import type { ImplementerAgentSession } from "./implementer-session.js";
import type { PlannerOutput } from "./planner.js";

export interface VerifiedPullRequest {
  readonly number: number;
  readonly headSha: string;
  readonly url: string;
}

export interface ImplementerGithubPort {
  verifyImplementation(request: {
    readonly issueNumber: number;
    readonly branch: string;
    readonly expectedHeadSha: string;
    readonly allowsAutomationChanges: boolean;
  }): Promise<VerifiedPullRequest>;
}

export class ImplementerResultError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImplementerResultError";
  }
}

function expectedHead(
  branch: string,
  result: Awaited<ReturnType<ImplementerAgentSession["run"]>>,
): string {
  if (result.branch !== branch) {
    throw new ImplementerResultError(
      `Implementer used branch ${result.branch}; expected ${branch}`,
    );
  }
  const expectedHeadSha = result.commits.at(-1)?.sha;
  if (expectedHeadSha === undefined) {
    throw new ImplementerResultError("Implementer did not create a commit");
  }
  return expectedHeadSha;
}

export async function implementIssue(options: {
  readonly plan: Extract<PlannerOutput, { status: "ready" }>;
  readonly model: string;
  readonly session: ImplementerAgentSession;
  readonly checkoutPath?: string;
  readonly github: ImplementerGithubPort;
}): Promise<VerifiedPullRequest> {
  const branch = `sandcastle/issue-${options.plan.issue.number}`;
  const result = await options.session.run({
    model: options.model,
    branch,
    plan: options.plan,
    ...(options.checkoutPath === undefined ? {} : { checkoutPath: options.checkoutPath }),
  });
  const expectedHeadSha = expectedHead(branch, result);
  return options.github.verifyImplementation({
    issueNumber: options.plan.issue.number,
    branch,
    expectedHeadSha,
    allowsAutomationChanges: options.plan.allowsAutomationChanges,
  });
}
