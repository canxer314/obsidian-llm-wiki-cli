import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, it, vi } from "vitest";

import {
  createTargetOperationRunnerWithWorker,
  executeTargetOperationInCheckout,
  type AuthorizedTargetOperationInvocation,
} from "../.sandcastle/target-operation.js";
import {
  runTargetOperationWithDependencies,
  targetOperationRuntimeDependencies,
} from "../.sandcastle/target-operation-runtime.js";

const REVISION = "a".repeat(40);
const ISSUE_OPERATIONS = [
  "implement-issue",
  "implement-prd",
  "split-prd",
] as const;
const PULL_REQUEST_OPERATIONS = [
  "implement-feedback",
  "review",
  "update-branch",
] as const;
const NON_FEEDBACK_OPERATIONS = [
  "implement-issue",
  "implement-prd",
  "split-prd",
  "review",
  "update-branch",
] as const;
const LABEL_OPERATIONS = [
  ...ISSUE_OPERATIONS,
  ...PULL_REQUEST_OPERATIONS,
] as const;

const startup = {
  imageName: "fixture-image",
  childEnvironments: { git: {}, github: {}, claude: {}, githubAgent: {} },
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
};

const sideEffectDependencyNames = [
  "readStartup",
  "createGithub",
  "createManagedGithub",
  "targetWorkerStartup",
  "runImplementation",
  "createImplementer",
  "runPrdImplementation",
  "createPrdImplementer",
  "runFeedback",
  "createFeedbackImplementer",
  "createFeedbackPublisher",
  "runSplit",
  "createSplitter",
  "runReview",
  "createReviewRunner",
  "createReviewPublisher",
  "runBranchUpdate",
  "createBranchUpdater",
  "createBranchConflictResolver",
  "runArchitectureReview",
  "createArchitectureReviewer",
  "createArtifactDirectory",
] as const;

function runtimeSpies() {
  const spies = Object.fromEntries(
    sideEffectDependencyNames.map((name) => [name, vi.fn()]),
  ) as Record<(typeof sideEffectDependencyNames)[number], ReturnType<typeof vi.fn>>;
  return {
    runtime: targetOperationRuntimeDependencies(spies as never),
    spies,
  };
}

function labelInvocation(
  operation: (typeof LABEL_OPERATIONS)[number],
  acquired: unknown,
): Record<string, unknown> {
  return {
    operation,
    revision: REVISION,
    jobId: `job-${operation}`,
    ...(acquired === undefined ? {} : { acquired }),
    ...(operation === "implement-feedback" || operation === "review" || operation === "update-branch"
      ? { pullRequest }
      : {}),
  };
}

function outerLabelInvocation(
  operation: (typeof LABEL_OPERATIONS)[number],
  acquired: unknown,
): Record<string, unknown> {
  return {
    ...labelInvocation(operation, acquired),
    number: 219,
  };
}

function expectNoSideEffects(spies: ReturnType<typeof runtimeSpies>["spies"]): void {
  for (const spy of Object.values(spies)) expect(spy).not.toHaveBeenCalled();
}

it.each([
  [
    "implement-issue" as const,
    ["219", JSON.stringify(labelInvocation("implement-issue", true)), "unexpected"],
  ],
  [
    "architecture-review" as const,
    [JSON.stringify({
      operation: "architecture-review",
      revision: REVISION,
      jobId: "scheduled-review",
    }), "unexpected"],
  ],
])(
  "rejects extra serialized arguments for the %s wrapper before runtime construction",
  async (operation, argv) => {
    const { runtime, spies } = runtimeSpies();

    await expect(runTargetOperationWithDependencies(operation, argv, runtime))
      .rejects.toThrow("Target operation invocation is invalid");

    expectNoSideEffects(spies);
  },
);

it.each(["01", "1e0", "+1", " 1"])(
  "rejects non-canonical Work Item argument %s before runtime construction",
  async (numberArgument) => {
    const { runtime, spies } = runtimeSpies();

    await expect(runTargetOperationWithDependencies(
      "implement-issue",
      [numberArgument, JSON.stringify(labelInvocation("implement-issue", true))],
      runtime,
    )).rejects.toThrow("Target operation Work Item number is invalid");

    expectNoSideEffects(spies);
  },
);

it.each([
  [undefined, "Target operation invocation is missing"],
  ["{", "Target operation invocation is invalid"],
  ["null", "Target operation invocation is invalid"],
  ["[]", "Target operation invocation is invalid"],
])(
  "rejects malformed serialized invocation %s before runtime construction",
  async (serialized, message) => {
    const { runtime, spies } = runtimeSpies();

    await expect(runTargetOperationWithDependencies(
      "implement-issue",
      ["219", serialized] as string[],
      runtime,
    )).rejects.toThrow(message);

    expectNoSideEffects(spies);
  },
);

it("preserves fixed wrapper identity rejection before runtime construction", async () => {
  const { runtime, spies } = runtimeSpies();

  await expect(runTargetOperationWithDependencies(
    "implement-issue",
    ["219", JSON.stringify(labelInvocation("review", true))],
    runtime,
  )).rejects.toThrow(
    "Target operation wrapper does not match the authorized invocation",
  );

  expectNoSideEffects(spies);
});

it.each([
  ["number", { number: 219 }],
  ["acquired", { acquired: true }],
  ["pullRequest", { pullRequest }],
  ["reconcile", { reconcile: { invocation: "reconcile" } }],
  ["unexpected", { unexpected: true }],
])(
  "preserves the exact scheduled protocol by rejecting %s before runtime construction",
  async (_caseName, forbidden) => {
    const { runtime, spies } = runtimeSpies();

    await expect(runTargetOperationWithDependencies(
      "architecture-review",
      [JSON.stringify({
        operation: "architecture-review",
        revision: REVISION,
        jobId: "scheduled-review",
        ...forbidden,
      })],
      runtime,
    )).rejects.toThrow("Target operation invocation is invalid");

    expectNoSideEffects(spies);
  },
);

it("allows ordinary and explicitly reconciled feedback invocations", async () => {
  const authorization = {
    invocation: "reconcile" as const,
    baseRevision: "b".repeat(40),
    expectedPost: "c".repeat(40),
    expectedReply: { rootCommentId: "PRRC_root", body: "" },
  };
  const runFeedback = vi.fn(async () => ({ status: "implemented" as const }));
  const runtime = targetOperationRuntimeDependencies({
    readStartup: async () => ({
      snapshot: startup,
      serialized: "",
      githubAgentSandbox: {} as never,
      automationSandbox: {} as never,
    }),
    createGithub: () => ({} as never),
    createManagedGithub: (github) => github as never,
    createFeedbackPublisher: () => ({} as never),
    createFeedbackImplementer: () => ({} as never),
    runFeedback,
  });

  await runTargetOperationWithDependencies(
    "implement-feedback",
    ["219", JSON.stringify(labelInvocation("implement-feedback", true))],
    runtime,
  );
  await runTargetOperationWithDependencies(
    "implement-feedback",
    ["219", JSON.stringify({
      ...labelInvocation("implement-feedback", true),
      reconcile: authorization,
    })],
    runtime,
  );

  expect(runFeedback).toHaveBeenNthCalledWith(
    1,
    { pullRequestNumber: 219 },
    expect.any(Object),
  );
  expect(runFeedback).toHaveBeenNthCalledWith(
    2,
    { pullRequestNumber: 219, authorization },
    expect.any(Object),
  );
});

it("allows the exact scheduled invocation without managed acquisition fields", async () => {
  const runArchitectureReview = vi.fn(async () => ({ status: "proposed" as const }));
  const runtime = targetOperationRuntimeDependencies({
    readStartup: async () => ({
      snapshot: startup,
      serialized: "",
      githubAgentSandbox: {} as never,
      automationSandbox: {} as never,
    }),
    createGithub: () => ({} as never),
    createManagedGithub: (github) => github as never,
    createArchitectureReviewer: () => ({} as never),
    runArchitectureReview,
  });

  await runTargetOperationWithDependencies(
    "architecture-review",
    [JSON.stringify({
      operation: "architecture-review",
      revision: REVISION,
      jobId: "scheduled-review",
    })],
    runtime,
  );

  expect(runArchitectureReview).toHaveBeenCalledOnce();
});

it.each([
  [null, "Target operation requires an authorized invocation"],
  [[], "Target operation requires an authorized invocation"],
  [{}, "Target operation requires an authorized invocation"],
  [{ operation: "unknown", revision: REVISION, jobId: "job" }, "Target operation requires an authorized invocation"],
  [{ operation: "implement-issue", number: 219, revision: REVISION, jobId: "job", acquired: true, unexpected: true }, "Target operation invocation is invalid"],
])(
  "rejects malformed outer invocation %# before checkout, job-log, or worker effects",
  async (invocation, message) => {
    const root = mkdtempSync(join(tmpdir(), "invalid-target-invocation-"));
    const jobLogRoot = join(root, "logs");
    const runWorker = vi.fn();
    const runner = createTargetOperationRunnerWithWorker({
      checkoutOptions: {} as never,
      jobLogRoot,
      startup,
    }, runWorker);
    const withCheckout = vi.fn();

    try {
      await expect(runner.run(invocation as AuthorizedTargetOperationInvocation))
        .rejects.toThrow(message);
      await expect(executeTargetOperationInCheckout({
        checkout: { withCheckout },
        startup,
        invocation: invocation as AuthorizedTargetOperationInvocation,
      })).rejects.toThrow(message);

      expect(runWorker).not.toHaveBeenCalled();
      expect(withCheckout).not.toHaveBeenCalled();
      expect(existsSync(jobLogRoot)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

it.each([
  [
    { operation: "review", number: 219, revision: REVISION, jobId: "invalid-outer-pr", acquired: true, pullRequest: { ...pullRequest, headRefName: "" } },
    "Target Pull Request operation requires an acquired same-repository revision",
  ],
  [
    { operation: "implement-feedback", number: 219, revision: REVISION, jobId: "invalid-outer-reconcile", acquired: true, pullRequest, reconcile: { invocation: "reconcile", expectedPost: "short" } },
    "Target feedback reconciliation authorization is invalid",
  ],
  [
    { operation: "review", number: 219, revision: REVISION, jobId: "invalid-outer-family", acquired: true, pullRequest, reconcile: { invocation: "reconcile" } },
    "Target operation invocation is invalid",
  ],
] as const)(
  "rejects malformed outer authorization before job log or worker: %s",
  async (invocation, message) => {
    const root = mkdtempSync(join(tmpdir(), "invalid-target-authorization-"));
    const jobLogRoot = join(root, "logs");
    const runWorker = vi.fn();
    const runner = createTargetOperationRunnerWithWorker({
      checkoutOptions: {} as never,
      jobLogRoot,
      startup,
    }, runWorker);

    try {
      await expect(runner.run(invocation as AuthorizedTargetOperationInvocation))
        .rejects.toThrow(message);
      expect(runWorker).not.toHaveBeenCalled();
      expect(existsSync(jobLogRoot)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

it.each(LABEL_OPERATIONS)(
  "requires literal acquired execution for outer %s invocations",
  async (operation) => {
    for (const acquired of [undefined, false, null, "true"]) {
      const root = mkdtempSync(join(tmpdir(), "unacquired-target-invocation-"));
      const jobLogRoot = join(root, "logs");
      const runWorker = vi.fn();
      const runner = createTargetOperationRunnerWithWorker({
        checkoutOptions: {} as never,
        jobLogRoot,
        startup,
      }, runWorker);

      try {
        await expect(runner.run(
          outerLabelInvocation(operation, acquired) as AuthorizedTargetOperationInvocation,
        )).rejects.toThrow("Target operation invocation is not acquired");
        expect(runWorker).not.toHaveBeenCalled();
        expect(existsSync(jobLogRoot)).toBe(false);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  },
);

it.each([
  ["null", null],
  ["a primitive", "reconcile"],
  ["an array", []],
  ["an empty object", {}],
  ["a missing invocation kind", { baseRevision: REVISION }],
  ["a wrong invocation kind", { invocation: "ordinary" }],
  ["an invalid base revision", { invocation: "reconcile", baseRevision: "A".repeat(40) }],
  ["an invalid expected post", { invocation: "reconcile", expectedPost: "short" }],
  ["an empty reply", { invocation: "reconcile", expectedReply: {} }],
  ["a partial reply", { invocation: "reconcile", expectedReply: { rootCommentId: "root" } }],
  ["an empty reply root", { invocation: "reconcile", expectedReply: { rootCommentId: "", body: "reply" } }],
  ["a non-string reply body", { invocation: "reconcile", expectedReply: { rootCommentId: "root", body: 1 } }],
  ["an extra authorization field", { invocation: "reconcile", unexpected: true }],
  ["an extra reply field", { invocation: "reconcile", expectedReply: { rootCommentId: "root", body: "reply", unexpected: true } }],
])(
  "rejects feedback reconciliation authorization with %s before runtime construction",
  async (_caseName, reconcile) => {
    const { runtime, spies } = runtimeSpies();

    await expect(runTargetOperationWithDependencies(
      "implement-feedback",
      ["219", JSON.stringify({
        ...labelInvocation("implement-feedback", true),
        reconcile,
      })],
      runtime,
    )).rejects.toThrow(
      "Target feedback reconciliation authorization is invalid",
    );

    expectNoSideEffects(spies);
  },
);

it.each(PULL_REQUEST_OPERATIONS)(
  "validates Pull Request authorization for serialized %s invocations",
  async (operation) => {
    for (const malformedPullRequest of [
      null,
      "pull-request",
      [],
      {},
      { ...pullRequest, headSha: "A".repeat(40) },
      { ...pullRequest, headRefName: "" },
      { ...pullRequest, baseRefName: "" },
      { ...pullRequest, baseRepository: "", headRepository: "" },
      { ...pullRequest, headRepository: "" },
      { ...pullRequest, headRepository: "fork/repository" },
      { ...pullRequest, unexpected: true },
    ]) {
      const { runtime, spies } = runtimeSpies();

      await expect(runTargetOperationWithDependencies(
        operation,
        ["219", JSON.stringify({
          ...labelInvocation(operation, true),
          pullRequest: malformedPullRequest,
        })],
        runtime,
      )).rejects.toThrow(
        "Target Pull Request operation requires an acquired same-repository revision",
      );

      expectNoSideEffects(spies);
    }
  },
);

it.each(ISSUE_OPERATIONS)(
  "rejects Pull Request authorization for serialized %s invocations",
  async (operation) => {
    const { runtime, spies } = runtimeSpies();

    await expect(runTargetOperationWithDependencies(
      operation,
      ["219", JSON.stringify({
        ...labelInvocation(operation, true),
        pullRequest,
      })],
      runtime,
    )).rejects.toThrow("Target operation invocation is invalid");

    expectNoSideEffects(spies);
  },
);

it.each(NON_FEEDBACK_OPERATIONS)(
  "rejects feedback reconciliation authorization for serialized %s invocations",
  async (operation) => {
    const { runtime, spies } = runtimeSpies();

    await expect(runTargetOperationWithDependencies(
      operation,
      ["219", JSON.stringify({
        ...labelInvocation(operation, true),
        reconcile: { invocation: "reconcile" },
      })],
      runtime,
    )).rejects.toThrow("Target operation invocation is invalid");

    expectNoSideEffects(spies);
  },
);

it.each(LABEL_OPERATIONS)(
  "rejects inner Work Item number and unknown fields for serialized %s invocations",
  async (operation) => {
    for (const forbidden of [{ number: 219 }, { unexpected: true }]) {
      const { runtime, spies } = runtimeSpies();

      await expect(runTargetOperationWithDependencies(
        operation,
        ["219", JSON.stringify({
          ...labelInvocation(operation, true),
          ...forbidden,
        })],
        runtime,
      )).rejects.toThrow("Target operation invocation is invalid");

      expectNoSideEffects(spies);
    }
  },
);

it.each(LABEL_OPERATIONS)(
  "requires literal acquired execution for serialized %s invocations",
  async (operation) => {
    for (const acquired of [undefined, false, null, "true"]) {
      const { runtime, spies } = runtimeSpies();

      await expect(runTargetOperationWithDependencies(
        operation,
        ["219", JSON.stringify(labelInvocation(operation, acquired))],
        runtime,
      )).rejects.toThrow("Target operation invocation is not acquired");

      expectNoSideEffects(spies);
    }
  },
);
