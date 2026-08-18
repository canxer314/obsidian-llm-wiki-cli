import { describe, expect, it, vi } from "vitest";

import {
  processReadyPlan,
  type MergerRequest,
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
  it("reruns both gates from a clean target sync SHA", async () => {
    const syncedPullRequest = { ...pullRequest, headSha: sha("b") };
    const synchronize = vi.fn()
      .mockResolvedValueOnce({ status: "synced" as const, pullRequest: syncedPullRequest })
      .mockResolvedValue({ status: "unchanged" as const, pullRequest: syncedPullRequest });
    const runLocalQuality = vi.fn().mockResolvedValue(
      quality("success", syncedPullRequest.headSha),
    );
    const runReview = vi.fn().mockResolvedValue(
      review("success", syncedPullRequest.headSha),
    );

    await expect(processReadyPlan({
      pullRequest,
      synchronize,
      runLocalQuality,
      runReview,
      repair: vi.fn(),
    })).resolves.toMatchObject({
      pullRequest: syncedPullRequest,
      localQuality: { status: "success", revision: syncedPullRequest.headSha },
      review: { status: "success", revision: syncedPullRequest.headSha },
      synchronizationsUsed: 1,
    });

    expect(runLocalQuality).toHaveBeenCalledOnce();
    expect(runLocalQuality).toHaveBeenCalledWith(syncedPullRequest);
    expect(runReview).toHaveBeenCalledOnce();
    expect(synchronize).toHaveBeenCalledTimes(2);
  });

  it("does not start Merger on the clean target synchronization path", async () => {
    const mergeConflict = vi.fn();

    await processReadyPlan({
      pullRequest,
      synchronize: vi.fn().mockResolvedValue({ status: "unchanged", pullRequest }),
      runLocalQuality: vi.fn().mockResolvedValue(quality("success", pullRequest.headSha)),
      runReview: vi.fn().mockResolvedValue(review("success", pullRequest.headSha)),
      repair: vi.fn(),
      mergeConflict,
    });

    expect(mergeConflict).not.toHaveBeenCalled();
  });

  it("repairs a real conflict with an independent Merger budget and reruns both gates", async () => {
    const mergedPullRequest = { ...pullRequest, headSha: sha("b") };
    const synchronize = vi.fn()
      .mockResolvedValueOnce({
        status: "conflict" as const,
        pullRequest,
        targetBranch: "master",
        targetSha: sha("c"),
        summary: "Target master conflicts with the Issue branch",
      })
      .mockResolvedValue({ status: "unchanged" as const, pullRequest: mergedPullRequest });
    const mergeConflict = vi.fn().mockResolvedValue(mergedPullRequest);
    const runLocalQuality = vi.fn().mockResolvedValue(
      quality("success", mergedPullRequest.headSha),
    );
    const runReview = vi.fn().mockResolvedValue(
      review("success", mergedPullRequest.headSha),
    );

    await expect(processReadyPlan({
      pullRequest,
      synchronize,
      runLocalQuality,
      runReview,
      repair: vi.fn(),
      mergeConflict,
    })).resolves.toMatchObject({
      pullRequest: mergedPullRequest,
      repairsUsed: 0,
      mergerRepairsUsed: 1,
      localQuality: { status: "success", revision: mergedPullRequest.headSha },
      review: { status: "success", revision: mergedPullRequest.headSha },
    });

    expect(mergeConflict).toHaveBeenCalledWith({
      pullRequest,
      attempt: 1,
      targetBranch: "master",
      targetSha: sha("c"),
      summary: "Target master conflicts with the Issue branch",
    } satisfies MergerRequest);
    expect(runLocalQuality).toHaveBeenCalledWith(mergedPullRequest);
    expect(runReview).toHaveBeenCalledWith(
      mergedPullRequest,
      quality("success", mergedPullRequest.headSha),
    );
  });

  it("allows two Merger conflict repairs without consuming Implementer repairs", async () => {
    const revisions = [sha("a"), sha("b"), sha("c")];
    const targets = [sha("d"), sha("e"), sha("f")];
    const synchronize = vi.fn()
      .mockResolvedValueOnce({
        status: "conflict", pullRequest, targetBranch: "master",
        targetSha: targets[0], summary: "first conflict",
      })
      .mockResolvedValueOnce({
        status: "conflict", pullRequest: { ...pullRequest, headSha: revisions[1] },
        targetBranch: "master", targetSha: targets[1], summary: "second conflict",
      })
      .mockResolvedValueOnce({
        status: "conflict", pullRequest: { ...pullRequest, headSha: revisions[2] },
        targetBranch: "master", targetSha: targets[2], summary: "third conflict",
      });
    const mergeConflict = vi.fn()
      .mockResolvedValueOnce({ ...pullRequest, headSha: revisions[1] })
      .mockResolvedValueOnce({ ...pullRequest, headSha: revisions[2] });
    const runLocalQuality = vi.fn()
      .mockResolvedValueOnce(quality("success", revisions[1]!))
      .mockResolvedValueOnce(quality("success", revisions[2]!));
    const runReview = vi.fn()
      .mockResolvedValueOnce(review("success", revisions[1]!))
      .mockResolvedValueOnce(review("success", revisions[2]!));

    await expect(processReadyPlan({
      pullRequest,
      synchronize,
      runLocalQuality,
      runReview,
      repair: vi.fn(),
      mergeConflict,
    })).resolves.toMatchObject({
      pullRequest: { headSha: revisions[2] },
      repairsUsed: 0,
      mergerRepairsUsed: 2,
      terminalFailure: {
        stage: "target-sync:conflict-repair-budget-exhausted",
        revision: revisions[2],
        summary: "third conflict",
      },
    });

    expect(mergeConflict.mock.calls.map(([request]) => request.attempt)).toEqual([1, 2]);
    expect(runLocalQuality.mock.calls.map(([pr]) => pr.headSha)).toEqual(revisions.slice(1));
    expect(runReview.mock.calls.map(([pr]) => pr.headSha)).toEqual(revisions.slice(1));
  });

  it("returns a target conflict through terminal failure without running gates or repair", async () => {
    const runLocalQuality = vi.fn();
    const runReview = vi.fn();
    const repair = vi.fn();

    await expect(processReadyPlan({
      pullRequest,
      synchronize: vi.fn().mockResolvedValue({
        status: "conflict",
        pullRequest,
        summary: "Target master conflicts with the Issue branch",
      }),
      runLocalQuality,
      runReview,
      repair,
    })).resolves.toMatchObject({
      pullRequest,
      repairsUsed: 0,
      terminalFailure: {
        stage: "target-sync:conflict",
        revision: pullRequest.headSha,
        summary: "Target master conflicts with the Issue branch",
      },
    });

    expect(runLocalQuality).not.toHaveBeenCalled();
    expect(runReview).not.toHaveBeenCalled();
    expect(repair).not.toHaveBeenCalled();
  });

  it("stops after two target synchronizations instead of looping forever", async () => {
    const revisions = [sha("a"), sha("b"), sha("c"), sha("d")];
    const synchronize = vi.fn()
      .mockResolvedValueOnce({
        status: "synced" as const,
        pullRequest: { ...pullRequest, headSha: revisions[1]! },
      })
      .mockResolvedValueOnce({
        status: "synced" as const,
        pullRequest: { ...pullRequest, headSha: revisions[2]! },
      })
      .mockResolvedValueOnce({
        status: "outdated" as const,
        pullRequest: { ...pullRequest, headSha: revisions[2]! },
      });
    const runLocalQuality = vi.fn()
      .mockResolvedValueOnce(quality("success", revisions[1]!))
      .mockResolvedValueOnce(quality("success", revisions[2]!));
    const runReview = vi.fn()
      .mockResolvedValueOnce(review("success", revisions[1]!))
      .mockResolvedValueOnce(review("success", revisions[2]!));

    await expect(processReadyPlan({
      pullRequest,
      synchronize,
      runLocalQuality,
      runReview,
      repair: vi.fn(),
    })).resolves.toMatchObject({
      pullRequest: { headSha: revisions[2] },
      repairsUsed: 0,
      synchronizationsUsed: 2,
      terminalFailure: {
        stage: "target-sync:budget-exhausted",
        revision: revisions[2],
      },
    });

    expect(runLocalQuality.mock.calls.map(([pr]) => pr.headSha)).toEqual(
      revisions.slice(1, 3),
    );
    expect(synchronize.mock.calls.map(([, allowPush]) => allowPush)).toEqual([
      true,
      true,
      false,
    ]);
    expect(runReview).toHaveBeenCalledTimes(2);
  });

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
      terminalFailure: {
        stage: "reviewer:repair-budget-exhausted",
        revision: revisions[2],
        summary: "Changes are required.\n\nFix this: A concrete problem.",
      },
    });
    expect(repair).toHaveBeenCalledTimes(2);
  });

  it.each([
    {
      name: "local quality infrastructure error",
      gate: "quality" as const,
      terminalFailure: {
        stage: "local-quality:test",
        revision: pullRequest.headSha,
        summary: "test output",
      },
    },
    {
      name: "Reviewer error",
      gate: "review" as const,
      terminalFailure: {
        stage: "reviewer",
        revision: pullRequest.headSha,
        summary: "Reviewer failed without a publishable verdict",
      },
    },
  ])("does not repair a $name", async ({ gate, terminalFailure }) => {
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

    expect(result).toMatchObject({ repairsUsed: 0, terminalFailure });
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
