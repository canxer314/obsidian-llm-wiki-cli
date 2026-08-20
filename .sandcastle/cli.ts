import { randomUUID } from "node:crypto";

import {
  createSandcastleLiveStatus,
  type SandcastleLiveStatusDependencies,
  type SandcastleStatusFormat,
} from "./live-status.ts";

import {
  validateSandcastleRunId,
  type SandcastleExecutionContext,
} from "./evidence.ts";

export class SandcastleCliError extends Error {
  readonly exitCode = 2;

  constructor(message: string) {
    super(message);
    this.name = "SandcastleCliError";
  }
}

export interface SandcastleIssue {
  readonly number: number;
  readonly state: string;
  readonly labels: readonly string[];
}

export interface SandcastleGithubPort {
  ensureLabel(name: string): Promise<void>;
  getIssue(number: number): Promise<SandcastleIssue | null>;
  listCandidateIssues(): Promise<readonly SandcastleIssue[]>;
  claimIssue(number: number): Promise<boolean>;
}

export type SandcastleWatchEvent =
  | {
    readonly kind: "batch-started";
    readonly runId: string;
    readonly batchId: number;
    readonly issueNumbers: readonly number[];
  }
  | {
    readonly kind: "issue-started";
    readonly runId: string;
    readonly batchId: number;
    readonly issueNumber: number;
    readonly activeCount: number;
  }
  | {
    readonly kind: "issue-finished";
    readonly runId: string;
    readonly batchId: number;
    readonly issueNumber: number;
    readonly outcome: "success" | "failure";
    readonly activeCount: number;
  };

export interface SandcastleCliDependencies<TResult = unknown> {
  readonly github: SandcastleGithubPort;
  readonly processIssue: (
    issueNumber: number,
    context: SandcastleExecutionContext,
  ) => Promise<TResult>;
  readonly inspectClaim?: (
    issueNumber: number,
    format?: SandcastleStatusFormat,
  ) => Promise<void>;
  readonly createRunId?: () => string;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly recordWatchEvent?: (event: SandcastleWatchEvent) => void;
  readonly liveStatus?: SandcastleLiveStatusDependencies;
  readonly handleFailure?: (
    issueNumber: number,
    stage: "claim",
    error: unknown,
  ) => Promise<void>;
}

interface CliOptions {
  readonly issueNumber?: number;
  readonly inspectClaimNumber?: number;
  readonly watch: boolean;
  readonly statusFormat?: SandcastleStatusFormat;
  readonly liveStatusEnabled: boolean;
}

function parseCliOptions(argv: readonly string[]): CliOptions {
  let issueNumber: number | undefined;
  let inspectClaimNumber: number | undefined;
  let inspectClaimCount = 0;
  let watch = false;
  let statusFormat: SandcastleStatusFormat | undefined;
  let liveStatusEnabled = true;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--watch") {
      watch = true;
      continue;
    }
    if (argument === "--no-live-status") {
      liveStatusEnabled = false;
      continue;
    }
    if (argument === "--status-format") {
      const value = argv[index + 1];
      if (value !== "human" && value !== "json") {
        throw new SandcastleCliError("--status-format requires human or json");
      }
      statusFormat = value;
      index += 1;
      continue;
    }
    if (argument === "--inspect-claim") {
      inspectClaimCount += 1;
      const value = argv[index + 1];
      if (value === undefined) {
        throw new SandcastleCliError("--inspect-claim requires a number");
      }
      if (!/^[1-9]\d*$/.test(value)) {
        throw new SandcastleCliError("--inspect-claim requires a positive integer");
      }
      inspectClaimNumber = Number(value);
      if (!Number.isSafeInteger(inspectClaimNumber)) {
        throw new SandcastleCliError("--inspect-claim requires a positive integer");
      }
      index += 1;
      continue;
    }
    if (argument === "--issue") {
      const value = argv[index + 1];
      if (value === undefined) {
        throw new SandcastleCliError("--issue requires a number");
      }
      if (!/^[1-9]\d*$/.test(value)) {
        throw new SandcastleCliError("--issue requires a positive integer");
      }
      issueNumber = Number(value);
      if (!Number.isSafeInteger(issueNumber)) {
        throw new SandcastleCliError("--issue requires a positive integer");
      }
      index += 1;
      continue;
    }
    throw new SandcastleCliError(`Unknown argument: ${argument}`);
  }

  if (inspectClaimCount > 1) {
    throw new SandcastleCliError("--inspect-claim may only be specified once");
  }
  if (inspectClaimNumber !== undefined && !liveStatusEnabled) {
    throw new SandcastleCliError("--no-live-status cannot be used with --inspect-claim");
  }
  if (issueNumber !== undefined && watch && inspectClaimNumber === undefined) {
    throw new SandcastleCliError("--issue and --watch cannot be used together");
  }
  const executionModeCount = Number(issueNumber !== undefined) + Number(watch) +
    Number(inspectClaimNumber !== undefined);
  if (executionModeCount > 1) {
    throw new SandcastleCliError(
      "--inspect-claim, --issue, and --watch cannot be used together",
    );
  }
  if (executionModeCount === 0) {
    throw new SandcastleCliError(
      "Missing required --issue <number>; use --watch to scan the backlog",
    );
  }

  return {
    ...(issueNumber === undefined ? {} : { issueNumber }),
    ...(inspectClaimNumber === undefined ? {} : { inspectClaimNumber }),
    watch,
    ...(statusFormat === undefined ? {} : { statusFormat }),
    liveStatusEnabled,
  };
}

const WATCH_INTERVAL_MS = 300_000;
const MAX_ACTIVE_ISSUES = 2;

async function claimEligibleIssue<TResult>(
  issueNumber: number,
  dependencies: SandcastleCliDependencies<TResult>,
): Promise<boolean> {
  const issue = await dependencies.github.getIssue(issueNumber);
  if (issue === null) {
    throw new SandcastleCliError(`Issue #${issueNumber} does not exist`);
  }
  if (issue.state.toUpperCase() !== "OPEN") {
    throw new SandcastleCliError(`Issue #${issueNumber} must be open`);
  }
  if (!issue.labels.includes("Sandcastle")) {
    throw new SandcastleCliError(
      `Issue #${issueNumber} must have the Sandcastle label`,
    );
  }

  let claimed: boolean;
  try {
    claimed = await dependencies.github.claimIssue(issueNumber);
  } catch (error) {
    await dependencies.handleFailure?.(issueNumber, "claim", error);
    throw error;
  }
  return claimed;
}

async function runIssue<TResult>(
  context: SandcastleExecutionContext,
  dependencies: SandcastleCliDependencies<TResult>,
  status: ReturnType<typeof createSandcastleLiveStatus>,
): Promise<TResult | undefined> {
  if (!await claimEligibleIssue(context.issueNumber, dependencies)) return;
  const liveStatus = status.startIssue(context.batchId, context.issueNumber);
  try {
    const result = await dependencies.processIssue(context.issueNumber, {
      ...context,
      liveStatus,
    });
    status.finishIssue(context.issueNumber, "completed");
    return result;
  } catch (error) {
    status.finishIssue(context.issueNumber, "failed");
    throw error;
  }
}

export async function runSandcastleCli<TResult>(
  argv: readonly string[],
  dependencies: SandcastleCliDependencies<TResult>,
): Promise<TResult | undefined> {
  const options = parseCliOptions(argv);
  if (options.inspectClaimNumber !== undefined) {
    if (dependencies.inspectClaim === undefined) {
      throw new Error("Claim inspector is unavailable");
    }
    await dependencies.inspectClaim(
      options.inspectClaimNumber,
      options.statusFormat,
    );
    return;
  }
  const runId = dependencies.createRunId?.() ?? randomUUID();
  validateSandcastleRunId(runId);
  const status = createSandcastleLiveStatus({
    runId,
    ...(options.statusFormat === undefined ? {} : { format: options.statusFormat }),
    enabled: options.liveStatusEnabled,
    ...(dependencies.liveStatus === undefined
      ? {}
      : { dependencies: dependencies.liveStatus }),
  });
  await dependencies.github.ensureLabel("sandcastle:failed");
  if (options.watch) {
    try {
      const sleep = dependencies.sleep ?? ((milliseconds: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
    const active = new Map<number, Promise<unknown>>();
    let batchId = 0;
    for (;;) {
      let candidates: readonly SandcastleIssue[] = [];
      try {
        candidates = await dependencies.github.listCandidateIssues();
      } catch {
        // A later polling tick retries transient discovery failures.
      }
      const available = candidates.filter((issue) =>
        !active.has(issue.number) && !issue.labels.includes("sandcastle:failed")
      ).slice(0, MAX_ACTIVE_ISSUES - active.size);
      const claimed: SandcastleIssue[] = [];
      for (const issue of available) {
        try {
          if (await claimEligibleIssue(issue.number, dependencies)) claimed.push(issue);
        } catch {
          // Claim failures are finalized independently and do not stop the batch.
        }
      }
      if (claimed.length > 0) {
        batchId += 1;
        dependencies.recordWatchEvent?.({
          kind: "batch-started",
          runId,
          batchId,
          issueNumbers: claimed.map((issue) => issue.number),
        });
      }
      const workflowBatchId = batchId;
      for (const issue of claimed) {
        dependencies.recordWatchEvent?.({
          kind: "issue-started",
          runId,
          batchId: workflowBatchId,
          issueNumber: issue.number,
          activeCount: active.size + 1,
        });
        let outcome: "success" | "failure" = "success";
        const context = {
          runId,
          batchId: workflowBatchId,
          issueNumber: issue.number,
        };
        const liveStatus = status.startIssue(workflowBatchId, issue.number);
        const workflow = dependencies.processIssue(issue.number, {
          ...context,
          liveStatus,
        })
          .catch(() => {
            outcome = "failure";
          })
          .finally(() => {
            active.delete(issue.number);
            status.finishIssue(issue.number, outcome === "success" ? "completed" : "failed");
            dependencies.recordWatchEvent?.({
              kind: "issue-finished",
              runId,
              batchId: workflowBatchId,
              issueNumber: issue.number,
              outcome,
              activeCount: active.size,
            });
          });
        active.set(issue.number, workflow);
      }
      if (active.size === 0) status.idle(batchId);
      await sleep(WATCH_INTERVAL_MS);
    }
    } finally {
      status.dispose();
    }
  }

  return runIssue(
    { runId, batchId: 0, issueNumber: options.issueNumber! },
    dependencies,
    status,
  ).finally(() => status.dispose());
}
