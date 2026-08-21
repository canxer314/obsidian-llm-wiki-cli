import { redactFailureSummary } from "./failure-finalizer.ts";

export interface ImplementationAutomationIssue {
  readonly number: number;
  readonly state: string;
  readonly labels: readonly string[];
  readonly baseRevision: string;
}

export interface ImplementationAutomationPorts {
  readonly github: {
    readIssue(issueNumber: number): Promise<ImplementationAutomationIssue>;
    claimIssue?(issue: ImplementationAutomationIssue): Promise<"acquired" | "unavailable">;
    findReusableImplementation?(request: {
      readonly issueNumber: number;
      readonly branch: string;
    }): Promise<
      | { readonly status: "pull-request"; readonly branch: string; readonly pullRequestUrl: string }
      | { readonly status: "branch"; readonly branch: string }
      | undefined
    >;
    publishExistingImplementation?(request: {
      readonly issueNumber: number;
      readonly branch: string;
    }): Promise<{ readonly branch: string; readonly pullRequestUrl: string }>;
    addIssueLabel(issueNumber: number, label: string): Promise<void>;
    removeIssueLabel(issueNumber: number, label: string): Promise<void>;
    addRefusalDiagnostic?(issueNumber: number, reason: string): Promise<void>;
    addImplementationBlockedDiagnostic?(
      issueNumber: number,
      diagnostic: {
        readonly reason: "implementation-execution";
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
  readonly implementer: {
    implement(request: {
      readonly issueNumber: number;
      readonly baseRevision: string;
      readonly checkoutPath: string;
    }): Promise<{ readonly branch: string; readonly pullRequestUrl: string }>;
  };
  readonly lease?: {
    acquire(issueNumber: number): Promise<{ release(): Promise<void> } | undefined>;
  };
  readonly createJobId?: () => string;
}

export type ImplementationAutomationResult =
  | { readonly status: "implemented"; readonly branch: string; readonly pullRequestUrl: string }
  | { readonly status: "refused"; readonly reason: string }
  | { readonly status: "blocked"; readonly reason: "implementation-execution"; readonly jobId: string };

function refusal(issue: ImplementationAutomationIssue): string | undefined {
  if (issue.state !== "OPEN") return `Issue #${issue.number} is not open`;
  if (!issue.labels.includes("agent:implement")) {
    return `Issue #${issue.number} is not queued for implementation`;
  }
  if (issue.labels.includes("agent:in-progress")) return `Issue #${issue.number} is already in progress`;
  if (issue.labels.includes("agent:blocked")) return `Issue #${issue.number} is blocked`;
  if (!/^[0-9a-f]{40}$/u.test(issue.baseRevision)) {
    return `Issue #${issue.number} has an invalid authorized base revision`;
  }
  return undefined;
}

const activeIssueNumbers = new Set<number>();

function reusableBranch(issueNumber: number): string {
  return `sandcastle/issue-${issueNumber}`;
}

export async function runImplementationAutomationCommand(
  request: { readonly issueNumber: number },
  ports: ImplementationAutomationPorts,
): Promise<ImplementationAutomationResult> {
  if (activeIssueNumbers.has(request.issueNumber)) {
    const unavailableReason = `Issue #${request.issueNumber} is already being implemented`;
    return { status: "refused", reason: unavailableReason };
  }
  const issue = await ports.github.readIssue(request.issueNumber);
  const branch = reusableBranch(issue.number);
  const lease = ports.lease === undefined
    ? undefined
    : await ports.lease.acquire(issue.number);
  if (ports.lease !== undefined && lease === undefined) {
    const unavailableReason = `Issue #${issue.number} is already being implemented`;
    await ports.github.addRefusalDiagnostic?.(issue.number, unavailableReason);
    return { status: "refused", reason: unavailableReason };
  }
  activeIssueNumbers.add(issue.number);
  try {
    const existing = await ports.github.findReusableImplementation?.({
      issueNumber: issue.number,
      branch,
    });
    if (existing?.status === "pull-request") {
      return { status: "implemented", branch: existing.branch, pullRequestUrl: existing.pullRequestUrl };
    }
    if (existing?.status === "branch") {
      const result = await ports.github.publishExistingImplementation?.({
        issueNumber: issue.number,
        branch: existing.branch,
      });
      if (result !== undefined) return { status: "implemented", ...result };
      throw new Error(`Implementation branch ${existing.branch} requires publication recovery`);
    }
    const reason = refusal(issue);
    if (reason !== undefined) {
      await ports.github.addRefusalDiagnostic?.(issue.number, reason);
      return { status: "refused", reason };
    }

    const currentIssue = await ports.github.readIssue(issue.number);
    const currentReason = refusal(currentIssue);
    if (currentReason !== undefined || currentIssue.baseRevision !== issue.baseRevision) {
      const unavailableReason = currentReason ?? `Issue #${issue.number} changed its authorized base revision`;
      await ports.github.addRefusalDiagnostic?.(issue.number, unavailableReason);
      return { status: "refused", reason: unavailableReason };
    }
    const acquired = ports.github.claimIssue === undefined
      ? (await ports.github.addIssueLabel(issue.number, "agent:in-progress"), "acquired")
      : await ports.github.claimIssue(currentIssue);
    if (acquired === "unavailable") {
      const unavailableReason = `Issue #${issue.number} is no longer available for implementation`;
      await ports.github.addRefusalDiagnostic?.(issue.number, unavailableReason);
      return { status: "refused", reason: unavailableReason };
    }

    try {
      await ports.github.removeIssueLabel(issue.number, "agent:implement");
      const claimedIssue = await ports.github.readIssue(issue.number);
      if (
        claimedIssue.state !== "OPEN" ||
        claimedIssue.baseRevision !== issue.baseRevision ||
        !claimedIssue.labels.includes("agent:in-progress") ||
        claimedIssue.labels.includes("agent:implement") ||
        claimedIssue.labels.includes("agent:blocked")
      ) {
        throw new Error(`Issue #${issue.number} changed while implementation was being acquired`);
      }
      const result = await ports.checkout.withCheckout({
        pullRequestNumber: issue.number,
        revision: issue.baseRevision,
      }, (checkoutPath) => ports.implementer.implement({
        issueNumber: issue.number,
        baseRevision: issue.baseRevision,
        checkoutPath,
      }));
      return { status: "implemented", ...result };
    } catch (error) {
      const jobId = ports.createJobId?.() ?? "local-implementation-job";
      const summary = redactFailureSummary(error instanceof Error ? error.message : String(error));
      await Promise.allSettled([
        ports.github.addIssueLabel(issue.number, "agent:blocked"),
        ports.github.addImplementationBlockedDiagnostic?.(issue.number, {
          reason: "implementation-execution",
          jobId,
          summary,
        }),
      ]);
      return { status: "blocked", reason: "implementation-execution", jobId };
    } finally {
      await ports.github.removeIssueLabel(issue.number, "agent:in-progress").catch(() => undefined);
    }
  } finally {
    activeIssueNumbers.delete(issue.number);
    await lease?.release();
  }
}
