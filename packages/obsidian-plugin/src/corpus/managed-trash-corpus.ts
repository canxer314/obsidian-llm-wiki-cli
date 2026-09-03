/**
 * Managed-Trash process-crash corpus profiles (issue #191).
 *
 * These profiles move a public Markdown note and/or a binary attachment into
 * Managed Trash. A committed Change Set leaves the public path absent with the
 * exact original bytes retained only under the Bridge-owned private trash area;
 * every earlier termination must restore the exact public bytes and eliminate
 * all private trash residue after a restart.
 *
 * The managed-trash Change Sets never emit generic Vault events (trash and
 * restore are hidden by design, spec A-38), so the corpus proves hidden-trash
 * and restore success through raw public-path state plus the targeted
 * cache/reference probes the headless owning process injects. Each profile also
 * declares the redacted private-trash state its terminal proof state may hold
 * (counts + SHA-256 only, never a trash path/identifier), which the runner
 * compares and reports so committed runs retain exactly the Bridge-owned trash
 * entries they wrote and rolled-back runs prove no leakage.
 *
 * Two host-level crash seams are covered for the single-operation profiles:
 *   `after_trash_hidden_copy`    — the private hard-link/copy is durable, the
 *                                  public path is not yet removed (apply).
 *   `after_trash_restore_public` — the public bytes are restored, the private
 *                                  trash entry is not yet discarded (rollback).
 * Recovery from either seam must neither lose bytes nor duplicate public content
 * nor silently retain private trash residue (issue #191 AC5).
 */

import { createHash } from "node:crypto";

import { contentVersion } from "../content-version.js";
import type {
  MutationCorpusBoundary,
  MutationCorpusBoundaryFileState,
  MutationCorpusCrashPoint,
  MutationCorpusFileFixture,
  MutationCorpusHiddenStateExpectation,
  MutationCorpusProfile,
  MutationCorpusProofState,
} from "./crash-corpus-runner.js";

const textEncoder = new TextEncoder();

export const TRASH_NOTE_LABEL = "trash-note";
export const TRASH_ATTACHMENT_LABEL = "trash-attachment";
export const TRASH_MULTI_LABEL = "trash-note-attachment";

export const TRASH_NOTE_PATH = "Corpus/Trash/Note.md";
export const TRASH_ATTACHMENT_PATH = "Corpus/Trash/Binary.bin";
export const TRASH_MULTI_NOTE_PATH = "Corpus/Trash/Multi-Note.md";
export const TRASH_MULTI_ATTACHMENT_PATH = "Corpus/Trash/Multi-Binary.bin";

const TRASH_NOTE_TEXT =
  "# Managed Trash Note\r\n" +
  "\r\n" +
  "This note is subject to managed trash 你好 🚀.\r\n" +
  "A second body line keeps the fixture distinct.\r\n";

const TRASH_MULTI_NOTE_TEXT =
  "# Multi Trash Note\n" +
  "\n" +
  "A second note trashed in the same Change Set 再见.\n";

/** Binary bytes that are not valid UTF-8, so no Markdown content version applies. */
export const TRASH_ATTACHMENT_BYTES = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0x13, 0x80, 0x42, 0x00, 0xfe,
]);
export const TRASH_MULTI_ATTACHMENT_BYTES = Uint8Array.from([
  0x1f, 0x8b, 0x08, 0x00, 0xff, 0x00, 0xc0, 0xde, 0x0a, 0x00, 0x80, 0x11,
]);

export const TRASH_NOTE_BYTES: Uint8Array = textEncoder.encode(TRASH_NOTE_TEXT);
export const TRASH_MULTI_NOTE_BYTES: Uint8Array = textEncoder.encode(TRASH_MULTI_NOTE_TEXT);

type TrashEvidenceKey =
  | { readonly targetVersion: string }
  | { readonly expectedSha256: string };

interface ManagedTrashProfileDefinition {
  readonly kind: string;
  readonly label: string;
  readonly primaryPath: string;
  /** Public files in trash-operation order. */
  readonly fixtures: readonly MutationCorpusFileFixture[];
  /** Per-fixture evidence key for the `trash` operation (Markdown or attachment). */
  readonly evidence: readonly TrashEvidenceKey[];
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function digestOf(bytes: Uint8Array): string {
  return `sha256:${sha256Hex(bytes)}`;
}

function evidenceKey(fixture: MutationCorpusFileFixture): TrashEvidenceKey {
  if (fixture.kind === "attachment") {
    if (fixture.originalBytes === null) throw new Error("Managed-trash attachment needs original bytes");
    return { expectedSha256: sha256Hex(fixture.originalBytes) };
  }
  if (fixture.originalBytes === null) throw new Error("Managed-trash note needs original bytes");
  return { targetVersion: contentVersion(fixture.originalBytes) };
}

function crashPointName(crashPoint: MutationCorpusCrashPoint): string {
  return crashPoint.point.replace(/[^A-Za-z0-9_-]/gu, "_");
}

/** Full crash-point list for a single-operation Managed-Trash Change Set. */
export function singleTrashCrashPoints(): readonly MutationCorpusCrashPoint[] {
  return [
    { point: "before_prepared", phase: "apply" },
    { point: "after_prepared", phase: "apply" },
    { point: "after_trash_hidden_copy", phase: "apply" },
    { point: "after_mutation:0", phase: "apply" },
    { point: "after_raw_verification", phase: "apply" },
    { point: "during_semantic_evidence", phase: "apply" },
    { point: "after_semantic_evidence", phase: "apply" },
    { point: "after_snapshot", phase: "apply" },
    { point: "after_committed", phase: "apply" },
    { point: "before_rollback", phase: "rollback" },
    { point: "after_trash_restore_public", phase: "rollback" },
    { point: "after_rollback_mutation:0", phase: "rollback" },
    { point: "after_rollback_verification", phase: "rollback" },
    { point: "after_rollback_evidence", phase: "rollback" },
    { point: "before_rolled_back", phase: "rollback" },
    { point: "after_rolled_back", phase: "rollback" },
  ];
}

/**
 * Crash-point list for a two-operation (note + attachment) Managed-Trash Change
 * Set: every partial-mutation boundary, the committed seam, and the reverse-
 * order rollback boundaries that prove whole-Change-Set restoration.
 */
export function multiTrashCrashPoints(): readonly MutationCorpusCrashPoint[] {
  return [
    { point: "before_prepared", phase: "apply" },
    { point: "after_prepared", phase: "apply" },
    { point: "after_mutation:0", phase: "apply" },
    { point: "after_mutation:1", phase: "apply" },
    { point: "after_raw_verification", phase: "apply" },
    { point: "during_semantic_evidence", phase: "apply" },
    { point: "after_semantic_evidence", phase: "apply" },
    { point: "after_snapshot", phase: "apply" },
    { point: "after_committed", phase: "apply" },
    { point: "before_rollback", phase: "rollback" },
    { point: "after_rollback_mutation:0", phase: "rollback" },
    { point: "after_rollback_mutation:1", phase: "rollback" },
    { point: "after_rollback_verification", phase: "rollback" },
    { point: "after_rollback_evidence", phase: "rollback" },
    { point: "before_rolled_back", phase: "rollback" },
    { point: "after_rolled_back", phase: "rollback" },
  ];
}

export function trashJournalPhase(point: string): MutationCorpusBoundary["journalPhase"] {
  if (point === "before_prepared") return null;
  if (point === "after_committed") return "COMMITTED";
  if (point === "after_rolled_back") return "ROLLED_BACK";
  return "PREPARED";
}

export function trashProofState(point: string): MutationCorpusProofState {
  if (point === "before_prepared" || point === "after_committed") return "intent_applied";
  return "intent_not_applied";
}

function appliedMutationCount(point: string): number | null {
  if (!point.startsWith("after_mutation:")) return null;
  return Number(point.slice("after_mutation:".length)) + 1;
}

function restoredActionCount(point: string): number | null {
  if (!point.startsWith("after_rollback_mutation:")) return null;
  return Number(point.slice("after_rollback_mutation:".length)) + 1;
}

/**
 * Boundary public state of fixture `index` while parked at a crash point.
 * Public paths disappear in operation order during apply and return in reverse
 * operation order during rollback.
 */
export function trashBoundaryFileStateAt(
  point: string,
  index: number,
  count: number,
): MutationCorpusBoundaryFileState {
  if (point === "before_prepared" || point === "after_prepared") return "original";
  if (point === "after_trash_hidden_copy") return "original";
  const applied = appliedMutationCount(point);
  if (applied !== null) return index < applied ? "absent" : "original";
  if (point === "after_trash_restore_public") return "original";
  const restored = restoredActionCount(point);
  if (restored !== null) {
    // Rollback restores mutations in reverse operation order; after `restored`
    // actions the highest-index `restored` fixtures are back to original bytes.
    return index >= count - restored ? "original" : "absent";
  }
  switch (point) {
    case "after_raw_verification":
    case "during_semantic_evidence":
    case "after_semantic_evidence":
    case "after_snapshot":
    case "before_rollback":
    case "after_committed":
      return "absent";
    case "after_rollback_verification":
    case "after_rollback_evidence":
    case "before_rolled_back":
    case "after_rolled_back":
      return "original";
    default:
      throw new Error(`No Managed-Trash boundary model for ${point}`);
  }
}

function emptyHidden(): MutationCorpusHiddenStateExpectation {
  return { trashCount: 0, trashSha256s: [], stagingCount: 0, stagingSha256s: [] };
}

/**
 * Expected redacted private-trash state while parked at a crash point. The
 * staging area never holds files for a Managed-Trash Change Set, so every
 * boundary expects an empty staging area.
 */
function hiddenStateAt(
  point: string,
  digests: readonly string[],
): MutationCorpusHiddenStateExpectation {
  const total = digests.length;
  const retained = (indices: readonly number[]): MutationCorpusHiddenStateExpectation => ({
    trashCount: indices.length,
    trashSha256s: indices.map((index) => digests[index]!).sort(),
    stagingCount: 0,
    stagingSha256s: [],
  });
  if (point === "before_prepared" || point === "after_prepared") return emptyHidden();
  if (point === "after_trash_hidden_copy") {
    // The first mutation's private copy is durable; the public path is intact.
    return retained([0]);
  }
  const applied = appliedMutationCount(point);
  if (applied !== null) {
    const indices = Array.from({ length: Math.min(applied, total) }, (_, index) => index);
    return retained(indices);
  }
  if (point === "after_trash_restore_public") {
    // The rollback seam leaves every private entry in place (public restored).
    return retained(Array.from({ length: total }, (_, index) => index));
  }
  const restored = restoredActionCount(point);
  if (restored !== null) {
    // Entries whose public paths have been restored were removed; the remaining
    // trash entries belong to the not-yet-restored lowest indexes.
    const remaining = Math.max(0, total - restored);
    const indices = Array.from({ length: remaining }, (_, index) => index);
    return retained(indices);
  }
  switch (point) {
    case "after_raw_verification":
    case "during_semantic_evidence":
    case "after_semantic_evidence":
    case "after_snapshot":
    case "before_rollback":
    case "after_committed":
      return retained(Array.from({ length: total }, (_, index) => index));
    case "after_rollback_verification":
    case "after_rollback_evidence":
    case "before_rolled_back":
    case "after_rolled_back":
      return emptyHidden();
    default:
      throw new Error(`No Managed-Trash hidden boundary model for ${point}`);
  }
}

function boundaryFor(
  definition: ManagedTrashProfileDefinition,
  point: string,
): MutationCorpusBoundary {
  const digests = definition.fixtures.map(({ originalBytes }) =>
    originalBytes === null
      ? ""
      : digestOf(originalBytes),
  );
  return {
    journalPhase: trashJournalPhase(point),
    files: definition.fixtures.map(({ path }, index) => ({
      path,
      state: trashBoundaryFileStateAt(point, index, definition.fixtures.length),
    })),
    hidden: hiddenStateAt(point, digests),
  };
}

function managedTrashProfile(
  definition: ManagedTrashProfileDefinition,
  crashPoints: readonly MutationCorpusCrashPoint[],
): MutationCorpusProfile {
  const digests = definition.fixtures.map(({ originalBytes }) =>
    originalBytes === null ? "" : digestOf(originalBytes),
  );
  return {
    kind: definition.kind,
    label: definition.label,
    files: definition.fixtures,
    primaryPath: definition.primaryPath,
    submissionKey: (seed) => `submission-${seed}`,
    buildSubmitInput: (seed) => ({
      submissionKey: `submission-${seed}`,
      operations: definition.fixtures.map((fixture, index) => {
        const operationIndex = index;
        const evidence = definition.evidence[index]!;
        return {
          operationId: `${definition.label}-${operationIndex}-${seed}`,
          kind: "trash",
          path: fixture.path,
          ...evidence,
        };
      }),
    }),
    crashPoints,
    rollbackLeadInPoint: "after_snapshot",
    expectedBoundary: (crashPoint) => boundaryFor(definition, crashPoint.point),
    expectedProofState: (crashPoint) => trashProofState(crashPoint.point),
    expectedHiddenState: (proofState): MutationCorpusHiddenStateExpectation =>
      proofState === "intent_applied"
        ? {
            trashCount: digests.length,
            trashSha256s: [...digests].sort(),
            stagingCount: 0,
            stagingSha256s: [],
          }
        : emptyHidden(),
    timeoutMs: 90_000,
  };
}

const noteTrashDefinition: ManagedTrashProfileDefinition = {
  kind: "trash_note",
  label: TRASH_NOTE_LABEL,
  primaryPath: TRASH_NOTE_PATH,
  fixtures: [
    {
      path: TRASH_NOTE_PATH,
      originalBytes: TRASH_NOTE_BYTES,
      committedBytes: null, // the public note disappears into Managed Trash
    },
  ],
  evidence: [evidenceKey({ path: TRASH_NOTE_PATH, originalBytes: TRASH_NOTE_BYTES, committedBytes: null })],
};

const attachmentTrashDefinition: ManagedTrashProfileDefinition = {
  kind: "trash_attachment",
  label: TRASH_ATTACHMENT_LABEL,
  primaryPath: TRASH_ATTACHMENT_PATH,
  fixtures: [
    {
      path: TRASH_ATTACHMENT_PATH,
      kind: "attachment",
      originalBytes: TRASH_ATTACHMENT_BYTES,
      committedBytes: null,
    },
  ],
  evidence: [
    evidenceKey({
      path: TRASH_ATTACHMENT_PATH,
      kind: "attachment",
      originalBytes: TRASH_ATTACHMENT_BYTES,
      committedBytes: null,
    }),
  ],
};

const multiTrashDefinition: ManagedTrashProfileDefinition = {
  kind: "trash_note_attachment",
  label: TRASH_MULTI_LABEL,
  primaryPath: TRASH_MULTI_NOTE_PATH,
  fixtures: [
    {
      path: TRASH_MULTI_NOTE_PATH,
      originalBytes: TRASH_MULTI_NOTE_BYTES,
      committedBytes: null,
    },
    {
      path: TRASH_MULTI_ATTACHMENT_PATH,
      kind: "attachment",
      originalBytes: TRASH_MULTI_ATTACHMENT_BYTES,
      committedBytes: null,
    },
  ],
  evidence: [
    evidenceKey({
      path: TRASH_MULTI_NOTE_PATH,
      originalBytes: TRASH_MULTI_NOTE_BYTES,
      committedBytes: null,
    }),
    evidenceKey({
      path: TRASH_MULTI_ATTACHMENT_PATH,
      kind: "attachment",
      originalBytes: TRASH_MULTI_ATTACHMENT_BYTES,
      committedBytes: null,
    }),
  ],
};

export function seedForTrashNote(crashPoint: MutationCorpusCrashPoint): string {
  return `${TRASH_NOTE_LABEL}-${crashPointName(crashPoint)}`;
}

export function seedForTrashAttachment(crashPoint: MutationCorpusCrashPoint): string {
  return `${TRASH_ATTACHMENT_LABEL}-${crashPointName(crashPoint)}`;
}

export function seedForMultiTrash(crashPoint: MutationCorpusCrashPoint): string {
  return `${TRASH_MULTI_LABEL}-${crashPointName(crashPoint)}`;
}

export function trashNoteCorpusProfile(): MutationCorpusProfile {
  return managedTrashProfile(noteTrashDefinition, singleTrashCrashPoints());
}

export function trashAttachmentCorpusProfile(): MutationCorpusProfile {
  return managedTrashProfile(attachmentTrashDefinition, singleTrashCrashPoints());
}

export function multiTrashCorpusProfile(): MutationCorpusProfile {
  return managedTrashProfile(multiTrashDefinition, multiTrashCrashPoints());
}
