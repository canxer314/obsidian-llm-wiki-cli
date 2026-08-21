import { describe, expect, it, vi } from "vitest";

import { createTargetCheckout } from "../.sandcastle/target-checkout.js";

const revision = "0123456789abcdef0123456789abcdef01234567";

describe("Target Checkout", () => {
  it("creates an independent no-checkout clone and fetches then verifies only the acquired revision", async () => {
    const execute = vi.fn()
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
      "clone", "--no-checkout", "/trusted/source", "/jobs/review-220-job-a",
    ]);
    expect(execute).toHaveBeenNthCalledWith(2, "git", [
      "-C", "/jobs/review-220-job-a", "fetch", "--no-tags", "origin", revision,
    ]);
    expect(execute).toHaveBeenNthCalledWith(3, "git", [
      "-C", "/jobs/review-220-job-a", "rev-parse", "FETCH_HEAD",
    ]);
    expect(execute).toHaveBeenNthCalledWith(4, "git", [
      "-C", "/jobs/review-220-job-a", "ls-tree", "-r", "--name-only", revision,
      "--", ".sandcastle/.env",
    ]);
    expect(execute).toHaveBeenNthCalledWith(5, "git", [
      "-C", "/jobs/review-220-job-a", "checkout", "--detach", revision,
    ]);
    expect(execute).toHaveBeenNthCalledWith(6, "npm", [
      "--prefix", "/jobs/review-220-job-a", "ci",
    ]);
    expect(execute).not.toHaveBeenCalledWith("git", expect.arrayContaining(["worktree"]));
    expect(execute).not.toHaveBeenCalledWith("git", expect.arrayContaining(["--shared"]));
  });

  it("rejects a tracked Sandcastle private environment file before dependencies or Agent execution", async () => {
    const execute = vi.fn()
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
