import { lstat, realpath } from "node:fs/promises";
import { relative, resolve } from "node:path";

import {
  AgentWorkerExitError,
  AgentWorkerTimeoutError,
  runAgentWorker,
  workerJson,
  type AgentWorkerOptions,
} from "./agent-process-runner.ts";
import type {
  TargetCheckout,
  TargetCheckoutProcessOptions,
} from "./target-checkout.ts";
import {
  completeJobLog,
  createJobLog,
  inheritedJobLogEnvironment,
} from "./job-logs.ts";
import type { FeedbackReconcileAuthorization } from "./feedback-implementation-automation.ts";
import { classifyTargetOperationOutcome } from "./target-operation-outcome.ts";
import {
  trustAgentWorkerExit,
  type TrustedAgentWorkerName,
} from "./trusted-failure.ts";
import type { TargetOperationStartupSnapshot } from "./target-operation-startup.ts";

export type TargetOperationIdentity =
  | "implement-issue"
  | "implement-prd"
  | "implement-feedback"
  | "review"
  | "update-branch"
  | "split-prd"
  | "architecture-review";

export type LabelTriggeredTargetOperationIdentity = Exclude<
  TargetOperationIdentity,
  "architecture-review"
>;

export interface LabelTriggeredTargetOperationInvocation {
  readonly operation: LabelTriggeredTargetOperationIdentity;
  readonly number: number;
  readonly revision: string;
  readonly jobId: string;
  readonly acquired?: true;
  readonly pullRequest?: {
    readonly headSha: string;
    readonly headRefName: string;
    readonly baseRefName: string;
    readonly baseRepository: string;
    readonly headRepository: string;
  };
  readonly reconcile?: FeedbackReconcileAuthorization;
}

export interface ScheduledArchitectureReviewInvocation {
  readonly operation: "architecture-review";
  readonly revision: string;
  readonly jobId: string;
}

export type AuthorizedTargetOperationInvocation =
  | LabelTriggeredTargetOperationInvocation
  | ScheduledArchitectureReviewInvocation;

const TARGET_JOB_GRACE_MILLISECONDS = 10 * 1000;
const targetOperationTimeouts: Readonly<Record<TargetOperationIdentity, number>> = {
  "implement-issue": 60 * 60 * 1000,
  "implement-prd": 60 * 60 * 1000,
  "implement-feedback": 60 * 60 * 1000,
  review: 30 * 60 * 1000,
  "update-branch": 60 * 60 * 1000,
  "split-prd": 60 * 60 * 1000,
  "architecture-review": 21 * 60 * 1000,
};

export function targetOperationTimeout(operation: TargetOperationIdentity): number {
  return targetOperationTimeouts[operation];
}

const targetOperationEntries: Readonly<Record<TargetOperationIdentity, string>> = {
  "implement-issue": "operations/implement-issue.ts",
  "implement-prd": "operations/implement-prd.ts",
  "implement-feedback": "operations/implement-pr.ts",
  review: "operations/review-pr.ts",
  "update-branch": "operations/update-branch.ts",
  "split-prd": "operations/split-prd.ts",
  "architecture-review": "operations/architecture-review.ts",
};

function trustedWorkerJson<TResult>(
  result: Awaited<ReturnType<typeof runAgentWorker>>,
  workerName: TrustedAgentWorkerName,
): TResult {
  return workerJson(result, workerName, (options) =>
    trustAgentWorkerExit(
      new AgentWorkerExitError(options),
      workerName,
      options.code,
    ));
}

export async function executeTargetOperationInCheckout(options: {
  readonly checkout: TargetCheckout;
  readonly startup: TargetOperationStartupSnapshot;
  readonly invocation: AuthorizedTargetOperationInvocation;
}): Promise<unknown> {
  const { operation, revision, jobId } = options.invocation;
  const number = "number" in options.invocation ? options.invocation.number : undefined;
  const acquired = "acquired" in options.invocation ? options.invocation.acquired : undefined;
  const pullRequest = "pullRequest" in options.invocation ? options.invocation.pullRequest : undefined;
  const reconcile = "reconcile" in options.invocation ? options.invocation.reconcile : undefined;
  return options.checkout.withCheckout({
    revision,
    ...(number === undefined ? {} : { pullRequestNumber: number }),
  }, async (checkoutPath) => {
    let operationRoot: string;
    let operationEntry: string;
    try {
      operationRoot = await realpath(resolve(checkoutPath, ".sandcastle"));
      operationEntry = resolve(operationRoot, targetOperationEntries[operation]);
      const entryRelativePath = relative(operationRoot, await realpath(operationEntry));
      if (
        !(await lstat(operationEntry)).isFile() ||
        entryRelativePath.startsWith("..") ||
        entryRelativePath === ""
      ) {
        throw new Error("Target operation entry must be a regular file inside the authorized checkout");
      }
    } catch {
      throw new Error("Target operation entry must be a regular file inside the authorized checkout");
    }
    const result = await runAgentWorker({
      checkoutPath,
      workerFile: targetOperationEntries[operation],
      workerName: `Target operation ${operation}`,
      arguments_: [
        ...(number === undefined ? [] : [String(number)]),
        JSON.stringify({
          operation,
          revision,
          jobId,
          ...(acquired === true ? { acquired: true } : {}),
          ...(pullRequest === undefined ? {} : { pullRequest }),
          ...(reconcile === undefined ? {} : { reconcile }),
        }),
      ],
      input: JSON.stringify(options.startup),
      timeoutMessage: `Target operation ${operation} timed out`,
    });
    const outcome = classifyTargetOperationOutcome(
      operation,
      trustedWorkerJson(result, `Target operation ${operation}`),
    );
    return {
      value: outcome.outcome,
      disposition: outcome.kind === "blocked" ? "retain" : "cleanup",
    };
  });
}

interface TargetOperationRunnerOptions {
  readonly checkoutOptions?: TargetCheckoutProcessOptions;
  readonly jobLogRoot?: string;
  readonly startup: TargetOperationStartupSnapshot;
  readonly timeoutMilliseconds?: number;
  readonly graceMilliseconds?: number;
  readonly start?: AgentWorkerOptions["start"];
  readonly kill?: AgentWorkerOptions["kill"];
  readonly wait?: AgentWorkerOptions["wait"];
  readonly groupExited?: AgentWorkerOptions["groupExited"];
}

export function createTargetOperationRunner(options: TargetOperationRunnerOptions) {
  return createTargetOperationRunnerWithWorker(options, runAgentWorker);
}

export function createTargetOperationRunnerWithWorker(
  options: TargetOperationRunnerOptions,
  runWorker: typeof runAgentWorker,
) {
  return {
    async run(invocation: AuthorizedTargetOperationInvocation): Promise<unknown> {
      validateInvocation(invocation);
      if (options.checkoutOptions === undefined && options.start === undefined) {
        throw new Error("Target operation requires whole-job checkout configuration");
      }
      if (options.jobLogRoot === undefined && options.start === undefined) {
        throw new Error("Target operation requires local job log configuration");
      }
      const log = options.jobLogRoot === undefined
        ? undefined
        : await createJobLog({
            root: options.jobLogRoot,
            jobId: invocation.jobId,
            operation: invocation.operation,
            ...("number" in invocation ? { number: invocation.number } : {}),
            revision: invocation.revision,
          });
      let operationFailed = true;
      try {
        const result = await runWorker({
          checkoutPath: resolve(import.meta.dirname, ".."),
          workerFile: "target-job-worker.ts",
          workerName: "Target job",
          arguments_: [],
          input: JSON.stringify({
            checkout: options.checkoutOptions,
            startup: options.startup,
            invocation,
          }),
          timeoutMessage: `Target operation ${invocation.operation} timed out`,
          timeoutMilliseconds: options.timeoutMilliseconds ?? targetOperationTimeout(invocation.operation),
          graceMilliseconds: options.graceMilliseconds ?? TARGET_JOB_GRACE_MILLISECONDS,
          start: options.start,
          kill: options.kill,
          wait: options.wait,
          groupExited: options.groupExited,
          processGroupOwner: true,
          inheritedEnvironment: log === undefined ? undefined : inheritedJobLogEnvironment(log),
        });
        const outcome = classifyTargetOperationOutcome(
          invocation.operation,
          trustedWorkerJson(result, "Target job"),
        );
        operationFailed = false;
        if (log !== undefined) {
          await completeJobLog(log, {
            status: outcome.kind === "blocked" ? "failed" : "completed",
          });
        }
        return outcome.outcome;
      } catch (error) {
        if (log !== undefined && operationFailed) {
          await completeJobLog(log, {
            status: error instanceof AgentWorkerTimeoutError
              ? "timed-out"
              : "failed",
          }).catch(() => undefined);
        }
        throw error;
      }
    },
  };
}

function isAuthorizedScheduledInvocation(
  invocation: ScheduledArchitectureReviewInvocation,
): boolean {
  const authorizedKeys = new Set(["operation", "revision", "jobId"]);
  return Reflect.ownKeys(invocation).length === authorizedKeys.size &&
    Reflect.ownKeys(invocation).every((key) => typeof key === "string" && authorizedKeys.has(key));
}

function validateInvocation(invocation: AuthorizedTargetOperationInvocation): void {
  const { operation, revision, jobId } = invocation;
  if (operation === "architecture-review" && !isAuthorizedScheduledInvocation(invocation)) {
    throw new Error("Scheduled architecture review invocation is invalid");
  }
  if (operation !== "architecture-review" && (!Number.isSafeInteger(invocation.number) || invocation.number < 1)) {
    throw new Error("Target operation Work Item number is invalid");
  }
  if (!/^[0-9a-f]{40}$/u.test(revision) || jobId.length === 0) {
    throw new Error("Target operation requires an authorized invocation");
  }
  const pullRequestOperation = operation === "implement-feedback" || operation === "review" || operation === "update-branch";
  if (
    pullRequestOperation && (
      invocation.pullRequest === undefined ||
      invocation.pullRequest.headSha !== revision ||
      invocation.pullRequest.headRepository !== invocation.pullRequest.baseRepository
    )
  ) {
    throw new Error("Target Pull Request operation requires an acquired same-repository revision");
  }
}
