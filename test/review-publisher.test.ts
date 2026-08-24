import { describe, expect, it, vi } from "vitest";

import { createReviewPublisher } from "../.sandcastle/review-publisher.js";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

describe("review publisher", () => {
  it("starts the review branch at the acquired head and pushes the reviewer commit with an exact lease", async () => {
    const execute = vi.fn()
      .mockResolvedValueOnce({ stdout: "", stderr: "" })
      .mockResolvedValueOnce({ stdout: "", stderr: "" })
      .mockResolvedValueOnce({ stdout: "", stderr: "" })
      .mockResolvedValueOnce({ stdout: `${SHA_A}\n`, stderr: "" })
      .mockResolvedValueOnce({ stdout: `${SHA_B}\n`, stderr: "" })
      .mockResolvedValueOnce({ stdout: "", stderr: "" });
    const publisher = createReviewPublisher({ execute });

    await publisher.prepare("/checkout", "feature/review", SHA_A);
    await expect(publisher.publish({ checkoutPath: "/checkout", branch: "feature/review", expectedRevision: SHA_A })).resolves.toBe(SHA_B);

    expect(execute).toHaveBeenNthCalledWith(1, "git", ["-C", "/checkout", "config", "user.name", "claude-code[bot]"]);
    expect(execute).toHaveBeenNthCalledWith(2, "git", ["-C", "/checkout", "config", "user.email", "claude-code[bot]@users.noreply.github.com"]);
    expect(execute).toHaveBeenNthCalledWith(3, "git", ["-C", "/checkout", "checkout", "-B", "feature/review", SHA_A]);
    expect(execute).toHaveBeenNthCalledWith(6, "git", [
      "-C", "/checkout", "push", "origin",
      `--force-with-lease=refs/heads/feature/review:${SHA_A}`,
      "HEAD:refs/heads/feature/review",
    ]);
  });

  it("propagates a lease rejection without publishing a review revision", async () => {
    const execute = vi.fn()
      .mockResolvedValueOnce({ stdout: `${SHA_B}\n`, stderr: "" })
      .mockRejectedValueOnce(new Error("stale info"));
    const publisher = createReviewPublisher({ execute });

    await expect(publisher.publish({ checkoutPath: "/checkout", branch: "feature/review", expectedRevision: SHA_A }))
      .rejects.toThrow("stale info");
    expect(execute).toHaveBeenCalledTimes(2);
  });
});
