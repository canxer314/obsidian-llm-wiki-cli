import { describe, expect, it, vi } from "vitest";

import { runReviewAutomationCommand } from "../.sandcastle/review-automation.js";

const revision = "0123456789abcdef0123456789abcdef01234567";
const lease = { acquire: vi.fn(async () => ({ release: async () => {} })) };

describe("review automation command", () => {
  it("acquires an eligible Draft Pull Request and publishes a review for its acquired revision", async () => {
    const events: string[] = [];
    const github = {
      readPullRequest: vi.fn()
        .mockResolvedValueOnce({
          number: 220,
          state: "OPEN",
          isDraft: true,
          baseRepository: "canxer314/obsidian-llm-wiki-cli",
          headRepository: "canxer314/obsidian-llm-wiki-cli",
          headSha: revision,
          labels: ["agent:review"],
        })
        .mockResolvedValueOnce({
          number: 220,
          state: "OPEN",
          isDraft: true,
          baseRepository: "canxer314/obsidian-llm-wiki-cli",
          headRepository: "canxer314/obsidian-llm-wiki-cli",
          headSha: revision,
          labels: ["agent:review", "agent:in-progress"],
        }),
      addPullRequestLabel: vi.fn(async (_number: number, label: string) => {
        events.push(`add:${label}`);
      }),
      removePullRequestLabel: vi.fn(async (_number: number, label: string) => {
        events.push(`remove:${label}`);
      }),
    };
    const checkout = {
      withCheckout: vi.fn(async (request, action) => {
        events.push(`checkout:${request.revision}`);
        return action("/safe/disposable-checkout");
      }),
    };
    const reviewer = {
      review: vi.fn(async (request) => {
        events.push(`review:${request.revision}`);
        return { verdict: "Approved" as const, summary: "Looks good.", findings: [] };
      }),
    };
    const publisher = {
      publish: vi.fn(async (request) => {
        events.push(`publish:${request.revision}`);
      }),
    };

    await expect(runReviewAutomationCommand({ pullRequestNumber: 220 }, {
      github,
      checkout,
      reviewer,
      publisher,
      lease,
    })).resolves.toEqual({ status: "reviewed", revision });

    expect(events).toEqual([
      "add:agent:in-progress",
      "remove:agent:review",
      `checkout:${revision}`,
      `review:${revision}`,
      `publish:${revision}`,
      "remove:agent:in-progress",
    ]);
    expect(checkout.withCheckout).toHaveBeenCalledWith({
      pullRequestNumber: 220,
      revision,
    }, expect.any(Function));
    expect(reviewer.review).toHaveBeenCalledWith({
      pullRequestNumber: 220,
      revision,
      checkoutPath: "/safe/disposable-checkout",
    });
    expect(publisher.publish).toHaveBeenCalledWith({
      pullRequestNumber: 220,
      revision,
      review: { verdict: "Approved", summary: "Looks good.", findings: [] },
    });
    expect(github.addPullRequestLabel).not.toHaveBeenCalledWith(220, "agent:blocked");
  });

  it("refuses an in-progress request without touching the trigger an in-flight run still owns", async () => {
    const github = {
      readPullRequest: vi.fn().mockResolvedValue({
        number: 220,
        state: "OPEN",
        isDraft: true,
        baseRepository: "canxer314/obsidian-llm-wiki-cli",
        headRepository: "canxer314/obsidian-llm-wiki-cli",
        headSha: revision,
        labels: ["agent:review", "agent:in-progress"],
      }),
      addPullRequestLabel: vi.fn(),
      removePullRequestLabel: vi.fn(),
      addRefusalDiagnostic: vi.fn(),
    };

    await expect(runReviewAutomationCommand({ pullRequestNumber: 220 }, {
      github,
      checkout: { withCheckout: vi.fn() },
      reviewer: { review: vi.fn() },
      publisher: { publish: vi.fn() },
      lease,
    })).resolves.toEqual({ status: "refused", reason: "Pull Request #220 is already in progress" });

    expect(github.addPullRequestLabel).not.toHaveBeenCalled();
    expect(github.removePullRequestLabel).not.toHaveBeenCalled();
    expect(github.addRefusalDiagnostic).not.toHaveBeenCalled();
  });

  it("refuses a fork before checkout or Agent execution", async () => {
    const checkout = { withCheckout: vi.fn() };
    const reviewer = { review: vi.fn() };
    const github = {
      readPullRequest: vi.fn().mockResolvedValue({
        number: 220,
        state: "OPEN",
        isDraft: true,
        baseRepository: "canxer314/obsidian-llm-wiki-cli",
        headRepository: "contributor/obsidian-llm-wiki-cli",
        headSha: revision,
        labels: ["agent:review"],
      }),
      addPullRequestLabel: vi.fn(),
      removePullRequestLabel: vi.fn(),
      addRefusalDiagnostic: vi.fn(),
    };

    await expect(runReviewAutomationCommand({ pullRequestNumber: 220 }, {
      github,
      checkout,
      reviewer,
      publisher: { publish: vi.fn() },
      lease,
    })).resolves.toEqual({ status: "refused", reason: "Pull Request #220 must not originate from a fork" });

    expect(github.removePullRequestLabel).toHaveBeenCalledWith(220, "agent:review");
    expect(github.addRefusalDiagnostic).toHaveBeenCalledWith(220, "Pull Request #220 must not originate from a fork");
    expect(github.addPullRequestLabel).not.toHaveBeenCalled();
    expect(checkout.withCheckout).not.toHaveBeenCalled();
    expect(reviewer.review).not.toHaveBeenCalled();
  });

  it("retains the blocked result when blocked reporting itself fails", async () => {
    const github = {
      readPullRequest: vi.fn().mockResolvedValue({
        number: 220,
        state: "OPEN",
        isDraft: true,
        baseRepository: "canxer314/obsidian-llm-wiki-cli",
        headRepository: "canxer314/obsidian-llm-wiki-cli",
        headSha: revision,
        labels: ["agent:review"],
      }),
      addPullRequestLabel: vi.fn()
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error("GitHub unavailable")),
      removePullRequestLabel: vi.fn().mockRejectedValue(new Error("GitHub unavailable")),
      addBlockedDiagnostic: vi.fn().mockRejectedValue(new Error("GitHub unavailable")),
    };

    await expect(runReviewAutomationCommand({ pullRequestNumber: 220 }, {
      github,
      checkout: {
        withCheckout: vi.fn(async (_request, action) => action("/safe/disposable-checkout")),
      },
      reviewer: { review: vi.fn().mockRejectedValue(new Error("Agent execution failed")) },
      publisher: { publish: vi.fn() },
      lease,
      createJobId: () => "job-220",
    })).resolves.toEqual({ status: "blocked", reason: "review-execution", jobId: "job-220" });
  });

  it("blocks an acquired Pull Request when review execution fails without publishing a rejection", async () => {
    const events: string[] = [];
    const failure = new Error("Agent execution failed");
    const github = {
      readPullRequest: vi.fn()
        .mockResolvedValueOnce({
          number: 220,
          state: "OPEN",
          isDraft: true,
          baseRepository: "canxer314/obsidian-llm-wiki-cli",
          headRepository: "canxer314/obsidian-llm-wiki-cli",
          headSha: revision,
          labels: ["agent:review"],
        })
        .mockResolvedValueOnce({
          number: 220,
          state: "OPEN",
          isDraft: true,
          baseRepository: "canxer314/obsidian-llm-wiki-cli",
          headRepository: "canxer314/obsidian-llm-wiki-cli",
          headSha: revision,
          labels: ["agent:review", "agent:in-progress"],
        }),
      addPullRequestLabel: vi.fn(async (_number: number, label: string) => {
        events.push(`add:${label}`);
      }),
      removePullRequestLabel: vi.fn(async (_number: number, label: string) => {
        events.push(`remove:${label}`);
      }),
      addBlockedDiagnostic: vi.fn(async (_number: number, diagnostic) => {
        events.push(`blocked:${diagnostic.reason}`);
      }),
    };
    const publisher = { publish: vi.fn() };

    await expect(runReviewAutomationCommand({ pullRequestNumber: 220 }, {
      github,
      checkout: {
        withCheckout: vi.fn(async (_request, action) => action("/safe/disposable-checkout")),
      },
      reviewer: { review: vi.fn().mockRejectedValue(failure) },
      publisher,
      lease,
      createJobId: () => "job-220",
    })).resolves.toEqual({ status: "blocked", reason: "review-execution", jobId: "job-220" });

    expect(events).toEqual([
      "add:agent:in-progress",
      "remove:agent:review",
      "add:agent:blocked",
      "blocked:review-execution",
      "remove:agent:in-progress",
    ]);
    expect(publisher.publish).not.toHaveBeenCalled();
  });
});
