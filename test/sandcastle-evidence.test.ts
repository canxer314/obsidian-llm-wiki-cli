import { describe, expect, it, vi } from "vitest";

import {
  createSandcastleEvidenceRecorder,
  recordSandcastleWorkflow,
  type SandcastleExecutionContext,
} from "../.sandcastle/evidence.js";

const context: SandcastleExecutionContext = {
  runId: "run-acceptance-1",
  batchId: 3,
  issueNumber: 142,
};

describe("Sandcastle structured evidence", () => {
  it("records only bounded workflow correlation fields", () => {
    const write = vi.fn();
    const evidence = createSandcastleEvidenceRecorder(write);

    evidence.sessionStarted(context, {
      role: "implementer",
      attempt: 1,
      sessionName: "implementer-repair-issue-142-attempt-1",
      pullRequestNumber: 321,
      revision: "a".repeat(40),
    });
    evidence.gateFinished(context, {
      pullRequestNumber: 321,
      revision: "b".repeat(40),
      context: "sandcastle/review",
      outcome: "success",
    });
    evidence.mergeRequested(context, {
      pullRequestNumber: 321,
      expectedHeadSha: "b".repeat(40),
    });
    evidence.workflowFinished(context, {
      outcome: "merged",
      revision: "b".repeat(40),
    });

    expect(write.mock.calls.map(([event]) => event)).toEqual([
      {
        kind: "session-started",
        ...context,
        role: "implementer",
        attempt: 1,
        sessionName: "implementer-repair-issue-142-attempt-1",
        pullRequestNumber: 321,
        revision: "a".repeat(40),
      },
      {
        kind: "gate-finished",
        ...context,
        pullRequestNumber: 321,
        revision: "b".repeat(40),
        context: "sandcastle/review",
        outcome: "success",
      },
      {
        kind: "merge-requested",
        ...context,
        pullRequestNumber: 321,
        expectedHeadSha: "b".repeat(40),
      },
      {
        kind: "workflow-finished",
        ...context,
        outcome: "merged",
        revision: "b".repeat(40),
      },
    ]);
  });

  it("records an exact merged revision or an isolated failure stage", async () => {
    const events: unknown[] = [];
    const evidence = createSandcastleEvidenceRecorder((event) => events.push(event));

    await expect(recordSandcastleWorkflow(
      evidence,
      context,
      async () => ({ mergedRevision: "e".repeat(40) }),
      (result) => result.mergedRevision,
    )).resolves.toEqual({ mergedRevision: "e".repeat(40) });

    const failure = Object.assign(new Error("review failed"), { stage: "reviewer" });
    await expect(recordSandcastleWorkflow(
      evidence,
      { ...context, issueNumber: 143 },
      async () => Promise.reject(failure),
      () => "unreachable",
    )).rejects.toBe(failure);

    expect(events).toEqual([
      {
        kind: "workflow-finished",
        ...context,
        outcome: "merged",
        revision: "e".repeat(40),
      },
      {
        kind: "workflow-finished",
        ...context,
        issueNumber: 143,
        outcome: "failed",
        failureStage: "reviewer",
      },
    ]);
  });

  it("keeps two Issues and their repair attempts independently attributable", () => {
    const events: unknown[] = [];
    const evidence = createSandcastleEvidenceRecorder((event) => events.push(event));

    evidence.sessionStarted({ ...context, issueNumber: 201 }, {
      role: "implementer",
      attempt: 2,
      sessionName: "implementer-repair-issue-201-attempt-2",
      pullRequestNumber: 401,
      revision: "c".repeat(40),
    });
    evidence.sessionStarted({ ...context, issueNumber: 202 }, {
      role: "merger",
      attempt: 1,
      sessionName: "merger-issue-202-attempt-1",
      pullRequestNumber: 402,
      revision: "d".repeat(40),
    });

    expect(events).toEqual([
      expect.objectContaining({ issueNumber: 201, role: "implementer", attempt: 2 }),
      expect.objectContaining({ issueNumber: 202, role: "merger", attempt: 1 }),
    ]);
  });
});
