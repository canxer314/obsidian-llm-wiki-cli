import {
  claudeCode,
  Output,
  run,
  type SandboxHooks,
  type SandboxProvider,
} from "@ai-hero/sandcastle";
import { z } from "zod";

import type { FeedbackReplyIntent } from "./feedback-implementation-automation.ts";

const replyIntentSchema = z.object({
  rootCommentId: z.string(),
  body: z.string(),
});

export interface FeedbackImplementerSession {
  run(request: {
    readonly model: string;
    readonly pullRequestNumber: number;
    readonly branch: string;
    readonly revision: string;
    readonly checkoutPath: string;
    readonly rootCommentId: string;
  }): Promise<FeedbackReplyIntent>;
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
      const result = await runAgent({
        agent: createAgent(request.model),
        sandbox: options.sandbox,
        cwd: request.checkoutPath,
        hooks: options.hooks,
        branchStrategy: { type: "head" },
        maxIterations: 1,
        name: `implementer-feedback-pr-${request.pullRequestNumber}`,
        output: Output.object({ tag: "feedback-reply", schema: replyIntentSchema }),
        prompt: `Apply the requested feedback to existing GitHub Pull Request #${request.pullRequestNumber}. Work only on its existing branch ${request.branch}, which starts at the acquired full revision ${request.revision}. Inspect the Pull Request discussion and review feedback, make the smallest correct changes, choose and run the appropriate repository checks, then commit all intended changes. Do not create an Issue, branch, or Pull Request. Do not run gh auth setup-git, git push, rebase, or force-push; a controlled publisher will publish your local commit after you exit. The orchestrator owns every GitHub write: do not create, edit, or reply to any GitHub review comment or thread, do not run any gh write command (comments, replies, labels, edit, ready), and leave the Pull Request discussion untouched. The selected immutable feedback intent is the review-thread root ${request.rootCommentId}. Your <feedback-reply> rootCommentId must be exactly ${request.rootCommentId}; do not substitute another unresolved root or a reply comment.`,
      });
      return result.output;
    },
  };
}
