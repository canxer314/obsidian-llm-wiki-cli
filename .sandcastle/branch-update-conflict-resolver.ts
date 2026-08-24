import {
  Output,
  claudeCode,
  run,
  type SandboxHooks,
  type SandboxProvider,
} from "@ai-hero/sandcastle";
import { z } from "zod";

const resolutionSchema = z.strictObject({
  comment: z.string().min(1),
});

const resolutionPrompt = (request: {
  readonly pullRequestNumber: number;
  readonly branch: string;
  readonly baseBranch: string;
  readonly conflicts: readonly string[];
}) => `
Pull Request #${request.pullRequestNumber} on branch ${request.branch} has merge conflicts against ${request.baseBranch}. A git merge origin/${request.baseBranch} --no-edit has already been attempted and left the checkout conflicted.

Resolve every conflict and finish the merge. Do not abort the merge or leave a half-finished state.

Read CONTEXT.md and relevant docs before resolving substantive conflicts. Inspect Pull Request #${request.pullRequestNumber}, git status, and the conflicted files:
${request.conflicts.join("\n")}

For each hunk, investigate both sides' intent with git log and commit messages. Preserve both intents where possible. If they conflict, prioritize the Pull Request's stated goal and state the trade-off in your comment. Do not invent new behavior.

Run appropriate checks, stage all resolved files, and finish the merge with one conventional commit such as chore: merge origin/${request.baseBranch} into ${request.branch}. Do not push, rebase, create a branch, or make changes after committing.

Emit one JSON object in <output> tags with exactly one non-empty comment field. The comment is a Markdown Pull Request comment describing the conflicts, each resolution, and any uncertainty or remaining problem.
`;

export interface BranchUpdateConflictResolverSession {
  resolve(request: {
    readonly model: string;
    readonly pullRequestNumber: number;
    readonly branch: string;
    readonly baseBranch: string;
    readonly checkoutPath: string;
    readonly conflicts: readonly string[];
  }): Promise<{ readonly comment: string }>;
}

export function createBranchUpdateConflictResolverSession(options: {
  readonly sandbox: SandboxProvider;
  readonly hooks: SandboxHooks;
  readonly runAgent?: typeof run;
  readonly createAgent?: typeof claudeCode;
}): BranchUpdateConflictResolverSession {
  const runAgent = options.runAgent ?? run;
  const createAgent = options.createAgent ?? claudeCode;
  return {
    async resolve(request) {
      const result = await runAgent({
        agent: createAgent(request.model),
        sandbox: options.sandbox,
        cwd: request.checkoutPath,
        hooks: options.hooks,
        branchStrategy: { type: "branch", branch: request.branch },
        maxIterations: 1,
        name: `branch-update-pr-${request.pullRequestNumber}`,
        prompt: resolutionPrompt(request),
        output: Output.object({ tag: "output", schema: resolutionSchema, maxRetries: 2 }),
      });
      return result.output;
    },
  };
}
