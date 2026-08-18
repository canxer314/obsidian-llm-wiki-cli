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
        baseBranch: "origin/sandcastle/issue-103",
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
});
