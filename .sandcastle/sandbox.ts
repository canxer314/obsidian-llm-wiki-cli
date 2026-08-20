import { homedir } from "node:os";
import { resolve } from "node:path";

import { docker } from "@ai-hero/sandcastle/sandboxes/docker";

import {
  sandcastleImageName,
} from "./docker-image.ts";

import {
  loadSandcastleConfig,
  type SandcastleConfigPaths,
  type SandcastleModels,
} from "./private-config.ts";

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

export const plannerSandboxHooks = {
  sandbox: {
    onSandboxReady: [],
  },
} as const;

export function sandboxHooksFor(
  role: "planner" | "implementer" | "reviewer" | "merger",
) {
  if (role === "planner") return plannerSandboxHooks;
  return role === "implementer" ? sandboxHooks : repairSandboxHooks;
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

export async function loadSandboxStartup(
  paths: Partial<SandcastleConfigPaths> = {},
): Promise<{
  readonly sandbox: ReturnType<typeof createSandboxProvider>;
  readonly environment: Readonly<Record<string, string>>;
  readonly proxyEnvironment: Readonly<Record<string, string>>;
  readonly models: SandcastleModels;
}> {
  const config = await loadSandcastleConfig({
    settingsPath: paths.settingsPath ?? resolve(homedir(), ".claude/settings.json"),
    envPath: paths.envPath ?? resolve(import.meta.dirname, ".env"),
    ...(paths.log === undefined ? {} : { log: paths.log }),
  });
  const repositoryPath = resolve(import.meta.dirname, "..");
  const imageName = await sandcastleImageName({
    repositoryPath,
    uid: process.getuid?.() ?? 1000,
    gid: process.getgid?.() ?? 1000,
  });
  return {
    sandbox: createSandboxProvider(config.environment, imageName),
    environment: config.environment,
    proxyEnvironment: config.proxyEnvironment,
    models: config.models,
  };
}
