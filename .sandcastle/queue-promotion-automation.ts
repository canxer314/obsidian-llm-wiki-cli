export interface QueuedIssue {
  readonly number: number;
  readonly labels: readonly string[];
}

export interface QueuePromotionState {
  readonly labels: readonly string[];
  readonly parentNumber?: number;
  readonly blockers: readonly { readonly number: number; readonly state: string }[];
}

export interface QueuePromotionPorts {
  readonly github: {
    listQueuedIssues(): Promise<readonly QueuedIssue[]>;
    readPromotionState(issueNumber: number): Promise<QueuePromotionState>;
    addIssueLabel(issueNumber: number, label: string): Promise<void>;
    removeIssueLabel(issueNumber: number, label: string): Promise<void>;
    addPromotionDiagnostic(issueNumber: number): Promise<void>;
    addSubIssueRefusalDiagnostic(issueNumber: number, parentNumber: number): Promise<void>;
  };
}

export interface QueuePromotionResult {
  readonly status: "scanned";
  readonly promoted: readonly number[];
  readonly refused: readonly number[];
}

function promotable(state: QueuePromotionState): boolean {
  return state.labels.includes("agent:queued") &&
    !state.labels.includes("agent:in-progress") &&
    !state.blockers.some((blocker) => blocker.state === "OPEN");
}

export async function runQueuePromotionScan(
  ports: QueuePromotionPorts,
): Promise<QueuePromotionResult> {
  const queued = (await ports.github.listQueuedIssues())
    .slice()
    .sort((left, right) => left.number - right.number);
  const promoted: number[] = [];
  const refused: number[] = [];
  for (const issue of queued) {
    const state = await ports.github.readPromotionState(issue.number);
    if (!state.labels.includes("agent:queued")) continue;
    if (state.labels.includes("agent:in-progress")) continue;
    if (state.parentNumber !== undefined) {
      // Upstream refusal: agent:queued is not meaningful on sub-issues.
      // Business refusal semantics (#219 story 17): explain on the Issue and
      // clear the queue trigger, without agent:blocked. Comment before
      // clearing so an interrupted refusal stays visible and is picked up
      // again by the next scan.
      await ports.github.addSubIssueRefusalDiagnostic(issue.number, state.parentNumber);
      await ports.github.removeIssueLabel(issue.number, "agent:queued");
      refused.push(issue.number);
      continue;
    }
    if (!promotable(state)) continue;
    // Idempotent flip: re-read current state right before mutating to lose
    // races against another promotion of the same Issue.
    if (!promotable(await ports.github.readPromotionState(issue.number))) continue;
    // Add the implement trigger before clearing the queue so an interrupted
    // promotion leaves the Issue visible to the next scan instead of lost.
    await ports.github.addIssueLabel(issue.number, "agent:implement");
    await ports.github.removeIssueLabel(issue.number, "agent:queued");
    await ports.github.addPromotionDiagnostic(issue.number);
    promoted.push(issue.number);
  }
  return { status: "scanned", promoted, refused };
}
