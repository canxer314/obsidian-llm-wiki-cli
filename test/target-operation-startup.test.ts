import { Readable } from "node:stream";

import { describe, expect, it } from "vitest";

import {
  runTargetOperationWithDependencies,
  targetOperationRuntimeDependencies,
} from "../.sandcastle/target-operation-runtime.js";
import {
  readTargetOperationStartup,
  readTargetWorkerStartup,
  targetOperationStartupSnapshot,
  targetWorkerStartup,
} from "../.sandcastle/target-operation-startup.js";

const snapshot = {
  imageName: "fixture-image",
  childEnvironments: {
    git: { PATH: "/git" },
    github: { GH_TOKEN: "github-secret" },
    claude: { ANTHROPIC_AUTH_TOKEN: "claude-secret" },
    githubAgent: {
      GH_TOKEN: "github-secret",
      ANTHROPIC_AUTH_TOKEN: "claude-secret",
    },
  },
  models: {
    default: "default-model",
    planner: "planner-model",
    implementer: "implementer-model",
    reviewer: "reviewer-model",
  },
} as const;

describe("Target operation startup", () => {
  it.each([
    ["implement-issue", "github-agent-with-cli", "implementer-model", "implementation"],
    ["implement-prd", "github-agent", "implementer-model", "prd-implementation"],
    ["implement-feedback", "github-agent", "implementer-model", "feedback"],
    ["review", "github-agent", "reviewer-model", "review"],
    ["update-branch", "claude-only", "implementer-model", "branch-update"],
    ["split-prd", "github-agent", "planner-model", "split"],
    ["architecture-review", "claude-only", "planner-model", "architecture-review"],
  ] as const)("composes %s with its %s profile and %s model", async (operation, profile, model, runner) => {
    const events: string[] = [];
    const runtime = targetOperationRuntimeDependencies({
      readStartup: async () => ({ snapshot, serialized: "", githubAgentSandbox: {} as never, automationSandbox: {} as never }),
      createGithub: () => ({} as never),
      targetWorkerStartup: (_snapshot, selectedProfile) => {
        events.push(`profile:${selectedProfile}`);
        return "worker-startup";
      },
      createImplementer: (options) => ({ implement: async () => { events.push(`implementation:${options.implementerModel}`); return {}; } }),
      runImplementation: async (_request, dependencies) => {
        await dependencies.implementer.implement({});
        return { status: "implemented" };
      },
      createPrdImplementer: (options) => ({ implement: async () => { events.push(`prd-implementation:${options.implementerModel}`); return {}; } }),
      runPrdImplementation: async (_request, dependencies) => {
        await dependencies.implementer.implement({});
        return { status: "implemented" };
      },
      createFeedbackImplementer: (options) => ({ implement: async () => { events.push(`feedback:${options.model}`); return {}; } }),
      createFeedbackPublisher: () => ({} as never),
      runFeedback: async (_request, dependencies) => {
        await dependencies.implementer.implement({});
        return { status: "implemented" };
      },
      createSplitter: (options) => ({ split: async () => { events.push(`split:${options.model}`); return []; } }),
      runSplit: async (_request, dependencies) => {
        await dependencies.splitter.split({});
        return { status: "split" };
      },
      createReviewRunner: () => ({ review: async (request) => { events.push(`review:${request.model}`); return {}; } }),
      createReviewPublisher: () => ({} as never),
      runReview: async (_request, dependencies) => {
        await dependencies.reviewer.review({ pullRequestNumber: 219, branch: "branch", revision: "a".repeat(40), checkoutPath: "/target", reviewThreads: [] });
        return { status: "reviewed" };
      },
      createBranchConflictResolver: (options) => { events.push(`branch-update:${options.model}`); return {} as never; },
      createBranchUpdater: () => ({} as never),
      runBranchUpdate: async () => ({ status: "updated" }),
      createArchitectureReviewer: () => ({ review: async (request) => { events.push(`architecture-review:${request.model}`); return {}; } }),
      runArchitectureReview: async (dependencies) => {
        await dependencies.reviewer.review({ revision: "a".repeat(40), checkoutPath: "/target", priorProposals: [] });
        return { status: "proposed" };
      },
      createArtifactDirectory: async () => "/artifacts",
    });
    const invocation = operation === "architecture-review"
      ? { operation, revision: "a".repeat(40), jobId: "scheduled-review" }
      : {
          operation,
          revision: "a".repeat(40),
          jobId: "work-item-job",
          acquired: true,
          ...(operation === "implement-feedback" || operation === "review" || operation === "update-branch"
            ? {
                pullRequest: {
                  headSha: "a".repeat(40),
                  headRefName: "branch",
                  baseRefName: "master",
                  baseRepository: "owner/repository",
                  headRepository: "owner/repository",
                },
              }
            : {}),
        };

    await runTargetOperationWithDependencies(
      operation,
      operation === "architecture-review"
        ? [JSON.stringify(invocation)]
        : ["219", JSON.stringify(invocation)],
      runtime,
    );

    expect(events).toContain(`profile:${profile}`);
    expect(events).toContain(`${runner}:${model}`);
  });

  it("hydrates the trusted round snapshot received through stdin", async () => {
    const startup = await readTargetOperationStartup(
      Readable.from([JSON.stringify(snapshot)]),
    );

    expect(startup.snapshot).toEqual(snapshot);
    expect(startup.serialized).toBe(JSON.stringify(snapshot));
  });

  it("derives purpose-specific descendant worker snapshots", async () => {
    const claudeOnly = targetWorkerStartup(snapshot, "claude-only");
    const githubAgent = targetWorkerStartup(snapshot, "github-agent");
    const implementation = targetWorkerStartup(snapshot, "github-agent-with-cli");

    expect(claudeOnly).toContain("claude-secret");
    expect(claudeOnly).not.toContain("github-secret");
    expect(githubAgent).toContain("github-secret");
    expect(githubAgent).not.toContain("PATH");
    expect(implementation).toContain("githubEnvironment");
    await expect(readTargetWorkerStartup(Readable.from([claudeOnly]))).resolves.toHaveProperty("sandbox");
  });

  it("fails closed instead of reloading private configuration when stdin is empty", async () => {
    await expect(readTargetOperationStartup(Readable.from([]))).rejects.toThrow(
      "Target operation startup snapshot is missing",
    );
  });

  it("requires every purpose-specific environment and model", () => {
    expect(() => targetOperationStartupSnapshot({
      ...snapshot,
      childEnvironments: {
        git: snapshot.childEnvironments.git,
        github: snapshot.childEnvironments.github,
        githubAgent: snapshot.childEnvironments.githubAgent,
      },
    })).toThrow("Target operation startup snapshot is invalid");
    expect(() => targetOperationStartupSnapshot({
      ...snapshot,
      models: { planner: "planner-model" },
    })).toThrow("Target operation startup snapshot is invalid");
  });
});
