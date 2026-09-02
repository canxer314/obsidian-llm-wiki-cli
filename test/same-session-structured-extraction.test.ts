import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { createSameSessionStructuredExtractor } from "../.sandcastle/same-session-structured-extraction.js";

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
      output: expect.objectContaining({ _tag: "object", tag: "result", schema: outputSchema, maxRetries: 2 }),
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

  it("does not impose business observations when none are declared", async () => {
    const resume = vi.fn().mockResolvedValue({ commits: [{ sha: "resumed" }], output: { value: "validated" } });
    const runAgent = vi.fn().mockResolvedValue({ commits: [{ sha: "initial" }], resume });
    const extractor = createExtractor(runAgent);

    await expect(extractor.extract(plan())).resolves.toEqual({ value: "validated" });
  });
});
