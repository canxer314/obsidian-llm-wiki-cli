import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const IMAGE_INPUTS = [
  ".dockerignore",
  ".sandcastle/Dockerfile",
  "package.json",
  "package-lock.json",
  "packages/contracts/package.json",
  "packages/obsidian-plugin/package.json",
] as const;

export function dockerResourceSuffix(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

export async function sandcastleImageName(options: {
  readonly repositoryPath: string;
  readonly uid: number;
  readonly gid: number;
}): Promise<string> {
  const digest = createHash("sha256")
    .update(`${process.platform}:${process.arch}:${options.uid}:${options.gid}\0`);
  for (const path of IMAGE_INPUTS) {
    digest.update(path).update("\0");
    digest.update(await readFile(join(options.repositoryPath, path)));
    digest.update("\0");
  }
  return `sandcastle:obsidian-llm-wiki-cli-${digest.digest("hex").slice(0, 24)}`;
}

const PROXY_ENVIRONMENT_NAMES = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
] as const;

export interface DockerImageProcess {
  run(
    command: string,
    args: readonly string[],
    options: {
      readonly cwd: string;
      readonly environment: Readonly<Record<string, string>>;
    },
  ): Promise<void>;
}

export const dockerImageProcess: DockerImageProcess = {
  run: (command, args, options) =>
    new Promise((resolvePromise, reject) => {
      const child = spawn(command, args, {
        cwd: options.cwd,
        env: { ...process.env, ...options.environment },
        stdio: "inherit",
      });
      child.on("error", reject);
      child.on("close", (exitCode) => {
        if (exitCode === 0) resolvePromise();
        else reject(new Error(`${command} exited with status ${exitCode ?? 1}`));
      });
    }),
};

export async function buildSandcastleImage(options: {
  readonly repositoryPath: string;
  readonly uid: number;
  readonly gid: number;
  readonly environment?: Readonly<Record<string, string>>;
  readonly image?: string;
  readonly process?: DockerImageProcess;
}): Promise<string> {
  const environment = Object.fromEntries(
    PROXY_ENVIRONMENT_NAMES.flatMap((name) =>
      options.environment?.[name] === undefined
        ? []
        : [[name, options.environment[name]]]
    ),
  );
  const buildArgs = Object.keys(environment).flatMap((name) => [
    "--build-arg",
    name,
  ]);
  const image = options.image ?? await sandcastleImageName(options);
  await (options.process ?? dockerImageProcess).run(
    "docker",
    [
      "build",
      "--build-arg",
      `AGENT_UID=${options.uid}`,
      "--build-arg",
      `AGENT_GID=${options.gid}`,
      ...buildArgs,
      "--file",
      ".sandcastle/Dockerfile",
      "--tag",
      image,
      ".",
    ],
    {
      cwd: options.repositoryPath,
      environment,
    },
  );
  return image;
}
