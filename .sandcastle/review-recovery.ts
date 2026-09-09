import {
  claudeCode,
  run,
  type LoggingOption,
  type SandboxHooks,
  type SandboxProvider,
} from "@ai-hero/sandcastle";

import {
  createCheckoutObserver,
  type CheckoutObserver,
  type CheckoutSnapshot,
  type CheckoutStatusEntry,
} from "./checkout-safety.ts";
import { invokeWithRecovery } from "./invocation-recovery.ts";
import { inheritedJobLogView, type JobLog } from "./job-logs.ts";
import type { ReviewThreadComment } from "./review-automation.ts";
import type { StructuredExtractionCheckpoint } from "./structured-extraction-driver.ts";

// Reviewer produce recovery (Spec #449). The substantive produce stage runs
// inside one bounded invocation recovery window — at most three sequential
// Agent attempts against the same Target Checkout. Unlike the read-only
// structured stages, a produce attempt is expected to mutate the checkout: it
// commits intended improvements on the review branch. An interrupted attempt
// may therefore leave understood partial work (commits, diffs, or residue),
// and a recovery attempt continues that work instead of restarting it.
//
// The produce contract is validated after every successful invocation from
// observer state, never from which attempt committed:
// - the checkout must be clean — a returned success with staged, unstaged,
//   unmerged, or non-ignored untracked residue is a recoverable
//   produce-contract failure inside the bounded window;
// - the completed response must carry a resumable session checkpoint — a
//   missing checkpoint is likewise a recoverable produce-contract failure;
// - an unobservable checkout (missing path, failed observer command, or
//   malformed observer output, including an invalid HEAD) raises the
//   controlled stop-retry outcome from the observer and stops the window
//   immediately: unobservable state is never evidence that recovery is safe.
//
// A commit created before attempt one rejects therefore remains valid when a
// later attempt returns successfully without creating another commit.

export interface ReviewProduceOutcome {
  // The resumable produce-session checkpoint the immutable formatting stage
  // resumes for its first structured attempt.
  readonly checkpoint: StructuredExtractionCheckpoint;
  // The frozen post-produce checkout snapshot: a clean checkout at a valid
  // HEAD. Formatting starts by proving the checkout is still clean at exactly
  // this HEAD.
  readonly snapshot: CheckoutSnapshot;
}

interface ProducePromptRequest {
  readonly pullRequestNumber: number;
  readonly branch: string;
  readonly revision: string;
  readonly reviewThreads: readonly ReviewThreadComment[];
}

function producePromptBody(request: ProducePromptRequest): string {
  return `Inspect the Git diff, implementation, tests, repository standards, and originating Issue. Actively improve correct, in-scope problems you find: make the smallest correct changes, run appropriate checks, and commit every intended improvement on the existing branch. Do not create an Issue, branch, or Pull Request. Do not run gh auth setup-git, git push, rebase, or force-push; a controlled publisher will push your local commits after you exit.

Unresolved review threads are below. Address code-review requests when appropriate and prepare a reply for each addressed or substantively declined request. Only reply to one of these exact comment IDs.

${JSON.stringify(request.reviewThreads, null, 2)}

Keep your review in this session for a subsequent formatting request.`;
}

// The complete produce prompt for attempt one.
export function reviewProducePrompt(request: ProducePromptRequest): string {
  return `Review Pull Request #${request.pullRequestNumber} on branch ${request.branch}, which starts at exact revision ${request.revision}.

${producePromptBody(request)}`;
}

// The recovery produce prompt used from attempt two onward. The interrupted
// attempt may have left valid partial work in this same Target Checkout, so
// the Agent first inspects the checkout's complete current state and then
// continues it — never duplicating fixes or commits that already exist.
export function reviewProduceRecoveryPrompt(request: ProducePromptRequest): string {
  return `Review Pull Request #${request.pullRequestNumber} on branch ${request.branch}, which starts at exact revision ${request.revision}.

A previous review attempt in this same checkout was interrupted before it finished. Before doing anything else, inspect the checkout's complete current state: run git status to see staged, unstaged, unmerged, and untracked residue; read the current diff against ${request.revision}; list the existing commits with git log; and identify which improvements are already complete. Then continue that work: keep every valid improvement already in place, complete or commit any partial work you find, and do not duplicate fixes that were already made or create commits that repeat an existing one. Base your review on the checkout's complete current state, not on how the checkout looked when the interrupted attempt began.

${producePromptBody(request)}`;
}

// Repository-owned residue counts for the recoverable produce-contract
// failure summary. Ignored files never count as residue; the summary carries
// counts only, never paths or observer output.
function residueSummary(entries: readonly CheckoutStatusEntry[]): string {
  const local = entries.filter((entry) => entry.kind !== "ignored");
  const staged = local.filter((entry) =>
    entry.kind === "tracked" && entry.index !== " " && entry.index !== "?"
  ).length;
  const unstaged = local.filter((entry) =>
    entry.kind === "tracked" && entry.worktree !== " "
  ).length;
  const unmerged = local.filter((entry) => entry.kind === "unmerged").length;
  const untracked = local.filter((entry) => entry.kind === "untracked").length;
  return `staged=${staged}, unstaged=${unstaged}, unmerged=${unmerged}, untracked=${untracked}`;
}

export function createReviewProduceRecovery(options: {
  readonly sandbox: SandboxProvider;
  readonly hooks: SandboxHooks;
  // The single Target Checkout every produce attempt runs against.
  readonly checkoutPath: string;
  readonly observer?: CheckoutObserver;
  readonly log?: JobLog;
  readonly runAgent?: typeof run;
  readonly createAgent?: typeof claudeCode;
  readonly now?: () => number;
  readonly wait?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
}) {
  const observer = options.observer ?? createCheckoutObserver();
  const runAgent = options.runAgent ?? run;
  const createAgent = options.createAgent ?? claudeCode;
  const log = options.log ?? inheritedJobLogView();

  return {
    async produce(request: {
      readonly pullRequestNumber: number;
      readonly branch: string;
      readonly revision: string;
      readonly reviewThreads: readonly ReviewThreadComment[];
      readonly model: string;
      readonly name: string;
      readonly logging?: LoggingOption;
      readonly signal?: AbortSignal;
    }): Promise<ReviewProduceOutcome> {
      return invokeWithRecovery(async ({ recovery }) => {
        const result = await runAgent({
          agent: createAgent(request.model),
          sandbox: options.sandbox,
          hooks: options.hooks,
          cwd: options.checkoutPath,
          branchStrategy: { type: "head" },
          maxIterations: 1,
          name: request.name,
          ...(request.logging === undefined ? {} : { logging: request.logging }),
          ...(request.signal === undefined ? {} : { signal: request.signal }),
          prompt: recovery
            ? reviewProduceRecoveryPrompt(request)
            : reviewProducePrompt(request),
        });
        // Produce-contract validation runs from observer state. An
        // unobservable checkout raises the observer's stop-retry sentinel and
        // stops the window; residue or a missing checkpoint is an ordinary
        // recoverable failure that spends one invocation attempt.
        const snapshot = await observer.observe(options.checkoutPath);
        if (snapshot.entries.some((entry) => entry.kind !== "ignored")) {
          throw new Error(
            `Reviewer produce returned successfully with an unclean checkout (${residueSummary(snapshot.entries)})`,
          );
        }
        if (result.resume === undefined) {
          throw new Error("Reviewer session identity is unavailable");
        }
        return { checkpoint: { resume: result.resume }, snapshot };
      }, {
        role: "reviewer",
        stage: "produce",
        ...(log === undefined ? {} : { log }),
        ...(request.signal === undefined ? {} : { signal: request.signal }),
        ...(options.now === undefined ? {} : { now: options.now }),
        ...(options.wait === undefined ? {} : { wait: options.wait }),
      });
    },
  };
}
