import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { createCheckoutObserver } from "../.sandcastle/checkout-safety.js";
import {
  invokeWithRecovery,
  isStopRetry,
  StopRetryError,
} from "../.sandcastle/invocation-recovery.js";

function git(repository: string, arguments_: readonly string[]): string {
  return execFileSync(
    "git",
    ["-c", "user.name=test", "-c", "user.email=test@example.test", ...arguments_],
    { cwd: repository, encoding: "utf8" },
  );
}

function initRepository(): string {
  const repository = mkdtempSync(join(tmpdir(), "checkout-safety-"));
  git(repository, ["init", "--quiet", "--initial-branch=main"]);
  writeFileSync(join(repository, "tracked.txt"), "initial\n");
  git(repository, ["add", "tracked.txt"]);
  git(repository, ["commit", "--quiet", "-m", "initial"]);
  return repository;
}

const instantWait = vi.fn(async () => {});

describe("checkout safety observer", () => {
  it("observes a clean checkout with its HEAD and no status entries", async () => {
    const repository = initRepository();
    const observer = createCheckoutObserver();

    const snapshot = await observer.observe(repository);
    const head = git(repository, ["rev-parse", "HEAD"]).trim();

    expect(snapshot.head).toBe(head);
    expect(snapshot.head).toMatch(/^[0-9a-f]{40}$/u);
    expect(snapshot.entries).toEqual([]);
    await expect(observer.requireClean(repository)).resolves.toEqual(snapshot);
  });

  it("rejects a staged change when a clean checkout is required", async () => {
    const repository = initRepository();
    writeFileSync(join(repository, "staged.txt"), "staged\n");
    git(repository, ["add", "staged.txt"]);

    const caught = await createCheckoutObserver().requireClean(repository)
      .catch((error: unknown) => error);

    expect(isStopRetry(caught)).toBe(true);
    expect((caught as Error).message).toContain("staged=1");
    expect((caught as Error).message).not.toContain("staged.txt");
  });

  it("rejects an unstaged tracked-worktree modification", async () => {
    const repository = initRepository();
    writeFileSync(join(repository, "tracked.txt"), "modified\n");

    const caught = await createCheckoutObserver().requireClean(repository)
      .catch((error: unknown) => error);

    expect(isStopRetry(caught)).toBe(true);
    expect((caught as Error).message).toContain("unstaged=1");
  });

  it("rejects a non-ignored untracked file", async () => {
    const repository = initRepository();
    writeFileSync(join(repository, "stray.txt"), "stray\n");

    const caught = await createCheckoutObserver().requireClean(repository)
      .catch((error: unknown) => error);

    expect(isStopRetry(caught)).toBe(true);
    expect((caught as Error).message).toContain("untracked=1");
  });

  it("rejects unmerged paths from an active conflicted merge", async () => {
    const repository = initRepository();
    git(repository, ["checkout", "--quiet", "-b", "other"]);
    writeFileSync(join(repository, "tracked.txt"), "other\n");
    git(repository, ["commit", "--quiet", "-am", "other"]);
    git(repository, ["checkout", "--quiet", "main"]);
    writeFileSync(join(repository, "tracked.txt"), "main\n");
    git(repository, ["commit", "--quiet", "-am", "main"]);
    try {
      git(repository, ["merge", "--no-commit", "other"]);
    } catch {
      // The conflicting merge exits non-zero by design.
    }

    const snapshot = await createCheckoutObserver().observe(repository);
    expect(snapshot.entries.some((entry) => entry.kind === "unmerged")).toBe(true);

    const caught = await createCheckoutObserver().requireClean(repository)
      .catch((error: unknown) => error);
    expect(isStopRetry(caught)).toBe(true);
    expect((caught as Error).message).toContain("unmerged=1");
  });

  it("does not count ignored files as local mutation", async () => {
    const repository = initRepository();
    writeFileSync(join(repository, ".gitignore"), "build/\n");
    git(repository, ["add", ".gitignore"]);
    git(repository, ["commit", "--quiet", "-m", "ignore build output"]);
    mkdirSync(join(repository, "build"));
    writeFileSync(join(repository, "build", "output.txt"), "generated\n");

    const observer = createCheckoutObserver();
    await expect(observer.requireClean(repository)).resolves.toBeDefined();
    const before = await observer.observe(repository);
    await expect(observer.requireUnchanged(before, repository)).resolves.toBeDefined();
  });

  it("does not count fetch-related Git metadata as local mutation", async () => {
    const repository = initRepository();
    const observer = createCheckoutObserver();
    const before = await observer.observe(repository);

    // A fetch only touches .git metadata: FETCH_HEAD, fetched objects, and
    // remote-tracking refs. None of these are local checkout mutation.
    const head = before.head;
    writeFileSync(join(repository, ".git", "FETCH_HEAD"), `${head}\t\tbranch 'main' of origin\n`);
    git(repository, ["update-ref", "refs/remotes/origin/main", head]);

    await expect(observer.requireUnchanged(before, repository)).resolves.toBeDefined();
    await expect(observer.requireClean(repository)).resolves.toBeDefined();
  });

  it("detects HEAD movement and worktree edits as checkout changes", async () => {
    const repository = initRepository();
    const observer = createCheckoutObserver();
    const before = await observer.observe(repository);

    writeFileSync(join(repository, "tracked.txt"), "changed\n");
    const edited = await observer.requireUnchanged(before, repository)
      .catch((error: unknown) => error);
    expect(isStopRetry(edited)).toBe(true);
    expect((edited as Error).message).toContain("changed during a read-only stage");

    git(repository, ["checkout", "--quiet", "--", "tracked.txt"]);
    writeFileSync(join(repository, "tracked.txt"), "committed\n");
    git(repository, ["commit", "--quiet", "-am", "advance head"]);
    const moved = await observer.requireUnchanged(before, repository)
      .catch((error: unknown) => error);
    expect(isStopRetry(moved)).toBe(true);
  });

  it("fails closed when the checkout path is missing", async () => {
    const missing = join(tmpdir(), "checkout-safety-missing-path");

    const caught = await createCheckoutObserver().observe(missing)
      .catch((error: unknown) => error);

    expect(caught).toBeInstanceOf(StopRetryError);
    expect((caught as Error).message).toContain("path is missing");
  });

  it("fails closed when observer commands fail on a non-repository path", async () => {
    const notARepository = mkdtempSync(join(tmpdir(), "checkout-safety-not-git-"));

    const caught = await createCheckoutObserver().observe(notARepository)
      .catch((error: unknown) => error);

    expect(caught).toBeInstanceOf(StopRetryError);
    expect((caught as Error).message).toContain("cannot be observed");
  });

  it("fails closed on malformed HEAD output", async () => {
    const repository = initRepository();
    const execute = vi.fn(async () => ({ stdout: "not-a-revision\n", stderr: "" }));

    const caught = await createCheckoutObserver({ execute }).observe(repository)
      .catch((error: unknown) => error);

    expect(caught).toBeInstanceOf(StopRetryError);
    expect((caught as Error).message).toContain("malformed");
  });

  it("fails closed on malformed porcelain output", async () => {
    const repository = initRepository();
    const head = git(repository, ["rev-parse", "HEAD"]);
    const execute = vi.fn(async (_file: string, arguments_: readonly string[]) => {
      return arguments_.includes("rev-parse")
        ? { stdout: head, stderr: "" }
        : { stdout: "GARBAGE", stderr: "" };
    });

    const caught = await createCheckoutObserver({ execute }).observe(repository)
      .catch((error: unknown) => error);

    expect(caught).toBeInstanceOf(StopRetryError);
    expect((caught as Error).message).toContain("malformed");
  });

  it("fails closed when an observer command cannot run", async () => {
    const repository = initRepository();
    const execute = vi.fn(async () => {
      throw new Error("spawn git ENOENT");
    });

    const caught = await createCheckoutObserver({ execute }).observe(repository)
      .catch((error: unknown) => error);

    expect(caught).toBeInstanceOf(StopRetryError);
    expect((caught as Error).message).toContain("cannot be observed");
  });

  it("treats ignored porcelain entries as non-mutating", async () => {
    const repository = initRepository();
    const head = git(repository, ["rev-parse", "HEAD"]);
    const execute = vi.fn(async (_file: string, arguments_: readonly string[]) => {
      return arguments_.includes("rev-parse")
        ? { stdout: head, stderr: "" }
        : { stdout: "!! build/output.txt", stderr: "" };
    });

    const snapshot = await createCheckoutObserver({ execute }).requireClean(repository);
    expect(snapshot.entries).toEqual([
      { index: "!", worktree: "!", path: "build/output.txt", kind: "ignored" },
    ]);
  });

  it("stops an invocation recovery window instead of allowing another attempt", async () => {
    const missing = join(tmpdir(), "checkout-safety-missing-path");
    const observer = createCheckoutObserver();
    const invoke = vi.fn(async () => observer.requireClean(missing));

    const caught = await invokeWithRecovery(invoke, {
      role: "planner", stage: "plan", wait: instantWait,
    }).catch((error: unknown) => error);

    expect(invoke).toHaveBeenCalledTimes(1);
    expect(caught).toBeInstanceOf(StopRetryError);
  });
});
