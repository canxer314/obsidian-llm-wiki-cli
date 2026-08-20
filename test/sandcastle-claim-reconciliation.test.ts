import { describe, expect, it, vi } from "vitest";

import {
  reconcileClaim,
  type ClaimReconciliationPorts,
} from "../.sandcastle/claim-reconciliation.ts";

const SHA = {
  base: "a".repeat(40),
  head: "b".repeat(40),
  merged: "c".repeat(40),
} as const;

function ports(
  overrides: Partial<{
    issue: Awaited<ReturnType<ClaimReconciliationPorts["github"]["getIssue"]>>;
    branch: Awaited<ReturnType<ClaimReconciliationPorts["github"]["getBranch"]>>;
    pullRequests: Awaited<ReturnType<ClaimReconciliationPorts["github"]["listPullRequests"]>>;
    relation: Awaited<ReturnType<ClaimReconciliationPorts["git"]["compareCommits"]>>;
    uniqueCommits: Awaited<ReturnType<ClaimReconciliationPorts["git"]["countUniqueCommits"]>>;
    worktree: Awaited<ReturnType<ClaimReconciliationPorts["git"]["getWorktree"]>>;
    container: Awaited<ReturnType<ClaimReconciliationPorts["docker"]["getContainer"]>>;
  }> = {},
): ClaimReconciliationPorts {
  return {
    github: {
      getIssue: vi.fn().mockResolvedValue(overrides.issue ?? {
        existence: "present",
        state: "open",
        eligible: true,
      }),
      getBranch: vi.fn().mockResolvedValue(overrides.branch ?? {
        state: "present",
        headSha: SHA.base,
      }),
      listPullRequests: vi.fn().mockResolvedValue(overrides.pullRequests ?? []),
    },
    git: {
      compareCommits: vi.fn().mockResolvedValue(overrides.relation ?? "equal"),
      countUniqueCommits: vi.fn().mockResolvedValue(overrides.uniqueCommits ?? 0),
      getWorktree: vi.fn().mockResolvedValue(overrides.worktree ?? "clean"),
    },
    docker: {
      getContainer: vi.fn().mockResolvedValue(overrides.container ?? "absent"),
    },
  };
}

const input = {
  repository: "example/repository",
  issueNumber: 208,
  branch: "sandcastle/issue-208",
  comparisonBaseSha: SHA.base,
} as const;

describe("claim reconciliation", () => {
  it("identifies a proven empty claim without mutating any resource", async () => {
    const result = await reconcileClaim(input, ports());

    expect(result).toEqual({
      repository: "example/repository",
      issueNumber: 208,
      branch: "sandcastle/issue-208",
      comparisonBaseSha: SHA.base,
      issue: { existence: "present", state: "open", eligibility: "eligible" },
      claimBranch: { state: "present", headSha: SHA.base },
      branchRelation: "equal",
      uniqueCommits: { state: "zero", count: 0 },
      pullRequests: { state: "none", count: 0, items: [] },
      worktree: "clean",
      container: "absent",
      inconsistent: false,
      classification: "empty-candidate",
      recommendedAction: "release-empty-claim",
    });
  });

  it("treats an authoritative merged PR as delivery complete while retaining conflicts", async () => {
    const result = await reconcileClaim(input, ports({
      branch: { state: "present", headSha: SHA.head },
      relation: "diverged",
      uniqueCommits: 2,
      worktree: "dirty",
      container: "active",
      pullRequests: [{
        number: 312,
        state: "merged",
        headSha: SHA.merged,
        closesIssue: true,
      }],
    }));

    expect(result.pullRequests).toEqual({
      state: "merged",
      count: 1,
      items: [{ number: 312, state: "merged", headSha: SHA.merged, closesIssue: true }],
    });
    expect(result.inconsistent).toBe(true);
    expect(result.classification).toBe("delivery-complete");
    expect(result.recommendedAction).toBe("no-action");
  });

  it("classifies an absent branch with no associated resources as no claim", async () => {
    const result = await reconcileClaim(input, ports({
      branch: { state: "absent" },
      worktree: "absent",
    }));

    expect(result.branchRelation).toBe("unknown");
    expect(result.uniqueCommits).toEqual({ state: "unknown" });
    expect(result.classification).toBe("no-claim");
    expect(result.recommendedAction).toBe("no-action");
  });

  it("keeps a merged PR authoritative when multiple historical PRs exist", async () => {
    const result = await reconcileClaim(input, ports({
      pullRequests: [
        { number: 310, state: "closed", headSha: SHA.head, closesIssue: true },
        { number: 312, state: "merged", headSha: SHA.merged, closesIssue: true },
      ],
    }));

    expect(result.pullRequests.state).toBe("multiple");
    expect(result.inconsistent).toBe(true);
    expect(result.classification).toBe("delivery-complete");
  });

  it("does not treat a merged PR without a closing relationship as delivery", async () => {
    const result = await reconcileClaim(input, ports({
      pullRequests: [{
        number: 312,
        state: "merged",
        headSha: SHA.merged,
        closesIssue: false,
      }],
    }));

    expect(result.inconsistent).toBe(true);
    expect(result.classification).toBe("inconsistent");
    expect(result.recommendedAction).toBe("manual-review");
  });

  it.each([
    ["equal", 0, "empty-candidate"],
    ["ahead", 1, "active-or-preserved-work"],
    ["behind", 0, "active-or-preserved-work"],
    ["diverged", 1, "active-or-preserved-work"],
    ["unknown", "unknown", "unknown"],
  ] as const)("classifies %s branch relation and %s unique commits", async (
    relation,
    uniqueCommits,
    classification,
  ) => {
    const result = await reconcileClaim(input, ports({ relation, uniqueCommits }));

    expect(result.branchRelation).toBe(relation);
    expect(result.classification).toBe(classification);
  });

  it.each([
    [[], "none"],
    [[{ number: 1, state: "open", headSha: SHA.head, closesIssue: true }], "open"],
    [[{ number: 1, state: "closed", headSha: SHA.head, closesIssue: false }], "closed"],
  ] as const)("normalizes PR history as %s", async (pullRequests, state) => {
    const result = await reconcileClaim(input, ports({ pullRequests }));
    expect(result.pullRequests.state).toBe(state);
  });

  it.each([
    ["absent", "empty-candidate"],
    ["clean", "empty-candidate"],
    ["dirty", "active-or-preserved-work"],
    ["unknown", "unknown"],
  ] as const)("classifies %s worktree", async (worktree, classification) => {
    const result = await reconcileClaim(input, ports({ worktree }));
    expect(result.classification).toBe(classification);
  });

  it.each([
    ["absent", "empty-candidate"],
    ["present", "empty-candidate"],
    ["active", "active-or-preserved-work"],
    ["unknown", "unknown"],
  ] as const)("classifies %s container", async (container, classification) => {
    const result = await reconcileClaim(input, ports({ container }));
    expect(result.classification).toBe(classification);
  });

  it("fails closed when a port throws without exposing the error", async () => {
    const fakePorts = ports();
    vi.mocked(fakePorts.git.getWorktree).mockRejectedValue(
      new Error("token=secret /host/private/path untracked-file.ts"),
    );

    const result = await reconcileClaim(input, fakePorts);

    expect(result.worktree).toBe("unknown");
    expect(result.classification).toBe("unknown");
    expect(JSON.stringify(result)).not.toMatch(/secret|private|untracked/u);
  });

  it("does not infer no claim when the Issue read is unknown", async () => {
    const result = await reconcileClaim(input, ports({
      issue: { existence: "unknown", state: "unknown", eligible: "unknown" },
      branch: { state: "absent" },
      worktree: "absent",
    }));

    expect(result.classification).toBe("unknown");
    expect(result.recommendedAction).toBe("manual-review");
  });

  it("fails closed for partially unknown Issue facts when resources are absent", async () => {
    const result = await reconcileClaim(input, ports({
      issue: { existence: "present", state: "unknown", eligible: "unknown" },
      branch: { state: "absent" },
      worktree: "absent",
    }));

    expect(result.classification).toBe("unknown");
    expect(result.recommendedAction).toBe("manual-review");
  });

  it("classifies an absent Issue and absent resources as no claim", async () => {
    const result = await reconcileClaim(input, ports({
      issue: { existence: "absent", state: "unknown", eligible: false },
      branch: { state: "absent" },
      worktree: "absent",
    }));

    expect(result.classification).toBe("no-claim");
  });

  it("marks contradictory Issue facts as inconsistent", async () => {
    const result = await reconcileClaim(input, ports({
      issue: { existence: "absent", state: "open", eligible: true },
      branch: { state: "absent" },
      worktree: "absent",
    }));

    expect(result.inconsistent).toBe(true);
    expect(result.classification).toBe("inconsistent");
    expect(result.recommendedAction).toBe("manual-review");
  });

  it("uses read-only ports whose public interfaces cannot express mutations", async () => {
    const fakePorts = ports();

    await reconcileClaim(input, fakePorts);

    expect(Object.keys(fakePorts.github).sort()).toEqual([
      "getBranch",
      "getIssue",
      "listPullRequests",
    ]);
    expect(Object.keys(fakePorts.git).sort()).toEqual([
      "compareCommits",
      "countUniqueCommits",
      "getWorktree",
    ]);
    expect(Object.keys(fakePorts.docker)).toEqual(["getContainer"]);
    expect(JSON.stringify(Object.keys(fakePorts))).not.toMatch(
      /write|delete|remove|claim|finalize|fetch|checkout|reset|prune|stop|build/u,
    );
  });

  it("rejects non-deterministic or private claim identities before reading ports", async () => {
    const fakePorts = ports();

    await expect(reconcileClaim({
      ...input,
      branch: "/host/private/path",
    }, fakePorts)).rejects.toThrow("Invalid claim identity");

    expect(fakePorts.github.getIssue).not.toHaveBeenCalled();
    expect(fakePorts.git.getWorktree).not.toHaveBeenCalled();
    expect(fakePorts.docker.getContainer).not.toHaveBeenCalled();
  });
});
