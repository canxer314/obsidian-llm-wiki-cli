import { diagnosticSummary, redact as redactFailureSummary } from "./redaction.ts";
import type { SpecAutomationIssue } from "./spec-split-automation.ts";

export interface SpecChildIssue {
  readonly number: number;
  readonly title: string;
  readonly state: string;
  readonly openBlockerCount: number;
  readonly subIssueCount: number;
}

export type SpecImplementationBlockedReason = "spec-implementation-execution" | "spec-implementation-publication";

export interface SpecImplementationAutomationPorts {
  readonly github: {
    readSpec(issueNumber: number): Promise<SpecAutomationIssue>;
    listChildren(specNumber: number): Promise<readonly SpecChildIssue[]>;
    addIssueLabel(issueNumber: number, label: string): Promise<void>;
    removeIssueLabel(issueNumber: number, label: string): Promise<void>;
    addRefusalDiagnostic?(issueNumber: number, reason: string): Promise<void>;
    closeImplementedChild(request: {
      readonly specNumber: number;
      readonly childNumber: number;
      readonly revision: string;
    }): Promise<void>;
    addSpecImplementationBlockedDiagnostic?(
      issueNumber: number,
      diagnostic: {
        readonly reason: SpecImplementationBlockedReason;
        readonly jobId: string;
        readonly summary: string;
        readonly childNumber: number;
      },
    ): Promise<void>;
    addChildFailureDiagnostic?(
      childNumber: number,
      diagnostic: { readonly specNumber: number; readonly jobId: string },
    ): Promise<void>;
  };
  readonly pullRequests: {
    ensureSpecDraftPullRequest(request: {
      readonly specNumber: number;
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
      readonly specNumber: number;
      readonly child: { readonly number: number; readonly title: string };
      readonly branch: string;
      readonly baseRevision: string;
      readonly checkoutPath: string;
    }): Promise<{ readonly branch: string; readonly headSha: string }>;
  };
  readonly lease: {
    acquire(specNumber: number): Promise<{ release(): Promise<void> | void } | undefined>;
  };
  readonly createJobId?: () => string;
}

export type SpecImplementationAutomationResult =
  | {
    readonly status: "implemented";
    readonly childNumber: number;
    readonly branch: string;
    readonly pullRequestUrl: string;
    readonly continuation: "next-child" | "final-review";
  }
  | { readonly status: "refused"; readonly reason: string }
  | { readonly status: "blocked"; readonly reason: SpecImplementationBlockedReason; readonly jobId: string };

function specBranch(specNumber: number): string {
  return `sandcastle/spec-${specNumber}`;
}

function refusal(spec: SpecAutomationIssue): string | undefined {
  if (spec.state !== "OPEN") return `Issue #${spec.number} is not open`;
  if (!spec.labels.includes("agent:implement")) return `Issue #${spec.number} is not queued for implementation`;
  if (spec.labels.includes("agent:in-progress")) return `Issue #${spec.number} is already in progress`;
  if (spec.labels.includes("agent:blocked")) return `Issue #${spec.number} is blocked`;
  if (spec.subIssueCount === 0) return `Issue #${spec.number} has no sub-issues and is not a Spec`;
  if (!/^[0-9a-f]{40}$/u.test(spec.baseRevision)) return `Issue #${spec.number} has an invalid authorized base revision`;
  return undefined;
}

const activeSpecNumbers = new Set<number>();

export async function runSpecImplementationAutomationCommand(
  request: { readonly issueNumber: number },
  ports: SpecImplementationAutomationPorts,
): Promise<SpecImplementationAutomationResult> {
  if (activeSpecNumbers.has(request.issueNumber)) {
    return { status: "refused", reason: `Spec #${request.issueNumber} is already being implemented` };
  }
  const spec = await ports.github.readSpec(request.issueNumber);
  const reason = refusal(spec);
  if (reason !== undefined) {
    await ports.github.removeIssueLabel(spec.number, "agent:implement");
    await ports.github.addRefusalDiagnostic?.(spec.number, reason);
    return { status: "refused", reason };
  }
  const lease = await ports.lease.acquire(spec.number);
  if (lease === undefined) {
    const unavailableReason = `Spec #${spec.number} is already being implemented`;
    await ports.github.addRefusalDiagnostic?.(spec.number, unavailableReason);
    return { status: "refused", reason: unavailableReason };
  }
  activeSpecNumbers.add(spec.number);
  try {
    // Shape errors are business preflight refusals (#219 story 17): remove
    // the trigger and explain on the Automation Work Item without
    // agent:blocked, so an inapplicable request stays distinct from an
    // execution failure.
    const refuseShape = async (shapeReason: string): Promise<SpecImplementationAutomationResult> => {
      await ports.github.removeIssueLabel(spec.number, "agent:implement");
      await ports.github.addRefusalDiagnostic?.(spec.number, shapeReason);
      return { status: "refused", reason: shapeReason };
    };
    if (spec.parentNumber !== undefined) {
      return refuseShape(`Issue #${spec.number} has sub-issues but is itself a sub-issue of #${spec.parentNumber}; nested Specs are not supported`);
    }
    const children = await ports.github.listChildren(spec.number);
    const nestedChild = children.find((candidate) => candidate.subIssueCount > 0);
    if (nestedChild !== undefined) {
      return refuseShape(`Sub-issue #${nestedChild.number} itself has sub-issues; nested sub-issues are not supported`);
    }
    const child = children.find((candidate) => candidate.state === "OPEN");
    if (child === undefined) {
      return refuseShape(`Issue #${spec.number} has no open sub-issues to implement`);
    }
    if (child.openBlockerCount > 0) {
      const blockedReason = `Sub-issue #${child.number} cannot start while ${child.openBlockerCount} blocker(s) remain open`;
      await ports.github.removeIssueLabel(spec.number, "agent:implement");
      await ports.github.addRefusalDiagnostic?.(spec.number, blockedReason);
      return { status: "refused", reason: blockedReason };
    }

    await ports.github.addIssueLabel(spec.number, "agent:in-progress");
    await ports.github.removeIssueLabel(spec.number, "agent:implement");
    const branch = specBranch(spec.number);
    const block = async (
      blockedReason: SpecImplementationBlockedReason,
      error: unknown,
    ): Promise<SpecImplementationAutomationResult> => {
      const jobId = ports.createJobId?.() ?? "local-spec-implementation-job";
      const summary = redactFailureSummary(error instanceof Error ? error.message : String(error));
      // The public blocked diagnostic stays classification-only (#219 evidence
      // boundary); the redacted cause is recorded locally so a failed
      // publication round is diagnosable from the job log (the #416 attempt
      // that failed at review-publication left no local trace of why).
      console.error(`Spec implementation failed (${blockedReason}; job ${jobId}): ${diagnosticSummary(summary)}`);
      await Promise.allSettled([
        ports.github.addIssueLabel(spec.number, "agent:blocked"),
        ports.github.addSpecImplementationBlockedDiagnostic?.(spec.number, {
          reason: blockedReason,
          jobId,
          summary,
          childNumber: child.number,
        }),
        ports.github.addChildFailureDiagnostic?.(child.number, { specNumber: spec.number, jobId }),
      ]);
      return { status: "blocked", reason: blockedReason, jobId };
    };
    try {
      let implemented: { readonly branch: string; readonly headSha: string };
      try {
        const claimed = await ports.github.readSpec(spec.number);
        if (
          claimed.state !== "OPEN" ||
          claimed.baseRevision !== spec.baseRevision ||
          !claimed.labels.includes("agent:in-progress") ||
          claimed.labels.includes("agent:implement") ||
          claimed.labels.includes("agent:blocked") ||
          claimed.subIssueCount !== spec.subIssueCount ||
          claimed.parentNumber !== spec.parentNumber
        ) {
          throw new Error(`Issue #${spec.number} changed while Spec implementation was being acquired`);
        }
        implemented = await ports.checkout.withCheckout({
          pullRequestNumber: spec.number,
          revision: spec.baseRevision,
        }, (checkoutPath) => ports.implementer.implement({
          specNumber: spec.number,
          child: { number: child.number, title: child.title },
          branch,
          baseRevision: spec.baseRevision,
          checkoutPath,
        }));
      } catch (error) {
        return await block("spec-implementation-execution", error);
      }
      try {
        await ports.github.closeImplementedChild({
          specNumber: spec.number,
          childNumber: child.number,
          revision: implemented.headSha,
        });
        const pullRequest = await ports.pullRequests.ensureSpecDraftPullRequest({
          specNumber: spec.number,
          branch,
          headSha: implemented.headSha,
        });
        const remaining = (await ports.github.listChildren(spec.number))
          .filter((candidate) => candidate.state === "OPEN");
        if (remaining.length > 0) {
          await ports.github.addIssueLabel(spec.number, "agent:implement");
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
        return await block("spec-implementation-publication", error);
      }
    } finally {
      await ports.github.removeIssueLabel(spec.number, "agent:in-progress").catch(() => undefined);
    }
  } finally {
    activeSpecNumbers.delete(spec.number);
    await lease.release();
  }
}
