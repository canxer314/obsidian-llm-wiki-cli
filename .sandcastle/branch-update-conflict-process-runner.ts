import type { ChildProcess } from "node:child_process";

import { runAgentWorker, workerJson } from "./agent-process-runner.ts";
import type { BranchUpdateResolver } from "./branch-update-process-runner.ts";

export function createProcessBranchUpdateConflictResolver(options: {
  readonly model: string;
  readonly timeoutMilliseconds?: number;
  readonly graceMilliseconds?: number;
  readonly start?: (arguments_: readonly string[]) => ChildProcess;
  readonly kill?: (pid: number, signal: NodeJS.Signals) => void;
  readonly wait?: (milliseconds: number) => Promise<void>;
  readonly groupExited?: (pid: number) => Promise<void>;
}): BranchUpdateResolver {
  return {
    async resolve(request) {
      const result = await runAgentWorker({
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
        timeoutMessage: "Branch update conflict resolution timed out",
        timeoutMilliseconds: options.timeoutMilliseconds,
        graceMilliseconds: options.graceMilliseconds,
        start: options.start,
        kill: options.kill,
        wait: options.wait,
        groupExited: options.groupExited,
      });
      return workerJson<{ readonly comment: string }>(result, "Branch update conflict resolution");
    },
  };
}
