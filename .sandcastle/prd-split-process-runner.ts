import type { ChildProcess } from "node:child_process";

import { runAgentWorker, workerJson } from "./agent-process-runner.ts";
import type { PrdSlice } from "./prd-split-extraction.ts";

export function createProcessPrdSplitter(options: {
  readonly model: string;
  readonly timeoutMilliseconds?: number | undefined;
  readonly graceMilliseconds?: number | undefined;
  readonly start?: ((arguments_: readonly string[]) => ChildProcess) | undefined;
  readonly kill?: ((pid: number, signal: NodeJS.Signals) => void) | undefined;
  readonly wait?: ((milliseconds: number) => Promise<void>) | undefined;
  readonly groupExited?: ((pid: number) => Promise<void>) | undefined;
}) {
  return {
    async split(request: {
      readonly prdNumber: number;
      readonly title: string;
      readonly checkoutPath: string;
    }): Promise<readonly PrdSlice[]> {
      const result = await runAgentWorker({
        workerFile: "prd-split-worker.ts",
        workerName: "PRD split",
        arguments_: [
          String(request.prdNumber),
          request.title,
          request.checkoutPath,
          options.model,
        ],
        timeoutMessage: "PRD split execution timed out",
        timeoutMilliseconds: options.timeoutMilliseconds,
        graceMilliseconds: options.graceMilliseconds,
        start: options.start,
        kill: options.kill,
        wait: options.wait,
        groupExited: options.groupExited,
      });
      const parsed = workerJson<{ readonly slices: readonly PrdSlice[] }>(result, "PRD split");
      return parsed.slices;
    },
  };
}
