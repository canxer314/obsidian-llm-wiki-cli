import type { ChildProcess } from "node:child_process";
import { resolve } from "node:path";

import type { FeedbackReplyIntent } from "./feedback-implementation-automation.ts";
import { runAgentWorker, workerJson } from "./agent-process-runner.ts";

export function createProcessFeedbackImplementer(options: {
  readonly startup: string;
  readonly model: string;
  readonly start?: ((arguments_: readonly string[]) => ChildProcess) | undefined;
  readonly workerRoot?: string;
}) {
  return {
    async implement(request: {
      readonly pullRequestNumber: number;
      readonly branch: string;
      readonly revision: string;
      readonly checkoutPath: string;
      readonly rootCommentId: string;
    }): Promise<{ readonly reply: FeedbackReplyIntent }> {
      const result = await runAgentWorker({
        workerRoot: options.workerRoot ?? resolve(import.meta.dirname),
        workerFile: "feedback-worker.ts",
        workerName: "Feedback implementation",
        arguments_: [
          String(request.pullRequestNumber),
          request.branch,
          request.revision,
          request.checkoutPath,
          request.rootCommentId,
          options.model,
        ],
        input: options.startup,
        timeoutMessage: "Feedback implementation execution timed out",
        start: options.start,
      });
      const workerResult = workerJson<{ readonly status: "implemented"; readonly reply: FeedbackReplyIntent }>(result, "Feedback implementation");
      return { reply: workerResult.reply };
    },
  };
}
