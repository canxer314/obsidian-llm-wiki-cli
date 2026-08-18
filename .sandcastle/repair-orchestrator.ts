import type { VerifiedPullRequest } from "./implementer.js";
import type { LocalQualityResult } from "./local-quality.js";
import type { ReviewResult } from "./review.js";
import type { ReviewerFinding, ReviewerOutput } from "./reviewer-session.js";
import { redact } from "./redaction.ts";

const MAX_REPAIRS = 2;
const MAX_MERGER_REPAIRS = 2;
const MAX_SYNCHRONIZATIONS = 2;

export type TargetSyncResult =
  | {
    readonly status: "unchanged" | "synced";
    readonly pullRequest: VerifiedPullRequest;
  }
  | {
    readonly status: "outdated";
    readonly pullRequest: VerifiedPullRequest;
  }
  | {
    readonly status: "conflict";
    readonly pullRequest: VerifiedPullRequest;
    readonly targetBranch?: string;
    readonly targetSha?: string;
    readonly summary: string;
  };

export interface MergerRequest {
  readonly pullRequest: VerifiedPullRequest;
  readonly attempt: 1 | 2;
  readonly targetBranch: string;
  readonly targetSha: string;
  readonly summary: string;
}

export type RepairFeedback =
  | {
    readonly source: "local-quality";
    readonly stage: Exclude<LocalQualityResult, { status: "success" }>["stage"];
    readonly output?: string;
  }
  | {
    readonly source: "review";
    readonly summary: string;
    readonly findings: readonly ReviewerFinding[];
  };

export interface RepairRequest {
  readonly pullRequest: VerifiedPullRequest;
  readonly attempt: 1 | 2;
  readonly feedback: RepairFeedback;
}

export interface RepairOrchestratorOptions {
  readonly pullRequest: VerifiedPullRequest;
  readonly synchronize?: (
    pullRequest: VerifiedPullRequest,
    allowPush: boolean,
  ) => Promise<TargetSyncResult>;
  readonly runLocalQuality: (
    pullRequest: VerifiedPullRequest,
  ) => Promise<LocalQualityResult & { readonly revision: string }>;
  readonly runReview: (
    pullRequest: VerifiedPullRequest,
    localQuality: LocalQualityResult & { readonly revision: string },
  ) => Promise<ReviewResult>;
  readonly repair: (request: RepairRequest) => Promise<VerifiedPullRequest>;
  readonly mergeConflict?: (request: MergerRequest) => Promise<VerifiedPullRequest>;
}

export interface TerminalFailure {
  readonly stage: string;
  readonly revision?: string;
  readonly summary: string;
}

export type RepairOrchestratorResult = {
  readonly pullRequest: VerifiedPullRequest;
  readonly localQuality: LocalQualityResult & { readonly revision: string };
  readonly repairsUsed: number;
  readonly mergerRepairsUsed?: number;
  readonly synchronizationsUsed?: number;
  readonly review?: ReviewResult;
  readonly terminalFailure?: TerminalFailure;
};

function qualityFeedback(
  result: Exclude<LocalQualityResult, { status: "success" }>,
): RepairFeedback {
  return {
    source: "local-quality",
    stage: result.stage,
    output: redact(
      result.output ?? `Local quality failed during ${result.stage} without command output`,
    ),
  };
}

function reviewFeedback(
  result: ReviewerOutput,
): RepairFeedback {
  return {
    source: "review",
    summary: redact(result.summary),
    findings: result.findings.map((finding) => ({
      summary: redact(finding.summary),
      details: redact(finding.details),
    })),
  };
}

function qualityTerminalFailure(
  result: Exclude<LocalQualityResult, { status: "success" }> & { readonly revision: string },
  budgetExhausted: boolean,
): TerminalFailure {
  return {
    stage: `local-quality:${result.stage}${budgetExhausted ? ":repair-budget-exhausted" : ""}`,
    revision: result.revision,
    summary: redact(
      result.output ?? `Local quality failed during ${result.stage} without command output`,
    ),
  };
}

function reviewTerminalFailure(
  result: ReviewResult,
  budgetExhausted: boolean,
): TerminalFailure {
  if (result.status === "error") {
    return {
      stage: "reviewer",
      revision: result.revision,
      summary: "Reviewer failed without a publishable verdict",
    };
  }
  return {
    stage: `reviewer${budgetExhausted ? ":repair-budget-exhausted" : ""}`,
    revision: result.revision,
    summary: redact([
      result.summary,
      ...result.findings.map((finding) => `${finding.summary}: ${finding.details}`),
    ].join("\n\n")),
  };
}

function acceptRepair(
  previous: VerifiedPullRequest,
  repaired: VerifiedPullRequest,
): VerifiedPullRequest {
  if (repaired.number !== previous.number || repaired.headSha === previous.headSha) {
    throw new Error("Implementer repair must push a new SHA to the same Pull Request");
  }
  return repaired;
}

export async function processReadyPlan(
  options: RepairOrchestratorOptions,
): Promise<RepairOrchestratorResult> {
  let pullRequest = options.pullRequest;
  let repairsUsed = 0;
  let mergerRepairsUsed = 0;
  let synchronizationsUsed = 0;
  let needsPreGateSynchronization = true;

  const mergerFields = () => mergerRepairsUsed === 0
    ? {}
    : { mergerRepairsUsed };
  const synchronizationFields = () => synchronizationsUsed === 0
    ? {}
    : { synchronizationsUsed };

  const synchronize = async (): Promise<"unchanged" | "synced" | TerminalFailure> => {
    if (options.synchronize === undefined) return "unchanged";
    const result = await options.synchronize(
      pullRequest,
      synchronizationsUsed < MAX_SYNCHRONIZATIONS,
    );
    if (result.status === "unchanged") return "unchanged";
    if (result.status === "outdated") {
      return {
        stage: "target-sync:budget-exhausted",
        revision: pullRequest.headSha,
        summary: "Target branch kept changing during synchronization",
      };
    }
    if (result.status === "conflict") {
      if (
        options.mergeConflict === undefined ||
        result.targetBranch === undefined ||
        result.targetSha === undefined
      ) {
        return {
          stage: "target-sync:conflict",
          revision: pullRequest.headSha,
          summary: redact(result.summary),
        };
      }
      if (mergerRepairsUsed === MAX_MERGER_REPAIRS) {
        return {
          stage: "target-sync:conflict-repair-budget-exhausted",
          revision: pullRequest.headSha,
          summary: redact(result.summary),
        };
      }
      mergerRepairsUsed += 1;
      pullRequest = acceptRepair(
        pullRequest,
        await options.mergeConflict({
          pullRequest,
          attempt: mergerRepairsUsed as 1 | 2,
          targetBranch: result.targetBranch,
          targetSha: result.targetSha,
          summary: redact(result.summary),
        }),
      );
      return "synced";
    }
    synchronizationsUsed += 1;
    pullRequest = acceptRepair(pullRequest, result.pullRequest);
    return "synced";
  };

  for (;;) {
    const synchronization = needsPreGateSynchronization
      ? await synchronize()
      : "unchanged";
    needsPreGateSynchronization = true;
    if (typeof synchronization !== "string") {
      return {
        pullRequest,
        localQuality: {
          status: "error",
          stage: "setup",
          revision: pullRequest.headSha,
          output: synchronization.summary,
        },
        repairsUsed,
        ...mergerFields(),
        ...synchronizationFields(),
        terminalFailure: synchronization,
      };
    }

    const localQuality = await options.runLocalQuality(pullRequest);
    if (localQuality.status !== "success") {
      if (localQuality.status === "error" || repairsUsed === MAX_REPAIRS) {
        return {
          pullRequest,
          localQuality,
          repairsUsed,
        ...mergerFields(),
          terminalFailure: qualityTerminalFailure(
            localQuality,
            repairsUsed === MAX_REPAIRS,
          ),
        };
      }
      repairsUsed += 1;
      pullRequest = acceptRepair(
        pullRequest,
        await options.repair({
          pullRequest,
          attempt: repairsUsed as 1 | 2,
          feedback: qualityFeedback(localQuality),
        }),
      );
      continue;
    }

    const review = await options.runReview(pullRequest, localQuality);
    if (review.status === "success") {
      const postReviewSynchronization = await synchronize();
      if (postReviewSynchronization === "synced") {
        needsPreGateSynchronization = false;
        continue;
      }
      if (typeof postReviewSynchronization !== "string") {
        return {
          pullRequest,
          localQuality,
          review,
          repairsUsed,
        ...mergerFields(),
          ...synchronizationFields(),
          terminalFailure: postReviewSynchronization,
        };
      }
    }
    if (review.status !== "failure") {
      return {
        pullRequest,
        localQuality,
        review,
        repairsUsed,
        ...mergerFields(),
        ...synchronizationFields(),
        ...(review.status === "error"
          ? { terminalFailure: reviewTerminalFailure(review, false) }
          : {}),
      };
    }
    if (repairsUsed === MAX_REPAIRS) {
      return {
        pullRequest,
        localQuality,
        review,
        repairsUsed,
        ...mergerFields(),
        terminalFailure: reviewTerminalFailure(review, true),
      };
    }
    repairsUsed += 1;
    pullRequest = acceptRepair(
      pullRequest,
      await options.repair({
        pullRequest,
        attempt: repairsUsed as 1 | 2,
        feedback: reviewFeedback(review),
      }),
    );
  }
}
