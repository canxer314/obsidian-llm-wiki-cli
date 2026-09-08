import { appendJobOutput, type JobLog } from "./job-logs.ts";
import { redact } from "./redaction.ts";

// Bounded Agent invocation recovery kernel (Spec #449). One invocation
// recovery window allows a logical Agent stage at most three sequential
// attempts. Eligibility never depends on error text: every invocation
// rejection may receive another bounded attempt unless an available
// AbortSignal is already aborted or repository code raises the controlled
// stop-retry sentinel. Production Agent adapters do not use this helper yet;
// each role opts in only together with its state guards and postconditions.

export const MAX_INVOCATION_ATTEMPTS = 3;

const ORDINARY_RETRY_DELAYS_MILLISECONDS = [2_000, 8_000] as const;
const RATE_LIMIT_FALLBACK_DELAY_MILLISECONDS = 60_000;
const RATE_LIMIT_MAX_DELAY_MILLISECONDS = 15 * 60 * 1_000;
const MAX_RATE_LIMIT_CAUSE_DEPTH = 16;

// The controlled stop-retry sentinel is a narrow repository-owned type. It
// never depends on Sandcastle private classes or message matching, and it is
// the only repository-raised outcome besides real cancellation that stops a
// recovery window before exhaustion.
export class StopRetryError extends Error {
  constructor(summary: string) {
    super(summary);
    this.name = "StopRetryError";
  }
}

export function isStopRetry(failure: unknown): failure is StopRetryError {
  return failure instanceof StopRetryError;
}

export interface InvocationAttemptContext {
  // One-based ordinal of the invocation attempt about to run.
  readonly ordinal: number;
  // Whether this attempt is a recovery attempt (ordinal above one).
  readonly recovery: boolean;
}

export type InvocationRecoveryDelayClass = "ordinary" | "rate-limit";

export interface InvocationRecoveryDelay {
  readonly delayClass: InvocationRecoveryDelayClass;
  readonly milliseconds: number;
}

export interface InvocationRecoveryOptions {
  readonly role: string;
  readonly stage: string;
  readonly signal?: AbortSignal;
  readonly log?: JobLog;
  readonly now?: () => number;
  readonly wait?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
}

function requireLabel(value: unknown, kind: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Invocation recovery ${kind} is invalid`);
  }
  return value;
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error("Invocation recovery was aborted");
}

// The default backoff wait honors an available cancellation signal: it
// rejects immediately when the signal is already aborted and rejects as soon
// as the signal aborts mid-wait. A rejected wait propagates to the caller
// unchanged and neither consumes nor creates an invocation attempt.
export function waitForInvocationBackoff(
  milliseconds: number,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(abortReason(signal));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    // A pending backoff must never keep the process alive on its own.
    timer.unref?.();
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(abortReason(signal as AbortSignal));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

type HeaderSource =
  | { readonly get: (name: string) => string | null }
  | Readonly<Record<string, unknown>>
  | readonly (readonly [string, string])[];

function readHeader(source: unknown, name: string): string | undefined {
  if (typeof source !== "object" || source === null) return undefined;
  const candidate = source as HeaderSource;
  if (typeof (candidate as { get?: unknown }).get === "function") {
    const value = (candidate as { get: (name: string) => string | null }).get(name);
    return value === null ? undefined : value;
  }
  if (Array.isArray(candidate)) {
    for (const entry of candidate) {
      if (
        Array.isArray(entry) && entry.length === 2 &&
        typeof entry[0] === "string" && typeof entry[1] === "string" &&
        entry[0].toLowerCase() === name
      ) {
        return entry[1];
      }
    }
    return undefined;
  }
  const record = candidate as Readonly<Record<string, unknown>>;
  for (const key of Object.keys(record)) {
    if (key.toLowerCase() !== name) continue;
    const value = record[key];
    if (typeof value === "string") return value;
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
    return undefined;
  }
  return undefined;
}

function headerSourcesOf(failure: object): readonly unknown[] {
  const record = failure as Readonly<Record<string, unknown>>;
  const response = record.response;
  return [
    record.headers,
    typeof response === "object" && response !== null
      ? (response as Readonly<Record<string, unknown>>).headers
      : undefined,
  ];
}

function statusOf(failure: object): unknown {
  const record = failure as Readonly<Record<string, unknown>>;
  return record.status ?? record.statusCode;
}

// A Retry-After hint is an explicit positive seconds count or a valid future
// HTTP date. Anything else (missing, malformed, past, or non-positive) is not
// a usable delay.
function retryAfterDelayMilliseconds(value: string, now: number): number | undefined {
  if (/^\d+$/u.test(value.trim())) {
    const seconds = Number(value.trim());
    return seconds > 0 ? seconds * 1_000 : undefined;
  }
  const date = Date.parse(value);
  if (!Number.isNaN(date) && date > now) return date - now;
  return undefined;
}

// An x-ratelimit-reset hint is a future Unix-seconds timestamp.
function rateLimitResetDelayMilliseconds(value: string, now: number): number | undefined {
  if (!/^\d+$/u.test(value.trim())) return undefined;
  const at = Number(value.trim()) * 1_000;
  return at > now ? at - now : undefined;
}

// Rate-limit inspection walks only the in-memory error/cause chain and reads
// structured hints; it never stringifies the failure and never writes raw
// exceptions, provider bodies, headers, URLs, transcripts, or credentials
// anywhere. A valid future hint is used as-is up to fifteen minutes. Missing,
// invalid, past, or non-positive hints on a rate-limited failure fall back to
// sixty seconds.
export function rateLimitDelayMilliseconds(
  failure: unknown,
  now: number,
): number | undefined {
  let current: unknown = failure;
  let rateLimited = false;
  for (let depth = 0; depth < MAX_RATE_LIMIT_CAUSE_DEPTH; depth += 1) {
    if (typeof current !== "object" || current === null) break;
    for (const source of headerSourcesOf(current)) {
      const retryAfter = readHeader(source, "retry-after");
      if (retryAfter !== undefined) {
        rateLimited = true;
        const delay = retryAfterDelayMilliseconds(retryAfter, now);
        if (delay !== undefined) {
          return Math.min(delay, RATE_LIMIT_MAX_DELAY_MILLISECONDS);
        }
      }
      const reset = readHeader(source, "x-ratelimit-reset");
      if (reset !== undefined) {
        rateLimited = true;
        const delay = rateLimitResetDelayMilliseconds(reset, now);
        if (delay !== undefined) {
          return Math.min(delay, RATE_LIMIT_MAX_DELAY_MILLISECONDS);
        }
      }
    }
    if (statusOf(current) === 429) rateLimited = true;
    current = (current as Readonly<Record<string, unknown>>).cause;
  }
  return rateLimited ? RATE_LIMIT_FALLBACK_DELAY_MILLISECONDS : undefined;
}

// Ordinary failures wait two seconds before attempt two and eight seconds
// before attempt three. A failure carrying rate-limit hints instead receives
// the bounded rate-limit delay.
export function selectRecoveryDelay(
  failure: unknown,
  failedOrdinal: number,
  now: number,
): InvocationRecoveryDelay {
  const rateLimit = rateLimitDelayMilliseconds(failure, now);
  if (rateLimit !== undefined) {
    return { delayClass: "rate-limit", milliseconds: rateLimit };
  }
  const ordinary = ORDINARY_RETRY_DELAYS_MILLISECONDS[failedOrdinal - 1];
  if (ordinary === undefined) {
    throw new Error("Invocation recovery delay ordinal is invalid");
  }
  return { delayClass: "ordinary", milliseconds: ordinary };
}

function appendRecoveryEntry(log: JobLog | undefined, entry: Readonly<Record<string, unknown>>): void {
  if (log === undefined) return;
  // Every logged value is repository-owned metadata that has passed through
  // pattern redaction; raw exception text never reaches the retry log.
  const sanitized = Object.fromEntries(
    Object.entries(entry).map(([key, value]) => [
      key,
      typeof value === "string" ? redact(value) : value,
    ]),
  );
  appendJobOutput(log, "stderr", `[invocation-recovery] ${JSON.stringify(sanitized)}\n`);
}

// Runs one logical Agent stage with at most three sequential invocation
// attempts. Each callback receives its invocation ordinal and recovery
// status. Final exhaustion rethrows the last invocation failure unchanged;
// no raw failure is ever aggregated into a new diagnostic or written to the
// retry log.
export async function invokeWithRecovery<TResult>(
  invoke: (context: InvocationAttemptContext) => Promise<TResult>,
  options: InvocationRecoveryOptions,
): Promise<TResult> {
  const role = requireLabel(options.role, "role");
  const stage = requireLabel(options.stage, "stage");
  const now = options.now ?? (() => Date.now());
  const wait = options.wait ?? waitForInvocationBackoff;
  let lastFailure: unknown;
  for (let ordinal = 1; ordinal <= MAX_INVOCATION_ATTEMPTS; ordinal += 1) {
    if (options.signal?.aborted === true) {
      // Real cancellation stops the window immediately. An error merely
      // named AbortError never triggers this path; only the signal does.
      throw lastFailure ?? abortReason(options.signal);
    }
    try {
      return await invoke({ ordinal, recovery: ordinal > 1 });
    } catch (failure) {
      if (isStopRetry(failure)) {
        appendRecoveryEntry(options.log, {
          role, stage, attempt: ordinal, outcome: "stopped",
          reason: failure.message,
        });
        throw failure;
      }
      lastFailure = failure;
      if (ordinal === MAX_INVOCATION_ATTEMPTS) {
        appendRecoveryEntry(options.log, {
          role, stage, attempt: ordinal,
          attempts: MAX_INVOCATION_ATTEMPTS, outcome: "exhausted",
        });
        throw failure;
      }
    }
    const delay = selectRecoveryDelay(lastFailure, ordinal, now());
    appendRecoveryEntry(options.log, {
      role, stage, attempt: ordinal, nextAttempt: ordinal + 1,
      delayClass: delay.delayClass, delayMilliseconds: delay.milliseconds,
    });
    // A failed wait propagates immediately; it neither consumes nor creates
    // an invocation attempt.
    await wait(delay.milliseconds, options.signal);
  }
  throw lastFailure;
}
