import type { ChildProcess } from "node:child_process";

import { runAgentWorker, workerJson } from "./agent-process-runner.ts";

export function createProcessPrdImplementer(options: {
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
      readonly prdNumber: number;
      readonly child: { readonly number: number; readonly title: string };
      readonly branch: string;
      readonly baseRevision: string;
      readonly checkoutPath: string;
    }): Promise<{ readonly branch: string; readonly headSha: string }> {
      const result = await runAgentWorker({
        workerFile: "prd-implementation-worker.ts",
        workerName: "PRD implementation",
        arguments_: [
          String(request.prdNumber),
          String(request.child.number),
          request.branch,
          request.baseRevision,
          request.checkoutPath,
          options.plannerModel,
          options.implementerModel,
        ],
        timeoutMessage: "PRD implementation execution timed out",
        timeoutMilliseconds: options.timeoutMilliseconds,
        graceMilliseconds: options.graceMilliseconds,
        start: options.start,
        kill: options.kill,
        wait: options.wait,
        groupExited: options.groupExited,
      });
      return workerJson(result, "PRD implementation");
    },
  };
}
