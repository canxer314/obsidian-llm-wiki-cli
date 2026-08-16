import { describe, expect, it } from "vitest";
import {
  containerClaudeSettingsPath,
  redactSecretValues,
  validateContainerClaudeSettings,
} from "../src/local-stage.js";
import { buildImplementationContainerCommand } from "../src/sandcastle.js";

const invocation = {
  worktreePath: "/worktrees/65",
  prompt: "implement ticket",
  model: "claude-opus-5",
  contextWindow: 1_000_000,
  maximumIterations: 24,
  timeoutMs: 60_000,
  cpuLimit: 2,
  environment: {
    MODEL_GATEWAY_URL: "http://127.0.0.1:15721",
    MODEL_GATEWAY_TOKEN: "gateway-token",
  },
  runAsNonRoot: true as const,
  readOnlyRootFilesystem: true as const,
  privileged: false as const,
  mountDockerSocket: false as const,
  mountHostClaudeConfig: false as const,
};

describe("Sandcastle implementation container", () => {
  it("resolves settings from runner-local convention with an optional local override", () => {
    const original = process.env.AFK_CLAUDE_SETTINGS;
    try {
      delete process.env.AFK_CLAUDE_SETTINGS;
      expect(containerClaudeSettingsPath(undefined, "/home/runner")).toBe(
        "/home/runner/.claude/settings-docker.json",
      );
      expect(containerClaudeSettingsPath("/etc/afk/claude.json", "/home/runner")).toBe(
        "/etc/afk/claude.json",
      );
    } finally {
      if (original === undefined) delete process.env.AFK_CLAUDE_SETTINGS;
      else process.env.AFK_CLAUDE_SETTINGS = original;
    }
  });

  it("builds a bounded invocation with worktree and controlled settings mounts", () => {
    const command = buildImplementationContainerCommand(
      "afk-delivery:test",
      "/etc/afk/settings-docker.json",
      invocation,
    );

    expect(command.file).toBe("docker");
    expect(command.args).toEqual(expect.arrayContaining([
      "run", "--rm", "--user", "agent", "--read-only", "--cpus", "2",
      "--mount", "type=bind,source=/worktrees/65,target=/workspace",
      "--mount", "type=bind,source=/etc/afk/settings-docker.json,target=/opt/afk-delivery/settings.json,readonly",
      "--workdir", "/workspace",
      "--env", "AFK_MODEL=claude-opus-5",
      "--env", "AFK_CONTEXT_WINDOW=1000000",
      "--env", "AFK_MAX_ITERATIONS=24",
      "afk-delivery:test",
    ]));
    expect(command.stdin).toBe("implement ticket");
    expect(command.timeoutMs).toBe(60_000);
    const serialized = command.args.join(" ");
    expect(serialized).toContain("--network host");
    expect(serialized).not.toContain("/var/run/docker.sock");
    expect(serialized).not.toContain("/home/canxer/.claude");
    expect(serialized).not.toContain(".config/gh");
    expect(serialized).not.toContain("--privileged");
    expect(serialized).not.toContain("GITHUB_TOKEN");
    expect(serialized).not.toContain("gateway-token");
    expect(command.redactedEnvironment).toEqual({
      MODEL_GATEWAY_URL: "http://127.0.0.1:15721",
      MODEL_GATEWAY_TOKEN: "[REDACTED]",
    });
  });

  it("redacts gateway secret values from captured output", () => {
    expect(redactSecretValues(
      "request failed for token gateway-secret and gateway-secret again",
      ["gateway-secret"],
    )).toBe("request failed for token [REDACTED] and [REDACTED] again");
  });

  it("rejects GitHub credentials embedded in the settings file", () => {
    expect(() => validateContainerClaudeSettings(JSON.stringify({
      model: "fable",
      env: { GITHUB_TOKEN: "secret" },
    }))).toThrow("container Claude settings must not contain GitHub credentials");
    expect(() => validateContainerClaudeSettings(JSON.stringify({
      model: "fable",
      env: { GH_TOKEN: "secret" },
    }))).toThrow("container Claude settings must not contain GitHub credentials");
  });

  it("accepts a container-specific settings policy", () => {
    expect(() => validateContainerClaudeSettings(JSON.stringify({
      model: "fable",
      env: {
        ANTHROPIC_BASE_URL: "http://127.0.0.1:15721",
        ANTHROPIC_AUTH_TOKEN: "PROXY_MANAGED",
        CLAUDE_CODE_MAX_CONTEXT_TOKENS: "372000",
      },
    }))).not.toThrow();
  });

  it("rejects forbidden credentials instead of silently forwarding them", () => {
    expect(() => buildImplementationContainerCommand(
      "afk-delivery:test",
      "/etc/afk/settings-docker.json",
      {
        ...invocation,
        environment: { GITHUB_TOKEN: "secret" },
      },
    )).toThrow("forbidden implementation-stage environment variable: GITHUB_TOKEN");
  });
});
