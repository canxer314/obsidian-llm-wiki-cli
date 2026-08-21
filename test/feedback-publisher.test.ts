import { describe, expect, it, vi } from "vitest";

import { createFeedbackPublisher } from "../.sandcastle/feedback-publisher.js";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

describe("feedback publisher", () => {
  it("starts at the acquired revision and publishes the local commit with an exact lease", async () => {
    const execute = vi.fn()
      .mockResolvedValueOnce({ stdout: "", stderr: "" })
      .mockResolvedValueOnce({ stdout: `${SHA_A}\n`, stderr: "" })
      .mockResolvedValueOnce({ stdout: `${SHA_B}\n`, stderr: "" })
      .mockResolvedValueOnce({ stdout: "", stderr: "" });
    const publisher = createFeedbackPublisher({ execute });

    await publisher.prepare("/checkout", "feature/feedback", SHA_A);
    await expect(publisher.publish({
      checkoutPath: "/checkout",
      branch: "feature/feedback",
      expectedRevision: SHA_A,
    })).resolves.toBe(SHA_B);

    expect(execute).toHaveBeenNthCalledWith(1, "git", ["-C", "/checkout", "checkout", "-B", "feature/feedback", SHA_A]);
    expect(execute).toHaveBeenNthCalledWith(4, "git", [
      "-C", "/checkout", "push", "origin",
      `--force-with-lease=refs/heads/feature/feedback:${SHA_A}`,
      "HEAD:refs/heads/feature/feedback",
    ]);
  });

  it("uses the source repository's credential-free origin rather than the local checkout remote", async () => {
    const execute = vi.fn()
      .mockResolvedValueOnce({ stdout: `${SHA_B}\n`, stderr: "" })
      .mockResolvedValueOnce({ stdout: "https://github.com/canxer314/obsidian-llm-wiki-cli.git\n", stderr: "" })
      .mockResolvedValueOnce({ stdout: "", stderr: "" });
    const publisher = createFeedbackPublisher({ execute, sourceRepositoryPath: "/source" });

    await expect(publisher.publish({
      checkoutPath: "/checkout",
      branch: "feature/feedback",
      expectedRevision: SHA_A,
    })).resolves.toBe(SHA_B);

    expect(execute).toHaveBeenNthCalledWith(2, "git", ["-C", "/source", "remote", "get-url", "origin"]);
    expect(execute).toHaveBeenNthCalledWith(3, "git", [
      "-C", "/checkout", "push", "https://github.com/canxer314/obsidian-llm-wiki-cli.git",
      `--force-with-lease=refs/heads/feature/feedback:${SHA_A}`,
      "HEAD:refs/heads/feature/feedback",
    ]);
  });

  it("refuses a source remote URL containing credentials", async () => {
    const execute = vi.fn()
      .mockResolvedValueOnce({ stdout: `${SHA_B}\n`, stderr: "" })
      .mockResolvedValueOnce({ stdout: "https://token@example.test/repo.git\n", stderr: "" });
    const publisher = createFeedbackPublisher({ execute, sourceRepositoryPath: "/source" });

    await expect(publisher.publish({
      checkoutPath: "/checkout",
      branch: "feature/feedback",
      expectedRevision: SHA_A,
    })).rejects.toThrow("Feedback publication remote is invalid");
    expect(execute).toHaveBeenCalledTimes(2);
  });
  it("does not push when the agent left HEAD unchanged", async () => {
    const execute = vi.fn().mockResolvedValue({ stdout: `${SHA_A}\n`, stderr: "" });
    const publisher = createFeedbackPublisher({ execute });

    await expect(publisher.publish({
      checkoutPath: "/checkout",
      branch: "feature/feedback",
      expectedRevision: SHA_A,
    })).rejects.toThrow("Feedback implementation did not create a new local revision");
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("propagates a rejected lease without attempting a retry", async () => {
    const execute = vi.fn()
      .mockResolvedValueOnce({ stdout: `${SHA_B}\n`, stderr: "" })
      .mockRejectedValueOnce(new Error("stale info"));
    const publisher = createFeedbackPublisher({ execute });

    await expect(publisher.publish({
      checkoutPath: "/checkout",
      branch: "feature/feedback",
      expectedRevision: SHA_A,
    })).rejects.toThrow("stale info");
    expect(execute).toHaveBeenCalledTimes(2);
  });
});
