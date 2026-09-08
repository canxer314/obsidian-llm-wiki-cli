import type { ImplementerGitState } from "./implementer-git-state.ts";
import { createImplementerGitState } from "./implementer-git-state.ts";
import type { ImplementerAgentSession } from "./implementer-session.ts";
import {
  StopRetryError,
  invokeWithRecovery,
  isStopRetry,
  selectRecoveryDelay,
  waitForInvocationBackoff,
} from "./invocation-recovery.ts";
import { appendJobOutput, inheritedJobLogView, type JobLog } from "./job-logs.ts";
import type { PlannerOutput } from "./planner.js";
import { redact } from "./redaction.ts";

// Ordinary Issue implementation recovery (Spec #449, Issue #458). The
// Implementer runs inside one bounded invocation recovery window — at most
// three sequential Agent attempts — and recovers from durable named-branch
// state instead of the final Sandcastle run's commit delta:
//
// - The production Implementer requires a Target Checkout. The authorized
//   base revision (read after the reusable-implementation preflight) is
//   frozen for the whole recovery window, and the deterministic local branch
//   is prepared at that baseline without ever being checked out in the root
//   Target Checkout — the Agent works in the Sandcastle-managed worktree.
// - An unexpected same-name remote branch appearing after the preflight
//   stops recovery; it is never adopted.
// - Branch-state preparation and reads use a separate bounded three-attempt
//   read policy with the same backoff rules as invocation recovery and their
//   own sanitized log label. Read attempts never consume Agent invocation
//   attempts, and exhausted or unprovable reads stop further Agent calls.
// - Between attempts the Implementer reconciles local and remote branch
//   state: a remote equal to the local head, or equal to a known ancestor on
//   the frozen-baseline-to-local path, is accepted; remote ahead, divergence,
//   malformed revisions, or unknown ancestry stops recovery.
// - At least one Agent invocation must return successfully. Durable commits,
//   pushes, or a Draft Pull Request left behind by three throwing attempts
//   can never produce success.
// - After a successful return the durable named ref is read even when the
//   Sandcastle result reports no new commits. The durable head must differ
//   from the frozen baseline, descend from it, and leave the managed
//   worktree clean.
// - The result contract hands the deterministic branch and the durable
//   headSha to the existing higher-level verification, which remains
//   responsible for the exact remote head, one matching open Draft Pull
//   Request, the base/head relationship, the Issue closing text, and the
//   allowed-path policy.

export interface VerifiedPullRequest {
  readonly number: number;
  readonly headSha: string;
  readonly url: string;
}

export interface ImplementerGithubPort {
  verifyImplementation(request: {
    readonly issueNumber: number;
    readonly branch: string;
    readonly expectedHeadSha: string;
    readonly allowsAutomationChanges: boolean;
  }): Promise<VerifiedPullRequest>;
}

export class ImplementerResultError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImplementerResultError";
  }
}

const FULL_REVISION = /^[0-9a-f]{40}$/u;

// Branch-state preparation and reads get their own bounded policy: three
// attempts with the invocation-recovery delay rules, logged under a separate
// sanitized label so read retries are never confused with Agent invocation
// attempts.
const MAX_BRANCH_STATE_ATTEMPTS = 3;

function stopRetry(summary: string, cause?: unknown): StopRetryError {
  const failure = new StopRetryError(summary);
  if (cause !== undefined) {
    // The underlying read failure remains available for local diagnosis as
    // an in-memory cause; it is never copied into retry logs.
    Object.defineProperty(failure, "cause", {
      configurable: true,
      enumerable: false,
      value: cause,
      writable: true,
    });
  }
  return failure;
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error("Implementer branch-state read was aborted");
}

interface BranchStateReadOptions {
  readonly label: string;
  readonly log?: JobLog;
  readonly signal?: AbortSignal;
  readonly now?: () => number;
  readonly wait?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
}

function appendBranchStateEntry(
  log: JobLog | undefined,
  entry: Readonly<Record<string, unknown>>,
): void {
  if (log === undefined) return;
  // Every logged value is repository-owned metadata that has passed through
  // pattern redaction; raw read failures never reach the read-retry log.
  const sanitized = Object.fromEntries(
    Object.entries(entry).map(([key, value]) => [
      key,
      typeof value === "string" ? redact(value) : value,
    ]),
  );
  appendJobOutput(log, "stderr", `[implementer-branch-state] ${JSON.stringify(sanitized)}\n`);
}

// Runs one branch-state preparation or read with at most three attempts.
// The controlled stop-retry sentinel is never retried: it already carries a
// deliberate recovery stop. Ordinary read failures are retried with the
// invocation-recovery delay rules; exhaustion stops further Agent calls by
// raising the sentinel with the last read failure as its in-memory cause.
async function readBranchState<TResult>(
  read: () => Promise<TResult>,
  options: BranchStateReadOptions,
): Promise<TResult> {
  const now = options.now ?? (() => Date.now());
  const wait = options.wait ?? waitForInvocationBackoff;
  let lastFailure: unknown;
  for (let ordinal = 1; ordinal <= MAX_BRANCH_STATE_ATTEMPTS; ordinal += 1) {
    if (options.signal?.aborted === true) {
      throw lastFailure ?? abortReason(options.signal);
    }
    try {
      return await read();
    } catch (failure) {
      if (isStopRetry(failure)) {
        appendBranchStateEntry(options.log, {
          label: options.label, attempt: ordinal, outcome: "stopped",
          reason: failure.message,
        });
        throw failure;
      }
      lastFailure = failure;
      if (ordinal === MAX_BRANCH_STATE_ATTEMPTS) {
        appendBranchStateEntry(options.log, {
          label: options.label, attempt: ordinal,
          attempts: MAX_BRANCH_STATE_ATTEMPTS, outcome: "exhausted",
        });
        throw stopRetry(
          `Implementer branch-state ${options.label} observation failed after ${MAX_BRANCH_STATE_ATTEMPTS} attempts`,
          failure,
        );
      }
    }
    const delay = selectRecoveryDelay(lastFailure, ordinal, now());
    appendBranchStateEntry(options.log, {
      label: options.label, attempt: ordinal, nextAttempt: ordinal + 1,
      delayClass: delay.delayClass, delayMilliseconds: delay.milliseconds,
    });
    await wait(delay.milliseconds, options.signal);
  }
  throw lastFailure;
}

export async function implementIssue(options: {
  readonly plan: Extract<PlannerOutput, { status: "ready" }>;
  readonly model: string;
  readonly session: ImplementerAgentSession;
  // The authorized base revision, captured after the reusable-implementation
  // preflight and frozen for the whole recovery window.
  readonly baseRevision: string;
  // The required Target Checkout; the deterministic branch is prepared in
  // its repository without being checked out in the root checkout.
  readonly checkoutPath: string;
  readonly github: ImplementerGithubPort;
  readonly gitState?: ImplementerGitState;
  readonly log?: JobLog;
  readonly signal?: AbortSignal;
  readonly now?: () => number;
  readonly wait?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
}): Promise<VerifiedPullRequest> {
  const branch = `sandcastle/issue-${options.plan.issue.number}`;
  if (!FULL_REVISION.test(options.baseRevision)) {
    throw new ImplementerResultError(
      `Issue #${options.plan.issue.number} has an invalid authorized base revision`,
    );
  }
  // The frozen baseline: every preparation, reconciliation, and success
  // check below compares against this value and nothing newer.
  const baseline = options.baseRevision;
  const gitState = options.gitState ?? createImplementerGitState({
    checkoutPath: options.checkoutPath,
  });
  const log = options.log ?? inheritedJobLogView();
  const readOptions = {
    ...(log === undefined ? {} : { log }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.wait === undefined ? {} : { wait: options.wait }),
  };
  const read = <TResult>(label: string, observe: () => Promise<TResult>): Promise<TResult> =>
    readBranchState(observe, { label, ...readOptions });

  const requireWellFormed = (revision: string, kind: string): string => {
    if (!FULL_REVISION.test(revision)) {
      throw stopRetry(`Implementer ${kind} branch revision is malformed`);
    }
    return revision;
  };

  // Branch preparation before the first Agent attempt. A same-name remote
  // branch at this point is unexpected — the reusable-implementation
  // preflight already ran — and stops recovery instead of being adopted. A
  // leftover local branch is durable earlier work only when it descends from
  // the frozen baseline; anything else is unknown history and stops.
  await read("prepare", async () => {
    await gitState.fetchRemote();
    const remote = await gitState.observeRemoteBranch(branch);
    if (remote !== undefined) {
      requireWellFormed(remote, "remote");
      throw stopRetry(`Implementer found an unexpected remote branch ${branch}`);
    }
    const local = await gitState.observeLocalBranch(branch);
    if (local === undefined) {
      await gitState.prepareBranch({ branch, baseline });
      return;
    }
    requireWellFormed(local, "local");
    if (!(await gitState.isAncestor(baseline, local))) {
      throw stopRetry("Implementer local branch does not descend from the frozen baseline");
    }
  });

  // Reconciliation between attempts: prove the interrupted attempt's durable
  // state before another Agent invocation runs on top of it.
  const reconcile = (): Promise<void> => read("reconcile", async () => {
    const observedLocal = await gitState.observeLocalBranch(branch);
    if (observedLocal === undefined) {
      throw stopRetry("Implementer local branch is missing after an interrupted attempt");
    }
    const local = requireWellFormed(observedLocal, "local");
    if (!(await gitState.isAncestor(baseline, local))) {
      throw stopRetry("Implementer local branch does not descend from the frozen baseline");
    }
    await gitState.fetchRemote();
    const observedRemote = await gitState.observeRemoteBranch(branch);
    if (observedRemote === undefined) return;
    const remote = requireWellFormed(observedRemote, "remote");
    // Accepted: the interrupted attempt pushed its local head, or pushed a
    // known ancestor on the frozen-baseline-to-local path before advancing
    // further locally.
    if (remote === local) return;
    if (await gitState.isAncestor(remote, local)) return;
    throw stopRetry("Implementer remote branch moved ahead or diverged from the local branch");
  });

  const outcome = await invokeWithRecovery(async ({ recovery }) => {
    if (recovery) await reconcile();
    const result = await options.session.run({
      model: options.model,
      branch,
      plan: options.plan,
      checkoutPath: options.checkoutPath,
      ...(recovery ? { recovery: { baseline } } : {}),
    });
    if (result.branch !== branch) {
      throw new ImplementerResultError(
        `Implementer used branch ${result.branch}; expected ${branch}`,
      );
    }
    // The durable named ref is the success contract — never the final run's
    // commit delta, which is empty when an earlier interrupted attempt did
    // the committing and pushing.
    const headSha = await read("head", async () => {
      const observed = await gitState.observeLocalBranch(branch);
      if (observed === undefined) {
        throw new Error("Implementer durable branch is missing after a successful attempt");
      }
      const head = requireWellFormed(observed, "local");
      if (!(await gitState.isAncestor(baseline, head))) {
        throw stopRetry("Implementer branch head does not descend from the frozen baseline");
      }
      return head;
    });
    if (headSha === baseline) {
      throw new ImplementerResultError("Implementer did not advance the frozen baseline");
    }
    const worktree = await read("worktree", () => gitState.observeManagedWorktree(branch));
    if (worktree !== undefined && !worktree.clean) {
      throw new ImplementerResultError("Implementer left the managed worktree unclean");
    }
    return { branch, headSha };
  }, {
    role: "implementer",
    stage: "implementation",
    ...readOptions,
  });

  // Higher-level verification stays outside the recovery window and receives
  // the durable headSha read from the named ref.
  return options.github.verifyImplementation({
    issueNumber: options.plan.issue.number,
    branch: outcome.branch,
    expectedHeadSha: outcome.headSha,
    allowsAutomationChanges: options.plan.allowsAutomationChanges,
  });
}
