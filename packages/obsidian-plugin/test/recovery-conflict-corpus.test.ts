/**
 * Recovery-conflict corpus (issue #194).
 *
 * Proves that plugin startup resolves an active durable PREPARED frame before
 * any new write and that compare-before-restore never overwrites a third-party
 * mutation — whether the interference lands while recovery itself is parked
 * mid-restore or beforehand. Each deterministic scenario parks a real owning
 * process inside startup recovery, mutates a declared footprint as a third
 * party, and then proves across two more generations (one of them a restart
 * over the unproven residue) that recovery fails closed with result_unproven,
 * projects recovery_blocked, rejects the sentinel write, and preserves every
 * third-party byte.
 */

import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  COPY_ATTACHMENT_DESTINATION_PATH,
  MOVE_ATTACHMENT_SOURCE_PATH,
  copyAttachmentCorpusProfile,
  moveAttachmentCorpusProfile,
} from "../src/corpus/attachment-corpus.js";
import {
  CREATE_NOTE_PATH,
  createNoteCorpusProfile,
} from "../src/corpus/create-note-corpus.js";
import {
  replaceExactCorpusProfile,
} from "../src/corpus/edit-body-corpus.js";
import {
  EXACT_FIXTURE,
  FRONTMATTER_FIXTURE,
} from "../src/corpus/edit-fixtures.js";
import {
  editFrontmatterCorpusProfile,
} from "../src/corpus/frontmatter-corpus.js";
import {
  TRASH_NOTE_BYTES,
  TRASH_NOTE_PATH,
  trashNoteCorpusProfile,
} from "../src/corpus/managed-trash-corpus.js";
import {
  MOVE_DERIVED_A_PATH,
  MOVE_DESTINATION_PATH,
  MOVE_SOURCE_PATH,
  moveNoteCorpusProfile,
} from "../src/corpus/move-note-corpus.js";
import {
  multiMarkdownCorpusProfile,
  multiMarkdownFiles,
} from "../src/corpus/multi-operation-corpus.js";
import {
  runMutationCorpusAlreadyRestoredScenario,
  runMutationCorpusRecoveryInterferenceScenario,
  type CorpusRecoveryInterferenceEvidence,
  type CorpusScenarioEvidence,
  type RecoveryInterference,
} from "../src/corpus/crash-corpus-runner.js";
import {
  ChangeSetService,
  type ChangeSetExecutionAdapter,
  type ChangeSetRegistryState,
  type ChangeSetRegistryStore,
  type RecoveryJournalFrame,
} from "../src/index.js";

const textEncoder = new TextEncoder();

const temporaryReportRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryReportRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function reportDir(label: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `recovery-conflict-${label}-`));
  temporaryReportRoots.push(root);
  return root;
}

function hashBytes(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function foreignMarkdown(label: string): Uint8Array {
  return textEncoder.encode(
    `# Third-party ${label}\r\n\r\nForeign bytes no Change Set wrote 你好 🚀.\r\n`,
  );
}

function foreignBinary(): Uint8Array {
  return Uint8Array.from([0xde, 0xad, 0xbe, 0xef, 0x00, 0xff, 0x13, 0x80, 0x42]);
}

/** Shared assertions for a recovery-interference scenario (AC1/AC2/AC4/AC7). */
function assertInterferenceEvidence(
  evidence: CorpusScenarioEvidence,
  options: {
    readonly conflictPath: string;
    readonly conflictArea: "public" | "private_trash";
    readonly interferenceBytes: Uint8Array;
    readonly parkPoint: string;
    readonly beforeSha256: string | null;
    readonly expectedAfterSha256: string | null;
  },
): CorpusRecoveryInterferenceEvidence {
  expect(evidence.failures, JSON.stringify(evidence, null, 2)).toEqual([]);
  expect(evidence.verdict).toBe("pass");
  expect(evidence.cleanup.success).toBe(true);

  // AC4: result_unproven + recovery_blocked with a rejected sentinel.
  expect(evidence.proofState).toBe("result_unproven");
  expect(evidence.gate.effectiveGate).toBe("recovery_blocked");
  expect(evidence.gate.writeGate).toBe("blocked");
  expect(evidence.gate.recoveryState).toBe("blocked");
  expect(evidence.sentinel.applied).toBe(false);

  const interference = evidence.interference;
  expect(interference, "no recovery-interference evidence was recorded").toBeDefined();
  expect(interference!.recoveryParkPoint).toBe(options.parkPoint);

  // AC4: the conflict records observed/expected hashes without content.
  const conflict = interference!.conflict;
  expect(conflict).not.toBeNull();
  expect(conflict!.area).toBe(options.conflictArea);
  expect(conflict!.path).toBe(options.conflictPath);
  expect(conflict!.observedSha256).toBe(hashBytes(options.interferenceBytes));
  expect(conflict!.beforeSha256).toBe(options.beforeSha256);
  expect(conflict!.expectedAfterSha256).toBe(options.expectedAfterSha256);
  expect(conflict!.matchesBefore).toBe(false);
  expect(conflict!.matchesExpectedAfter).toBe(false);
  for (const value of Object.values(conflict!)) {
    if (typeof value === "string") {
      expect(
        value.includes("Foreign bytes no Change Set wrote"),
        "conflict records must never expose byte content",
      ).toBe(false);
    }
  }

  // AC1: while recovery was parked, no new Change Set mutation could begin —
  // the Bridge exposes no write surface until recovery resolves.
  expect(interference!.admissionDuringRecovery.attempted).toBe(true);
  expect(interference!.admissionDuringRecovery.admitted).toBe(false);
  expect(interference!.admissionDuringRecovery.reachable).toBe(false);

  // AC4/AC7: gate transitions — the conflict generation and the restart both
  // keep the Vault-wide write gate blocked and reject the sentinel.
  expect(interference!.generations.map(({ generation }) => generation)).toEqual([3, 4]);
  for (const generation of interference!.generations) {
    expect(generation.proofState).toBe("result_unproven");
    expect(generation.effectiveGate).toBe("recovery_blocked");
    expect(generation.writeGate).toBe("blocked");
    expect(generation.sentinel.attempted).toBe(true);
    expect(generation.sentinel.admitted).toBe(false);
    expect(generation.sentinel.gate).toBe("recovery_blocked");
  }

  // AC7: the report records the mutation/recovery interleaving.
  expect(interference!.interleaving.length).toBeGreaterThan(0);
  expect(
    interference!.interleaving.some(
      (line) => line.startsWith("gen2:") && line.includes(options.parkPoint.split(":")[0]!),
    ),
    "the child event log must show generation 2 reaching the recovery park point",
  ).toBe(true);
  expect(
    interference!.interleaving.some((line) => line.includes("supervisor:")),
    "the interleaving must record the supervisor actions",
  ).toBe(true);
  return interference!;
}

describe("startup recovery preserves third-party state (issue #194)", () => {
  it(
    "create_note: interference during a parked rollback fails closed and survives a restart",
    async () => {
      const profile = createNoteCorpusProfile();
      const bytes = foreignMarkdown("create");
      const evidence = await runMutationCorpusRecoveryInterferenceScenario({
        profile,
        seed: "interference-create-note",
        reportDir: await reportDir("create-note"),
        recoveryParkPoint: "before_rollback",
        interference: { area: "public", path: CREATE_NOTE_PATH, bytes },
      });
      const interference = assertInterferenceEvidence(evidence, {
        conflictPath: CREATE_NOTE_PATH,
        conflictArea: "public",
        interferenceBytes: bytes,
        parkPoint: "before_rollback",
        beforeSha256: null,
        expectedAfterSha256: hashBytes(profile.files[0]!.committedBytes!),
      });
      expect(evidence.residualPaths).toContain(`file:${CREATE_NOTE_PATH}`);
      const final = evidence.fileFinal.find((file) => file.path === CREATE_NOTE_PATH);
      expect(final?.sha256).toBe(hashBytes(bytes));
      expect(interference.conflict?.observedSha256).toBe(final?.sha256);
    },
    180_000,
  );

  it(
    "edit_body: interference after the rollback copy was staged fails closed",
    async () => {
      const profile = replaceExactCorpusProfile();
      const bytes = foreignMarkdown("edit-body");
      const parkPoint = `recovery_after_file_prepared:${EXACT_FIXTURE.path}`;
      const evidence = await runMutationCorpusRecoveryInterferenceScenario({
        profile,
        seed: "interference-edit-body",
        reportDir: await reportDir("edit-body"),
        recoveryParkPoint: parkPoint,
        interference: { area: "public", path: EXACT_FIXTURE.path, bytes },
      });
      assertInterferenceEvidence(evidence, {
        conflictPath: EXACT_FIXTURE.path,
        conflictArea: "public",
        interferenceBytes: bytes,
        parkPoint,
        beforeSha256: hashBytes(profile.files[0]!.originalBytes!),
        expectedAfterSha256: hashBytes(profile.files[0]!.committedBytes!),
      });
      expect(evidence.residualPaths).toContain(`file:${EXACT_FIXTURE.path}`);
      const final = evidence.fileFinal.find((file) => file.path === EXACT_FIXTURE.path);
      expect(final?.sha256).toBe(hashBytes(bytes));
    },
    180_000,
  );

  it(
    "edit_frontmatter: interference over an already-restored footprint fails closed",
    async () => {
      const profile = editFrontmatterCorpusProfile();
      const bytes = foreignMarkdown("frontmatter");
      const evidence = await runMutationCorpusRecoveryInterferenceScenario({
        profile,
        seed: "interference-frontmatter",
        reportDir: await reportDir("frontmatter"),
        recoveryParkPoint: "after_rollback_mutation:0",
        interference: { area: "public", path: FRONTMATTER_FIXTURE.path, bytes },
      });
      assertInterferenceEvidence(evidence, {
        conflictPath: FRONTMATTER_FIXTURE.path,
        conflictArea: "public",
        interferenceBytes: bytes,
        parkPoint: "after_rollback_mutation:0",
        beforeSha256: hashBytes(profile.files[0]!.originalBytes!),
        expectedAfterSha256: hashBytes(profile.files[0]!.committedBytes!),
      });
      expect(evidence.residualPaths).toContain(`file:${FRONTMATTER_FIXTURE.path}`);
    },
    180_000,
  );

  it(
    "move_note: third-party bytes at the move destination are never overwritten",
    async () => {
      const profile = moveNoteCorpusProfile();
      const bytes = foreignMarkdown("move-destination");
      const evidence = await runMutationCorpusRecoveryInterferenceScenario({
        profile,
        seed: "interference-move-destination",
        reportDir: await reportDir("move-destination"),
        recoveryParkPoint: "before_rollback",
        interference: { area: "public", path: MOVE_DESTINATION_PATH, bytes },
      });
      assertInterferenceEvidence(evidence, {
        conflictPath: MOVE_DESTINATION_PATH,
        conflictArea: "public",
        interferenceBytes: bytes,
        parkPoint: "before_rollback",
        beforeSha256: null,
        expectedAfterSha256: hashBytes(
          profile.files.find((file) => file.path === MOVE_DESTINATION_PATH)!.committedBytes!,
        ),
      });
      expect(evidence.residualPaths).toContain(`file:${MOVE_DESTINATION_PATH}`);
      // The untouched move source/derived footprints keep their parked state.
      const source = evidence.fileFinal.find((file) => file.path === MOVE_SOURCE_PATH);
      expect(source?.present).toBe(false);
    },
    180_000,
  );

  it(
    "move_note: a third-party file recreated at the move source is never overwritten",
    async () => {
      const profile = moveNoteCorpusProfile();
      const bytes = foreignMarkdown("move-source");
      const evidence = await runMutationCorpusRecoveryInterferenceScenario({
        profile,
        seed: "interference-move-source",
        reportDir: await reportDir("move-source"),
        recoveryParkPoint: "before_rollback",
        interference: { area: "public", path: MOVE_SOURCE_PATH, bytes },
      });
      assertInterferenceEvidence(evidence, {
        conflictPath: MOVE_SOURCE_PATH,
        conflictArea: "public",
        interferenceBytes: bytes,
        parkPoint: "before_rollback",
        beforeSha256: hashBytes(
          profile.files.find((file) => file.path === MOVE_SOURCE_PATH)!.originalBytes!,
        ),
        expectedAfterSha256: null,
      });
      expect(evidence.residualPaths).toContain(`file:${MOVE_SOURCE_PATH}`);
    },
    180_000,
  );

  it(
    "move_note: a third-party rewrite of a derived-reference source note is never overwritten",
    async () => {
      const profile = moveNoteCorpusProfile();
      const bytes = foreignMarkdown("derived");
      const evidence = await runMutationCorpusRecoveryInterferenceScenario({
        profile,
        seed: "interference-move-derived",
        reportDir: await reportDir("move-derived"),
        recoveryParkPoint: "before_rollback",
        interference: { area: "public", path: MOVE_DERIVED_A_PATH, bytes },
      });
      assertInterferenceEvidence(evidence, {
        conflictPath: MOVE_DERIVED_A_PATH,
        conflictArea: "public",
        interferenceBytes: bytes,
        parkPoint: "before_rollback",
        beforeSha256: hashBytes(
          profile.files.find((file) => file.path === MOVE_DERIVED_A_PATH)!.originalBytes!,
        ),
        expectedAfterSha256: hashBytes(
          profile.files.find((file) => file.path === MOVE_DERIVED_A_PATH)!.committedBytes!,
        ),
      });
      expect(evidence.residualPaths).toContain(`file:${MOVE_DERIVED_A_PATH}`);
      // The untouched sibling derived note keeps its parked (committed) bytes.
      const sibling = evidence.fileFinal.find((file) => file.path.endsWith("Derived-B.md"));
      expect(sibling?.bytesMatchCommitted).toBe(true);
    },
    180_000,
  );

  it(
    "copy_attachment: third-party bytes at the binary destination are never overwritten",
    async () => {
      const profile = copyAttachmentCorpusProfile();
      const bytes = foreignBinary();
      const evidence = await runMutationCorpusRecoveryInterferenceScenario({
        profile,
        seed: "interference-copy-attachment",
        reportDir: await reportDir("copy-attachment"),
        recoveryParkPoint: "before_rollback",
        interference: { area: "public", path: COPY_ATTACHMENT_DESTINATION_PATH, bytes },
      });
      assertInterferenceEvidence(evidence, {
        conflictPath: COPY_ATTACHMENT_DESTINATION_PATH,
        conflictArea: "public",
        interferenceBytes: bytes,
        parkPoint: "before_rollback",
        beforeSha256: null,
        expectedAfterSha256: hashBytes(
          profile.files.find((file) => file.path === COPY_ATTACHMENT_DESTINATION_PATH)!
            .committedBytes!,
        ),
      });
      expect(evidence.residualPaths).toContain(`file:${COPY_ATTACHMENT_DESTINATION_PATH}`);
      const final = evidence.fileFinal.find(
        (file) => file.path === COPY_ATTACHMENT_DESTINATION_PATH,
      );
      expect(final?.sha256).toBe(hashBytes(bytes));
      expect(final?.contentVersion).toBeNull();
    },
    180_000,
  );

  it(
    "move_attachment: a third-party binary recreated at the move source is never overwritten",
    async () => {
      const profile = moveAttachmentCorpusProfile();
      const bytes = foreignBinary();
      const evidence = await runMutationCorpusRecoveryInterferenceScenario({
        profile,
        seed: "interference-move-attachment",
        reportDir: await reportDir("move-attachment"),
        recoveryParkPoint: "before_rollback",
        interference: { area: "public", path: MOVE_ATTACHMENT_SOURCE_PATH, bytes },
      });
      assertInterferenceEvidence(evidence, {
        conflictPath: MOVE_ATTACHMENT_SOURCE_PATH,
        conflictArea: "public",
        interferenceBytes: bytes,
        parkPoint: "before_rollback",
        beforeSha256: hashBytes(
          profile.files.find((file) => file.path === MOVE_ATTACHMENT_SOURCE_PATH)!.originalBytes!,
        ),
        expectedAfterSha256: null,
      });
      expect(evidence.residualPaths).toContain(`file:${MOVE_ATTACHMENT_SOURCE_PATH}`);
    },
    180_000,
  );

  it(
    "trash_note: a third-party file recreated at the trashed public path is never overwritten and the private copy is preserved",
    async () => {
      const profile = trashNoteCorpusProfile();
      const bytes = foreignMarkdown("trash-public");
      const evidence = await runMutationCorpusRecoveryInterferenceScenario({
        profile,
        seed: "interference-trash-public",
        reportDir: await reportDir("trash-public"),
        recoveryParkPoint: "before_rollback",
        interference: { area: "public", path: TRASH_NOTE_PATH, bytes },
      });
      assertInterferenceEvidence(evidence, {
        conflictPath: TRASH_NOTE_PATH,
        conflictArea: "public",
        interferenceBytes: bytes,
        parkPoint: "before_rollback",
        beforeSha256: hashBytes(TRASH_NOTE_BYTES),
        expectedAfterSha256: null,
      });
      expect(evidence.residualPaths).toContain(`file:${TRASH_NOTE_PATH}`);
      // The Bridge-owned private trash copy is preserved (never destroyed by
      // the failed restore) and its path is never leaked.
      expect(evidence.hidden).not.toBeNull();
      expect(evidence.hidden!.trashCount).toBe(1);
      expect(evidence.hidden!.trashSha256s).toEqual([hashBytes(TRASH_NOTE_BYTES)]);
      expect(
        evidence.residualPaths.some((entry) => entry.startsWith("trash:")),
        "a private Managed-Trash path must never be surfaced",
      ).toBe(false);
    },
    180_000,
  );

  it(
    "trash_note: tampered private managed-trash bytes are never restored publicly and never destroyed",
    async () => {
      const profile = trashNoteCorpusProfile();
      const bytes = foreignMarkdown("trash-private");
      const evidence = await runMutationCorpusRecoveryInterferenceScenario({
        profile,
        seed: "interference-trash-private",
        reportDir: await reportDir("trash-private"),
        recoveryParkPoint: "before_rollback",
        interference: { area: "private_trash", bytes },
      });
      assertInterferenceEvidence(evidence, {
        conflictPath: TRASH_NOTE_PATH,
        conflictArea: "private_trash",
        interferenceBytes: bytes,
        parkPoint: "before_rollback",
        beforeSha256: hashBytes(TRASH_NOTE_BYTES),
        expectedAfterSha256: null,
      });
      // The tampered private copy is preserved byte-for-byte and never
      // published; the public footprint stays absent.
      expect(evidence.hidden).not.toBeNull();
      expect(evidence.hidden!.trashCount).toBe(1);
      expect(evidence.hidden!.trashSha256s).toEqual([hashBytes(bytes)]);
      const publicFinal = evidence.fileFinal.find((file) => file.path === TRASH_NOTE_PATH);
      expect(publicFinal?.present).toBe(false);
      expect(evidence.residualPaths).toEqual([]);
    },
    180_000,
  );

  it(
    "partial restoration never downgrades the unproven result: one footprint restored, one interfered",
    async () => {
      const profile = multiMarkdownCorpusProfile();
      const [first, second] = multiMarkdownFiles;
      const bytes = foreignMarkdown("partial");
      const evidence = await runMutationCorpusRecoveryInterferenceScenario({
        profile,
        seed: "interference-partial",
        reportDir: await reportDir("partial"),
        // Generation 2 restores the second file (reverse order) and parks;
        // the supervisor then interferes with the still-committed first file.
        recoveryParkPoint: "after_rollback_mutation:0",
        interference: { area: "public", path: first!.path, bytes },
      });
      assertInterferenceEvidence(evidence, {
        conflictPath: first!.path,
        conflictArea: "public",
        interferenceBytes: bytes,
        parkPoint: "after_rollback_mutation:0",
        beforeSha256: hashBytes(first!.originalBytes!),
        expectedAfterSha256: hashBytes(first!.committedBytes!),
      });
      // AC5: the safely restored footprint keeps its exact before bytes while
      // the interfered one keeps the third-party bytes; neither permits success
      // nor new writes.
      const untouched = evidence.fileFinal.find((file) => file.path === second!.path);
      expect(untouched?.bytesMatchOriginal).toBe(true);
      expect(untouched?.sha256).toBe(hashBytes(second!.originalBytes!));
      const interfered = evidence.fileFinal.find((file) => file.path === first!.path);
      expect(interfered?.sha256).toBe(hashBytes(bytes));
      expect(evidence.proofState).toBe("result_unproven");
      expect(evidence.sentinel.applied).toBe(false);
    },
    180_000,
  );
});

describe("already-restored acceptance (issue #194)", () => {
  function assertAlreadyRestored(
    evidence: CorpusScenarioEvidence,
    options: { readonly sentinelNote?: string } = {},
  ): void {
    void options;
    expect(evidence.failures, JSON.stringify(evidence, null, 2)).toEqual([]);
    expect(evidence.verdict).toBe("pass");
    expect(evidence.proofState).toBe("intent_not_applied");
    expect(evidence.gate.effectiveGate).toBeNull();
    expect(evidence.gate.recoveryState === "none" || evidence.gate.recoveryState === null).toBe(
      true,
    );
    // The sentinel write becomes admissible only after recovery reached a
    // trustworthy terminal outcome.
    expect(evidence.sentinel.submitted).toBe(true);
    expect(evidence.sentinel.applied).toBe(true);
    expect(evidence.residualPaths).toEqual([]);
    expect(evidence.hidden?.stagingCount ?? 0).toBe(0);
    expect(evidence.cleanup.success).toBe(true);
  }

  it(
    "edit_body: a rollback that completed before its durable ROLLED_BACK is accepted as already restored",
    async () => {
      const profile = replaceExactCorpusProfile();
      const evidence = await runMutationCorpusAlreadyRestoredScenario({
        profile,
        seed: "restored-edit-body",
        reportDir: await reportDir("restored-edit-body"),
        mode: "crash_before_rolled_back",
      });
      assertAlreadyRestored(evidence);
      const final = evidence.fileFinal.find((file) => file.path === EXACT_FIXTURE.path);
      expect(final?.bytesMatchOriginal).toBe(true);
      expect(final?.sha256).toBe(hashBytes(profile.files[0]!.originalBytes!));
    },
    180_000,
  );

  it(
    "create_note: a third party that removed the created note is accepted as already restored",
    async () => {
      const profile = createNoteCorpusProfile();
      const evidence = await runMutationCorpusAlreadyRestoredScenario({
        profile,
        seed: "restored-create-note",
        reportDir: await reportDir("restored-create-note"),
        mode: "supervisor_restored",
      });
      assertAlreadyRestored(evidence);
      const final = evidence.fileFinal.find((file) => file.path === CREATE_NOTE_PATH);
      expect(final?.present).toBe(false);
    },
    180_000,
  );

  it(
    "move_note: a rollback that completed before its durable ROLLED_BACK converges the whole closure",
    async () => {
      const profile = moveNoteCorpusProfile();
      const evidence = await runMutationCorpusAlreadyRestoredScenario({
        profile,
        seed: "restored-move-note",
        reportDir: await reportDir("restored-move-note"),
        mode: "crash_before_rolled_back",
      });
      assertAlreadyRestored(evidence);
      for (const file of profile.files) {
        const final = evidence.fileFinal.find((candidate) => candidate.path === file.path);
        if (file.originalBytes === null) {
          expect(final?.present, `${file.path} should stay absent`).toBe(false);
        } else {
          expect(final?.bytesMatchOriginal, `${file.path} must hold exact original bytes`).toBe(
            true,
          );
        }
      }
    },
    180_000,
  );

  it(
    "copy_attachment: a rollback that completed before its durable ROLLED_BACK is accepted",
    async () => {
      const profile = copyAttachmentCorpusProfile();
      const evidence = await runMutationCorpusAlreadyRestoredScenario({
        profile,
        seed: "restored-copy-attachment",
        reportDir: await reportDir("restored-copy-attachment"),
        mode: "crash_before_rolled_back",
      });
      assertAlreadyRestored(evidence);
    },
    180_000,
  );

  it(
    "trash_note: a third party that restored the public note is accepted and the private copy is discarded",
    async () => {
      const profile = trashNoteCorpusProfile();
      const evidence = await runMutationCorpusAlreadyRestoredScenario({
        profile,
        seed: "restored-trash-note",
        reportDir: await reportDir("restored-trash-note"),
        mode: "supervisor_restored",
      });
      assertAlreadyRestored(evidence);
      const final = evidence.fileFinal.find((file) => file.path === TRASH_NOTE_PATH);
      expect(final?.bytesMatchOriginal).toBe(true);
      // The staged/hidden residue is discarded: no private trash entry remains.
      expect(evidence.hidden).not.toBeNull();
      expect(evidence.hidden!.trashCount).toBe(0);
      expect(
        evidence.residualPaths.some((entry) => entry.startsWith("trash:")),
        "a private Managed-Trash path must never be surfaced",
      ).toBe(false);
    },
    180_000,
  );
});

// ---------------------------------------------------------------------------
// In-process admission proof: the recovery_in_progress operational gate
// rejects a new Change Set submission without binding its key, and the same
// key becomes admissible once recovery has reached a trustworthy terminal
// outcome (change-set.ts admission gate; spec §7.5).
// ---------------------------------------------------------------------------

class MemoryStore implements ChangeSetRegistryStore {
  state: ChangeSetRegistryState | undefined;

  async load(): Promise<unknown> {
    return structuredClone(this.state);
  }

  async save(state: ChangeSetRegistryState): Promise<void> {
    this.state = structuredClone(state);
  }
}

class DirectoryAdapter implements ChangeSetExecutionAdapter {
  readonly directories = new Set<string>();
  readonly identities = new Map<string, string>();
  readonly prepared = new Map<string, string>();
  frame: RecoveryJournalFrame | null = null;
  #nextIdentity = 0;

  async loadRecoveryFrame(): Promise<RecoveryJournalFrame | null> {
    return structuredClone(this.frame);
  }

  async persistRecoveryFrame(frame: RecoveryJournalFrame): Promise<void> {
    this.frame = structuredClone(frame);
  }

  async pathKind(path: string): Promise<"directory" | "file" | null> {
    return this.directories.has(path) ? "directory" : null;
  }

  async directoryIdentity(path: string): Promise<string | null> {
    return this.identities.get(path) ?? null;
  }

  async prepareDirectory(stageId: string): Promise<string> {
    this.#nextIdentity += 1;
    const identity = `directory-${this.#nextIdentity}`;
    this.prepared.set(stageId, identity);
    return identity;
  }

  async publishDirectory(stageId: string, path: string): Promise<void> {
    const identity = this.prepared.get(stageId);
    if (identity === undefined) throw new Error("prepared directory is missing");
    this.prepared.delete(stageId);
    this.directories.add(path);
    this.identities.set(path, identity);
  }

  async discardPreparedDirectory(stageId: string): Promise<void> {
    this.prepared.delete(stageId);
  }

  async removeDirectory(path: string): Promise<void> {
    this.directories.delete(path);
    this.identities.delete(path);
  }

  async publishSearchSnapshot(): Promise<void> {}
}

describe("recovery_in_progress admission gate", () => {
  it("rejects a new Change Set while recovery is in progress and admits the same key after a trustworthy terminal", async () => {
    const store = new MemoryStore();
    const adapter = new DirectoryAdapter();
    let nextId = 0;
    const service = await ChangeSetService.open({
      store,
      dataSource: {
        readBinary: async () => null,
        pathKind: async (path) => (adapter.directories.has(path) ? "directory" : null),
        isContained: async () => true,
      },
      execution: adapter,
      createChangeSetId: () => `change-set-${++nextId}`,
    });

    const input = {
      submissionKey: "recovery-gate-key",
      operations: [
        {
          operationId: "mkdir-1",
          kind: "create_directory",
          path: "Recovery/Gated",
          ifExists: "reject",
        },
      ],
    } as const;

    const blocked = await service.submit(input, {
      vault: { writeGate: "open", writeState: "writable" },
      effectiveGate: { code: "recovery_in_progress" },
    });
    expect(blocked).toEqual({
      outcome: "operationally_blocked",
      gate: { code: "recovery_in_progress" },
    });
    // The gate rejects before binding: no Change Set or proof state exists.
    expect(store.state?.entries ?? []).toHaveLength(0);
    expect(adapter.directories.size).toBe(0);

    // Once recovery reaches a trustworthy terminal outcome the unchanged key
    // may retry and apply.
    const admitted = await service.submit(input, {
      vault: { writeGate: "open", writeState: "writable" },
      effectiveGate: null,
    });
    expect(admitted.outcome).toBe("registered");
    expect(admitted.changeSet?.state).toBe("intent_applied");
    expect(adapter.directories.has("Recovery/Gated")).toBe(true);
  });
});
