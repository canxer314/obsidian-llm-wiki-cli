#!/usr/bin/env node

import { resolve } from "node:path";

import { SandcastleCliError, runSandcastleCli } from "./cli.ts";
import { createDockerLocalQualityHost } from "./docker-local-quality-host.ts";
import { GithubCliPort } from "./github-cli.ts";
import { createSandcastleImplementerSession } from "./implementer-session.ts";
import { implementIssue, repairIssue } from "./implementer.ts";
import { checkPullRequestLocalQuality } from "./local-quality.ts";
import { processReadyPlan } from "./repair-orchestrator.ts";
import { reviewPullRequest } from "./review.ts";
import { createSandcastleReviewerSession } from "./reviewer-session.ts";
import { createSandcastlePlannerSession } from "./planner-session.ts";
import { planIssue } from "./planner.ts";
import { loadSandboxStartup, sandboxHooks } from "./sandbox.ts";

try {
  const github = new GithubCliPort();
  const result = await runSandcastleCli(process.argv.slice(2), {
    github,
    processIssue: async (issueNumber) => {
      const startup = await loadSandboxStartup();
      const plannerSession = createSandcastlePlannerSession({
        sandbox: startup.sandbox,
        hooks: sandboxHooks,
      });
      const plan = await planIssue({
        issueNumber,
        model: startup.models.planner,
        session: plannerSession,
      });
      if (plan.status === "blocked") return plan;
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
      return processReadyPlan({
        pullRequest,
        runLocalQuality: (currentPullRequest) => checkPullRequestLocalQuality(
          currentPullRequest.number,
          github,
          createDockerLocalQualityHost(localQualityHostOptions),
        ),
        runReview: (currentPullRequest, localQuality) => reviewPullRequest({
          pullRequestNumber: currentPullRequest.number,
          revision: currentPullRequest.headSha,
          localQuality,
          model: startup.models.reviewer,
          session: reviewerSession,
          github,
        }),
        repair: ({ pullRequest: currentPullRequest, attempt, feedback }) => repairIssue({
          plan,
          model: startup.models.implementer,
          session: implementerSession,
          github,
          pullRequest: currentPullRequest,
          attempt,
          feedback,
        }),
      });
    },
  });
  if (result !== undefined) console.log(JSON.stringify(result));
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = error instanceof SandcastleCliError ? error.exitCode : 1;
}
