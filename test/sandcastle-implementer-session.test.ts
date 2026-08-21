import { describe, expect, it, vi } from "vitest";

import {
  createSandcastleImplementerSession,
} from "../.sandcastle/implementer-session.js";

const plan = {
  status: "ready" as const,
  implementationSummary: "Implement the requested behavior.",
  blockingReason: null,
  allowsAutomationChanges: false,
  issue: {
    number: 103,
    title: "Implementer",
    body: "Implement this Issue.",
    labels: ["Sandcastle"],
    comments: [{ author: "maintainer", body: "Keep it minimal." }],
  },
};

describe("Sandcastle Implementer session adapter", () => {
  it("runs a fresh Implementer session on the deterministic Issue branch", async () => {
    const runAgent = vi.fn().mockResolvedValue({
      branch: "sandcastle/issue-103",
      commits: [{ sha: "abc123" }],
    });
    const createAgent = vi.fn().mockReturnValue({ name: "fake-agent" });
    const sandbox = { kind: "fake-sandbox" };
    const hooks = { sandbox: { onSandboxReady: [] } };
    const session = createSandcastleImplementerSession({
      sandbox: sandbox as never,
      hooks,
      runAgent: runAgent as never,
      createAgent: createAgent as never,
    });

    await expect(session.run({
      model: "implementer-model",
      branch: "sandcastle/issue-103",
      plan,
    })).resolves.toEqual({
      branch: "sandcastle/issue-103",
      commits: [{ sha: "abc123" }],
    });

    expect(runAgent).toHaveBeenCalledOnce();
    expect(runAgent).toHaveBeenCalledWith(expect.objectContaining({
      sandbox,
      hooks,
      branchStrategy: {
        type: "branch",
        branch: "sandcastle/issue-103",
      },
      maxIterations: 1,
      name: "implementer-issue-103",
    }));
    expect(createAgent).toHaveBeenCalledWith("implementer-model");
    const request = runAgent.mock.calls[0]![0];
    expect(request.prompt).toContain(JSON.stringify(plan));
    expect(request.prompt).toContain("gh auth setup-git");
    expect(request.prompt).toContain("git push origin sandcastle/issue-103");
    expect(request.prompt).toContain("--draft");
    expect(request.prompt).toContain("Closes #103");
    expect(request.prompt).toContain("Do not rebase or force-push");
    expect(request.prompt).toContain("Do not modify .sandcastle/ or .github/workflows/");
  });

  it("runs a fresh bounded repair session without creating another Pull Request", async () => {
    const runAgent = vi.fn().mockResolvedValue({
      branch: "sandcastle/issue-103",
      commits: [{ sha: "def456" }],
    });
    const evidence = { record: vi.fn() };
    const signal = new AbortController().signal;
    const execution = { runId: "run-1", batchId: 1, issueNumber: 103, signal };
    const repairHooks = { sandbox: { onSandboxReady: [{ command: "repair" }] } };
    const session = createSandcastleImplementerSession({
      sandbox: { kind: "fake-sandbox" } as never,
      hooks: { sandbox: { onSandboxReady: [] } },
      repairHooks,
      runAgent: runAgent as never,
      createAgent: vi.fn().mockReturnValue({ name: "fake-agent" }) as never,
      evidence: evidence as never,
      execution,
    });

    await session.run({
      model: "implementer-model",
      branch: "sandcastle/issue-103",
      plan,
      repair: {
        attempt: 2,
        pullRequestNumber: 321,
        revision: "a".repeat(40),
        feedback: {
          source: "review",
          summary: "Changes are required.",
          findings: [{ summary: "Fix this", details: "Handle the edge case." }],
        },
      },
    });

    const request = runAgent.mock.calls[0]![0];
    expect(request.signal).toBe(signal);
    expect(request.name).toBe("implementer-repair-issue-103-attempt-2");
    expect(request.hooks).toBe(repairHooks);
    expect(request.prompt).toContain("repair attempt 2 of 2");
    expect(request.prompt).toContain("a".repeat(40));
    expect(request.prompt).toContain("Handle the edge case.");
    expect(request.prompt).toContain("git push origin sandcastle/issue-103");
    expect(request.prompt).toContain("Do not create another Pull Request");
    expect(request.prompt).not.toContain("gh pr create");
    expect(evidence.record).toHaveBeenNthCalledWith(1, expect.objectContaining({
      kind: "session-started", runId: execution.runId, batchId: execution.batchId,
      issueNumber: execution.issueNumber, role: "implementer", stage: "repair",
      attempt: 2, sessionName: request.name, pullRequestNumber: 321,
      revision: "a".repeat(40), timestamp: expect.any(String),
    }));
    expect(evidence.record).toHaveBeenNthCalledWith(2, expect.objectContaining({
      kind: "session-finished", outcome: "completed", durationMs: expect.any(Number),
    }));
  });
});
