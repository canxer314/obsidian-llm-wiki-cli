import { resolve } from "node:path";

import { createAutomationGithubPort } from "./automation-github.ts";
import { runArchitectureReviewAutomationCommand } from "./architecture-review-automation.ts";
import { createProcessArchitectureReviewRunner } from "./architecture-review-process-runner.ts";
import { runBranchUpdateAutomationCommand } from "./branch-update-automation.ts";
import { createProcessBranchUpdateConflictResolver } from "./branch-update-conflict-process-runner.ts";
import { createProcessBranchUpdater } from "./branch-update-process-runner.ts";
import {
  runFeedbackImplementation,
  type FeedbackReconcileAuthorization,
} from "./feedback-implementation-automation.ts";
import { createProcessFeedbackImplementer } from "./feedback-process-runner.ts";
import { createFeedbackPublisher } from "./feedback-publisher.ts";
import { runImplementationAutomationCommand } from "./implementation-automation.ts";
import { createProcessImplementer } from "./implementation-process-runner.ts";
import { runPrdImplementationAutomationCommand } from "./prd-implementation-automation.ts";
import { createProcessPrdImplementer } from "./prd-implementation-process-runner.ts";
import { runPrdSplitAutomationCommand } from "./prd-split-automation.ts";
import { createProcessPrdSplitter } from "./prd-split-process-runner.ts";
import { createReviewArtifactDirectory } from "./review-artifacts.ts";
import { runReviewAutomationCommand } from "./review-automation.ts";
import { createProcessReviewRunner } from "./review-process-runner.ts";
import { createReviewPublisher } from "./review-publisher.ts";
import { createManagedOperationGithub } from "./target-operation-github.ts";
import {
  readTargetOperationStartup,
  targetWorkerStartup,
} from "./target-operation-startup.ts";
import type { TargetOperationIdentity } from "./target-operation.ts";

interface LabelTriggeredTargetOperationInvocation {
  readonly operation: Exclude<TargetOperationIdentity, "architecture-review">;
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

interface ScheduledArchitectureReviewInvocation {
  readonly operation: "architecture-review";
  readonly revision: string;
  readonly jobId: string;
}

type TargetOperationInvocation =
  | LabelTriggeredTargetOperationInvocation
  | ScheduledArchitectureReviewInvocation;

function parseInvocation(value: string | undefined): TargetOperationInvocation {
  if (value === undefined) throw new Error("Target operation invocation is missing");
  const invocation = JSON.parse(value) as TargetOperationInvocation;
  if (
    !/^[0-9a-f]{40}$/u.test(invocation.revision) ||
    typeof invocation.operation !== "string" ||
    typeof invocation.jobId !== "string" || invocation.jobId.length === 0
  ) {
    throw new Error("Target operation invocation is invalid");
  }
  return invocation;
}

function isAuthorizedScheduledInvocation(invocation: TargetOperationInvocation): boolean {
  return !Object.hasOwn(invocation, "number") &&
    !Object.hasOwn(invocation, "acquired") &&
    !Object.hasOwn(invocation, "pullRequest") &&
    !Object.hasOwn(invocation, "reconcile");
}

function requirePullRequestSecurity(
  operation: TargetOperationIdentity,
  invocation: TargetOperationInvocation,
): void {
  const pullRequestOperation = operation === "implement-feedback" || operation === "review" || operation === "update-branch";
  if (
    pullRequestOperation && (
      !("pullRequest" in invocation) ||
      invocation.pullRequest === undefined ||
      invocation.pullRequest.headSha !== invocation.revision ||
      invocation.pullRequest.baseRepository !== invocation.pullRequest.headRepository
    )
  ) {
    throw new Error("Target Pull Request operation requires an acquired same-repository revision");
  }
}

export interface TargetOperationRuntimeDependencies {
  readonly readStartup: typeof readTargetOperationStartup;
  readonly createGithub: typeof createAutomationGithubPort;
  readonly createManagedGithub: typeof createManagedOperationGithub;
  readonly targetWorkerStartup: typeof targetWorkerStartup;
  readonly runImplementation: typeof runImplementationAutomationCommand;
  readonly createImplementer: typeof createProcessImplementer;
  readonly runPrdImplementation: typeof runPrdImplementationAutomationCommand;
  readonly createPrdImplementer: typeof createProcessPrdImplementer;
  readonly runFeedback: typeof runFeedbackImplementation;
  readonly createFeedbackImplementer: typeof createProcessFeedbackImplementer;
  readonly createFeedbackPublisher: typeof createFeedbackPublisher;
  readonly runSplit: typeof runPrdSplitAutomationCommand;
  readonly createSplitter: typeof createProcessPrdSplitter;
  readonly runReview: typeof runReviewAutomationCommand;
  readonly createReviewRunner: typeof createProcessReviewRunner;
  readonly createReviewPublisher: typeof createReviewPublisher;
  readonly runBranchUpdate: typeof runBranchUpdateAutomationCommand;
  readonly createBranchUpdater: typeof createProcessBranchUpdater;
  readonly createBranchConflictResolver: typeof createProcessBranchUpdateConflictResolver;
  readonly runArchitectureReview: typeof runArchitectureReviewAutomationCommand;
  readonly createArchitectureReviewer: typeof createProcessArchitectureReviewRunner;
  readonly createArtifactDirectory: typeof createReviewArtifactDirectory;
}

const productionDependencies: TargetOperationRuntimeDependencies = {
  readStartup: readTargetOperationStartup,
  createGithub: createAutomationGithubPort,
  createManagedGithub: createManagedOperationGithub,
  targetWorkerStartup,
  runImplementation: runImplementationAutomationCommand,
  createImplementer: createProcessImplementer,
  runPrdImplementation: runPrdImplementationAutomationCommand,
  createPrdImplementer: createProcessPrdImplementer,
  runFeedback: runFeedbackImplementation,
  createFeedbackImplementer: createProcessFeedbackImplementer,
  createFeedbackPublisher,
  runSplit: runPrdSplitAutomationCommand,
  createSplitter: createProcessPrdSplitter,
  runReview: runReviewAutomationCommand,
  createReviewRunner: createProcessReviewRunner,
  createReviewPublisher,
  runBranchUpdate: runBranchUpdateAutomationCommand,
  createBranchUpdater: createProcessBranchUpdater,
  createBranchConflictResolver: createProcessBranchUpdateConflictResolver,
  runArchitectureReview: runArchitectureReviewAutomationCommand,
  createArchitectureReviewer: createProcessArchitectureReviewRunner,
  createArtifactDirectory: createReviewArtifactDirectory,
};

export function targetOperationRuntimeDependencies(
  overrides: Partial<TargetOperationRuntimeDependencies> = {},
): TargetOperationRuntimeDependencies {
  return { ...productionDependencies, ...overrides };
}

export async function runTargetOperation(
  operation: TargetOperationIdentity,
  argv: readonly string[] = process.argv.slice(2),
): Promise<unknown> {
  return runTargetOperationWithDependencies(operation, argv, productionDependencies);
}

export async function runTargetOperationWithDependencies(
  operation: TargetOperationIdentity,
  argv: readonly string[],
  dependencies: TargetOperationRuntimeDependencies,
): Promise<unknown> {
  const [numberArgument, invocationArgument] = operation === "architecture-review"
    ? [undefined, argv[0]]
    : [argv[0], argv[1]];
  const number = Number(numberArgument);
  if (!Number.isSafeInteger(number) || number < 1) {
    if (operation !== "architecture-review") {
      throw new Error("Target operation Work Item number is invalid");
    }
  }
  const invocation = parseInvocation(invocationArgument);
  if (invocation.operation !== operation) {
    throw new Error("Target operation wrapper does not match the authorized invocation");
  }
  if (operation === "architecture-review" && !isAuthorizedScheduledInvocation(invocation)) {
    throw new Error("Target operation invocation is invalid");
  }
  requirePullRequestSecurity(operation, invocation);
  const checkoutPath = resolve(import.meta.dirname, "..");
  const startupInput = await dependencies.readStartup();
  const startup = startupInput.snapshot;
  const rawGithub = dependencies.createGithub({ environment: startup.childEnvironments.github });
  const github = dependencies.createManagedGithub(
    rawGithub as unknown as Record<string, unknown>,
    operation,
    number,
    invocation,
  ) as typeof rawGithub;
  const checkout = {
    async withCheckout<TResult>(
      request: { readonly revision: string },
      action: (path: string) => Promise<TResult>,
    ): Promise<TResult> {
      if (request.revision !== invocation.revision) {
        throw new Error("Target operation requested a revision other than the authorized checkout");
      }
      return action(checkoutPath);
    },
  };
  const lease = { acquire: async () => ({ release: async () => {} }) };
  const createJobId = () => invocation.jobId;

  if (operation === "implement-issue") {
    return dependencies.runImplementation({ issueNumber: number }, {
      github,
      checkout,
      implementer: dependencies.createImplementer({
        startup: dependencies.targetWorkerStartup(startup, "github-agent-with-cli"),
        plannerModel: startup.models.planner,
        implementerModel: startup.models.implementer,
      }),
      lease,
      createJobId,
    });
  }
  if (operation === "implement-prd") {
    return dependencies.runPrdImplementation({ issueNumber: number }, {
      github,
      pullRequests: github,
      checkout,
      implementer: dependencies.createPrdImplementer({
        startup: dependencies.targetWorkerStartup(startup, "github-agent"),
        plannerModel: startup.models.planner,
        implementerModel: startup.models.implementer,
      }),
      lease,
      createJobId,
    });
  }
  if (operation === "implement-feedback") {
    return dependencies.runFeedback({
      pullRequestNumber: number,
      ...(invocation.operation === "architecture-review" || invocation.reconcile === undefined
        ? {}
        : { authorization: invocation.reconcile }),
    }, {
      github,
      checkout,
      publisher: dependencies.createFeedbackPublisher({ gitEnvironment: startup.childEnvironments.git }),
      implementer: dependencies.createFeedbackImplementer({
        startup: dependencies.targetWorkerStartup(startup, "github-agent"),
        model: startup.models.implementer,
      }),
      lease,
      createJobId,
    });
  }
  if (operation === "split-prd") {
    return dependencies.runSplit({ issueNumber: number }, {
      github,
      checkout,
      splitter: dependencies.createSplitter({
        startup: dependencies.targetWorkerStartup(startup, "github-agent"),
        model: startup.models.planner,
      }),
      publisher: github,
      createJobId,
    });
  }
  if (operation === "review") {
    const reviewer = dependencies.createReviewRunner({
      startup: dependencies.targetWorkerStartup(startup, "github-agent"),
    });
    const artifactRoot = resolve(checkoutPath, ".sandcastle", "jobs", "review-artifacts");
    return dependencies.runReview({ pullRequestNumber: number }, {
      github,
      checkout,
      reviewer: {
        review: async ({ pullRequestNumber, branch, revision, checkoutPath: path, reviewThreads }) => {
          const artifactDirectory = await dependencies.createArtifactDirectory({ root: artifactRoot, jobId: invocation.jobId });
          return reviewer.review({
            pullRequestNumber,
            branch,
            revision,
            checkoutPath: path,
            reviewThreads,
            model: startup.models.reviewer,
            artifactDirectory,
          });
        },
      },
      publisher: dependencies.createReviewPublisher({ gitEnvironment: startup.childEnvironments.git }),
      lease,
      createJobId,
    });
  }
  if (operation === "update-branch") {
    return dependencies.runBranchUpdate({ pullRequestNumber: number }, {
      github,
      checkout,
      updater: dependencies.createBranchUpdater({
        environment: startup.childEnvironments.git,
        resolver: dependencies.createBranchConflictResolver({
          startup: dependencies.targetWorkerStartup(startup, "claude-only"),
          model: startup.models.implementer,
        }),
      }),
      lease,
      createJobId,
    });
  }

  const reviewer = dependencies.createArchitectureReviewer({
    startup: dependencies.targetWorkerStartup(startup, "claude-only"),
  });
  const artifactRoot = resolve(checkoutPath, ".sandcastle", "jobs", "review-artifacts");
  return dependencies.runArchitectureReview({
    github,
    checkout,
    reviewer: {
      review: async ({ revision, checkoutPath: path, priorProposals }) => {
        const artifactDirectory = await dependencies.createArtifactDirectory({ root: artifactRoot, jobId: invocation.jobId });
        return reviewer.review({
          revision,
          checkoutPath: path,
          priorProposals,
          model: startup.models.planner,
          artifactDirectory,
        });
      },
    },
    publisher: github,
    createJobId,
  });
}
