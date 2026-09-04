import { diagnosticSummary } from "./redaction.ts";

export interface ReviewAutomationPullRequest {
  readonly number: number;
  readonly state: string;
  readonly isDraft: boolean;
  readonly baseRepository: string;
  readonly headRepository: string;
  readonly headRefName: string;
  readonly headSha: string;
  readonly labels: readonly string[];
}

export interface ReviewInlineComment {
  readonly path: string;
  readonly line: number;
  readonly body: string;
}

export interface ReviewReply {
  readonly commentId: string;
  readonly body: string;
}

export interface PublishedReview {
  readonly summary: string;
  readonly inlineComments: readonly ReviewInlineComment[];
  readonly replies: readonly ReviewReply[];
}

export interface ReviewThreadComment {
  readonly commentId: string;
  readonly path?: string;
  readonly line?: number;
  readonly author: string;
  readonly body: string;
}

export interface ReviewAutomationPorts {
  readonly github: {
    readPullRequest(pullRequestNumber: number): Promise<ReviewAutomationPullRequest>;
    readUnresolvedReviewThreads(pullRequestNumber: number): Promise<readonly ReviewThreadComment[]>;
    addPullRequestLabel(pullRequestNumber: number, label: string): Promise<void>;
    removePullRequestLabel(pullRequestNumber: number, label: string): Promise<void>;
    publishReview(request: {
      readonly pullRequestNumber: number;
      readonly revision: string;
      readonly review: PublishedReview;
    }): Promise<void>;
    markPullRequestReady(pullRequestNumber: number): Promise<void>;
    replyToReviewThread(request: {
      readonly pullRequestNumber: number;
      readonly reply: ReviewReply;
    }): Promise<void>;
    addRefusalDiagnostic?(pullRequestNumber: number, reason: string): Promise<void>;
    addBlockedDiagnostic?(
      pullRequestNumber: number,
      diagnostic: { readonly reason: "review-execution"; readonly jobId: string },
    ): Promise<void>;
  };
  readonly checkout: {
    withCheckout<TResult>(
      request: { readonly pullRequestNumber: number; readonly revision: string },
      action: (checkoutPath: string) => Promise<TResult>,
    ): Promise<TResult>;
  };
  readonly reviewer: {
    review(request: {
      readonly pullRequestNumber: number;
      readonly branch: string;
      readonly revision: string;
      readonly checkoutPath: string;
      readonly reviewThreads: readonly ReviewThreadComment[];
    }): Promise<PublishedReview>;
  };
  readonly publisher: {
    prepare(checkoutPath: string, branch: string, revision: string): Promise<void>;
    publish(request: {
      readonly checkoutPath: string;
      readonly branch: string;
      readonly expectedRevision: string;
    }): Promise<string>;
  };
  readonly lease: {
    acquire(pullRequestNumber: number): Promise<{ release(): Promise<void> | void } | undefined>;
  };
  readonly createJobId?: () => string;
}

export type ReviewAutomationResult =
  | { readonly status: "reviewed"; readonly revision: string; readonly verdict: "improved" | "clean" }
  | { readonly status: "refused"; readonly reason: string }
  | { readonly status: "blocked"; readonly reason: "review-execution"; readonly jobId: string };

function refusal(pullRequest: ReviewAutomationPullRequest): string | undefined {
  if (pullRequest.state !== "OPEN") return `Pull Request #${pullRequest.number} is not open`;
  if (!pullRequest.isDraft) return `Pull Request #${pullRequest.number} is not a Draft`;
  if (pullRequest.baseRepository !== pullRequest.headRepository) return `Pull Request #${pullRequest.number} must not originate from a fork`;
  if (!/^[0-9a-f]{40}$/u.test(pullRequest.headSha)) return `Pull Request #${pullRequest.number} has an invalid head revision`;
  if (!pullRequest.labels.includes("agent:review")) return `Pull Request #${pullRequest.number} is not queued for review`;
  if (pullRequest.labels.includes("agent:in-progress")) return `Pull Request #${pullRequest.number} is already in progress`;
  if (pullRequest.labels.includes("agent:blocked")) return `Pull Request #${pullRequest.number} is blocked`;
  return undefined;
}

export async function runReviewAutomationCommand(
  request: { readonly pullRequestNumber: number },
  ports: ReviewAutomationPorts,
): Promise<ReviewAutomationResult> {
  const pullRequest = await ports.github.readPullRequest(request.pullRequestNumber);
  const reason = refusal(pullRequest);
  if (reason !== undefined) {
    if (pullRequest.labels.includes("agent:in-progress")) return { status: "refused", reason };
    await ports.github.removePullRequestLabel(pullRequest.number, "agent:review");
    await ports.github.addRefusalDiagnostic?.(pullRequest.number, reason);
    return { status: "refused", reason };
  }
  const lease = await ports.lease.acquire(pullRequest.number);
  if (lease === undefined) throw new Error(`Pull Request #${pullRequest.number} is already in progress`);
  try {
    await ports.github.addPullRequestLabel(pullRequest.number, "agent:in-progress");
    try {
      const acquiredPullRequest = await ports.github.readPullRequest(pullRequest.number);
      if (
        acquiredPullRequest.state !== "OPEN" ||
        acquiredPullRequest.headSha !== pullRequest.headSha ||
        !acquiredPullRequest.labels.includes("agent:review") ||
        !acquiredPullRequest.labels.includes("agent:in-progress") ||
        acquiredPullRequest.labels.includes("agent:blocked")
      ) throw new Error(`Pull Request #${pullRequest.number} changed while review was being acquired`);
      await ports.github.removePullRequestLabel(pullRequest.number, "agent:review");
      const reviewThreads = await ports.github.readUnresolvedReviewThreads(pullRequest.number);
      const revision = await ports.checkout.withCheckout({ pullRequestNumber: pullRequest.number, revision: pullRequest.headSha }, async (checkoutPath) => {
        await ports.publisher.prepare(checkoutPath, pullRequest.headRefName, pullRequest.headSha);
        const review = await ports.reviewer.review({
          pullRequestNumber: pullRequest.number,
          branch: pullRequest.headRefName,
          revision: pullRequest.headSha,
          checkoutPath,
          reviewThreads,
        });
        const publishedRevision = await ports.publisher.publish({
          checkoutPath,
          branch: pullRequest.headRefName,
          expectedRevision: pullRequest.headSha,
        });
        if (!/^[0-9a-f]{40}$/u.test(publishedRevision)) throw new Error("Review publication did not produce a full revision");
        await ports.github.publishReview({ pullRequestNumber: pullRequest.number, revision: publishedRevision, review });
        await ports.github.markPullRequestReady(pullRequest.number);
        const validReplyIds = new Set(reviewThreads.map(({ commentId }) => commentId));
        await Promise.all(review.replies
          .filter(({ commentId }) => validReplyIds.has(commentId))
          .map((reply) => ports.github.replyToReviewThread({ pullRequestNumber: pullRequest.number, reply })));
        return publishedRevision;
      });
      return {
        status: "reviewed",
        revision,
        verdict: revision === pullRequest.headSha ? "clean" : "improved",
      };
    } catch (error) {
      const jobId = ports.createJobId?.() ?? "local-review-job";
      // The public blocked diagnostic stays classification-only (#219 evidence
      // boundary), but the cause must still survive somewhere local: twice in
      // #428 the review agent and publisher both succeeded and only the final
      // publication failed, and this catch was the sole record of the error.
      console.error(`Review automation failed (job ${jobId}): ${diagnosticSummary(error instanceof Error ? (error.stack ?? error.message) : String(error))}`);
      await Promise.allSettled([
        ports.github.addPullRequestLabel(pullRequest.number, "agent:blocked"),
        ports.github.addBlockedDiagnostic?.(pullRequest.number, { reason: "review-execution", jobId }),
      ]);
      return { status: "blocked", reason: "review-execution", jobId };
    } finally {
      await ports.github.removePullRequestLabel(pullRequest.number, "agent:in-progress").catch(() => undefined);
    }
  } finally {
    await lease.release();
  }
}
