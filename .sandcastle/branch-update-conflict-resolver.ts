import {
  claudeCode,
  run,
  type SandboxHooks,
  type SandboxProvider,
} from "@ai-hero/sandcastle";
import { z } from "zod";

import { agentLogging } from "./agent-logging.ts";
import type { CheckoutObserver } from "./checkout-safety.ts";
import type { JobLog } from "./job-logs.ts";
import { createStructuredExtractionDriver } from "./structured-extraction-driver.ts";

// Branch update conflict resolution seam (Spec #449, Issue #457). The
// resolver's responsibilities are split into two stages:
//
// 1. The produce stage resolves the merge. One Agent invocation runs against
//    the already-conflicted Target Checkout and finishes the in-progress
//    merge in place; it never emits the Pull Request comment. The run call
//    carries no `output` definition, and the stage returns the resumable
//    session checkpoint instead of a comment. The bounded invocation
//    recovery window for produce lives in the parent process runner, which
//    classifies the durable merge state before every attempt — this session
//    performs exactly one produce invocation per call.
// 2. The formatting stage extracts the resolution comment as a separate
//    immutable stage through the repository-owned structured extraction
//    driver: at most three structured attempts, each inside its own bounded
//    invocation recovery window, resuming the frozen produce checkpoint
//    (resolve mode) or starting a fresh session (format mode). The checkout
//    observer proves the checkout is clean at the exact merge commit before
//    and after every formatting invocation; any mutation or observer
//    failure raises the controlled stop-retry outcome immediately.
//
// Format mode serves an already completed exact merge awaiting formatting:
// a previous attempt finished the merge commit but never produced a usable
// comment. Recovery preserves that merge — it is never re-merged or
// re-committed — and goes straight to formatting with a fresh session that
// inspects the existing merge commit.

const resolutionSchema = z.strictObject({
  comment: z.string().min(1),
});

interface ResolutionRequest {
  readonly pullRequestNumber: number;
  readonly branch: string;
  readonly baseBranch: string;
  readonly conflicts: readonly string[];
}

// The complete produce prompt for the first attempt against a conflicted
// checkout.
function resolutionPrompt(request: ResolutionRequest): string {
  return `
Pull Request #${request.pullRequestNumber} on branch ${request.branch} has merge conflicts against ${request.baseBranch}. A git merge origin/${request.baseBranch} --no-edit has already been attempted and left the checkout conflicted.

Resolve every conflict and finish the merge. Do not abort the merge or leave a half-finished state.

Read CONTEXT.md and relevant docs before resolving substantive conflicts. Inspect Pull Request #${request.pullRequestNumber}, git status, and the conflicted files:
${request.conflicts.join("\n")}

For each hunk, investigate both sides' intent with git log and commit messages. Preserve both intents where possible. If they conflict, prioritize the Pull Request's stated goal and state the trade-off in your comment. Do not invent new behavior.

Run appropriate checks, stage all resolved files, and finish the merge with one conventional commit such as chore: merge origin/${request.baseBranch} into ${request.branch}. Do not push, rebase, create a branch, or make changes after committing.

Keep your resolution in this session for a subsequent formatting request.
`;
}

// The recovery produce prompt used when a previous attempt in this same
// Target Checkout was interrupted. The durable merge state was already
// classified as an active in-progress merge, so the attempt completes that
// work in place — it never aborts, resets, or re-merges valid existing work.
function resolutionRecoveryPrompt(request: ResolutionRequest): string {
  return `
Pull Request #${request.pullRequestNumber} on branch ${request.branch} has merge conflicts against ${request.baseBranch}. A git merge origin/${request.baseBranch} --no-edit is in progress in this checkout.

A previous resolution attempt in this same checkout was interrupted before it finished. Before doing anything else, inspect the checkout's complete current state: run git status to see staged, unstaged, unmerged, and untracked residue; inspect the unmerged paths and any resolutions already staged; and identify which conflicts are already resolved. Then continue that work in place: keep every valid resolution already in place, resolve the remaining conflicts, and do not abort the merge, reset the checkout, or repeat work that is already done. The merge is still in progress — finish it, never restart it.

Read CONTEXT.md and relevant docs before resolving substantive conflicts. Inspect Pull Request #${request.pullRequestNumber}, git status, and the conflicted files:
${request.conflicts.join("\n")}

For each hunk, investigate both sides' intent with git log and commit messages. Preserve both intents where possible. If they conflict, prioritize the Pull Request's stated goal and state the trade-off in your comment. Do not invent new behavior.

Run appropriate checks, stage all resolved files, and finish the merge with one conventional commit such as chore: merge origin/${request.baseBranch} into ${request.branch}. Do not push, rebase, create a branch, or make changes after committing.

Keep your resolution in this session for a subsequent formatting request.
`;
}

// The formatting stage's strict no-mutation contract. The formatting prompt
// carries it and every format-correction prompt repeats it verbatim.
export const RESOLUTION_FORMATTING_CONTRACT =
  "No-mutation formatting contract: this stage only formats the conflict resolution you already completed — " +
  "you must not modify, create, or delete any file in this checkout; you must not stage, commit, " +
  "push, or otherwise change Git state (HEAD, the index, tracked files, or untracked files); " +
  "run only read-only inspection commands.";

// Resolve-mode formatting resumes the frozen produce session and asks it to
// emit the already-completed resolution comment. It makes no changes of its
// own.
const resolutionFormattingPrompt = `Now emit the conflict resolution you just completed as one JSON object inside <resolution> tags with exactly one non-empty comment field. The comment is a Markdown Pull Request comment describing the conflicts, each resolution, and any uncertainty or remaining problem.

${RESOLUTION_FORMATTING_CONTRACT}
`;

// Format-mode initial prompt for an already completed exact merge awaiting
// formatting. The fresh session inspects the existing merge commit; it must
// not merge or commit again.
function completedMergeFormattingPrompt(request: {
  readonly pullRequestNumber: number;
  readonly branch: string;
  readonly baseBranch: string;
}): string {
  return `
Pull Request #${request.pullRequestNumber} on branch ${request.branch} had merge conflicts against ${request.baseBranch}. The conflicts were already resolved and the merge commit already exists at HEAD of this checkout. Do not merge, commit, or change anything.

Inspect the completed merge commit with read-only commands (git log, git show, and the diff against its first parent) to understand each conflict and how it was resolved. Then emit one JSON object inside <resolution> tags with exactly one non-empty comment field. The comment is a Markdown Pull Request comment describing the conflicts, each resolution, and any uncertainty or remaining problem.

${RESOLUTION_FORMATTING_CONTRACT}
`;
}

export interface BranchUpdateConflictResolverSession {
  // One produce invocation completing the in-progress merge in place,
  // followed by the immutable formatting stage resuming the produce
  // checkpoint. `recovery` selects the recovery produce prompt for a
  // continued attempt against the same checkout.
  resolve(request: {
    readonly model: string;
    readonly pullRequestNumber: number;
    readonly branch: string;
    readonly baseBranch: string;
    readonly checkoutPath: string;
    readonly conflicts: readonly string[];
    readonly recovery?: boolean;
  }): Promise<{ readonly comment: string }>;
  // Format-only path for an already completed exact merge: straight to the
  // immutable formatting stage with a fresh session.
  format(request: {
    readonly model: string;
    readonly pullRequestNumber: number;
    readonly branch: string;
    readonly baseBranch: string;
    readonly checkoutPath: string;
  }): Promise<{ readonly comment: string }>;
}

export function createBranchUpdateConflictResolverSession(options: {
  readonly sandbox: SandboxProvider;
  readonly hooks: SandboxHooks;
  readonly observer?: CheckoutObserver;
  readonly log?: JobLog;
  readonly runAgent?: typeof run;
  readonly createAgent?: typeof claudeCode;
  readonly now?: () => number;
  readonly wait?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
}): BranchUpdateConflictResolverSession {
  const runAgent = options.runAgent ?? run;
  const createAgent = options.createAgent ?? claudeCode;

  const formattingDriver = (checkoutPath: string) => createStructuredExtractionDriver({
    sandbox: options.sandbox,
    hooks: options.hooks,
    checkoutPath,
    role: "merger",
    stage: "resolution-formatting",
    ...(options.observer === undefined ? {} : { observer: options.observer }),
    ...(options.log === undefined ? {} : { log: options.log }),
    ...(options.runAgent === undefined ? {} : { runAgent: options.runAgent }),
    ...(options.createAgent === undefined ? {} : { createAgent: options.createAgent }),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.wait === undefined ? {} : { wait: options.wait }),
  });

  return {
    async resolve(request) {
      const logging = agentLogging();
      const produced = await runAgent({
        agent: createAgent(request.model),
        sandbox: options.sandbox,
        cwd: request.checkoutPath,
        hooks: options.hooks,
        // Head strategy: the Target Checkout's root index already holds the
        // failed merge, so the agent must resolve it in place. A named-branch
        // strategy would ask Sandcastle for a second managed worktree of the
        // same checked-out branch and collide before the agent could run.
        branchStrategy: { type: "head" },
        maxIterations: 1,
        name: `branch-update-pr-${request.pullRequestNumber}`,
        ...(logging === undefined ? {} : { logging }),
        prompt: request.recovery === true
          ? resolutionRecoveryPrompt(request)
          : resolutionPrompt(request),
        // No `output` definition: the produce stage never extracts the
        // comment, so Sandcastle recursive output retry stays disabled. The
        // immutable formatting stage below owns comment extraction.
      });
      if (produced.resume === undefined) {
        throw new Error("Branch update conflict resolution session identity is unavailable");
      }
      const driver = formattingDriver(request.checkoutPath);
      return driver.extract({
        model: request.model,
        name: `branch-update-pr-${request.pullRequestNumber}-formatting`,
        initialPrompt: resolutionFormattingPrompt,
        readOnlyContract: RESOLUTION_FORMATTING_CONTRACT,
        ...(logging === undefined ? {} : { logging }),
        // The frozen produce checkpoint: formatting attempt one resumes the
        // produce session instead of starting a fresh Agent run.
        checkpoint: { resume: produced.resume },
        output: { tag: "resolution", schema: resolutionSchema },
      });
    },
    async format(request) {
      const logging = agentLogging();
      const driver = formattingDriver(request.checkoutPath);
      return driver.extract({
        model: request.model,
        name: `branch-update-pr-${request.pullRequestNumber}-formatting`,
        initialPrompt: completedMergeFormattingPrompt(request),
        readOnlyContract: RESOLUTION_FORMATTING_CONTRACT,
        ...(logging === undefined ? {} : { logging }),
        // No checkpoint: the merge was completed by an earlier attempt whose
        // session is gone, so formatting starts a fresh session that inspects
        // the existing merge commit.
        output: { tag: "resolution", schema: resolutionSchema },
      });
    },
  };
}
