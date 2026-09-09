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
  const run = async (
    mode: "resolve" | "format",
    request: {
      readonly pullRequestNumber: number;
      readonly branch: string;
      readonly baseBranch: string;
      readonly revision: string;
      readonly checkoutPath: string;
    },
    recovery: boolean,
    conflicts: readonly string[],
  ) => {
    const result = await runAgentWorker({
      workerRoot: options.workerRoot ?? resolve(import.meta.dirname),
      workerFile: "branch-update-conflict-worker.ts",
      workerName: "Branch update conflict resolution",
      arguments_: [
        mode,
        String(request.pullRequestNumber),
        request.branch,
        request.baseBranch,
        request.revision,
        request.checkoutPath,
        options.model,
        recovery ? "recovery" : "initial",
        JSON.stringify(conflicts),
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
  };
  return {
    resolve: (request) => run("resolve", request, request.recovery === true, request.conflicts),
    format: (request) => run("format", request, false, []),
  };
}
