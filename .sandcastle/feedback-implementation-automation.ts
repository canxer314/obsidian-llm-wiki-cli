import { redact as redactFailureSummary } from "./redaction.ts";
import type { ReviewAutomationPullRequest, ReviewReply, ReviewThreadComment } from "./review-automation.js";
import {
  classifyFeedbackReconciliation,
  feedbackReplyMarker,
  inspectFeedbackMarkerReplies,
  selectFeedbackIntent,
  type FeedbackReviewState,
  type FeedbackReplyMarker,
  type FeedbackThreadReply,
} from "./feedback-reconciliation.ts";
import { convergeFeedbackHead, type FeedbackConvergence } from "./feedback-convergence.ts";
import type { GithubReadErrorClassification } from "./github-cli.ts";

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
    readCurrentUnresolvedFeedback(pullRequestNumber: number): Promise<FeedbackReviewState>;
    readCommitParent(sha: string): Promise<string | undefined>;
    readUnresolvedReviewThreads(pullRequestNumber: number): Promise<readonly ReviewThreadComment[]>;
    addPullRequestLabel(pullRequestNumber: number, label: string): Promise<void>;
    removePullRequestLabel(pullRequestNumber: number, label: string): Promise<void>;
    replyToReviewThread(request: {
      readonly pullRequestNumber: number;
      readonly reply: ReviewReply;
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
      readonly rootCommentId: string;
    }): Promise<{ readonly reply: FeedbackReplyIntent }>;
  };
  readonly lease: {
    acquire(pullRequestNumber: number): Promise<{ release(): Promise<void> | void } | undefined>;
  };
  readonly createJobId?: () => string;
  readonly wait?: (milliseconds: number) => Promise<void>;
  readonly convergenceAttempts?: number;
  readonly replyConvergenceAttempts?: number;
  readonly classifyReadError?: (error: unknown) => GithubReadErrorClassification;
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
const RATE_LIMIT_RETRY_DELAY_MILLISECONDS = 60_000;

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
  readonly attempts: number;
  readonly wait: (milliseconds: number) => Promise<void>;
  readonly classifyReadError: (error: unknown) => GithubReadErrorClassification;
}): Promise<void> {
  const marker: FeedbackReplyMarker = {
    pullRequestNumber: request.pullRequestNumber,
    pre: request.pre,
    post: request.post,
    rootCommentId: request.rootCommentId,
  };
  const markerBody = `${request.body}\n\n${feedbackReplyMarker(marker)}`;
  const readReplyCount = async (): Promise<number> => {
    let lastError: unknown;
    let rateLimitRetried = false;
    let normalAttempts = 0;
    for (;;) {
      let classification: GithubReadErrorClassification = { kind: "transient" };
      try {
        const result = inspectFeedbackMarkerReplies(
          await request.github.readFeedbackReplies(request.pullRequestNumber),
          marker,
        );
        if (result === "exactly-one") return 1;
        if (result === "conflict") {
          throw new FeedbackStageError("feedback-reply", "Canonical feedback reply is duplicated or structurally conflicting", request.post);
        }
        lastError = new Error("Canonical feedback reply is not yet visible");
      } catch (error) {
        if (error instanceof FeedbackStageError) throw error;
        classification = request.classifyReadError(error);
        if (classification.kind === "deterministic" && !(error instanceof Error && error.message === "Canonical feedback reply is not yet visible")) {
          throw new FeedbackStageError("feedback-reply", error instanceof Error ? error.message : String(error), request.post);
        }
        if (classification.kind === "rate-limited") {
          if (rateLimitRetried) {
            throw new FeedbackStageError("feedback-reply", error instanceof Error ? error.message : String(error), request.post);
          }
          rateLimitRetried = true;
          lastError = error;
          await request.wait(classification.retryAfterMilliseconds ?? RATE_LIMIT_RETRY_DELAY_MILLISECONDS);
          continue;
        }
        lastError = error;
      }
      normalAttempts += 1;
      if (normalAttempts >= request.attempts) {
        throw new FeedbackStageError(
          "feedback-reply",
          lastError instanceof Error ? lastError.message : "Canonical feedback reply did not converge",
          request.post,
        );
      }
      await request.wait(CONVERGENCE_POLL_DELAY_MILLISECONDS);
    }
  };
  try {
    await request.github.replyToReviewThread({
      pullRequestNumber: request.pullRequestNumber,
      reply: { commentId: request.rootCommentId, body: markerBody },
    });
  } catch (error) {
    await readReplyCount();
    return;
  }
  await readReplyCount();
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

// Every blocked path shares one shape: settle the managed labels and return
// the typed outcome with the settle failures attached (#293).
async function blockAndSettle(
  ports: FeedbackImplementationPorts,
  pullRequestNumber: number,
  jobId: string,
  reason: FeedbackBlockedReason,
  summary: string,
  extra?: { readonly revision?: string },
): Promise<FeedbackImplementationResult> {
  const finalization = await settleBlockedState(ports, pullRequestNumber, jobId, reason, summary);
  return blocked(jobId, reason, summary, {
    ...(extra?.revision === undefined ? {} : { revision: extra.revision }),
    finalization,
  });
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
    readonly invocation?: "ordinary" | "reconcile";
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

  const invocation = request.invocation ?? "ordinary";
  if (invocation === "ordinary") {
    const reason = refusal(pullRequest);
    if (reason !== undefined) {
      await ports.github.removePullRequestLabel(pullRequest.number, "agent:implement");
      await ports.github.addRefusalDiagnostic?.(pullRequest.number, reason);
      return { status: "refused", reason };
    }
  }
  const selectCurrentIntent = async (): Promise<{ readonly rootCommentId: string; readonly state: FeedbackReviewState }> => {
    const state = await ports.github.readCurrentUnresolvedFeedback(request.pullRequestNumber);
    const selectedIntent = await selectFeedbackIntent({
      pullRequestNumber: request.pullRequestNumber,
      invocation,
      state,
      parentOf: (sha) => ports.github.readCommitParent(sha),
    });
    if (selectedIntent.status !== "selected") {
      throw new FeedbackStageError(
        "feedback-reconciliation",
        selectedIntent.status === "none" ? "No current unresolved feedback intent exists" : selectedIntent.reason,
      );
    }
    return { rootCommentId: selectedIntent.rootCommentId, state };
  };
  let initialIntent: { readonly rootCommentId: string; readonly state: FeedbackReviewState };
  try {
    initialIntent = await selectCurrentIntent();
  } catch (error) {
    const summary = error instanceof FeedbackStageError ? error.message : redactFailureSummary(error instanceof Error ? error.message : String(error));
    return blockAndSettle(ports, request.pullRequestNumber, jobId, "feedback-reconciliation", summary);
  }
  const selectedIntent = { status: "selected" as const, rootCommentId: initialIntent.rootCommentId };
  const currentFeedback = initialIntent.state;
  const assertIntentRemainsPending = async (message: string, revision?: string): Promise<void> => {
    const currentIntent = await selectCurrentIntent();
    if (
      currentIntent.rootCommentId !== selectedIntent.rootCommentId
      || currentIntent.state.replies.some((reply) => reply.rootCommentId === selectedIntent.rootCommentId)
    ) {
      throw new FeedbackStageError("feedback-reconciliation", message, revision);
    }
  };
  const reconciliation = await classifyFeedbackReconciliation({
    pullRequestNumber: request.pullRequestNumber,
    headSha: pullRequest.headSha,
    baseRevision: request.baseRevision,
    ...(request.expectedPost === undefined ? {} : { expectedPost: request.expectedPost }),
    ...(request.expectedReply === undefined ? {} : { expectedReplyRootCommentId: request.expectedReply.rootCommentId }),
    intentRootCommentId: selectedIntent.rootCommentId,
    invocation,
    replies: currentFeedback.replies,
    parentOf: (sha) => ports.github.readCommitParent(sha),
  });
  switch (reconciliation.status) {
    case "adopt":
      return finalizeAdopted(request.pullRequestNumber, reconciliation.post, jobId, ports);
    case "reply-only": {
      if (request.expectedReply === undefined) {
        return blockAndSettle(ports, request.pullRequestNumber, jobId, "feedback-reconciliation", "Reply-only completion requires the reply intent");
      }
      const parent = await ports.github.readCommitParent(reconciliation.post);
      if (parent === undefined) {
        return blockAndSettle(ports, request.pullRequestNumber, jobId, "feedback-reconciliation", "Reply-only completion cannot prove the acquired revision");
      }
      try {
        await assertIntentRemainsPending("Feedback intent changed before reply-only publication", reconciliation.post);
      } catch (error) {
        const summary = redactFailureSummary(error instanceof Error ? error.message : String(error));
        return blockAndSettle(ports, request.pullRequestNumber, jobId, "feedback-reconciliation", summary, { revision: reconciliation.post });
      }
      try {
        await publishCanonicalReply({
          pullRequestNumber: request.pullRequestNumber,
          pre: parent,
          post: reconciliation.post,
          rootCommentId: request.expectedReply.rootCommentId,
          body: request.expectedReply.body,
          github: ports.github,
          attempts: ports.replyConvergenceAttempts ?? CONVERGENCE_ATTEMPTS,
          wait: (milliseconds) => waitFor(ports, milliseconds),
          classifyReadError: ports.classifyReadError ?? (() => ({ kind: "deterministic" })),
        });
      } catch (error) {
        const summary = redactFailureSummary(error instanceof Error ? error.message : String(error));
        return blockAndSettle(ports, request.pullRequestNumber, jobId, "feedback-reply", summary, { revision: reconciliation.post });
      }
      return finalizeAdopted(request.pullRequestNumber, reconciliation.post, jobId, ports);
    }
    case "fail-closed": {
      return blockAndSettle(ports, request.pullRequestNumber, jobId, "feedback-reconciliation", reconciliation.reason);
    }
    case "proceed":
      break;
  }

  const lease = await ports.lease.acquire(pullRequest.number);
  if (lease === undefined) {
    return { status: "refused", reason: `Pull Request #${pullRequest.number} is already being processed` };
  }
  activePullRequestNumbers.add(pullRequest.number);
  let publishedRevision: string | undefined;
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
      // Once the controlled publisher returns, every later failure is
      // post-publication: the typed outcome must carry the published revision
      // and never masquerade as a pre-publication execution failure (#293).
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
            rootCommentId: selectedIntent.rootCommentId,
          });
        } catch (error) {
          throw new FeedbackStageError("feedback-execution", error instanceof Error ? error.message : String(error));
        }
        if (outcome.reply.rootCommentId !== selectedIntent.rootCommentId) {
          throw new FeedbackStageError(
            "feedback-reply",
            `Reply target ${outcome.reply.rootCommentId} does not match the selected feedback intent`,
          );
        }
        try {
          await assertIntentRemainsPending("Feedback intent changed while implementation was running");
        } catch (error) {
          if (error instanceof FeedbackStageError) throw error;
          throw new FeedbackStageError("feedback-reconciliation", error instanceof Error ? error.message : String(error));
        }
        try {
          publishedRevision = await ports.publisher.publish({
            checkoutPath,
            branch: pullRequest.headRefName,
            expectedRevision: pullRequest.headSha,
          });
        } catch (error) {
          throw new FeedbackStageError("feedback-publication", error instanceof Error ? error.message : String(error));
        }
        let threads: readonly ReviewThreadComment[];
        try {
          threads = await ports.github.readUnresolvedReviewThreads(pullRequest.number);
        } catch (error) {
          throw new FeedbackStageError(
            "feedback-reply",
            error instanceof Error ? error.message : String(error),
            publishedRevision,
          );
        }
        if (!threads.some((thread) => thread.commentId === outcome.reply.rootCommentId)) {
          throw new FeedbackStageError(
            "feedback-reply",
            `Reply target ${outcome.reply.rootCommentId} is not an unresolved review thread on Pull Request #${pullRequest.number}`,
            publishedRevision,
          );
        }
        let convergence: FeedbackConvergence;
        try {
          convergence = await convergeFeedbackHead({
            expectedPost: publishedRevision,
            acquiredPre: pullRequest.headSha,
            readHead: async () => (await ports.github.readPullRequest(pullRequest.number)).headSha,
            classifyReadError: ports.classifyReadError ?? (() => ({ kind: "deterministic" })),
            attempts: ports.convergenceAttempts ?? CONVERGENCE_ATTEMPTS,
            wait: async (classification, attempt) => {
              await waitFor(ports, classification.kind === "rate-limited"
                ? classification.retryAfterMilliseconds ?? RATE_LIMIT_RETRY_DELAY_MILLISECONDS
                : attempt * CONVERGENCE_POLL_DELAY_MILLISECONDS);
            },
          });
        } catch (error) {
          // Non-transient head-read errors are post-push convergence
          // failures, not execution failures (#293).
          if (error instanceof FeedbackStageError) throw error;
          throw new FeedbackStageError(
            "feedback-convergence",
            error instanceof Error ? error.message : String(error),
            publishedRevision,
          );
        }
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
        try {
          await assertIntentRemainsPending("Feedback intent changed before reply publication", publishedRevision);
        } catch (error) {
          if (error instanceof FeedbackStageError) {
            throw error.revision === undefined
              ? new FeedbackStageError(error.stage, error.message, publishedRevision)
              : error;
          }
          throw new FeedbackStageError("feedback-reconciliation", error instanceof Error ? error.message : String(error), publishedRevision);
        }
        await publishCanonicalReply({
          pullRequestNumber: pullRequest.number,
          pre: pullRequest.headSha,
          post: publishedRevision,
          rootCommentId: outcome.reply.rootCommentId,
          body: outcome.reply.body,
          github: ports.github,
          attempts: ports.replyConvergenceAttempts ?? CONVERGENCE_ATTEMPTS,
          wait: (milliseconds) => waitFor(ports, milliseconds),
          classifyReadError: ports.classifyReadError ?? (() => ({ kind: "deterministic" })),
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
      const stage = error instanceof FeedbackStageError
        ? error.stage
        : publishedRevision === undefined
          ? "feedback-execution"
          : "feedback-convergence";
      const revision = error instanceof FeedbackStageError && error.revision !== undefined
        ? error.revision
        : publishedRevision;
      return blockAndSettle(ports, pullRequest.number, jobId, stage, summary, revision === undefined ? undefined : { revision });
    }
  } finally {
    activePullRequestNumbers.delete(pullRequest.number);
    await lease.release();
  }
}
