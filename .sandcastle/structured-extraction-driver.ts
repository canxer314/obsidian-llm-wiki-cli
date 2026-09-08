import {
  claudeCode,
  run,
  type LoggingOption,
  type RunResult,
  type SandboxHooks,
  type SandboxProvider,
  type StructuredOutputError,
} from "@ai-hero/sandcastle";
import type { z } from "zod";

import {
  createCheckoutObserver,
  type CheckoutObserver,
} from "./checkout-safety.ts";
import {
  StopRetryError,
  invokeWithRecovery,
  isStopRetry,
} from "./invocation-recovery.ts";
import { appendJobOutput, type JobLog } from "./job-logs.ts";
import { redact } from "./redaction.ts";
import {
  STRUCTURED_EXTRACTION_ATTEMPTS,
  classifyStructuredOutputError,
  extractFromStdout,
  structuredExtractionExhaustionError,
} from "./same-session-structured-extraction.ts";

// Repository-owned structured extraction driver (Spec #449). One logical
// structured stage owns at most STRUCTURED_EXTRACTION_ATTEMPTS completed
// structured attempts, and every structured attempt runs inside one bounded
// invocation recovery window (MAX_INVOCATION_ATTEMPTS sequential invocation
// attempts). An invocation rejection never consumes a structured attempt; a
// completed response whose tagged payload is missing, invalid JSON, or
// schema-invalid consumes exactly one. The normative ceiling for one stage is
// therefore nine Agent executions.
//
// Structured parse handoff and structured exhaustion never pass through
// generic invocation retry: the handoff leaves the window as the controlled
// stop-retry sentinel, so it cannot create or reset another invocation
// budget. Final exhaustion surfaces the bounded
// structuredExtractionExhaustionError diagnostic and follows the existing
// operation failure path.
//
// No attempt arms the library's recursive output retry: run calls never carry
// an `output` definition (stronger than maxRetries: 0 — there is nothing for
// the library to retry), and the driver extracts from the run's stdout itself
// with the shared multi-block candidate semantics, so an earlier valid tagged
// block is still accepted when a later block is malformed.
//
// The driver enforces the role's read-only contract with the checkout
// observer: the Target Checkout must be clean before structured attempt one,
// the initial HEAD is frozen, and unchanged state is proven after both
// successful and rejected invocations. Any mutation or observer failure
// raises the stop-retry sentinel immediately — no reset and no further Agent
// call.

export const MAX_STRUCTURED_ATTEMPTS = STRUCTURED_EXTRACTION_ATTEMPTS;

// A resumable session checkpoint captured from a completed response. Only a
// completed invalid response can advance the checkpoint; invocation
// rejections carry no completed session and never touch it. A stage that
// follows a substantive produce stage (the Reviewer's formatting stage) hands
// its frozen produce checkpoint in with the plan so structured attempt one
// resumes the produce session instead of starting a fresh Agent run.
export interface StructuredExtractionCheckpoint {
  readonly resume: NonNullable<RunResult["resume"]>;
}

// Internal alias kept for the handoff payload below.
type SessionCheckpoint = StructuredExtractionCheckpoint;

export type StructuredFailureKind = "missing-tag" | "invalid-json" | "schema-invalid";

// The classified parse failures raised by the shared extraction layer map to
// exactly three repository-owned kinds. The kind is derived from the
// classifier's own fixed messages, never from raw provider output.
export function structuredFailureKind(error: StructuredOutputError): StructuredFailureKind {
  if (error.message.includes("not found in agent output")) return "missing-tag";
  if (error.message.includes("contains invalid JSON")) return "invalid-json";
  return "schema-invalid";
}

// The controlled handoff that carries a completed-but-unusable structured
// response out of the invocation recovery window. As a stop-retry sentinel it
// bypasses generic invocation retry: the window stops at once, the structured
// budget (not the invocation budget) absorbs the failure, and no invocation
// budget is created or reset by the handoff.
class StructuredAttemptHandoff extends StopRetryError {
  readonly classified: StructuredOutputError;
  readonly checkpoint: SessionCheckpoint | undefined;
  constructor(classified: StructuredOutputError, checkpoint: SessionCheckpoint | undefined) {
    super(`structured attempt completed without a usable <${classified.tag}> block`);
    this.name = "StructuredAttemptHandoff";
    this.classified = classified;
    this.checkpoint = checkpoint;
  }
}

function checkpointOf(result: RunResult): SessionCheckpoint | undefined {
  return result.resume === undefined ? undefined : { resume: result.resume };
}

function sessionIdOf(result: RunResult): string | undefined {
  return result.iterations?.at(-1)?.sessionId;
}

const FAILURE_KIND_PROBLEM: Readonly<Record<StructuredFailureKind, string>> = {
  "missing-tag": "no <{tag}> block was present in the response",
  "invalid-json": "the <{tag}> block did not contain valid JSON",
  "schema-invalid": "the <{tag}> block did not match the required schema",
};

// The format-correction prompt for a resumed checkpoint. It states the
// repository-owned failure kind and repeats the role's strict read-only
// contract verbatim; it never embeds raw provider errors, matched output,
// stdout, or transcript text.
export function structuredCorrectionPrompt(options: {
  readonly tag: string;
  readonly kind: StructuredFailureKind;
  readonly nextStructuredOrdinal: number;
  readonly readOnlyContract: string;
}): string {
  const problem = FAILURE_KIND_PROBLEM[options.kind].split("<{tag}>").join(`<${options.tag}>`);
  return `Your previous response did not produce a usable structured result: ${problem}. ` +
    `This is structured attempt ${options.nextStructuredOrdinal} of ${MAX_STRUCTURED_ATTEMPTS}.\n\n` +
    `Emit exactly one corrected <${options.tag}> block containing one JSON object that ` +
    `matches the required schema, and nothing else inside the tags.\n\n` +
    options.readOnlyContract;
}

export interface StructuredExtractionPlan<Output> {
  readonly model: string;
  readonly name: string;
  // The complete initial prompt, used for structured attempt one and for any
  // later structured attempt when no resumable checkpoint exists.
  readonly initialPrompt: string;
  // The role's strict read-only contract, repeated verbatim in every
  // format-correction prompt.
  readonly readOnlyContract: string;
  readonly logging?: LoggingOption;
  // An optional resumable checkpoint captured by a prior produce stage. When
  // present, structured attempt one resumes it with the initial prompt; a
  // completed invalid response still advances it like any other checkpoint.
  readonly checkpoint?: StructuredExtractionCheckpoint;
  readonly output: {
    readonly tag: string;
    readonly schema: z.ZodType<Output>;
  };
  readonly signal?: AbortSignal;
}

export interface StructuredExtractionDriverOptions {
  readonly sandbox: SandboxProvider;
  readonly hooks: SandboxHooks;
  // The Target Checkout the stage runs against. Required: the read-only
  // contract is enforced by observing this path.
  readonly checkoutPath: string;
  readonly role: string;
  readonly stage: string;
  readonly observer?: CheckoutObserver;
  readonly log?: JobLog;
  readonly runAgent?: typeof run;
  readonly createAgent?: typeof claudeCode;
  readonly now?: () => number;
  readonly wait?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
}

function appendDriverEntry(log: JobLog | undefined, entry: Readonly<Record<string, unknown>>): void {
  if (log === undefined) return;
  // Every logged value is repository-owned metadata that has passed through
  // pattern redaction; raw responses and provider errors never reach the log.
  const sanitized = Object.fromEntries(
    Object.entries(entry).map(([key, value]) => [
      key,
      typeof value === "string" ? redact(value) : value,
    ]),
  );
  appendJobOutput(log, "stderr", `[structured-extraction] ${JSON.stringify(sanitized)}\n`);
}

export function createStructuredExtractionDriver(options: StructuredExtractionDriverOptions) {
  const observer = options.observer ?? createCheckoutObserver();
  const runAgent = options.runAgent ?? run;
  const createAgent = options.createAgent ?? claudeCode;

  return {
    async extract<Output>(plan: StructuredExtractionPlan<Output>): Promise<Output> {
      // The checkout must be clean before structured attempt one; a dirty,
      // missing, or unobservable checkout raises the controlled stop-retry
      // outcome before any Agent call. The returned snapshot freezes the
      // initial HEAD and status that every later observation compares against.
      const frozen = await observer.requireClean(options.checkoutPath);

      // The resumable checkpoint and the latest classified parse failure are
      // tracked separately. The checkpoint starts from the plan's optional
      // produce-stage checkpoint; a completed invalid response that carries a
      // resumable session checkpoint advances it, otherwise the prior usable
      // checkpoint is retained. The classified failure selects the
      // format-correction prompt; with no checkpoint the next structured
      // attempt starts a new complete prompt.
      let checkpoint: SessionCheckpoint | undefined = plan.checkpoint;
      let classified: StructuredOutputError | undefined;

      for (
        let structuredOrdinal = 1;
        structuredOrdinal <= MAX_STRUCTURED_ATTEMPTS;
        structuredOrdinal += 1
      ) {
        const prompt = classified === undefined || checkpoint === undefined
          ? plan.initialPrompt
          : structuredCorrectionPrompt({
              tag: plan.output.tag,
              kind: structuredFailureKind(classified),
              nextStructuredOrdinal: structuredOrdinal,
              readOnlyContract: plan.readOnlyContract,
            });

        try {
          return await invokeWithRecovery(async () => {
            let result: RunResult;
            try {
              // No `output` definition is handed to the library on any
              // attempt: Sandcastle's recursive output retry stays disabled
              // and the driver owns every structured attempt with the same
              // model, sandbox, hooks, head branch strategy, schema, and
              // prompt.
              const session = checkpoint;
              result = session === undefined
                ? await runAgent({
                    agent: createAgent(plan.model),
                    sandbox: options.sandbox,
                    hooks: options.hooks,
                    cwd: options.checkoutPath,
                    branchStrategy: { type: "head" },
                    maxIterations: 1,
                    name: plan.name,
                    ...(plan.logging === undefined ? {} : { logging: plan.logging }),
                    ...(plan.signal === undefined ? {} : { signal: plan.signal }),
                    prompt,
                  })
                : await session.resume(prompt, {
                    ...(plan.logging === undefined ? {} : { logging: plan.logging }),
                    ...(plan.signal === undefined ? {} : { signal: plan.signal }),
                  });
            } catch (failure) {
              if (isStopRetry(failure)) throw failure;
              // A rejected invocation still has to prove the read-only
              // contract held before another bounded invocation attempt runs.
              await observer.requireUnchanged(frozen, options.checkoutPath);
              throw failure;
            }
            await observer.requireUnchanged(frozen, options.checkoutPath);
            try {
              return await extractFromStdout(result, plan.output.tag, plan.output.schema);
            } catch (failure) {
              const classified = classifyStructuredOutputError(failure, {
                tag: plan.output.tag,
                ...(sessionIdOf(result) === undefined
                  ? {}
                  : { sessionId: sessionIdOf(result) as string }),
              });
              if (classified === undefined) throw failure;
              // The completed response was unusable: leave the window through
              // the controlled handoff so exactly one structured attempt is
              // consumed and no invocation attempt is spent on a parse fault.
              throw new StructuredAttemptHandoff(classified, checkpointOf(result));
            }
          }, {
            role: options.role,
            // The window entries carry the structured ordinal in their stage
            // so the Job Log records structured and invocation ordinals
            // alongside the delay class for every bounded retry.
            stage: `${options.stage} structured ${structuredOrdinal}`,
            ...(options.log === undefined ? {} : { log: options.log }),
            ...(plan.signal === undefined ? {} : { signal: plan.signal }),
            ...(options.now === undefined ? {} : { now: options.now }),
            ...(options.wait === undefined ? {} : { wait: options.wait }),
          });
        } catch (failure) {
          if (!(failure instanceof StructuredAttemptHandoff)) {
            // Invocation exhaustion rethrows the last invocation failure
            // unchanged; mutation, observer failure, and cancellation
            // propagate as raised. All follow the existing operation failure
            // path.
            throw failure;
          }
          const advanced = failure.checkpoint !== undefined;
          checkpoint = failure.checkpoint ?? checkpoint;
          classified = failure.classified;
          appendDriverEntry(options.log, {
            role: options.role,
            stage: options.stage,
            structuredAttempt: structuredOrdinal,
            outcome: "invalid",
            failureKind: structuredFailureKind(failure.classified),
            checkpoint: advanced ? "advanced" : checkpoint === undefined ? "none" : "retained",
          });
          if (structuredOrdinal === MAX_STRUCTURED_ATTEMPTS) {
            appendDriverEntry(options.log, {
              role: options.role,
              stage: options.stage,
              structuredAttempts: MAX_STRUCTURED_ATTEMPTS,
              outcome: "exhausted",
            });
            throw structuredExtractionExhaustionError(failure.classified);
          }
        }
      }
      // Unreachable: the loop either returns a validated payload or throws.
      throw new Error("Structured extraction attempts were exhausted");
    },
  };
}
