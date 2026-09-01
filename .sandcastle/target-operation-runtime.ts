import { resolve } from "node:path";

import { createAutomationGithubPort } from "./automation-github.ts";
import { runArchitectureReviewAutomationCommand } from "./architecture-review-automation.ts";
import { createProcessArchitectureReviewRunner } from "./architecture-review-process-runner.ts";
import { runBranchUpdateAutomationCommand } from "./branch-update-automation.ts";
import { createProcessBranchUpdateConflictResolver } from "./branch-update-conflict-process-runner.ts";
import { createProcessBranchUpdater } from "./branch-update-process-runner.ts";
import { runFeedbackImplementation } from "./feedback-implementation-automation.ts";
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
import {
  parseTargetOperationWorkerInvocation,
  type TargetOperationIdentity,
} from "./target-operation-invocation.ts";

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
  const { number, invocation } = parseTargetOperationWorkerInvocation(operation, argv);
  const workItemNumber = number as number;
  const checkoutPath = resolve(import.meta.dirname, "..");
  const startupInput = await dependencies.readStartup();
  const startup = startupInput.snapshot;
  const rawGithub = dependencies.createGithub({ environment: startup.childEnvironments.github });
  const github = dependencies.createManagedGithub(
    rawGithub as unknown as Record<string, unknown>,
    operation,
    workItemNumber,
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

  if (invocation.operation === "implement-issue") {
    return dependencies.runImplementation({ issueNumber: workItemNumber }, {
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
  if (invocation.operation === "implement-prd") {
    return dependencies.runPrdImplementation({ issueNumber: workItemNumber }, {
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
  if (invocation.operation === "implement-feedback") {
    return dependencies.runFeedback({
      pullRequestNumber: workItemNumber,
      ...(invocation.reconcile === undefined
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
  if (invocation.operation === "split-prd") {
    return dependencies.runSplit({ issueNumber: workItemNumber }, {
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
  if (invocation.operation === "review") {
    const reviewer = dependencies.createReviewRunner({
      startup: dependencies.targetWorkerStartup(startup, "github-agent"),
    });
    const artifactRoot = resolve(checkoutPath, ".sandcastle", "jobs", "review-artifacts");
    return dependencies.runReview({ pullRequestNumber: workItemNumber }, {
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
  if (invocation.operation === "update-branch") {
    return dependencies.runBranchUpdate({ pullRequestNumber: workItemNumber }, {
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
