import { describe, expect, it, vi } from "vitest";

import {
  processReadyPlan,
  type RepairRequest,
} from "../.sandcastle/repair-orchestrator.js";
import type { VerifiedPullRequest } from "../.sandcastle/implementer.js";

const sha = (character: string) => character.repeat(40);
const pullRequest: VerifiedPullRequest = {
  number: 321,
  headSha: sha("a"),
  url: "https://github.com/example/repo/pull/321",
};

function quality(
  status: "success" | "failure" | "error",
  revision: string,
  output = "test output",
) {
  return status === "success"
    ? { status, revision } as const
    : { status, revision, stage: "test" as const, output };
}

function review(
  status: "success" | "failure",
  revision: string,
  details = "A concrete problem.",
) {
  return {
    status,
    revision,
    verdict: status === "success" ? "Approved" as const : "Changes requested" as const,
    summary: status === "success" ? "Looks good." : "Changes are required.",
    findings: status === "success" ? [] : [{ summary: "Fix this", details }],
  };
}

describe("Sandcastle repair orchestration", () => {
  it("repairs a local quality failure and reruns both gates from the new SHA", async () => {
    const repairedSha = sha("b");
    const runLocalQuality = vi.fn()
      .mockResolvedValueOnce(quality("failure", pullRequest.headSha))
      .mockResolvedValueOnce(quality("success", repairedSha));
    const runReview = vi.fn().mockResolvedValue(review("success", repairedSha));
    const repair = vi.fn().mockResolvedValue({ ...pullRequest, headSha: repairedSha });

    await expect(processReadyPlan({
      pullRequest,
      runLocalQuality,
      runReview,
      repair,
    })).resolves.toEqual({
      pullRequest: { ...pullRequest, headSha: repairedSha },
      localQuality: quality("success", repairedSha),
      review: review("success", repairedSha),
      repairsUsed: 1,
    });

    expect(runLocalQuality.mock.calls.map(([pr]) => pr.headSha)).toEqual([
      pullRequest.headSha,
      repairedSha,
    ]);
    expect(runReview).toHaveBeenCalledOnce();
    expect(repair).toHaveBeenCalledWith({
      pullRequest,
      attempt: 1,
      feedback: {
        source: "local-quality",
        stage: "test",
        output: "test output",
      },
    } satisfies RepairRequest);
  });

  it("shares two repairs across a local failure followed by requested changes", async () => {
    const revisions = [sha("a"), sha("b"), sha("c")];
    const runLocalQuality = vi.fn()
      .mockResolvedValueOnce(quality("failure", revisions[0]!))
      .mockResolvedValueOnce(quality("success", revisions[1]!))
      .mockResolvedValueOnce(quality("success", revisions[2]!));
    const runReview = vi.fn()
      .mockResolvedValueOnce(review("failure", revisions[1]!))
      .mockResolvedValueOnce(review("success", revisions[2]!));
    const repair = vi.fn()
      .mockResolvedValueOnce({ ...pullRequest, headSha: revisions[1]! })
      .mockResolvedValueOnce({ ...pullRequest, headSha: revisions[2]! });

    const result = await processReadyPlan({
      pullRequest,
      runLocalQuality,
      runReview,
      repair,
    });

    expect(result).toMatchObject({ repairsUsed: 2, review: { status: "success" } });
    expect(runLocalQuality.mock.calls.map(([pr]) => pr.headSha)).toEqual(revisions);
    expect(runReview.mock.calls.map(([pr]) => pr.headSha)).toEqual(revisions.slice(1));
    expect(repair.mock.calls.map(([request]) => [
      request.attempt,
      request.feedback.source,
    ])).toEqual([[1, "local-quality"], [2, "review"]]);
  });

  it("stops after three implementation versions when the shared budget is exhausted", async () => {
    const revisions = [sha("a"), sha("b"), sha("c")];
    const runLocalQuality = vi.fn()
      .mockResolvedValueOnce(quality("success", revisions[0]!))
      .mockResolvedValueOnce(quality("failure", revisions[1]!))
      .mockResolvedValueOnce(quality("success", revisions[2]!));
    const runReview = vi.fn()
      .mockResolvedValueOnce(review("failure", revisions[0]!))
      .mockResolvedValueOnce(review("failure", revisions[2]!));
    const repair = vi.fn()
      .mockResolvedValueOnce({ ...pullRequest, headSha: revisions[1]! })
      .mockResolvedValueOnce({ ...pullRequest, headSha: revisions[2]! });

    const result = await processReadyPlan({
      pullRequest,
      runLocalQuality,
      runReview,
      repair,
    });

    expect(result).toMatchObject({
      pullRequest: { headSha: revisions[2] },
      repairsUsed: 2,
      review: { status: "failure", revision: revisions[2] },
    });
    expect(repair).toHaveBeenCalledTimes(2);
  });

  it.each([
    { name: "local quality infrastructure error", gate: "quality" as const },
    { name: "Reviewer error", gate: "review" as const },
  ])("does not repair a $name", async ({ gate }) => {
    const runLocalQuality = vi.fn().mockResolvedValue(
      quality(gate === "quality" ? "error" : "success", pullRequest.headSha),
    );
    const runReview = vi.fn().mockResolvedValue({
      status: "error" as const,
      revision: pullRequest.headSha,
    });
    const repair = vi.fn();

    const result = await processReadyPlan({
      pullRequest,
      runLocalQuality,
      runReview,
      repair,
    });

    expect(result).toMatchObject({ repairsUsed: 0 });
    expect(repair).not.toHaveBeenCalled();
    expect(runReview).toHaveBeenCalledTimes(gate === "review" ? 1 : 0);
  });

  it("supplies descriptive quality feedback when the command produced no output", async () => {
    const repairedSha = sha("b");
    const repair = vi.fn().mockResolvedValue({ ...pullRequest, headSha: repairedSha });

    await processReadyPlan({
      pullRequest,
      runLocalQuality: vi.fn()
        .mockResolvedValueOnce({
          status: "failure",
          revision: pullRequest.headSha,
          stage: "test",
        })
        .mockResolvedValueOnce(quality("success", repairedSha)),
      runReview: vi.fn().mockResolvedValue(review("success", repairedSha)),
      repair,
    });

    expect(repair).toHaveBeenCalledWith(expect.objectContaining({
      feedback: {
        source: "local-quality",
        stage: "test",
        output: "Local quality failed during test without command output",
      },
    }));
  });

  it("redacts secrets before passing bounded quality or review feedback to repair", async () => {
    const repairedSha = sha("b");
    const secret = `ghp_${"x".repeat(30)}`;
    const runLocalQuality = vi.fn()
      .mockResolvedValueOnce(quality("failure", pullRequest.headSha, `token=${secret}`))
      .mockResolvedValueOnce(quality("success", repairedSha));
    const repair = vi.fn().mockResolvedValue({ ...pullRequest, headSha: repairedSha });

    await processReadyPlan({
      pullRequest,
      runLocalQuality,
      runReview: vi.fn().mockResolvedValue(review("success", repairedSha)),
      repair,
    });

    const request = repair.mock.calls[0]![0] as RepairRequest;
    expect(JSON.stringify(request.feedback)).not.toContain(secret);
    expect(request.feedback).toMatchObject({ output: "token=[REDACTED]" });
  });
});
