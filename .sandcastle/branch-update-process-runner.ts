import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { BranchUpdateResult } from "./branch-update-automation.ts";

const executeFile = promisify(execFile);

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
  readonly execute?: (
    file: string,
    arguments_: readonly string[],
  ) => Promise<{ readonly stdout: string; readonly stderr: string }>;
  readonly resolver?: BranchUpdateResolver;
}) {
  const execute = options.execute ?? (async (file, arguments_) => {
    const result = await executeFile(file, [...arguments_]);
    return { stdout: result.stdout, stderr: result.stderr };
  });
  return {
    async update(request: {
      readonly pullRequestNumber: number;
      readonly branch: string;
      readonly baseBranch: string;
      readonly revision: string;
      readonly checkoutPath: string;
    }): Promise<BranchUpdateResult> {
      const git = (arguments_: readonly string[]) => execute("git", ["-C", request.checkoutPath, ...arguments_]);
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
