import { describe, expect, it, vi } from "vitest";

import { runImplementationAutomationCommand } from "../.sandcastle/implementation-automation.js";

const revision = "0123456789abcdef0123456789abcdef01234567";

describe("implementation automation command", () => {
  it("acquires an eligible Issue and runs the Implementer in a Target Checkout at its authorized base revision", async () => {
    const events: string[] = [];
    const github = {
      readIssue: vi.fn().mockResolvedValue({
        number: 221,
        state: "OPEN",
        labels: ["agent:implement"],
        baseRevision: revision,
      }),
      addIssueLabel: vi.fn(async (_number: number, label: string) => events.push(`add:${label}`)),
      removeIssueLabel: vi.fn(async (_number: number, label: string) => events.push(`remove:${label}`)),
    };
    const checkout = {
      withCheckout: vi.fn(async (request, action) => {
        events.push(`checkout:${request.revision}`);
        return action("/safe/disposable-checkout");
      }),
    };
    const implementer = {
      implement: vi.fn(async (request) => {
        events.push(`implement:${request.baseRevision}`);
        expect(request.checkoutPath).toBe("/safe/disposable-checkout");
        return { branch: "sandcastle/issue-221", pullRequestUrl: "https://example.test/pr/221" };
      }),
    };

    await expect(runImplementationAutomationCommand({ issueNumber: 221 }, {
      github,
      checkout,
      implementer,
    })).resolves.toEqual({
      status: "implemented",
      branch: "sandcastle/issue-221",
      pullRequestUrl: "https://example.test/pr/221",
    });

    expect(events).toEqual([
      "add:agent:in-progress",
      "remove:agent:implement",
      `checkout:${revision}`,
      `implement:${revision}`,
      "remove:agent:in-progress",
    ]);
    expect(github.addIssueLabel).not.toHaveBeenCalledWith(221, "agent:blocked");
  });

  it("refuses an inapplicable Issue without mutating it or blocking automation", async () => {
    const github = {
      readIssue: vi.fn().mockResolvedValue({
        number: 221,
        state: "OPEN",
        labels: [],
        baseRevision: revision,
      }),
      addIssueLabel: vi.fn(),
      removeIssueLabel: vi.fn(),
      addRefusalDiagnostic: vi.fn(),
    };

    await expect(runImplementationAutomationCommand({ issueNumber: 221 }, {
      github,
      checkout: { withCheckout: vi.fn() },
      implementer: { implement: vi.fn() },
    })).resolves.toEqual({ status: "refused", reason: "Issue #221 is not queued for implementation" });

    expect(github.addIssueLabel).not.toHaveBeenCalled();
    expect(github.removeIssueLabel).not.toHaveBeenCalled();
    expect(github.addRefusalDiagnostic).toHaveBeenCalledWith(221, "Issue #221 is not queued for implementation");
  });

  it("reuses an existing upstream-equivalent Draft Pull Request after the trigger label was removed", async () => {
    const github = {
      readIssue: vi.fn().mockResolvedValue({ number: 221, state: "OPEN", labels: [], baseRevision: revision }),
      addIssueLabel: vi.fn().mockResolvedValue(undefined),
      removeIssueLabel: vi.fn().mockResolvedValue(undefined),
      findReusableImplementation: vi.fn().mockResolvedValue({
        branch: "sandcastle/issue-221",
        pullRequestUrl: "https://example.test/pr/221",
      }),
    };
    const checkout = { withCheckout: vi.fn() };
    const implementer = { implement: vi.fn() };

    await expect(runImplementationAutomationCommand({ issueNumber: 221 }, {
      github,
      checkout,
      implementer,
    })).resolves.toEqual({
      status: "implemented",
      branch: "sandcastle/issue-221",
      pullRequestUrl: "https://example.test/pr/221",
    });

    expect(github.findReusableImplementation).toHaveBeenCalledWith({
      issueNumber: 221,
      branch: "sandcastle/issue-221",
    });
    expect(checkout.withCheckout).not.toHaveBeenCalled();
    expect(implementer.implement).not.toHaveBeenCalled();
  });

  it("blocks an acquired Issue when execution or publication fails and preserves the job diagnostic", async () => {
    const events: string[] = [];
    const github = {
      readIssue: vi.fn().mockResolvedValue({ number: 221, state: "OPEN", labels: ["agent:implement"], baseRevision: revision }),
      addIssueLabel: vi.fn(async (_number: number, label: string) => events.push(`add:${label}`)),
      removeIssueLabel: vi.fn(async (_number: number, label: string) => events.push(`remove:${label}`)),
      addImplementationBlockedDiagnostic: vi.fn(async (_number: number, diagnostic) => events.push(`blocked:${diagnostic.jobId}`)),
    };

    await expect(runImplementationAutomationCommand({ issueNumber: 221 }, {
      github,
      checkout: { withCheckout: vi.fn(async (_request, action) => action("/safe/disposable-checkout")) },
      implementer: { implement: vi.fn().mockRejectedValue(new Error("push failed")) },
      createJobId: () => "job-221",
    })).resolves.toEqual({ status: "blocked", reason: "implementation-execution", jobId: "job-221" });

    expect(events).toEqual([
      "add:agent:in-progress",
      "remove:agent:implement",
      "add:agent:blocked",
      "blocked:job-221",
      "remove:agent:in-progress",
    ]);
  });
});
