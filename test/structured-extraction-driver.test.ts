import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { StructuredOutputError } from "@ai-hero/sandcastle";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import type { CheckoutObserver } from "../.sandcastle/checkout-safety.js";
import { createCheckoutObserver } from "../.sandcastle/checkout-safety.js";
import { isStopRetry, StopRetryError } from "../.sandcastle/invocation-recovery.js";
import { createJobLog, type JobLog } from "../.sandcastle/job-logs.js";
import { STRUCTURED_EXTRACTION_ATTEMPTS } from "../.sandcastle/same-session-structured-extraction.js";
import {
  MAX_STRUCTURED_ATTEMPTS,
  createStructuredExtractionDriver,
  structuredCorrectionPrompt,
  structuredFailureKind,
} from "../.sandcastle/structured-extraction-driver.js";

const outputSchema = z.strictObject({ value: z.string() });
const sandbox = { kind: "fake-sandbox" } as never;
const hooks = { sandbox: { onSandboxReady: [] } };
const READ_ONLY_CONTRACT = "Read-only contract: change nothing in this checkout.";

const tagged = (value: unknown) => `<result>${JSON.stringify(value)}</result>`;

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

function completedResult(
  stdout: string,
  extras: { readonly resume?: unknown; readonly sessionId?: string } = {},
) {
  return {
    stdout,
    commits: [{ sha: "c".repeat(40) }],
    branch: "head-branch",
    ...(extras.sessionId === undefined
      ? {}
      : { iterations: [{ sessionId: extras.sessionId }] }),
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
  return { observer, requireClean, requireUnchanged, snapshot };
}

function harness(
  runAgent: ReturnType<typeof vi.fn>,
  overrides: Record<string, unknown> = {},
) {
  const { observer, requireClean, requireUnchanged } = fakeObserver();
  const wait = vi.fn(async () => {});
  const createAgent = vi.fn().mockReturnValue({ name: "fake-agent" });
  const driver = createStructuredExtractionDriver({
    sandbox,
    hooks,
    checkoutPath: "/safe/checkout",
    role: "planner",
    stage: "structured-extraction",
    observer,
    wait,
    runAgent: runAgent as never,
    createAgent: createAgent as never,
    ...overrides,
  });
  return { driver, requireClean, requireUnchanged, wait, createAgent };
}

function plan(overrides: Record<string, unknown> = {}) {
  return {
    model: "driver-model",
    name: "driver-test",
    initialPrompt: "complete the read-only task",
    readOnlyContract: READ_ONLY_CONTRACT,
    output: { tag: "result", schema: outputSchema },
    ...overrides,
  };
}

async function newJobLog(): Promise<JobLog> {
  const root = mkdtempSync(join(tmpdir(), "structured-driver-log-"));
  return createJobLog({
    root,
    jobId: "job-1",
    operation: "implement-issue",
    revision: "d".repeat(40),
  });
}

describe("structured extraction driver", () => {
  it("proves a clean checkout, runs the complete prompt once, and proves unchanged state after the invocation", async () => {
    const runAgent = vi.fn().mockResolvedValue(completedResult(tagged({ value: "ok" })));
    const { driver, requireClean, requireUnchanged, createAgent } = harness(runAgent);

    await expect(driver.extract(plan())).resolves.toEqual({ value: "ok" });

    expect(requireClean).toHaveBeenCalledOnce();
    expect(requireClean).toHaveBeenCalledWith("/safe/checkout");
    expect(runAgent).toHaveBeenCalledOnce();
    expect(requireUnchanged).toHaveBeenCalledOnce();
    const request = runAgent.mock.calls[0]![0];
    expect(createAgent).toHaveBeenCalledWith("driver-model");
    expect(request).toEqual(expect.objectContaining({
      agent: { name: "fake-agent" },
      sandbox,
      hooks,
      cwd: "/safe/checkout",
      branchStrategy: { type: "head" },
      maxIterations: 1,
      name: "driver-test",
      prompt: "complete the read-only task",
    }));
    // Drift guard: the library's recursive output retry is never armed, so no
    // run call carries an output definition (stronger than maxRetries: 0).
    expect(request).not.toHaveProperty("output");
  });

  it("recovers from a #44-style 403 gateway rejection within the same structured attempt and leaks nothing raw", async () => {
    const log = await newJobLog();
    const gateway = new Error(forbiddenHtml);
    const runAgent = vi.fn()
      .mockRejectedValueOnce(gateway)
      .mockResolvedValueOnce(completedResult(tagged({ value: "recovered" })));
    const { driver, requireUnchanged, wait } = harness(runAgent, { log });

    await expect(driver.extract(plan())).resolves.toEqual({ value: "recovered" });

    // The rejection consumed no structured attempt: both invocations ran the
    // same complete prompt inside one recovery window, and the unchanged
    // checkout was proven after the rejection and after the success.
    expect(runAgent).toHaveBeenCalledTimes(2);
    expect(runAgent.mock.calls[0]![0].prompt).toBe("complete the read-only task");
    expect(runAgent.mock.calls[1]![0].prompt).toBe("complete the read-only task");
    expect(requireUnchanged).toHaveBeenCalledTimes(2);
    expect(wait).toHaveBeenCalledWith(2_000, undefined);

    const stderr = await import("node:fs/promises").then((fs) =>
      fs.readFile(log.stderrPath, "utf8"));
    expect(stderr).toContain("[invocation-recovery]");
    expect(stderr).toContain("\"stage\":\"structured-extraction structured 1\"");
    expect(stderr).toContain("\"attempt\":1");
    expect(stderr).toContain("\"nextAttempt\":2");
    expect(stderr).toContain("\"delayClass\":\"ordinary\"");
    for (const secret of forbiddenSecrets) {
      expect(stderr).not.toContain(secret);
    }
  });

  it.each([
    ["missing tag", "plain text without any tag", "no <result> block was present"],
    ["invalid JSON", "<result>{oops</result>", "did not contain valid JSON"],
    ["schema-invalid payload", tagged({ other: 1 }), "did not match the required schema"],
  ])(
    "a completed response with a %s consumes exactly one structured attempt and never an invocation attempt",
    async (_label, invalidStdout, problem) => {
      const resume = vi.fn().mockResolvedValue(completedResult(tagged({ value: "fixed" })));
      const runAgent = vi.fn().mockResolvedValue(
        completedResult(invalidStdout, { resume, sessionId: "session-1" }),
      );
      const { driver, wait } = harness(runAgent);

      await expect(driver.extract(plan())).resolves.toEqual({ value: "fixed" });

      // One invocation for the invalid completion; the next structured
      // attempt resumed the fresh checkpoint with a format-correction prompt.
      expect(runAgent).toHaveBeenCalledOnce();
      expect(resume).toHaveBeenCalledOnce();
      // No backoff wait: a parse handoff never spends an invocation attempt.
      expect(wait).not.toHaveBeenCalled();
      const [correctionPrompt] = resume.mock.calls[0]!;
      expect(correctionPrompt).toContain(problem);
      expect(correctionPrompt).toContain(
        `structured attempt 2 of ${MAX_STRUCTURED_ATTEMPTS}`,
      );
      expect(correctionPrompt).toContain(READ_ONLY_CONTRACT);
      // The correction prompt never embeds the raw matched response.
      expect(correctionPrompt).not.toContain("{oops");
      expect(correctionPrompt).not.toContain("plain text without any tag");
      expect(correctionPrompt).not.toContain("other");
    },
  );

  it("starts a new complete prompt when a completed invalid response carries no checkpoint", async () => {
    const runAgent = vi.fn()
      .mockResolvedValueOnce(completedResult("<result>{broken</result>"))
      .mockResolvedValueOnce(completedResult(tagged({ value: "fresh" })));
    const { driver } = harness(runAgent);

    await expect(driver.extract(plan())).resolves.toEqual({ value: "fresh" });

    expect(runAgent).toHaveBeenCalledTimes(2);
    expect(runAgent.mock.calls[0]![0].prompt).toBe("complete the read-only task");
    expect(runAgent.mock.calls[1]![0].prompt).toBe("complete the read-only task");
  });

  it("retains the prior usable checkpoint when a later invalid response carries none", async () => {
    const resume = vi.fn()
      .mockResolvedValueOnce(completedResult("<result>{broken again</result>"))
      .mockResolvedValueOnce(completedResult(tagged({ value: "third" })));
    const runAgent = vi.fn().mockResolvedValue(
      completedResult("<result>{broken</result>", { resume, sessionId: "session-1" }),
    );
    const { driver } = harness(runAgent);

    await expect(driver.extract(plan())).resolves.toEqual({ value: "third" });

    expect(runAgent).toHaveBeenCalledOnce();
    // Both correction attempts resumed the same checkpoint: the second
    // invalid response carried no resumable session, so the prior one lived.
    expect(resume).toHaveBeenCalledTimes(2);
    expect(resume.mock.calls[0]![0]).toContain(`structured attempt 2 of ${MAX_STRUCTURED_ATTEMPTS}`);
    expect(resume.mock.calls[1]![0]).toContain(`structured attempt 3 of ${MAX_STRUCTURED_ATTEMPTS}`);
  });

  it("makes at most nine Agent executions and then surfaces the bounded exhaustion diagnostic", async () => {
    const log = await newJobLog();
    // Every structured attempt: two invocation rejections, then a completed
    // invalid response without a checkpoint. 3 x 3 = 9 executions.
    const runAgent = vi.fn();
    for (let attempt = 0; attempt < MAX_STRUCTURED_ATTEMPTS; attempt += 1) {
      runAgent
        .mockRejectedValueOnce(new Error("gateway unavailable"))
        .mockRejectedValueOnce(new Error("gateway unavailable"))
        .mockResolvedValueOnce(completedResult("<result>{broken</result>"));
    }
    const { driver, wait } = harness(runAgent, { log });

    const failure = await driver.extract(plan()).catch((error: unknown) => error);

    expect(runAgent).toHaveBeenCalledTimes(MAX_STRUCTURED_ATTEMPTS * 3);
    expect(wait).toHaveBeenCalledTimes(MAX_STRUCTURED_ATTEMPTS * 2);
    expect(failure).toBeInstanceOf(StructuredOutputError);
    const classified = failure as StructuredOutputError;
    expect(classified.tag).toBe("result");
    expect(classified.message).toContain(
      `could not be parsed after ${STRUCTURED_EXTRACTION_ATTEMPTS} attempts`,
    );
    expect(classified.rawMatched).toBeUndefined();
    expect(classified.message).not.toContain("{broken");

    // The Job Log distinguishes structured attempt ordinals from invocation
    // attempt ordinals and carries only sanitized metadata.
    const { readFile } = await import("node:fs/promises");
    const stderr = await readFile(log.stderrPath, "utf8");
    for (let structured = 1; structured <= MAX_STRUCTURED_ATTEMPTS; structured += 1) {
      expect(stderr).toContain(`"stage":"structured-extraction structured ${structured}"`);
      expect(stderr).toContain(`"structuredAttempt":${structured}`);
    }
    expect(stderr).toContain("\"attempt\":1");
    expect(stderr).toContain("\"attempt\":2");
    expect(stderr).toContain("\"delayClass\":\"ordinary\"");
    expect(stderr).toContain("\"outcome\":\"exhausted\"");
    expect(stderr).not.toContain("gateway unavailable");
  });

  it("rethrows the last invocation failure unchanged when one window exhausts three invocations", async () => {
    const failures = [1, 2, 3].map((n) => new Error(`invocation failure ${n}`));
    const runAgent = vi.fn().mockImplementation(() =>
      Promise.reject(failures[runAgent.mock.calls.length - 1]));
    const { driver } = harness(runAgent);

    await expect(driver.extract(plan())).rejects.toBe(failures[2]);
    expect(runAgent).toHaveBeenCalledTimes(3);
  });

  it("accepts an earlier valid tagged block when a later block is malformed", async () => {
    const stdout = [
      tagged({ value: "early-valid" }),
      "some trailing narration",
      "<result>{broken</result>",
    ].join("\n");
    const runAgent = vi.fn().mockResolvedValue(completedResult(stdout));
    const { driver } = harness(runAgent);

    await expect(driver.extract(plan())).resolves.toEqual({ value: "early-valid" });
    expect(runAgent).toHaveBeenCalledOnce();
  });

  it("stops immediately on a checkout mutation after a completed invocation, with no further Agent call", async () => {
    const runAgent = vi.fn().mockResolvedValue(completedResult(tagged({ value: "ok" })));
    const { driver, requireUnchanged, wait } = harness(runAgent);
    requireUnchanged.mockRejectedValueOnce(
      new StopRetryError("Target Checkout changed during a read-only stage"),
    );

    const failure = await driver.extract(plan()).catch((error: unknown) => error);

    expect(isStopRetry(failure)).toBe(true);
    expect(runAgent).toHaveBeenCalledOnce();
    expect(wait).not.toHaveBeenCalled();
  });

  it("stops immediately on a checkout mutation after a rejected invocation, with no retry", async () => {
    const invocationFailure = new Error("provider stream ended");
    const runAgent = vi.fn().mockRejectedValue(invocationFailure);
    const { driver, requireUnchanged, wait } = harness(runAgent);
    requireUnchanged.mockRejectedValueOnce(
      new StopRetryError("Target Checkout changed during a read-only stage"),
    );

    const failure = await driver.extract(plan()).catch((error: unknown) => error);

    expect(isStopRetry(failure)).toBe(true);
    expect(failure).not.toBe(invocationFailure);
    expect(runAgent).toHaveBeenCalledOnce();
    expect(wait).not.toHaveBeenCalled();
  });

  it("refuses a checkout that is not clean before any Agent call", async () => {
    const runAgent = vi.fn();
    const { driver, requireClean } = harness(runAgent);
    requireClean.mockRejectedValueOnce(
      new StopRetryError("Target Checkout is not clean (staged=0, unstaged=1, unmerged=0, untracked=0)"),
    );

    const failure = await driver.extract(plan()).catch((error: unknown) => error);

    expect(isStopRetry(failure)).toBe(true);
    expect(runAgent).not.toHaveBeenCalled();
  });

  it("never starts an Agent call when the cancellation signal is already aborted", async () => {
    const runAgent = vi.fn();
    const { driver } = harness(runAgent);
    const controller = new AbortController();
    controller.abort(new Error("operation timed out"));

    await expect(
      driver.extract(plan({ signal: controller.signal })),
    ).rejects.toThrow("operation timed out");
    expect(runAgent).not.toHaveBeenCalled();
  });

  it("keeps raw matched output out of the bounded exhaustion diagnostic", async () => {
    const runAgent = vi.fn().mockResolvedValue(
      completedResult("<result>raw secret payload</result>"),
    );
    const { driver } = harness(runAgent);

    const failure = await driver.extract(plan()).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(StructuredOutputError);
    const classified = failure as StructuredOutputError;
    expect(classified.message).toContain("last parse detail:");
    expect(classified.message).not.toContain("raw secret payload");
    expect(classified.rawMatched).toBeUndefined();
  });
});

describe("structuredCorrectionPrompt", () => {
  it("states the failure kind, the attempt ordinal, and the read-only contract", () => {
    const prompt = structuredCorrectionPrompt({
      tag: "plan",
      kind: "invalid-json",
      nextStructuredOrdinal: 2,
      readOnlyContract: READ_ONLY_CONTRACT,
    });
    expect(prompt).toContain("the <plan> block did not contain valid JSON");
    expect(prompt).toContain(`structured attempt 2 of ${MAX_STRUCTURED_ATTEMPTS}`);
    expect(prompt).toContain(READ_ONLY_CONTRACT);
  });
});

describe("structuredFailureKind", () => {
  it("maps the shared classifier messages to repository-owned kinds", () => {
    const make = (message: string) => new StructuredOutputError(message, {
      tag: "result",
      rawMatched: undefined,
      commits: [],
      branch: "",
    });
    expect(structuredFailureKind(make("Structured output tag <result> not found in agent output")))
      .toBe("missing-tag");
    expect(structuredFailureKind(make("Structured output tag <result> contains invalid JSON")))
      .toBe("invalid-json");
    expect(structuredFailureKind(make("Structured output tag <result> failed schema validation")))
      .toBe("schema-invalid");
  });
});

// Real temporary-Git fixtures: the checkout observer runs for real against a
// disposable repository, proving unchanged HEAD/porcelain state after success
// and rejection, and immediate fail-closed behavior on injected mutation.
describe("structured extraction driver checkout observation (real Git)", () => {
  function git(repository: string, arguments_: readonly string[]): string {
    return execFileSync(
      "git",
      ["-c", "user.name=test", "-c", "user.email=test@example.test", ...arguments_],
      { cwd: repository, encoding: "utf8" },
    );
  }

  function initRepository(): string {
    const repository = mkdtempSync(join(tmpdir(), "structured-driver-git-"));
    git(repository, ["init", "--quiet", "--initial-branch=main"]);
    writeFileSync(join(repository, "tracked.txt"), "initial\n");
    git(repository, ["add", "tracked.txt"]);
    git(repository, ["commit", "--quiet", "-m", "initial"]);
    return repository;
  }

  function porcelainState(repository: string): string {
    return git(repository, [
      "status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all",
    ]);
  }

  function realGitHarness(runAgent: ReturnType<typeof vi.fn>, checkoutPath: string) {
    const wait = vi.fn(async () => {});
    const driver = createStructuredExtractionDriver({
      sandbox,
      hooks,
      checkoutPath,
      role: "planner",
      stage: "structured-extraction",
      observer: createCheckoutObserver(),
      wait,
      runAgent: runAgent as never,
      createAgent: vi.fn().mockReturnValue({ name: "fake-agent" }) as never,
    });
    return { driver, wait };
  }

  it("leaves HEAD and porcelain state unchanged after a successful extraction", async () => {
    const repository = initRepository();
    const headBefore = git(repository, ["rev-parse", "HEAD"]);
    const statusBefore = porcelainState(repository);
    const runAgent = vi.fn().mockResolvedValue(completedResult(tagged({ value: "ok" })));
    const { driver } = realGitHarness(runAgent, repository);

    await expect(driver.extract(plan())).resolves.toEqual({ value: "ok" });

    expect(runAgent).toHaveBeenCalledOnce();
    expect(runAgent.mock.calls[0]![0].cwd).toBe(repository);
    expect(git(repository, ["rev-parse", "HEAD"])).toBe(headBefore);
    expect(porcelainState(repository)).toBe(statusBefore);
  });

  it("leaves HEAD and porcelain state unchanged across a rejected invocation and its recovery", async () => {
    const repository = initRepository();
    const headBefore = git(repository, ["rev-parse", "HEAD"]);
    const statusBefore = porcelainState(repository);
    const runAgent = vi.fn()
      .mockRejectedValueOnce(new Error(forbiddenHtml))
      .mockResolvedValueOnce(completedResult(tagged({ value: "recovered" })));
    const { driver } = realGitHarness(runAgent, repository);

    await expect(driver.extract(plan())).resolves.toEqual({ value: "recovered" });

    expect(runAgent).toHaveBeenCalledTimes(2);
    expect(git(repository, ["rev-parse", "HEAD"])).toBe(headBefore);
    expect(porcelainState(repository)).toBe(statusBefore);
  });

  it("fails closed immediately when a completed invocation mutates the checkout", async () => {
    const repository = initRepository();
    const runAgent = vi.fn().mockImplementation(() => {
      writeFileSync(join(repository, "mutated.txt"), "agent wrote this\n");
      return Promise.resolve(completedResult(tagged({ value: "ok" })));
    });
    const { driver, wait } = realGitHarness(runAgent, repository);

    const failure = await driver.extract(plan()).catch((error: unknown) => error);

    expect(isStopRetry(failure)).toBe(true);
    expect((failure as Error).message).toContain(
      "Target Checkout changed during a read-only stage",
    );
    expect(runAgent).toHaveBeenCalledOnce();
    expect(wait).not.toHaveBeenCalled();
  });

  it("fails closed immediately when a rejected invocation mutates the checkout", async () => {
    const repository = initRepository();
    const runAgent = vi.fn().mockImplementation(() => {
      writeFileSync(join(repository, "mutated.txt"), "agent wrote this\n");
      return Promise.reject(new Error("provider stream ended"));
    });
    const { driver, wait } = realGitHarness(runAgent, repository);

    const failure = await driver.extract(plan()).catch((error: unknown) => error);

    expect(isStopRetry(failure)).toBe(true);
    expect(runAgent).toHaveBeenCalledOnce();
    expect(wait).not.toHaveBeenCalled();
  });

  it("refuses a dirty checkout before any Agent call", async () => {
    const repository = initRepository();
    writeFileSync(join(repository, "dirty.txt"), "pre-existing local change\n");
    const runAgent = vi.fn();
    const { driver } = realGitHarness(runAgent, repository);

    const failure = await driver.extract(plan()).catch((error: unknown) => error);

    expect(isStopRetry(failure)).toBe(true);
    expect((failure as Error).message).toContain("Target Checkout is not clean");
    expect(runAgent).not.toHaveBeenCalled();
  });
});
