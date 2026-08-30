import type { ChildProcess } from "node:child_process";

import { runAgentWorker, workerJson } from "./agent-process-runner.ts";

export function createProcessPrdImplementer(options: {
  readonly startup: string;
  readonly plannerModel: string;
  readonly implementerModel: string;
  readonly timeoutMilliseconds?: number | undefined;
  readonly graceMilliseconds?: number | undefined;
  readonly start?: ((arguments_: readonly string[]) => ChildProcess) | undefined;
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
        checkoutPath: request.checkoutPath,
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
        input: options.startup,
        timeoutMessage: "PRD implementation execution timed out",
        timeoutMilliseconds: options.timeoutMilliseconds,
        graceMilliseconds: options.graceMilliseconds,
        start: options.start,
      });
      return workerJson(result, "PRD implementation");
    },
  };
}
