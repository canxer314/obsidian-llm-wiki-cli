import type { VerifiedPullRequest } from "./implementer.js";
import type { MergerAgentSession } from "./merger-session.js";
import type { MergerRequest } from "./repair-orchestrator.js";

export interface ConflictMergerGithubPort {
  verifyConflictMerge(request: {
    readonly issueNumber: number;
    readonly pullRequest: VerifiedPullRequest;
    readonly expectedHeadSha: string;
    readonly targetBranch: string;
    readonly targetSha: string;
  }): Promise<VerifiedPullRequest>;
}

export class MergerResultError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MergerResultError";
  }
}

export async function mergeConflict(options: {
  readonly issueNumber: number;
  readonly model: string;
  readonly session: MergerAgentSession;
  readonly github: ConflictMergerGithubPort;
  readonly request: MergerRequest;
}): Promise<VerifiedPullRequest> {
  const branch = `sandcastle/issue-${options.issueNumber}`;
  const result = await options.session.run({
    model: options.model,
    branch,
    request: options.request,
  });
  if (result.branch !== branch) {
    throw new MergerResultError(`Merger used branch ${result.branch}; expected ${branch}`);
  }
  const expectedHeadSha = result.commits.at(-1)?.sha;
  if (expectedHeadSha === undefined || expectedHeadSha === options.request.pullRequest.headSha) {
    throw new MergerResultError("Merger did not create a new merge commit");
  }
  return options.github.verifyConflictMerge({
    issueNumber: options.issueNumber,
    pullRequest: options.request.pullRequest,
    expectedHeadSha,
    targetBranch: options.request.targetBranch,
    targetSha: options.request.targetSha,
  });
}
