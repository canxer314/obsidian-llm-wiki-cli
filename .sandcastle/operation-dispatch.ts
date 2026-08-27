import type { AutomationCommand } from "./automation-command.ts";
import type { QueuePromotionResult } from "./queue-promotion-automation.ts";

// This is the production boundary between generic dispatch scheduling and the
// fixed, independently-owned automation operations. It deliberately owns no
// acquisition or business logic: each operation receives the Work Item number
// only after the Dispatcher has selected and serialized its command.
export interface AutomationOperationDispatchPorts {
  readonly updateBranch: (pullRequestNumber: number) => Promise<unknown>;
  readonly implementFeedback: (pullRequestNumber: number) => Promise<unknown>;
  readonly directFeedback: (pullRequestNumber: number) => Promise<unknown>;
  readonly implementIssue: (issueNumber: number) => Promise<unknown>;
  readonly implementPrd: (issueNumber: number) => Promise<unknown>;
  readonly splitPrd: (issueNumber: number) => Promise<unknown>;
  readonly review: (pullRequestNumber: number) => Promise<unknown>;
  readonly promoteQueue: () => Promise<QueuePromotionResult>;
  readonly architectureReview: () => Promise<unknown>;
}

export function createAutomationOperationDispatch(ports: AutomationOperationDispatchPorts) {
  return {
    async run(command: AutomationCommand): Promise<void> {
      switch (command.operation) {
        case "update-branch":
          await ports.updateBranch(command.number);
          return;
        case "implement":
          await ports.implementFeedback(command.number);
          return;
        case "implement-issue":
          await ports.implementIssue(command.number);
          return;
        case "implement-prd":
          await ports.implementPrd(command.number);
          return;
        case "split-prd":
          await ports.splitPrd(command.number);
          return;
        case "review":
          await ports.review(command.number);
          return;
      }
    },
    promoteQueue: ports.promoteQueue,
    architectureReview: ports.architectureReview,
    updateBranch: ports.updateBranch,
    implementFeedback: ports.implementFeedback,
    directFeedback: ports.directFeedback,
    implementIssue: ports.implementIssue,
    implementPrd: ports.implementPrd,
    splitPrd: ports.splitPrd,
    review: ports.review,
  };
}
