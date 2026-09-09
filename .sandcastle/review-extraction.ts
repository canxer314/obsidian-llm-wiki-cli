import { join } from "node:path";

import {
  claudeCode,
  run,
  type SandboxHooks,
  type SandboxProvider,
} from "@ai-hero/sandcastle";
import { z } from "zod";

import { agentLogging } from "./agent-logging.ts";
import {
  createCheckoutObserver,
  type CheckoutObserver,
} from "./checkout-safety.ts";
import { StopRetryError } from "./invocation-recovery.ts";
import { inheritedJobLogView, type JobLog } from "./job-logs.ts";
import type { PublishedReview, ReviewThreadComment } from "./review-automation.ts";
import { createReviewProduceRecovery } from "./review-recovery.ts";
import { createStructuredExtractionDriver } from "./structured-extraction-driver.ts";

export type ExtractedReview = PublishedReview;

const inlineCommentSchema = z.strictObject({
  path: z.string().min(1).refine((path) => !path.startsWith("/") && !path.split("/").includes(".."), {
    message: "inline comment path must be repository-relative",
  }),
  line: z.number().int().positive(),
  body: z.string().min(1),
});

const replySchema = z.strictObject({
  commentId: z.string().min(1),
  body: z.string().min(1),
});

export const reviewSchema = z.strictObject({
  summary: z.string().min(1),
  inlineComments: z.array(inlineCommentSchema),
  replies: z.array(replySchema),
});

// The Reviewer formatting stage's strict no-mutation contract. The formatting
// prompt carries it and every format-correction prompt repeats it verbatim.
export const REVIEW_FORMATTING_CONTRACT =
  "No-mutation formatting contract: this stage only formats the review you already completed — " +
  "you must not modify, create, or delete any file in this checkout; you must not stage, commit, " +
  "push, or otherwise change Git state (HEAD, the index, tracked files, or untracked files); " +
  "run only read-only inspection commands.";

// The formatting stage resumes the frozen produce session and asks it to emit
// the already-completed review. It makes no code changes of its own.
const formattingPrompt = `Now emit the review you just completed as one JSON object inside <review> tags. Include a concise summary, inlineComments, and replies. Each inline comment requires a repository-relative path, exact current line number, and body. Each reply requires an exact commentId from the provided unresolved review threads and body. Use empty arrays when none apply.

${REVIEW_FORMATTING_CONTRACT}
`;

const REVIEW_TIMEOUT_MILLISECONDS = 135 * 60 * 1000;

// The Reviewer seam (Spec #449): substantive produce runs inside one bounded
// invocation recovery window in the same Target Checkout (review-recovery.ts),
// then structured formatting runs as a separate immutable stage through the
// repository-owned structured extraction driver — at most three structured
// attempts, each inside its own invocation recovery window, resuming the
// frozen produce checkpoint, with Sandcastle recursive output retry never
// armed (run calls carry no output definition) and extraction via the shared
// multi-block stdout scanning. Formatting starts from requireClean at the
// frozen post-produce HEAD, and the driver proves every formatting invocation
// — including rejected ones — left HEAD and the checkout unchanged; any
// mutation raises the stop-retry sentinel and terminates recovery
// immediately. Total Agent executions stay within the normative twelve
// (3 produce + 3 structured x 3 invocation) and stop on success, bounded by
// the operation timeout that rides the shared abort signal.
export function createSameSessionReviewExtractor(options: {
  readonly sandbox: SandboxProvider;
  readonly hooks: SandboxHooks;
  readonly observer?: CheckoutObserver;
  readonly log?: JobLog;
  readonly runAgent?: typeof run;
  readonly createAgent?: typeof claudeCode;
  readonly now?: () => number;
  readonly wait?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  readonly timeoutMilliseconds?: number;
}) {
  const observer = options.observer ?? createCheckoutObserver();
  const log = options.log ?? inheritedJobLogView();
  return {
    async review(request: {
      readonly pullRequestNumber: number;
      readonly branch: string;
      readonly revision: string;
      readonly checkoutPath: string;
      readonly reviewThreads: readonly ReviewThreadComment[];
      readonly model: string;
      readonly artifactDirectory?: string;
    }): Promise<ExtractedReview> {
      const logging = agentLogging(
        request.artifactDirectory === undefined
          ? undefined
          : join(request.artifactDirectory, "review.log"),
      );
      const controller = new AbortController();
      const timeout = setTimeout(
        () => controller.abort(new Error("Reviewer execution timed out")),
        options.timeoutMilliseconds ?? REVIEW_TIMEOUT_MILLISECONDS,
      );
      try {
        const produceRecovery = createReviewProduceRecovery({
          sandbox: options.sandbox,
          hooks: options.hooks,
          checkoutPath: request.checkoutPath,
          observer,
          ...(log === undefined ? {} : { log }),
          ...(options.runAgent === undefined ? {} : { runAgent: options.runAgent }),
          ...(options.createAgent === undefined ? {} : { createAgent: options.createAgent }),
          ...(options.now === undefined ? {} : { now: options.now }),
          ...(options.wait === undefined ? {} : { wait: options.wait }),
        });
        const produced = await produceRecovery.produce({
          pullRequestNumber: request.pullRequestNumber,
          branch: request.branch,
          revision: request.revision,
          reviewThreads: request.reviewThreads,
          model: request.model,
          name: `review-pr-${request.pullRequestNumber}`,
          ...(logging === undefined ? {} : { logging }),
          signal: controller.signal,
        });
        // Formatting starts from requireClean at the frozen post-produce HEAD:
        // the checkout must still be clean at exactly the HEAD the successful
        // produce stage left behind. Any drift stops the stage before the
        // formatting driver makes an Agent call.
        const baseline = await observer.requireClean(request.checkoutPath);
        if (baseline.head !== produced.snapshot.head) {
          throw new StopRetryError(
            "Reviewer formatting baseline drifted from the frozen post-produce HEAD",
          );
        }
        const driver = createStructuredExtractionDriver({
          sandbox: options.sandbox,
          hooks: options.hooks,
          checkoutPath: request.checkoutPath,
          role: "reviewer",
          stage: "review-formatting",
          observer,
          ...(log === undefined ? {} : { log }),
          ...(options.runAgent === undefined ? {} : { runAgent: options.runAgent }),
          ...(options.createAgent === undefined ? {} : { createAgent: options.createAgent }),
          ...(options.now === undefined ? {} : { now: options.now }),
          ...(options.wait === undefined ? {} : { wait: options.wait }),
        });
        return await driver.extract({
          model: request.model,
          name: `review-pr-${request.pullRequestNumber}-formatting`,
          initialPrompt: formattingPrompt,
          readOnlyContract: REVIEW_FORMATTING_CONTRACT,
          ...(logging === undefined ? {} : { logging }),
          checkpoint: produced.checkpoint,
          output: { tag: "review", schema: reviewSchema },
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timeout);
      }
    },
  };
}
