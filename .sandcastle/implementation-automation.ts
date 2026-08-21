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
    }): Promise<{ readonly branch: string; readonly pullRequestUrl: string } | undefined>;
    addIssueLabel(issueNumber: number, label: string): Promise<void>;
    removeIssueLabel(issueNumber: number, label: string): Promise<void>;
    addRefusalDiagnostic?(issueNumber: number, reason: string): Promise<void>;
    addImplementationBlockedDiagnostic?(
      issueNumber: number,
      diagnostic: { readonly reason: "implementation-execution"; readonly jobId: string },
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
  const issue = await ports.github.readIssue(request.issueNumber);
  const branch = reusableBranch(issue.number);
  const existing = await ports.github.findReusableImplementation?.({
    issueNumber: issue.number,
    branch,
  });
  if (existing !== undefined) return { status: "implemented", ...existing };
  const reason = refusal(issue);
  if (reason !== undefined) {
    await ports.github.addRefusalDiagnostic?.(issue.number, reason);
    return { status: "refused", reason };
  }

  if (activeIssueNumbers.has(issue.number)) {
    const unavailableReason = `Issue #${issue.number} is already being implemented`;
    await ports.github.addRefusalDiagnostic?.(issue.number, unavailableReason);
    return { status: "refused", reason: unavailableReason };
  }
  activeIssueNumbers.add(issue.number);
  try {
    const acquired = ports.github.claimIssue === undefined
      ? (await ports.github.addIssueLabel(issue.number, "agent:in-progress"), "acquired")
      : await ports.github.claimIssue(issue);
    if (acquired === "unavailable") {
      const unavailableReason = `Issue #${issue.number} is no longer available for implementation`;
      await ports.github.addRefusalDiagnostic?.(issue.number, unavailableReason);
      return { status: "refused", reason: unavailableReason };
    }

    try {
      await ports.github.removeIssueLabel(issue.number, "agent:implement");
      const result = await ports.checkout.withCheckout({
        pullRequestNumber: issue.number,
        revision: issue.baseRevision,
      }, (checkoutPath) => ports.implementer.implement({
        issueNumber: issue.number,
        baseRevision: issue.baseRevision,
        checkoutPath,
      }));
      return { status: "implemented", ...result };
    } catch {
      const jobId = ports.createJobId?.() ?? "local-implementation-job";
      await Promise.allSettled([
        ports.github.addIssueLabel(issue.number, "agent:blocked"),
        ports.github.addImplementationBlockedDiagnostic?.(issue.number, {
          reason: "implementation-execution",
          jobId,
        }),
      ]);
      return { status: "blocked", reason: "implementation-execution", jobId };
    } finally {
      await ports.github.removeIssueLabel(issue.number, "agent:in-progress").catch(() => undefined);
    }
  } finally {
    activeIssueNumbers.delete(issue.number);
  }
}
