import { describe, expect, it, vi } from "vitest";

import { runFeedbackImplementation } from "../.sandcastle/feedback-implementation-automation.js";
import { feedbackReplyMarker } from "../.sandcastle/feedback-reconciliation.js";

const PRE = "a".repeat(40);
const POST = "b".repeat(40);
const OTHER = "c".repeat(40);
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

function markerReply(body: string, rootCommentId = ROOT): { readonly rootCommentId: string; readonly replyCommentId: string; readonly body: string } {
  return { rootCommentId, replyCommentId: "PRRC_reply", body };
}

function marker(rootCommentId = ROOT): { readonly rootCommentId: string; readonly replyCommentId: string; readonly body: string } {
  return markerReply(feedbackReplyMarker({ pullRequestNumber: 224, pre: PRE, post: POST, rootCommentId }), rootCommentId);
}

function ports(overrides: {
  readonly headReads?: readonly string[];
  readonly replies?: readonly { readonly rootCommentId: string; readonly replyCommentId: string; readonly body: string }[];
  readonly feedbackRoots?: readonly string[];
  readonly feedbackStates?: readonly {
    readonly unresolvedRootCommentIds: readonly string[];
    readonly replies: readonly { readonly rootCommentId: string; readonly replyCommentId: string; readonly body: string }[];
  }[];
  readonly readbackReplies?: readonly { readonly rootCommentId: string; readonly replyCommentId: string; readonly body: string }[];
  readonly parentOf?: (sha: string) => string | undefined;
  readonly implementReply?: { readonly rootCommentId: string; readonly body: string };
  readonly publishError?: Error;
  readonly replyError?: Error;
  readonly writeAddsMarker?: boolean;
  readonly convergenceAttempts?: number;
  readonly replyConvergenceAttempts?: number;
  readonly finalizationFailures?: readonly string[];
  readonly blockedLabelFailure?: boolean;
  readonly diagnosticFailure?: boolean;
} = {}) {
  const headReads = overrides.headReads ?? [PRE, PRE, PRE, POST];
  let reads = 0;
  let canonicalReadback = overrides.readbackReplies ?? [marker()];
  let feedbackReads = 0;
  const github = {
    readPullRequest: vi.fn(async () => {
      const index = Math.min(reads, headReads.length - 1);
      reads += 1;
      return pullRequest(headReads[index], reads <= 2 ? ["agent:implement"] : ["agent:in-progress"]);
    }),
    readFeedbackReplies: vi.fn()
      .mockImplementation(async () => canonicalReadback),
    readCurrentUnresolvedFeedback: vi.fn(async () => {
      const state = overrides.feedbackStates?.[Math.min(feedbackReads, overrides.feedbackStates.length - 1)];
      feedbackReads += 1;
      return state ?? {
        unresolvedRootCommentIds: overrides.feedbackRoots ?? [ROOT],
        replies: overrides.replies ?? [],
      };
    }),
    readCommitParent: vi.fn(async (sha: string) => overrides.parentOf?.(sha)),
    readUnresolvedReviewThreads: vi.fn().mockResolvedValue([{ commentId: ROOT, author: "reviewer", body: "Please fix." }]),
    addPullRequestLabel: vi.fn(async (_number: number, label: string) => {
      if (overrides.blockedLabelFailure && label === "agent:blocked") throw new Error("label unavailable");
    }),
    removePullRequestLabel: vi.fn(async (_number: number, label: string) => {
      if (overrides.finalizationFailures?.includes(label)) throw new Error(`label ${label} removal failed`);
    }),
    addFeedbackBlockedDiagnostic: vi.fn(async () => {
      if (overrides.diagnosticFailure) throw new Error("diagnostic unavailable");
    }),
    replyToReviewThread: vi.fn(async (request: { readonly reply: { readonly body: string } }) => {
      if (overrides.replyError !== undefined) throw overrides.replyError;
      if (overrides.writeAddsMarker === true) {
        canonicalReadback = [markerReply(request.reply.body)];
      }
    }),
  };
  const publisher = {
    prepare: vi.fn().mockResolvedValue(undefined),
    publish: vi.fn(async () => {
      if (overrides.publishError !== undefined) throw overrides.publishError;
      return POST;
    }),
  };
  const implementer = {
    implement: vi.fn().mockResolvedValue({
      reply: overrides.implementReply ?? { rootCommentId: ROOT, body: "Fixed." },
    }),
  };
  return {
    github,
    publisher,
    implementer,
    checkout: {
      withCheckout: vi.fn(async (_request, action) => action("/checkout")),
    },
    lease: { acquire: vi.fn(async () => ({ release: async () => {} })) },
    createJobId: () => "feedback-job",
    wait: async () => {},
    convergenceAttempts: overrides.convergenceAttempts,
    replyConvergenceAttempts: overrides.replyConvergenceAttempts,
  };
}

const CLEAN_FINALIZATION = { blockedStateFailed: false, diagnosticFailed: false, inProgressCleanupFailed: false };

describe("feedback implementation", () => {
  it("runs ordinary feedback through its production interface without reconciliation authorization", async () => {
    const subject = ports({ writeAddsMarker: true });

    await expect(runFeedbackImplementation({ pullRequestNumber: 224 }, subject))
      .resolves.toEqual({ status: "implemented", revision: POST, reconciled: false });

    expect(subject.implementer.implement).toHaveBeenCalledWith(expect.objectContaining({ rootCommentId: ROOT }));
  });

  it("does not adopt an old marker when a distinct unresolved root is the current intent", async () => {
    const oldRoot = "PRRC_old";
    const subject = ports({
      headReads: [PRE, PRE, PRE, POST],
      feedbackRoots: [ROOT],
      writeAddsMarker: true,
      readbackReplies: [marker(ROOT)],
    });

    await expect(runFeedbackImplementation({ pullRequestNumber: 224 }, subject))
      .resolves.toEqual({ status: "implemented", revision: POST, reconciled: false });

    expect(subject.implementer.implement).toHaveBeenCalledWith(expect.objectContaining({ rootCommentId: ROOT }));
  });

  it("selects a new root without historical marker rounds poisoning it", async () => {
    const oldRoot = "PRRC_old";
    const subject = ports({
      feedbackRoots: [oldRoot, ROOT],
      replies: [marker(oldRoot)],
      parentOf: (sha) => sha === POST ? PRE : undefined,
      writeAddsMarker: true,
    });

    await expect(runFeedbackImplementation({ pullRequestNumber: 224 }, subject))
      .resolves.toEqual({ status: "implemented", revision: POST, reconciled: false });

    expect(subject.implementer.implement).toHaveBeenCalledWith(expect.objectContaining({ rootCommentId: ROOT }));
  });

  it("fails closed before Agent execution when review state has multiple current roots", async () => {
    const subject = ports({ feedbackRoots: [ROOT, "PRRC_other"] });

    await expect(runFeedbackImplementation({ pullRequestNumber: 224 }, subject))
      .resolves.toEqual({
        status: "blocked",
        reason: "feedback-reconciliation",
        jobId: "feedback-job",
        summary: expect.any(String),
        finalization: CLEAN_FINALIZATION,
      });

    expect(subject.implementer.implement).not.toHaveBeenCalled();
    expect(subject.publisher.publish).not.toHaveBeenCalled();
  });

  it("fails closed before Agent execution when a thread already contains a non-canonical reply", async () => {
    const subject = ports({ replies: [markerReply("A third-party reply")] });

    await expect(runFeedbackImplementation({ pullRequestNumber: 224 }, subject))
      .resolves.toEqual({
        status: "blocked",
        reason: "feedback-reconciliation",
        jobId: "feedback-job",
        summary: expect.any(String),
        finalization: CLEAN_FINALIZATION,
      });

    expect(subject.implementer.implement).not.toHaveBeenCalled();
    expect(subject.publisher.publish).not.toHaveBeenCalled();
  });

  it("adopts matching evidence only for an explicit reconcile invocation", async () => {
    const state = [marker(ROOT)];
    const ordinary = ports({ headReads: [POST], replies: state, parentOf: () => PRE });

    await expect(runFeedbackImplementation({ pullRequestNumber: 224 }, ordinary))
      .resolves.toEqual(expect.objectContaining({ status: "blocked", reason: "feedback-reconciliation" }));

    const reconcile = ports({ headReads: [POST], replies: state, parentOf: () => PRE });
    await expect(runFeedbackImplementation({ pullRequestNumber: 224, authorization: { invocation: "reconcile" } }, reconcile))
      .resolves.toEqual({ status: "implemented", revision: POST, reconciled: true });
  });
  it("settles blocked Feedback Reconcile Authorization when Canonical Implementation Reply classification cannot read its parent", async () => {
    let parentReads = 0;
    const subject = ports({
      headReads: [POST],
      replies: [marker(ROOT)],
      parentOf: () => {
        parentReads += 1;
        if (parentReads === 2) throw new Error("commit graph unavailable");
        return PRE;
      },
    });

    await expect(runFeedbackImplementation({ pullRequestNumber: 224, authorization: { invocation: "reconcile" } }, subject))
      .resolves.toEqual({
        status: "blocked",
        reason: "feedback-reconciliation",
        jobId: "feedback-job",
        summary: "commit graph unavailable",
        finalization: CLEAN_FINALIZATION,
      });

    expect(subject.github.readCommitParent).toHaveBeenCalledTimes(2);
    expect(subject.github.addPullRequestLabel).toHaveBeenCalledWith(224, "agent:blocked");
    expect(subject.github.addFeedbackBlockedDiagnostic).toHaveBeenCalledWith(224, {
      reason: "feedback-reconciliation",
      jobId: "feedback-job",
      summary: "commit graph unavailable",
    });
    expect(subject.github.removePullRequestLabel).toHaveBeenCalledWith(224, "agent:in-progress");
  });

  it("settles blocked Feedback Reconcile Authorization when legacy evidence classification cannot read its parent", async () => {
    const subject = ports({
      headReads: [POST],
      replies: [markerReply(`Implemented in ${POST}`)],
      parentOf: () => { throw new Error("commit graph unavailable"); },
    });

    await expect(runFeedbackImplementation({
      pullRequestNumber: 224,
      authorization: { invocation: "reconcile", baseRevision: PRE },
    }, subject)).resolves.toEqual({
      status: "blocked",
      reason: "feedback-reconciliation",
      jobId: "feedback-job",
      summary: "commit graph unavailable",
      finalization: CLEAN_FINALIZATION,
    });

    expect(subject.github.readCommitParent).toHaveBeenCalledTimes(1);
    expect(subject.github.addPullRequestLabel).toHaveBeenCalledWith(224, "agent:blocked");
    expect(subject.github.addFeedbackBlockedDiagnostic).toHaveBeenCalledWith(224, {
      reason: "feedback-reconciliation",
      jobId: "feedback-job",
      summary: "commit graph unavailable",
    });
    expect(subject.github.removePullRequestLabel).toHaveBeenCalledWith(224, "agent:in-progress");
  });

  it("publishes only through the controlled publisher and verifies the existing PR head", async () => {
    const subject = ports();

    await expect(runFeedbackImplementation({ pullRequestNumber: 224 }, subject))
      .resolves.toEqual({ status: "implemented", revision: POST, reconciled: false });

    expect(subject.publisher.prepare).toHaveBeenCalledWith("/checkout", "feature/feedback", PRE);
    expect(subject.implementer.implement).toHaveBeenCalledWith({
      pullRequestNumber: 224,
      branch: "feature/feedback",
      revision: PRE,
      checkoutPath: "/checkout",
      rootCommentId: ROOT,
    });
    expect(subject.publisher.publish).toHaveBeenCalledWith({
      checkoutPath: "/checkout",
      branch: "feature/feedback",
      expectedRevision: PRE,
    });
  });

  it("does not publish when a second current feedback root appears during execution", async () => {
    const subject = ports({
      feedbackStates: [
        { unresolvedRootCommentIds: [ROOT], replies: [] },
        { unresolvedRootCommentIds: [ROOT, "PRRC_new"], replies: [] },
      ],
    });

    await expect(runFeedbackImplementation({ pullRequestNumber: 224 }, subject))
      .resolves.toEqual(expect.objectContaining({ status: "blocked", reason: "feedback-reconciliation" }));

    expect(subject.publisher.publish).not.toHaveBeenCalled();
    expect(subject.github.replyToReviewThread).not.toHaveBeenCalled();
  });

  it("does not publish when the selected root receives a canonical marker during execution", async () => {
    const subject = ports({
      feedbackStates: [
        { unresolvedRootCommentIds: [ROOT], replies: [] },
        { unresolvedRootCommentIds: [ROOT], replies: [marker(ROOT)] },
      ],
      parentOf: (sha) => sha === POST ? PRE : undefined,
    });

    await expect(runFeedbackImplementation({ pullRequestNumber: 224 }, subject))
      .resolves.toEqual(expect.objectContaining({ status: "blocked", reason: "feedback-reconciliation" }));

    expect(subject.publisher.publish).not.toHaveBeenCalled();
    expect(subject.github.replyToReviewThread).not.toHaveBeenCalled();
  });
  it("does not reply after a same-thread follow-up appears post-publication", async () => {
    const subject = ports({
      feedbackStates: [
        { unresolvedRootCommentIds: [ROOT], replies: [] },
        { unresolvedRootCommentIds: [ROOT], replies: [] },
        { unresolvedRootCommentIds: [ROOT], replies: [markerReply("Reviewer follow-up")] },
      ],
    });

    await expect(runFeedbackImplementation({ pullRequestNumber: 224 }, subject))
      .resolves.toEqual(expect.objectContaining({ status: "blocked", reason: "feedback-reconciliation", revision: POST }));

    expect(subject.publisher.publish).toHaveBeenCalledTimes(1);
    expect(subject.github.replyToReviewThread).not.toHaveBeenCalled();
  });
  it("converges when the first post-push read still sees the acquired PRE", async () => {
    const subject = ports({ headReads: [PRE, PRE, PRE, PRE, POST] });

    await expect(runFeedbackImplementation({ pullRequestNumber: 224 }, subject))
      .resolves.toEqual({ status: "implemented", revision: POST, reconciled: false });

    expect(subject.publisher.publish).toHaveBeenCalledTimes(1);
    expect(subject.github.readPullRequest).toHaveBeenCalledTimes(5);
  });

  it("retries only explicitly transient post-push read errors", async () => {
    const transient = Object.assign(new Error("network reset"), { transient: true });
    const subject = ports({
      headReads: [PRE, PRE, PRE, POST],
    });
    subject.github.readPullRequest.mockReset()
      .mockResolvedValueOnce(pullRequest(PRE))
      .mockResolvedValueOnce(pullRequest(PRE))
      .mockResolvedValueOnce(pullRequest(PRE, ["agent:in-progress"]))
      .mockRejectedValueOnce(transient)
      .mockResolvedValue(pullRequest(POST, ["agent:in-progress"]));

    await expect(runFeedbackImplementation({ pullRequestNumber: 224 }, subject))
      .resolves.toEqual({ status: "implemented", revision: POST, reconciled: false });

    expect(subject.github.readPullRequest).toHaveBeenCalledTimes(5);
  });

  it("returns a typed indeterminate outcome when the head stays at PRE without a second push", async () => {
    const subject = ports({ headReads: [PRE, PRE, PRE, PRE, PRE, PRE], convergenceAttempts: 3 });

    await expect(runFeedbackImplementation({ pullRequestNumber: 224 }, subject))
      .resolves.toEqual({
        status: "blocked",
        reason: "feedback-convergence",
        jobId: "feedback-job",
        summary: expect.any(String),
        revision: POST,
        finalization: CLEAN_FINALIZATION,
      });

    expect(subject.publisher.publish).toHaveBeenCalledTimes(1);
    expect(subject.github.replyToReviewThread).not.toHaveBeenCalled();
    expect(subject.github.addPullRequestLabel).toHaveBeenCalledWith(224, "agent:blocked");
    expect(subject.github.removePullRequestLabel).toHaveBeenCalledWith(224, "agent:in-progress");
  });

  it("fails closed on a third-party head without overwriting it", async () => {
    const subject = ports({ headReads: [PRE, PRE, PRE, OTHER] });

    await expect(runFeedbackImplementation({ pullRequestNumber: 224 }, subject))
      .resolves.toEqual({
        status: "blocked",
        reason: "feedback-head-conflict",
        jobId: "feedback-job",
        summary: expect.any(String),
        revision: POST,
        finalization: CLEAN_FINALIZATION,
      });

    expect(subject.publisher.publish).toHaveBeenCalledTimes(1);
    expect(subject.github.replyToReviewThread).not.toHaveBeenCalled();
    expect(subject.github.addPullRequestLabel).toHaveBeenCalledWith(224, "agent:blocked");
  });

  it("blocks a reply publication failure with the published revision and adopts it on re-entry", async () => {
    const first = ports({ replyError: new Error("reply lost") });
    first.github.readFeedbackReplies.mockReset().mockResolvedValue([]);

    await expect(runFeedbackImplementation({ pullRequestNumber: 224 }, first))
      .resolves.toEqual({
        status: "blocked",
        reason: "feedback-reply",
        jobId: "feedback-job",
        summary: expect.any(String),
        revision: POST,
        finalization: CLEAN_FINALIZATION,
      });

    // A later authorized invocation observes durable state before any Agent
    // execution or publication and adopts the exact POST without rerunning.
    const second = ports({
      headReads: [POST, POST, POST, POST],
      replies: [markerReply(feedbackReplyMarker({ pullRequestNumber: 224, pre: PRE, post: POST, rootCommentId: ROOT }))],
      parentOf: () => PRE,
    });

    await expect(runFeedbackImplementation({ pullRequestNumber: 224, authorization: { invocation: "reconcile", baseRevision: PRE } }, second))
      .resolves.toEqual({ status: "implemented", revision: POST, reconciled: true });

    expect(second.implementer.implement).not.toHaveBeenCalled();
    expect(second.publisher.publish).not.toHaveBeenCalled();
    expect(second.github.replyToReviewThread).not.toHaveBeenCalled();
    expect(second.github.removePullRequestLabel).toHaveBeenCalledWith(224, "agent:blocked");
    expect(second.github.removePullRequestLabel).toHaveBeenCalledWith(224, "agent:in-progress");
    expect(second.github.removePullRequestLabel).toHaveBeenCalledWith(224, "agent:implement");
  });

  it("waits for delayed canonical reply visibility after a successful write without posting twice", async () => {
    const subject = ports({ replyConvergenceAttempts: 3 });
    subject.github.readFeedbackReplies.mockReset()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([marker(ROOT)]);

    await expect(runFeedbackImplementation({ pullRequestNumber: 224 }, subject))
      .resolves.toEqual({ status: "implemented", revision: POST, reconciled: false });

    expect(subject.github.replyToReviewThread).toHaveBeenCalledTimes(1);
    expect(subject.github.readFeedbackReplies).toHaveBeenCalledTimes(2);
  });

  it("waits for delayed canonical reply visibility after an uncertain write without posting twice", async () => {
    const subject = ports({ replyError: new Error("response lost"), replyConvergenceAttempts: 3 });
    subject.github.readFeedbackReplies.mockReset()
      .mockResolvedValueOnce([])
      .mockResolvedValue([marker(ROOT)]);

    await expect(runFeedbackImplementation({ pullRequestNumber: 224 }, subject))
      .resolves.toEqual({ status: "implemented", revision: POST, reconciled: false });

    expect(subject.github.replyToReviewThread).toHaveBeenCalledTimes(1);
    expect(subject.github.readFeedbackReplies).toHaveBeenCalledTimes(2);
  });

  it("does not write a reply-only completion after feedback intent changes", async () => {
    const subject = ports({
      headReads: [POST],
      parentOf: () => PRE,
      feedbackStates: [
        { unresolvedRootCommentIds: [ROOT], replies: [] },
        { unresolvedRootCommentIds: [ROOT, "PRRC_new"], replies: [] },
      ],
    });

    await expect(runFeedbackImplementation({
      pullRequestNumber: 224,
      authorization: {
        invocation: "reconcile",
        expectedPost: POST,
        expectedReply: { rootCommentId: ROOT, body: "Fixed." },
      },
    }, subject)).resolves.toEqual(expect.objectContaining({
      status: "blocked",
      reason: "feedback-reconciliation",
      revision: POST,
    }));

    expect(subject.github.replyToReviewThread).not.toHaveBeenCalled();
  });
  it("does not retry a reply readback after an uncertain write has converged", async () => {
    const subject = ports({ replyError: new Error("response lost"), replyConvergenceAttempts: 2 });
    subject.github.readFeedbackReplies.mockReset()
      .mockResolvedValueOnce([marker(ROOT)])
      .mockResolvedValueOnce([]);

    await expect(runFeedbackImplementation({ pullRequestNumber: 224 }, subject))
      .resolves.toEqual({ status: "implemented", revision: POST, reconciled: false });

    expect(subject.github.replyToReviewThread).toHaveBeenCalledTimes(1);
    expect(subject.github.readFeedbackReplies).toHaveBeenCalledTimes(1);
  });

  it("fails closed when canonical readback has a structurally conflicting marker", async () => {
    const subject = ports({ replyConvergenceAttempts: 1 });
    subject.github.readFeedbackReplies.mockReset().mockResolvedValue([
      marker(ROOT),
      markerReply(feedbackReplyMarker({ pullRequestNumber: 224, pre: PRE, post: POST, rootCommentId: "PRRC_other" })),
    ]);

    await expect(runFeedbackImplementation({ pullRequestNumber: 224 }, subject))
      .resolves.toEqual(expect.objectContaining({ status: "blocked", reason: "feedback-reply", revision: POST }));
  });
  it("does not duplicate a reply whose POST landed even when the response was lost", async () => {
    const subject = ports({ replyError: new Error("response lost"), writeAddsMarker: true });
    subject.github.readFeedbackReplies.mockReset()
      .mockImplementation(async () => [marker(ROOT)]);

    await expect(runFeedbackImplementation({ pullRequestNumber: 224 }, subject))
      .resolves.toEqual({ status: "implemented", revision: POST, reconciled: false });

    expect(subject.github.replyToReviewThread).toHaveBeenCalledTimes(1);
  });

  it("performs a controlled reply-only completion without running the Agent or pushing", async () => {
    const subject = ports({ headReads: [POST, POST, POST, POST], parentOf: () => PRE });

    await expect(runFeedbackImplementation({
      pullRequestNumber: 224,
      authorization: {
        invocation: "reconcile",
        expectedPost: POST,
        expectedReply: { rootCommentId: ROOT, body: "Fixed." },
      },
    }, subject)).resolves.toEqual({ status: "implemented", revision: POST, reconciled: true });

    expect(subject.implementer.implement).not.toHaveBeenCalled();
    expect(subject.publisher.publish).not.toHaveBeenCalled();
    expect(subject.github.replyToReviewThread).toHaveBeenCalledTimes(1);
    expect(subject.github.replyToReviewThread).toHaveBeenCalledWith({
      pullRequestNumber: 224,
      reply: expect.objectContaining({ commentId: ROOT }),
    });
  });

  it("fails closed on ambiguous publication evidence without touching anything", async () => {
    const replies = [
      markerReply(feedbackReplyMarker({ pullRequestNumber: 224, pre: PRE, post: POST, rootCommentId: ROOT })),
      markerReply(feedbackReplyMarker({ pullRequestNumber: 224, pre: PRE, post: POST, rootCommentId: ROOT })),
    ];
    const subject = ports({ headReads: [POST, POST, POST, POST], replies });

    await expect(runFeedbackImplementation({ pullRequestNumber: 224 }, subject))
      .resolves.toEqual({
        status: "blocked",
        reason: "feedback-reconciliation",
        jobId: "feedback-job",
        summary: expect.any(String),
        finalization: CLEAN_FINALIZATION,
      });

    expect(subject.implementer.implement).not.toHaveBeenCalled();
    expect(subject.publisher.publish).not.toHaveBeenCalled();
    expect(subject.github.replyToReviewThread).not.toHaveBeenCalled();
    expect(subject.github.addPullRequestLabel).toHaveBeenCalledWith(224, "agent:blocked");
  });

  it("rejects a rejected force-with-lease publication as blocked without a retry", async () => {
    const subject = ports({ publishError: new Error("stale info") });

    await expect(runFeedbackImplementation({ pullRequestNumber: 224 }, subject))
      .resolves.toEqual({
        status: "blocked",
        reason: "feedback-publication",
        jobId: "feedback-job",
        summary: expect.any(String),
        finalization: CLEAN_FINALIZATION,
      });

    expect(subject.publisher.publish).toHaveBeenCalledTimes(1);
    expect(subject.github.replyToReviewThread).not.toHaveBeenCalled();
    expect(subject.github.addPullRequestLabel).toHaveBeenCalledWith(224, "agent:blocked");
  });

  it("reflects an in-progress cleanup failure in a typed finalization outcome", async () => {
    const subject = ports({ finalizationFailures: ["agent:in-progress"] });

    await expect(runFeedbackImplementation({ pullRequestNumber: 224 }, subject))
      .resolves.toEqual({
        status: "blocked",
        reason: "feedback-finalization",
        jobId: "feedback-job",
        summary: expect.any(String),
        revision: POST,
        finalization: { blockedStateFailed: false, diagnosticFailed: false, inProgressCleanupFailed: true },
      });
  });

  it("distinguishes a blocked-state mutation failure from the original execution failure", async () => {
    const subject = ports({ replyError: new Error("reply lost"), blockedLabelFailure: true });
    subject.github.readFeedbackReplies.mockReset().mockResolvedValue([]);

    await expect(runFeedbackImplementation({ pullRequestNumber: 224 }, subject))
      .resolves.toEqual({
        status: "blocked",
        reason: "feedback-reply",
        jobId: "feedback-job",
        summary: expect.any(String),
        revision: POST,
        finalization: { blockedStateFailed: true, diagnosticFailed: false, inProgressCleanupFailed: false },
      });
  });

  it("records a diagnostic settlement failure without skipping blocked-label or cleanup attempts", async () => {
    const subject = ports({ diagnosticFailure: true });
    subject.implementer.implement.mockRejectedValue(new Error("execution failed"));

    await expect(runFeedbackImplementation({ pullRequestNumber: 224 }, subject))
      .resolves.toEqual({
        status: "blocked",
        reason: "feedback-execution",
        jobId: "feedback-job",
        summary: "execution failed",
        finalization: { blockedStateFailed: false, diagnosticFailed: true, inProgressCleanupFailed: false },
      });

    expect(subject.github.addPullRequestLabel).toHaveBeenCalledWith(224, "agent:blocked");
    expect(subject.github.removePullRequestLabel).toHaveBeenCalledWith(224, "agent:in-progress");
  });

  it("reconciles the current Canary-shaped state without Agent, push, or reply creation", async () => {
    const subject = ports({
      headReads: [POST, POST, POST, POST],
      replies: [markerReply(feedbackReplyMarker({ pullRequestNumber: 224, pre: PRE, post: POST, rootCommentId: ROOT }))],
      parentOf: () => PRE,
    });
    subject.github.readPullRequest.mockReset()
      .mockResolvedValue(pullRequest(POST, ["agent:blocked"]));

    await expect(runFeedbackImplementation({ pullRequestNumber: 224, authorization: { invocation: "reconcile", baseRevision: PRE } }, subject))
      .resolves.toEqual({ status: "implemented", revision: POST, reconciled: true });

    expect(subject.implementer.implement).not.toHaveBeenCalled();
    expect(subject.publisher.publish).not.toHaveBeenCalled();
    expect(subject.github.replyToReviewThread).not.toHaveBeenCalled();
    expect(subject.github.addPullRequestLabel).not.toHaveBeenCalled();
    expect(subject.github.removePullRequestLabel).toHaveBeenCalledWith(224, "agent:blocked");
  });

  it("rejects a mismatching Agent reply root before publication or post-publication work", async () => {
    const subject = ports({ implementReply: { rootCommentId: "PRRC_nope", body: "Fixed." } });

    await expect(runFeedbackImplementation({ pullRequestNumber: 224 }, subject))
      .resolves.toEqual({
        status: "blocked",
        reason: "feedback-reply",
        jobId: "feedback-job",
        summary: expect.any(String),
        finalization: CLEAN_FINALIZATION,
      });

    expect(subject.publisher.publish).not.toHaveBeenCalled();
    expect(subject.github.readUnresolvedReviewThreads).not.toHaveBeenCalled();
    expect(subject.github.replyToReviewThread).not.toHaveBeenCalled();
    expect(subject.github.readFeedbackReplies).not.toHaveBeenCalled();
    expect(subject.github.addPullRequestLabel).toHaveBeenCalledWith(224, "agent:blocked");
    expect(subject.github.removePullRequestLabel).toHaveBeenCalledWith(224, "agent:in-progress");
  });

  it("blocks the work item when the PR head differs after publication", async () => {
    const subject = ports({ headReads: [PRE, PRE, PRE, OTHER] });

    await expect(runFeedbackImplementation({ pullRequestNumber: 224 }, subject))
      .resolves.toEqual({
        status: "blocked",
        reason: "feedback-head-conflict",
        jobId: "feedback-job",
        summary: expect.any(String),
        revision: POST,
        finalization: CLEAN_FINALIZATION,
      });

    expect(subject.github.addPullRequestLabel).toHaveBeenCalledWith(224, "agent:blocked");
    expect(subject.github.removePullRequestLabel).toHaveBeenCalledWith(224, "agent:in-progress");
  });

  it("types a non-transient post-push read failure as convergence with the published revision", async () => {
    const subject = ports({ headReads: [PRE, PRE, PRE, POST] });
    subject.github.readPullRequest.mockReset()
      .mockResolvedValueOnce(pullRequest(PRE))
      .mockResolvedValueOnce(pullRequest(PRE))
      .mockResolvedValueOnce(pullRequest(PRE, ["agent:in-progress"]))
      .mockRejectedValueOnce(new Error("unexpected read failure"))
      .mockResolvedValue(pullRequest(POST, ["agent:in-progress"]));

    await expect(runFeedbackImplementation({ pullRequestNumber: 224 }, subject))
      .resolves.toEqual({
        status: "blocked",
        reason: "feedback-convergence",
        jobId: "feedback-job",
        summary: expect.any(String),
        revision: POST,
        finalization: CLEAN_FINALIZATION,
      });

    expect(subject.publisher.publish).toHaveBeenCalledTimes(1);
    expect(subject.github.replyToReviewThread).not.toHaveBeenCalled();
  });

  it("types a readback read failure as a reply-stage failure with the published revision", async () => {
    const subject = ports({ headReads: [PRE, PRE, PRE, POST] });
    subject.github.readFeedbackReplies.mockReset()
      .mockResolvedValueOnce([])
      .mockRejectedValueOnce(new Error("readback read failed"))
      .mockResolvedValue([marker()]);

    await expect(runFeedbackImplementation({ pullRequestNumber: 224 }, subject))
      .resolves.toEqual({
        status: "blocked",
        reason: "feedback-reply",
        jobId: "feedback-job",
        summary: expect.any(String),
        revision: POST,
        finalization: CLEAN_FINALIZATION,
      });

    expect(subject.github.replyToReviewThread).toHaveBeenCalledTimes(1);
    expect(subject.github.addPullRequestLabel).toHaveBeenCalledWith(224, "agent:blocked");
  });

  it("types a reply-target read failure as a reply-stage failure with the published revision", async () => {
    const subject = ports({ headReads: [PRE, PRE, PRE, POST] });
    subject.github.readUnresolvedReviewThreads.mockRejectedValue(new Error("threads unavailable"));

    await expect(runFeedbackImplementation({ pullRequestNumber: 224 }, subject))
      .resolves.toEqual({
        status: "blocked",
        reason: "feedback-reply",
        jobId: "feedback-job",
        summary: expect.any(String),
        revision: POST,
        finalization: CLEAN_FINALIZATION,
      });
  });

  it("adopts strict unique legacy evidence when the acquired revision is authorized", async () => {
    const subject = ports({
      headReads: [POST, POST, POST, POST],
      replies: [markerReply(`Implemented in ${POST}.`)],
      parentOf: () => PRE,
    });

    await expect(runFeedbackImplementation({ pullRequestNumber: 224, authorization: { invocation: "reconcile", baseRevision: PRE } }, subject))
      .resolves.toEqual({ status: "implemented", revision: POST, reconciled: true });

    expect(subject.implementer.implement).not.toHaveBeenCalled();
    expect(subject.publisher.publish).not.toHaveBeenCalled();
    expect(subject.github.replyToReviewThread).not.toHaveBeenCalled();
    expect(subject.github.removePullRequestLabel).toHaveBeenCalledWith(224, "agent:blocked");
  });

  it("fails closed on legacy evidence without an authorized acquired revision", async () => {
    const subject = ports({
      headReads: [POST, POST, POST, POST],
      replies: [markerReply(`Implemented in ${POST}.`)],
    });

    await expect(runFeedbackImplementation({ pullRequestNumber: 224 }, subject))
      .resolves.toEqual({
        status: "blocked",
        reason: "feedback-reconciliation",
        jobId: "feedback-job",
        summary: expect.any(String),
        finalization: CLEAN_FINALIZATION,
      });

    expect(subject.implementer.implement).not.toHaveBeenCalled();
    expect(subject.publisher.publish).not.toHaveBeenCalled();
    expect(subject.github.replyToReviewThread).not.toHaveBeenCalled();
  });

  it("blocks the work item and retains the local job diagnostic when the feedback job times out", async () => {
    const subject = ports();
    subject.implementer.implement.mockRejectedValue(new Error("Feedback implementation execution timed out"));

    await expect(runFeedbackImplementation({ pullRequestNumber: 224 }, subject))
      .resolves.toEqual({
        status: "blocked",
        reason: "feedback-execution",
        jobId: "feedback-job",
        summary: expect.any(String),
        finalization: CLEAN_FINALIZATION,
      });

    expect(subject.publisher.publish).not.toHaveBeenCalled();
    expect(subject.github.addFeedbackBlockedDiagnostic).toHaveBeenCalledWith(224, {
      reason: "feedback-execution",
      jobId: "feedback-job",
      summary: "Feedback implementation execution timed out",
    });
    expect(subject.github.addPullRequestLabel).toHaveBeenCalledWith(224, "agent:blocked");
    expect(subject.github.removePullRequestLabel).toHaveBeenCalledWith(224, "agent:in-progress");
  });
});
