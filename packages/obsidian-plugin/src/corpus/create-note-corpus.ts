/**
 * `create_note` mutation corpus profile (issue #187).
 *
 * The note is created at a nested Vault path so a single Change Set exercises
 * every filesystem-mutation seam of the durable executor: two derived parent
 * directories (`after_mutation:0` / `after_mutation:1`) and the staged
 * Markdown file publish (`after_file_mutation:0`), followed by raw
 * verification, the successor-snapshot success barrier, and the durable
 * `COMMITTED` write. The fixture declares no original bytes (the Change Set
 * creates the file) and the committed bytes it must leave behind.
 */

import type {
  MutationCorpusBoundary,
  MutationCorpusCrashPoint,
  MutationCorpusFileFixture,
  MutationCorpusProfile,
  MutationCorpusProofState,
} from "./crash-corpus-runner.js";

const textEncoder = new TextEncoder();

export const CREATE_NOTE_LABEL = "create-note";
export const CREATE_NOTE_PATH = "Corpus/Notes/Alpha.md";
export const CREATE_NOTE_CONTENT = "# Corpus Alpha\n\n你好，世界 🚀\ncreated by the crash corpus\n";
export const CREATE_NOTE_BYTES = textEncoder.encode(CREATE_NOTE_CONTENT);

export const createNoteCrashPoints: readonly MutationCorpusCrashPoint[] = [
  { point: "before_prepared", phase: "apply" },
  { point: "after_prepared", phase: "apply" },
  { point: "after_mutation:0", phase: "apply" },
  { point: "after_mutation:1", phase: "apply" },
  { point: "after_file_mutation:0", phase: "apply" },
  { point: "after_raw_verification", phase: "apply" },
  { point: "during_success_barrier", phase: "apply" },
  { point: "after_snapshot", phase: "apply" },
  { point: "after_committed", phase: "apply" },
  { point: "before_rollback", phase: "rollback" },
  { point: "after_rollback_mutation:0", phase: "rollback" },
  { point: "after_rollback_verification", phase: "rollback" },
  { point: "after_rollback_evidence", phase: "rollback" },
  { point: "before_rolled_back", phase: "rollback" },
  { point: "after_rolled_back", phase: "rollback" },
];

export const CREATE_NOTE_ROLLBACK_LEAD_IN = "after_snapshot";

const createNoteFixture: MutationCorpusFileFixture = {
  path: CREATE_NOTE_PATH,
  originalBytes: null,
  committedBytes: CREATE_NOTE_BYTES,
};

function crashPointName(crashPoint: MutationCorpusCrashPoint): string {
  return crashPoint.point.replace(/[^A-Za-z0-9_-]/gu, "_");
}

function proofStateFor(crashPoint: MutationCorpusCrashPoint): MutationCorpusProofState {
  if (crashPoint.point === "before_prepared" || crashPoint.point === "after_committed") {
    return "intent_applied";
  }
  return "intent_not_applied";
}

function boundaryFor(crashPoint: MutationCorpusCrashPoint): MutationCorpusBoundary {
  // The boundary is the on-disk state observed while the real process is
  // parked at the crash point (before the supervisor terminates it), not the
  // post-recovery terminal state.
  const fileState =
    crashPoint.point === "before_prepared" ||
    crashPoint.point === "after_prepared" ||
    crashPoint.point === "after_mutation:0" ||
    crashPoint.point === "after_mutation:1" ||
    crashPoint.point === "after_rollback_mutation:0" ||
    crashPoint.point === "after_rollback_verification" ||
    crashPoint.point === "after_rollback_evidence" ||
    crashPoint.point === "before_rolled_back" ||
    crashPoint.point === "after_rolled_back"
      ? "absent"
      : "committed";
  switch (crashPoint.point) {
    case "before_prepared":
      // No durable frame yet and no filesystem mutation has happened.
      return { journalPhase: null, files: [{ path: CREATE_NOTE_PATH, state: "absent" }] };
    case "after_committed":
      return { journalPhase: "COMMITTED", files: [{ path: CREATE_NOTE_PATH, state: fileState }] };
    case "after_rolled_back":
      return { journalPhase: "ROLLED_BACK", files: [{ path: CREATE_NOTE_PATH, state: "absent" }] };
    case "before_rollback":
      // Rollback has not started yet; the lead-in (after_snapshot) fully
      // applied the note and its parent directories.
      return { journalPhase: "PREPARED", files: [{ path: CREATE_NOTE_PATH, state: "committed" }] };
    default:
      return { journalPhase: "PREPARED", files: [{ path: CREATE_NOTE_PATH, state: fileState }] };
  }
}

export function seedForCreateNote(crashPoint: MutationCorpusCrashPoint): string {
  return `${CREATE_NOTE_LABEL}-${crashPointName(crashPoint)}`;
}

export function createNoteCorpusProfile(): MutationCorpusProfile {
  return {
    kind: "create_note",
    label: CREATE_NOTE_LABEL,
    files: [createNoteFixture],
    primaryPath: CREATE_NOTE_PATH,
    submissionKey: (seed) => `submission-${seed}`,
    buildSubmitInput: (seed) => ({
      submissionKey: `submission-${seed}`,
      operations: [
        {
          operationId: `create-${seed}`,
          kind: "create_note",
          path: CREATE_NOTE_PATH,
          content: CREATE_NOTE_CONTENT,
          ifExists: "reject",
        },
      ],
    }),
    crashPoints: createNoteCrashPoints,
    rollbackLeadInPoint: CREATE_NOTE_ROLLBACK_LEAD_IN,
    expectedBoundary: (crashPoint) => boundaryFor(crashPoint),
    expectedProofState: (crashPoint) => proofStateFor(crashPoint),
    timeoutMs: 60_000,
  };
}
