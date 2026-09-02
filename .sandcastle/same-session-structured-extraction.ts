import {
  Output,
  StructuredOutputError,
  claudeCode,
  run,
  type SandboxHooks,
  type SandboxProvider,
} from "@ai-hero/sandcastle";
import type { z } from "zod";

type RunResult = Awaited<ReturnType<typeof run>>;

type ObservedResult = Pick<RunResult, "commits">;

type StructuredRunResult<Output> = RunResult & {
  readonly output: Output;
};

const EXTRACTION_ATTEMPTS = 3;

function extractionRetryPrompt(error: StructuredOutputError, retriesRemaining: number): string {
  const raw = error.rawMatched === undefined ? "(no matching tag was emitted)" : error.rawMatched;
  const cause = error.cause === undefined
    ? "(no parser detail)"
    : typeof error.cause === "string"
      ? error.cause
      : JSON.stringify(error.cause, null, 2);
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
      const output = Output.object({ tag: plan.output.tag, schema: plan.output.schema });

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
        for (let attempt = 1; attempt <= EXTRACTION_ATTEMPTS; attempt += 1) {
          try {
            const extracted = await resume(prompt, {
              ...(plan.logging === undefined ? {} : { logging: plan.logging }),
              signal: controller.signal,
              output,
            }) as StructuredRunResult<Output>;
            await plan.observeResumed?.(extracted);
            return extracted.output;
          } catch (error) {
            if (!(error instanceof StructuredOutputError)) throw error;
            await plan.observeResumed?.(error);
            if (attempt === EXTRACTION_ATTEMPTS || error.sessionId === undefined) throw error;

            const sessionId = error.sessionId;
            prompt = extractionRetryPrompt(error, EXTRACTION_ATTEMPTS - attempt);
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
              resumeSession: sessionId,
            });
          }
        }

        throw new Error("Structured extraction attempts were exhausted");
      } finally {
        clearTimeout(timeout);
      }
    },
  };
}
