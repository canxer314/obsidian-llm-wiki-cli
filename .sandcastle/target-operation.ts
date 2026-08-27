import { lstat, realpath } from "node:fs/promises";
import { relative, resolve } from "node:path";

import type { TargetCheckout } from "./target-checkout.ts";
import type { TargetOperationStartupSnapshot } from "./target-operation-startup.ts";
import { runAgentWorker, workerJson } from "./agent-process-runner.ts";

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
  readonly reconcile?: {
    readonly invocation: "reconcile";
    readonly baseRevision?: string;
    readonly expectedPost?: string;
    readonly expectedReply?: { readonly rootCommentId: string; readonly body: string };
  };
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

export function createTargetOperationRunner(options: {
  readonly checkout: TargetCheckout;
  readonly startup: TargetOperationStartupSnapshot;
}) {
  return {
    async run(invocation: AuthorizedTargetOperationInvocation): Promise<unknown> {
      const { operation, number, revision, jobId, reconcile } = invocation;
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
      return options.checkout.withCheckout({ pullRequestNumber: number, revision }, async (checkoutPath) => {
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
              revision,
              jobId,
              ...(invocation.acquired === true ? { acquired: true } : {}),
              ...(invocation.pullRequest === undefined ? {} : { pullRequest: invocation.pullRequest }),
              ...(reconcile === undefined ? {} : { reconcile }),
            }),
          ],
          input: JSON.stringify(options.startup),
          timeoutMessage: `Target operation ${operation} timed out`,
        });
        return workerJson(result, `Target operation ${operation}`);
      });
    },
  };
}
