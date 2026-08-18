import type { VerifiedPullRequest } from "./implementer.ts";
import type { LocalQualityResult } from "./local-quality.ts";
import type { ReviewResult } from "./review.ts";

export interface MergePullRequestState {
  readonly state: string;
  readonly isDraft: boolean;
  readonly repository: string;
  readonly defaultBranch: string;
  readonly baseRepository: string;
  readonly headRepository: string;
  readonly baseRefName: string;
  readonly headRefName: string;
  readonly headSha: string;
  readonly mergeable: string;
  readonly closingIssueNumbers: readonly number[];
}

export interface MergeGithubPort {
  markPullRequestReady(pullRequestNumber: number): Promise<void>;
  getPullRequestForMerge(pullRequestNumber: number): Promise<MergePullRequestState>;
  squashMergePullRequest(
    pullRequestNumber: number,
    expectedHeadSha: string,
  ): Promise<{ readonly merged: boolean }>;
  deleteBranch(branch: string): Promise<void>;
}

interface MergeVerifiedPullRequestOptions {
  readonly issueNumber: number;
  readonly pullRequest: VerifiedPullRequest;
  readonly localQuality: LocalQualityResult & { readonly revision: string };
  readonly review: ReviewResult;
  readonly github: MergeGithubPort;
}

export class MergeVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MergeVerificationError";
  }
}

function requireMergeableState(
  issueNumber: number,
  pullRequestNumber: number,
  metadata: MergePullRequestState,
): void {
  if (metadata.state.toUpperCase() !== "OPEN") {
    throw new MergeVerificationError(`Pull Request #${pullRequestNumber} is not open`);
  }
  if (metadata.isDraft) {
    throw new MergeVerificationError(`Pull Request #${pullRequestNumber} is still a Draft`);
  }
  if (
    metadata.baseRepository !== metadata.repository ||
    metadata.headRepository !== metadata.repository
  ) {
    throw new MergeVerificationError(
      `Pull Request #${pullRequestNumber} does not belong entirely to ${metadata.repository}`,
    );
  }
  if (metadata.baseRefName !== metadata.defaultBranch) {
    throw new MergeVerificationError(
      `Pull Request #${pullRequestNumber} does not target ${metadata.defaultBranch}`,
    );
  }
  if (metadata.headRefName !== `sandcastle/issue-${issueNumber}`) {
    throw new MergeVerificationError(
      `Pull Request #${pullRequestNumber} does not use the Issue branch`,
    );
  }
  if (metadata.mergeable !== "MERGEABLE") {
    throw new MergeVerificationError(`Pull Request #${pullRequestNumber} is not mergeable`);
  }
  if (!metadata.closingIssueNumbers.includes(issueNumber)) {
    throw new MergeVerificationError(
      `Pull Request #${pullRequestNumber} does not close Issue #${issueNumber}`,
    );
  }
}

export interface MergeVerifiedPullRequestResult {
  readonly pullRequest: VerifiedPullRequest;
  readonly mergedRevision: string;
}

export async function mergeVerifiedPullRequest(
  options: MergeVerifiedPullRequestOptions,
): Promise<MergeVerifiedPullRequestResult> {
  if (
    options.localQuality.status !== "success" ||
    options.review.status !== "success"
  ) {
    throw new MergeVerificationError(
      "Exact-head merge requires successful local quality and review",
    );
  }
  const revision = options.pullRequest.headSha;
  if (
    options.localQuality.revision !== revision ||
    options.review.revision !== revision
  ) {
    throw new MergeVerificationError(
      "Pull Request head does not match both successful gates",
    );
  }

  await options.github.markPullRequestReady(options.pullRequest.number);
  const metadata = await options.github.getPullRequestForMerge(options.pullRequest.number);
  requireMergeableState(options.issueNumber, options.pullRequest.number, metadata);
  if (metadata.headSha !== revision) {
    throw new MergeVerificationError(
      "Pull Request head does not match both successful gates",
    );
  }

  const result = await options.github.squashMergePullRequest(
    options.pullRequest.number,
    revision,
  );
  if (!result.merged) {
    throw new MergeVerificationError(
      `GitHub did not merge Pull Request #${options.pullRequest.number}`,
    );
  }
  await options.github.deleteBranch(metadata.headRefName);
  return { pullRequest: options.pullRequest, mergedRevision: revision };
}
