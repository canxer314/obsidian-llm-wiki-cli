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

  it("resumes the accumulating Spec branch and keeps the Spec relationship for a Spec child", async () => {
    const runAgent = vi.fn().mockResolvedValue({
      branch: "sandcastle/spec-226",
      commits: [{ sha: "abc123" }],
    });
    const session = createSandcastleImplementerSession({
      sandbox: { kind: "fake-sandbox" } as never,
      hooks: { sandbox: { onSandboxReady: [] } },
      runAgent: runAgent as never,
      createAgent: vi.fn().mockReturnValue({ name: "fake-agent" }) as never,
    });

    await session.run({
      model: "implementer-model",
      branch: "sandcastle/spec-226",
      plan,
      parentSpec: { number: 226 },
    });

    const request = runAgent.mock.calls[0]![0];
    expect(request.prompt).toContain("Spec #226");
    expect(request.prompt).toContain("git fetch origin sandcastle/spec-226");
    expect(request.prompt).toContain("git checkout -B sandcastle/spec-226 origin/sandcastle/spec-226");
    expect(request.prompt).toContain("Part of #226");
    expect(request.prompt).toContain("Do not rebase or force-push");
    expect(request.prompt).not.toContain("Closes #103");
  });

  it("inspects durable branch state and forbids unsafe history operations in the recovery prompt", async () => {
    const baseline = "a".repeat(40);
    const runAgent = vi.fn().mockResolvedValue({
      branch: "sandcastle/issue-103",
      commits: [],
    });
    const session = createSandcastleImplementerSession({
      sandbox: { kind: "fake-sandbox" } as never,
      hooks: { sandbox: { onSandboxReady: [] } },
      runAgent: runAgent as never,
      createAgent: vi.fn().mockReturnValue({ name: "fake-agent" }) as never,
    });

    await session.run({
      model: "implementer-model",
      branch: "sandcastle/issue-103",
      plan,
      checkoutPath: "/safe/disposable-checkout",
      recovery: { baseline },
    });

    const request = runAgent.mock.calls[0]![0];
    // The recovery prompt inspects the local branch, the remote branch, and
    // any existing Draft Pull Request before acting.
    expect(request.prompt).toContain("interrupted");
    expect(request.prompt).toContain(`frozen authorized base revision ${baseline}`);
    expect(request.prompt).toContain("git log sandcastle/issue-103");
    expect(request.prompt).toContain("git fetch origin sandcastle/issue-103");
    expect(request.prompt).toContain("gh pr list --head sandcastle/issue-103");
    // Later attempts never reset to the remote, rebase, force-push, merge
    // unknown concurrent work, or create a duplicate Pull Request.
    expect(request.prompt).toContain("Never reset the local branch to the remote branch");
    expect(request.prompt).toContain("never rebase");
    expect(request.prompt).toContain("never force-push");
    expect(request.prompt).toContain("never merge unknown concurrent work");
    expect(request.prompt).toContain("never create a second Pull Request");
    // The implementation instructions still apply: same plan, branch, push,
    // and Draft Pull Request behavior.
    expect(request.prompt).toContain(JSON.stringify(plan));
    expect(request.prompt).toContain("git push origin sandcastle/issue-103");
    expect(request.prompt).toContain("Closes #103");
  });

  it("inspects earlier children and forbids resetting the shared branch in a Spec-child recovery prompt", async () => {
    const baseline = "a".repeat(40);
    const runAgent = vi.fn().mockResolvedValue({
      branch: "sandcastle/spec-226",
      commits: [],
    });
    const session = createSandcastleImplementerSession({
      sandbox: { kind: "fake-sandbox" } as never,
      hooks: { sandbox: { onSandboxReady: [] } },
      runAgent: runAgent as never,
      createAgent: vi.fn().mockReturnValue({ name: "fake-agent" }) as never,
    });

    await session.run({
      model: "implementer-model",
      branch: "sandcastle/spec-226",
      plan,
      checkoutPath: "/safe/disposable-checkout",
      parentSpec: { number: 226 },
      recovery: { baseline },
    });

    const request = runAgent.mock.calls[0]![0];
    // The Spec-child recovery prompt identifies the child of the Spec, the
    // frozen shared-branch baseline, and the durable state to preserve:
    // earlier child implementations, current local commits, the remote shared
    // branch, and the single existing "Part of #226" Draft Pull Request.
    expect(request.prompt).toContain("child #103 of Spec #226");
    expect(request.prompt).toContain("shared accumulating branch sandcastle/spec-226");
    expect(request.prompt).toContain(`frozen shared-branch baseline ${baseline}`);
    expect(request.prompt).toContain("earlier child implementations");
    expect(request.prompt).toContain("git log sandcastle/spec-226");
    expect(request.prompt).toContain("git fetch origin sandcastle/spec-226");
    expect(request.prompt).toContain("gh pr list --head sandcastle/spec-226");
    expect(request.prompt).toContain("Part of #226");
    expect(request.prompt).toContain("Never reset the local branch to the remote branch");
    expect(request.prompt).toContain("never rebase");
    expect(request.prompt).toContain("never force-push");
    expect(request.prompt).toContain("never merge unknown concurrent work");
    expect(request.prompt).toContain("never create a second Pull Request");
    // The recovery prompt must not instruct the Agent to reset the local
    // branch to origin/sandcastle/spec-226: that would discard a valid
    // current-child commit left by the interrupted attempt.
    expect(request.prompt).not.toContain("git checkout -B sandcastle/spec-226 origin/sandcastle/spec-226");
    expect(request.prompt).not.toContain("Closes #103");
    expect(request.prompt).toContain("git push origin sandcastle/spec-226");
  });
});
