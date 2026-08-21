import { execFile } from "node:child_process";
import { promisify } from "node:util";

const executeFile = promisify(execFile);

type Execute = (
  file: string,
  arguments_: readonly string[],
  environment?: Readonly<Record<string, string>>,
) => Promise<{ readonly stdout: string; readonly stderr: string }>;

function requireFullRevision(revision: string, message: string): void {
  if (!/^[0-9a-f]{40}$/u.test(revision)) throw new Error(message);
}

export function createFeedbackPublisher(options: {
  readonly execute?: Execute;
  readonly sourceRepositoryPath?: string;
  readonly gitEnvironment?: Readonly<Record<string, string>>;
}) {
  const execute = options.execute ?? (async (file, arguments_, environment) => {
    const result = await executeFile(file, [...arguments_], { env: environment });
    return { stdout: result.stdout, stderr: result.stderr };
  });
  const git = (arguments_: readonly string[]) => options.gitEnvironment === undefined
    ? execute("git", arguments_)
    : execute("git", arguments_, options.gitEnvironment);
  const sourceRepositoryPath = options.sourceRepositoryPath;

  return {
    async prepare(checkoutPath: string, branch: string, revision: string): Promise<void> {
      requireFullRevision(revision, "Feedback publication requires a full expected revision");
      if (branch.length === 0 || branch.startsWith("-") || branch.includes("..")) {
        throw new Error("Feedback publication branch is invalid");
      }
      await git(["-C", checkoutPath, "checkout", "-B", branch, revision]);
      const { stdout } = await git(["-C", checkoutPath, "rev-parse", "HEAD"]);
      if (stdout.trim() !== revision) {
        throw new Error("Feedback checkout did not start at the acquired revision");
      }
    },
    async publish(request: {
      readonly checkoutPath: string;
      readonly branch: string;
      readonly expectedRevision: string;
    }): Promise<string> {
      requireFullRevision(request.expectedRevision, "Feedback publication requires a full expected revision");
      const { stdout } = await git(["-C", request.checkoutPath, "rev-parse", "HEAD"]);
      const revision = stdout.trim();
      requireFullRevision(revision, "Feedback implementation did not create a full local revision");
      if (revision === request.expectedRevision) {
        throw new Error("Feedback implementation did not create a new local revision");
      }
      const remote = sourceRepositoryPath === undefined
        ? "origin"
        : (await git(["-C", sourceRepositoryPath, "remote", "get-url", "origin"])).stdout.trim();
      if (remote.length === 0 || /:\/\/[^/]*@/u.test(remote)) {
        throw new Error("Feedback publication remote is invalid");
      }
      await git([
        "-C", request.checkoutPath,
        "push", remote,
        `--force-with-lease=refs/heads/${request.branch}:${request.expectedRevision}`,
        `HEAD:refs/heads/${request.branch}`,
      ]);
      return revision;
    },
  };
}
