import { describe, expect, it, vi } from "vitest";

import { runSpecSplitAutomationCommand } from "../.sandcastle/spec-split-automation.js";

const revision = "0123456789abcdef0123456789abcdef01234567";

function spec(overrides = {}) {
  return {
    number: 223,
    title: "Split a Spec",
    state: "OPEN",
    labels: ["agent:to-tickets"],
    baseRevision: revision,
    subIssueCount: 0,
    ...overrides,
  };
}

// Mirrors the label lifecycle: the post-claim re-read observes the labels that
// the add/remove calls actually published.
function claimedGithub(events: string[], extras = {}) {
  const labels = new Set(["agent:to-tickets"]);
  return {
    readSpec: vi.fn(async () => spec({ labels: [...labels] })),
    addIssueLabel: vi.fn(async (_number: number, label: string) => {
      labels.add(label);
      events.push(`add:${label}`);
    }),
    removeIssueLabel: vi.fn(async (_number: number, label: string) => {
      labels.delete(label);
      events.push(`remove:${label}`);
    }),
    ...extras,
  };
}

describe("Spec split automation command", () => {
  it("acquires an eligible Spec, splits it in its authorized checkout, and publishes children", async () => {
    const events: string[] = [];
    const github = claimedGithub(events);
    const slices = [{ title: "Create a vertical slice", whatToBuild: "Deliver one complete path.", acceptanceCriteria: ["It works"] }];

    await expect(runSpecSplitAutomationCommand({ issueNumber: 223 }, {
      github,
      checkout: { withCheckout: vi.fn(async (request, action) => {
        events.push(`checkout:${request.revision}`);
        return action("/safe/disposable-checkout");
      }) },
      splitter: { split: vi.fn(async (request) => {
        events.push(`split:${request.specNumber}:${request.title}`);
        return slices;
      }) },
      publisher: { publishSpecSplit: vi.fn(async (request) => {
        events.push(`publish:${request.specNumber}:${request.slices.length}`);
        return [301];
      }) },
    })).resolves.toEqual({ status: "split", childIssueNumbers: [301] });

    expect(events).toEqual([
      "add:agent:in-progress",
      "remove:agent:to-tickets",
      `checkout:${revision}`,
      "split:223:Split a Spec",
      "publish:223:1",
      "remove:agent:in-progress",
    ]);
  });

  it("refuses a Spec that already has children without executing or blocking it", async () => {
    const github = {
      readSpec: vi.fn().mockResolvedValue(spec({ subIssueCount: 1 })),
      addIssueLabel: vi.fn(),
      removeIssueLabel: vi.fn(),
      addRefusalDiagnostic: vi.fn(),
    };
    const splitter = { split: vi.fn() };

    await expect(runSpecSplitAutomationCommand({ issueNumber: 223 }, {
      github,
      checkout: { withCheckout: vi.fn() },
      splitter,
      publisher: { publishSpecSplit: vi.fn() },
    })).resolves.toEqual({ status: "refused", reason: "Issue #223 already has 1 sub-issue(s)" });

    expect(splitter.split).not.toHaveBeenCalled();
    expect(github.addIssueLabel).not.toHaveBeenCalled();
    expect(github.removeIssueLabel).toHaveBeenCalledWith(223, "agent:to-tickets");
  });

  it("blocks partial publication without rerunning the produce pass", async () => {
    const splitter = { split: vi.fn().mockResolvedValue([{ title: "Slice", whatToBuild: "Build it.", acceptanceCriteria: ["It works"] }]) };
    const github = claimedGithub([], {
      addSplitBlockedDiagnostic: vi.fn().mockResolvedValue(undefined),
    });

    await expect(runSpecSplitAutomationCommand({ issueNumber: 223 }, {
      github,
      checkout: { withCheckout: vi.fn(async (_request, action) => action("/safe/disposable-checkout")) },
      splitter,
      publisher: { publishSpecSplit: vi.fn().mockRejectedValue(new Error("Second child publication failed")) },
      createJobId: () => "job-223",
    })).resolves.toEqual({ status: "blocked", reason: "spec-split-execution", jobId: "job-223" });

    expect(splitter.split).toHaveBeenCalledTimes(1);
    expect(github.addIssueLabel).toHaveBeenCalledWith(223, "agent:blocked");
  });

  it("blocks execution failures and always clears visible acquisition", async () => {
    const events: string[] = [];
    const github = claimedGithub(events, {
      addSplitBlockedDiagnostic: vi.fn(async (_number: number, diagnostic) => events.push(`blocked:${diagnostic.jobId}`)),
    });

    await expect(runSpecSplitAutomationCommand({ issueNumber: 223 }, {
      github,
      checkout: { withCheckout: vi.fn(async (_request, action) => action("/safe/disposable-checkout")) },
      splitter: { split: vi.fn().mockRejectedValue(new Error("Agent execution failed")) },
      publisher: { publishSpecSplit: vi.fn() },
      createJobId: () => "job-223",
    })).resolves.toEqual({ status: "blocked", reason: "spec-split-execution", jobId: "job-223" });

    expect(events).toEqual([
      "add:agent:in-progress",
      "remove:agent:to-tickets",
      "add:agent:blocked",
      "blocked:job-223",
      "remove:agent:in-progress",
    ]);
  });

  it("blocks when the Spec target changes while splitting is being acquired", async () => {
    const events: string[] = [];
    const github = claimedGithub(events, {
      addSplitBlockedDiagnostic: vi.fn(async (_number: number, diagnostic) => events.push(`blocked:${diagnostic.jobId}`)),
    });
    github.readSpec
      .mockResolvedValueOnce(spec())
      .mockResolvedValueOnce(spec({
        labels: ["agent:in-progress"],
        baseRevision: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      }));
    const splitter = { split: vi.fn() };
    const checkout = { withCheckout: vi.fn() };

    await expect(runSpecSplitAutomationCommand({ issueNumber: 223 }, {
      github,
      checkout,
      splitter,
      publisher: { publishSpecSplit: vi.fn() },
      createJobId: () => "job-223",
    })).resolves.toEqual({ status: "blocked", reason: "spec-split-execution", jobId: "job-223" });

    expect(checkout.withCheckout).not.toHaveBeenCalled();
    expect(splitter.split).not.toHaveBeenCalled();
    expect(github.addIssueLabel).toHaveBeenCalledWith(223, "agent:blocked");
    expect(github.removeIssueLabel).toHaveBeenCalledWith(223, "agent:in-progress");
  });

  it("blocks the Spec and retains the local job reference when the split job times out", async () => {
    const events: string[] = [];
    const github = claimedGithub(events, {
      addSplitBlockedDiagnostic: vi.fn(async (_number: number, diagnostic) => events.push(`blocked:${diagnostic.jobId}`)),
    });
    const publisher = { publishSpecSplit: vi.fn() };

    await expect(runSpecSplitAutomationCommand({ issueNumber: 223 }, {
      github,
      checkout: { withCheckout: vi.fn(async (_request, action) => action("/safe/disposable-checkout")) },
      splitter: { split: vi.fn().mockRejectedValue(new Error("Spec split execution timed out")) },
      publisher,
      createJobId: () => "job-223",
    })).resolves.toEqual({ status: "blocked", reason: "spec-split-execution", jobId: "job-223" });

    expect(publisher.publishSpecSplit).not.toHaveBeenCalled();
    expect(events).toEqual([
      "add:agent:in-progress",
      "remove:agent:to-tickets",
      "add:agent:blocked",
      "blocked:job-223",
      "remove:agent:in-progress",
    ]);
  });
});
