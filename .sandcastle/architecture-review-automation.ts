import { redactFailureSummary } from "./failure-finalizer.ts";

export const ARCHITECTURE_REVIEW_IDENTITY = "architecture-review";

// Upstream check-backlog guard: a run proceeds only while fewer than ten
// source:architecture-review Issues are open.
export const ARCHITECTURE_REVIEW_BACKLOG_LIMIT = 10;

export interface ArchitectureReviewProposal {
  readonly number: number;
  readonly title: string;
  readonly state: string;
  readonly body: string;
}

export type ArchitectureReviewOutcome =
  | {
      readonly status: "proposed";
      readonly title: string;
      readonly body: string;
      readonly oneLineSummary: string;
      readonly candidatesConsidered: readonly string[];
    }
  | { readonly status: "skipped"; readonly reason: string };

export interface ArchitectureReviewAutomationPorts {
  readonly github: {
    countOpenArchitectureReviewProposals(): Promise<number>;
    readBaseRevision(): Promise<string>;
    listArchitectureReviewProposals(): Promise<readonly ArchitectureReviewProposal[]>;
  };
  readonly checkout: {
    withCheckout<TResult>(
      request: { readonly revision: string },
      action: (checkoutPath: string) => Promise<TResult>,
    ): Promise<TResult>;
  };
  readonly reviewer: {
    review(request: {
      readonly revision: string;
      readonly checkoutPath: string;
      readonly priorProposals: readonly ArchitectureReviewProposal[];
    }): Promise<ArchitectureReviewOutcome>;
  };
  readonly publisher: {
    publishArchitectureProposal(request: {
      readonly title: string;
      readonly body: string;
    }): Promise<{ readonly issueNumber: number; readonly issueUrl: string }>;
  };
  readonly createJobId?: () => string;
}

export type ArchitectureReviewAutomationResult =
  | {
      readonly status: "proposed";
      readonly revision: string;
      readonly issueNumber: number;
      readonly issueUrl: string;
    }
  | { readonly status: "skipped"; readonly revision: string; readonly reason: string }
  | { readonly status: "refused"; readonly reason: "architecture-review-backlog" }
  | {
      readonly status: "blocked";
      readonly reason: "architecture-review-execution" | "architecture-review-publication";
      readonly jobId: string;
      readonly summary: string;
    };

export async function runArchitectureReviewAutomationCommand(
  ports: ArchitectureReviewAutomationPorts,
): Promise<ArchitectureReviewAutomationResult> {
  const openProposals = await ports.github.countOpenArchitectureReviewProposals();
  if (openProposals >= ARCHITECTURE_REVIEW_BACKLOG_LIMIT) {
    return { status: "refused", reason: "architecture-review-backlog" };
  }
  const [revision, priorProposals] = await Promise.all([
    ports.github.readBaseRevision(),
    ports.github.listArchitectureReviewProposals(),
  ]);
  // A blocked architecture review has no Automation Work Item to annotate, so
  // the classified result and the retained local job artifacts are the whole
  // diagnostic surface; nothing is published to GitHub on failure.
  const blocked = (
    reason: "architecture-review-execution" | "architecture-review-publication",
    error: unknown,
  ): ArchitectureReviewAutomationResult => ({
    status: "blocked",
    reason,
    jobId: ports.createJobId?.() ?? "local-architecture-review-job",
    summary: redactFailureSummary(error instanceof Error ? error.message : String(error)),
  });
  try {
    return await ports.checkout.withCheckout({ revision }, async (checkoutPath) => {
      let outcome: ArchitectureReviewOutcome;
      try {
        outcome = await ports.reviewer.review({ revision, checkoutPath, priorProposals });
      } catch (error) {
        return blocked("architecture-review-execution", error);
      }
      if (outcome.status === "skipped") {
        return { status: "skipped", revision, reason: outcome.reason };
      }
      try {
        const published = await ports.publisher.publishArchitectureProposal({
          title: outcome.title,
          body: outcome.body,
        });
        return {
          status: "proposed",
          revision,
          issueNumber: published.issueNumber,
          issueUrl: published.issueUrl,
        };
      } catch (error) {
        return blocked("architecture-review-publication", error);
      }
    });
  } catch (error) {
    return blocked("architecture-review-execution", error);
  }
}
