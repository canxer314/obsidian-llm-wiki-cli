import {
  selectDeliveryTransition,
  type AuthenticatedGitHubSnapshot,
  type ControlEnvelope,
  type DeliveryLeaseResult,
  type RepositoryPolicy,
  type WorkflowRunIdentity,
} from "@llm-wiki/afk-delivery-core";

export interface ManagedPullRequestContinuationRequest {
  repository: string;
  ticketNumber: number;
  lease: DeliveryLeaseResult;
  policy: RepositoryPolicy;
  workflowRun: WorkflowRunIdentity;
}

export interface SynchronizationRequest {
  prNumber: number;
  headBranch: string;
  expectedHeadRevision: string;
  targetRevision: string;
}

export interface SynchronizationConflict {
  path: string;
  ours: string;
  theirs: string;
}

export type SynchronizationResult =
  | { status: "succeeded"; outputRevision: string; narrative: string }
  | { status: "conflicted"; narrative: string; conflicts: SynchronizationConflict[] };

export interface ConflictResolutionRequest extends SynchronizationRequest {
  ticket: AuthenticatedGitHubSnapshot["ticket"];
  controlComments: AuthenticatedGitHubSnapshot["controlComments"];
  conflicts: SynchronizationConflict[];
}

export interface InterruptedSynchronization {
  prNumber: number;
  inputRevision: string;
  outputRevision: string;
  targetRevision: string;
  narrative: string;
}

export interface ManagedPullRequestContinuationPorts {
  reconstruct(): Promise<{
    snapshot: AuthenticatedGitHubSnapshot;
    interruptedSynchronization?: InterruptedSynchronization;
  }>;
  synchronize(input: SynchronizationRequest): Promise<SynchronizationResult>;
  resolveConflicts(input: ConflictResolutionRequest): Promise<{
    status: "succeeded" | "failed";
    outputRevision?: string;
    narrative: string;
  }>;
  recordControlComment(input: {
    prNumber: number;
    envelope: ControlEnvelope;
    narrative?: string;
    idempotencyKey: string;
  }): Promise<{ created: boolean }>;
  recordNeedsHuman(input: {
    ticketNumber: number;
    prNumber?: number;
    reason: string;
    idempotencyKey: string;
  }): Promise<{ created: boolean }>;
}

export type ManagedPullRequestContinuationResult =
  | {
      status: "synchronized";
      prNumber: number;
      inputRevision: string;
      outputRevision: string;
      conflictResolved: boolean;
      recovered?: boolean;
      recordCreated: boolean;
    }
  | {
      status: "selected";
      transition: ReturnType<typeof selectDeliveryTransition>["transition"];
    }
  | { status: "needs-human"; reason: string; recordCreated: boolean };

async function persistSynchronization(
  request: ManagedPullRequestContinuationRequest,
  ports: ManagedPullRequestContinuationPorts,
  snapshot: AuthenticatedGitHubSnapshot,
  synchronization: InterruptedSynchronization,
  options: { conflictResolved: boolean; recovered?: boolean },
): Promise<Extract<ManagedPullRequestContinuationResult, { status: "synchronized" }>> {
  const recordedTransition = selectDeliveryTransition({
    snapshot,
    lease: request.lease,
    policy: request.policy,
    workflowRun: request.workflowRun,
    stageOutcome: {
      kind: "synchronization",
      status: "succeeded",
      inputRevision: synchronization.inputRevision,
      outputRevision: synchronization.outputRevision,
      narrative: synchronization.narrative,
    },
  });
  const effect = recordedTransition.effects[0];
  if (
    recordedTransition.transition.kind !== "record-synchronization" ||
    effect?.kind !== "record-control-comment" ||
    effect.envelope === undefined
  ) {
    throw new Error("fresh GitHub reconstruction rejected the synchronization result");
  }
  const record = await ports.recordControlComment({
    prNumber: synchronization.prNumber,
    envelope: effect.envelope,
    ...(effect.narrative === undefined ? {} : { narrative: effect.narrative }),
    idempotencyKey: effect.idempotencyKey,
  });
  return {
    status: "synchronized",
    prNumber: synchronization.prNumber,
    inputRevision: synchronization.inputRevision,
    outputRevision: synchronization.outputRevision,
    conflictResolved: options.conflictResolved,
    ...(options.recovered === undefined ? {} : { recovered: options.recovered }),
    recordCreated: record.created,
  };
}

function verifySnapshot(
  request: ManagedPullRequestContinuationRequest,
  snapshot: AuthenticatedGitHubSnapshot,
): void {
  if (snapshot.repository !== request.repository || snapshot.ticket.number !== request.ticketNumber) {
    throw new Error("reconstructed GitHub snapshot does not match the continuation request");
  }
}

export async function continueManagedPullRequest(
  request: ManagedPullRequestContinuationRequest,
  ports: ManagedPullRequestContinuationPorts,
): Promise<ManagedPullRequestContinuationResult> {
  const reconstructed = await ports.reconstruct();
  verifySnapshot(request, reconstructed.snapshot);
  if (reconstructed.interruptedSynchronization !== undefined) {
    const interrupted = reconstructed.interruptedSynchronization;
    const currentPr = reconstructed.snapshot.pullRequests.find((pr) => pr.number === interrupted.prNumber);
    if (
      currentPr === undefined ||
      currentPr.headRevision !== interrupted.outputRevision ||
      currentPr.baseRevision !== interrupted.targetRevision ||
      reconstructed.snapshot.targetBranchRevision !== interrupted.targetRevision
    ) {
      throw new Error("interrupted synchronization proof does not match the current GitHub snapshot");
    }
    return persistSynchronization(request, ports, reconstructed.snapshot, interrupted, {
      conflictResolved: false,
      recovered: true,
    });
  }
  const selected = selectDeliveryTransition({
    snapshot: reconstructed.snapshot,
    lease: request.lease,
    policy: request.policy,
    workflowRun: request.workflowRun,
  });

  if (selected.transition.kind === "needs-human") {
    const effect = selected.effects[0];
    if (effect === undefined || selected.transition.reason === undefined) {
      throw new Error("Needs Human transition is missing its durable effect");
    }
    const recorded = await ports.recordNeedsHuman({
      ticketNumber: request.ticketNumber,
      ...(selected.transition.prNumber === undefined ? {} : { prNumber: selected.transition.prNumber }),
      reason: selected.transition.reason,
      idempotencyKey: effect.idempotencyKey,
    });
    return { status: "needs-human", reason: selected.transition.reason, recordCreated: recorded.created };
  }

  if (selected.transition.kind !== "synchronize") {
    return { status: "selected", transition: selected.transition };
  }

  const prNumber = selected.transition.prNumber;
  const inputRevision = selected.transition.inputRevision;
  const targetRevision = reconstructed.snapshot.targetBranchRevision;
  if (prNumber === undefined || inputRevision === undefined || targetRevision === undefined) {
    throw new Error("synchronization transition is missing an exact Revision");
  }
  const currentSnapshotPr = reconstructed.snapshot.pullRequests.find((pr) => pr.number === prNumber);
  if (currentSnapshotPr?.headBranch === undefined) {
    throw new Error("synchronization requires the Managed PR head branch");
  }
  const attempted = await ports.synchronize({
    prNumber,
    headBranch: currentSnapshotPr.headBranch,
    expectedHeadRevision: inputRevision,
    targetRevision,
  });
  let conflictResolved = false;
  let synchronization: Extract<SynchronizationResult, { status: "succeeded" }>;
  if (attempted.status === "conflicted") {
    const resolved = await ports.resolveConflicts({
      prNumber,
      headBranch: currentSnapshotPr.headBranch,
      expectedHeadRevision: inputRevision,
      targetRevision,
      ticket: reconstructed.snapshot.ticket,
      controlComments: reconstructed.snapshot.controlComments,
      conflicts: attempted.conflicts,
    });
    if (resolved.status !== "succeeded" || resolved.outputRevision === undefined) {
      const reason = "bounded conflict resolution did not produce a new Revision";
      const recorded = await ports.recordNeedsHuman({
        ticketNumber: request.ticketNumber,
        prNumber,
        reason,
        idempotencyKey: `${selected.transition.transitionId}:conflict:record-needs-human`,
      });
      return { status: "needs-human", reason, recordCreated: recorded.created };
    }
    synchronization = {
      status: "succeeded",
      outputRevision: resolved.outputRevision,
      narrative: resolved.narrative,
    };
    conflictResolved = true;
  } else {
    synchronization = attempted;
  }

  const refreshed = await ports.reconstruct();
  verifySnapshot(request, refreshed.snapshot);
  const currentPr = refreshed.snapshot.pullRequests.find((pr) => pr.number === prNumber);
  if (
    currentPr === undefined ||
    currentPr.headRevision !== synchronization.outputRevision ||
    currentPr.baseRevision !== targetRevision
  ) {
    throw new Error("synchronized Revision changed before its control record was persisted");
  }

  return persistSynchronization(request, ports, refreshed.snapshot, {
    prNumber,
    inputRevision,
    outputRevision: synchronization.outputRevision,
    targetRevision,
    narrative: synchronization.narrative,
  }, { conflictResolved });
}
