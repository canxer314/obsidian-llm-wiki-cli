import { createHash } from "node:crypto";

export type Revision = string;
export type ActorType = "Bot" | "App" | "User";

export interface TrustedActor {
  login: string;
  type: "Bot" | "App";
}

export interface RepositoryPolicy {
  schemaVersion: 1;
  targetBranch: string;
  readyLabel: string;
  prohibitedLabel: string;
  needsHumanLabel: string;
  trustedActors: TrustedActor[];
  maximumRepairRounds: number;
  requiredValidationCommands: string[];
  reviewSkill: {
    path: string;
    revision: string;
  };
  mergeStrategy: "merge" | "squash" | "rebase";
}

export interface DeliveryTicketSnapshot {
  number: number;
  open: boolean;
  labels: string[];
  openBlockerNumbers: number[];
  dependencyDataComplete: boolean;
  body?: string;
  additionalValidationCommands?: string[];
}

export interface ImplementationPullRequestSnapshot {
  number: number;
  ticketNumber: number;
  open: boolean;
  targetBranch: string;
  headBranch?: string;
  headRevision: Revision;
  baseRevision: Revision;
  mergeable: boolean | "unknown";
  requiredChecksPass: boolean;
  managed: boolean;
  body?: string;
  diff?: string;
}

export type ControlKind =
  | "managed-pr"
  | "synchronization"
  | "validation"
  | "review-handoff"
  | "repair-handoff"
  | "merge-report"
  | "needs-human";

export interface ControlEnvelope {
  schemaVersion: 1;
  kind: ControlKind;
  repository: string;
  ticketNumber: number;
  prNumber: number;
  targetBranch?: string;
  targetRevision?: Revision;
  round: number;
  transitionId: string;
  inputRevision: Revision;
  outputRevision?: Revision;
  disposition: string;
  workflowRunId: string;
  workflowRunAttempt?: number;
  baseRevision?: Revision;
  commands?: ValidationCommandResult[];
}

export interface AuthenticatedControlComment {
  commentId: string;
  author: { login: string; type: ActorType };
  envelope: unknown;
  narrative: string;
}

export interface RepositoryDocument {
  path: string;
  content: string;
}

export interface ReviewerCapabilities {
  sourceReadOnly: boolean;
  canEdit: boolean;
  canCommit: boolean;
  canPush: boolean;
  canComment: boolean;
  githubCredentials: boolean;
}

export interface ReviewRequest {
  ticket: DeliveryTicketSnapshot & { body: string };
  round: number;
  repositoryInstructions: string;
  domainDocuments: RepositoryDocument[];
  architectureDecisions: RepositoryDocument[];
  baseRevision: Revision;
  headRevision: Revision;
  diff: string;
  skill: RepositoryPolicy["reviewSkill"];
  capabilities: ReviewerCapabilities;
}

export interface AuthenticatedGitHubSnapshot {
  repository: string;
  repositoryInstructions?: string;
  domainDocuments?: RepositoryDocument[];
  architectureDecisions?: RepositoryDocument[];
  targetBranchRevision?: Revision;
  ticket: DeliveryTicketSnapshot;
  pullRequests: ImplementationPullRequestSnapshot[];
  controlComments: AuthenticatedControlComment[];
  completedEffectKeys?: string[];
}

export type DeliveryLeaseResult =
  | { status: "acquired"; leaseId: string }
  | { status: "not-acquired"; reason: string };

export interface WorkflowRunIdentity {
  id: string;
  attempt: number;
}

export interface ValidationCommandResult {
  command: string;
  exitCode: number | null;
  checkId: string;
  timedOut: boolean;
}

export interface ValidationRequest {
  revision: Revision;
  round: number;
  workflowRun: WorkflowRunIdentity;
  checks: Array<{
    command: string;
    source: "repository-policy" | "delivery-ticket";
  }>;
}

export type StageOutcome =
  | {
      kind: "implementation";
      status: "succeeded";
      prNumber: number;
      outputRevision: Revision;
      narrative: string;
    }
  | {
      kind: "synchronization";
      status: "succeeded";
      inputRevision: Revision;
      outputRevision: Revision;
      narrative: string;
    }
  | {
      kind: "validation";
      status: "succeeded" | "failed";
      failureKind?: "code-validation" | "infrastructure";
      revision: Revision;
      round: number;
      commands: ValidationCommandResult[];
    }
  | {
      kind: "review";
      status: "succeeded" | "failed";
      revision: Revision;
      baseRevision: Revision;
      round: number;
      disposition: "approved" | "changes-required" | "unable-to-review";
      narrative: string;
      capabilities: ReviewerCapabilities;
    }
  | {
      kind: "repair";
      status: "succeeded" | "failed";
      inputRevision: Revision;
      outputRevision: Revision;
      round: number;
      narrative: string;
      findingsComplete: boolean;
    }
  | {
      kind: "merge-preparation";
      status: "succeeded" | "failed";
      revision: Revision;
      narrative: string;
    };

export interface DeliveryTransitionInput {
  snapshot: AuthenticatedGitHubSnapshot;
  lease: DeliveryLeaseResult;
  policy: RepositoryPolicy;
  workflowRun: WorkflowRunIdentity;
  stageOutcome?: StageOutcome;
}

export type DeliveryTransitionKind =
  | "no-transition"
  | "wait-for-open-blockers"
  | "needs-human"
  | "implement"
  | "record-implementation"
  | "continue-pr"
  | "synchronize"
  | "record-synchronization"
  | "validate"
  | "record-validation"
  | "review"
  | "record-review-handoff"
  | "repair"
  | "record-repair-handoff"
  | "prepare-merge"
  | "record-merge-report"
  | "merge";

export interface DeliveryTransition {
  kind: DeliveryTransitionKind;
  transitionId: string;
  ticketNumber: number;
  prNumber?: number;
  round: number;
  inputRevision?: Revision;
  outputRevision?: Revision;
  reason?: string;
}

export type ModeledEffectKind =
  | "create-implementation-pr"
  | "record-managed-pr"
  | "continue-pr"
  | "synchronize-pr"
  | "record-control-comment"
  | "run-validation"
  | "run-review"
  | "run-repair"
  | "record-merge-report"
  | "merge-exact-revision"
  | "record-needs-human";

export interface ModeledEffect {
  kind: ModeledEffectKind;
  idempotencyKey: string;
  transitionId: string;
  envelope?: ControlEnvelope;
  narrative?: string;
  exactRevision?: Revision;
  validationRequest?: ValidationRequest;
  reviewRequest?: ReviewRequest;
}

export interface DeliveryTransitionResult {
  transition: DeliveryTransition;
  effects: ModeledEffect[];
}

interface TrustedHistory {
  records: ControlEnvelope[];
  invalidReason?: string;
}

const REVISION_PATTERN = /^[0-9a-f]{40}$/u;
const CONTROL_KINDS = new Set<ControlKind>([
  "managed-pr",
  "synchronization",
  "validation",
  "review-handoff",
  "repair-handoff",
  "merge-report",
  "needs-human",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseControlEnvelope(value: unknown): ControlEnvelope | undefined {
  if (!isRecord(value)) return undefined;
  const allowedKeys = new Set([
    "schemaVersion", "kind", "repository", "ticketNumber", "prNumber", "targetBranch", "targetRevision", "round",
    "transitionId", "inputRevision", "outputRevision", "disposition", "workflowRunId",
    "workflowRunAttempt", "baseRevision", "commands",
  ]);
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) return undefined;
  const requiredStrings = [
    "kind",
    "repository",
    "transitionId",
    "inputRevision",
    "disposition",
    "workflowRunId",
  ] as const;
  if (
    value.schemaVersion !== 1 ||
    !requiredStrings.every((key) => typeof value[key] === "string") ||
    !CONTROL_KINDS.has(value.kind as ControlKind) ||
    !Number.isInteger(value.ticketNumber) ||
    !Number.isInteger(value.prNumber) ||
    !Number.isInteger(value.round) ||
    (value.targetBranch !== undefined && typeof value.targetBranch !== "string") ||
    (value.targetRevision !== undefined &&
      (typeof value.targetRevision !== "string" || !REVISION_PATTERN.test(value.targetRevision))) ||
    (value.round as number) < 0 ||
    (value.workflowRunAttempt !== undefined && (
      !Number.isInteger(value.workflowRunAttempt) ||
      (value.workflowRunAttempt as number) < 1
    )) ||
    ((value.kind === "validation" || value.kind === "review-handoff") &&
      value.workflowRunAttempt === undefined) ||
    !REVISION_PATTERN.test(value.inputRevision as string) ||
    (value.baseRevision !== undefined &&
      (typeof value.baseRevision !== "string" || !REVISION_PATTERN.test(value.baseRevision))) ||
    (value.outputRevision !== undefined &&
      (typeof value.outputRevision !== "string" || !REVISION_PATTERN.test(value.outputRevision)))
  ) {
    return undefined;
  }
  if (value.commands !== undefined) {
    if (
      !Array.isArray(value.commands) ||
      !value.commands.every(
        (command) =>
          isRecord(command) &&
          typeof command.command === "string" &&
          (Number.isInteger(command.exitCode) || command.exitCode === null) &&
          typeof command.checkId === "string" &&
          typeof command.timedOut === "boolean",
      )
    ) {
      return undefined;
    }
  }
  return value as unknown as ControlEnvelope;
}

function actorIsTrusted(
  actor: AuthenticatedControlComment["author"],
  policy: RepositoryPolicy,
): boolean {
  return policy.trustedActors.some(
    (trusted) => trusted.login === actor.login && trusted.type === actor.type,
  );
}

function authenticateHistory(
  snapshot: AuthenticatedGitHubSnapshot,
  policy: RepositoryPolicy,
  pr: ImplementationPullRequestSnapshot | undefined,
  predecessorRevision?: Revision,
): TrustedHistory {
  const records: ControlEnvelope[] = [];
  const identities = new Map<string, string>();
  const parsed: Array<{ commentId: string; envelope: ControlEnvelope; narrative: string }> = [];
  for (const comment of snapshot.controlComments) {
    if (!actorIsTrusted(comment.author, policy)) continue;
    const envelope = parseControlEnvelope(comment.envelope);
    if (envelope === undefined) {
      return { records, invalidReason: `trusted control comment ${comment.commentId} has a malformed or unsupported envelope` };
    }
    if (envelope.kind === "review-handoff" && (
      envelope.baseRevision !== pr?.baseRevision ||
      !["approved", "changes-required", "unable-to-review"].includes(envelope.disposition) ||
      !reviewNarrativeMatchesDisposition(
        comment.narrative,
        envelope.disposition as "approved" | "changes-required" | "unable-to-review",
      )
    )) {
      return { records, invalidReason: `trusted review handoff ${comment.commentId} contradicts its Control Envelope or current base Revision` };
    }
    parsed.push({ commentId: comment.commentId, envelope, narrative: comment.narrative });
  }

  const connectedRevisions = new Set<Revision>([pr?.headRevision, predecessorRevision].filter(
    (revision): revision is Revision => revision !== undefined,
  ));
  for (const { envelope } of parsed) {
    if (
      envelope.kind === "managed-pr" &&
      (envelope.outputRevision === undefined || envelope.inputRevision === envelope.outputRevision)
    ) {
      connectedRevisions.add(envelope.inputRevision);
    }
  }
  let expanded = true;
  while (expanded) {
    expanded = false;
    for (const { envelope } of parsed) {
      if (
        (envelope.kind === "repair-handoff" || envelope.kind === "synchronization") &&
        envelope.outputRevision !== undefined &&
        connectedRevisions.has(envelope.outputRevision) &&
        !connectedRevisions.has(envelope.inputRevision)
      ) {
        connectedRevisions.add(envelope.inputRevision);
        expanded = true;
      }
    }
  }

  for (const { commentId, envelope } of parsed) {
    if (
      envelope.repository !== snapshot.repository ||
      envelope.ticketNumber !== snapshot.ticket.number ||
      pr === undefined ||
      envelope.prNumber !== pr.number ||
      (envelope.kind === "managed-pr" && envelope.disposition === "adopted" &&
        (envelope.targetBranch !== policy.targetBranch || pr.targetBranch !== envelope.targetBranch))
    ) {
      return { records, invalidReason: `trusted control comment ${commentId} does not match the GitHub snapshot` };
    }
    const applicableRevision = envelope.outputRevision ?? envelope.inputRevision;
    if (!connectedRevisions.has(applicableRevision)) {
      return { records, invalidReason: `trusted control comment ${commentId} is not part of the authenticated Revision chain` };
    }
    if (
      (envelope.kind === "repair-handoff" || envelope.kind === "synchronization") &&
      envelope.outputRevision === undefined &&
      !(envelope.kind === "synchronization" && envelope.disposition === "started" &&
        envelope.targetRevision !== undefined)
    ) {
      return { records, invalidReason: `trusted control comment ${commentId} is missing its output Revision` };
    }
    const canonical = JSON.stringify(envelope);
    const previous = identities.get(envelope.transitionId);
    if (previous !== undefined && previous !== canonical) {
      return { records, invalidReason: `transition ${envelope.transitionId} has contradictory trusted records` };
    }
    identities.set(envelope.transitionId, canonical);
    records.push(envelope);
  }
  return { records };
}

function stableTransitionId(parts: Array<string | number | undefined>): string {
  const digest = createHash("sha256")
    .update(parts.map((part) => part ?? "-").join(""))
    .digest("hex")
    .slice(0, 24);
  return `afk-v1-${digest}`;
}

function transition(
  input: DeliveryTransitionInput,
  kind: DeliveryTransitionKind,
  options: {
    pr?: ImplementationPullRequestSnapshot;
    round?: number;
    inputRevision?: Revision;
    outputRevision?: Revision;
    reason?: string;
  } = {},
): DeliveryTransition {
  const round = options.round ?? 0;
  const transitionId = stableTransitionId([
    input.snapshot.repository,
    input.snapshot.ticket.number,
    options.pr?.number,
    kind,
    round,
    options.inputRevision,
    options.outputRevision,
  ]);
  return {
    kind,
    transitionId,
    ticketNumber: input.snapshot.ticket.number,
    ...(options.pr === undefined ? {} : { prNumber: options.pr.number }),
    round,
    ...(options.inputRevision === undefined ? {} : { inputRevision: options.inputRevision }),
    ...(options.outputRevision === undefined ? {} : { outputRevision: options.outputRevision }),
    ...(options.reason === undefined ? {} : { reason: options.reason }),
  };
}

function result(
  input: DeliveryTransitionInput,
  selected: DeliveryTransition,
  effects: Omit<ModeledEffect, "idempotencyKey" | "transitionId">[],
): DeliveryTransitionResult {
  const completed = new Set(input.snapshot.completedEffectKeys ?? []);
  return {
    transition: selected,
    effects: effects
      .map((effect, index) => ({
        ...effect,
        transitionId: selected.transitionId,
        idempotencyKey: `${selected.transitionId}:${index}:${effect.kind}`,
      }))
      .filter((effect) => !completed.has(effect.idempotencyKey)),
  };
}

function needsHuman(
  input: DeliveryTransitionInput,
  reason: string,
  pr?: ImplementationPullRequestSnapshot,
): DeliveryTransitionResult {
  const selected = transition(input, "needs-human", {
    ...(pr === undefined ? {} : { pr }),
    ...(pr === undefined ? {} : { inputRevision: pr.headRevision }),
    reason,
  });
  const effect = pr === undefined
    ? { kind: "record-needs-human" as const }
    : {
        kind: "record-needs-human" as const,
        envelope: controlEnvelope(input, selected, "needs-human", "recorded"),
        narrative: reason,
      };
  return result(input, selected, [effect]);
}

function controlEnvelope(
  input: DeliveryTransitionInput,
  selected: DeliveryTransition,
  kind: ControlKind,
  disposition: string,
  commands?: ValidationCommandResult[],
  baseRevision?: Revision,
): ControlEnvelope {
  if (selected.prNumber === undefined || selected.inputRevision === undefined) {
    throw new Error("control records require a PR and input Revision");
  }
  return {
    schemaVersion: 1,
    kind,
    repository: input.snapshot.repository,
    ticketNumber: input.snapshot.ticket.number,
    prNumber: selected.prNumber,
    round: selected.round,
    transitionId: selected.transitionId,
    inputRevision: selected.inputRevision,
    ...(selected.outputRevision === undefined ? {} : { outputRevision: selected.outputRevision }),
    disposition,
    workflowRunId: input.workflowRun.id,
    workflowRunAttempt: input.workflowRun.attempt,
    ...(baseRevision === undefined ? {} : { baseRevision }),
    ...(commands === undefined ? {} : { commands }),
  };
}

function requiredValidationPassed(
  record: ControlEnvelope | undefined,
  policy: RepositoryPolicy,
  ticket?: DeliveryTicketSnapshot,
): boolean {
  if (record?.kind !== "validation" || record.disposition !== "succeeded") return false;
  const commands = record.commands ?? [];
  if (new Set(commands.map((command) => command.checkId)).size !== commands.length) return false;
  const requiredCommands = [
    ...policy.requiredValidationCommands,
    ...(ticket?.additionalValidationCommands ?? []),
  ];
  return requiredCommands.every((required) => {
    const matches = commands.filter((command) => command.command === required);
    return matches.length === 1 && matches[0]?.exitCode === 0 && matches[0].timedOut === false;
  });
}

function validationPolicyIsUnambiguous(
  policy: RepositoryPolicy,
  ticket: DeliveryTicketSnapshot,
): boolean {
  const baseline = policy.requiredValidationCommands;
  const additional = ticket.additionalValidationCommands ?? [];
  return baseline.length > 0 &&
    baseline.every((command) => command.trim().length > 0) &&
    additional.every((command) => command.trim().length > 0) &&
    new Set(baseline).size === baseline.length &&
    new Set(additional).size === additional.length &&
    additional.every((command) => !baseline.includes(command));
}

function validationRequest(
  input: DeliveryTransitionInput,
  revision: Revision,
  round: number,
): ValidationRequest {
  return {
    revision,
    round,
    workflowRun: input.workflowRun,
    checks: [
      ...input.policy.requiredValidationCommands.map((command) => ({
        command,
        source: "repository-policy" as const,
      })),
      ...(input.snapshot.ticket.additionalValidationCommands ?? []).map((command) => ({
        command,
        source: "delivery-ticket" as const,
      })),
    ],
  };
}

const REVIEWER_CAPABILITIES: ReviewerCapabilities = {
  sourceReadOnly: true,
  canEdit: false,
  canCommit: false,
  canPush: false,
  canComment: false,
  githubCredentials: false,
};

function reviewerIsIsolated(capabilities: ReviewerCapabilities): boolean {
  return capabilities.sourceReadOnly &&
    !capabilities.canEdit &&
    !capabilities.canCommit &&
    !capabilities.canPush &&
    !capabilities.canComment &&
    !capabilities.githubCredentials;
}

function reviewNarrativeMatchesDisposition(
  narrative: string,
  disposition: "approved" | "changes-required" | "unable-to-review",
): boolean {
  const headingPattern = /^## (Verdict|Standards|Spec|Interactions|Constraints)\s*$/gmu;
  const matches = [...narrative.matchAll(headingPattern)];
  const expectedHeadings = ["Verdict", "Standards", "Spec", "Interactions", "Constraints"];
  if (
    matches.length !== expectedHeadings.length ||
    matches.some((match, index) => match[1] !== expectedHeadings[index])
  ) return false;

  const sections = matches.map((match, index) => {
    const start = (match.index ?? 0) + match[0].length;
    const end = matches[index + 1]?.index ?? narrative.length;
    return narrative.slice(start, end).trim();
  });
  return sections.every((section) => section.length > 0) && sections[0] === disposition;
}

function buildReviewRequest(
  input: DeliveryTransitionInput,
  pr: ImplementationPullRequestSnapshot,
  round: number,
): ReviewRequest | undefined {
  const { snapshot, policy } = input;
  if (
    snapshot.ticket.body === undefined || snapshot.ticket.body.trim().length === 0 ||
    snapshot.repositoryInstructions === undefined || snapshot.repositoryInstructions.trim().length === 0 ||
    snapshot.domainDocuments === undefined || snapshot.domainDocuments.length === 0 ||
    snapshot.domainDocuments.some((document) =>
      document.path.trim().length === 0 || document.content.trim().length === 0
    ) ||
    snapshot.architectureDecisions === undefined || snapshot.architectureDecisions.length === 0 ||
    snapshot.architectureDecisions.some((document) =>
      document.path.trim().length === 0 || document.content.trim().length === 0
    ) ||
    pr.diff === undefined || pr.diff.trim().length === 0 ||
    policy.reviewSkill.path.trim().length === 0 || policy.reviewSkill.revision.trim().length === 0
  ) return undefined;
  return {
    ticket: { ...snapshot.ticket, body: snapshot.ticket.body },
    round,
    repositoryInstructions: snapshot.repositoryInstructions,
    domainDocuments: snapshot.domainDocuments,
    architectureDecisions: snapshot.architectureDecisions,
    baseRevision: pr.baseRevision,
    headRevision: pr.headRevision,
    diff: pr.diff,
    skill: policy.reviewSkill,
    capabilities: REVIEWER_CAPABILITIES,
  };
}

function latest(records: ControlEnvelope[], kind: ControlKind): ControlEnvelope | undefined {
  return records.filter((record) => record.kind === kind).at(-1);
}

function processStageOutcome(
  input: DeliveryTransitionInput,
  pr: ImplementationPullRequestSnapshot | undefined,
  records: ControlEnvelope[],
): DeliveryTransitionResult | undefined {
  const stage = input.stageOutcome;
  if (stage === undefined) return undefined;
  if (stage.status !== "succeeded" && stage.kind !== "validation") {
    return needsHuman(input, `${stage.kind} stage did not succeed`, pr);
  }

  if (stage.kind === "implementation") {
    if (pr === undefined || stage.prNumber !== pr.number || stage.outputRevision !== pr.headRevision) {
      return needsHuman(input, "implementation outcome does not match the current GitHub PR");
    }
    const selected = transition(input, "record-implementation", {
      pr,
      inputRevision: pr.headRevision,
      outputRevision: pr.headRevision,
    });
    const envelope = controlEnvelope(input, selected, "managed-pr", "succeeded");
    return result(input, selected, [{
      kind: "record-managed-pr",
      envelope,
      narrative: redactHandoffNarrative(stage.narrative),
    }]);
  }
  if (pr === undefined) return needsHuman(input, `${stage.kind} outcome has no matching Implementation PR`);

  if (stage.kind === "synchronization") {
    if (stage.outputRevision !== pr.headRevision || stage.inputRevision === stage.outputRevision) {
      return needsHuman(input, "synchronization outcome is not bound to the current changed Revision", pr);
    }
    const selected = transition(input, "record-synchronization", {
      pr, inputRevision: stage.inputRevision, outputRevision: stage.outputRevision,
    });
    return result(input, selected, [{
      kind: "record-control-comment",
      envelope: controlEnvelope(input, selected, "synchronization", "succeeded"),
      narrative: redactHandoffNarrative(stage.narrative),
    }]);
  }
  if (stage.kind === "validation") {
    const currentRepair = latest(records.filter((record) =>
      record.outputRevision === pr.headRevision
    ), "repair-handoff");
    const expectedRound = currentRepair === undefined ? 1 : currentRepair.round + 1;
    if (stage.revision !== pr.headRevision || stage.round !== expectedRound) {
      return needsHuman(input, "validation is stale or bound to the wrong review round", pr);
    }
    const validationDisposition = stage.status === "failed"
      ? stage.failureKind === "infrastructure"
        ? "infrastructure-failed"
        : stage.failureKind === "code-validation"
          ? "code-validation-failed"
          : undefined
      : "succeeded";
    if (validationDisposition === undefined) {
      return needsHuman(input, "failed validation has no unambiguous failure classification", pr);
    }
    if (stage.status === "succeeded") {
      const complete = requiredValidationPassed({
        schemaVersion: 1, kind: "validation", repository: input.snapshot.repository,
        ticketNumber: input.snapshot.ticket.number, prNumber: pr.number, round: 0,
        transitionId: "pending", inputRevision: stage.revision, disposition: "succeeded",
        workflowRunId: input.workflowRun.id, workflowRunAttempt: input.workflowRun.attempt,
        commands: stage.commands,
      }, input.policy, input.snapshot.ticket);
      if (!complete) {
        return needsHuman(input, "validation failed or is missing required commands", pr);
      }
    }
    const selected = transition(input, "record-validation", {
      pr,
      round: stage.round,
      inputRevision: pr.headRevision,
    });
    return result(input, selected, [{
      kind: "record-control-comment",
      envelope: controlEnvelope(input, selected, "validation", validationDisposition, stage.commands),
    }]);
  }
  if (stage.kind === "review") {
    const currentValidation = latest(records.filter((record) =>
      record.inputRevision === pr.headRevision
    ), "validation");
    const expectedRound = currentValidation?.round;
    if (
      stage.revision !== pr.headRevision ||
      expectedRound === undefined ||
      stage.round !== expectedRound ||
      stage.baseRevision !== pr.baseRevision ||
      !reviewerIsIsolated(stage.capabilities) ||
      !reviewNarrativeMatchesDisposition(stage.narrative, stage.disposition)
    ) {
      return needsHuman(input, "review is stale, contradictory, incomplete, or not capability-isolated", pr);
    }
    const selected = transition(input, "record-review-handoff", {
      pr, round: stage.round, inputRevision: pr.headRevision,
    });
    return result(input, selected, [{
      kind: "record-control-comment",
      envelope: controlEnvelope(input, selected, "review-handoff", stage.disposition, undefined, stage.baseRevision),
      narrative: redactHandoffNarrative(stage.narrative),
    }]);
  }
  if (stage.kind === "repair") {
    if (!stage.findingsComplete || stage.outputRevision !== pr.headRevision || stage.inputRevision === stage.outputRevision) {
      return needsHuman(input, "repair mapping is incomplete or not bound to the current changed Revision", pr);
    }
    const selected = transition(input, "record-repair-handoff", {
      pr, round: stage.round, inputRevision: stage.inputRevision, outputRevision: stage.outputRevision,
    });
    return result(input, selected, [{
      kind: "record-control-comment",
      envelope: controlEnvelope(input, selected, "repair-handoff", "succeeded"),
      narrative: redactHandoffNarrative(stage.narrative),
    }]);
  }
  if (stage.revision !== pr.headRevision) {
    return needsHuman(input, "merge preparation is stale for the current Revision", pr);
  }
  const selected = transition(input, "record-merge-report", { pr, inputRevision: pr.headRevision });
  return result(input, selected, [{
    kind: "record-merge-report",
    envelope: controlEnvelope(input, selected, "merge-report", "ready"),
    narrative: redactHandoffNarrative(stage.narrative),
  }]);
}

export function redactHandoffNarrative(narrative: string): string {
  return narrative
    .replace(/^(Authorization\s*:\s*)(?:Bearer\s+|token\s+)?\S+\s*$/gimu, "$1[REDACTED]")
    .replace(/\b(?:gh[oprsu]_[A-Za-z0-9_]{12,}|github_pat_[A-Za-z0-9_]{12,})\b/gu, "[REDACTED]");
}

export function selectDeliveryTransition(
  input: DeliveryTransitionInput,
): DeliveryTransitionResult {
  const { snapshot, policy } = input;
  const ticket = snapshot.ticket;

  if (input.lease.status !== "acquired") {
    return result(input, transition(input, "no-transition", { reason: input.lease.reason }), []);
  }
  if (!validationPolicyIsUnambiguous(policy, ticket)) {
    return needsHuman(input, "repository and ticket validation policy is ambiguous");
  }
  if (!ticket.open || !ticket.labels.includes(policy.readyLabel)) {
    return needsHuman(input, "ticket is not open and authorized for AFK Delivery");
  }
  if (!ticket.dependencyDataComplete) {
    return needsHuman(input, "native dependency data is incomplete");
  }
  if (ticket.openBlockerNumbers.length > 0) {
    return result(input, transition(input, "wait-for-open-blockers", {
      reason: `open blockers: ${ticket.openBlockerNumbers.join(", ")}`,
    }), []);
  }
  if (ticket.labels.includes(policy.prohibitedLabel)) {
    return needsHuman(input, "AFK Delivery is prohibited by repository policy");
  }

  const candidates = snapshot.pullRequests.filter(
    (pr) => pr.open && pr.ticketNumber === ticket.number,
  );
  if (candidates.length > 1) return needsHuman(input, "multiple candidate Implementation PRs exist");
  const pr = candidates[0];
  if (pr !== undefined &&
      (!pr.managed || pr.targetBranch !== policy.targetBranch)) {
    return needsHuman(input, "the candidate PR is unmanaged or targets the wrong branch", pr);
  }

  const predecessorRevision = input.stageOutcome !== undefined &&
    (input.stageOutcome.kind === "repair" || input.stageOutcome.kind === "synchronization")
    ? input.stageOutcome.inputRevision
    : undefined;
  const history = pr === undefined
    ? { records: [] }
    : authenticateHistory(snapshot, policy, pr, predecessorRevision);
  if (history.invalidReason !== undefined) return needsHuman(input, history.invalidReason, pr);

  const stageResult = processStageOutcome(input, pr, history.records);
  if (stageResult !== undefined) return stageResult;

  if (pr === undefined) {
    const selected = transition(input, "implement");
    return result(input, selected, [{ kind: "create-implementation-pr" }]);
  }

  if (latest(history.records, "needs-human") !== undefined) {
    return result(input, transition(input, "no-transition", { pr, reason: "Needs Human is already recorded" }), []);
  }
  if (history.records.length === 0) {
    return needsHuman(input, "the Implementation PR has no authenticated management record", pr);
  }
  if (latest(history.records, "managed-pr") === undefined) {
    return needsHuman(input, "the Implementation PR is not authenticated as Managed", pr);
  }
  const unfinishedSynchronization = history.records.find((record) =>
    record.kind === "synchronization" && record.disposition === "started" &&
    !history.records.some((later) =>
      later.kind === "synchronization" && later.disposition === "ready" &&
      later.inputRevision === record.inputRevision && later.targetRevision === record.targetRevision &&
      record.transitionId.endsWith(":intent") &&
      later.transitionId === `${record.transitionId.slice(0, -":intent".length)}:ready`
    ),
  );
  if (unfinishedSynchronization !== undefined) {
    return needsHuman(input, "a synchronization attempt was interrupted before its output was authenticated", pr);
  }
  if (
    snapshot.targetBranchRevision !== undefined &&
    pr.baseRevision !== snapshot.targetBranchRevision
  ) {
    const selected = transition(input, "synchronize", { pr, inputRevision: pr.headRevision });
    return result(input, selected, [{ kind: "synchronize-pr", exactRevision: pr.headRevision }]);
  }

  const currentRevision = pr.headRevision;
  const currentRecords = history.records.filter((record) =>
    (record.outputRevision ?? record.inputRevision) === currentRevision,
  );
  const repair = latest(currentRecords, "repair-handoff");
  const validation = latest(currentRecords, "validation");
  const review = latest(currentRecords, "review-handoff");
  const mergeReport = latest(currentRecords, "merge-report");

  if (mergeReport !== undefined) {
    if (!pr.mergeable || !pr.requiredChecksPass) {
      return needsHuman(input, "merge gates changed after the Merge Report", pr);
    }
    const selected = transition(input, "merge", { pr, inputRevision: currentRevision });
    return result(input, selected, [{ kind: "merge-exact-revision", exactRevision: currentRevision }]);
  }
  if (review?.disposition === "changes-required") {
    if (review.round >= policy.maximumRepairRounds) {
      return needsHuman(input, "maximum repair rounds exhausted", pr);
    }
    const selected = transition(input, "repair", {
      pr, round: review.round, inputRevision: currentRevision,
    });
    return result(input, selected, [{ kind: "run-repair", exactRevision: currentRevision }]);
  }
  if (repair !== undefined && repair.outputRevision === currentRevision && validation === undefined) {
    const selected = transition(input, "validate", { pr, round: repair.round + 1, inputRevision: currentRevision });
    return result(input, selected, [{
      kind: "run-validation",
      exactRevision: currentRevision,
      validationRequest: validationRequest(input, currentRevision, selected.round),
    }]);
  }
  if (!requiredValidationPassed(validation, policy, ticket)) {
    const selected = transition(input, "validate", { pr, inputRevision: currentRevision });
    return result(input, selected, [{
      kind: "run-validation",
      exactRevision: currentRevision,
      validationRequest: validationRequest(input, currentRevision, selected.round),
    }]);
  }
  if (review === undefined) {
    const reviewRound = repair?.outputRevision === currentRevision ? repair.round + 1 : 1;
    const request = buildReviewRequest(input, pr, reviewRound);
    if (request === undefined) {
      return needsHuman(input, "review context is incomplete or the pinned review skill is unavailable", pr);
    }
    const selected = transition(input, "review", { pr, round: reviewRound, inputRevision: currentRevision });
    return result(input, selected, [{
      kind: "run-review",
      exactRevision: currentRevision,
      reviewRequest: request,
    }]);
  }
  if (review.disposition !== "approved") {
    return needsHuman(input, "trusted review history has no actionable disposition", pr);
  }
  if (!pr.mergeable || !pr.requiredChecksPass) {
    return needsHuman(input, "current PR does not satisfy deterministic merge gates", pr);
  }
  const selected = transition(input, "prepare-merge", {
    pr, round: review.round, inputRevision: currentRevision,
  });
  return result(input, selected, [{ kind: "record-merge-report", exactRevision: currentRevision }]);
}
