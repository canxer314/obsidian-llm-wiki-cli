import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  copyAttachmentCorpusProfile,
  moveAttachmentCorpusProfile,
} from "../corpus/attachment-corpus.js";
import {
  runMutationCorpusAlreadyRestoredScenario,
  runMutationCorpusCapacityFaultScenario,
  runMutationCorpusCollisionScenario,
  runMutationCorpusHostOperationFaultScenario,
  runMutationCorpusJournalFaultScenario,
  runMutationCorpusJournalWriteFaultScenario,
  runMutationCorpusRecoveryInterferenceScenario,
  runMutationCorpusScenario,
  runSubmissionKeyCrashReplayScenario,
  runSubmissionKeyRecoveryBlockedScenario,
  runSubmissionKeyRegistryFaultScenario,
  runSubmissionKeyReplayScenario,
  type CorpusScenarioEvidence,
  type MutationCorpusCrashPoint,
  type MutationCorpusProfile,
  type SubmissionKeyCorpusEvidence,
} from "../corpus/crash-corpus-runner.js";
import { createNoteCorpusProfile } from "../corpus/create-note-corpus.js";
import { replaceExactCorpusProfile, replaceWholeCorpusProfile } from "../corpus/edit-body-corpus.js";
import { editFrontmatterCorpusProfile } from "../corpus/frontmatter-corpus.js";
import { type JournalWriteFault } from "../corpus/journal-faults.js";
import { trashAttachmentCorpusProfile, trashNoteCorpusProfile } from "../corpus/managed-trash-corpus.js";
import { moveNoteCorpusProfile } from "../corpus/move-note-corpus.js";
import {
  multiFrontmatterCorpusProfile,
  multiMarkdownCorpusProfile,
} from "../corpus/multi-operation-corpus.js";
import {
  multiFrontmatterReorderedCallbacks,
  moveNoteMissingRenameEventDeadline,
  runSemanticEvidenceScenario,
} from "../corpus/semantic-evidence-corpus.js";
import { CHANGE_SET_RECORD_RETENTION_MS } from "../change-set.js";

export const CRASH_RESTORATION_RETAINED_AUTHORITY_CORPUS_ID =
  "crash-restoration-retained-authority-proof";

export const CRASH_RESTORATION_RETAINED_AUTHORITY_SCENARIO_PLAN = [
  "crash-boundaries/all-mutation-kinds",
  "recovery/prepared-whole-change-set-restoration",
  "recovery/committed-suppresses-restoration",
  "recovery/compare-before-restore-third-party-preservation",
  "faults/journal-truncation-wrong-vault-checksum-capacity",
  "faults/disk-sync-permission-destination",
  "faults/semantic-timeout-and-callback-reorder",
  "retention/reconnect-crash-and-seven-day-authority",
  "cleanup/no-staging-trash-or-fixture-residue",
] as const;

export type CrashRestorationRetainedAuthorityScenarioName =
  (typeof CRASH_RESTORATION_RETAINED_AUTHORITY_SCENARIO_PLAN)[number];

export class CrashRestorationRetainedAuthorityCorpusError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CrashRestorationRetainedAuthorityCorpusError";
  }
}

export interface CrashRestorationRetainedAuthorityRecord {
  readonly mutationKind: string;
  readonly injectionPoint: string;
  readonly fixtureSha256: string;
  readonly beforeInventorySha256: string;
  readonly afterInventorySha256: string;
  readonly proofState: "intent_applied" | "intent_not_applied" | "result_unproven" | null;
  readonly gate: string | null;
  readonly cleanupSucceeded: boolean;
  readonly verdict: "passed";
}

export interface CrashRestorationRetainedAuthorityCorpusOutcome {
  readonly scenarioManifestSha256: string;
  readonly records: readonly CrashRestorationRetainedAuthorityRecord[];
  readonly coverage: {
    readonly everyMutationKindAtEveryDeclaredBoundary: true;
    readonly preparedRestoresWholeChangeSet: true;
    readonly committedSuppressesRestoration: true;
    readonly conflictingBytesPreservedAndWritesBlocked: true;
    readonly deterministicJournalStorageDestinationAndSemanticFaults: true;
    readonly callbackReorderAndSemanticTimeoutProven: true;
    readonly concurrentIdempotencyProven: true;
  };
  readonly retainedAuthority: {
    readonly retentionMs: typeof CHANGE_SET_RECORD_RETENTION_MS;
    readonly queryableAcrossCrashAndReconnect: true;
    readonly completeRecordsRetained: true;
    readonly requiredRecordsNeverBecomeOrdinaryUnknown: true;
  };
  readonly cleanup: {
    readonly residualPaths: readonly [];
    readonly vaultVisibleStaging: 0;
    readonly managedTrashLeakage: 0;
    readonly fixtureResidue: 0;
  };
  readonly assertions: readonly string[];
}

export interface CrashRestorationRetainedAuthorityCorpusEvidenceDraft {
  readonly corpusId: typeof CRASH_RESTORATION_RETAINED_AUTHORITY_CORPUS_ID;
  readonly scenarioManifestSha256: string;
  readonly records: readonly CrashRestorationRetainedAuthorityRecord[];
  readonly coverage: CrashRestorationRetainedAuthorityCorpusOutcome["coverage"];
  readonly retainedAuthority: CrashRestorationRetainedAuthorityCorpusOutcome["retainedAuthority"];
  readonly cleanup: CrashRestorationRetainedAuthorityCorpusOutcome["cleanup"];
  readonly eventLog: readonly {
    readonly sequence: number;
    readonly kind: "transport" | "tool" | "assertion" | "cleanup";
    readonly name: string;
    readonly detailSha256: string;
  }[];
  readonly assertions: readonly string[];
  readonly verdict: "passed";
}

type EventKind = "transport" | "tool" | "assertion" | "cleanup";

type CorpusRunners = {
  readonly mutation: typeof runMutationCorpusScenario;
  readonly capacity: typeof runMutationCorpusCapacityFaultScenario;
  readonly collision: typeof runMutationCorpusCollisionScenario;
  readonly journal: typeof runMutationCorpusJournalFaultScenario;
  readonly journalWrite: typeof runMutationCorpusJournalWriteFaultScenario;
  readonly hostOperation: typeof runMutationCorpusHostOperationFaultScenario;
  readonly interference: typeof runMutationCorpusRecoveryInterferenceScenario;
  readonly alreadyRestored: typeof runMutationCorpusAlreadyRestoredScenario;
  readonly replay: typeof runSubmissionKeyReplayScenario;
  readonly crashReplay: typeof runSubmissionKeyCrashReplayScenario;
  readonly recoveryBlocked: typeof runSubmissionKeyRecoveryBlockedScenario;
  readonly registryFault: typeof runSubmissionKeyRegistryFaultScenario;
  readonly semantic: typeof runSemanticEvidenceScenario;
};

const defaultRunners: CorpusRunners = {
  mutation: runMutationCorpusScenario,
  capacity: runMutationCorpusCapacityFaultScenario,
  collision: runMutationCorpusCollisionScenario,
  journal: runMutationCorpusJournalFaultScenario,
  journalWrite: runMutationCorpusJournalWriteFaultScenario,
  hostOperation: runMutationCorpusHostOperationFaultScenario,
  interference: runMutationCorpusRecoveryInterferenceScenario,
  alreadyRestored: runMutationCorpusAlreadyRestoredScenario,
  replay: runSubmissionKeyReplayScenario,
  crashReplay: runSubmissionKeyCrashReplayScenario,
  recoveryBlocked: runSubmissionKeyRecoveryBlockedScenario,
  registryFault: runSubmissionKeyRegistryFaultScenario,
  semantic: runSemanticEvidenceScenario,
};

const textEncoder = new TextEncoder();

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value !== "object" || value === null) return JSON.stringify(value);
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, nested]) => `${JSON.stringify(key)}:${canonicalJson(nested)}`)
    .join(",")}}`;
}

function scenarioManifestSha256(): string {
  return sha256(
    canonicalJson({
      corpusId: CRASH_RESTORATION_RETAINED_AUTHORITY_CORPUS_ID,
      scenarios: CRASH_RESTORATION_RETAINED_AUTHORITY_SCENARIO_PLAN,
    }),
  );
}

function inventorySha256(entries: readonly { readonly path: string; readonly kind: string; readonly bytes?: number; readonly sha256?: string }[]): string {
  return sha256(
    canonicalJson(
      entries.map(({ path, kind, bytes, sha256: digest }) => ({ path, kind, bytes: bytes ?? null, sha256: digest ?? null })),
    ),
  );
}

function fixtureSha256(profile: MutationCorpusProfile): string {
  return sha256(
    canonicalJson(
      profile.files.map((file) => ({
        path: file.path,
        kind: file.kind ?? "markdown",
        originalSha256: file.originalBytes === null ? null : sha256(file.originalBytes),
        committedSha256: file.committedBytes === null ? null : sha256(file.committedBytes),
      })),
    ),
  );
}

function assertScenarioEvidence(
  evidence: CorpusScenarioEvidence,
  profile: MutationCorpusProfile,
  injectionPoint: string,
): CrashRestorationRetainedAuthorityRecord {
  if (evidence.verdict !== "pass" || evidence.failures.length > 0 || !evidence.cleanup.success) {
    throw new CrashRestorationRetainedAuthorityCorpusError(
      `${profile.kind} at ${injectionPoint} did not close its crash-recovery proof`,
    );
  }
  if (evidence.residualPaths.some((path) => path.startsWith("trash:") || path.startsWith("staging:"))) {
    throw new CrashRestorationRetainedAuthorityCorpusError(
      `${profile.kind} at ${injectionPoint} exposed Bridge-private residue`,
    );
  }
  return {
    mutationKind: profile.kind,
    injectionPoint,
    fixtureSha256: fixtureSha256(profile),
    beforeInventorySha256: inventorySha256(evidence.before),
    afterInventorySha256: inventorySha256(evidence.after),
    proofState: evidence.proofState,
    gate: evidence.gate.effectiveGate,
    cleanupSucceeded: true,
    verdict: "passed",
  };
}

function assertSubmissionEvidence(evidence: SubmissionKeyCorpusEvidence, label: string): void {
  if (evidence.verdict !== "pass" || evidence.failures.length > 0 || !evidence.cleanup.success) {
    throw new CrashRestorationRetainedAuthorityCorpusError(
      `Submission Key authority scenario ${label} did not close its proof`,
    );
  }
}

function allMutationProfiles(): readonly MutationCorpusProfile[] {
  return [
    createNoteCorpusProfile(),
    replaceExactCorpusProfile(),
    replaceWholeCorpusProfile(),
    editFrontmatterCorpusProfile(),
    multiMarkdownCorpusProfile(),
    multiFrontmatterCorpusProfile(),
    moveNoteCorpusProfile(),
    copyAttachmentCorpusProfile(),
    moveAttachmentCorpusProfile(),
    trashNoteCorpusProfile(),
    trashAttachmentCorpusProfile(),
  ];
}

function seedFor(profile: MutationCorpusProfile, crashPoint: MutationCorpusCrashPoint): string {
  return `${profile.label}-${crashPoint.phase}-${crashPoint.point.replace(/[^A-Za-z0-9_-]/gu, "_")}`;
}

function foreignBytes(label: string): Uint8Array {
  return textEncoder.encode(`# Third-party ${label}\r\n\r\nForeign bytes that no Change Set wrote.\r\n`);
}

function faultRecord(
  evidence: CorpusScenarioEvidence,
  profile: MutationCorpusProfile,
  injectionPoint: string,
): CrashRestorationRetainedAuthorityRecord {
  const record = assertScenarioEvidence(evidence, profile, injectionPoint);
  if (evidence.fault?.fired.fired !== true && !injectionPoint.startsWith("journal/")) {
    throw new CrashRestorationRetainedAuthorityCorpusError(
      `${profile.kind} fault ${injectionPoint} did not fire deterministically`,
    );
  }
  return record;
}

export async function runCrashRestorationRetainedAuthorityCorpus(options: {
  readonly workingDirectory: string;
  readonly record: (kind: EventKind, name: string, detail: unknown) => void;
  readonly assertion: (name: string) => void;
  readonly runners?: Partial<CorpusRunners>;
}): Promise<CrashRestorationRetainedAuthorityCorpusOutcome> {
  const runners = { ...defaultRunners, ...options.runners };
  const reportDirectory = await mkdtemp(join(options.workingDirectory, "crash-restoration-proof-"));
  const assertions: string[] = [];
  const records: CrashRestorationRetainedAuthorityRecord[] = [];
  const assertion = (name: string): void => {
    assertions.push(name);
    options.assertion(name);
  };
  const add = (record: CrashRestorationRetainedAuthorityRecord): void => {
    records.push(record);
    options.record("assertion", "crash-restoration-record", {
      mutationKind: record.mutationKind,
      injectionPoint: record.injectionPoint,
      proofState: record.proofState,
      gate: record.gate,
      fixtureSha256: record.fixtureSha256,
      beforeInventorySha256: record.beforeInventorySha256,
      afterInventorySha256: record.afterInventorySha256,
    });
  };

  try {
    for (const profile of allMutationProfiles()) {
      for (const crashPoint of profile.crashPoints) {
        const evidence = await runners.mutation({
          profile,
          crashPoint,
          seed: seedFor(profile, crashPoint),
          reportDir: reportDirectory,
        });
        add(assertScenarioEvidence(evidence, profile, `${crashPoint.phase}:${crashPoint.point}`));
      }
    }
    assertion("crash-boundaries:every-mutation-kind-and-declared-boundary");

    const edit = replaceExactCorpusProfile();
    const trash = trashNoteCorpusProfile();
    const move = moveNoteCorpusProfile();
    const moveDestination = move.files.find((file) => file.committedBytes !== null && file.originalBytes === null)!;

    const prepared = await runners.alreadyRestored({
      profile: edit,
      seed: "prepared-whole-change-set",
      reportDir: reportDirectory,
      mode: "crash_before_rolled_back",
    });
    add(assertScenarioEvidence(prepared, edit, "restored-journal:prepared-whole-change-set"));
    if (prepared.proofState !== "intent_not_applied" || prepared.gate.effectiveGate !== null) {
      throw new CrashRestorationRetainedAuthorityCorpusError("A durable PREPARED frame did not restore before new writes");
    }
    assertion("recovery:durable-prepared-restores-whole-change-set-before-writes");

    const committed = await runners.mutation({
      profile: edit,
      crashPoint: { phase: "apply", point: "after_committed" },
      seed: "committed-suppresses-restoration",
      reportDir: reportDirectory,
    });
    add(assertScenarioEvidence(committed, edit, "apply:after_committed"));
    if (committed.proofState !== "intent_applied") {
      throw new CrashRestorationRetainedAuthorityCorpusError("A durable COMMITTED frame did not suppress restoration");
    }
    assertion("recovery:durable-committed-suppresses-restoration");

    const conflict = await runners.interference({
      profile: move,
      seed: "compare-before-restore-foreign-destination",
      reportDir: reportDirectory,
      recoveryParkPoint: "before_rollback",
      interference: { area: "public", path: moveDestination.path, bytes: foreignBytes("destination") },
    });
    add(assertScenarioEvidence(conflict, move, "external-mutation:compare-before-restore"));
    if (
      conflict.proofState !== "result_unproven" ||
      conflict.gate.effectiveGate !== "recovery_blocked" ||
      conflict.interference?.conflict?.matchesBefore !== false
    ) {
      throw new CrashRestorationRetainedAuthorityCorpusError("Foreign bytes were not preserved behind result_unproven");
    }
    assertion("recovery:compare-before-restore-preserves-third-party-bytes-and-blocks-writes");

    const journalFaults: readonly Parameters<typeof runners.journal>[0][] = [
      {
        profile: edit,
        seed: "fault-truncated-journal",
        reportDir: reportDirectory,
        parkPoint: "after_prepared",
        corruption: { kind: "truncate_header" },
        expectedRecovery: "boot_refused",
      },
      {
        profile: edit,
        seed: "fault-wrong-vault",
        reportDir: reportDirectory,
        parkPoint: "after_prepared",
        wrongVault: true,
        expectedRecovery: "blocked_unproven",
      },
      {
        profile: edit,
        seed: "fault-invalid-checksum",
        reportDir: reportDirectory,
        parkPoint: "after_committed",
        corruption: { kind: "corrupt_frame_checksum", target: "both" },
        expectedRecovery: "blocked_unproven",
      },
    ];
    for (const fault of journalFaults) {
      add(faultRecord(await runners.journal(fault), edit, `journal/${fault.seed}`));
    }
    add(
      faultRecord(
        await runners.capacity({ profile: edit, seed: "fault-capacity", reportDir: reportDirectory, slotCapacity: 96 }),
        edit,
        "journal/capacity",
      ),
    );
    const writeFaults: readonly JournalWriteFault[] = [
      { phase: "COMMITTED", occurrence: 1, step: "before_write", code: "ENOSPC", message: "injected disk full" },
      { phase: "COMMITTED", occurrence: 1, step: "sync", code: "EIO", message: "injected sync failure" },
      { phase: "COMMITTED", occurrence: 1, step: "before_write", code: "EACCES", message: "injected permission failure" },
    ];
    for (const fault of writeFaults) {
      add(
        faultRecord(
          await runners.journalWrite({
            profile: edit,
            seed: `fault-${fault.code}-${fault.step}`,
            reportDir: reportDirectory,
            fault,
            generation: "apply",
            expectedProof: "intent_not_applied",
            expectedGate: "open",
          }),
          edit,
          `journal-write/${fault.code}-${fault.step}`,
        ),
      );
    }
    add(
      faultRecord(
        await runners.hostOperation({
          profile: trash,
          seed: "fault-trash-restore-permission",
          reportDir: reportDirectory,
          operation: "restoreFromTrash",
          code: "EACCES",
          expectedHiddenTrashCount: 1,
        }),
        trash,
        "managed-trash/permission",
      ),
    );
    add(
      assertScenarioEvidence(
        await runners.collision({
          profile: copyAttachmentCorpusProfile(),
          seed: "fault-destination-collision",
          reportDir: reportDirectory,
          collisionPath: copyAttachmentCorpusProfile().files.find((file) => file.originalBytes === null)!.path,
          collisionBytes: Uint8Array.from([0x63, 0x6f, 0x6c, 0x6c, 0x69, 0x64, 0x65]),
        }),
        copyAttachmentCorpusProfile(),
        "destination/preexisting-bytes",
      ),
    );
    assertion("faults:truncation-wrong-vault-checksum-capacity-disk-sync-permission-destination");

    const semanticReports = await Promise.all([
      runners.semantic({ scenario: multiFrontmatterReorderedCallbacks(), reportDir: reportDirectory }),
      runners.semantic({ scenario: moveNoteMissingRenameEventDeadline(), reportDir: reportDirectory }),
    ]);
    if (semanticReports.some((report) => report.verdict !== "pass" || report.failures.length > 0)) {
      throw new CrashRestorationRetainedAuthorityCorpusError("Semantic callback reorder or timeout did not fail closed");
    }
    options.record("assertion", "semantic-callback-and-timeout", {
      scenarios: semanticReports.map((report) => ({
        scenario: report.scenario,
        proofState: report.proofState,
        journalPhase: report.journalPhase,
      })),
    });
    assertion("semantic-evidence:reordered-callback-and-timeout-fail-closed");

    const replay = await runners.replay({ profile: edit, seed: "retention-reconnect", reportDir: reportDirectory });
    const crashReplay = await runners.crashReplay({
      profile: edit,
      seed: "retention-crash-reconnect",
      reportDir: reportDirectory,
      crashPoint: "after_prepared",
      expectedProof: "intent_not_applied",
    });
    const blocked = await runners.recoveryBlocked({
      profile: edit,
      seed: "retention-recovery-blocked",
      reportDir: reportDirectory,
      residueBytes: foreignBytes("retained-authority"),
      blockedNotePath: "CrashRestorationProof/Blocked.md",
    });
    const missingRegistry = await runners.registryFault({
      profile: edit,
      seed: "retention-required-record-missing",
      reportDir: reportDirectory,
      fault: "missing",
    });
    for (const [label, evidence] of [
      ["reconnect", replay],
      ["crash-reconnect", crashReplay],
      ["recovery-blocked", blocked],
      ["required-record-missing", missingRegistry],
    ] as const) {
      assertSubmissionEvidence(evidence, label);
    }
    if (
      replay.registryAfter?.entries.some((entry) => entry.retentionMs < CHANGE_SET_RECORD_RETENTION_MS) ||
      missingRegistry.results.unrelatedStatus === undefined
    ) {
      throw new CrashRestorationRetainedAuthorityCorpusError("Submission Key retention authority was not durably preserved");
    }
    options.record("assertion", "retained-submission-authority", {
      retentionMs: CHANGE_SET_RECORD_RETENTION_MS,
      scenarios: 4,
      crashAndReconnect: true,
      ordinaryUnknownRejectedForRequiredRecord: true,
    });
    assertion("retention:seven-day-records-queryable-across-crash-and-reconnect");
    assertion("retention:required-record-loss-never-degrades-to-ordinary-unknown");

    if (records.some((record) => !record.cleanupSucceeded)) {
      throw new CrashRestorationRetainedAuthorityCorpusError("A crash scenario left residual fixture state");
    }
    options.record("cleanup", "crash-restoration-temporary-reports", { residualPaths: 0 });
    assertion("cleanup:no-vault-visible-staging-managed-trash-leakage-or-fixture-residue");

    return {
      scenarioManifestSha256: scenarioManifestSha256(),
      records,
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
      assertions,
    };
  } finally {
    await rm(reportDirectory, { recursive: true, force: true }).catch(() => undefined);
  }
}

export function composeCrashRestorationRetainedAuthorityCorpusEvidence(options: {
  readonly outcome: CrashRestorationRetainedAuthorityCorpusOutcome;
  readonly events: readonly { readonly kind: EventKind; readonly name: string; readonly detail: unknown }[];
  readonly assertions: readonly string[];
}): CrashRestorationRetainedAuthorityCorpusEvidenceDraft {
  const { outcome } = options;
  if (
    outcome.records.length === 0 ||
    outcome.records.some((record) => !record.cleanupSucceeded || record.verdict !== "passed") ||
    outcome.cleanup.residualPaths.length !== 0 ||
    outcome.cleanup.vaultVisibleStaging !== 0 ||
    outcome.cleanup.managedTrashLeakage !== 0 ||
    outcome.cleanup.fixtureResidue !== 0 ||
    outcome.retainedAuthority.retentionMs !== CHANGE_SET_RECORD_RETENTION_MS ||
    !Object.values(outcome.coverage).every(Boolean) ||
    outcome.assertions.length === 0 ||
    options.assertions.length === 0
  ) {
    throw new CrashRestorationRetainedAuthorityCorpusError(
      "Crash-restoration retained-authority outcome does not satisfy release-blocking invariants",
    );
  }
  return {
    corpusId: CRASH_RESTORATION_RETAINED_AUTHORITY_CORPUS_ID,
    scenarioManifestSha256: outcome.scenarioManifestSha256,
    records: outcome.records,
    coverage: outcome.coverage,
    retainedAuthority: outcome.retainedAuthority,
    cleanup: outcome.cleanup,
    eventLog: options.events.map((event, index) => ({
      sequence: index + 1,
      kind: event.kind,
      name: event.name,
      detailSha256: sha256(canonicalJson(event.detail)),
    })),
    assertions: [...options.assertions],
    verdict: "passed",
  };
}
