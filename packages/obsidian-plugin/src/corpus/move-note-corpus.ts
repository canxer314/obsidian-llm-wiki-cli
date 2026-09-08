/**
 * Note-move + derived-rewrite corpus profile (issue #189).
 *
 * A single `move` operation moves `Alpha.md` to `Beta.md` while two pre-existing
 * derived notes (`Derived-A.md`, `Derived-B.md`) each hold a wikilink that
 * resolves to the moved note. The Change Set therefore rewrites both derived
 * notes in one causally ordered closure (projected by `projectMove` from the
 * Search Snapshot reference graph) before the rename becomes visible. A crash
 * between any two of those mutations must leave either the complete original
 * closure (source path present, destination absent, every derived note at its
 * exact original bytes and Content Version) or the complete committed closure
 * (destination and every intended rewrite present), never a mixed closure.
 *
 * The fixtures model the two halves of a move the same way the byte fixtures
 * model every other Change Set: the source note declares original bytes and a
 * committed "absent" state (the move removes the path), the destination
 * declares original "absent" and the exact moved bytes, and each derived note
 * declares original bytes (pointing at `Alpha`) and committed bytes (pointing
 * at `Beta`). The move destination reuses the source's parent directory, so no
 * directory mutation is created and the deterministic mutation seam is the two
 * derived file publishes (`after_file_mutation:0/1`) followed by the rename
 * itself (`after_mutation:0`).
 */

import { contentVersion } from "../content-version.js";
import type {
  MutationCorpusBoundary,
  MutationCorpusBoundaryFileState,
  MutationCorpusCrashPoint,
  MutationCorpusFileFixture,
  MutationCorpusProfile,
  MutationCorpusProofState,
} from "./crash-corpus-runner.js";

const textEncoder = new TextEncoder();

export const MOVE_NOTE_LABEL = "move-note";

export const MOVE_SOURCE_PATH = "Corpus/Move/Alpha.md";
export const MOVE_DESTINATION_PATH = "Corpus/Move/Beta.md";
export const MOVE_DERIVED_A_PATH = "Corpus/Move/Derived-A.md";
export const MOVE_DERIVED_B_PATH = "Corpus/Move/Derived-B.md";

export const MOVE_SOURCE_TEXT =
  "# Alpha\r\n" +
  "\r\n" +
  "Source note body 你好 🚀.\r\n" +
  "Second body line.\r\n";

const MOVE_DERIVED_A_ORIGINAL_TEXT =
  "# Derived A\n" +
  "\n" +
  "This note records a link to the moved note: [[Alpha]].\n" +
  "\n" +
  "LF line endings and CJK 你好 here.\n";

const MOVE_DERIVED_A_COMMITTED_TEXT =
  MOVE_DERIVED_A_ORIGINAL_TEXT.replace("[[Alpha]]", "[[Beta]]");

const MOVE_DERIVED_B_ORIGINAL_TEXT =
  "# Derived B\r\n" +
  "\r\n" +
  "See also [[Alpha]].\r\n" +
  "\r\n" +
  "CRLF line endings plus astral 🌍 and CJK 再见.\r\n";

const MOVE_DERIVED_B_COMMITTED_TEXT =
  MOVE_DERIVED_B_ORIGINAL_TEXT.replace("[[Alpha]]", "[[Beta]]");

export const MOVE_SOURCE_BYTES: Uint8Array = textEncoder.encode(MOVE_SOURCE_TEXT);

export interface MoveDerivedFixture {
  readonly path: string;
  readonly originalBytes: Uint8Array;
  readonly committedBytes: Uint8Array;
}

/** Derived closure notes in publish (path) order: `after_file_mutation:0/1`. */
export const MOVE_DERIVED_FIXTURES: readonly MoveDerivedFixture[] = [
  {
    path: MOVE_DERIVED_A_PATH,
    originalBytes: textEncoder.encode(MOVE_DERIVED_A_ORIGINAL_TEXT),
    committedBytes: textEncoder.encode(MOVE_DERIVED_A_COMMITTED_TEXT),
  },
  {
    path: MOVE_DERIVED_B_PATH,
    originalBytes: textEncoder.encode(MOVE_DERIVED_B_ORIGINAL_TEXT),
    committedBytes: textEncoder.encode(MOVE_DERIVED_B_COMMITTED_TEXT),
  },
];

if (MOVE_DERIVED_A_ORIGINAL_TEXT.split("[[Alpha]]").length !== 2) {
  throw new Error("Move corpus Derived-A fixture must reference the source exactly once");
}
if (MOVE_DERIVED_B_ORIGINAL_TEXT.split("[[Alpha]]").length !== 2) {
  throw new Error("Move corpus Derived-B fixture must reference the source exactly once");
}

const MOVE_SOURCE_FIXTURE: MutationCorpusFileFixture = {
  path: MOVE_SOURCE_PATH,
  originalBytes: MOVE_SOURCE_BYTES,
  committedBytes: null, // the move removes the source path
};

const MOVE_DESTINATION_FIXTURE: MutationCorpusFileFixture = {
  path: MOVE_DESTINATION_PATH,
  originalBytes: null, // absent before the move
  committedBytes: MOVE_SOURCE_BYTES, // the rename leaves the exact moved bytes
};

export const moveNoteFiles: readonly MutationCorpusFileFixture[] = [
  MOVE_SOURCE_FIXTURE,
  MOVE_DESTINATION_FIXTURE,
  ...MOVE_DERIVED_FIXTURES.map(({ path, originalBytes, committedBytes }) => ({
    path,
    originalBytes,
    committedBytes,
  })),
];

export const MOVE_DERIVED_COUNT = MOVE_DERIVED_FIXTURES.length;

export const MOVE_ROLLBACK_LEAD_IN = "after_snapshot";

/**
 * Full crash-point list for a single note move with two derived rewrites:
 * every apply boundary the acceptance criteria names (before/after durable
 * PREPARED, after each individual mutation, after raw verification, during the
 * cache/graph wait and the success-barrier quiet window, before and after
 * durable COMMITTED) plus the rollback boundaries that prove whole-closure
 * restoration (before/after ROLLED_BACK and every partial rollback mutation).
 */
export function moveNoteCrashPoints(): readonly MutationCorpusCrashPoint[] {
  return [
    { point: "before_prepared", phase: "apply" },
    { point: "after_prepared", phase: "apply" },
    { point: "after_file_mutation:0", phase: "apply" },
    { point: "after_file_mutation:1", phase: "apply" },
    { point: "after_mutation:0", phase: "apply" },
    { point: "after_raw_verification", phase: "apply" },
    { point: "during_semantic_evidence", phase: "apply" },
    { point: "during_success_barrier", phase: "apply" },
    { point: "after_snapshot", phase: "apply" },
    { point: "after_committed", phase: "apply" },
    { point: "before_rollback", phase: "rollback" },
    { point: "after_rollback_mutation:0", phase: "rollback" },
    { point: "after_rollback_mutation:1", phase: "rollback" },
    { point: "after_rollback_mutation:2", phase: "rollback" },
    { point: "after_rollback_verification", phase: "rollback" },
    { point: "after_rollback_evidence", phase: "rollback" },
    { point: "before_rolled_back", phase: "rollback" },
    { point: "after_rolled_back", phase: "rollback" },
  ];
}

export function crashPointName(crashPoint: MutationCorpusCrashPoint): string {
  return crashPoint.point.replace(/[^A-Za-z0-9_-]/gu, "_");
}

function derivedPublishIndex(path: string): number {
  return MOVE_DERIVED_FIXTURES.findIndex(({ path: candidate }) => candidate === path);
}

function moveJournalPhase(point: string): MutationCorpusBoundary["journalPhase"] {
  if (point === "before_prepared") return null;
  if (point === "after_committed") return "COMMITTED";
  if (point === "after_rolled_back") return "ROLLED_BACK";
  return "PREPARED";
}

export function moveProofState(point: string): MutationCorpusProofState {
  if (point === "before_prepared" || point === "after_committed") return "intent_applied";
  return "intent_not_applied";
}

/**
 * Boundary byte state of a single public path while the child parks at a crash
 * point. Derived notes publish in path order during apply
 * (`after_file_mutation:0/1`) and restore in reverse path order during
 * rollback after the move-back action (`after_rollback_mutation:1/2`).
 */
export function moveBoundaryFileStateAt(
  point: string,
  path: string,
): MutationCorpusBoundaryFileState {
  const isSource = path === MOVE_SOURCE_PATH;
  const isDestination = path === MOVE_DESTINATION_PATH;
  const derivedIndex = derivedPublishIndex(path);
  const isDerived = derivedIndex >= 0;
  if (!isSource && !isDestination && !isDerived) {
    throw new Error(`Move corpus has no boundary model for ${path}`);
  }
  if (point.startsWith("after_file_mutation:")) {
    const published = Number(point.slice("after_file_mutation:".length));
    if (isSource) return "original";
    if (isDestination) return "absent";
    return derivedIndex <= published ? "committed" : "original";
  }
  if (point.startsWith("after_rollback_mutation:")) {
    const restoredActions = Number(point.slice("after_rollback_mutation:".length));
    if (isSource) return "original";
    if (isDestination) return "absent";
    // Action 0 moves the note back; each derived file restores in reverse
    // publish order at action 1 + (count - 1 - publishIndex).
    const restoreAction = 1 + (MOVE_DERIVED_COUNT - 1 - derivedIndex);
    return restoredActions >= restoreAction ? "original" : "committed";
  }
  switch (point) {
    case "before_prepared":
    case "after_prepared":
      return isSource ? "original" : isDestination ? "absent" : "original";
    case "after_mutation:0":
    case "after_raw_verification":
    case "during_semantic_evidence":
    case "during_success_barrier":
    case "after_snapshot":
    case "after_committed":
      return isSource ? "absent" : isDestination ? "committed" : "committed";
    case "before_rollback":
      return isSource ? "absent" : isDestination ? "committed" : "committed";
    case "after_rollback_verification":
    case "after_rollback_evidence":
    case "before_rolled_back":
    case "after_rolled_back":
      return isSource ? "original" : isDestination ? "absent" : "original";
    default:
      throw new Error(`No move-crash boundary model for ${point}`);
  }
}

export function moveBoundaryFor(point: string): MutationCorpusBoundary {
  return {
    journalPhase: moveJournalPhase(point),
    files: moveNoteFiles.map(({ path }) => ({
      path,
      state: moveBoundaryFileStateAt(point, path),
    })),
  };
}

export function seedForMoveNote(crashPoint: MutationCorpusCrashPoint): string {
  return `${MOVE_NOTE_LABEL}-${crashPointName(crashPoint)}`;
}

export function moveNoteCorpusProfile(): MutationCorpusProfile {
  return {
    kind: "move_note",
    label: MOVE_NOTE_LABEL,
    files: moveNoteFiles,
    primaryPath: MOVE_SOURCE_PATH,
    submissionKey: (seed) => `submission-${seed}`,
    buildSubmitInput: (seed) => ({
      submissionKey: `submission-${seed}`,
      operations: [
        {
          operationId: `move-${seed}`,
          kind: "move",
          sourcePath: MOVE_SOURCE_PATH,
          destinationPath: MOVE_DESTINATION_PATH,
          targetVersion: contentVersion(MOVE_SOURCE_BYTES),
          linkEffect: "update_resolved_references",
        },
      ],
    }),
    crashPoints: moveNoteCrashPoints(),
    rollbackLeadInPoint: MOVE_ROLLBACK_LEAD_IN,
    expectedBoundary: (crashPoint) => moveBoundaryFor(crashPoint.point),
    expectedProofState: (crashPoint) => moveProofState(crashPoint.point),
    timeoutMs: 90_000,
  };
}
