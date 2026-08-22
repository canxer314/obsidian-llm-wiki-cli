import { redact as redactFailureSummary } from "./redaction.ts";

export interface BranchUpdatePullRequest {
  readonly number: number;
  readonly state: string;
  readonly isDraft: boolean;
  readonly baseRepository: string;
  readonly headRepository: string;
  readonly headRefName: string;
  readonly baseRefName: string;
  readonly headSha: string;
  readonly labels: readonly string[];
}

export interface BranchUpdateAutomationPorts {
  readonly github: {
    readPullRequest(pullRequestNumber: number): Promise<BranchUpdatePullRequest>;
    addPullRequestLabel(pullRequestNumber: number, label: string): Promise<void>;
    removePullRequestLabel(pullRequestNumber: number, label: string): Promise<void>;
    addRefusalDiagnostic?(pullRequestNumber: number, reason: string): Promise<void>;
    addBranchUpdateBlockedDiagnostic?(
      pullRequestNumber: number,
      diagnostic: {
        readonly reason: "branch-update-execution";
        readonly jobId: string;
        readonly summary: string;
      },
    ): Promise<void>;
  };
  readonly checkout: {
    withCheckout<TResult>(
      request: { readonly pullRequestNumber: number; readonly revision: string },
      action: (checkoutPath: string) => Promise<TResult>,
    ): Promise<TResult>;
  };
  readonly updater: {
    update(request: {
      readonly pullRequestNumber: number;
      readonly branch: string;
      readonly baseBranch: string;
      readonly revision: string;
      readonly checkoutPath: string;
    }): Promise<{ readonly revision: string }>;
  };
  readonly lease?: {
    acquire(pullRequestNumber: number): Promise<{ release(): Promise<void> } | undefined>;
  };
  readonly createJobId?: () => string;
}

export type BranchUpdateAutomationResult =
  | { readonly status: "updated"; readonly revision: string }
  | { readonly status: "refused"; readonly reason: string }
  | { readonly status: "blocked"; readonly reason: "branch-update-execution"; readonly jobId: string };

const activePullRequestNumbers = new Set<number>();

function refusal(pullRequest: BranchUpdatePullRequest): string | undefined {
  if (pullRequest.state !== "OPEN") return `Pull Request #${pullRequest.number} is not open`;
  if (!pullRequest.isDraft) return `Pull Request #${pullRequest.number} is not a Draft`;
  if (pullRequest.baseRepository !== pullRequest.headRepository) {
    return `Pull Request #${pullRequest.number} must not originate from a fork`;
  }
  if (!/^[0-9a-f]{40}$/u.test(pullRequest.headSha)) {
    return `Pull Request #${pullRequest.number} has an invalid head revision`;
  }
  if (!pullRequest.labels.includes("agent:update-branch")) {
    return `Pull Request #${pullRequest.number} is not queued for branch update`;
  }
  if (pullRequest.labels.includes("agent:in-progress")) {
    return `Pull Request #${pullRequest.number} is already in progress`;
  }
  if (pullRequest.labels.includes("agent:blocked")) return `Pull Request #${pullRequest.number} is blocked`;
  return undefined;
}

export async function runBranchUpdateAutomationCommand(
  request: { readonly pullRequestNumber: number },
  ports: BranchUpdateAutomationPorts,
): Promise<BranchUpdateAutomationResult> {
  if (activePullRequestNumbers.has(request.pullRequestNumber)) {
    return {
      status: "refused",
      reason: `Pull Request #${request.pullRequestNumber} is already being updated`,
    };
  }
  const pullRequest = await ports.github.readPullRequest(request.pullRequestNumber);
  const lease = ports.lease === undefined ? undefined : await ports.lease.acquire(pullRequest.number);
  if (ports.lease !== undefined && lease === undefined) {
    return { status: "refused", reason: `Pull Request #${pullRequest.number} is already being updated` };
  }
  activePullRequestNumbers.add(pullRequest.number);
  try {
    // Business preflight refusal (#219 story 17): remove the trigger and
    // explain on the Automation Work Item, without agent:blocked, so an
    // inapplicable request (e.g. a fork Pull Request) does not re-refuse
    // every round.
    const reason = refusal(pullRequest);
    if (reason !== undefined) {
      await ports.github.removePullRequestLabel(pullRequest.number, "agent:update-branch");
      await ports.github.addRefusalDiagnostic?.(pullRequest.number, reason);
      return { status: "refused", reason };
    }

    await ports.github.addPullRequestLabel(pullRequest.number, "agent:in-progress");
    try {
      await ports.github.removePullRequestLabel(pullRequest.number, "agent:update-branch");
      const current = await ports.github.readPullRequest(pullRequest.number);
      if (
        current.state !== "OPEN" ||
        !current.isDraft ||
        current.baseRepository !== current.headRepository ||
        current.headSha !== pullRequest.headSha ||
        !current.labels.includes("agent:in-progress") ||
        current.labels.includes("agent:update-branch") ||
        current.labels.includes("agent:blocked")
      ) {
        throw new Error(`Pull Request #${pullRequest.number} changed while branch update was being acquired`);
      }
      const result = await ports.checkout.withCheckout({
        pullRequestNumber: pullRequest.number,
        revision: pullRequest.headSha,
      }, (checkoutPath) => ports.updater.update({
        pullRequestNumber: pullRequest.number,
        branch: pullRequest.headRefName,
        baseBranch: pullRequest.baseRefName,
        revision: pullRequest.headSha,
        checkoutPath,
      }));
      if (!/^[0-9a-f]{40}$/u.test(result.revision)) {
        throw new Error("Branch update did not publish a full revision");
      }
      return { status: "updated", revision: result.revision };
    } catch (error) {
      const jobId = ports.createJobId?.() ?? "local-branch-update-job";
      const summary = redactFailureSummary(error instanceof Error ? error.message : String(error));
      await Promise.allSettled([
        ports.github.addPullRequestLabel(pullRequest.number, "agent:blocked"),
        ports.github.addBranchUpdateBlockedDiagnostic?.(pullRequest.number, {
          reason: "branch-update-execution",
          jobId,
          summary,
        }),
      ]);
      return { status: "blocked", reason: "branch-update-execution", jobId };
    } finally {
      await ports.github.removePullRequestLabel(pullRequest.number, "agent:in-progress").catch(() => undefined);
    }
  } finally {
    activePullRequestNumbers.delete(pullRequest.number);
    await lease?.release();
  }
}
