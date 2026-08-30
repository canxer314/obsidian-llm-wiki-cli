import { describe, expect, it, vi } from "vitest";

import * as targetOperationOutcome from "../.sandcastle/target-operation-outcome.js";

const { classifyTargetOperationOutcome } = targetOperationOutcome;

const INVALID_OUTCOME_MESSAGE = "Target operation returned an invalid outcome";

function expectInvalidTargetOperationOutcome(value: unknown, payloadText?: string): void {
  let error: unknown;
  try {
    classifyTargetOperationOutcome("implement-issue", value);
  } catch (caught) {
    error = caught;
  }

  expect(error).toMatchObject({
    name: "InvalidTargetOperationOutcomeError",
    message: INVALID_OUTCOME_MESSAGE,
  });
  expect(error).toBeInstanceOf(targetOperationOutcome.InvalidTargetOperationOutcomeError);
  expect(error).not.toHaveProperty("cause");
  if (payloadText !== undefined) {
    expect(String(error)).not.toContain(payloadText);
    expect(JSON.stringify(error)).not.toContain(payloadText);
  }
}

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
    "classifies %s/%s as completed without changing its business result",
    (operation, status) => {
      const outcome = { status, marker: `${operation}-${status}` };

      const classification = classifyTargetOperationOutcome(operation, outcome);

      expect(classification.outcome).toBe(outcome);
      expect(classification).toEqual({
        kind: "completed",
        outcome,
      });
      expect(Object.keys(classification)).toEqual(["kind", "outcome"]);
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
  ] as const)("treats accepted %s/%s as completed", (operation, status) => {
    const outcome = { status, reason: "business refusal" };

    const classification = classifyTargetOperationOutcome(operation, outcome);

    expect(classification.outcome).toBe(outcome);
    expect(classification).toEqual({
      kind: "completed",
      outcome,
    });
    expect(Object.keys(classification)).toEqual(["kind", "outcome"]);
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

    const classification = classifyTargetOperationOutcome(operation, outcome);

    expect(classification.outcome).toBe(outcome);
    expect(classification).toEqual({
      kind: "blocked",
      outcome,
    });
    expect(Object.keys(classification)).toEqual(["kind", "outcome"]);
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
  ])("rejects invalid outcome shape with a stable typed error without serializing it", (outcome) => {
    expectInvalidTargetOperationOutcome(outcome, "must not serialize");
  });

  it("rejects inherited status without serializing its payload", () => {
    const outcome = Object.create({ status: "implemented", secret: "inherited payload" });

    expectInvalidTargetOperationOutcome(outcome, "inherited payload");
  });

  it("rejects an own status accessor without invoking it", () => {
    const status = vi.fn(() => "implemented");
    const outcome = Object.defineProperty({ secret: "accessor payload" }, "status", {
      enumerable: true,
      get: status,
    });

    expectInvalidTargetOperationOutcome(outcome, "accessor payload");
    expect(status).not.toHaveBeenCalled();
  });

  it("rejects an own throwing status accessor without invoking it or serializing its payload", () => {
    const status = vi.fn(() => {
      throw new Error("getter payload");
    });
    const outcome = Object.defineProperty({ secret: "getter payload" }, "status", {
      enumerable: true,
      get: status,
    });

    expectInvalidTargetOperationOutcome(outcome, "getter payload");
    expect(status).not.toHaveBeenCalled();
  });

  it("rejects a benign Proxy-wrapped outcome", () => {
    expectInvalidTargetOperationOutcome(new Proxy({ status: "implemented" }, {}));
  });

  it("normalizes a Proxy trap failure without invoking the trap or serializing its payload", () => {
    const trap = vi.fn(() => {
      throw new Error("proxy payload");
    });
    const outcome = new Proxy({ status: "implemented" }, { getOwnPropertyDescriptor: trap });

    expectInvalidTargetOperationOutcome(outcome, "proxy payload");
    expect(trap).not.toHaveBeenCalled();
  });
});
