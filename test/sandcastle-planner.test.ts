import { describe, expect, it, vi } from "vitest";

import {
  PlannerOutputError,
  planIssue,
  plannerOutputSchema,
  type PlannerAgentSession,
} from "../.sandcastle/planner.js";

function completeOutput() {
  return {
    status: "ready" as const,
    implementationSummary: "Add a structured Planner handoff.",
    blockingReason: null,
    allowsAutomationChanges: false,
    issue: {
      number: 101,
      title: "Structured planning",
      body: "Build the Planner flow.",
      labels: ["Sandcastle", "ready-for-agent"],
      comments: [{ author: "maintainer", body: "Keep it minimal." }],
    },
  };
}

function agentSession(output: unknown): PlannerAgentSession {
  return { run: vi.fn().mockResolvedValue(output) };
}

describe("Sandcastle Planner", () => {
  it("starts an independent session scoped to the explicit Issue and schema", async () => {
    const session = agentSession(completeOutput());

    const handoff = await planIssue({ issueNumber: 101, model: "planner-model", session });

    expect(session.run).toHaveBeenCalledOnce();
    expect(session.run).toHaveBeenCalledWith({
      issueNumber: 101,
      model: "planner-model",
      output: { tag: "plan", schema: plannerOutputSchema },
    });
    expect(handoff).toEqual(completeOutput());
  });

  it("returns a self-contained handoff with the full Issue context", async () => {
    const output = completeOutput();

    const handoff = await planIssue({
      issueNumber: 101,
      model: "planner-model",
      session: agentSession(output),
    });

    expect(handoff.issue).toEqual({
      number: 101,
      title: "Structured planning",
      body: "Build the Planner flow.",
      labels: ["Sandcastle", "ready-for-agent"],
      comments: [{ author: "maintainer", body: "Keep it minimal." }],
    });
    expect(handoff).toMatchObject({
      status: "ready",
      implementationSummary: "Add a structured Planner handoff.",
      blockingReason: null,
      allowsAutomationChanges: false,
    });
  });

  it.each([
    { name: "missing", output: undefined },
    { name: "free text", output: "READY: implement it" },
    {
      name: "invalid ready plan",
      output: { ...completeOutput(), blockingReason: "not actually blocked" },
    },
    {
      name: "mismatched Issue",
      output: { ...completeOutput(), issue: { ...completeOutput().issue, number: 102 } },
    },
  ])("fails closed for $name output", async ({ output }) => {
    await expect(
      planIssue({
        issueNumber: 101,
        model: "planner-model",
        session: agentSession(output),
      }),
    ).rejects.toBeInstanceOf(PlannerOutputError);
  });

  it("accepts a blocked result only with an explicit reason", async () => {
    const output = {
      ...completeOutput(),
      status: "blocked" as const,
      implementationSummary: "Wait for the dependency.",
      blockingReason: "Issue #100 is still open.",
    };

    await expect(
      planIssue({
        issueNumber: 101,
        model: "planner-model",
        session: agentSession(output),
      }),
    ).resolves.toEqual(output);
  });
});
