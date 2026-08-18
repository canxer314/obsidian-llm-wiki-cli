import { docker } from "@ai-hero/sandcastle/sandboxes/docker";

export const sandboxHooks = {
  sandbox: {
    onSandboxReady: [{ command: "npm ci", timeoutMs: 300_000 }],
  },
} as const;

export function createSandboxProvider() {
  return docker({ network: "host" });
}
