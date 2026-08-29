import { describe, expect, it } from "vitest";

import { classifyTargetOperationOutcome } from "../.sandcastle/target-operation-outcome.js";

const acceptedOutcomes = [
  ["implement-issue", "implemented"],
  ["implement-prd", "implemented"],
  ["implement-feedback", "implemented"],
  ["review", "reviewed"],
  ["update-branch", "updated"],
  ["update-branch", "up-to-date"],
  ["split-prd", "split"],
  ["architecture-review", "proposed"],
  ["architecture-review", "skipped"],
] as const;

describe("Target operation outcome policy", () => {
  it.each(acceptedOutcomes)(
    "classifies %s/%s as a completed cleanup outcome without changing its business result",
    (operation, status) => {
      const outcome = { status, marker: `${operation}-${status}` };

      expect(classifyTargetOperationOutcome(operation, outcome)).toEqual({
        outcome,
        checkout: "cleanup",
        jobLog: "completed",
        automation: "completed",
      });
    },
  );

  it.each([
    ["implement-issue", "refused"],
    ["implement-prd", "refused"],
    ["implement-feedback", "refused"],
    ["review", "refused"],
    ["update-branch", "refused"],
    ["split-prd", "refused"],
    ["architecture-review", "refused"],
  ] as const)("treats accepted %s/%s as completed cleanup", (operation, status) => {
    const outcome = { status, reason: "business refusal" };

    expect(classifyTargetOperationOutcome(operation, outcome)).toEqual({
      outcome,
      checkout: "cleanup",
      jobLog: "completed",
      automation: "completed",
    });
  });

  it.each([
    "implement-issue",
    "implement-prd",
    "implement-feedback",
    "review",
    "update-branch",
    "split-prd",
    "architecture-review",
  ] as const)("preserves typed %s/blocked separately from an exception", (operation) => {
    const outcome = { status: "blocked", reason: "execution", marker: operation };

    expect(classifyTargetOperationOutcome(operation, outcome)).toEqual({
      outcome,
      checkout: "retain",
      jobLog: "failed",
      automation: "blocked",
    });
  });

  it.each([
    undefined,
    null,
    [],
    "not an outcome",
    1,
    {},
    { status: undefined },
    { status: 1 },
    { status: "unknown", secret: "must not serialize" },
    { status: "reviewed", secret: "must not serialize" },
  ])("rejects invalid outcome shape without serializing it", (outcome) => {
    expect(() => classifyTargetOperationOutcome("implement-issue", outcome)).toThrow(
      "Target operation returned an invalid outcome",
    );
    expect(() => classifyTargetOperationOutcome("implement-issue", outcome)).not.toThrow(
      "must not serialize",
    );
  });
});
