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

export interface DockerImageInspectionProcess {
  inspect(image: string): Promise<boolean>;
}

export const dockerImageInspectionProcess: DockerImageInspectionProcess = {
  inspect: (image) =>
    new Promise((resolvePromise, reject) => {
      const child = spawn("docker", ["image", "inspect", image], {
        stdio: "ignore",
      });
      child.on("error", () => {
        reject(new Error("Could not inspect Sandcastle Docker image readiness"));
      });
      child.on("close", (exitCode) => resolvePromise(exitCode === 0));
    }),
};

export async function sandcastleImageReadiness(options: {
  readonly image: string;
  readonly process?: DockerImageInspectionProcess;
}): Promise<"ready" | "missing"> {
  return await (options.process ?? dockerImageInspectionProcess).inspect(options.image)
    ? "ready"
    : "missing";
}

export async function requireSandcastleImage(options: {
  readonly image: string;
  readonly process?: DockerImageInspectionProcess;
}): Promise<void> {
  if (await sandcastleImageReadiness(options) === "missing") {
    throw new Error(
      "Sandcastle Docker image is not ready; run `npm run sandcastle -- build-image`",
    );
  }
}

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
        stdio: "ignore",
      });
      child.on("error", () => {
        reject(new Error("Could not build Sandcastle Docker image"));
      });
      child.on("close", (exitCode) => {
        if (exitCode === 0) resolvePromise();
        else reject(new Error("Could not build Sandcastle Docker image"));
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
