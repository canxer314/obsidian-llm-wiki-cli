import { lookupRegisteredRuntimeProfile, preflightRuntimeProfile } from "./runtime-profile.js";
import { z } from "zod";
import { createHash } from "node:crypto";
import { mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { ProvisionedTestVault } from "./test-vault.js";
import { verifyStandardDiagnosticBundle, type StandardDiagnosticBundle } from "../diagnostic-bundle.js";

export const DIAGNOSTIC_PRIVATE_MARKER_CATEGORIES = [
  "body", "frontmatter", "attachment", "request", "before-image", "raw-key", "raw-id",
  "credential", "environment", "username", "real-path", "capability",
] as const;
export type DiagnosticPrivateMarkerCategory = typeof DIAGNOSTIC_PRIVATE_MARKER_CATEGORIES[number];
export interface DiagnosticPrivateMarker { readonly category: DiagnosticPrivateMarkerCategory; readonly value: string }
export interface InstalledDiagnosticPrivacyFixture {
  readonly seed: string;
  readonly manifestSha256: string;
  readonly markers: readonly DiagnosticPrivateMarker[];
  readonly files: readonly { readonly path: string; readonly content: string }[];
  readonly environment: { readonly LLM_WIKI_ACCEPTANCE_DIAGNOSTIC_MARKER: string; readonly LLM_WIKI_ACCEPTANCE_DIAGNOSTIC_CREDENTIAL: string };
  readonly selectedContent: string;
  readonly expectedSelectionSha256: string;
}

export async function prepareInstalledDiagnosticPrivacyFixture(vault: ProvisionedTestVault, runId: string, label: "vault-a" | "vault-b"): Promise<InstalledDiagnosticPrivacyFixture> {
  if (!basename(vault.vaultPath).startsWith("installed-runtime-vault-") || /thinkflywheel/iu.test(vault.vaultPath)) throw new Error("Privacy fixtures require a generated Vault");
  const seed = `installed-diagnostic-privacy-v1:${runId}:${label}`;
  const marker = (category: DiagnosticPrivateMarkerCategory) => `privacy_${category.replaceAll("-", "_")}_${diagnosticSha256(seed).slice(0, 20)}`;
  const selectedContent = marker("body");
  const files = [
    { path: "diagnostic-privacy/selection.md", content: `---\nprivateValue: ${marker("frontmatter")}\n---\n${selectedContent}\n` },
    { path: "diagnostic-privacy/attachment.bin", content: marker("attachment") },
  ];
  await mkdir(join(vault.vaultPath, "diagnostic-privacy"), { recursive: false });
  for (const file of files) await writeFile(join(vault.vaultPath, file.path), file.content, { flag: "wx", mode: 0o600 });
  const environment = { LLM_WIKI_ACCEPTANCE_DIAGNOSTIC_MARKER: marker("environment"), LLM_WIKI_ACCEPTANCE_DIAGNOSTIC_CREDENTIAL: marker("credential") };
  const markers = ["body", "frontmatter", "attachment", "credential", "environment"].map(category => ({ category: category as DiagnosticPrivateMarkerCategory, value: marker(category as DiagnosticPrivateMarkerCategory) }));
  return { seed, manifestSha256: diagnosticSha256(diagnosticCanonicalJson(files.map(file => ({ path: file.path, contentSha256: diagnosticSha256(file.content) })))), files, markers, environment, selectedContent,
    expectedSelectionSha256: diagnosticSha256(selectedContent) };
}

/** Reads actual generated source bytes; a marker declaration alone never certifies exercised coverage. */
export async function observeInstalledDiagnosticPrivacySources(options: {
  readonly fixture: InstalledDiagnosticPrivacyFixture; readonly vault: ProvisionedTestVault;
  readonly journalPayload: unknown; readonly vaultId: string; readonly capabilityToken: string;
  readonly environment: Record<string, string | undefined>; readonly username?: string;
}): Promise<readonly DiagnosticPrivateMarker[]> {
  for (const file of options.fixture.files) {
    const path = join(options.vault.vaultPath, file.path);
    if (await realpath(path) !== path || !(await stat(path)).isFile() || await readFile(path, "utf8") !== file.content) {
      throw new Error("Installed diagnostic fixture source bytes changed");
    }
  }
  for (const [key, value] of Object.entries(options.fixture.environment)) {
    if (options.environment[key] !== value) throw new Error("Installed diagnostic process environment source was not observed");
  }
  const payload = options.journalPayload as { vaultId?: unknown; changeSetId?: unknown; input?: { submissionKey?: unknown; operations?: readonly { operationId?: unknown }[] }; effects?: unknown; targets?: unknown } | null;
  if (payload === null || typeof payload !== "object" || payload.vaultId !== options.vaultId || typeof payload.changeSetId !== "string" ||
      payload.input === undefined || typeof payload.input.submissionKey !== "string") throw new Error("Installed diagnostic journal request/identity sources are missing");
  const beforeImages: string[] = [];
  const walk = (value: unknown): void => {
    if (value === null || typeof value !== "object") return;
    for (const [key, nested] of Object.entries(value)) {
      if (key === "before" && typeof nested === "object" && nested !== null && "bytesBase64" in nested && typeof nested.bytesBase64 === "string") {
        const bytes = Buffer.from(nested.bytesBase64, "base64");
        if (bytes.length === 0 || bytes.toString("base64") !== nested.bytesBase64) throw new Error("Installed diagnostic journal before-image source is invalid");
        beforeImages.push(bytes.toString("utf8"), nested.bytesBase64);
      }
      walk(nested);
    }
  };
  walk(payload);
  if (beforeImages.length === 0) throw new Error("Installed diagnostic journal before-image source is missing");
  const deterministicSuffix = options.fixture.environment.LLM_WIKI_ACCEPTANCE_DIAGNOSTIC_MARKER.slice("privacy_environment_".length);
  // A's durable request has A's seed; B reuses that actual request only for a second independent bundle scan.
  const requestMarker = /^installed-semantic-privacy_request_[a-f0-9]{20}$/u.test(payload.input.submissionKey);
  if (!requestMarker || !beforeImages.some(value => /privacy_before_image_[a-f0-9]{20}/u.test(value))) throw new Error("Installed journal lacks deterministic request/before-image markers");
  if (options.vault.vaultPath.includes("vault-a") && (!payload.input.submissionKey.endsWith(deterministicSuffix) ||
      !beforeImages.some(value => value.includes(`privacy_before_image_${deterministicSuffix}`)))) throw new Error("Installed journal deterministic markers do not match the current fixture");
  if (options.username === undefined || options.username.length === 0) throw new Error("Installed diagnostic process username source was not observed");
  return [...options.fixture.markers,
    { category: "request", value: JSON.stringify(payload.input) },
    { category: "request", value: payload.input.submissionKey.slice("installed-semantic-".length) },
    ...(payload.input.operations ?? []).filter(operation => typeof operation.operationId === "string" && operation.operationId.length > 0)
      .map(operation => ({ category: "raw-id" as const, value: operation.operationId as string })),
    ...beforeImages.flatMap(value => [{ category: "before-image" as const, value },
      ...[...value.matchAll(/privacy_before_image_[a-f0-9]{20}/gu)].map(([token]) => ({ category: "before-image" as const, value: token }))]),
    { category: "raw-key", value: payload.input.submissionKey },
    { category: "raw-id", value: payload.changeSetId }, { category: "raw-id", value: options.vaultId },
    { category: "username", value: options.username }, { category: "real-path", value: options.vault.vaultPath },
    { category: "real-path", value: options.vault.profileDirectory }, { category: "capability", value: options.capabilityToken }];
}

export const INSTALLED_DIAGNOSTIC_PRIVACY_COVERAGE = ["standard/closed-fields", "standard/all-private-categories", "standard/independent-checksum", "standard/bundle-local-alias-correlation",
  "content/fresh-cancel-before-distinct-copy", "content/exact-selection", "content/actual-copied-checksum", "wire/closed-health-modes", "wire/no-diagnostic-download-tool", "isolation/second-vault", "cleanup/confirmed"] as const;
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const proofSchema = z.object({
  schemaVersion: z.literal(1), scope: z.literal("installed-diagnostic-privacy-A33"), verdict: z.literal("passed"), runId: z.string().min(1),
  candidateBundleSha256: hashSchema, profileName: z.string().min(1), coverage: z.array(z.enum(INSTALLED_DIAGNOSTIC_PRIVACY_COVERAGE)),
  vaults: z.array(z.object({ label: z.enum(["vault-a", "vault-b"]), vaultIdSha256: hashSchema, installedMainSha256: hashSchema,
    runtime: z.object({ platform: z.string(), osBuild: z.string(), obsidianVersion: z.string(), electronVersion: z.string(), nodeVersion: z.string(), capabilities: z.array(z.string()) }).strict(),
    seed: z.string().min(1), manifestSha256: hashSchema, beforeInventorySha256: hashSchema, afterInventorySha256: hashSchema,
    beforePrivateStateSha256: hashSchema, afterPrivateStateSha256: hashSchema,
    checksum: z.string().regex(/^sha256:[a-f0-9]{64}$/u), markerCount: z.number().int().positive(), markerCategories: z.array(z.enum(DIAGNOSTIC_PRIVATE_MARKER_CATEGORIES)),
    markerManifestSha256: hashSchema, correlatedJournalAliases: z.number().int().nonnegative(),
  }).strict()).length(2),
  confirmations: z.array(z.object({ outcome: z.enum(["cancelled", "copied"]), confirmationIdSha256: hashSchema, selectionSha256: hashSchema,
    copiedTextSha256: hashSchema.optional(), bundleChecksum: z.string().regex(/^sha256:[a-f0-9]{64}$/u).optional() }).strict()).length(2),
  wireRejections: z.literal(16), secondVaultUnchanged: z.literal(true),
  eventLog: z.array(z.object({ sequence: z.number().int().positive(), name: z.string().min(1), detailSha256: hashSchema }).strict()).min(1),
  cleanup: z.object({ verified: z.literal(true), vaultCount: z.literal(2), residualCount: z.literal(0) }).strict(),
}).strict();

export interface InstalledDiagnosticTrustedObservation {
  readonly binding: { readonly runId: string; readonly candidateBundleSha256: string; readonly profileName: string; readonly installedMainSha256: string };
  readonly vaults: readonly {
    readonly label: "vault-a" | "vault-b"; readonly vaultIdSha256: string;
    readonly runtime: import("./runtime-profile.js").ObservedRuntimeEnvironment;
    readonly seed: string; readonly files: readonly { readonly path: string; readonly contentSha256: string }[];
    readonly standardBundle: StandardDiagnosticBundle;
    readonly markers: readonly { readonly category: DiagnosticPrivateMarkerCategory; readonly sha256: string; readonly length: number }[];
    readonly journalEnqueueSeq?: number;
    readonly beforeInventory: readonly { readonly pathSha256: string; readonly sha256: string; readonly sizeBytes: number }[];
    readonly afterInventory: readonly { readonly pathSha256: string; readonly sha256: string; readonly sizeBytes: number }[];
    readonly beforePrivateState: readonly { readonly pathSha256: string; readonly sha256: string; readonly sizeBytes: number }[];
    readonly afterPrivateState: readonly { readonly pathSha256: string; readonly sha256: string; readonly sizeBytes: number }[];
  }[];
  readonly confirmations: readonly { readonly outcome: "cancelled" | "copied"; readonly confirmationIdSha256: string; readonly selectionSha256: string; readonly copiedTextSha256?: string; readonly bundleChecksum?: string }[];
  readonly events: readonly { readonly sequence: number; readonly name: string; readonly detailSha256: string }[];
  readonly removedRoots: readonly { readonly label: "vault-a" | "vault-b"; readonly kind: "vault" | "profile" | "reports"; readonly rootSha256: string }[];
}
export interface InstalledDiagnosticTrustedContext {
  /** The run composition obtains this independently from the actual runner, never from the proof under validation. */
  readonly observation: InstalledDiagnosticTrustedObservation;
  /** Transcript digest for consistency only; it cannot replace the separately retained source pin. */
  readonly expectedObservationSha256: string;
}

export interface InstalledDiagnosticSourcePin {
  /** Retained by the run composition from the runner callback, separately from transported evidence. */
  readonly binding: InstalledDiagnosticTrustedObservation["binding"];
  readonly observationSha256: string;
}

/** The caller is the trust boundary: never obtain expectedPin from the evidence being validated. */
export function validateInstalledDiagnosticPrivacyProof(value: unknown, binding: InstalledDiagnosticTrustedObservation["binding"], trusted?: InstalledDiagnosticTrustedContext, expectedPin?: InstalledDiagnosticSourcePin): z.infer<typeof proofSchema> {
  if (trusted === undefined) throw new Error("Installed diagnostic proof requires an independent trusted observation");
  if (expectedPin === undefined) throw new Error("Installed diagnostic proof requires an independently retained source pin");
  if (!/^[a-f0-9]{64}$/u.test(expectedPin.observationSha256) || trusted.expectedObservationSha256 !== expectedPin.observationSha256 ||
      diagnosticSha256(diagnosticCanonicalJson(trusted.observation)) !== expectedPin.observationSha256 ||
      diagnosticCanonicalJson(expectedPin.binding) !== diagnosticCanonicalJson(binding) ||
      diagnosticCanonicalJson(trusted.observation.binding) !== diagnosticCanonicalJson(binding)) throw new Error("Installed diagnostic trusted observation source binding does not match");
  const proof = proofSchema.parse(value);
  const profile = lookupRegisteredRuntimeProfile(binding.profileName);
  if (profile === null || proof.runId !== binding.runId || proof.candidateBundleSha256 !== binding.candidateBundleSha256 || proof.profileName !== binding.profileName ||
      diagnosticCanonicalJson([...proof.coverage].sort()) !== diagnosticCanonicalJson([...INSTALLED_DIAGNOSTIC_PRIVACY_COVERAGE].sort()) ||
      proof.vaults[0]!.label !== "vault-a" || proof.vaults[1]!.label !== "vault-b" || proof.vaults[0]!.vaultIdSha256 === proof.vaults[1]!.vaultIdSha256 ||
      proof.vaults[0]!.installedMainSha256 !== proof.vaults[1]!.installedMainSha256 || proof.vaults[0]!.correlatedJournalAliases < 1 ||
      proof.vaults.some(vault => vault.installedMainSha256 !== binding.installedMainSha256 || preflightRuntimeProfile(profile, vault.runtime).length > 0 || vault.markerCount < DIAGNOSTIC_PRIVATE_MARKER_CATEGORIES.length ||
        diagnosticCanonicalJson([...vault.markerCategories].sort()) !== diagnosticCanonicalJson([...DIAGNOSTIC_PRIVATE_MARKER_CATEGORIES].sort())) ||
      proof.vaults[1]!.beforeInventorySha256 !== proof.vaults[1]!.afterInventorySha256 ||
      proof.vaults[1]!.beforePrivateStateSha256 !== proof.vaults[1]!.afterPrivateStateSha256) throw new Error("Installed diagnostic provenance, coverage or isolation composition is incomplete");
  const [cancelled, copied] = proof.confirmations;
  if (cancelled!.outcome !== "cancelled" || copied!.outcome !== "copied" || cancelled!.confirmationIdSha256 === copied!.confirmationIdSha256 ||
      cancelled!.selectionSha256 !== copied!.selectionSha256 || cancelled!.copiedTextSha256 !== undefined || cancelled!.bundleChecksum !== undefined ||
      copied!.copiedTextSha256 === undefined || copied!.bundleChecksum === undefined) throw new Error("Installed diagnostic fresh confirmation composition is incomplete");
  const requiredEvents = [
    "vault-a-installed-runtime-ready", "vault-b-installed-runtime-ready", "vault-a-six-tool-inventory", "vault-b-six-tool-inventory",
    "vault-a-closed-health-input-modes-rejected", "vault-b-closed-health-input-modes-rejected",
    "agent-authority-attempts-observations-unchanged", "vault-a-standard-local-report-observed", "vault-b-standard-local-report-observed",
    "vault-a-cancelled-local-content-report-observed", "vault-a-copied-local-content-report-observed",
    "vault-a-generated-vault", "vault-b-generated-vault",
  ];
  const eventSequence = (name: string): number => proof.eventLog.find(event => event.name === name)?.sequence ?? 0;
  if (proof.eventLog.some((event, index) => event.sequence !== index + 1) || requiredEvents.some(name => eventSequence(name) === 0) ||
      eventSequence("vault-a-cancelled-local-content-report-observed") >= eventSequence("vault-a-copied-local-content-report-observed") ||
      ["vault-a-generated-vault", "vault-b-generated-vault"].some(name => eventSequence(name) <= eventSequence("vault-a-copied-local-content-report-observed"))) {
    throw new Error("Installed diagnostic observation/cleanup event composition is incomplete");
  }
  for (const vault of proof.vaults) {
    if (proof.eventLog.find(event => event.name === `${vault.label}-standard-local-report-observed`)?.detailSha256 !== diagnosticSha256(diagnosticCanonicalJson(vault))) {
      throw new Error("Installed diagnostic bundle checksum/provenance does not match its observed event");
    }
  }
  for (const confirmation of proof.confirmations) {
    if (proof.eventLog.find(event => event.name === `vault-a-${confirmation.outcome}-local-content-report-observed`)?.detailSha256 !== diagnosticSha256(diagnosticCanonicalJson(confirmation))) {
      throw new Error("Installed diagnostic copied checksum does not match its observed confirmation event");
    }
  }
  const source = trusted.observation;
  if (source.vaults.length !== 2 || source.confirmations.length !== 2 || source.removedRoots.length !== 6 ||
      diagnosticCanonicalJson(source.events) !== diagnosticCanonicalJson(proof.eventLog) ||
      diagnosticCanonicalJson(source.confirmations) !== diagnosticCanonicalJson(proof.confirmations)) throw new Error("Installed diagnostic trusted observation transcript is incomplete or differs");
  for (const observed of source.vaults) {
    const summary = proof.vaults.find(vault => vault.label === observed.label);
    if (summary === undefined || summary.vaultIdSha256 !== observed.vaultIdSha256 || diagnosticCanonicalJson(summary.runtime) !== diagnosticCanonicalJson(observed.runtime) ||
        summary.seed !== observed.seed || summary.manifestSha256 !== diagnosticSha256(diagnosticCanonicalJson(observed.files)) ||
        summary.markerCount !== observed.markers.length || summary.markerManifestSha256 !== diagnosticSha256(diagnosticCanonicalJson(observed.markers)) ||
        summary.beforeInventorySha256 !== diagnosticSha256(diagnosticCanonicalJson(observed.beforeInventory)) || summary.afterInventorySha256 !== diagnosticSha256(diagnosticCanonicalJson(observed.afterInventory)) ||
        summary.beforePrivateStateSha256 !== diagnosticSha256(diagnosticCanonicalJson(observed.beforePrivateState)) || summary.afterPrivateStateSha256 !== diagnosticSha256(diagnosticCanonicalJson(observed.afterPrivateState))) {
      throw new Error("Installed diagnostic marker/manifest/inventory facts differ from the trusted observation");
    }
    if (!verifyStandardDiagnosticBundle(observed.standardBundle) || summary.checksum !== observed.standardBundle.checksum.canonicalPayload ||
        new Set(observed.markers.map(marker => marker.category)).size !== DIAGNOSTIC_PRIVATE_MARKER_CATEGORIES.length ||
        observed.markers.some(marker => !DIAGNOSTIC_PRIVATE_MARKER_CATEGORIES.includes(marker.category) || !/^[a-f0-9]{64}$/u.test(marker.sha256) || marker.length < 1)) throw new Error("Installed diagnostic trusted observation standard bundle/source coverage is invalid");
    // Recheck source-marker absence without retaining raw private marker bytes.
    const strings: string[] = [];
    const collect = (value: unknown): void => { if (typeof value === "string") strings.push(value); else if (Array.isArray(value)) value.forEach(collect); else if (typeof value === "object" && value !== null) Object.values(value).forEach(collect); };
    collect(observed.standardBundle);
    for (const marker of observed.markers) for (const text of strings) for (let offset = 0; offset + marker.length <= text.length; offset += 1) {
      if (diagnosticSha256(text.slice(offset, offset + marker.length)) === marker.sha256) throw new Error("Installed diagnostic trusted observation contains a private marker");
    }
    const aliases = verifyInstalledDiagnosticPrivacyBundle(observed.standardBundle, [], observed.journalEnqueueSeq === undefined ? undefined : { journalEnqueueSeq: observed.journalEnqueueSeq, journalPhase: "FAILED" });
    if (aliases.correlatedJournalAliases !== summary.correlatedJournalAliases) throw new Error("Installed diagnostic trusted observation alias facts differ");
    for (const kind of ["vault", "profile", "reports"] as const) {
      if (source.removedRoots.filter(root => root.label === observed.label && root.kind === kind && /^[a-f0-9]{64}$/u.test(root.rootSha256)).length !== 1) throw new Error("Installed diagnostic trusted cleanup source is incomplete");
    }
  }
  return proof;
}

export function diagnosticProcessEnvironment(request: {
  readonly vaultPath: string; readonly profileDirectory: string;
  readonly diagnosticPrivacyEnvironment?: Record<string, string>;
}): NodeJS.ProcessEnv | undefined {
  const supplied = request.diagnosticPrivacyEnvironment;
  if (supplied === undefined) return undefined;
  if (!basename(request.vaultPath).startsWith("installed-runtime-vault-") || !basename(request.profileDirectory).startsWith("installed-runtime-profile-") ||
      /thinkflywheel/iu.test(request.vaultPath + request.profileDirectory)) throw new Error("Diagnostic process environment requires generated roots");
  const keys = ["LLM_WIKI_ACCEPTANCE_DIAGNOSTIC_MARKER", "LLM_WIKI_ACCEPTANCE_DIAGNOSTIC_CREDENTIAL"];
  if (Object.keys(supplied).length !== keys.length || Object.keys(supplied).some(key => !keys.includes(key)) ||
      !/^privacy_environment_[a-f0-9]{20}$/u.test(supplied[keys[0]!] ?? "") || !/^privacy_credential_[a-f0-9]{20}$/u.test(supplied[keys[1]!] ?? "")) {
    throw new Error("Diagnostic environment has incompatible closed marker fields");
  }
  return { ...process.env, ...supplied };
}

/** Independent verifier: does not call the producer's canonical serializer or alias generator. */
export function diagnosticCanonicalJson(value: unknown): string {
  const sorted = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(sorted);
    if (typeof item !== "object" || item === null) return item;
    return Object.fromEntries(Object.keys(item).sort().map(key => [key, sorted((item as Record<string, unknown>)[key])]));
  };
  return JSON.stringify(sorted(value));
}
export function diagnosticSha256(value: string): string { return createHash("sha256").update(value).digest("hex"); }

export function verifyInstalledDiagnosticPrivacyBundle(value: unknown, markers: readonly DiagnosticPrivateMarker[], expected?: { readonly journalEnqueueSeq: number; readonly journalPhase: "FAILED" }): {
  readonly checksum: string; readonly markerCount: number; readonly markerCategories: readonly DiagnosticPrivateMarkerCategory[];
  readonly correlatedJournalAliases: number;
} {
  if (!verifyStandardDiagnosticBundle(value)) throw new Error("Installed standard diagnostic has unknown fields or invalid checksum");
  const bundle = value as StandardDiagnosticBundle;
  const { checksum, ...payload } = bundle;
  if (checksum.canonicalPayload !== `sha256:${diagnosticSha256(diagnosticCanonicalJson(payload))}`) {
    throw new Error("Installed standard diagnostic independent checksum mismatch");
  }
  if (markers.some(marker => marker.value.length === 0 || !DIAGNOSTIC_PRIVATE_MARKER_CATEGORIES.includes(marker.category))) {
    throw new Error("Installed diagnostic private marker coverage is invalid");
  }
  const serialized = JSON.stringify(bundle);
  for (const marker of markers) {
    if (serialized.includes(marker.value) || serialized.includes(JSON.stringify(marker.value).slice(1, -1))) {
      throw new Error(`Installed standard diagnostic leaked a private marker (${marker.category})`);
    }
  }
  const outcomes = new Map(bundle.changeSetOutcomes.map(entry => [entry.changeSetAlias, entry]));
  if (outcomes.size !== bundle.changeSetOutcomes.length ||
      new Set(bundle.changeSetOutcomes.map(entry => entry.submissionKeyDigest)).size !== bundle.changeSetOutcomes.length) {
    throw new Error("Installed diagnostic alias correlation has duplicate identities");
  }
  const journalAliases = bundle.journal.frames.filter(frame => frame.state === "valid");
  for (const frame of journalAliases) {
    if (frame.state !== "valid" || !outcomes.has(frame.changeSetAlias)) throw new Error("Installed diagnostic journal alias correlation is unproven");
  }
  if (expected !== undefined) {
    const latest = journalAliases.filter(frame => frame.state === "valid").sort((left, right) => right.sequence - left.sequence)[0];
    const outcome = bundle.changeSetOutcomes.find(entry => entry.enqueueSeq === expected.journalEnqueueSeq);
    if (latest === undefined || latest.phase !== expected.journalPhase || outcome === undefined || latest.changeSetAlias !== outcome.changeSetAlias ||
        outcome.state !== "result_unproven" || outcome.executionPhase !== "terminal") throw new Error("Installed diagnostic durable journal/outcome alias correlation does not match");
  }
  for (const queue of bundle.queueTimeline) {
    for (const alias of [queue.currentExecutionAlias, queue.headChangeSetAlias]) {
      if (alias !== null && !outcomes.has(alias)) throw new Error("Installed diagnostic queue alias correlation is unproven");
    }
  }
  return { checksum: checksum.canonicalPayload, markerCount: markers.length,
    markerCategories: DIAGNOSTIC_PRIVATE_MARKER_CATEGORIES.filter(category => markers.some(marker => marker.category === category)),
    correlatedJournalAliases: journalAliases.length };
}
