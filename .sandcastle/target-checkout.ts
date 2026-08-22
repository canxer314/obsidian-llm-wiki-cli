import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const executeFile = promisify(execFile);

export interface TargetCheckout {
  withCheckout<TResult>(
    request: { readonly pullRequestNumber?: number; readonly revision: string },
    action: (checkoutPath: string) => Promise<TResult>,
  ): Promise<TResult>;
}

export function createTargetCheckout(options: {
  readonly sourceRepositoryPath: string;
  readonly checkoutRoot?: string;
  readonly createJobDirectory?: () => string;
  readonly execute?: (
    file: string,
    arguments_: readonly string[],
    environment?: Readonly<Record<string, string>>,
  ) => Promise<{ readonly stdout: string; readonly stderr: string }>;
  readonly gitEnvironment?: Readonly<Record<string, string>>;
  readonly dependencyEnvironment?: Readonly<Record<string, string>>;
}): TargetCheckout {
  const execute = options.execute ?? (async (file, arguments_, environment) => {
    const result = await executeFile(file, arguments_, { env: environment });
    return { stdout: result.stdout, stderr: result.stderr };
  });
  const git = (arguments_: readonly string[]) => options.gitEnvironment === undefined
    ? execute("git", arguments_)
    : execute("git", arguments_, options.gitEnvironment);
  const npm = (arguments_: readonly string[]) => options.dependencyEnvironment === undefined
    ? execute("npm", arguments_)
    : execute("npm", arguments_, options.dependencyEnvironment);
  return {
    async withCheckout(request, action) {
      if (!/^[0-9a-f]{40}$/u.test(request.revision)) {
        throw new Error("Target Checkout requires a full Git revision");
      }
      const checkoutPath = options.createJobDirectory === undefined
        ? await (async () => {
          const checkoutRoot = options.checkoutRoot ?? tmpdir();
          await mkdir(checkoutRoot, { recursive: true, mode: 0o700 });
          return mkdtemp(join(checkoutRoot, `review-${request.pullRequestNumber ?? "job"}-`));
        })()
        : options.createJobDirectory();
      let completed = false;
      try {
        await git([
          "clone", "--no-checkout", "--no-local", options.sourceRepositoryPath, checkoutPath,
        ]);
        await git(["-C", checkoutPath, "fetch", "--no-tags", "origin", request.revision]);
        const fetched = (await git(["-C", checkoutPath, "rev-parse", "FETCH_HEAD"])).stdout.trim();
        if (fetched !== request.revision) {
          throw new Error("Target Checkout fetched an unexpected revision");
        }
        const trackedPrivateEnvironment = (await git([
          "-C", checkoutPath,
          "ls-tree", "-r", "--name-only", request.revision, "--", ".sandcastle/.env",
        ])).stdout.trim();
        if (trackedPrivateEnvironment.length > 0) {
          throw new Error("Target revision tracks a Sandcastle private environment file");
        }
        await git(["-C", checkoutPath, "checkout", "--detach", request.revision]);
        await npm(["--prefix", checkoutPath, "ci", "--ignore-scripts"]);
        const result = await action(checkoutPath);
        completed = true;
        return result;
      } finally {
        if (completed) {
          await rm(checkoutPath, { force: true, recursive: true });
        }
      }
    },
  };
}
