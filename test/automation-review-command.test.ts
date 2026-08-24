import { describe, expect, it, vi } from "vitest";

import { runReviewAutomationCommand } from "../.sandcastle/review-automation.js";

const revision = "0123456789abcdef0123456789abcdef01234567";
const improvedRevision = "abcdef0123456789abcdef0123456789abcdef01";

function pullRequest(labels = ["agent:review"]) {
  return {
    number: 220,
    state: "OPEN",
    isDraft: true,
    baseRepository: "canxer314/obsidian-llm-wiki-cli",
    headRepository: "canxer314/obsidian-llm-wiki-cli",
    headRefName: "feature/review",
    headSha: revision,
    labels,
  };
}

function ports(events: string[], reviewer = vi.fn().mockResolvedValue({ summary: "Improved the branch.", inlineComments: [], replies: [] })) {
  const github = {
    readPullRequest: vi.fn().mockResolvedValueOnce(pullRequest()).mockResolvedValueOnce(pullRequest(["agent:review", "agent:in-progress"])),
    readUnresolvedReviewThreads: vi.fn().mockResolvedValue([{ commentId: "PRRC_1", author: "maintainer", body: "Please fix this." }]),
    addPullRequestLabel: vi.fn(async (_number: number, label: string) => { events.push(`add:${label}`); }),
    removePullRequestLabel: vi.fn(async (_number: number, label: string) => { events.push(`remove:${label}`); }),
    publishReview: vi.fn(async (request) => { events.push(`review:${request.revision}`); }),
    markPullRequestReady: vi.fn(async () => { events.push("ready"); }),
    replyToReviewThread: vi.fn(async ({ reply }) => { events.push(`reply:${reply.commentId}`); }),
    addBlockedDiagnostic: vi.fn(async () => { events.push("blocked"); }),
  };
  const publisher = {
    prepare: vi.fn(async (_checkout: string, branch: string, expectedRevision: string) => { events.push(`prepare:${branch}:${expectedRevision}`); }),
    publish: vi.fn(async ({ expectedRevision }) => {
      events.push(`push:${expectedRevision}`);
      return improvedRevision;
    }),
  };
  return {
    github,
    checkout: { withCheckout: vi.fn(async (_request, action) => action("/safe/disposable-checkout")) },
    reviewer: { review: reviewer },
    publisher,
  };
}

describe("review automation command", () => {
  it("publishes the reviewer-improved head, marks the PR ready, and replies to known threads", async () => {
    const events: string[] = [];
    const reviewer = vi.fn().mockResolvedValue({
      summary: "Improved a validation path.",
      inlineComments: [{ path: "src/file.ts", line: 12, body: "This is now safe." }],
      replies: [{ commentId: "PRRC_1", body: "Fixed in the review commit." }, { commentId: "unknown", body: "Must not post." }],
    });
    const dependencies = ports(events, reviewer);

    await expect(runReviewAutomationCommand({ pullRequestNumber: 220 }, dependencies)).resolves.toEqual({ status: "reviewed", revision: improvedRevision });

    expect(reviewer).toHaveBeenCalledWith({
      pullRequestNumber: 220,
      branch: "feature/review",
      revision,
      checkoutPath: "/safe/disposable-checkout",
      reviewThreads: [{ commentId: "PRRC_1", author: "maintainer", body: "Please fix this." }],
    });
    expect(dependencies.publisher.publish).toHaveBeenCalledWith({ checkoutPath: "/safe/disposable-checkout", branch: "feature/review", expectedRevision: revision });
    expect(dependencies.github.publishReview).toHaveBeenCalledWith(expect.objectContaining({ revision: improvedRevision }));
    expect(events).toEqual([
      "add:agent:in-progress", "remove:agent:review", `prepare:feature/review:${revision}`, `push:${revision}`,
      `review:${improvedRevision}`, "ready", "reply:PRRC_1", "remove:agent:in-progress",
    ]);
  });

  it("publishes a clean review at the original head when the reviewer makes no commit", async () => {
    const events: string[] = [];
    const dependencies = ports(events, vi.fn().mockResolvedValue({ summary: "Clean.", inlineComments: [], replies: [] }));
    dependencies.publisher.publish.mockResolvedValue(revision);

    await expect(runReviewAutomationCommand({ pullRequestNumber: 220 }, dependencies)).resolves.toEqual({ status: "reviewed", revision });
    expect(dependencies.github.publishReview).toHaveBeenCalledWith(expect.objectContaining({ revision }));
    expect(dependencies.github.markPullRequestReady).toHaveBeenCalledWith(220);
  });

  it("blocks and leaves the Draft PR open without a fabricated review when the lease rejects the push", async () => {
    const events: string[] = [];
    const dependencies = ports(events);
    dependencies.publisher.publish.mockRejectedValue(new Error("stale info"));

    await expect(runReviewAutomationCommand({ pullRequestNumber: 220 }, { ...dependencies, createJobId: () => "job-220" }))
      .resolves.toEqual({ status: "blocked", reason: "review-execution", jobId: "job-220" });

    expect(dependencies.github.publishReview).not.toHaveBeenCalled();
    expect(dependencies.github.markPullRequestReady).not.toHaveBeenCalled();
    expect(dependencies.github.addPullRequestLabel).toHaveBeenCalledWith(220, "agent:blocked");
    expect(dependencies.github.removePullRequestLabel).toHaveBeenCalledWith(220, "agent:in-progress");
  });

  it("refuses an in-progress request without touching the trigger", async () => {
    const events: string[] = [];
    const dependencies = ports(events);
    dependencies.github.readPullRequest.mockReset();
    dependencies.github.readPullRequest.mockResolvedValue(pullRequest(["agent:review", "agent:in-progress"]));

    await expect(runReviewAutomationCommand({ pullRequestNumber: 220 }, dependencies))
      .resolves.toEqual({ status: "refused", reason: "Pull Request #220 is already in progress" });
    expect(dependencies.github.removePullRequestLabel).not.toHaveBeenCalled();
  });
});
