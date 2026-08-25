import { redact as redactFailureSummary } from "./redaction.ts";
import type { ReviewAutomationPullRequest, ReviewThreadComment } from "./review-automation.js";
import {
  classifyFeedbackReconciliation,
  countFeedbackMarkerReplies,
  feedbackReplyMarker,
  type FeedbackReplyMarker,
  type FeedbackThreadReply,
} from "./feedback-reconciliation.ts";
import { convergeFeedbackHead } from "./feedback-convergence.ts";

export interface FeedbackReplyIntent {
  readonly rootCommentId: string;
  readonly body: string;
}

export type FeedbackBlockedReason =
  | "feedback-execution"
  | "feedback-publication"
  | "feedback-convergence"
  | "feedback-head-conflict"
  | "feedback-reply"
  | "feedback-reconciliation"
  | "feedback-finalization";

export interface FeedbackFinalization {
  readonly blockedStateFailed: boolean;
  readonly diagnosticFailed: boolean;
  readonly inProgressCleanupFailed: boolean;
}

export interface FeedbackImplementationPorts {
  readonly github: {
    readPullRequest(pullRequestNumber: number): Promise<ReviewAutomationPullRequest & { readonly headRefName: string }>;
    readFeedbackReplies(pullRequestNumber: number): Promise<readonly FeedbackThreadReply[]>;
    readCommitParent(sha: string): Promise<string | undefined>;
    readUnresolvedReviewThreads(pullRequestNumber: number): Promise<readonly ReviewThreadComment[]>;
    addPullRequestLabel(pullRequestNumber: number, label: string): Promise<void>;
    removePullRequestLabel(pullRequestNumber: number, label: string): Promise<void>;
    replyToReviewThread(request: {
      readonly pullRequestNumber: number;
      readonly reply: { readonly commentId: string; readonly body: string };
    }): Promise<void>;
    addRefusalDiagnostic?(pullRequestNumber: number, reason: string): Promise<void>;
    addFeedbackBlockedDiagnostic?(
      pullRequestNumber: number,
      diagnostic: { readonly reason: FeedbackBlockedReason; readonly jobId: string; readonly summary: string },
    ): Promise<void>;
  };
  readonly checkout: {
    withCheckout<TResult>(
      request: { readonly pullRequestNumber: number; readonly revision: string },
      action: (checkoutPath: string) => Promise<TResult>,
    ): Promise<TResult>;
  };
  readonly publisher: {
    prepare(checkoutPath: string, branch: string, revision: string): Promise<void>;
    publish(request: {
      readonly checkoutPath: string;
      readonly branch: string;
      readonly expectedRevision: string;
    }): Promise<string>;
  };
  readonly implementer: {
    implement(request: {
      readonly pullRequestNumber: number;
      readonly branch: string;
      readonly revision: string;
      readonly checkoutPath: string;
    }): Promise<{ readonly reply: FeedbackReplyIntent }>;
  };
  readonly lease: {
    acquire(pullRequestNumber: number): Promise<{ release(): Promise<void> | void } | undefined>;
  };
  readonly createJobId?: () => string;
  readonly wait?: (milliseconds: number) => Promise<void>;
  readonly convergenceAttempts?: number;
  readonly isTransientReadError?: (error: unknown) => boolean;
}

export type FeedbackImplementationResult =
  | { readonly status: "implemented"; readonly revision: string; readonly reconciled: boolean }
  | { readonly status: "refused"; readonly reason: string }
  | {
      readonly status: "blocked";
      readonly reason: FeedbackBlockedReason;
      readonly jobId: string;
      readonly summary: string;
      readonly revision?: string;
      readonly finalization?: FeedbackFinalization;
    };

const activePullRequestNumbers = new Set<number>();

// Application policy: post-push reads poll a conservative small bound; a
// third-party SHA fails closed immediately and exhaustion is indeterminate
// rather than repeated publication.
const CONVERGENCE_ATTEMPTS = 5;
const CONVERGENCE_POLL_DELAY_MILLISECONDS = 2000;

class FeedbackStageError extends Error {
  readonly stage: FeedbackBlockedReason;
  readonly revision: string | undefined;
  constructor(stage: FeedbackBlockedReason, message: string, revision?: string) {
    super(message);
    this.name = "FeedbackStageError";
    this.stage = stage;
    this.revision = revision;
  }
}

function refusal(pullRequest: ReviewAutomationPullRequest): string | undefined {
  if (pullRequest.state !== "OPEN") return `Pull Request #${pullRequest.number} is not open`;
  if (!pullRequest.isDraft) return `Pull Request #${pullRequest.number} is not a Draft`;
  if (pullRequest.baseRepository !== pullRequest.headRepository) return `Pull Request #${pullRequest.number} must not originate from a fork`;
  if (!/^[0-9a-f]{40}$/u.test(pullRequest.headSha)) return `Pull Request #${pullRequest.number} has an invalid head revision`;
  if (!pullRequest.labels.includes("agent:implement")) return `Pull Request #${pullRequest.number} is not queued for feedback implementation`;
  if (pullRequest.labels.includes("agent:in-progress")) return `Pull Request #${pullRequest.number} is already in progress`;
  if (pullRequest.labels.includes("agent:blocked")) return `Pull Request #${pullRequest.number} is blocked`;
  return undefined;
}

function blocked(
  jobId: string,
  reason: FeedbackBlockedReason,
  summary: string,
  extra?: { readonly revision?: string; readonly finalization?: FeedbackFinalization },
): FeedbackImplementationResult {
  return {
    status: "blocked",
    reason,
    jobId,
    summary,
    ...(extra?.revision === undefined ? {} : { revision: extra.revision }),
    ...(extra?.finalization === undefined ? {} : { finalization: extra.finalization }),
  };
}

async function waitFor(ports: FeedbackImplementationPorts, milliseconds: number): Promise<void> {
  const wait = ports.wait ?? ((delay) => new Promise((resolveWait) => setTimeout(resolveWait, delay)));
  await wait(milliseconds);
}

// The orchestrator is the single canonical reply writer: it publishes the
// reply with bounded provenance and reads the marker back so a lost response
// cannot create a duplicate (#293).
async function publishCanonicalReply(request: {
  readonly pullRequestNumber: number;
  readonly pre: string;
  readonly post: string;
  readonly rootCommentId: string;
  readonly body: string;
  readonly github: FeedbackImplementationPorts["github"];
}): Promise<void> {
  const marker: FeedbackReplyMarker = {
    pullRequestNumber: request.pullRequestNumber,
    pre: request.pre,
    post: request.post,
    rootCommentId: request.rootCommentId,
  };
  const markerBody = `${request.body}\n\n${feedbackReplyMarker(marker)}`;
  try {
    await request.github.replyToReviewThread({
      pullRequestNumber: request.pullRequestNumber,
      reply: { commentId: request.rootCommentId, body: markerBody },
    });
  } catch (error) {
    const landed = countFeedbackMarkerReplies(
      await request.github.readFeedbackReplies(request.pullRequestNumber),
      marker,
    );
    if (landed !== 1) {
      throw new FeedbackStageError(
        "feedback-reply",
        error instanceof Error ? error.message : String(error),
        request.post,
      );
    }
  }
  const after = await request.github.readFeedbackReplies(request.pullRequestNumber);
  if (countFeedbackMarkerReplies(after, marker) !== 1) {
    throw new FeedbackStageError(
      "feedback-reply",
      "Canonical feedback reply did not converge to exactly one marker",
      request.post,
    );
  }
}

async function settleBlockedState(
  ports: FeedbackImplementationPorts,
  pullRequestNumber: number,
  jobId: string,
  reason: FeedbackBlockedReason,
  summary: string,
): Promise<FeedbackFinalization> {
  const [blockedLabel, diagnostic, inProgressCleanup] = await Promise.allSettled([
    ports.github.addPullRequestLabel(pullRequestNumber, "agent:blocked"),
    ports.github.addFeedbackBlockedDiagnostic?.(pullRequestNumber, { reason, jobId, summary }) ?? Promise.resolve(),
    ports.github.removePullRequestLabel(pullRequestNumber, "agent:in-progress"),
  ]);
  return {
    blockedStateFailed: blockedLabel.status === "rejected",
    diagnosticFailed: diagnostic.status === "rejected",
    inProgressCleanupFailed: inProgressCleanup.status === "rejected",
  };
}

// Reconciliation finalization: adopted or reply-only completions must leave
// managed labels consistent, and a cleanup failure is not best effort (#293).
async function finalizeAdopted(
  pullRequestNumber: number,
  post: string,
  jobId: string,
  ports: FeedbackImplementationPorts,
): Promise<FeedbackImplementationResult> {
  const results = await Promise.allSettled([
    ports.github.removePullRequestLabel(pullRequestNumber, "agent:blocked"),
    ports.github.removePullRequestLabel(pullRequestNumber, "agent:in-progress"),
    ports.github.removePullRequestLabel(pullRequestNumber, "agent:implement"),
  ]);
  if (results.some((result) => result.status === "rejected")) {
    return blocked(jobId, "feedback-finalization", "Adopted feedback state could not be finalized", { revision: post });
  }
  return { status: "implemented", revision: post, reconciled: true };
}

export async function runFeedbackImplementationAutomationCommand(
  request: {
    readonly pullRequestNumber: number;
    readonly baseRevision?: string;
    readonly expectedPost?: string;
    readonly expectedReply?: FeedbackReplyIntent;
  },
  ports: FeedbackImplementationPorts,
): Promise<FeedbackImplementationResult> {
  const jobId = ports.createJobId?.() ?? "local-feedback-job";
  if (activePullRequestNumbers.has(request.pullRequestNumber)) {
    return { status: "refused", reason: `Pull Request #${request.pullRequestNumber} is already being processed` };
  }
  const pullRequest = await ports.github.readPullRequest(request.pullRequestNumber);

  // Observe-first reconciliation: durable GitHub facts decide re-entry before
  // any Agent execution or publication (#293).
  const reconciliation = await classifyFeedbackReconciliation({
    pullRequestNumber: request.pullRequestNumber,
    headSha: pullRequest.headSha,
    // A known acquired revision arrives only from a controlled reconcile
    // authorization; ordinary dispatch observes first without a base to prove
    // legacy evidence against and lets the existing acquisition checks race.
    baseRevision: request.baseRevision,
    ...(request.expectedPost === undefined ? {} : { expectedPost: request.expectedPost }),
    replies: await ports.github.readFeedbackReplies(request.pullRequestNumber),
    parentOf: (sha) => ports.github.readCommitParent(sha),
  });
  switch (reconciliation.status) {
    case "adopt":
      return finalizeAdopted(request.pullRequestNumber, reconciliation.post, jobId, ports);
    case "reply-only": {
      if (request.expectedReply === undefined) {
        const finalization = await settleBlockedState(ports, request.pullRequestNumber, jobId, "feedback-reconciliation", "Reply-only completion requires the reply intent");
        return blocked(jobId, "feedback-reconciliation", "Reply-only completion requires the reply intent", { finalization });
      }
      const parent = await ports.github.readCommitParent(reconciliation.post);
      if (parent === undefined) {
        const finalization = await settleBlockedState(ports, request.pullRequestNumber, jobId, "feedback-reconciliation", "Reply-only completion cannot prove the acquired revision");
        return blocked(jobId, "feedback-reconciliation", "Reply-only completion cannot prove the acquired revision", { finalization });
      }
      try {
        await publishCanonicalReply({
          pullRequestNumber: request.pullRequestNumber,
          pre: parent,
          post: reconciliation.post,
          rootCommentId: request.expectedReply.rootCommentId,
          body: request.expectedReply.body,
          github: ports.github,
        });
      } catch (error) {
        const summary = redactFailureSummary(error instanceof Error ? error.message : String(error));
        const finalization = await settleBlockedState(ports, request.pullRequestNumber, jobId, "feedback-reply", summary);
        return blocked(jobId, "feedback-reply", summary, {
          revision: reconciliation.post,
          finalization,
        });
      }
      return finalizeAdopted(request.pullRequestNumber, reconciliation.post, jobId, ports);
    }
    case "fail-closed": {
      const finalization = await settleBlockedState(ports, request.pullRequestNumber, jobId, "feedback-reconciliation", reconciliation.reason);
      return blocked(jobId, "feedback-reconciliation", reconciliation.reason, { finalization });
    }
    case "proceed":
      break;
  }

  // Business preflight refusal (#219 story 17): remove the trigger and
  // explain on the Automation Work Item, without agent:blocked, so an
  // inapplicable request (e.g. a fork Pull Request) does not re-refuse
  // every round.
  const reason = refusal(pullRequest);
  if (reason !== undefined) {
    await ports.github.removePullRequestLabel(pullRequest.number, "agent:implement");
    await ports.github.addRefusalDiagnostic?.(pullRequest.number, reason);
    return { status: "refused", reason };
  }

  const lease = await ports.lease.acquire(pullRequest.number);
  if (lease === undefined) {
    return { status: "refused", reason: `Pull Request #${pullRequest.number} is already being processed` };
  }
  activePullRequestNumbers.add(pullRequest.number);
  try {
    const current = await ports.github.readPullRequest(pullRequest.number);
    const currentReason = refusal(current);
    if (currentReason !== undefined) {
      await ports.github.removePullRequestLabel(pullRequest.number, "agent:implement");
      await ports.github.addRefusalDiagnostic?.(pullRequest.number, currentReason);
      return { status: "refused", reason: currentReason };
    }
    if (current.headSha !== pullRequest.headSha) {
      // A moved head is a race, not a business refusal: keep the trigger so
      // the next dispatch round implements feedback on the new head.
      return { status: "refused", reason: `Pull Request #${pullRequest.number} head changed while feedback implementation was being acquired` };
    }
    await ports.github.addPullRequestLabel(pullRequest.number, "agent:in-progress");
    try {
      await ports.github.removePullRequestLabel(pullRequest.number, "agent:implement");
      const claimed = await ports.github.readPullRequest(pullRequest.number);
      if (
        claimed.headSha !== pullRequest.headSha ||
        !claimed.labels.includes("agent:in-progress") ||
        claimed.labels.includes("agent:implement") ||
        claimed.labels.includes("agent:blocked")
      ) {
        throw new Error(`Pull Request #${pullRequest.number} changed while feedback implementation was being acquired`);
      }
      const revision = await ports.checkout.withCheckout({
        pullRequestNumber: pullRequest.number,
        revision: pullRequest.headSha,
      }, async (checkoutPath) => {
        await ports.publisher.prepare(checkoutPath, pullRequest.headRefName, pullRequest.headSha);
        let outcome: { readonly reply: FeedbackReplyIntent };
        try {
          outcome = await ports.implementer.implement({
            pullRequestNumber: pullRequest.number,
            branch: pullRequest.headRefName,
            revision: pullRequest.headSha,
            checkoutPath,
          });
        } catch (error) {
          throw new FeedbackStageError("feedback-execution", error instanceof Error ? error.message : String(error));
        }
        let publishedRevision: string;
        try {
          publishedRevision = await ports.publisher.publish({
            checkoutPath,
            branch: pullRequest.headRefName,
            expectedRevision: pullRequest.headSha,
          });
        } catch (error) {
          throw new FeedbackStageError("feedback-publication", error instanceof Error ? error.message : String(error));
        }
        const threads = await ports.github.readUnresolvedReviewThreads(pullRequest.number);
        if (!threads.some((thread) => thread.commentId === outcome.reply.rootCommentId)) {
          throw new FeedbackStageError(
            "feedback-reply",
            `Reply target ${outcome.reply.rootCommentId} is not an unresolved review thread on Pull Request #${pullRequest.number}`,
            publishedRevision,
          );
        }
        const convergence = await convergeFeedbackHead({
          expectedPost: publishedRevision,
          acquiredPre: pullRequest.headSha,
          readHead: async () => (await ports.github.readPullRequest(pullRequest.number)).headSha,
          isTransientReadError: ports.isTransientReadError ?? (() => false),
          attempts: ports.convergenceAttempts ?? CONVERGENCE_ATTEMPTS,
          wait: async (attempt) => {
            await waitFor(ports, attempt * CONVERGENCE_POLL_DELAY_MILLISECONDS);
          },
        });
        if (convergence.status === "indeterminate") {
          throw new FeedbackStageError(
            "feedback-convergence",
            "Pull Request head did not converge to the published feedback revision",
            publishedRevision,
          );
        }
        if (convergence.status === "race") {
          throw new FeedbackStageError(
            "feedback-head-conflict",
            `Pull Request head became ${convergence.sha}`,
            publishedRevision,
          );
        }
        await publishCanonicalReply({
          pullRequestNumber: pullRequest.number,
          pre: pullRequest.headSha,
          post: publishedRevision,
          rootCommentId: outcome.reply.rootCommentId,
          body: outcome.reply.body,
          github: ports.github,
        });
        return publishedRevision;
      });
      if (!/^[0-9a-f]{40}$/u.test(revision) || revision === pullRequest.headSha) {
        throw new Error("Feedback implementation did not publish a new full revision");
      }
      try {
        await ports.github.removePullRequestLabel(pullRequest.number, "agent:in-progress");
      } catch (error) {
        return blocked(jobId, "feedback-finalization", redactFailureSummary(error instanceof Error ? error.message : String(error)), {
          revision,
          finalization: { blockedStateFailed: false, diagnosticFailed: false, inProgressCleanupFailed: true },
        });
      }
      return { status: "implemented", revision, reconciled: false };
    } catch (error) {
      const summary = redactFailureSummary(error instanceof Error ? error.message : String(error));
      const stage = error instanceof FeedbackStageError ? error.stage : "feedback-execution";
      const finalization = await settleBlockedState(ports, pullRequest.number, jobId, stage, summary);
      return blocked(jobId, stage, summary, {
        ...(error instanceof FeedbackStageError && error.revision !== undefined ? { revision: error.revision } : {}),
        finalization,
      });
    }
  } finally {
    activePullRequestNumbers.delete(pullRequest.number);
    await lease.release();
  }
}
