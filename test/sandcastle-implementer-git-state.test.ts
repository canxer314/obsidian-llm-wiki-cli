import { describe, expect, it, vi } from "vitest";

import type { CheckoutObserver } from "../.sandcastle/checkout-safety.js";
import { createImplementerGitState } from "../.sandcastle/implementer-git-state.js";
import { isStopRetry } from "../.sandcastle/invocation-recovery.js";

const checkoutPath = "/safe/disposable-checkout";
const branch = "sandcastle/issue-103";
const baseline = "a".repeat(40);
const headOne = "b".repeat(40);
const worktreePath = `${checkoutPath}/.sandcastle/worktrees/sandcastle-issue-103`;

type Execution = { readonly stdout: string; readonly stderr: string };

// Routes git invocations by their argument list; unmatched commands fail the
// test loudly so the port's exact command surface stays pinned.
function executeDouble(
  routes: ReadonlyArray<{
    readonly command: string;
    readonly result?: Execution;
    readonly failure?: Error;
  }>,
): ReturnType<typeof vi.fn> {
  return vi.fn(async (_file: string, arguments_: readonly string[]) => {
    const command = arguments_.join(" ");
    for (const route of routes) {
      if (command.includes(route.command)) {
        if (route.failure !== undefined) throw route.failure;
        return route.result ?? { stdout: "", stderr: "" };
      }
    }
    throw new Error(`unexpected command: ${command}`);
  });
}

const worktreeListing = (...entries: readonly string[]) => entries.join("\n");

describe("Implementer Git-state port", () => {
  it("prepares the deterministic local branch at the baseline without checking it out", async () => {
    const execute = executeDouble([{ command: `branch ${branch} ${baseline}` }]);
    const port = createImplementerGitState({ checkoutPath, execute: execute as never });

    await port.prepareBranch({ branch, baseline });

    expect(execute).toHaveBeenCalledWith("git", ["-C", checkoutPath, "branch", branch, baseline]);
  });

  it("fetches origin without tags", async () => {
    const execute = executeDouble([{ command: "fetch --no-tags origin" }]);
    const port = createImplementerGitState({ checkoutPath, execute: execute as never });

    await port.fetchRemote();

    expect(execute).toHaveBeenCalledWith("git", ["-C", checkoutPath, "fetch", "--no-tags", "origin"]);
  });

  it("observes the local branch revision and reports an absent branch as undefined", async () => {
    const execute = executeDouble([{
      command: `for-each-ref --format=%(objectname) refs/heads/${branch}`,
      result: { stdout: `${headOne}\n`, stderr: "" },
    }]);
    const port = createImplementerGitState({ checkoutPath, execute: execute as never });

    await expect(port.observeLocalBranch(branch)).resolves.toBe(headOne);

    const missing = createImplementerGitState({
      checkoutPath,
      execute: executeDouble([{ command: "for-each-ref" }]) as never,
    });
    await expect(missing.observeLocalBranch(branch)).resolves.toBeUndefined();
  });

  it("observes the remote-tracking branch revision and reports an absent branch as undefined", async () => {
    const execute = executeDouble([{
      command: `rev-parse --verify --quiet origin/${branch}`,
      result: { stdout: `${headOne}\n`, stderr: "" },
    }]);
    const port = createImplementerGitState({ checkoutPath, execute: execute as never });

    await expect(port.observeRemoteBranch(branch)).resolves.toBe(headOne);
    expect(execute).toHaveBeenCalledWith("git", [
      "-C", checkoutPath, "rev-parse", "--verify", "--quiet", `origin/${branch}`,
    ]);

    const missing = createImplementerGitState({
      checkoutPath,
      execute: executeDouble([{
        command: "rev-parse",
        failure: new Error("git rev-parse exited with 1"),
      }]) as never,
    });
    await expect(missing.observeRemoteBranch(branch)).resolves.toBeUndefined();
  });

  it("answers ancestry from merge-base and propagates unanswerable ancestry", async () => {
    const ancestor = createImplementerGitState({
      checkoutPath,
      execute: executeDouble([{ command: `merge-base --is-ancestor ${baseline} ${headOne}` }]) as never,
    });
    await expect(ancestor.isAncestor(baseline, headOne)).resolves.toBe(true);

    const notAncestor = createImplementerGitState({
      checkoutPath,
      execute: executeDouble([{
        command: "merge-base",
        failure: new Error("git merge-base exited with 1"),
      }]) as never,
    });
    await expect(notAncestor.isAncestor(headOne, baseline)).resolves.toBe(false);

    const unknown = createImplementerGitState({
      checkoutPath,
      execute: executeDouble([{
        command: "merge-base",
        failure: new Error("git merge-base exited with 128"),
      }]) as never,
    });
    await expect(unknown.isAncestor(baseline, headOne)).rejects.toThrow("exited with 128");
  });

  it("reports undefined when no managed worktree holds the deterministic branch", async () => {
    const execute = executeDouble([{
      command: "worktree list --porcelain",
      result: {
        stdout: worktreeListing(
          `worktree ${checkoutPath}`,
          `HEAD ${baseline}`,
          "detached",
          "",
        ),
        stderr: "",
      },
    }]);
    const port = createImplementerGitState({ checkoutPath, execute: execute as never });

    await expect(port.observeManagedWorktree(branch)).resolves.toBeUndefined();
  });

  it("proves the managed worktree clean through the checkout observer", async () => {
    const execute = executeDouble([{
      command: "worktree list --porcelain",
      result: {
        stdout: worktreeListing(
          `worktree ${checkoutPath}`,
          `HEAD ${baseline}`,
          "detached",
          "",
          `worktree ${worktreePath}`,
          `HEAD ${headOne}`,
          `branch refs/heads/${branch}`,
          "",
        ),
        stderr: "",
      },
    }]);
    const observer = {
      observe: vi.fn(async () => ({ head: headOne, entries: [] })),
    } as unknown as CheckoutObserver;
    const port = createImplementerGitState({
      checkoutPath,
      execute: execute as never,
      observer,
    });

    await expect(port.observeManagedWorktree(branch)).resolves.toEqual({
      path: worktreePath,
      clean: true,
    });
    expect(observer.observe).toHaveBeenCalledWith(worktreePath);
  });

  it("reports a dirty preserved worktree as unclean evidence", async () => {
    const execute = executeDouble([{
      command: "worktree list --porcelain",
      result: {
        stdout: worktreeListing(
          `worktree ${checkoutPath}`,
          `HEAD ${baseline}`,
          "detached",
          "",
          `worktree ${worktreePath}`,
          `HEAD ${headOne}`,
          `branch refs/heads/${branch}`,
          "",
        ),
        stderr: "",
      },
    }]);
    const observer = {
      observe: vi.fn(async () => ({
        head: headOne,
        entries: [{ index: " ", worktree: "M", path: "src/file.ts", kind: "tracked" }],
      })),
    } as unknown as CheckoutObserver;
    const port = createImplementerGitState({
      checkoutPath,
      execute: execute as never,
      observer,
    });

    await expect(port.observeManagedWorktree(branch)).resolves.toEqual({
      path: worktreePath,
      clean: false,
    });
  });

  it("stops when the deterministic branch is checked out in the root Target Checkout", async () => {
    const execute = executeDouble([{
      command: "worktree list --porcelain",
      result: {
        stdout: worktreeListing(
          `worktree ${checkoutPath}`,
          `HEAD ${headOne}`,
          `branch refs/heads/${branch}`,
          "",
        ),
        stderr: "",
      },
    }]);
    const port = createImplementerGitState({ checkoutPath, execute: execute as never });

    const failure = await port.observeManagedWorktree(branch).catch((error: unknown) => error);
    expect(isStopRetry(failure)).toBe(true);
  });
});
