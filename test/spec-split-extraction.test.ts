import { mkdtempSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { StructuredOutputError } from "@ai-hero/sandcastle";
import { describe, expect, it, vi } from "vitest";

import type { CheckoutObserver } from "../.sandcastle/checkout-safety.js";
import { StopRetryError, isStopRetry } from "../.sandcastle/invocation-recovery.js";
import { createJobLog } from "../.sandcastle/job-logs.js";
import { STRUCTURED_EXTRACTION_ATTEMPTS } from "../.sandcastle/same-session-structured-extraction.js";
import {
  SPEC_SPLITTER_READ_ONLY_CONTRACT,
  createSameSessionSpecSplitExtractor,
} from "../.sandcastle/spec-split-extraction.js";

const slices = [
  { title: "Create slice", whatToBuild: "Deliver a complete path.", acceptanceCriteria: ["It works"] },
];

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

function splitResult(stdout: string, extras: { readonly resume?: unknown } = {}) {
  return {
    stdout,
    commits: [],
    branch: "head-branch",
    iterations: [{ sessionId: "spec-split-session" }],
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

function createSplitter(
  runAgent: ReturnType<typeof vi.fn>,
  overrides: Record<string, unknown> = {},
) {
  const { observer, requireClean, requireUnchanged } = fakeObserver();
  const wait = vi.fn(async () => {});
  const createAgent = vi.fn().mockReturnValue({ name: "fake-splitter" });
  const splitter = createSameSessionSpecSplitExtractor({
    sandbox: { kind: "fake-sandbox" } as never,
    hooks: { sandbox: { onSandboxReady: [] } },
    checkoutPath: "/safe/disposable-checkout",
    observer,
    wait,
    runAgent: runAgent as never,
    createAgent: createAgent as never,
    ...overrides,
  });
  return { splitter, requireClean, requireUnchanged, wait, createAgent };
}

const request = {
  specNumber: 223,
  title: "Split a Spec",
  model: "splitter-model",
};

describe("same-session Spec split extraction", () => {
  it("produces slices in one clean read-only pass through the repository-owned driver", async () => {
    const runAgent = vi.fn().mockResolvedValue(splitResult(tagged({ slices })));
    const { splitter, requireClean, requireUnchanged, createAgent } = createSplitter(runAgent);

    await expect(splitter.split(request)).resolves.toEqual(slices);

    expect(requireClean).toHaveBeenCalledWith("/safe/disposable-checkout");
    expect(runAgent).toHaveBeenCalledOnce();
    expect(runAgent).toHaveBeenCalledWith(expect.objectContaining({
      cwd: "/safe/disposable-checkout",
      branchStrategy: { type: "head" },
      maxIterations: 1,
      name: "spec-split-223",
    }));
    const runRequest = runAgent.mock.calls[0]![0];
    // The SDK's recursive output retry is never armed: no run call carries an
    // output definition, so there is nothing for the library to retry.
    expect(runRequest).not.toHaveProperty("output");
    expect(createAgent).toHaveBeenCalledWith("splitter-model");
    expect(runRequest.prompt).toContain("gh issue view 223 --comments");
    expect(runRequest.prompt).toContain("tracer-bullet vertical slice");
    expect(runRequest.prompt).toContain(SPEC_SPLITTER_READ_ONLY_CONTRACT);
    expect(runRequest.prompt).toContain("<output>");
    expect(runRequest.prompt).toContain("non-empty slices array");
    // The read-only contract was proven after the invocation.
    expect(requireUnchanged).toHaveBeenCalledOnce();
  });

  it("returns valid slices after an invocation interruption recovered inside the bounded window", async () => {
    const root = mkdtempSync(join(tmpdir(), "spec-split-log-"));
    const log = await createJobLog({
      root,
      jobId: "job-223",
      operation: "spec-split",
      revision: "d".repeat(40),
    });
    const runAgent = vi.fn()
      .mockRejectedValueOnce(new Error(forbiddenHtml))
      .mockResolvedValueOnce(splitResult(tagged({ slices })));
    const { splitter, requireUnchanged, wait } = createSplitter(runAgent, { log });

    await expect(splitter.split(request)).resolves.toEqual(slices);

    // The interruption consumed no structured attempt: both invocations ran
    // the same complete split prompt inside one recovery window.
    expect(runAgent).toHaveBeenCalledTimes(2);
    expect(runAgent.mock.calls[0]![0].prompt).toBe(runAgent.mock.calls[1]![0].prompt);
    expect(runAgent.mock.calls[1]![0]).not.toHaveProperty("output");
    // The unchanged checkout was proven after the rejected invocation too.
    expect(requireUnchanged).toHaveBeenCalledTimes(2);
    expect(wait).toHaveBeenCalledWith(2_000, undefined);

    // Only sanitized attempt metadata reached the append-only Job Log.
    const stderr = await readFile(log.stderrPath, "utf8");
    expect(stderr).toContain("[invocation-recovery]");
    expect(stderr).toContain("\"role\":\"spec-splitter\"");
    expect(stderr).toContain("\"attempt\":1");
    expect(stderr).toContain("\"nextAttempt\":2");
    expect(stderr).toContain("\"delayClass\":\"ordinary\"");
    for (const secret of forbiddenSecrets) {
      expect(stderr).not.toContain(secret);
    }
  });

  it("resumes a resumable checkpoint with a correction prompt that repeats the read-only contract", async () => {
    const resume = vi.fn().mockResolvedValue(splitResult(tagged({ slices })));
    const runAgent = vi.fn().mockResolvedValue(
      splitResult("<output>{not valid</output>", { resume }),
    );
    const { splitter, wait } = createSplitter(runAgent);

    await expect(splitter.split(request)).resolves.toEqual(slices);

    expect(runAgent).toHaveBeenCalledOnce();
    expect(resume).toHaveBeenCalledOnce();
    // A parse handoff never spends an invocation attempt on backoff.
    expect(wait).not.toHaveBeenCalled();
    const [correctionPrompt, resumeOptions] = resume.mock.calls[0]!;
    expect(correctionPrompt).toContain("the <output> block did not contain valid JSON");
    expect(correctionPrompt).toContain(
      `structured attempt 2 of ${STRUCTURED_EXTRACTION_ATTEMPTS}`,
    );
    expect(correctionPrompt).toContain(SPEC_SPLITTER_READ_ONLY_CONTRACT);
    // The correction prompt never embeds raw provider errors or responses.
    expect(correctionPrompt).not.toContain("{not valid");
    // The resumed correction carries no output definition either.
    expect(resumeOptions).not.toHaveProperty("output");
  });

  it("falls back to a fresh complete prompt when an invalid response carries no resume checkpoint", async () => {
    const runAgent = vi.fn()
      .mockResolvedValueOnce(splitResult("<output>not JSON</output>"))
      .mockResolvedValueOnce(splitResult(tagged({ slices })));
    const { splitter, wait } = createSplitter(runAgent);

    await expect(splitter.split(request)).resolves.toEqual(slices);

    // Deterministic checkpoint fallback: with no resumable checkpoint the
    // next structured attempt restarts from the complete initial prompt.
    expect(runAgent).toHaveBeenCalledTimes(2);
    expect(runAgent.mock.calls[0]![0].prompt).toBe(runAgent.mock.calls[1]![0].prompt);
    expect(wait).not.toHaveBeenCalled();
  });

  it("retains the previous usable checkpoint when a resumed correction carries none", async () => {
    const resume = vi.fn()
      .mockResolvedValueOnce({
        stdout: "<output>{still broken</output>",
        commits: [],
        branch: "head-branch",
        iterations: [{ sessionId: "spec-split-session" }],
      })
      .mockResolvedValueOnce(splitResult(tagged({ slices })));
    const runAgent = vi.fn().mockResolvedValue(
      splitResult("<output>{not valid</output>", { resume }),
    );
    const { splitter } = createSplitter(runAgent);

    await expect(splitter.split(request)).resolves.toEqual(slices);

    // The third structured attempt resumed the retained first checkpoint
    // instead of restarting the side-effecting read pass.
    expect(runAgent).toHaveBeenCalledOnce();
    expect(resume).toHaveBeenCalledTimes(2);
    expect(resume.mock.calls[1]![0]).toContain(
      `structured attempt 3 of ${STRUCTURED_EXTRACTION_ATTEMPTS}`,
    );
    expect(resume.mock.calls[1]![0]).toContain(SPEC_SPLITTER_READ_ONLY_CONTRACT);
  });

  it("accepts an earlier valid <output> block when a later block is malformed", async () => {
    const stdout = [tagged({ slices }), "trailing narration", "<output>{broken</output>"].join("\n");
    const runAgent = vi.fn().mockResolvedValue(splitResult(stdout));
    const { splitter } = createSplitter(runAgent);

    await expect(splitter.split(request)).resolves.toEqual(slices);
    expect(runAgent).toHaveBeenCalledOnce();
  });

  it("surfaces the bounded exhaustion diagnostic after three completed invalid outputs", async () => {
    const runAgent = vi.fn().mockResolvedValue(splitResult("<output>not JSON</output>"));
    const { splitter } = createSplitter(runAgent);

    const failure = await splitter.split(request).catch((error: unknown) => error);

    expect(runAgent).toHaveBeenCalledTimes(STRUCTURED_EXTRACTION_ATTEMPTS);
    expect(failure).toBeInstanceOf(StructuredOutputError);
    const classified = failure as StructuredOutputError;
    expect(classified.tag).toBe("output");
    expect(classified.message).toContain(
      `Structured output tag <output> could not be parsed after ${STRUCTURED_EXTRACTION_ATTEMPTS} attempts`,
    );
    // Drift guard: no rawMatched or stdout content leaks into the diagnostic.
    expect(classified.message).not.toContain("not JSON");
    expect(classified.rawMatched).toBeUndefined();
  });

  it("stops immediately, without another Agent call, when the checkout changed during the split", async () => {
    const runAgent = vi.fn().mockResolvedValue(splitResult(tagged({ slices })));
    const { splitter, requireUnchanged, wait } = createSplitter(runAgent);
    requireUnchanged.mockRejectedValueOnce(
      new StopRetryError("Target Checkout changed during a read-only stage"),
    );

    const failure = await splitter.split(request).catch((error: unknown) => error);

    // Fail-closed: no automatic reset and no later Agent attempt.
    expect(isStopRetry(failure)).toBe(true);
    expect(runAgent).toHaveBeenCalledOnce();
    expect(wait).not.toHaveBeenCalled();
  });

  it("stops immediately when the checkout changed during a rejected invocation", async () => {
    const runAgent = vi.fn().mockRejectedValue(new Error("gateway unavailable"));
    const { splitter, requireUnchanged, wait } = createSplitter(runAgent);
    requireUnchanged.mockRejectedValueOnce(
      new StopRetryError("Target Checkout changed during a read-only stage"),
    );

    const failure = await splitter.split(request).catch((error: unknown) => error);

    expect(isStopRetry(failure)).toBe(true);
    expect(runAgent).toHaveBeenCalledOnce();
    expect(wait).not.toHaveBeenCalled();
  });

  it("requires a clean Target Checkout before any Agent call", async () => {
    const runAgent = vi.fn();
    const { splitter, requireClean } = createSplitter(runAgent);
    requireClean.mockRejectedValueOnce(
      new StopRetryError("Target Checkout is not clean (staged=0, unstaged=0, unmerged=0, untracked=2)"),
    );

    const failure = await splitter.split(request).catch((error: unknown) => error);

    expect(isStopRetry(failure)).toBe(true);
    expect(runAgent).not.toHaveBeenCalled();
  });
});
