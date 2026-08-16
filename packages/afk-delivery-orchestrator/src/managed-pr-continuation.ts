import {
  selectDeliveryTransition,
  type AuthenticatedGitHubSnapshot,
  type ControlEnvelope,
  type DeliveryLeaseResult,
  type RepairRequest,
  type RepositoryPolicy,
  type WorkflowRunIdentity,
  type ValidationRequest,
  type ReviewRequest,
  type StageOutcome,
} from "@llm-wiki/afk-delivery-core";

export interface ManagedPullRequestContinuationRequest {
  repository: string;
  ticketNumber: number;
  lease: DeliveryLeaseResult;
  policy: RepositoryPolicy;
  workflowRun: WorkflowRunIdentity;
}

export function synchronizationStagingRef(input: {
  prNumber: number;
  expectedHeadRevision: string;
  targetRevision: string;
}): string {
  return `refs/afk-delivery/v1/synchronizations/${input.prNumber}/${input.expectedHeadRevision}-${input.targetRevision}`;
}

export interface SynchronizationRequest {
  prNumber: number;
  headBranch: string;
  expectedHeadRevision: string;
  targetRevision: string;
  authorizeOutput(outputRevision: string): Promise<void>;
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

export interface PreparedSynchronization extends InterruptedSynchronization {
  headBranch: string;
  readyEnvelope?: ControlEnvelope;
}

export interface ManagedPullRequestContinuationPorts {
  reconstruct(): Promise<{
    snapshot: AuthenticatedGitHubSnapshot;
    preparedSynchronization?: PreparedSynchronization;
    interruptedSynchronization?: InterruptedSynchronization;
  }>;
  synchronize(input: SynchronizationRequest): Promise<SynchronizationResult>;
  publishPreparedSynchronization(input: InterruptedSynchronization & { headBranch: string }): Promise<void>;
  resolveConflicts(input: ConflictResolutionRequest): Promise<{
    status: "succeeded" | "failed";
    outputRevision?: string;
    narrative: string;
  }>;
  runValidation?(input: ValidationRequest): Promise<Extract<StageOutcome, { kind: "validation" }>>;
  runReview?(input: ReviewRequest): Promise<Extract<StageOutcome, { kind: "review" }>>;
  runRepair?(input: RepairRequest): Promise<Extract<StageOutcome, { kind: "repair" }>>;
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
    evidenceLinks: string[];
    envelope?: ControlEnvelope;
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

function evidenceLink(request: ManagedPullRequestContinuationRequest, prNumber?: number): string {
  const subject = prNumber === undefined
    ? `issues/${request.ticketNumber}`
    : `pull/${prNumber}`;
  return `https://github.com/${request.repository}/${subject}`;
}

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

function verifyStageSnapshot(
  request: ManagedPullRequestContinuationRequest,
  snapshot: AuthenticatedGitHubSnapshot,
  prNumber: number,
  headRevision: string,
  baseRevision?: string,
): void {
  verifySnapshot(request, snapshot);
  const pr = snapshot.pullRequests.find((candidate) => candidate.number === prNumber);
  if (pr === undefined || pr.headRevision !== headRevision ||
      (baseRevision !== undefined && pr.baseRevision !== baseRevision)) {
    throw new Error("PR Revision changed before stage evidence was persisted");
  }
}

async function consumeSelectedStageEffect(
  request: ManagedPullRequestContinuationRequest,
  ports: ManagedPullRequestContinuationPorts,
  snapshot: AuthenticatedGitHubSnapshot,
  selected: ReturnType<typeof selectDeliveryTransition>,
): Promise<ManagedPullRequestContinuationResult | undefined> {
  const effect = selected.effects[0];
  const prNumber = selected.transition.prNumber;
  const revision = selected.transition.inputRevision;
  if (effect === undefined || prNumber === undefined || revision === undefined) return undefined;
  if (effect.kind === "run-validation") {
    if (ports.runValidation === undefined || effect.validationRequest === undefined ||
        effect.validationRequest.revision !== revision || effect.exactRevision !== revision ||
        effect.validationRequest.round !== selected.transition.round) {
      throw new Error("validation effect is incomplete or not bound to the selected Revision");
    }
    const outcome = await ports.runValidation(effect.validationRequest);
    const refreshed = await ports.reconstruct();
    verifyStageSnapshot(request, refreshed.snapshot, prNumber, revision);
    const recorded = selectDeliveryTransition({
      snapshot: refreshed.snapshot, lease: request.lease, policy: request.policy, workflowRun: request.workflowRun,
      stageOutcome: outcome,
    });
    const record = recorded.effects[0];
    if (record?.kind !== "record-control-comment" || record.envelope === undefined) {
      throw new Error("fresh GitHub reconstruction rejected validation evidence");
    }
    await ports.recordControlComment({ prNumber, envelope: record.envelope, idempotencyKey: record.idempotencyKey });
    return { status: "selected", transition: recorded.transition };
  }
  if (effect.kind === "run-review") {
    if (ports.runReview === undefined || effect.reviewRequest === undefined ||
        effect.reviewRequest.headRevision !== revision || effect.exactRevision !== revision ||
        effect.reviewRequest.round !== selected.transition.round) {
      throw new Error("review effect is incomplete or not bound to the selected Revision");
    }
    const outcome = await ports.runReview(effect.reviewRequest);
    const refreshed = await ports.reconstruct();
    verifyStageSnapshot(request, refreshed.snapshot, prNumber, revision, effect.reviewRequest.baseRevision);
    const recorded = selectDeliveryTransition({
      snapshot: refreshed.snapshot, lease: request.lease, policy: request.policy, workflowRun: request.workflowRun,
      stageOutcome: outcome,
    });
    const record = recorded.effects[0];
    if (record?.kind !== "record-control-comment" || record.envelope === undefined) {
      throw new Error("fresh GitHub reconstruction rejected Review Handoff");
    }
    await ports.recordControlComment({
      prNumber, envelope: record.envelope, ...(record.narrative === undefined ? {} : { narrative: record.narrative }), idempotencyKey: record.idempotencyKey,
    });
    return { status: "selected", transition: recorded.transition };
  }
  if (effect.kind === "run-repair") {
    if (ports.runRepair === undefined || effect.repairRequest === undefined) {
      throw new Error("repair effect is missing its stage port or request");
    }
    if (effect.repairRequest.rejectedRevision !== revision || effect.exactRevision !== revision) {
      throw new Error("repair effect is not bound to the rejected Revision");
    }
    if (effect.repairRequest.round !== selected.transition.round) {
      throw new Error("repair effect is not bound to the selected review round");
    }
    if (effect.envelope === undefined || effect.envelope.disposition !== "started") {
      throw new Error("repair effect is missing its authenticated start intent");
    }
    await ports.recordControlComment({
      prNumber,
      envelope: effect.envelope,
      ...(effect.narrative === undefined ? {} : { narrative: effect.narrative }),
      idempotencyKey: effect.idempotencyKey,
    });
    const outcome = await ports.runRepair(effect.repairRequest);
    const refreshed = await ports.reconstruct();
    if (outcome.status !== "succeeded") {
      const possiblePublishedRevision = outcome.outputRevision !== revision
        ? outcome.outputRevision
        : revision;
      verifyStageSnapshot(request, refreshed.snapshot, prNumber, possiblePublishedRevision);
      const failed = selectDeliveryTransition({
        snapshot: refreshed.snapshot, lease: request.lease, policy: request.policy, workflowRun: request.workflowRun,
        stageOutcome: outcome,
      });
      const needsHumanEffect = failed.effects[0];
      if (failed.transition.kind !== "needs-human" || failed.transition.reason === undefined ||
          needsHumanEffect?.kind !== "record-needs-human") {
        throw new Error("fresh GitHub reconstruction did not fail closed after repair failure");
      }
      const record = await ports.recordNeedsHuman({
        ticketNumber: request.ticketNumber,
        prNumber,
        reason: failed.transition.reason,
        evidenceLinks: [evidenceLink(request, prNumber)],
        ...(needsHumanEffect.envelope === undefined ? {} : { envelope: needsHumanEffect.envelope }),
        idempotencyKey: needsHumanEffect.idempotencyKey,
      });
      return { status: "needs-human", reason: failed.transition.reason, recordCreated: record.created };
    }
    if (outcome.inputRevision !== revision || outcome.outputRevision === revision) {
      throw new Error("repair did not produce a new Revision from the rejected Revision");
    }
    verifyStageSnapshot(request, refreshed.snapshot, prNumber, outcome.outputRevision);
    const recorded = selectDeliveryTransition({
      snapshot: refreshed.snapshot, lease: request.lease, policy: request.policy, workflowRun: request.workflowRun,
      stageOutcome: outcome,
    });
    const record = recorded.effects[0];
    if (record?.kind !== "record-control-comment" || record.envelope === undefined) {
      throw new Error("fresh GitHub reconstruction rejected Repair Handoff");
    }
    await ports.recordControlComment({
      prNumber, envelope: record.envelope, ...(record.narrative === undefined ? {} : { narrative: record.narrative }), idempotencyKey: record.idempotencyKey,
    });
    return { status: "selected", transition: recorded.transition };
  }
  return undefined;
}

export async function continueManagedPullRequest(
  request: ManagedPullRequestContinuationRequest,
  ports: ManagedPullRequestContinuationPorts,
): Promise<ManagedPullRequestContinuationResult> {
  const reconstructed = await ports.reconstruct();
  verifySnapshot(request, reconstructed.snapshot);
  if (reconstructed.preparedSynchronization !== undefined) {
    const prepared = reconstructed.preparedSynchronization;
    if (prepared.readyEnvelope !== undefined) {
      await ports.recordControlComment({
        prNumber: prepared.prNumber,
        envelope: prepared.readyEnvelope,
        narrative: `Recovered synchronization output Revision ${prepared.outputRevision}.`,
        idempotencyKey: `${prepared.readyEnvelope.transitionId}:record-control-comment`,
      });
    }
    await ports.publishPreparedSynchronization(prepared);
    const refreshed = await ports.reconstruct();
    verifySnapshot(request, refreshed.snapshot);
    return persistSynchronization(request, ports, refreshed.snapshot, reconstructed.preparedSynchronization, {
      conflictResolved: false,
      recovered: true,
    });
  }
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

  const consumed = await consumeSelectedStageEffect(request, ports, reconstructed.snapshot, selected);
  if (consumed !== undefined) return consumed;

  if (selected.transition.kind === "needs-human") {
    const effect = selected.effects[0];
    if (effect === undefined || selected.transition.reason === undefined) {
      throw new Error("Needs Human transition is missing its durable effect");
    }
    const recorded = await ports.recordNeedsHuman({
      ticketNumber: request.ticketNumber,
      ...(selected.transition.prNumber === undefined ? {} : { prNumber: selected.transition.prNumber }),
      reason: selected.transition.reason,
      evidenceLinks: [evidenceLink(request, selected.transition.prNumber)],
      ...(effect.envelope === undefined ? {} : { envelope: effect.envelope }),
      idempotencyKey: effect.idempotencyKey,
    });
    return { status: "needs-human", reason: selected.transition.reason, recordCreated: recorded.created };
  }

  let intent: ControlEnvelope | undefined;
  if (selected.transition.kind === "synchronize") {
    const prNumber = selected.transition.prNumber;
    const inputRevision = selected.transition.inputRevision;
    const targetRevision = reconstructed.snapshot.targetBranchRevision;
    if (prNumber === undefined || inputRevision === undefined || targetRevision === undefined) {
      throw new Error("synchronization transition is missing an exact Revision");
    }
    intent = {
      schemaVersion: 1,
      kind: "synchronization",
      repository: request.repository,
      ticketNumber: request.ticketNumber,
      prNumber,
      targetRevision,
      round: selected.transition.round,
      transitionId: `${selected.transition.transitionId}:intent`,
      inputRevision,
      disposition: "started",
      workflowRunId: request.workflowRun.id,
      workflowRunAttempt: request.workflowRun.attempt,
    };
    await ports.recordControlComment({
      prNumber,
      envelope: intent,
      narrative: `Synchronization intent for target Revision ${targetRevision}.`,
      idempotencyKey: `${intent.transitionId}:record-control-comment`,
    });
  }

  if (selected.transition.kind !== "synchronize") {
    return { status: "selected", transition: selected.transition };
  }

  const prNumber = selected.transition.prNumber;
  const inputRevision = selected.transition.inputRevision;
  const targetRevision = reconstructed.snapshot.targetBranchRevision;
  if (prNumber === undefined || inputRevision === undefined || targetRevision === undefined || intent === undefined) {
    throw new Error("synchronization transition is missing an exact Revision");
  }
  let authorizedOutput: string | undefined;
  const authorizeOutput = async (outputRevision: string): Promise<void> => {
    if (authorizedOutput !== undefined && authorizedOutput !== outputRevision) {
      throw new Error("synchronization attempted to authorize contradictory output Revisions");
    }
    authorizedOutput = outputRevision;
    const ready: ControlEnvelope = {
      ...intent,
      transitionId: `${selected.transition.transitionId}:ready`,
      outputRevision,
      disposition: "ready",
    };
    await ports.recordControlComment({
      prNumber,
      envelope: ready,
      narrative: `Synchronization output Revision ${outputRevision} is ready to publish.`,
      idempotencyKey: `${ready.transitionId}:record-control-comment`,
    });
  };
  const currentSnapshotPr = reconstructed.snapshot.pullRequests.find((pr) => pr.number === prNumber);
  if (currentSnapshotPr?.headBranch === undefined) {
    throw new Error("synchronization requires the Managed PR head branch");
  }
  const attempted = await ports.synchronize({
    prNumber,
    headBranch: currentSnapshotPr.headBranch,
    expectedHeadRevision: inputRevision,
    targetRevision,
    authorizeOutput,
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
      authorizeOutput,
    });
    if (resolved.status !== "succeeded" || resolved.outputRevision === undefined) {
      const reason = "bounded conflict resolution did not produce a new Revision";
      const needsHumanEnvelope: ControlEnvelope = {
        schemaVersion: 1,
        kind: "needs-human",
        repository: request.repository,
        ticketNumber: request.ticketNumber,
        prNumber,
        round: selected.transition.round,
        transitionId: `${selected.transition.transitionId}:conflict:needs-human`,
        inputRevision,
        disposition: "recorded",
        workflowRunId: request.workflowRun.id,
        workflowRunAttempt: request.workflowRun.attempt,
      };
      const recorded = await ports.recordNeedsHuman({
        ticketNumber: request.ticketNumber,
        prNumber,
        reason,
        evidenceLinks: [evidenceLink(request, prNumber)],
        envelope: needsHumanEnvelope,
        idempotencyKey: `${needsHumanEnvelope.transitionId}:record-needs-human`,
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
  if (authorizedOutput !== synchronization.outputRevision) {
    throw new Error("synchronization output was not durably authorized before publication");
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
