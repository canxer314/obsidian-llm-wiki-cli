import {
  resolveTargetOperationRoute,
} from "./automation-command-route.ts";
import type { FeedbackReconcileAuthorization } from "./feedback-implementation-automation.ts";
import type { createTargetOperationCommandDispatch } from "./target-operation-dispatch.ts";

export function createAutomationCliDependencies<TDependencies extends object>(options: {
  readonly targetOperationCommands: ReturnType<typeof createTargetOperationCommandDispatch>;
  readonly withScheduler: <T>(identity: string, action: () => Promise<T>) => Promise<T>;
  readonly additionalDependencies?: TDependencies;
}) {
  return {
    ...options.additionalDependencies,
    runReview: (pullRequestNumber: number) => {
      const route = resolveTargetOperationRoute("review", pullRequestNumber);
      return options.withScheduler(route.identity, () => options.targetOperationCommands.runOperation(route.targetOperation, route.number));
    },
    runFeedback: (pullRequestNumber: number, reconcile?: FeedbackReconcileAuthorization) => {
      const route = resolveTargetOperationRoute("implement-feedback", pullRequestNumber);
      return options.withScheduler(route.identity, () => options.targetOperationCommands.runOperation(route.targetOperation, route.number, reconcile));
    },
    runImplement: (issueNumber: number) => {
      const route = resolveTargetOperationRoute("implement-issue", issueNumber);
      return options.withScheduler(route.identity, () => options.targetOperationCommands.runOperation(route.targetOperation, route.number));
    },
    runImplementSpec: (issueNumber: number) => {
      const route = resolveTargetOperationRoute("implement-spec", issueNumber);
      return options.withScheduler(route.identity, () => options.targetOperationCommands.runOperation(route.targetOperation, route.number));
    },
    runSplit: (issueNumber: number) => {
      const route = resolveTargetOperationRoute("split-spec", issueNumber);
      return options.withScheduler(route.identity, () => options.targetOperationCommands.runOperation(route.targetOperation, route.number));
    },
    runUpdate: (pullRequestNumber: number) => {
      const route = resolveTargetOperationRoute("update-branch", pullRequestNumber);
      return options.withScheduler(route.identity, () => options.targetOperationCommands.runOperation(route.targetOperation, route.number));
    },
  };
}
