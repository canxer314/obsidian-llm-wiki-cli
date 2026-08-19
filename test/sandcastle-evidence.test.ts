import { describe, expect, it, vi } from "vitest";

import {
  createSandcastleEvidenceRecorder,
  recordSandcastleGate,
  recordSandcastleMerge,
  recordSandcastleWorkflow,
  type SandcastleExecutionContext,
} from "../.sandcastle/evidence.js";
import { processReadyPlan } from "../.sandcastle/repair-orchestrator.js";

const context: SandcastleExecutionContext = {
  runId: "run-acceptance-1",
  batchId: 3,
  issueNumber: 142,
};
const sha = (character: string) => character.repeat(40);

describe("Sandcastle structured evidence", () => {
  it("records only validated workflow correlation fields", () => {
    const write = vi.fn();
    const evidence = createSandcastleEvidenceRecorder(write);

    evidence.record({
      kind: "session-started",
      ...context,
      role: "implementer",
      attempt: 1,
      sessionName: "implementer-repair-issue-142-attempt-1",
      pullRequestNumber: 321,
      revision: sha("a"),
    });
    evidence.record({
      kind: "gate-finished",
      ...context,
      pullRequestNumber: 321,
      revision: sha("b"),
      context: "sandcastle/review",
      outcome: "success",
    });
    evidence.record({
      kind: "merge-requested",
      ...context,
      pullRequestNumber: 321,
      expectedHeadSha: sha("b"),
    });
    evidence.record({
      kind: "workflow-finished",
      ...context,
      outcome: "merged",
      revision: sha("b"),
    });

    expect(write.mock.calls.map(([event]) => event)).toEqual([
      expect.objectContaining({ kind: "session-started", issueNumber: 142 }),
      expect.objectContaining({ kind: "gate-finished", revision: sha("b") }),
      expect.objectContaining({ kind: "merge-requested", expectedHeadSha: sha("b") }),
      expect.objectContaining({ kind: "workflow-finished", outcome: "merged" }),
    ]);
  });

  it.each([
    { name: "long run ID", event: { ...context, runId: "x".repeat(129) } },
    { name: "free-text stage", event: { ...context, failureStage: "token=secret value" } },
    { name: "abbreviated SHA", event: { ...context, revision: "abc123" } },
  ])("rejects $name before writing JSONL", ({ event }) => {
    const write = vi.fn();
    const evidence = createSandcastleEvidenceRecorder(write);

    expect(() => evidence.record({
      kind: "workflow-finished",
      outcome: "failed",
      ...event,
    })).toThrow("Sandcastle evidence");
    expect(write).not.toHaveBeenCalled();
  });

  it("drops unknown runtime fields before writing JSONL", () => {
    const write = vi.fn();
    const evidence = createSandcastleEvidenceRecorder(write);

    evidence.record({
      kind: "workflow-finished",
      ...context,
      outcome: "failed",
      prompt: "must not be written",
      token: "secret",
    } as never);

    expect(write).toHaveBeenCalledWith({
      kind: "workflow-finished",
      ...context,
      outcome: "failed",
    });
  });

  it("records a gate error against the known head before rethrowing", async () => {
    const events: unknown[] = [];
    const evidence = createSandcastleEvidenceRecorder((event) => events.push(event));
    const failure = new Error("status API unavailable");

    await expect(recordSandcastleGate(
      evidence,
      context,
      {
        pullRequestNumber: 321,
        revision: sha("f"),
        context: "sandcastle/review",
      },
      async () => Promise.reject(failure),
    )).rejects.toBe(failure);

    expect(events).toEqual([{
      kind: "gate-finished",
      ...context,
      pullRequestNumber: 321,
      revision: sha("f"),
      context: "sandcastle/review",
      outcome: "error",
    }]);
  });

  it("records complete isolated traces for two orchestrated Issues", async () => {
    const events: unknown[] = [];
    const evidence = createSandcastleEvidenceRecorder((event) => events.push(event));

    async function runIssue(issueNumber: number, pullRequestNumber: number, fails: boolean) {
      const execution = { ...context, issueNumber };
      const initialRevision = sha(issueNumber === 201 ? "a" : "c");
      const repairedRevision = sha(issueNumber === 201 ? "b" : "d");
      const initialPullRequest = {
        number: pullRequestNumber,
        url: `https://github.com/example/repo/pull/${pullRequestNumber}`,
        headSha: initialRevision,
      };
      let qualityAttempt = 0;

      return recordSandcastleWorkflow(
        evidence,
        execution,
        async () => {
          const orchestration = await processReadyPlan({
            pullRequest: initialPullRequest,
            runLocalQuality: (pullRequest) => recordSandcastleGate(
              evidence,
              execution,
              {
                pullRequestNumber,
                revision: pullRequest.headSha,
                context: "sandcastle/local-quality",
              },
              async () => {
                qualityAttempt += 1;
                return qualityAttempt === 1 && !fails
                  ? { status: "failure" as const, stage: "test" as const, revision: pullRequest.headSha }
                  : { status: fails ? "error" as const : "success" as const, stage: "test" as const, revision: pullRequest.headSha };
              },
            ),
            runReview: (pullRequest) => recordSandcastleGate(
              evidence,
              execution,
              { pullRequestNumber, revision: pullRequest.headSha, context: "sandcastle/review" },
              async () => ({
                status: "success" as const,
                revision: pullRequest.headSha,
                verdict: "Approved" as const,
                summary: "Approved",
                findings: [],
              }),
            ),
            repair: async ({ attempt }) => {
              evidence.record({
                kind: "session-started",
                ...execution,
                role: "implementer",
                attempt,
                sessionName: `implementer-repair-issue-${issueNumber}-attempt-${attempt}`,
                pullRequestNumber,
                revision: initialRevision,
              });
              return { ...initialPullRequest, headSha: repairedRevision };
            },
          });
          if (orchestration.terminalFailure !== undefined) {
            throw Object.assign(new Error("workflow failed"), {
              stage: orchestration.terminalFailure.stage,
            });
          }
          return recordSandcastleMerge(
            evidence,
            execution,
            { pullRequestNumber, expectedHeadSha: orchestration.pullRequest.headSha },
            async () => ({ mergedRevision: orchestration.pullRequest.headSha }),
          );
        },
        (result) => result.mergedRevision,
      );
    }

    const [successful, failed] = await Promise.allSettled([
      runIssue(201, 401, false),
      runIssue(202, 402, true),
    ]);

    expect(successful).toEqual({ status: "fulfilled", value: { mergedRevision: sha("b") } });
    expect(failed.status).toBe("rejected");
    expect(events.filter((event) => (event as { issueNumber: number }).issueNumber === 201))
      .toEqual([
        expect.objectContaining({ kind: "gate-finished", revision: sha("a"), context: "sandcastle/local-quality", outcome: "failure" }),
        expect.objectContaining({ kind: "session-started", attempt: 1 }),
        expect.objectContaining({ kind: "gate-finished", revision: sha("b"), context: "sandcastle/local-quality", outcome: "success" }),
        expect.objectContaining({ kind: "gate-finished", revision: sha("b"), context: "sandcastle/review", outcome: "success" }),
        expect.objectContaining({ kind: "merge-requested", expectedHeadSha: sha("b") }),
        expect.objectContaining({ kind: "workflow-finished", outcome: "merged", revision: sha("b") }),
      ]);
    expect(events.filter((event) => (event as { issueNumber: number }).issueNumber === 202))
      .toEqual([
        expect.objectContaining({ kind: "gate-finished", revision: sha("c"), context: "sandcastle/local-quality", outcome: "error" }),
        expect.objectContaining({ kind: "workflow-finished", outcome: "failed", failureStage: "local-quality:test" }),
      ]);
  });
});
