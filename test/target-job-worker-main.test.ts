import { describe, expect, it, vi } from "vitest";

import { runTargetJobWorker } from "../.sandcastle/target-job-worker-main.js";

const validInput = {
  checkout: { sourceRepositoryPath: "/trusted/repository" },
  startup: {
    imageName: "fixture-image",
    childEnvironments: { git: {}, github: {}, claude: {}, githubAgent: {} },
    models: {
      default: "default-model",
      planner: "planner-model",
      implementer: "implementer-model",
      reviewer: "reviewer-model",
    },
  },
  invocation: {
    operation: "implement-issue",
    number: 219,
    revision: "a".repeat(40),
    jobId: "job-219",
    acquired: true,
  },
} as const;

describe("Target job worker", () => {
  it.each([
    ["malformed JSON", "{"],
    ["missing checkout", JSON.stringify({
      startup: validInput.startup,
      invocation: validInput.invocation,
    })],
    ["invalid checkout", JSON.stringify({ ...validInput, checkout: null })],
    ["invalid startup", JSON.stringify({ ...validInput, startup: null })],
    ["invalid invocation", JSON.stringify({
      ...validInput,
      invocation: { ...validInput.invocation, acquired: false },
    })],
  ])("rejects %s before constructing effectful dependencies", async (_caseName, serialized) => {
    const createCheckout = vi.fn();
    const executeOperation = vi.fn();

    await expect(runTargetJobWorker(serialized, {
      createCheckout,
      executeOperation,
    })).rejects.toThrow();

    expect(createCheckout).not.toHaveBeenCalled();
    expect(executeOperation).not.toHaveBeenCalled();
  });

  it("constructs checkout only after validating the complete envelope", async () => {
    const checkout = { withCheckout: vi.fn() };
    const createCheckout = vi.fn(() => checkout);
    const executeOperation = vi.fn(async () => ({ status: "implemented" }));

    await expect(runTargetJobWorker(JSON.stringify(validInput), {
      createCheckout,
      executeOperation,
    })).resolves.toEqual({ status: "implemented" });

    expect(createCheckout).toHaveBeenCalledOnce();
    expect(createCheckout).toHaveBeenCalledWith(validInput.checkout);
    expect(executeOperation).toHaveBeenCalledWith({
      checkout,
      startup: validInput.startup,
      invocation: validInput.invocation,
    });
  });
});
