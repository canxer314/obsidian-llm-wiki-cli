import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { createProcessArchitectureReviewRunner } from "../.sandcastle/architecture-review-process-runner.js";
import { runArchitectureReviewAutomationCommand } from "../.sandcastle/architecture-review-automation.js";
import { createProcessBranchUpdateConflictResolver } from "../.sandcastle/branch-update-conflict-process-runner.js";
import { createProcessBranchUpdater } from "../.sandcastle/branch-update-process-runner.js";
import { runBranchUpdateAutomationCommand } from "../.sandcastle/branch-update-automation.js";
import { createProcessFeedbackImplementer } from "../.sandcastle/feedback-process-runner.js";
import { createFeedbackPublisher } from "../.sandcastle/feedback-publisher.js";
import { runFeedbackImplementation } from "../.sandcastle/feedback-implementation-automation.js";
import { createProcessImplementer } from "../.sandcastle/implementation-process-runner.js";
import { runImplementationAutomationCommand } from "../.sandcastle/implementation-automation.js";
import { createProcessReviewRunner } from "../.sandcastle/review-process-runner.js";
import { runReviewAutomationCommand } from "../.sandcastle/review-automation.js";
import { createReviewPublisher } from "../.sandcastle/review-publisher.js";
import { createProcessSpecImplementer } from "../.sandcastle/spec-implementation-process-runner.js";
import { runSpecImplementationAutomationCommand } from "../.sandcastle/spec-implementation-automation.js";
import { createProcessSpecSplitter } from "../.sandcastle/spec-split-process-runner.js";
import { runSpecSplitAutomationCommand } from "../.sandcastle/spec-split-automation.js";
import { parseTargetJobInput } from "../.sandcastle/target-job-input.js";
import { parseTargetOperationWorkerInvocation } from "../.sandcastle/target-operation-invocation.js";
import {
  createTargetOperationRunnerWithWorker,
  executeTargetOperationInCheckout,
  targetOperationTimeout,
  type AuthorizedTargetOperationInvocation,
  type TargetOperationIdentity,
} from "../.sandcastle/target-operation.js";
import {
  runTargetOperationWithDependencies,
  targetOperationRuntimeDependencies,
} from "../.sandcastle/target-operation-runtime.js";
import { createTrustedAutomationFixture } from "./trusted-automation-fixture.js";

const REVISION = "a".repeat(40);
const OTHER_REVISION = "b".repeat(40);
const CHECKOUT_PATH = "/delivered/target-checkout";

const OPERATIONS = [
  "implement-issue",
  "implement-spec",
  "implement-feedback",
  "review",
  "update-branch",
  "split-spec",
  "architecture-review",
] as const satisfies readonly TargetOperationIdentity[];

const operationEntries: Readonly<Record<TargetOperationIdentity, string>> = {
  "implement-issue": "implement-issue.ts",
  "implement-spec": "implement-spec.ts",
  "implement-feedback": "implement-pr.ts",
  review: "review-pr.ts",
  "update-branch": "update-branch.ts",
  "split-spec": "split-spec.ts",
  "architecture-review": "architecture-review.ts",
};

const operationStatuses: Readonly<Record<TargetOperationIdentity, string>> = {
  "implement-issue": "implemented",
  "implement-spec": "implemented",
  "implement-feedback": "implemented",
  review: "reviewed",
  "update-branch": "updated",
  "split-spec": "split",
  "architecture-review": "proposed",
};

// Master's whole-job timeouts. The review row is the regression anchor: a
// stale Target Checkout snapshot still caps review at 30 minutes, but the
// trusted automation checkout runs the operation with 90.
const operationTimeouts: Readonly<Record<TargetOperationIdentity, number>> = {
  "implement-issue": 60 * 60 * 1000,
  "implement-spec": 60 * 60 * 1000,
  "implement-feedback": 60 * 60 * 1000,
  review: 90 * 60 * 1000,
  "update-branch": 60 * 60 * 1000,
  "split-spec": 60 * 60 * 1000,
  "architecture-review": 21 * 60 * 1000,
};

const startup = {
  imageName: "fixture-image",
  childEnvironments: {
    git: { GIT_SECRET: "git-secret" },
    github: { GH_TOKEN: "github-secret" },
    claude: {},
    githubAgent: {},
  },
  models: {
    default: "default-model",
    planner: "planner-model",
    implementer: "implementer-model",
    reviewer: "reviewer-model",
  },
} as const;

const pullRequest = {
  headSha: REVISION,
  headRefName: "feature-branch",
  baseRefName: "master",
  baseRepository: "owner/repository",
  headRepository: "owner/repository",
} as const;

function authorizedInvocation(operation: TargetOperationIdentity): AuthorizedTargetOperationInvocation {
  if (operation === "architecture-review") {
    return { operation, revision: REVISION, jobId: `job-${operation}` };
  }
  return {
    operation,
    number: 219,
    revision: REVISION,
    jobId: `job-${operation}`,
    acquired: true,
    ...(operation === "implement-feedback" || operation === "review" || operation === "update-branch"
      ? { pullRequest }
      : {}),
  } as AuthorizedTargetOperationInvocation;
}

function workerArgv(operation: TargetOperationIdentity): readonly string[] {
  const invocation = authorizedInvocation(operation);
  if (operation === "architecture-review") {
    return [JSON.stringify({ ...invocation, checkoutPath: CHECKOUT_PATH })];
  }
  const { number, ...workerInvocation } = invocation as AuthorizedTargetOperationInvocation & {
    readonly number: number;
  };
  return [String(number), JSON.stringify({ ...workerInvocation, checkoutPath: CHECKOUT_PATH })];
}

describe("Target operation trusted-code conformance", () => {
  describe("whole-job runner seam", () => {
    it.each(OPERATIONS)(
      "spawns the %s Target job worker from the trusted .sandcastle with the whole-job timeout",
      async (operation) => {
        const runWorker = vi.fn(async () => ({
          output: JSON.stringify({ status: operationStatuses[operation] }),
          code: 0,
          diagnostics: "",
        }));
        const trustedSandcastleRoot = "/trusted/automation/.sandcastle";
        const checkoutOptions = {
          sourceRepositoryPath: "/trusted/repository",
          gitEnvironment: {},
          dependencyEnvironment: {},
        };
        const runner = createTargetOperationRunnerWithWorker({
          checkoutOptions,
          startup,
          trustedSandcastleRoot,
          start: () => {
            throw new Error("the injected Target job worker handles execution");
          },
        }, runWorker);
        const invocation = authorizedInvocation(operation);

        await expect(runner.run(invocation))
          .resolves.toEqual({ status: operationStatuses[operation] });

        expect(runWorker).toHaveBeenCalledOnce();
        const request = runWorker.mock.calls[0]![0];
        expect(request.workerRoot).toBe(trustedSandcastleRoot);
        expect(request.workerFile).toBe("target-job-worker.ts");
        expect(request.workerName).toBe("Target job");
        expect(request.arguments_).toEqual([]);
        expect(request.timeoutMilliseconds).toBe(operationTimeouts[operation]);
        expect(request.timeoutMilliseconds).toBe(targetOperationTimeout(operation));
        // The operated checkout path never enters the outer envelope; it is
        // injected only when the trusted target-job worker spawns the
        // operation worker (see the checkout-execution seam below).
        const input = parseTargetJobInput(request.input);
        expect(input).toEqual({ checkout: checkoutOptions, startup, invocation });
        expect(request.input).not.toContain("checkoutPath");
      },
    );

    it("defaults the Target job worker root to the running module's own trusted .sandcastle", async () => {
      const runWorker = vi.fn(async () => ({
        output: JSON.stringify({ status: "implemented" }),
        code: 0,
        diagnostics: "",
      }));
      const runner = createTargetOperationRunnerWithWorker({
        checkoutOptions: { sourceRepositoryPath: "/trusted/repository" },
        startup,
        start: () => {
          throw new Error("the injected Target job worker handles execution");
        },
      }, runWorker);

      await expect(runner.run(authorizedInvocation("implement-issue")))
        .resolves.toEqual({ status: "implemented" });

      expect(runWorker.mock.calls[0]![0].workerRoot)
        .toBe(resolve(import.meta.dirname, "../.sandcastle"));
    });
  });

  describe("checkout execution seam", () => {
    let fixtureRoot: string;
    let trustedSandcastleRoot: string;
    const checkoutRoots: string[] = [];

    // The trusted entry records the argv it was spawned with so the test can
    // run the production worker-invocation parser over the real arguments.
    const trustedEntry = [
      'let input = ""; for await (const chunk of process.stdin) input += chunk;',
      "const startup = JSON.parse(input);",
      "const workerArguments = process.argv.slice(2);",
      "const invocation = JSON.parse(workerArguments.length === 1 ? workerArguments[0] : workerArguments[1]);",
      `const statuses = ${JSON.stringify(operationStatuses)};`,
      'console.log(JSON.stringify({ status: statuses[invocation.operation], source: "trusted-operation", imageName: startup.imageName, workerArguments }));',
    ].join("\n");

    beforeAll(async () => {
      fixtureRoot = mkdtempSync(join(tmpdir(), "trusted-code-conformance-fixture-"));
      trustedSandcastleRoot = await createTrustedAutomationFixture(
        fixtureRoot,
        "implement-issue.ts",
        trustedEntry,
      );
      for (const operation of OPERATIONS) {
        if (operation === "implement-issue") continue;
        writeFileSync(
          join(trustedSandcastleRoot, "operations", operationEntries[operation]),
          trustedEntry,
        );
      }
    });

    afterAll(async () => {
      const { rm } = await import("node:fs/promises");
      await rm(fixtureRoot, { recursive: true, force: true });
      await Promise.all(checkoutRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
    });

    it.each(OPERATIONS)(
      "executes %s from the trusted .sandcastle while the delivered checkout snapshot stays inert",
      async (operation) => {
        const checkoutPath = mkdtempSync(join(tmpdir(), `trusted-code-conformance-checkout-${operation}-`));
        checkoutRoots.push(checkoutPath);
        const markerPath = join(checkoutPath, "divergent-code-executed");
        // A deliberately divergent operation entry inside the operated Target
        // Checkout snapshot: if it ever ran, it would leave a marker file and
        // report its own provenance.
        const divergentDirectory = join(checkoutPath, ".sandcastle", "operations");
        mkdirSync(divergentDirectory, { recursive: true });
        writeFileSync(join(divergentDirectory, operationEntries[operation]), [
          'import { writeFileSync } from "node:fs";',
          `writeFileSync(${JSON.stringify(markerPath)}, "divergent checkout code ran\\n");`,
          'console.log(JSON.stringify({ source: "divergent-checkout-snapshot" }));',
        ].join("\n"));
        const withCheckout = vi.fn(async (
          request: { readonly pullRequestNumber?: number; readonly revision: string },
          action: (path: string) => Promise<{
            readonly value: unknown;
            readonly disposition: "cleanup" | "retain";
          }>,
        ) => {
          expect(request).toEqual(operation === "architecture-review"
            ? { revision: REVISION }
            : { pullRequestNumber: 219, revision: REVISION });
          const completion = await action(checkoutPath);
          expect(completion.disposition).toBe("cleanup");
          return completion.value;
        });

        const outcome = await executeTargetOperationInCheckout({
          checkout: { withCheckout },
          startup,
          invocation: authorizedInvocation(operation),
          trustedSandcastleRoot,
        }) as { readonly workerArguments: readonly string[] };

        expect(outcome).toMatchObject({
          status: operationStatuses[operation],
          source: "trusted-operation",
          imageName: startup.imageName,
        });
        expect(outcome).not.toMatchObject({ source: "divergent-checkout-snapshot" });
        expect(existsSync(markerPath)).toBe(false);
        expect(withCheckout).toHaveBeenCalledOnce();

        const parsed = parseTargetOperationWorkerInvocation(operation, outcome.workerArguments);
        expect(parsed.checkoutPath).toBe(checkoutPath);
        expect(parsed.invocation).toEqual({
          ...(() => {
            const invocation = authorizedInvocation(operation) as Record<string, unknown>;
            const { number: _number, ...workerInvocation } = invocation;
            return workerInvocation;
          })(),
          checkoutPath,
        });
        expect(parsed.number).toBe(operation === "architecture-review" ? undefined : 219);
      },
      20_000,
    );
  });

  describe("operation runtime seam", () => {
    const NESTED_FACTORY_NAMES = [
      "createImplementer",
      "createSpecImplementer",
      "createFeedbackImplementer",
      "createFeedbackPublisher",
      "createReviewRunner",
      "createReviewPublisher",
      "createSplitter",
      "createBranchUpdater",
      "createBranchConflictResolver",
      "createArchitectureReviewer",
    ] as const;

    type NestedFactoryName = (typeof NESTED_FACTORY_NAMES)[number];

    interface RuntimeCase {
      readonly operation: TargetOperationIdentity;
      readonly profile: string;
      readonly factories: readonly NestedFactoryName[];
      readonly runCommand:
        | "runImplementation"
        | "runSpecImplementation"
        | "runFeedback"
        | "runSplit"
        | "runReview"
        | "runBranchUpdate"
        | "runArchitectureReview";
      readonly request?: unknown;
      readonly status: string;
    }

    const runtimeCases: readonly RuntimeCase[] = [
      {
        operation: "implement-issue",
        profile: "github-agent-with-cli",
        factories: ["createImplementer"],
        runCommand: "runImplementation",
        request: { issueNumber: 219 },
        status: "implemented",
      },
      {
        operation: "implement-spec",
        profile: "github-agent",
        factories: ["createSpecImplementer"],
        runCommand: "runSpecImplementation",
        request: { issueNumber: 219 },
        status: "implemented",
      },
      {
        operation: "implement-feedback",
        profile: "github-agent",
        factories: ["createFeedbackImplementer", "createFeedbackPublisher"],
        runCommand: "runFeedback",
        request: { pullRequestNumber: 219 },
        status: "implemented",
      },
      {
        operation: "review",
        profile: "github-agent",
        factories: ["createReviewRunner", "createReviewPublisher"],
        runCommand: "runReview",
        request: { pullRequestNumber: 219 },
        status: "reviewed",
      },
      {
        operation: "update-branch",
        profile: "claude-only",
        factories: ["createBranchUpdater", "createBranchConflictResolver"],
        runCommand: "runBranchUpdate",
        request: { pullRequestNumber: 219 },
        status: "updated",
      },
      {
        operation: "split-spec",
        profile: "github-agent",
        factories: ["createSplitter"],
        runCommand: "runSplit",
        request: { issueNumber: 219 },
        status: "split",
      },
      {
        operation: "architecture-review",
        profile: "claude-only",
        factories: ["createArchitectureReviewer"],
        runCommand: "runArchitectureReview",
        status: "proposed",
      },
    ];

    it.each(runtimeCases)(
      "drives $operation through the injected nested workers on the authorized Target Checkout",
      async (runtimeCase) => {
        const events: string[] = [];
        const rawGithub = { raw: "github" };
        const managedGithub = { managed: "github" };
        const instances = Object.fromEntries(NESTED_FACTORY_NAMES.map((name) => [
          name,
          name === "createReviewRunner" || name === "createArchitectureReviewer"
            ? { review: vi.fn(async () => ({})) }
            : { worker: name },
        ])) as Record<NestedFactoryName, unknown>;
        const factories = Object.fromEntries(NESTED_FACTORY_NAMES.map((name) => [
          name,
          vi.fn(() => instances[name]),
        ])) as Record<NestedFactoryName, ReturnType<typeof vi.fn>>;
        const targetWorkerStartupSpy = vi.fn(() => "trusted-worker-startup");
        const createArtifactDirectory = vi.fn(async () => "/artifacts");

        // Every run* stub proves two things before returning its outcome:
        // the checkout seam delivers exactly the authorized Target Checkout
        // path (and fails closed on any other revision), and the nested
        // workers it receives are the injected factory instances.
        const proveCheckout = async (dependencies: {
          readonly checkout: {
            withCheckout<TResult>(
              request: { readonly revision: string },
              action: (path: string) => Promise<TResult>,
            ): Promise<TResult>;
          };
        }): Promise<string> => {
          const delivered = await dependencies.checkout.withCheckout(
            { revision: REVISION },
            async (path) => path,
          );
          events.push(`checkout:${delivered}`);
          await expect(dependencies.checkout.withCheckout(
            { revision: OTHER_REVISION },
            async () => "unreachable",
          )).rejects.toThrow(
            "Target operation requested a revision other than the authorized checkout",
          );
          return delivered;
        };

        const runCommands = {
          runImplementation: vi.fn(async (request: unknown, dependencies: never) => {
            const dependencies_ = dependencies as {
              github: unknown; checkout: never; implementer: unknown; createJobId: () => string;
            };
            events.push(`run:runImplementation:${JSON.stringify(request)}`);
            expect(dependencies_.github).toBe(managedGithub);
            expect(dependencies_.implementer).toBe(instances.createImplementer);
            await proveCheckout(dependencies_);
            events.push(`job:${dependencies_.createJobId()}`);
            return { status: "implemented" };
          }),
          runSpecImplementation: vi.fn(async (request: unknown, dependencies: never) => {
            const dependencies_ = dependencies as {
              github: unknown; checkout: never; implementer: unknown; createJobId: () => string;
            };
            events.push(`run:runSpecImplementation:${JSON.stringify(request)}`);
            expect(dependencies_.github).toBe(managedGithub);
            expect(dependencies_.implementer).toBe(instances.createSpecImplementer);
            await proveCheckout(dependencies_);
            events.push(`job:${dependencies_.createJobId()}`);
            return { status: "implemented" };
          }),
          runFeedback: vi.fn(async (request: unknown, dependencies: never) => {
            const dependencies_ = dependencies as {
              github: unknown; checkout: never; implementer: unknown; publisher: unknown;
              createJobId: () => string;
            };
            events.push(`run:runFeedback:${JSON.stringify(request)}`);
            expect(dependencies_.github).toBe(managedGithub);
            expect(dependencies_.implementer).toBe(instances.createFeedbackImplementer);
            expect(dependencies_.publisher).toBe(instances.createFeedbackPublisher);
            await proveCheckout(dependencies_);
            events.push(`job:${dependencies_.createJobId()}`);
            return { status: "implemented" };
          }),
          runSplit: vi.fn(async (request: unknown, dependencies: never) => {
            const dependencies_ = dependencies as {
              github: unknown; checkout: never; splitter: unknown; publisher: unknown;
              createJobId: () => string;
            };
            events.push(`run:runSplit:${JSON.stringify(request)}`);
            expect(dependencies_.github).toBe(managedGithub);
            expect(dependencies_.splitter).toBe(instances.createSplitter);
            expect(dependencies_.publisher).toBe(managedGithub);
            await proveCheckout(dependencies_);
            events.push(`job:${dependencies_.createJobId()}`);
            return { status: "split" };
          }),
          runReview: vi.fn(async (request: unknown, dependencies: never) => {
            const dependencies_ = dependencies as {
              github: unknown;
              checkout: never;
              reviewer: { review: (request: Record<string, unknown>) => Promise<unknown> };
              publisher: unknown;
              createJobId: () => string;
            };
            events.push(`run:runReview:${JSON.stringify(request)}`);
            expect(dependencies_.github).toBe(managedGithub);
            expect(dependencies_.publisher).toBe(instances.createReviewPublisher);
            const delivered = await proveCheckout(dependencies_);
            await dependencies_.reviewer.review({
              pullRequestNumber: 219,
              branch: "feature-branch",
              revision: REVISION,
              checkoutPath: delivered,
              reviewThreads: [],
            });
            events.push(`job:${dependencies_.createJobId()}`);
            return { status: "reviewed" };
          }),
          runBranchUpdate: vi.fn(async (request: unknown, dependencies: never) => {
            const dependencies_ = dependencies as {
              github: unknown; checkout: never; updater: unknown; createJobId: () => string;
            };
            events.push(`run:runBranchUpdate:${JSON.stringify(request)}`);
            expect(dependencies_.github).toBe(managedGithub);
            expect(dependencies_.updater).toBe(instances.createBranchUpdater);
            await proveCheckout(dependencies_);
            events.push(`job:${dependencies_.createJobId()}`);
            return { status: "updated" };
          }),
          runArchitectureReview: vi.fn(async (dependencies: never) => {
            const dependencies_ = dependencies as {
              github: unknown;
              checkout: never;
              reviewer: { review: (request: Record<string, unknown>) => Promise<unknown> };
              publisher: unknown;
              createJobId: () => string;
            };
            events.push("run:runArchitectureReview");
            expect(dependencies_.github).toBe(managedGithub);
            expect(dependencies_.publisher).toBe(managedGithub);
            const delivered = await proveCheckout(dependencies_);
            await dependencies_.reviewer.review({
              revision: REVISION,
              checkoutPath: delivered,
              priorProposals: [],
            });
            events.push(`job:${dependencies_.createJobId()}`);
            return { status: "proposed" };
          }),
        };

        const runtime = targetOperationRuntimeDependencies({
          readStartup: async () => ({
            snapshot: startup,
            serialized: "",
            githubAgentSandbox: {} as never,
            automationSandbox: {} as never,
          }),
          createGithub: vi.fn(() => rawGithub as never),
          createManagedGithub: vi.fn(() => managedGithub as never),
          targetWorkerStartup: targetWorkerStartupSpy as never,
          createArtifactDirectory: createArtifactDirectory as never,
          ...factories,
          ...runCommands,
        } as never);

        await expect(runTargetOperationWithDependencies(
          runtimeCase.operation,
          workerArgv(runtimeCase.operation),
          runtime,
        )).resolves.toEqual({ status: runtimeCase.status });

        // The authorized Target Checkout path is the checkout the run*
        // command operates on, delivered through the checkout seam.
        expect(events).toContain(`checkout:${CHECKOUT_PATH}`);
        expect(events).toContain(`job:job-${runtimeCase.operation}`);
        if (runtimeCase.request !== undefined) {
          expect(events).toContain(
            `run:${runtimeCase.runCommand}:${JSON.stringify(runtimeCase.request)}`,
          );
        }

        // Exactly the operation's own nested worker factories run, each with
        // the trusted worker startup derived through the injected seam.
        for (const name of NESTED_FACTORY_NAMES) {
          if (runtimeCase.factories.includes(name)) {
            expect(factories[name]).toHaveBeenCalledOnce();
          } else {
            expect(factories[name], `${name} must stay unused`).not.toHaveBeenCalled();
          }
        }
        expect(targetWorkerStartupSpy).toHaveBeenCalledWith(startup, runtimeCase.profile);

        if (runtimeCase.operation === "implement-issue") {
          expect(factories.createImplementer).toHaveBeenCalledWith(expect.objectContaining({
            startup: "trusted-worker-startup",
            plannerModel: "planner-model",
            implementerModel: "implementer-model",
          }));
        }
        if (runtimeCase.operation === "implement-spec") {
          expect(factories.createSpecImplementer).toHaveBeenCalledWith(expect.objectContaining({
            startup: "trusted-worker-startup",
            plannerModel: "planner-model",
            implementerModel: "implementer-model",
          }));
        }
        if (runtimeCase.operation === "implement-feedback") {
          expect(factories.createFeedbackImplementer).toHaveBeenCalledWith(expect.objectContaining({
            startup: "trusted-worker-startup",
            model: "implementer-model",
          }));
          expect(factories.createFeedbackPublisher).toHaveBeenCalledWith({
            gitEnvironment: startup.childEnvironments.git,
          });
        }
        if (runtimeCase.operation === "split-spec") {
          expect(factories.createSplitter).toHaveBeenCalledWith(expect.objectContaining({
            startup: "trusted-worker-startup",
            model: "planner-model",
          }));
        }
        if (runtimeCase.operation === "update-branch") {
          expect(factories.createBranchConflictResolver).toHaveBeenCalledWith(expect.objectContaining({
            startup: "trusted-worker-startup",
            model: "implementer-model",
          }));
          expect(factories.createBranchUpdater).toHaveBeenCalledWith({
            environment: startup.childEnvironments.git,
            resolver: instances.createBranchConflictResolver,
          });
        }
        if (runtimeCase.operation === "review" || runtimeCase.operation === "architecture-review") {
          const reviewerFactory = runtimeCase.operation === "review"
            ? "createReviewRunner"
            : "createArchitectureReviewer";
          expect(factories[reviewerFactory]).toHaveBeenCalledWith({
            startup: "trusted-worker-startup",
          });
          // The artifact directory root lives under the authorized Target
          // Checkout, never under a module-derived location.
          expect(createArtifactDirectory).toHaveBeenCalledWith({
            root: join(CHECKOUT_PATH, ".sandcastle", "jobs", "review-artifacts"),
            jobId: `job-${runtimeCase.operation}`,
          });
          const review = (instances[reviewerFactory] as { review: ReturnType<typeof vi.fn> }).review;
          expect(review).toHaveBeenCalledWith(expect.objectContaining({
            checkoutPath: CHECKOUT_PATH,
            model: runtimeCase.operation === "review" ? "reviewer-model" : "planner-model",
            artifactDirectory: "/artifacts",
          }));
        }
        if (runtimeCase.operation === "review") {
          expect(factories.createReviewPublisher).toHaveBeenCalledWith({
            gitEnvironment: startup.childEnvironments.git,
          });
        }
      },
    );

    it("wires master's own operation commands and nested worker factories into the production runtime", () => {
      const production = targetOperationRuntimeDependencies();

      expect(production.runImplementation).toBe(runImplementationAutomationCommand);
      expect(production.createImplementer).toBe(createProcessImplementer);
      expect(production.runSpecImplementation).toBe(runSpecImplementationAutomationCommand);
      expect(production.createSpecImplementer).toBe(createProcessSpecImplementer);
      expect(production.runFeedback).toBe(runFeedbackImplementation);
      expect(production.createFeedbackImplementer).toBe(createProcessFeedbackImplementer);
      expect(production.createFeedbackPublisher).toBe(createFeedbackPublisher);
      expect(production.runSplit).toBe(runSpecSplitAutomationCommand);
      expect(production.createSplitter).toBe(createProcessSpecSplitter);
      expect(production.runReview).toBe(runReviewAutomationCommand);
      expect(production.createReviewRunner).toBe(createProcessReviewRunner);
      expect(production.createReviewPublisher).toBe(createReviewPublisher);
      expect(production.runBranchUpdate).toBe(runBranchUpdateAutomationCommand);
      expect(production.createBranchUpdater).toBe(createProcessBranchUpdater);
      expect(production.createBranchConflictResolver).toBe(createProcessBranchUpdateConflictResolver);
      expect(production.runArchitectureReview).toBe(runArchitectureReviewAutomationCommand);
      expect(production.createArchitectureReviewer).toBe(createProcessArchitectureReviewRunner);
    });
  });

  describe("stale checkout snapshot regression", () => {
    it("runs master's 90-minute review timeout and master review publisher against a divergent snapshot", async () => {
      // A stale/divergent Target Checkout snapshot: its .sandcastle still
      // carries the 30-minute review timeout and the retired form-field
      // review publisher (-f comments[0][path]=..., which GitHub rejects with
      // HTTP 422 whenever a review carries inline comments).
      const snapshotRoot = mkdtempSync(join(tmpdir(), "stale-review-snapshot-"));
      const snapshotSandcastle = join(snapshotRoot, ".sandcastle");
      mkdirSync(join(snapshotSandcastle, "operations"), { recursive: true });
      writeFileSync(join(snapshotSandcastle, "target-operation.ts"), [
        'const targetOperationTimeouts = { review: 30 * 60 * 1000 };',
        "export const stale = targetOperationTimeouts;",
      ].join("\n"));
      writeFileSync(join(snapshotSandcastle, "review-publisher.ts"), [
        'await execute("gh", [',
        '  "api", `repos/{owner}/{repo}/pulls/${number}/reviews`,',
        '  "-f", "event=COMMENT",',
        '  "-f", "comments[0][path]=stale",',
        "]);",
      ].join("\n"));

      try {
        const staleTimeout = readFileSync(join(snapshotSandcastle, "target-operation.ts"), "utf8");
        const stalePublisher = readFileSync(join(snapshotSandcastle, "review-publisher.ts"), "utf8");
        expect(staleTimeout).toContain("30 * 60 * 1000");
        expect(stalePublisher).toContain("comments[0][path]");

        // Master's trusted timeout governs the whole review job even though
        // the delivered snapshot still declares 30 minutes.
        expect(targetOperationTimeout("review")).toBe(90 * 60 * 1000);
        const runWorker = vi.fn(async () => ({
          output: JSON.stringify({ status: "reviewed" }),
          code: 0,
          diagnostics: "",
        }));
        const runner = createTargetOperationRunnerWithWorker({
          checkoutOptions: { sourceRepositoryPath: "/trusted/repository" },
          startup,
          trustedSandcastleRoot: "/trusted/automation/.sandcastle",
          start: () => {
            throw new Error("the injected Target job worker handles execution");
          },
        }, runWorker);
        await expect(runner.run(authorizedInvocation("review")))
          .resolves.toEqual({ status: "reviewed" });
        expect(runWorker.mock.calls[0]![0].timeoutMilliseconds).toBe(90 * 60 * 1000);
        expect(runWorker.mock.calls[0]![0].workerRoot).toBe("/trusted/automation/.sandcastle");

        // Master's review publisher is the version the runtime wires and the
        // version that actually runs: exact-lease git publication, never the
        // snapshot's form-field review body.
        expect(targetOperationRuntimeDependencies().createReviewPublisher)
          .toBe(createReviewPublisher);
        const PUBLISHED_REVISION = "c".repeat(40);
        const REMOTE = "https://github.com/example/repository.git";
        const execute = vi.fn()
          .mockResolvedValueOnce({ stdout: "", stderr: "" })
          .mockResolvedValueOnce({ stdout: "", stderr: "" })
          .mockResolvedValueOnce({ stdout: "", stderr: "" })
          .mockResolvedValueOnce({ stdout: `${REVISION}\n`, stderr: "" })
          .mockResolvedValueOnce({ stdout: `${PUBLISHED_REVISION}\n`, stderr: "" })
          .mockResolvedValueOnce({ stdout: `${REMOTE}\n`, stderr: "" })
          .mockResolvedValueOnce({ stdout: "", stderr: "" });
        const runtime = targetOperationRuntimeDependencies({
          readStartup: async () => ({
            snapshot: startup,
            serialized: "",
            githubAgentSandbox: {} as never,
            automationSandbox: {} as never,
          }),
          createGithub: () => ({} as never),
          createManagedGithub: (github) => github,
          targetWorkerStartup: (() => "trusted-worker-startup") as never,
          createReviewRunner: () => ({ review: async () => ({}) }) as never,
          createReviewPublisher: ((options: { readonly gitEnvironment?: Readonly<Record<string, string>> }) =>
            createReviewPublisher({ ...options, execute })) as never,
          runReview: (async (_request: unknown, dependencies: {
            readonly checkout: {
              withCheckout<TResult>(
                request: { readonly revision: string },
                action: (path: string) => Promise<TResult>,
              ): Promise<TResult>;
            };
            readonly publisher: {
              prepare(checkoutPath: string, branch: string, revision: string): Promise<void>;
              publish(request: {
                readonly checkoutPath: string;
                readonly branch: string;
                readonly expectedRevision: string;
              }): Promise<string>;
            };
          }) => {
            const published = await dependencies.checkout.withCheckout(
              { revision: REVISION },
              async (path) => {
                await dependencies.publisher.prepare(path, "feature-branch", REVISION);
                return dependencies.publisher.publish({
                  checkoutPath: path,
                  branch: "feature-branch",
                  expectedRevision: REVISION,
                });
              },
            );
            return { status: "reviewed", revision: published };
          }) as never,
          createArtifactDirectory: (async () => "/artifacts") as never,
        });

        await expect(runTargetOperationWithDependencies(
          "review",
          workerArgv("review"),
          runtime,
        )).resolves.toEqual({ status: "reviewed", revision: PUBLISHED_REVISION });

        const calls = execute.mock.calls as unknown as readonly (readonly [
          string,
          readonly string[],
          Readonly<Record<string, string>>?,
        ])[];
        // Every git invocation runs under the trusted startup git
        // environment delivered to master's publisher.
        for (const call of calls) {
          expect(call[2]).toBe(startup.childEnvironments.git);
        }
        expect(calls[0]?.slice(0, 2)).toEqual(["git", ["-C", CHECKOUT_PATH, "config", "user.name", "claude-code[bot]"]]);
        expect(calls[2]?.slice(0, 2)).toEqual(["git", ["-C", CHECKOUT_PATH, "checkout", "-B", "feature-branch", REVISION]]);
        expect(calls[6]?.slice(0, 2)).toEqual(["git", [
          "-C", CHECKOUT_PATH, "push", REMOTE,
          `--force-with-lease=refs/heads/feature-branch:${REVISION}`,
          "HEAD:refs/heads/feature-branch",
        ]]);
        for (const call of calls) {
          expect(JSON.stringify(call)).not.toContain("comments[0][path]");
        }
      } finally {
        rmSync(snapshotRoot, { recursive: true, force: true });
      }
    });
  });
});
