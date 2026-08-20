import { describe, expect, it, vi } from "vitest";

import {
  createSandcastlePlannerSession,
} from "../.sandcastle/planner-session.js";
import { plannerOutputSchema } from "../.sandcastle/planner.js";

const output = {
  status: "ready" as const,
  implementationSummary: "Implement the requested behavior.",
  blockingReason: null,
  allowsAutomationChanges: false,
  issue: {
    number: 101,
    title: "Planner",
    body: "Plan this Issue.",
    labels: ["Sandcastle"],
    comments: [],
  },
};

describe("Sandcastle Planner session adapter", () => {
  it("runs a fresh read-only Planner session with structured output", async () => {
    const runAgent = vi.fn().mockResolvedValue({ output });
    const createAgent = vi.fn().mockReturnValue({ name: "fake-agent" });
    const sandbox = { kind: "fake-sandbox" };
    const hooks = { sandbox: { onSandboxReady: [] } };
    const evidence = { record: vi.fn() };
    const execution = { runId: "run-1", batchId: 1, issueNumber: 101 };
    const session = createSandcastlePlannerSession({
      sandbox: sandbox as never,
      hooks,
      runAgent: runAgent as never,
      createAgent: createAgent as never,
      evidence: evidence as never,
      execution,
    });

    await expect(session.run({
      issueNumber: 101,
      model: "planner-model",
      output: { tag: "plan", schema: plannerOutputSchema },
    })).resolves.toEqual(output);

    expect(runAgent).toHaveBeenCalledOnce();
    expect(runAgent).toHaveBeenCalledWith(expect.objectContaining({
      sandbox,
      hooks,
      branchStrategy: { type: "head" },
      maxIterations: 1,
      name: "planner-issue-101",
      output: expect.objectContaining({ tag: "plan" }),
    }));
    const request = runAgent.mock.calls[0]![0];
    expect(createAgent).toHaveBeenCalledWith("planner-model");
    expect(request.agent).toEqual({ name: "fake-agent" });
    expect(request.prompt).toContain("gh issue view 101 --comments");
    expect(request.prompt).toContain("body, labels, and all comments");
    expect(request.prompt).toContain("<plan>");
    expect(request.prompt).toContain("exactly match this strict schema");
    expect(request.prompt).toContain("implementationSummary (a non-empty string, never an array or object)");
    expect(request.prompt).toContain("include no fields other than those listed");
    expect(request.prompt).toContain("Do not add scope, metadata, explanation, helper, or any other fields");
    expect(request.prompt).toContain(
      "Determine whether the Issue explicitly permits changes to Sandcastle or GitHub automation configuration",
    );
    expect(request.prompt).not.toContain(output.issue.body);
    expect(evidence.record).toHaveBeenNthCalledWith(1, expect.objectContaining({
      kind: "session-started", ...execution, role: "planner", stage: "planner",
      attempt: 1, sessionName: request.name, timestamp: expect.any(String),
    }));
    expect(evidence.record).toHaveBeenNthCalledWith(2, expect.objectContaining({
      kind: "session-finished", outcome: "completed", durationMs: expect.any(Number),
    }));
  });
});
