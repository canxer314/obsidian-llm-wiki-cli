#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import { runAutomationCli } from "./automation-cli.ts";
import {
  buildSandcastleImage,
  requireSandcastleImage,
  sandcastleImageReadiness,
} from "./docker-image.ts";
import { createAutomationGithubPort, createAutomationDispatchGithubPort } from "./automation-github.ts";
import { dispatchAutomationCommands } from "./automation-dispatch.ts";
import { createAutomationOperationDispatch } from "./operation-dispatch.ts";
import {
  inspectGithubAgentReadiness,
  githubAgentReadinessRequiredFor,
  requireGithubAgentReadiness,
} from "./github-readiness.ts";
import { runQueuePromotionScan } from "./queue-promotion-automation.ts";
import { inspectAutomationCommands } from "./automation-inspector.ts";
import { createAutomationScheduler } from "./automation-scheduler.ts";
import { createTargetCheckout, removeExpiredFailureCheckouts } from "./target-checkout.ts";
import { runBranchUpdateAutomationCommand } from "./branch-update-automation.ts";
import { createProcessBranchUpdater } from "./branch-update-process-runner.ts";
import { createProcessBranchUpdateConflictResolver } from "./branch-update-conflict-process-runner.ts";
import {
  ARCHITECTURE_REVIEW_IDENTITY,
  runArchitectureReviewAutomationCommand,
} from "./architecture-review-automation.ts";
import { createProcessArchitectureReviewRunner } from "./architecture-review-process-runner.ts";
import { runReviewAutomationCommand } from "./review-automation.ts";
import { createProcessReviewRunner } from "./review-process-runner.ts";
import { createReviewPublisher } from "./review-publisher.ts";
import {
  createReviewArtifactDirectory,
  removeExpiredReviewArtifacts,
} from "./review-artifacts.ts";
import { createProcessFeedbackImplementer } from "./feedback-process-runner.ts";
import { createFeedbackImplementationEntry } from "./feedback-implementation-ports.ts";
import { createFeedbackPublisher } from "./feedback-publisher.ts";
import { createProcessImplementer } from "./implementation-process-runner.ts";
import { runImplementationAutomationCommand } from "./implementation-automation.ts";
import { createProcessPrdImplementer } from "./prd-implementation-process-runner.ts";
import { runPrdImplementationAutomationCommand } from "./prd-implementation-automation.ts";
import { runPrdSplitAutomationCommand } from "./prd-split-automation.ts";
import { createProcessPrdSplitter } from "./prd-split-process-runner.ts";
import { acquireImplementationLease, acquirePullRequestLease } from "./implementation-lease.ts";
import {
  loadSandboxStartup,
} from "./sandbox.ts";

try {
  const repositoryPath = resolve(import.meta.dirname, "..");
  const jobsRoot = resolve(import.meta.dirname, "jobs");
  const artifactRoot = resolve(jobsRoot, "review-artifacts");
  if (process.argv[2] !== "inspect") {
    await removeExpiredReviewArtifacts({ root: artifactRoot });
    await removeExpiredFailureCheckouts({
      root: jobsRoot,
      preserve: ["review-artifacts", "pull-request-leases", "implementation-leases"],
    });
  }
  const startup = await loadSandboxStartup();
  const jobId = randomUUID();
  const automationGithub = createAutomationGithubPort({
    environment: startup.childEnvironments.github,
  });
  const dispatchGithub = createAutomationDispatchGithubPort({
    environment: startup.childEnvironments.github,
  });
  const scheduler = createAutomationScheduler({
    repositoryPath,
    environment: startup.childEnvironments.git,
  });
  const withScheduler = async <T>(identity: string, action: () => Promise<T>): Promise<T> => {
    const lock = await scheduler.acquire();
    if (lock === undefined) throw new Error("Dispatcher is already running");
    try {
      await scheduler.prepare();
      let result!: T;
      await scheduler.track(identity, async () => {
        result = await action();
      });
      return result;
    } finally {
      await lock.release();
    }
  };
  const reviewer = createProcessReviewRunner({});
  const reviewPublisher = createReviewPublisher({
    sourceRepositoryPath: repositoryPath,
    gitEnvironment: startup.childEnvironments.git,
  });
  const updater = createProcessBranchUpdater({
    environment: startup.childEnvironments.git,
    resolver: createProcessBranchUpdateConflictResolver({ model: startup.models.implementer }),
  });
  const architectureReviewer = createProcessArchitectureReviewRunner({});
  const implementer = createProcessImplementer({
    plannerModel: startup.models.planner,
    implementerModel: startup.models.implementer,
  });
  const prdImplementer = createProcessPrdImplementer({
    plannerModel: startup.models.planner,
    implementerModel: startup.models.implementer,
  });
  const feedbackImplementer = createProcessFeedbackImplementer({ model: startup.models.implementer });
  const feedbackEntry = createFeedbackImplementationEntry((pullRequestNumber) => ({
    github: automationGithub,
    checkout: createTargetCheckout({
      sourceRepositoryPath: repositoryPath,
      checkoutRoot: resolve(import.meta.dirname, "jobs"),
      createJobDirectory: () => resolve(import.meta.dirname, "jobs", `feedback-${jobId}`),
      gitEnvironment: startup.childEnvironments.git,
      dependencyEnvironment: startup.childEnvironments.dependencies,
    }),
    publisher: createFeedbackPublisher({
      sourceRepositoryPath: repositoryPath,
      gitEnvironment: startup.childEnvironments.git,
    }),
    implementer: feedbackImplementer,
    lease: {
      acquire: (currentPullRequestNumber) => acquirePullRequestLease({
        root: resolve(import.meta.dirname, "jobs", "pull-request-leases"),
        pullRequestNumber: currentPullRequestNumber,
      }),
    },
    createJobId: () => jobId,
  }));
  const prdSplitter = createProcessPrdSplitter({ model: startup.models.planner });
  const runIssueImplementation = (issueNumber: number) => runImplementationAutomationCommand({ issueNumber }, {
    github: {
      readIssue: (currentIssueNumber) => automationGithub.readIssue(currentIssueNumber),
      findReusableImplementation: (request) => {
        const findReusableImplementation = automationGithub.findReusableImplementation;
        if (findReusableImplementation === undefined) {
          throw new Error("Implementation Pull Request lookup is unavailable");
        }
        return findReusableImplementation(request);
      },
      publishExistingImplementation: (request) => {
        const publishExistingImplementation = automationGithub.publishExistingImplementation;
        if (publishExistingImplementation === undefined) {
          throw new Error("Implementation Pull Request publication is unavailable");
        }
        return publishExistingImplementation(request);
      },
      addIssueLabel: (currentIssueNumber, label) => automationGithub.addIssueLabel(currentIssueNumber, label),
      removeIssueLabel: (currentIssueNumber, label) => automationGithub.removeIssueLabel(currentIssueNumber, label),
      addRefusalDiagnostic: (currentIssueNumber, reason) => {
        const addRefusalDiagnostic = automationGithub.addRefusalDiagnostic;
        return addRefusalDiagnostic === undefined
          ? Promise.resolve()
          : addRefusalDiagnostic(currentIssueNumber, reason);
      },
      addImplementationBlockedDiagnostic: (currentIssueNumber, diagnostic) => {
        const addImplementationBlockedDiagnostic = automationGithub.addImplementationBlockedDiagnostic;
        return addImplementationBlockedDiagnostic === undefined
          ? Promise.resolve()
          : addImplementationBlockedDiagnostic(currentIssueNumber, diagnostic);
      },
    },
    checkout: createTargetCheckout({
      sourceRepositoryPath: repositoryPath,
      checkoutRoot: resolve(import.meta.dirname, "jobs"),
      createJobDirectory: () => resolve(import.meta.dirname, "jobs", `implementation-${jobId}`),
      gitEnvironment: startup.childEnvironments.git,
      dependencyEnvironment: startup.childEnvironments.dependencies,
    }),
    implementer,
    lease: {
      acquire: (currentIssueNumber) => acquireImplementationLease({
        root: resolve(import.meta.dirname, "jobs", "implementation-leases"),
        issueNumber: currentIssueNumber,
      }),
    },
    createJobId: () => jobId,
  });
  const runPrdImplementation = (issueNumber: number) => runPrdImplementationAutomationCommand({ issueNumber }, {
    github: automationGithub,
    pullRequests: automationGithub,
    checkout: createTargetCheckout({
      sourceRepositoryPath: repositoryPath,
      checkoutRoot: resolve(import.meta.dirname, "jobs"),
      createJobDirectory: () => resolve(import.meta.dirname, "jobs", `prd-implementation-${jobId}`),
      gitEnvironment: startup.childEnvironments.git,
      dependencyEnvironment: startup.childEnvironments.dependencies,
    }),
    implementer: prdImplementer,
    lease: {
      acquire: (currentIssueNumber) => acquireImplementationLease({
        root: resolve(import.meta.dirname, "jobs", "implementation-leases"),
        issueNumber: currentIssueNumber,
      }),
    },
    createJobId: () => jobId,
  });
  const runPrdSplit = (issueNumber: number) => runPrdSplitAutomationCommand({ issueNumber }, {
    github: automationGithub,
    checkout: createTargetCheckout({
      sourceRepositoryPath: repositoryPath,
      checkoutRoot: resolve(import.meta.dirname, "jobs"),
      gitEnvironment: startup.childEnvironments.git,
      dependencyEnvironment: startup.childEnvironments.dependencies,
    }),
    splitter: prdSplitter,
    publisher: automationGithub,
    createJobId: () => jobId,
  });
  const runReview = (pullRequestNumber: number) => runReviewAutomationCommand({ pullRequestNumber }, {
    github: {
      ...automationGithub,
      publishReview: (request) => automationGithub.publishReview(request),
    },
    checkout: createTargetCheckout({
      sourceRepositoryPath: repositoryPath,
      checkoutRoot: resolve(import.meta.dirname, "jobs"),
      gitEnvironment: startup.childEnvironments.git,
      dependencyEnvironment: startup.childEnvironments.dependencies,
    }),
    reviewer: {
      review: async ({ pullRequestNumber: currentPullRequestNumber, branch, revision, checkoutPath, reviewThreads }) => {
        const artifactDirectory = await createReviewArtifactDirectory({ root: artifactRoot, jobId });
        return reviewer.review({ pullRequestNumber: currentPullRequestNumber, branch, revision, checkoutPath, reviewThreads, model: startup.models.reviewer, artifactDirectory });
      },
    },
    publisher: reviewPublisher,
    lease: {
      acquire: (currentPullRequestNumber) => acquirePullRequestLease({
        root: resolve(import.meta.dirname, "jobs", "pull-request-leases"),
        pullRequestNumber: currentPullRequestNumber,
      }),
    },
    createJobId: () => jobId,
  });
  const runBranchUpdate = (pullRequestNumber: number) => runBranchUpdateAutomationCommand({ pullRequestNumber }, {
    github: automationGithub,
    checkout: createTargetCheckout({
      sourceRepositoryPath: repositoryPath,
      checkoutRoot: resolve(import.meta.dirname, "jobs"),
      createJobDirectory: () => resolve(import.meta.dirname, "jobs", `branch-update-${jobId}`),
      gitEnvironment: startup.childEnvironments.git,
      dependencyEnvironment: startup.childEnvironments.dependencies,
    }),
    updater,
    lease: {
      acquire: (currentPullRequestNumber) => acquirePullRequestLease({
        root: resolve(import.meta.dirname, "jobs", "pull-request-leases"),
        pullRequestNumber: currentPullRequestNumber,
      }),
    },
    createJobId: () => jobId,
  });
  const runArchitectureReview = () => runArchitectureReviewAutomationCommand({
    github: automationGithub,
    checkout: createTargetCheckout({
      sourceRepositoryPath: repositoryPath,
      checkoutRoot: resolve(import.meta.dirname, "jobs"),
      createJobDirectory: () => resolve(import.meta.dirname, "jobs", `architecture-review-${jobId}`),
      gitEnvironment: startup.childEnvironments.git,
      dependencyEnvironment: startup.childEnvironments.dependencies,
    }),
    reviewer: {
      review: async ({ revision, checkoutPath, priorProposals }) => {
        const artifactDirectory = await createReviewArtifactDirectory({ root: artifactRoot, jobId });
        return architectureReviewer.review({ revision, checkoutPath, priorProposals, model: startup.models.planner, artifactDirectory });
      },
    },
    publisher: automationGithub,
    createJobId: () => jobId,
  });
  const operationDispatch = createAutomationOperationDispatch({
    updateBranch: runBranchUpdate,
    implementFeedback: (pullRequestNumber) => feedbackEntry.runDispatcher(pullRequestNumber),
    directFeedback: (pullRequestNumber) => feedbackEntry.runDirect(pullRequestNumber),
    implementIssue: runIssueImplementation,
    implementPrd: runPrdImplementation,
    splitPrd: runPrdSplit,
    review: runReview,
    promoteQueue: () => runQueuePromotionScan({ github: dispatchGithub }),
    architectureReview: runArchitectureReview,
  });
  const result = await runAutomationCli(process.argv.slice(2), {
    preflight: async (operation) => {
      await requireSandcastleImage({ image: startup.imageName });
      if (githubAgentReadinessRequiredFor(operation)) {
        await requireGithubAgentReadiness({
          image: startup.imageName,
          uid: startup.uid,
          gid: startup.gid,
          environment: startup.childEnvironments.githubAgent,
        });
      }
    },
    buildImage: async () => {
      await buildSandcastleImage({
        repositoryPath: startup.repositoryPath,
        uid: startup.uid,
        gid: startup.gid,
        environment: startup.proxyEnvironment,
        image: startup.imageName,
      });
      return { status: "image-ready" } as const;
    },
    runReview: (pullRequestNumber) => withScheduler(`pull-request:${pullRequestNumber}`, () => operationDispatch.review(pullRequestNumber)),
    setupLabels: async () => {
      await dispatchGithub.ensureLabels();
      return { status: "labels-ready" } as const;
    },
    architectureReview: () => withScheduler(ARCHITECTURE_REVIEW_IDENTITY, () => operationDispatch.architectureReview()),
    runUpdate: (pullRequestNumber) => withScheduler(`pull-request:${pullRequestNumber}`, () => operationDispatch.updateBranch(pullRequestNumber)),
    runFeedback: (pullRequestNumber, reconcile) => withScheduler(
      `pull-request:${pullRequestNumber}`,
      () => reconcile === undefined
        ? operationDispatch.directFeedback(pullRequestNumber)
        : feedbackEntry.runDirect(pullRequestNumber, reconcile),
    ),
    dispatch: (concurrency) => dispatchAutomationCommands({
      concurrency: concurrency ?? Number(process.env.SANDCASTLE_DISPATCH_CONCURRENCY ?? "2"),
    }, {
      scheduler,
      github: dispatchGithub,
      readiness: {
        verifyGithubAgentAuthentication: () => requireGithubAgentReadiness({
          image: startup.imageName,
          uid: startup.uid,
          gid: startup.gid,
          environment: startup.childEnvironments.githubAgent,
        }),
      },
      promotion: {
        scan: operationDispatch.promoteQueue,
      },
      run: operationDispatch.run,
    }),
    inspect: async () => {
      const readiness = await inspectGithubAgentReadiness({
        image: startup.imageName,
        uid: startup.uid,
        gid: startup.gid,
        environment: startup.childEnvironments.githubAgent,
      });
      const activeJobs = await scheduler.activeJobs();
      const imageReadiness = await sandcastleImageReadiness({ image: startup.imageName });
      if (readiness.githubAgentReadiness !== "ready") {
        return {
          imageReadiness,
          ...readiness,
          commandInspection: "unavailable" as const,
          activeJobs,
        };
      }
      return {
        imageReadiness,
        ...readiness,
        commandInspection: "available" as const,
        ...await inspectAutomationCommands({ github: dispatchGithub, scheduler: { activeJobs: async () => activeJobs } }),
      };
    },
    runImplement: (issueNumber) => withScheduler(`issue:${issueNumber}`, () => operationDispatch.implementIssue(issueNumber)),
    runImplementPrd: (issueNumber) => withScheduler(`prd:${issueNumber}`, () => operationDispatch.implementPrd(issueNumber)),
    runSplit: (issueNumber) => withScheduler(`prd:${issueNumber}`, () => operationDispatch.splitPrd(issueNumber)),
  });
  console.log(JSON.stringify(result));
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
}
