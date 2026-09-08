import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  replaceExactCorpusProfile,
} from "../src/corpus/edit-body-corpus.js";
import {
  trashNoteCorpusProfile,
} from "../src/corpus/managed-trash-corpus.js";
import {
  runMutationCorpusCapacityFaultScenario,
  runMutationCorpusHostOperationFaultScenario,
  runMutationCorpusJournalFaultScenario,
  runMutationCorpusJournalWriteFaultScenario,
  type CorpusScenarioEvidence,
} from "../src/corpus/crash-corpus-runner.js";
import type { JournalWriteFault } from "../src/corpus/journal-faults.js";

const temporaryReportRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryReportRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function reportDir(label: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `journal-fault-${label}-`));
  temporaryReportRoots.push(root);
  return root;
}

function assertPass(evidence: CorpusScenarioEvidence): void {
  expect(evidence.failures, JSON.stringify(evidence, null, 2)).toEqual([]);
  expect(evidence.verdict).toBe("pass");
  expect(evidence.cleanup.success).toBe(true);
}

describe("recovery-journal corruption corpus (issue #192)", () => {
  const profile = replaceExactCorpusProfile();

  it(
    "selects the newest trustworthy frame when only the newest frame survives",
    async () => {
      const seed = "journal-valid-newest";
      const evidence = await runMutationCorpusJournalFaultScenario({
        profile,
        seed,
        reportDir: await reportDir(seed),
        parkPoint: "after_committed",
        corruption: { kind: "corrupt_frame_checksum", target: "older" },
        expectedRecovery: "applied",
      });
      assertPass(evidence);
      expect(evidence.proofState).toBe("intent_applied");
      expect(evidence.fault?.fired.fired).toBe(false);
      expect(evidence.gate.effectiveGate).toBeNull();
      expect(evidence.sentinel.applied).toBe(true);
    },
    120_000,
  );

  it(
    "falls back to the older trustworthy frame when the newest frame is checksum-invalid",
    async () => {
      const seed = "journal-newest-corrupt";
      const evidence = await runMutationCorpusJournalFaultScenario({
        profile,
        seed,
        reportDir: await reportDir(seed),
        parkPoint: "after_committed",
        corruption: { kind: "corrupt_frame_checksum", target: "newest" },
        expectedRecovery: "rolled_back",
      });
      assertPass(evidence);
      expect(evidence.proofState).toBe("intent_not_applied");
      expect(evidence.gate.effectiveGate).toBeNull();
      expect(evidence.sentinel.applied).toBe(true);
    },
    120_000,
  );

  it(
    "fails closed with an observable blocked gate when no frame is trustworthy",
    async () => {
      const seed = "journal-no-trustworthy";
      const evidence = await runMutationCorpusJournalFaultScenario({
        profile,
        seed,
        reportDir: await reportDir(seed),
        parkPoint: "after_committed",
        corruption: { kind: "corrupt_frame_checksum", target: "both" },
        expectedRecovery: "blocked_unproven",
      });
      assertPass(evidence);
      expect(evidence.proofState).toBe("result_unproven");
      expect(evidence.gate.effectiveGate).not.toBeNull();
      expect(evidence.sentinel.applied).toBe(false);
      expect(evidence.residualPaths.length).toBeGreaterThan(0);
    },
    120_000,
  );

  it(
    "never interprets wrong-Vault journal data as a Change Set for the current Vault",
    async () => {
      const seed = "journal-wrong-vault";
      const evidence = await runMutationCorpusJournalFaultScenario({
        profile,
        seed,
        reportDir: await reportDir(seed),
        parkPoint: "after_prepared",
        wrongVault: true,
        expectedRecovery: "blocked_unproven",
      });
      assertPass(evidence);
      expect(evidence.proofState).toBe("result_unproven");
      expect(evidence.gate.effectiveGate).not.toBeNull();
      expect(evidence.sentinel.applied).toBe(false);
      // The journal frame is untouched and no recovery mutation overwrote it.
      expect(evidence.fault?.journal.after?.recoverable?.phase).toBe("PREPARED");
    },
    120_000,
  );

  it(
    "refuses to boot over a truncated journal header without mutating public state",
    async () => {
      const seed = "journal-truncated-header";
      const evidence = await runMutationCorpusJournalFaultScenario({
        profile,
        seed,
        reportDir: await reportDir(seed),
        parkPoint: "after_prepared",
        corruption: { kind: "truncate_header" },
        expectedRecovery: "boot_refused",
      });
      assertPass(evidence);
      expect(evidence.proofState).toBeNull();
    },
    120_000,
  );

  it(
    "refuses to boot over an incompatible journal magic",
    async () => {
      const seed = "journal-incompatible-magic";
      const evidence = await runMutationCorpusJournalFaultScenario({
        profile,
        seed,
        reportDir: await reportDir(seed),
        parkPoint: "after_prepared",
        corruption: { kind: "incompatible_magic" },
        expectedRecovery: "boot_refused",
      });
      assertPass(evidence);
    },
    120_000,
  );

  it(
    "refuses to boot over an incompatible journal schema version",
    async () => {
      const seed = "journal-incompatible-version";
      const evidence = await runMutationCorpusJournalFaultScenario({
        profile,
        seed,
        reportDir: await reportDir(seed),
        parkPoint: "after_prepared",
        corruption: { kind: "incompatible_version" },
        expectedRecovery: "boot_refused",
      });
      assertPass(evidence);
    },
    120_000,
  );

  it(
    "refuses to boot when the requested journal slot capacity does not match the file",
    async () => {
      const seed = "journal-incompatible-capacity";
      const evidence = await runMutationCorpusJournalFaultScenario({
        profile,
        seed,
        reportDir: await reportDir(seed),
        gen2JournalSlotCapacity: 1024,
        expectedRecovery: "boot_refused",
      });
      assertPass(evidence);
    },
    120_000,
  );
});

describe("recovery-journal storage-fault corpus (issue #192)", () => {
  const profile = replaceExactCorpusProfile();

  const committedSteps: readonly { step: JournalWriteFault["step"]; label: string }[] = [
    { step: "before_write", label: "disk-full-before-write" },
    { step: "no_progress", label: "no-progress" },
    { step: "short_write", label: "short-write" },
    { step: "sync", label: "sync-failure" },
    { step: "after_sync", label: "post-sync-failure" },
  ];

  for (const { step, label } of committedSteps) {
    it(
      `a failed COMMITTED persistence step (${label}) rolls back and never advances public proof`,
      async () => {
        const seed = `committed-${label}`;
        const fault: JournalWriteFault = {
          phase: "COMMITTED",
          occurrence: 1,
          step,
          code: "ENOSPC",
          message: `injected ${label} on COMMITTED`,
          ...(step === "short_write" ? { partialPrefixBytes: 16 } : {}),
        };
        const evidence = await runMutationCorpusJournalWriteFaultScenario({
          profile,
          seed,
          reportDir: await reportDir(seed),
          fault,
          generation: "apply",
          expectedProof: "intent_not_applied",
          expectedGate: "open",
        });
        assertPass(evidence);
        expect(evidence.fault?.fired.fired).toBe(true);
        expect(evidence.fault?.fired.at?.phase).toBe("COMMITTED");
        expect(evidence.proofState).toBe("intent_not_applied");
        expect(evidence.sentinel.applied).toBe(true);
      },
      120_000,
    );
  }

  it(
    "a permission-denied COMMITTED persistence step fails closed without destroying the last recoverable frame",
    async () => {
      const seed = "committed-permission-denied";
      const fault: JournalWriteFault = {
        phase: "COMMITTED",
        occurrence: 1,
        step: "before_write",
        code: "EACCES",
        message: "injected EACCES on COMMITTED",
      };
      const evidence = await runMutationCorpusJournalWriteFaultScenario({
        profile,
        seed,
        reportDir: await reportDir(seed),
        fault,
        generation: "apply",
        expectedProof: "intent_not_applied",
        expectedGate: "open",
      });
      assertPass(evidence);
      expect(evidence.fault?.fired.fired).toBe(true);
      expect(evidence.fault?.fired.at?.phase).toBe("COMMITTED");
      expect(evidence.proofState).toBe("intent_not_applied");
      expect(evidence.fault?.journal.after?.recoverable).not.toBeNull();
    },
    120_000,
  );

  it(
    "a failed ROLLED_BACK persistence step during recovery reports result_unproven and blocks writes",
    async () => {
      const seed = "rolled-back-sync-failure";
      const fault: JournalWriteFault = {
        phase: "ROLLED_BACK",
        occurrence: 1,
        step: "sync",
        code: "EIO",
        message: "injected sync failure on ROLLED_BACK",
      };
      const evidence = await runMutationCorpusJournalWriteFaultScenario({
        profile,
        seed,
        reportDir: await reportDir(seed),
        fault,
        generation: "recovery",
        expectedProof: "result_unproven",
        expectedGate: "blocked",
      });
      assertPass(evidence);
      expect(evidence.fault?.fired.fired).toBe(true);
      expect(evidence.fault?.fired.at?.phase).toBe("ROLLED_BACK");
      expect(evidence.proofState).toBe("result_unproven");
      expect(evidence.gate.effectiveGate).not.toBeNull();
      expect(evidence.sentinel.applied).toBe(false);
      // Enough failure evidence is retained for local diagnosis: the durable
      // FAILED frame supersedes the unproven ROLLED_BACK attempt.
      expect(evidence.fault?.journal.after?.recoverable?.phase).toBe("FAILED");
    },
    120_000,
  );

  it(
    "a failed FAILED persistence step during recovery over a third-party residue fails closed and preserves the residue",
    async () => {
      const seed = "failed-persist-residue";
      const fixture = profile.files[0]!;
      const residueBytes = new TextEncoder().encode(
        "# Foreign\n\nBytes a Change Set never wrote 你好 🚀\n",
      );
      expect(
        Buffer.from(residueBytes).equals(Buffer.from(fixture.originalBytes!)) ||
          Buffer.from(residueBytes).equals(Buffer.from(fixture.committedBytes!)),
      ).toBe(false);
      const fault: JournalWriteFault = {
        phase: "FAILED",
        occurrence: 1,
        step: "before_write",
        code: "EIO",
        message: "injected failure on FAILED persistence",
      };
      const evidence = await runMutationCorpusJournalWriteFaultScenario({
        profile,
        seed,
        reportDir: await reportDir(seed),
        fault,
        generation: "recovery",
        residue: { path: fixture.path, bytes: residueBytes },
        expectedProof: "result_unproven",
        expectedGate: "blocked",
      });
      assertPass(evidence);
      expect(evidence.fault?.fired.fired).toBe(true);
      expect(evidence.fault?.fired.at?.phase).toBe("FAILED");
      expect(evidence.proofState).toBe("result_unproven");
      expect(evidence.gate.effectiveGate).not.toBeNull();
      expect(evidence.sentinel.applied).toBe(false);
      // The third-party residue is preserved and surfaced for local diagnosis.
      const final = evidence.fileFinal.find((file) => file.path === fixture.path);
      expect(final?.bytesMatchOriginal).toBe(false);
      expect(final?.bytesMatchCommitted).toBe(false);
      expect(evidence.residualPaths).toContain(`file:${fixture.path}`);
    },
    120_000,
  );

  it(
    "a real slot-capacity error at the first PREPARED persistence never advances proof and a clean restart commits",
    async () => {
      const seed = "slot-capacity-exhaustion";
      const evidence = await runMutationCorpusCapacityFaultScenario({
        profile,
        seed,
        reportDir: await reportDir(seed),
        slotCapacity: 96,
      });
      assertPass(evidence);
      expect(evidence.proofState).toBe("intent_applied");
      expect(evidence.sentinel.applied).toBe(true);
    },
    120_000,
  );
});

describe("managed-trash rollback storage fault corpus (issue #192)", () => {
  it(
    "a permission failure restoring from Managed Trash preserves current/hidden state and blocks writes",
    async () => {
      const profile = trashNoteCorpusProfile();
      const seed = "trash-restore-eacces";
      const evidence = await runMutationCorpusHostOperationFaultScenario({
        profile,
        seed,
        reportDir: await reportDir(seed),
        operation: "restoreFromTrash",
        code: "EACCES",
        expectedHiddenTrashCount: 1,
      });
      assertPass(evidence);
      expect(evidence.proofState).toBe("result_unproven");
      expect(evidence.gate.effectiveGate).not.toBeNull();
      expect(evidence.sentinel.applied).toBe(false);
      expect(evidence.hidden?.trashCount).toBe(1);
      expect(evidence.fault?.fired.fired).toBe(true);
      expect(
        evidence.residualPaths.some((entry) => entry.startsWith("trash:")),
        "a private Managed-Trash path must never be surfaced as a residual path",
      ).toBe(false);
    },
    120_000,
  );
});
