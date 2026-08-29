import type { FeedbackReconcileAuthorization } from "./feedback-implementation-automation.ts";
import type { createTargetOperationCommandDispatch } from "./target-operation-dispatch.ts";

export function createAutomationCliDependencies<TDependencies extends object>(options: {
  readonly targetOperationCommands: ReturnType<typeof createTargetOperationCommandDispatch>;
  readonly withScheduler: <T>(identity: string, action: () => Promise<T>) => Promise<T>;
  readonly additionalDependencies?: TDependencies;
}) {
  return {
    ...options.additionalDependencies,
    runReview: (pullRequestNumber: number) => options.withScheduler(
      `pull-request:${pullRequestNumber}`,
      () => options.targetOperationCommands.runOperation("review", pullRequestNumber),
    ),
    runFeedback: (pullRequestNumber: number, reconcile?: FeedbackReconcileAuthorization) => options.withScheduler(
      `pull-request:${pullRequestNumber}`,
      () => options.targetOperationCommands.runOperation("implement-feedback", pullRequestNumber, reconcile),
    ),
    runImplement: (issueNumber: number) => options.withScheduler(
      `issue:${issueNumber}`,
      () => options.targetOperationCommands.runOperation("implement-issue", issueNumber),
    ),
    runImplementPrd: (issueNumber: number) => options.withScheduler(
      `prd:${issueNumber}`,
      () => options.targetOperationCommands.runOperation("implement-prd", issueNumber),
    ),
    runSplit: (issueNumber: number) => options.withScheduler(
      `prd:${issueNumber}`,
      () => options.targetOperationCommands.runOperation("split-prd", issueNumber),
    ),
    runUpdate: (pullRequestNumber: number) => options.withScheduler(
      `pull-request:${pullRequestNumber}`,
      () => options.targetOperationCommands.runOperation("update-branch", pullRequestNumber),
    ),
  };
}
