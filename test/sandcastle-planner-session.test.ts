import { mkdtempSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import { StructuredOutputError } from "@ai-hero/sandcastle";

import type { CheckoutObserver } from "../.sandcastle/checkout-safety.js";
import { StopRetryError, isStopRetry } from "../.sandcastle/invocation-recovery.js";
import { createJobLog } from "../.sandcastle/job-logs.js";
import {
  PLANNER_READ_ONLY_CONTRACT,
  createSandcastlePlannerSession,
} from "../.sandcastle/planner-session.js";
import { plannerOutputSchema } from "../.sandcastle/planner.js";
import { STRUCTURED_EXTRACTION_ATTEMPTS } from "../.sandcastle/same-session-structured-extraction.js";

const output = {
  status: "ready" as const,
  implementationSummary: "Implement the requested behavior.",
  blockingReason: null,
  allowsAutomationChanges: false,
  issue: {
    number: 101,
    title: "Planner",
    body: "Plan this Issue.",
    labels: ["Sandcastle"],
    comments: [],
  },
};

const planned = (value: unknown) => `<plan>${JSON.stringify(value)}</plan>`;

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

function planResult(stdout: string, extras: { readonly resume?: unknown } = {}) {
  return {
    stdout,
    commits: [],
    branch: "sandcastle/issue-101",
    iterations: [{ sessionId: "session-1" }],
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

function createSession(
  runAgent: ReturnType<typeof vi.fn>,
  overrides: Record<string, unknown> = {},
) {
  const { observer, requireClean, requireUnchanged } = fakeObserver();
  const wait = vi.fn(async () => {});
  const createAgent = vi.fn().mockReturnValue({ name: "fake-agent" });
  const session = createSandcastlePlannerSession({
    sandbox: { kind: "fake-sandbox" } as never,
    hooks: {},
    checkoutPath: "/safe/checkout",
    observer,
    wait,
    runAgent: runAgent as never,
    createAgent: createAgent as never,
    ...overrides,
  });
  return { session, requireClean, requireUnchanged, wait, createAgent };
}

const request = {
  issueNumber: 101,
  model: "planner-model",
  output: { tag: "plan" as const, schema: plannerOutputSchema },
};

describe("Sandcastle Planner session adapter", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("retains the complete raw Agent stream in the inherited whole-job log", async () => {
    vi.stubEnv("SANDCASTLE_JOB_STDOUT_LOG", "/trusted/jobs/logs/job-101/stdout.log");
    const runAgent = vi.fn().mockResolvedValue(planResult(planned(output)));
    const { session } = createSession(runAgent);

    await session.run(request);

    expect(runAgent).toHaveBeenCalledWith(expect.objectContaining({
      logging: {
        type: "file",
        path: "/trusted/jobs/logs/job-101/stdout.log",
        verbose: true,
      },
    }));
  });

  it("runs a fresh read-only Planner session with structured output", async () => {
    const runAgent = vi.fn().mockResolvedValue(planResult(planned(output)));
    const createAgent = vi.fn().mockReturnValue({ name: "fake-agent" });
    const sandbox = { kind: "fake-sandbox" };
    const hooks = { sandbox: { onSandboxReady: [] } };
    const { observer } = fakeObserver();
    const session = createSandcastlePlannerSession({
      sandbox: sandbox as never,
      hooks,
      checkoutPath: "/safe/checkout",
      observer,
      wait: vi.fn(async () => {}),
      runAgent: runAgent as never,
      createAgent: createAgent as never,
    });

    await expect(session.run(request)).resolves.toEqual(output);

    expect(runAgent).toHaveBeenCalledOnce();
    expect(runAgent).toHaveBeenCalledWith(expect.objectContaining({
      sandbox,
      hooks,
      cwd: "/safe/checkout",
      branchStrategy: { type: "head" },
      maxIterations: 1,
      name: "planner-issue-101",
    }));
    const runRequest = runAgent.mock.calls[0]![0];
    // The SDK's recursive output retry is never armed: no run call carries an
    // output definition, so there is nothing for the library to retry.
    expect(runRequest).not.toHaveProperty("output");
    expect(createAgent).toHaveBeenCalledWith("planner-model");
    expect(runRequest.agent).toEqual({ name: "fake-agent" });
    expect(runRequest.prompt).toContain("gh issue view 101 --comments");
    expect(runRequest.prompt).toContain("body, labels, and all comments");
    expect(runRequest.prompt).toContain("<plan>");
    expect(runRequest.prompt).toContain("exactly match this strict schema");
    expect(runRequest.prompt).toContain("implementationSummary (a non-empty string, never an array or object)");
    expect(runRequest.prompt).toContain("include no fields other than those listed");
    expect(runRequest.prompt).toContain("Do not add scope, metadata, explanation, helper, or any other fields");
    expect(runRequest.prompt).toContain(PLANNER_READ_ONLY_CONTRACT);
    expect(runRequest.prompt).toContain(
      "Determine whether the Issue explicitly permits changes to Sandcastle or GitHub automation configuration",
    );
    expect(runRequest.prompt).toContain(
      "Treat comments generated by prior Automation failures (for example, comments saying an Automation operation is blocked and naming a local job) as execution history only: preserve them in the returned issue context, but they must not by themselves make the plan blocked. Base blocking decisions on the Issue's requested work, current state, dependencies, and unresolved human decisions.",
    );
    expect(runRequest.prompt).not.toContain(output.issue.body);
    expect(runRequest.prompt).not.toContain("shared accumulating branch");
    expect(runRequest.prompt).not.toContain("git fetch origin");
  });

  it("recovers a #44-style first-attempt 403 gateway failure into a valid plan within the same Target operation", async () => {
    const root = mkdtempSync(join(tmpdir(), "planner-session-log-"));
    const log = await createJobLog({
      root,
      jobId: "job-101",
      operation: "implement-issue",
      revision: "d".repeat(40),
    });
    const runAgent = vi.fn()
      .mockRejectedValueOnce(new Error(forbiddenHtml))
      .mockResolvedValueOnce(planResult(planned(output)));
    const { session, requireUnchanged, wait } = createSession(runAgent, { log });

    await expect(session.run(request)).resolves.toEqual(output);

    // The gateway rejection consumed no structured attempt: both invocations
    // ran the same complete planning prompt inside one recovery window.
    expect(runAgent).toHaveBeenCalledTimes(2);
    expect(runAgent.mock.calls[0]![0].prompt).toBe(runAgent.mock.calls[1]![0].prompt);
    expect(requireUnchanged).toHaveBeenCalledTimes(2);
    expect(wait).toHaveBeenCalledWith(2_000, undefined);

    // Only sanitized attempt metadata reached the append-only Job Log.
    const stderr = await readFile(log.stderrPath, "utf8");
    expect(stderr).toContain("[invocation-recovery]");
    expect(stderr).toContain("\"role\":\"planner\"");
    expect(stderr).toContain("\"attempt\":1");
    expect(stderr).toContain("\"nextAttempt\":2");
    expect(stderr).toContain("\"delayClass\":\"ordinary\"");
    for (const secret of forbiddenSecrets) {
      expect(stderr).not.toContain(secret);
    }
  });

  it("resumes a resumable checkpoint with a format-correction prompt that repeats the read-only contract", async () => {
    const resume = vi.fn().mockResolvedValue(planResult(planned(output)));
    const runAgent = vi.fn().mockResolvedValue(
      planResult("<plan>{not valid</plan>", { resume }),
    );
    const { session, wait } = createSession(runAgent);

    await expect(session.run(request)).resolves.toEqual(output);

    expect(runAgent).toHaveBeenCalledOnce();
    expect(resume).toHaveBeenCalledOnce();
    // A parse handoff never spends an invocation attempt on backoff.
    expect(wait).not.toHaveBeenCalled();
    const [correctionPrompt, resumeOptions] = resume.mock.calls[0]!;
    expect(correctionPrompt).toContain("the <plan> block did not contain valid JSON");
    expect(correctionPrompt).toContain(
      `structured attempt 2 of ${STRUCTURED_EXTRACTION_ATTEMPTS}`,
    );
    expect(correctionPrompt).toContain(PLANNER_READ_ONLY_CONTRACT);
    // The correction prompt never embeds raw provider errors or responses.
    expect(correctionPrompt).not.toContain("{not valid");
    // The resumed correction carries no output definition either.
    expect(resumeOptions).not.toHaveProperty("output");
  });

  it("accepts an earlier valid tagged block when a later block is malformed", async () => {
    const stdout = [planned(output), "trailing narration", "<plan>{broken</plan>"].join("\n");
    const runAgent = vi.fn().mockResolvedValue(planResult(stdout));
    const { session } = createSession(runAgent);

    await expect(session.run(request)).resolves.toEqual(output);
    expect(runAgent).toHaveBeenCalledOnce();
  });

  it("surfaces the bounded exhaustion diagnostic after three completed invalid outputs", async () => {
    const runAgent = vi.fn().mockResolvedValue(planResult("<plan>not JSON</plan>"));
    const { session } = createSession(runAgent);

    const failure = await session.run(request).catch((error: unknown) => error);

    // Three structured attempts, one invocation each (no checkpoint was
    // carried, so each attempt started a new complete planning prompt); the
    // operation fails as Blocked Automation in bounded time.
    expect(runAgent).toHaveBeenCalledTimes(STRUCTURED_EXTRACTION_ATTEMPTS);
    expect(failure).toBeInstanceOf(StructuredOutputError);
    const classified = failure as StructuredOutputError;
    expect(classified.tag).toBe("plan");
    expect(classified.message).toContain(
      `Structured output tag <plan> could not be parsed after ${STRUCTURED_EXTRACTION_ATTEMPTS} attempts`,
    );
    expect(classified.message).toContain("last parse detail: SyntaxError:");
    // Drift guard: no rawMatched or stdout content leaks into the diagnostic.
    expect(classified.message).not.toContain("not JSON");
    expect(classified.rawMatched).toBeUndefined();
  });

  it("makes at most nine Agent executions for direct structured Planner recovery", async () => {
    // Every structured attempt: two invocation rejections, then a completed
    // invalid response without a resumable checkpoint. 3 x 3 = 9 executions.
    const runAgent = vi.fn();
    for (let attempt = 0; attempt < STRUCTURED_EXTRACTION_ATTEMPTS; attempt += 1) {
      runAgent
        .mockRejectedValueOnce(new Error("gateway unavailable"))
        .mockRejectedValueOnce(new Error("gateway unavailable"))
        .mockResolvedValueOnce(planResult("<plan>{broken</plan>"));
    }
    const { session, wait } = createSession(runAgent);

    const failure = await session.run(request).catch((error: unknown) => error);

    expect(runAgent).toHaveBeenCalledTimes(STRUCTURED_EXTRACTION_ATTEMPTS * 3);
    expect(wait).toHaveBeenCalledTimes(STRUCTURED_EXTRACTION_ATTEMPTS * 2);
    expect(failure).toBeInstanceOf(StructuredOutputError);
    expect((failure as StructuredOutputError).message).toContain(
      `could not be parsed after ${STRUCTURED_EXTRACTION_ATTEMPTS} attempts`,
    );
  });

  it.each([
    ["timeout", () => new Error("Planner execution timed out")],
    ["abort", () => new DOMException("The operation was aborted", "AbortError")],
    ["execution", () => new Error("claude exited with code 1: sandbox unavailable")],
  ])("gives the %s failure three bounded invocation attempts and rethrows it unchanged", async (_name, makeFailure) => {
    const failure = makeFailure();
    const runAgent = vi.fn().mockRejectedValue(failure);
    const { session } = createSession(runAgent);

    // An AbortError name without a real aborted signal is an ordinary
    // invocation failure: it receives the same bounded attempts and the last
    // failure propagates unchanged along the operation failure path.
    await expect(session.run(request)).rejects.toBe(failure);
    expect(runAgent).toHaveBeenCalledTimes(3);
  });

  it("stops immediately, without another Agent call, when the checkout changed during planning", async () => {
    const runAgent = vi.fn().mockResolvedValue(planResult(planned(output)));
    const { session, requireUnchanged, wait } = createSession(runAgent);
    requireUnchanged.mockRejectedValueOnce(
      new StopRetryError("Target Checkout changed during a read-only stage"),
    );

    const failure = await session.run(request).catch((error: unknown) => error);

    expect(isStopRetry(failure)).toBe(true);
    expect(runAgent).toHaveBeenCalledOnce();
    expect(wait).not.toHaveBeenCalled();
  });

  it("requires a clean Target Checkout before any Agent call", async () => {
    const runAgent = vi.fn();
    const { session, requireClean } = createSession(runAgent);
    requireClean.mockRejectedValueOnce(
      new StopRetryError("Target Checkout is not clean (staged=0, unstaged=0, unmerged=0, untracked=2)"),
    );

    const failure = await session.run(request).catch((error: unknown) => error);

    expect(isStopRetry(failure)).toBe(true);
    expect(runAgent).not.toHaveBeenCalled();
  });

  it("runs a fresh read-only Planner session with Spec child context", async () => {
    const runAgent = vi.fn().mockResolvedValue(planResult(planned(output)));
    const { observer } = fakeObserver();
    const session = createSandcastlePlannerSession({
      sandbox: { kind: "fake-sandbox" } as never,
      hooks: { sandbox: { onSandboxReady: [] } },
      checkoutPath: "/safe/checkout",
      observer,
      wait: vi.fn(async () => {}),
      runAgent: runAgent as never,
      createAgent: vi.fn().mockReturnValue({ name: "fake-agent" }) as never,
      specContext: { parentSpec: 306, branch: "sandcastle/spec-306" },
    });

    await expect(session.run({
      issueNumber: 309,
      model: "planner-model",
      output: { tag: "plan", schema: plannerOutputSchema },
    })).resolves.toEqual(output);

    const runRequest = runAgent.mock.calls[0]![0];
    expect(runRequest.prompt).toContain(
      "This Issue is one child of Spec #306, delivered on the shared accumulating branch sandcastle/spec-306",
    );
    expect(runRequest.prompt).toContain(
      "If sandcastle/spec-306 already exists on origin, inspect the accumulated branch state with git fetch origin sandcastle/spec-306",
    );
    expect(runRequest.prompt).toContain(
      "git show origin/sandcastle/spec-306:<path>",
    );
    expect(runRequest.prompt).toContain(
      "Plan against the accumulated branch state when it exists, not the bare base checkout",
    );
  });
});
