import { describe, expect, it, vi } from "vitest";

import { createSameSessionReviewExtractor } from "../.sandcastle/review-extraction.js";

const revision = "0123456789abcdef0123456789abcdef01234567";

describe("same-session review extraction", () => {
  it("runs one unconstrained review pass then extracts structured output by resuming that session", async () => {
    const extraction = vi.fn().mockResolvedValue({
      commits: [],
      output: { verdict: "Approved", summary: "Looks good.", findings: [] },
    });
    const runAgent = vi.fn().mockResolvedValue({
      commits: [],
      resume: extraction,
    });
    const extractor = createSameSessionReviewExtractor({
      sandbox: { kind: "fake-sandbox" } as never,
      hooks: { sandbox: { onSandboxReady: [] } },
      runAgent: runAgent as never,
      createAgent: vi.fn().mockReturnValue({ name: "fake-reviewer" }) as never,
    });

    await expect(extractor.review({
      pullRequestNumber: 220,
      revision,
      checkoutPath: "/safe/disposable-checkout",
      model: "reviewer-model",
    })).resolves.toEqual({
      verdict: "Approved",
      summary: "Looks good.",
      findings: [],
    });

    expect(runAgent).toHaveBeenCalledWith(expect.objectContaining({
      cwd: "/safe/disposable-checkout",
      maxIterations: 1,
    }));
    const produceRequest = runAgent.mock.calls[0]![0];
    expect(produceRequest.prompt).toContain(`Pull Request #220 at exact revision ${revision}`);
    expect(produceRequest.prompt).not.toContain("<review>");
    expect(extraction).toHaveBeenCalledWith(expect.stringContaining("<review>"), {
      signal: expect.any(AbortSignal),
      output: expect.objectContaining({ _tag: "object", tag: "review", maxRetries: 2 }),
    });
  });

  it("writes the complete reviewer output to the job artifact directory", async () => {
    const extraction = vi.fn().mockResolvedValue({
      commits: [], output: { verdict: "Approved", summary: "Looks good.", findings: [] },
    });
    const runAgent = vi.fn().mockResolvedValue({ commits: [], resume: extraction });
    const extractor = createSameSessionReviewExtractor({
      sandbox: { kind: "fake-sandbox" } as never,
      hooks: { sandbox: { onSandboxReady: [] } },
      runAgent: runAgent as never,
      createAgent: vi.fn().mockReturnValue({ name: "fake-reviewer" }) as never,
    });

    await extractor.review({
      pullRequestNumber: 220,
      revision,
      checkoutPath: "/safe/disposable-checkout",
      model: "reviewer-model",
      artifactDirectory: "/jobs/review-artifacts/pr-220",
    });

    expect(runAgent).toHaveBeenCalledWith(expect.objectContaining({
      logging: { type: "file", path: "/jobs/review-artifacts/pr-220/review.log", verbose: true },
    }));
    expect(extraction).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      logging: { type: "file", path: "/jobs/review-artifacts/pr-220/review.log", verbose: true },
    }));
  });

  it("keeps valid repository-relative inline locations", async () => {
    const extraction = vi.fn().mockResolvedValue({
      commits: [],
      output: {
        verdict: "Changes requested",
        summary: "A defect was found.",
        findings: [{
          summary: "Incorrect boundary",
          details: "The condition excludes the final record.",
          location: { path: ".sandcastle/review-automation.ts", line: 96, side: "RIGHT" },
        }],
      },
    });
    const extractor = createSameSessionReviewExtractor({
      sandbox: { kind: "fake-sandbox" } as never,
      hooks: { sandbox: { onSandboxReady: [] } },
      runAgent: vi.fn().mockResolvedValue({ commits: [], resume: extraction }) as never,
      createAgent: vi.fn().mockReturnValue({ name: "fake-reviewer" }) as never,
    });

    await expect(extractor.review({
      pullRequestNumber: 220,
      revision,
      checkoutPath: "/safe/disposable-checkout",
      model: "reviewer-model",
    })).resolves.toMatchObject({
      findings: [{ location: { path: ".sandcastle/review-automation.ts", line: 96, side: "RIGHT" } }],
    });
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

    await expect(extractor.review({
      pullRequestNumber: 220,
      revision,
      checkoutPath: "/safe/disposable-checkout",
      model: "reviewer-model",
    })).rejects.toThrow("Reviewer execution timed out");
    expect(signal?.aborted).toBe(true);
  });

  it("fails closed when the produce pass does not expose a resumable session", async () => {
    const extractor = createSameSessionReviewExtractor({
      sandbox: { kind: "fake-sandbox" } as never,
      hooks: { sandbox: { onSandboxReady: [] } },
      runAgent: vi.fn().mockResolvedValue({ commits: [] }) as never,
      createAgent: vi.fn().mockReturnValue({ name: "fake-reviewer" }) as never,
    });

    await expect(extractor.review({
      pullRequestNumber: 220,
      revision,
      checkoutPath: "/safe/disposable-checkout",
      model: "reviewer-model",
    })).rejects.toThrow("Reviewer session identity is unavailable");
  });
});
