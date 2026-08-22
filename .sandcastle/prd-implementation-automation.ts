import { redactFailureSummary } from "./failure-finalizer.ts";
import type { PrdAutomationIssue } from "./prd-split-automation.ts";

export interface PrdChildIssue {
  readonly number: number;
  readonly title: string;
  readonly state: string;
  readonly openBlockerCount: number;
  readonly subIssueCount: number;
}

export type PrdImplementationBlockedReason = "prd-implementation-execution" | "prd-implementation-publication";

export interface PrdImplementationAutomationPorts {
  readonly github: {
    readPrd(issueNumber: number): Promise<PrdAutomationIssue>;
    listChildren(prdNumber: number): Promise<readonly PrdChildIssue[]>;
    addIssueLabel(issueNumber: number, label: string): Promise<void>;
    removeIssueLabel(issueNumber: number, label: string): Promise<void>;
    addRefusalDiagnostic?(issueNumber: number, reason: string): Promise<void>;
    closeImplementedChild(request: {
      readonly prdNumber: number;
      readonly childNumber: number;
      readonly revision: string;
    }): Promise<void>;
    addPrdImplementationBlockedDiagnostic?(
      issueNumber: number,
      diagnostic: {
        readonly reason: PrdImplementationBlockedReason;
        readonly jobId: string;
        readonly summary: string;
        readonly childNumber: number;
      },
    ): Promise<void>;
    addChildFailureDiagnostic?(
      childNumber: number,
      diagnostic: { readonly prdNumber: number; readonly jobId: string },
    ): Promise<void>;
  };
  readonly pullRequests: {
    ensurePrdDraftPullRequest(request: {
      readonly prdNumber: number;
      readonly branch: string;
      readonly headSha: string;
    }): Promise<{ readonly number: number; readonly url: string }>;
    addPullRequestLabel(pullRequestNumber: number, label: string): Promise<void>;
  };
  readonly checkout: {
    withCheckout<TResult>(
      request: { readonly pullRequestNumber: number; readonly revision: string },
      action: (checkoutPath: string) => Promise<TResult>,
    ): Promise<TResult>;
  };
  readonly implementer: {
    implement(request: {
      readonly prdNumber: number;
      readonly child: { readonly number: number; readonly title: string };
      readonly branch: string;
      readonly baseRevision: string;
      readonly checkoutPath: string;
    }): Promise<{ readonly branch: string; readonly headSha: string }>;
  };
  readonly lease?: {
    acquire(prdNumber: number): Promise<{ release(): Promise<void> } | undefined>;
  };
  readonly createJobId?: () => string;
}

export type PrdImplementationAutomationResult =
  | {
    readonly status: "implemented";
    readonly childNumber: number;
    readonly branch: string;
    readonly pullRequestUrl: string;
    readonly continuation: "next-child" | "final-review";
  }
  | { readonly status: "refused"; readonly reason: string }
  | { readonly status: "blocked"; readonly reason: PrdImplementationBlockedReason; readonly jobId: string };

function prdBranch(prdNumber: number): string {
  return `sandcastle/prd-${prdNumber}`;
}

function refusal(prd: PrdAutomationIssue): string | undefined {
  if (prd.state !== "OPEN") return `Issue #${prd.number} is not open`;
  if (!prd.labels.includes("agent:implement")) return `Issue #${prd.number} is not queued for implementation`;
  if (prd.labels.includes("agent:in-progress")) return `Issue #${prd.number} is already in progress`;
  if (prd.labels.includes("agent:blocked")) return `Issue #${prd.number} is blocked`;
  if (prd.subIssueCount === 0) return `Issue #${prd.number} has no sub-issues and is not a PRD`;
  if (!/^[0-9a-f]{40}$/u.test(prd.baseRevision)) return `Issue #${prd.number} has an invalid authorized base revision`;
  return undefined;
}

const activePrdNumbers = new Set<number>();

export async function runPrdImplementationAutomationCommand(
  request: { readonly issueNumber: number },
  ports: PrdImplementationAutomationPorts,
): Promise<PrdImplementationAutomationResult> {
  if (activePrdNumbers.has(request.issueNumber)) {
    return { status: "refused", reason: `PRD #${request.issueNumber} is already being implemented` };
  }
  const prd = await ports.github.readPrd(request.issueNumber);
  const reason = refusal(prd);
  if (reason !== undefined) {
    await ports.github.removeIssueLabel(prd.number, "agent:implement");
    await ports.github.addRefusalDiagnostic?.(prd.number, reason);
    return { status: "refused", reason };
  }
  const lease = ports.lease === undefined
    ? undefined
    : await ports.lease.acquire(prd.number);
  if (ports.lease !== undefined && lease === undefined) {
    const unavailableReason = `PRD #${prd.number} is already being implemented`;
    await ports.github.addRefusalDiagnostic?.(prd.number, unavailableReason);
    return { status: "refused", reason: unavailableReason };
  }
  activePrdNumbers.add(prd.number);
  try {
    // Shape errors cannot resolve themselves, so they block the Work Item
    // (upstream-equivalent) instead of silently consuming the trigger.
    const refuseShape = async (shapeReason: string): Promise<PrdImplementationAutomationResult> => {
      await ports.github.removeIssueLabel(prd.number, "agent:implement");
      await ports.github.addIssueLabel(prd.number, "agent:blocked");
      await ports.github.addRefusalDiagnostic?.(prd.number, shapeReason);
      return { status: "refused", reason: shapeReason };
    };
    if (prd.parentNumber !== undefined) {
      return refuseShape(`Issue #${prd.number} has sub-issues but is itself a sub-issue of #${prd.parentNumber}; nested PRDs are not supported`);
    }
    const children = await ports.github.listChildren(prd.number);
    const nestedChild = children.find((candidate) => candidate.subIssueCount > 0);
    if (nestedChild !== undefined) {
      return refuseShape(`Sub-issue #${nestedChild.number} itself has sub-issues; nested sub-issues are not supported`);
    }
    const child = children.find((candidate) => candidate.state === "OPEN");
    if (child === undefined) {
      return refuseShape(`Issue #${prd.number} has no open sub-issues to implement`);
    }
    if (child.openBlockerCount > 0) {
      const blockedReason = `Sub-issue #${child.number} cannot start while ${child.openBlockerCount} blocker(s) remain open`;
      await ports.github.removeIssueLabel(prd.number, "agent:implement");
      await ports.github.addRefusalDiagnostic?.(prd.number, blockedReason);
      return { status: "refused", reason: blockedReason };
    }

    await ports.github.addIssueLabel(prd.number, "agent:in-progress");
    await ports.github.removeIssueLabel(prd.number, "agent:implement");
    const branch = prdBranch(prd.number);
    const block = async (
      blockedReason: PrdImplementationBlockedReason,
      error: unknown,
    ): Promise<PrdImplementationAutomationResult> => {
      const jobId = ports.createJobId?.() ?? "local-prd-implementation-job";
      const summary = redactFailureSummary(error instanceof Error ? error.message : String(error));
      await Promise.allSettled([
        ports.github.addIssueLabel(prd.number, "agent:blocked"),
        ports.github.addPrdImplementationBlockedDiagnostic?.(prd.number, {
          reason: blockedReason,
          jobId,
          summary,
          childNumber: child.number,
        }),
        ports.github.addChildFailureDiagnostic?.(child.number, { prdNumber: prd.number, jobId }),
      ]);
      return { status: "blocked", reason: blockedReason, jobId };
    };
    try {
      let implemented: { readonly branch: string; readonly headSha: string };
      try {
        implemented = await ports.checkout.withCheckout({
          pullRequestNumber: prd.number,
          revision: prd.baseRevision,
        }, (checkoutPath) => ports.implementer.implement({
          prdNumber: prd.number,
          child: { number: child.number, title: child.title },
          branch,
          baseRevision: prd.baseRevision,
          checkoutPath,
        }));
      } catch (error) {
        return await block("prd-implementation-execution", error);
      }
      try {
        await ports.github.closeImplementedChild({
          prdNumber: prd.number,
          childNumber: child.number,
          revision: implemented.headSha,
        });
        const pullRequest = await ports.pullRequests.ensurePrdDraftPullRequest({
          prdNumber: prd.number,
          branch,
          headSha: implemented.headSha,
        });
        const remaining = (await ports.github.listChildren(prd.number))
          .filter((candidate) => candidate.state === "OPEN");
        if (remaining.length > 0) {
          await ports.github.addIssueLabel(prd.number, "agent:implement");
          return {
            status: "implemented",
            childNumber: child.number,
            branch,
            pullRequestUrl: pullRequest.url,
            continuation: "next-child",
          };
        }
        await ports.pullRequests.addPullRequestLabel(pullRequest.number, "agent:review");
        return {
          status: "implemented",
          childNumber: child.number,
          branch,
          pullRequestUrl: pullRequest.url,
          continuation: "final-review",
        };
      } catch (error) {
        return await block("prd-implementation-publication", error);
      }
    } finally {
      await ports.github.removeIssueLabel(prd.number, "agent:in-progress").catch(() => undefined);
    }
  } finally {
    activePrdNumbers.delete(prd.number);
    await lease?.release();
  }
}
