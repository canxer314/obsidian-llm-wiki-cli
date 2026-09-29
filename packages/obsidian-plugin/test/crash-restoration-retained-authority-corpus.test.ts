import { describe, expect, it } from "vitest";

import {
  CHANGE_SET_RECORD_RETENTION_MS,
  composeCrashRestorationRetainedAuthorityCorpusEvidence,
  type CrashRestorationRetainedAuthorityCorpusOutcome,
} from "../src/index.js";

const DIGEST = "a".repeat(64);

function outcome(): CrashRestorationRetainedAuthorityCorpusOutcome {
  return {
    scenarioManifestSha256: DIGEST,
    records: [
      {
        mutationKind: "move",
        injectionPoint: "rollback:before_rollback",
        fixtureSha256: DIGEST,
        beforeInventorySha256: DIGEST,
        afterInventorySha256: DIGEST,
        proofState: "result_unproven",
        gate: "recovery_blocked",
        cleanupSucceeded: true,
        verdict: "passed",
      },
    ],
    coverage: {
      everyMutationKindAtEveryDeclaredBoundary: true,
      preparedRestoresWholeChangeSet: true,
      committedSuppressesRestoration: true,
      conflictingBytesPreservedAndWritesBlocked: true,
      deterministicJournalStorageDestinationAndSemanticFaults: true,
      callbackReorderAndSemanticTimeoutProven: true,
      concurrentIdempotencyProven: true,
    },
    retainedAuthority: {
      retentionMs: CHANGE_SET_RECORD_RETENTION_MS,
      queryableAcrossCrashAndReconnect: true,
      completeRecordsRetained: true,
      requiredRecordsNeverBecomeOrdinaryUnknown: true,
    },
    cleanup: { residualPaths: [], vaultVisibleStaging: 0, managedTrashLeakage: 0, fixtureResidue: 0 },
    assertions: ["scenario:closed"],
  };
}

describe("crash restoration retained-authority evidence", () => {
  it("emits a release-blocking digest-only verdict", () => {
    const evidence = composeCrashRestorationRetainedAuthorityCorpusEvidence({
      outcome: outcome(),
      events: [
        {
          kind: "assertion",
          name: "crash-restoration-record",
          detail: { fixtureSha256: DIGEST, privateBytes: undefined },
        },
      ],
      assertions: ["scenario:closed"],
    });

    expect(evidence.verdict).toBe("passed");
    expect(evidence.records[0]).toMatchObject({
      mutationKind: "move",
      proofState: "result_unproven",
      gate: "recovery_blocked",
      cleanupSucceeded: true,
    });
    expect(evidence.retainedAuthority.retentionMs).toBe(7 * 24 * 60 * 60 * 1_000);
    expect(evidence.eventLog[0]?.detailSha256).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("rejects residual cleanup or shortened authority retention", () => {
    expect(() =>
      composeCrashRestorationRetainedAuthorityCorpusEvidence({
        outcome: {
          ...outcome(),
          cleanup: { residualPaths: ["file:Proof.md"], vaultVisibleStaging: 0, managedTrashLeakage: 0, fixtureResidue: 0 },
        },
        events: [{ kind: "cleanup", name: "bad", detail: {} }],
        assertions: ["scenario:closed"],
      }),
    ).toThrow("release-blocking invariants");
    expect(() =>
      composeCrashRestorationRetainedAuthorityCorpusEvidence({
        outcome: {
          ...outcome(),
          retainedAuthority: { ...outcome().retainedAuthority, retentionMs: 1 },
        },
        events: [{ kind: "assertion", name: "bad", detail: {} }],
        assertions: ["scenario:closed"],
      }),
    ).toThrow("release-blocking invariants");
  });
});
