import type { ChildProcess } from "node:child_process";

import { runAgentWorker, workerJson } from "./agent-process-runner.ts";

export function createProcessImplementer(options: {
  readonly startup: string;
  readonly plannerModel: string;
  readonly implementerModel: string;
  readonly start?: ((arguments_: readonly string[]) => ChildProcess) | undefined;
}) {
  return {
    async implement(request: {
      readonly issueNumber: number;
      readonly baseRevision: string;
      readonly checkoutPath: string;
    }): Promise<{ readonly branch: string; readonly pullRequestUrl: string }> {
      const result = await runAgentWorker({
        checkoutPath: request.checkoutPath,
        workerFile: "implementation-worker.ts",
        workerName: "Implementation",
        arguments_: [
          String(request.issueNumber),
          request.baseRevision,
          request.checkoutPath,
          options.plannerModel,
          options.implementerModel,
        ],
        input: options.startup,
        timeoutMessage: "Implementation execution timed out",
        start: options.start,
      });
      return workerJson(result, "Implementation");
    },
  };
}
