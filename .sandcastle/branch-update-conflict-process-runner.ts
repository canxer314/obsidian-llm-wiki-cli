import type { ChildProcess } from "node:child_process";
import { resolve } from "node:path";

import { runAgentWorker, workerJson } from "./agent-process-runner.ts";
import type { BranchUpdateResolver } from "./branch-update-process-runner.ts";

export function createProcessBranchUpdateConflictResolver(options: {
  readonly startup: string;
  readonly model: string;
  readonly start?: (arguments_: readonly string[]) => ChildProcess;
  readonly workerRoot?: string;
}): BranchUpdateResolver {
  return {
    async resolve(request) {
      const result = await runAgentWorker({
        workerRoot: options.workerRoot ?? resolve(import.meta.dirname),
        workerFile: "branch-update-conflict-worker.ts",
        workerName: "Branch update conflict resolution",
        arguments_: [
          String(request.pullRequestNumber),
          request.branch,
          request.baseBranch,
          request.revision,
          request.checkoutPath,
          options.model,
          JSON.stringify(request.conflicts),
        ],
        input: options.startup,
        timeoutMessage: "Branch update conflict resolution timed out",
        start: options.start,
      });
      const resolution = workerJson<{ readonly comment?: unknown }>(result, "Branch update conflict resolution");
      if (typeof resolution.comment !== "string" || resolution.comment.length === 0) {
        throw new Error("Branch update conflict resolution worker returned invalid result");
      }
      return { comment: resolution.comment };
    },
  };
}
