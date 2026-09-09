import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  invokeWithRecovery,
  isStopRetry,
  MAX_INVOCATION_ATTEMPTS,
  rateLimitDelayMilliseconds,
  selectRecoveryDelay,
  StopRetryError,
  type InvocationAttemptContext,
} from "../.sandcastle/invocation-recovery.js";
import { createJobLog, type JobLog } from "../.sandcastle/job-logs.js";

const revision = "0123456789abcdef0123456789abcdef01234567";

async function newJobLog(): Promise<JobLog> {
  const root = mkdtempSync(join(tmpdir(), "invocation-recovery-logs-"));
  return createJobLog({
    root,
    jobId: "job-1",
    operation: "implement-issue",
    revision,
    now: 1_000,
  });
}

function stderrOf(log: JobLog): string {
  return readFileSync(log.stderrPath, "utf8");
}

const instantWait = vi.fn(async () => {});

function rateLimitedError(options?: {
  readonly headers?: unknown;
  readonly status?: number;
  readonly cause?: unknown;
}): Error {
  const failure = new Error("provider rejected the invocation");
  if (options?.headers !== undefined) {
    Object.defineProperty(failure, "headers", { value: options.headers });
  }
  if (options?.status !== undefined) {
    Object.defineProperty(failure, "status", { value: options.status });
  }
  if (options?.cause !== undefined) {
    Object.defineProperty(failure, "cause", { value: options.cause });
  }
  return failure;
}

// The redacted #44-style regression fixture: a 403 HTML gateway page with
// credential-shaped and URL-shaped content that must never reach retry logs.
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

describe("invokeWithRecovery bounded attempts", () => {
  it("succeeds on the first attempt with ordinal one and no recovery status", async () => {
    const contexts: InvocationAttemptContext[] = [];
    const result = await invokeWithRecovery(async (context) => {
      contexts.push(context);
      return "ok";
    }, { role: "planner", stage: "plan", wait: instantWait });

    expect(result).toBe("ok");
    expect(contexts).toEqual([{ ordinal: 1, recovery: false }]);
  });

  it.each([
    ["#44-style redacted 403 HTML gateway response", () => new Error(forbiddenHtml)],
    ["authentication failure", () => Object.assign(new Error("HTTP 401 authentication failed"), { status: 401 })],
    ["400 bad request", () => Object.assign(new Error("HTTP 400 invalid request"), { status: 400 })],
    ["404 not found", () => Object.assign(new Error("HTTP 404 model not found"), { status: 404 })],
    ["sandbox startup failure", () => new Error("sandbox container failed to start")],
    ["hook failure", () => new Error("PreToolUse hook blocked the command")],
    ["generic provider failure", () => new Error("provider stream ended unexpectedly")],
  ])("gives the %s the same bounded attempt policy without leaking its raw message", async (_label, raise) => {
    const log = await newJobLog();
    const contexts: InvocationAttemptContext[] = [];
    const result = await invokeWithRecovery(async (context) => {
      contexts.push(context);
      if (context.ordinal === 1) throw raise();
      return "recovered";
    }, { role: "planner", stage: "plan", log, wait: instantWait });

    expect(result).toBe("recovered");
    expect(contexts).toEqual([
      { ordinal: 1, recovery: false },
      { ordinal: 2, recovery: true },
    ]);
    const stderr = stderrOf(log);
    expect(stderr).toContain("[invocation-recovery]");
    expect(stderr).toContain("\"attempt\":1");
    expect(stderr).toContain("\"nextAttempt\":2");
    expect(stderr).toContain("\"delayClass\":\"ordinary\"");
    expect(stderr).toContain("\"delayMilliseconds\":2000");
    for (const secret of [...forbiddenSecrets, "HTTP 401", "HTTP 400", "HTTP 404",
      "sandbox container", "PreToolUse", "provider stream"]) {
      expect(stderr).not.toContain(secret);
    }
  });

  it("makes at most three sequential attempts and rethrows the last failure unchanged on exhaustion", async () => {
    const log = await newJobLog();
    const events: string[] = [];
    const failures = [1, 2, 3].map((n) => new Error(`invocation failure ${n}`));
    const invoke = vi.fn(async (context: InvocationAttemptContext) => {
      events.push(`call-${context.ordinal}`);
      const failure = failures[context.ordinal - 1]!;
      events.push(`reject-${context.ordinal}`);
      throw failure;
    });

    const caught = await invokeWithRecovery(invoke, {
      role: "reviewer", stage: "review", log, wait: instantWait,
    }).catch((error: unknown) => error);

    expect(caught).toBe(failures[2]);
    expect(invoke).toHaveBeenCalledTimes(MAX_INVOCATION_ATTEMPTS);
    // Attempts are strictly sequential: each rejection settles before the
    // next call begins.
    expect(events).toEqual([
      "call-1", "reject-1", "call-2", "reject-2", "call-3", "reject-3",
    ]);
    const stderr = stderrOf(log);
    expect(stderr).toContain("\"outcome\":\"exhausted\"");
    expect(stderr).toContain("\"attempts\":3");
    for (const failure of failures) expect(stderr).not.toContain(failure.message);
  });

  it("waits two seconds before attempt two and eight seconds before attempt three", async () => {
    const wait = vi.fn(async () => {});
    const invoke = vi.fn(async () => {
      throw new Error("transient provider failure");
    });

    await expect(invokeWithRecovery(invoke, {
      role: "reviewer", stage: "review", wait,
    })).rejects.toBeInstanceOf(Error);

    expect(wait.mock.calls.map(([milliseconds]) => milliseconds)).toEqual([2_000, 8_000]);
  });

  it("stops immediately on the controlled stop-retry sentinel", async () => {
    const log = await newJobLog();
    const sentinel = new StopRetryError("Target Checkout state cannot be observed");
    const invoke = vi.fn(async () => {
      throw sentinel;
    });

    const caught = await invokeWithRecovery(invoke, {
      role: "planner", stage: "plan", log, wait: instantWait,
    }).catch((error: unknown) => error);

    expect(caught).toBe(sentinel);
    expect(isStopRetry(caught)).toBe(true);
    expect(invoke).toHaveBeenCalledTimes(1);
    const stderr = stderrOf(log);
    expect(stderr).toContain("\"outcome\":\"stopped\"");
    expect(stderr).toContain("Target Checkout state cannot be observed");
  });

  it("propagates a failed wait immediately without consuming or creating an invocation attempt", async () => {
    const waitFailure = new Error("backoff timer failed");
    const wait = vi.fn(async () => {
      throw waitFailure;
    });
    const invoke = vi.fn(async () => {
      throw new Error("transient provider failure");
    });

    const caught = await invokeWithRecovery(invoke, {
      role: "reviewer", stage: "review", wait,
    }).catch((error: unknown) => error);

    expect(caught).toBe(waitFailure);
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("requires repository-owned role and stage labels", async () => {
    await expect(invokeWithRecovery(async () => "ok", {
      role: "", stage: "plan", wait: instantWait,
    })).rejects.toThrow("Invocation recovery role is invalid");
    await expect(invokeWithRecovery(async () => "ok", {
      role: "planner", stage: "", wait: instantWait,
    })).rejects.toThrow("Invocation recovery stage is invalid");
  });
});

describe("rate-limit delay selection", () => {
  const now = 1_800_000_000_000;

  it("uses explicit positive Retry-After seconds", () => {
    expect(rateLimitDelayMilliseconds(
      rateLimitedError({ headers: { "Retry-After": "5" } }), now,
    )).toBe(5_000);
  });

  it("reads Retry-After from a Headers instance and from header entry pairs", () => {
    const headers = new Headers({ "retry-after": "7" });
    expect(rateLimitDelayMilliseconds(rateLimitedError({ headers }), now)).toBe(7_000);
    expect(rateLimitDelayMilliseconds(
      rateLimitedError({ headers: [["x-other", "1"], ["Retry-After", "9"]] }), now,
    )).toBe(9_000);
  });

  it("uses a valid future Retry-After HTTP date", () => {
    const at = new Date(now + 30_000).toUTCString();
    const delay = rateLimitDelayMilliseconds(
      rateLimitedError({ headers: { "retry-after": at } }), now,
    );
    expect(delay).toBeGreaterThan(28_000);
    expect(delay).toBeLessThanOrEqual(30_000);
  });

  it("uses a future x-ratelimit-reset Unix-seconds hint", () => {
    const reset = Math.floor((now + 45_000) / 1_000);
    expect(rateLimitDelayMilliseconds(
      rateLimitedError({ headers: { "x-ratelimit-reset": String(reset) } }), now,
    )).toBe(45_000 - (now % 1_000));
  });

  it("caps a valid future hint at fifteen minutes", () => {
    expect(rateLimitDelayMilliseconds(
      rateLimitedError({ headers: { "retry-after": "3600" } }), now,
    )).toBe(15 * 60 * 1_000);
  });

  it("falls back to sixty seconds when a rate-limited failure has no hint", () => {
    expect(rateLimitDelayMilliseconds(
      rateLimitedError({ status: 429 }), now,
    )).toBe(60_000);
    expect(rateLimitDelayMilliseconds(
      rateLimitedError({ status: 429, headers: {} }), now,
    )).toBe(60_000);
  });

  it.each([
    ["non-positive seconds", { "retry-after": "0" }],
    ["invalid seconds", { "retry-after": "soon" }],
    ["a past HTTP date", { "retry-after": new Date(now - 30_000).toUTCString() }],
    ["a past reset timestamp", { "x-ratelimit-reset": String(Math.floor((now - 30_000) / 1_000)) }],
    ["a malformed reset timestamp", { "x-ratelimit-reset": "not-a-number" }],
  ])("falls back to sixty seconds for %s on a rate-limited failure", (_label, headers) => {
    expect(rateLimitDelayMilliseconds(
      rateLimitedError({ status: 429, headers }), now,
    )).toBe(60_000);
  });

  it("follows the in-memory cause chain to find a hint", () => {
    const inner = rateLimitedError({ headers: { "retry-after": "12" } });
    const outer = new Error("provider invocation failed");
    Object.defineProperty(outer, "cause", { value: inner });
    expect(rateLimitDelayMilliseconds(outer, now)).toBe(12_000);
  });

  it("never inspects error text for rate-limit eligibility", () => {
    const textual = new Error("rate limit exceeded, retry-after: 5");
    expect(rateLimitDelayMilliseconds(textual, now)).toBeUndefined();
    expect(selectRecoveryDelay(textual, 1, now)).toEqual({
      delayClass: "ordinary", milliseconds: 2_000,
    });
  });

  it("selects ordinary delays for failures without rate-limit signals", () => {
    const failure = new Error("generic provider failure");
    expect(selectRecoveryDelay(failure, 1, now)).toEqual({
      delayClass: "ordinary", milliseconds: 2_000,
    });
    expect(selectRecoveryDelay(failure, 2, now)).toEqual({
      delayClass: "ordinary", milliseconds: 8_000,
    });
    expect(selectRecoveryDelay("a non-Error rejection", 1, now)).toEqual({
      delayClass: "ordinary", milliseconds: 2_000,
    });
  });

  it("logs the rate-limit delay class and bounded delay without raw failure text", async () => {
    const log = await newJobLog();
    const wait = vi.fn(async () => {});
    const failure = rateLimitedError({ headers: { "retry-after": "30" } });
    failure.message = forbiddenHtml;
    const invoke = vi.fn(async (context: InvocationAttemptContext) => {
      if (context.ordinal === 1) throw failure;
      return "recovered";
    });

    await expect(invokeWithRecovery(invoke, {
      role: "planner", stage: "plan", log, wait, now: () => 1_800_000_000_000,
    })).resolves.toBe("recovered");

    expect(wait).toHaveBeenCalledWith(30_000, undefined);
    const stderr = stderrOf(log);
    expect(stderr).toContain("\"delayClass\":\"rate-limit\"");
    expect(stderr).toContain("\"delayMilliseconds\":30000");
    for (const secret of forbiddenSecrets) expect(stderr).not.toContain(secret);
  });
});

describe("cancellation", () => {
  it("retries an error merely named AbortError while the signal remains active", async () => {
    const controller = new AbortController();
    const named = new Error("the provider aborted the stream");
    named.name = "AbortError";
    const contexts: InvocationAttemptContext[] = [];

    const result = await invokeWithRecovery(async (context) => {
      contexts.push(context);
      if (context.ordinal === 1) throw named;
      return "recovered";
    }, { role: "reviewer", stage: "review", signal: controller.signal, wait: instantWait });

    expect(result).toBe("recovered");
    expect(contexts).toHaveLength(2);
  });

  it("never starts an attempt when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const invoke = vi.fn(async () => "ok");

    const caught = await invokeWithRecovery(invoke, {
      role: "planner", stage: "plan", signal: controller.signal, wait: instantWait,
    }).catch((error: unknown) => error);

    expect(invoke).not.toHaveBeenCalled();
    expect((caught as Error).name).toBe("AbortError");
  });

  it("prevents the next call when the signal aborts after a failure", async () => {
    const controller = new AbortController();
    const failure = new Error("transient provider failure");
    const invoke = vi.fn(async () => {
      controller.abort();
      throw failure;
    });

    const caught = await invokeWithRecovery(invoke, {
      role: "planner", stage: "plan", signal: controller.signal, wait: instantWait,
    }).catch((error: unknown) => error);

    // The wait used here ignores the signal, so the loop-top cancellation
    // guard stops the window and rethrows the last invocation failure.
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(caught).toBe(failure);
  });

  it("interrupts an in-progress backoff wait when the signal aborts", async () => {
    const controller = new AbortController();
    const invoke = vi.fn(async () => {
      setTimeout(() => controller.abort(), 20).unref();
      throw new Error("transient provider failure");
    });
    const started = Date.now();

    const caught = await invokeWithRecovery(invoke, {
      role: "planner", stage: "plan", signal: controller.signal,
    }).catch((error: unknown) => error);

    expect(invoke).toHaveBeenCalledTimes(1);
    expect((caught as Error).name).toBe("AbortError");
    // The two-second ordinary delay must have been interrupted, not awaited.
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});
