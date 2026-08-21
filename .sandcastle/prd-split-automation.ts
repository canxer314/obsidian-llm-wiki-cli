import type { PrdSlice } from "./prd-split-extraction.ts";

export interface PrdAutomationIssue {
  readonly number: number;
  readonly title: string;
  readonly state: string;
  readonly labels: readonly string[];
  readonly baseRevision: string;
  readonly subIssueCount: number;
  readonly parentNumber?: number;
}

export interface PrdSplitAutomationPorts {
  readonly github: {
    readPrd(issueNumber: number): Promise<PrdAutomationIssue>;
    addIssueLabel(issueNumber: number, label: string): Promise<void>;
    removeIssueLabel(issueNumber: number, label: string): Promise<void>;
    addRefusalDiagnostic?(issueNumber: number, reason: string): Promise<void>;
    addSplitBlockedDiagnostic?(issueNumber: number, diagnostic: { readonly jobId: string }): Promise<void>;
  };
  readonly checkout: {
    withCheckout<TResult>(
      request: { readonly pullRequestNumber: number; readonly revision: string },
      action: (checkoutPath: string) => Promise<TResult>,
    ): Promise<TResult>;
  };
  readonly splitter: {
    split(request: {
      readonly prdNumber: number;
      readonly title: string;
      readonly checkoutPath: string;
    }): Promise<readonly PrdSlice[]>;
  };
  readonly publisher: {
    publishPrdSplit(request: { readonly prdNumber: number; readonly slices: readonly PrdSlice[] }): Promise<readonly number[]>;
  };
  readonly createJobId?: () => string;
}

export type PrdSplitAutomationResult =
  | { readonly status: "split"; readonly childIssueNumbers: readonly number[] }
  | { readonly status: "refused"; readonly reason: string }
  | { readonly status: "blocked"; readonly reason: "prd-split-execution"; readonly jobId: string };

function refusal(issue: PrdAutomationIssue): string | undefined {
  if (issue.state !== "OPEN") return `Issue #${issue.number} is not open`;
  if (!issue.labels.includes("agent:to-issues")) return `Issue #${issue.number} is not queued for PRD splitting`;
  if (issue.labels.includes("agent:in-progress")) return `Issue #${issue.number} is already in progress`;
  if (issue.labels.includes("agent:blocked")) return `Issue #${issue.number} is blocked`;
  if (issue.subIssueCount > 0) return `Issue #${issue.number} already has ${issue.subIssueCount} sub-issue(s)`;
  if (issue.parentNumber !== undefined) return `Issue #${issue.number} is itself a sub-issue of #${issue.parentNumber}`;
  if (!/^[0-9a-f]{40}$/u.test(issue.baseRevision)) return `Issue #${issue.number} has an invalid authorized base revision`;
  return undefined;
}

export async function runPrdSplitAutomationCommand(
  request: { readonly issueNumber: number },
  ports: PrdSplitAutomationPorts,
): Promise<PrdSplitAutomationResult> {
  const issue = await ports.github.readPrd(request.issueNumber);
  const reason = refusal(issue);
  if (reason !== undefined) {
    await ports.github.removeIssueLabel(issue.number, "agent:to-issues");
    await ports.github.addRefusalDiagnostic?.(issue.number, reason);
    return { status: "refused", reason };
  }

  await ports.github.addIssueLabel(issue.number, "agent:in-progress");
  try {
    await ports.github.removeIssueLabel(issue.number, "agent:to-issues");
    const childIssueNumbers = await ports.checkout.withCheckout({
      pullRequestNumber: issue.number,
      revision: issue.baseRevision,
    }, async (checkoutPath) => {
      const slices = await ports.splitter.split({ prdNumber: issue.number, title: issue.title, checkoutPath });
      return ports.publisher.publishPrdSplit({ prdNumber: issue.number, slices });
    });
    return { status: "split", childIssueNumbers };
  } catch {
    const jobId = ports.createJobId?.() ?? "local-prd-split-job";
    await Promise.allSettled([
      ports.github.addIssueLabel(issue.number, "agent:blocked"),
      ports.github.addSplitBlockedDiagnostic?.(issue.number, { jobId }),
    ]);
    return { status: "blocked", reason: "prd-split-execution", jobId };
  } finally {
    await ports.github.removeIssueLabel(issue.number, "agent:in-progress").catch(() => undefined);
  }
}
