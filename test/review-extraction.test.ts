import { describe, expect, it, vi } from "vitest";

import type { CheckoutObserver, CheckoutSnapshot } from "../.sandcastle/checkout-safety.js";
import { StopRetryError, isStopRetry } from "../.sandcastle/invocation-recovery.js";
import {
  REVIEW_FORMATTING_CONTRACT,
  createSameSessionReviewExtractor,
} from "../.sandcastle/review-extraction.js";

const revision = "0123456789abcdef0123456789abcdef01234567";
const producedHead = "b".repeat(40);
const request = {
  pullRequestNumber: 220,
  branch: "feature/review",
  revision,
  checkoutPath: "/safe/disposable-checkout",
  reviewThreads: [{ commentId: "PRRC_1", author: "maintainer", body: "Please fix this." }],
  model: "reviewer-model",
};

const tagged = (value: unknown) => `<review>${JSON.stringify(value)}</review>`;
const cleanReview = { summary: "Reviewed.", inlineComments: [], replies: [] };

function fakeObserver(snapshot?: CheckoutSnapshot) {
  const frozen = snapshot ?? { head: producedHead, entries: [] };
  const observe = vi.fn().mockResolvedValue(frozen);
  const requireClean = vi.fn().mockResolvedValue(frozen);
  const requireUnchanged = vi.fn().mockResolvedValue(frozen);
  const observer = { observe, requireClean, requireUnchanged } as CheckoutObserver;
  return { observer, observe, requireClean, requireUnchanged, frozen };
}

function harness(
  runAgent: ReturnType<typeof vi.fn>,
  overrides: Record<string, unknown> = {},
) {
  const fakes = fakeObserver(overrides.snapshot as CheckoutSnapshot | undefined);
  const wait = vi.fn(async () => {});
  const createAgent = vi.fn().mockReturnValue({ name: "fake-reviewer" });
  const extractor = createSameSessionReviewExtractor({
    sandbox: { kind: "fake-sandbox" } as never,
    hooks: { sandbox: { onSandboxReady: [] } },
    observer: fakes.observer,
    wait,
    runAgent: runAgent as never,
    createAgent: createAgent as never,
    ...overrides,
  });
  return { extractor, wait, createAgent, ...fakes };
}

describe("same-session review extraction", () => {
  it("produces through the bounded window, then formats through the frozen produce session as an immutable stage", async () => {
    const resume = vi.fn().mockResolvedValue({ commits: [], stdout: tagged(cleanReview) });
    const runAgent = vi.fn().mockResolvedValue({ commits: [{ sha: producedHead }], resume });
    const { extractor, observe, requireClean, requireUnchanged } = harness(runAgent);

    await expect(extractor.review(request)).resolves.toEqual(cleanReview);

    // Produce: one bounded invocation against the prepared Target Checkout.
    expect(runAgent).toHaveBeenCalledOnce();
    const produceRequest = runAgent.mock.calls[0]![0];
    expect(produceRequest).toEqual(expect.objectContaining({
      cwd: request.checkoutPath,
      maxIterations: 1,
      branchStrategy: { type: "head" },
    }));
    expect(produceRequest.prompt).toContain(`Pull Request #220 on branch ${request.branch}`);
    expect(produceRequest.prompt).toContain(`exact revision ${revision}`);
    expect(produceRequest.prompt).toContain("PRRC_1");
    expect(produceRequest.prompt).toContain("commit every intended improvement");
    expect(produceRequest).not.toHaveProperty("output");
    expect(observe).toHaveBeenCalledOnce();

    // Formatting baseline: requireClean at the frozen post-produce HEAD, then
    // the driver's own clean proof and unchanged proof around the resume.
    expect(requireClean).toHaveBeenCalledTimes(2);
    // Formatting resumes the produce session with the no-mutation contract;
    // no run call carries an output definition.
    expect(resume).toHaveBeenCalledOnce();
    const [formatPrompt, formatOptions] = resume.mock.calls[0]!;
    expect(formatPrompt).toContain("<review>");
    expect(formatPrompt).toContain(REVIEW_FORMATTING_CONTRACT);
    expect(formatOptions).toEqual({ signal: expect.any(AbortSignal) });
    expect(requireUnchanged).toHaveBeenCalledOnce();
    // Two Agent executions total: one produce, one formatting.
    expect(runAgent.mock.calls.length + resume.mock.calls.length).toBe(2);
  });

  it("writes the complete reviewer output to the job artifact directory", async () => {
    const resume = vi.fn().mockResolvedValue({ commits: [], stdout: tagged(cleanReview) });
    const runAgent = vi.fn().mockResolvedValue({ commits: [], resume });
    const { extractor } = harness(runAgent);

    await extractor.review({ ...request, artifactDirectory: "/jobs/review-artifacts/pr-220" });

    expect(runAgent).toHaveBeenCalledWith(expect.objectContaining({
      logging: { type: "file", path: "/jobs/review-artifacts/pr-220/review.log", verbose: true },
    }));
    expect(resume).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      logging: { type: "file", path: "/jobs/review-artifacts/pr-220/review.log", verbose: true },
    }));
  });

  it("recovers a well-formed earlier <review> block when the last closed block is malformed, with no re-emit", async () => {
    const review = { summary: "Recovered from the earlier block.", inlineComments: [], replies: [] };
    const stdout = [tagged(review), "<review>not JSON at all</review>"].join("\n");
    const resume = vi.fn().mockResolvedValue({
      commits: [],
      iterations: [{ sessionId: "review-session-1" }],
      stdout,
    });
    const runAgent = vi.fn().mockResolvedValue({
      commits: [],
      iterations: [{ sessionId: "review-session-1" }],
      resume,
    });
    const { extractor } = harness(runAgent);

    await expect(extractor.review(request)).resolves.toEqual(review);

    // Recovery consumed no retry: one produce invocation and one formatting
    // invocation, no same-session re-emit, no further commits.
    expect(runAgent).toHaveBeenCalledOnce();
    expect(resume).toHaveBeenCalledOnce();
  });

  it("recovers formatting through a bounded structured attempt whose correction prompt repeats the no-mutation contract", async () => {
    const correctionResume = vi.fn().mockResolvedValue({ commits: [], stdout: tagged(cleanReview) });
    const produceResume = vi.fn().mockResolvedValue({
      commits: [],
      iterations: [{ sessionId: "review-session-2" }],
      stdout: "<review>{oops</review>",
      resume: correctionResume,
    });
    const runAgent = vi.fn().mockResolvedValue({ commits: [], resume: produceResume });
    const { extractor, requireUnchanged, wait } = harness(runAgent);

    await expect(extractor.review(request)).resolves.toEqual(cleanReview);

    expect(produceResume).toHaveBeenCalledOnce();
    expect(correctionResume).toHaveBeenCalledOnce();
    // A parse handoff never spends an invocation attempt: no backoff wait.
    expect(wait).not.toHaveBeenCalled();
    const [correctionPrompt] = correctionResume.mock.calls[0]!;
    expect(correctionPrompt).toContain("did not contain valid JSON");
    expect(correctionPrompt).toContain("structured attempt 2 of 3");
    expect(correctionPrompt).toContain(REVIEW_FORMATTING_CONTRACT);
    expect(correctionPrompt).not.toContain("{oops");
    // The unchanged proof ran after both formatting invocations.
    expect(requireUnchanged).toHaveBeenCalledTimes(2);
  });

  it("rejects malformed structured output after the bounded structured attempts", async () => {
    const resume = vi.fn().mockResolvedValue({ commits: [], stdout: "<review>{oops</review>" });
    const runAgent = vi.fn().mockResolvedValue({ commits: [], resume });
    const { extractor } = harness(runAgent);

    const failure = await extractor.review(request).catch((error: unknown) => error);

    expect((failure as Error).message).toContain("could not be parsed after 3 attempts");
    expect((failure as Error).message).not.toContain("{oops");
    expect(runAgent).toHaveBeenCalledOnce();
    // Three structured attempts, each resuming the retained produce
    // checkpoint (invalid completions carried no fresh checkpoint).
    expect(resume).toHaveBeenCalledTimes(3);
  });

  it("retries a produce attempt that leaves the session identity unavailable, then fails closed after three attempts", async () => {
    const runAgent = vi.fn().mockResolvedValue({ commits: [] });
    const { extractor, requireClean, wait } = harness(runAgent);

    await expect(extractor.review(request)).rejects.toThrow("Reviewer session identity is unavailable");
    expect(runAgent).toHaveBeenCalledTimes(3);
    expect(wait).toHaveBeenCalledTimes(2);
    // Formatting never started: no baseline proof and no resume call.
    expect(requireClean).not.toHaveBeenCalled();
  });

  it("stops before any formatting Agent call when the baseline drifts from the frozen post-produce HEAD", async () => {
    const resume = vi.fn();
    const runAgent = vi.fn().mockResolvedValue({ commits: [], resume });
    const drifted = { head: "c".repeat(40), entries: [] };
    const observe = vi.fn().mockResolvedValue({ head: producedHead, entries: [] });
    const requireClean = vi.fn().mockResolvedValue(drifted);
    const observer = { observe, requireClean, requireUnchanged: vi.fn() } as unknown as CheckoutObserver;
    const extractor = createSameSessionReviewExtractor({
      sandbox: { kind: "fake-sandbox" } as never,
      hooks: { sandbox: { onSandboxReady: [] } },
      observer,
      wait: vi.fn(async () => {}),
      runAgent: runAgent as never,
      createAgent: vi.fn().mockReturnValue({ name: "fake-reviewer" }) as never,
    });

    const failure = await extractor.review(request).catch((error: unknown) => error);

    expect(isStopRetry(failure)).toBe(true);
    expect((failure as Error).message).toContain("frozen post-produce HEAD");
    expect(resume).not.toHaveBeenCalled();
  });

  it("stops recovery immediately when a formatting invocation mutates HEAD or the checkout", async () => {
    const resume = vi.fn().mockResolvedValue({ commits: [], stdout: tagged(cleanReview) });
    const runAgent = vi.fn().mockResolvedValue({ commits: [], resume });
    const { extractor, requireUnchanged, wait } = harness(runAgent);
    requireUnchanged.mockRejectedValueOnce(
      new StopRetryError("Target Checkout changed during a read-only stage"),
    );

    const failure = await extractor.review(request).catch((error: unknown) => error);

    expect(isStopRetry(failure)).toBe(true);
    expect(runAgent).toHaveBeenCalledOnce();
    expect(resume).toHaveBeenCalledOnce();
    expect(wait).not.toHaveBeenCalled();
  });

  it("stays within the normative twelve Agent executions before surfacing exhaustion", async () => {
    // Produce: two rejections, then a clean success (3 executions).
    // Formatting: every structured attempt rejects twice, then completes
    // with an invalid payload that carries no fresh checkpoint (9 executions).
    const resume = vi.fn();
    const runAgent = vi.fn()
      .mockRejectedValueOnce(new Error("gateway unavailable"))
      .mockRejectedValueOnce(new Error("gateway unavailable"))
      .mockResolvedValueOnce({ commits: [], resume });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      resume
        .mockRejectedValueOnce(new Error("gateway unavailable"))
        .mockRejectedValueOnce(new Error("gateway unavailable"))
        .mockResolvedValueOnce({ commits: [], stdout: "<review>{broken</review>" });
    }
    const { extractor, wait } = harness(runAgent);

    const failure = await extractor.review(request).catch((error: unknown) => error);

    const executions = runAgent.mock.calls.length + resume.mock.calls.length;
    expect(executions).toBe(12);
    expect(runAgent).toHaveBeenCalledTimes(3);
    expect(resume).toHaveBeenCalledTimes(9);
    expect(wait).toHaveBeenCalledTimes(8);
    expect((failure as Error).message).toContain("could not be parsed after 3 attempts");
  });

  it("aborts the running reviewer when its deadline expires", async () => {
    let signal: AbortSignal | undefined;
    const extractor = createSameSessionReviewExtractor({
      sandbox: { kind: "fake-sandbox" } as never,
      hooks: { sandbox: { onSandboxReady: [] } },
      observer: fakeObserver().observer,
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
