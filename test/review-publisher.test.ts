import { describe, expect, it, vi } from "vitest";

import { createReviewPublisher } from "../.sandcastle/review-publisher.js";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const REMOTE = "https://github.com/example/repository.git";

describe("review publisher", () => {
  it("starts the review branch at the acquired head and pushes the reviewer commit with an exact lease", async () => {
    const execute = vi.fn()
      .mockResolvedValueOnce({ stdout: "", stderr: "" })
      .mockResolvedValueOnce({ stdout: "", stderr: "" })
      .mockResolvedValueOnce({ stdout: "", stderr: "" })
      .mockResolvedValueOnce({ stdout: `${SHA_A}\n`, stderr: "" })
      .mockResolvedValueOnce({ stdout: `${SHA_B}\n`, stderr: "" })
      .mockResolvedValueOnce({ stdout: `${REMOTE}\n`, stderr: "" })
      .mockResolvedValueOnce({ stdout: "", stderr: "" });
    const publisher = createReviewPublisher({ execute });

    await publisher.prepare("/checkout", "feature/review", SHA_A);
    await expect(publisher.publish({ checkoutPath: "/checkout", branch: "feature/review", expectedRevision: SHA_A })).resolves.toBe(SHA_B);

    expect(execute).toHaveBeenNthCalledWith(1, "git", ["-C", "/checkout", "config", "user.name", "claude-code[bot]"]);
    expect(execute).toHaveBeenNthCalledWith(2, "git", ["-C", "/checkout", "config", "user.email", "claude-code[bot]@users.noreply.github.com"]);
    expect(execute).toHaveBeenNthCalledWith(3, "git", ["-C", "/checkout", "checkout", "-B", "feature/review", SHA_A]);
    expect(execute).toHaveBeenNthCalledWith(5, "git", ["-C", "/checkout", "rev-parse", "HEAD"]);
    expect(execute).toHaveBeenNthCalledWith(6, "git", ["-C", "/checkout", "remote", "get-url", "origin"]);
    expect(execute).toHaveBeenNthCalledWith(7, "git", [
      "-C", "/checkout", "push", REMOTE,
      `--force-with-lease=refs/heads/feature/review:${SHA_A}`,
      "HEAD:refs/heads/feature/review",
    ]);
  });

  it.each([
    {
      name: "malformed acquired revision",
      branch: "feature/review",
      revision: "not-a-full-revision",
      diagnostic: "Review publication requires a full expected revision",
    },
    {
      name: "invalid branch",
      branch: "-unsafe",
      revision: SHA_A,
      diagnostic: "Review publication branch is invalid",
    },
  ])("rejects $name before preparing the checkout", async ({ branch, revision, diagnostic }) => {
    const execute = vi.fn();
    const publisher = createReviewPublisher({ execute });

    await expect(publisher.prepare("/checkout", branch, revision)).rejects.toThrow(diagnostic);
    expect(execute).not.toHaveBeenCalled();
  });

  it("rejects when the prepared checkout does not resolve to the acquired revision", async () => {
    const execute = vi.fn()
      .mockResolvedValueOnce({ stdout: "", stderr: "" })
      .mockResolvedValueOnce({ stdout: "", stderr: "" })
      .mockResolvedValueOnce({ stdout: "", stderr: "" })
      .mockResolvedValueOnce({ stdout: `${SHA_B}\n`, stderr: "" });
    const publisher = createReviewPublisher({ execute });

    await expect(publisher.prepare("/checkout", "feature/review", SHA_A))
      .rejects.toThrow("Review checkout did not start at the acquired revision");
    expect(execute).toHaveBeenNthCalledWith(1, "git", [
      "-C", "/checkout", "config", "user.name", "claude-code[bot]",
    ]);
    expect(execute).toHaveBeenNthCalledWith(2, "git", [
      "-C", "/checkout", "config", "user.email", "claude-code[bot]@users.noreply.github.com",
    ]);
    expect(execute).toHaveBeenNthCalledWith(3, "git", [
      "-C", "/checkout", "checkout", "-B", "feature/review", SHA_A,
    ]);
    expect(execute).toHaveBeenNthCalledWith(4, "git", [
      "-C", "/checkout", "rev-parse", "HEAD",
    ]);
  });

  it("uses the trusted source origin without consulting the Target Checkout remote", async () => {
    const execute = vi.fn()
      .mockResolvedValueOnce({ stdout: `${SHA_B}\n`, stderr: "" })
      .mockResolvedValueOnce({ stdout: `${REMOTE}\n`, stderr: "" })
      .mockResolvedValueOnce({ stdout: "", stderr: "" });
    const publisher = createReviewPublisher({
      execute,
      sourceRepositoryPath: "/trusted/source",
    });

    await expect(publisher.publish({
      checkoutPath: "/checkout",
      branch: "feature/review",
      expectedRevision: SHA_A,
    })).resolves.toBe(SHA_B);
    expect(execute).toHaveBeenNthCalledWith(2, "git", [
      "-C", "/trusted/source", "remote", "get-url", "origin",
    ]);
    expect(execute).toHaveBeenNthCalledWith(3, "git", [
      "-C", "/checkout", "push", REMOTE,
      `--force-with-lease=refs/heads/feature/review:${SHA_A}`,
      "HEAD:refs/heads/feature/review",
    ]);
  });

  it("permits an unchanged reviewer revision", async () => {
    const execute = vi.fn()
      .mockResolvedValueOnce({ stdout: `${SHA_A}\n`, stderr: "" })
      .mockResolvedValueOnce({ stdout: `${REMOTE}\n`, stderr: "" })
      .mockResolvedValueOnce({ stdout: "", stderr: "" });
    const publisher = createReviewPublisher({ execute });

    await expect(publisher.publish({
      checkoutPath: "/checkout",
      branch: "feature/review",
      expectedRevision: SHA_A,
    })).resolves.toBe(SHA_A);
  });

  it.each([
    {
      name: "malformed expected revision",
      branch: "feature/review",
      expectedRevision: "not-a-full-revision",
      head: undefined,
      diagnostic: "Review publication requires a full expected revision",
    },
    {
      name: "invalid branch",
      branch: "feature..review",
      expectedRevision: SHA_A,
      head: undefined,
      diagnostic: "Review publication branch is invalid",
    },
    {
      name: "malformed resulting revision",
      branch: "feature/review",
      expectedRevision: SHA_A,
      head: "not-a-full-revision\n",
      diagnostic: "Reviewer did not leave a full local revision",
    },
  ])("uses the stable review diagnostic for $name", async ({
    branch,
    expectedRevision,
    head,
    diagnostic,
  }) => {
    const execute = head === undefined
      ? vi.fn()
      : vi.fn().mockResolvedValueOnce({ stdout: head, stderr: "" });
    const publisher = createReviewPublisher({ execute });

    await expect(publisher.publish({
      checkoutPath: "/checkout",
      branch,
      expectedRevision,
    })).rejects.toThrow(diagnostic);
    expect(execute).toHaveBeenCalledTimes(head === undefined ? 0 : 1);
  });

  it("rejects a credential-bearing Target Checkout origin before push", async () => {
    const execute = vi.fn()
      .mockResolvedValueOnce({ stdout: `${SHA_B}\n`, stderr: "" })
      .mockResolvedValueOnce({ stdout: "https://token@example.test/repo.git\n", stderr: "" });
    const publisher = createReviewPublisher({ execute });

    await expect(publisher.publish({
      checkoutPath: "/checkout",
      branch: "feature/review",
      expectedRevision: SHA_A,
    })).rejects.toThrow("Review publication remote is invalid");
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("propagates a lease rejection without publishing a review revision", async () => {
    const execute = vi.fn()
      .mockResolvedValueOnce({ stdout: `${SHA_B}\n`, stderr: "" })
      .mockResolvedValueOnce({ stdout: `${REMOTE}\n`, stderr: "" })
      .mockRejectedValueOnce(new Error("stale info"));
    const publisher = createReviewPublisher({ execute });

    await expect(publisher.publish({ checkoutPath: "/checkout", branch: "feature/review", expectedRevision: SHA_A }))
      .rejects.toThrow("stale info");
    expect(execute).toHaveBeenCalledTimes(3);
  });
});
