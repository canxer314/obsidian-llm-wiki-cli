import { describe, expect, it } from "vitest";
import {
  runConflictResolutionStage,
  type ConflictResolutionStagePorts,
} from "../src/conflict-resolution.js";

const HEAD = "a".repeat(40);
const TARGET = "b".repeat(40);
const OUTPUT = "c".repeat(40);

const request = {
  repository: "owner/repo",
  ticket: {
    number: 66,
    open: true,
    labels: ["ready-for-agent"],
    openBlockerNumbers: [],
    dependencyDataComplete: true,
    body: "Preserve the continuation semantics",
  },
  prNumber: 73,
  headBranch: "afk/ticket-66",
  expectedHeadRevision: HEAD,
  targetRevision: TARGET,
  conflicts: [{ path: "src/index.ts", ours: "feature side", theirs: "master side" }],
  controlComments: [{
    commentId: "managed-1",
    author: { login: "delivery-bot", type: "Bot" as const },
    envelope: { kind: "managed-pr" },
    narrative: "Trusted history",
  }],
  policy: {
    model: "fable",
    contextWindow: 372000,
    maximumIterations: 8,
    timeoutMs: 900000,
    cpuLimit: 2,
  },
};

function ports(): { value: ConflictResolutionStagePorts; invocations: unknown[] } {
  const invocations: unknown[] = [];
  return {
    invocations,
    value: {
      createWorktree: async () => ({ path: "/worktree", branch: request.headBranch, baseRevision: HEAD }),
      runAgent: async (invocation) => {
        invocations.push(invocation);
        return { exitCode: 0, stdout: "Resolved conflict", stderr: "" };
      },
      resolveHeadRevision: async () => OUTPUT,
      pushResolvedRevision: async (input) => {
        invocations.push(input);
      },
      removeWorktree: async () => {},
    },
  };
}

describe("conflict resolution stage", () => {
  it("supplies both conflict sides and trusted history to one isolated bounded agent", async () => {
    const fake = ports();

    await expect(runConflictResolutionStage(request, fake.value)).resolves.toEqual({
      status: "succeeded",
      outputRevision: OUTPUT,
      narrative: "Resolved conflict",
    });
    expect(fake.invocations[0]).toMatchObject({
      worktreePath: "/worktree",
      model: "fable",
      maximumIterations: 8,
      environment: {},
      runAsNonRoot: true,
      readOnlyRootFilesystem: true,
      privileged: false,
      mountDockerSocket: false,
      mountHostClaudeConfig: false,
    });
    const prompt = (fake.invocations[0] as { prompt: string }).prompt;
    expect(prompt).toContain("Preserve the continuation semantics");
    expect(prompt).toContain("feature side");
    expect(prompt).toContain("master side");
    expect(prompt).toContain("Trusted history");
    expect(fake.invocations[1]).toEqual({
      worktreePath: "/worktree",
      branch: request.headBranch,
      expectedHeadRevision: HEAD,
      outputRevision: OUTPUT,
    });
  });

  it("rejects a successful agent that produces no new Revision", async () => {
    const fake = ports();
    fake.value.resolveHeadRevision = async () => HEAD;
    await expect(runConflictResolutionStage(request, fake.value)).resolves.toMatchObject({
      status: "failed",
      reason: "conflict resolution produced no new Revision",
    });
  });
});
