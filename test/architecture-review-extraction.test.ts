import { describe, expect, it, vi } from "vitest";

import {
  architectureReviewSchema,
  createSameSessionArchitectureReviewExtractor,
} from "../.sandcastle/architecture-review-extraction.js";

const revision = "0123456789abcdef0123456789abcdef01234567";

const priorProposals = [
  { number: 101, title: "Deepen the vault index", state: "CLOSED", body: "Prior body" },
];

const proposedOutcome = {
  status: "proposed" as const,
  title: "Deepen the search indexer",
  body: "## Architecture review\n\n...",
  oneLineSummary: "One deep module for indexing.",
  candidatesConsidered: ["indexer", "cache"],
};

function createExtractor(runAgent: unknown, options: { readonly timeoutMilliseconds?: number } = {}) {
  return createSameSessionArchitectureReviewExtractor({
    sandbox: { kind: "fake-sandbox" } as never,
    hooks: { sandbox: { onSandboxReady: [] } },
    ...(options.timeoutMilliseconds === undefined
      ? {}
      : { timeoutMilliseconds: options.timeoutMilliseconds }),
    runAgent: runAgent as never,
    createAgent: vi.fn().mockReturnValue({ name: "fake-architecture-reviewer" }) as never,
  });
}

describe("same-session architecture review extraction", () => {
  it("accepts Spec proposals and rejects legacy PRD terminology before publication", () => {
    expect(architectureReviewSchema.safeParse(proposedOutcome).success).toBe(true);
    expect(architectureReviewSchema.safeParse({
      ...proposedOutcome,
      title: "PRD: Deepen the search indexer",
    }).success).toBe(false);
    expect(architectureReviewSchema.safeParse({
      ...proposedOutcome,
      body: "# Architecture review\n\n# PRDs: Deepen the search indexer",
    }).success).toBe(false);
  });

  it("runs one bounded read-only produce pass with the prior proposals, then extracts by resuming that session", async () => {
    const extraction = vi.fn().mockResolvedValue({ commits: [], output: proposedOutcome });
    const runAgent = vi.fn().mockResolvedValue({ commits: [], resume: extraction });
    const extractor = createExtractor(runAgent);

    await expect(extractor.review({
      revision,
      checkoutPath: "/safe/disposable-checkout",
      priorProposals,
      model: "planner-model",
    })).resolves.toEqual(proposedOutcome);

    expect(runAgent).toHaveBeenCalledWith(expect.objectContaining({
      cwd: "/safe/disposable-checkout",
      maxIterations: 1,
    }));
    const produceRequest = runAgent.mock.calls[0]![0];
    expect(produceRequest.prompt).toContain(revision);
    expect(produceRequest.prompt).toContain("Deepen the vault index");
    expect(produceRequest.prompt).toContain(
      "Do not delegate exploration to subagents or launch Agent tasks",
    );
    expect(produceRequest.prompt).toContain(
      "Inspect at most twelve focused files after reading CONTEXT.md and the relevant ADRs",
    );
    expect(produceRequest.prompt).toContain(
      "Stop exploring as soon as you can rank three credible candidates, or skip when the available evidence does not support a fresh proposal",
    );
    expect(produceRequest.prompt).not.toContain("<output>");
    expect(produceRequest.output).toBeUndefined();
    expect(extraction).toHaveBeenCalledWith(expect.stringContaining("<output>"), {
      signal: expect.any(AbortSignal),
      output: expect.objectContaining({ _tag: "object", tag: "output", maxRetries: 2 }),
    });
  });

  it("accepts the upstream-equivalent skipped outcome", async () => {
    const skipped = { status: "skipped" as const, reason: "Every candidate is covered by #101." };
    const extraction = vi.fn().mockResolvedValue({ commits: [], output: skipped });
    const runAgent = vi.fn().mockResolvedValue({ commits: [], resume: extraction });
    const extractor = createExtractor(runAgent);

    await expect(extractor.review({
      revision,
      checkoutPath: "/safe/disposable-checkout",
      priorProposals,
      model: "planner-model",
    })).resolves.toEqual(skipped);
  });

  it("writes the complete reviewer output to the job artifact directory", async () => {
    const extraction = vi.fn().mockResolvedValue({ commits: [], output: proposedOutcome });
    const runAgent = vi.fn().mockResolvedValue({ commits: [], resume: extraction });
    const extractor = createExtractor(runAgent);

    await extractor.review({
      revision,
      checkoutPath: "/safe/disposable-checkout",
      priorProposals,
      model: "planner-model",
      artifactDirectory: "/jobs/review-artifacts/job-228",
    });

    expect(runAgent).toHaveBeenCalledWith(expect.objectContaining({
      logging: { type: "file", path: "/jobs/review-artifacts/job-228/architecture-review.log", verbose: true },
    }));
    expect(extraction).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      logging: { type: "file", path: "/jobs/review-artifacts/job-228/architecture-review.log", verbose: true },
    }));
  });

  it("fails closed when the produce pass creates commits", async () => {
    const runAgent = vi.fn().mockResolvedValue({ commits: [{ sha: revision }], resume: vi.fn() });
    const extractor = createExtractor(runAgent);

    await expect(extractor.review({
      revision,
      checkoutPath: "/safe/disposable-checkout",
      priorProposals,
      model: "planner-model",
    })).rejects.toThrow("Architecture review session must not create commits");
  });

  it("fails closed when the produce pass does not expose a resumable session", async () => {
    const runAgent = vi.fn().mockResolvedValue({ commits: [] });
    const extractor = createExtractor(runAgent);

    await expect(extractor.review({
      revision,
      checkoutPath: "/safe/disposable-checkout",
      priorProposals,
      model: "planner-model",
    })).rejects.toThrow("Architecture review session identity is unavailable");
  });

  it("does not repeat the side-effecting produce pass when bounded extraction retries are exhausted", async () => {
    const extraction = vi.fn().mockRejectedValue(new Error("Structured output extraction failed"));
    const runAgent = vi.fn().mockResolvedValue({ commits: [], resume: extraction });
    const extractor = createExtractor(runAgent);

    await expect(extractor.review({
      revision,
      checkoutPath: "/safe/disposable-checkout",
      priorProposals,
      model: "planner-model",
    })).rejects.toThrow("Structured output extraction failed");
    expect(runAgent).toHaveBeenCalledOnce();
    expect(extraction).toHaveBeenCalledOnce();
  });

  it("aborts the running reviewer when its deadline expires", async () => {
    let signal: AbortSignal | undefined;
    const extractor = createExtractor(
      vi.fn(({ signal: receivedSignal }) => new Promise((_resolve, reject) => {
        signal = receivedSignal;
        receivedSignal.addEventListener("abort", () => reject(receivedSignal.reason));
      })),
      { timeoutMilliseconds: 0 },
    );

    await expect(extractor.review({
      revision,
      checkoutPath: "/safe/disposable-checkout",
      priorProposals,
      model: "planner-model",
    })).rejects.toThrow("Architecture review execution timed out");
    expect(signal?.aborted).toBe(true);
  });
});
