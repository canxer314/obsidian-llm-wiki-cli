import { describe, expect, it } from "vitest";

import { parseTargetJobInput } from "../.sandcastle/target-job-input.js";

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

describe("Target job input", () => {
  it("distinguishes missing input from invalid serialized input", () => {
    expect(() => parseTargetJobInput(""))
      .toThrow("Target job input is missing");
    for (const serialized of ["{", "null", '"input"', "1", "true", "[]"]) {
      expect(() => parseTargetJobInput(serialized))
        .toThrow("Target job input is invalid");
    }
  });

  it.each([
    [{ startup: validInput.startup, invocation: validInput.invocation }],
    [{ checkout: validInput.checkout, invocation: validInput.invocation }],
    [{ checkout: validInput.checkout, startup: validInput.startup }],
    [{ ...validInput, extra: "authority" }],
    [{ ...validInput, constructor: {} }],
    [{ ...validInput, prototype: {} }],
    [JSON.parse(JSON.stringify({ ...validInput, __proto__: "ignored" }).replace(/}$/, ',"__proto__":{}}'))],
  ])("rejects a non-exact envelope %#", (input) => {
    expect(() => parseTargetJobInput(JSON.stringify(input)))
      .toThrow("Target job input is invalid");
  });

  it.each([
    ["checkout", null, "Target Checkout process options are invalid"],
    ["checkout", "checkout", "Target Checkout process options are invalid"],
    ["checkout", [], "Target Checkout process options are invalid"],
    ["checkout", { sourceRepositoryPath: "" }, "Target Checkout process options are invalid"],
    ["startup", null, "Target operation startup snapshot is invalid"],
    ["startup", "startup", "Target operation startup snapshot is invalid"],
    ["startup", [], "Target operation startup snapshot is invalid"],
    ["startup", { ...validInput.startup, imageName: "" }, "Target operation startup snapshot is invalid"],
    ["invocation", null, "Target operation requires an authorized invocation"],
    ["invocation", "invocation", "Target operation requires an authorized invocation"],
    ["invocation", [], "Target operation requires an authorized invocation"],
    ["invocation", { ...validInput.invocation, acquired: false }, "Target operation invocation is not acquired"],
  ])("delegates invalid %s validation to its owning codec", (field, value, message) => {
    expect(() => parseTargetJobInput(JSON.stringify({ ...validInput, [field]: value })))
      .toThrow(message);
  });

  it("returns the exact validated envelope", () => {
    expect(parseTargetJobInput(JSON.stringify(validInput))).toEqual(validInput);
  });

  it("returns a snapshot independent from the parsed envelope", () => {
    const mutable = structuredClone(validInput) as {
      checkout: { sourceRepositoryPath: string };
      startup: { childEnvironments: { git: Record<string, string> } };
      invocation: { jobId: string };
    };
    const parsed = parseTargetJobInput(JSON.stringify(mutable));

    mutable.checkout.sourceRepositoryPath = "/changed/repository";
    mutable.startup.childEnvironments.git.PATH = "/changed";
    mutable.invocation.jobId = "changed";

    expect(parsed.checkout.sourceRepositoryPath).toBe("/trusted/repository");
    expect(parsed.startup.childEnvironments.git).toEqual({});
    expect(parsed.invocation.jobId).toBe("job-219");
    expect(Object.isFrozen(parsed)).toBe(true);
  });
});
