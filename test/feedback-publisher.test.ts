import { describe, expect, it, vi } from "vitest";

import { createFeedbackPublisher } from "../.sandcastle/feedback-publisher.js";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const REMOTE = "https://github.com/example/repository.git";

describe("feedback publisher", () => {
  it("starts at the acquired revision and publishes the local commit with an exact lease", async () => {
    const execute = vi.fn()
      .mockResolvedValueOnce({ stdout: "", stderr: "" })
      .mockResolvedValueOnce({ stdout: `${SHA_A}\n`, stderr: "" })
      .mockResolvedValueOnce({ stdout: `${SHA_B}\n`, stderr: "" })
      .mockResolvedValueOnce({ stdout: `${REMOTE}\n`, stderr: "" })
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
      "-C", "/checkout", "remote", "get-url", "origin",
    ]);
    expect(execute).toHaveBeenNthCalledWith(5, "git", [
      "-C", "/checkout", "push", REMOTE,
      `--force-with-lease=refs/heads/feature/feedback:${SHA_A}`,
      "HEAD:refs/heads/feature/feedback",
    ]);
  });

  it.each([
    {
      name: "malformed acquired revision",
      branch: "feature/feedback",
      revision: "not-a-full-revision",
      diagnostic: "Feedback publication requires a full expected revision",
    },
    {
      name: "invalid branch",
      branch: "-unsafe",
      revision: SHA_A,
      diagnostic: "Feedback publication branch is invalid",
    },
  ])("rejects $name before preparing the checkout", async ({ branch, revision, diagnostic }) => {
    const execute = vi.fn();
    const publisher = createFeedbackPublisher({ execute });

    await expect(publisher.prepare("/checkout", branch, revision)).rejects.toThrow(diagnostic);
    expect(execute).not.toHaveBeenCalled();
  });

  it("rejects when the prepared checkout does not resolve to the acquired revision", async () => {
    const execute = vi.fn()
      .mockResolvedValueOnce({ stdout: "", stderr: "" })
      .mockResolvedValueOnce({ stdout: `${SHA_B}\n`, stderr: "" });
    const publisher = createFeedbackPublisher({ execute });

    await expect(publisher.prepare("/checkout", "feature/feedback", SHA_A))
      .rejects.toThrow("Feedback checkout did not start at the acquired revision");
    expect(execute).toHaveBeenNthCalledWith(1, "git", [
      "-C", "/checkout", "checkout", "-B", "feature/feedback", SHA_A,
    ]);
    expect(execute).toHaveBeenNthCalledWith(2, "git", [
      "-C", "/checkout", "rev-parse", "HEAD",
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

  it.each([
    { name: "empty", remote: "\n" },
    { name: "credential-bearing", remote: "https://token@example.test/repo.git\n" },
  ])("refuses an $name source remote before push", async ({ remote }) => {
    const execute = vi.fn()
      .mockResolvedValueOnce({ stdout: `${SHA_B}\n`, stderr: "" })
      .mockResolvedValueOnce({ stdout: remote, stderr: "" });
    const publisher = createFeedbackPublisher({ execute, sourceRepositoryPath: "/source" });

    await expect(publisher.publish({
      checkoutPath: "/checkout",
      branch: "feature/feedback",
      expectedRevision: SHA_A,
    })).rejects.toThrow("Feedback publication remote is invalid");
    expect(execute).toHaveBeenCalledTimes(2);
  });
  it.each([
    {
      name: "malformed expected revision",
      branch: "feature/feedback",
      expectedRevision: "not-a-full-revision",
      head: undefined,
      diagnostic: "Feedback publication requires a full expected revision",
    },
    {
      name: "invalid branch",
      branch: "feature..feedback",
      expectedRevision: SHA_A,
      head: undefined,
      diagnostic: "Feedback publication branch is invalid",
    },
    {
      name: "malformed resulting revision",
      branch: "feature/feedback",
      expectedRevision: SHA_A,
      head: "not-a-full-revision\n",
      diagnostic: "Feedback implementation did not create a full local revision",
    },
  ])("uses the stable feedback diagnostic for $name", async ({
    branch,
    expectedRevision,
    head,
    diagnostic,
  }) => {
    const execute = head === undefined
      ? vi.fn()
      : vi.fn().mockResolvedValueOnce({ stdout: head, stderr: "" });
    const publisher = createFeedbackPublisher({ execute });

    await expect(publisher.publish({
      checkoutPath: "/checkout",
      branch,
      expectedRevision,
    })).rejects.toThrow(diagnostic);
    expect(execute).toHaveBeenCalledTimes(head === undefined ? 0 : 1);
  });

  it("does not resolve a remote when the agent left HEAD unchanged", async () => {
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
      .mockResolvedValueOnce({ stdout: `${REMOTE}\n`, stderr: "" })
      .mockRejectedValueOnce(new Error("stale info"));
    const publisher = createFeedbackPublisher({ execute });

    await expect(publisher.publish({
      checkoutPath: "/checkout",
      branch: "feature/feedback",
      expectedRevision: SHA_A,
    })).rejects.toThrow("stale info");
    expect(execute).toHaveBeenNthCalledWith(3, "git", [
      "-C", "/checkout", "push", REMOTE,
      `--force-with-lease=refs/heads/feature/feedback:${SHA_A}`,
      "HEAD:refs/heads/feature/feedback",
    ]);
    expect(execute).toHaveBeenCalledTimes(3);
  });
});
