import { execFile } from "node:child_process";
import { promisify } from "node:util";

const executeFile = promisify(execFile);

type Execute = (
  file: string,
  arguments_: readonly string[],
  environment?: Readonly<Record<string, string>>,
) => Promise<{ readonly stdout: string; readonly stderr: string }>;

type Git = (arguments_: readonly string[]) => Promise<{
  readonly stdout: string;
  readonly stderr: string;
}>;

interface ExactLeaseDiagnostics {
  readonly invalidAcquiredRevision: string;
  readonly invalidExpectedRevision: string;
  readonly invalidBranch: string;
  readonly checkoutMismatch: string;
  readonly invalidResultingRevision: string;
  readonly invalidRemote: string;
}

interface ExactLeasePublisherOptions {
  readonly execute?: Execute;
  readonly sourceRepositoryPath?: string;
  readonly gitEnvironment?: Readonly<Record<string, string>>;
  readonly configureCheckout?: (checkoutPath: string, git: Git) => Promise<void>;
  readonly revisionPolicy:
    | { readonly requireNewRevision: false }
    | { readonly requireNewRevision: true; readonly unchangedRevisionDiagnostic: string };
  readonly diagnostics: ExactLeaseDiagnostics;
}

function requireFullRevision(revision: string, message: string): void {
  if (!/^[0-9a-f]{40}$/u.test(revision)) throw new Error(message);
}

function requireBranch(branch: string, message: string): void {
  if (branch.length === 0 || branch.startsWith("-") || branch.includes("..")) {
    throw new Error(message);
  }
}

function requireRemote(remote: string, message: string): void {
  if (remote.length === 0 || /:\/\/[^/]*@/u.test(remote)) throw new Error(message);
}

export function createExactLeasePublisher(options: ExactLeasePublisherOptions) {
  const execute = options.execute ?? (async (file, arguments_, environment) => {
    const result = await executeFile(file, [...arguments_], { env: environment });
    return { stdout: result.stdout, stderr: result.stderr };
  });
  const git: Git = (arguments_) => options.gitEnvironment === undefined
    ? execute("git", arguments_)
    : execute("git", arguments_, options.gitEnvironment);

  return {
    async prepare(checkoutPath: string, branch: string, acquiredRevision: string): Promise<void> {
      requireFullRevision(acquiredRevision, options.diagnostics.invalidAcquiredRevision);
      requireBranch(branch, options.diagnostics.invalidBranch);
      await options.configureCheckout?.(checkoutPath, git);
      await git(["-C", checkoutPath, "checkout", "-B", branch, acquiredRevision]);
      const { stdout } = await git(["-C", checkoutPath, "rev-parse", "HEAD"]);
      if (stdout.trim() !== acquiredRevision) {
        throw new Error(options.diagnostics.checkoutMismatch);
      }
    },

    async publish(request: {
      readonly checkoutPath: string;
      readonly branch: string;
      readonly expectedRevision: string;
    }): Promise<string> {
      requireFullRevision(request.expectedRevision, options.diagnostics.invalidExpectedRevision);
      requireBranch(request.branch, options.diagnostics.invalidBranch);
      const { stdout } = await git(["-C", request.checkoutPath, "rev-parse", "HEAD"]);
      const revision = stdout.trim();
      requireFullRevision(revision, options.diagnostics.invalidResultingRevision);
      if (options.revisionPolicy.requireNewRevision && revision === request.expectedRevision) {
        throw new Error(options.revisionPolicy.unchangedRevisionDiagnostic);
      }
      const remoteRepositoryPath = options.sourceRepositoryPath ?? request.checkoutPath;
      const remote = (await git([
        "-C", remoteRepositoryPath, "remote", "get-url", "origin",
      ])).stdout.trim();
      requireRemote(remote, options.diagnostics.invalidRemote);
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
