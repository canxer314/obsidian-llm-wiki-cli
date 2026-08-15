export interface ManagedControlEnvelope {
  schemaVersion: 1;
  kind: "managed-pr";
  repository: string;
  ticketNumber: number;
  prNumber: number;
  targetBranch?: string;
  round: 0;
  transitionId: string;
  inputRevision: string;
  outputRevision: string;
  disposition: "succeeded" | "adopted";
  workflowRunId: string;
}

export interface ManagedPullRequestRecord {
  number: number;
  headRevision: string;
  headBranch: string;
  baseBranch: string;
  body: string;
  comments: Array<{
    author: { login: string; type: "Bot" | "App" | "User" };
    body: string;
  }>;
}

export interface ManagedImplementationPorts {
  findRemoteBranchRevision(branch: string): Promise<string | undefined>;
  ensureRemoteBranch(branch: string, exactRevision: string): Promise<void>;
  findOpenPullRequests(
    ticketNumber: number,
    branch: string,
    targetBranch: string,
  ): Promise<ManagedPullRequestRecord[]>;
  createPullRequest(input: {
    title: string;
    body: string;
    headBranch: string;
    baseBranch: string;
  }): Promise<ManagedPullRequestRecord>;
  postComment(prNumber: number, body: string): Promise<void>;
}

export interface ManagedImplementationRequest {
  repository: string;
  ticket: { number: number; title: string };
  targetBranch: string;
  branch: string;
  outputRevision: string;
  transitionId: string;
  workflowRunId: string;
  trustedActor: { login: string; type: "Bot" | "App" };
  narrative: string;
}

const MARKER_PREFIX = "afk-managed-pr:";
const ENVELOPE_PREFIX = "<!-- afk-control-envelope\n";
const ENVELOPE_SUFFIX = "\n-->";

function pullRequestMarker(ticketNumber: number, transitionId: string): string {
  return `<!-- ${MARKER_PREFIX}${ticketNumber}:${transitionId} -->`;
}

function pullRequestBody(request: ManagedImplementationRequest): string {
  return [
    `Closes #${request.ticket.number}`,
    "",
    "Implemented autonomously from the linked Delivery Ticket.",
    "",
    pullRequestMarker(request.ticket.number, request.transitionId),
  ].join("\n");
}

export function envelopeComment(envelope: ManagedControlEnvelope, narrative: string): string {
  return [
    ENVELOPE_PREFIX + JSON.stringify(envelope) + ENVELOPE_SUFFIX,
    "",
    narrative,
  ].join("\n");
}

export function extractControlEnvelope(body: string): unknown | undefined {
  const start = body.indexOf(ENVELOPE_PREFIX);
  if (start < 0) return undefined;
  const jsonStart = start + ENVELOPE_PREFIX.length;
  const end = body.indexOf(ENVELOPE_SUFFIX, jsonStart);
  if (end < 0) return undefined;
  try {
    return JSON.parse(body.slice(jsonStart, end)) as unknown;
  } catch {
    return undefined;
  }
}

export function parseManagedControlEnvelope(body: string): ManagedControlEnvelope | undefined {
  try {
    const value = extractControlEnvelope(body);
    if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
    const record = value as Record<string, unknown>;
    const allowedKeys = new Set([
      "schemaVersion", "kind", "repository", "ticketNumber", "prNumber", "targetBranch", "round",
      "transitionId", "inputRevision", "outputRevision", "disposition", "workflowRunId",
    ]);
    if (Object.keys(record).some((key) => !allowedKeys.has(key))) return undefined;
    if (
      record.schemaVersion !== 1 || record.kind !== "managed-pr" || record.round !== 0 ||
      (record.disposition !== "succeeded" && record.disposition !== "adopted") ||
      (record.targetBranch !== undefined && typeof record.targetBranch !== "string") ||
      !Number.isInteger(record.ticketNumber) ||
      !Number.isInteger(record.prNumber) || typeof record.repository !== "string" ||
      typeof record.transitionId !== "string" || typeof record.workflowRunId !== "string" ||
      typeof record.inputRevision !== "string" || typeof record.outputRevision !== "string" ||
      !/^[0-9a-f]{40}$/u.test(record.inputRevision) ||
      !/^[0-9a-f]{40}$/u.test(record.outputRevision)
    ) return undefined;
    return value as ManagedControlEnvelope;
  } catch {
    return undefined;
  }
}

export function recognizeManagedPullRequest(
  pr: ManagedPullRequestRecord,
  policy: {
    repository: string;
    ticketNumber: number;
    targetBranch?: string;
    trustedActors: Array<{ login: string; type: "Bot" | "App" }>;
  },
): { managed: true; ticketNumber: number; initialRevision: string } | { managed: false } {
  for (const comment of pr.comments) {
    const trusted = policy.trustedActors.some(
      (actor) => actor.login === comment.author.login && actor.type === comment.author.type,
    );
    if (!trusted) continue;
    const envelope = parseManagedControlEnvelope(comment.body);
    if (
      envelope?.repository === policy.repository &&
      envelope.ticketNumber === policy.ticketNumber &&
      envelope.prNumber === pr.number &&
      (policy.targetBranch === undefined ||
        (pr.baseBranch === policy.targetBranch &&
          (envelope.disposition !== "adopted" || envelope.targetBranch === policy.targetBranch))) &&
      envelope.inputRevision === envelope.outputRevision &&
      pr.body.includes(`Closes #${policy.ticketNumber}`) &&
      (envelope.disposition === "adopted" ||
        pr.body.includes(pullRequestMarker(policy.ticketNumber, envelope.transitionId)))
    ) {
      return { managed: true, ticketNumber: policy.ticketNumber, initialRevision: envelope.outputRevision };
    }
  }
  return { managed: false };
}

export interface ManagedPullRequestAdoptionRequest {
  repository: string;
  ticketNumber: number;
  prNumber: number;
  targetBranch: string;
  currentRevision: string;
  transitionId: string;
  workflowRunId: string;
  trustedActor: { login: string; type: "Bot" | "App" };
  narrative: string;
}

export async function adoptManagedPullRequest(
  request: ManagedPullRequestAdoptionRequest,
  ports: ManagedImplementationPorts,
): Promise<{
  prNumber: number;
  currentRevision: string;
  managementRecordCreated: boolean;
}> {
  const candidates = await ports.findOpenPullRequests(
    request.ticketNumber,
    "",
    request.targetBranch,
  );
  const pr = candidates.find((candidate) => candidate.number === request.prNumber);
  if (
    candidates.length !== 1 ||
    pr === undefined ||
    pr.baseBranch !== request.targetBranch ||
    pr.headRevision !== request.currentRevision
  ) {
    throw new Error("adoption requires one eligible PR at the exact current Revision and target branch");
  }

  const existing = pr.comments.some((comment) => {
    if (comment.author.login !== request.trustedActor.login ||
        comment.author.type !== request.trustedActor.type) return false;
    const envelope = parseManagedControlEnvelope(comment.body);
    return envelope?.disposition === "adopted" &&
      envelope.repository === request.repository &&
      envelope.ticketNumber === request.ticketNumber &&
      envelope.prNumber === request.prNumber &&
      envelope.targetBranch === request.targetBranch &&
      envelope.inputRevision === request.currentRevision &&
      envelope.outputRevision === request.currentRevision &&
      envelope.transitionId === request.transitionId;
  });
  if (!existing) {
    const envelope: ManagedControlEnvelope = {
      schemaVersion: 1,
      kind: "managed-pr",
      repository: request.repository,
      ticketNumber: request.ticketNumber,
      prNumber: request.prNumber,
      targetBranch: request.targetBranch,
      round: 0,
      transitionId: request.transitionId,
      inputRevision: request.currentRevision,
      outputRevision: request.currentRevision,
      disposition: "adopted",
      workflowRunId: request.workflowRunId,
    };
    await ports.postComment(pr.number, envelopeComment(envelope, request.narrative));
    const refreshed = await ports.findOpenPullRequests(request.ticketNumber, "", request.targetBranch);
    const authenticated = refreshed.length === 1 && refreshed[0]?.number === request.prNumber &&
      refreshed[0].headRevision === request.currentRevision &&
      recognizeManagedPullRequest(refreshed[0], {
        repository: request.repository,
        ticketNumber: request.ticketNumber,
        targetBranch: request.targetBranch,
        trustedActors: [request.trustedActor],
      }).managed;
    if (!authenticated) {
      throw new Error("published adoption record could not be authenticated from GitHub");
    }
  }
  return {
    prNumber: pr.number,
    currentRevision: request.currentRevision,
    managementRecordCreated: !existing,
  };
}

export async function publishManagedImplementation(
  request: ManagedImplementationRequest,
  ports: ManagedImplementationPorts,
): Promise<{
  prNumber: number;
  outputRevision: string;
  created: boolean;
  managementRecordCreated: boolean;
}> {
  await ports.ensureRemoteBranch(request.branch, request.outputRevision);
  const existing = await ports.findOpenPullRequests(
    request.ticket.number,
    request.branch,
    request.targetBranch,
  );
  if (existing.length > 1) {
    throw new Error("multiple open Implementation PRs match the deterministic identity");
  }
  let pr = existing[0];
  const created = pr === undefined;
  if (pr === undefined) {
    pr = await ports.createPullRequest({
      title: request.ticket.title,
      body: pullRequestBody(request),
      headBranch: request.branch,
      baseBranch: request.targetBranch,
    });
  }
  if (
    pr.headRevision !== request.outputRevision ||
    pr.headBranch !== request.branch ||
    pr.baseBranch !== request.targetBranch
  ) {
    throw new Error("Implementation PR does not match the exact published Revision");
  }

  const envelope: ManagedControlEnvelope = {
    schemaVersion: 1,
    kind: "managed-pr",
    repository: request.repository,
    ticketNumber: request.ticket.number,
    prNumber: pr.number,
    round: 0,
    transitionId: request.transitionId,
    inputRevision: request.outputRevision,
    outputRevision: request.outputRevision,
    disposition: "succeeded",
    workflowRunId: request.workflowRunId,
  };
  const managementRecordCreated = !pr.comments.some((comment) => {
    if (comment.author.login !== request.trustedActor.login ||
        comment.author.type !== request.trustedActor.type) return false;
    const current = parseManagedControlEnvelope(comment.body);
    return current?.transitionId === request.transitionId &&
      current.kind === "managed-pr" && current.prNumber === pr.number;
  });
  if (managementRecordCreated) {
    await ports.postComment(pr.number, envelopeComment(envelope, request.narrative));
  }
  return {
    prNumber: pr.number,
    outputRevision: request.outputRevision,
    created,
    managementRecordCreated,
  };
}
