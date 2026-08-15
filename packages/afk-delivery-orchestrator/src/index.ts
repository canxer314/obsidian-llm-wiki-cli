export * from "./conflict-resolution.js";
export * from "./git-synchronization.js";
export * from "./github-publication.js";
export * from "./implementation.js";
export * from "./local-stage.js";
export * from "./managed-pr-continuation.js";
export * from "./managed-pr-recovery.js";
export * from "./managed-pr.js";
export * from "./new-implementation.js";
export * from "./sandcastle.js";
export * from "./validation-review.js";

export interface DeliveryTicketSnapshot {
  number: number;
  open: boolean;
  labels: string[];
  openBlockerNumbers: number[];
  dependencyDataComplete: boolean;
}

export type PreflightCheckName =
  | "docker"
  | "model-gateway"
  | "delivery-image"
  | "pinned-skills"
  | "github-authentication"
  | "repository-access"
  | "writable-workspace";

export interface PreflightCheck {
  name: PreflightCheckName;
  check(signal?: AbortSignal): Promise<{ ok: true } | { ok: false; reason: string }>;
}

export type WorkerPreflightResult =
  | { status: "ready"; checks: PreflightCheckName[] }
  | {
      status: "not-ready";
      failedCheck: PreflightCheckName;
      reason: string;
      checks: PreflightCheckName[];
    };

export async function runWorkerPreflight(
  configuredChecks: PreflightCheck[],
  signal?: AbortSignal,
): Promise<WorkerPreflightResult> {
  const checks: PreflightCheckName[] = [];
  for (const configured of configuredChecks) {
    checks.push(configured.name);
    try {
      const result = await configured.check(signal);
      if (!result.ok) {
        return {
          status: "not-ready",
          failedCheck: configured.name,
          reason: result.reason,
          checks,
        };
      }
    } catch (error) {
      return {
        status: "not-ready",
        failedCheck: configured.name,
        reason: error instanceof Error ? error.message : "preflight check failed",
        checks,
      };
    }
  }
  return { status: "ready", checks };
}

export interface BoundedTransitionWork {
  schemaVersion: 1;
  repository: string;
  ticket: DeliveryTicketSnapshot;
  lease: { status: "acquired"; leaseId: string };
  workflowRun: { id: string; attempt: number };
  maximumTransitions: 1;
}

export function createBoundedTransitionWork(input: {
  repository: string;
  snapshot: DeliveryTicketSnapshot;
  leaseId: string;
  workflowRun: { id: string; attempt: number };
  policy: { readyLabel: string; prohibitedLabel: string };
}): BoundedTransitionWork {
  if (!input.snapshot.open || !input.snapshot.dependencyDataComplete ||
      input.snapshot.openBlockerNumbers.length > 0 ||
      !input.snapshot.labels.includes(input.policy.readyLabel) ||
      input.snapshot.labels.includes(input.policy.prohibitedLabel)) {
    throw new Error(`Delivery Ticket #${input.snapshot.number} is not in the Delivery Frontier`);
  }
  return {
    schemaVersion: 1,
    repository: input.repository,
    ticket: input.snapshot,
    lease: { status: "acquired", leaseId: input.leaseId },
    workflowRun: input.workflowRun,
    maximumTransitions: 1,
  };
}

export interface BoundedDeliveryWorkerPorts<Snapshot> {
  preflightChecks: PreflightCheck[];
  reconstruct(signal?: AbortSignal): Promise<Snapshot>;
  dispatch(snapshot: Snapshot, signal?: AbortSignal): Promise<{ transitionId: string }>;
}

export type BoundedDeliveryWorkerResult =
  | { status: "preflight-failed"; failedCheck: PreflightCheckName; reason: string }
  | { status: "dispatched"; transitionId: string };

export async function runBoundedDeliveryWorker<Snapshot>(
  ports: BoundedDeliveryWorkerPorts<Snapshot>,
  signal?: AbortSignal,
): Promise<BoundedDeliveryWorkerResult> {
  const preflight = await runWorkerPreflight(ports.preflightChecks, signal);
  if (preflight.status === "not-ready") {
    return {
      status: "preflight-failed",
      failedCheck: preflight.failedCheck,
      reason: preflight.reason,
    };
  }
  const snapshot = await ports.reconstruct(signal);
  signal?.throwIfAborted();
  const transition = await ports.dispatch(snapshot, signal);
  return { status: "dispatched", transitionId: transition.transitionId };
}

export function deliveryLeaseGroup(
  repository: string,
  work: { ticketNumber: number; prNumber?: number },
): string {
  const normalizedRepository = repository.toLowerCase().replace(/[^a-z0-9._/-]+/gu, "-");
  return `afk-delivery-${normalizedRepository}-ticket-${work.ticketNumber}`;
}

export interface GitHubReadPort {
  request(path: string, signal?: AbortSignal): Promise<Response>;
}

export interface DiscoveryPolicy {
  owner: string;
  repository: string;
  readyLabel: string;
  prohibitedLabel: string;
}

export type ExcludedDeliveryTicket =
  | { ticketNumber: number; reason: "prohibited" }
  | { ticketNumber: number; reason: "open-blockers"; openBlockerNumbers: number[] }
  | { ticketNumber: number; reason: "dependency-data-incomplete" };

export interface DeliveryFrontier {
  frontier: DeliveryTicketSnapshot[];
  excluded: ExcludedDeliveryTicket[];
}

interface GitHubIssue {
  number: number;
  state: "open" | "closed";
  labels?: Array<string | { name: string }>;
  openBlockerCount?: number;
  pullRequest: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseIssue(value: unknown): GitHubIssue | undefined {
  if (!isRecord(value) || !Number.isInteger(value.number) ||
      (value.state !== "open" && value.state !== "closed") ||
      (value.labels !== undefined && !Array.isArray(value.labels))) {
    return undefined;
  }
  const labels: Array<string | { name: string }> = [];
  for (const label of value.labels ?? []) {
    if (typeof label === "string") labels.push(label);
    else if (isRecord(label) && typeof label.name === "string") labels.push({ name: label.name });
    else return undefined;
  }
  const summary = value.issue_dependencies_summary;
  let openBlockerCount: number | undefined;
  if (summary !== undefined) {
    if (!isRecord(summary) || !Number.isInteger(summary.blocked_by) ||
        (summary.blocked_by as number) < 0) return undefined;
    openBlockerCount = summary.blocked_by as number;
  }
  return {
    number: value.number as number,
    state: value.state,
    labels,
    ...(openBlockerCount === undefined ? {} : { openBlockerCount }),
    pullRequest: value.pull_request !== undefined,
  };
}

function labelsOf(issue: GitHubIssue): string[] {
  return (issue.labels ?? []).map((label) => typeof label === "string" ? label : label.name);
}

function hasNextPage(response: Response): boolean {
  const link = response.headers.get("link");
  if (link === null) return false;
  return link.split(",").some((part) => /;\s*rel="next"\s*$/u.test(part.trim()));
}

async function readIssuePage(
  github: GitHubReadPort,
  path: string,
  signal?: AbortSignal,
): Promise<{ issues: GitHubIssue[]; hasNext: boolean } | undefined> {
  try {
    const response = await github.request(path, signal);
    if (response.status !== 200) return undefined;
    const value: unknown = await response.json();
    if (!Array.isArray(value)) return undefined;
    const issues = value.map(parseIssue);
    if (issues.some((issue) => issue === undefined)) return undefined;
    return { issues: issues as GitHubIssue[], hasNext: hasNextPage(response) };
  } catch {
    return undefined;
  }
}

async function readAllIssues(
  github: GitHubReadPort,
  pathForPage: (page: number) => string,
  signal?: AbortSignal,
): Promise<GitHubIssue[] | undefined> {
  const all: GitHubIssue[] = [];
  const seenNumbers = new Set<number>();
  for (let page = 1; ; page += 1) {
    const result = await readIssuePage(github, pathForPage(page), signal);
    if (result === undefined) return undefined;
    for (const issue of result.issues) {
      if (seenNumbers.has(issue.number)) return undefined;
      seenNumbers.add(issue.number);
      all.push(issue);
    }
    if (!result.hasNext) return all;
  }
}

export type ReconstructedDeliveryTicket =
  | { status: "eligible"; ticket: DeliveryTicketSnapshot }
  | { status: "waiting"; ticket: DeliveryTicketSnapshot; reason: "open-blockers" }
  | { status: "needs-human"; reason: string };

export async function reconstructDeliveryTicket(
  github: GitHubReadPort,
  input: DiscoveryPolicy & { ticketNumber: number },
  signal?: AbortSignal,
): Promise<ReconstructedDeliveryTicket> {
  const root = `/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repository)}`;
  let issue: GitHubIssue | undefined;
  let body: string | undefined;
  try {
    const response = await github.request(`${root}/issues/${input.ticketNumber}`, signal);
    if (response.status !== 200) return { status: "needs-human", reason: "Delivery Ticket reconstruction failed closed" };
    const value: unknown = await response.json();
    issue = parseIssue(value);
    if (isRecord(value) && typeof value.body === "string") body = value.body;
  } catch {
    return { status: "needs-human", reason: "Delivery Ticket reconstruction failed closed" };
  }
  if (issue === undefined || issue.pullRequest || issue.number !== input.ticketNumber) {
    return { status: "needs-human", reason: "Delivery Ticket response is unverifiable" };
  }
  const labels = labelsOf(issue);
  if (issue.state !== "open" || !labels.includes(input.readyLabel)) {
    return { status: "needs-human", reason: "Delivery Ticket is not open and authorized" };
  }
  if (labels.includes(input.prohibitedLabel)) {
    return { status: "needs-human", reason: "AFK Delivery is prohibited" };
  }
  if (issue.openBlockerCount === undefined) {
    return { status: "needs-human", reason: "native dependency data is incomplete" };
  }
  const blockers = await readAllIssues(
    github,
    (page) => `${root}/issues/${input.ticketNumber}/dependencies/blocked_by?per_page=100&page=${page}`,
    signal,
  );
  if (blockers === undefined) return { status: "needs-human", reason: "native dependency data is incomplete" };
  const openBlockerNumbers = blockers.filter((blocker) => blocker.state === "open").map((blocker) => blocker.number);
  if (openBlockerNumbers.length !== issue.openBlockerCount) {
    return { status: "needs-human", reason: "native dependency data is contradictory" };
  }
  const ticket: DeliveryTicketSnapshot = {
    number: issue.number,
    open: true,
    labels,
    openBlockerNumbers,
    dependencyDataComplete: true,
    ...(body === undefined ? {} : { body }),
  };
  return openBlockerNumbers.length > 0
    ? { status: "waiting", ticket, reason: "open-blockers" }
    : { status: "eligible", ticket };
}

export async function discoverDeliveryFrontier(
  github: GitHubReadPort,
  policy: DiscoveryPolicy,
  signal?: AbortSignal,
): Promise<DeliveryFrontier> {
  const root = `/repos/${encodeURIComponent(policy.owner)}/${encodeURIComponent(policy.repository)}`;
  const tickets = await readAllIssues(
    github,
    (page) => `${root}/issues?state=open&labels=${encodeURIComponent(policy.readyLabel)}&per_page=100&page=${page}`,
    signal,
  );
  if (tickets === undefined) throw new Error("Delivery Ticket discovery failed closed");

  const frontier: DeliveryTicketSnapshot[] = [];
  const excluded: ExcludedDeliveryTicket[] = [];
  for (const ticket of tickets) {
    if (ticket.pullRequest) continue;
    const labels = labelsOf(ticket);
    if (ticket.state !== "open" || !labels.includes(policy.readyLabel)) continue;
    if (ticket.openBlockerCount === undefined) {
      excluded.push({ ticketNumber: ticket.number, reason: "dependency-data-incomplete" });
      continue;
    }
    if (labels.includes(policy.prohibitedLabel)) {
      excluded.push({ ticketNumber: ticket.number, reason: "prohibited" });
      continue;
    }
    const blockers = await readAllIssues(
      github,
      (page) => `${root}/issues/${ticket.number}/dependencies/blocked_by?per_page=100&page=${page}`,
      signal,
    );
    if (blockers === undefined) {
      excluded.push({ ticketNumber: ticket.number, reason: "dependency-data-incomplete" });
      continue;
    }
    const openBlockerNumbers = blockers
      .filter((blocker) => blocker.state === "open")
      .map((blocker) => blocker.number);
    if (openBlockerNumbers.length !== ticket.openBlockerCount) {
      excluded.push({ ticketNumber: ticket.number, reason: "dependency-data-incomplete" });
      continue;
    }
    if (openBlockerNumbers.length > 0) {
      excluded.push({ ticketNumber: ticket.number, reason: "open-blockers", openBlockerNumbers });
      continue;
    }
    frontier.push({
      number: ticket.number,
      open: true,
      labels,
      openBlockerNumbers,
      dependencyDataComplete: true,
    });
  }
  return { frontier, excluded };
}
