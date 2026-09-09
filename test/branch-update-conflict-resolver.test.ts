import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { createBranchUpdateConflictResolverSession } from "../.sandcastle/branch-update-conflict-resolver.js";
import type { CheckoutObserver } from "../.sandcastle/checkout-safety.js";
import { StopRetryError, isStopRetry } from "../.sandcastle/invocation-recovery.js";

const mergeRevision = "fedcba9876543210fedcba9876543210fedcba98";
const checkoutPath = "/safe/disposable-checkout";

const request = {
  model: "implementer-model",
  pullRequestNumber: 225,
  branch: "sandcastle/issue-221",
  baseBranch: "master",
  checkoutPath,
  conflicts: ["src/index.ts"],
};

const tagged = (value: unknown) => `<resolution>${JSON.stringify(value)}</resolution>`;

function completedResult(stdout: string, extras: { readonly resume?: unknown } = {}) {
  return {
    stdout,
    commits: [],
    branch: "sandcastle/issue-221",
    iterations: [{ sessionId: "session-1" }],
    ...(extras.resume === undefined ? {} : { resume: extras.resume }),
  };
}

function fakeObserver() {
  const snapshot = { head: mergeRevision, entries: [] };
  const requireClean = vi.fn().mockResolvedValue(snapshot);
  const requireUnchanged = vi.fn().mockResolvedValue(snapshot);
  const observer = {
    observe: vi.fn().mockResolvedValue(snapshot),
    requireClean,
    requireUnchanged,
  } as unknown as CheckoutObserver;
  return { observer, requireClean, requireUnchanged, snapshot };
}

function harness(runAgent: ReturnType<typeof vi.fn>) {
  const { observer, requireClean, requireUnchanged, snapshot } = fakeObserver();
  const wait = vi.fn(async () => {});
  const createAgent = vi.fn().mockReturnValue({ name: "fake-resolver" });
  const session = createBranchUpdateConflictResolverSession({
    sandbox: { kind: "fake-sandbox" } as never,
    hooks: { sandbox: { onSandboxReady: [] } },
    observer,
    wait,
    runAgent: runAgent as never,
    createAgent: createAgent as never,
  });
  return { session, observer, requireClean, requireUnchanged, snapshot, wait, createAgent };
}

function git(repository: string, arguments_: readonly string[]): string {
  return execFileSync(
    "git",
    ["-c", "user.name=test", "-c", "user.email=test@example.test", ...arguments_],
    { cwd: repository, encoding: "utf8" },
  );
}

describe("branch update conflict resolver session produce stage", () => {
  it("runs one produce invocation on the head strategy, then formats through the resumed checkpoint", async () => {
    const resume = vi.fn().mockResolvedValue(completedResult(tagged({ comment: "Resolved src/index.ts." })));
    const runAgent = vi.fn().mockResolvedValue(completedResult("", { resume }));
    const { session, requireClean, requireUnchanged, wait, createAgent } = harness(runAgent);

    await expect(session.resolve(request)).resolves.toEqual({ comment: "Resolved src/index.ts." });

    expect(createAgent).toHaveBeenCalledWith("implementer-model");
    expect(runAgent).toHaveBeenCalledOnce();
    const produceRequest = runAgent.mock.calls[0]![0];
    expect(produceRequest).toEqual(expect.objectContaining({
      cwd: checkoutPath,
      branchStrategy: { type: "head" },
      maxIterations: 1,
      name: "branch-update-pr-225",
    }));
    // Drift guard: neither the produce call nor any formatting run call arms
    // the library's recursive output retry.
    expect(produceRequest).not.toHaveProperty("output");
    expect(produceRequest.prompt).toContain("src/index.ts");
    expect(produceRequest.prompt).toContain("Do not abort the merge");
    expect(produceRequest.prompt).not.toContain("interrupted");
    // The immutable formatting stage proved a clean checkout at the frozen
    // merge commit, resumed the produce checkpoint once, and proved the
    // invocation left the checkout unchanged.
    expect(requireClean).toHaveBeenCalledOnce();
    expect(requireClean).toHaveBeenCalledWith(checkoutPath);
    expect(resume).toHaveBeenCalledOnce();
    const formattingPrompt = resume.mock.calls[0]![0] as string;
    expect(formattingPrompt).toContain("<resolution>");
    expect(formattingPrompt).toContain("No-mutation formatting contract");
    expect(requireUnchanged).toHaveBeenCalledOnce();
    expect(wait).not.toHaveBeenCalled();
  });

  it("uses the recovery produce prompt for a continued attempt against the same checkout", async () => {
    const resume = vi.fn().mockResolvedValue(completedResult(tagged({ comment: "Continued." })));
    const runAgent = vi.fn().mockResolvedValue(completedResult("", { resume }));
    const { session } = harness(runAgent);

    await expect(session.resolve({ ...request, recovery: true })).resolves.toEqual({ comment: "Continued." });

    const produceRequest = runAgent.mock.calls[0]![0];
    expect(produceRequest).not.toHaveProperty("output");
    expect(produceRequest.prompt).toContain("interrupted");
    expect(produceRequest.prompt).toContain("complete current state");
    expect(produceRequest.prompt).toContain("git status");
    expect(produceRequest.prompt).toContain("finish it, never restart it");
    expect(produceRequest.prompt).toContain("do not abort the merge, reset the checkout");
    expect(produceRequest.prompt).toContain("src/index.ts");
  });

  it("fails the produce stage when the completed run carries no resumable checkpoint", async () => {
    const runAgent = vi.fn().mockResolvedValue(completedResult(""));
    const { session, requireClean } = harness(runAgent);

    await expect(session.resolve(request))
      .rejects.toThrow("Branch update conflict resolution session identity is unavailable");
    // Formatting never starts without a usable checkpoint.
    expect(requireClean).not.toHaveBeenCalled();
  });

  it("propagates a produce invocation rejection without running the formatting stage", async () => {
    const rejection = new Error("provider stream ended");
    const runAgent = vi.fn().mockRejectedValue(rejection);
    const { session, requireClean, wait } = harness(runAgent);

    await expect(session.resolve(request)).rejects.toBe(rejection);
    expect(requireClean).not.toHaveBeenCalled();
    expect(wait).not.toHaveBeenCalled();
  });

  it("treats a successful produce that left the merge unfinished as a recoverable failure, not a stop", async () => {
    // The produce invocation returned with a resumable checkpoint but the
    // agent never ran the final commit: staged resolutions and MERGE_HEAD are
    // still present, so the checkout carries ordinary residue. This is a
    // produce-contract failure that must spend a bounded produce attempt, not
    // the formatting stage's fail-closed stop-retry sentinel (which would
    // terminate the whole window with zero further Agent calls).
    const resume = vi.fn();
    const runAgent = vi.fn().mockResolvedValue(completedResult("", { resume }));
    const { session, observer, requireClean } = harness(runAgent);
    observer.observe.mockResolvedValue({
      head: mergeRevision,
      entries: [{ index: "M", worktree: " ", path: "src/index.ts", kind: "tracked" }],
    });

    const failure = await session.resolve(request).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain("unclean checkout");
    // Formatting never started: no clean-checkout proof, no resumed session.
    expect(requireClean).not.toHaveBeenCalled();
    expect(resume).not.toHaveBeenCalled();
  });
});

describe("branch update conflict resolver session formatting stage", () => {
  it("formats an already completed merge from a fresh session without touching the merge", async () => {
    const runAgent = vi.fn().mockResolvedValue(
      completedResult(tagged({ comment: "Formatted from the completed merge." })),
    );
    const { session, requireClean, requireUnchanged } = harness(runAgent);

    await expect(session.format({
      model: "implementer-model",
      pullRequestNumber: 225,
      branch: "sandcastle/issue-221",
      baseBranch: "master",
      checkoutPath,
    })).resolves.toEqual({ comment: "Formatted from the completed merge." });

    // The checkout is proven clean before the formatting invocation runs.
    expect(requireClean).toHaveBeenCalledOnce();
    expect(requireClean.mock.invocationCallOrder[0]!).toBeLessThan(runAgent.mock.invocationCallOrder[0]!);
    expect(runAgent).toHaveBeenCalledOnce();
    const formatRequest = runAgent.mock.calls[0]![0];
    expect(formatRequest).toEqual(expect.objectContaining({
      cwd: checkoutPath,
      branchStrategy: { type: "head" },
      maxIterations: 1,
      name: "branch-update-pr-225-formatting",
    }));
    expect(formatRequest).not.toHaveProperty("output");
    expect(formatRequest.prompt).toContain("already exists at HEAD");
    expect(formatRequest.prompt).toContain("Do not merge, commit, or change anything");
    expect(formatRequest.prompt).toContain("No-mutation formatting contract");
    expect(requireUnchanged).toHaveBeenCalledOnce();
  });

  it("stops immediately when a rejected formatting invocation mutated the checkout", async () => {
    const resume = vi.fn().mockRejectedValue(new Error("provider stream ended"));
    const runAgent = vi.fn().mockResolvedValue(completedResult("", { resume }));
    const { session, requireUnchanged, wait } = harness(runAgent);
    const mutation = new StopRetryError("Target Checkout changed during a read-only stage");
    requireUnchanged.mockRejectedValue(mutation);

    const failure = await session.resolve(request).catch((error: unknown) => error);

    expect(failure).toBe(mutation);
    expect(isStopRetry(failure)).toBe(true);
    expect(resume).toHaveBeenCalledOnce();
    expect(wait).not.toHaveBeenCalled();
  });

  it("stops immediately when the checkout observer fails before any formatting invocation", async () => {
    const runAgent = vi.fn();
    const { session, requireClean } = harness(runAgent);
    const unobservable = new StopRetryError("Target Checkout path is missing");
    requireClean.mockRejectedValue(unobservable);

    const failure = await session.format({
      model: "implementer-model",
      pullRequestNumber: 225,
      branch: "sandcastle/issue-221",
      baseBranch: "master",
      checkoutPath,
    }).catch((error: unknown) => error);

    expect(failure).toBe(unobservable);
    expect(isStopRetry(failure)).toBe(true);
    expect(runAgent).not.toHaveBeenCalled();
  });

  it("exhausts the bounded structured budget on unusable completed responses", async () => {
    const resumeThree = vi.fn().mockResolvedValue(completedResult("no structured block"));
    const resumeTwo = vi.fn().mockResolvedValue(completedResult("no structured block", { resume: resumeThree }));
    const resumeOne = vi.fn().mockResolvedValue(completedResult("no structured block", { resume: resumeTwo }));
    const runAgent = vi.fn().mockResolvedValue(completedResult("", { resume: resumeOne }));
    const { session, wait } = harness(runAgent);

    await expect(session.resolve(request)).rejects.toThrow(
      "Structured output tag <resolution> could not be parsed after 3 attempts",
    );
    // Three structured attempts, each consuming the advanced checkpoint.
    expect(resumeOne).toHaveBeenCalledOnce();
    expect(resumeTwo).toHaveBeenCalledOnce();
    expect(resumeThree).toHaveBeenCalledOnce();
    // Parse handoffs never spend invocation backoff.
    expect(wait).not.toHaveBeenCalled();
  });

  it("exhausts the bounded invocation window inside one structured attempt", async () => {
    const failures = [1, 2, 3].map((n) => new Error(`invocation failure ${n}`));
    const resume = vi.fn().mockImplementation(() =>
      Promise.reject(failures[resume.mock.calls.length - 1]));
    const runAgent = vi.fn().mockResolvedValue(completedResult("", { resume }));
    const { session, requireUnchanged, wait } = harness(runAgent);

    await expect(session.resolve(request)).rejects.toBe(failures[2]);
    expect(resume).toHaveBeenCalledTimes(3);
    // Every rejected invocation still proved the read-only contract held.
    expect(requireUnchanged).toHaveBeenCalledTimes(3);
    expect(wait).toHaveBeenCalledTimes(2);
    expect(wait).toHaveBeenNthCalledWith(1, 2_000, undefined);
    expect(wait).toHaveBeenNthCalledWith(2, 8_000, undefined);
  });
});

describe("branch update conflict resolver session against a real conflicted checkout", () => {
  it("resolves a real conflict in the already-conflicted checkout where a second worktree would collide", async () => {
    const repository = mkdtempSync(join(tmpdir(), "branch-update-conflict-"));
    try {
      git(repository, ["init", "--quiet", "--initial-branch=master"]);
      writeFileSync(join(repository, "conflict.txt"), "base\n");
      git(repository, ["add", "conflict.txt"]);
      git(repository, ["commit", "--quiet", "-m", "base"]);
      git(repository, ["switch", "--quiet", "--create", "sandcastle/issue-221"]);
      writeFileSync(join(repository, "conflict.txt"), "branch\n");
      git(repository, ["commit", "--quiet", "-am", "branch change"]);
      const branchSha = git(repository, ["rev-parse", "HEAD"]).trim();
      git(repository, ["switch", "--quiet", "master"]);
      writeFileSync(join(repository, "conflict.txt"), "master\n");
      git(repository, ["commit", "--quiet", "-am", "master change"]);
      const masterSha = git(repository, ["rev-parse", "HEAD"]).trim();
      git(repository, ["switch", "--quiet", "sandcastle/issue-221"]);

      // A real failed merge leaves real unmerged entries in the root index of
      // this checkout — the state the resolver must repair in place.
      expect(() => git(repository, ["merge", "--no-edit", "master"])).toThrow();
      const unmerged = git(repository, ["diff", "--name-only", "--diff-filter=U"]).trim().split("\n");
      expect(unmerged).toEqual(["conflict.txt"]);

      // The former named-branch topology asked Sandcastle for a second managed
      // worktree of the same branch; real Git rejects that before any Agent
      // execution because the branch is already checked out here.
      const colliding = join(repository, "..", `${repository.split("/").pop()!}-worktree`);
      let collision: unknown;
      try {
        git(repository, ["worktree", "add", colliding, "sandcastle/issue-221"]);
      } catch (error) {
        collision = error;
      }
      expect(String((collision as { stderr?: unknown })?.stderr ?? collision)).toContain("already checked out");

      const resume = vi.fn(async () => completedResult(tagged({ comment: "Resolved conflict.txt." })));
      const runAgent = vi.fn(async (options: { readonly cwd: string }) => {
        writeFileSync(join(options.cwd, "conflict.txt"), "resolved\n");
        git(options.cwd, ["add", "conflict.txt"]);
        git(options.cwd, ["commit", "--quiet", "--no-edit"]);
        return completedResult("", { resume });
      });
      const resolver = createBranchUpdateConflictResolverSession({
        sandbox: { kind: "fake-sandbox" } as never,
        hooks: { sandbox: { onSandboxReady: [] } },
        runAgent: runAgent as never,
        createAgent: vi.fn().mockReturnValue({ name: "fake-resolver" }) as never,
      });

      await expect(resolver.resolve({
        ...request,
        checkoutPath: repository,
        conflicts: unmerged,
      })).resolves.toEqual({ comment: "Resolved conflict.txt." });

      expect(runAgent).toHaveBeenCalledWith(expect.objectContaining({
        cwd: repository,
        branchStrategy: { type: "head" },
      }));
      // The formatting stage observed the real checkout through the default
      // repository-owned observer: clean at the merge commit, unchanged by
      // the formatting invocation.
      expect(resume).toHaveBeenCalledOnce();
      const topology = git(repository, ["rev-list", "--parents", "--max-count=1", "HEAD"]).trim().split(/\s+/u);
      expect(topology.slice(1)).toEqual([branchSha, masterSha]);
      expect(git(repository, ["status", "--porcelain"]).trim()).toBe("");
    } finally {
      rmSync(repository, { recursive: true, force: true });
    }
  });
});
