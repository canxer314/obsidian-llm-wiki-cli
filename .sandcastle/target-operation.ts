import { lstat, realpath } from "node:fs/promises";
import { relative, resolve } from "node:path";

import {
  AgentWorkerExitError,
  AgentWorkerTimeoutError,
  runAgentWorker,
  runTargetJob,
  workerJson,
} from "./agent-process-runner.ts";
import type {
  TargetCheckout,
  TargetCheckoutProcessOptions,
} from "./target-checkout.ts";
import {
  completeJobLog,
  createJobLog,
} from "./job-logs.ts";
import {
  parseAuthorizedTargetOperationInvocation,
  targetOperationWorkerArguments,
  type AuthorizedTargetOperationInvocation,
  type LabelTriggeredTargetOperationIdentity,
  type TargetOperationIdentity,
} from "./target-operation-invocation.ts";
export type {
  AuthorizedTargetOperationInvocation,
  LabelTriggeredTargetOperationIdentity,
  TargetOperationIdentity,
} from "./target-operation-invocation.ts";
import { classifyTargetOperationOutcome } from "./target-operation-outcome.ts";
import {
  trustAgentWorkerExit,
  trustTargetOperationTimeout,
  type TrustedAgentWorkerName,
} from "./trusted-failure.ts";
import type { TargetOperationStartupSnapshot } from "./target-operation-startup.ts";

const TARGET_JOB_GRACE_MILLISECONDS = 10 * 1000;
const targetOperationTimeouts: Readonly<Record<TargetOperationIdentity, number>> = {
  "implement-issue": 90 * 60 * 1000,
  "implement-spec": 90 * 60 * 1000,
  "implement-feedback": 90 * 60 * 1000,
  review: 135 * 60 * 1000,
  "update-branch": 90 * 60 * 1000,
  "split-spec": 90 * 60 * 1000,
  "architecture-review": 31.5 * 60 * 1000,
};

export function targetOperationTimeout(operation: TargetOperationIdentity): number {
  return targetOperationTimeouts[operation];
}

const targetOperationEntries: Readonly<Record<TargetOperationIdentity, string>> = {
  "implement-issue": "operations/implement-issue.ts",
  "implement-spec": "operations/implement-spec.ts",
  "implement-feedback": "operations/implement-pr.ts",
  review: "operations/review-pr.ts",
  "update-branch": "operations/update-branch.ts",
  "split-spec": "operations/split-spec.ts",
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
  readonly trustedSandcastleRoot?: string;
}): Promise<unknown> {
  const invocation = parseAuthorizedTargetOperationInvocation(options.invocation);
  const { operation, revision } = invocation;
  const number = "number" in invocation ? invocation.number : undefined;
  return options.checkout.withCheckout({
    revision,
    ...(number === undefined ? {} : { pullRequestNumber: number }),
  }, async (checkoutPath) => {
    // The operation entry always resolves from the trusted automation .sandcastle
    // (the checkout running the Target job; injected in tests). A Target Checkout
    // whose .sandcastle carries divergent code never influences what runs; the
    // operated checkout is delivered to the worker only through its arguments.
    const trustedSandcastleRoot = options.trustedSandcastleRoot ?? resolve(import.meta.dirname);
    let operationRoot: string;
    let operationEntry: string;
    try {
      operationRoot = await realpath(trustedSandcastleRoot);
      operationEntry = resolve(operationRoot, targetOperationEntries[operation]);
      const entryRelativePath = relative(operationRoot, await realpath(operationEntry));
      if (
        !(await lstat(operationEntry)).isFile() ||
        entryRelativePath.startsWith("..") ||
        entryRelativePath === ""
      ) {
        throw new Error("Target operation entry must be a regular file inside the trusted automation checkout");
      }
    } catch {
      throw new Error("Target operation entry must be a regular file inside the trusted automation checkout");
    }
    const result = await runAgentWorker({
      workerRoot: operationRoot,
      workerFile: targetOperationEntries[operation],
      workerName: `Target operation ${operation}`,
      arguments_: targetOperationWorkerArguments(invocation, checkoutPath),
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
  readonly start?: (arguments_: readonly string[]) => import("node:child_process").ChildProcess;
  readonly trustedSandcastleRoot?: string;
}

export function createTargetOperationRunner(options: TargetOperationRunnerOptions) {
  const runner = createTargetOperationRunnerWithWorker(options, runTargetJob);
  return {
    async run(invocation: AuthorizedTargetOperationInvocation): Promise<unknown> {
      try {
        return await runner.run(invocation);
      } catch (error) {
        if (error instanceof AgentWorkerTimeoutError) {
          throw trustTargetOperationTimeout(error, invocation.operation);
        }
        throw error;
      }
    },
  };
}

export function createTargetOperationRunnerWithWorker(
  options: TargetOperationRunnerOptions,
  runWorker: typeof runTargetJob,
) {
  return {
    async run(invocation: AuthorizedTargetOperationInvocation): Promise<unknown> {
      const authorizedInvocation = parseAuthorizedTargetOperationInvocation(invocation);
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
            jobId: authorizedInvocation.jobId,
            operation: authorizedInvocation.operation,
            ...("number" in authorizedInvocation ? { number: authorizedInvocation.number } : {}),
            revision: authorizedInvocation.revision,
          });
      let operationFailed = true;
      try {
        const result = await runWorker({
          workerRoot: options.trustedSandcastleRoot ?? resolve(import.meta.dirname),
          workerFile: "target-job-worker.ts",
          workerName: "Target job",
          arguments_: [],
          input: JSON.stringify({
            checkout: options.checkoutOptions,
            startup: options.startup,
            invocation: authorizedInvocation,
          }),
          timeoutMessage: `Target operation ${authorizedInvocation.operation} timed out`,
          timeoutMilliseconds: options.timeoutMilliseconds ?? targetOperationTimeout(authorizedInvocation.operation),
          graceMilliseconds: options.graceMilliseconds ?? TARGET_JOB_GRACE_MILLISECONDS,
          start: options.start,
          log,
        });
        const outcome = classifyTargetOperationOutcome(
          authorizedInvocation.operation,
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
