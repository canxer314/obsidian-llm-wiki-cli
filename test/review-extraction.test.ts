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
      output: expect.objectContaining({ _tag: "object", tag: "review", maxRetries: 2 }),
    });
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
