import { describe, expect, it, vi } from "vitest";

import { runBranchUpdateAutomationCommand } from "../.sandcastle/branch-update-automation.js";

const revision = "0123456789abcdef0123456789abcdef01234567";
const updatedRevision = "fedcba9876543210fedcba9876543210fedcba98";
const lease = { acquire: vi.fn(async () => ({ release: async () => {} })) };

function pullRequest(labels = ["agent:update-branch"], headSha = revision) {
  return {
    number: 225,
    state: "OPEN",
    isDraft: true,
    baseRepository: "canxer314/obsidian-llm-wiki-cli",
    headRepository: "canxer314/obsidian-llm-wiki-cli",
    baseRefName: "master",
    headRefName: "sandcastle/issue-221",
    headSha,
    labels,
  };
}

describe("branch update automation command", () => {
  it("acquires an eligible Pull Request and updates its exact head revision in a Target Checkout", async () => {
    const events: string[] = [];
    const github = {
      readPullRequest: vi.fn()
        .mockResolvedValueOnce(pullRequest())
        .mockResolvedValueOnce(pullRequest(["agent:in-progress"])),
      addPullRequestLabel: vi.fn(async (_number: number, label: string) => events.push(`add:${label}`)),
      removePullRequestLabel: vi.fn(async (_number: number, label: string) => events.push(`remove:${label}`)),
    };
    const checkout = {
      withCheckout: vi.fn(async (request, action) => {
        events.push(`checkout:${request.revision}`);
        return action("/safe/disposable-checkout");
      }),
    };
    const updater = {
      update: vi.fn(async (request) => {
        events.push(`update:${request.revision}`);
        expect(request).toMatchObject({
          pullRequestNumber: 225,
          branch: "sandcastle/issue-221",
          baseBranch: "master",
          checkoutPath: "/safe/disposable-checkout",
        });
        return { revision: updatedRevision };
      }),
    };

    await expect(runBranchUpdateAutomationCommand({ pullRequestNumber: 225 }, { github, checkout, updater, lease }))
      .resolves.toEqual({ status: "updated", revision: updatedRevision });

    expect(events).toEqual([
      "add:agent:in-progress",
      "remove:agent:update-branch",
      `checkout:${revision}`,
      `update:${revision}`,
      "remove:agent:in-progress",
    ]);
  });

  it("blocks a changed head during acquisition with diagnostics and cleanup", async () => {
    const events: string[] = [];
    const github = {
      readPullRequest: vi.fn()
        .mockResolvedValueOnce(pullRequest())
        .mockResolvedValueOnce(pullRequest(["agent:in-progress"], updatedRevision)),
      addPullRequestLabel: vi.fn(async (_number: number, label: string) => events.push(`add:${label}`)),
      removePullRequestLabel: vi.fn(async (_number: number, label: string) => events.push(`remove:${label}`)),
      addBranchUpdateBlockedDiagnostic: vi.fn(async (_number: number, diagnostic) => events.push(`blocked:${diagnostic.jobId}`)),
    };

    await expect(runBranchUpdateAutomationCommand({ pullRequestNumber: 225 }, {
      github,
      checkout: { withCheckout: vi.fn() },
      updater: { update: vi.fn() },
      lease,
      createJobId: () => "job-225",
    })).resolves.toEqual({ status: "blocked", reason: "branch-update-execution", jobId: "job-225" });

    expect(github.addBranchUpdateBlockedDiagnostic).toHaveBeenCalledWith(225, {
      reason: "branch-update-execution",
      jobId: "job-225",
      summary: "Pull Request #225 changed while branch update was being acquired",
    });
    expect(events).toEqual([
      "add:agent:in-progress",
      "remove:agent:update-branch",
      "add:agent:blocked",
      "blocked:job-225",
      "remove:agent:in-progress",
    ]);
  });

  it("blocks a lease-rejected remote push and preserves manual retry guidance", async () => {
    const github = {
      readPullRequest: vi.fn()
        .mockResolvedValueOnce(pullRequest())
        .mockResolvedValueOnce(pullRequest(["agent:in-progress"])),
      addPullRequestLabel: vi.fn().mockResolvedValue(undefined),
      removePullRequestLabel: vi.fn().mockResolvedValue(undefined),
      addBranchUpdateBlockedDiagnostic: vi.fn().mockResolvedValue(undefined),
    };

    await expect(runBranchUpdateAutomationCommand({ pullRequestNumber: 225 }, {
      github,
      checkout: { withCheckout: vi.fn(async (_request, action) => action("/safe/disposable-checkout")) },
      updater: { update: vi.fn().mockRejectedValue(new Error("stale info: lease rejected")) },
      lease,
      createJobId: () => "job-225",
    })).resolves.toEqual({ status: "blocked", reason: "branch-update-execution", jobId: "job-225" });

    expect(github.addBranchUpdateBlockedDiagnostic).toHaveBeenCalledWith(225, {
      reason: "branch-update-execution",
      jobId: "job-225",
      summary: "stale info: lease rejected",
    });
  });

  it("refuses an ineligible Pull Request without mutating labels or starting an update", async () => {
    const github = {
      readPullRequest: vi.fn().mockResolvedValue(pullRequest([])),
      addPullRequestLabel: vi.fn(),
      removePullRequestLabel: vi.fn(),
    };
    const checkout = { withCheckout: vi.fn() };
    const updater = { update: vi.fn() };

    await expect(runBranchUpdateAutomationCommand({ pullRequestNumber: 225 }, { github, checkout, updater, lease }))
      .resolves.toEqual({ status: "refused", reason: "Pull Request #225 is not queued for branch update" });

    expect(github.addPullRequestLabel).not.toHaveBeenCalled();
    expect(github.removePullRequestLabel).not.toHaveBeenCalled();
    expect(checkout.withCheckout).not.toHaveBeenCalled();
    expect(updater.update).not.toHaveBeenCalled();
  });

  it("blocks a merge conflict with local diagnostics and restores retry state", async () => {
    const github = {
      readPullRequest: vi.fn()
        .mockResolvedValueOnce(pullRequest())
        .mockResolvedValueOnce(pullRequest(["agent:in-progress"])),
      addPullRequestLabel: vi.fn().mockResolvedValue(undefined),
      removePullRequestLabel: vi.fn().mockResolvedValue(undefined),
      addBranchUpdateBlockedDiagnostic: vi.fn().mockResolvedValue(undefined),
    };

    await expect(runBranchUpdateAutomationCommand({ pullRequestNumber: 225 }, {
      github,
      checkout: { withCheckout: vi.fn(async (_request, action) => action("/safe/disposable-checkout")) },
      updater: { update: vi.fn().mockRejectedValue(new Error("merge conflict in src/index.ts")) },
      lease,
      createJobId: () => "job-225",
    })).resolves.toEqual({ status: "blocked", reason: "branch-update-execution", jobId: "job-225" });

    expect(github.addPullRequestLabel).toHaveBeenCalledWith(225, "agent:blocked");
    expect(github.addBranchUpdateBlockedDiagnostic).toHaveBeenCalledWith(225, {
      reason: "branch-update-execution",
      jobId: "job-225",
      summary: "merge conflict in src/index.ts",
    });
  });

  it("refuses a concurrent branch update before invoking another updater", async () => {
    let releaseUpdate!: () => void;
    const updateFinished = new Promise<void>((resolve) => { releaseUpdate = resolve; });
    const github = {
      readPullRequest: vi.fn()
        .mockResolvedValueOnce(pullRequest())
        .mockResolvedValueOnce(pullRequest(["agent:in-progress"])),
      addPullRequestLabel: vi.fn().mockResolvedValue(undefined),
      removePullRequestLabel: vi.fn().mockResolvedValue(undefined),
    };
    const updater = {
      update: vi.fn(async () => {
        await updateFinished;
        return { revision: updatedRevision };
      }),
    };
    const ports = {
      github,
      checkout: { withCheckout: vi.fn(async (_request, action) => action("/safe/disposable-checkout")) },
      updater,
      lease,
    };
    const first = runBranchUpdateAutomationCommand({ pullRequestNumber: 225 }, ports);
    await vi.waitFor(() => expect(updater.update).toHaveBeenCalledOnce());
    await expect(runBranchUpdateAutomationCommand({ pullRequestNumber: 225 }, ports))
      .resolves.toEqual({ status: "refused", reason: "Pull Request #225 is already being updated" });
    releaseUpdate();
    await first;
  });
});
