import {
  claudeCode,
  run,
  type SandboxHooks,
  type SandboxProvider,
} from "@ai-hero/sandcastle";

export interface FeedbackImplementerSession {
  run(request: {
    readonly model: string;
    readonly pullRequestNumber: number;
    readonly branch: string;
    readonly revision: string;
    readonly checkoutPath: string;
  }): Promise<void>;
}

export function createFeedbackImplementerSession(options: {
  readonly sandbox: SandboxProvider;
  readonly hooks: SandboxHooks;
  readonly runAgent?: typeof run;
  readonly createAgent?: typeof claudeCode;
}): FeedbackImplementerSession {
  const runAgent = options.runAgent ?? run;
  const createAgent = options.createAgent ?? claudeCode;
  return {
    async run(request) {
      await runAgent({
        agent: createAgent(request.model),
        sandbox: options.sandbox,
        cwd: request.checkoutPath,
        hooks: options.hooks,
        branchStrategy: { type: "head" },
        maxIterations: 1,
        name: `implementer-feedback-pr-${request.pullRequestNumber}`,
        prompt: `Apply the requested feedback to existing GitHub Pull Request #${request.pullRequestNumber}. Work only on its existing branch ${request.branch}, which starts at the acquired full revision ${request.revision}. Inspect the Pull Request discussion and review feedback, make the smallest correct changes, choose and run the appropriate repository checks, then commit all intended changes. Do not create an Issue, branch, or Pull Request. Do not run gh auth setup-git, git push, rebase, or force-push; a controlled publisher will publish your local commit after you exit.`,
      });
    },
  };
}
