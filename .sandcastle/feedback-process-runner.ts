import type { ChildProcess } from "node:child_process";

import type { FeedbackReplyIntent } from "./feedback-implementation-automation.ts";
import { runAgentWorker, workerJson } from "./agent-process-runner.ts";

export function createProcessFeedbackImplementer(options: {
  readonly startup: string;
  readonly model: string;
  readonly timeoutMilliseconds?: number | undefined;
  readonly graceMilliseconds?: number | undefined;
  readonly start?: ((arguments_: readonly string[]) => ChildProcess) | undefined;
  readonly kill?: ((pid: number, signal: NodeJS.Signals) => void) | undefined;
  readonly wait?: ((milliseconds: number) => Promise<void>) | undefined;
  readonly groupExited?: ((pid: number) => Promise<void>) | undefined;
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
        checkoutPath: request.checkoutPath,
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
        timeoutMilliseconds: options.timeoutMilliseconds,
        graceMilliseconds: options.graceMilliseconds,
        start: options.start,
        kill: options.kill,
        wait: options.wait,
        groupExited: options.groupExited,
      });
      const workerResult = workerJson<{ readonly status: "implemented"; readonly reply: FeedbackReplyIntent }>(result, "Feedback implementation");
      return { reply: workerResult.reply };
    },
  };
}
