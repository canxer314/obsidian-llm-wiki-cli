import { describe, expect, it, vi } from "vitest";

import { runFeedbackImplementation } from "../.sandcastle/feedback-implementation-automation.js";
import { feedbackReplyMarker } from "../.sandcastle/feedback-reconciliation.js";
import { classifyGithubReadError } from "../.sandcastle/github-cli.js";

const PRE = "a".repeat(40);
const POST = "b".repeat(40);
const ROOT = "PRRC_root";

function target429Error(stderr: string): Error {
  return Object.assign(new Error("Command failed: gh issue view 429 --json number"), { stderr });
}

function targetServerStatusNumberError(
  target: 500 | 502 | 503 | 504,
  stderr = "HTTP 404 Not Found",
  arguments_ = "--json headRefOid",
): Error {
  return Object.assign(
    new Error(`Command failed: gh pr view ${target} ${arguments_}`),
    { stderr },
  );
}

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

function createResources(options: {
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

describe("feedback implementation production interface", () => {
  it.each([
    new Error("unexpected EOF"),
    new Error("transport connection reset by peer"),
    new Error("context deadline exceeded"),
    new Error("HTTP 503 Service Unavailable"),
    Object.assign(new Error("Command failed: gh pr view 500 --json headRefOid"), {
      stderr: "HTTP 503 Service Unavailable",
    }),
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

  it("honors only safe parseable rate-limit retry hints", () => {
    expect(classifyGithubReadError(new Error("HTTP 429 Retry-After: 90 seconds")))
      .toEqual({ kind: "rate-limited", retryAfterMilliseconds: 90_000 });
    expect(classifyGithubReadError(new Error("HTTP 429 Retry-After: 5 seconds")))
      .toEqual({ kind: "rate-limited", retryAfterMilliseconds: 60_000 });
    expect(classifyGithubReadError(new Error("HTTP 429 Retry-After: 2147484 seconds")))
      .toEqual({ kind: "rate-limited", retryAfterMilliseconds: 60_000 });
    expect(classifyGithubReadError(new Error("HTTP 429 Retry-After: 0 seconds")))
      .toEqual({ kind: "rate-limited", retryAfterMilliseconds: 60_000 });
    expect(classifyGithubReadError(new Error("HTTP 429 Retry-After: Infinity seconds")))
      .toEqual({ kind: "rate-limited", retryAfterMilliseconds: 60_000 });
    expect(classifyGithubReadError(new Error("HTTP 429 Retry-After: not-a-number seconds")))
      .toEqual({ kind: "rate-limited", retryAfterMilliseconds: 60_000 });
    expect(classifyGithubReadError(new Error("HTTP 429 X-RateLimit-Reset: 0")))
      .toEqual({ kind: "rate-limited", retryAfterMilliseconds: 60_000 });
    expect(classifyGithubReadError(new Error("HTTP 429 X-RateLimit-Reset: Infinity")))
      .toEqual({ kind: "rate-limited", retryAfterMilliseconds: 60_000 });
    expect(classifyGithubReadError(new Error("HTTP 429 X-RateLimit-Reset: 9999999999999")))
      .toEqual({ kind: "rate-limited", retryAfterMilliseconds: 60_000 });
    expect(classifyGithubReadError(new Error("HTTP 429 X-RateLimit-Reset: 1060"), () => 1_000_000))
      .toEqual({ kind: "rate-limited", retryAfterMilliseconds: 60_000 });
    expect(classifyGithubReadError(new Error("HTTP 429 X-RateLimit-Reset: 1090"), () => 1_000_000))
      .toEqual({ kind: "rate-limited", retryAfterMilliseconds: 90_000 });
  });

  it.each([
    target429Error("GraphQL: Could not resolve to an issue or pull request with the number of 429. (repository.issue)"),
    target429Error("HTTP 404 Not Found"),
    target429Error("HTTP 403: Resource not accessible by integration"),
  ])("does not mistake a target number 429 for rate limiting: %s", (error) => {
    expect(classifyGithubReadError(error)).toEqual({ kind: "deterministic" });
  });

  it.each([
    { status: 404, text: "service unavailable" },
    { status: 403, text: "gateway timeout" },
  ])("keeps deterministic HTTP $status failures fail-closed despite transient-looking details", ({ status, text }) => {
    const error = Object.assign(new Error("Command failed: gh pr view 500 --json headRefOid"), {
      stderr: `HTTP ${status} Not Found\n${text}`,
    });
    expect(classifyGithubReadError(error)).toEqual({ kind: "deterministic" });
  });

  it.each(
    ([500, 502, 503, 504] as const).flatMap((target) => [
      { target, stderr: "HTTP 404 Not Found" },
      { target, stderr: "HTTP 403: Resource not accessible by integration" },
      { target, stderr: "HTTP 422 Unprocessable Entity" },
    ]),
  )(
    "does not mistake target number $target with deterministic stderr for an HTTP server error",
    ({ target, stderr }) => {
      expect(classifyGithubReadError(targetServerStatusNumberError(target, stderr)))
        .toEqual({ kind: "deterministic" });
    },
  );

  it.each(["network timeout", "service unavailable"])(
    "does not classify command argument text '$arguments_' when stderr is deterministic",
    (arguments_) => {
      const error = targetServerStatusNumberError(
        500,
        "HTTP 404 Not Found",
        `--json headRefOid --jq '${arguments_}'`,
      );
      expect(classifyGithubReadError(error)).toEqual({ kind: "deterministic" });
    },
  );

  it("prefers deterministic stderr over a conflicting plain error message", () => {
    const error = Object.assign(new Error("HTTP 500 Internal Server Error"), {
      stderr: "HTTP 404 Not Found",
    });
    expect(classifyGithubReadError(error)).toEqual({ kind: "deterministic" });
  });

  it("classifies diagnostics after a Node command wrapper with empty stderr", () => {
    const error = Object.assign(new Error(
      "Command failed: gh pr view 500 --json headRefOid\nHTTP 503 Service Unavailable",
    ), { stderr: "" });
    expect(classifyGithubReadError(error)).toEqual({ kind: "transient" });
  });

  it.each([
    target429Error("HTTP 429 Too Many Requests"),
    target429Error("HTTP 403: API rate limit exceeded"),
    target429Error("HTTP 403: You have exceeded a secondary rate limit"),
    target429Error("GraphQL API rate limit exceeded"),
  ])("preserves semantic GitHub rate limits even with a target number 429: %s", (error) => {
    expect(classifyGithubReadError(error)).toEqual({ kind: "rate-limited" });
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

  it("runs ordinary feedback through the production interface", async () => {
    const dependencies = createResources({ headRateLimit: true });
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
  });

  it("preserves explicit reconcile authorization through the production interface", async () => {
    const dependencies = createResources();
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
    await expect(runFeedbackImplementation({
      pullRequestNumber: 224,
      authorization: { invocation: "reconcile", baseRevision, expectedPost, expectedReply },
    }, {
      github: dependencies.github,
      checkout: dependencies.checkout,
      publisher: dependencies.publisher,
      implementer: { implement: dependencies.implementer },
      lease: dependencies.lease,
      createJobId: () => "feedback-job",
      wait: async () => {},
      convergenceAttempts: 1,
      replyConvergenceAttempts: 1,
    })).resolves.toEqual({ status: "implemented", revision: expectedPost, reconciled: true });
    expect(dependencies.publisher.publish).not.toHaveBeenCalled();
  });

  it("keeps explicit reconcile reply readback fail-closed for target number 429", async () => {
    const dependencies = createResources();
    const baseRevision = "c".repeat(40);
    const expectedPost = "d".repeat(40);
    const readError = target429Error("HTTP 404 Not Found");
    dependencies.github.readPullRequest.mockReset().mockResolvedValue(pullRequest(expectedPost, ["agent:in-progress"]));
    dependencies.github.readCurrentUnresolvedFeedback.mockResolvedValue({ unresolvedRootCommentIds: [ROOT], replies: [] });
    dependencies.github.readCommitParent.mockResolvedValue(baseRevision);
    dependencies.github.readFeedbackReplies.mockRejectedValue(readError);
    const waits: number[] = [];
    await expect(runFeedbackImplementation({
      pullRequestNumber: 224,
      authorization: {
        invocation: "reconcile",
        baseRevision,
        expectedPost,
        expectedReply: { rootCommentId: ROOT, body: "Reply only." },
      },
    }, {
      github: dependencies.github,
      checkout: dependencies.checkout,
      publisher: dependencies.publisher,
      implementer: { implement: dependencies.implementer },
      lease: dependencies.lease,
      createJobId: () => "feedback-job",
      wait: async (milliseconds) => { waits.push(milliseconds); },
      convergenceAttempts: 1,
      replyConvergenceAttempts: 3,
    })).resolves.toMatchObject({ status: "blocked", reason: "feedback-reply", revision: expectedPost });

    expect(waits).toEqual([]);
    expect(dependencies.github.readFeedbackReplies).toHaveBeenCalledTimes(1);
    expect(dependencies.github.replyToReviewThread).toHaveBeenCalledTimes(1);
  });

  it("keeps ordinary feedback head convergence fail-closed for target number 429", async () => {
    const dependencies = createResources();
    const readError = target429Error("HTTP 404 Not Found");
    dependencies.github.readPullRequest.mockReset()
      .mockResolvedValueOnce(pullRequest())
      .mockResolvedValueOnce(pullRequest())
      .mockResolvedValueOnce(pullRequest(PRE, ["agent:in-progress"]))
      .mockRejectedValueOnce(readError);
    const waits: number[] = [];
    await expect(runFeedbackImplementation({ pullRequestNumber: 224 }, {
      github: dependencies.github,
      checkout: dependencies.checkout,
      publisher: dependencies.publisher,
      implementer: { implement: dependencies.implementer },
      lease: dependencies.lease,
      createJobId: () => "feedback-job",
      wait: async (milliseconds) => { waits.push(milliseconds); },
      convergenceAttempts: 3,
      replyConvergenceAttempts: 1,
    }))
      .resolves.toMatchObject({ status: "blocked", reason: "feedback-convergence", revision: POST });

    expect(waits).toEqual([]);
    expect(dependencies.github.readPullRequest).toHaveBeenCalledTimes(4);
  });

  it("runs ordinary feedback without reconcile authorization", async () => {
    const dependencies = createResources({ headRateLimit: true });
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
    expect(dependencies.publisher.publish).toHaveBeenCalledTimes(1);
  });

  it("uses one dedicated 60-second retry for a production-classified head rate limit", async () => {
    const dependencies = createResources({ headRateLimit: true });
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
    const dependencies = createResources({ replyRateLimit: true });
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

  it("fails fast without a rate-limit wait or second write when canonical readback names target 429", async () => {
    const dependencies = createResources();
    const error = target429Error("GraphQL: Could not resolve to an issue or pull request with the number of 429. (repository.issue)");
    dependencies.github.readPullRequest.mockReset()
      .mockResolvedValueOnce(pullRequest())
      .mockResolvedValueOnce(pullRequest())
      .mockResolvedValueOnce(pullRequest(PRE, ["agent:in-progress"]))
      .mockResolvedValueOnce(pullRequest(POST, ["agent:in-progress"]));
    dependencies.github.readFeedbackReplies.mockReset().mockRejectedValue(error);
    const waits: number[] = [];

    const result = await runFeedbackImplementation({ pullRequestNumber: 224 }, {
      github: dependencies.github,
      checkout: dependencies.checkout,
      publisher: dependencies.publisher,
      implementer: { implement: dependencies.implementer },
      lease: dependencies.lease,
      createJobId: () => "feedback-job",
      wait: async (milliseconds) => { waits.push(milliseconds); },
      convergenceAttempts: 1,
      replyConvergenceAttempts: 3,
    });

    expect(result).toMatchObject({ status: "blocked", reason: "feedback-reply", revision: POST });
    expect(waits).toEqual([]);
    expect(dependencies.github.readFeedbackReplies).toHaveBeenCalledTimes(1);
    expect(dependencies.github.replyToReviewThread).toHaveBeenCalledTimes(1);
  });

  it("fails fast on an ordinary authorization 403 in production head convergence", async () => {
    const dependencies = createResources({ authorizationFailure: true });
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

  it("fails fast when production head convergence gets a 404 for Pull Request 500", async () => {
    const dependencies = createResources();
    const error = targetServerStatusNumberError(500);
    const waits: number[] = [];
    dependencies.github.readPullRequest.mockReset()
      .mockResolvedValueOnce(pullRequest())
      .mockResolvedValueOnce(pullRequest())
      .mockResolvedValueOnce(pullRequest(PRE, ["agent:in-progress"]))
      .mockRejectedValueOnce(error);

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

  it("retries a transient production-classified reply readback error", async () => {
    const dependencies = createResources();
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
    const dependencies = createResources();
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

  it("fails fast when production reply readback gets a 404 for Pull Request 500", async () => {
    const dependencies = createResources();
    const waits: number[] = [];
    dependencies.github.readFeedbackReplies.mockReset()
      .mockRejectedValueOnce(targetServerStatusNumberError(500));

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
    // Reply readback starts after the intentional publication-settle wait; the
    // deterministic read itself must not add a retry wait.
    expect(waits).toEqual([2_000]);
    expect(dependencies.github.readFeedbackReplies).toHaveBeenCalledTimes(1);
    expect(dependencies.github.replyToReviewThread).toHaveBeenCalledTimes(1);
  });
});
