import type { ChildProcess } from "node:child_process";

import { runAgentWorker, workerJson } from "./agent-process-runner.ts";
import type { PrdSlice } from "./prd-split-extraction.ts";

export function createProcessPrdSplitter(options: {
  readonly startup: string;
  readonly model: string;
  readonly start?: ((arguments_: readonly string[]) => ChildProcess) | undefined;
}) {
  return {
    async split(request: {
      readonly prdNumber: number;
      readonly title: string;
      readonly checkoutPath: string;
    }): Promise<readonly PrdSlice[]> {
      const result = await runAgentWorker({
        checkoutPath: request.checkoutPath,
        workerFile: "prd-split-worker.ts",
        workerName: "PRD split",
        arguments_: [
          String(request.prdNumber),
          request.title,
          request.checkoutPath,
          options.model,
        ],
        input: options.startup,
        timeoutMessage: "PRD split execution timed out",
        start: options.start,
      });
      const parsed = workerJson<{ readonly slices: readonly PrdSlice[] }>(result, "PRD split");
      return parsed.slices;
    },
  };
}
