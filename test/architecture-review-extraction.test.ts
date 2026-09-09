import { mkdtempSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { StructuredOutputError } from "@ai-hero/sandcastle";
import { describe, expect, it, vi } from "vitest";

import {
  ARCHITECTURE_REVIEW_READ_ONLY_CONTRACT,
  architectureReviewSchema,
  createSameSessionArchitectureReviewExtractor,
} from "../.sandcastle/architecture-review-extraction.js";
import type { CheckoutObserver } from "../.sandcastle/checkout-safety.js";
import { StopRetryError, isStopRetry } from "../.sandcastle/invocation-recovery.js";
import { createJobLog } from "../.sandcastle/job-logs.js";
import { STRUCTURED_EXTRACTION_ATTEMPTS } from "../.sandcastle/same-session-structured-extraction.js";

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

const skippedOutcome = {
  status: "skipped" as const,
  reason: "Every candidate is covered by #101.",
};

const tagged = (value: unknown) => `<output>${JSON.stringify(value)}</output>`;

// The redacted #44-style regression fixture: a 403 HTML gateway page with
// credential-shaped and URL-shaped secrets that must never reach the Job Log.
const forbiddenHtml = [
  "<html><head><title>403 Forbidden</title></head><body>",
  "<h1>Unable to load site</h1>",
  "<p>Please try again later.</p>",
  `<!-- authorization: Bearer sk-ant-${"a".repeat(30)} token=ghp_${"b".repeat(36)} -->`,
  "<p>gateway: https://proxy.internal.example/v1/messages?key=secret-key</p>",
  "</body></html>",
].join("\n");

const forbiddenSecrets = [
  "Unable to load site",
  "Please try again later",
  "sk-ant-",
  "ghp_",
  "proxy.internal.example",
  "secret-key",
];

function reviewResult(stdout: string, extras: { readonly resume?: unknown } = {}) {
  return {
    stdout,
    commits: [],
    branch: "head-branch",
    iterations: [{ sessionId: "architecture-review-session" }],
    ...(extras.resume === undefined ? {} : { resume: extras.resume }),
  };
}

function fakeObserver() {
  const snapshot = { head: "a".repeat(40), entries: [] };
  const requireClean = vi.fn().mockResolvedValue(snapshot);
  const requireUnchanged = vi.fn().mockResolvedValue(snapshot);
  const observer = {
    observe: vi.fn().mockResolvedValue(snapshot),
    requireClean,
    requireUnchanged,
  } as CheckoutObserver;
  return { observer, requireClean, requireUnchanged };
}

function createExtractor(
  runAgent: ReturnType<typeof vi.fn>,
  overrides: Record<string, unknown> = {},
) {
  const { observer, requireClean, requireUnchanged } = fakeObserver();
  const wait = vi.fn(async () => {});
  const createAgent = vi.fn().mockReturnValue({ name: "fake-architecture-reviewer" });
  const extractor = createSameSessionArchitectureReviewExtractor({
    sandbox: { kind: "fake-sandbox" } as never,
    hooks: { sandbox: { onSandboxReady: [] } },
    checkoutPath: "/safe/disposable-checkout",
    observer,
    wait,
    runAgent: runAgent as never,
    createAgent: createAgent as never,
    ...overrides,
  });
  return { extractor, requireClean, requireUnchanged, wait, createAgent };
}

const request = {
  revision,
  priorProposals,
  model: "planner-model",
};

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

  it("runs one bounded read-only review pass through the repository-owned driver", async () => {
    const runAgent = vi.fn().mockResolvedValue(reviewResult(tagged(proposedOutcome)));
    const { extractor, requireClean, requireUnchanged } = createExtractor(runAgent);

    await expect(extractor.review(request)).resolves.toEqual(proposedOutcome);

    expect(requireClean).toHaveBeenCalledWith("/safe/disposable-checkout");
    expect(runAgent).toHaveBeenCalledOnce();
    expect(runAgent).toHaveBeenCalledWith(expect.objectContaining({
      cwd: "/safe/disposable-checkout",
      branchStrategy: { type: "head" },
      maxIterations: 1,
      signal: expect.any(AbortSignal),
    }));
    const runRequest = runAgent.mock.calls[0]![0];
    // The SDK's recursive output retry is never armed: no run call carries an
    // output definition, so there is nothing for the library to retry.
    expect(runRequest).not.toHaveProperty("output");
    expect(runRequest.prompt).toContain(revision);
    expect(runRequest.prompt).toContain("Deepen the vault index");
    expect(runRequest.prompt).toContain(
      "Do not delegate exploration to subagents or launch Agent tasks",
    );
    expect(runRequest.prompt).toContain(
      "Inspect at most twelve focused files after reading CONTEXT.md and the relevant ADRs",
    );
    expect(runRequest.prompt).toContain(
      "Stop exploring as soon as you can rank three credible candidates, or skip when the available evidence does not support a fresh proposal",
    );
    expect(runRequest.prompt).toContain(ARCHITECTURE_REVIEW_READ_ONLY_CONTRACT);
    expect(runRequest.prompt).toContain(
      "the command publishes an accepted proposal itself",
    );
    expect(runRequest.prompt).toContain("<output>");
    expect(runRequest.prompt).toContain('"status":"skipped"');
    // The read-only contract was proven after the invocation.
    expect(requireUnchanged).toHaveBeenCalledOnce();
  });

  it("accepts the upstream-equivalent skipped outcome", async () => {
    const runAgent = vi.fn().mockResolvedValue(reviewResult(tagged(skippedOutcome)));
    const { extractor } = createExtractor(runAgent);

    await expect(extractor.review(request)).resolves.toEqual(skippedOutcome);
  });

  it("writes the complete reviewer output to the job artifact directory", async () => {
    const runAgent = vi.fn().mockResolvedValue(reviewResult(tagged(proposedOutcome)));
    const { extractor } = createExtractor(runAgent);

    await extractor.review({
      ...request,
      artifactDirectory: "/jobs/review-artifacts/job-228",
    });

    expect(runAgent).toHaveBeenCalledWith(expect.objectContaining({
      logging: { type: "file", path: "/jobs/review-artifacts/job-228/architecture-review.log", verbose: true },
    }));
  });

  it("returns a valid proposal after an invocation interruption recovered inside the bounded window", async () => {
    const root = mkdtempSync(join(tmpdir(), "architecture-review-log-"));
    const log = await createJobLog({
      root,
      jobId: "job-228",
      operation: "architecture-review",
      revision,
    });
    const runAgent = vi.fn()
      .mockRejectedValueOnce(new Error(forbiddenHtml))
      .mockResolvedValueOnce(reviewResult(tagged(proposedOutcome)));
    const { extractor, requireUnchanged, wait } = createExtractor(runAgent, { log });

    await expect(extractor.review(request)).resolves.toEqual(proposedOutcome);

    // The interruption consumed no structured attempt: both invocations ran
    // the same complete review prompt inside one recovery window, and neither
    // carried an output definition.
    expect(runAgent).toHaveBeenCalledTimes(2);
    expect(runAgent.mock.calls[0]![0].prompt).toBe(runAgent.mock.calls[1]![0].prompt);
    expect(runAgent.mock.calls[1]![0]).not.toHaveProperty("output");
    expect(requireUnchanged).toHaveBeenCalledTimes(2);
    expect(wait).toHaveBeenCalledWith(2_000, expect.any(AbortSignal));

    // Only sanitized attempt metadata reached the append-only Job Log.
    const stderr = await readFile(log.stderrPath, "utf8");
    expect(stderr).toContain("[invocation-recovery]");
    expect(stderr).toContain("\"role\":\"architecture-reviewer\"");
    expect(stderr).toContain("\"attempt\":1");
    expect(stderr).toContain("\"nextAttempt\":2");
    for (const secret of forbiddenSecrets) {
      expect(stderr).not.toContain(secret);
    }
  });

  it("returns an explicit skip after an interruption and a structured correction that repeats the read-only contract", async () => {
    const resume = vi.fn().mockResolvedValue(reviewResult(tagged(skippedOutcome)));
    const runAgent = vi.fn()
      .mockRejectedValueOnce(new Error("gateway unavailable"))
      .mockResolvedValueOnce(reviewResult("<output>{not valid</output>", { resume }));
    const { extractor } = createExtractor(runAgent);

    await expect(extractor.review(request)).resolves.toEqual(skippedOutcome);

    expect(runAgent).toHaveBeenCalledTimes(2);
    expect(resume).toHaveBeenCalledOnce();
    const [correctionPrompt, resumeOptions] = resume.mock.calls[0]!;
    expect(correctionPrompt).toContain("the <output> block did not contain valid JSON");
    expect(correctionPrompt).toContain(
      `structured attempt 2 of ${STRUCTURED_EXTRACTION_ATTEMPTS}`,
    );
    expect(correctionPrompt).toContain(ARCHITECTURE_REVIEW_READ_ONLY_CONTRACT);
    // The correction prompt never embeds the raw invocation error, raw
    // provider errors, or matched output.
    expect(correctionPrompt).not.toContain("gateway unavailable");
    expect(correctionPrompt).not.toContain("{not valid");
    expect(resumeOptions).not.toHaveProperty("output");
  });

  it("falls back to a fresh complete prompt when an invalid response carries no resume checkpoint", async () => {
    const runAgent = vi.fn()
      .mockResolvedValueOnce(reviewResult("<output>not JSON</output>"))
      .mockResolvedValueOnce(reviewResult(tagged(proposedOutcome)));
    const { extractor, wait } = createExtractor(runAgent);

    await expect(extractor.review(request)).resolves.toEqual(proposedOutcome);

    // Deterministic checkpoint fallback: with no resumable checkpoint the
    // next structured attempt restarts from the complete initial prompt.
    expect(runAgent).toHaveBeenCalledTimes(2);
    expect(runAgent.mock.calls[0]![0].prompt).toBe(runAgent.mock.calls[1]![0].prompt);
    expect(wait).not.toHaveBeenCalled();
  });

  it("recovers a well-formed earlier <output> block when the last closed block is malformed", async () => {
    const stdout = [
      tagged(proposedOutcome),
      "trailing narration",
      "<output>not JSON at all</output>",
    ].join("\n");
    const runAgent = vi.fn().mockResolvedValue(reviewResult(stdout));
    const { extractor } = createExtractor(runAgent);

    await expect(extractor.review(request)).resolves.toEqual(proposedOutcome);

    // Recovery consumed no retry: the multi-block candidate scan accepted the
    // well-formed earlier block with a single invocation.
    expect(runAgent).toHaveBeenCalledOnce();
  });

  it("surfaces the bounded exhaustion diagnostic after three completed invalid outputs", async () => {
    const runAgent = vi.fn().mockResolvedValue(reviewResult("<output>not JSON</output>"));
    const { extractor } = createExtractor(runAgent);

    const failure = await extractor.review(request).catch((error: unknown) => error);

    expect(runAgent).toHaveBeenCalledTimes(STRUCTURED_EXTRACTION_ATTEMPTS);
    expect(failure).toBeInstanceOf(StructuredOutputError);
    const classified = failure as StructuredOutputError;
    expect(classified.tag).toBe("output");
    expect(classified.message).toContain(
      `Structured output tag <output> could not be parsed after ${STRUCTURED_EXTRACTION_ATTEMPTS} attempts`,
    );
    expect(classified.message).not.toContain("not JSON");
    expect(classified.rawMatched).toBeUndefined();
  });

  it("aborts the running reviewer when its deadline expires, without spending invocation retries", async () => {
    let signal: AbortSignal | undefined;
    const runAgent = vi.fn(({ signal: receivedSignal }) => new Promise((_resolve, reject) => {
      signal = receivedSignal;
      receivedSignal.addEventListener("abort", () => reject(receivedSignal.reason));
    }));
    const { extractor } = createExtractor(runAgent as never, { timeoutMilliseconds: 0 });

    await expect(extractor.review(request)).rejects.toThrow("Architecture review execution timed out");

    // Cancellation is not an invocation failure: the aborted run received no
    // bounded retry and the timeout error propagated unchanged.
    expect(runAgent).toHaveBeenCalledOnce();
    expect(signal?.aborted).toBe(true);
  });

  it("stops immediately, without another Agent call, when the checkout changed during the review", async () => {
    const runAgent = vi.fn().mockResolvedValue(reviewResult(tagged(proposedOutcome)));
    const { extractor, requireUnchanged, wait } = createExtractor(runAgent);
    requireUnchanged.mockRejectedValueOnce(
      new StopRetryError("Target Checkout changed during a read-only stage"),
    );

    const failure = await extractor.review(request).catch((error: unknown) => error);

    // Fail-closed: no automatic reset and no later Agent attempt.
    expect(isStopRetry(failure)).toBe(true);
    expect(runAgent).toHaveBeenCalledOnce();
    expect(wait).not.toHaveBeenCalled();
  });

  it("requires a clean Target Checkout before any Agent call", async () => {
    const runAgent = vi.fn();
    const { extractor, requireClean } = createExtractor(runAgent);
    requireClean.mockRejectedValueOnce(
      new StopRetryError("Target Checkout is not clean (staged=0, unstaged=0, unmerged=0, untracked=2)"),
    );

    const failure = await extractor.review(request).catch((error: unknown) => error);

    expect(isStopRetry(failure)).toBe(true);
    expect(runAgent).not.toHaveBeenCalled();
  });
});
