import { Readable } from "node:stream";

import { describe, expect, it } from "vitest";

import {
  readTargetOperationStartup,
  readTargetWorkerStartup,
  targetOperationStartupSnapshot,
  targetWorkerStartup,
} from "../.sandcastle/target-operation-startup.js";

const snapshot = {
  imageName: "fixture-image",
  childEnvironments: {
    git: { PATH: "/git" },
    github: { GH_TOKEN: "github-secret" },
    claude: { ANTHROPIC_AUTH_TOKEN: "claude-secret" },
    githubAgent: {
      GH_TOKEN: "github-secret",
      ANTHROPIC_AUTH_TOKEN: "claude-secret",
    },
  },
  models: {
    default: "default-model",
    planner: "planner-model",
    implementer: "implementer-model",
    reviewer: "reviewer-model",
  },
} as const;

describe("Target operation startup", () => {
  it("hydrates the trusted round snapshot received through stdin", async () => {
    const startup = await readTargetOperationStartup(
      Readable.from([JSON.stringify(snapshot)]),
    );

    expect(startup.snapshot).toEqual(snapshot);
    expect(startup.serialized).toBe(JSON.stringify(snapshot));
  });

  it("derives purpose-specific descendant worker snapshots", async () => {
    const claudeOnly = targetWorkerStartup(snapshot, "claude-only");
    const githubAgent = targetWorkerStartup(snapshot, "github-agent");
    const implementation = targetWorkerStartup(snapshot, "github-agent-with-cli");

    expect(claudeOnly).toContain("claude-secret");
    expect(claudeOnly).not.toContain("github-secret");
    expect(githubAgent).toContain("github-secret");
    expect(githubAgent).not.toContain("PATH");
    expect(implementation).toContain("githubEnvironment");
    await expect(readTargetWorkerStartup(Readable.from([claudeOnly]))).resolves.toHaveProperty("sandbox");
  });

  it("fails closed instead of reloading private configuration when stdin is empty", async () => {
    await expect(readTargetOperationStartup(Readable.from([]))).rejects.toThrow(
      "Target operation startup snapshot is missing",
    );
  });

  it("requires every purpose-specific environment and model", () => {
    expect(() => targetOperationStartupSnapshot({
      ...snapshot,
      childEnvironments: {
        git: snapshot.childEnvironments.git,
        github: snapshot.childEnvironments.github,
        githubAgent: snapshot.childEnvironments.githubAgent,
      },
    })).toThrow("Target operation startup snapshot is invalid");
    expect(() => targetOperationStartupSnapshot({
      ...snapshot,
      models: { planner: "planner-model" },
    })).toThrow("Target operation startup snapshot is invalid");
  });
});
