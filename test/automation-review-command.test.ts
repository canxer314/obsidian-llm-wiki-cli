import { describe, expect, it, vi } from "vitest";

import { createAutomationGithubPort } from "../.sandcastle/automation-github.js";
import { runReviewAutomationCommand } from "../.sandcastle/review-automation.js";
import { createSameSessionReviewExtractor } from "../.sandcastle/review-extraction.js";
import { createReviewPublisher } from "../.sandcastle/review-publisher.js";

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
    lease: { acquire: vi.fn(async () => ({ release: async () => {} })) },
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

    await expect(runReviewAutomationCommand({ pullRequestNumber: 220 }, dependencies)).resolves.toEqual({ status: "reviewed", revision: improvedRevision, verdict: "improved" });

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

    await expect(runReviewAutomationCommand({ pullRequestNumber: 220 }, dependencies)).resolves.toEqual({ status: "reviewed", revision, verdict: "clean" });
    expect(dependencies.github.publishReview).toHaveBeenCalledWith(expect.objectContaining({ revision }));
    expect(dependencies.github.markPullRequestReady).toHaveBeenCalledWith(220);
  });

  it.each([
    { name: "clean review", reviewedRevision: revision, verdict: "clean" as const },
    { name: "improved review", reviewedRevision: improvedRevision, verdict: "improved" as const },
  ])("keeps the prepared Target Checkout available for a $name", async ({ reviewedRevision, verdict }) => {
    const events: string[] = [];
    let checkoutBranch: string | undefined;
    let checkoutRevision: string | undefined;
    const execute = vi.fn(async (_file: string, arguments_: readonly string[]) => {
      if (arguments_[2] === "checkout") {
        checkoutBranch = arguments_[4];
        checkoutRevision = arguments_[5];
      }
      if (arguments_[2] === "rev-parse") return { stdout: `${checkoutRevision}\n`, stderr: "" };
      return { stdout: "", stderr: "" };
    });
    const extractor = createSameSessionReviewExtractor({
      sandbox: { kind: "fake-sandbox" } as never,
      hooks: { sandbox: { onSandboxReady: [] } },
      runAgent: vi.fn(async (options: { readonly cwd: string; readonly branchStrategy: unknown }) => {
        expect(checkoutBranch).toBe("feature/review");
        expect(checkoutRevision).toBe(revision);
        expect(options).toMatchObject({ cwd: "/safe/disposable-checkout", branchStrategy: { type: "head" } });
        checkoutRevision = reviewedRevision;
        return {
          commits: reviewedRevision === revision ? [] : [{}],
          resume: vi.fn().mockResolvedValue({ output: { summary: "Reviewed.", inlineComments: [], replies: [] } }),
        };
      }) as never,
      createAgent: vi.fn().mockReturnValue({ name: "fake-reviewer" }) as never,
    });
    const dependencies = ports(events, (request) =>
      extractor.review({ ...request, model: "reviewer-model" }),
    );
    dependencies.publisher = createReviewPublisher({ execute });

    await expect(runReviewAutomationCommand({ pullRequestNumber: 220 }, dependencies))
      .resolves.toEqual({ status: "reviewed", revision: reviewedRevision, verdict });

    expect(execute).toHaveBeenCalledWith("git", [
      "-C", "/safe/disposable-checkout", "checkout", "-B", "feature/review", revision,
    ]);
    expect(execute).toHaveBeenCalledWith("git", [
      "-C", "/safe/disposable-checkout", "push", "origin",
      `--force-with-lease=refs/heads/feature/review:${revision}`,
      "HEAD:refs/heads/feature/review",
    ]);
  });

  it("blocks a reviewer execution failure without publishing or changing the existing Draft PR", async () => {
    const events: string[] = [];
    const reviewer = vi.fn().mockRejectedValue(new Error("reviewer execution failed"));
    const dependencies = ports(events, reviewer);

    await expect(runReviewAutomationCommand({ pullRequestNumber: 220 }, { ...dependencies, createJobId: () => "job-220" }))
      .resolves.toEqual({ status: "blocked", reason: "review-execution", jobId: "job-220" });

    expect(dependencies.publisher.publish).not.toHaveBeenCalled();
    expect(dependencies.github.publishReview).not.toHaveBeenCalled();
    expect(dependencies.github.markPullRequestReady).not.toHaveBeenCalled();
    expect(dependencies.github.replyToReviewThread).not.toHaveBeenCalled();
    expect(events).toEqual([
      "add:agent:in-progress", "remove:agent:review", `prepare:feature/review:${revision}`,
      "add:agent:blocked", "blocked", "remove:agent:in-progress",
    ]);
  });

  it("later reviews the same Draft PR at its current full head after an execution failure", async () => {
    const events: string[] = [];
    const failedDependencies = ports(events, vi.fn().mockRejectedValue(new Error("reviewer execution failed")));

    await expect(runReviewAutomationCommand({ pullRequestNumber: 220 }, failedDependencies))
      .resolves.toMatchObject({ status: "blocked", reason: "review-execution" });

    const currentRevision = "fedcba9876543210fedcba9876543210fedcba98";
    const laterDependencies = ports(events);
    laterDependencies.github.readPullRequest.mockReset();
    laterDependencies.github.readPullRequest
      .mockResolvedValueOnce({ ...pullRequest(), headSha: currentRevision })
      .mockResolvedValueOnce({ ...pullRequest(["agent:review", "agent:in-progress"]), headSha: currentRevision });
    laterDependencies.publisher.publish.mockResolvedValue(currentRevision);

    await expect(runReviewAutomationCommand({ pullRequestNumber: 220 }, laterDependencies))
      .resolves.toEqual({ status: "reviewed", revision: currentRevision, verdict: "clean" });

    expect(laterDependencies.reviewer.review).toHaveBeenCalledWith(expect.objectContaining({
      pullRequestNumber: 220,
      revision: currentRevision,
    }));
    expect(laterDependencies.publisher.prepare).toHaveBeenCalledWith(
      "/safe/disposable-checkout", "feature/review", currentRevision,
    );
    expect(laterDependencies.publisher.publish).toHaveBeenCalledWith({
      checkoutPath: "/safe/disposable-checkout", branch: "feature/review", expectedRevision: currentRevision,
    });
    expect(laterDependencies.github.publishReview).toHaveBeenCalledWith(expect.objectContaining({ revision: currentRevision }));
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

  it("refuses a fork decoded through the stable Pull Request REST shape before Agent execution", async () => {
    const events: string[] = [];
    const execute = vi.fn()
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          number: 220,
          state: "open",
          draft: true,
          base: {
            ref: "master",
            repo: { full_name: "canxer314/obsidian-llm-wiki-cli" },
          },
          head: {
            ref: "contributor-branch",
            sha: revision,
            repo: { full_name: "contributor/obsidian-llm-wiki-cli" },
          },
          labels: [{ name: "agent:review" }],
        }),
        stderr: "",
      })
      .mockResolvedValue({ stdout: "", stderr: "" });
    const dependencies = ports(events);
    const github = createAutomationGithubPort({ execute });
    const reviewGithub = {
      ...dependencies.github,
      readPullRequest: github.readPullRequest,
      removePullRequestLabel: github.removePullRequestLabel,
      addRefusalDiagnostic: github.addRefusalDiagnostic,
    };

    await expect(runReviewAutomationCommand({ pullRequestNumber: 220 }, {
      ...dependencies,
      github: reviewGithub,
    }))
      .resolves.toEqual({ status: "refused", reason: "Pull Request #220 must not originate from a fork" });
    expect(execute).toHaveBeenNthCalledWith(1, "gh", [
      "api", "repos/{owner}/{repo}/pulls/220",
    ], undefined);
    expect(execute).toHaveBeenNthCalledWith(2, "gh", [
      "api", "--method", "DELETE", "repos/{owner}/{repo}/issues/220/labels/agent%3Areview",
    ], undefined);
    expect(execute).toHaveBeenNthCalledWith(3, "gh", [
      "api", "repos/{owner}/{repo}/issues/220/comments",
      "-f", "body=Pull Request #220 must not originate from a fork",
    ], undefined);
    expect(dependencies.reviewer.review).not.toHaveBeenCalled();
    expect(dependencies.checkout.withCheckout).not.toHaveBeenCalled();
    expect(events).toEqual([]);
  });

  it("leaves the trigger untouched when the acquisition label cannot be added", async () => {
    const events: string[] = [];
    const dependencies = ports(events);
    dependencies.github.addPullRequestLabel.mockRejectedValueOnce(new Error("label transport failed"));

    await expect(runReviewAutomationCommand({ pullRequestNumber: 220 }, dependencies))
      .rejects.toThrow("label transport failed");
    expect(dependencies.github.removePullRequestLabel).not.toHaveBeenCalled();
    expect(dependencies.github.addBlockedDiagnostic).not.toHaveBeenCalled();
    expect(dependencies.reviewer.review).not.toHaveBeenCalled();
    expect(dependencies.checkout.withCheckout).not.toHaveBeenCalled();
    expect(events).toEqual([]);
  });

  it("leaves the trigger and all mutation ports untouched when the initial Pull Request read fails", async () => {
    const events: string[] = [];
    const dependencies = ports(events);
    dependencies.github.readPullRequest.mockReset();
    dependencies.github.readPullRequest.mockRejectedValue(new Error("Pull Request shape is unreadable"));

    await expect(runReviewAutomationCommand({ pullRequestNumber: 220 }, dependencies))
      .rejects.toThrow("Pull Request shape is unreadable");
    expect(dependencies.github.addPullRequestLabel).not.toHaveBeenCalled();
    expect(dependencies.github.removePullRequestLabel).not.toHaveBeenCalled();
    expect(dependencies.github.addBlockedDiagnostic).not.toHaveBeenCalled();
    expect(dependencies.reviewer.review).not.toHaveBeenCalled();
    expect(dependencies.checkout.withCheckout).not.toHaveBeenCalled();
    expect(events).toEqual([]);
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
