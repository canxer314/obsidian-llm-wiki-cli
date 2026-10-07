import type { PersistentFifoProof } from "../../src/installed-runtime/fifo-observation.js";

/** Synthetic verifier/orchestration fixture. Never installed acceptance evidence. */
export function syntheticFifoProof(runId: string, profile: string, candidateBundleSha256: string): PersistentFifoProof {
  const digest = "a".repeat(64);
  const entries = [1, 2, 3, 4].map(i => ({ submissionKey: String(i).repeat(64), changeSetId: String(i + 4).repeat(64), enqueueSeq: i }));
  const event = (kind: string, i: number, extra = {}) => ({ kind, ...entries[i], ...extra });
  return {
    scope: "persistent-fifo-and-pre-mutation-repreflight", source: "installed-obsidian", runId, profile,
    candidateBundleSha256, installedMainSha256: digest, vaultIdSha256: digest, seed: digest, canonicalManifestSha256: digest,
    beforeInventorySha256: digest, afterInventorySha256: digest, targetAfterSha256: digest, dependencyAfterSha256: digest, derivedAfterSha256: digest,
    replay: { keysReplayed: 4, identitiesPreserved: 4, recordsUnchanged: 4, noAdditionalExecutionEvents: true },
    enqueue: entries, staleKeys: [entries[1]!.submissionKey, entries[2]!.submissionKey], cleanupSucceeded: true, verdict: "passed",
    events: [event("enqueued", 0), event("started", 0, { writeLease: true }), event("preflight", 0, { accepted: true, writeLease: true }), event("first-mutation", 0), event("committed", 0),
      ...[1, 2, 3].map(i => event("enqueued", i)),
      { kind: "fixtures-changed", targetBefore: "1".repeat(64), targetAfter: "2".repeat(64), dependencyBefore: "3".repeat(64), dependencyAfter: "4".repeat(64) },
      { kind: "restart", stopped: true }, event("recovered", 0, { state: "intent_applied" }),
      ...[1, 2].flatMap(i => [event("started", i, { writeLease: true }), event("preflight", i, { accepted: false, writeLease: true }), event("terminal", i, { state: "intent_not_applied" })]),
      event("started", 3, { writeLease: true }), event("preflight", 3, { accepted: true, writeLease: true }), event("first-mutation", 3), event("committed", 3), event("terminal", 3, { state: "intent_applied" })],
  } as PersistentFifoProof;
}
