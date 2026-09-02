import {
  resolveAutomationCommandRoute,
  resolveTargetOperationRoute,
  type VerifiedAutomationCommandRoute,
} from "./automation-command-route.ts";
import type { AutomationCommand } from "./automation-command.ts";
import {
  createTargetOperationCommandRunner,
  type TargetOperationAcquisitionState,
} from "./target-operation-command.ts";
import type {
  AuthorizedTargetOperationInvocation,
  LabelTriggeredTargetOperationIdentity,
} from "./target-operation.ts";

interface TargetOperationDispatchGithub {
  readBaseRevision(): Promise<string>;
  readSpec(number: number): Promise<{
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

function issueOperation(route: VerifiedAutomationCommandRoute): boolean {
  return route.receiver === "issue";
}

export function createScheduledArchitectureReview(options: {
  readonly github: Pick<TargetOperationDispatchGithub, "readBaseRevision">;
  readonly target: {
    run(invocation: AuthorizedTargetOperationInvocation): Promise<unknown>;
  };
  readonly createJobId: () => string;
}) {
  return {
    async run(): Promise<unknown> {
      const revision = await options.github.readBaseRevision();
      if (!/^[0-9a-f]{40}$/u.test(revision)) {
        throw new Error("Target operation requires a full authorized revision");
      }
      return options.target.run({
        operation: "architecture-review",
        revision,
        jobId: options.createJobId(),
      });
    },
  };
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
        const route = resolveTargetOperationRoute(operation, number);
        if (issueOperation(route)) {
          const issue = await options.github.readSpec(number);
          const routeMatches = issue.parentNumber === undefined && (
            operation === "split-spec" ||
            (operation === "implement-spec"
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
      addInProgress: (operation, number) => {
        const route = resolveTargetOperationRoute(operation, number);
        return issueOperation(route)
          ? options.github.addIssueLabel(route.number, "agent:in-progress")
          : options.github.addPullRequestLabel(route.number, "agent:in-progress");
      },
      removeTrigger: (operation, number) => {
        const route = resolveTargetOperationRoute(operation, number);
        return issueOperation(route)
          ? options.github.removeIssueLabel(route.number, route.trigger)
          : options.github.removePullRequestLabel(route.number, route.trigger);
      },
      addBlocked: (operation, number) => {
        const route = resolveTargetOperationRoute(operation, number);
        return issueOperation(route)
          ? options.github.addIssueLabel(route.number, "agent:blocked")
          : options.github.addPullRequestLabel(route.number, "agent:blocked");
      },
      addBlockedDiagnostic: async (operation, number, diagnostic) => {
        const route = resolveTargetOperationRoute(operation, number);
        await options.github.addRefusalDiagnostic?.(
          route.number,
          `Automation ${route.targetOperation} is blocked (job ${diagnostic.jobId}): ${diagnostic.summary}`,
        );
      },
      removeInProgress: (operation, number) => {
        const route = resolveTargetOperationRoute(operation, number);
        return issueOperation(route)
          ? options.github.removeIssueLabel(route.number, "agent:in-progress")
          : options.github.removePullRequestLabel(route.number, "agent:in-progress");
      },
    },
    createJobId: options.createJobId,
  });

  return {
    runCommand(command: AutomationCommand): Promise<unknown> {
      if (command.operation === "unknown") {
        throw new Error("Inspection-only Automation Command cannot execute");
      }
      const route = resolveAutomationCommandRoute(command.operation, command.number);
      if (command.identity !== route.identity) {
        throw new Error("Automation Command identity is not canonical");
      }
      return commands.run(route.targetOperation, route.number);
    },
    runOperation: commands.run,
  };
}
