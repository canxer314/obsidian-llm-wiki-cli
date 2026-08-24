export interface ReviewAutomationPullRequest {
  readonly number: number;
  readonly state: string;
  readonly isDraft: boolean;
  readonly baseRepository: string;
  readonly headRepository: string;
  readonly headSha: string;
  readonly labels: readonly string[];
}

export interface ReviewFinding {
  readonly summary: string;
  readonly details: string;
  readonly location?: {
    readonly path: string;
    readonly line: number;
    readonly side: "LEFT" | "RIGHT";
  };
}

export interface PublishedReview {
  readonly verdict: "Approved" | "Changes requested";
  readonly summary: string;
  readonly findings: readonly ReviewFinding[];
}

export interface ReviewAutomationPorts {
  readonly github: {
    readPullRequest(pullRequestNumber: number): Promise<ReviewAutomationPullRequest>;
    addPullRequestLabel(pullRequestNumber: number, label: string): Promise<void>;
    removePullRequestLabel(pullRequestNumber: number, label: string): Promise<void>;
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
      readonly revision: string;
      readonly checkoutPath: string;
    }): Promise<PublishedReview>;
  };
  readonly publisher: {
    publish(request: {
      readonly pullRequestNumber: number;
      readonly revision: string;
      readonly review: PublishedReview;
    }): Promise<void>;
  };
  readonly lease: {
    acquire(pullRequestNumber: number): Promise<{ release(): Promise<void> | void } | undefined>;
  };
  readonly createJobId?: () => string;
}

export type ReviewAutomationResult =
  | { readonly status: "reviewed"; readonly revision: string }
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
    // An in-progress Pull Request is owned by an in-flight run whose
    // acquisition protocol requires the trigger to still be present, so a
    // concurrent refusal must not touch it; every other refusal is a
    // business preflight refusal (#219 story 17): remove the trigger and
    // explain on the Automation Work Item, without agent:blocked, so an
    // inapplicable request (e.g. a fork Pull Request) does not re-refuse
    // every round.
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
        !acquiredPullRequest.labels.includes("agent:review") ||
        !acquiredPullRequest.labels.includes("agent:in-progress") ||
        acquiredPullRequest.labels.includes("agent:blocked")
      ) throw new Error(`Pull Request #${pullRequest.number} changed while review was being acquired`);
      await ports.github.removePullRequestLabel(pullRequest.number, "agent:review");
      await ports.checkout.withCheckout({ pullRequestNumber: pullRequest.number, revision: pullRequest.headSha }, async (checkoutPath) => {
        const review = await ports.reviewer.review({ pullRequestNumber: pullRequest.number, revision: pullRequest.headSha, checkoutPath });
        await ports.publisher.publish({ pullRequestNumber: pullRequest.number, revision: pullRequest.headSha, review });
      });
    } catch {
      const jobId = ports.createJobId?.() ?? "local-review-job";
      await Promise.allSettled([
        ports.github.addPullRequestLabel(pullRequest.number, "agent:blocked"),
        ports.github.addBlockedDiagnostic?.(pullRequest.number, { reason: "review-execution", jobId }),
      ]);
      return { status: "blocked", reason: "review-execution", jobId };
    } finally {
      await ports.github.removePullRequestLabel(pullRequest.number, "agent:in-progress").catch(() => undefined);
    }
    return { status: "reviewed", revision: pullRequest.headSha };
  } finally {
    await lease.release();
  }
}
