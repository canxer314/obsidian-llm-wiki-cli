import { randomUUID } from "node:crypto";

import {
  createSandcastleLiveStatus,
  type SandcastleLiveStatusDependencies,
  type SandcastleLiveStatusPort,
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

export type SandcastleSignal = "SIGINT" | "SIGTERM";

export type SandcastleInterruptionLifecycle = "draining" | "cancelling" | "forced-exit";
export interface SandcastleInterruptionEvent {
  readonly kind: "interruption-lifecycle";
  readonly runId: string;
  readonly lifecycle: SandcastleInterruptionLifecycle;
  readonly timestamp: string;
  readonly elapsedMs: number;
  readonly outcome: "requested" | "completed" | "incomplete";
}

export interface SandcastleSignalSource {
  add(listener: (signal: SandcastleSignal) => void): void;
  remove(listener: (signal: SandcastleSignal) => void): void;
}

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
  readonly signalSource?: SandcastleSignalSource;
  readonly warningSink?: (warning: string) => void;
  readonly forceExit?: (exitCode: number) => void;
  readonly monotonicNow?: () => number;
  readonly utcNow?: () => Date;
  readonly recordInterruption?: (event: SandcastleInterruptionEvent) => void;
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
export const FORCED_EXIT_WARNING =
  "Sandcastle forced exit requested; finalization may be incomplete";

export class SandcastleCancellationError extends Error {
  constructor() {
    super("Sandcastle workflow interrupted");
    this.name = "AbortError";
  }
}

const PROCESS_SIGNAL_SOURCE: SandcastleSignalSource = {
  add(listener) {
    process.on("SIGINT", listener);
    process.on("SIGTERM", listener);
  },
  remove(listener) {
    process.off("SIGINT", listener);
    process.off("SIGTERM", listener);
  },
};

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
  const controller = new AbortController();
  const signalSource = dependencies.signalSource ?? PROCESS_SIGNAL_SOURCE;
  const warningSink = dependencies.warningSink ?? ((warning: string) => console.error(warning));
  const forceExit = dependencies.forceExit ?? ((exitCode: number) => process.exit(exitCode));
  const monotonicNow = dependencies.monotonicNow ?? (() => performance.now());
  const utcNow = dependencies.utcNow ?? (() => new Date());
  const startedAt = monotonicNow();
  const recordInterruption = (
    lifecycle: SandcastleInterruptionLifecycle,
    outcome: SandcastleInterruptionEvent["outcome"],
  ) => dependencies.recordInterruption?.({
    kind: "interruption-lifecycle",
    runId,
    lifecycle,
    timestamp: utcNow().toISOString(),
    elapsedMs: Math.max(0, Math.floor(monotonicNow() - startedAt)),
    outcome,
  });
  const activeStatuses = new Set<SandcastleLiveStatusPort>();
  let signalCount = 0;
  let draining = false;
  let wakeDrain!: () => void;
  const drainRequested = new Promise<void>((resolve) => { wakeDrain = resolve; });
  const transitionActive = (stage: "draining" | "cancelling" | "forced-exit") => {
    for (const liveStatus of activeStatuses) liveStatus.transition(stage);
  };
  const onSignal = (_signal: SandcastleSignal) => {
    signalCount += 1;
    if (!options.watch) {
      if (signalCount === 1) {
        transitionActive("cancelling");
        recordInterruption("cancelling", "requested");
        controller.abort(new SandcastleCancellationError());
        return;
      }
    } else {
      if (signalCount === 1) {
        draining = true;
        transitionActive("draining");
        recordInterruption("draining", "requested");
        wakeDrain();
        return;
      }
      if (signalCount === 2) {
        transitionActive("cancelling");
        recordInterruption("cancelling", "requested");
        controller.abort(new SandcastleCancellationError());
        return;
      }
    }
    transitionActive("forced-exit");
    recordInterruption("forced-exit", "incomplete");
    warningSink(FORCED_EXIT_WARNING);
    forceExit(1);
  };
  signalSource.add(onSignal);

  try {
    await dependencies.github.ensureLabel("sandcastle:failed");
    if (options.watch) {
      const waitForNextPoll = dependencies.sleep === undefined
        ? (milliseconds: number) => new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, milliseconds);
          void drainRequested.then(() => {
            clearTimeout(timer);
            resolve();
          });
        })
        : (milliseconds: number) => Promise.race([
          dependencies.sleep!(milliseconds),
          drainRequested,
        ]);
      const active = new Map<number, Promise<unknown>>();
      let batchId = 0;
      for (;;) {
        if (draining) {
          await Promise.allSettled(active.values());
          recordInterruption(signalCount >= 2 ? "cancelling" : "draining", "completed");
          return;
        }
        let candidates: readonly SandcastleIssue[] = [];
        try {
          candidates = await dependencies.github.listCandidateIssues();
        } catch {
          // A later polling tick retries transient discovery failures.
        }
        if (draining) continue;
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
          if (draining) break;
        }
        const launchable = controller.signal.aborted ? [] : claimed;
        if (launchable.length > 0) {
          batchId += 1;
          dependencies.recordWatchEvent?.({
            kind: "batch-started",
            runId,
            batchId,
            issueNumbers: launchable.map((issue) => issue.number),
          });
        }
        const workflowBatchId = batchId;
        for (const issue of launchable) {
          dependencies.recordWatchEvent?.({
            kind: "issue-started",
            runId,
            batchId: workflowBatchId,
            issueNumber: issue.number,
            activeCount: active.size + 1,
          });
          let outcome: "success" | "failure" = "success";
          const liveStatus = status.startIssue(workflowBatchId, issue.number);
          activeStatuses.add(liveStatus);
          if (signalCount >= 3) liveStatus.transition("forced-exit");
          else if (signalCount >= 2) liveStatus.transition("cancelling");
          else if (draining) liveStatus.transition("draining");
          const workflow = Promise.resolve(dependencies.processIssue(issue.number, {
            runId,
            batchId: workflowBatchId,
            issueNumber: issue.number,
            signal: controller.signal,
            liveStatus,
          }))
            .catch(() => {
              outcome = "failure";
            })
            .finally(() => {
              active.delete(issue.number);
              activeStatuses.delete(liveStatus);
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
        if (draining) continue;
        if (active.size === 0) status.idle(batchId);
        await waitForNextPoll(WATCH_INTERVAL_MS);
      }
    }

    const context = {
      runId,
      batchId: 0,
      issueNumber: options.issueNumber!,
      signal: controller.signal,
    };
    if (controller.signal.aborted) throw controller.signal.reason;
    if (!await claimEligibleIssue(context.issueNumber, dependencies)) return;
    const liveStatus = status.startIssue(context.batchId, context.issueNumber);
    activeStatuses.add(liveStatus);
    try {
      const result = await dependencies.processIssue(context.issueNumber, { ...context, liveStatus });
      status.finishIssue(context.issueNumber, "completed");
      return result;
    } catch (error) {
      status.finishIssue(context.issueNumber, "failed");
      throw error;
    } finally {
      activeStatuses.delete(liveStatus);
      if (signalCount > 0) recordInterruption("cancelling", "completed");
    }
  } finally {
    signalSource.remove(onSignal);
    status.dispose();
  }
}
