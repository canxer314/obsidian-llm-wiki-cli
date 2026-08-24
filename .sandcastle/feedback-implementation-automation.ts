import { redact as redactFailureSummary } from "./redaction.ts";
import type { ReviewAutomationPullRequest } from "./review-automation.js";

export interface FeedbackImplementationPorts {
  readonly github: {
    readPullRequest(pullRequestNumber: number): Promise<ReviewAutomationPullRequest & { readonly headRefName: string }>;
    addPullRequestLabel(pullRequestNumber: number, label: string): Promise<void>;
    removePullRequestLabel(pullRequestNumber: number, label: string): Promise<void>;
    addRefusalDiagnostic?(pullRequestNumber: number, reason: string): Promise<void>;
    addFeedbackBlockedDiagnostic?(
      pullRequestNumber: number,
      diagnostic: { readonly reason: "feedback-execution"; readonly jobId: string; readonly summary: string },
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
    }): Promise<void>;
  };
  readonly lease: {
    acquire(pullRequestNumber: number): Promise<{ release(): Promise<void> | void } | undefined>;
  };
  readonly createJobId?: () => string;
}

export type FeedbackImplementationResult =
  | { readonly status: "implemented"; readonly revision: string }
  | { readonly status: "refused"; readonly reason: string }
  | { readonly status: "blocked"; readonly reason: "feedback-execution"; readonly jobId: string };

const activePullRequestNumbers = new Set<number>();

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

export async function runFeedbackImplementationAutomationCommand(
  request: { readonly pullRequestNumber: number },
  ports: FeedbackImplementationPorts,
): Promise<FeedbackImplementationResult> {
  if (activePullRequestNumbers.has(request.pullRequestNumber)) {
    return { status: "refused", reason: `Pull Request #${request.pullRequestNumber} is already being processed` };
  }
  const pullRequest = await ports.github.readPullRequest(request.pullRequestNumber);
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
        await ports.implementer.implement({
          pullRequestNumber: pullRequest.number,
          branch: pullRequest.headRefName,
          revision: pullRequest.headSha,
          checkoutPath,
        });
        const publishedRevision = await ports.publisher.publish({
          checkoutPath,
          branch: pullRequest.headRefName,
          expectedRevision: pullRequest.headSha,
        });
        const updated = await ports.github.readPullRequest(pullRequest.number);
        if (updated.headSha !== publishedRevision) {
          throw new Error("Pull Request head did not match the published feedback revision");
        }
        return publishedRevision;
      });
      if (!/^[0-9a-f]{40}$/u.test(revision) || revision === pullRequest.headSha) {
        throw new Error("Feedback implementation did not publish a new full revision");
      }
      return { status: "implemented", revision };
    } catch (error) {
      const jobId = ports.createJobId?.() ?? "local-feedback-job";
      const summary = redactFailureSummary(error instanceof Error ? error.message : String(error));
      await Promise.allSettled([
        ports.github.addPullRequestLabel(pullRequest.number, "agent:blocked"),
        ports.github.addFeedbackBlockedDiagnostic?.(pullRequest.number, {
          reason: "feedback-execution", jobId, summary,
        }),
      ]);
      return { status: "blocked", reason: "feedback-execution", jobId };
    } finally {
      await ports.github.removePullRequestLabel(pullRequest.number, "agent:in-progress").catch(() => undefined);
    }
  } finally {
    activePullRequestNumbers.delete(pullRequest.number);
    await lease.release();
  }
}
