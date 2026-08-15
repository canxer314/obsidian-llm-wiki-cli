import { describe, expect, it } from "vitest";
import {
  runImplementationStage,
  type ImplementationStagePorts,
  type ImplementationStageRequest,
} from "../src/implementation.js";

const request: ImplementationStageRequest = {
  repository: "canxer314/obsidian-llm-wiki-cli",
  ticket: {
    number: 65,
    title: "Implement a Delivery Ticket as a Managed PR",
    body: "Complete ticket specification",
  },
  repositoryInstructions: [
    { path: "CLAUDE.md", content: "Repository policy" },
  ],
  domainDocuments: [
    { path: "docs/contexts/afk-delivery/CONTEXT.md", content: "Delivery vocabulary" },
  ],
  architectureDecisions: [
    { path: "docs/adr/0001.md", content: "GitHub is durable state" },
  ],
  targetBranch: "master",
  validationCommands: ["npm run typecheck", "npm test -- --run"],
  transitionId: "afk-v1-test",
  policy: {
    model: "claude-opus-5",
    contextWindow: 1_000_000,
    maximumIterations: 24,
    timeoutMs: 60_000,
    cpuLimit: 2,
  },
};

describe("implementation stage", () => {
  it("supplies complete trusted context to an isolated bounded agent stage", async () => {
    const invocations: Parameters<ImplementationStagePorts["runAgent"]>[0][] = [];
    const ports: ImplementationStagePorts = {
      createWorktree: async () => ({
        path: "/worktrees/issue-65",
        branch: "afk/ticket-65-afk-v1-test",
        baseRevision: "a".repeat(40),
      }),
      runAgent: async (invocation) => {
        invocations.push(invocation);
        return { exitCode: 0, stdout: "implemented", stderr: "" };
      },
      resolveHeadRevision: async () => "b".repeat(40),
      removeWorktree: async () => undefined,
    };

    await expect(runImplementationStage(request, ports)).resolves.toEqual({
      status: "succeeded",
      branch: "afk/ticket-65-afk-v1-test",
      baseRevision: "a".repeat(40),
      outputRevision: "b".repeat(40),
      narrative: "implemented",
    });

    expect(invocations).toHaveLength(1);
    expect(invocations[0]).toMatchObject({
      worktreePath: "/worktrees/issue-65",
      model: "claude-opus-5",
      contextWindow: 1_000_000,
      maximumIterations: 24,
      timeoutMs: 60_000,
      cpuLimit: 2,
      runAsNonRoot: true,
      readOnlyRootFilesystem: true,
      privileged: false,
      mountDockerSocket: false,
      mountHostClaudeConfig: false,
    });
    expect(invocations[0]?.environment).toEqual({});
    expect(invocations[0]?.prompt).toContain("Complete ticket specification");
    expect(invocations[0]?.prompt).toContain("Repository policy");
    expect(invocations[0]?.prompt).toContain("Delivery vocabulary");
    expect(invocations[0]?.prompt).toContain("GitHub is durable state");
    expect(invocations[0]?.prompt).toContain("Target branch: master");
    expect(invocations[0]?.prompt).toContain("npm run typecheck");
    expect(invocations[0]?.prompt).toContain("/implement");
  });

  it("rejects a completed stage with no implementation commit", async () => {
    const removed: string[] = [];
    const ports: ImplementationStagePorts = {
      createWorktree: async () => ({
        path: "/worktrees/no-commit",
        branch: "afk/ticket-65-afk-v1-test",
        baseRevision: "a".repeat(40),
      }),
      runAgent: async () => ({ exitCode: 0, stdout: "No changes needed", stderr: "" }),
      resolveHeadRevision: async () => "a".repeat(40),
      removeWorktree: async (worktree) => { removed.push(worktree.path); },
    };

    await expect(runImplementationStage(request, ports)).resolves.toEqual({
      status: "failed",
      reason: "implementation stage produced no commit",
      narrative: "No changes needed",
    });
    expect(removed).toEqual(["/worktrees/no-commit"]);
  });

  it("captures failures and redacts secrets from agent output", async () => {
    const ports: ImplementationStagePorts = {
      createWorktree: async () => ({
        path: "/worktrees/failed",
        branch: "afk/ticket-65-afk-v1-test",
        baseRevision: "a".repeat(40),
      }),
      runAgent: async () => ({
        exitCode: 7,
        stdout: "Authorization: Bearer secret-value",
        stderr: "token github_pat_abcdefghijklmnopqrstuvwxyz",
      }),
      resolveHeadRevision: async () => { throw new Error("should not inspect a failed stage"); },
      removeWorktree: async () => undefined,
    };

    await expect(runImplementationStage(request, ports)).resolves.toEqual({
      status: "failed",
      reason: "implementation agent exited with 7",
      narrative: "Authorization: [REDACTED]\ntoken [REDACTED]",
    });
  });

  it("reports a timed-out agent and still removes its worktree", async () => {
    const removed: string[] = [];
    const ports: ImplementationStagePorts = {
      createWorktree: async () => ({
        path: "/worktrees/timed-out",
        branch: "afk/ticket-65-afk-v1-test",
        baseRevision: "a".repeat(40),
      }),
      runAgent: async () => { throw new DOMException("timed out", "TimeoutError"); },
      resolveHeadRevision: async () => { throw new Error("should not inspect a timed-out stage"); },
      removeWorktree: async (worktree) => { removed.push(worktree.path); },
    };

    await expect(runImplementationStage(request, ports)).resolves.toEqual({
      status: "failed",
      reason: "implementation agent timed out after 60000ms",
      narrative: "",
    });
    expect(removed).toEqual(["/worktrees/timed-out"]);
  });
});
