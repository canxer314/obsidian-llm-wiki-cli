import { describe, expect, it, vi } from "vitest";

import { runFeedbackImplementation } from "../.sandcastle/feedback-implementation-ports.js";
import { feedbackReplyMarker } from "../.sandcastle/feedback-reconciliation.js";
import { isTransientGithubReadError } from "../.sandcastle/github-cli.js";

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

function createPorts() {
  const github = {
    readPullRequest: vi.fn()
      .mockResolvedValueOnce(pullRequest())
      .mockResolvedValueOnce(pullRequest())
      .mockResolvedValueOnce(pullRequest(PRE, ["agent:in-progress"]))
      .mockRejectedValueOnce(new Error("HTTP 503 Service Unavailable"))
      .mockResolvedValue(pullRequest(POST, ["agent:in-progress"])),
    readFeedbackReplies: vi.fn().mockResolvedValue([
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
    new Error("HTTP 429"),
    new Error("HTTP 503 Service Unavailable"),
    Object.assign(new Error("gh exited"), { stderr: "network connection refused" }),
    Object.assign(new Error("gh exited"), { stderr: "TLS handshake timeout" }),
  ])("classifies transient GitHub read failure %s", (error) => {
    expect(isTransientGithubReadError(error)).toBe(true);
  });

  it.each([
    new Error("invalid feedback schema"),
    new Error("HTTP 401 Unauthorized"),
    new Error("validation failed"),
    new Error("HTTP 422 Unprocessable Entity"),
  ])("does not classify deterministic GitHub failure %s", (error) => {
    expect(isTransientGithubReadError(error)).toBe(false);
  });

  it.each(["direct/reconcile", "Dispatcher"] as const)("uses the real classifier for %s feedback head convergence", async (_caller) => {
    const dependencies = createPorts();
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

    expect(result).toEqual({ status: "implemented", revision: POST, reconciled: false });
    expect(dependencies.github.readPullRequest).toHaveBeenCalledTimes(5);
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
