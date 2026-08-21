#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import { SandcastleCliError, runSandcastleCli } from "./cli.ts";
import { runAutomationCli } from "./automation-cli.ts";
import { createAutomationGithubPort } from "./automation-github.ts";
import { createTargetCheckout } from "./target-checkout.ts";
import { runReviewAutomationCommand } from "./review-automation.ts";
import { createProcessReviewRunner } from "./review-process-runner.ts";
import {
  createReviewArtifactDirectory,
  removeExpiredReviewArtifacts,
} from "./review-artifacts.ts";
import {
  ClaimResourceReleaseAdapter,
  DockerClaimReadAdapter,
  GitClaimReadAdapter,
  GithubClaimReadAdapter,
} from "./claim-reconciliation-adapters.ts";
import {
  inspectClaim,
  resolveClaimInspectionIdentity,
} from "./claim-inspector.ts";
import { createDockerLocalQualityHost } from "./docker-local-quality-host.ts";
import {
  buildSandcastleImage,
  dockerResourceSuffix,
} from "./docker-image.ts";
import {
  createSandcastleEvidenceRecorder,
  recordSandcastleGate,
  recordSandcastleMerge,
  recordSandcastleWorkflow,
} from "./evidence.ts";
import { finalizeFailure } from "./failure-finalizer.ts";
import { finalizeInterruptedClaim } from "./interrupted-claim-finalizer.ts";
import {
  runFailureAwareWorkflow,
  SandcastleWorkflowError,
} from "./failure-workflow.ts";
import { GithubCliPort } from "./github-cli.ts";
import { createFeedbackImplementerSession } from "./feedback-implementer-session.ts";
import { runFeedbackImplementationAutomationCommand } from "./feedback-implementation-automation.ts";
import { createFeedbackPublisher } from "./feedback-publisher.ts";
import { createSandcastleImplementerSession } from "./implementer-session.ts";
import { mergeConflict } from "./conflict-merger.ts";
import { implementIssue, repairIssue } from "./implementer.ts";
import { runImplementationAutomationCommand } from "./implementation-automation.ts";
import { acquireImplementationLease, acquirePullRequestLease } from "./implementation-lease.ts";
import { checkPullRequestLocalQuality } from "./local-quality.ts";
import { mergeVerifiedPullRequest, type MergeVerifiedPullRequestResult } from "./merge.ts";
import { createSandcastleMergerSession } from "./merger-session.ts";
import { planIssue, type PlannerOutput } from "./planner.ts";
import {
  processReadyPlan,
  type RepairOrchestratorResult,
} from "./repair-orchestrator.ts";
import { reviewPullRequest } from "./review.ts";
import { createSandcastleReviewerSession } from "./reviewer-session.ts";
import { createSandcastlePlannerSession } from "./planner-session.ts";
import {
  loadSandboxStartup,
  repairSandboxHooks,
  sandboxHooksFor,
} from "./sandbox.ts";

try {
  const repositoryPath = resolve(import.meta.dirname, "..");
  if (process.argv[2] === "run") {
    const artifactRoot = resolve(import.meta.dirname, "jobs", "review-artifacts");
    await removeExpiredReviewArtifacts({ root: artifactRoot });
    const startup = await loadSandboxStartup();
    const jobId = randomUUID();
    const automationGithub = createAutomationGithubPort({
      environment: startup.childEnvironments.github,
    });
    const github = new GithubCliPort();
    const reviewer = createProcessReviewRunner({});
    const result = await runAutomationCli(process.argv.slice(2), {
      runReview: (pullRequestNumber) => runReviewAutomationCommand({ pullRequestNumber }, {
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
      }),
      runFeedback: (pullRequestNumber) => runFeedbackImplementationAutomationCommand({ pullRequestNumber }, {
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
      }),
      runImplement: (issueNumber) => runImplementationAutomationCommand({ issueNumber }, {
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
      }),
    });
    console.log(JSON.stringify(result));
  } else {
  const github = new GithubCliPort();
  let runtimeImageBuild: Promise<string> | undefined;
  const writeEvent = (event: unknown) => console.error(JSON.stringify({ sandcastleEvidence: event }));
  const evidence = createSandcastleEvidenceRecorder(writeEvent);
  const result = await runSandcastleCli(process.argv.slice(2), {
    github,
    inspectClaim: async (issueNumber, format) => {
      const identity = await resolveClaimInspectionIdentity(repositoryPath);
      await inspectClaim({
        ...identity,
        issueNumber,
        ...(format === undefined ? {} : { format }),
        ports: {
          github: new GithubClaimReadAdapter(),
          git: new GitClaimReadAdapter(repositoryPath),
          docker: new DockerClaimReadAdapter(),
        },
      });
    },
    recordWatchEvent: writeEvent,
    recordInterruption: writeEvent,
    finalizeInterruption: async (receipt) => {
      const identity = await resolveClaimInspectionIdentity(repositoryPath);
      const release = new ClaimResourceReleaseAdapter(repositoryPath);
      const result = await finalizeInterruptedClaim({
        repository: identity.repository,
        receipt,
      }, {
        reconciliation: {
          github: new GithubClaimReadAdapter(),
          git: new GitClaimReadAdapter(repositoryPath),
          docker: new DockerClaimReadAdapter(),
        },
        release: {
          compareAndDeleteLocalBranch: (input) => release.compareAndDeleteLocalBranch(input),
          compareAndDeleteBranch: (input) => github.compareAndDeleteBranch(input),
        },
        failure: github,
      });
      if (result.failures.length > 0) {
        throw new SandcastleWorkflowError("interrupted", result.failures);
      }
    },
    handleFailure: async (issueNumber, stage, error) => {
      const finalization = await finalizeFailure({
        issueNumber,
        stage,
        summary: error instanceof Error ? error.message : String(error),
      }, github);
      if (finalization.failures.length > 0) {
        throw new SandcastleWorkflowError(stage, finalization.failures, { cause: error });
      }
    },
    processIssue: (issueNumber, execution) => recordSandcastleWorkflow(
      evidence,
      execution,
      () => runFailureAwareWorkflow<
        PlannerOutput | RepairOrchestratorResult | MergeVerifiedPullRequestResult
      >({
      issueNumber,
      github,
      run: async (progress) => {
      const enter = (
        stage: Parameters<NonNullable<typeof execution.liveStatus>["transition"]>[0],
        pullRequest?: Parameters<typeof progress.enter>[1],
      ) => {
        progress.enter(stage, pullRequest);
        execution.liveStatus?.transition(stage);
      };
      enter("startup");
      const startup = await loadSandboxStartup();
      runtimeImageBuild ??= buildSandcastleImage({
        repositoryPath: resolve(import.meta.dirname, ".."),
        uid: process.getuid?.() ?? 1000,
        gid: process.getgid?.() ?? 1000,
        environment: startup.proxyEnvironment,
      });
      await runtimeImageBuild;
      const plannerSession = createSandcastlePlannerSession({
        sandbox: startup.sandbox,
        hooks: sandboxHooksFor("planner"),
        evidence,
        execution,
      });
      enter("planner");
      const plan = await planIssue({
        issueNumber,
        model: startup.models.planner,
        session: plannerSession,
      });
      if (plan.status === "blocked") {
        return {
          result: plan,
          terminalFailure: {
            stage: "planner:blocked",
            summary: plan.blockingReason,
          },
        };
      }
      enter("implementer");
      const implementerSession = createSandcastleImplementerSession({
        sandbox: startup.sandbox,
        hooks: sandboxHooksFor("implementer"),
        repairHooks: repairSandboxHooks,
        evidence,
        execution,
      });
      const pullRequest = await implementIssue({
        plan,
        model: startup.models.implementer,
        session: implementerSession,
        github,
      });
      enter("local-quality", pullRequest);
      const localQualityHostOptions = {
        repositoryPath: resolve(import.meta.dirname, ".."),
        worktreeRoot: resolve(import.meta.dirname, "worktrees"),
        runId: `sandcastle-quality-${issueNumber}-${dockerResourceSuffix(
          `${execution.runId}:${execution.batchId}`,
        )}`,
        uid: process.getuid?.() ?? 1000,
        gid: process.getgid?.() ?? 1000,
        environment: startup.proxyEnvironment,
      };
      const reviewerSession = createSandcastleReviewerSession({
        sandbox: startup.sandbox,
        hooks: sandboxHooksFor("reviewer"),
        evidence,
        execution,
      });
      const mergerSession = createSandcastleMergerSession({
        sandbox: startup.sandbox,
        hooks: sandboxHooksFor("merger"),
        evidence,
        execution,
      });
      const orchestration = await processReadyPlan({
        pullRequest,
        synchronize: (currentPullRequest, allowPush) => {
          enter("target-sync", currentPullRequest);
          return github.synchronizePullRequest(currentPullRequest, allowPush);
        },
        runLocalQuality: async (currentPullRequest) => {
          enter("local-quality", currentPullRequest);
          return recordSandcastleGate(
            evidence,
            execution,
            {
              pullRequestNumber: currentPullRequest.number,
              revision: currentPullRequest.headSha,
              context: "sandcastle/local-quality",
            },
            () => checkPullRequestLocalQuality(
              currentPullRequest.number,
              github,
              createDockerLocalQualityHost(localQualityHostOptions),
            ),
          );
        },
        runReview: async (currentPullRequest, localQuality) => {
          enter("reviewer", currentPullRequest);
          return recordSandcastleGate(
            evidence,
            execution,
            {
              pullRequestNumber: currentPullRequest.number,
              revision: currentPullRequest.headSha,
              context: "sandcastle/review",
            },
            () => reviewPullRequest({
              pullRequestNumber: currentPullRequest.number,
              revision: currentPullRequest.headSha,
              localQuality,
              model: startup.models.reviewer,
              session: reviewerSession,
              github,
            }),
          );
        },
        repair: ({ pullRequest: currentPullRequest, attempt, feedback }) => {
          enter("repair", currentPullRequest);
          return repairIssue({
          plan,
          model: startup.models.implementer,
          session: implementerSession,
          github,
          pullRequest: currentPullRequest,
          attempt,
          feedback,
        });
        },
        mergeConflict: (request) => {
          enter("merger", request.pullRequest);
          return mergeConflict({
            issueNumber,
            model: startup.models.implementer,
            session: mergerSession,
            github,
            request,
          });
        },
      });
      if (
        orchestration.terminalFailure !== undefined ||
        orchestration.localQuality.status !== "success" ||
        orchestration.review?.status !== "success"
      ) {
        return {
          result: orchestration,
          pullRequest: orchestration.pullRequest,
          ...(orchestration.terminalFailure === undefined
            ? {}
            : { terminalFailure: orchestration.terminalFailure }),
        };
      }
      enter("merge", orchestration.pullRequest);
      const verifiedReview = orchestration.review;
      const merged = await recordSandcastleMerge(
        evidence,
        execution,
        {
          pullRequestNumber: orchestration.pullRequest.number,
          expectedHeadSha: orchestration.pullRequest.headSha,
        },
        () => mergeVerifiedPullRequest({
          issueNumber,
          pullRequest: orchestration.pullRequest,
          localQuality: orchestration.localQuality,
          review: verifiedReview,
          github,
        }),
      );
      return {
        result: merged,
        pullRequest: orchestration.pullRequest,
      };
      },
    }),
      (workflowResult) => {
        if (!("mergedRevision" in workflowResult)) {
          throw new Error("Successful Sandcastle workflow did not merge a revision");
        }
        return workflowResult.mergedRevision;
      },
    ),
  });
  if (result !== undefined) console.log(JSON.stringify(result));
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = error instanceof SandcastleCliError ? error.exitCode : 1;
}
