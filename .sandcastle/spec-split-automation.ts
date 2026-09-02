import type { SpecSlice } from "./spec-split-extraction.ts";

export interface SpecAutomationIssue {
  readonly number: number;
  readonly title: string;
  readonly state: string;
  readonly labels: readonly string[];
  readonly baseRevision: string;
  readonly subIssueCount: number;
  readonly parentNumber?: number;
}

export interface SpecSplitAutomationPorts {
  readonly github: {
    readSpec(issueNumber: number): Promise<SpecAutomationIssue>;
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
      readonly specNumber: number;
      readonly title: string;
      readonly checkoutPath: string;
    }): Promise<readonly SpecSlice[]>;
  };
  readonly publisher: {
    publishSpecSplit(request: { readonly specNumber: number; readonly slices: readonly SpecSlice[] }): Promise<readonly number[]>;
  };
  readonly createJobId?: () => string;
}

export type SpecSplitAutomationResult =
  | { readonly status: "split"; readonly childIssueNumbers: readonly number[] }
  | { readonly status: "refused"; readonly reason: string }
  | { readonly status: "blocked"; readonly reason: "spec-split-execution"; readonly jobId: string };

function refusal(issue: SpecAutomationIssue): string | undefined {
  if (issue.state !== "OPEN") return `Issue #${issue.number} is not open`;
  if (!issue.labels.includes("agent:to-tickets")) return `Issue #${issue.number} is not queued for Spec splitting`;
  if (issue.labels.includes("agent:in-progress")) return `Issue #${issue.number} is already in progress`;
  if (issue.labels.includes("agent:blocked")) return `Issue #${issue.number} is blocked`;
  if (issue.subIssueCount > 0) return `Issue #${issue.number} already has ${issue.subIssueCount} sub-issue(s)`;
  if (issue.parentNumber !== undefined) return `Issue #${issue.number} is itself a sub-issue of #${issue.parentNumber}`;
  if (!/^[0-9a-f]{40}$/u.test(issue.baseRevision)) return `Issue #${issue.number} has an invalid authorized base revision`;
  return undefined;
}

export async function runSpecSplitAutomationCommand(
  request: { readonly issueNumber: number },
  ports: SpecSplitAutomationPorts,
): Promise<SpecSplitAutomationResult> {
  const issue = await ports.github.readSpec(request.issueNumber);
  const reason = refusal(issue);
  if (reason !== undefined) {
    await ports.github.removeIssueLabel(issue.number, "agent:to-tickets");
    await ports.github.addRefusalDiagnostic?.(issue.number, reason);
    return { status: "refused", reason };
  }

  await ports.github.addIssueLabel(issue.number, "agent:in-progress");
  try {
    await ports.github.removeIssueLabel(issue.number, "agent:to-tickets");
    const claimed = await ports.github.readSpec(issue.number);
    if (
      claimed.state !== "OPEN" ||
      claimed.baseRevision !== issue.baseRevision ||
      claimed.subIssueCount !== 0 ||
      claimed.parentNumber !== undefined ||
      !claimed.labels.includes("agent:in-progress") ||
      claimed.labels.includes("agent:to-tickets") ||
      claimed.labels.includes("agent:blocked")
    ) {
      throw new Error(`Issue #${issue.number} changed while Spec split was being acquired`);
    }
    const childIssueNumbers = await ports.checkout.withCheckout({
      pullRequestNumber: issue.number,
      revision: issue.baseRevision,
    }, async (checkoutPath) => {
      const slices = await ports.splitter.split({ specNumber: issue.number, title: issue.title, checkoutPath });
      return ports.publisher.publishSpecSplit({ specNumber: issue.number, slices });
    });
    return { status: "split", childIssueNumbers };
  } catch {
    const jobId = ports.createJobId?.() ?? "local-spec-split-job";
    await Promise.allSettled([
      ports.github.addIssueLabel(issue.number, "agent:blocked"),
      ports.github.addSplitBlockedDiagnostic?.(issue.number, { jobId }),
    ]);
    return { status: "blocked", reason: "spec-split-execution", jobId };
  } finally {
    await ports.github.removeIssueLabel(issue.number, "agent:in-progress").catch(() => undefined);
  }
}
