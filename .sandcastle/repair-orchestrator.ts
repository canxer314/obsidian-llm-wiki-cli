import type { VerifiedPullRequest } from "./implementer.js";
import type { LocalQualityResult } from "./local-quality.js";
import type { ReviewResult } from "./review.js";
import type { ReviewerFinding, ReviewerOutput } from "./reviewer-session.js";

const MAX_REPAIRS = 2;
const MAX_FEEDBACK_LENGTH = 20_000;

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

export type RepairOrchestratorResult = {
  readonly pullRequest: VerifiedPullRequest;
  readonly localQuality: LocalQualityResult & { readonly revision: string };
  readonly repairsUsed: number;
  readonly review?: ReviewResult;
};

function redact(text: string): string {
  return text
    .replace(
      /\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|sk-ant-[A-Za-z0-9_-]{20,}|AKIA[A-Z0-9]{16})\b/gu,
      "[REDACTED]",
    )
    .replace(
      /((?:token|password|secret|api[_-]?key|authorization)\s*[:=]\s*)([^\s,;]+)/giu,
      "$1[REDACTED]",
    )
    .slice(0, MAX_FEEDBACK_LENGTH);
}

function qualityFeedback(
  result: Exclude<LocalQualityResult, { status: "success" }>,
): RepairFeedback {
  return {
    source: "local-quality",
    stage: result.stage,
    ...(result.output === undefined ? {} : { output: redact(result.output) }),
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

export async function processReadyPlan(
  options: RepairOrchestratorOptions,
): Promise<RepairOrchestratorResult> {
  let pullRequest = options.pullRequest;
  let repairsUsed = 0;

  for (;;) {
    const localQuality = await options.runLocalQuality(pullRequest);
    if (localQuality.status !== "success") {
      if (localQuality.status === "error" || repairsUsed === MAX_REPAIRS) {
        return { pullRequest, localQuality, repairsUsed };
      }
      repairsUsed += 1;
      const repaired = await options.repair({
        pullRequest,
        attempt: repairsUsed as 1 | 2,
        feedback: qualityFeedback(localQuality),
      });
      if (repaired.number !== pullRequest.number || repaired.headSha === pullRequest.headSha) {
        throw new Error("Implementer repair must push a new SHA to the same Pull Request");
      }
      pullRequest = repaired;
      continue;
    }

    const review = await options.runReview(pullRequest, localQuality);
    if (review.status !== "failure" || repairsUsed === MAX_REPAIRS) {
      return { pullRequest, localQuality, review, repairsUsed };
    }
    repairsUsed += 1;
    const repaired = await options.repair({
      pullRequest,
      attempt: repairsUsed as 1 | 2,
      feedback: reviewFeedback(review),
    });
    if (repaired.number !== pullRequest.number || repaired.headSha === pullRequest.headSha) {
      throw new Error("Implementer repair must push a new SHA to the same Pull Request");
    }
    pullRequest = repaired;
  }
}
