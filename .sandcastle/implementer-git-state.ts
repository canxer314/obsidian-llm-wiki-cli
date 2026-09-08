import { spawn } from "node:child_process";

import {
  createCheckoutObserver,
  type CheckoutObserver,
  type CheckoutObserverExecute,
} from "./checkout-safety.ts";
import { StopRetryError } from "./invocation-recovery.ts";

// Implementer Git-state port (Spec #449, Issue #458). The ordinary Issue
// Implementer recovers from durable named-branch state instead of the final
// Sandcastle run's commit delta, so every branch-state fact it acts on comes
// through this narrow injectable port: branch preparation, local and remote
// observation, ancestry checks, fetches, and clean managed-worktree evidence.
// The port never checks the deterministic branch out in the root Target
// Checkout — the Agent works in the Sandcastle-managed worktree under
// .sandcastle/worktrees/, and every operation below runs against the root
// checkout's repository without moving its own detached HEAD.
//
// The port reports mechanics only; recovery policy (which observed states may
// receive another Agent attempt) lives in implementer.ts. Unprovable state
// raises the controlled stop-retry sentinel so no further Agent invocation is
// made on top of state the orchestrator cannot reason about.

export interface ImplementerManagedWorktree {
  // Host path of the managed worktree currently checking out the
  // deterministic branch.
  readonly path: string;
  // True when the worktree carries no staged, unstaged, unmerged, or
  // non-ignored untracked residue.
  readonly clean: boolean;
}

export interface ImplementerGitState {
  // Creates the deterministic local branch at the frozen baseline without
  // checking it out. Fails when the branch already exists; callers observe
  // first and validate an existing branch's ancestry instead.
  prepareBranch(request: {
    readonly branch: string;
    readonly baseline: string;
  }): Promise<void>;
  // Fetches origin so remote-tracking refs and pushed objects are local.
  fetchRemote(): Promise<void>;
  // Full revision of refs/heads/<branch>, or undefined when absent. The raw
  // observed string is returned; callers validate its shape.
  observeLocalBranch(branch: string): Promise<string | undefined>;
  // Full revision of the remote-tracking branch origin/<branch>, or
  // undefined when absent. The raw observed string is returned; callers
  // validate its shape.
  observeRemoteBranch(branch: string): Promise<string | undefined>;
  // True when `ancestor` is an ancestor of `descendant`. Unanswerable
  // ancestry (missing objects, malformed revisions) throws.
  isAncestor(ancestor: string, descendant: string): Promise<boolean>;
  // Evidence for the managed worktree checking out the deterministic branch:
  // undefined when no worktree holds the branch (a clean successful run
  // removes its managed worktree), otherwise the worktree path and whether it
  // is clean. The deterministic branch checked out in the root Target
  // Checkout is a contract violation and raises the stop-retry sentinel.
  observeManagedWorktree(branch: string): Promise<ImplementerManagedWorktree | undefined>;
}

export interface ImplementerGitStateOptions {
  // The root Target Checkout whose repository owns the deterministic branch.
  readonly checkoutPath: string;
  readonly execute?: CheckoutObserverExecute;
  readonly gitEnvironment?: Readonly<Record<string, string>>;
  readonly observer?: CheckoutObserver;
}

class GitStateCommandError extends Error {
  constructor(summary: string) {
    super(summary);
    this.name = "GitStateCommandError";
  }
}

// Port commands follow the Target Checkout execution pattern: a fixed
// executable with captured output. Child stderr stays local to the failing
// call; summaries carry only the repository-owned exit status.
async function executeCapturingOutput(
  file: string,
  arguments_: readonly string[],
  environment?: Readonly<Record<string, string>>,
): Promise<{ readonly stdout: string; readonly stderr: string }> {
  return new Promise((resolveExecution, reject) => {
    const child = spawn(file, [...arguments_], { env: environment });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer | string) => {
      stdout += String(chunk);
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderr += String(chunk);
    });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === 0) {
        resolveExecution({ stdout, stderr });
        return;
      }
      reject(new GitStateCommandError(
        `${file} ${arguments_[0] ?? ""} exited with ${code ?? signal ?? "unknown status"}`,
      ));
    });
  });
}

const normalizePath = (path: string): string => path.replace(/\\/gu, "/");

interface WorktreeListEntry {
  readonly path: string;
  readonly branch?: string;
}

// Parses `git worktree list --porcelain` records. Each record starts with a
// `worktree <path>` line; a `branch refs/heads/<name>` line follows for
// worktrees on a branch (absent for the detached root Target Checkout).
function parseWorktreeList(stdout: string): WorktreeListEntry[] {
  const entries: WorktreeListEntry[] = [];
  let path: string | undefined;
  let branch: string | undefined;
  const flush = (): void => {
    if (path === undefined) return;
    entries.push({ path, ...(branch === undefined ? {} : { branch }) });
    path = undefined;
    branch = undefined;
  };
  for (const line of stdout.split("\n")) {
    if (line.startsWith("worktree ")) {
      flush();
      path = line.slice("worktree ".length);
    } else if (line.startsWith("branch ")) {
      branch = line.slice("branch ".length);
    }
  }
  flush();
  return entries;
}

export function createImplementerGitState(
  options: ImplementerGitStateOptions,
): ImplementerGitState {
  const execute = options.execute ?? executeCapturingOutput;
  const git = async (arguments_: readonly string[]) => {
    const fullArguments = ["-C", options.checkoutPath, ...arguments_];
    return options.gitEnvironment === undefined
      ? execute("git", fullArguments)
      : execute("git", fullArguments, options.gitEnvironment);
  };
  const observer = options.observer ?? createCheckoutObserver({
    execute,
    ...(options.gitEnvironment === undefined
      ? {}
      : { gitEnvironment: options.gitEnvironment }),
  });

  // `for-each-ref` exits 0 with empty output when the ref is absent, so
  // observation never depends on matching a failing exit status.
  const observeRef = async (ref: string): Promise<string | undefined> => {
    const observed = (await git(["for-each-ref", "--format=%(objectname)", ref])).stdout.trim();
    return observed.length === 0 ? undefined : observed;
  };

  return {
    async prepareBranch(request) {
      // `git branch <name> <start>` creates the ref without touching HEAD,
      // the index, or any worktree, and fails when the name already exists.
      await git(["branch", request.branch, request.baseline]);
    },
    async fetchRemote() {
      await git(["fetch", "--no-tags", "origin"]);
    },
    observeLocalBranch(branch) {
      return observeRef(`refs/heads/${branch}`);
    },
    async observeRemoteBranch(branch) {
      // `rev-parse --verify --quiet` exits 1 silently when the
      // remote-tracking ref is absent, so absence is read from the exit
      // status rather than from ambiguous output.
      try {
        const observed = (await git([
          "rev-parse", "--verify", "--quiet", `origin/${branch}`,
        ])).stdout.trim();
        return observed.length === 0 ? undefined : observed;
      } catch (failure) {
        if (failure instanceof Error && /exited with 1$/u.test(failure.message)) {
          return undefined;
        }
        throw failure;
      }
    },
    async isAncestor(ancestor, descendant) {
      try {
        await git(["merge-base", "--is-ancestor", ancestor, descendant]);
        return true;
      } catch (failure) {
        // `merge-base --is-ancestor` exits 1 for "not an ancestor"; any
        // other failure (unknown revision, missing objects) propagates. The
        // exit status is matched at the end so exit 128 ("exited with 128")
        // is never mistaken for it.
        if (failure instanceof Error && /exited with 1$/u.test(failure.message)) {
          return false;
        }
        throw failure;
      }
    },
    async observeManagedWorktree(branch) {
      const listing = (await git(["worktree", "list", "--porcelain"])).stdout;
      const match = parseWorktreeList(listing)
        .find((entry) => entry.branch === `refs/heads/${branch}`);
      if (match === undefined) return undefined;
      if (normalizePath(match.path) === normalizePath(options.checkoutPath)) {
        throw new StopRetryError(
          "Implementer deterministic branch is checked out in the root Target Checkout",
        );
      }
      // Unobservable worktree state raises the observer's stop-retry
      // sentinel: residue questions are never answered by guesswork.
      const snapshot = await observer.observe(match.path);
      return {
        path: match.path,
        clean: snapshot.entries.every((entry) => entry.kind === "ignored"),
      };
    },
  };
}
