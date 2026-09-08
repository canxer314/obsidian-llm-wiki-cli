import {
  StructuredOutputError,
  claudeCode,
  run,
  type RunOptions,
  type SandboxHooks,
  type SandboxProvider,
} from "@ai-hero/sandcastle";
import type { z } from "zod";

type RunResult = Awaited<ReturnType<typeof run>>;

type ObservedResult = Pick<RunResult, "commits">;

/**
 * Total structured-output parse attempts (initial attempt plus retries) shared
 * by every extraction site. Sites that arm the library's same-session retry
 * resolve their budget as STRUCTURED_EXTRACTION_ATTEMPTS - 1 maxRetries.
 */
export const STRUCTURED_EXTRACTION_ATTEMPTS = 3;

/**
 * What the seam always knows when a structured-output run fails: the tag being
 * extracted and the session the seam would resume for a retry. A classified
 * failure inherits the tracked session when its surface form does not carry
 * one, so an armed retry is never bypassed for want of a session identity.
 */
interface StructuredOutputFailureContext {
  readonly tag: string;
  readonly sessionId?: string;
}

/**
 * Normalise any parse-shaped failure from a structured-output run into the
 * recognised recoverable StructuredOutputError before a retry guard evaluates
 * it. Returns undefined for failures that are not output/parse failures —
 * timeouts, aborts, and sandbox/execution errors — so they propagate
 * unretried and are never swallowed.
 *
 * Parse-shaped surfaces: StructuredOutputError itself (including the same
 * class from a duplicate bundle copy, which bypasses instanceof), a raw
 * SyntaxError escaping a lower JSON.parse layer (the live reviewer failure's
 * surface form), and a ZodError-shaped schema validation failure thrown
 * instead of reported.
 */
export function classifyStructuredOutputError(
  error: unknown,
  context: StructuredOutputFailureContext,
): StructuredOutputError | undefined {
  if (error instanceof StructuredOutputError) {
    if (error.sessionId !== undefined || context.sessionId === undefined) return error;
    return new StructuredOutputError(error.message, {
      tag: error.tag,
      rawMatched: error.rawMatched,
      cause: error.cause,
      commits: error.commits,
      branch: error.branch,
      ...(error.preservedWorktreePath === undefined
        ? {}
        : { preservedWorktreePath: error.preservedWorktreePath }),
      sessionId: context.sessionId,
      ...(error.sessionFilePath === undefined ? {} : { sessionFilePath: error.sessionFilePath }),
    });
  }
  if (typeof error !== "object" || error === null) return undefined;
  const shape = error as {
    readonly name?: unknown;
    readonly message?: unknown;
    readonly tag?: unknown;
    readonly rawMatched?: unknown;
    readonly cause?: unknown;
    readonly commits?: unknown;
    readonly branch?: unknown;
    readonly issues?: unknown;
  };
  if (shape.name === "StructuredOutputError" && typeof shape.tag === "string") {
    const structured = error as Partial<StructuredOutputError>;
    return new StructuredOutputError(
      typeof shape.message === "string"
        ? shape.message
        : `Structured output tag <${shape.tag}> could not be extracted`,
      {
        tag: shape.tag,
        rawMatched: typeof shape.rawMatched === "string" ? shape.rawMatched : undefined,
        cause: shape.cause,
        commits: Array.isArray(shape.commits) ? shape.commits as { sha: string }[] : [],
        branch: typeof shape.branch === "string" ? shape.branch : "",
        ...(typeof structured.sessionId === "string"
          ? { sessionId: structured.sessionId }
          : context.sessionId === undefined
            ? {}
            : { sessionId: context.sessionId }),
        ...(typeof structured.sessionFilePath === "string"
          ? { sessionFilePath: structured.sessionFilePath }
          : {}),
      },
    );
  }
  if (shape.name === "SyntaxError") {
    return new StructuredOutputError(
      `Structured output tag <${context.tag}> contains invalid JSON`,
      {
        tag: context.tag,
        rawMatched: undefined,
        cause: error,
        commits: [],
        branch: "",
        ...(context.sessionId === undefined ? {} : { sessionId: context.sessionId }),
      },
    );
  }
  if (shape.name === "ZodError" && Array.isArray(shape.issues)) {
    return new StructuredOutputError(
      `Structured output tag <${context.tag}> failed schema validation`,
      {
        tag: context.tag,
        rawMatched: undefined,
        cause: error,
        commits: [],
        branch: "",
        ...(context.sessionId === undefined ? {} : { sessionId: context.sessionId }),
      },
    );
  }
  return undefined;
}

/**
 * Longest parse-detail excerpt a bounded diagnostic may carry. The detail is
 * a length-bounded summary of the parser's own complaint (error name and
 * message, or validation issues) — never rawMatched, stdout, or transcript
 * text — so it is safe to record in the local job log without leaking
 * untrusted agent output into diagnostics.
 */
const MAX_PARSE_DETAIL_LENGTH = 240;

/**
 * Redact the matched raw text from a diagnostic excerpt and cap its length.
 * Runtimes quote the offending input inside JSON.parse complaints, and a
 * bounded diagnostic must never carry rawMatched, stdout, or transcript text.
 */
function boundedDiagnosticExcerpt(text: string, rawMatched: string | undefined): string {
  const redacted = rawMatched === undefined || rawMatched.length === 0
    ? text
    : text.split(rawMatched).join("(redacted matched output)");
  return redacted.length <= MAX_PARSE_DETAIL_LENGTH
    ? redacted
    : `${redacted.slice(0, MAX_PARSE_DETAIL_LENGTH)}…`;
}

/**
 * Render the parser detail of a classified failure, length-bounded and with
 * the matched raw text redacted.
 */
function boundedParseDetail(error: StructuredOutputError): string {
  const detail = error.cause === undefined
    ? "(no parser detail)"
    : typeof error.cause === "string"
      ? error.cause
      : error.cause instanceof Error
        ? `${error.cause.name}: ${error.cause.message}`
        : JSON.stringify(error.cause, null, 2);
  return boundedDiagnosticExcerpt(detail, error.rawMatched);
}

/**
 * Shape the classified failure surfaced when the parse-retry budget is spent
 * into a bounded diagnostic naming the tag, the attempts made, the classified
 * failure kind, and the last parse detail, so a structured-output formatting
 * failure is distinguishable from a real execution failure when the Primary
 * Operator reads the local job log — and a never-emitted tag stays
 * distinguishable from a malformed one. The result stays a
 * StructuredOutputError, preserving the recoverable classification; it
 * deliberately drops rawMatched so no parser raw text or stdout leaves the
 * seam. Per ADR-0002 this shape is never registered as a trusted failure —
 * the published Work Item diagnostic remains the coarse provenance-registered
 * classification.
 */
export function structuredExtractionExhaustionError(
  error: StructuredOutputError,
): StructuredOutputError {
  return new StructuredOutputError(
    `Structured output tag <${error.tag}> could not be parsed after ${STRUCTURED_EXTRACTION_ATTEMPTS} attempts; last failure: ${boundedDiagnosticExcerpt(error.message, error.rawMatched)}; last parse detail: ${boundedParseDetail(error)}`,
    {
      tag: error.tag,
      rawMatched: undefined,
      cause: error.cause,
      commits: error.commits,
      branch: error.branch,
      ...(error.preservedWorktreePath === undefined
        ? {}
        : { preservedWorktreePath: error.preservedWorktreePath }),
      ...(error.sessionId === undefined ? {} : { sessionId: error.sessionId }),
      ...(error.sessionFilePath === undefined ? {} : { sessionFilePath: error.sessionFilePath }),
    },
  );
}

/**
 * Wrap a structured-output run so a parse-shaped failure escaping the
 * library's own retry guard is classified into the recognised recoverable
 * StructuredOutputError before the failure surfaces. Non-output failures
 * (timeouts, aborts, sandbox/execution errors) propagate unchanged.
 *
 * The caller arms the library's same-session retry with
 * STRUCTURED_EXTRACTION_ATTEMPTS - 1 maxRetries inside this run call. A
 * parse-shaped failure reaching this wrapper has escaped that armed guard —
 * either the budget was spent, or the failure's surface form (a raw parse
 * fault, a foreign-bundle StructuredOutputError) was never recognised by the
 * guard — so it is classified and surfaced as the same bounded exhaustion
 * diagnostic instead of passing the guard by.
 */
export function withStructuredOutputErrorClassification(
  runAgent: typeof run,
  tag: string,
): typeof run {
  return (async (runOptions: RunOptions) => {
    try {
      return await runAgent(runOptions);
    } catch (error) {
      const classified = classifyStructuredOutputError(error, { tag });
      if (classified === undefined) throw error;
      throw structuredExtractionExhaustionError(classified);
    }
  }) as typeof run;
}

function extractionRetryPrompt(error: StructuredOutputError, retriesRemaining: number): string {
  const raw = error.rawMatched === undefined ? "(no matching tag was emitted)" : error.rawMatched;
  const cause = boundedParseDetail(error);
  return `Your previous response did not produce valid structured output.

Retries remaining after this attempt: ${retriesRemaining}.

Problem:
${error.message}

Parser detail:
${cause}

Previous matched output:
${raw}

Emit only a corrected <${error.tag}> block. Do not change files or run commands.`;
}

/**
 * Enumerate every closed <tag> block in the output stream, newest first. The
 * scan mirrors the library's findLastTagContent (non-overlapping, a trailing
 * unclosed block is ignored) but keeps every candidate instead of binding to
 * the last closed block, so a malformed trailing emission cannot shadow a
 * well-formed copy that is already present.
 */
function closedTagContents(stdout: string, tag: string): string[] {
  const openTag = `<${tag}>`;
  const closeTag = `</${tag}>`;
  const contents: string[] = [];
  let searchFrom = 0;
  while (true) {
    const openIdx = stdout.indexOf(openTag, searchFrom);
    if (openIdx === -1) break;
    const contentStart = openIdx + openTag.length;
    const closeIdx = stdout.indexOf(closeTag, contentStart);
    if (closeIdx === -1) break;
    contents.push(stdout.slice(contentStart, closeIdx));
    searchFrom = closeIdx + closeTag.length;
  }
  return contents.reverse();
}

/** Fence-aware unwrapping identical to the library's extraction layer. */
function unwrapFences(text: string): string {
  const fenceMatch = text.match(/^```(?:json)?\s*\n([\s\S]*?)\n\s*```\s*$/);
  if (fenceMatch) return fenceMatch[1]!.trim();
  return text;
}

/**
 * Extract the structured output from a run's stdout by trying every closed
 * <tag> block newest-first — the last closed block first, preserving the
 * library's binding when it is well-formed — and returning the first
 * candidate that both JSON-parses and validates against the schema.
 *
 * Failure surfaces keep the library's exact shapes: no closed block yields
 * "not found"; otherwise the newest candidate's parse or validation detail
 * is thrown, tagged with the run's commits, branch, and session identity so
 * the classified same-session retry path can take over.
 *
 * Exported for the repository-owned structured extraction driver
 * (structured-extraction-driver.ts), which applies the same multi-block
 * candidate semantics inside its own bounded structured attempts.
 */
export async function extractFromStdout<Output>(
  result: RunResult,
  tag: string,
  schema: z.ZodType<Output>,
): Promise<Output> {
  const lastIteration = result.iterations?.at(-1);
  const context = {
    commits: result.commits,
    branch: result.branch,
    ...(result.preservedWorktreePath === undefined
      ? {}
      : { preservedWorktreePath: result.preservedWorktreePath }),
    ...(lastIteration?.sessionId === undefined ? {} : { sessionId: lastIteration.sessionId }),
    ...(lastIteration?.sessionFilePath === undefined
      ? {}
      : { sessionFilePath: lastIteration.sessionFilePath }),
  };
  const candidates = closedTagContents(result.stdout, tag);
  if (candidates.length === 0) {
    throw new StructuredOutputError(
      `Structured output tag <${tag}> not found in agent output`,
      { tag, rawMatched: undefined, ...context },
    );
  }
  let newestFailure: StructuredOutputError | undefined;
  for (const raw of candidates) {
    const unwrapped = unwrapFences(raw.trim());
    let parsed: unknown;
    try {
      parsed = JSON.parse(unwrapped);
    } catch (cause) {
      newestFailure ??= new StructuredOutputError(
        `Structured output tag <${tag}> contains invalid JSON`,
        { tag, rawMatched: raw, cause, ...context },
      );
      continue;
    }
    const validation = await schema["~standard"].validate(parsed);
    if (validation.issues) {
      newestFailure ??= new StructuredOutputError(
        `Structured output tag <${tag}> failed schema validation`,
        { tag, rawMatched: raw, cause: validation.issues, ...context },
      );
      continue;
    }
    return validation.value;
  }
  // Candidates was non-empty and every iteration either returned or recorded
  // the newest candidate's failure, so this is always set.
  throw newestFailure as StructuredOutputError;
}

export function createSameSessionStructuredExtractor(options: {
  readonly sandbox: SandboxProvider;
  readonly hooks: SandboxHooks;
  readonly runAgent?: typeof run;
  readonly createAgent?: typeof claudeCode;
}) {
  const runAgent = options.runAgent ?? run;
  const createAgent = options.createAgent ?? claudeCode;

  return {
    async extract<Output>(plan: {
      readonly model: string;
      readonly checkoutPath: string;
      readonly initialPrompt: string;
      readonly resumedPrompt: string;
      readonly timeoutMilliseconds: number;
      readonly timeoutError: Error;
      readonly logging?: Parameters<typeof run>[0]["logging"];
      readonly output: {
        readonly tag: string;
        readonly schema: z.ZodType<Output>;
      };
      readonly missingResumeMessage: string;
      readonly observeInitial?: (result: ObservedResult) => void | Promise<void>;
      readonly observeResumed?: (result: ObservedResult) => void | Promise<void>;
    }): Promise<Output> {
      const controller = new AbortController();
      const timeout = setTimeout(
        () => controller.abort(plan.timeoutError),
        plan.timeoutMilliseconds,
      );

      try {
        const produced = await runAgent({
          agent: createAgent(plan.model),
          sandbox: options.sandbox,
          hooks: options.hooks,
          cwd: plan.checkoutPath,
          ...(plan.logging === undefined ? {} : { logging: plan.logging }),
          signal: controller.signal,
          branchStrategy: { type: "head" },
          maxIterations: 1,
          prompt: plan.initialPrompt,
        });
        await plan.observeInitial?.(produced);
        if (produced.resume === undefined) {
          throw new Error(plan.missingResumeMessage);
        }

        let resume = produced.resume;
        let prompt = plan.resumedPrompt;
        // Track the session the seam would resume so a parse fault whose
        // surface form carries no session identity is still retried within
        // the same session instead of bypassing the armed retry.
        let sessionId = produced.iterations?.at(-1)?.sessionId;
        for (let attempt = 1; attempt <= STRUCTURED_EXTRACTION_ATTEMPTS; attempt += 1) {
          let extracted: Output;
          let resumedResult: RunResult;
          try {
            // No output definition is handed to the library: the seam
            // enumerates every closed <tag> block in the run's stdout itself
            // so a well-formed earlier candidate is used before any
            // model re-emit is requested, consuming no retry.
            resumedResult = await resume(prompt, {
              ...(plan.logging === undefined ? {} : { logging: plan.logging }),
              signal: controller.signal,
            });
            extracted = await extractFromStdout(resumedResult, plan.output.tag, plan.output.schema);
          } catch (error) {
            const classified = classifyStructuredOutputError(error, {
              tag: plan.output.tag,
              ...(sessionId === undefined ? {} : { sessionId }),
            });
            if (classified === undefined) throw error;
            await plan.observeResumed?.(classified);
            if (attempt === STRUCTURED_EXTRACTION_ATTEMPTS) {
              // The budget is spent: surface the bounded exhaustion
              // diagnostic naming the tag, the attempts made, and the last
              // parse detail — never rawMatched or stdout.
              throw structuredExtractionExhaustionError(classified);
            }
            if (classified.sessionId === undefined) {
              throw classified;
            }

            const retrySessionId = classified.sessionId;
            sessionId = retrySessionId;
            prompt = extractionRetryPrompt(classified, STRUCTURED_EXTRACTION_ATTEMPTS - attempt);
            resume = (retryPrompt, retryOptions) => runAgent({
              agent: createAgent(plan.model),
              sandbox: options.sandbox,
              hooks: options.hooks,
              cwd: plan.checkoutPath,
              ...(plan.logging === undefined ? {} : { logging: plan.logging }),
              ...retryOptions,
              prompt: retryPrompt,
              branchStrategy: { type: "head" },
              maxIterations: 1,
              resumeSession: retrySessionId,
            });
            continue;
          }
          await plan.observeResumed?.(resumedResult);
          return extracted;
        }

        throw new Error("Structured extraction attempts were exhausted");
      } finally {
        clearTimeout(timeout);
      }
    },
  };
}
