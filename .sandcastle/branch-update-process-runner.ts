import { spawn } from "node:child_process";

import type { BranchUpdateResult } from "./branch-update-automation.ts";
import { createWorkerProcessLifecycle } from "./worker-process-lifecycle.ts";

const GIT_COMMAND_TIMEOUT_MILLISECONDS = 5 * 60 * 1000;
const GIT_COMMAND_GRACE_MILLISECONDS = 10 * 1000;

type Execute = (
  arguments_: readonly string[],
) => Promise<{ readonly stdout: string; readonly stderr: string }>;

function createProcessGitExecutor(options: {
  readonly environment?: Readonly<Record<string, string>>;
  readonly timeoutMilliseconds?: number;
  readonly graceMilliseconds?: number;
}): Execute {
  const lifecycle = createWorkerProcessLifecycle();
  return async (arguments_) => {
    const timeoutMilliseconds = options.timeoutMilliseconds ?? GIT_COMMAND_TIMEOUT_MILLISECONDS;
    const completed = await lifecycle.run({
      role: "nested",
      timeoutMilliseconds,
      graceMilliseconds: options.graceMilliseconds ?? GIT_COMMAND_GRACE_MILLISECONDS,
      launch: (admit, disposition) => {
        const child = spawn("git", [...arguments_], {
          detached: disposition.detached,
          stdio: ["ignore", "pipe", "pipe"],
          ...(options.environment === undefined ? {} : { env: options.environment }),
        });
        admit(child);
        if (child.pid === undefined) throw new Error("spawn git ENOENT");
      },
    });
    if (completed.status === "timed-out") {
      throw new Error(`git command timed out after ${timeoutMilliseconds}ms`);
    }
    if (completed.code !== 0) {
      throw new Error(`git exited with ${completed.code ?? "signal"}: ${completed.stderr}`);
    }
    return completed;
  };
}

export interface BranchUpdateResolver {
  resolve(request: {
    readonly pullRequestNumber: number;
    readonly branch: string;
    readonly baseBranch: string;
    readonly revision: string;
    readonly checkoutPath: string;
    readonly conflicts: readonly string[];
  }): Promise<{ readonly comment: string }>;
}

export function createProcessBranchUpdater(options: {
  readonly execute?: Execute;
  readonly environment?: Readonly<Record<string, string>>;
  readonly resolver?: BranchUpdateResolver;
  readonly timeoutMilliseconds?: number;
  readonly graceMilliseconds?: number;
}) {
  const execute = options.execute ?? createProcessGitExecutor(options);
  return {
    async update(request: {
      readonly pullRequestNumber: number;
      readonly branch: string;
      readonly baseBranch: string;
      readonly revision: string;
      readonly checkoutPath: string;
    }): Promise<BranchUpdateResult> {
      const git = (arguments_: readonly string[]) => execute(["-C", request.checkoutPath, ...arguments_]);
      const revisionOf = async (ref: string) => (await git(["rev-parse", ref])).stdout.trim();
      const unresolvedConflicts = async () => (await git(["diff", "--name-only", "--diff-filter=U"])).stdout
        .split("\n").map((line) => line.trim()).filter(Boolean);
      const push = (revision: string) => git([
        "push", `--force-with-lease=refs/heads/${request.branch}:${request.revision}`,
        "origin", `HEAD:refs/heads/${request.branch}`,
      ]);

      await git(["fetch", "--no-tags", "origin", request.baseBranch]);
      await git(["switch", "--create", request.branch, request.revision]);
      const preMergeSha = await revisionOf("HEAD");
      const baseSha = await revisionOf(`origin/${request.baseBranch}`);
      const mergeBase = (await git(["merge-base", "HEAD", `origin/${request.baseBranch}`])).stdout.trim();

      if (mergeBase === baseSha) return { status: "up-to-date" };

      try {
        await git(["merge", "--no-edit", `origin/${request.baseBranch}`]);
      } catch {
        const conflicts = await unresolvedConflicts();
        if (conflicts.length === 0) {
          throw new Error("Branch update merge failed without reported conflicts");
        }
        if (options.resolver === undefined) {
          throw new Error("Branch update conflict resolution is unavailable");
        }
        const resolved = await options.resolver.resolve({
          pullRequestNumber: request.pullRequestNumber,
          branch: request.branch,
          baseBranch: request.baseBranch,
          revision: request.revision,
          checkoutPath: request.checkoutPath,
          conflicts,
        });
        const postSha = await revisionOf("HEAD");
        if (postSha === preMergeSha) {
          throw new Error("Conflict-resolution agent produced no commits");
        }
        const unresolved = await unresolvedConflicts();
        if (unresolved.length > 0) {
          throw new Error(`Conflict-resolution agent left unresolved conflicts in:\n${unresolved.join("\n")}`);
        }
        await push(postSha);
        return { status: "updated", revision: postSha, comment: resolved.comment };
      }

      const revision = await revisionOf("HEAD");
      if (!/^[0-9a-f]{40}$/u.test(revision)) throw new Error("Branch update produced an invalid revision");
      await push(revision);
      return { status: "updated", revision };
    },
  };
}
