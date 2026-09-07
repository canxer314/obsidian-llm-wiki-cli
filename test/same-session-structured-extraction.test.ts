import { StructuredOutputError } from "@ai-hero/sandcastle";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  STRUCTURED_EXTRACTION_ATTEMPTS,
  createSameSessionStructuredExtractor,
} from "../.sandcastle/same-session-structured-extraction.js";

const outputSchema = z.strictObject({ value: z.string() });
const sandbox = { kind: "fake-sandbox" } as never;
const hooks = { sandbox: { onSandboxReady: [] } };
const logging = { type: "file", path: "/jobs/extraction.log", verbose: true } as const;

function createExtractor(runAgent: ReturnType<typeof vi.fn>) {
  return createSameSessionStructuredExtractor({
    sandbox,
    hooks,
    runAgent: runAgent as never,
    createAgent: vi.fn().mockReturnValue({ name: "fake-agent" }) as never,
  });
}

function plan(overrides: Partial<Parameters<ReturnType<typeof createExtractor>["extract"]>[0]> = {}) {
  return {
    model: "extractor-model",
    checkoutPath: "/safe/disposable-checkout",
    initialPrompt: "complete the task and preserve context",
    resumedPrompt: "emit <result> JSON now",
    timeoutMilliseconds: 60_000,
    timeoutError: new Error("extraction timed out"),
    logging,
    output: { tag: "result", schema: outputSchema },
    missingResumeMessage: "session identity is unavailable",
    ...overrides,
  };
}

describe("same-session structured extraction", () => {
  it("runs the fixed head, single-iteration production pass and resumes it with the same signal, logging, and output contract", async () => {
    const resume = vi.fn().mockResolvedValue({ commits: [{ sha: "resumed" }], output: { value: "validated" } });
    const runAgent = vi.fn().mockResolvedValue({ commits: [{ sha: "initial" }], resume });
    const extractor = createExtractor(runAgent);

    await expect(extractor.extract(plan())).resolves.toEqual({ value: "validated" });

    const initial = runAgent.mock.calls[0]![0];
    expect(initial).toEqual(expect.objectContaining({
      agent: { name: "fake-agent" },
      sandbox,
      hooks,
      cwd: "/safe/disposable-checkout",
      prompt: "complete the task and preserve context",
      branchStrategy: { type: "head" },
      maxIterations: 1,
      logging,
    }));
    expect(resume).toHaveBeenCalledWith("emit <result> JSON now", expect.objectContaining({
      signal: initial.signal,
      logging,
      output: expect.objectContaining({ _tag: "object", tag: "result", schema: outputSchema, maxRetries: undefined }),
    }));
  });

  it("fails before extraction and clears its deadline when production does not expose a resumable session", async () => {
    vi.useFakeTimers();
    const runAgent = vi.fn().mockResolvedValue({ commits: [] });
    const extractor = createExtractor(runAgent);

    await expect(extractor.extract(plan())).rejects.toThrow("session identity is unavailable");
    expect(runAgent).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  });

  it.each([
    ["initial run", () => Promise.reject(new Error("initial failed"))],
    ["resumed run", () => Promise.resolve({ commits: [], resume: vi.fn().mockRejectedValue(new Error("resumed failed")) })],
  ])("clears its deadline when the %s fails", async (_name, result) => {
    vi.useFakeTimers();
    const runAgent = vi.fn().mockImplementation(result);
    const extractor = createExtractor(runAgent);

    await expect(extractor.extract(plan())).rejects.toThrow(/failed/);
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  });

  it("clears its deadline when extraction cannot parse structured output", async () => {
    vi.useFakeTimers();
    const runAgent = vi.fn().mockResolvedValue({
      commits: [],
      resume: vi.fn().mockRejectedValue(new Error("structured output failed")),
    });
    const extractor = createExtractor(runAgent);

    await expect(extractor.extract(plan())).rejects.toThrow("structured output failed");
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  });

  it("runs optional observations after each result and before returning structured output", async () => {
    const events: string[] = [];
    const resume = vi.fn().mockImplementation(async () => {
      events.push("resume");
      return { commits: [], output: { value: "validated" } };
    });
    const runAgent = vi.fn().mockResolvedValue({ commits: [], resume });
    const extractor = createExtractor(runAgent);

    await expect(extractor.extract(plan({
      observeInitial: () => { events.push("initial observation"); },
      observeResumed: () => { events.push("resumed observation"); },
    }))).resolves.toEqual({ value: "validated" });

    expect(events).toEqual(["initial observation", "resume", "resumed observation"]);
  });

  it("observes every malformed extraction attempt before retrying the same session", async () => {
    const observations: string[][] = [];
    const malformed = new StructuredOutputError("Structured output tag <result> contains invalid JSON", {
      tag: "result",
      rawMatched: "not JSON",
      commits: [{ sha: "malformed-extraction" }],
      branch: "spec-402",
      sessionId: "session-1",
    });
    const resume = vi.fn().mockRejectedValueOnce(malformed);
    const runAgent = vi.fn()
      .mockResolvedValueOnce({ commits: [], resume })
      .mockResolvedValueOnce({ commits: [], output: { value: "validated" } });
    const extractor = createExtractor(runAgent);

    await expect(extractor.extract(plan({
      observeResumed: ({ commits }) => { observations.push(commits.map(({ sha }) => sha)); },
    }))).resolves.toEqual({ value: "validated" });

    expect(observations).toEqual([["malformed-extraction"], []]);
    expect(runAgent).toHaveBeenNthCalledWith(2, expect.objectContaining({
      prompt: expect.stringContaining("Emit only a corrected <result> block"),
      resumeSession: "session-1",
      output: expect.objectContaining({ _tag: "object", tag: "result", maxRetries: undefined }),
    }));
  });

  it("does not impose business observations when none are declared", async () => {
    const resume = vi.fn().mockResolvedValue({ commits: [{ sha: "resumed" }], output: { value: "validated" } });
    const runAgent = vi.fn().mockResolvedValue({ commits: [{ sha: "initial" }], resume });
    const extractor = createExtractor(runAgent);

    await expect(extractor.extract(plan())).resolves.toEqual({ value: "validated" });
  });

  it("retries a low-level parse fault escaping the extraction run within the same session", async () => {
    // The live reviewer failure's shape: the output stream held a well-formed
    // <review> block plus a malformed duplicate, and the failure escaped the
    // retry guard as a raw SyntaxError (a JSON.parse fault), not a
    // StructuredOutputError — one session id, and no retry prompt in the log.
    const lowLevelParseFault = new SyntaxError(`Unexpected token '"' in JSON at position 312`);
    const resume = vi.fn().mockRejectedValueOnce(lowLevelParseFault);
    const runAgent = vi.fn()
      .mockResolvedValueOnce({ commits: [], iterations: [{ sessionId: "review-session-1" }], resume })
      .mockResolvedValueOnce({ commits: [], output: { value: "validated" } });
    const extractor = createExtractor(runAgent);

    await expect(extractor.extract(plan())).resolves.toEqual({ value: "validated" });

    expect(runAgent).toHaveBeenCalledTimes(2);
    expect(runAgent).toHaveBeenNthCalledWith(2, expect.objectContaining({
      resumeSession: "review-session-1",
      prompt: expect.stringContaining("Emit only a corrected <result> block"),
    }));
  });

  it.each([
    ["StructuredOutputError", () => new StructuredOutputError("Structured output tag <result> contains invalid JSON", {
      tag: "result",
      rawMatched: "not JSON",
      commits: [],
      branch: "spec-437",
      sessionId: "session-1",
    })],
    ["a raw JSON.parse SyntaxError", () => new SyntaxError("Unexpected end of JSON input")],
    ["a thrown ZodError validation failure", () => {
      try {
        outputSchema.parse({});
      } catch (error) {
        return error;
      }
      throw new Error("expected the schema to reject");
    }],
    ["a StructuredOutputError from a duplicate bundle copy", () => ({
      name: "StructuredOutputError",
      message: "Structured output tag <result> contains invalid JSON",
      tag: "result",
      rawMatched: "not JSON",
      commits: [],
      branch: "spec-437",
      sessionId: "session-1",
    })],
    ["a StructuredOutputError without a session identity", () => new StructuredOutputError("Structured output tag <result> not found in agent output", {
      tag: "result",
      rawMatched: undefined,
      commits: [],
      branch: "spec-437",
    })],
  ])("classifies %s reaching the seam as recoverable so the retry guard cannot be bypassed", async (_name, makeFailure) => {
    const resume = vi.fn().mockRejectedValueOnce(makeFailure());
    const runAgent = vi.fn()
      .mockResolvedValueOnce({ commits: [], iterations: [{ sessionId: "session-1" }], resume })
      .mockResolvedValueOnce({ commits: [], output: { value: "validated" } });
    const extractor = createExtractor(runAgent);

    await expect(extractor.extract(plan())).resolves.toEqual({ value: "validated" });

    expect(runAgent).toHaveBeenCalledTimes(2);
    expect(runAgent).toHaveBeenNthCalledWith(2, expect.objectContaining({
      resumeSession: "session-1",
      prompt: expect.stringContaining("Emit only a corrected <result> block"),
    }));
  });

  it.each([
    ["timeout", () => new Error("extraction timed out")],
    ["abort", () => new DOMException("The operation was aborted", "AbortError")],
    ["execution", () => new Error("claude exited with code 1: sandbox unavailable")],
  ])("propagates the %s failure unchanged and consumes no retry", async (_name, makeFailure) => {
    const failure = makeFailure();
    const resume = vi.fn().mockRejectedValue(failure);
    const runAgent = vi.fn().mockResolvedValue({ commits: [], iterations: [{ sessionId: "session-1" }], resume });
    const extractor = createExtractor(runAgent);

    await expect(extractor.extract(plan())).rejects.toBe(failure);
    expect(runAgent).toHaveBeenCalledTimes(1);
    expect(resume).toHaveBeenCalledTimes(1);
  });

  it("propagates a business observation failure unchanged and consumes no retry", async () => {
    const observationFailure = new Error("extraction session must not create commits");
    const resume = vi.fn().mockResolvedValue({ commits: [{ sha: "resumed" }], output: { value: "validated" } });
    const runAgent = vi.fn().mockResolvedValue({ commits: [], iterations: [{ sessionId: "session-1" }], resume });
    const extractor = createExtractor(runAgent);

    await expect(extractor.extract(plan({
      observeResumed: () => { throw observationFailure; },
    }))).rejects.toBe(observationFailure);
    expect(runAgent).toHaveBeenCalledTimes(1);
    expect(resume).toHaveBeenCalledTimes(1);
  });

  it("surfaces an exhausted budget as the classified recoverable output error, never a silent success", async () => {
    const lowLevelParseFault = new SyntaxError("Unexpected end of JSON input");
    const resume = vi.fn().mockRejectedValue(lowLevelParseFault);
    const runAgent = vi.fn()
      .mockResolvedValueOnce({ commits: [], iterations: [{ sessionId: "session-1" }], resume })
      .mockRejectedValue(lowLevelParseFault);
    const extractor = createExtractor(runAgent);

    const failure = await extractor.extract(plan()).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(StructuredOutputError);
    expect(failure).not.toBe(lowLevelParseFault);
    const classified = failure as StructuredOutputError;
    expect(classified.message).toBe("Structured output tag <result> contains invalid JSON");
    expect(classified.tag).toBe("result");
    expect(classified.cause).toBe(lowLevelParseFault);
    expect(classified.sessionId).toBe("session-1");
    // The initial extraction plus the armed retries, then the budget is spent.
    expect(runAgent).toHaveBeenCalledTimes(STRUCTURED_EXTRACTION_ATTEMPTS);
  });
});
