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
  readonly lease?: {
    acquire(pullRequestNumber: number): Promise<{ release(): Promise<void> } | undefined>;
  };
  readonly createJobId?: () => string;
}

export type ReviewAutomationResult =
  | { readonly status: "reviewed"; readonly revision: string }
  | {
    readonly status: "blocked";
    readonly reason: "review-execution";
    readonly jobId: string;
  };

function requireEligiblePullRequest(pullRequest: ReviewAutomationPullRequest): void {
  if (pullRequest.state !== "OPEN") {
    throw new Error(`Pull Request #${pullRequest.number} is not open`);
  }
  if (!pullRequest.isDraft) {
    throw new Error(`Pull Request #${pullRequest.number} is not a Draft`);
  }
  if (pullRequest.baseRepository !== pullRequest.headRepository) {
    throw new Error(`Pull Request #${pullRequest.number} must not originate from a fork`);
  }
  if (!/^[0-9a-f]{40}$/u.test(pullRequest.headSha)) {
    throw new Error(`Pull Request #${pullRequest.number} has an invalid head revision`);
  }
  if (!pullRequest.labels.includes("agent:review")) {
    throw new Error(`Pull Request #${pullRequest.number} is not queued for review`);
  }
  if (pullRequest.labels.includes("agent:in-progress")) {
    throw new Error(`Pull Request #${pullRequest.number} is already in progress`);
  }
  if (pullRequest.labels.includes("agent:blocked")) {
    throw new Error(`Pull Request #${pullRequest.number} is blocked`);
  }
}

export async function runReviewAutomationCommand(
  request: { readonly pullRequestNumber: number },
  ports: ReviewAutomationPorts,
): Promise<ReviewAutomationResult> {
  const pullRequest = await ports.github.readPullRequest(request.pullRequestNumber);
  requireEligiblePullRequest(pullRequest);
  const lease = ports.lease === undefined ? undefined : await ports.lease.acquire(pullRequest.number);
  if (ports.lease !== undefined && lease === undefined) {
    throw new Error(`Pull Request #${pullRequest.number} is already in progress`);
  }

  try {
    await ports.github.addPullRequestLabel(pullRequest.number, "agent:in-progress");
    try {
      await ports.github.removePullRequestLabel(pullRequest.number, "agent:review");
      await ports.checkout.withCheckout({
        pullRequestNumber: pullRequest.number,
        revision: pullRequest.headSha,
      }, async (checkoutPath) => {
        const review = await ports.reviewer.review({
          pullRequestNumber: pullRequest.number,
          revision: pullRequest.headSha,
          checkoutPath,
        });
        await ports.publisher.publish({
          pullRequestNumber: pullRequest.number,
          revision: pullRequest.headSha,
          review,
        });
      });
    } catch {
      const jobId = ports.createJobId?.() ?? "local-review-job";
      await Promise.allSettled([
        ports.github.addPullRequestLabel(pullRequest.number, "agent:blocked"),
        ports.github.addBlockedDiagnostic?.(pullRequest.number, {
          reason: "review-execution",
          jobId,
        }),
      ]);
      return { status: "blocked", reason: "review-execution", jobId };
    } finally {
      await ports.github.removePullRequestLabel(pullRequest.number, "agent:in-progress")
        .catch(() => undefined);
    }

    return { status: "reviewed", revision: pullRequest.headSha };
  } finally {
    await lease?.release();
  }
}
