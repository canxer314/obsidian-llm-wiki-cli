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
}

export interface ImplementerAgentSessionResult {
  readonly branch: string;
  readonly commits: readonly { readonly sha: string }[];
}

export interface ImplementerAgentSession {
  run(request: ImplementerAgentSessionRequest): Promise<ImplementerAgentSessionResult>;
}

const implementerPrompt = (
  branch: string,
  plan: Extract<PlannerOutput, { status: "ready" }>,
) => `
Implement GitHub Issue #${plan.issue.number} using this complete Planner handoff:

${JSON.stringify(plan)}

Work only on branch ${branch}. Implement the Issue, run the relevant tests, commit all intended changes, run gh auth setup-git, and run git push origin ${branch}. Do not rebase or force-push.

Create a Draft Pull Request with gh pr create --draft. Its base must be the repository default branch, its head must be ${branch}, and its body must contain exactly the closing relationship Closes #${plan.issue.number}.

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
        hooks: options.hooks,
        branchStrategy: {
          type: "branch",
          branch: request.branch,
          baseBranch: `origin/${request.branch}`,
        },
        maxIterations: 1,
        name: `implementer-issue-${request.plan.issue.number}`,
        prompt: implementerPrompt(request.branch, request.plan),
      });
      return { branch: result.branch, commits: result.commits };
    },
  };
}
