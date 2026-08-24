import { describe, expect, it, vi } from "vitest";

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

function gitMock(options: {
  readonly revisions: readonly string[];
  readonly mergeBase: string;
  readonly merge?: "clean" | "conflict";
  readonly diffs?: readonly string[];
  readonly pushError?: Error;
}) {
  const revisions = [...options.revisions];
  const diffs = [...(options.diffs ?? [])];
  return vi.fn(async (_file: string, arguments_: readonly string[]) => {
    const command = arguments_.at(2);
    if (command === "rev-parse") return { stdout: `${revisions.shift()!}\n`, stderr: "" };
    if (command === "merge-base") return { stdout: `${options.mergeBase}\n`, stderr: "" };
    if (command === "merge" && options.merge === "conflict") throw new Error("merge conflict");
    if (command === "diff") return { stdout: diffs.shift() ?? "", stderr: "" };
    if (command === "push" && options.pushError !== undefined) throw options.pushError;
    return { stdout: "", stderr: "" };
  });
}

describe("process branch updater", () => {
  it("merges the upstream base cleanly and pushes with an explicit revision lease", async () => {
    const execute = gitMock({ revisions: [revision, baseRevision, updatedRevision], mergeBase: mergeBaseRevision });
    const updater = createProcessBranchUpdater({ execute });

    await expect(updater.update(request)).resolves.toEqual({ status: "updated", revision: updatedRevision });

    expect(execute).toHaveBeenLastCalledWith("git", [
      "-C", "/safe/disposable-checkout",
      "push", "--force-with-lease=refs/heads/sandcastle/issue-221:0123456789abcdef0123456789abcdef01234567",
      "origin", "HEAD:refs/heads/sandcastle/issue-221",
    ]);
  });

  it("short-circuits an already-up-to-date branch without merging or pushing", async () => {
    const execute = gitMock({ revisions: [revision, baseRevision], mergeBase: baseRevision });
    const updater = createProcessBranchUpdater({ execute });

    await expect(updater.update(request)).resolves.toEqual({ status: "up-to-date" });

    expect(execute).not.toHaveBeenCalledWith("git", expect.arrayContaining(["merge"]));
    expect(execute).not.toHaveBeenCalledWith("git", expect.arrayContaining(["push"]));
  });

  it("runs the resolver after a conflict, verifies the commit, and pushes its result", async () => {
    const execute = gitMock({
      revisions: [revision, baseRevision, updatedRevision],
      mergeBase: mergeBaseRevision,
      merge: "conflict",
      diffs: ["src/index.ts\n", ""],
    });
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
    expect(execute).toHaveBeenLastCalledWith("git", [
      "-C", "/safe/disposable-checkout",
      "push", "--force-with-lease=refs/heads/sandcastle/issue-221:0123456789abcdef0123456789abcdef01234567",
      "origin", "HEAD:refs/heads/sandcastle/issue-221",
    ]);
  });

  it("fails closed when the conflict-resolution agent produces no commit", async () => {
    const execute = gitMock({
      revisions: [revision, baseRevision, revision],
      mergeBase: mergeBaseRevision,
      merge: "conflict",
      diffs: ["src/index.ts\n"],
    });
    const updater = createProcessBranchUpdater({
      execute,
      resolver: { resolve: vi.fn().mockResolvedValue({ comment: "No commit." }) },
    });

    await expect(updater.update(request)).rejects.toThrow("Conflict-resolution agent produced no commits");
    expect(execute).not.toHaveBeenCalledWith("git", expect.arrayContaining(["push"]));
  });

  it("fails closed when the conflict-resolution agent leaves unresolved paths", async () => {
    const execute = gitMock({
      revisions: [revision, baseRevision, updatedRevision],
      mergeBase: mergeBaseRevision,
      merge: "conflict",
      diffs: ["src/index.ts\n", "src/other.ts\n"],
    });
    const updater = createProcessBranchUpdater({
      execute,
      resolver: { resolve: vi.fn().mockResolvedValue({ comment: "Still conflicted." }) },
    });

    await expect(updater.update(request)).rejects.toThrow("Conflict-resolution agent left unresolved conflicts in:\nsrc/other.ts");
    expect(execute).not.toHaveBeenCalledWith("git", expect.arrayContaining(["push"]));
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
