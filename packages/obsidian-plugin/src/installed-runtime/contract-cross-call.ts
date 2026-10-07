import { createHash } from "node:crypto";
import { request } from "node:http";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import * as contract from "@llm-wiki/vault-contracts";

import { parseChangeSetRegistryState } from "../change-set.js";
import { ContractPackageCorpusError, contractDigest, validateContractDependentReport, type ContractToolName, type VersionContractPackage } from "./contract-package-corpus.js";

export interface ContractCrossCallEvidence {
  readonly scenarioId: string;
  readonly authoritySha256: string;
  readonly binding: import("./contract-package-corpus.js").ContractPackageCorpusEvidence["binding"] | null;
  readonly observations: readonly { sequence: number; name: string; requestSha256: string; responseSha256: string; facts: Readonly<Record<string, string | number | boolean>> }[];
  readonly graphTransitions?: import("zod").z.infer<typeof import("./contract-package-corpus.js").contractGraphTransitionSchema>[];
  readonly programProof?: import("zod").z.infer<typeof import("./contract-package-corpus.js").contractProgramProofSchema> | null;
  readonly cleanup: { readonly sessionsClosed: boolean };
  readonly verdict: "passed" | "blocked";
  readonly requiredCorpus: string | null;
  readonly dependency: { readonly binding: NonNullable<ContractCrossCallEvidence["binding"]>; readonly sourceVaults: import("zod").z.infer<typeof import("./contract-package-corpus.js").contractSourceVaultSchema>[]; readonly reportSha256: string; readonly report: unknown } | null;
}
const executedCrossCalls = new WeakMap<object, { endpoint: string; vaultIdSha256: string; snapshotSha256: string }>();
export const isExecutedContractCrossCallEvidence = (value: unknown, endpoint: string, vaultIdSha256: string): value is ContractCrossCallEvidence => {
  if (typeof value !== "object" || value === null) return false;
  const binding = executedCrossCalls.get(value);
  return binding?.endpoint === endpoint && binding.vaultIdSha256 === vaultIdSha256 && binding.snapshotSha256 === contractDigest(value);
};
const contractDigestBytes = (content: string): string => createHash("sha256").update(Buffer.from(content, "utf8")).digest("hex");
const results = {
  vault_health: contract.parseHealthResult,
  vault_discover: contract.parseDiscoverResult,
  vault_read: contract.parseReadToolResult,
  vault_continue: contract.parseContinueResult,
  vault_change_set_submit: contract.parseChangeSetSubmitResult,
  vault_change_set_status: contract.parseChangeSetStatusResult,
};

/** A standalone scenario executor: no local authority actions, no manufactured installed proofs. */
export async function runContractCrossCallScenario(options: {
  readonly authority: VersionContractPackage;
  readonly scenarioId: string;
  readonly endpoint: URL;
  readonly expectedVaultId: string;
  readonly seedNotes?: readonly { path: string; content: string }[];
  readonly observeProgramState?: () => Promise<{ registryBytes: Uint8Array; inventory: readonly { path: string; sha256: string; sizeBytes: number }[] }>;
  readonly restart?: () => Promise<{ endpoint: URL; expectedVaultId: string }>;
  readonly invalidUtf8Path?: string;
  readonly readFixtureBytes?: (path: string) => Promise<Uint8Array | null>;
  readonly continuationTiming?: "full-real-time" | "binding-only";
  readonly submissionKeySuffix?: string;
  readonly quotaMetadataPath?: string;
  readonly binding?: NonNullable<ContractCrossCallEvidence["binding"]>;
  readonly dependency?: NonNullable<ContractCrossCallEvidence["dependency"]>;
  readonly predecessorProof?: ContractCrossCallEvidence;
}): Promise<ContractCrossCallEvidence> {
  const scenario = options.authority.scenarios.find(s => s.id === options.scenarioId);
  if (scenario === undefined) throw new ContractPackageCorpusError("Unknown cross-call scenario");
  if (options.endpoint.protocol !== "http:" || options.endpoint.hostname !== "127.0.0.1" || options.endpoint.pathname !== "/mcp" || options.expectedVaultId.length === 0) throw new ContractPackageCorpusError("Cross-call requires identity-bound loopback MCP");
  const observations: ContractCrossCallEvidence["observations"][number][] = [];
  const graphTransitions: NonNullable<ContractCrossCallEvidence["graphTransitions"]> = [];
  const clients: Client[] = [];
  const observe = (name: string, input: unknown, output: unknown, facts: Record<string, string | number | boolean>): void => { observations.push({ sequence: observations.length + 1, name, requestSha256: contractDigest(input), responseSha256: contractDigest(output), facts }); };
  const connect = async (): Promise<Client> => {
    const client = new Client({ name: "contract-cross-call", version: options.authority.contractVersion }); clients.push(client);
    await client.connect(new StreamableHTTPClientTransport(options.endpoint, { requestInit: { headers: { "X-Expected-Vault-ID": options.expectedVaultId } } }));
    return client;
  };
  const call = async (client: Client, tool: ContractToolName, arguments_: Record<string, unknown>): Promise<unknown> => {
    const raw = await client.callTool({ name: tool, arguments: arguments_ });
    const parsed = results[tool](raw.structuredContent);
    const text = Array.isArray(raw.content) ? raw.content.filter(item => item.type === "text") : [];
    if (text.length !== 1 || text[0]?.text !== JSON.stringify(parsed) || contractDigest(parsed) !== contractDigest(raw.structuredContent)) throw new ContractPackageCorpusError("Cross-call representation mismatch");
    observe(tool, arguments_, parsed, { schemaValid: true, structuredTextIdentical: true, isError: raw.isError === true });
    return parsed;
  };
  let requiredCorpus: string | null = null;
  let programProof: ContractCrossCallEvidence["programProof"] = null;
  const observeProgramState = async () => {
    const raw = await options.observeProgramState!();
    const parsed = JSON.parse(Buffer.from(raw.registryBytes).toString("utf8"));
    const registry = parseChangeSetRegistryState("changeSets" in parsed ? parsed.changeSets : parsed);
    return { registrySha256: createHash("sha256").update(raw.registryBytes).digest("hex"), nextEnqueueSeq: registry.nextEnqueueSeq, entries: registry.entries.map(entry => ({ submissionKeySha256: contractDigest(entry.submissionKey), fingerprint: entry.fingerprint, changeSetIdSha256: contractDigest(entry.changeSetId), enqueueSeq: entry.enqueueSeq, recordSha256: contractDigest(entry.changeSet), state: entry.changeSet.state, phase: entry.execution?.phase ?? null })), inventory: [...raw.inventory].sort((a, b) => a.path.localeCompare(b.path)) };
  };
  try {
    switch (scenario.execution) {
      case "identity-health": {
        const value = contract.parseHealthResult(await call(await connect(), "vault_health", {}));
        if (value.outcome !== "observed" || value.vault.id !== options.expectedVaultId || value.listener.port !== Number(options.endpoint.port)) throw new ContractPackageCorpusError("Cross-call health identity mismatch");
        observe("identity-bound-health", {}, value, { identityMatched: true, listenerMatched: true }); break;
      }
      case "missing-identity":
      case "wrong-identity": {
        const headers = scenario.execution === "missing-identity" ? {} : { "X-Expected-Vault-ID": options.expectedVaultId + "-wrong" };
        const requests = [{ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }, ...options.authority.roots.filter(root => root.direction === "input").map(root => ({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: root.tool, arguments: {} } }))];
        for (const message of requests) {
          const status = await new Promise<number>((resolve, reject) => {
            const req = request(options.endpoint, { method: "POST", headers: { "Content-Type": "application/json", ...headers } }, response => { response.resume(); response.once("end", () => resolve(response.statusCode ?? 0)); response.once("error", reject); });
            req.setTimeout(10_000, () => req.destroy(new Error("Identity probe timeout"))); req.once("error", reject); req.end(JSON.stringify(message));
          });
          if (status !== 403) throw new ContractPackageCorpusError("Identity mismatch did not reject before dispatch");
          observe(message.method, message, { status }, { status, rejectedBeforeDispatch: true });
        }
        break;
      }
      case "structured-text": {
        await call(await connect(), "vault_health", {}); break;
      }
      case "section-no-fallback": {
        const args = { items: [{ kind: "section", path: "Notes/Welcome.md", hierarchy: ["Installed Runtime Harness"], occurrence: 999 }] };
        const result = contract.parseReadToolResult(await call(await connect(), "vault_read", args));
        if (!("outcome" in result) || result.outcome !== "items" || result.items.length !== 1 || result.items[0]?.outcome !== "not_satisfied") throw new ContractPackageCorpusError("Section occurrence fell back");
        observe("no-section-fallback", args, result, { noFallback: true }); break;
      }
      case "change-set-program": {
        const manifest = JSON.parse(await readFile(join(options.authority.packageRoot, "fixtures/v1/scenarios.json"), "utf8")) as { scenarios: { id: string; fixture?: string }[] };
        const fixture = manifest.scenarios.find(s => s.id === scenario.id)?.fixture;
        if (fixture === undefined) throw new ContractPackageCorpusError("Cross-call program missing");
          const program = JSON.parse(await readFile(join(options.authority.packageRoot, "fixtures/v1", fixture), "utf8")) as { steps: { call: string; arguments: Record<string, unknown>; capture?: string; expect: { outcome?: string; lookup?: string; state?: string; failureCode?: string; sameChangeSetAs?: string; code?: string } }[] };
        const captured = new Map<string, string>(); const client = await connect();
        const needsRepeatProof = ["change-set-same-key-replay", "change-set-key-conflict"].includes(scenario.id);
        if (needsRepeatProof && options.observeProgramState === undefined) { requiredCorpus = "durable-registry-public-inventory"; break; }
        const beforeSubmission = needsRepeatProof ? await observeProgramState() : null;
        let beforeRepeat: Awaited<ReturnType<typeof observeProgramState>> | null = null;
        let responseRecordSha256 = "";
        for (const [stepIndex, step] of program.steps.entries()) {
          const tool = step.call === "submit" ? "vault_change_set_submit" : "vault_change_set_status";
          const value = await call(client, tool, step.arguments) as { outcome?: string; lookup?: string; code?: string; changeSet?: { changeSetId: string; state: string; failure?: { code: string } } };
          if (step.expect.outcome !== undefined && value.outcome !== step.expect.outcome || step.expect.lookup !== undefined && value.lookup !== step.expect.lookup || step.expect.code !== undefined && value.code !== step.expect.code || step.expect.failureCode !== undefined && value.changeSet?.failure?.code !== step.expect.failureCode || step.expect.state !== undefined && (step.expect.state === "in_progress" ? !["in_progress", "intent_applied"].includes(value.changeSet?.state ?? "") : value.changeSet?.state !== step.expect.state) || step.expect.sameChangeSetAs !== undefined && value.changeSet?.changeSetId !== captured.get(step.expect.sameChangeSetAs)) throw new ContractPackageCorpusError("Cross-call program behavior mismatch");
          // Installed execution can terminalize before the response; never demand a synthetic in_progress state.
          if (step.capture !== undefined && value.changeSet !== undefined) captured.set(step.capture, value.changeSet.changeSetId);
          observe("program-expectation", step.expect, value, { expectationMatched: true });
          if (needsRepeatProof && stepIndex === 0) {
            const key = step.arguments.submissionKey;
            const deadline = Date.now() + 30_000;
            while (true) {
              const status = contract.parseChangeSetStatusResult(await call(client, "vault_change_set_status", { submissionKey: key }));
              if (status.lookup === "found" && status.changeSet.state === "intent_applied") { responseRecordSha256 = contractDigest(status.changeSet); observe("durable-status-record", { submissionKey: key }, status, { recordSha256: responseRecordSha256, changeSetIdSha256: contractDigest(status.changeSet.changeSetId) }); break; }
              if (status.lookup === "found" && status.changeSet.state !== "in_progress" || Date.now() >= deadline) throw new ContractPackageCorpusError("Replay baseline did not durably apply");
              await new Promise(resolve => setTimeout(resolve, 25));
            }
            beforeRepeat = await observeProgramState();
          }
        }
        if (needsRepeatProof) {
          const afterRepeat = await observeProgramState();
          const keySha256 = contractDigest(program.steps[0]!.arguments.submissionKey);
          const entry = beforeRepeat!.entries.filter(entry => entry.submissionKeySha256 === keySha256);
          if (entry.length !== 1 || entry[0]!.state !== "intent_applied" || entry[0]!.recordSha256 !== responseRecordSha256 || contractDigest(beforeRepeat) !== contractDigest(afterRepeat) || beforeSubmission!.entries.some(entry => entry.submissionKeySha256 === keySha256) || beforeRepeat!.nextEnqueueSeq !== beforeSubmission!.nextEnqueueSeq + 1) throw new ContractPackageCorpusError("Replay/conflict changed durable registry or public raw bytes");
          programProof = { submissionKeySha256: keySha256, requestSha256: contractDigest(program.steps[0]!.arguments), responseRecordSha256, beforeSubmission: beforeSubmission!, beforeRepeat: beforeRepeat!, afterRepeat };
          observe("durable-repeat-no-side-effects", { requestSha256: programProof.requestSha256 }, programProof, { durableRecordPreserved: true, completePublicInventoryPreserved: true, noDuplicateEnqueue: true });
        }
        break;
      }
      case "frozen-continuation": {
        const source = options.seedNotes?.find(note => note.path === "Notes/Transport.md");
        if (source === undefined) throw new ContractPackageCorpusError("Frozen scenario needs deterministic source bytes");
        const client = await connect();
        const first = contract.parseReadToolResult(await call(client, "vault_read", { items: [{ kind: "exact", path: source.path }] }));
        if (!("outcome" in first) || first.outcome !== "page" || first.continuation === null) throw new ContractPackageCorpusError("Frozen scenario did not issue transport pages");
        const changed = source.content + "\ncontract-frozen-successor\n";
        const args = { submissionKey: "contract-frozen-" + options.authority.manifestSha256.slice(0, 12) + (options.submissionKeySuffix === undefined ? "" : "-" + options.submissionKeySuffix), operations: [{ operationId: "change-source", kind: "edit_body", path: source.path, targetVersion: "sha256:" + contractDigestBytes(source.content), edit: { kind: "replace_whole", replacement: changed.startsWith("﻿") ? changed.slice(1) : changed } }] };
        try {
        const submit = contract.parseChangeSetSubmitResult(await call(client, "vault_change_set_submit", args));
        if (submit.outcome !== "registered" || submit.changeSet.state === "intent_not_applied") { requiredCorpus = "mutation-executor"; break; }
        let terminal: string = submit.changeSet.state;
        const deadline = Date.now() + 30_000;
        while (terminal === "in_progress" && Date.now() < deadline) {
          await new Promise(resolve => setTimeout(resolve, 25));
          const status = contract.parseChangeSetStatusResult(await call(client, "vault_change_set_status", { submissionKey: args.submissionKey }));
          if (status.lookup === "found") terminal = status.changeSet.state;
        }
        if (terminal !== "intent_applied") throw new ContractPackageCorpusError("Frozen source mutation did not apply");
        const successor = contract.parseReadToolResult(await call(client, "vault_read", { items: [{ kind: "metadata", path: source.path }] }));
        if (!("outcome" in successor) || successor.outcome !== "items" || successor.items[0]?.outcome !== "satisfied" || successor.items[0].result.contentVersion !== "sha256:" + contractDigestBytes(changed)) throw new ContractPackageCorpusError("Frozen source bytes were not changed");
        const pages = [first]; let token: string | null = first.continuation;
        while (token !== null) {
          const page = contract.parseContinueResult(await call(client, "vault_continue", { continuation: token }));
          if (!("outcome" in page) || page.outcome !== "page") throw new ContractPackageCorpusError("Frozen chain lost after mutation");
          pages.push(page); token = page.continuation;
        }
        let offset = 0; let reconstructed = "";
        for (const page of pages) for (const item of page.items) {
          if (!("content" in item) || !("start" in item) || item.start !== offset || Buffer.byteLength(item.content, "utf8") !== item.end - item.start || Buffer.byteLength(JSON.stringify({ structuredContent: page, content: [{ type: "text", text: JSON.stringify(page) }], isError: false })) > 262_144) throw new ContractPackageCorpusError("Frozen continuation byte ranges or page bound invalid");
          offset = item.end; reconstructed += item.content;
        }
        if (reconstructed !== source.content) throw new ContractPackageCorpusError("Frozen continuation changed with source bytes");
        observe("frozen-after-source-change", { beforeSha256: contractDigestBytes(source.content) }, { afterSha256: contractDigestBytes(changed), reconstructedSha256: contractDigestBytes(reconstructed) }, { sourceChanged: true, exactFrozenBytes: true, pageCount: pages.length, sizeBytes: offset });
        } finally {
        const cleanupStatusDeadline = Date.now() + 30_000;
        let mutationApplied = false;
        while (true) {
          const status = contract.parseChangeSetStatusResult(await call(client, "vault_change_set_status", { submissionKey: args.submissionKey }));
          if (status.lookup === "found" && status.changeSet.state === "intent_applied") { mutationApplied = true; break; }
          if (status.lookup === "found" && status.changeSet.state !== "in_progress") break;
          if (status.lookup !== "found" || Date.now() >= cleanupStatusDeadline) throw new ContractPackageCorpusError("Frozen source mutation state uncertain; cleanup cannot be confirmed");
          await new Promise(resolve => setTimeout(resolve, 25));
        }
        if (mutationApplied) {
        const restore = { submissionKey: args.submissionKey + "-restore", operations: [{ operationId: "restore-source", kind: "edit_body", path: source.path, targetVersion: "sha256:" + contractDigestBytes(changed), edit: { kind: "replace_whole", replacement: source.content.startsWith("﻿") ? source.content.slice(1) : source.content } }] };
        await call(client, "vault_change_set_submit", restore);
        const restoreDeadline = Date.now() + 30_000;
        while (true) {
          const status = contract.parseChangeSetStatusResult(await call(client, "vault_change_set_status", { submissionKey: restore.submissionKey }));
          if (status.lookup === "found" && status.changeSet.state === "intent_applied") break;
          if (status.lookup === "found" && status.changeSet.state !== "in_progress") throw new ContractPackageCorpusError("Frozen source cleanup rejected; bytes may remain changed");
          if (Date.now() >= restoreDeadline) throw new ContractPackageCorpusError("Frozen source cleanup unconfirmed");
          await new Promise(resolve => setTimeout(resolve, 25));
        }
        }
        const restored = contract.parseReadToolResult(await call(client, "vault_read", { items: [{ kind: "metadata", path: source.path }] }));
        if (!("outcome" in restored) || restored.outcome !== "items" || restored.items[0]?.outcome !== "satisfied" || restored.items[0].result.contentVersion !== "sha256:" + contractDigestBytes(source.content)) throw new ContractPackageCorpusError("Frozen source cleanup bytes unconfirmed");
        }
        break;
      }
      case "client-bound-sliding": {
        const client = await connect(); const other = await connect();
        const start = Date.now();
        const source = options.seedNotes?.find(note => note.path === "Notes/GroupLarge.md");
        if (source === undefined) throw new ContractPackageCorpusError("Sliding scenario requires a multi-page seed");
        const first = contract.parseReadToolResult(await call(client, "vault_read", { items: [{ kind: "exact", path: source.path }] }));
        if (!("outcome" in first) || first.outcome !== "page" || first.continuation === null) throw new ContractPackageCorpusError("Client-bound scenario did not issue a token");
        const token = first.continuation;
        const wrong = contract.parseContinueResult(await call(other, "vault_continue", { continuation: token }));
        if (!("code" in wrong) || wrong.code !== "continuation_unavailable") throw new ContractPackageCorpusError("Wrong client consumed another session's token");
        observe("wrong-client-token-rejected", { tokenSha256: contractDigest(token) }, wrong, { wrongClientRejected: true });
        if (options.continuationTiming !== "binding-only") await new Promise(resolve => setTimeout(resolve, 600_000));
        const replacementIssuedAt = Date.now();
        const second = contract.parseContinueResult(await call(client, "vault_continue", { continuation: token }));
        if (!("outcome" in second) || second.outcome !== "page" || second.continuation === null) throw new ContractPackageCorpusError("Wrong-client request destroyed owner token or multi-page fixture incomplete");
        observe("original-client-token-preserved", { tokenSha256: contractDigest(token) }, second, { ownerTokenPreserved: true, elapsedMs: replacementIssuedAt - start });
        const replay = contract.parseContinueResult(await call(client, "vault_continue", { continuation: token }));
        if (!("code" in replay) || replay.code !== "continuation_unavailable") throw new ContractPackageCorpusError("Consumed token replay accepted");
        observe("consumed-token-replay-rejected", { tokenSha256: contractDigest(token) }, replay, { consumedRejected: true });
        const malformed = contract.parseContinueResult(await call(client, "vault_continue", { continuation: "contract-not-a-token" }));
        if (!("code" in malformed) || malformed.code !== "continuation_unavailable") throw new ContractPackageCorpusError("Malformed token did not expose only continuation_unavailable");
        observe("malformed-token-rejected", {}, malformed, { malformedRejected: true });
        let next: string | null = second.continuation;
        if (options.continuationTiming === "binding-only") requiredCorpus = "continuation-expiry-sliding-time";
        else {
          // Beyond the first token's real 15-minute lifetime, but within the replacement's lifetime.
          await new Promise(resolve => setTimeout(resolve, 310_000));
          const sliding = contract.parseContinueResult(await call(client, "vault_continue", { continuation: next }));
          if (!("outcome" in sliding) || sliding.outcome !== "page" || Date.now() - start < 900_000 || Date.now() - replacementIssuedAt >= 900_000) throw new ContractPackageCorpusError("Replacement did not receive an independent sliding lifetime");
          observe("real-time-sliding-lifetime", {}, sliding, { originalAgeMs: Date.now() - start, replacementAgeMs: Date.now() - replacementIssuedAt, replacementSurvivesOriginalExpiry: true });
          next = sliding.continuation;
          const expiring = contract.parseReadToolResult(await call(client, "vault_read", { items: [{ kind: "exact", path: source.path }] }));
          if (!("outcome" in expiring) || expiring.outcome !== "page" || expiring.continuation === null) throw new ContractPackageCorpusError("Expiry token not issued");
          const expiryStart = Date.now(); await new Promise(resolve => setTimeout(resolve, 901_000));
          const expired = contract.parseContinueResult(await call(client, "vault_continue", { continuation: expiring.continuation }));
          if (!("code" in expired) || expired.code !== "continuation_unavailable" || Date.now() - expiryStart < 900_000) throw new ContractPackageCorpusError("Real-time expired token accepted");
          observe("real-time-token-expiry", {}, expired, { elapsedMs: Date.now() - expiryStart, expiredRejected: true });
          // Any earlier residual chain also expired during this wait; session close releases remaining retained bytes.
          next = null;
        }
        while (next !== null) {
          const page = contract.parseContinueResult(await call(client, "vault_continue", { continuation: next }));
          if (!("outcome" in page) || page.outcome !== "page") throw new ContractPackageCorpusError("Client-bound cleanup did not drain token");
          next = page.continuation;
        }
        break;
      }
      case "mixed-read": {
        const paths = ["Notes/Bom.md", "Notes/CjkAstral.md", "Notes/Bom.md"];
        const expected = paths.map(path => options.seedNotes?.find(note => note.path === path)?.content);
        if (expected.some(content => content === undefined)) throw new ContractPackageCorpusError("Mixed-read requires byte-exact seed");
        const args = { items: [{ kind: "metadata", path: paths[0] }, ...paths.map(path => ({ kind: "exact", path }))] };
        const value = contract.parseReadToolResult(await call(await connect(), "vault_read", args));
        if (!("outcome" in value) || value.outcome !== "items" || value.items.length !== 4) throw new ContractPackageCorpusError("Mixed read index lost");
        for (let index = 0; index < paths.length; index++) {
          const item = value.items[index + 1]; const content = expected[index]!;
          if (item?.outcome !== "satisfied" || item.result.kind !== "exact" || item.result.index !== index + 1 || item.result.path !== paths[index] || item.result.content !== content || item.result.sizeBytes !== Buffer.byteLength(content) || item.result.contentVersion !== "sha256:" + contractDigestBytes(content)) throw new ContractPackageCorpusError("Mixed read bytes/index/version mismatch");
        }
        observe("ordered-duplicate-exact-bytes", args, value, { duplicatePreserved: true, exactBytes: true, canonicalContentVersions: true }); break;
      }
      case "limit-grouping": {
        const client = await connect();
        const single = contract.parseReadToolResult(await call(client, "vault_read", { items: [{ kind: "exact", path: "Notes/OverLimit.md" }] }));
        if (!("outcome" in single) || single.outcome !== "items" || single.items[0]?.outcome !== "note_exceeds_exact_read_limit") throw new ContractPackageCorpusError("Exact-read limit not enforced");
        const grouping = contract.parseReadToolResult(await call(client, "vault_read", { items: [{ kind: "exact", path: "Notes/Transport.md" }, { kind: "exact", path: "Notes/GroupLarge.md" }, { kind: "metadata", path: "Notes/Transport.md" }] }));
        if (!("outcome" in grouping) || grouping.outcome !== "grouping_required" || grouping.suggestedGroups.length < 2 || grouping.suggestedGroups[0]?.startIndex !== 0 || grouping.suggestedGroups.at(-1)?.endIndexExclusive !== 3 || grouping.suggestedGroups.some((group, index) => group.exactReadBytes > 1_048_576 || index > 0 && grouping.suggestedGroups[index - 1]?.endIndexExclusive !== group.startIndex) || JSON.stringify(grouping).includes('"content"')) throw new ContractPackageCorpusError("Deterministic contiguous grouping not enforced");
        observe("limit-and-contiguous-grouping", {}, grouping, { singleNoteRefused: true, noPartialContent: true, contiguousOrderedGroups: true }); break;
      }
      case "quota-cleanup": {
        const client = await connect(); const tokens: string[] = [];
        for (let index = 0; index < 8; index++) {
          const page = contract.parseReadToolResult(await call(client, "vault_read", { items: [{ kind: "exact", path: "Notes/Transport.md" }] }));
          if (!("outcome" in page) || page.outcome !== "page" || page.continuation === null) throw new ContractPackageCorpusError("Quota setup failed");
          tokens.push(page.continuation);
        }
        const refused = contract.parseReadToolResult(await call(client, "vault_read", { items: [{ kind: "exact", path: "Notes/Transport.md" }] }));
        if (!("code" in refused) || refused.code !== "continuation_unavailable") throw new ContractPackageCorpusError("Ninth live chain accepted");
        let replacementToken: string | null = null;
        for (const [chainIndex, initial] of tokens.entries()) {
          let token: string | null = initial;
          while (token !== null) {
            const page = contract.parseContinueResult(await call(client, "vault_continue", { continuation: token }));
            if (!("outcome" in page) || page.outcome !== "page") throw new ContractPackageCorpusError("Quota refusal evicted live chain");
            token = page.continuation;
          }
          const replay = contract.parseContinueResult(await call(client, "vault_continue", { continuation: initial }));
          if (!("code" in replay) || replay.code !== "continuation_unavailable") throw new ContractPackageCorpusError("Quota consumed token still live");
          if (chainIndex === 0) {
            const replacement = contract.parseReadToolResult(await call(client, "vault_read", { items: [{ kind: "exact", path: "Notes/Transport.md" }] }));
            if (!("outcome" in replacement) || replacement.outcome !== "page" || replacement.continuation === null) throw new ContractPackageCorpusError("Rejected issuance leaked chain authority after one completion");
            replacementToken = replacement.continuation;
          }
        }
        while (replacementToken !== null) {
          const page = contract.parseContinueResult(await call(client, "vault_continue", { continuation: replacementToken }));
          if (!("outcome" in page) || page.outcome !== "page") throw new ContractPackageCorpusError("Replacement chain unavailable after rejected issuance");
          replacementToken = page.continuation;
        }
        observe("rejected-issuance-has-no-retained-authority", {}, refused, { replacementAcceptedImmediately: true, remainingSevenPreserved: true, rejectedTokenPublished: false });
        const next = contract.parseReadToolResult(await call(client, "vault_read", { items: [{ kind: "exact", path: "Notes/Transport.md" }] }));
        if (!("outcome" in next) || next.outcome !== "page" || next.continuation === null) throw new ContractPackageCorpusError("Completion did not release capacity");
        await client.close();
        const reopened = await connect();
        const abandoned = contract.parseContinueResult(await call(reopened, "vault_continue", { continuation: next.continuation }));
        if (!("code" in abandoned) || abandoned.code !== "continuation_unavailable") throw new ContractPackageCorpusError("Session teardown retained token authority");
        const fresh = contract.parseReadToolResult(await call(reopened, "vault_read", { items: [{ kind: "exact", path: "Notes/Transport.md" }] }));
        if (!("outcome" in fresh) || fresh.outcome !== "page") throw new ContractPackageCorpusError("New session lacks freed capacity");
        observe("quota-preserved-and-session-capacity-released", {}, fresh, { eightChainsSurvived: true, ninthRejected: true, consumedReplayRejected: true, completionReleasedCapacity: true, closedSessionTokenRejected: true });
        if (options.quotaMetadataPath === undefined) { requiredCorpus = "continuation-full-lifecycle-cleanup"; break; }
        const byteClient = await connect();
        const metadataInput = { items: [{ kind: "metadata", path: options.quotaMetadataPath }] };
        const large = contract.parseReadToolResult(await call(byteClient, "vault_read", metadataInput));
        if (!("outcome" in large) || large.outcome !== "page" || large.continuation === null || large.items.length !== 1 || !("kind" in large.items[0]!) || large.items[0]!.kind !== "item") throw new ContractPackageCorpusError("Retained-byte fixture did not issue metadata chunks");
        const firstChunk = large.items[0];
        if (!("sizeBytes" in firstChunk) || !("end" in firstChunk)) throw new ContractPackageCorpusError("Retained-byte measurement unavailable");
        const retained = firstChunk.sizeBytes - firstChunk.end;
        if (retained <= 4 * 1_048_576 || retained > 8 * 1_048_576) throw new ContractPackageCorpusError("Retained-byte fixture cannot distinguish bytes from chain quota");
        const byteRefused = contract.parseReadToolResult(await call(byteClient, "vault_read", metadataInput));
        if (!("code" in byteRefused) || byteRefused.code !== "continuation_unavailable") throw new ContractPackageCorpusError("8MiB retained-byte quota not enforced independently of chain quota");
        let byteToken: string | null = large.continuation;
        while (byteToken !== null) {
          const page = contract.parseContinueResult(await call(byteClient, "vault_continue", { continuation: byteToken }));
          if (!("outcome" in page) || page.outcome !== "page") throw new ContractPackageCorpusError("Byte quota rejection evicted accepted chain");
          byteToken = page.continuation;
        }
        const released = contract.parseReadToolResult(await call(byteClient, "vault_read", metadataInput));
        if (!("outcome" in released) || released.outcome !== "page" || released.continuation === null) throw new ContractPackageCorpusError("Byte chain completion did not release retained capacity");
        observe("retained-byte-quota-no-eviction", metadataInput, byteRefused, { retainedBytesBeforeRefusal: retained, retainedByteLimit: 8 * 1_048_576, acceptedChains: 1, secondRejected: true, acceptedChainDrained: true, completionReleasedCapacity: true });
        if (options.continuationTiming === "binding-only") { requiredCorpus = "continuation-full-lifecycle-cleanup"; break; }
        const issuedAt = Date.now();
        await new Promise(resolve => setTimeout(resolve, 901_000));
        const expired = contract.parseContinueResult(await call(byteClient, "vault_continue", { continuation: released.continuation }));
        if (!("code" in expired) || expired.code !== "continuation_unavailable") throw new ContractPackageCorpusError("Quota expiry retained token authority");
        const afterExpiry = contract.parseReadToolResult(await call(byteClient, "vault_read", metadataInput));
        if (!("outcome" in afterExpiry) || afterExpiry.outcome !== "page" || afterExpiry.continuation === null) throw new ContractPackageCorpusError("Quota expiry did not release byte capacity");
        observe("expiry-releases-retained-capacity", {}, afterExpiry, { elapsedMs: Date.now() - issuedAt, expiredTokenRejected: true, capacityReleased: true });
        if (options.restart === undefined) { requiredCorpus = "controlled-installed-restart"; break; }
        await Promise.all(clients.map(client => client.close()));
        const restarted = await options.restart();
        if (restarted.endpoint.toString() !== options.endpoint.toString() || restarted.expectedVaultId !== options.expectedVaultId) throw new ContractPackageCorpusError("Quota Bridge teardown changed Vault/endpoint authority");
        const afterClient = await connect();
        const abandonedAfterBridge = contract.parseContinueResult(await call(afterClient, "vault_continue", { continuation: afterExpiry.continuation }));
        if (!("code" in abandonedAfterBridge) || abandonedAfterBridge.code !== "continuation_unavailable") throw new ContractPackageCorpusError("Bridge teardown retained token authority");
        const capacity = contract.parseReadToolResult(await call(afterClient, "vault_read", metadataInput));
        if (!("outcome" in capacity) || capacity.outcome !== "page") throw new ContractPackageCorpusError("Bridge teardown failed to release capacity");
        observe("bridge-teardown-releases-retained-capacity", {}, capacity, { oldTokenRejected: true, capacityReleased: true }); break;
      }
      case "invalid-utf8": {
        if (options.invalidUtf8Path === undefined || options.readFixtureBytes === undefined) { requiredCorpus = "invalid-utf8-generated-fixture"; break; }
        const bytes = await options.readFixtureBytes(options.invalidUtf8Path);
        if (bytes === null) throw new ContractPackageCorpusError("Invalid UTF-8 fixture absent");
        try { new TextDecoder("utf-8", { fatal: true }).decode(bytes); throw new ContractPackageCorpusError("Invalid UTF-8 fixture is actually valid"); }
        catch (error) { if (error instanceof ContractPackageCorpusError) throw error; }
        const client = await connect(); const args = { items: [{ kind: "exact", path: options.invalidUtf8Path }] };
        const raw = await client.callTool({ name: "vault_read", arguments: args });
        if (raw.isError !== true || raw.structuredContent !== undefined) throw new ContractPackageCorpusError("Invalid UTF-8 became a trustworthy product result");
        observe("invalid-utf8-untrusted-rejection", args, raw, { fixtureInvalidUtf8: true, noTrustedResult: true, notSatisfiedNotSubstituted: true }); break;
      }
      case "structured-graph": {
        const fixture = JSON.parse(await readFile(join(options.authority.packageRoot, "fixtures/v1/vault-discover/valid/structured-graph-projection.json"), "utf8"));
        const value = contract.parseDiscoverResult(await call(await connect(), "vault_discover", fixture.input));
        if (value.outcome !== "results" || !value.complete || value.items.length !== 1 || value.items[0]?.path !== "Projects/Bridge.md") { requiredCorpus = "structured-graph-generated-fixture"; break; }
        const item = value.items[0]; const bytes = await options.readFixtureBytes?.(item.path);
        if (bytes === undefined || bytes === null) { requiredCorpus = "structured-graph-byte-observation"; break; }
        if (item.contentVersion !== "sha256:" + createHash("sha256").update(bytes).digest("hex") || item.sizeBytes !== bytes.byteLength || item.frontmatter?.status !== "active" || !item.outline?.some(heading => heading.heading === "Design") || !item.matches?.some(match => match.text === "Design") || !item.references?.some(reference => reference.profile === "wikilink" && reference.target === "Target Note" && reference.resolvedPath === "Target Note.md")) throw new ContractPackageCorpusError("Structured graph projections not associated with raw bytes");
        for (const reference of item.references ?? []) if (Buffer.from(bytes).subarray(reference.startByte, reference.endByteExclusive).toString("utf8") !== reference.original) throw new ContractPackageCorpusError("Structured graph reference locator differs from raw bytes");
        observe("combined-structured-graph-raw-byte-projection", fixture.input, value, { allPredicatesMatched: true, frontmatterOutlineMatchesReferences: true, rawByteVersionMatched: true }); break;
      }
      case "uncertain-response": {
        const program = JSON.parse(await readFile(join(options.authority.packageRoot, "fixtures/v1/vault-change-set/scenario-uncertain-response.json"), "utf8"));
        const submitArguments = program.steps[0].arguments as Record<string, unknown>;
        let discarded = false;
        const client = new Client({ name: "contract-lost-response", version: options.authority.contractVersion }); clients.push(client);
        const losingFetch: typeof globalThis.fetch = async (input, init) => {
          const response = await globalThis.fetch(input, init);
          const body = init?.body;
          if (typeof body === "string") {
            const message = JSON.parse(body);
            if (message.method === "tools/call" && message.params?.name === "vault_change_set_submit") {
              // Fully receive the actual wire response, then prevent the client
              // from obtaining a trusted result. Status must recover independently.
              const raw = await response.text(); discarded = true;
              observe("submit-wire-response-discarded", submitArguments, { responseSha256: contractDigest(raw) }, { actuallyReceived: true, deliberatelyUnavailable: true });
              throw new Error("Contract response intentionally discarded");
            }
          }
          return response;
        };
        await client.connect(new StreamableHTTPClientTransport(options.endpoint, { fetch: losingFetch, requestInit: { headers: { "X-Expected-Vault-ID": options.expectedVaultId } } }));
        try { await client.callTool({ name: "vault_change_set_submit", arguments: submitArguments }); throw new ContractPackageCorpusError("Discarded submit returned a trusted result"); }
        catch (error) { if (error instanceof ContractPackageCorpusError || !discarded) throw error; }
        await client.close();
        const firstStatus = contract.parseChangeSetStatusResult(await call(await connect(), "vault_change_set_status", { submissionKey: submitArguments.submissionKey }));
        if (firstStatus.lookup !== "found") throw new ContractPackageCorpusError("Lost response cannot be recovered by original key");
        if (options.restart === undefined) { requiredCorpus = "controlled-installed-restart"; break; }
        await Promise.all(clients.map(client => client.close()));
        const restarted = await options.restart();
        if (restarted.expectedVaultId !== options.expectedVaultId || restarted.endpoint.toString() !== options.endpoint.toString()) throw new ContractPackageCorpusError("Uncertain-response restart changed endpoint/Vault authority");
        const after = contract.parseChangeSetStatusResult(await call(await connect(), "vault_change_set_status", { submissionKey: submitArguments.submissionKey }));
        if (after.lookup !== "found" || after.changeSet.changeSetId !== firstStatus.changeSet.changeSetId) throw new ContractPackageCorpusError("Restart lost original-key Change Set knowledge");
        observe("original-key-recovered-after-restart", {}, after, { identityPreserved: true, originalKeyRecovered: true }); break;
      }
      case "dependent-corpus": {
        if (scenario.id === "successor-search-snapshot-graph-evidence") {
          const inherited = options.predecessorProof;
          if (inherited !== undefined) {
            if (!isExecutedContractCrossCallEvidence(inherited, options.endpoint.toString(), contractDigest(options.expectedVaultId)) || inherited.scenarioId !== scenario.id || inherited.authoritySha256 !== options.authority.manifestSha256) throw new ContractPackageCorpusError("Frozen predecessor report is not the executed scenario");
            graphTransitions.push(...(inherited.graphTransitions ?? []).map(entry => structuredClone(entry)));
            for (const entry of inherited.observations.filter(entry => entry.name !== "validated-installed-dependent-proof")) observations.push({ ...entry, sequence: observations.length + 1 });
          } else {
            const source = options.seedNotes?.find(note => note.path === "Notes/Transport.md");
            if (source === undefined) { requiredCorpus = "successor-graph-generated-fixture"; break; }
            const client = await connect();
            const first = contract.parseReadToolResult(await call(client, "vault_read", { items: [{ kind: "exact", path: source.path }] }));
            if (!("outcome" in first) || first.outcome !== "page" || first.continuation === null) throw new ContractPackageCorpusError("Successor graph predecessor token absent");
            const changed = source.content + "\n[[Target Note]]\n";
            const apply = async (suffix: string, before: string, replacement: string): Promise<void> => {
              const args = { submissionKey: `contract-successor-${suffix}-${options.authority.manifestSha256.slice(0, 12)}`, operations: [{ operationId: suffix, kind: "edit_body", path: source.path, targetVersion: "sha256:" + contractDigestBytes(before), edit: { kind: "replace_whole", replacement: replacement.startsWith("﻿") ? replacement.slice(1) : replacement } }] };
              await call(client, "vault_change_set_submit", args);
              const deadline = Date.now() + 30_000;
              while (true) {
                const status = contract.parseChangeSetStatusResult(await call(client, "vault_change_set_status", { submissionKey: args.submissionKey }));
                if (status.lookup === "found" && status.changeSet.state === "intent_applied") return;
                if (status.lookup === "found" && status.changeSet.state !== "in_progress" || Date.now() >= deadline) throw new ContractPackageCorpusError("Successor graph public mutation failed");
                await new Promise(resolve => setTimeout(resolve, 25));
              }
            };
            const query = { query: { all: [{ path: { prefix: source.path } }, { graph: { relation: "links_to", path: "Target Note.md", maxDepth: 1 } }] }, projection: { matches: false, references: true }, order: { by: "path", direction: "asc" }, page: { maxItems: 100, continuation: null } };
            const beforeGraph = contract.parseDiscoverResult(await call(client, "vault_discover", query));
            if (beforeGraph.outcome !== "results" || beforeGraph.items.length !== 0) throw new ContractPackageCorpusError("Successor graph baseline has unexpected relation");
            await apply("add-link", source.content, changed);
            try {
              const successor = contract.parseDiscoverResult(await call(client, "vault_discover", query));
              if (successor.outcome !== "results" || successor.items.length !== 1 || successor.items[0]?.contentVersion !== "sha256:" + contractDigestBytes(changed) || !successor.items[0].references?.some(reference => reference.resolvedPath === "Target Note.md")) throw new ContractPackageCorpusError("Successor graph did not associate new relation with changed bytes");
              let reconstructed = ""; let offset = 0; let token: string | null = first.continuation; let page = first;
              while (true) {
                for (const item of page.items) {
                  if (!("content" in item) || !("start" in item) || item.start !== offset || Buffer.byteLength(item.content) !== item.end - item.start) throw new ContractPackageCorpusError("Successor predecessor byte ranges invalid");
                  offset = item.end; reconstructed += item.content;
                }
                if (token === null) break;
                const next = contract.parseContinueResult(await call(client, "vault_continue", { continuation: token }));
                if (!("outcome" in next) || next.outcome !== "page") throw new ContractPackageCorpusError("Successor graph invalidated accepted predecessor continuation");
                page = next; token = next.continuation;
              }
              if (reconstructed !== source.content) throw new ContractPackageCorpusError("Successor graph changed frozen predecessor result");
            } finally { await apply("restore-link", changed, source.content); }
            const restored = contract.parseDiscoverResult(await call(client, "vault_discover", query));
            if (restored.outcome !== "results" || restored.items.length !== 0) throw new ContractPackageCorpusError("Successor graph cleanup did not remove relation");
            const targetPath = "Notes/ContractSuccessorTarget.md";
            const renamedPath = "Notes/ContractSuccessorRenamed.md";
            const targetContent = "# Contract successor target\n";
            const linkedSource = source.content + "\n[[ContractSuccessorTarget]]\n";
            const mutate = async (suffix: string, operations: Record<string, unknown>[]) => {
              const args = { submissionKey: `contract-successor-${suffix}-${options.authority.manifestSha256.slice(0, 12)}`, operations };
              const submitted = contract.parseChangeSetSubmitResult(await call(client, "vault_change_set_submit", args));
              if (submitted.outcome !== "registered") throw new ContractPackageCorpusError("Successor transition was not registered");
              const deadline = Date.now() + 30_000;
              while (true) {
                const status = contract.parseChangeSetStatusResult(await call(client, "vault_change_set_status", { submissionKey: args.submissionKey }));
                if (status.lookup === "found" && status.changeSet.state === "intent_applied") return;
                if (status.lookup === "found" && status.changeSet.state !== "in_progress" || Date.now() >= deadline) throw new ContractPackageCorpusError("Successor transition did not apply");
                await new Promise(resolve => setTimeout(resolve, 25));
              }
            };
            const graphQuery = (target: string, unresolved: boolean) => ({ query: { all: [{ path: { exact: source.path } }, unresolved ? { unresolvedLink: { target } } : { graph: { relation: "links_to", path: target, maxDepth: 1 } }] }, projection: { matches: false, references: true }, order: { by: "path", direction: "asc" }, page: { maxItems: 100, continuation: null } });
            const sourceBytes = async () => {
              const bytes = await options.readFixtureBytes?.(source.path);
              if (bytes === undefined || bytes === null) throw new ContractPackageCorpusError("Successor transition raw source bytes absent");
              return Buffer.from(bytes).toString("utf8");
            };
            const transition = async (name: string, operations: Record<string, unknown>[], target: string, unresolved: boolean) => {
              const acceptedBytes = await sourceBytes();
              const frozen = contract.parseReadToolResult(await call(client, "vault_read", { items: [{ kind: "exact", path: source.path }] }));
              if (!("outcome" in frozen) || frozen.outcome !== "page" || frozen.continuation === null) throw new ContractPackageCorpusError("Successor transition frozen predecessor absent");
              const before = contract.parseDiscoverResult(await call(client, "vault_discover", graphQuery(target, unresolved)));
              await mutate(name, operations);
              const after = contract.parseDiscoverResult(await call(client, "vault_discover", graphQuery(target, unresolved)));
              const successorBytes = await sourceBytes();
              if (before.outcome !== "results" || after.outcome !== "results" || !before.complete || before.continuation !== null || !after.complete || after.continuation !== null || before.items.length !== 0 || after.items.length !== 1 || after.items[0]?.path !== source.path || after.items[0].contentVersion !== "sha256:" + contractDigestBytes(successorBytes) || !after.items[0].references?.some(reference => unresolved ? reference.target === target && reference.resolvedPath === null : reference.resolvedPath === target)) throw new ContractPackageCorpusError("Successor transition graph is not coherent with raw bytes");
              let page = frozen; let reconstructed = ""; let offset = 0;
              while (true) {
                for (const item of page.items) {
                  if (!("content" in item) || !("start" in item) || item.start !== offset || Buffer.byteLength(item.content) !== item.end - item.start) throw new ContractPackageCorpusError("Successor transition predecessor ranges invalid");
                  reconstructed += item.content; offset = item.end;
                }
                if (page.continuation === null) break;
                const next = contract.parseContinueResult(await call(client, "vault_continue", { continuation: page.continuation }));
                if (!("outcome" in next) || next.outcome !== "page") throw new ContractPackageCorpusError("Successor transition invalidated frozen predecessor");
                page = next;
              }
              if (reconstructed !== acceptedBytes) throw new ContractPackageCorpusError("Successor transition predecessor bytes changed");
              graphTransitions.push({ transition: name as "unresolved-link" | "target-creation" | "rename" | "deletion", request: contract.parseDiscoverInput(graphQuery(target, unresolved)), before, after, acceptedBytesSha256: contractDigestBytes(acceptedBytes), reconstructedSha256: contractDigestBytes(reconstructed), successorBytesSha256: contractDigestBytes(successorBytes) });
              observe("successor-transition-frozen-predecessor", { transition: name, beforeGraphSha256: contractDigest(before), acceptedBytesSha256: contractDigestBytes(acceptedBytes) }, { afterGraphSha256: contractDigest(after), successorBytesSha256: contractDigestBytes(successorBytes), reconstructedSha256: contractDigestBytes(reconstructed) }, { transition: name, beforeGraphSha256: contractDigest(before), afterGraphSha256: contractDigest(after), acceptedBytesSha256: contractDigestBytes(acceptedBytes), reconstructedSha256: contractDigestBytes(reconstructed), successorContentVersion: after.items[0].contentVersion, graphChanged: true, exactFrozenBytes: true });
            };
            if (options.readFixtureBytes === undefined) { requiredCorpus = "successor-graph-byte-observation"; break; }
            try {
              await transition("unresolved-link", [{ operationId: "add-unresolved", kind: "edit_body", path: source.path, targetVersion: "sha256:" + contractDigestBytes(source.content), edit: { kind: "replace_whole", replacement: linkedSource.startsWith("﻿") ? linkedSource.slice(1) : linkedSource } }], "ContractSuccessorTarget", true);
              await transition("target-creation", [{ operationId: "create-target", kind: "create_note", path: targetPath, content: targetContent, ifExists: "reject" }], targetPath, false);
              await transition("rename", [{ operationId: "rename-target", kind: "move", sourcePath: targetPath, destinationPath: renamedPath, targetVersion: "sha256:" + contractDigestBytes(targetContent), linkEffect: "update_resolved_references" }], renamedPath, false);
              await transition("deletion", [{ operationId: "delete-target", kind: "trash", path: renamedPath, targetVersion: "sha256:" + contractDigestBytes(targetContent) }], "ContractSuccessorRenamed", true);
            } finally {
              const current = await sourceBytes();
              if (current !== source.content) await mutate("restore-transitions", [{ operationId: "restore-transitions", kind: "edit_body", path: source.path, targetVersion: "sha256:" + contractDigestBytes(current), edit: { kind: "replace_whole", replacement: source.content.startsWith("﻿") ? source.content.slice(1) : source.content } }]);
              for (const path of [targetPath, renamedPath]) {
                const metadata = contract.parseReadToolResult(await call(client, "vault_read", { items: [{ kind: "metadata", path }] }));
                if (!("outcome" in metadata) || metadata.outcome !== "items") throw new ContractPackageCorpusError("Successor cleanup metadata unavailable");
                const item = metadata.items[0];
                if (item?.outcome === "satisfied") await mutate("cleanup-" + (path === targetPath ? "target" : "renamed"), [{ operationId: "cleanup-target", kind: "trash", path, targetVersion: item.result.contentVersion }]);
                else if (item?.outcome !== "not_satisfied") throw new ContractPackageCorpusError("Successor cleanup absence unconfirmed");
              }
              if (await sourceBytes() !== source.content) throw new ContractPackageCorpusError("Successor cleanup raw source differs");
            }
            observe("successor-graph-frozen-predecessor", {}, { beforeSha256: contractDigestBytes(source.content), changedSha256: contractDigestBytes(changed) }, { graphChanged: true, frozenPredecessorExact: true, restored: true });
          }
        }
        const dependency = options.dependency;
        if (dependency === undefined) { requiredCorpus = scenario.requiredCorpus; break; }
        if (options.binding === undefined || contractDigest(dependency.binding) !== contractDigest(options.binding) || dependency.reportSha256 !== contractDigest(dependency.report)) throw new ContractPackageCorpusError("Dependent installed report binding/digest mismatch");
        if (dependency.sourceVaults.length === 0) { requiredCorpus = "installed-source-vault-provenance"; break; }
        validateContractDependentReport(scenario.id, dependency.report);
        observe("validated-installed-dependent-proof", dependency.binding, { reportSha256: dependency.reportSha256 }, { requiredCorpus: scenario.requiredCorpus, sourceReportValidated: true, bindingMatched: true, cleanupConfirmed: true });
        break;
      }
    }
  } finally { await Promise.all(clients.map(client => client.close())); }
  const evidence: ContractCrossCallEvidence = { scenarioId: scenario.id, authoritySha256: options.authority.manifestSha256, binding: options.binding ?? null, observations, programProof, graphTransitions, cleanup: { sessionsClosed: true }, verdict: requiredCorpus === null ? "passed" : "blocked", requiredCorpus, dependency: options.dependency ?? null };
  executedCrossCalls.set(evidence, { endpoint: options.endpoint.toString(), vaultIdSha256: contractDigest(options.expectedVaultId), snapshotSha256: contractDigest(evidence) });
  return evidence;
}
