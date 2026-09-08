import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { createBranchUpdateConflictResolverSession } from "../.sandcastle/branch-update-conflict-resolver.js";
import { createProcessBranchUpdater } from "../.sandcastle/branch-update-process-runner.js";
import { isStopRetry } from "../.sandcastle/invocation-recovery.js";

const revision = "0123456789abcdef0123456789abcdef01234567";
const baseRevision = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const mergeBaseRevision = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const updatedRevision = "fedcba9876543210fedcba9876543210fedcba98";
const extraRevision = "cccccccccccccccccccccccccccccccccccccccc";

const request = {
  pullRequestNumber: 225,
  branch: "sandcastle/issue-221",
  baseBranch: "master",
  revision,
  checkoutPath: "/safe/disposable-checkout",
};

const validMergeParents = `${updatedRevision} ${revision} ${baseRevision}`;

function fakeGit(script: string): { readonly directory: string; readonly environment: Readonly<Record<string, string>> } {
  const directory = mkdtempSync(join(tmpdir(), "branch-update-git-"));
  const git = join(directory, "git");
  writeFileSync(git, `#!/bin/bash\n${script}\n`);
  chmodSync(git, 0o700);
  return {
    directory,
    environment: { PATH: directory, HOME: directory },
  };
}

// A scripted value queue: each call shifts the next scripted value, and once
// the script is exhausted the last value repeats, so an unchanged checkout
// state needs only one entry.
function queue<T>(values: readonly T[], fallback: T): { next(): T } {
  const items = [...values];
  let last = fallback;
  return {
    next() {
      if (items.length > 0) last = items.shift()!;
      return last;
    },
  };
}

// A state-machine Git double. Each durable aspect of the checkout (HEAD via
// the revision queue, MERGE_HEAD, merge behavior, unmerged-path diffs,
// rev-list topology, porcelain status) is scripted independently so a test
// can move the checkout from an active conflict to a completed or aborted
// merge between recovery attempts.
function gitMock(options: {
  readonly revisions: readonly string[];
  readonly mergeBase: string;
  readonly merges?: readonly ("clean" | "conflict")[];
  readonly mergeHeads?: readonly (string | undefined)[];
  readonly diffs?: readonly string[];
  readonly parents?: readonly string[];
  readonly statuses?: readonly string[];
  readonly pushError?: Error;
}) {
  const revisions = queue(options.revisions, "");
  const merges = queue(options.merges ?? ["clean"], "clean");
  const mergeHeads = queue<string | undefined>(options.mergeHeads ?? [undefined], undefined);
  const diffs = queue(options.diffs ?? [""], "");
  const parents = queue(options.parents ?? [""], "");
  const statuses = queue(options.statuses ?? [""], "");
  return vi.fn(async (arguments_: readonly string[]) => {
    const command = arguments_.at(2);
    if (command === "rev-parse") {
      if (arguments_.at(3) === "-q") {
        const mergeHead = mergeHeads.next();
        if (mergeHead === undefined) throw new Error("git exited with 1: ");
        return { stdout: `${mergeHead}\n`, stderr: "" };
      }
      return { stdout: `${revisions.next()}\n`, stderr: "" };
    }
    if (command === "merge-base") return { stdout: `${options.mergeBase}\n`, stderr: "" };
    if (command === "merge" && merges.next() === "conflict") throw new Error("merge conflict");
    if (command === "diff") return { stdout: diffs.next(), stderr: "" };
    if (command === "rev-list") return { stdout: `${parents.next()}\n`, stderr: "" };
    if (command === "status") return { stdout: statuses.next(), stderr: "" };
    if (command === "push" && options.pushError !== undefined) throw options.pushError;
    return { stdout: "", stderr: "" };
  });
}

// The default conflicted-checkout script: the initial merge conflicts, the
// first classification sees MERGE_HEAD with unmerged paths, and a successful
// resolver attempt leaves the exact validated merge commit on a clean
// checkout.
function conflictGitMock(options: {
  readonly revisions?: readonly string[];
  readonly merges?: readonly ("clean" | "conflict")[];
  readonly mergeHeads?: readonly (string | undefined)[];
  readonly diffs?: readonly string[];
  readonly parents?: readonly string[];
  readonly statuses?: readonly string[];
  readonly postRevision?: string;
  readonly pushError?: Error;
}) {
  return gitMock({
    revisions: options.revisions ?? [
      revision, baseRevision, revision, options.postRevision ?? updatedRevision,
    ],
    mergeBase: mergeBaseRevision,
    merges: options.merges ?? ["conflict"],
    mergeHeads: options.mergeHeads ?? [baseRevision],
    diffs: options.diffs ?? ["src/index.ts\n", ""],
    parents: options.parents ?? [validMergeParents],
    statuses: options.statuses ?? ["UU src/index.ts\n", ""],
    ...(options.pushError === undefined ? {} : { pushError: options.pushError }),
  });
}

function mergeCallsOf(execute: ReturnType<typeof vi.fn>): readonly (readonly string[])[] {
  return execute.mock.calls.map((call) => call[0] as readonly string[])
    .filter((arguments_) => arguments_.at(2) === "merge");
}

function pushCallsOf(execute: ReturnType<typeof vi.fn>): readonly (readonly string[])[] {
  return execute.mock.calls.map((call) => call[0] as readonly string[])
    .filter((arguments_) => arguments_.at(2) === "push");
}

function realGit(repository: string, arguments_: readonly string[]): string {
  return execFileSync(
    "git",
    ["-c", "user.name=test", "-c", "user.email=test@example.test", ...arguments_],
    { cwd: repository, encoding: "utf8" },
  );
}

describe("process branch updater", () => {
  it("accepts only Git arguments through its fixed-executable adapter", async () => {
    const execute = gitMock({ revisions: [revision, baseRevision], mergeBase: baseRevision });
    const updater = createProcessBranchUpdater({ execute });

    await expect(updater.update(request)).resolves.toEqual({ status: "up-to-date" });

    expect(execute).toHaveBeenNthCalledWith(1, [
      "-C", "/safe/disposable-checkout", "fetch", "--no-tags", "origin", "master",
    ]);
  });

  it("merges the upstream base cleanly and pushes with an explicit revision lease", async () => {
    const execute = gitMock({ revisions: [revision, baseRevision, updatedRevision], mergeBase: mergeBaseRevision });
    const updater = createProcessBranchUpdater({ execute });

    await expect(updater.update(request)).resolves.toEqual({ status: "updated", revision: updatedRevision });

    expect(execute).toHaveBeenLastCalledWith([
      "-C", "/safe/disposable-checkout",
      "push", "--force-with-lease=refs/heads/sandcastle/issue-221:0123456789abcdef0123456789abcdef01234567",
      "origin", "HEAD:refs/heads/sandcastle/issue-221",
    ]);
  });

  it("rejects a malformed clean-merge revision before pushing", async () => {
    const execute = gitMock({
      revisions: [revision, baseRevision, "truncated"],
      mergeBase: mergeBaseRevision,
    });
    const updater = createProcessBranchUpdater({ execute });

    await expect(updater.update(request)).rejects.toThrow("Branch update produced an invalid revision");
    expect(pushCallsOf(execute)).toHaveLength(0);
  });

  it("spawns git through the purpose-specific environment instead of inheriting the parent", async () => {
    const updater = createProcessBranchUpdater({
      environment: { PATH: "/definitely-not-on-this-host", HOME: "/tmp" },
    });

    await expect(updater.update({
      pullRequestNumber: 225,
      branch: "sandcastle/issue-221",
      baseBranch: "master",
      revision,
      checkoutPath: "/safe/disposable-checkout",
    })).rejects.toThrow(/spawn git ENOENT/u);
  });

  it("captures complete stdout through the production fixed-Git launch path", async () => {
    const fixture = fakeGit(`
case "$3:$4" in
  rev-parse:HEAD) printf '0123456789abcdef'; printf '0123456789abcdef01234567\\n' ;;
  rev-parse:origin/master) printf 'aaaaaaaaaaaaaaaaaaaa'; printf 'aaaaaaaaaaaaaaaaaaaa\\n' ;;
  merge-base:HEAD) printf 'aaaaaaaaaaaaaaaa'; printf 'aaaaaaaaaaaaaaaaaaaaaaaa\\n' ;;
esac
printf 'diagnostic-part-one' >&2
printf '%s' '-part-two' >&2
`);
    try {
      const updater = createProcessBranchUpdater({ environment: fixture.environment });
      await expect(updater.update(request)).resolves.toEqual({ status: "up-to-date" });
    } finally {
      rmSync(fixture.directory, { recursive: true, force: true });
    }
  });

  it("captures complete stderr for a production Git nonzero exit", async () => {
    const fixture = fakeGit("printf 'first diagnostic ' >&2\nprintf 'second diagnostic' >&2\nexit 7");
    try {
      const updater = createProcessBranchUpdater({ environment: fixture.environment });
      await expect(updater.update(request)).rejects.toThrow(
        "git exited with 7: first diagnostic second diagnostic",
      );
    } finally {
      rmSync(fixture.directory, { recursive: true, force: true });
    }
  });

  it("maps a production Git signal exit", async () => {
    const fixture = fakeGit("printf 'terminated' >&2\nkill -TERM $$");
    try {
      const updater = createProcessBranchUpdater({ environment: fixture.environment });
      await expect(updater.update(request)).rejects.toThrow("git exited with signal: terminated");
    } finally {
      rmSync(fixture.directory, { recursive: true, force: true });
    }
  });

  it("short-circuits an already-up-to-date branch without merging or pushing", async () => {
    const execute = gitMock({ revisions: [revision, baseRevision], mergeBase: baseRevision });
    const updater = createProcessBranchUpdater({ execute });

    await expect(updater.update(request)).resolves.toEqual({ status: "up-to-date" });

    expect(execute).not.toHaveBeenCalledWith(expect.arrayContaining(["merge"]));
    expect(pushCallsOf(execute)).toHaveLength(0);
  });

  it("classifies the active conflict, runs the resolver, verifies the exact merge commit, and pushes once", async () => {
    const execute = conflictGitMock({});
    const resolver = {
      resolve: vi.fn().mockResolvedValue({ comment: "Resolved src/index.ts." }),
      format: vi.fn(),
    };
    const wait = vi.fn(async () => {});
    const updater = createProcessBranchUpdater({ execute, resolver, wait });

    await expect(updater.update(request)).resolves.toEqual({
      status: "updated", revision: updatedRevision, comment: "Resolved src/index.ts.",
    });

    expect(resolver.resolve).toHaveBeenCalledOnce();
    expect(resolver.resolve).toHaveBeenCalledWith(expect.objectContaining({
      pullRequestNumber: 225,
      checkoutPath: "/safe/disposable-checkout",
      conflicts: ["src/index.ts"],
      recovery: false,
    }));
    expect(resolver.format).not.toHaveBeenCalled();
    // The merge state was classified before the attempt through the
    // repository-owned probes.
    expect(execute).toHaveBeenCalledWith([
      "-C", "/safe/disposable-checkout", "rev-parse", "-q", "--verify", "MERGE_HEAD",
    ]);
    expect(execute).toHaveBeenCalledWith([
      "-C", "/safe/disposable-checkout",
      "rev-list", "--parents", "--max-count=1", "HEAD",
    ]);
    expect(wait).not.toHaveBeenCalled();
    expect(pushCallsOf(execute)).toHaveLength(1);
    expect(execute).toHaveBeenLastCalledWith([
      "-C", "/safe/disposable-checkout",
      "push", "--force-with-lease=refs/heads/sandcastle/issue-221:0123456789abcdef0123456789abcdef01234567",
      "origin", "HEAD:refs/heads/sandcastle/issue-221",
    ]);
  });

  it("completes the still-active conflict on the next attempt without resetting valid work", async () => {
    // Attempt one's invocation rejects while the merge stays in progress;
    // classification sees the same active conflict and attempt two completes
    // it in place. The revision script alternates per HEAD observation:
    // freeze, attempt-one classify, attempt-two classify, final validate.
    const execute = conflictGitMock({
      revisions: [revision, baseRevision, revision, revision, updatedRevision],
      statuses: ["UU src/index.ts\n", "UU src/index.ts\n", ""],
    });
    const resolver = {
      resolve: vi.fn()
        .mockRejectedValueOnce(new Error("provider stream ended"))
        .mockResolvedValue({ comment: "Resolved src/index.ts." }),
      format: vi.fn(),
    };
    const wait = vi.fn(async () => {});
    const updater = createProcessBranchUpdater({ execute, resolver, wait });

    await expect(updater.update(request)).resolves.toEqual({
      status: "updated", revision: updatedRevision, comment: "Resolved src/index.ts.",
    });

    expect(resolver.resolve).toHaveBeenCalledTimes(2);
    expect(resolver.resolve).toHaveBeenNthCalledWith(1, expect.objectContaining({ recovery: false }));
    expect(resolver.resolve).toHaveBeenNthCalledWith(2, expect.objectContaining({ recovery: true }));
    expect(resolver.format).not.toHaveBeenCalled();
    expect(wait).toHaveBeenCalledOnce();
    expect(wait).toHaveBeenCalledWith(2_000, undefined);
    // The original merge is never repeated for an active conflict.
    expect(mergeCallsOf(execute)).toHaveLength(1);
    expect(pushCallsOf(execute)).toHaveLength(1);
  });

  it("preserves an already completed exact merge and goes straight to formatting", async () => {
    // Attempt one's invocation rejects after its merge commit was already
    // created. Classification then sees HEAD as the exact merge commit with
    // no merge metadata: the merge is preserved and only formatting runs.
    const execute = conflictGitMock({
      revisions: [revision, baseRevision, revision, updatedRevision],
      mergeHeads: [baseRevision, undefined],
    });
    const resolver = {
      resolve: vi.fn().mockRejectedValue(new Error("worker exited before returning")),
      format: vi.fn().mockResolvedValue({ comment: "Formatted from the completed merge." }),
    };
    const wait = vi.fn(async () => {});
    const updater = createProcessBranchUpdater({ execute, resolver, wait });

    await expect(updater.update(request)).resolves.toEqual({
      status: "updated", revision: updatedRevision, comment: "Formatted from the completed merge.",
    });

    expect(resolver.resolve).toHaveBeenCalledOnce();
    expect(resolver.format).toHaveBeenCalledOnce();
    expect(resolver.format).toHaveBeenCalledWith({
      pullRequestNumber: 225,
      branch: "sandcastle/issue-221",
      baseBranch: "master",
      revision,
      checkoutPath: "/safe/disposable-checkout",
    });
    // The completed merge is never re-merged or re-committed.
    expect(mergeCallsOf(execute)).toHaveLength(1);
    expect(wait).toHaveBeenCalledOnce();
    expect(pushCallsOf(execute)).toHaveLength(1);
  });

  it("repeats the original merge against the frozen base revision after an aborted merge", async () => {
    // Attempt one's invocation rejects after the merge was aborted: the
    // checkout is clean at the original head with no merge metadata.
    // Attempt two re-runs the original merge against the frozen baseSha and
    // resolves the fresh conflict state.
    const execute = conflictGitMock({
      revisions: [revision, baseRevision, revision, revision, updatedRevision],
      merges: ["conflict", "conflict"],
      mergeHeads: [baseRevision, undefined],
      diffs: ["src/index.ts\n", "src/index.ts\n", ""],
    });
    const resolver = {
      resolve: vi.fn()
        .mockRejectedValueOnce(new Error("sandbox restarted"))
        .mockResolvedValue({ comment: "Resolved after re-merge." }),
      format: vi.fn(),
    };
    const wait = vi.fn(async () => {});
    const updater = createProcessBranchUpdater({ execute, resolver, wait });

    await expect(updater.update(request)).resolves.toEqual({
      status: "updated", revision: updatedRevision, comment: "Resolved after re-merge.",
    });

    const merges = mergeCallsOf(execute);
    expect(merges).toHaveLength(2);
    expect(merges[0]).toEqual([
      "-C", "/safe/disposable-checkout", "merge", "--no-edit", "origin/master",
    ]);
    // The repeated merge runs against the frozen base revision.
    expect(merges[1]).toEqual([
      "-C", "/safe/disposable-checkout", "merge", "--no-edit", baseRevision,
    ]);
    expect(resolver.resolve).toHaveBeenCalledTimes(2);
    // The repeated merge left a pristine conflict state, so the produce
    // prompt is the initial one rather than the recovery one.
    expect(resolver.resolve).toHaveBeenNthCalledWith(2, expect.objectContaining({ recovery: false }));
    expect(pushCallsOf(execute)).toHaveLength(1);
  });

  it("accepts a cleanly repeated merge after an abort without a resolution comment", async () => {
    const execute = conflictGitMock({
      revisions: [revision, baseRevision, revision, revision, updatedRevision],
      merges: ["conflict", "clean"],
      mergeHeads: [baseRevision, undefined],
    });
    const resolver = {
      resolve: vi.fn().mockRejectedValue(new Error("worker died after merge --abort")),
      format: vi.fn(),
    };
    const updater = createProcessBranchUpdater({ execute, resolver, wait: vi.fn(async () => {}) });

    await expect(updater.update(request)).resolves.toEqual({
      status: "updated", revision: updatedRevision,
    });

    expect(resolver.resolve).toHaveBeenCalledOnce();
    expect(resolver.format).not.toHaveBeenCalled();
    expect(pushCallsOf(execute)).toHaveLength(1);
  });

  it.each([
    ["an unrelated non-merge commit", `${updatedRevision} ${revision}`],
    ["an extra commit after the merge", `${updatedRevision} ${extraRevision}`],
    ["a merge commit with a third parent", `${validMergeParents} ${mergeBaseRevision}`],
    ["a wrong first parent", `${updatedRevision} ${mergeBaseRevision} ${baseRevision}`],
    ["reversed parents", `${updatedRevision} ${baseRevision} ${revision}`],
    ["a wrong second parent", `${updatedRevision} ${revision} ${mergeBaseRevision}`],
  ] as const)("stops recovery immediately on %s", async (_case, parents) => {
    const execute = conflictGitMock({
      revisions: [revision, baseRevision, updatedRevision],
      mergeHeads: [undefined],
      parents: [parents],
      statuses: [""],
    });
    const resolver = { resolve: vi.fn(), format: vi.fn() };
    const wait = vi.fn(async () => {});
    const updater = createProcessBranchUpdater({ execute, resolver, wait });

    const failure = await updater.update(request).catch((error: unknown) => error);

    expect(isStopRetry(failure)).toBe(true);
    expect((failure as Error).message).toContain(
      "Branch update HEAD changed without exactly one merge commit on the frozen revisions",
    );
    expect(resolver.resolve).not.toHaveBeenCalled();
    expect(resolver.format).not.toHaveBeenCalled();
    expect(wait).not.toHaveBeenCalled();
    expect(pushCallsOf(execute)).toHaveLength(0);
  });

  it("stops recovery immediately on a malformed HEAD revision", async () => {
    const execute = conflictGitMock({
      revisions: [revision, baseRevision, "truncated"],
    });
    const resolver = { resolve: vi.fn(), format: vi.fn() };
    const updater = createProcessBranchUpdater({ execute, resolver, wait: vi.fn(async () => {}) });

    const failure = await updater.update(request).catch((error: unknown) => error);

    expect(isStopRetry(failure)).toBe(true);
    expect((failure as Error).message).toContain("malformed HEAD revision");
    expect(resolver.resolve).not.toHaveBeenCalled();
    expect(pushCallsOf(execute)).toHaveLength(0);
  });

  it("stops recovery immediately on a malformed MERGE_HEAD revision", async () => {
    const execute = conflictGitMock({
      mergeHeads: ["not-a-revision"],
    });
    const resolver = { resolve: vi.fn(), format: vi.fn() };
    const updater = createProcessBranchUpdater({ execute, resolver, wait: vi.fn(async () => {}) });

    const failure = await updater.update(request).catch((error: unknown) => error);

    expect(isStopRetry(failure)).toBe(true);
    expect((failure as Error).message).toContain("malformed MERGE_HEAD revision");
    expect(resolver.resolve).not.toHaveBeenCalled();
    expect(pushCallsOf(execute)).toHaveLength(0);
  });

  it("stops recovery immediately on residue at the original head without merge metadata", async () => {
    const execute = conflictGitMock({
      revisions: [revision, baseRevision, revision],
      mergeHeads: [undefined],
      statuses: [" M tracked.ts\n"],
    });
    const resolver = { resolve: vi.fn(), format: vi.fn() };
    const updater = createProcessBranchUpdater({ execute, resolver, wait: vi.fn(async () => {}) });

    const failure = await updater.update(request).catch((error: unknown) => error);

    expect(isStopRetry(failure)).toBe(true);
    expect((failure as Error).message).toContain(
      "residue at the original head without merge metadata",
    );
    expect(resolver.resolve).not.toHaveBeenCalled();
    expect(pushCallsOf(execute)).toHaveLength(0);
  });

  it("stops recovery immediately when a completed merge carries dirty residue", async () => {
    const execute = conflictGitMock({
      revisions: [revision, baseRevision, updatedRevision],
      mergeHeads: [undefined],
      statuses: ["?? stray.ts\n"],
    });
    const resolver = { resolve: vi.fn(), format: vi.fn() };
    const updater = createProcessBranchUpdater({ execute, resolver, wait: vi.fn(async () => {}) });

    const failure = await updater.update(request).catch((error: unknown) => error);

    expect(isStopRetry(failure)).toBe(true);
    expect((failure as Error).message).toContain("unresolved or dirty residue");
    expect(resolver.format).not.toHaveBeenCalled();
    expect(pushCallsOf(execute)).toHaveLength(0);
  });

  it("stops recovery when an in-progress merge sits on a changed HEAD", async () => {
    const execute = conflictGitMock({
      revisions: [revision, baseRevision, updatedRevision],
      mergeHeads: [baseRevision],
    });
    const resolver = { resolve: vi.fn(), format: vi.fn() };
    const updater = createProcessBranchUpdater({ execute, resolver, wait: vi.fn(async () => {}) });

    const failure = await updater.update(request).catch((error: unknown) => error);

    expect(isStopRetry(failure)).toBe(true);
    expect((failure as Error).message).toContain("in progress on a changed HEAD");
    expect(pushCallsOf(execute)).toHaveLength(0);
  });

  it("stops recovery when an in-progress merge targets an unexpected revision", async () => {
    const execute = conflictGitMock({
      mergeHeads: [mergeBaseRevision],
    });
    const resolver = { resolve: vi.fn(), format: vi.fn() };
    const updater = createProcessBranchUpdater({ execute, resolver, wait: vi.fn(async () => {}) });

    const failure = await updater.update(request).catch((error: unknown) => error);

    expect(isStopRetry(failure)).toBe(true);
    expect((failure as Error).message).toContain("targets an unexpected revision");
    expect(pushCallsOf(execute)).toHaveLength(0);
  });

  it("fails closed when the conflict-resolution agent produces no commit", async () => {
    // The state stays an active conflict with HEAD at the pre-merge head, so
    // each attempt's validation rejects "no commits" until the bounded
    // window exhausts.
    const execute = conflictGitMock({
      revisions: [revision, baseRevision, revision],
      diffs: ["src/index.ts\n"],
      statuses: ["UU src/index.ts\n"],
    });
    const resolver = {
      resolve: vi.fn().mockResolvedValue({ comment: "No commit." }),
      format: vi.fn(),
    };
    const updater = createProcessBranchUpdater({ execute, resolver, wait: vi.fn(async () => {}) });

    await expect(updater.update(request)).rejects.toThrow("Conflict-resolution agent produced no commits");
    expect(resolver.resolve).toHaveBeenCalledTimes(3);
    expect(pushCallsOf(execute)).toHaveLength(0);
  });

  it("surfaces the last failure unchanged after three exhausted produce attempts", async () => {
    const failures = [1, 2, 3].map((n) => new Error(`invocation failure ${n}`));
    const execute = conflictGitMock({
      // The checkout stays an active conflict at the pre-merge head for the
      // whole window.
      revisions: [revision, baseRevision, revision],
      statuses: ["UU src/index.ts\n"],
    });
    const resolver = {
      resolve: vi.fn().mockImplementation(() =>
        Promise.reject(failures[resolver.resolve.mock.calls.length - 1])),
      format: vi.fn(),
    };
    const wait = vi.fn(async () => {});
    const updater = createProcessBranchUpdater({ execute, resolver, wait });

    await expect(updater.update(request)).rejects.toBe(failures[2]);
    expect(resolver.resolve).toHaveBeenCalledTimes(3);
    expect(wait).toHaveBeenCalledTimes(2);
    expect(pushCallsOf(execute)).toHaveLength(0);
  });

  it("retries a successful attempt that left unresolved paths until the window exhausts", async () => {
    // Each attempt: classify sees the active conflict at the pre-merge head,
    // the resolver returns successfully, and validation reaches the
    // unresolved-paths check (HEAD observed as the new commit).
    const execute = conflictGitMock({
      revisions: [
        revision, baseRevision,
        revision, updatedRevision,
        revision, updatedRevision,
        revision, updatedRevision,
      ],
      diffs: ["src/index.ts\n", "src/other.ts\n"],
      statuses: ["UU src/index.ts\n"],
    });
    const resolver = {
      resolve: vi.fn().mockResolvedValue({ comment: "Still conflicted." }),
      format: vi.fn(),
    };
    const updater = createProcessBranchUpdater({ execute, resolver, wait: vi.fn(async () => {}) });

    await expect(updater.update(request))
      .rejects.toThrow("Conflict-resolution agent left unresolved conflicts in:\nsrc/other.ts");
    expect(resolver.resolve).toHaveBeenCalledTimes(3);
    expect(pushCallsOf(execute)).toHaveLength(0);
  });

  it("stops recovery on the next classification after an attempt left dirty residue", async () => {
    // Attempt one's successful return fails the clean-checkout validation;
    // the next classification proves the completed merge carries residue and
    // stops the window without another Agent call.
    const execute = conflictGitMock({
      mergeHeads: [baseRevision, undefined],
      statuses: ["UU src/index.ts\n", "?? stray.ts\n"],
    });
    const resolver = {
      resolve: vi.fn().mockResolvedValue({ comment: "Resolved src/index.ts." }),
      format: vi.fn(),
    };
    const updater = createProcessBranchUpdater({ execute, resolver, wait: vi.fn(async () => {}) });

    const failure = await updater.update(request).catch((error: unknown) => error);

    expect(isStopRetry(failure)).toBe(true);
    expect((failure as Error).message).toContain("unresolved or dirty residue");
    expect(resolver.resolve).toHaveBeenCalledOnce();
    expect(pushCallsOf(execute)).toHaveLength(0);
  });

  it("stops recovery on the next classification after an attempt produced the wrong parents", async () => {
    const wrongParents = `${updatedRevision} ${baseRevision} ${revision}`;
    const execute = conflictGitMock({
      mergeHeads: [baseRevision, undefined],
      parents: [wrongParents],
    });
    const resolver = {
      resolve: vi.fn().mockResolvedValue({ comment: "Resolved src/index.ts." }),
      format: vi.fn(),
    };
    const updater = createProcessBranchUpdater({ execute, resolver, wait: vi.fn(async () => {}) });

    const failure = await updater.update(request).catch((error: unknown) => error);

    expect(isStopRetry(failure)).toBe(true);
    expect((failure as Error).message).toContain(
      "changed without exactly one merge commit on the frozen revisions",
    );
    expect(resolver.resolve).toHaveBeenCalledOnce();
    expect(pushCallsOf(execute)).toHaveLength(0);
  });

  it("surfaces a rejected force-with-lease push after a clean merge", async () => {
    const execute = gitMock({
      revisions: [revision, baseRevision, updatedRevision],
      mergeBase: mergeBaseRevision,
      pushError: new Error("stale info: lease rejected"),
    });
    const updater = createProcessBranchUpdater({ execute });

    await expect(updater.update(request)).rejects.toThrow("stale info: lease rejected");
  });

  it("surfaces a rejected push after conflict resolution without re-entering the window", async () => {
    const execute = conflictGitMock({ pushError: new Error("stale info: lease rejected") });
    const resolver = {
      resolve: vi.fn().mockResolvedValue({ comment: "Resolved src/index.ts." }),
      format: vi.fn(),
    };
    const updater = createProcessBranchUpdater({ execute, resolver, wait: vi.fn(async () => {}) });

    // The push sits outside the recovery window: its rejection is not
    // retried and the produce stage does not run again.
    await expect(updater.update(request)).rejects.toThrow("stale info: lease rejected");
    expect(resolver.resolve).toHaveBeenCalledOnce();
    expect(pushCallsOf(execute)).toHaveLength(1);
  });
});

describe("process branch updater against a real temporary Git remote", () => {
  it("resolves a real conflict in the conflicted checkout and pushes exactly the validated merge commit", async () => {
    const root = mkdtempSync(join(tmpdir(), "branch-update-real-"));
    try {
      const remote = join(root, "remote.git");
      const contributor = join(root, "contributor");
      const checkout = join(root, "checkout");
      realGit(root, ["init", "--quiet", "--bare", "--initial-branch=master", remote]);
      realGit(root, ["init", "--quiet", "--initial-branch=master", contributor]);
      writeFileSync(join(contributor, "conflict.txt"), "base\n");
      realGit(contributor, ["add", "conflict.txt"]);
      realGit(contributor, ["commit", "--quiet", "-m", "base"]);
      realGit(contributor, ["remote", "add", "origin", remote]);
      realGit(contributor, ["push", "--quiet", "origin", "master"]);
      realGit(contributor, ["switch", "--quiet", "--create", "sandcastle/issue-221"]);
      writeFileSync(join(contributor, "conflict.txt"), "branch\n");
      realGit(contributor, ["commit", "--quiet", "-am", "branch change"]);
      const branchSha = realGit(contributor, ["rev-parse", "HEAD"]).trim();
      realGit(contributor, ["push", "--quiet", "origin", "sandcastle/issue-221"]);
      realGit(contributor, ["switch", "--quiet", "master"]);
      writeFileSync(join(contributor, "conflict.txt"), "master\n");
      realGit(contributor, ["commit", "--quiet", "-am", "master change"]);
      const masterSha = realGit(contributor, ["rev-parse", "HEAD"]).trim();
      realGit(contributor, ["push", "--quiet", "origin", "master"]);
      realGit(root, ["clone", "--quiet", remote, checkout]);

      const observedStrategies: unknown[] = [];
      const resume = vi.fn(async () => ({
        stdout: '<resolution>{"comment":"Resolved conflict.txt."}</resolution>',
        commits: [],
        branch: "sandcastle/issue-221",
        iterations: [{ sessionId: "session-1" }],
      }));
      const resolver = createBranchUpdateConflictResolverSession({
        sandbox: { kind: "fake-sandbox" } as never,
        hooks: { sandbox: { onSandboxReady: [] } },
        runAgent: vi.fn(async (options: { readonly cwd: string; readonly branchStrategy: unknown }) => {
          observedStrategies.push(options.branchStrategy);
          writeFileSync(join(options.cwd, "conflict.txt"), "resolved\n");
          realGit(options.cwd, ["add", "conflict.txt"]);
          realGit(options.cwd, ["commit", "--quiet", "--no-edit"]);
          return {
            stdout: "",
            commits: [],
            branch: "sandcastle/issue-221",
            iterations: [{ sessionId: "session-0" }],
            resume,
          };
        }) as never,
        createAgent: vi.fn().mockReturnValue({ name: "fake-resolver" }) as never,
      });
      const updater = createProcessBranchUpdater({ resolver });

      const result = await updater.update({
        pullRequestNumber: 225,
        branch: "sandcastle/issue-221",
        baseBranch: "master",
        revision: branchSha,
        checkoutPath: checkout,
      });

      expect(observedStrategies).toEqual([{ type: "head" }]);
      expect(result.status).toBe("updated");
      if (result.status !== "updated") throw new Error("unreachable");
      expect(result.comment).toBe("Resolved conflict.txt.");
      const topology = realGit(checkout, ["rev-list", "--parents", "--max-count=1", "HEAD"]).trim().split(/\s+/u);
      expect(topology).toEqual([result.revision, branchSha, masterSha]);
      expect(realGit(remote, ["rev-parse", "refs/heads/sandcastle/issue-221"]).trim()).toBe(result.revision);
      expect(realGit(checkout, ["status", "--porcelain"]).trim()).toBe("");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("recovers a real completed merge awaiting formatting without re-merging", async () => {
    const root = mkdtempSync(join(tmpdir(), "branch-update-real-format-"));
    try {
      const remote = join(root, "remote.git");
      const contributor = join(root, "contributor");
      const checkout = join(root, "checkout");
      realGit(root, ["init", "--quiet", "--bare", "--initial-branch=master", remote]);
      realGit(root, ["init", "--quiet", "--initial-branch=master", contributor]);
      writeFileSync(join(contributor, "conflict.txt"), "base\n");
      realGit(contributor, ["add", "conflict.txt"]);
      realGit(contributor, ["commit", "--quiet", "-m", "base"]);
      realGit(contributor, ["remote", "add", "origin", remote]);
      realGit(contributor, ["push", "--quiet", "origin", "master"]);
      realGit(contributor, ["switch", "--quiet", "--create", "sandcastle/issue-221"]);
      writeFileSync(join(contributor, "conflict.txt"), "branch\n");
      realGit(contributor, ["commit", "--quiet", "-am", "branch change"]);
      const branchSha = realGit(contributor, ["rev-parse", "HEAD"]).trim();
      realGit(contributor, ["push", "--quiet", "origin", "sandcastle/issue-221"]);
      realGit(contributor, ["switch", "--quiet", "master"]);
      writeFileSync(join(contributor, "conflict.txt"), "master\n");
      realGit(contributor, ["commit", "--quiet", "-am", "master change"]);
      const masterSha = realGit(contributor, ["rev-parse", "HEAD"]).trim();
      realGit(contributor, ["push", "--quiet", "origin", "master"]);
      realGit(root, ["clone", "--quiet", remote, checkout]);

      // Attempt one completes the real merge commit, then its invocation
      // rejects before a comment exists. Attempt two must classify the
      // durable state as a completed exact merge and only format it.
      const produce = vi.fn(async (options: { readonly cwd: string }) => {
        writeFileSync(join(options.cwd, "conflict.txt"), "resolved\n");
        realGit(options.cwd, ["add", "conflict.txt"]);
        realGit(options.cwd, ["commit", "--quiet", "--no-edit"]);
        throw new Error("worker exited before returning a result");
      });
      const formatRun = vi.fn(async () => ({
        stdout: '<resolution>{"comment":"Formatted the completed merge."}</resolution>',
        commits: [],
        branch: "sandcastle/issue-221",
        iterations: [{ sessionId: "session-format" }],
      }));
      const resolver = {
        resolve: vi.fn().mockRejectedValue(new Error("unreachable: resolve must not run again")),
        format: vi.fn(async (request_: { readonly checkoutPath: string }) => {
          const session = createBranchUpdateConflictResolverSession({
            sandbox: { kind: "fake-sandbox" } as never,
            hooks: { sandbox: { onSandboxReady: [] } },
            runAgent: formatRun as never,
            createAgent: vi.fn().mockReturnValue({ name: "fake-formatter" }) as never,
          });
          return session.format({
            model: "merger-model",
            pullRequestNumber: 225,
            branch: "sandcastle/issue-221",
            baseBranch: "master",
            checkoutPath: request_.checkoutPath,
          });
        }),
      };
      // The first attempt's produce runs through a real session against the
      // conflicted checkout, rejecting after the merge commit exists.
      const firstSession = createBranchUpdateConflictResolverSession({
        sandbox: { kind: "fake-sandbox" } as never,
        hooks: { sandbox: { onSandboxReady: [] } },
        runAgent: produce as never,
        createAgent: vi.fn().mockReturnValue({ name: "fake-resolver" }) as never,
      });
      resolver.resolve.mockImplementation((request_: {
        readonly checkoutPath: string;
        readonly conflicts: readonly string[];
      }) => firstSession.resolve({
        model: "merger-model",
        pullRequestNumber: 225,
        branch: "sandcastle/issue-221",
        baseBranch: "master",
        checkoutPath: request_.checkoutPath,
        conflicts: request_.conflicts,
      }));
      const updater = createProcessBranchUpdater({
        resolver,
        wait: vi.fn(async () => {}),
      });

      const result = await updater.update({
        pullRequestNumber: 225,
        branch: "sandcastle/issue-221",
        baseBranch: "master",
        revision: branchSha,
        checkoutPath: checkout,
      });

      expect(result.status).toBe("updated");
      if (result.status !== "updated") throw new Error("unreachable");
      expect(result.comment).toBe("Formatted the completed merge.");
      expect(resolver.resolve).toHaveBeenCalledOnce();
      expect(resolver.format).toHaveBeenCalledOnce();
      const topology = realGit(checkout, ["rev-list", "--parents", "--max-count=1", "HEAD"]).trim().split(/\s+/u);
      expect(topology).toEqual([result.revision, branchSha, masterSha]);
      expect(realGit(remote, ["rev-parse", "refs/heads/sandcastle/issue-221"]).trim()).toBe(result.revision);
      expect(realGit(checkout, ["status", "--porcelain"]).trim()).toBe("");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
