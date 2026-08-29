import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  runFeedbackImplementation: vi.fn(),
  github: { kind: "managed-github" },
  checkoutPublisher: { kind: "feedback-publisher" },
  implementer: { kind: "feedback-implementer" },
}));

vi.mock("../.sandcastle/feedback-implementation-automation.js", () => ({
  runFeedbackImplementation: mocks.runFeedbackImplementation,
}));
vi.mock("../.sandcastle/automation-github.js", () => ({
  createAutomationGithubPort: vi.fn(() => ({ kind: "raw-github" })),
}));
vi.mock("../.sandcastle/target-operation-github.js", () => ({
  createManagedOperationGithub: vi.fn(() => mocks.github),
}));
vi.mock("../.sandcastle/feedback-publisher.js", () => ({
  createFeedbackPublisher: vi.fn(() => mocks.checkoutPublisher),
}));
vi.mock("../.sandcastle/feedback-process-runner.js", () => ({
  createProcessFeedbackImplementer: vi.fn(() => mocks.implementer),
}));
vi.mock("../.sandcastle/target-operation-startup.js", () => ({
  readTargetOperationStartup: vi.fn(async () => ({
    snapshot: {
      imageName: "fixture-image",
      childEnvironments: { git: {}, github: {}, claude: {}, githubAgent: {} },
      models: {
        default: "default-model",
        planner: "planner-model",
        implementer: "implementer-model",
        reviewer: "reviewer-model",
      },
    },
  })),
  targetWorkerStartup: vi.fn(() => ({ kind: "worker-startup" })),
}));

import { runTargetOperation } from "../.sandcastle/target-operation-runtime.js";

const REVISION = "a".repeat(40);
const AUTHORIZATION = {
  invocation: "reconcile" as const,
  baseRevision: "b".repeat(40),
  expectedPost: "c".repeat(40),
  expectedReply: { rootCommentId: "PRRC_root", body: "Fixed." },
};

function invocation(reconcile?: typeof AUTHORIZATION): string {
  return JSON.stringify({
    revision: REVISION,
    jobId: "feedback-job",
    ...(reconcile === undefined ? {} : { reconcile }),
  });
}

describe("Target feedback implementation composition", () => {
  beforeEach(() => {
    mocks.runFeedbackImplementation.mockReset()
      .mockResolvedValue({ status: "implemented", revision: REVISION, reconciled: false });
  });

  it("sends ordinary Dispatcher execution to the shared interface without authorization", async () => {
    await runTargetOperation("implement-feedback", ["347", invocation()]);

    expect(mocks.runFeedbackImplementation).toHaveBeenCalledOnce();
    expect(mocks.runFeedbackImplementation).toHaveBeenCalledWith(
      { pullRequestNumber: 347 },
      expect.objectContaining({
        github: mocks.github,
        publisher: mocks.checkoutPublisher,
        implementer: mocks.implementer,
      }),
    );
  });

  it("preserves explicit reconcile authorization through the same interface", async () => {
    await runTargetOperation("implement-feedback", ["347", invocation(AUTHORIZATION)]);

    expect(mocks.runFeedbackImplementation).toHaveBeenCalledOnce();
    expect(mocks.runFeedbackImplementation).toHaveBeenCalledWith(
      { pullRequestNumber: 347, authorization: AUTHORIZATION },
      expect.objectContaining({
        github: mocks.github,
        publisher: mocks.checkoutPublisher,
        implementer: mocks.implementer,
      }),
    );
  });
});
