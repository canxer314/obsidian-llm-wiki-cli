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
  parseAuthorizedTargetOperationInvocation,
} from "../.sandcastle/target-operation-invocation.js";
import {
  runTargetOperationWithDependencies,
  targetOperationRuntimeDependencies,
} from "../.sandcastle/target-operation-runtime.js";

const REVISION = "a".repeat(40);
const ISSUE_OPERATIONS = [
  "implement-issue",
  "implement-spec",
  "split-spec",
] as const;
const PULL_REQUEST_OPERATIONS = [
  "implement-feedback",
  "review",
  "update-branch",
] as const;
const NON_FEEDBACK_OPERATIONS = [
  "implement-issue",
  "implement-spec",
  "split-spec",
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
  "runSpecImplementation",
  "createSpecImplementer",
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

function defineAccessor(
  value: Record<PropertyKey, unknown>,
  key: PropertyKey,
  get: () => unknown,
): void {
  Object.defineProperty(value, key, {
    configurable: true,
    enumerable: true,
    get,
  });
}

function proxyWithSubstitution<T extends object>(
  target: T,
  substitutions: Readonly<Record<PropertyKey, unknown>>,
): { readonly proxy: T; readonly get: ReturnType<typeof vi.fn> } {
  const get = vi.fn((value: T, key: PropertyKey, receiver: unknown) =>
    Object.hasOwn(substitutions, key)
      ? substitutions[key]
      : Reflect.get(value, key, receiver));
  return {
    proxy: new Proxy(target, { get }),
    get,
  };
}

async function expectOuterInvocationRejected(
  invocation: Record<PropertyKey, unknown>,
  message?: string,
): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "invalid-memory-target-invocation-"));
  const jobLogRoot = join(root, "logs");
  const runWorker = vi.fn(async () => ({
    output: JSON.stringify({ status: "refused", reason: "fixture refusal" }),
    code: 0,
    diagnostics: "",
  }));
  const runner = createTargetOperationRunnerWithWorker({
    checkoutOptions: {} as never,
    jobLogRoot,
    startup,
  }, runWorker);
  const withCheckout = vi.fn();

  try {
    const runnerExpectation = expect(runner.run(
      invocation as AuthorizedTargetOperationInvocation,
    )).rejects;
    const checkoutExpectation = expect(executeTargetOperationInCheckout({
      checkout: { withCheckout },
      startup,
      invocation: invocation as AuthorizedTargetOperationInvocation,
    })).rejects;
    if (message === undefined) {
      await runnerExpectation.toThrow();
      await checkoutExpectation.toThrow();
    } else {
      await runnerExpectation.toThrow(message);
      await checkoutExpectation.toThrow(message);
    }

    expect(runWorker).not.toHaveBeenCalled();
    expect(withCheckout).not.toHaveBeenCalled();
    expect(existsSync(jobLogRoot)).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

async function runOuterInvocation(
  invocation: Record<PropertyKey, unknown>,
): Promise<Record<string, unknown>> {
  const runWorker = vi.fn(async () => ({
    output: JSON.stringify({ status: "refused", reason: "fixture refusal" }),
    code: 0,
    diagnostics: "",
  }));
  const runner = createTargetOperationRunnerWithWorker({
    startup,
    start: () => {
      throw new Error("injected Target worker should handle this invocation");
    },
  }, runWorker);

  await expect(runner.run(invocation as AuthorizedTargetOperationInvocation))
    .resolves.toEqual({ status: "refused", reason: "fixture refusal" });
  const input = JSON.parse(runWorker.mock.calls[0]![0].input) as {
    invocation: Record<string, unknown>;
  };
  return input.invocation;
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
  ["operation", "Target operation requires an authorized invocation", () => {
    const invocation = outerLabelInvocation("implement-issue", true);
    const get = vi.fn()
      .mockReturnValueOnce("implement-issue")
      .mockReturnValueOnce("review");
    defineAccessor(invocation, "operation", get);
    return { invocation, get };
  }],
  ["number", "Target operation Work Item number is invalid", () => {
    const invocation = outerLabelInvocation("implement-issue", true);
    const get = vi.fn(() => 219);
    defineAccessor(invocation, "number", get);
    return { invocation, get };
  }],
  ["revision", "Target operation requires an authorized invocation", () => {
    const invocation = outerLabelInvocation("implement-issue", true);
    const get = vi.fn()
      .mockReturnValueOnce(REVISION)
      .mockReturnValueOnce("b".repeat(40));
    defineAccessor(invocation, "revision", get);
    return { invocation, get };
  }],
  ["jobId", "Target operation requires an authorized invocation", () => {
    const invocation = outerLabelInvocation("implement-issue", true);
    const get = vi.fn(() => "accessor-job");
    defineAccessor(invocation, "jobId", get);
    return { invocation, get };
  }],
  ["acquired", "Target operation invocation is not acquired", () => {
    const invocation = outerLabelInvocation("implement-issue", true);
    const get = vi.fn(() => true);
    defineAccessor(invocation, "acquired", get);
    return { invocation, get };
  }],
] as const)(
  "rejects an accessor-backed outer %s before checkout, job-log, or worker effects",
  async (_field, message, createCase) => {
    const { invocation, get } = createCase();

    await expectOuterInvocationRejected(invocation, message);

    expect(get).not.toHaveBeenCalled();
  },
);

it.each([
  ["pullRequest", () => {
    const invocation = outerLabelInvocation("review", true);
    const get = vi.fn(() => pullRequest);
    defineAccessor(invocation, "pullRequest", get);
    return { invocation, get };
  }],
  ...(["headSha", "headRefName", "baseRefName", "baseRepository", "headRepository"] as const)
    .map((field) => [field, () => {
      const authorization = { ...pullRequest };
      const authorizedValue = authorization[field];
      const get = vi.fn(() => authorizedValue);
      defineAccessor(authorization, field, get);
      return {
        invocation: {
          ...outerLabelInvocation("review", true),
          pullRequest: authorization,
        },
        get,
      };
    }] as const),
] as const)(
  "rejects accessor-backed Pull Request authorization field %s before effects",
  async (_field, createCase) => {
    const { invocation, get } = createCase();

    await expectOuterInvocationRejected(
      invocation,
      "Target Pull Request operation requires an acquired same-repository revision",
    );

    expect(get).not.toHaveBeenCalled();
  },
);

it.each([
  ["reconcile", () => {
    const invocation = {
      ...outerLabelInvocation("implement-feedback", true),
      reconcile: { invocation: "reconcile" },
    };
    const get = vi.fn(() => ({ invocation: "reconcile" }));
    defineAccessor(invocation, "reconcile", get);
    return { invocation, get };
  }],
  ...(["baseRevision", "expectedPost"] as const).map((field) => [field, () => {
    const reconcile = {
      invocation: "reconcile",
      [field]: REVISION,
    };
    const get = vi.fn(() => REVISION);
    defineAccessor(reconcile, field, get);
    return {
      invocation: {
        ...outerLabelInvocation("implement-feedback", true),
        reconcile,
      },
      get,
    };
  }] as const),
  ["expectedReply", () => {
    const authorizedReply = { rootCommentId: "PRRC_root", body: "reply" };
    const reconcile: Record<string, unknown> = {
      invocation: "reconcile",
      expectedReply: authorizedReply,
    };
    const get = vi.fn(() => authorizedReply);
    defineAccessor(reconcile, "expectedReply", get);
    return {
      invocation: {
        ...outerLabelInvocation("implement-feedback", true),
        reconcile,
      },
      get,
    };
  }],
  ...(["rootCommentId", "body"] as const).map((field) => [field, () => {
    const expectedReply = { rootCommentId: "PRRC_root", body: "reply" };
    const authorizedValue = expectedReply[field];
    const get = vi.fn(() => authorizedValue);
    defineAccessor(expectedReply, field, get);
    return {
      invocation: {
        ...outerLabelInvocation("implement-feedback", true),
        reconcile: { invocation: "reconcile", expectedReply },
      },
      get,
    };
  }] as const),
] as const)(
  "rejects accessor-backed reconciliation authorization field %s before effects",
  async (_field, createCase) => {
    const { invocation, get } = createCase();

    await expectOuterInvocationRejected(
      invocation,
      "Target feedback reconciliation authorization is invalid",
    );

    expect(get).not.toHaveBeenCalled();
  },
);

it("binds Proxy-backed authorization to one recursive descriptor snapshot", async () => {
  const reply = proxyWithSubstitution(
    { rootCommentId: "PRRC_root", body: "authorized reply" },
    { rootCommentId: "PRRC_other", body: "substituted reply" },
  );
  const reconcile = proxyWithSubstitution({
    invocation: "reconcile" as const,
    baseRevision: "b".repeat(40),
    expectedPost: "c".repeat(40),
    expectedReply: reply.proxy,
  }, {
    invocation: "ordinary",
    baseRevision: "d".repeat(40),
    expectedPost: "e".repeat(40),
    expectedReply: { rootCommentId: "PRRC_other", body: "substituted reply" },
  });
  const pullRequestAuthorization = proxyWithSubstitution({ ...pullRequest }, {
    headSha: "f".repeat(40),
    headRefName: "substituted-head",
    baseRefName: "substituted-base",
    baseRepository: "other/base",
    headRepository: "other/head",
  });
  const invocation = proxyWithSubstitution({
    ...outerLabelInvocation("implement-feedback", true),
    pullRequest: pullRequestAuthorization.proxy,
    reconcile: reconcile.proxy,
  }, {
    operation: "review",
    number: 220,
    revision: "f".repeat(40),
    jobId: "substituted-job",
    acquired: false,
    pullRequest: { ...pullRequest, headSha: "f".repeat(40) },
    reconcile: { invocation: "ordinary" },
  });

  await expect(runOuterInvocation(invocation.proxy)).resolves.toEqual({
    ...outerLabelInvocation("implement-feedback", true),
    pullRequest,
    reconcile: {
      invocation: "reconcile",
      baseRevision: "b".repeat(40),
      expectedPost: "c".repeat(40),
      expectedReply: { rootCommentId: "PRRC_root", body: "authorized reply" },
    },
  });
  expect(invocation.get).not.toHaveBeenCalled();
  expect(pullRequestAuthorization.get).not.toHaveBeenCalled();
  expect(reconcile.get).not.toHaveBeenCalled();
  expect(reply.get).not.toHaveBeenCalled();
});

it("binds a Proxy-backed issue operation family to its descriptor snapshot", async () => {
  const invocation = proxyWithSubstitution(
    outerLabelInvocation("implement-issue", true),
    {
      operation: "review",
      revision: "b".repeat(40),
      jobId: "substituted-job",
      acquired: false,
      pullRequest,
    },
  );

  await expect(runOuterInvocation(invocation.proxy)).resolves.toEqual(
    outerLabelInvocation("implement-issue", true),
  );
  expect(invocation.get).not.toHaveBeenCalled();
});

it("rejects an accessor when Object.prototype pollutes descriptor values", () => {
  const invocation = outerLabelInvocation("implement-issue", true);
  const revision = vi.fn(() => "b".repeat(40));
  defineAccessor(invocation, "revision", revision);
  Object.defineProperty(Object.prototype, "value", {
    configurable: true,
    value: REVISION,
  });
  let failure: unknown;

  try {
    parseAuthorizedTargetOperationInvocation(invocation);
  } catch (error) {
    failure = error;
  } finally {
    delete Object.prototype.value;
  }

  expect(failure).toEqual(new Error("Target operation requires an authorized invocation"));
  expect(revision).not.toHaveBeenCalled();
});

it("rejects revoked Proxy authorization with stable redacted categories", async () => {
  const revokedOuter = Proxy.revocable(outerLabelInvocation("implement-issue", true), {});
  revokedOuter.revoke();
  await expectOuterInvocationRejected(
    revokedOuter.proxy,
    "Target operation requires an authorized invocation",
  );

  const revokedPullRequest = Proxy.revocable({ ...pullRequest }, {});
  revokedPullRequest.revoke();
  await expectOuterInvocationRejected({
    ...outerLabelInvocation("review", true),
    pullRequest: revokedPullRequest.proxy,
  }, "Target Pull Request operation requires an acquired same-repository revision");
});

it.each([
  ["operation", "implement-issue"],
  ["number", 219],
  ["revision", REVISION],
  ["jobId", "inherited-job"],
  ["acquired", true],
] as const)("rejects inherited outer authorization field %s", async (field, inheritedValue) => {
  const invocation = outerLabelInvocation("implement-issue", true);
  delete invocation[field];
  Object.setPrototypeOf(invocation, { [field]: inheritedValue });

  await expectOuterInvocationRejected(invocation);
});

it.each([
  ["pullRequest", () => {
    const invocation = outerLabelInvocation("review", true);
    delete invocation.pullRequest;
    Object.setPrototypeOf(invocation, { pullRequest });
    return invocation;
  }, "Target Pull Request operation requires an acquired same-repository revision"],
  ["pullRequest.headSha", () => {
    const authorization = { ...pullRequest } as Record<string, unknown>;
    delete authorization.headSha;
    Object.setPrototypeOf(authorization, { headSha: REVISION });
    return {
      ...outerLabelInvocation("review", true),
      pullRequest: authorization,
    };
  }, "Target Pull Request operation requires an acquired same-repository revision"],
  ["reconcile.invocation", () => {
    const reconcile = Object.create({ invocation: "reconcile" }) as Record<string, unknown>;
    return {
      ...outerLabelInvocation("implement-feedback", true),
      reconcile,
    };
  }, "Target feedback reconciliation authorization is invalid"],
  ["expectedReply.rootCommentId", () => {
    const expectedReply = { body: "reply" } as Record<string, unknown>;
    Object.setPrototypeOf(expectedReply, { rootCommentId: "PRRC_root" });
    return {
      ...outerLabelInvocation("implement-feedback", true),
      reconcile: { invocation: "reconcile", expectedReply },
    };
  }, "Target feedback reconciliation authorization is invalid"],
] as const)(
  "rejects inherited nested authorization field %s",
  async (_field, createInvocation, message) => {
    await expectOuterInvocationRejected(createInvocation(), message);
  },
);

it.each([
  ["extra string key", "unexpected"],
  ["symbol key", Symbol("unexpected-authorization")],
] as const)("rejects an outer invocation with an %s", async (_caseName, key) => {
  const invocation = outerLabelInvocation("implement-issue", true);
  invocation[key] = "authority";

  await expectOuterInvocationRejected(
    invocation,
    "Target operation invocation is invalid",
  );
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
