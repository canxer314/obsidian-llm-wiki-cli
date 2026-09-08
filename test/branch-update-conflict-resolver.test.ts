import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { createBranchUpdateConflictResolverSession } from "../.sandcastle/branch-update-conflict-resolver.js";

const request = {
  model: "implementer-model",
  pullRequestNumber: 225,
  branch: "sandcastle/issue-221",
  baseBranch: "master",
  checkoutPath: "/safe/disposable-checkout",
  conflicts: ["src/index.ts"],
};

function git(repository: string, arguments_: readonly string[]): string {
  return execFileSync(
    "git",
    ["-c", "user.name=test", "-c", "user.email=test@example.test", ...arguments_],
    { cwd: repository, encoding: "utf8" },
  );
}

describe("branch update conflict resolver session", () => {
  it("runs the resolver on the head of the acquired branch checkout and extracts its PR comment", async () => {
    const runAgent = vi.fn().mockResolvedValue({ output: { comment: "Resolved src/index.ts." } });
    const resolver = createBranchUpdateConflictResolverSession({
      sandbox: { kind: "fake-sandbox" } as never,
      hooks: { sandbox: { onSandboxReady: [] } },
      runAgent: runAgent as never,
      createAgent: vi.fn().mockReturnValue({ name: "fake-resolver" }) as never,
    });

    await expect(resolver.resolve(request)).resolves.toEqual({ comment: "Resolved src/index.ts." });

    expect(runAgent).toHaveBeenCalledWith(expect.objectContaining({
      cwd: "/safe/disposable-checkout",
      branchStrategy: { type: "head" },
      maxIterations: 1,
      name: "branch-update-pr-225",
      output: expect.objectContaining({ _tag: "object", tag: "output", maxRetries: 2 }),
    }));
    expect(runAgent.mock.calls[0]![0].prompt).toContain("src/index.ts");
    expect(runAgent.mock.calls[0]![0].prompt).toContain("Do not abort the merge");
  });

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

      const runAgent = vi.fn(async (options: { readonly cwd: string }) => {
        writeFileSync(join(options.cwd, "conflict.txt"), "resolved\n");
        git(options.cwd, ["add", "conflict.txt"]);
        git(options.cwd, ["commit", "--quiet", "--no-edit"]);
        return { output: { comment: "Resolved conflict.txt." } };
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
      const topology = git(repository, ["rev-list", "--parents", "--max-count=1", "HEAD"]).trim().split(/\s+/u);
      expect(topology.slice(1)).toEqual([branchSha, masterSha]);
      expect(git(repository, ["status", "--porcelain"]).trim()).toBe("");
    } finally {
      rmSync(repository, { recursive: true, force: true });
    }
  });
});
