import { lstat, realpath } from "node:fs/promises";
import { relative, resolve } from "node:path";

import {
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
import type { TargetOperationStartupSnapshot } from "./target-operation-startup.ts";

export type TargetOperationIdentity =
  | "implement-issue"
  | "implement-prd"
  | "implement-feedback"
  | "review"
  | "update-branch"
  | "split-prd"
  | "architecture-review";

export interface AuthorizedTargetOperationInvocation {
  readonly operation: TargetOperationIdentity;
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

const targetOperationEntries: Readonly<Record<TargetOperationIdentity, string>> = {
  "implement-issue": "operations/implement-issue.ts",
  "implement-prd": "operations/implement-prd.ts",
  "implement-feedback": "operations/implement-pr.ts",
  review: "operations/review-pr.ts",
  "update-branch": "operations/update-branch.ts",
  "split-prd": "operations/split-prd.ts",
  "architecture-review": "operations/architecture-review.ts",
};

export async function executeTargetOperationInCheckout(options: {
  readonly checkout: TargetCheckout;
  readonly startup: TargetOperationStartupSnapshot;
  readonly invocation: AuthorizedTargetOperationInvocation;
}): Promise<unknown> {
  const { operation, number, revision, jobId, reconcile } = options.invocation;
  return options.checkout.withCheckout({ pullRequestNumber: number, revision }, async (checkoutPath) => {
    try {
      const operationRoot = await realpath(resolve(checkoutPath, ".sandcastle"));
      const operationEntry = resolve(operationRoot, targetOperationEntries[operation]);
      const entryRelativePath = relative(operationRoot, await realpath(operationEntry));
      if (
        !(await lstat(operationEntry)).isFile() ||
        entryRelativePath.startsWith("..") ||
        entryRelativePath === ""
      ) {
        throw new Error("Target operation entry must be a regular file inside the authorized checkout");
      }
      const result = await runAgentWorker({
        checkoutPath,
        workerFile: targetOperationEntries[operation],
        workerName: `Target operation ${operation}`,
        arguments_: [
          String(number),
          JSON.stringify({
            operation,
            revision,
            jobId,
            ...(options.invocation.acquired === true ? { acquired: true } : {}),
            ...(options.invocation.pullRequest === undefined ? {} : { pullRequest: options.invocation.pullRequest }),
            ...(reconcile === undefined ? {} : { reconcile }),
          }),
        ],
        input: JSON.stringify(options.startup),
        timeoutMessage: `Target operation ${operation} timed out`,
      });
      return workerJson(result, `Target operation ${operation}`);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("ENOENT:")) {
        throw new Error("Target operation entry must be a regular file inside the authorized checkout");
      }
      throw error;
    }
  });
}

export function createTargetOperationRunner(options: {
  readonly checkoutOptions?: TargetCheckoutProcessOptions;
  readonly jobLogRoot?: string;
  readonly startup: TargetOperationStartupSnapshot;
  readonly timeoutMilliseconds?: number;
  readonly graceMilliseconds?: number;
  readonly start?: AgentWorkerOptions["start"];
  readonly kill?: AgentWorkerOptions["kill"];
  readonly wait?: AgentWorkerOptions["wait"];
  readonly groupExited?: AgentWorkerOptions["groupExited"];
}) {
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
            number: invocation.number,
            revision: invocation.revision,
          });
      let operationFailed = true;
      try {
        const result = await runAgentWorker({
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
          timeoutMilliseconds: options.timeoutMilliseconds ?? targetOperationTimeouts[invocation.operation],
          graceMilliseconds: options.graceMilliseconds ?? TARGET_JOB_GRACE_MILLISECONDS,
          start: options.start,
          kill: options.kill,
          wait: options.wait,
          groupExited: options.groupExited,
          processGroupOwner: true,
          inheritedEnvironment: log === undefined ? undefined : inheritedJobLogEnvironment(log),
        });
        const outcome = workerJson(result, `Target operation ${invocation.operation}`);
        operationFailed = false;
        if (log !== undefined) {
          await completeJobLog(log, {
            status: isBlockedOutcome(outcome) ? "failed" : "completed",
          });
        }
        return outcome;
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

function isBlockedOutcome(value: unknown): boolean {
  return typeof value === "object" && value !== null &&
    "status" in value && value.status === "blocked";
}

function validateInvocation(invocation: AuthorizedTargetOperationInvocation): void {
  const { operation, number, revision, jobId } = invocation;
  if (!Number.isSafeInteger(number) || number < 1) {
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
