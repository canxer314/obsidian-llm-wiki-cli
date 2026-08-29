import { describe, expect, it } from "vitest";

import {
  canonicalAutomationTriggerLabels,
  commandRoutesForReceiver,
  resolveAutomationCommandRoute,
  resolveTargetOperationRoute,
  validateAutomationCommand,
} from "../.sandcastle/automation-command-route.js";

const routes = [
  {
    operation: "update-branch",
    targetOperation: "update-branch",
    trigger: "agent:update-branch",
    receiver: "pull-request",
    identity: "pull-request:101",
  },
  {
    operation: "implement",
    targetOperation: "implement-feedback",
    trigger: "agent:implement",
    receiver: "pull-request",
    identity: "pull-request:102",
  },
  {
    operation: "review",
    targetOperation: "review",
    trigger: "agent:review",
    receiver: "pull-request",
    identity: "pull-request:103",
  },
  {
    operation: "implement-issue",
    targetOperation: "implement-issue",
    trigger: "agent:implement",
    receiver: "issue",
    identity: "issue:104",
  },
  {
    operation: "implement-prd",
    targetOperation: "implement-prd",
    trigger: "agent:implement",
    receiver: "issue",
    identity: "prd:105",
  },
  {
    operation: "split-prd",
    targetOperation: "split-prd",
    trigger: "agent:to-issues",
    receiver: "issue",
    identity: "prd:106",
  },
] as const;

describe("Automation Command routes", () => {
  it.each(routes)("resolves the $operation route in both directions", (expected) => {
    const number = Number(expected.identity.split(":")[1]);
    const route = {
      ...expected,
      number,
    };

    expect(resolveAutomationCommandRoute(expected.operation, number)).toEqual(route);
    expect(resolveTargetOperationRoute(expected.targetOperation, number)).toEqual(route);
    expect(validateAutomationCommand({
      number,
      operation: expected.operation,
      identity: expected.identity,
      labels: [expected.trigger],
    })).toEqual(route);
  });

  it("enumerates immutable receiver-scoped routes and canonical trigger labels", () => {
    expect(commandRoutesForReceiver("pull-request", 110)).toEqual([
      {
        operation: "update-branch",
        targetOperation: "update-branch",
        trigger: "agent:update-branch",
        receiver: "pull-request",
        identity: "pull-request:110",
        number: 110,
      },
      {
        operation: "implement",
        targetOperation: "implement-feedback",
        trigger: "agent:implement",
        receiver: "pull-request",
        identity: "pull-request:110",
        number: 110,
      },
      {
        operation: "review",
        targetOperation: "review",
        trigger: "agent:review",
        receiver: "pull-request",
        identity: "pull-request:110",
        number: 110,
      },
    ]);
    expect(canonicalAutomationTriggerLabels()).toEqual([
      "agent:update-branch",
      "agent:implement",
      "agent:review",
      "agent:to-issues",
    ]);
  });

  it.each([
    ["wrong identity namespace", { number: 101, operation: "review", identity: "issue:101", labels: [] }],
    ["wrong identity number", { number: 101, operation: "review", identity: "pull-request:102", labels: [] }],
    ["inspection-only unknown", { number: 101, operation: "unknown", identity: "pull-request:101", labels: [] }],
    ["inconsistent target route", { number: 101, operation: "implement", identity: "issue:101", labels: [] }],
  ])("rejects %s command", (_caseName, command) => {
    expect(() => validateAutomationCommand(command)).toThrow();
  });

  it.each([0, -1, Number.MAX_SAFE_INTEGER + 1])("rejects invalid Work Item number %s", (number) => {
    expect(() => resolveAutomationCommandRoute("review", number)).toThrow();
  });

  it.each(["unknown", "architecture-review", "not-an-operation"])
  ("rejects %s outside the label-triggered route", (operation) => {
    expect(() => resolveAutomationCommandRoute(operation, 101)).toThrow();
    expect(() => resolveTargetOperationRoute(operation, 101)).toThrow();
  });
});
