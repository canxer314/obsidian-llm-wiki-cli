/**
 * Shared crash-point / boundary / proof model for the Markdown-edit and
 * typed-Frontmatter corpus profiles (issue #188).
 *
 * A body edit or Frontmatter rewrite on pre-existing notes never creates
 * directories and never drives a RecoveryMutation descriptor, so the durable
 * executor reaches a fixed, small seam for these Change Sets:
 *
 *   apply:    before_prepared → after_prepared → (stage) →
 *             after_file_mutation:{n-1} → after_raw_verification →
 *             during_success_barrier → after_snapshot → (durable COMMITTED) →
 *             after_committed
 *   rollback: before_rollback → after_rollback_mutation:{n-1} →
 *             after_rollback_verification → after_rollback_evidence →
 *             before_rolled_back → (durable ROLLED_BACK) → after_rolled_back
 *
 * The file-publish and rollback-restore order follows the operation order of
 * the profile's public files, so a boundary state for file `i` is derived from
 * `i`, the crash point, and the file count deterministically.
 */

import type {
  MutationCorpusBoundary,
  MutationCorpusBoundaryFileState,
  MutationCorpusCrashPoint,
  MutationCorpusFileFixture,
  MutationCorpusProofState,
} from "./crash-corpus-runner.js";

export const EDIT_ROLLBACK_LEAD_IN = "after_snapshot";

/** Full crash-point list for a single-file Markdown edit / Frontmatter rewrite. */
export function singleFileEditCrashPoints(): readonly MutationCorpusCrashPoint[] {
  return [
    { point: "before_prepared", phase: "apply" },
    { point: "after_prepared", phase: "apply" },
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
}

/**
 * Curated crash-point list for a two-file multi-operation Change Set: every
 * partial-mutation boundary (`after_file_mutation:0/1`), the committed seam,
 * and the mid-rollback boundaries that prove whole-Change-Set restoration.
 */
export function multiFileEditCrashPoints(): readonly MutationCorpusCrashPoint[] {
  return [
    { point: "before_prepared", phase: "apply" },
    { point: "after_file_mutation:0", phase: "apply" },
    { point: "after_file_mutation:1", phase: "apply" },
    { point: "after_raw_verification", phase: "apply" },
    { point: "during_success_barrier", phase: "apply" },
    { point: "after_snapshot", phase: "apply" },
    { point: "after_committed", phase: "apply" },
    { point: "before_rollback", phase: "rollback" },
    { point: "after_rollback_mutation:0", phase: "rollback" },
    { point: "after_rollback_mutation:1", phase: "rollback" },
    { point: "after_rolled_back", phase: "rollback" },
  ];
}

export function editJournalPhase(point: string): MutationCorpusBoundary["journalPhase"] {
  if (point === "before_prepared") return null;
  if (point === "after_committed") return "COMMITTED";
  if (point === "after_rolled_back") return "ROLLED_BACK";
  return "PREPARED";
}

export function editProofState(point: string): MutationCorpusProofState {
  if (point === "before_prepared" || point === "after_committed") return "intent_applied";
  return "intent_not_applied";
}

/**
 * Boundary byte state of public file `index` (0-based operation order) while a
 * child parks at `point`. Files are published in operation order during apply
 * and restored in reverse operation order during rollback.
 */
export function editBoundaryFileStateAt(
  point: string,
  index: number,
  count: number,
): MutationCorpusBoundaryFileState {
  if (point.startsWith("after_file_mutation:")) {
    const published = Number(point.slice("after_file_mutation:".length));
    return index <= published ? "committed" : "original";
  }
  if (point.startsWith("after_rollback_mutation:")) {
    const restored = Number(point.slice("after_rollback_mutation:".length));
    const reverseIndex = count - 1 - index;
    return reverseIndex <= restored ? "original" : "committed";
  }
  switch (point) {
    case "before_prepared":
    case "after_prepared":
      return "original";
    case "after_raw_verification":
    case "during_success_barrier":
    case "after_snapshot":
    case "after_committed":
    case "before_rollback":
      return "committed";
    case "after_rollback_verification":
    case "after_rollback_evidence":
    case "before_rolled_back":
    case "after_rolled_back":
      return "original";
    default:
      throw new Error(`No edit-crash boundary model for ${point}`);
  }
}

export function editBoundaryFor(
  point: string,
  files: readonly MutationCorpusFileFixture[],
): MutationCorpusBoundary {
  return {
    journalPhase: editJournalPhase(point),
    files: files.map((file, index) => ({
      path: file.path,
      state: editBoundaryFileStateAt(point, index, files.length),
    })),
  };
}

export function crashPointName(crashPoint: MutationCorpusCrashPoint): string {
  return crashPoint.point.replace(/[^A-Za-z0-9_-]/gu, "_");
}
