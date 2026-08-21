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
        getWorktree: vi.fn(async () => "clean"),
      },
      docker: {
        getContainer: vi.fn(async () => "present"),
      },
    },
    release: {
      removeStoppedContainer: vi.fn(async () => undefined),
      removeCleanWorktree: vi.fn(async () => undefined),
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
    expect(fake.release.removeStoppedContainer).toHaveBeenCalledWith(identity);
    expect(fake.release.removeCleanWorktree).toHaveBeenCalledWith(identity);
    expect(fake.release.compareAndDeleteLocalBranch).toHaveBeenCalledWith({
      ...identity,
      expectedHeadSha: baseSha,
    });
    expect(fake.release.compareAndDeleteBranch).toHaveBeenCalledWith({
      ...identity,
      expectedHeadSha: baseSha,
    });
    expect(fake.failure.addIssueLabel).not.toHaveBeenCalled();
  });

  it.each([
    ["branch absent", (fake: InterruptedClaimFinalizationPorts) => vi.mocked(fake.reconciliation.github.getBranch).mockResolvedValue({ state: "absent" })],
    ["branch head mismatch", (fake: InterruptedClaimFinalizationPorts) => vi.mocked(fake.reconciliation.github.getBranch).mockResolvedValue({ state: "present", headSha: "b".repeat(40) })],
    ["branch ahead", (fake: InterruptedClaimFinalizationPorts) => vi.mocked(fake.reconciliation.git.compareCommits).mockResolvedValue("ahead")],
    ["unique commits", (fake: InterruptedClaimFinalizationPorts) => vi.mocked(fake.reconciliation.git.countUniqueCommits).mockResolvedValue(1)],
    ["dirty worktree", (fake: InterruptedClaimFinalizationPorts) => vi.mocked(fake.reconciliation.git.getWorktree).mockResolvedValue("dirty")],
    ["active container", (fake: InterruptedClaimFinalizationPorts) => vi.mocked(fake.reconciliation.docker.getContainer).mockResolvedValue("active")],
    ["associated Pull Request", (fake: InterruptedClaimFinalizationPorts) => vi.mocked(fake.reconciliation.github.listPullRequests).mockResolvedValue([{ number: 31, state: "closed", headSha: baseSha, closesIssue: true }])],
    ["unknown Git fact", (fake: InterruptedClaimFinalizationPorts) => vi.mocked(fake.reconciliation.git.getWorktree).mockRejectedValue(new Error("unavailable"))],
  ])("preserves the claim when %s is observed", async (_name, change) => {
    const fake = ports();
    change(fake);

    const result = await finalizeInterruptedClaim({
      repository: "example/repository",
      receipt,
    }, fake);

    expect(result.status).toBe("preserved");
    expect(fake.release.removeStoppedContainer).not.toHaveBeenCalled();
    expect(fake.release.removeCleanWorktree).not.toHaveBeenCalled();
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

  it("reports partial cleanup failure and leaves the branch as the recovery anchor", async () => {
    const fake = ports();
    vi.mocked(fake.release.removeCleanWorktree).mockRejectedValue(new Error("worktree changed"));

    const result = await finalizeInterruptedClaim({
      repository: "example/repository",
      receipt,
    }, fake);

    expect(result).toEqual({
      status: "cleanup-failed",
      failures: ["worktree: cleanup-failed"],
    });
    expect(fake.release.compareAndDeleteBranch).not.toHaveBeenCalled();
    expect(fake.failure.addIssueLabel).toHaveBeenCalledWith(209, "sandcastle:failed");
  });
});
