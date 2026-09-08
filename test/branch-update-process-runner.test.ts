import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { createBranchUpdateConflictResolverSession } from "../.sandcastle/branch-update-conflict-resolver.js";
import { createProcessBranchUpdater } from "../.sandcastle/branch-update-process-runner.js";

const revision = "0123456789abcdef0123456789abcdef01234567";
const baseRevision = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const mergeBaseRevision = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const updatedRevision = "fedcba9876543210fedcba9876543210fedcba98";

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

function gitMock(options: {
  readonly revisions: readonly string[];
  readonly mergeBase: string;
  readonly merge?: "clean" | "conflict";
  readonly diffs?: readonly string[];
  readonly parents?: string;
  readonly status?: string;
  readonly pushError?: Error;
}) {
  const revisions = [...options.revisions];
  const diffs = [...(options.diffs ?? [])];
  return vi.fn(async (arguments_: readonly string[]) => {
    const command = arguments_.at(2);
    if (command === "rev-parse") return { stdout: `${revisions.shift()!}\n`, stderr: "" };
    if (command === "merge-base") return { stdout: `${options.mergeBase}\n`, stderr: "" };
    if (command === "merge" && options.merge === "conflict") throw new Error("merge conflict");
    if (command === "diff") return { stdout: diffs.shift() ?? "", stderr: "" };
    if (command === "rev-list") return { stdout: `${options.parents ?? ""}\n`, stderr: "" };
    if (command === "status") return { stdout: options.status ?? "", stderr: "" };
    if (command === "push" && options.pushError !== undefined) throw options.pushError;
    return { stdout: "", stderr: "" };
  });
}

function conflictGitMock(options: {
  readonly parents?: string;
  readonly diffs?: readonly string[];
  readonly status?: string;
  readonly postRevision?: string;
}) {
  return gitMock({
    revisions: [revision, baseRevision, options.postRevision ?? updatedRevision],
    mergeBase: mergeBaseRevision,
    merge: "conflict",
    diffs: options.diffs ?? ["src/index.ts\n", ""],
    ...(options.parents === undefined ? {} : { parents: options.parents }),
    ...(options.status === undefined ? {} : { status: options.status }),
  });
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

  it.each([
    ["clean merge", "clean"],
    ["conflict resolution", "conflict"],
  ] as const)("rejects a malformed %s revision before pushing", async (_case, merge) => {
    const execute = gitMock({
      revisions: [revision, baseRevision, "truncated"],
      mergeBase: mergeBaseRevision,
      merge,
      ...(merge === "conflict" ? { diffs: ["src/index.ts\n", ""] } : {}),
    });
    const resolver = { resolve: vi.fn().mockResolvedValue({ comment: "Resolved src/index.ts." }) };
    const updater = createProcessBranchUpdater({ execute, resolver });

    await expect(updater.update(request)).rejects.toThrow("Branch update produced an invalid revision");
    expect(execute).not.toHaveBeenCalledWith(expect.arrayContaining(["push"]));
    if (merge === "conflict") expect(resolver.resolve).toHaveBeenCalledOnce();
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
    expect(execute).not.toHaveBeenCalledWith(expect.arrayContaining(["push"]));
  });

  it("runs the resolver after a conflict, verifies the exact merge commit, and pushes its result", async () => {
    const execute = conflictGitMock({ parents: validMergeParents });
    const resolver = { resolve: vi.fn().mockResolvedValue({ comment: "Resolved src/index.ts." }) };
    const updater = createProcessBranchUpdater({ execute, resolver });

    await expect(updater.update(request)).resolves.toEqual({
      status: "updated", revision: updatedRevision, comment: "Resolved src/index.ts.",
    });

    expect(resolver.resolve).toHaveBeenCalledWith(expect.objectContaining({
      pullRequestNumber: 225,
      checkoutPath: "/safe/disposable-checkout",
      conflicts: ["src/index.ts"],
    }));
    expect(execute).toHaveBeenCalledWith([
      "-C", "/safe/disposable-checkout",
      "rev-list", "--parents", "--max-count=1", "HEAD",
    ]);
    expect(execute).toHaveBeenLastCalledWith([
      "-C", "/safe/disposable-checkout",
      "push", "--force-with-lease=refs/heads/sandcastle/issue-221:0123456789abcdef0123456789abcdef01234567",
      "origin", "HEAD:refs/heads/sandcastle/issue-221",
    ]);
  });

  it("fails closed when the conflict-resolution agent produces no commit", async () => {
    const execute = conflictGitMock({ postRevision: revision, diffs: ["src/index.ts\n"] });
    const updater = createProcessBranchUpdater({
      execute,
      resolver: { resolve: vi.fn().mockResolvedValue({ comment: "No commit." }) },
    });

    await expect(updater.update(request)).rejects.toThrow("Conflict-resolution agent produced no commits");
    expect(execute).not.toHaveBeenCalledWith(expect.arrayContaining(["push"]));
  });

  it.each([
    ["an unrelated non-merge commit", `${updatedRevision} ${revision}`],
    ["an extra commit after the merge", `${updatedRevision} ${mergeBaseRevision}`],
    ["a merge commit with a third parent", `${validMergeParents} ${mergeBaseRevision}`],
  ] as const)("fails closed on %s instead of exactly one merge commit", async (_case, parents) => {
    const execute = conflictGitMock({ parents });
    const updater = createProcessBranchUpdater({
      execute,
      resolver: { resolve: vi.fn().mockResolvedValue({ comment: "Resolved src/index.ts." }) },
    });

    await expect(updater.update(request))
      .rejects.toThrow("Conflict-resolution agent did not finish with exactly one merge commit");
    expect(execute).not.toHaveBeenCalledWith(expect.arrayContaining(["push"]));
  });

  it.each([
    ["a wrong first parent", `${updatedRevision} ${mergeBaseRevision} ${baseRevision}`],
    ["reversed parents", `${updatedRevision} ${baseRevision} ${revision}`],
    ["a wrong second parent", `${updatedRevision} ${revision} ${mergeBaseRevision}`],
  ] as const)("fails closed on a merge commit with %s", async (_case, parents) => {
    const execute = conflictGitMock({ parents });
    const updater = createProcessBranchUpdater({
      execute,
      resolver: { resolve: vi.fn().mockResolvedValue({ comment: "Resolved src/index.ts." }) },
    });

    await expect(updater.update(request)).rejects.toThrow(
      `instead of ${revision} ${baseRevision}`,
    );
    expect(execute).not.toHaveBeenCalledWith(expect.arrayContaining(["push"]));
  });

  it("fails closed when the conflict-resolution agent leaves unresolved paths", async () => {
    const execute = conflictGitMock({
      parents: validMergeParents,
      diffs: ["src/index.ts\n", "src/other.ts\n"],
    });
    const updater = createProcessBranchUpdater({
      execute,
      resolver: { resolve: vi.fn().mockResolvedValue({ comment: "Still conflicted." }) },
    });

    await expect(updater.update(request)).rejects.toThrow("Conflict-resolution agent left unresolved conflicts in:\nsrc/other.ts");
    expect(execute).not.toHaveBeenCalledWith(expect.arrayContaining(["push"]));
  });

  it.each([
    ["staged changes", "A  staged.ts\n"],
    ["unstaged changes", " M tracked.ts\n"],
    ["non-ignored untracked residue", "?? stray.ts\n"],
  ] as const)("fails closed when the conflict-resolution agent leaves %s", async (_case, status) => {
    const execute = conflictGitMock({ parents: validMergeParents, status });
    const updater = createProcessBranchUpdater({
      execute,
      resolver: { resolve: vi.fn().mockResolvedValue({ comment: "Resolved src/index.ts." }) },
    });

    await expect(updater.update(request)).rejects.toThrow("Conflict-resolution agent left the checkout dirty:");
    expect(execute).not.toHaveBeenCalledWith(expect.arrayContaining(["push"]));
  });

  it("surfaces a rejected force-with-lease push", async () => {
    const execute = gitMock({
      revisions: [revision, baseRevision, updatedRevision],
      mergeBase: mergeBaseRevision,
      pushError: new Error("stale info: lease rejected"),
    });
    const updater = createProcessBranchUpdater({ execute });

    await expect(updater.update(request)).rejects.toThrow("stale info: lease rejected");
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
      const resolver = createBranchUpdateConflictResolverSession({
        sandbox: { kind: "fake-sandbox" } as never,
        hooks: { sandbox: { onSandboxReady: [] } },
        runAgent: vi.fn(async (options: { readonly cwd: string; readonly branchStrategy: unknown }) => {
          observedStrategies.push(options.branchStrategy);
          writeFileSync(join(options.cwd, "conflict.txt"), "resolved\n");
          realGit(options.cwd, ["add", "conflict.txt"]);
          realGit(options.cwd, ["commit", "--quiet", "--no-edit"]);
          return { output: { comment: "Resolved conflict.txt." } };
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
      const topology = realGit(checkout, ["rev-list", "--parents", "--max-count=1", "HEAD"]).trim().split(/\s+/u);
      expect(topology).toEqual([result.revision, branchSha, masterSha]);
      expect(realGit(remote, ["rev-parse", "refs/heads/sandcastle/issue-221"]).trim()).toBe(result.revision);
      expect(realGit(checkout, ["status", "--porcelain"]).trim()).toBe("");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
