import type { VerifiedPullRequest } from "./implementer.js";
import type { LocalQualityResult } from "./local-quality.js";
import type { ReviewResult } from "./review.js";
import type { ReviewerFinding, ReviewerOutput } from "./reviewer-session.js";
import { redact } from "./redaction.ts";

const MAX_REPAIRS = 2;

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
  readonly runLocalQuality: (
    pullRequest: VerifiedPullRequest,
  ) => Promise<LocalQualityResult & { readonly revision: string }>;
  readonly runReview: (
    pullRequest: VerifiedPullRequest,
    localQuality: LocalQualityResult & { readonly revision: string },
  ) => Promise<ReviewResult>;
  readonly repair: (request: RepairRequest) => Promise<VerifiedPullRequest>;
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

  for (;;) {
    const localQuality = await options.runLocalQuality(pullRequest);
    if (localQuality.status !== "success") {
      if (localQuality.status === "error" || repairsUsed === MAX_REPAIRS) {
        return {
          pullRequest,
          localQuality,
          repairsUsed,
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
    if (review.status !== "failure") {
      return {
        pullRequest,
        localQuality,
        review,
        repairsUsed,
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
