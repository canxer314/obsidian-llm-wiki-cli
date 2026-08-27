import { resolve } from "node:path";

import { createAutomationGithubPort } from "./automation-github.ts";
import { runArchitectureReviewAutomationCommand } from "./architecture-review-automation.ts";
import { createProcessArchitectureReviewRunner } from "./architecture-review-process-runner.ts";
import { runBranchUpdateAutomationCommand } from "./branch-update-automation.ts";
import { createProcessBranchUpdateConflictResolver } from "./branch-update-conflict-process-runner.ts";
import { createProcessBranchUpdater } from "./branch-update-process-runner.ts";
import { createFeedbackImplementationEntry } from "./feedback-implementation-ports.ts";
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

interface TargetOperationInvocation {
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

function parseInvocation(value: string | undefined): TargetOperationInvocation {
  if (value === undefined) throw new Error("Target operation invocation is missing");
  const invocation = JSON.parse(value) as TargetOperationInvocation;
  if (!/^[0-9a-f]{40}$/u.test(invocation.revision) || invocation.jobId.length === 0) {
    throw new Error("Target operation invocation is invalid");
  }
  return invocation;
}

export async function runTargetOperation(
  operation: TargetOperationIdentity,
  argv: readonly string[] = process.argv.slice(2),
): Promise<unknown> {
  const number = Number(argv[0]);
  if ((!Number.isSafeInteger(number) || number < 1) && operation !== "architecture-review") {
    throw new Error("Target operation Work Item number is invalid");
  }
  const invocation = parseInvocation(argv[1]);
  const checkoutPath = resolve(import.meta.dirname, "..");
  const startupInput = await readTargetOperationStartup();
  const startup = startupInput.snapshot;
  const rawGithub = createAutomationGithubPort({ environment: startup.childEnvironments.github });
  const github = createManagedOperationGithub(
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
    return runImplementationAutomationCommand({ issueNumber: number }, {
      github,
      checkout,
      implementer: createProcessImplementer({
        startup: targetWorkerStartup(startup, "github-agent-with-cli"),
        plannerModel: startup.models.planner,
        implementerModel: startup.models.implementer,
      }),
      lease,
      createJobId,
    });
  }
  if (operation === "implement-prd") {
    return runPrdImplementationAutomationCommand({ issueNumber: number }, {
      github,
      pullRequests: github,
      checkout,
      implementer: createProcessPrdImplementer({
        startup: targetWorkerStartup(startup, "github-agent"),
        plannerModel: startup.models.planner,
        implementerModel: startup.models.implementer,
      }),
      lease,
      createJobId,
    });
  }
  if (operation === "implement-feedback") {
    const entry = createFeedbackImplementationEntry(() => ({
      github,
      checkout,
      publisher: createFeedbackPublisher({ gitEnvironment: startup.childEnvironments.git }),
      implementer: createProcessFeedbackImplementer({
        startup: targetWorkerStartup(startup, "github-agent"),
        model: startup.models.implementer,
      }),
      lease,
      createJobId,
    }));
    return invocation.reconcile === undefined
      ? entry.runDispatcher(number)
      : entry.runDirect(number, invocation.reconcile);
  }
  if (operation === "split-prd") {
    return runPrdSplitAutomationCommand({ issueNumber: number }, {
      github,
      checkout,
      splitter: createProcessPrdSplitter({
        startup: targetWorkerStartup(startup, "github-agent"),
        model: startup.models.planner,
      }),
      publisher: github,
      createJobId,
    });
  }
  if (operation === "review") {
    const reviewer = createProcessReviewRunner({
      startup: targetWorkerStartup(startup, "github-agent"),
    });
    const artifactRoot = resolve(checkoutPath, ".sandcastle", "jobs", "review-artifacts");
    return runReviewAutomationCommand({ pullRequestNumber: number }, {
      github,
      checkout,
      reviewer: {
        review: async ({ pullRequestNumber, branch, revision, checkoutPath: path, reviewThreads }) => {
          const artifactDirectory = await createReviewArtifactDirectory({ root: artifactRoot, jobId: invocation.jobId });
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
      publisher: createReviewPublisher({ gitEnvironment: startup.childEnvironments.git }),
      lease,
      createJobId,
    });
  }
  if (operation === "update-branch") {
    return runBranchUpdateAutomationCommand({ pullRequestNumber: number }, {
      github,
      checkout,
      updater: createProcessBranchUpdater({
        environment: startup.childEnvironments.git,
        resolver: createProcessBranchUpdateConflictResolver({
          startup: targetWorkerStartup(startup, "claude-only"),
          model: startup.models.implementer,
        }),
      }),
      lease,
      createJobId,
    });
  }

  const reviewer = createProcessArchitectureReviewRunner({
    startup: targetWorkerStartup(startup, "claude-only"),
  });
  const artifactRoot = resolve(checkoutPath, ".sandcastle", "jobs", "review-artifacts");
  return runArchitectureReviewAutomationCommand({
    github,
    checkout,
    reviewer: {
      review: async ({ revision, checkoutPath: path, priorProposals }) => {
        const artifactDirectory = await createReviewArtifactDirectory({ root: artifactRoot, jobId: invocation.jobId });
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
