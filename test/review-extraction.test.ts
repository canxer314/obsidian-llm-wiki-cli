import { describe, expect, it, vi } from "vitest";

import { createSameSessionReviewExtractor } from "../.sandcastle/review-extraction.js";

const revision = "0123456789abcdef0123456789abcdef01234567";
const request = {
  pullRequestNumber: 220,
  branch: "feature/review",
  revision,
  checkoutPath: "/safe/disposable-checkout",
  reviewThreads: [{ commentId: "PRRC_1", author: "maintainer", body: "Please fix this." }],
  model: "reviewer-model",
};

describe("same-session review extraction", () => {
  it("uses the prepared Target Checkout directly so reviewer commits remain available to the publisher", async () => {
    const review = { summary: "Improved the branch.", inlineComments: [], replies: [] };
    const extraction = vi.fn().mockResolvedValue({ commits: [{}], stdout: `<review>${JSON.stringify(review)}</review>` });
    const runAgent = vi.fn().mockResolvedValue({ commits: [{}], resume: extraction });
    const extractor = createSameSessionReviewExtractor({
      sandbox: { kind: "fake-sandbox" } as never,
      hooks: { sandbox: { onSandboxReady: [] } },
      runAgent: runAgent as never,
      createAgent: vi.fn().mockReturnValue({ name: "fake-reviewer" }) as never,
    });

    await expect(extractor.review(request)).resolves.toEqual({ summary: "Improved the branch.", inlineComments: [], replies: [] });

    expect(runAgent).toHaveBeenCalledWith(expect.objectContaining({
      cwd: request.checkoutPath,
      maxIterations: 1,
      branchStrategy: { type: "head" },
    }));
    const produceRequest = runAgent.mock.calls[0]![0];
    expect(produceRequest.prompt).toContain(`Pull Request #220 on branch ${request.branch}`);
    expect(produceRequest.prompt).toContain(`exact revision ${revision}`);
    expect(produceRequest.prompt).toContain("PRRC_1");
    expect(produceRequest.prompt).toContain("commit every intended improvement");
    expect(produceRequest).not.toHaveProperty("output");
    expect(extraction).toHaveBeenCalledWith(expect.stringContaining("<review>"), {
      signal: expect.any(AbortSignal),
    });
    expect(extraction.mock.calls[0]![1]).not.toHaveProperty("output");
  });

  it("writes the complete reviewer output to the job artifact directory", async () => {
    const review = { summary: "Clean.", inlineComments: [], replies: [] };
    const extraction = vi.fn().mockResolvedValue({ commits: [], stdout: `<review>${JSON.stringify(review)}</review>` });
    const runAgent = vi.fn().mockResolvedValue({ commits: [], resume: extraction });
    const extractor = createSameSessionReviewExtractor({
      sandbox: { kind: "fake-sandbox" } as never,
      hooks: { sandbox: { onSandboxReady: [] } },
      runAgent: runAgent as never,
      createAgent: vi.fn().mockReturnValue({ name: "fake-reviewer" }) as never,
    });

    await extractor.review({ ...request, artifactDirectory: "/jobs/review-artifacts/pr-220" });

    expect(runAgent).toHaveBeenCalledWith(expect.objectContaining({
      logging: { type: "file", path: "/jobs/review-artifacts/pr-220/review.log", verbose: true },
    }));
    expect(extraction).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      logging: { type: "file", path: "/jobs/review-artifacts/pr-220/review.log", verbose: true },
    }));
  });

  it("recovers a well-formed earlier <review> block when the last closed block is malformed, with no re-emit and no commits", async () => {
    const review = { summary: "Recovered from the earlier block.", inlineComments: [], replies: [] };
    const stdout = [
      `<review>${JSON.stringify(review)}</review>`,
      "<review>not JSON at all</review>",
    ].join("\n");
    const extraction = vi.fn().mockResolvedValue({
      commits: [],
      iterations: [{ sessionId: "review-session-1" }],
      stdout,
    });
    const runAgent = vi.fn().mockResolvedValue({
      commits: [],
      iterations: [{ sessionId: "review-session-1" }],
      resume: extraction,
    });
    const extractor = createSameSessionReviewExtractor({
      sandbox: { kind: "fake-sandbox" } as never,
      hooks: { sandbox: { onSandboxReady: [] } },
      runAgent: runAgent as never,
      createAgent: vi.fn().mockReturnValue({ name: "fake-reviewer" }) as never,
    });

    await expect(extractor.review(request)).resolves.toEqual(review);

    // Recovery consumed no retry: the produce pass ran once and no
    // same-session re-emit (and therefore no further commits, push, publish,
    // or reply work) was requested.
    expect(runAgent).toHaveBeenCalledTimes(1);
    expect(extraction).toHaveBeenCalledTimes(1);
  });

  it("rejects malformed structured output after bounded same-session extraction retries", async () => {
    const extraction = vi.fn().mockRejectedValue(new Error("structured output failed"));
    const runAgent = vi.fn().mockResolvedValue({ commits: [], resume: extraction });
    const extractor = createSameSessionReviewExtractor({
      sandbox: { kind: "fake-sandbox" } as never,
      hooks: { sandbox: { onSandboxReady: [] } },
      runAgent: runAgent as never,
      createAgent: vi.fn().mockReturnValue({ name: "fake-reviewer" }) as never,
    });

    await expect(extractor.review(request)).rejects.toThrow("structured output failed");
    expect(runAgent).toHaveBeenCalledTimes(1);
    expect(extraction).toHaveBeenCalledTimes(1);
    expect(extraction.mock.calls[0]![1]).not.toHaveProperty("output");
  });

  it("fails closed when the production pass provides no session identity", async () => {
    const runAgent = vi.fn().mockResolvedValue({ commits: [] });
    const extractor = createSameSessionReviewExtractor({
      sandbox: { kind: "fake-sandbox" } as never,
      hooks: { sandbox: { onSandboxReady: [] } },
      runAgent: runAgent as never,
      createAgent: vi.fn().mockReturnValue({ name: "fake-reviewer" }) as never,
    });

    await expect(extractor.review(request)).rejects.toThrow("Reviewer session identity is unavailable");
    expect(runAgent).toHaveBeenCalledTimes(1);
  });

  it("does not retry a generic reviewer execution failure", async () => {
    const runAgent = vi.fn().mockRejectedValue(new Error("reviewer execution failed"));
    const extractor = createSameSessionReviewExtractor({
      sandbox: { kind: "fake-sandbox" } as never,
      hooks: { sandbox: { onSandboxReady: [] } },
      runAgent: runAgent as never,
      createAgent: vi.fn().mockReturnValue({ name: "fake-reviewer" }) as never,
    });

    await expect(extractor.review(request)).rejects.toThrow("reviewer execution failed");
    expect(runAgent).toHaveBeenCalledTimes(1);
  });

  it("aborts the running reviewer when its deadline expires", async () => {
    let signal: AbortSignal | undefined;
    const extractor = createSameSessionReviewExtractor({
      sandbox: { kind: "fake-sandbox" } as never,
      hooks: { sandbox: { onSandboxReady: [] } },
      timeoutMilliseconds: 0,
      runAgent: vi.fn(({ signal: receivedSignal }) => new Promise((_resolve, reject) => {
        signal = receivedSignal;
        receivedSignal.addEventListener("abort", () => reject(receivedSignal.reason));
      })) as never,
      createAgent: vi.fn().mockReturnValue({ name: "fake-reviewer" }) as never,
    });

    await expect(extractor.review(request)).rejects.toThrow("Reviewer execution timed out");
    expect(signal?.aborted).toBe(true);
  });
});
