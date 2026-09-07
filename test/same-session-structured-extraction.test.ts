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

const tagged = (value: unknown) => `<result>${JSON.stringify(value)}</result>`;

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
  it("runs the fixed head, single-iteration production pass and resumes it with the same signal and logging, extracting from stdout itself", async () => {
    const resume = vi.fn().mockResolvedValue({
      commits: [{ sha: "resumed" }],
      stdout: tagged({ value: "validated" }),
    });
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
    expect(initial).not.toHaveProperty("output");
    // Drift guard: candidate selection is never delegated back to the
    // library's last-closed-block binding, so no output definition is handed
    // to resume.
    expect(resume).toHaveBeenCalledWith("emit <result> JSON now", {
      signal: initial.signal,
      logging,
    });
    expect(resume.mock.calls[0]![1]).not.toHaveProperty("output");
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
      return { commits: [], stdout: tagged({ value: "validated" }) };
    });
    const runAgent = vi.fn().mockResolvedValue({ commits: [], resume });
    const extractor = createExtractor(runAgent);

    await expect(extractor.extract(plan({
      observeInitial: () => { events.push("initial observation"); },
      observeResumed: () => { events.push("resumed observation"); },
    }))).resolves.toEqual({ value: "validated" });

    expect(events).toEqual(["initial observation", "resume", "resumed observation"]);
  });

  it("recovers a well-formed earlier block when the last closed block is malformed, without any model re-emit or retry", async () => {
    // The live reviewer failure's shape: the output stream held a well-formed
    // <result> block plus a malformed duplicate emitted after it. The seam
    // tries candidates newest-first and recovers the well-formed copy before
    // asking the model for anything.
    const stdout = [
      tagged({ value: "recovered" }),
      "some trailing chatter",
      "<result>not JSON at all</result>",
    ].join("\n");
    const resume = vi.fn().mockResolvedValue({
      commits: [],
      iterations: [{ sessionId: "session-1" }],
      stdout,
    });
    const runAgent = vi.fn().mockResolvedValue({
      commits: [],
      iterations: [{ sessionId: "session-1" }],
      resume,
    });
    const extractor = createExtractor(runAgent);

    await expect(extractor.extract(plan())).resolves.toEqual({ value: "recovered" });

    expect(resume).toHaveBeenCalledTimes(1);
    expect(runAgent).toHaveBeenCalledTimes(1);
  });

  it("recovers a well-formed earlier block when the last closed block fails schema validation", async () => {
    const stdout = [
      tagged({ value: "recovered" }),
      tagged({ wrong: "shape" }),
    ].join("\n");
    const resume = vi.fn().mockResolvedValue({
      commits: [],
      iterations: [{ sessionId: "session-1" }],
      stdout,
    });
    const runAgent = vi.fn().mockResolvedValue({
      commits: [],
      iterations: [{ sessionId: "session-1" }],
      resume,
    });
    const extractor = createExtractor(runAgent);

    await expect(extractor.extract(plan())).resolves.toEqual({ value: "recovered" });

    expect(runAgent).toHaveBeenCalledTimes(1);
  });

  it("keeps selecting the last closed block when it is well-formed", async () => {
    const stdout = [
      tagged({ value: "first" }),
      tagged({ value: "last" }),
    ].join("\n");
    const resume = vi.fn().mockResolvedValue({
      commits: [],
      iterations: [{ sessionId: "session-1" }],
      stdout,
    });
    const runAgent = vi.fn().mockResolvedValue({
      commits: [],
      iterations: [{ sessionId: "session-1" }],
      resume,
    });
    const extractor = createExtractor(runAgent);

    await expect(extractor.extract(plan())).resolves.toEqual({ value: "last" });

    expect(runAgent).toHaveBeenCalledTimes(1);
  });

  it("requests exactly one same-session re-emit carrying the parse detail when the only closed block is malformed", async () => {
    const resume = vi.fn().mockResolvedValue({
      commits: [],
      iterations: [{ sessionId: "session-1" }],
      stdout: "<result>not JSON</result>",
    });
    const runAgent = vi.fn()
      .mockResolvedValueOnce({ commits: [], iterations: [{ sessionId: "session-1" }], resume })
      .mockResolvedValueOnce({
        commits: [],
        iterations: [{ sessionId: "session-1" }],
        stdout: tagged({ value: "validated" }),
      });
    const extractor = createExtractor(runAgent);

    await expect(extractor.extract(plan())).resolves.toEqual({ value: "validated" });

    expect(runAgent).toHaveBeenCalledTimes(2);
    const retry = runAgent.mock.calls[1]![0];
    expect(retry).toEqual(expect.objectContaining({
      resumeSession: "session-1",
      prompt: expect.stringContaining("Emit only a corrected <result> block"),
    }));
    expect(retry).not.toHaveProperty("output");
    expect(retry.prompt).toContain("Structured output tag <result> contains invalid JSON");
    expect(retry.prompt).toContain("SyntaxError");
    expect(retry.prompt).toContain("not JSON");
  });

  it("surfaces the newest candidate's parse detail when every closed block is malformed and the budget is spent", async () => {
    const stdout = [
      "<result>older malformed</result>",
      "<result>newest malformed</result>",
    ].join("\n");
    const resume = vi.fn().mockResolvedValue({
      commits: [],
      iterations: [{ sessionId: "session-1" }],
      stdout,
    });
    const runAgent = vi.fn()
      .mockResolvedValueOnce({ commits: [], iterations: [{ sessionId: "session-1" }], resume })
      .mockResolvedValue({
        commits: [],
        iterations: [{ sessionId: "session-1" }],
        stdout,
      });
    const extractor = createExtractor(runAgent);

    const failure = await extractor.extract(plan()).catch((error: unknown) => error);

    // Budget exhaustion surfaces the bounded, classified diagnostic: still a
    // recoverable StructuredOutputError naming the tag, the attempts made,
    // and the newest candidate's parse detail.
    expect(failure).toBeInstanceOf(StructuredOutputError);
    const classified = failure as StructuredOutputError;
    expect(classified.tag).toBe("result");
    expect(classified.message).toContain(
      `Structured output tag <result> could not be parsed after ${STRUCTURED_EXTRACTION_ATTEMPTS} attempts`,
    );
    expect(classified.message).toContain("last parse detail: SyntaxError: ");
    // The classified failure kind survives exhaustion, so a malformed
    // emission stays distinguishable from a tag that was never emitted.
    expect(classified.message).toContain(
      "last failure: Structured output tag <result> contains invalid JSON",
    );
    // Drift guard: the bounded diagnostic never embeds rawMatched or stdout
    // content, even when the runtime quotes the offending input inside its
    // parser complaint.
    expect(classified.message).not.toContain("newest malformed");
    expect(classified.message).not.toContain("older malformed");
    expect(classified.rawMatched).toBeUndefined();
    // No retry happens beyond the budget.
    expect(runAgent).toHaveBeenCalledTimes(STRUCTURED_EXTRACTION_ATTEMPTS);
  });

  it("keeps the never-emitted kind in the bounded diagnostic when a stream with no closed block exhausts the budget", async () => {
    const resume = vi.fn().mockResolvedValue({
      commits: [],
      iterations: [{ sessionId: "session-1" }],
      stdout: "the agent narrated but never emitted the tag",
    });
    const runAgent = vi.fn()
      .mockResolvedValueOnce({ commits: [], iterations: [{ sessionId: "session-1" }], resume })
      .mockResolvedValue({
        commits: [],
        iterations: [{ sessionId: "session-1" }],
        stdout: "still no tag",
      });
    const extractor = createExtractor(runAgent);

    const failure = await extractor.extract(plan()).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(StructuredOutputError);
    const classified = failure as StructuredOutputError;
    expect(classified.message).toContain(
      `Structured output tag <result> could not be parsed after ${STRUCTURED_EXTRACTION_ATTEMPTS} attempts`,
    );
    expect(classified.message).toContain(
      "last failure: Structured output tag <result> not found in agent output",
    );
    expect(classified.message).toContain("last parse detail: (no parser detail)");
    expect(runAgent).toHaveBeenCalledTimes(STRUCTURED_EXTRACTION_ATTEMPTS);
  });

  it("treats a stream with no closed tag block as today: a recognised recoverable error retried within the budget", async () => {
    const resume = vi.fn().mockResolvedValue({
      commits: [],
      iterations: [{ sessionId: "session-1" }],
      stdout: "the agent narrated but never emitted the tag",
    });
    const runAgent = vi.fn()
      .mockResolvedValueOnce({ commits: [], iterations: [{ sessionId: "session-1" }], resume })
      .mockResolvedValueOnce({
        commits: [],
        iterations: [{ sessionId: "session-1" }],
        stdout: tagged({ value: "validated" }),
      });
    const extractor = createExtractor(runAgent);

    await expect(extractor.extract(plan())).resolves.toEqual({ value: "validated" });

    expect(runAgent).toHaveBeenCalledTimes(2);
    const retry = runAgent.mock.calls[1]![0];
    expect(retry.prompt).toContain("Structured output tag <result> not found in agent output");
    expect(retry.prompt).toContain("(no matching tag was emitted)");
    expect(retry.prompt).toContain("Emit only a corrected <result> block");
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
      .mockResolvedValueOnce({ commits: [], stdout: tagged({ value: "validated" }) });
    const extractor = createExtractor(runAgent);

    await expect(extractor.extract(plan({
      observeResumed: ({ commits }) => { observations.push(commits.map(({ sha }) => sha)); },
    }))).resolves.toEqual({ value: "validated" });

    expect(observations).toEqual([["malformed-extraction"], []]);
    expect(runAgent).toHaveBeenNthCalledWith(2, expect.objectContaining({
      prompt: expect.stringContaining("Emit only a corrected <result> block"),
      resumeSession: "session-1",
    }));
    expect(runAgent.mock.calls[1]![0]).not.toHaveProperty("output");
  });

  it("does not impose business observations when none are declared", async () => {
    const resume = vi.fn().mockResolvedValue({
      commits: [{ sha: "resumed" }],
      stdout: tagged({ value: "validated" }),
    });
    const runAgent = vi.fn().mockResolvedValue({ commits: [{ sha: "initial" }], resume });
    const extractor = createExtractor(runAgent);

    await expect(extractor.extract(plan())).resolves.toEqual({ value: "validated" });
  });

  it("retries a low-level parse fault escaping the extraction run within the same session", async () => {
    // The live reviewer failure's surface form when the library still owned
    // extraction: a raw SyntaxError (a JSON.parse fault), not a
    // StructuredOutputError — one session id, and no retry prompt in the log.
    const lowLevelParseFault = new SyntaxError(`Unexpected token '"' in JSON at position 312`);
    const resume = vi.fn().mockRejectedValueOnce(lowLevelParseFault);
    const runAgent = vi.fn()
      .mockResolvedValueOnce({ commits: [], iterations: [{ sessionId: "review-session-1" }], resume })
      .mockResolvedValueOnce({ commits: [], stdout: tagged({ value: "validated" }) });
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
      .mockResolvedValueOnce({ commits: [], stdout: tagged({ value: "validated" }) });
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
    const resume = vi.fn().mockResolvedValue({
      commits: [{ sha: "resumed" }],
      stdout: tagged({ value: "validated" }),
    });
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
    // The exhausted budget surfaces the bounded, classified diagnostic:
    // tag, attempts made, and the last parse detail — still the recoverable
    // StructuredOutputError, never a silent success.
    expect(classified.tag).toBe("result");
    expect(classified.message).toContain(
      `Structured output tag <result> could not be parsed after ${STRUCTURED_EXTRACTION_ATTEMPTS} attempts`,
    );
    expect(classified.message).toContain(
      "last parse detail: SyntaxError: Unexpected end of JSON input",
    );
    expect(classified.cause).toBe(lowLevelParseFault);
    expect(classified.sessionId).toBe("session-1");
    // The initial extraction plus the armed retries, then the budget is spent.
    expect(runAgent).toHaveBeenCalledTimes(STRUCTURED_EXTRACTION_ATTEMPTS);
  });
});
