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
import {
  inspectGithubAgentReadiness,
  githubAgentReadinessRequiredFor,
  requireGithubAgentReadiness,
} from "./github-readiness.ts";
import { runQueuePromotionScan } from "./queue-promotion-automation.ts";
import { inspectAutomationCommands } from "./automation-inspector.ts";
import { createAutomationScheduler } from "./automation-scheduler.ts";
import {
  createInterruptedAutomationRecovery,
  createJobLogEvidenceScanner,
} from "./interrupted-automation-recovery.ts";
import { removeExpiredFailureCheckouts } from "./target-checkout.ts";
import { runSerializedAutomationCommand } from "./serialized-automation-command.ts";
import { createTargetOperationRunner } from "./target-operation.ts";
import {
  createScheduledArchitectureReview,
  createTargetOperationCommandDispatch,
} from "./target-operation-dispatch.ts";
import { createAutomationCliDependencies } from "./automation-target-composition.ts";
import { removeExpiredJobLogs } from "./job-logs.ts";
import { removeExpiredReviewArtifacts } from "./review-artifacts.ts";
import { loadSandboxStartup } from "./sandbox.ts";

try {
  const repositoryPath = resolve(import.meta.dirname, "..");
  const jobsRoot = resolve(import.meta.dirname, "jobs");
  const artifactRoot = resolve(jobsRoot, "review-artifacts");
  const jobLogRoot = resolve(jobsRoot, "logs");
  if (process.argv[2] !== "inspect") {
    await Promise.all([
      removeExpiredReviewArtifacts({ root: artifactRoot }),
      removeExpiredJobLogs({ root: jobLogRoot }),
    ]);
    await removeExpiredFailureCheckouts({
      root: jobsRoot,
      preserve: ["logs", "review-artifacts", "pull-request-leases", "implementation-leases"],
    });
  }
  const startup = await loadSandboxStartup();
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
  const withScheduler = <T>(identity: string, action: () => Promise<T>): Promise<T> =>
    runSerializedAutomationCommand(scheduler, identity, action);
  const targetOperations = createTargetOperationRunner({
    checkoutOptions: {
      sourceRepositoryPath: repositoryPath,
      checkoutRoot: jobsRoot,
      gitEnvironment: startup.childEnvironments.git,
      dependencyEnvironment: startup.childEnvironments.dependencies,
    },
    jobLogRoot,
    startup: {
      imageName: startup.imageName,
      childEnvironments: {
        git: startup.childEnvironments.git,
        github: startup.childEnvironments.github,
        claude: startup.childEnvironments.claude,
        githubAgent: startup.childEnvironments.githubAgent,
      },
      models: startup.models,
    },
  });
  const targetOperationCommands = createTargetOperationCommandDispatch({
    github: automationGithub,
    target: targetOperations,
    createJobId: randomUUID,
  });
  const scheduledArchitectureReview = createScheduledArchitectureReview({
    github: automationGithub,
    target: targetOperations,
    createJobId: randomUUID,
  });
  const runCommand = async (
    command: import("./automation-command.ts").AutomationCommand,
  ): Promise<void> => {
    await targetOperationCommands.runCommand(command);
  };
  const cliDependencies = createAutomationCliDependencies({
    targetOperationCommands,
    withScheduler,
    additionalDependencies: {
      preflight: async (operation: string) => {
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
      setupLabels: async () => {
        await dispatchGithub.ensureLabels();
        return { status: "labels-ready" } as const;
      },
      architectureReview: () => withScheduler(
        "architecture-review",
        () => scheduledArchitectureReview.run(),
      ),
      dispatch: (concurrency: number | undefined) => dispatchAutomationCommands({
        concurrency: concurrency ?? Number(process.env.SANDCASTLE_DISPATCH_CONCURRENCY ?? "2"),
      }, {
        scheduler,
        github: dispatchGithub,
        recovery: createInterruptedAutomationRecovery({
          scheduler,
          evidence: createJobLogEvidenceScanner({ root: jobLogRoot }),
          github: dispatchGithub,
        }),
        readiness: {
          verifyGithubAgentAuthentication: () => requireGithubAgentReadiness({
            image: startup.imageName,
            uid: startup.uid,
            gid: startup.gid,
            environment: startup.childEnvironments.githubAgent,
          }),
        },
        promotion: {
          scan: () => runQueuePromotionScan(
            { github: dispatchGithub },
            { createJobId: randomUUID },
          ),
        },
        run: runCommand,
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
    },
  });
  const result = await runAutomationCli(process.argv.slice(2), cliDependencies);
  console.log(JSON.stringify(result));
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
}
