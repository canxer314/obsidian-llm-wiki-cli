/**
 * Typed-Frontmatter rewrite corpus profile (issue #188): `edit_frontmatter`.
 *
 * The fixture carries an untouched CRLF Frontmatter block plus a CRLF/CJK body;
 * a typed rewrite sets/removes/appends JSON-scalar keys. The committed bytes
 * are produced by the same production `projectFrontmatter` the executor uses,
 * so the corpus proves byte-exact all-or-restore behavior for Frontmatter
 * rewrites without duplicating YAML projection logic.
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
  FRONTMATTER_COMMITTED_BYTES,
  FRONTMATTER_FIXTURE,
  FRONTMATTER_ORIGINAL_BYTES,
} from "./edit-fixtures.js";
import type {
  MutationCorpusCrashPoint,
  MutationCorpusFileFixture,
  MutationCorpusProfile,
} from "./crash-corpus-runner.js";

export const EDIT_FRONTMATTER_LABEL = "edit-frontmatter";

export const editFrontmatterFixtureFiles: readonly MutationCorpusFileFixture[] = [
  {
    path: FRONTMATTER_FIXTURE.path,
    originalBytes: FRONTMATTER_ORIGINAL_BYTES,
    committedBytes: FRONTMATTER_COMMITTED_BYTES,
  },
];

export function seedForEditFrontmatter(crashPoint: MutationCorpusCrashPoint): string {
  return `${EDIT_FRONTMATTER_LABEL}-${crashPointName(crashPoint)}`;
}

export function editFrontmatterCorpusProfile(): MutationCorpusProfile {
  const path = FRONTMATTER_FIXTURE.path;
  return {
    kind: "edit_frontmatter",
    label: EDIT_FRONTMATTER_LABEL,
    files: editFrontmatterFixtureFiles,
    primaryPath: path,
    submissionKey: (seed) => `submission-${seed}`,
    buildSubmitInput: (seed) => ({
      submissionKey: `submission-${seed}`,
      operations: [
        {
          operationId: `frontmatter-${seed}`,
          kind: "edit_frontmatter",
          path,
          targetVersion: contentVersion(FRONTMATTER_ORIGINAL_BYTES),
          changes: FRONTMATTER_FIXTURE.changes,
        },
      ],
    }),
    crashPoints: singleFileEditCrashPoints(),
    rollbackLeadInPoint: EDIT_ROLLBACK_LEAD_IN,
    expectedBoundary: (crashPoint) =>
      editBoundaryFor(crashPoint.point, editFrontmatterFixtureFiles),
    expectedProofState: (crashPoint) => editProofState(crashPoint.point),
    timeoutMs: 60_000,
  };
}
