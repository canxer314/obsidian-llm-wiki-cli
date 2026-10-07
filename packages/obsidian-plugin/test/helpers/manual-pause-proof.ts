import { createStandardDiagnosticBundle } from "../../src/diagnostic-bundle.js";
import { projectManualPauseWire, manualPauseSourceDigest, type ManualPauseConsumptionContext, type ManualPauseWireObservation } from "../../src/installed-runtime/manual-pause-source.js";
import { createHash } from "node:crypto";
import { compareInventories } from "../../src/installed-runtime/test-vault.js";
import { manualPauseProofSchema } from "../../src/installed-runtime/manual-pause-observation.js";
import { MVP_PERF_REF_1 } from "../../src/installed-runtime/runtime-profile.js";

/** Synthetic validator fixture only. Never installed acceptance evidence. */
export function syntheticManualPauseProof(runId: string, profile: string, candidateBundleSha256: string) {
  const digest = (value: string) => createHash("sha256").update(value).digest("hex");
  const enqueue = [1, 2, 3, 4].map(seq => ({ submissionKey: digest(`key-${seq}`), changeSetId: digest(`cs-${seq}`), enqueueSeq: seq }));
  const event = (kind: string, index: number, extra = {}) => ({ kind, ...enqueue[index], ...extra });
  const lifecycle = (index: number) => [event("started", index, { writeLease: true }), event("preflight", index, { accepted: true, writeLease: true }),
    event("first-mutation", index), event("committed", index), event("terminal", index, { state: "intent_applied" })];
  const before = [{ path: "Notes/Welcome.md", sha256: digest("welcome"), sizeBytes: 7 }];
  const afterA = [...before, ...["Head", "First", "Second", "Third"].map((name, index) => ({ path: `ManualPauseProof/${name}.md`, sha256: digest(`# Pause ${index}\n`), sizeBytes: 10 }))];
  const afterB = [...before, { path: "ManualPauseProof/Independent.md", sha256: digest("# Independent\n"), sizeBytes: 14 }];
  const write = { gate: "open", pauseSource: "manual" };
  const row = (tool: string, phase: string, extra = {}) => ({ source: "loopback-mcp", phase, tool, contract: `${tool}:v1`,
    vaultIdSha256: digest("vault-a"), requestSha256: digest("request"), structuredSha256: digest("response"), textSha256: digest("response"),
    schemaValid: true, textIdentical: true, isError: false, branch: "observed", gate: null, submissionKeySha256: null, changeSetIdSha256: null,
    state: null, continuationInSha256: null, continuationOutSha256: null, contentVersion: null, start: null, end: null, pageBytes: null, ...extra });
  const toolRows = [row("vault_health", "pausing"), row("vault_health", "paused"),
    ...enqueue.map((entry, index) => row("vault_change_set_status", "paused", { submissionKeySha256: entry.submissionKey, changeSetIdSha256: entry.changeSetId, branch: "found", state: index === 0 ? "intent_applied" : "in_progress" })),
    row("vault_change_set_submit", "paused", { submissionKeySha256: digest("unbound"), branch: "operationally_blocked", gate: "writes_paused", isError: true }),
    row("vault_change_set_status", "paused", { submissionKeySha256: digest("unbound"), branch: "unknown" }), row("vault_discover", "paused", { branch: "results" }),
    row("vault_read", "paused", { branch: "page", continuationOutSha256: digest("token"), contentVersion: digest("content"), start: 0, end: 3, pageBytes: 3 }),
    row("vault_continue", "paused", { branch: "page", continuationInSha256: digest("token"), contentVersion: digest("content"), start: 3, end: 7, pageBytes: 4 }),
    row("vault_change_set_status", "paused", { vaultIdSha256: digest("vault-b"), changeSetIdSha256: digest("b-progress"), branch: "found", state: "intent_applied" }),
    row("vault_health", "resumed"), ...enqueue.map(entry => row("vault_change_set_status", "resumed", { submissionKeySha256: entry.submissionKey, changeSetIdSha256: entry.changeSetId, branch: "found", state: "intent_applied" }))].map((entry, index) => ({ ...entry, sequence: index + 1 }));
  return manualPauseProofSchema.parse({ scope: "manual-pause-drain-and-fifo", source: "installed-obsidian", runId, profile,
    candidateBundleSha256, installedMainSha256: digest("main"), canonicalManifestSha256: digest("manifest"),
    vaults: ["vault-a", "vault-b"].map((label, index) => ({ label, vaultIdSha256: digest(label), seed: digest("seed"),
      runtime: { platform: MVP_PERF_REF_1.os.platform, osBuild: MVP_PERF_REF_1.os.build, obsidianVersion: MVP_PERF_REF_1.versions.obsidian,
        electronVersion: MVP_PERF_REF_1.versions.electron, nodeVersion: MVP_PERF_REF_1.versions.node, capabilities: [...MVP_PERF_REF_1.capabilities] },
      inventory: { before, after: index === 0 ? afterA : afterB, ...compareInventories(before, index === 0 ? afterA : afterB) },
      registry: (index === 0 ? enqueue : [{ submissionKey: digest("b-key"), changeSetId: digest("b-progress"), enqueueSeq: 1 }]).map(e => ({ ...e, state: "intent_applied", executionPhase: "terminal" })) })),
    enqueue, events: [event("enqueued", 0), ...lifecycle(0).slice(0, 4), ...[1, 2, 3].map(i => event("enqueued", i)), event("terminal", 0, { state: "intent_applied" }), ...[1, 2, 3].flatMap(lifecycle)],
    pausingEventCount: 8, pausedEventCount: 9, resumeEventCount: 9,
    health: { pausing: { write: { ...write, state: "pausing" }, recovery: "none", effectiveGate: "writes_paused", queue: { currentExecutionId: enqueue[0]!.changeSetId, length: 4, headChangeSetId: enqueue[0]!.changeSetId } },
      paused: { write: { ...write, state: "paused" }, recovery: "none", effectiveGate: "writes_paused", queue: { currentExecutionId: null, length: 3, headChangeSetId: enqueue[1]!.changeSetId } },
      resumed: { write: { gate: "open", state: "writable", pauseSource: null }, recovery: "none", effectiveGate: null, queue: { currentExecutionId: null, length: 0, headChangeSetId: null } } },
    localActions: ["pause-writes", "resume-writes"].map(action => ({ action, invocationIdSha256: digest(action), beforeSha256: digest(`${action}-before`), afterSha256: digest(`${action}-after`) })),
    toolRows,
    unboundKeySha256: digest("unbound"), contentSha256: digest("content"), independentProgressChangeSetIdSha256: digest("b-progress"),
    cleanup: [{ attempted: true, residualPaths: [] }, { attempted: true, residualPaths: [] }], cleanupSucceeded: true, verdict: "passed" });
}

/** Independently built literal source fixture, not copied from a caller's public proof. */
export function syntheticManualPauseSource(runId: string, profile: string, candidateBundleSha256: string, installedMainSha256: string) {
  const hash = (value: string) => createHash("sha256").update(value).digest("hex");
  const baseline = syntheticManualPauseProof(runId, profile, candidateBundleSha256);
  const versions = { bridge: "0.1.0", plugin: "0.1.0", protocol: "1.0", persistentStateSchema: 2, recoveryJournalSchema: 1 };
  const lifecycle = { startup: "ready", upgrade: "not_run", migration: "not_run", recovery: "not_run" };
  const rawHealth = (phase: "pausing" | "paused" | "resumed") => {
    const summary = baseline.health[phase];
    return { outcome: "observed", vault: { id: "vault-a", name: "fixture", path: "/generated/a" }, versions, listener: { address: "127.0.0.1", port: 32123 },
      readiness: { searchSnapshot: "ready", cache: "ready", index: "ready" }, recovery: { state: "none" }, write: summary.write,
      queue: { currentExecutionId: phase === "pausing" ? "cs-1" : null, length: summary.queue.length, headChangeSetId: phase === "pausing" ? "cs-1" : phase === "paused" ? "cs-2" : null },
      lifecycle, effectiveGate: phase === "resumed" ? null : { code: "writes_paused" }, overall: "healthy", reasonCodes: [], operatorAction: "none" };
  };
  const wire: ManualPauseWireObservation[] = [];
  const add = (name: ManualPauseWireObservation["name"], phase: ManualPauseWireObservation["phase"], input: Record<string, unknown>, response: unknown, vaultId = "vault-a", isError = false) => {
    wire.push({ sequence: wire.length + 1, phase, name, vaultId, endpoint: "http://127.0.0.1:32123/mcp", arguments: input, result: { structuredContent: response, content: [{ type: "text", text: JSON.stringify(response) }], isError } });
  };
  const record = (seq: number, applied: boolean) => applied ? { changeSetId: `cs-${seq}`, state: "intent_applied", preview: { requestedEffects: [], derivedEffects: [], paths: [] }, requestedEffects: [], derivedEffects: [], paths: [] } : { changeSetId: `cs-${seq}`, state: "in_progress" };
  const status = (seq: number, phase: "paused" | "resumed") => add("vault_change_set_status", phase, { submissionKey: `key-${seq}` }, { lookup: "found", changeSet: record(seq, phase === "resumed" || seq === 1), vault: { writeGate: "open", writeState: phase === "paused" ? "paused" : "writable" } });
  add("vault_health", "pausing", {}, rawHealth("pausing")); add("vault_health", "paused", {}, rawHealth("paused"));
  for (const seq of [1, 2, 3, 4]) status(seq, "paused");
  add("vault_change_set_submit", "paused", { submissionKey: "unbound", operations: [{ operationId: "new", kind: "create_note", ifExists: "reject", path: "ManualPauseProof/Head.md", content: "# New\n" }] }, { outcome: "operationally_blocked", gate: { code: "writes_paused" } }, "vault-a", true);
  add("vault_change_set_status", "paused", { submissionKey: "unbound" }, { lookup: "unknown", vault: { writeGate: "open", writeState: "paused" } });
  add("vault_discover", "paused", { query: { path: { prefix: "ManualPauseProof/" } }, projection: { matches: false }, order: { by: "path", direction: "asc" }, page: { maxItems: 1000, continuation: null } }, { outcome: "results", ordering: { by: "path", direction: "asc", tieBreaker: "path_utf8_bytes" }, items: [], complete: true, continuation: null });
  const page = (start: number, end: number, bytes: string, complete: boolean) => ({ outcome: "page", items: [{ index: 0, path: "ManualPauseProof/Content.md", contentVersion: `sha256:${hash("content")}`, sizeBytes: 7, kind: "exact", start, end, content: bytes, complete }], continuation: complete ? null : "token", complete });
  add("vault_read", "paused", { items: [{ kind: "exact", path: "ManualPauseProof/Content.md" }] }, page(0, 3, "con", false));
  add("vault_continue", "paused", { continuation: "token" }, page(3, 7, "tent", true));
  add("vault_change_set_status", "paused", { submissionKey: "b-key" }, { lookup: "found", changeSet: { ...record(1, true), changeSetId: "b-progress" }, vault: { writeGate: "open", writeState: "writable" } }, "vault-b");
  add("vault_health", "resumed", {}, rawHealth("resumed")); for (const seq of [1, 2, 3, 4]) status(seq, "resumed");
  const diagnostic = (phase: "pausing" | "paused" | "resumed") => {
    const value = rawHealth(phase);
    return createStandardDiagnosticBundle({ vaultId: "vault-a", versions, health: { readiness: value.readiness, recovery: "none", write: phase === "pausing" ? { gate: "open", state: "writable", pauseSource: null } : value.write, effectiveGate: phase === "resumed" || phase === "pausing" ? null : "writes_paused", overall: "healthy", reasonCodes: [], operatorAction: "none" }, listener: value.listener, queue: value.queue, lifecycle, journal: { availability: "unavailable", frames: [] }, changeSets: [], machineEvents: [] });
  };
  const localReports = ["pause-writes", "resume-writes"].map((action, index) => ({ schemaVersion: 1, runId, candidateBundleSha256, installedMainSha256, capabilityToken: "c".repeat(64), vaultId: "vault-a", endpoint: "http://127.0.0.1:32123/mcp", invocationId: action, action, outcome: "accepted", before: diagnostic(index === 0 ? "pausing" : "paused"), after: diagnostic(index === 0 ? "paused" : "resumed") }));
  const { toolRows: _rows, localActions: _actions, verdict: _verdict, cleanupSucceeded: _clean, ...facts } = baseline;
  facts.installedMainSha256 = installedMainSha256;
  const source = { runId, candidateBundleSha256, installedMainSha256, profile, wire, localReports, facts } as NonNullable<ManualPauseConsumptionContext["source"]>;
  const context: ManualPauseConsumptionContext = { runId, candidateBundleSha256, installedMainSha256, profile, source, sourceSha256: manualPauseSourceDigest(source) };
  const proof = manualPauseProofSchema.parse({ ...facts, toolRows: wire.map(projectManualPauseWire), localActions: localReports.map(report => ({ action: report.action, invocationIdSha256: hash(report.invocationId), beforeSha256: hash(JSON.stringify(report.before)), afterSha256: hash(JSON.stringify(report.after)) })), verdict: "passed", cleanupSucceeded: true });
  return { source, context, proof };
}
