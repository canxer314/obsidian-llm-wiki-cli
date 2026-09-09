import { spawn } from "node:child_process";

import type { BranchUpdateResult } from "./branch-update-automation.ts";
import { StopRetryError, invokeWithRecovery } from "./invocation-recovery.ts";
import type { JobLog } from "./job-logs.ts";
import { createWorkerProcessLifecycle } from "./worker-process-lifecycle.ts";

const GIT_COMMAND_TIMEOUT_MILLISECONDS = 7.5 * 60 * 1000;
const GIT_COMMAND_GRACE_MILLISECONDS = 10 * 1000;

const FULL_REVISION = /^[0-9a-f]{40}$/u;

type Execute = (
  arguments_: readonly string[],
) => Promise<{ readonly stdout: string; readonly stderr: string }>;

function requireFullRevision(revision: string): string {
  if (!FULL_REVISION.test(revision)) {
    throw new Error("Branch update produced an invalid revision");
  }
  return revision;
}

function createProcessGitExecutor(options: {
  readonly environment?: Readonly<Record<string, string>>;
}): Execute {
  const lifecycle = createWorkerProcessLifecycle();
  return async (arguments_) => {
    const completed = await lifecycle.run({
      role: "nested",
      timeoutMilliseconds: GIT_COMMAND_TIMEOUT_MILLISECONDS,
      graceMilliseconds: GIT_COMMAND_GRACE_MILLISECONDS,
      launch: (admit, disposition) => {
        const child = spawn("git", [...arguments_], {
          detached: disposition.detached,
          stdio: ["ignore", "pipe", "pipe"],
          ...(options.environment === undefined ? {} : { env: options.environment }),
        });
        admit(child);
      },
    });
    if (completed.status === "timed-out") {
      throw new Error(`git command timed out after ${GIT_COMMAND_TIMEOUT_MILLISECONDS}ms`);
    }
    if (completed.code !== 0) {
      throw new Error(`git exited with ${completed.code ?? "signal"}: ${completed.stderr}`);
    }
    return completed;
  };
}

export interface BranchUpdateResolver {
  // One produce attempt that completes the active conflicted merge in place,
  // followed by immutable resolution-comment formatting. `recovery` marks a
  // continued attempt against the same Target Checkout: the prompt then
  // instructs the Agent to inspect and continue the checkout's current state
  // instead of starting over.
  resolve(request: {
    readonly pullRequestNumber: number;
    readonly branch: string;
    readonly baseBranch: string;
    readonly revision: string;
    readonly checkoutPath: string;
    readonly conflicts: readonly string[];
    readonly recovery?: boolean;
  }): Promise<{ readonly comment: string }>;
  // Immutable resolution-comment formatting for an already completed exact
  // merge. The merge is preserved as-is: never re-merged and never
  // re-committed.
  format(request: {
    readonly pullRequestNumber: number;
    readonly branch: string;
    readonly baseBranch: string;
    readonly revision: string;
    readonly checkoutPath: string;
  }): Promise<{ readonly comment: string }>;
}

// The durable merge states recovery distinguishes before every attempt
// (Issue #457). Only the first three may receive another bounded attempt;
// every other observed state is unprovable history and stops recovery.
type MergeState =
  // MERGE_HEAD is present on the frozen pre-merge head: the next attempt
  // completes the in-progress merge in place, never resetting valid work.
  | { readonly kind: "active-conflict"; readonly conflicts: readonly string[] }
  // HEAD is a single merge commit whose parents are exactly the frozen
  // pre-merge head and base revision. It is preserved as-is and goes
  // straight to comment formatting.
  | { readonly kind: "completed-merge"; readonly revision: string }
  // The checkout is clean at the original pre-merge head with no merge
  // metadata: the original merge may be repeated against the frozen base.
  | { readonly kind: "aborted-merge" }
  // Any other changed HEAD, wrong or reversed parents, extra commits,
  // malformed revisions, or residue without merge metadata.
  | { readonly kind: "invalid"; readonly reason: string };

const UNMERGED_STATUS = new Set(["DD", "AU", "UD", "UA", "DU", "AA", "UU"]);

// Unmerged paths from `git status --porcelain` output: any record whose
// index/worktree pair is one of the seven unmerged combinations.
function unmergedPaths(porcelain: string): string[] {
  const paths: string[] = [];
  for (const line of porcelain.split("\n")) {
    if (line.length < 4) continue;
    if (UNMERGED_STATUS.has(line.slice(0, 2))) paths.push(line.slice(3));
  }
  return paths;
}

// Repository-owned merge-state classification (Issue #457). Runs before
// every recovery attempt and decides from durable Git state — never from
// which attempt ran — whether the checkout holds an active conflicted merge,
// an already completed exact merge awaiting formatting, an aborted merge at
// the original clean head, or an invalid state that stops recovery.
function createMergeStateClassifier(options: {
  readonly git: (arguments_: readonly string[]) => Promise<{ readonly stdout: string }>;
  readonly preMergeSha: string;
  readonly baseSha: string;
}): () => Promise<MergeState> {
  const { git, preMergeSha, baseSha } = options;
  const invalid = (reason: string): MergeState => ({ kind: "invalid", reason });
  return async () => {
    const head = (await git(["rev-parse", "HEAD"])).stdout.trim();
    if (!FULL_REVISION.test(head)) {
      return invalid("Branch update merge state has a malformed HEAD revision");
    }
    // The merge-metadata probe: `rev-parse -q --verify MERGE_HEAD` exits 1
    // quietly when no merge is in progress and prints the revision being
    // merged in otherwise.
    let mergeHead: string | undefined;
    try {
      mergeHead = (await git(["rev-parse", "-q", "--verify", "MERGE_HEAD"])).stdout.trim();
    } catch (failure) {
      if (!(failure instanceof Error) || !failure.message.includes("exited with 1")) {
        throw failure;
      }
    }
    const porcelain = (await git(["status", "--porcelain"])).stdout;
    const dirty = porcelain.trim().length > 0;
    if (mergeHead !== undefined) {
      if (!FULL_REVISION.test(mergeHead)) {
        return invalid("Branch update merge state has a malformed MERGE_HEAD revision");
      }
      if (head !== preMergeSha) {
        return invalid("Branch update merge is in progress on a changed HEAD");
      }
      if (mergeHead !== baseSha) {
        return invalid("Branch update merge in progress targets an unexpected revision");
      }
      return { kind: "active-conflict", conflicts: unmergedPaths(porcelain) };
    }
    if (head === preMergeSha) {
      if (dirty) {
        return invalid(
          "Branch update checkout carries residue at the original head without merge metadata",
        );
      }
      return { kind: "aborted-merge" };
    }
    // rev-list --parents prints "<commit> <parent1> <parent2>..." for the
    // single HEAD commit, so one line pins the commit, its parent count, and
    // the parent order at once.
    const topology = (await git(["rev-list", "--parents", "--max-count=1", "HEAD"])).stdout
      .trim().split(/\s+/u);
    if (
      topology[0] !== head || topology.length !== 3 ||
      topology[1] !== preMergeSha || topology[2] !== baseSha
    ) {
      return invalid(
        "Branch update HEAD changed without exactly one merge commit on the frozen revisions",
      );
    }
    if (dirty) {
      return invalid("Branch update completed merge carries unresolved or dirty residue");
    }
    return { kind: "completed-merge", revision: head };
  };
}

export function createProcessBranchUpdater(options: {
  readonly execute?: Execute;
  readonly environment?: Readonly<Record<string, string>>;
  readonly resolver?: BranchUpdateResolver;
  readonly log?: JobLog;
  readonly now?: () => number;
  readonly wait?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
}) {
  const execute = options.execute ?? createProcessGitExecutor(options);
  // Destructured once so the recovery-window options below can use shorthand
  // properties: the lifecycle-seam conformance guard forbids backoff-shaped
  // orchestration keys inside protocol runners.
  const { log, now, wait } = options;
  return {
    async update(request: {
      readonly pullRequestNumber: number;
      readonly branch: string;
      readonly baseBranch: string;
      readonly revision: string;
      readonly checkoutPath: string;
    }): Promise<BranchUpdateResult> {
      const git = (arguments_: readonly string[]) => execute(["-C", request.checkoutPath, ...arguments_]);
      const revisionOf = async (ref: string) => (await git(["rev-parse", ref])).stdout.trim();
      const unresolvedConflicts = async () => (await git(["diff", "--name-only", "--diff-filter=U"])).stdout
        .split("\n").map((line) => line.trim()).filter(Boolean);
      const push = (revision: string) => git([
        "push", `--force-with-lease=refs/heads/${request.branch}:${request.revision}`,
        "origin", `HEAD:refs/heads/${request.branch}`,
      ]);

      await git(["fetch", "--no-tags", "origin", request.baseBranch]);
      await git(["switch", "--create", request.branch, request.revision]);
      // Freeze the revisions that authorize exactly one merge result: the
      // pre-merge Pull Request head and the freshly fetched base head. Every
      // classification and post-resolution check below compares against
      // these frozen values.
      const preMergeSha = await revisionOf("HEAD");
      const baseSha = await revisionOf(`origin/${request.baseBranch}`);
      const mergeBase = (await git(["merge-base", "HEAD", `origin/${request.baseBranch}`])).stdout.trim();

      if (mergeBase === baseSha) return { status: "up-to-date" };

      const requireExactMergeCommit = async (revision: string) => {
        const topology = (await git(["rev-list", "--parents", "--max-count=1", "HEAD"])).stdout
          .trim().split(/\s+/u);
        if (topology[0] !== revision || topology.length !== 3) {
          throw new Error("Conflict-resolution agent did not finish with exactly one merge commit");
        }
        if (topology[1] !== preMergeSha || topology[2] !== baseSha) {
          throw new Error(
            `Conflict-resolution agent produced a merge commit with parents ${topology[1]} ${topology[2]}`
            + ` instead of ${preMergeSha} ${baseSha}`,
          );
        }
      };
      const requireCleanCheckout = async () => {
        // Porcelain output already honours ignore rules, so any line at all
        // is staged, unstaged, or non-ignored untracked residue.
        const status = (await git(["status", "--porcelain"])).stdout.trim();
        if (status.length > 0) {
          throw new Error(`Conflict-resolution agent left the checkout dirty:\n${status}`);
        }
      };

      try {
        await git(["merge", "--no-edit", `origin/${request.baseBranch}`]);
      } catch {
        const conflicts = await unresolvedConflicts();
        if (conflicts.length === 0) {
          throw new Error("Branch update merge failed without reported conflicts");
        }
        const resolver = options.resolver;
        if (resolver === undefined) {
          throw new Error("Branch update conflict resolution is unavailable");
        }
        const resolverRequest = {
          pullRequestNumber: request.pullRequestNumber,
          branch: request.branch,
          baseBranch: request.baseBranch,
          revision: request.revision,
          checkoutPath: request.checkoutPath,
        };
        const classifyMergeState = createMergeStateClassifier({ git, preMergeSha, baseSha });
        // Success postconditions for a completed produce attempt: one exact
        // clean merge commit on the frozen revisions, zero unmerged paths,
        // and a clean checkout. A returned comment proves the formatting
        // stage consumed a usable session checkpoint.
        const validateResolvedMerge = async (comment: string) => {
          const postSha = await revisionOf("HEAD");
          if (postSha === preMergeSha) {
            throw new Error("Conflict-resolution agent produced no commits");
          }
          const revision = requireFullRevision(postSha);
          await requireExactMergeCommit(revision);
          const unresolved = await unresolvedConflicts();
          if (unresolved.length > 0) {
            throw new Error(`Conflict-resolution agent left unresolved conflicts in:\n${unresolved.join("\n")}`);
          }
          await requireCleanCheckout();
          return { revision, comment };
        };
        const recoveryKernel = {
          ...(log === undefined ? {} : { log }),
          ...(now === undefined ? {} : { now }),
          ...(wait === undefined ? {} : { wait }),
        };
        // One bounded invocation recovery window: at most three sequential
        // produce attempts against the same Target Checkout and the same
        // frozen pre-merge and base revisions. The durable merge state is
        // classified before every attempt.
        const outcome: { readonly revision: string; readonly comment?: string } =
          await invokeWithRecovery(async ({ recovery }) => {
            const state = await classifyMergeState();
            if (state.kind === "invalid") {
              // Unprovable history stops recovery immediately.
              throw new StopRetryError(state.reason);
            }
            if (state.kind === "completed-merge") {
              // The exact merge is preserved as-is — never re-merged or
              // re-committed — and goes straight to immutable formatting.
              const formatted = await resolver.format(resolverRequest);
              const formattedSha = await revisionOf("HEAD");
              if (formattedSha !== state.revision) {
                throw new Error("Resolution-comment formatting changed the completed merge commit");
              }
              await requireCleanCheckout();
              return { revision: state.revision, comment: formatted.comment };
            }
            if (state.kind === "active-conflict") {
              const resolved = await resolver.resolve({
                ...resolverRequest,
                conflicts: state.conflicts,
                recovery,
              });
              return validateResolvedMerge(resolved.comment);
            }
            // Aborted merge at the original clean head: repeat the original
            // merge once against the frozen base revision inside this
            // attempt, then resolve the fresh conflict state.
            try {
              await git(["merge", "--no-edit", baseSha]);
            } catch {
              const repeated = await unresolvedConflicts();
              if (repeated.length === 0) {
                throw new Error("Branch update merge failed without reported conflicts");
              }
              const resolved = await resolver.resolve({
                ...resolverRequest,
                conflicts: repeated,
                recovery: false,
              });
              return validateResolvedMerge(resolved.comment);
            }
            const revision = requireFullRevision(await revisionOf("HEAD"));
            await requireExactMergeCommit(revision);
            await requireCleanCheckout();
            return { revision };
          }, {
            role: "merger",
            stage: "conflict-resolution",
            ...recoveryKernel,
          });
        // The lease-protected push stays outside the recovery window: it
        // runs zero times on any failure and exactly once only after both
        // merge validation and valid comment extraction.
        await push(outcome.revision);
        return {
          status: "updated",
          revision: outcome.revision,
          ...(outcome.comment === undefined ? {} : { comment: outcome.comment }),
        };
      }

      const revision = requireFullRevision(await revisionOf("HEAD"));
      await push(revision);
      return { status: "updated", revision };
    },
  };
}
