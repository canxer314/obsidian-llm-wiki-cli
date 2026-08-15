import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type {
  ManagedPullRequestContinuationPorts,
  SynchronizationConflict,
} from "./managed-pr-continuation.js";

const execFileAsync = promisify(execFile);

export type GitSynchronizationCommand = (
  file: string,
  args: string[],
  options?: { environment?: Record<string, string> },
) => Promise<string>;

async function defaultCommand(
  file: string,
  args: string[],
  options?: { environment?: Record<string, string> },
): Promise<string> {
  const { stdout } = await execFileAsync(file, args, {
    timeout: 120_000,
    maxBuffer: 10 * 1024 * 1024,
    env: options?.environment === undefined
      ? process.env
      : { ...process.env, ...options.environment },
  });
  return stdout.trim();
}

const deterministicGitEnvironment = {
  GIT_AUTHOR_NAME: "AFK Delivery",
  GIT_AUTHOR_EMAIL: "afk-delivery@invalid",
  GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z",
  GIT_COMMITTER_NAME: "AFK Delivery",
  GIT_COMMITTER_EMAIL: "afk-delivery@invalid",
  GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z",
};

export function createGitSynchronizationPorts(input: {
  repositoryUrl: string;
  command?: GitSynchronizationCommand;
}): Pick<ManagedPullRequestContinuationPorts, "synchronize"> {
  const command = input.command ?? defaultCommand;
  return {
    async synchronize(request) {
      const remote = await command("git", [
        "ls-remote", "--heads", input.repositoryUrl, `refs/heads/${request.headBranch}`,
      ]);
      const remoteHead = remote.split(/\s+/u)[0];
      if (remoteHead !== request.expectedHeadRevision) {
        const recoveryDirectory = await mkdtemp(join(tmpdir(), `afk-sync-recover-pr-${request.prNumber}-`));
        try {
          await command("git", ["clone", "--no-checkout", input.repositoryUrl, recoveryDirectory]);
          const parentLine = await command("git", [
            "-C", recoveryDirectory, "rev-list", "--parents", "-n", "1", remoteHead ?? "",
          ]);
          const [, ...parents] = parentLine.split(/\s+/u);
          if (
            parents.length === 2 &&
            parents.includes(request.expectedHeadRevision) &&
            parents.includes(request.targetRevision)
          ) {
            return {
              status: "succeeded",
              outputRevision: remoteHead!,
              narrative: `Recovered synchronization Revision ${remoteHead}.`,
            };
          }
        } finally {
          await rm(recoveryDirectory, { recursive: true, force: true });
        }
        throw new Error("Managed PR head changed before synchronization");
      }

      const directory = await mkdtemp(join(tmpdir(), `afk-sync-pr-${request.prNumber}-`));
      try {
        await command("git", ["clone", "--no-checkout", input.repositoryUrl, directory]);
        await command("git", ["-C", directory, "checkout", "--detach", request.expectedHeadRevision]);
        try {
          await command("git", [
            "-C", directory, "merge", "--no-ff", "-m",
            `AFK Delivery synchronize ${request.targetRevision} into ${request.expectedHeadRevision}`,
            request.targetRevision,
          ], { environment: deterministicGitEnvironment });
        } catch (error) {
          const paths = (await command("git", [
            "-C", directory, "diff", "--name-only", "--diff-filter=U",
          ])).split("\n").filter(Boolean);
          if (paths.length === 0) throw error;
          const conflicts: SynchronizationConflict[] = [];
          for (const path of paths) {
            const ours = await command("git", ["-C", directory, "show", `:2:${path}`]);
            const theirs = await command("git", ["-C", directory, "show", `:3:${path}`]);
            conflicts.push({ path, ours, theirs });
          }
          return {
            status: "conflicted",
            narrative: `Deterministic synchronization found ${paths.length} conflicting path${paths.length === 1 ? "" : "s"}.`,
            conflicts,
          };
        }
        const outputRevision = await command("git", ["-C", directory, "rev-parse", "HEAD"]);
        if (outputRevision === request.expectedHeadRevision) {
          throw new Error("synchronization did not produce a new Revision");
        }
        await command("git", [
          "-C", directory, "push", "origin",
          `HEAD:refs/heads/${request.headBranch}`,
          `--force-with-lease=refs/heads/${request.headBranch}:${request.expectedHeadRevision}`,
        ]);
        return {
          status: "succeeded",
          outputRevision,
          narrative: `Merged target Revision ${request.targetRevision} into ${request.expectedHeadRevision}.`,
        };
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  };
}
