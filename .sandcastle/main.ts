#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import { runAutomationCli } from "./automation-cli.ts";
import { createAutomationGithubPort, createAutomationDispatchGithubPort } from "./automation-github.ts";
import { dispatchAutomationCommands } from "./automation-dispatch.ts";
import { runQueuePromotionScan } from "./queue-promotion-automation.ts";
import { inspectAutomationCommands } from "./automation-inspector.ts";
import { createAutomationScheduler } from "./automation-scheduler.ts";
import { createTargetCheckout } from "./target-checkout.ts";
import { runBranchUpdateAutomationCommand } from "./branch-update-automation.ts";
import { createProcessBranchUpdater } from "./branch-update-process-runner.ts";
import {
  ARCHITECTURE_REVIEW_IDENTITY,
  runArchitectureReviewAutomationCommand,
} from "./architecture-review-automation.ts";
import { createProcessArchitectureReviewRunner } from "./architecture-review-process-runner.ts";
import { runReviewAutomationCommand } from "./review-automation.ts";
import { createProcessReviewRunner } from "./review-process-runner.ts";
import {
  createReviewArtifactDirectory,
  removeExpiredReviewArtifacts,
} from "./review-artifacts.ts";
import { GithubCliPort } from "./github-cli.ts";
import { createFeedbackImplementerSession } from "./feedback-implementer-session.ts";
import { runFeedbackImplementationAutomationCommand } from "./feedback-implementation-automation.ts";
import { createFeedbackPublisher } from "./feedback-publisher.ts";
import { createSandcastleImplementerSession } from "./implementer-session.ts";
import { implementIssue } from "./implementer.ts";
import { runImplementationAutomationCommand } from "./implementation-automation.ts";
import { runPrdImplementationAutomationCommand } from "./prd-implementation-automation.ts";
import { runPrdSplitAutomationCommand } from "./prd-split-automation.ts";
import { createSameSessionPrdSplitExtractor } from "./prd-split-extraction.ts";
import { acquireImplementationLease, acquirePullRequestLease } from "./implementation-lease.ts";
import { planIssue } from "./planner.ts";
import { createSandcastlePlannerSession } from "./planner-session.ts";
import {
  loadSandboxStartup,
  sandboxHooksFor,
} from "./sandbox.ts";

try {
  const repositoryPath = resolve(import.meta.dirname, "..");
  const artifactRoot = resolve(import.meta.dirname, "jobs", "review-artifacts");
  if (process.argv[2] !== "inspect") await removeExpiredReviewArtifacts({ root: artifactRoot });
  const startup = await loadSandboxStartup();
  const jobId = randomUUID();
  const automationGithub = createAutomationGithubPort({
    environment: startup.childEnvironments.github,
  });
  const dispatchGithub = createAutomationDispatchGithubPort({
    environment: startup.childEnvironments.github,
  });
  const scheduler = createAutomationScheduler({ repositoryPath });
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
  const github = new GithubCliPort();
  const reviewer = createProcessReviewRunner({});
  const updater = createProcessBranchUpdater({});
  const architectureReviewer = createProcessArchitectureReviewRunner({});
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
    implementer: {
      implement: async ({ issueNumber: currentIssueNumber, baseRevision, checkoutPath }) => {
        const plannerSession = createSandcastlePlannerSession({
          sandbox: startup.automationSandbox,
          hooks: { sandbox: { onSandboxReady: [] } },
          checkoutPath,
        });
        const plan = await planIssue({
          issueNumber: currentIssueNumber,
          model: startup.models.planner,
          session: plannerSession,
        });
        if (plan.status === "blocked") throw new Error(plan.blockingReason);
        const implementerSession = createSandcastleImplementerSession({
          sandbox: startup.automationSandbox,
          hooks: sandboxHooksFor("implementer"),
        });
        const pullRequest = await implementIssue({
          plan,
          model: startup.models.implementer,
          session: implementerSession,
          checkoutPath,
          github,
        });
        if (pullRequest.headSha === baseRevision) {
          throw new Error("Implementer did not advance the authorized base revision");
        }
        return { branch: `sandcastle/issue-${currentIssueNumber}`, pullRequestUrl: pullRequest.url };
      },
    },
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
    implementer: {
      implement: async ({ prdNumber, child, branch, baseRevision, checkoutPath }) => {
        const plannerSession = createSandcastlePlannerSession({
          sandbox: startup.automationSandbox,
          hooks: { sandbox: { onSandboxReady: [] } },
          checkoutPath,
        });
        const plan = await planIssue({
          issueNumber: child.number,
          model: startup.models.planner,
          session: plannerSession,
        });
        if (plan.status === "blocked") throw new Error(plan.blockingReason);
        const implementerSession = createSandcastleImplementerSession({
          sandbox: startup.automationSandbox,
          hooks: sandboxHooksFor("implementer"),
        });
        const result = await implementerSession.run({
          model: startup.models.implementer,
          branch,
          plan,
          checkoutPath,
          parentPrd: { number: prdNumber },
        });
        if (result.branch !== branch) {
          throw new Error(`Implementer used branch ${result.branch}; expected ${branch}`);
        }
        const headSha = result.commits.at(-1)?.sha;
        if (headSha === undefined) throw new Error("Implementer did not create a commit");
        if (headSha === baseRevision) {
          throw new Error("Implementer did not advance the authorized base revision");
        }
        return { branch, headSha };
      },
    },
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
    splitter: {
      split: ({ prdNumber, title, checkoutPath }) => createSameSessionPrdSplitExtractor({
        sandbox: startup.automationSandbox,
        hooks: { sandbox: { onSandboxReady: [] } },
        agentEnvironment: startup.childEnvironments.claude,
      }).split({ prdNumber, title, checkoutPath, model: startup.models.planner }),
    },
    publisher: automationGithub,
    createJobId: () => jobId,
  });
  const result = await runAutomationCli(process.argv.slice(2), {
    runReview: (pullRequestNumber) => withScheduler(`pull-request:${pullRequestNumber}`, () => runReviewAutomationCommand({ pullRequestNumber }, {
      github: automationGithub,
      checkout: createTargetCheckout({
        sourceRepositoryPath: repositoryPath,
        checkoutRoot: resolve(import.meta.dirname, "jobs"),
        gitEnvironment: startup.childEnvironments.git,
        dependencyEnvironment: startup.childEnvironments.dependencies,
      }),
      reviewer: {
        review: async ({ pullRequestNumber: currentPullRequestNumber, revision, checkoutPath }) => {
          const artifactDirectory = await createReviewArtifactDirectory({
            root: artifactRoot,
            jobId,
          });
          return reviewer.review({
            pullRequestNumber: currentPullRequestNumber,
            revision,
            checkoutPath,
            model: startup.models.reviewer,
            artifactDirectory,
          });
        },
      },
      publisher: automationGithub,
      lease: {
        acquire: (currentPullRequestNumber) => acquirePullRequestLease({
          root: resolve(import.meta.dirname, "jobs", "pull-request-leases"),
          pullRequestNumber: currentPullRequestNumber,
        }),
      },
      createJobId: () => jobId,
    })),
    setupLabels: async () => {
      await dispatchGithub.ensureLabels();
      return { status: "labels-ready" } as const;
    },
    architectureReview: () => withScheduler(ARCHITECTURE_REVIEW_IDENTITY, () => runArchitectureReviewAutomationCommand({
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
          const artifactDirectory = await createReviewArtifactDirectory({
            root: artifactRoot,
            jobId,
          });
          return architectureReviewer.review({
            revision,
            checkoutPath,
            priorProposals,
            model: startup.models.planner,
            artifactDirectory,
          });
        },
      },
      publisher: automationGithub,
      createJobId: () => jobId,
    })),
    runUpdate: (pullRequestNumber) => withScheduler(`pull-request:${pullRequestNumber}`, () => runBranchUpdateAutomationCommand({ pullRequestNumber }, {
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
    })),
    runFeedback: (pullRequestNumber) => withScheduler(`pull-request:${pullRequestNumber}`, () => runFeedbackImplementationAutomationCommand({ pullRequestNumber }, {
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
      implementer: {
        implement: async (request) => createFeedbackImplementerSession({
          sandbox: startup.automationSandbox,
          hooks: sandboxHooksFor("implementer"),
        }).run({
          model: startup.models.implementer,
          ...request,
        }),
      },
      lease: {
        acquire: (currentPullRequestNumber) => acquirePullRequestLease({
          root: resolve(import.meta.dirname, "jobs", "pull-request-leases"),
          pullRequestNumber: currentPullRequestNumber,
        }),
      },
      createJobId: () => jobId,
    })),
    dispatch: (concurrency) => dispatchAutomationCommands({
      concurrency: concurrency ?? Number(process.env.SANDCASTLE_DISPATCH_CONCURRENCY ?? "2"),
    }, {
      scheduler,
      github: dispatchGithub,
      promotion: {
        scan: () => runQueuePromotionScan({ github: dispatchGithub }),
      },
      run: async (command) => {
        if (command.operation === "update-branch") {
          await runBranchUpdateAutomationCommand({ pullRequestNumber: command.number }, {
            github: automationGithub,
            checkout: createTargetCheckout({
              sourceRepositoryPath: repositoryPath,
              checkoutRoot: resolve(import.meta.dirname, "jobs"),
              createJobDirectory: () => resolve(import.meta.dirname, "jobs", `branch-update-${jobId}`),
              gitEnvironment: startup.childEnvironments.git,
              dependencyEnvironment: startup.childEnvironments.dependencies,
            }),
            updater,
            createJobId: () => jobId,
          });
          return;
        }
        if (command.operation === "implement") {
          await runFeedbackImplementationAutomationCommand({ pullRequestNumber: command.number }, {
            github: automationGithub,
            checkout: createTargetCheckout({
              sourceRepositoryPath: repositoryPath,
              checkoutRoot: resolve(import.meta.dirname, "jobs"),
              createJobDirectory: () => resolve(import.meta.dirname, "jobs", `feedback-${jobId}`),
              gitEnvironment: startup.childEnvironments.git,
              dependencyEnvironment: startup.childEnvironments.dependencies,
            }),
            publisher: createFeedbackPublisher({ sourceRepositoryPath: repositoryPath, gitEnvironment: startup.childEnvironments.git }),
            implementer: {
              implement: async (request) => createFeedbackImplementerSession({
                sandbox: startup.automationSandbox,
                hooks: sandboxHooksFor("implementer"),
              }).run({ model: startup.models.implementer, ...request }),
            },
            createJobId: () => jobId,
          });
          return;
        }
        if (command.operation === "implement-issue") {
          await runIssueImplementation(command.number);
          return;
        }
        if (command.operation === "implement-prd") {
          await runPrdImplementation(command.number);
          return;
        }
        if (command.operation === "split-prd") {
          await runPrdSplit(command.number);
          return;
        }
        await runReviewAutomationCommand({ pullRequestNumber: command.number }, {
          github: automationGithub,
          checkout: createTargetCheckout({
            sourceRepositoryPath: repositoryPath,
            checkoutRoot: resolve(import.meta.dirname, "jobs"),
            gitEnvironment: startup.childEnvironments.git,
            dependencyEnvironment: startup.childEnvironments.dependencies,
          }),
          reviewer: {
            review: async ({ pullRequestNumber: currentPullRequestNumber, revision, checkoutPath }) => {
              const artifactDirectory = await createReviewArtifactDirectory({ root: artifactRoot, jobId });
              return reviewer.review({ pullRequestNumber: currentPullRequestNumber, revision, checkoutPath, model: startup.models.reviewer, artifactDirectory });
            },
          },
          publisher: automationGithub,
          createJobId: () => jobId,
        });
      },
    }),
    inspect: () => inspectAutomationCommands({ github: dispatchGithub, scheduler }),
    runImplement: (issueNumber) => runIssueImplementation(issueNumber),
    runImplementPrd: (issueNumber) => withScheduler(`prd:${issueNumber}`, () => runPrdImplementation(issueNumber)),
    runSplit: (issueNumber) => runPrdSplit(issueNumber),
  });
  console.log(JSON.stringify(result));
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
}
