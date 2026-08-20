import { spawn } from "node:child_process";
import { join } from "node:path";

import {
  runLocalQuality,
  type LocalQualityCommandResult,
  type LocalQualityHost,
  type LocalQualityResult,
} from "./local-quality.ts";

export interface LocalQualityProcessOptions {
  readonly cwd: string;
  readonly allowFailure?: boolean;
  readonly environment?: Readonly<Record<string, string>>;
}

export interface LocalQualityProcess {
  run(
    command: string,
    args: readonly string[],
    options: LocalQualityProcessOptions,
  ): Promise<LocalQualityCommandResult>;
}

export interface DockerLocalQualityHostOptions {
  readonly repositoryPath: string;
  readonly worktreeRoot: string;
  readonly runId: string;
  readonly uid: number;
  readonly gid: number;
  readonly environment?: Readonly<Record<string, string>>;
  readonly process?: LocalQualityProcess;
  readonly image?: string;
}

const PROXY_ENVIRONMENT_NAMES = new Set([
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
]);

function proxyEnvironment(
  environment: Readonly<Record<string, string>> | undefined,
): Record<string, string> {
  if (environment === undefined) return {};
  return Object.fromEntries(
    Object.entries(environment).filter(
      ([name, value]) => PROXY_ENVIRONMENT_NAMES.has(name) && value.length > 0,
    ),
  );
}

function redactEnvironmentValues(
  output: string,
  environment: Readonly<Record<string, string>> | undefined,
): string {
  return Object.values(environment ?? {}).reduce(
    (redacted, value) => value.length === 0 ? redacted : redacted.replaceAll(value, "[REDACTED]"),
    output,
  );
}

class ProcessError extends Error {
  constructor(command: string, output: string) {
    super(`${command} failed${output.length === 0 ? "" : `: ${output}`}`);
    this.name = "ProcessError";
  }
}

export const nodeProcess: LocalQualityProcess = {
  run: (command, args, options) =>
    new Promise((resolve, reject) => {
      const child = spawn(command, args, {
        cwd: options.cwd,
        env: options.environment === undefined
          ? undefined
          : { ...process.env, ...options.environment },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let output = "";
      child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
        output += chunk;
      });
      child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
        output += chunk;
      });
      child.on("error", reject);
      child.on("close", (exitCode) => {
        const result = {
          exitCode: exitCode ?? 1,
          output: redactEnvironmentValues(output, options.environment),
        };
        if (result.exitCode !== 0 && options.allowFailure !== true) {
          reject(new ProcessError([command, ...args].join(" "), result.output.trim()));
          return;
        }
        resolve(result);
      });
    }),
};

const COMMAND_RESULT_MARKER = "__SANDCASTLE_LOCAL_QUALITY_EXIT__=";
const CONTAINER_COMMAND = [
  "sh",
  "-c",
  `"$@"; status=$?; printf '\\n${COMMAND_RESULT_MARKER}%s\\n' "$status"`,
  "local-quality",
] as const;

function containerCommandResult(output: string): LocalQualityCommandResult {
  const markerIndex = output.lastIndexOf(COMMAND_RESULT_MARKER);
  if (markerIndex === -1) {
    throw new Error("Docker did not report the container command result");
  }
  const resultText = output.slice(markerIndex + COMMAND_RESULT_MARKER.length).trim();
  if (!/^\d+$/u.test(resultText)) {
    throw new Error("Docker reported an invalid container command result");
  }
  return {
    exitCode: Number(resultText),
    output: output.slice(0, markerIndex).trimEnd(),
  };
}

export function createDockerLocalQualityHost(
  options: DockerLocalQualityHostOptions,
): LocalQualityHost {
  const process = options.process ?? nodeProcess;
  const image = options.image ?? `sandcastle:local-quality-${options.runId}`;
  const worktreePath = join(options.worktreeRoot, options.runId);
  const commandOptions = { cwd: options.repositoryPath } as const;
  const environment = proxyEnvironment(options.environment);
  const environmentArgs = Object.keys(environment).flatMap((name) => [
    "--env",
    name,
  ]);
  const buildEnvironmentArgs = Object.keys(environment).flatMap((name) => [
    "--build-arg",
    name,
  ]);
  let worktreeCreated = false;
  let imageCreated = false;
  let containerCreated = false;

  return {
    setup: async (revision) => {
      await process.run(
        "git",
        ["worktree", "add", "--detach", worktreePath, revision],
        commandOptions,
      );
      worktreeCreated = true;
      await process.run(
        "docker",
        [
          "build",
          "--build-arg",
          `AGENT_UID=${options.uid}`,
          "--build-arg",
          `AGENT_GID=${options.gid}`,
          ...buildEnvironmentArgs,
          "--file",
          join(worktreePath, ".sandcastle/Dockerfile"),
          "--tag",
          image,
          worktreePath,
        ],
        { ...commandOptions, environment },
      );
      imageCreated = true;
      await process.run(
        "docker",
        [
          "run",
          "--detach",
          "--name",
          options.runId,
          "--network",
          "host",
          "--user",
          `${options.uid}:${options.gid}`,
          "--volume",
          `${worktreePath}:/home/agent/workspace`,
          "--workdir",
          "/home/agent/workspace",
          ...environmentArgs,
          image,
        ],
        { ...commandOptions, environment },
      );
      containerCreated = true;
    },
    run: async (command) => {
      if (!containerCreated) throw new Error("Local quality container is not prepared");
      const result = await process.run(
        "docker",
        ["exec", options.runId, ...CONTAINER_COMMAND, ...command],
        { ...commandOptions, environment },
      );
      return containerCommandResult(
        redactEnvironmentValues(result.output ?? "", environment),
      );
    },
    dispose: async () => {
      const failures: string[] = [];
      if (containerCreated) {
        const result = await process.run(
          "docker",
          ["rm", "--force", options.runId],
          { ...commandOptions, allowFailure: true },
        );
        if (result.exitCode !== 0) failures.push(result.output ?? "Could not remove container");
        containerCreated = false;
      }
      if (imageCreated) {
        const result = await process.run(
          "docker",
          ["image", "rm", "--force", image],
          { ...commandOptions, allowFailure: true },
        );
        if (result.exitCode !== 0) failures.push(result.output ?? "Could not remove image");
        imageCreated = false;
      }
      if (worktreeCreated) {
        const result = await process.run(
          "git",
          ["worktree", "remove", "--force", worktreePath],
          { ...commandOptions, allowFailure: true },
        );
        if (result.exitCode !== 0) failures.push(result.output ?? "Could not remove worktree");
        worktreeCreated = false;
      }
      if (failures.length > 0) throw new Error(failures.join("; "));
    },
  };
}

export function runDockerLocalQuality(
  revision: string,
  options: DockerLocalQualityHostOptions,
): Promise<LocalQualityResult> {
  return runLocalQuality(revision, createDockerLocalQualityHost(options));
}
