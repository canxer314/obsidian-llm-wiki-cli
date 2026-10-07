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
    unboundKeySha256: digest("unbound"), contentSha256: digest("content"), independentProgressChangeSetIdSha256: digest("b-progress"),
    cleanup: [{ attempted: true, residualPaths: [] }, { attempted: true, residualPaths: [] }], cleanupSucceeded: true, verdict: "passed" });
}
