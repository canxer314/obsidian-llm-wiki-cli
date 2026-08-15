import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import type {
  ConflictResolutionStagePorts,
  ConflictResolutionStageRequest,
} from "./conflict-resolution.js";
import type {
  ImplementationAgentInvocation,
  ImplementationStagePorts,
  ImplementationStageRequest,
  ImplementationWorktree,
} from "./implementation.js";
import { buildImplementationContainerCommand } from "./sandcastle.js";

const execFileAsync = promisify(execFile);

function deterministicBranch(request: ImplementationStageRequest): string {
  const suffix = request.transitionId.replace(/[^a-zA-Z0-9._-]+/gu, "-");
  return `afk/ticket-${request.ticket.number}-${suffix}`;
}

export function redactSecretValues(value: string, secrets: string[]): string {
  return secrets
    .filter((secret) => secret.length > 0)
    .reduce((redacted, secret) => redacted.split(secret).join("[REDACTED]"), value);
}

type SpawnProcess = (
  file: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv; stdio: ["pipe", "pipe", "pipe"] },
) => ChildProcessWithoutNullStreams;

export async function runContainerCommand(
  command: ReturnType<typeof buildImplementationContainerCommand>,
  spawnProcess: SpawnProcess = spawn,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return await new Promise((resolve, reject) => {
    const child = spawnProcess(command.file, command.args, {
      env: { PATH: process.env.PATH ?? "", ...command.environment },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, command.timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new DOMException("implementation agent timed out", "TimeoutError"));
        return;
      }
      resolve({
        exitCode: code ?? 1,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
    child.stdin.end(command.stdin);
  });
}

export function containerClaudeSettingsPath(
  override = process.env.AFK_CLAUDE_SETTINGS,
  runnerHome = homedir(),
): string {
  return resolve(override ?? join(runnerHome, ".claude", "settings-docker.json"));
}

export function validateContainerClaudeSettings(content: string): void {
  const settings: unknown = JSON.parse(content);
  if (typeof settings !== "object" || settings === null || Array.isArray(settings)) {
    throw new Error("container Claude settings must be a JSON object");
  }
  const environment = (settings as { env?: unknown }).env;
  if (environment !== undefined &&
      (typeof environment !== "object" || environment === null || Array.isArray(environment))) {
    throw new Error("container Claude settings env must be a JSON object");
  }
  const values = environment as Record<string, unknown> | undefined;
  if (values?.GITHUB_TOKEN !== undefined || values?.GH_TOKEN !== undefined) {
    throw new Error("container Claude settings must not contain GitHub credentials");
  }
}

export function createLocalConflictResolutionPorts(input: {
  repositoryPath: string;
  image: string;
  claudeSettingsPath: string;
  modelGatewayUrl: string;
  modelGatewayToken: string;
}): ConflictResolutionStagePorts {
  const agentPorts = createLocalImplementationPorts(input);
  return {
    async createWorktree(request: ConflictResolutionStageRequest): Promise<ImplementationWorktree> {
      const directory = await mkdtemp(join(tmpdir(), `afk-conflict-pr-${request.prNumber}-`));
      try {
        const { stdout } = await execFileAsync("git", [
          "-C", input.repositoryPath, "remote", "get-url", "origin",
        ]);
        await execFileAsync("git", ["clone", "--no-checkout", stdout.trim(), directory]);
        await execFileAsync("git", [
          "-C", directory, "checkout", "--detach", request.expectedHeadRevision,
        ]);
        try {
          await execFileAsync("git", [
            "-C", directory, "merge", "--no-commit", "--no-ff", request.targetRevision,
          ]);
          throw new Error("conflict resolution stage was invoked for a clean synchronization");
        } catch (error) {
          const { stdout: paths } = await execFileAsync("git", [
            "-C", directory, "diff", "--name-only", "--diff-filter=U",
          ]);
          if (paths.trim().length === 0) throw error;
        }
        return {
          path: directory,
          branch: request.headBranch,
          baseRevision: request.expectedHeadRevision,
        };
      } catch (error) {
        await rm(directory, { recursive: true, force: true });
        throw error;
      }
    },
    runAgent: agentPorts.runAgent,
    async resolveHeadRevision(worktreePath) {
      const { stdout } = await execFileAsync("git", ["-C", worktreePath, "rev-parse", "HEAD"]);
      return stdout.trim();
    },
    async pushResolvedRevision(request) {
      await execFileAsync("git", [
        "-C", request.worktreePath, "push", "origin",
        `${request.outputRevision}:refs/heads/${request.branch}`,
        `--force-with-lease=refs/heads/${request.branch}:${request.expectedHeadRevision}`,
      ]);
    },
    async removeWorktree(worktree) {
      await rm(worktree.path, { recursive: true, force: true });
    },
  };
}

export function createLocalImplementationPorts(input: {
  repositoryPath: string;
  image: string;
  claudeSettingsPath: string;
  modelGatewayUrl: string;
  modelGatewayToken: string;
}): ImplementationStagePorts {
  let settingsChecked: Promise<void> | undefined;
  const checkSettings = (): Promise<void> => {
    settingsChecked ??= readFile(input.claudeSettingsPath, "utf8").then((content) => {
      validateContainerClaudeSettings(content);
    });
    return settingsChecked;
  };
  const branches = new Map<string, string>();
  return {
    async createWorktree(request): Promise<ImplementationWorktree> {
      const directory = await mkdtemp(join(tmpdir(), `afk-ticket-${request.ticket.number}-`));
      const branch = deterministicBranch(request);
      const { stdout } = await execFileAsync("git", [
        "-C", input.repositoryPath, "rev-parse", `refs/remotes/origin/${request.targetBranch}`,
      ]);
      const baseRevision = stdout.trim();
      try {
        await execFileAsync("git", [
          "clone", "--no-local", "--no-checkout", input.repositoryPath, directory,
        ]);
        await execFileAsync("git", [
          "-C", directory, "checkout", "-B", branch, baseRevision,
        ]);
      } catch (error) {
        await rm(directory, { recursive: true, force: true });
        throw error;
      }
      branches.set(directory, branch);
      return { path: directory, branch, baseRevision };
    },
    async runAgent(invocation: ImplementationAgentInvocation) {
      await checkSettings();
      const result = await runContainerCommand(buildImplementationContainerCommand(
        input.image,
        input.claudeSettingsPath,
        {
          ...invocation,
          environment: {
            MODEL_GATEWAY_URL: input.modelGatewayUrl,
            MODEL_GATEWAY_TOKEN: input.modelGatewayToken,
          },
        },
      ));
      return {
        ...result,
        stdout: redactSecretValues(result.stdout, [input.modelGatewayToken]),
        stderr: redactSecretValues(result.stderr, [input.modelGatewayToken]),
      };
    },
    async resolveHeadRevision(worktreePath) {
      const { stdout } = await execFileAsync("git", ["-C", worktreePath, "rev-parse", "HEAD"]);
      const outputRevision = stdout.trim();
      const branch = branches.get(worktreePath);
      if (branch === undefined) throw new Error("implementation workspace is not registered");
      await execFileAsync("git", [
        "-C", input.repositoryPath, "fetch", worktreePath, `${outputRevision}:refs/heads/${branch}`,
      ]);
      return outputRevision;
    },
    async removeWorktree(worktree) {
      branches.delete(worktree.path);
      await rm(worktree.path, { recursive: true, force: true });
    },
  };
}
