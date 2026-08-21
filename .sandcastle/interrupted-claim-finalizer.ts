import type { SandcastleClaimReceipt } from "./cli.ts";
import {
  reconcileClaim,
  type ClaimReconciliationInput,
  type ClaimReconciliationPorts,
  type ClaimReconciliationSnapshot,
} from "./claim-reconciliation.ts";
import {
  finalizeFailure,
  type FailureGithubPort,
} from "./failure-finalizer.ts";

export interface InterruptedClaimReleasePort {
  removeStoppedContainer(input: ClaimReconciliationInput): Promise<void>;
  removeCleanWorktree(input: ClaimReconciliationInput): Promise<void>;
  compareAndDeleteLocalBranch(input: ClaimReconciliationInput & {
    readonly expectedHeadSha: string;
  }): Promise<void>;
  compareAndDeleteBranch(input: ClaimReconciliationInput & {
    readonly expectedHeadSha: string;
  }): Promise<void>;
}

export interface InterruptedClaimFinalizationPorts {
  readonly reconciliation: ClaimReconciliationPorts;
  readonly release: InterruptedClaimReleasePort;
  readonly failure: FailureGithubPort;
}

export interface InterruptedClaimFinalizationOptions {
  readonly repository: string;
  readonly receipt: SandcastleClaimReceipt;
}

export type InterruptedClaimFinalizationResult = {
  readonly status: "released" | "preserved" | "delivery-complete" | "cleanup-failed";
  readonly failures: readonly string[];
};

function isReceiptBoundEmpty(
  snapshot: ClaimReconciliationSnapshot,
  receipt: SandcastleClaimReceipt,
): boolean {
  return snapshot.recommendedAction === "release-empty-claim" &&
    snapshot.claimBranch.state === "present" &&
    snapshot.claimBranch.headSha === receipt.baseSha &&
    snapshot.branchRelation === "equal" &&
    snapshot.uniqueCommits.state === "zero" &&
    snapshot.pullRequests.state === "none" &&
    (snapshot.worktree === "absent" || snapshot.worktree === "clean") &&
    (snapshot.container === "absent" || snapshot.container === "present");
}

async function markInterruptedFailure(
  issueNumber: number,
  reason: string,
  github: FailureGithubPort,
): Promise<readonly string[]> {
  const result = await finalizeFailure({
    issueNumber,
    stage: "interrupted",
    summary: reason,
  }, github);
  return result.failures;
}

export async function finalizeInterruptedClaim(
  options: InterruptedClaimFinalizationOptions,
  ports: InterruptedClaimFinalizationPorts,
): Promise<InterruptedClaimFinalizationResult> {
  const input: ClaimReconciliationInput = {
    repository: options.repository,
    issueNumber: options.receipt.issueNumber,
    branch: options.receipt.branch,
    comparisonBaseSha: options.receipt.baseSha,
  };
  const snapshot = await reconcileClaim(input, ports.reconciliation);

  if (snapshot.classification === "delivery-complete") {
    return { status: "delivery-complete", failures: [] };
  }
  if (!isReceiptBoundEmpty(snapshot, options.receipt)) {
    const failures = await markInterruptedFailure(
      options.receipt.issueNumber,
      `classification=${snapshot.classification}; reason=claim-not-proven-empty`,
      ports.failure,
    );
    return { status: "preserved", failures };
  }

  const cleanupFailures: string[] = [];
  if (snapshot.container === "present") {
    try {
      await ports.release.removeStoppedContainer(input);
    } catch {
      cleanupFailures.push("container: cleanup-failed");
    }
  }
  if (cleanupFailures.length === 0 && snapshot.worktree === "clean") {
    try {
      await ports.release.removeCleanWorktree(input);
    } catch {
      cleanupFailures.push("worktree: cleanup-failed");
    }
  }
  if (cleanupFailures.length === 0) {
    try {
      await ports.release.compareAndDeleteLocalBranch({
        ...input,
        expectedHeadSha: options.receipt.baseSha,
      });
    } catch {
      cleanupFailures.push("local-branch: cleanup-failed");
    }
  }
  if (cleanupFailures.length === 0) {
    try {
      await ports.release.compareAndDeleteBranch({
        ...input,
        expectedHeadSha: options.receipt.baseSha,
      });
    } catch {
      cleanupFailures.push("branch: cleanup-failed");
    }
  }
  if (cleanupFailures.length === 0) return { status: "released", failures: [] };

  const finalizationFailures = await markInterruptedFailure(
    options.receipt.issueNumber,
    "classification=empty-candidate; reason=cleanup-failed",
    ports.failure,
  );
  return {
    status: "cleanup-failed",
    failures: [...cleanupFailures, ...finalizationFailures],
  };
}
