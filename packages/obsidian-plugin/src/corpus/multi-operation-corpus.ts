/**
 * Multi-operation Change Set corpus profiles (issue #188).
 *
 * These profiles prove whole-Change-Set restoration rather than per-file best
 * effort: a durable PREPARED frame spans two pre-existing notes, the apply
 * publishes each file in operation order (`after_file_mutation:0/1`), and a
 * rollback restores the files in reverse operation order
 * (`after_rollback_mutation:0/1`). Every restorable termination must return
 * *both* files to their exact original bytes.
 */

import { contentVersion } from "../content-version.js";
import {
  EDIT_ROLLBACK_LEAD_IN,
  crashPointName,
  editBoundaryFor,
  editProofState,
  multiFileEditCrashPoints,
} from "./edit-change-model.js";
import {
  EXACT_COMMITTED_BYTES,
  EXACT_FIXTURE,
  EXACT_ORIGINAL_BYTES,
  FRONTMATTER_COMMITTED_BYTES,
  FRONTMATTER_FIXTURE,
  FRONTMATTER_ORIGINAL_BYTES,
  WHOLE_COMMITTED_BYTES,
  WHOLE_FIXTURE,
  WHOLE_ORIGINAL_BYTES,
} from "./edit-fixtures.js";
import type {
  MutationCorpusCrashPoint,
  MutationCorpusFileFixture,
  MutationCorpusProfile,
} from "./crash-corpus-runner.js";

export const MULTI_MARKDOWN_LABEL = "edit-multi-markdown";
export const MULTI_FRONTMATTER_LABEL = "edit-multi-frontmatter";

/** A body edit (`replace_exact` on A) followed by another body edit (`replace_whole` on B). */
export const multiMarkdownFiles: readonly MutationCorpusFileFixture[] = [
  {
    path: "Corpus/Multi/EditA.md",
    originalBytes: EXACT_ORIGINAL_BYTES,
    committedBytes: EXACT_COMMITTED_BYTES,
  },
  {
    path: "Corpus/Multi/EditB.md",
    originalBytes: WHOLE_ORIGINAL_BYTES,
    committedBytes: WHOLE_COMMITTED_BYTES,
  },
];

/** A body edit (`replace_exact` on C) followed by a typed Frontmatter rewrite on D. */
export const multiFrontmatterFiles: readonly MutationCorpusFileFixture[] = [
  {
    path: "Corpus/Multi/NoteC.md",
    originalBytes: EXACT_ORIGINAL_BYTES,
    committedBytes: EXACT_COMMITTED_BYTES,
  },
  {
    path: "Corpus/Multi/NoteD.md",
    originalBytes: FRONTMATTER_ORIGINAL_BYTES,
    committedBytes: FRONTMATTER_COMMITTED_BYTES,
  },
];

const multiMarkdownFirst = multiMarkdownFiles[0]!;
const multiMarkdownSecond = multiMarkdownFiles[1]!;
const multiFrontmatterFirst = multiFrontmatterFiles[0]!;
const multiFrontmatterSecond = multiFrontmatterFiles[1]!;

export function seedForMultiMarkdown(crashPoint: MutationCorpusCrashPoint): string {
  return `${MULTI_MARKDOWN_LABEL}-${crashPointName(crashPoint)}`;
}

export function seedForMultiFrontmatter(crashPoint: MutationCorpusCrashPoint): string {
  return `${MULTI_FRONTMATTER_LABEL}-${crashPointName(crashPoint)}`;
}

export function multiMarkdownCorpusProfile(): MutationCorpusProfile {
  const first = multiMarkdownFirst;
  const second = multiMarkdownSecond;
  return {
    kind: "edit_multi_markdown",
    label: MULTI_MARKDOWN_LABEL,
    files: multiMarkdownFiles,
    primaryPath: first.path,
    submissionKey: (seed) => `submission-${seed}`,
    buildSubmitInput: (seed) => ({
      submissionKey: `submission-${seed}`,
      operations: [
        {
          operationId: `multi-a-${seed}`,
          kind: "edit_body",
          path: first.path,
          targetVersion: contentVersion(first.originalBytes!),
          edit: {
            kind: "replace_exact",
            old: EXACT_FIXTURE.oldText,
            replacement: EXACT_FIXTURE.replacementText,
            expectedOccurrences: 1,
          },
        },
        {
          operationId: `multi-b-${seed}`,
          kind: "edit_body",
          path: second.path,
          targetVersion: contentVersion(second.originalBytes!),
          edit: { kind: "replace_whole", replacement: WHOLE_FIXTURE.replacementText },
        },
      ],
    }),
    crashPoints: multiFileEditCrashPoints(),
    rollbackLeadInPoint: EDIT_ROLLBACK_LEAD_IN,
    expectedBoundary: (crashPoint) => editBoundaryFor(crashPoint.point, multiMarkdownFiles),
    expectedProofState: (crashPoint) => editProofState(crashPoint.point),
    timeoutMs: 60_000,
  };
}

export function multiFrontmatterCorpusProfile(): MutationCorpusProfile {
  const first = multiFrontmatterFirst;
  const second = multiFrontmatterSecond;
  return {
    kind: "edit_multi_frontmatter",
    label: MULTI_FRONTMATTER_LABEL,
    files: multiFrontmatterFiles,
    primaryPath: first.path,
    submissionKey: (seed) => `submission-${seed}`,
    buildSubmitInput: (seed) => ({
      submissionKey: `submission-${seed}`,
      operations: [
        {
          operationId: `multi-c-${seed}`,
          kind: "edit_body",
          path: first.path,
          targetVersion: contentVersion(first.originalBytes!),
          edit: {
            kind: "replace_exact",
            old: EXACT_FIXTURE.oldText,
            replacement: EXACT_FIXTURE.replacementText,
            expectedOccurrences: 1,
          },
        },
        {
          operationId: `multi-d-${seed}`,
          kind: "edit_frontmatter",
          path: second.path,
          targetVersion: contentVersion(second.originalBytes!),
          changes: [...FRONTMATTER_FIXTURE.changes],
        },
      ],
    }),
    crashPoints: multiFileEditCrashPoints(),
    rollbackLeadInPoint: EDIT_ROLLBACK_LEAD_IN,
    expectedBoundary: (crashPoint) => editBoundaryFor(crashPoint.point, multiFrontmatterFiles),
    expectedProofState: (crashPoint) => editProofState(crashPoint.point),
    timeoutMs: 60_000,
  };
}
