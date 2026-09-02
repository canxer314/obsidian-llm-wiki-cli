import type { ChildProcess } from "node:child_process";

import { runAgentWorker, workerJson } from "./agent-process-runner.ts";
import type { SpecSlice } from "./spec-split-extraction.ts";

export function createProcessSpecSplitter(options: {
  readonly startup: string;
  readonly model: string;
  readonly start?: ((arguments_: readonly string[]) => ChildProcess) | undefined;
}) {
  return {
    async split(request: {
      readonly specNumber: number;
      readonly title: string;
      readonly checkoutPath: string;
    }): Promise<readonly SpecSlice[]> {
      const result = await runAgentWorker({
        checkoutPath: request.checkoutPath,
        workerFile: "spec-split-worker.ts",
        workerName: "Spec split",
        arguments_: [
          String(request.specNumber),
          request.title,
          request.checkoutPath,
          options.model,
        ],
        input: options.startup,
        timeoutMessage: "Spec split execution timed out",
        start: options.start,
      });
      const parsed = workerJson<{ readonly slices: readonly SpecSlice[] }>(result, "Spec split");
      return parsed.slices;
    },
  };
}
