#!/usr/bin/env node

import { resolve } from "node:path";

import { SandcastleCliError, runSandcastleCli } from "./cli.ts";
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
import {
  runFailureAwareWorkflow,
  SandcastleWorkflowError,
} from "./failure-workflow.ts";
import { GithubCliPort } from "./github-cli.ts";
import { createSandcastleImplementerSession } from "./implementer-session.ts";
import { mergeConflict } from "./conflict-merger.ts";
import { implementIssue, repairIssue } from "./implementer.ts";
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
  const github = new GithubCliPort();
  let runtimeImageBuild: Promise<string> | undefined;
  const writeEvent = (event: unknown) => console.error(JSON.stringify({ sandcastleEvidence: event }));
  const evidence = createSandcastleEvidenceRecorder(writeEvent);
  const result = await runSandcastleCli(process.argv.slice(2), {
    github,
    recordWatchEvent: writeEvent,
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
      progress.enter("startup");
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
      progress.enter("local-quality", pullRequest);
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
          progress.enter("target-sync", currentPullRequest);
          return github.synchronizePullRequest(currentPullRequest, allowPush);
        },
        runLocalQuality: async (currentPullRequest) => {
          progress.enter("local-quality", currentPullRequest);
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
          progress.enter("reviewer", currentPullRequest);
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
        mergeConflict: (request) => {
          progress.enter("merger", request.pullRequest);
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
      progress.enter("merge", orchestration.pullRequest);
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
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = error instanceof SandcastleCliError ? error.exitCode : 1;
}
