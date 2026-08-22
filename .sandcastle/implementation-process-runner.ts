import type { ChildProcess } from "node:child_process";

import { runAgentWorker, workerJson } from "./agent-process-runner.ts";

export function createProcessImplementer(options: {
  readonly plannerModel: string;
  readonly implementerModel: string;
  readonly timeoutMilliseconds?: number | undefined;
  readonly graceMilliseconds?: number | undefined;
  readonly start?: ((arguments_: readonly string[]) => ChildProcess) | undefined;
  readonly kill?: ((pid: number, signal: NodeJS.Signals) => void) | undefined;
  readonly wait?: ((milliseconds: number) => Promise<void>) | undefined;
  readonly groupExited?: ((pid: number) => Promise<void>) | undefined;
}) {
  return {
    async implement(request: {
      readonly issueNumber: number;
      readonly baseRevision: string;
      readonly checkoutPath: string;
    }): Promise<{ readonly branch: string; readonly pullRequestUrl: string }> {
      const result = await runAgentWorker({
        workerFile: "implementation-worker.ts",
        workerName: "Implementation",
        arguments_: [
          String(request.issueNumber),
          request.baseRevision,
          request.checkoutPath,
          options.plannerModel,
          options.implementerModel,
        ],
        timeoutMessage: "Implementation execution timed out",
        timeoutMilliseconds: options.timeoutMilliseconds,
        graceMilliseconds: options.graceMilliseconds,
        start: options.start,
        kill: options.kill,
        wait: options.wait,
        groupExited: options.groupExited,
      });
      return workerJson(result, "Implementation");
    },
  };
}
