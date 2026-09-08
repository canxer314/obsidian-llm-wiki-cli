/**
 * Markdown body-edit corpus profiles (issue #188): `replace_exact` and
 * `replace_whole`. Both treat the body edit as a byte-replacement mutation over
 * a pre-existing note that is seeded with exact original bytes before
 * generation 1, and both must restore those exact bytes (with the original
 * Content Version) after any restorable pre-commit termination.
 */

import { contentVersion } from "../content-version.js";
import {
  EDIT_ROLLBACK_LEAD_IN,
  crashPointName,
  editBoundaryFor,
  editProofState,
  singleFileEditCrashPoints,
} from "./edit-change-model.js";
import {
  EXACT_COMMITTED_BYTES,
  EXACT_FIXTURE,
  EXACT_ORIGINAL_BYTES,
  WHOLE_COMMITTED_BYTES,
  WHOLE_FIXTURE,
  WHOLE_ORIGINAL_BYTES,
} from "./edit-fixtures.js";
import type {
  MutationCorpusCrashPoint,
  MutationCorpusProfile,
} from "./crash-corpus-runner.js";

export const REPLACE_EXACT_LABEL = "edit-body-exact";
export const REPLACE_WHOLE_LABEL = "edit-body-whole";

export const replaceExactFixtureFiles = [
  {
    path: EXACT_FIXTURE.path,
    originalBytes: EXACT_ORIGINAL_BYTES,
    committedBytes: EXACT_COMMITTED_BYTES,
  },
] as const;

export const replaceWholeFixtureFiles = [
  {
    path: WHOLE_FIXTURE.path,
    originalBytes: WHOLE_ORIGINAL_BYTES,
    committedBytes: WHOLE_COMMITTED_BYTES,
  },
] as const;

export function seedForReplaceExact(crashPoint: MutationCorpusCrashPoint): string {
  return `${REPLACE_EXACT_LABEL}-${crashPointName(crashPoint)}`;
}

export function seedForReplaceWhole(crashPoint: MutationCorpusCrashPoint): string {
  return `${REPLACE_WHOLE_LABEL}-${crashPointName(crashPoint)}`;
}

export function replaceExactCorpusProfile(): MutationCorpusProfile {
  const path = EXACT_FIXTURE.path;
  return {
    kind: "replace_exact",
    label: REPLACE_EXACT_LABEL,
    files: replaceExactFixtureFiles,
    primaryPath: path,
    submissionKey: (seed) => `submission-${seed}`,
    buildSubmitInput: (seed) => ({
      submissionKey: `submission-${seed}`,
      operations: [
        {
          operationId: `exact-${seed}`,
          kind: "edit_body",
          path,
          targetVersion: contentVersion(EXACT_ORIGINAL_BYTES),
          edit: {
            kind: "replace_exact",
            old: EXACT_FIXTURE.oldText,
            replacement: EXACT_FIXTURE.replacementText,
            expectedOccurrences: 1,
          },
        },
      ],
    }),
    crashPoints: singleFileEditCrashPoints(),
    rollbackLeadInPoint: EDIT_ROLLBACK_LEAD_IN,
    expectedBoundary: (crashPoint) => editBoundaryFor(crashPoint.point, replaceExactFixtureFiles),
    expectedProofState: (crashPoint) => editProofState(crashPoint.point),
    timeoutMs: 60_000,
  };
}

export function replaceWholeCorpusProfile(): MutationCorpusProfile {
  const path = WHOLE_FIXTURE.path;
  return {
    kind: "replace_whole",
    label: REPLACE_WHOLE_LABEL,
    files: replaceWholeFixtureFiles,
    primaryPath: path,
    submissionKey: (seed) => `submission-${seed}`,
    buildSubmitInput: (seed) => ({
      submissionKey: `submission-${seed}`,
      operations: [
        {
          operationId: `whole-${seed}`,
          kind: "edit_body",
          path,
          targetVersion: contentVersion(WHOLE_ORIGINAL_BYTES),
          edit: { kind: "replace_whole", replacement: WHOLE_FIXTURE.replacementText },
        },
      ],
    }),
    crashPoints: singleFileEditCrashPoints(),
    rollbackLeadInPoint: EDIT_ROLLBACK_LEAD_IN,
    expectedBoundary: (crashPoint) => editBoundaryFor(crashPoint.point, replaceWholeFixtureFiles),
    expectedProofState: (crashPoint) => editProofState(crashPoint.point),
    timeoutMs: 60_000,
  };
}
