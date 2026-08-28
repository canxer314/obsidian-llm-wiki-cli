import type { AutomationCommand } from "./automation-command.ts";
import {
  createTargetOperationCommandRunner,
  type TargetOperationAcquisitionState,
} from "./target-operation-command.ts";
import type {
  AuthorizedTargetOperationInvocation,
  TargetOperationIdentity,
} from "./target-operation.ts";

interface TargetOperationDispatchGithub {
  readBaseRevision(): Promise<string>;
  readPrd(number: number): Promise<{
    readonly state: string;
    readonly labels: readonly string[];
    readonly baseRevision: string;
    readonly parentNumber?: number;
    readonly subIssueCount: number;
  }>;
  readPullRequest(number: number): Promise<{
    readonly state: string;
    readonly labels: readonly string[];
    readonly headSha: string;
    readonly headRefName: string;
    readonly baseRefName: string;
    readonly baseRepository: string;
    readonly headRepository: string;
  }>;
  addIssueLabel(number: number, label: string): Promise<void>;
  removeIssueLabel(number: number, label: string): Promise<void>;
  addPullRequestLabel(number: number, label: string): Promise<void>;
  removePullRequestLabel(number: number, label: string): Promise<void>;
  addRefusalDiagnostic?(
    number: number,
    diagnostic: string,
  ): Promise<void>;
}

function issueOperation(operation: TargetOperationIdentity): boolean {
  return operation === "implement-issue" ||
    operation === "implement-prd" ||
    operation === "split-prd";
}

export function createTargetOperationCommandDispatch(options: {
  readonly github: TargetOperationDispatchGithub;
  readonly target: {
    run(invocation: AuthorizedTargetOperationInvocation): Promise<unknown>;
  };
  readonly createJobId: () => string;
}) {
  const commands = createTargetOperationCommandRunner({
    target: options.target,
    acquisition: {
      read: async (operation, number): Promise<TargetOperationAcquisitionState> => {
        if (operation === "architecture-review") {
          return {
            state: "OPEN",
            labels: [],
            revision: await options.github.readBaseRevision(),
          };
        }
        if (issueOperation(operation)) {
          const issue = await options.github.readPrd(number);
          const routeMatches = issue.parentNumber === undefined && (
            operation === "split-prd" ||
            (operation === "implement-prd"
              ? issue.subIssueCount > 0
              : issue.subIssueCount === 0)
          );
          if (!routeMatches) {
            throw new Error(
              `Issue #${number} no longer matches Target operation ${operation}`,
            );
          }
          return {
            state: issue.state,
            labels: issue.labels,
            revision: issue.baseRevision,
          };
        }
        const pullRequest = await options.github.readPullRequest(number);
        if (pullRequest.baseRepository !== pullRequest.headRepository) {
          throw new Error(
            `Pull Request #${number} must not originate from a fork`,
          );
        }
        return {
          state: pullRequest.state,
          labels: pullRequest.labels,
          revision: pullRequest.headSha,
          pullRequest: {
            headSha: pullRequest.headSha,
            headRefName: pullRequest.headRefName,
            baseRefName: pullRequest.baseRefName,
            baseRepository: pullRequest.baseRepository,
            headRepository: pullRequest.headRepository,
          },
        };
      },
      addInProgress: (operation, number) => issueOperation(operation)
        ? options.github.addIssueLabel(number, "agent:in-progress")
        : options.github.addPullRequestLabel(number, "agent:in-progress"),
      removeTrigger: (operation, number) => {
        const trigger = operation === "split-prd"
          ? "agent:to-issues"
          : operation === "review"
            ? "agent:review"
            : operation === "update-branch"
              ? "agent:update-branch"
              : "agent:implement";
        return issueOperation(operation)
          ? options.github.removeIssueLabel(number, trigger)
          : options.github.removePullRequestLabel(number, trigger);
      },
      addBlocked: (operation, number) => issueOperation(operation)
        ? options.github.addIssueLabel(number, "agent:blocked")
        : options.github.addPullRequestLabel(number, "agent:blocked"),
      addBlockedDiagnostic: async (operation, number, diagnostic) => {
        if (operation === "architecture-review") return;
        await options.github.addRefusalDiagnostic?.(
          number,
          `Automation ${operation} is blocked (job ${diagnostic.jobId}): ${diagnostic.summary}`,
        );
      },
      removeInProgress: (operation, number) => issueOperation(operation)
        ? options.github.removeIssueLabel(number, "agent:in-progress")
        : options.github.removePullRequestLabel(number, "agent:in-progress"),
    },
    createJobId: options.createJobId,
  });

  return {
    runCommand(command: AutomationCommand): Promise<unknown> {
      if (command.operation === "unknown") {
        throw new Error("Inspection-only Automation Command cannot execute");
      }
      const operation: TargetOperationIdentity = command.operation === "implement"
        ? "implement-feedback"
        : command.operation;
      return commands.run(operation, command.number);
    },
    runOperation: commands.run,
  };
}
