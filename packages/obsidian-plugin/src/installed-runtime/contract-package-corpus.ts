import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { readdir, readFile, lstat } from "node:fs/promises";
import { join } from "node:path";

import * as contract from "@llm-wiki/vault-contracts";
import type { ContractCrossCallEvidence } from "./contract-cross-call.js";
import { isExecutedContractCrossCallEvidence } from "./contract-cross-call.js";
import { registeredReferenceRewriteCorpusEvidenceSchema, semanticEvidenceSearchSnapshotCorpusEvidenceSchema, type InstalledRuntimeEvidence } from "./evidence.js";
import { z } from "zod";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { EXPECTED_VAULT_ID_HEADER } from "../request-policy.js";

export const CONTRACT_PACKAGE_CORPUS_ID = "version-contract-package";
export const CONTRACT_PACKAGE_ASSERTION = "contract:complete-authority-fixtures-wire-and-cross-call-evidence";
export const defaultContractPackageRoot = (): string => fileURLToPath(new URL(import.meta.url.endsWith(".mjs") ? "../../contracts/" : "../../../contracts/", import.meta.url));
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const toolNames = ["vault_health", "vault_discover", "vault_read", "vault_continue", "vault_change_set_submit", "vault_change_set_status"] as const;
export type ContractToolName = typeof toolNames[number];
const fieldSchema = z.object({ pointer: z.string(), tool: z.enum(toolNames), direction: z.enum(["input", "output"]) }).strict();
const manifestSchema = z.object({
  contractVersion: z.literal(contract.CONTRACT_VERSION),
  roots: z.array(z.object({ path: z.string(), tool: z.enum(toolNames), direction: z.enum(["input", "output"]), sha256: digest }).strict()).length(12),
  sharedDefinitions: z.array(z.object({ root: z.string(), pointer: z.string() }).strict()),
  fixtures: z.array(z.object({ path: z.string(), valid: z.boolean(), sha256: digest, fields: z.array(fieldSchema).min(1) }).strict()).min(1),
  scenarios: z.array(z.discriminatedUnion("execution", [
    z.object({ id: z.string().min(1), authority: z.string().min(1), execution: z.enum(["identity-health", "missing-identity", "wrong-identity", "structured-text", "section-no-fallback", "change-set-program", "frozen-continuation", "client-bound-sliding", "mixed-read", "limit-grouping", "invalid-utf8", "structured-graph", "quota-cleanup", "uncertain-response"]) }).strict(),
    z.object({ id: z.string().min(1), authority: z.string().min(1), execution: z.literal("dependent-corpus"), requiredCorpus: z.string().min(1) }).strict(),
  ])).min(1),
}).strict();
export type VersionContractPackage = z.infer<typeof manifestSchema> & { readonly manifestSha256: string; readonly packageRoot: string };

export class ContractPackageCorpusError extends Error {
  constructor(message: string) { super(message); this.name = "ContractPackageCorpusError"; }
}
export function versionContractAuthorityDigest(packageRoot: string): string {
  const manifest = manifestSchema.parse(JSON.parse(readFileSync(join(packageRoot, "fixtures/v1/acceptance-manifest.json"), "utf8")));
  const scenarios = JSON.parse(readFileSync(join(packageRoot, "fixtures/v1/scenarios.json"), "utf8")) as { scenarios: { fixture?: string }[] };
  const paths = [...new Set(scenarios.scenarios.flatMap(scenario => scenario.fixture === undefined ? [] : ["fixtures/v1/" + scenario.fixture]))].sort();
  const programValues = paths.map(path => ({ path, value: JSON.parse(readFileSync(join(packageRoot, path), "utf8")) }));
  return contractDigest({ manifest, scenarios, programValues });
}
export function contractDigest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k,v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  return JSON.stringify(value);
}
const validators = {
  vault_health: { input: z.object({}).strict(), output: contract.healthResultSchema, inputJson: contract.createHealthInputJsonSchema, outputJson: contract.createHealthResultJsonSchema },
  vault_discover: { input: contract.discoverInputSchema, output: contract.discoverResultSchema, inputJson: contract.createDiscoverInputJsonSchema, outputJson: contract.createDiscoverResultJsonSchema },
  vault_read: { input: contract.readInputSchema, output: contract.readToolResultSchema, inputJson: contract.createReadInputJsonSchema, outputJson: contract.createReadResultJsonSchema },
  vault_continue: { input: contract.continueInputSchema, output: contract.continueResultSchema, inputJson: contract.createContinueInputJsonSchema, outputJson: contract.createContinueResultJsonSchema },
  vault_change_set_submit: { input: contract.changeSetSubmitInputSchema, output: contract.changeSetSubmitResultSchema, inputJson: contract.createChangeSetSubmitInputJsonSchema, outputJson: contract.createChangeSetSubmitResultJsonSchema },
  vault_change_set_status: { input: contract.changeSetStatusInputSchema, output: contract.changeSetStatusResultSchema, inputJson: contract.createChangeSetStatusInputJsonSchema, outputJson: contract.createChangeSetStatusResultJsonSchema },
};
async function files(directory: string, prefix = ""): Promise<string[]> {
  const result: string[] = [];
  for (const name of (await readdir(directory)).sort()) {
    const path = join(directory, name);
    const stat = await lstat(path);
    if (stat.isSymbolicLink()) throw new ContractPackageCorpusError("Contract authority refuses symbolic links");
    const relative = prefix + name;
    if (stat.isDirectory()) result.push(...await files(path, relative + "/"));
    else if (stat.isFile()) result.push(relative);
    else throw new ContractPackageCorpusError("Unknown contract package entry");
  }
  return result;
}
function exactCoverage(actual: readonly string[], expected: readonly string[], label: string): void {
  if (new Set(expected).size !== expected.length) throw new ContractPackageCorpusError(`Duplicate ${label} coverage`);
  if ([...actual].sort().join("\0") !== [...expected].sort().join("\0")) throw new ContractPackageCorpusError(`Missing or unknown ${label} coverage`);
}
const executedWire = new WeakMap<object, { endpoint: string; expectedVaultId: string; snapshotSha256: string }>();
export const contractCorpusBindingSchema = z.object({ runId: z.string().min(1), profileName: z.string().min(1), candidateBundleSha256: digest, vaultIdSha256: digest, seedManifestSha256: digest }).strict();
export const contractObservationSchema = z.object({ sequence: z.number().int().positive(), name: z.string().min(1), requestSha256: digest, responseSha256: digest, facts: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])) }).strict();
export interface ContractChildSource {
  scenarioId: string; sourceRunId: string; candidateBundleSha256: string; installedMainSha256: string; profileName: string;
  identity: { vaultId: string; port: number };
  seedNotes: { path: string; content: string }[];
  events: { kind: "transport" | "cleanup"; name: string; detail: unknown }[];
  cleanup: { attempted: boolean; residualPaths: readonly string[] };
}
/** Runner-owned private snapshots, retained before public projection and Vault removal. */
export interface ContractChildConsumptionContext {
  runId: string; candidateBundleSha256: string; installedMainSha256: string; profileName: string;
  children: { source: ContractChildSource; sourceSha256: string }[];
  reports: { scenarioId: string; report: unknown; reportSha256: string }[];
}
export function contractSeedDigest(seedNotes: readonly { path: string; content: string }[]): string {
  const manifest = seedNotes.map(note => `${createHash("sha256").update(note.content).digest("hex")}  ${note.path}`).sort().join("\n") + "\n";
  return createHash("sha256").update(manifest).digest("hex");
}
export function consumeContractChildSources(report: ContractPackageCorpusEvidence, context: ContractChildConsumptionContext | undefined, evidence: Pick<InstalledRuntimeEvidence, "candidate" | "registeredReferenceRewriteCorpus" | "semanticEvidenceSearchSnapshotCorpus" | "contractSourceVaults">): void {
  const installedMainSha256 = evidence.candidate?.files.find(file => file.path === "main.js")?.sha256;
  for (const [id, sibling] of [["registered-reference-byte-verification", evidence.registeredReferenceRewriteCorpus], ["successor-search-snapshot-graph-evidence", evidence.semanticEvidenceSearchSnapshotCorpus]] as const) {
    const source = report.crossCalls.find(row => row.id === id)?.proof.dependency;
    if (source === null || source === undefined || sibling === null || source.reportSha256 !== contractDigest(sibling)) throw new ContractPackageCorpusError("Version contract source report does not match its sibling installed corpus");
    for (const vault of source.sourceVaults) {
      if (!(evidence.contractSourceVaults ?? []).some(record => contractDigest(record) === contractDigest(vault))) throw new ContractPackageCorpusError("Version contract source Vault provenance does not match its independently recorded installed runtime");
      const prefix = id === "registered-reference-byte-verification" ? "registered-reference" : "semantic";
      if (!sibling.eventLog.some(event => event.name === `${prefix}-source-vault-identity` && event.detailSha256 === vault.identityEventSha256) || !sibling.eventLog.some(event => event.name === `${prefix}-source-vault-cleaned` && event.detailSha256 === vault.cleanupEventSha256)) throw new ContractPackageCorpusError("Version contract source Vault event provenance is detached from its sibling");
    }
  }
  if (context === undefined || context.runId !== report.binding.runId || context.candidateBundleSha256 !== report.binding.candidateBundleSha256 || context.profileName !== report.binding.profileName || context.installedMainSha256 !== installedMainSha256) throw new ContractPackageCorpusError("Version contract independent child source context absent or mismatched");
  for (const id of ["registered-reference-byte-verification", "successor-search-snapshot-graph-evidence"]) {
    const dependency = report.crossCalls.find(row => row.id === id)!.proof.dependency!;
    const retainedReports = context.reports.filter(item => item.scenarioId === id);
    if (retainedReports.length !== 1 || contractDigest(retainedReports[0]!.report) !== retainedReports[0]!.reportSha256 || retainedReports[0]!.reportSha256 !== dependency.reportSha256) throw new ContractPackageCorpusError("Version contract independent child source report pin mismatch");
    const children = context.children.filter(item => id === "registered-reference-byte-verification" ? item.source.scenarioId === id : item.source.scenarioId !== "registered-reference-byte-verification");
    if (children.length === 0 || children.length !== dependency.sourceVaults.length) throw new ContractPackageCorpusError("Version contract independent child source coverage mismatch");
    const projected = children.map(({ source, sourceSha256 }) => {
      if (contractDigest(source) !== sourceSha256 || source.candidateBundleSha256 !== context.candidateBundleSha256 || source.installedMainSha256 !== context.installedMainSha256 || source.profileName !== context.profileName || !source.sourceRunId.startsWith(context.runId + "-") || !source.cleanup.attempted || source.cleanup.residualPaths.length !== 0) throw new ContractPackageCorpusError("Version contract independent child source pin mismatch");
      const identity = { scenarioId: source.scenarioId, sourceRunId: source.sourceRunId, candidateBundleSha256: source.candidateBundleSha256, profileName: source.profileName, vaultIdSha256: contractDigest(source.identity.vaultId), seedManifestSha256: contractSeedDigest(source.seedNotes) };
      const cleanup = { sourceRunId: source.sourceRunId, vaultIdSha256: identity.vaultIdSha256, cleanupConfirmed: true };
      const prefix = id === "registered-reference-byte-verification" ? "registered-reference" : "semantic";
      const expected = [{ kind: "transport", name: `${prefix}-source-vault-identity`, detail: identity }, { kind: "cleanup", name: `${prefix}-source-vault-cleaned`, detail: cleanup }];
      if (contractDigest(source.events) !== contractDigest(expected)) throw new ContractPackageCorpusError("Version contract independent child source events mismatch");
      const events = (retainedReports[0]!.report as { eventLog: { kind: string; name: string; detailSha256: string }[] }).eventLog;
      for (const event of expected) if (!events.some(row => row.kind === event.kind && row.name === event.name && row.detailSha256 === contractDigest(event.detail))) throw new ContractPackageCorpusError("Version contract independent child source report events detached");
      return { ...identity, identityEventSha256: contractDigest(identity), cleanupEventSha256: contractDigest(cleanup) };
    });
    exactCoverage(dependency.sourceVaults.map(contractDigest), projected.map(contractDigest), "independent child source identities and seeds");
  }
}
export const contractSourceVaultSchema = z.object({ scenarioId: z.string().min(1), sourceRunId: z.string().min(1), candidateBundleSha256: digest, profileName: z.string().min(1), vaultIdSha256: digest, seedManifestSha256: digest, identityEventSha256: digest, cleanupEventSha256: digest }).strict();
export const contractProgramStateSchema = z.object({ registrySha256: digest, nextEnqueueSeq: z.number().int().nonnegative(), entries: z.array(z.object({ submissionKeySha256: digest, fingerprint: z.string().min(1), changeSetIdSha256: digest, enqueueSeq: z.number().int().nonnegative(), recordSha256: digest, state: z.string().min(1), phase: z.string().nullable() }).strict()), inventory: z.array(z.object({ path: z.string().min(1), sha256: digest, sizeBytes: z.number().int().nonnegative() }).strict()) }).strict();
export const contractProgramProofSchema = z.object({ submissionKeySha256: digest, requestSha256: digest, responseRecordSha256: digest, beforeSubmission: contractProgramStateSchema, beforeRepeat: contractProgramStateSchema, afterRepeat: contractProgramStateSchema }).strict();
export const contractGraphTransitionSchema = z.object({ transition: z.enum(["unresolved-link", "target-creation", "rename", "deletion"]), request: contract.discoverInputSchema, before: contract.discoverResultSchema.refine(value => value.outcome === "results" && value.complete && value.continuation === null, "Graph proof must not publish continuation authority"), after: contract.discoverResultSchema.refine(value => value.outcome === "results" && value.complete && value.continuation === null, "Graph proof must not publish continuation authority"), acceptedBytesSha256: digest, reconstructedSha256: digest, successorBytesSha256: digest }).strict();
export const contractCrossCallProofSchema = z.object({ scenarioId: z.string().min(1), authoritySha256: digest, binding: contractCorpusBindingSchema.nullable(), observations: z.array(contractObservationSchema), programProof: contractProgramProofSchema.nullable().optional(), graphTransitions: z.array(contractGraphTransitionSchema).optional(), cleanup: z.object({ sessionsClosed: z.boolean() }).strict(), verdict: z.enum(["passed", "blocked"]), requiredCorpus: z.string().nullable(), dependency: z.object({ binding: contractCorpusBindingSchema, sourceVaults: z.array(contractSourceVaultSchema), reportSha256: digest, report: z.unknown() }).strict().nullable() }).strict();
const wireInputSchema = z.object({ id: z.string(), tool: z.enum(toolNames), valid: z.boolean(), requestSha256: digest, responseSha256: digest.nullable(), rejected: z.boolean() }).strict();
const wireEvidenceSchema = z.object({ authoritySha256: digest, inputs: z.array(wireInputSchema), outputs: z.array(z.object({ tool: z.enum(toolNames), root: z.string(), responseSha256: digest, requestEvidencePointer: z.string(), structuredTextIdentical: z.literal(true) }).strict()).length(6), outputFixtures: z.array(z.object({ id: z.string(), root: z.string(), valid: z.boolean(), mode: z.literal("validator-only"), associatedOutputPointer: z.string() }).strict()), unknownFieldRejections: z.array(z.object({ tool: z.enum(toolNames), requestSha256: digest }).strict()).length(6), eventLog: z.array(z.object({ sequence: z.number().int().positive(), kind: z.enum(["tool", "assertion", "cleanup"]), name: z.string(), detailSha256: digest }).strict()).min(1), cleanup: z.object({ sessionClosed: z.literal(true) }).strict(), verdict: z.literal("passed") }).strict();
export const contractPackageCorpusEvidenceSchema = z.object({
  corpusId: z.literal(CONTRACT_PACKAGE_CORPUS_ID), contractVersion: z.literal(contract.CONTRACT_VERSION), authoritySha256: digest,
  binding: contractCorpusBindingSchema,
  wire: wireEvidenceSchema,
  roots: z.array(z.object({ id: z.string(), sha256: digest, evidencePointer: z.string().min(1) }).strict()).length(12),
  sharedDefinitions: z.array(z.object({ id: z.string(), rootEvidencePointer: z.string().min(1) }).strict()),
  fixtures: z.array(z.object({ id: z.string(), valid: z.boolean(), direction: z.enum(["input", "output"]), mode: z.enum(["executed", "validator-only"]), evidencePointer: z.string().min(1) }).strict()).min(1),
  crossCalls: z.array(z.object({ id: z.string(), evidenceSha256: digest, evidencePointer: z.string().min(1), source: z.literal("real-loopback"), observations: z.array(contractObservationSchema).min(1), proof: contractCrossCallProofSchema }).strict()).min(1),
  beforeInventorySha256: digest, afterInventorySha256: digest,
  cleanup: z.object({ attempted: z.literal(true), residualPaths: z.array(z.string()).length(0), sessionClosed: z.literal(true) }).strict(),
  eventLog: z.array(z.object({ sequence: z.number().int().positive(), kind: z.enum(["tool", "assertion", "cleanup"]), name: z.string(), detailSha256: digest }).strict()).min(1),
  assertions: z.array(z.literal(CONTRACT_PACKAGE_ASSERTION)).length(1), verdict: z.literal("passed"),
}).strict().superRefine((value, context) => {
  // Report consumption independently reopens the bundled authority. A rehashed
  // partial report cannot choose its own coverage set.
  const packaged = manifestSchema.parse(JSON.parse(readFileSync(join(defaultContractPackageRoot(), "fixtures/v1/acceptance-manifest.json"), "utf8")));
  try {
    if (value.authoritySha256 !== versionContractAuthorityDigest(defaultContractPackageRoot()) || value.wire.authoritySha256 !== value.authoritySha256) throw new ContractPackageCorpusError("Contract authority digest does not match bundled version package");
    exactCoverage(value.roots.map(row => row.id), packaged.roots.map(row => row.path), "reported roots");
    exactCoverage(value.sharedDefinitions.map(row => row.id), packaged.sharedDefinitions.map(row => row.root + row.pointer), "reported shared definitions");
    exactCoverage(value.fixtures.map(row => row.id), packaged.fixtures.flatMap(fixture => fixture.fields.map(field => fixture.path + "#" + field.pointer)), "reported fixtures");
    exactCoverage(value.crossCalls.map(row => row.id), packaged.scenarios.map(row => row.id), "reported cross-call scenarios");
    exactCoverage(value.wire.inputs.filter(row => row.id.startsWith("fixtures/")).map(row => row.id), packaged.fixtures.flatMap(f => f.fields.filter(field => field.direction === "input").map(field => f.path + "#" + field.pointer)), "reported wire input fixtures");
    exactCoverage(value.wire.outputFixtures.map(row => row.id), packaged.fixtures.flatMap(f => f.fields.filter(field => field.direction === "output").map(field => f.path + "#" + field.pointer)), "reported wire output fixtures");
    exactCoverage(value.wire.outputs.map(row => row.tool), toolNames, "reported real outputs");
    exactCoverage(value.wire.unknownFieldRejections.map(row => row.tool), toolNames, "reported unknown field rejections");
    for (const rejection of value.wire.unknownFieldRejections) {
      const base = packaged.fixtures.flatMap(fixture => fixture.valid ? fixture.fields.filter(field => field.direction === "input" && field.tool === rejection.tool).map(field => ({ fixture, field })) : [])[0];
      const fixtureValue = base === undefined ? {} : JSON.parse(readFileSync(join(defaultContractPackageRoot(), base.fixture.path), "utf8"));
      const request = base === undefined || base.field.pointer === "" ? fixtureValue : fixtureValue[base.field.pointer.slice(1)];
      const expected = contractDigest({ ...request, __contract_unknown_field: true });
      const rows = value.wire.inputs.filter(input => input.id === `unknown-field/${rejection.tool}`);
      if (rejection.requestSha256 !== expected || rows.length !== 1 || rows[0]!.requestSha256 !== expected || !rows[0]!.rejected || rows[0]!.valid || rows[0]!.tool !== rejection.tool) throw new ContractPackageCorpusError("Unknown-field rejection evidence does not bind its rejected request");
    }
    for (const root of value.roots) {
      const authoritative = packaged.roots.find(entry => entry.path === root.id)!;
      if (root.sha256 !== authoritative.sha256) throw new ContractPackageCorpusError("Reported root digest differs from authority");
      const entries = authoritative.direction === "output" ? value.wire.outputs : value.wire.inputs;
      const index = entries.findIndex(entry => entry.tool === authoritative.tool && (!("valid" in entry) || entry.valid));
      if (index < 0 || root.evidencePointer !== `wire/${authoritative.direction === "output" ? "outputs" : "inputs"}/${index}`) throw new ContractPackageCorpusError("Root output/input association does not resolve");
    }
    for (const row of value.wire.outputs) {
      const index = Number(row.requestEvidencePointer.split("/")[1]); const input = value.wire.inputs[index];
      if (!input?.valid || input.tool !== row.tool || input.responseSha256 !== row.responseSha256) throw new ContractPackageCorpusError("Real output is detached from request evidence");
    }
    for (const definition of value.sharedDefinitions) if (definition.rootEvidencePointer !== `roots/${value.roots.findIndex(root => definition.id.startsWith(root.id + "#"))}`) throw new ContractPackageCorpusError("Shared definition root pointer does not resolve");
    for (const fixture of packaged.fixtures) for (const field of fixture.fields) {
      const row = value.fixtures.find(entry => entry.id === fixture.path + "#" + field.pointer)!;
      if (row.valid !== fixture.valid || row.direction !== field.direction || row.mode !== (field.direction === "input" ? "executed" : "validator-only")) throw new ContractPackageCorpusError("Reported fixture role differs from authority");
      const entries = field.direction === "input" ? value.wire.inputs : value.wire.outputFixtures;
      const index = entries.findIndex(entry => entry.id === row.id);
      if (row.evidencePointer !== `wire/${field.direction === "input" ? "inputs" : "outputFixtures"}/${index}` || entries[index]?.valid !== fixture.valid) throw new ContractPackageCorpusError("Fixture evidence pointer does not resolve to its execution/validation");
      if (field.direction === "input") {
        const input = value.wire.inputs[index]!;
        const fixtureValue = JSON.parse(readFileSync(join(defaultContractPackageRoot(), fixture.path), "utf8"));
        const request = field.pointer === "" ? fixtureValue : fixtureValue[field.pointer.slice(1)];
        if (input.requestSha256 !== contractDigest(request)) throw new ContractPackageCorpusError("Fixture request digest differs from version authority");
        if (input.tool !== field.tool || input.rejected === fixture.valid || fixture.valid && input.responseSha256 === null) throw new ContractPackageCorpusError("Fixture input execution result does not match authority");
      } else {
        const output = value.wire.outputFixtures[index]!;
        const outputIndex = value.wire.outputs.findIndex(entry => entry.tool === field.tool);
        if (output.associatedOutputPointer !== `outputs/${outputIndex}` || output.root !== value.wire.outputs[outputIndex]?.root) throw new ContractPackageCorpusError("Fixture output association does not resolve");
      }
    }
    for (const [index, row] of value.crossCalls.entries()) {
      if (row.evidenceSha256 !== contractDigest(row.proof) || row.evidencePointer !== `crossCalls/${index}/observations` || row.id !== row.proof.scenarioId || contractDigest(row.observations) !== contractDigest(row.proof.observations)) throw new ContractPackageCorpusError("Cross-call proof digest or pointer is detached from behavior");
      if (row.proof.verdict !== "passed" || row.proof.requiredCorpus !== null || !row.proof.cleanup.sessionsClosed || row.proof.authoritySha256 !== value.authoritySha256 || contractDigest(row.proof.binding) !== contractDigest(value.binding)) throw new ContractPackageCorpusError("Cross-call proof has missing behavior, provenance or cleanup");
      const scenario = packaged.scenarios.find(scenario => scenario.id === row.id)!;
      if (["change-set-same-key-replay", "change-set-key-conflict"].includes(row.id)) {
        const proof = row.proof.programProof;
        if (proof === null || proof === undefined) throw new ContractPackageCorpusError("Durable registry and public inventory proof is absent");
        const fixture = row.id === "change-set-same-key-replay" ? "scenario-replay.json" : "scenario-conflict.json";
        const program = JSON.parse(readFileSync(join(defaultContractPackageRoot(), "fixtures/v1/vault-change-set", fixture), "utf8"));
        const request = program.steps[0].arguments;
        const entry = proof.beforeRepeat.entries.filter(entry => entry.submissionKeySha256 === proof.submissionKeySha256);
        if (proof.submissionKeySha256 !== contractDigest(request.submissionKey) || proof.requestSha256 !== contractDigest(request) || entry.length !== 1 || entry[0]!.fingerprint !== "sha256:" + contractDigest({ operations: request.operations, readDependencies: request.readDependencies ?? [] }) || entry[0]!.state !== "intent_applied" || entry[0]!.recordSha256 !== proof.responseRecordSha256 || proof.beforeSubmission.entries.some(entry => entry.submissionKeySha256 === proof.submissionKeySha256) || proof.beforeRepeat.nextEnqueueSeq !== proof.beforeSubmission.nextEnqueueSeq + 1 || contractDigest(proof.beforeRepeat) !== contractDigest(proof.afterRepeat)) throw new ContractPackageCorpusError("Durable registry replay/conflict proof contradicts its request or public inventory");
        const wireRecord = row.observations.find(entry => entry.name === "durable-status-record");
        if (wireRecord === undefined || wireRecord.requestSha256 !== contractDigest({ submissionKey: request.submissionKey }) || wireRecord.facts.recordSha256 !== proof.responseRecordSha256 || wireRecord.facts.changeSetIdSha256 !== entry[0]!.changeSetIdSha256 || !row.observations.some(entry => entry.name === "vault_change_set_status" && entry.requestSha256 === wireRecord.requestSha256 && entry.responseSha256 === wireRecord.responseSha256)) throw new ContractPackageCorpusError("Durable wire record does not bind actual status request/output");
        const created = request.operations[0];
        const expectedFile = { path: created.path, sha256: createHash("sha256").update(created.content, "utf8").digest("hex"), sizeBytes: Buffer.byteLength(created.content, "utf8") };
        const expectedInventory = [...proof.beforeSubmission.inventory, expectedFile].sort((a, b) => a.path.localeCompare(b.path));
        if (proof.beforeSubmission.inventory.some(entry => entry.path === created.path) || contractDigest(expectedInventory) !== contractDigest(proof.beforeRepeat.inventory)) throw new ContractPackageCorpusError("Public raw inventory does not prove exactly the first create effect");
        for (const state of [proof.beforeSubmission, proof.beforeRepeat, proof.afterRepeat]) if (new Set(state.inventory.map(entry => entry.path)).size !== state.inventory.length) throw new ContractPackageCorpusError("Durable replay inventory contains duplicate paths");
      }
      if (row.id === "successor-search-snapshot-graph-evidence") {
        const transitions = row.proof.graphTransitions ?? [];
        if (transitions.length !== 4 || new Set(transitions.map(entry => entry.transition)).size !== 4) throw new ContractPackageCorpusError("Graph wire transition proof is absent or duplicate");
        for (const transition of transitions) {
          const observation = row.observations.find(entry => entry.name === "successor-transition-frozen-predecessor" && entry.facts.transition === transition.transition);
          const unresolved = transition.transition === "unresolved-link" || transition.transition === "deletion";
          const target = transition.transition === "unresolved-link" ? "ContractSuccessorTarget" : transition.transition === "deletion" ? "ContractSuccessorRenamed" : transition.transition === "target-creation" ? "Notes/ContractSuccessorTarget.md" : "Notes/ContractSuccessorRenamed.md";
          const expectedRequest = { query: { all: [{ path: { exact: "Notes/Transport.md" } }, unresolved ? { unresolvedLink: { target } } : { graph: { relation: "links_to", path: target, maxDepth: 1 } }] }, projection: { matches: false, references: true }, order: { by: "path", direction: "asc" }, page: { maxItems: 100, continuation: null } };
          if (contractDigest(transition.request) !== contractDigest(expectedRequest) || transition.after.outcome !== "results" || !transition.after.items[0]?.references?.some(reference => unresolved ? reference.target === target && reference.resolvedPath === null : reference.resolvedPath === target)) throw new ContractPackageCorpusError("Graph transition proof lacks the required relation and query");
          const requestSha256 = contractDigest(transition.request);
          if (transition.before.outcome !== "results" || transition.after.outcome !== "results" || transition.before.items.length !== 0 || transition.after.items.length !== 1 || transition.after.items[0]?.path !== "Notes/Transport.md" || transition.after.items[0].contentVersion !== "sha256:" + transition.successorBytesSha256 || transition.acceptedBytesSha256 !== transition.reconstructedSha256 || observation?.facts.beforeGraphSha256 !== contractDigest(transition.before) || observation.facts.afterGraphSha256 !== contractDigest(transition.after) || observation.facts.acceptedBytesSha256 !== transition.acceptedBytesSha256 || observation.facts.reconstructedSha256 !== transition.reconstructedSha256) throw new ContractPackageCorpusError("Graph wire transition proof contradicts byte or graph output");
          for (const response of [transition.before, transition.after]) if (!row.observations.some(entry => entry.name === "vault_discover" && entry.requestSha256 === requestSha256 && entry.responseSha256 === contractDigest(response))) throw new ContractPackageCorpusError("Graph transition proof is detached from actual wire request/output");
        }
      }
      if (scenario.execution === "dependent-corpus") {
        const source = row.proof.dependency;
        if (source === null || contractDigest(source.binding) !== contractDigest(value.binding) || source.reportSha256 !== contractDigest(source.report)) throw new ContractPackageCorpusError("Cross-call dependent source report, binding or digest is absent");
        if (source.sourceVaults.length === 0) throw new ContractPackageCorpusError("Dependent source Vault provenance is absent");
        for (const vault of source.sourceVaults) if (!vault.sourceRunId.startsWith(value.binding.runId + "-") || vault.candidateBundleSha256 !== value.binding.candidateBundleSha256 || vault.profileName !== value.binding.profileName || vault.cleanupEventSha256 === "0".repeat(64)) throw new ContractPackageCorpusError("Dependent source Vault provenance or cleanup does not bind parent run");
        for (const vault of source.sourceVaults) {
          const identityDetails = { scenarioId: vault.scenarioId, sourceRunId: vault.sourceRunId, candidateBundleSha256: vault.candidateBundleSha256, profileName: vault.profileName, vaultIdSha256: vault.vaultIdSha256, seedManifestSha256: vault.seedManifestSha256 };
          if (vault.identityEventSha256 !== contractDigest(identityDetails) || vault.cleanupEventSha256 !== contractDigest({ sourceRunId: vault.sourceRunId, vaultIdSha256: vault.vaultIdSha256, cleanupConfirmed: true })) throw new ContractPackageCorpusError("Source Vault identity or cleanup event digest is detached from provenance");
        }
        validateContractDependentReport(row.id, source.report);
      } else if (row.proof.dependency !== null) throw new ContractPackageCorpusError("Non-dependent cross-call contains an unknown source report");
      assertContractCrossCallBehavior(scenario, row.observations);
    }
  } catch (error) { context.addIssue({ code: "custom", message: error instanceof Error ? error.message : "Contract report coverage mismatch" }); }
  for (const entries of [value.roots, value.sharedDefinitions, value.fixtures, value.crossCalls]) if (new Set(entries.map(entry => entry.id)).size !== entries.length) context.addIssue({ code: "custom", message: "Duplicate contract coverage" });
  if (!value.eventLog.every((entry, index) => entry.sequence === index + 1) || value.crossCalls.some(call => !call.observations.every((entry, index) => entry.sequence === index + 1))) context.addIssue({ code: "custom", message: "Contract observation sequence mismatch" });
});
const dependentGateReportSchema = z.object({ kind: z.literal("installed-contract-gate-proof"), scenarioId: z.string().min(1), source: z.literal("installed-obsidian"), calls: z.array(z.object({ sequence: z.number().int().positive(), tool: z.enum(toolNames), requestSha256: digest, responseSha256: digest, compatibilitySha256: digest, outcome: z.enum(["incompatible", "operationally_blocked", "observed", "page"]), gate: z.enum(["incompatible_protocol", "recovery_blocked", "starting", "snapshot_unavailable"]).nullable(), isError: z.boolean(), rawAccessCount: z.number().int().nonnegative() }).strict()).min(1), identities: z.array(z.object({ vaultIdSha256: digest, endpointSha256: digest, healthSha256: digest, stateSha256: digest }).strict()), cleanup: z.object({ attempted: z.literal(true), residualPaths: z.array(z.string()).length(0) }).strict() }).strict();
export function validateContractDependentReport(scenarioId: string, report: unknown): void {
  if (scenarioId === "registered-reference-byte-verification") {
    const source = registeredReferenceRewriteCorpusEvidenceSchema.parse(report);
    if (source.verdict !== "passed" || source.rawBytes.fixtures.some(fixture => !fixture.everyReferenceExactlyOneVerifiedSpan || !fixture.everyUntouchedByteExact || !fixture.finalBytesHashReread) || new Set(source.moves.map(move => move.profile)).size !== 4 || source.residualCleanup.writeGate !== "open") throw new ContractPackageCorpusError("Registered-reference installed proof is incomplete");
  } else if (scenarioId === "successor-search-snapshot-graph-evidence") {
    const source = semanticEvidenceSearchSnapshotCorpusEvidenceSchema.parse(report);
    for (const kind of ["create_note", "move_note", "trash_note"]) if (!source.scenarios.some(row => row.mutationKind === kind && row.proofState === "intent_applied" && row.successorSnapshot.version !== null && row.successorSnapshot.version > row.successorSnapshot.baselineVersion && row.successorSnapshot.immutable && row.cleanupSucceeded)) throw new ContractPackageCorpusError("Successor graph installed mutation proof is incomplete");
  } else if (scenarioId === "change-set-seven-day-retention") {
    const source = z.object({ kind: z.literal("installed-contract-retention-proof"), retentionMs: z.literal(604800000), timeBoundaryFixtureSha256: digest, before: contract.changeSetStatusResultSchema, afterRestart: contract.changeSetStatusResultSchema, afterRetention: contract.changeSetStatusResultSchema, cleanupConfirmed: z.literal(true) }).strict().parse(report);
    if (source.before.lookup !== "found" || source.afterRestart.lookup !== "found" || contractDigest(source.before.changeSet) !== contractDigest(source.afterRestart.changeSet) || source.afterRetention.lookup !== "expired") throw new ContractPackageCorpusError("Retention proof lacks complete retained records or expired tombstone");
  } else {
    const source = dependentGateReportSchema.parse(report);
    if (source.scenarioId !== scenarioId || !source.calls.every((row, index) => row.sequence === index + 1)) throw new ContractPackageCorpusError("Dependent installed source scenario/order mismatch");
    for (const row of source.calls) if (row.responseSha256 !== row.compatibilitySha256) throw new ContractPackageCorpusError("Dependent installed structured/text mismatch");
    if (scenarioId === "schema-compatible-incompatible-health") {
      const health = source.calls.find(row => row.tool === "vault_health");
      if (health === undefined || health.outcome !== "incompatible" || health.isError) throw new ContractPackageCorpusError("Minimal incompatible health behavior is absent");
    } else if (scenarioId === "two-vault-coexistence") {
      if (source.identities.length !== 2 || new Set(source.identities.map(row => row.vaultIdSha256)).size !== 2 || new Set(source.identities.map(row => row.endpointSha256)).size !== 2 || new Set(source.identities.map(row => row.stateSha256)).size !== 2) throw new ContractPackageCorpusError("Two-Vault identity endpoint state isolation is absent");
    } else if (scenarioId === "content-read-operational-block") {
      for (const tool of ["vault_discover", "vault_read", "vault_continue"] as const) if (!source.calls.some(row => row.tool === tool && row.outcome === "operationally_blocked" && row.rawAccessCount === 0)) throw new ContractPackageCorpusError("Content gate did not precede all raw access");
    } else if (scenarioId === "continuation-operational-gate-precedence") {
      const blocked = source.calls.find(row => row.tool === "vault_continue" && row.outcome === "operationally_blocked");
      const resumed = source.calls.find(row => row.tool === "vault_continue" && row.outcome === "page");
      if (blocked === undefined || resumed === undefined || blocked.rawAccessCount !== 0 || blocked.requestSha256 !== resumed.requestSha256 || blocked.sequence >= resumed.sequence) throw new ContractPackageCorpusError("Operational gate consumed or inspected continuation token");
    } else throw new ContractPackageCorpusError("Unknown dependent installed proof");
  }
}
export function assertContractCrossCallBehavior(scenario: VersionContractPackage["scenarios"][number], observations: readonly z.infer<typeof contractObservationSchema>[]): void {
  const has = (name: string, facts: Record<string, string | number | boolean> = {}): boolean => observations.some(row => row.name === name && Object.entries(facts).every(([key, expected]) => row.facts[key] === expected));
  const requirements: Partial<Record<VersionContractPackage["scenarios"][number]["execution"], readonly [string, Record<string, string | number | boolean>][]>> = {
    "identity-health": [["identity-bound-health", { identityMatched: true, listenerMatched: true }]],
    "structured-text": [["vault_health", { schemaValid: true, structuredTextIdentical: true }]],
    "section-no-fallback": [["no-section-fallback", { noFallback: true }]],
    "mixed-read": [["ordered-duplicate-exact-bytes", { duplicatePreserved: true, exactBytes: true, canonicalContentVersions: true }]],
    "limit-grouping": [["limit-and-contiguous-grouping", { singleNoteRefused: true, noPartialContent: true, contiguousOrderedGroups: true }]],
    "frozen-continuation": [["frozen-after-source-change", { sourceChanged: true, exactFrozenBytes: true }]],
    "invalid-utf8": [["invalid-utf8-untrusted-rejection", { fixtureInvalidUtf8: true, noTrustedResult: true, notSatisfiedNotSubstituted: true }]],
    "structured-graph": [["combined-structured-graph-raw-byte-projection", { allPredicatesMatched: true, frontmatterOutlineMatchesReferences: true, rawByteVersionMatched: true }]],
    "uncertain-response": [["submit-wire-response-discarded", { actuallyReceived: true, deliberatelyUnavailable: true }], ["original-key-recovered-after-restart", { identityPreserved: true, originalKeyRecovered: true }]],
    "client-bound-sliding": [["consumed-token-replay-rejected", { consumedRejected: true }], ["malformed-token-rejected", { malformedRejected: true }], ["wrong-client-token-rejected", { wrongClientRejected: true }], ["original-client-token-preserved", { ownerTokenPreserved: true }], ["real-time-sliding-lifetime", { replacementSurvivesOriginalExpiry: true }], ["real-time-token-expiry", { expiredRejected: true }]],
    "quota-cleanup": [["rejected-issuance-has-no-retained-authority", { replacementAcceptedImmediately: true, remainingSevenPreserved: true, rejectedTokenPublished: false }], ["quota-preserved-and-session-capacity-released", { eightChainsSurvived: true, ninthRejected: true, completionReleasedCapacity: true, closedSessionTokenRejected: true }], ["retained-byte-quota-no-eviction", { acceptedChains: 1, secondRejected: true, acceptedChainDrained: true }], ["expiry-releases-retained-capacity", { expiredTokenRejected: true, capacityReleased: true }], ["bridge-teardown-releases-retained-capacity", { oldTokenRejected: true, capacityReleased: true }]],
  };
  if (scenario.execution === "missing-identity" || scenario.execution === "wrong-identity") {
    if (observations.length !== 7 || observations.filter(row => row.name === "initialize").length !== 1 || observations.filter(row => row.name === "tools/call").length !== 6 || observations.some(row => row.facts.status !== 403 || row.facts.rejectedBeforeDispatch !== true)) throw new ContractPackageCorpusError("Cross-call identity rejection behavior is incomplete");
  } else if (scenario.execution === "change-set-program") {
    if (!has("program-expectation", { expectationMatched: true }) || !observations.some(row => row.name === "vault_change_set_submit" && row.facts.schemaValid === true)) throw new ContractPackageCorpusError("Cross-call Change Set program behavior is incomplete");
  } else if (scenario.execution === "dependent-corpus") {
    // A string naming another corpus is not proof. Its installed producer must
    // supply a validated, content-addressed source report before this can pass.
    if (!has("validated-installed-dependent-proof", { requiredCorpus: scenario.requiredCorpus, sourceReportValidated: true, bindingMatched: true, cleanupConfirmed: true })) throw new ContractPackageCorpusError("Cross-call dependent installed behavior is absent");
    if (scenario.id === "successor-search-snapshot-graph-evidence" && !has("successor-graph-frozen-predecessor", { graphChanged: true, frozenPredecessorExact: true, restored: true })) throw new ContractPackageCorpusError("Successor graph frozen predecessor behavior is absent");
    if (scenario.id === "successor-search-snapshot-graph-evidence") for (const transition of ["unresolved-link", "target-creation", "rename", "deletion"]) {
      const row = observations.find(row => row.name === "successor-transition-frozen-predecessor" && row.facts.transition === transition);
      if (row === undefined || row.facts.graphChanged !== true || row.facts.exactFrozenBytes !== true || row.facts.acceptedBytesSha256 !== row.facts.reconstructedSha256 || row.facts.beforeGraphSha256 === row.facts.afterGraphSha256 || typeof row.facts.successorContentVersion !== "string" || !/^sha256:[a-f0-9]{64}$/.test(row.facts.successorContentVersion)) throw new ContractPackageCorpusError("Successor graph transition proof is incomplete");
    }
  } else if (!(requirements[scenario.execution] ?? []).every(([name, facts]) => has(name, facts))) throw new ContractPackageCorpusError(`Cross-call behavior is incomplete: ${scenario.id}`);
  for (const row of observations) {
    if (row.name === "real-time-token-expiry" && Number(row.facts.elapsedMs) < 900_000 || row.name === "real-time-sliding-lifetime" && (Number(row.facts.originalAgeMs) < 900_000 || Number(row.facts.replacementAgeMs) >= 900_000) || row.name === "expiry-releases-retained-capacity" && Number(row.facts.elapsedMs) < 900_000) throw new ContractPackageCorpusError("Cross-call real-time lifetime behavior is incomplete");
  }
}
export type ContractPackageCorpusEvidence = z.infer<typeof contractPackageCorpusEvidenceSchema>;

/** Completion consumes executed producer objects, not JSON-shaped passing assertions. */
export function completeContractPackageCorpus(options: {
  authority: VersionContractPackage; wire: ContractFixtureWireEvidence; crossCalls: readonly ContractCrossCallEvidence[];
  binding: z.infer<typeof contractCorpusBindingSchema>; beforeInventorySha256: string; afterInventorySha256: string;
  cleanup: { attempted: boolean; residualPaths: readonly string[] };
}): ContractPackageCorpusEvidence {
  const { authority, wire, crossCalls } = options;
  const inputIds = authority.fixtures.flatMap(fixture => fixture.fields.filter(field => field.direction === "input").map(field => fixture.path + "#" + field.pointer));
  exactCoverage(wire.inputs.filter(row => row.id.startsWith("fixtures/")).map(row => row.id), inputIds, "input fixture");
  const outputIds = authority.fixtures.flatMap(fixture => fixture.fields.filter(field => field.direction === "output").map(field => fixture.path + "#" + field.pointer));
  exactCoverage(wire.outputFixtures.map(row => row.id), outputIds, "output fixture");
  exactCoverage(crossCalls.map(row => row.scenarioId), authority.scenarios.map(row => row.id), "cross-call");
  const executed = executedWire.get(wire);
  if (executed === undefined || executed.snapshotSha256 !== contractDigest(wire) || wire.authoritySha256 !== authority.manifestSha256 || contractDigest(executed.expectedVaultId) !== options.binding.vaultIdSha256) throw new ContractPackageCorpusError("Contract wire evidence is unexecuted, changed or bound to another Vault");
  for (const proof of crossCalls) {
    if (!isExecutedContractCrossCallEvidence(proof, executed.endpoint, options.binding.vaultIdSha256) || proof.verdict !== "passed" || proof.requiredCorpus !== null || proof.authoritySha256 !== authority.manifestSha256 || !proof.cleanup.sessionsClosed || proof.observations.length === 0) throw new ContractPackageCorpusError(`Required executed cross-call behavior is absent or blocked: ${proof.scenarioId}`);
  }
  if (!options.cleanup.attempted || options.cleanup.residualPaths.length !== 0 || !wire.cleanup.sessionClosed) throw new ContractPackageCorpusError("Contract cleanup is unconfirmed");
  return contractPackageCorpusEvidenceSchema.parse({
    corpusId: CONTRACT_PACKAGE_CORPUS_ID, contractVersion: authority.contractVersion, authoritySha256: authority.manifestSha256, binding: options.binding, wire,
    roots: authority.roots.map(root => ({ id: root.path, sha256: root.sha256, evidencePointer: root.direction === "output" ? `wire/outputs/${wire.outputs.findIndex(row => row.tool === root.tool)}` : `wire/inputs/${wire.inputs.findIndex(row => row.tool === root.tool && row.valid)}` })),
    sharedDefinitions: authority.sharedDefinitions.map(def => ({ id: def.root + def.pointer, rootEvidencePointer: `roots/${authority.roots.findIndex(root => root.path === def.root)}` })),
    fixtures: authority.fixtures.flatMap(fixture => fixture.fields.map(field => ({ id: fixture.path + "#" + field.pointer, valid: fixture.valid, direction: field.direction, mode: field.direction === "input" ? "executed" : "validator-only", evidencePointer: field.direction === "input" ? `wire/inputs/${wire.inputs.findIndex(row => row.id === fixture.path + "#" + field.pointer)}` : `wire/outputFixtures/${wire.outputFixtures.findIndex(row => row.id === fixture.path + "#" + field.pointer)}` }))),
    crossCalls: crossCalls.map((proof, index) => ({ id: proof.scenarioId, evidenceSha256: contractDigest(proof), evidencePointer: `crossCalls/${index}/observations`, source: "real-loopback", observations: proof.observations, proof })),
    beforeInventorySha256: options.beforeInventorySha256, afterInventorySha256: options.afterInventorySha256, cleanup: { ...options.cleanup, sessionClosed: true },
    eventLog: wire.eventLog, assertions: [CONTRACT_PACKAGE_ASSERTION], verdict: "passed",
  });
}

export interface ContractFixtureWireEvidence {
  readonly authoritySha256: string;
  readonly inputs: readonly { id: string; tool: ContractToolName; valid: boolean; requestSha256: string; responseSha256: string | null; rejected: boolean }[];
  readonly outputs: readonly { tool: ContractToolName; root: string; responseSha256: string; requestEvidencePointer: string; structuredTextIdentical: true }[];
  readonly outputFixtures: readonly { id: string; root: string; valid: boolean; mode: "validator-only"; associatedOutputPointer: string }[];
  readonly unknownFieldRejections: readonly { tool: ContractToolName; requestSha256: string }[];
  readonly eventLog: readonly { sequence: number; kind: "tool" | "assertion" | "cleanup"; name: string; detailSha256: string }[];
  readonly cleanup: { sessionClosed: true };
  readonly verdict: "passed";
}

/** Only inputs enter tools/call; output examples exercise validators, never the endpoint. */
export async function runContractFixtureWireCorpus(options: {
  readonly authority: VersionContractPackage;
  readonly endpoint: URL;
  readonly expectedVaultId: string;
}): Promise<ContractFixtureWireEvidence> {
  if (options.endpoint.protocol !== "http:" || options.endpoint.hostname !== "127.0.0.1" || options.expectedVaultId.length === 0) throw new ContractPackageCorpusError("Contract corpus requires identity-bound loopback HTTP");
  // Recheck at consumption so a stale loaded inventory cannot conceal changed bytes.
  const authority = await loadVersionContractPackage(options.authority.packageRoot);
  if (authority.manifestSha256 !== options.authority.manifestSha256) throw new ContractPackageCorpusError("Contract authority changed before execution");
  const client = new Client({ name: "version-contract-corpus", version: authority.contractVersion });
  const transport = new StreamableHTTPClientTransport(options.endpoint, { requestInit: { headers: { [EXPECTED_VAULT_ID_HEADER]: options.expectedVaultId } } });
  const inputs: ContractFixtureWireEvidence["inputs"][number][] = [];
  const outputs: ContractFixtureWireEvidence["outputs"][number][] = [];
  const outputFixtures: ContractFixtureWireEvidence["outputFixtures"][number][] = [];
  const unknownFieldRejections: ContractFixtureWireEvidence["unknownFieldRejections"][number][] = [];
  const eventLog: ContractFixtureWireEvidence["eventLog"][number][] = [];
  const record = (kind: "tool" | "assertion" | "cleanup", name: string, detail: unknown): void => { eventLog.push({ sequence: eventLog.length + 1, kind, name, detailSha256: contractDigest(detail) }); };
  const call = async (tool: ContractToolName, arguments_: Record<string, unknown>, id: string, valid: boolean): Promise<void> => {
    let result: Awaited<ReturnType<Client["callTool"]>>;
    try { result = await client.callTool({ name: tool, arguments: arguments_ }); }
    catch (error) {
      // Input rejection must be a protocol validation error, not a lost connection.
      if (!valid && typeof error === "object" && error !== null && "code" in error && error.code === -32602) {
        inputs.push({ id, tool, valid, requestSha256: contractDigest(arguments_), responseSha256: null, rejected: true }); record("tool", id, { rejected: true }); return;
      }
      throw new ContractPackageCorpusError(`Contract input execution failed: ${id}`);
    }
    if (!valid) {
      const typedInvalid = tool === "vault_change_set_submit" && contract.changeSetSubmitResultSchema.safeParse(result.structuredContent).success && (result.structuredContent as { outcome: string }).outcome === "request_invalid";
      if (result.isError !== true || (result.structuredContent !== undefined && !typedInvalid)) throw new ContractPackageCorpusError(`Invalid input was ignored: ${id}`);
      if (typedInvalid) {
        const text = Array.isArray(result.content) ? result.content.filter(item => item.type === "text") : [];
        if (text.length !== 1 || text[0]?.text !== JSON.stringify(result.structuredContent)) throw new ContractPackageCorpusError(`Structured/text representation mismatch: ${id}`);
      }
      inputs.push({ id, tool, valid, requestSha256: contractDigest(arguments_), responseSha256: contractDigest(result), rejected: true }); record("tool", id, { rejected: true }); return;
    }
    const parsed = validators[tool].output.parse(result.structuredContent);
    const text = Array.isArray(result.content) ? result.content.filter(item => item.type === "text") : [];
    if (text.length !== 1 || text[0]?.text !== JSON.stringify(parsed) || canonicalJson(parsed) !== canonicalJson(result.structuredContent)) throw new ContractPackageCorpusError(`Structured/text representation mismatch: ${id}`);
    const responseSha256 = contractDigest(result.structuredContent);
    inputs.push({ id, tool, valid, requestSha256: contractDigest(arguments_), responseSha256, rejected: false });
    record("tool", id, { requestSha256: contractDigest(arguments_), responseSha256 });
    if (!outputs.some(row => row.tool === tool)) outputs.push({ tool, root: authority.roots.find(root => root.tool === tool && root.direction === "output")!.path, responseSha256, requestEvidencePointer: `inputs/${inputs.length - 1}`, structuredTextIdentical: true });
  };
  try {
    await client.connect(transport);
    exactCoverage((await client.listTools()).tools.map(tool => tool.name), toolNames, "public tools");
    const firstInputs = new Map<ContractToolName, Record<string, unknown>>();
    for (const fixture of authority.fixtures) {
      const value = JSON.parse(await readFile(join(authority.packageRoot, fixture.path), "utf8"));
      for (const field of fixture.fields) {
        if (field.direction !== "input") continue;
        const candidate = (field.pointer === "" ? value : value[field.pointer.slice(1)]) as Record<string, unknown>;
        await call(field.tool, candidate, fixture.path + "#" + field.pointer, fixture.valid);
        if (fixture.valid && !firstInputs.has(field.tool)) firstInputs.set(field.tool, candidate);
      }
    }
    // Health has an empty input root but no input fixture in the original package.
    if (!firstInputs.has("vault_health")) { firstInputs.set("vault_health", {}); await call("vault_health", {}, "roots/vault_health/input", true); }
    for (const tool of toolNames) {
      const valid = firstInputs.get(tool);
      if (valid === undefined) throw new ContractPackageCorpusError(`No executable valid input for ${tool}`);
      const arguments_ = { ...valid, __contract_unknown_field: true };
      await call(tool, arguments_, `unknown-field/${tool}`, false);
      unknownFieldRejections.push({ tool, requestSha256: contractDigest(arguments_) });
    }
    exactCoverage(outputs.map(row => row.tool), toolNames, "real output associations");
    for (const fixture of authority.fixtures) {
      for (const field of fixture.fields.filter(field => field.direction === "output")) {
        outputFixtures.push({ id: fixture.path + "#" + field.pointer, valid: fixture.valid, root: authority.roots.find(root => root.tool === field.tool && root.direction === "output")!.path, mode: "validator-only", associatedOutputPointer: `outputs/${outputs.findIndex(row => row.tool === field.tool)}` });
        record("assertion", fixture.path + "#" + field.pointer, { valid: fixture.valid, validatorOnly: true });
      }
    }
  } finally {
    // A close failure cannot turn into passing cleanup evidence.
    await client.close(); record("cleanup", "mcp-session-closed", { closed: true });
  }
  const evidence: ContractFixtureWireEvidence = { authoritySha256: authority.manifestSha256, inputs, outputs, outputFixtures, unknownFieldRejections, eventLog, cleanup: { sessionClosed: true }, verdict: "passed" };
  executedWire.set(evidence, { endpoint: options.endpoint.toString(), expectedVaultId: options.expectedVaultId, snapshotSha256: contractDigest(evidence) });
  return evidence;
}

export async function loadVersionContractPackage(packageRoot: string): Promise<VersionContractPackage> {
  const manifest = manifestSchema.parse(JSON.parse(await readFile(join(packageRoot, "fixtures/v1/acceptance-manifest.json"), "utf8")));
  exactCoverage((await files(join(packageRoot, "schema/v1"))).map(p => "schema/v1/" + p), manifest.roots.map(r => r.path), "roots");
  exactCoverage(manifest.roots.map(r => `${r.tool}/${r.direction}`), toolNames.flatMap(tool => [tool + "/input", tool + "/output"]), "tool roots");
  const definitions: string[] = [];
  for (const root of manifest.roots) {
    const bytes = await readFile(join(packageRoot, root.path));
    if (createHash("sha256").update(bytes).digest("hex") !== root.sha256) throw new ContractPackageCorpusError("Root authority checksum mismatch");
    const schema = JSON.parse(bytes.toString("utf8"));
    if (contractDigest(schema) !== contractDigest(validators[root.tool][root.direction === "input" ? "inputJson" : "outputJson"]())) throw new ContractPackageCorpusError("Root schema differs from versioned validator");
    definitions.push(...Object.keys(schema.$defs ?? {}).map(key => root.path + "#/$defs/" + key));
  }
  exactCoverage(definitions, manifest.sharedDefinitions.map(d => d.root + d.pointer), "shared definitions");
  const scenarioBytes = await readFile(join(packageRoot, "fixtures/v1/scenarios.json"));
  const scenarios = JSON.parse(scenarioBytes.toString("utf8"));
  if (scenarios.contractVersion !== manifest.contractVersion) throw new ContractPackageCorpusError("Cross-call contract version mismatch");
  exactCoverage(scenarios.scenarios.map((s: { id: string; authority: string }) => s.id + "/" + s.authority), manifest.scenarios.map(s => s.id + "/" + s.authority), "cross-call scenarios");
  const programs: string[] = scenarios.scenarios.flatMap((s: { fixture?: string }) => s.fixture === undefined ? [] : ["fixtures/v1/" + s.fixture]);
  // A scenario may intentionally reuse a valid output fixture; it remains validator-only.
  const actualFixtureFiles = (await files(join(packageRoot, "fixtures/v1"))).map(p => "fixtures/v1/" + p);
  exactCoverage(actualFixtureFiles.filter(p => /\/(?:valid|invalid)\//u.test(p)), manifest.fixtures.map(f => f.path), "fixtures");
  exactCoverage(actualFixtureFiles, [...new Set(["fixtures/v1/acceptance-manifest.json", "fixtures/v1/scenarios.json", ...programs, ...manifest.fixtures.map(f => f.path)])], "fixture files");
  for (const fixture of manifest.fixtures) {
    const bytes = await readFile(join(packageRoot, fixture.path));
    if (createHash("sha256").update(bytes).digest("hex") !== fixture.sha256) throw new ContractPackageCorpusError("Fixture authority checksum mismatch");
    const value = JSON.parse(bytes.toString("utf8"));
    const keys = fixture.fields.map(f => f.pointer);
    exactCoverage(fixture.fields[0]?.pointer === "" ? [""] : Object.keys(value).map(k => "/" + k), keys, "fixture fields");
    if (fixture.valid !== fixture.path.split("/").includes("valid")) throw new ContractPackageCorpusError("Fixture validity authority mismatch");
    for (const field of fixture.fields) {
      const candidate = field.pointer === "" ? value : value[field.pointer.slice(1)];
      if (validators[field.tool][field.direction].safeParse(candidate).success !== fixture.valid) throw new ContractPackageCorpusError("Fixture validator accepted invalid output or refused valid value");
    }
  }
  const programValues = await Promise.all([...new Set(programs)].sort().map(async path => ({ path, value: JSON.parse(await readFile(join(packageRoot, path), "utf8")) })));
  return { ...manifest, packageRoot, manifestSha256: contractDigest({ manifest, scenarios, programValues }) };
}
