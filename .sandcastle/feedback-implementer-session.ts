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
import type { FeedbackReplyIntent } from "./feedback-implementation-automation.ts";
import { createFeedbackProduceRecovery } from "./feedback-recovery.ts";
import { StopRetryError } from "./invocation-recovery.ts";
import { inheritedJobLogView, type JobLog } from "./job-logs.ts";
import { createStructuredExtractionDriver } from "./structured-extraction-driver.ts";

const replyIntentSchema = z.object({
  rootCommentId: z.string(),
  body: z.string(),
});

// The Feedback Implementer formatting stage's strict no-mutation contract.
// The formatting prompt carries it and every format-correction prompt repeats
// it verbatim.
export const FEEDBACK_FORMATTING_CONTRACT =
  "No-mutation formatting contract: this stage only formats the feedback reply you already prepared — " +
  "run only read-only inspection commands; you must not modify, create, or delete any file in this checkout; " +
  "you must not stage, commit, push, or otherwise change Git state (HEAD, the index, tracked files, or untracked files); " +
  "you must not perform any GitHub operation (no gh commands, no comments, replies, labels, or edits).";

// The formatting stage resumes the frozen produce session and asks it to emit
// the already-prepared reply. It makes no code changes of its own, and it
// pins the selected immutable feedback root: the emitted rootCommentId must
// be returned verbatim, never replaced by another root or a reply comment.
function formattingPrompt(rootCommentId: string): string {
  return `Now emit the feedback reply you just prepared as one JSON object inside <feedback-reply> tags with exactly rootCommentId and body. Do not put rootCommentId or body in XML tag attributes. The rootCommentId must be exactly ${rootCommentId}; do not substitute another unresolved root or a reply comment.

${FEEDBACK_FORMATTING_CONTRACT}
`;
}

export interface FeedbackImplementerSession {
  run(request: {
    readonly model: string;
    readonly pullRequestNumber: number;
    readonly branch: string;
    readonly revision: string;
    readonly checkoutPath: string;
    readonly rootCommentId: string;
  }): Promise<FeedbackReplyIntent>;
}

// The Feedback Implementer seam (Spec #449): substantive produce runs inside
// one bounded invocation recovery window in the same Target Checkout
// (feedback-recovery.ts), then structured formatting runs as a separate
// immutable stage through the repository-owned structured extraction driver —
// at most three structured attempts, each inside its own invocation recovery
// window, resuming the frozen produce checkpoint, with Sandcastle recursive
// output retry never armed (run calls carry no output definition) and
// extraction via the shared multi-block stdout scanning. Formatting starts
// from requireClean at the frozen post-produce HEAD, and the driver proves
// every formatting invocation — including rejected ones — left HEAD and the
// checkout unchanged; any mutation raises the stop-retry sentinel and
// terminates recovery immediately.
export function createFeedbackImplementerSession(options: {
  readonly sandbox: SandboxProvider;
  readonly hooks: SandboxHooks;
  readonly observer?: CheckoutObserver;
  readonly log?: JobLog;
  readonly runAgent?: typeof run;
  readonly createAgent?: typeof claudeCode;
  readonly now?: () => number;
  readonly wait?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
}): FeedbackImplementerSession {
  const observer = options.observer ?? createCheckoutObserver();
  const log = options.log ?? inheritedJobLogView();
  return {
    async run(request) {
      const logging = agentLogging();
      const produceRecovery = createFeedbackProduceRecovery({
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
        rootCommentId: request.rootCommentId,
        model: request.model,
        name: `implementer-feedback-pr-${request.pullRequestNumber}`,
        ...(logging === undefined ? {} : { logging }),
      });
      // Formatting starts from requireClean at the frozen post-produce HEAD:
      // the checkout must still be clean at exactly the HEAD the successful
      // produce stage left behind. Any drift stops the stage before the
      // formatting driver makes an Agent call.
      const baseline = await observer.requireClean(request.checkoutPath);
      if (baseline.head !== produced.snapshot.head) {
        throw new StopRetryError(
          "Feedback formatting baseline drifted from the frozen post-produce HEAD",
        );
      }
      const driver = createStructuredExtractionDriver({
        sandbox: options.sandbox,
        hooks: options.hooks,
        checkoutPath: request.checkoutPath,
        role: "feedback-implementer",
        stage: "feedback-formatting",
        observer,
        ...(log === undefined ? {} : { log }),
        ...(options.runAgent === undefined ? {} : { runAgent: options.runAgent }),
        ...(options.createAgent === undefined ? {} : { createAgent: options.createAgent }),
        ...(options.now === undefined ? {} : { now: options.now }),
        ...(options.wait === undefined ? {} : { wait: options.wait }),
      });
      return driver.extract({
        model: request.model,
        name: `implementer-feedback-pr-${request.pullRequestNumber}-formatting`,
        initialPrompt: formattingPrompt(request.rootCommentId),
        readOnlyContract: FEEDBACK_FORMATTING_CONTRACT,
        ...(logging === undefined ? {} : { logging }),
        checkpoint: produced.checkpoint,
        output: { tag: "feedback-reply", schema: replyIntentSchema },
      });
    },
  };
}
