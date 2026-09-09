import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { ImplementerGitState } from "../.sandcastle/implementer-git-state.js";
import type { ImplementerAgentSession } from "../.sandcastle/implementer-session.js";
import {
  ImplementerResultError,
  implementIssue,
  type ImplementerGithubPort,
} from "../.sandcastle/implementer.js";
import { isStopRetry } from "../.sandcastle/invocation-recovery.js";
import { createJobLog } from "../.sandcastle/job-logs.js";

const plan = {
  status: "ready" as const,
  implementationSummary: "Implement the requested behavior.",
  blockingReason: null,
  allowsAutomationChanges: false,
  issue: {
    number: 103,
    title: "Implementer",
    body: "Implement this Issue.",
    labels: ["Sandcastle"],
    comments: [],
  },
};

const branch = "sandcastle/issue-103";
const checkoutPath = "/safe/disposable-checkout";
const baseline = "a".repeat(40);
const headOne = "b".repeat(40);
const headTwo = "c".repeat(40);
const foreignHead = "d".repeat(40);
const pullRequestUrl = "https://github.com/example/repo/pull/321";

interface BranchState {
  local: string | undefined;
  remote: string | undefined;
  worktree: { readonly path: string; readonly clean: boolean } | undefined;
}

// A stateful Git-state double: local/remote refs and the managed worktree
// evolve as fake Agent attempts mutate them, and ancestry follows an ordered
// chain of revisions. Revisions outside the chain make merge-base fail the
// way unknown objects do.
function branchStateDouble(options?: {
  readonly chain?: readonly string[];
  readonly local?: string;
  readonly remote?: string;
  readonly worktree?: BranchState["worktree"];
}): {
  readonly state: BranchState;
  readonly port: ImplementerGitState;
} {
  const state: BranchState = {
    local: options?.local,
    remote: options?.remote,
    worktree: options?.worktree,
  };
  const chain = options?.chain ?? [baseline, headOne, headTwo];
  const port: ImplementerGitState = {
    prepareBranch: vi.fn(async (request: { branch: string; baseline: string }) => {
      state.local = request.baseline;
    }),
    fetchRemote: vi.fn(async () => {}),
    observeLocalBranch: vi.fn(async () => state.local),
    observeRemoteBranch: vi.fn(async () => state.remote),
    isAncestor: vi.fn(async (ancestor: string, descendant: string) => {
      const ancestorIndex = chain.indexOf(ancestor);
      const descendantIndex = chain.indexOf(descendant);
      if (ancestorIndex === -1 || descendantIndex === -1) {
        throw new Error("git merge-base exited with 128");
      }
      return ancestorIndex <= descendantIndex;
    }),
    observeManagedWorktree: vi.fn(async () => state.worktree),
  };
  return { state, port };
}

function githubDouble(): ImplementerGithubPort & {
  readonly verifyImplementation: ReturnType<typeof vi.fn>;
} {
  return {
    verifyImplementation: vi.fn(async (request: { expectedHeadSha: string }) => ({
      number: 321,
      headSha: request.expectedHeadSha,
      url: pullRequestUrl,
    })),
  };
}

function harness(options?: {
  readonly double?: ReturnType<typeof branchStateDouble>;
  readonly run?: ReturnType<typeof vi.fn>;
  readonly github?: ImplementerGithubPort;
}) {
  const double = options?.double ?? branchStateDouble();
  const run = options?.run ?? vi.fn(async () => {
    double.state.local = headOne;
    return { branch, commits: [{ sha: headOne }] };
  });
  const session: ImplementerAgentSession = { run: run as never };
  const github = options?.github ?? githubDouble();
  const wait = vi.fn(async () => {});
  const request = {
    plan,
    model: "implementer-model",
    session,
    baseRevision: baseline,
    checkoutPath,
    github,
    gitState: double.port,
    wait: wait as (milliseconds: number, signal?: AbortSignal) => Promise<void>,
  };
  return { double, run, session, github, wait, request };
}

describe("Sandcastle Implementer", () => {
  it("prepares the deterministic branch at the frozen baseline and verifies the pushed Draft PR", async () => {
    const { double, request, run, github, wait } = harness();

    await expect(implementIssue(request)).resolves.toEqual({
      number: 321,
      headSha: headOne,
      url: pullRequestUrl,
    });

    // Preparation created the local branch at the frozen baseline without
    // checking it out, after proving no same-name remote branch exists.
    expect(double.port.prepareBranch).toHaveBeenCalledWith({ branch, baseline });
    expect(double.port.observeRemoteBranch).toHaveBeenCalledWith(branch);
    expect(run).toHaveBeenCalledOnce();
    expect(run).toHaveBeenCalledWith({
      model: "implementer-model",
      branch,
      plan,
      checkoutPath,
    });
    expect(github.verifyImplementation).toHaveBeenCalledWith({
      issueNumber: 103,
      branch,
      expectedHeadSha: headOne,
      allowsAutomationChanges: false,
    });
    expect(wait).not.toHaveBeenCalled();
  });

  it("recovers the pushed branch head when attempt one advanced and pushed before rejecting and attempt two adds no commits", async () => {
    const double = branchStateDouble();
    const run = vi.fn()
      .mockImplementationOnce(async () => {
        // The interrupted attempt committed and pushed the named branch,
        // then the invocation rejected.
        double.state.local = headOne;
        double.state.remote = headOne;
        throw new Error("provider stream ended");
      })
      .mockResolvedValue({ branch, commits: [] });
    const { request, github } = harness({ double, run });

    await expect(implementIssue(request)).resolves.toEqual({
      number: 321,
      headSha: headOne,
      url: pullRequestUrl,
    });

    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[0]![0]).not.toHaveProperty("recovery");
    expect(run.mock.calls[1]![0]).toEqual(expect.objectContaining({
      recovery: { baseline },
    }));
    // The branch was prepared once; the recovery attempt continued the
    // durable state without duplicating commits, pushes, or Pull Requests.
    expect(double.port.prepareBranch).toHaveBeenCalledOnce();
    // The durable named ref — not the empty commit delta of the final run —
    // is the head handed to Pull Request verification.
    expect(github.verifyImplementation).toHaveBeenCalledWith(expect.objectContaining({
      branch,
      expectedHeadSha: headOne,
    }));
  });

  it("accepts a remote that is a known ancestor on the baseline-to-local path", async () => {
    const double = branchStateDouble();
    const run = vi.fn()
      .mockImplementationOnce(async () => {
        // Pushed headOne, then advanced locally to headTwo before rejecting.
        double.state.local = headTwo;
        double.state.remote = headOne;
        throw new Error("sandbox restarted");
      })
      .mockResolvedValue({ branch, commits: [] });
    const { request, github } = harness({ double, run });

    await expect(implementIssue(request)).resolves.toEqual({
      number: 321,
      headSha: headTwo,
      url: pullRequestUrl,
    });
    expect(github.verifyImplementation).toHaveBeenCalledWith(expect.objectContaining({
      expectedHeadSha: headTwo,
    }));
  });

  it("stops recovery when an unexpected same-name remote branch appears after the preflight", async () => {
    const double = branchStateDouble({ remote: foreignHead, chain: [baseline, foreignHead] });
    const { request, run, github } = harness({ double });

    const failure = await implementIssue(request).catch((error: unknown) => error);

    expect(isStopRetry(failure)).toBe(true);
    // The unexpected remote branch is never adopted: no Agent attempt runs.
    expect(run).not.toHaveBeenCalled();
    expect(double.port.prepareBranch).not.toHaveBeenCalled();
    expect(github.verifyImplementation).not.toHaveBeenCalled();
  });

  it("keeps a leftover local branch that descends from the frozen baseline instead of re-preparing it", async () => {
    const double = branchStateDouble({ local: headOne });
    const { request, run } = harness({ double });

    await implementIssue(request);

    expect(double.port.prepareBranch).not.toHaveBeenCalled();
    expect(run).toHaveBeenCalledOnce();
  });

  it("stops recovery when a leftover local branch does not descend from the frozen baseline", async () => {
    const double = branchStateDouble({ local: foreignHead, chain: [baseline, foreignHead] });
    // The leftover branch carries history unrelated to the frozen baseline.
    vi.mocked(double.port.isAncestor).mockResolvedValue(false);
    const { request, run } = harness({ double });

    const failure = await implementIssue(request).catch((error: unknown) => error);

    expect(isStopRetry(failure)).toBe(true);
    expect(run).not.toHaveBeenCalled();
  });

  it("stops further Agent calls when the remote branch moved ahead of the local branch", async () => {
    const double = branchStateDouble();
    const run = vi.fn().mockImplementation(async () => {
      double.state.local = headOne;
      double.state.remote = headTwo;
      throw new Error("provider stream ended");
    });
    const { request, github } = harness({ double, run });

    const failure = await implementIssue(request).catch((error: unknown) => error);

    expect(isStopRetry(failure)).toBe(true);
    // Reconciliation stopped the window before a second Agent invocation.
    expect(run).toHaveBeenCalledOnce();
    expect(github.verifyImplementation).not.toHaveBeenCalled();
  });

  it("stops further Agent calls when the local and remote branches diverged", async () => {
    const double = branchStateDouble({ chain: [baseline, headOne, foreignHead] });
    const run = vi.fn().mockImplementation(async () => {
      double.state.local = headOne;
      double.state.remote = foreignHead;
      throw new Error("provider stream ended");
    });
    const { request, github } = harness({ double, run });

    const failure = await implementIssue(request).catch((error: unknown) => error);

    expect(isStopRetry(failure)).toBe(true);
    expect(run).toHaveBeenCalledOnce();
    expect(github.verifyImplementation).not.toHaveBeenCalled();
  });

  it("stops further Agent calls when an observed branch revision is malformed", async () => {
    const double = branchStateDouble();
    const run = vi.fn().mockImplementation(async () => {
      double.state.local = "not-a-sha";
      throw new Error("provider stream ended");
    });
    const { request } = harness({ double, run });

    const failure = await implementIssue(request).catch((error: unknown) => error);

    expect(isStopRetry(failure)).toBe(true);
    expect(run).toHaveBeenCalledOnce();
  });

  it("stops further Agent calls when branch ancestry cannot be proven", async () => {
    const double = branchStateDouble();
    // Unknown objects make merge-base fail; the read policy retries the
    // failed read and then stops the recovery window.
    vi.mocked(double.port.isAncestor).mockRejectedValue(new Error("git merge-base exited with 128"));
    const run = vi.fn().mockImplementation(async () => {
      double.state.local = headOne;
      throw new Error("provider stream ended");
    });
    const { request, wait } = harness({ double, run });

    const failure = await implementIssue(request).catch((error: unknown) => error);

    expect(isStopRetry(failure)).toBe(true);
    expect(run).toHaveBeenCalledOnce();
    // The first wait is the invocation-recovery backoff before attempt two;
    // the read policy then applied the shared delay rules — two seconds
    // before the second read, eight before the third.
    expect(wait).toHaveBeenCalledTimes(3);
    expect(wait).toHaveBeenNthCalledWith(1, 2_000, undefined);
    expect(wait).toHaveBeenNthCalledWith(2, 2_000, undefined);
    expect(wait).toHaveBeenNthCalledWith(3, 8_000, undefined);
  });

  it("retries a failed branch-state read without consuming an Agent invocation attempt", async () => {
    const double = branchStateDouble();
    vi.mocked(double.port.observeLocalBranch)
      .mockRejectedValueOnce(new Error("index.lock held"))
      .mockRejectedValueOnce(new Error("index.lock held"))
      .mockImplementation(async () => double.state.local);
    const { request, run, wait } = harness({ double });

    await expect(implementIssue(request)).resolves.toEqual(expect.objectContaining({
      headSha: headOne,
    }));

    // The two read retries consumed no Agent invocation attempt.
    expect(run).toHaveBeenCalledOnce();
    expect(wait).toHaveBeenCalledTimes(2);
  });

  it("stops further Agent calls when branch-state reads exhaust their bounded attempts", async () => {
    const double = branchStateDouble();
    vi.mocked(double.port.observeLocalBranch).mockRejectedValue(new Error("repository corrupted"));
    const { request, run, github, wait } = harness({ double });

    const failure = await implementIssue(request).catch((error: unknown) => error);

    expect(isStopRetry(failure)).toBe(true);
    // Preparation reads never succeeded, so no Agent invocation ran at all.
    expect(run).not.toHaveBeenCalled();
    expect(github.verifyImplementation).not.toHaveBeenCalled();
    expect(wait).toHaveBeenCalledTimes(2);
  });

  it("logs branch-state read retries under their own sanitized label", async () => {
    const double = branchStateDouble();
    vi.mocked(double.port.observeRemoteBranch).mockRejectedValueOnce(new Error("network unreachable"));
    const { request } = harness({ double });
    const log = await createJobLog({
      root: mkdtempSync(join(tmpdir(), "implementer-log-")),
      jobId: "implementer-branch-state",
      operation: "implement-issue",
      number: 103,
      revision: baseline,
      now: 1_700_000_000_000,
    });

    await implementIssue({ ...request, log });

    const stderr = readFileSync(log.stderrPath, "utf8");
    expect(stderr).toContain("[implementer-branch-state]");
    expect(stderr).toContain("\"label\":\"prepare\"");
  });

  it("gives a successful attempt that left the managed worktree dirty another bounded attempt", async () => {
    const worktreePath = `${checkoutPath}/.sandcastle/worktrees/sandcastle-issue-103`;
    const double = branchStateDouble();
    const run = vi.fn()
      .mockImplementationOnce(async () => {
        double.state.local = headOne;
        double.state.worktree = { path: worktreePath, clean: false };
        return { branch, commits: [{ sha: headOne }] };
      })
      .mockImplementationOnce(async () => {
        double.state.worktree = undefined;
        return { branch, commits: [] };
      });
    const { request, github } = harness({ double, run });

    await expect(implementIssue(request)).resolves.toEqual(expect.objectContaining({
      headSha: headOne,
    }));
    expect(run).toHaveBeenCalledTimes(2);
    expect(double.port.observeManagedWorktree).toHaveBeenCalledTimes(2);
    expect(github.verifyImplementation).toHaveBeenCalledOnce();
  });

  it("gives a successful attempt that did not advance the frozen baseline another bounded attempt", async () => {
    const double = branchStateDouble();
    const run = vi.fn()
      .mockResolvedValueOnce({ branch, commits: [] })
      .mockImplementationOnce(async () => {
        double.state.local = headOne;
        return { branch, commits: [{ sha: headOne }] };
      });
    const { request, github } = harness({ double, run });

    await expect(implementIssue(request)).resolves.toEqual(expect.objectContaining({
      headSha: headOne,
    }));
    expect(run).toHaveBeenCalledTimes(2);
    expect(github.verifyImplementation).toHaveBeenCalledWith(expect.objectContaining({
      expectedHeadSha: headOne,
    }));
  });

  it("never succeeds from durable work left by three throwing attempts", async () => {
    const double = branchStateDouble();
    const interruption = new Error("Implementer session interrupted");
    const run = vi.fn().mockImplementation(async () => {
      // Every attempt committed and pushed durably, then rejected.
      double.state.local = headOne;
      double.state.remote = headOne;
      throw interruption;
    });
    const { request, github } = harness({ double, run });

    await expect(implementIssue(request)).rejects.toBe(interruption);

    expect(run).toHaveBeenCalledTimes(3);
    // At least one Agent invocation must return successfully: the durable
    // commits, pushes, and any Draft Pull Request cannot produce success.
    expect(github.verifyImplementation).not.toHaveBeenCalled();
  });

  it("fails closed for a wrong result branch before trusting GitHub state", async () => {
    const run = vi.fn(async () => ({ branch: "other", commits: [{ sha: headOne }] }));
    const github = githubDouble();
    const { request } = harness({ run, github });

    await expect(implementIssue(request)).rejects.toBeInstanceOf(ImplementerResultError);

    expect(run).toHaveBeenCalledTimes(3);
    expect(github.verifyImplementation).not.toHaveBeenCalled();
  });

  it("propagates remote or Draft Pull Request verification failures", async () => {
    const failure = new Error("Remote branch sandcastle/issue-103 does not match the Implementer commit");
    const github = githubDouble();
    vi.mocked(github.verifyImplementation).mockRejectedValue(failure);
    const { request, run } = harness({ github });

    await expect(implementIssue(request)).rejects.toBe(failure);
    expect(run).toHaveBeenCalledOnce();
  });

  it("refuses an invalid authorized base revision before touching branch state", async () => {
    const double = branchStateDouble();
    const { request, run } = harness({ double });

    await expect(implementIssue({ ...request, baseRevision: "not-a-revision" }))
      .rejects.toBeInstanceOf(ImplementerResultError);

    expect(double.port.fetchRemote).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });
});
