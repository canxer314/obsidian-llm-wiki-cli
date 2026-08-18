import { homedir } from "node:os";
import { resolve } from "node:path";

import { docker } from "@ai-hero/sandcastle/sandboxes/docker";

import {
  loadSandcastleConfig,
  type SandcastleConfigPaths,
  type SandcastleModels,
} from "./private-config.ts";

export const sandboxHooks = {
  sandbox: {
    onSandboxReady: [{ command: "npm ci", timeoutMs: 300_000 }],
  },
} as const;

function createSandboxProvider(environment: Readonly<Record<string, string>>) {
  return docker({ network: "host", env: { ...environment } });
}

export async function loadSandboxStartup(
  paths: Partial<SandcastleConfigPaths> = {},
): Promise<{
  readonly sandbox: ReturnType<typeof createSandboxProvider>;
  readonly models: SandcastleModels;
}> {
  const config = await loadSandcastleConfig({
    settingsPath: paths.settingsPath ?? resolve(homedir(), ".claude/settings.json"),
    envPath: paths.envPath ?? resolve(import.meta.dirname, ".env"),
    ...(paths.log === undefined ? {} : { log: paths.log }),
  });
  return {
    sandbox: createSandboxProvider(config.environment),
    models: config.models,
  };
}
