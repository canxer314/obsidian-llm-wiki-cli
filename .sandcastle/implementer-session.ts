import {
  claudeCode,
  run,
  type SandboxHooks,
  type SandboxProvider,
} from "@ai-hero/sandcastle";

import type { PlannerOutput } from "./planner.js";

export interface ImplementerAgentSessionRequest {
  readonly model: string;
  readonly branch: string;
  readonly plan: Extract<PlannerOutput, { status: "ready" }>;
  readonly checkoutPath?: string;
  readonly parentPrd?: { readonly number: number };
}

export interface ImplementerAgentSessionResult {
  readonly branch: string;
  readonly commits: readonly { readonly sha: string }[];
}

export interface ImplementerAgentSession {
  run(request: ImplementerAgentSessionRequest): Promise<ImplementerAgentSessionResult>;
}

const draftPullRequestInstructions = (branch: string, relationship: string) => `Before publishing, inspect whether this branch already has a Draft Pull Request. Reuse and update one existing upstream-equivalent Draft Pull Request; otherwise create exactly one Draft Pull Request with gh pr create --draft. Its base must be the repository default branch, its head must be ${branch}, and its body must contain the relationship ${relationship}.`;

const initialImplementerPrompt = (
  branch: string,
  plan: Extract<PlannerOutput, { status: "ready" }>,
  parentPrd?: { readonly number: number },
) => `
Implement GitHub Issue #${plan.issue.number} using this complete Planner handoff:

${JSON.stringify(plan)}

Work only on branch ${branch}. Implement the Issue, choose and run the appropriate repository checks, commit all intended changes, run gh auth setup-git, and run git push origin ${branch}. Do not rebase or force-push.

${parentPrd === undefined
    ? draftPullRequestInstructions(branch, `Closes #${plan.issue.number}`)
    : `This Issue is one child of PRD #${parentPrd.number}, delivered on the shared accumulating branch ${branch}. If ${branch} already exists on origin, resume it with git fetch origin ${branch} && git checkout -B ${branch} origin/${branch} so earlier completed children are preserved. ${draftPullRequestInstructions(branch, `Part of #${parentPrd.number}`)}`}

${plan.allowsAutomationChanges
    ? "This Issue explicitly allows changes to Sandcastle or GitHub workflow automation."
    : "Do not modify .sandcastle/ or .github/workflows/. This Issue does not allow automation changes."}
`;

export function createSandcastleImplementerSession(options: {
  readonly sandbox: SandboxProvider;
  readonly hooks: SandboxHooks;
  readonly runAgent?: typeof run;
  readonly createAgent?: typeof claudeCode;
}): ImplementerAgentSession {
  const runAgent = options.runAgent ?? run;
  const createAgent = options.createAgent ?? claudeCode;
  return {
    async run(request) {
      const result = await runAgent({
        agent: createAgent(request.model),
        sandbox: options.sandbox,
        ...(request.checkoutPath === undefined ? {} : { cwd: request.checkoutPath }),
        hooks: options.hooks,
        branchStrategy: {
          type: "branch",
          branch: request.branch,
        },
        maxIterations: 1,
        name: `implementer-issue-${request.plan.issue.number}`,
        prompt: initialImplementerPrompt(request.branch, request.plan, request.parentPrd),
      });
      return { branch: result.branch, commits: result.commits };
    },
  };
}
