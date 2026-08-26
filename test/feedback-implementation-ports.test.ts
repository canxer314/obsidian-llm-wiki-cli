import { describe, expect, it, vi } from "vitest";

import { createFeedbackImplementationEntry, runFeedbackImplementation } from "../.sandcastle/feedback-implementation-ports.js";
import { feedbackReplyMarker } from "../.sandcastle/feedback-reconciliation.js";
import { classifyGithubReadError } from "../.sandcastle/github-cli.js";

const PRE = "a".repeat(40);
const POST = "b".repeat(40);
const ROOT = "PRRC_root";

function pullRequest(headSha = PRE, labels = ["agent:implement"]) {
  return {
    number: 224,
    state: "OPEN",
    isDraft: true,
    baseRepository: "canxer314/obsidian-llm-wiki-cli",
    headRepository: "canxer314/obsidian-llm-wiki-cli",
    headRefName: "feature/feedback",
    headSha,
    labels,
  };
}

function createPorts(options: {
  readonly headRateLimit?: boolean;
  readonly replyRateLimit?: boolean;
  readonly authorizationFailure?: boolean;
} = {}) {
  const github = {
    readPullRequest: options.headRateLimit
      ? vi.fn()
        .mockResolvedValueOnce(pullRequest())
        .mockResolvedValueOnce(pullRequest())
        .mockResolvedValueOnce(pullRequest(PRE, ["agent:in-progress"]))
        .mockRejectedValueOnce(new Error("HTTP 403: API rate limit exceeded"))
        .mockResolvedValueOnce(pullRequest(POST, ["agent:in-progress"]))
      : options.authorizationFailure
        ? vi.fn()
          .mockResolvedValueOnce(pullRequest())
          .mockResolvedValueOnce(pullRequest())
          .mockResolvedValueOnce(pullRequest(PRE, ["agent:in-progress"]))
          .mockRejectedValueOnce(Object.assign(new Error("gh exited"), { stderr: "HTTP 403: Resource not accessible by integration" }))
        : vi.fn()
          .mockResolvedValueOnce(pullRequest())
          .mockResolvedValueOnce(pullRequest())
          .mockResolvedValueOnce(pullRequest(PRE, ["agent:in-progress"]))
          .mockRejectedValueOnce(new Error("HTTP 503 Service Unavailable"))
          .mockResolvedValue(pullRequest(POST, ["agent:in-progress"])),
    readFeedbackReplies: options.replyRateLimit
      ? vi.fn()
        .mockRejectedValueOnce(new Error("HTTP 403: You have exceeded a secondary rate limit"))
        .mockResolvedValueOnce([
          {
            rootCommentId: ROOT,
            replyCommentId: "PRRC_reply",
            body: `Fixed.\n\n${feedbackReplyMarker({ pullRequestNumber: 224, pre: PRE, post: POST, rootCommentId: ROOT })}`,
          },
        ])
      : vi.fn().mockResolvedValue([
        {
          rootCommentId: ROOT,
          replyCommentId: "PRRC_reply",
          body: `Fixed.\n\n${feedbackReplyMarker({ pullRequestNumber: 224, pre: PRE, post: POST, rootCommentId: ROOT })}`,
        },
      ]),
    readCurrentUnresolvedFeedback: vi.fn().mockResolvedValue({ unresolvedRootCommentIds: [ROOT], replies: [] }),
    readCommitParent: vi.fn().mockResolvedValue(undefined),
    readUnresolvedReviewThreads: vi.fn().mockResolvedValue([{ commentId: ROOT, author: "reviewer", body: "Please fix." }]),
    addPullRequestLabel: vi.fn().mockResolvedValue(undefined),
    removePullRequestLabel: vi.fn().mockResolvedValue(undefined),
    replyToReviewThread: vi.fn().mockResolvedValue(undefined),
  };
  return {
    github,
    checkout: { withCheckout: vi.fn(async (_request, action) => action("/checkout")) },
    publisher: {
      prepare: vi.fn().mockResolvedValue(undefined),
      publish: vi.fn().mockResolvedValue(POST),
    },
    implementer: vi.fn().mockResolvedValue({ reply: { rootCommentId: ROOT, body: "Fixed." } }),
    lease: { acquire: vi.fn().mockResolvedValue({ release: async () => {} }) },
  };
}

describe("feedback implementation production ports", () => {
  it.each([
    new Error("unexpected EOF"),
    new Error("transport connection reset by peer"),
    new Error("context deadline exceeded"),
    new Error("HTTP 503 Service Unavailable"),
    Object.assign(new Error("gh exited"), { stderr: "network connection refused" }),
    Object.assign(new Error("gh exited"), { stderr: "TLS handshake timeout" }),
  ])("classifies ordinary transient GitHub read failure %s", (error) => {
    expect(classifyGithubReadError(error)).toEqual({ kind: "transient" });
  });

  it.each([
    new Error("HTTP 403: API rate limit exceeded"),
    Object.assign(new Error("gh exited"), { stderr: "gh: API rate limit exceeded (HTTP 403)" }),
    new Error("HTTP 403: You have exceeded a secondary rate limit"),
    new Error("GraphQL API rate limit exceeded"),
    new Error("HTTP 429 Too Many Requests"),
  ])("classifies GitHub rate-limited read failure %s", (error) => {
    expect(classifyGithubReadError(error)).toEqual({ kind: "rate-limited" });
  });

  it("honors a parseable rate-limit retry hint without shortening the minimum wait", () => {
    expect(classifyGithubReadError(new Error("HTTP 429 Retry-After: 90 seconds")))
      .toEqual({ kind: "rate-limited", retryAfterMilliseconds: 90_000 });
    expect(classifyGithubReadError(new Error("HTTP 429 Retry-After: 5 seconds")))
      .toEqual({ kind: "rate-limited", retryAfterMilliseconds: 60_000 });
  });

  it.each([
    new Error("invalid feedback schema"),
    new Error("HTTP 401 Unauthorized"),
    new Error("validation failed"),
    new Error("HTTP 422 Unprocessable Entity"),
    Object.assign(new Error("gh exited"), { stderr: "HTTP 403: Resource not accessible by integration" }),
  ])("does not classify deterministic GitHub failure as retryable %s", (error) => {
    expect(classifyGithubReadError(error)).toEqual({ kind: "deterministic" });
  });

  it("runs direct ordinary feedback through the shared production classifier entry", async () => {
    const dependencies = createPorts({ headRateLimit: true });
    const waits: number[] = [];
    const entry = createFeedbackImplementationEntry(() => ({
      github: dependencies.github,
      checkout: dependencies.checkout,
      publisher: dependencies.publisher,
      implementer: { implement: dependencies.implementer },
      lease: dependencies.lease,
      createJobId: () => "feedback-job",
      wait: async (milliseconds) => { waits.push(milliseconds); },
      convergenceAttempts: 2,
      replyConvergenceAttempts: 1,
    }));

    await expect(entry.runDirect(224)).resolves.toEqual({ status: "implemented", revision: POST, reconciled: false });
    expect(waits).toEqual([60_000]);
  });

  it("preserves direct reconcile authorization through the shared production classifier entry", async () => {
    const dependencies = createPorts();
    const baseRevision = "c".repeat(40);
    const expectedPost = "d".repeat(40);
    const expectedReply = { rootCommentId: ROOT, body: "Reply only." };
    dependencies.github.readPullRequest.mockReset().mockResolvedValue(pullRequest(expectedPost, ["agent:in-progress"]));
    dependencies.github.readCurrentUnresolvedFeedback.mockResolvedValue({ unresolvedRootCommentIds: [ROOT], replies: [] });
    dependencies.github.readCommitParent.mockResolvedValue(baseRevision);
    dependencies.github.readFeedbackReplies.mockResolvedValue([
      {
        rootCommentId: ROOT,
        replyCommentId: "PRRC_reply",
        body: `Reply only.\n\n${feedbackReplyMarker({ pullRequestNumber: 224, pre: baseRevision, post: expectedPost, rootCommentId: ROOT })}`,
      },
    ]);
    const entry = createFeedbackImplementationEntry(() => ({
      github: dependencies.github,
      checkout: dependencies.checkout,
      publisher: dependencies.publisher,
      implementer: { implement: dependencies.implementer },
      lease: dependencies.lease,
      createJobId: () => "feedback-job",
      wait: async () => {},
      convergenceAttempts: 1,
      replyConvergenceAttempts: 1,
    }));

    await expect(entry.runDirect(224, {
      invocation: "reconcile",
      baseRevision,
      expectedPost,
      expectedReply,
    })).resolves.toEqual({ status: "implemented", revision: expectedPost, reconciled: true });
    expect(dependencies.publisher.publish).not.toHaveBeenCalled();
  });

  it("runs Dispatcher feedback as ordinary through the shared production classifier entry", async () => {
    const dependencies = createPorts({ headRateLimit: true });
    const waits: number[] = [];
    const entry = createFeedbackImplementationEntry(() => ({
      github: dependencies.github,
      checkout: dependencies.checkout,
      publisher: dependencies.publisher,
      implementer: { implement: dependencies.implementer },
      lease: dependencies.lease,
      createJobId: () => "feedback-job",
      wait: async (milliseconds) => { waits.push(milliseconds); },
      convergenceAttempts: 2,
      replyConvergenceAttempts: 1,
    }));

    await expect(entry.runDispatcher(224)).resolves.toEqual({ status: "implemented", revision: POST, reconciled: false });
    expect(waits).toEqual([60_000]);
    expect(dependencies.publisher.publish).toHaveBeenCalledTimes(1);
  });

  it("uses one dedicated 60-second retry for a production-classified head rate limit", async () => {
    const dependencies = createPorts({ headRateLimit: true });
    const waits: number[] = [];

    await expect(runFeedbackImplementation({ pullRequestNumber: 224 }, {
      github: dependencies.github,
      checkout: dependencies.checkout,
      publisher: dependencies.publisher,
      implementer: { implement: dependencies.implementer },
      lease: dependencies.lease,
      createJobId: () => "feedback-job",
      wait: async (milliseconds) => { waits.push(milliseconds); },
      convergenceAttempts: 2,
      replyConvergenceAttempts: 1,
    })).resolves.toEqual({ status: "implemented", revision: POST, reconciled: false });

    expect(waits).toEqual([60_000]);
    expect(dependencies.github.readPullRequest).toHaveBeenCalledTimes(5);
  });

  it("uses one dedicated 60-second retry for a production-classified reply readback rate limit without a second write", async () => {
    const dependencies = createPorts({ replyRateLimit: true });
    const waits: number[] = [];

    await expect(runFeedbackImplementation({ pullRequestNumber: 224 }, {
      github: dependencies.github,
      checkout: dependencies.checkout,
      publisher: dependencies.publisher,
      implementer: { implement: dependencies.implementer },
      lease: dependencies.lease,
      createJobId: () => "feedback-job",
      wait: async (milliseconds) => { waits.push(milliseconds); },
      convergenceAttempts: 2,
      replyConvergenceAttempts: 1,
    })).resolves.toEqual({ status: "implemented", revision: POST, reconciled: false });

    expect(waits).toEqual([2_000, 60_000]);
    expect(dependencies.github.readFeedbackReplies).toHaveBeenCalledTimes(2);
    expect(dependencies.github.replyToReviewThread).toHaveBeenCalledTimes(1);
  });

  it("fails fast on an ordinary authorization 403 in production head convergence", async () => {
    const dependencies = createPorts({ authorizationFailure: true });
    const waits: number[] = [];

    const result = await runFeedbackImplementation({ pullRequestNumber: 224 }, {
      github: dependencies.github,
      checkout: dependencies.checkout,
      publisher: dependencies.publisher,
      implementer: { implement: dependencies.implementer },
      lease: dependencies.lease,
      createJobId: () => "feedback-job",
      wait: async (milliseconds) => { waits.push(milliseconds); },
      convergenceAttempts: 2,
      replyConvergenceAttempts: 1,
    });

    expect(result).toMatchObject({ status: "blocked", reason: "feedback-convergence", revision: POST });
    expect(waits).toEqual([]);
    expect(dependencies.github.readPullRequest).toHaveBeenCalledTimes(4);
  });

  it("fails fast on a deterministic production-classified head read error", async () => {
    const dependencies = createPorts();
    dependencies.github.readPullRequest.mockReset()
      .mockResolvedValueOnce(pullRequest())
      .mockResolvedValueOnce(pullRequest())
      .mockResolvedValueOnce(pullRequest(PRE, ["agent:in-progress"]))
      .mockRejectedValueOnce(new Error("HTTP 422 Unprocessable Entity"));

    const result = await runFeedbackImplementation({ pullRequestNumber: 224 }, {
      github: dependencies.github,
      checkout: dependencies.checkout,
      publisher: dependencies.publisher,
      implementer: { implement: dependencies.implementer },
      lease: dependencies.lease,
      createJobId: () => "feedback-job",
      wait: async () => {},
      convergenceAttempts: 2,
      replyConvergenceAttempts: 1,
    });

    expect(result).toMatchObject({ status: "blocked", reason: "feedback-convergence", revision: POST });
    expect(dependencies.github.readPullRequest).toHaveBeenCalledTimes(4);
  });

  it("retries a transient production-classified reply readback error", async () => {
    const dependencies = createPorts();
    dependencies.github.readFeedbackReplies.mockReset()
      .mockRejectedValueOnce(new Error("HTTP 503 Service Unavailable"))
      .mockResolvedValueOnce([
        {
          rootCommentId: ROOT,
          replyCommentId: "PRRC_reply",
          body: `Fixed.\n\n${feedbackReplyMarker({ pullRequestNumber: 224, pre: PRE, post: POST, rootCommentId: ROOT })}`,
        },
      ]);

    const result = await runFeedbackImplementation({ pullRequestNumber: 224 }, {
      github: dependencies.github,
      checkout: dependencies.checkout,
      publisher: dependencies.publisher,
      implementer: { implement: dependencies.implementer },
      lease: dependencies.lease,
      createJobId: () => "feedback-job",
      wait: async () => {},
      convergenceAttempts: 2,
      replyConvergenceAttempts: 2,
    });

    expect(result).toEqual({ status: "implemented", revision: POST, reconciled: false });
    expect(dependencies.github.readFeedbackReplies).toHaveBeenCalledTimes(2);
  });

  it("fails fast on an ordinary authorization 403 in production reply readback", async () => {
    const dependencies = createPorts();
    const waits: number[] = [];
    dependencies.github.readPullRequest.mockReset()
      .mockResolvedValueOnce(pullRequest())
      .mockResolvedValueOnce(pullRequest())
      .mockResolvedValueOnce(pullRequest(PRE, ["agent:in-progress"]))
      .mockResolvedValueOnce(pullRequest(POST, ["agent:in-progress"]));
    dependencies.github.readFeedbackReplies.mockReset()
      .mockRejectedValueOnce(Object.assign(new Error("gh exited"), { stderr: "HTTP 403: Resource not accessible by integration" }));

    const result = await runFeedbackImplementation({ pullRequestNumber: 224 }, {
      github: dependencies.github,
      checkout: dependencies.checkout,
      publisher: dependencies.publisher,
      implementer: { implement: dependencies.implementer },
      lease: dependencies.lease,
      createJobId: () => "feedback-job",
      wait: async (milliseconds) => { waits.push(milliseconds); },
      convergenceAttempts: 2,
      replyConvergenceAttempts: 2,
    });

    expect(result).toMatchObject({ status: "blocked", reason: "feedback-reply", revision: POST });
    expect(waits).toEqual([]);
    expect(dependencies.github.readFeedbackReplies).toHaveBeenCalledTimes(1);
    expect(dependencies.github.replyToReviewThread).toHaveBeenCalledTimes(1);
  });

  it("fails fast on a deterministic production-classified reply readback error", async () => {
    const dependencies = createPorts();
    dependencies.github.readFeedbackReplies.mockReset()
      .mockRejectedValueOnce(new Error("HTTP 422 Unprocessable Entity"));

    const result = await runFeedbackImplementation({ pullRequestNumber: 224 }, {
      github: dependencies.github,
      checkout: dependencies.checkout,
      publisher: dependencies.publisher,
      implementer: { implement: dependencies.implementer },
      lease: dependencies.lease,
      createJobId: () => "feedback-job",
      wait: async () => {},
      convergenceAttempts: 2,
      replyConvergenceAttempts: 2,
    });

    expect(result).toMatchObject({ status: "blocked", reason: "feedback-reply", revision: POST });
    expect(dependencies.github.readFeedbackReplies).toHaveBeenCalledTimes(1);
  });
});
