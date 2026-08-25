import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";

import { docker } from "@ai-hero/sandcastle/sandboxes/docker";

import {
  sandcastleImageName,
} from "./docker-image.ts";

import {
  loadSandcastleConfig,
  type SandcastleConfigPaths,
  type SandcastleModels,
} from "./private-config.ts";
import { createChildEnvironments } from "./automation-environment.ts";

const OFFLINE_INSTALL = [
  "printf '%s\\n' \"$(node --version)\" \"$(npm --version)\" | cmp --silent - /home/agent/.npm/sandcastle-runtime.versions",
  "sha256sum --check --status /home/agent/.npm/sandcastle-image.sha256",
  "timeout --signal=TERM --kill-after=10s 240s npm ci --offline",
].join(" && ");

const REPAIR_INSTALL = [
  "printf '%s\\n' \"$(node --version)\" \"$(npm --version)\" | cmp --silent - /home/agent/.npm/sandcastle-runtime.versions",
  "timeout --signal=TERM --kill-after=10s 240s npm ci --prefer-offline --fetch-timeout=30000 --fetch-retries=1 --fetch-retry-mintimeout=1000 --fetch-retry-maxtimeout=5000",
].join(" && ");

export const sandboxHooks = {
  sandbox: {
    onSandboxReady: [{ command: OFFLINE_INSTALL, timeoutMs: 270_000 }],
  },
} as const;

export const repairSandboxHooks = {
  sandbox: {
    onSandboxReady: [{ command: REPAIR_INSTALL, timeoutMs: 270_000 }],
  },
} as const;

export const revisionCompatibleSandboxHooks = repairSandboxHooks;

export const plannerSandboxHooks = {
  sandbox: {
    onSandboxReady: [],
  },
} as const;

export function sandboxHooksFor(
  role: "planner" | "implementer" | "feedback" | "reviewer" | "merger",
) {
  if (role === "planner") return plannerSandboxHooks;
  if (role === "implementer") return sandboxHooks;
  return role === "feedback" ? revisionCompatibleSandboxHooks : repairSandboxHooks;
}

function createSandboxProvider(
  environment: Readonly<Record<string, string>>,
  imageName: string,
) {
  return docker({
    imageName,
    network: "host",
    env: { ...environment },
  });
}

const executeFile = promisify(execFile);

interface GitIdentity {
  readonly name: string;
  readonly email: string;
}

// Container Agent commits are authored with the trusted checkout's git
// identity: the container HOME has no .gitconfig, so startup reads
// user.name/user.email and injects them into the GitHub-capable Agent
// environment as GIT_AUTHOR_*/GIT_COMMITTER_* variables (#269). The values
// are non-sensitive and never enter logs, retained artifacts, GitHub
// diagnostics, or error messages beyond the identity itself.
async function readGitIdentity(repositoryPath: string): Promise<GitIdentity> {
  const readValue = async (key: string): Promise<string> => {
    try {
      const { stdout } = await executeFile("git", ["-C", repositoryPath, "config", "--get", key], { encoding: "utf8" });
      return stdout.trim();
    } catch (error) {
      // git exits 1 when the key is unset; treat that as an absent identity.
      if ((error as { code?: number }).code === 1) return "";
      throw error;
    }
  };
  const [name, email] = await Promise.all([readValue("user.name"), readValue("user.email")]);
  return { name, email };
}

export async function loadSandboxStartup(
  paths: Partial<SandcastleConfigPaths> = {},
  options: {
    readonly readGitIdentity?: (repositoryPath: string) => Promise<GitIdentity>;
  } = {},
): Promise<{
  readonly repositoryPath: string;
  readonly uid: number;
  readonly gid: number;
  readonly imageName: string;
  readonly sandbox: ReturnType<typeof createSandboxProvider>;
  readonly automationSandbox: ReturnType<typeof createSandboxProvider>;
  readonly githubAgentSandbox: ReturnType<typeof createSandboxProvider>;
  readonly environment: Readonly<Record<string, string>>;
  readonly proxyEnvironment: Readonly<Record<string, string>>;
  readonly childEnvironments: ReturnType<typeof createChildEnvironments>;
  readonly models: SandcastleModels;
}> {
  const config = await loadSandcastleConfig({
    settingsPath: paths.settingsPath ?? resolve(homedir(), ".claude/settings.json"),
    envPath: paths.envPath ?? resolve(homedir(), ".config", "sandcastle", "env"),
    ...(paths.log === undefined ? {} : { log: paths.log }),
  });
  const repositoryPath = resolve(import.meta.dirname, "..");
  const uid = process.getuid?.() ?? 1000;
  const gid = process.getgid?.() ?? 1000;
  const imageName = await sandcastleImageName({ repositoryPath, uid, gid });
  const gitIdentity = await (options.readGitIdentity ?? readGitIdentity)(repositoryPath);
  if (gitIdentity.name.length === 0 || gitIdentity.email.length === 0) {
    throw new Error(
      "The trusted repository checkout has no configured git user.name/user.email; " +
      "Agent container commits require a git identity",
    );
  }
  const childEnvironments = createChildEnvironments({
    ...config.environment,
    GIT_AUTHOR_NAME: gitIdentity.name,
    GIT_AUTHOR_EMAIL: gitIdentity.email,
    GIT_COMMITTER_NAME: gitIdentity.name,
    GIT_COMMITTER_EMAIL: gitIdentity.email,
    ...(process.env.PATH === undefined ? {} : { PATH: process.env.PATH }),
    ...(process.env.HOME === undefined ? {} : { HOME: process.env.HOME }),
  });
  return {
    repositoryPath,
    uid,
    gid,
    imageName,
    sandbox: createSandboxProvider(config.environment, imageName),
    automationSandbox: createSandboxProvider(
      childEnvironments.claude,
      imageName,
    ),
    githubAgentSandbox: createSandboxProvider(
      childEnvironments.githubAgent,
      imageName,
    ),
    environment: config.environment,
    proxyEnvironment: config.proxyEnvironment,
    childEnvironments,
    models: config.models,
  };
}
