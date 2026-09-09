import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { ImplementerGitState } from "../.sandcastle/implementer-git-state.js";
import type { ImplementerAgentSession } from "../.sandcastle/implementer-session.js";
import {
  ImplementerResultError,
  implementSpecChild,
} from "../.sandcastle/implementer.js";
import { isStopRetry } from "../.sandcastle/invocation-recovery.js";
import { createJobLog } from "../.sandcastle/job-logs.js";

const plan = {
  status: "ready" as const,
  implementationSummary: "Implement this child of the Spec.",
  blockingReason: null,
  allowsAutomationChanges: false,
  issue: {
    number: 301,
    title: "Child one",
    body: "Implement this Issue.",
    labels: ["ready-for-agent"],
    comments: [],
  },
};

const specNumber = 226;
const branch = "sandcastle/spec-226";
const checkoutPath = "/safe/disposable-checkout";
// The parent Spec's authorized base revision; the frozen baseline only when
// the shared accumulating branch does not exist yet on origin.
const baseRevision = "a".repeat(40);
// Head of the shared accumulating branch after earlier children completed.
const sharedHead = "b".repeat(40);
// Current-child commit created on top of the earlier children.
const childHead = "c".repeat(40);
const foreignHead = "d".repeat(40);

interface BranchState {
  local: string | undefined;
  remote: string | undefined;
  worktree: { readonly path: string; readonly clean: boolean } | undefined;
}

// A stateful Git-state double for the shared accumulating branch: local/remote
// refs evolve as fake Agent attempts mutate them, and ancestry follows an
// ordered chain of revisions. Revisions outside the chain make merge-base fail
// the way unknown objects do.
function specChildDouble(options?: {
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
    // An existing shared accumulating branch (the earlier-children head) is
    // the expected durable state for a Spec child; tests that need the absent
    // branch case pass an explicit undefined remote.
    remote: options !== undefined && "remote" in options ? options.remote : sharedHead,
    worktree: options?.worktree,
  };
  const chain = options?.chain ?? [baseRevision, sharedHead, childHead];
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

function harness(options?: {
  readonly double?: ReturnType<typeof specChildDouble>;
  readonly run?: ReturnType<typeof vi.fn>;
}) {
  const double = options?.double ?? specChildDouble();
  const run = options?.run ?? vi.fn(async () => {
    double.state.local = childHead;
    return { branch, commits: [{ sha: childHead }] };
  });
  const session: ImplementerAgentSession = { run: run as never };
  const wait = vi.fn(async () => {});
  const request = {
    plan,
    model: "implementer-model",
    session,
    specNumber,
    branch,
    baseRevision,
    checkoutPath,
    gitState: double.port,
    wait: wait as (milliseconds: number, signal?: AbortSignal) => Promise<void>,
  };
  return { double, run, session, wait, request };
}

describe("Spec-child durable Implementer", () => {
  it("freezes the existing shared remote branch head as the baseline and prepares the local accumulating branch there", async () => {
    const { double, request, run } = harness();

    await expect(implementSpecChild(request)).resolves.toEqual({ branch, headSha: childHead });

    // The shared branch was fetched and its verified head became the frozen
    // baseline; the local accumulating branch was prepared there so the
    // earlier completed children remain reachable below the current child.
    expect(double.port.fetchRemote).toHaveBeenCalled();
    expect(double.port.observeRemoteBranch).toHaveBeenCalledWith(branch);
    expect(double.port.prepareBranch).toHaveBeenCalledWith({ branch, baseline: sharedHead });
    // The durable head read proved the current-child commit descends from the
    // earlier-children baseline.
    expect(double.port.isAncestor).toHaveBeenCalledWith(sharedHead, childHead);
    expect(run).toHaveBeenCalledOnce();
    expect(run).toHaveBeenCalledWith({
      model: "implementer-model",
      branch,
      plan,
      checkoutPath,
      parentSpec: { number: specNumber },
    });
    expect(run.mock.calls[0]![0]).not.toHaveProperty("recovery");
  });

  it("uses the authorized base revision as the baseline when the shared remote branch does not exist", async () => {
    const double = specChildDouble({ remote: undefined });
    const { request, run } = harness({ double });

    await expect(implementSpecChild(request)).resolves.toEqual({ branch, headSha: childHead });

    expect(double.port.fetchRemote).toHaveBeenCalled();
    expect(double.port.observeRemoteBranch).toHaveBeenCalledWith(branch);
    expect(double.port.prepareBranch).toHaveBeenCalledWith({ branch, baseline: baseRevision });
    expect(run).toHaveBeenCalledOnce();
  });

  it("keeps a leftover local accumulating branch that descends from the frozen shared baseline", async () => {
    const double = specChildDouble({ local: childHead });
    const { request, run } = harness({ double });

    await expect(implementSpecChild(request)).resolves.toEqual({ branch, headSha: childHead });

    // Earlier durable work is reused rather than re-prepared.
    expect(double.port.prepareBranch).not.toHaveBeenCalled();
    expect(run).toHaveBeenCalledOnce();
  });

  it("stops before any Agent attempt when a leftover local branch does not descend from the frozen shared baseline", async () => {
    const double = specChildDouble({
      local: foreignHead,
      chain: [baseRevision, sharedHead, foreignHead],
    });
    // The leftover branch carries history unrelated to the accumulated branch.
    vi.mocked(double.port.isAncestor).mockResolvedValue(false);
    const { request, run } = harness({ double });

    const failure = await implementSpecChild(request).catch((error: unknown) => error);

    expect(isStopRetry(failure)).toBe(true);
    expect(run).not.toHaveBeenCalled();
  });

  it("recovers an interrupted current-child commit when a later invocation returns successfully without adding a commit", async () => {
    const double = specChildDouble();
    const run = vi.fn()
      .mockImplementationOnce(async () => {
        // The interrupted attempt committed and pushed the current child on
        // top of the earlier children, then the invocation rejected.
        double.state.local = childHead;
        double.state.remote = childHead;
        throw new Error("provider stream ended");
      })
      .mockResolvedValue({ branch, commits: [] });
    const { request } = harness({ double, run });

    await expect(implementSpecChild(request)).resolves.toEqual({ branch, headSha: childHead });

    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[0]![0]).not.toHaveProperty("recovery");
    expect(run.mock.calls[1]![0]).toEqual(expect.objectContaining({
      parentSpec: { number: specNumber },
      recovery: { baseline: sharedHead },
    }));
    // The branch was prepared once; the recovery attempt continued the
    // durable state without resetting the local branch to origin, duplicating
    // the push, or duplicating the earlier children.
    expect(double.port.prepareBranch).toHaveBeenCalledOnce();
    expect(double.port.isAncestor).toHaveBeenCalledWith(sharedHead, childHead);
    // The durable named ref — not the empty commit delta of the final run —
    // is the head reported to the higher-level Spec publication.
  });

  it("accepts a shared remote that is a known ancestor on the frozen-baseline-to-local path", async () => {
    const double = specChildDouble();
    const run = vi.fn()
      .mockImplementationOnce(async () => {
        // The interrupted attempt created the current-child commit locally
        // but had not yet pushed it, so the shared remote still points at the
        // earlier-children head (a known ancestor of the local branch).
        double.state.local = childHead;
        throw new Error("sandbox restarted");
      })
      .mockResolvedValue({ branch, commits: [] });
    const { request } = harness({ double, run });

    await expect(implementSpecChild(request)).resolves.toEqual({ branch, headSha: childHead });
    expect(double.port.isAncestor).toHaveBeenCalledWith(sharedHead, childHead);
  });

  it("stops further Agent calls when the shared remote moved to a commit outside the frozen-baseline-to-local path", async () => {
    // The interrupted attempt rewound origin/<branch> to an ancestor of the
    // frozen earlier-children baseline (baseRevision precedes sharedHead in
    // the chain). Such a remote is an ancestor of the local current-child head
    // but is NOT on the frozen-baseline-to-local path, so it must stop rather
    // than be adopted: continuing could re-push a branch whose earlier-child
    // history was reset or folded into foreign history.
    const double = specChildDouble();
    const run = vi.fn().mockImplementation(async () => {
      double.state.local = childHead;
      double.state.remote = baseRevision;
      throw new Error("provider stream ended");
    });
    const { request, wait } = harness({ double, run });

    const failure = await implementSpecChild(request).catch((error: unknown) => error);

    expect(isStopRetry(failure)).toBe(true);
    expect((failure as Error).message).toContain("moved ahead or diverged");
    // Reconciliation stopped the window before a second Agent invocation.
    expect(run).toHaveBeenCalledOnce();
    expect(wait).toHaveBeenCalledOnce();
  });

  it("stops further Agent calls when the shared remote branch moved ahead of the local accumulating branch", async () => {
    const double = specChildDouble({
      chain: [baseRevision, sharedHead, childHead, foreignHead],
    });
    const run = vi.fn().mockImplementation(async () => {
      double.state.local = childHead;
      double.state.remote = foreignHead;
      throw new Error("provider stream ended");
    });
    const { request, wait } = harness({ double, run });

    const failure = await implementSpecChild(request).catch((error: unknown) => error);

    expect(isStopRetry(failure)).toBe(true);
    // Reconciliation stopped the window before a second Agent invocation.
    expect(run).toHaveBeenCalledOnce();
    expect(wait).toHaveBeenCalledOnce();
  });

  it("stops further Agent calls when the local and shared remote branches diverged", async () => {
    const double = specChildDouble({
      chain: [baseRevision, sharedHead, childHead],
    });
    const run = vi.fn().mockImplementation(async () => {
      double.state.local = childHead;
      double.state.remote = foreignHead;
      throw new Error("provider stream ended");
    });
    // The foreign remote head is not an ancestor of the local current-child
    // head, so the interrupted attempt's concurrent state cannot be proven
    // safe to continue from.
    vi.mocked(double.port.isAncestor).mockImplementation(async (ancestor, descendant) =>
      ancestor === sharedHead && descendant === childHead
    );
    const { request, wait } = harness({ double, run });

    const failure = await implementSpecChild(request).catch((error: unknown) => error);

    expect(isStopRetry(failure)).toBe(true);
    expect(run).toHaveBeenCalledOnce();
    expect(wait).toHaveBeenCalledOnce();
  });

  it("stops further Agent calls when an observed branch revision is malformed", async () => {
    const double = specChildDouble();
    const run = vi.fn().mockImplementation(async () => {
      double.state.local = "not-a-sha";
      throw new Error("provider stream ended");
    });
    const { request } = harness({ double, run });

    const failure = await implementSpecChild(request).catch((error: unknown) => error);

    expect(isStopRetry(failure)).toBe(true);
    expect(run).toHaveBeenCalledOnce();
  });

  it("gives a successful attempt that left the managed worktree dirty another bounded attempt", async () => {
    const worktreePath = `${checkoutPath}/.sandcastle/worktrees/sandcastle-spec-226`;
    const double = specChildDouble();
    const run = vi.fn()
      .mockImplementationOnce(async () => {
        double.state.local = childHead;
        double.state.worktree = { path: worktreePath, clean: false };
        return { branch, commits: [{ sha: childHead }] };
      })
      .mockImplementationOnce(async () => {
        double.state.worktree = undefined;
        return { branch, commits: [] };
      });
    const { request } = harness({ double, run });

    await expect(implementSpecChild(request)).resolves.toEqual({ branch, headSha: childHead });
    expect(run).toHaveBeenCalledTimes(2);
    expect(double.port.observeManagedWorktree).toHaveBeenCalledTimes(2);
  });

  it("gives a successful attempt that did not advance the frozen shared baseline another bounded attempt", async () => {
    const double = specChildDouble();
    const run = vi.fn()
      .mockResolvedValueOnce({ branch, commits: [] })
      .mockImplementationOnce(async () => {
        double.state.local = childHead;
        return { branch, commits: [{ sha: childHead }] };
      });
    const { request } = harness({ double, run });

    await expect(implementSpecChild(request)).resolves.toEqual({ branch, headSha: childHead });
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("never succeeds from durable work left by three throwing attempts", async () => {
    const double = specChildDouble();
    const interruption = new Error("Spec Implementer session interrupted");
    const run = vi.fn().mockImplementation(async () => {
      // Every attempt committed and pushed durably, then rejected.
      double.state.local = childHead;
      double.state.remote = childHead;
      throw interruption;
    });
    const { request } = harness({ double, run });

    await expect(implementSpecChild(request)).rejects.toBe(interruption);

    // At least one Agent invocation must return successfully: durable commits
    // or a remote shared branch without a successful return cannot produce a
    // recovered child.
    expect(run).toHaveBeenCalledTimes(3);
  });

  it("fails closed for a wrong result branch before trusting durable state", async () => {
    const double = specChildDouble();
    const run = vi.fn(async () => ({ branch: "sandcastle/spec-999", commits: [{ sha: childHead }] }));
    const { request } = harness({ double, run });

    await expect(implementSpecChild(request)).rejects.toBeInstanceOf(ImplementerResultError);
    expect(run).toHaveBeenCalledTimes(3);
  });

  it("refuses an invalid authorized base revision before touching branch state", async () => {
    const double = specChildDouble();
    const { request, run } = harness({ double });

    await expect(implementSpecChild({ ...request, baseRevision: "not-a-revision" }))
      .rejects.toBeInstanceOf(ImplementerResultError);

    expect(double.port.fetchRemote).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  it("logs branch-state coordination for a Spec child under the shared sanitized label", async () => {
    const double = specChildDouble({ remote: undefined });
    vi.mocked(double.port.observeRemoteBranch).mockRejectedValueOnce(new Error("network unreachable"));
    const { request, run } = harness({ double });
    const log = await createJobLog({
      root: mkdtempSync(join(tmpdir(), "spec-implementer-log-")),
      jobId: "spec-implementer-branch-state",
      operation: "implement-spec",
      number: specNumber,
      revision: baseRevision,
      now: 1_700_000_000_000,
    });

    await implementSpecChild({ ...request, log });

    const stderr = readFileSync(log.stderrPath, "utf8");
    expect(stderr).toContain("[implementer-branch-state]");
    expect(stderr).toContain("\"label\":\"prepare\"");
    expect(run).toHaveBeenCalledOnce();
  });

  it("retries a failed branch-state read without consuming an Agent invocation attempt", async () => {
    const double = specChildDouble();
    vi.mocked(double.port.observeLocalBranch)
      .mockRejectedValueOnce(new Error("index.lock held"))
      .mockRejectedValueOnce(new Error("index.lock held"))
      .mockImplementation(async () => double.state.local);
    const { request, run, wait } = harness({ double });

    await expect(implementSpecChild(request)).resolves.toEqual({ branch, headSha: childHead });

    // The two read retries consumed no Agent invocation attempt.
    expect(run).toHaveBeenCalledOnce();
    expect(wait).toHaveBeenCalledTimes(2);
  });

  it("stops further Agent calls when branch-state reads exhaust their bounded attempts", async () => {
    const double = specChildDouble();
    vi.mocked(double.port.observeRemoteBranch).mockRejectedValue(new Error("repository corrupted"));
    const { request, run, wait } = harness({ double });

    const failure = await implementSpecChild(request).catch((error: unknown) => error);

    expect(isStopRetry(failure)).toBe(true);
    expect(run).not.toHaveBeenCalled();
    expect(wait).toHaveBeenCalledTimes(2);
  });
});
