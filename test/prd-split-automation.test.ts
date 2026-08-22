import { describe, expect, it, vi } from "vitest";

import { runPrdSplitAutomationCommand } from "../.sandcastle/prd-split-automation.js";

const revision = "0123456789abcdef0123456789abcdef01234567";

function prd(overrides = {}) {
  return {
    number: 223,
    title: "Split a PRD",
    state: "OPEN",
    labels: ["agent:to-issues"],
    baseRevision: revision,
    subIssueCount: 0,
    ...overrides,
  };
}

describe("PRD split automation command", () => {
  it("acquires an eligible PRD, splits it in its authorized checkout, and publishes children", async () => {
    const events: string[] = [];
    const github = {
      readPrd: vi.fn().mockResolvedValue(prd()),
      addIssueLabel: vi.fn(async (_number: number, label: string) => events.push(`add:${label}`)),
      removeIssueLabel: vi.fn(async (_number: number, label: string) => events.push(`remove:${label}`)),
    };
    const slices = [{ title: "Create a vertical slice", whatToBuild: "Deliver one complete path.", acceptanceCriteria: ["It works"] }];

    await expect(runPrdSplitAutomationCommand({ issueNumber: 223 }, {
      github,
      checkout: { withCheckout: vi.fn(async (request, action) => {
        events.push(`checkout:${request.revision}`);
        return action("/safe/disposable-checkout");
      }) },
      splitter: { split: vi.fn(async (request) => {
        events.push(`split:${request.prdNumber}:${request.title}`);
        return slices;
      }) },
      publisher: { publishPrdSplit: vi.fn(async (request) => {
        events.push(`publish:${request.prdNumber}:${request.slices.length}`);
        return [301];
      }) },
    })).resolves.toEqual({ status: "split", childIssueNumbers: [301] });

    expect(events).toEqual([
      "add:agent:in-progress",
      "remove:agent:to-issues",
      `checkout:${revision}`,
      "split:223:Split a PRD",
      "publish:223:1",
      "remove:agent:in-progress",
    ]);
  });

  it("refuses a PRD that already has children without executing or blocking it", async () => {
    const github = {
      readPrd: vi.fn().mockResolvedValue(prd({ subIssueCount: 1 })),
      addIssueLabel: vi.fn(),
      removeIssueLabel: vi.fn(),
      addRefusalDiagnostic: vi.fn(),
    };
    const splitter = { split: vi.fn() };

    await expect(runPrdSplitAutomationCommand({ issueNumber: 223 }, {
      github,
      checkout: { withCheckout: vi.fn() },
      splitter,
      publisher: { publishPrdSplit: vi.fn() },
    })).resolves.toEqual({ status: "refused", reason: "Issue #223 already has 1 sub-issue(s)" });

    expect(splitter.split).not.toHaveBeenCalled();
    expect(github.addIssueLabel).not.toHaveBeenCalled();
    expect(github.removeIssueLabel).toHaveBeenCalledWith(223, "agent:to-issues");
  });

  it("blocks partial publication without rerunning the produce pass", async () => {
    const splitter = { split: vi.fn().mockResolvedValue([{ title: "Slice", whatToBuild: "Build it.", acceptanceCriteria: ["It works"] }]) };
    const github = {
      readPrd: vi.fn().mockResolvedValue(prd()),
      addIssueLabel: vi.fn().mockResolvedValue(undefined),
      removeIssueLabel: vi.fn().mockResolvedValue(undefined),
      addSplitBlockedDiagnostic: vi.fn().mockResolvedValue(undefined),
    };

    await expect(runPrdSplitAutomationCommand({ issueNumber: 223 }, {
      github,
      checkout: { withCheckout: vi.fn(async (_request, action) => action("/safe/disposable-checkout")) },
      splitter,
      publisher: { publishPrdSplit: vi.fn().mockRejectedValue(new Error("Second child publication failed")) },
      createJobId: () => "job-223",
    })).resolves.toEqual({ status: "blocked", reason: "prd-split-execution", jobId: "job-223" });

    expect(splitter.split).toHaveBeenCalledTimes(1);
    expect(github.addIssueLabel).toHaveBeenCalledWith(223, "agent:blocked");
  });

  it("blocks execution failures and always clears visible acquisition", async () => {
    const events: string[] = [];
    const github = {
      readPrd: vi.fn().mockResolvedValue(prd()),
      addIssueLabel: vi.fn(async (_number: number, label: string) => events.push(`add:${label}`)),
      removeIssueLabel: vi.fn(async (_number: number, label: string) => events.push(`remove:${label}`)),
      addSplitBlockedDiagnostic: vi.fn(async (_number: number, diagnostic) => events.push(`blocked:${diagnostic.jobId}`)),
    };

    await expect(runPrdSplitAutomationCommand({ issueNumber: 223 }, {
      github,
      checkout: { withCheckout: vi.fn(async (_request, action) => action("/safe/disposable-checkout")) },
      splitter: { split: vi.fn().mockRejectedValue(new Error("Agent execution failed")) },
      publisher: { publishPrdSplit: vi.fn() },
      createJobId: () => "job-223",
    })).resolves.toEqual({ status: "blocked", reason: "prd-split-execution", jobId: "job-223" });

    expect(events).toEqual([
      "add:agent:in-progress",
      "remove:agent:to-issues",
      "add:agent:blocked",
      "blocked:job-223",
      "remove:agent:in-progress",
    ]);
  });

  it("blocks the PRD and retains the local job reference when the split job times out", async () => {
    const events: string[] = [];
    const github = {
      readPrd: vi.fn().mockResolvedValue(prd()),
      addIssueLabel: vi.fn(async (_number: number, label: string) => events.push(`add:${label}`)),
      removeIssueLabel: vi.fn(async (_number: number, label: string) => events.push(`remove:${label}`)),
      addSplitBlockedDiagnostic: vi.fn(async (_number: number, diagnostic) => events.push(`blocked:${diagnostic.jobId}`)),
    };
    const publisher = { publishPrdSplit: vi.fn() };

    await expect(runPrdSplitAutomationCommand({ issueNumber: 223 }, {
      github,
      checkout: { withCheckout: vi.fn(async (_request, action) => action("/safe/disposable-checkout")) },
      splitter: { split: vi.fn().mockRejectedValue(new Error("PRD split execution timed out")) },
      publisher,
      createJobId: () => "job-223",
    })).resolves.toEqual({ status: "blocked", reason: "prd-split-execution", jobId: "job-223" });

    expect(publisher.publishPrdSplit).not.toHaveBeenCalled();
    expect(events).toEqual([
      "add:agent:in-progress",
      "remove:agent:to-issues",
      "add:agent:blocked",
      "blocked:job-223",
      "remove:agent:in-progress",
    ]);
  });
});
