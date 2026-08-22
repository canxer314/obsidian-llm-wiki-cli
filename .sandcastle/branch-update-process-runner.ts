import { execFile } from "node:child_process";
import { promisify } from "node:util";

const executeFile = promisify(execFile);

export function createProcessBranchUpdater(options: {
  readonly execute?: (
    file: string,
    arguments_: readonly string[],
  ) => Promise<{ readonly stdout: string; readonly stderr: string }>;
}) {
  const execute = options.execute ?? (async (file, arguments_) => {
    const result = await executeFile(file, [...arguments_]);
    return { stdout: result.stdout, stderr: result.stderr };
  });
  return {
    async update(request: {
      readonly branch: string;
      readonly baseBranch: string;
      readonly revision: string;
      readonly checkoutPath: string;
    }): Promise<{ readonly revision: string }> {
      await execute("git", ["-C", request.checkoutPath, "fetch", "--no-tags", "origin", request.baseBranch]);
      await execute("git", ["-C", request.checkoutPath, "switch", "--create", request.branch, request.revision]);
      await execute("git", ["-C", request.checkoutPath, "merge", "--no-edit", `origin/${request.baseBranch}`]);
      const { stdout } = await execute("git", ["-C", request.checkoutPath, "rev-parse", "HEAD"]);
      const revision = stdout.trim();
      if (!/^[0-9a-f]{40}$/u.test(revision)) throw new Error("Branch update produced an invalid revision");
      await execute("git", [
        "-C", request.checkoutPath,
        "push", `--force-with-lease=refs/heads/${request.branch}:${request.revision}`,
        "origin", `HEAD:refs/heads/${request.branch}`,
      ]);
      return { revision };
    },
  };
}
