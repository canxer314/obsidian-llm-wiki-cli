import { mkdtemp, mkdir, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { createTargetCheckout, removeExpiredFailureCheckouts } from "../.sandcastle/target-checkout.js";

const revision = "0123456789abcdef0123456789abcdef01234567";
const remote = "https://github.com/example/repository.git";

describe("Target Checkout", () => {
  it("clones the resolved GitHub remote and fetches then verifies only the acquired revision", async () => {
    const execute = vi.fn()
      .mockResolvedValueOnce({ stdout: `${remote}\n`, stderr: "" })
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
      "-C", "/jobs/review-220-job-a", "fetch", "--no-tags", "origin", revision,
    ]);
    expect(execute).toHaveBeenNthCalledWith(4, "git", [
      "-C", "/jobs/review-220-job-a", "rev-parse", "FETCH_HEAD",
    ]);
    expect(execute).toHaveBeenNthCalledWith(5, "git", [
      "-C", "/jobs/review-220-job-a", "ls-tree", "-r", "--name-only", revision,
      "--", ".sandcastle/.env",
    ]);
    expect(execute).toHaveBeenNthCalledWith(6, "git", [
      "-C", "/jobs/review-220-job-a", "checkout", "--detach", revision,
    ]);
    expect(execute).toHaveBeenNthCalledWith(7, "npm", [
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

  it("rejects a tracked Sandcastle private environment file before dependencies or Agent execution", async () => {
    const execute = vi.fn()
      .mockResolvedValueOnce({ stdout: `${remote}\n`, stderr: "" })
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