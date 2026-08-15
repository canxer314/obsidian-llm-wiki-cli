import { describe, expect, it } from "vitest";
import { redactSecretValues } from "../src/local-stage.js";
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
    MODEL_GATEWAY_URL: "http://host.docker.internal:3456",
    MODEL_GATEWAY_TOKEN: "gateway-token",
  },
  runAsNonRoot: true as const,
  readOnlyRootFilesystem: true as const,
  privileged: false as const,
  mountDockerSocket: false as const,
  mountHostClaudeConfig: false as const,
};

describe("Sandcastle implementation container", () => {
  it("builds a bounded non-root invocation with only the worktree mount", () => {
    const command = buildImplementationContainerCommand("afk-delivery:test", invocation);

    expect(command.file).toBe("docker");
    expect(command.args).toEqual(expect.arrayContaining([
      "run", "--rm", "--user", "agent", "--read-only", "--cpus", "2",
      "--mount", "type=bind,source=/worktrees/65,target=/workspace",
      "--workdir", "/workspace",
      "--env", "AFK_MODEL=claude-opus-5",
      "--env", "AFK_CONTEXT_WINDOW=1000000",
      "--env", "AFK_MAX_ITERATIONS=24",
      "afk-delivery:test",
    ]));
    expect(command.stdin).toBe("implement ticket");
    expect(command.timeoutMs).toBe(60_000);
    const serialized = command.args.join(" ");
    expect(serialized).not.toContain("/var/run/docker.sock");
    expect(serialized).not.toContain(".claude");
    expect(serialized).not.toContain(".config/gh");
    expect(serialized).not.toContain("--privileged");
    expect(serialized).not.toContain("GITHUB_TOKEN");
    expect(serialized).not.toContain("gateway-token");
    expect(command.redactedEnvironment).toEqual({
      MODEL_GATEWAY_URL: "http://host.docker.internal:3456",
      MODEL_GATEWAY_TOKEN: "[REDACTED]",
    });
  });

  it("redacts gateway secret values from captured output", () => {
    expect(redactSecretValues(
      "request failed for token gateway-secret and gateway-secret again",
      ["gateway-secret"],
    )).toBe("request failed for token [REDACTED] and [REDACTED] again");
  });

  it("rejects forbidden credentials instead of silently forwarding them", () => {
    expect(() => buildImplementationContainerCommand("afk-delivery:test", {
      ...invocation,
      environment: { GITHUB_TOKEN: "secret" },
    })).toThrow("forbidden implementation-stage environment variable: GITHUB_TOKEN");
  });
});
