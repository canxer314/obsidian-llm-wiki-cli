#!/usr/bin/env node

import { resolve } from "node:path";

import { SandcastleCliError, runSandcastleCli } from "./cli.ts";
import { createDockerLocalQualityHost } from "./docker-local-quality-host.ts";
import { finalizeFailure } from "./failure-finalizer.ts";
import {
  runFailureAwareWorkflow,
  SandcastleWorkflowError,
} from "./failure-workflow.ts";
import { GithubCliPort } from "./github-cli.ts";
import { createSandcastleImplementerSession } from "./implementer-session.ts";
import { implementIssue, repairIssue } from "./implementer.ts";
import { checkPullRequestLocalQuality } from "./local-quality.ts";
import { planIssue, type PlannerOutput } from "./planner.ts";
import {
  processReadyPlan,
  type RepairOrchestratorResult,
} from "./repair-orchestrator.ts";
import { reviewPullRequest } from "./review.ts";
import { createSandcastleReviewerSession } from "./reviewer-session.ts";
import { createSandcastlePlannerSession } from "./planner-session.ts";
import { loadSandboxStartup, sandboxHooks } from "./sandbox.ts";

try {
  const github = new GithubCliPort();
  const result = await runSandcastleCli(process.argv.slice(2), {
    github,
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
    processIssue: async (issueNumber) => runFailureAwareWorkflow<
      PlannerOutput | RepairOrchestratorResult
    >({
      issueNumber,
      github,
      run: async (progress) => {
      progress.enter("startup");
      const startup = await loadSandboxStartup();
      const plannerSession = createSandcastlePlannerSession({
        sandbox: startup.sandbox,
        hooks: sandboxHooks,
      });
      progress.enter("planner");
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
      progress.enter("implementer");
      const implementerSession = createSandcastleImplementerSession({
        sandbox: startup.sandbox,
        hooks: sandboxHooks,
      });
      const pullRequest = await implementIssue({
        plan,
        model: startup.models.implementer,
        session: implementerSession,
        github,
      });
      progress.enter("local-quality", pullRequest);
      const localQualityHostOptions = {
        repositoryPath: resolve(import.meta.dirname, ".."),
        worktreeRoot: resolve(import.meta.dirname, "worktrees"),
        runId: `sandcastle-quality-${issueNumber}`,
        uid: process.getuid?.() ?? 1000,
        gid: process.getgid?.() ?? 1000,
      };
      const reviewerSession = createSandcastleReviewerSession({
        sandbox: startup.sandbox,
        hooks: sandboxHooks,
      });
      const orchestration = await processReadyPlan({
        pullRequest,
        synchronize: (currentPullRequest, allowPush) => {
          progress.enter("target-sync", currentPullRequest);
          return github.synchronizePullRequest(currentPullRequest, allowPush);
        },
        runLocalQuality: (currentPullRequest) => {
          progress.enter("local-quality", currentPullRequest);
          return checkPullRequestLocalQuality(
          currentPullRequest.number,
          github,
          createDockerLocalQualityHost(localQualityHostOptions),
        );
        },
        runReview: (currentPullRequest, localQuality) => {
          progress.enter("reviewer", currentPullRequest);
          return reviewPullRequest({
          pullRequestNumber: currentPullRequest.number,
          revision: currentPullRequest.headSha,
          localQuality,
          model: startup.models.reviewer,
          session: reviewerSession,
          github,
        });
        },
        repair: ({ pullRequest: currentPullRequest, attempt, feedback }) => {
          progress.enter("repair", currentPullRequest);
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
      });
      return {
        result: orchestration,
        pullRequest: orchestration.pullRequest,
        ...(orchestration.terminalFailure === undefined
          ? {}
          : { terminalFailure: orchestration.terminalFailure }),
      };
      },
    }),
  });
  if (result !== undefined) console.log(JSON.stringify(result));
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = error instanceof SandcastleCliError ? error.exitCode : 1;
}
