import {
  claudeCode,
  run,
  type SandboxHooks,
  type SandboxProvider,
} from "@ai-hero/sandcastle";

import type { MergerRequest } from "./repair-orchestrator.js";

export interface MergerAgentSessionRequest {
  readonly model: string;
  readonly branch: string;
  readonly request: MergerRequest;
}

export interface MergerAgentSessionResult {
  readonly branch: string;
  readonly commits: readonly { readonly sha: string }[];
}

export interface MergerAgentSession {
  run(request: MergerAgentSessionRequest): Promise<MergerAgentSessionResult>;
}

const mergerPrompt = (branch: string, request: MergerRequest) => `
This is Merger conflict repair attempt ${request.attempt} of 2 for Pull Request #${request.pullRequest.number}.

The Issue branch ${branch} is at ${request.pullRequest.headSha}. The latest ${request.targetBranch} commit is ${request.targetSha}. A normal merge reported this conflict:

${request.summary}

Work only on branch ${branch}. Confirm HEAD is exactly ${request.pullRequest.headSha}. Run git fetch origin ${request.targetBranch}, confirm FETCH_HEAD is exactly ${request.targetSha}, and run git merge ${request.targetSha}. Resolve only the merge conflicts, preserving both sides' intended behavior. Run the relevant tests, commit the merge, run gh auth setup-git, and run git push origin ${branch}. The push must produce one new normal merge commit whose first parent is ${request.pullRequest.headSha} and second parent is ${request.targetSha}. Do not rebase or force-push. Do not create or modify Pull Requests.
`;

export function createSandcastleMergerSession(options: {
  readonly sandbox: SandboxProvider;
  readonly hooks: SandboxHooks;
  readonly runAgent?: typeof run;
  readonly createAgent?: typeof claudeCode;
}): MergerAgentSession {
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
        name: `merger-issue-${request.branch.split("-").at(-1)}-attempt-${request.request.attempt}`,
        prompt: mergerPrompt(request.branch, request.request),
      });
      return { branch: result.branch, commits: result.commits };
    },
  };
}
