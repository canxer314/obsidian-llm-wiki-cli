import { execFile } from "node:child_process";
import { access, mkdtemp, mkdir, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createTargetCheckout, removeExpiredFailureCheckouts } from "../.sandcastle/target-checkout.js";

const executeFile = promisify(execFile);
const revision = "0123456789abcdef0123456789abcdef01234567";
const remote = "https://github.com/example/repository.git";

const git = async (arguments_: readonly string[]): Promise<string> =>
  (await executeFile("git", [...arguments_])).stdout.trim();

const pathExists = async (path: string): Promise<boolean> =>
  access(path).then(() => true, () => false);

describe("Target Checkout", () => {
  it("clones the resolved GitHub remote and fetches then verifies only the acquired revision", async () => {
    const execute = vi.fn()
      .mockResolvedValueOnce({ stdout: `${remote}\n`, stderr: "" })
      .mockResolvedValueOnce({ stdout: "", stderr: "" })
      .mockResolvedValueOnce({ stdout: "Fixture Source\n", stderr: "" })
      .mockResolvedValueOnce({ stdout: "source@fixture.example\n", stderr: "" })
      .mockResolvedValueOnce({ stdout: "", stderr: "" })
      .mockResolvedValueOnce({ stdout: "", stderr: "" })
      .mockResolvedValueOnce({ stdout: "", stderr: "" })
      .mockResolvedValueOnce({ stdout: `${revision}\n`, stderr: "" })
      .mockResolvedValueOnce({ stdout: "", stderr: "" })
      .mockResolvedValueOnce({ stdout: "", stderr: "" })
      .mockResolvedValueOnce({ stdout: "", stderr: "" });
    const checkout = createTargetCheckout({
      sourceRepositoryPath: "/trusted/source",
      checkoutRoot: "/jobs",
      execute,
      createJobDirectory: () => "/jobs/review-220-job-a",
    });

    await expect(checkout.withCheckout({ pullRequestNumber: 220, revision }, async (path) => path))
      .resolves.toBe("/jobs/review-220-job-a");

    expect(execute).toHaveBeenNthCalledWith(1, "git", [
      "-C", "/trusted/source", "remote", "get-url", "origin",
    ]);
    expect(execute).toHaveBeenNthCalledWith(2, "git", [
      "clone", "--no-checkout", "--no-local", remote, "/jobs/review-220-job-a",
    ]);
    expect(execute).toHaveBeenNthCalledWith(3, "git", [
      "-C", "/trusted/source", "config", "--get", "user.name",
    ]);
    expect(execute).toHaveBeenNthCalledWith(4, "git", [
      "-C", "/trusted/source", "config", "--get", "user.email",
    ]);
    expect(execute).toHaveBeenNthCalledWith(5, "git", [
      "-C", "/jobs/review-220-job-a", "config", "--local", "user.name", "Fixture Source",
    ]);
    expect(execute).toHaveBeenNthCalledWith(6, "git", [
      "-C", "/jobs/review-220-job-a", "config", "--local", "user.email", "source@fixture.example",
    ]);
    expect(execute).toHaveBeenNthCalledWith(7, "git", [
      "-C", "/jobs/review-220-job-a", "fetch", "--no-tags", "origin", revision,
    ]);
    expect(execute).toHaveBeenNthCalledWith(8, "git", [
      "-C", "/jobs/review-220-job-a", "rev-parse", "FETCH_HEAD",
    ]);
    expect(execute).toHaveBeenNthCalledWith(9, "git", [
      "-C", "/jobs/review-220-job-a", "ls-tree", "-r", "--name-only", revision,
      "--", ".sandcastle/.env",
    ]);
    expect(execute).toHaveBeenNthCalledWith(10, "git", [
      "-C", "/jobs/review-220-job-a", "checkout", "--detach", revision,
    ]);
    expect(execute).toHaveBeenNthCalledWith(11, "npm", [
      "--prefix", "/jobs/review-220-job-a", "ci", "--ignore-scripts",
    ]);
    expect(execute).not.toHaveBeenCalledWith("git", expect.arrayContaining(["worktree"]));
    expect(execute).not.toHaveBeenCalledWith("git", expect.arrayContaining(["--shared"]));
  });

  it("rejects a source remote with embedded credentials before cloning", async () => {
    const execute = vi.fn()
      .mockResolvedValueOnce({ stdout: "https://token@github.com/example/repository.git\n", stderr: "" });
    const action = vi.fn();
    const checkout = createTargetCheckout({
      sourceRepositoryPath: "/trusted/source",
      checkoutRoot: "/jobs",
      execute,
      createJobDirectory: () => "/jobs/review-220-job-a",
    });

    await expect(checkout.withCheckout({ pullRequestNumber: 220, revision }, action))
      .rejects.toThrow("Target Checkout remote is invalid");

    expect(action).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalledWith("git", expect.arrayContaining(["clone"]));
  });

  it.each([
    "git@github.com:example/repository.git",
    "ssh://git@github.com/example/repository.git",
    "http://github.com/example/repository.git",
  ])("rejects a non-HTTPS source remote before cloning", async (invalidRemote) => {
    const execute = vi.fn()
      .mockResolvedValueOnce({ stdout: `${invalidRemote}\n`, stderr: "" });
    const action = vi.fn();
    const checkout = createTargetCheckout({
      sourceRepositoryPath: "/trusted/source",
      checkoutRoot: "/jobs",
      execute,
      createJobDirectory: () => "/jobs/review-220-job-a",
    });

    await expect(checkout.withCheckout({ pullRequestNumber: 220, revision }, action))
      .rejects.toThrow("Target Checkout remote is invalid");

    expect(action).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalledWith("git", expect.arrayContaining(["clone"]));
  });

  it("rejects a tracked Sandcastle private environment file before dependencies or Agent execution", async () => {
    const execute = vi.fn()
      .mockResolvedValueOnce({ stdout: `${remote}\n`, stderr: "" })
      .mockResolvedValueOnce({ stdout: "", stderr: "" })
      .mockResolvedValueOnce({ stdout: "Fixture Source\n", stderr: "" })
      .mockResolvedValueOnce({ stdout: "source@fixture.example\n", stderr: "" })
      .mockResolvedValueOnce({ stdout: "", stderr: "" })
      .mockResolvedValueOnce({ stdout: "", stderr: "" })
      .mockResolvedValueOnce({ stdout: "", stderr: "" })
      .mockResolvedValueOnce({ stdout: `${revision}\n`, stderr: "" })
      .mockResolvedValueOnce({ stdout: "100644 blob\t.sandcastle/.env\n", stderr: "" });
    const action = vi.fn();
    const checkout = createTargetCheckout({
      sourceRepositoryPath: "/trusted/source",
      checkoutRoot: "/jobs",
      execute,
      createJobDirectory: () => "/jobs/review-220-job-a",
    });

    await expect(checkout.withCheckout({ pullRequestNumber: 220, revision }, action))
      .rejects.toThrow("tracks a Sandcastle private environment file");

    expect(action).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalledWith("git", expect.arrayContaining(["checkout"]));
  });

  it("rejects a source checkout without a git identity before fetching", async () => {
    const execute = vi.fn()
      .mockResolvedValueOnce({ stdout: `${remote}\n`, stderr: "" })
      .mockResolvedValueOnce({ stdout: "", stderr: "" })
      .mockResolvedValueOnce({ stdout: "", stderr: "" })
      .mockResolvedValueOnce({ stdout: "source@fixture.example\n", stderr: "" });
    const action = vi.fn();
    const checkout = createTargetCheckout({
      sourceRepositoryPath: "/trusted/source",
      checkoutRoot: "/jobs",
      execute,
      createJobDirectory: () => "/jobs/review-220-job-a",
    });

    await expect(checkout.withCheckout({ pullRequestNumber: 220, revision }, action))
      .rejects.toThrow(
        "no configured git user.name/user.email",
      );

    expect(action).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalledWith("git", expect.arrayContaining(["fetch"]));
  });
});

describe("Target Checkout real Git filesystem integration", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  const createFixture = async (): Promise<{
    readonly root: string;
    readonly remotePath: string;
    readonly trustedPath: string;
    readonly registeredWorktreePath: string;
    readonly checkoutRoot: string;
    readonly hiddenRevision: string;
  }> => {
    const root = await mkdtemp(join(tmpdir(), "target-checkout-integration-"));
    roots.push(root);
    const remotePath = join(root, "remote.git");
    const contributorPath = join(root, "contributor");
    const trustedPath = join(root, "trusted");
    const registeredWorktreePath = join(root, "registered-worktree");
    const checkoutRoot = join(root, "jobs");

    await git(["init", "--bare", "-b", "master", remotePath]);
    // This simulates GitHub's ability to serve an unadvertised Pull Request SHA.
    await git(["-C", remotePath, "config", "uploadpack.allowAnySHA1InWant", "true"]);
    await git(["init", "-b", "master", contributorPath]);
    await git(["-C", contributorPath, "config", "user.name", "Fixture Contributor"]);
    await git(["-C", contributorPath, "config", "user.email", "contributor@example.test"]);
    await writeFile(join(contributorPath, "package.json"), JSON.stringify({
      name: "target-checkout-fixture",
      version: "1.0.0",
      private: true,
    }));
    await writeFile(join(contributorPath, "package-lock.json"), JSON.stringify({
      name: "target-checkout-fixture",
      version: "1.0.0",
      lockfileVersion: 3,
      requires: true,
      packages: { "": { name: "target-checkout-fixture", version: "1.0.0" } },
    }));
    await writeFile(join(contributorPath, "base.txt"), "base\n");
    await git(["-C", contributorPath, "add", "-A"]);
    await git(["-C", contributorPath, "commit", "-m", "initial commit"]);
    await git(["-C", contributorPath, "remote", "add", "origin", remotePath]);
    await git(["-C", contributorPath, "push", "origin", "master"]);
    await git(["clone", "--no-local", remotePath, trustedPath]);
    await git(["-C", trustedPath, "config", "user.name", "Trusted Source"]);
    await git(["-C", trustedPath, "config", "user.email", "trusted-source@example.test"]);
    // Production only accepts credential-free HTTPS remotes. Keep the bare
    // repository local while making the trusted source resolve the production
    // remote shape; the execution seam maps clone-only traffic to the fixture.
    await git(["-C", trustedPath, "remote", "set-url", "origin", "https://github.com/example/repository.git"]);
    await git(["-C", trustedPath, "worktree", "add", "--detach", registeredWorktreePath, "master"]);

    await git(["-C", contributorPath, "switch", "-c", "hidden-pr"]);
    await writeFile(join(contributorPath, "target-only.txt"), "target revision\n");
    await git(["-C", contributorPath, "add", "target-only.txt"]);
    await git(["-C", contributorPath, "commit", "-m", "unadvertised target"]);
    const hiddenRevision = await git(["-C", contributorPath, "rev-parse", "HEAD"]);
    await git(["-C", contributorPath, "push", "origin", "hidden-pr"]);
    await git(["-C", remotePath, "update-ref", "-d", "refs/heads/hidden-pr"]);

    return { root, remotePath, trustedPath, registeredWorktreePath, checkoutRoot, hiddenRevision };
  };

  it("fetches an unadvertised revision into an independent checkout, runs isolated dependency setup, and confines successful cleanup", async () => {
    const fixture = await createFixture();
    const cachePath = join(fixture.root, "download-cache");
    const historicalPath = join(fixture.checkoutRoot, "historical-failure");
    const unrelatedClaudeWorktreePath = join(fixture.root, "unrelated-claude-worktree");
    await Promise.all([
      mkdir(historicalPath, { recursive: true }),
      mkdir(unrelatedClaudeWorktreePath, { recursive: true }),
    ]);
    await writeFile(join(unrelatedClaudeWorktreePath, "sentinel"), "preserve me\n");
    await expect(executeFile("git", ["-C", fixture.trustedPath, "cat-file", "-e", `${fixture.hiddenRevision}^{commit}`]))
      .rejects.toMatchObject({ code: 128 });

    const dependencyPrefixes: string[] = [];
    const dependencyEnvironments: Array<Readonly<Record<string, string>> | undefined> = [];
    const gitCalls: string[][] = [];
    const execute = async (
      file: string,
      arguments_: readonly string[],
      environment?: Readonly<Record<string, string>>,
    ): Promise<{ readonly stdout: string; readonly stderr: string }> => {
      if (file === "npm") {
        const prefix = arguments_[arguments_.indexOf("--prefix") + 1];
        if (prefix === undefined) throw new Error("fake npm requires --prefix");
        dependencyPrefixes.push(prefix);
        dependencyEnvironments.push(environment);
        await mkdir(join(prefix, "node_modules"), { recursive: true });
        await writeFile(join(prefix, "node_modules", ".installed-by-fake-npm"), "installed\n");
        return { stdout: "", stderr: "" };
      }
      gitCalls.push([...arguments_]);
      const actualArguments = arguments_.map((argument) =>
        argument === "https://github.com/example/repository.git" ? fixture.remotePath : argument,
      );
      const result = await executeFile(file, actualArguments, { env: environment });
      return { stdout: result.stdout, stderr: result.stderr };
    };
    const checkout = createTargetCheckout({
      sourceRepositoryPath: fixture.trustedPath,
      checkoutRoot: fixture.checkoutRoot,
      execute,
      dependencyEnvironment: { npm_config_cache: cachePath },
    });
    const checkoutPaths: string[] = [];

    for (let index = 0; index < 2; index += 1) {
      await checkout.withCheckout({ pullRequestNumber: 219, revision: fixture.hiddenRevision }, async (checkoutPath) => {
        checkoutPaths.push(checkoutPath);
        expect(await git(["-C", checkoutPath, "rev-parse", "HEAD"])).toBe(fixture.hiddenRevision);
        expect(await git(["-C", checkoutPath, "rev-parse", "--is-inside-work-tree"])).toBe("true");
        expect((await stat(join(checkoutPath, ".git"))).isDirectory()).toBe(true);
        expect(await pathExists(join(checkoutPath, ".git", "objects", "info", "alternates"))).toBe(false);
        expect(await pathExists(join(checkoutPath, "node_modules", ".installed-by-fake-npm"))).toBe(true);
        expect(await git(["-C", checkoutPath, "config", "--local", "--get", "user.name"])).toBe("Trusted Source");
        expect(await git(["-C", checkoutPath, "config", "--local", "--get", "user.email"])).toBe("trusted-source@example.test");

        // Simulate the Agent's ordinary publication preparation: the detached
        // checkout can create a commit and validate a push without changing source.
        await writeFile(join(checkoutPath, `agent-result-${index}.txt`), "result\n");
        await git(["-C", checkoutPath, "add", "-A"]);
        await git(["-C", checkoutPath, "commit", "-m", "agent result"]);
        await git(["-C", checkoutPath, "push", "--dry-run", "origin", "HEAD:refs/heads/agent-result"]);
      });
    }

    expect(new Set(checkoutPaths).size).toBe(2);
    expect(dependencyPrefixes).toEqual(checkoutPaths);
    expect(dependencyEnvironments).toEqual([
      { npm_config_cache: cachePath },
      { npm_config_cache: cachePath },
    ]);
    expect(gitCalls).toContainEqual([
      "-C", checkoutPaths[0]!, "fetch", "--no-tags", "origin", fixture.hiddenRevision,
    ]);
    expect(await git(["-C", fixture.trustedPath, "worktree", "list", "--porcelain"]))
      .not.toContain(checkoutPaths[0]!);
    expect(await git(["-C", fixture.trustedPath, "worktree", "list", "--porcelain"]))
      .toContain(fixture.registeredWorktreePath);
    await expect(executeFile("git", ["-C", fixture.trustedPath, "cat-file", "-e", `${fixture.hiddenRevision}^{commit}`]))
      .rejects.toMatchObject({ code: 128 });
    await Promise.all(checkoutPaths.map((path) => expect(pathExists(path)).resolves.toBe(false)));
    await expect(pathExists(fixture.trustedPath)).resolves.toBe(true);
    await expect(pathExists(fixture.registeredWorktreePath)).resolves.toBe(true);
    await expect(pathExists(unrelatedClaudeWorktreePath)).resolves.toBe(true);
    await expect(pathExists(join(unrelatedClaudeWorktreePath, "sentinel"))).resolves.toBe(true);
    await expect(pathExists(historicalPath)).resolves.toBe(true);
  });

  it("preserves a failed checkout for diagnosis without affecting source or siblings", async () => {
    const fixture = await createFixture();
    const historicalPath = join(fixture.checkoutRoot, "preserved-historical-failure");
    await mkdir(historicalPath, { recursive: true });
    const checkout = createTargetCheckout({
      sourceRepositoryPath: fixture.trustedPath,
      checkoutRoot: fixture.checkoutRoot,
      execute: async (file, arguments_, environment) => {
        if (file === "npm") return { stdout: "", stderr: "" };
        const actualArguments = arguments_.map((argument) =>
          argument === "https://github.com/example/repository.git" ? fixture.remotePath : argument,
        );
        const result = await executeFile(file, actualArguments, { env: environment });
        return { stdout: result.stdout, stderr: result.stderr };
      },
    });
    let failedCheckoutPath = "";

    await expect(checkout.withCheckout({ revision: fixture.hiddenRevision }, async (checkoutPath) => {
      failedCheckoutPath = checkoutPath;
      throw new Error("agent failed");
    })).rejects.toThrow("agent failed");

    await expect(pathExists(failedCheckoutPath)).resolves.toBe(true);
    await expect(pathExists(fixture.trustedPath)).resolves.toBe(true);
    await expect(pathExists(fixture.registeredWorktreePath)).resolves.toBe(true);
    await expect(pathExists(historicalPath)).resolves.toBe(true);
  });
});

describe("Failed Target Checkout retention", () => {
  it("sweeps failure directories older than seven days and preserves structural directories", async () => {
    const root = await mkdtemp(join(tmpdir(), "failure-checkout-retention-"));
    try {
      const now = Date.now();
      const sevenDays = 7 * 24 * 60 * 60 * 1000;
      const expired = join(root, "feedback-old-job");
      const recent = join(root, "branch-update-new-job");
      const preserved = join(root, "pull-request-leases");
      await mkdir(expired);
      await mkdir(recent);
      await mkdir(preserved);
      await writeFile(join(root, "note.txt"), "not a directory");
      const old = new Date(now - sevenDays - 1000);
      await utimes(expired, old, old);
      await utimes(preserved, old, old);

      await removeExpiredFailureCheckouts({
        root,
        preserve: ["review-artifacts", "pull-request-leases", "implementation-leases"],
        now,
      });

      expect((await readdir(root)).sort()).toEqual(["branch-update-new-job", "note.txt", "pull-request-leases"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("ignores a missing jobs root", async () => {
    await expect(removeExpiredFailureCheckouts({
      root: join(tmpdir(), "failure-checkout-retention-missing-root"),
    })).resolves.toBeUndefined();
  });
});