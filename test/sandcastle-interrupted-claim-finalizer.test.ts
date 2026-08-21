import { describe, expect, it, vi } from "vitest";

import {
  finalizeInterruptedClaim,
  type InterruptedClaimFinalizationPorts,
} from "../.sandcastle/interrupted-claim-finalizer.js";
import type { SandcastleClaimReceipt } from "../.sandcastle/cli.js";

const baseSha = "a".repeat(40);
const receipt: SandcastleClaimReceipt = {
  issueNumber: 209,
  runId: "run-current-process",
  branch: "sandcastle/issue-209",
  baseSha,
};

function ports(): InterruptedClaimFinalizationPorts {
  return {
    reconciliation: {
      github: {
        getIssue: vi.fn(async () => ({ existence: "present", state: "open", eligible: true })),
        getBranch: vi.fn(async () => ({ state: "present", headSha: baseSha })),
        listPullRequests: vi.fn(async () => []),
      },
      git: {
        compareCommits: vi.fn(async () => "equal"),
        countUniqueCommits: vi.fn(async () => 0),
        getWorktree: vi.fn(async () => "absent"),
      },
      docker: {
        getContainer: vi.fn(async () => "absent"),
      },
    },
    release: {
      compareAndDeleteLocalBranch: vi.fn(async () => undefined),
      compareAndDeleteBranch: vi.fn(async () => undefined),
    },
    failure: {
      addIssueComment: vi.fn(async () => undefined),
      addPullRequestComment: vi.fn(async () => undefined),
      addIssueLabel: vi.fn(async () => undefined),
      removeIssueLabel: vi.fn(async () => undefined),
    },
  };
}

describe("interrupted current-process claim finalization", () => {
  it("releases every proven-empty resource and binds branch deletion to the receipt SHA", async () => {
    const fake = ports();

    await expect(finalizeInterruptedClaim({
      repository: "example/repository",
      receipt,
    }, fake)).resolves.toEqual({ status: "released", failures: [] });

    const identity = {
      repository: "example/repository",
      issueNumber: 209,
      branch: "sandcastle/issue-209",
      comparisonBaseSha: baseSha,
    };
    expect(fake.release.compareAndDeleteBranch).toHaveBeenCalledWith({
      ...identity,
      expectedHeadSha: baseSha,
    });
    expect(fake.release.compareAndDeleteLocalBranch).toHaveBeenCalledWith({
      ...identity,
      expectedHeadSha: baseSha,
    });
    expect(fake.failure.addIssueLabel).not.toHaveBeenCalled();
  });

  it.each([
    ["branch absent", (fake: InterruptedClaimFinalizationPorts) => vi.mocked(fake.reconciliation.github.getBranch).mockResolvedValue({ state: "absent" })],
    ["branch unknown", (fake: InterruptedClaimFinalizationPorts) => vi.mocked(fake.reconciliation.github.getBranch).mockRejectedValue(new Error("unavailable"))],
    ["branch head mismatch", (fake: InterruptedClaimFinalizationPorts) => vi.mocked(fake.reconciliation.github.getBranch).mockResolvedValue({ state: "present", headSha: "b".repeat(40) })],
    ...(["ahead", "behind", "diverged"] as const).map((relation) => [
      `branch ${relation}`,
      (fake: InterruptedClaimFinalizationPorts) => vi.mocked(fake.reconciliation.git.compareCommits).mockResolvedValue(relation),
    ] as const),
    ["branch relation unknown", (fake: InterruptedClaimFinalizationPorts) => vi.mocked(fake.reconciliation.git.compareCommits).mockRejectedValue(new Error("unavailable"))],
    ["unique commits", (fake: InterruptedClaimFinalizationPorts) => vi.mocked(fake.reconciliation.git.countUniqueCommits).mockResolvedValue(1)],
    ["unique commits unknown", (fake: InterruptedClaimFinalizationPorts) => vi.mocked(fake.reconciliation.git.countUniqueCommits).mockRejectedValue(new Error("unavailable"))],
    ["clean worktree", (fake: InterruptedClaimFinalizationPorts) => vi.mocked(fake.reconciliation.git.getWorktree).mockResolvedValue("clean")],
    ["dirty worktree", (fake: InterruptedClaimFinalizationPorts) => vi.mocked(fake.reconciliation.git.getWorktree).mockResolvedValue("dirty")],
    ["unknown worktree", (fake: InterruptedClaimFinalizationPorts) => vi.mocked(fake.reconciliation.git.getWorktree).mockRejectedValue(new Error("unavailable"))],
    ["stopped container", (fake: InterruptedClaimFinalizationPorts) => vi.mocked(fake.reconciliation.docker.getContainer).mockResolvedValue("present")],
    ["active container", (fake: InterruptedClaimFinalizationPorts) => vi.mocked(fake.reconciliation.docker.getContainer).mockResolvedValue("active")],
    ["unknown container", (fake: InterruptedClaimFinalizationPorts) => vi.mocked(fake.reconciliation.docker.getContainer).mockRejectedValue(new Error("unavailable"))],
    ...(["open", "closed"] as const).map((state) => [
      `${state} Pull Request`,
      (fake: InterruptedClaimFinalizationPorts) => vi.mocked(fake.reconciliation.github.listPullRequests).mockResolvedValue([{ number: 31, state, headSha: baseSha, closesIssue: true }]),
    ] as const),
    ["multiple Pull Requests", (fake: InterruptedClaimFinalizationPorts) => vi.mocked(fake.reconciliation.github.listPullRequests).mockResolvedValue([
      { number: 31, state: "closed", headSha: baseSha, closesIssue: true },
      { number: 32, state: "closed", headSha: baseSha, closesIssue: true },
    ])],
    ["unknown Pull Requests", (fake: InterruptedClaimFinalizationPorts) => vi.mocked(fake.reconciliation.github.listPullRequests).mockRejectedValue(new Error("unavailable"))],
    ["unknown Issue", (fake: InterruptedClaimFinalizationPorts) => vi.mocked(fake.reconciliation.github.getIssue).mockRejectedValue(new Error("unavailable"))],
  ])("preserves the claim when %s is observed", async (_name, change) => {
    const fake = ports();
    change(fake);

    const result = await finalizeInterruptedClaim({
      repository: "example/repository",
      receipt,
    }, fake);

    expect(result.status).toBe("preserved");
    expect(fake.release.compareAndDeleteLocalBranch).not.toHaveBeenCalled();
    expect(fake.release.compareAndDeleteBranch).not.toHaveBeenCalled();
    expect(fake.failure.addIssueLabel).toHaveBeenCalledWith(209, "sandcastle:failed");
    expect(fake.failure.removeIssueLabel).toHaveBeenCalledWith(209, "Sandcastle");
    expect(vi.mocked(fake.failure.addIssueComment).mock.calls[0]?.[1]).toContain("Failure stage: `interrupted`");
  });

  it("keeps merged delivery authoritative without cleanup or failure finalization", async () => {
    const fake = ports();
    vi.mocked(fake.reconciliation.github.listPullRequests).mockResolvedValue([{
      number: 31,
      state: "merged",
      headSha: baseSha,
      closesIssue: true,
    }]);

    await expect(finalizeInterruptedClaim({
      repository: "example/repository",
      receipt,
    }, fake)).resolves.toEqual({ status: "delivery-complete", failures: [] });

    expect(fake.release.compareAndDeleteBranch).not.toHaveBeenCalled();
    expect(fake.failure.addIssueLabel).not.toHaveBeenCalled();
  });

  it("preserves the remote branch when its expected head changes during compare-delete", async () => {
    const fake = ports();
    vi.mocked(fake.release.compareAndDeleteBranch).mockRejectedValue(
      new Error("stale lease"),
    );

    const result = await finalizeInterruptedClaim({
      repository: "example/repository",
      receipt,
    }, fake);

    expect(result).toEqual({
      status: "cleanup-failed",
      failures: ["branch: cleanup-failed"],
    });
    expect(fake.release.compareAndDeleteBranch).toHaveBeenCalledWith(
      expect.objectContaining({ expectedHeadSha: baseSha }),
    );
    expect(fake.release.compareAndDeleteLocalBranch).not.toHaveBeenCalled();
    expect(fake.failure.addIssueLabel).toHaveBeenCalledWith(209, "sandcastle:failed");
  });

  it("reports local branch cleanup failure after the remote branch was safely released", async () => {
    const fake = ports();
    vi.mocked(fake.release.compareAndDeleteLocalBranch).mockRejectedValue(
      new Error("local ref changed"),
    );

    const result = await finalizeInterruptedClaim({
      repository: "example/repository",
      receipt,
    }, fake);

    expect(result).toEqual({
      status: "cleanup-failed",
      failures: ["local-branch: cleanup-failed"],
    });
    expect(fake.release.compareAndDeleteBranch).toHaveBeenCalledOnce();
    expect(fake.failure.addIssueLabel).toHaveBeenCalledWith(209, "sandcastle:failed");
  });
});
