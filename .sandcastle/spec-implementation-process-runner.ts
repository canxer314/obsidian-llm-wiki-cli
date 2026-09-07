import type { ChildProcess } from "node:child_process";
import { resolve } from "node:path";

import { runAgentWorker, workerJson } from "./agent-process-runner.ts";

export function createProcessSpecImplementer(options: {
  readonly startup: string;
  readonly plannerModel: string;
  readonly implementerModel: string;
  readonly start?: ((arguments_: readonly string[]) => ChildProcess) | undefined;
  readonly workerRoot?: string;
}) {
  return {
    async implement(request: {
      readonly specNumber: number;
      readonly child: { readonly number: number; readonly title: string };
      readonly branch: string;
      readonly baseRevision: string;
      readonly checkoutPath: string;
    }): Promise<{ readonly branch: string; readonly headSha: string }> {
      const result = await runAgentWorker({
        workerRoot: options.workerRoot ?? resolve(import.meta.dirname),
        workerFile: "spec-implementation-worker.ts",
        workerName: "Spec implementation",
        arguments_: [
          String(request.specNumber),
          String(request.child.number),
          request.branch,
          request.baseRevision,
          request.checkoutPath,
          options.plannerModel,
          options.implementerModel,
        ],
        input: options.startup,
        timeoutMessage: "Spec implementation execution timed out",
        start: options.start,
      });
      return workerJson(result, "Spec implementation");
    },
  };
}
