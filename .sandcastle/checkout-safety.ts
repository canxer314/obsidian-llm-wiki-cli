import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";

import { StopRetryError } from "./invocation-recovery.ts";

// Repository-owned Git checkout safety observer (Spec #449). It proves
// whether a Target Checkout remained safe to reuse by comparing HEAD, the
// index, the tracked worktree, unmerged paths, and non-ignored untracked
// files. Ignored files and fetch-related Git metadata (fetched objects,
// remote-tracking refs, FETCH_HEAD) never count as local mutation. Missing
// paths, failed observer commands, and malformed observer output all raise
// the controlled stop-retry outcome: unobservable state is never treated as
// evidence that recovery is safe.

export interface CheckoutObserverExecution {
  readonly stdout: string;
  readonly stderr: string;
}

export type CheckoutObserverExecute = (
  file: string,
  arguments_: readonly string[],
  environment?: Readonly<Record<string, string>>,
) => Promise<CheckoutObserverExecution>;

export interface CheckoutObserverOptions {
  readonly execute?: CheckoutObserverExecute;
  readonly gitEnvironment?: Readonly<Record<string, string>>;
}

export type CheckoutStatusEntryKind = "tracked" | "unmerged" | "untracked" | "ignored";

export interface CheckoutStatusEntry {
  readonly index: string;
  readonly worktree: string;
  readonly path: string;
  readonly kind: CheckoutStatusEntryKind;
}

export interface CheckoutSnapshot {
  readonly head: string;
  readonly entries: readonly CheckoutStatusEntry[];
}

export interface CheckoutObserver {
  observe(checkoutPath: string): Promise<CheckoutSnapshot>;
  requireClean(checkoutPath: string): Promise<CheckoutSnapshot>;
  requireUnchanged(before: CheckoutSnapshot, checkoutPath: string): Promise<CheckoutSnapshot>;
}

class ObserverCommandError extends Error {
  constructor(summary: string) {
    super(summary);
    this.name = "ObserverCommandError";
  }
}

// Observer commands follow the Target Checkout execution pattern: a fixed
// executable with captured output. Child stderr stays local to the failing
// call and is carried only as the stop-retry sentinel's in-memory cause.
async function executeCapturingOutput(
  file: string,
  arguments_: readonly string[],
  environment?: Readonly<Record<string, string>>,
): Promise<CheckoutObserverExecution> {
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
      reject(new ObserverCommandError(
        `${file} ${arguments_[0] ?? ""} exited with ${code ?? signal ?? "unknown status"}`,
      ));
    });
  });
}

function observationFailure(summary: string, cause?: unknown): StopRetryError {
  const failure = new StopRetryError(summary);
  if (cause !== undefined) {
    // The failed observation remains available for local diagnosis as an
    // in-memory cause; it is never copied into retry logs.
    Object.defineProperty(failure, "cause", {
      configurable: true,
      enumerable: false,
      value: cause,
      writable: true,
    });
  }
  return failure;
}

const UNMERGED_INDEX_WORKTREE = new Set(["DD", "AU", "UD", "UA", "DU", "AA", "UU"]);
const STATUS_CODE = /^[ MADRCU?!]$/u;

// Parses `git status --porcelain=v1 -z --no-renames` output. Any record that
// does not match the exact porcelain shape is malformed observer output and
// fails closed rather than being treated as a clean checkout.
function parseStatusEntries(stdout: string): CheckoutStatusEntry[] {
  const records = stdout.split("\0");
  if (records.length > 0 && records[records.length - 1] === "") records.pop();
  return records.map((record) => {
    const match = /^(.{2}) (.+)$/su.exec(record);
    if (
      match === null || match[1] === undefined || match[2] === undefined ||
      !STATUS_CODE.test(match[1].charAt(0)) || !STATUS_CODE.test(match[1].charAt(1))
    ) {
      throw new Error(`malformed porcelain record: ${JSON.stringify(record.slice(0, 16))}`);
    }
    const index = match[1].charAt(0);
    const worktree = match[1].charAt(1);
    const path = match[2];
    let kind: CheckoutStatusEntryKind;
    if (index === "?" && worktree === "?") kind = "untracked";
    else if (index === "!" && worktree === "!") kind = "ignored";
    else if (UNMERGED_INDEX_WORKTREE.has(match[1])) kind = "unmerged";
    else if (index === "?" || worktree === "?" || index === "!" || worktree === "!") {
      throw new Error(`malformed porcelain record: ${JSON.stringify(record.slice(0, 16))}`);
    } else kind = "tracked";
    return { index, worktree, path, kind };
  });
}

function canonicalEntries(entries: readonly CheckoutStatusEntry[]): string {
  return JSON.stringify(entries.map((entry) => [
    entry.index, entry.worktree, entry.kind, entry.path,
  ]));
}

export function createCheckoutObserver(options?: CheckoutObserverOptions): CheckoutObserver {
  const execute = options?.execute ?? executeCapturingOutput;
  const git = async (checkoutPath: string, arguments_: readonly string[]) => {
    const fullArguments = ["-C", checkoutPath, ...arguments_];
    return options?.gitEnvironment === undefined
      ? execute("git", fullArguments)
      : execute("git", fullArguments, options.gitEnvironment);
  };

  const observe = async (checkoutPath: string): Promise<CheckoutSnapshot> => {
    try {
      const pathStat = await stat(checkoutPath);
      if (!pathStat.isDirectory()) {
        throw observationFailure("Target Checkout path is missing");
      }
    } catch (error) {
      if (error instanceof StopRetryError) throw error;
      throw observationFailure("Target Checkout path is missing", error);
    }
    let head: string;
    try {
      head = (await git(checkoutPath, ["rev-parse", "HEAD"])).stdout.trim();
    } catch (error) {
      throw observationFailure("Target Checkout state cannot be observed", error);
    }
    if (!/^[0-9a-f]{40}$/u.test(head)) {
      throw observationFailure("Target Checkout observer output is malformed");
    }
    let status: string;
    try {
      status = (await git(checkoutPath, [
        "status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all",
      ])).stdout;
    } catch (error) {
      throw observationFailure("Target Checkout state cannot be observed", error);
    }
    let entries: CheckoutStatusEntry[];
    try {
      entries = parseStatusEntries(status);
    } catch (error) {
      throw observationFailure("Target Checkout observer output is malformed", error);
    }
    return { head, entries };
  };

  return {
    observe,
    async requireClean(checkoutPath) {
      const snapshot = await observe(checkoutPath);
      const local = snapshot.entries.filter((entry) => entry.kind !== "ignored");
      if (local.length === 0) return snapshot;
      const staged = local.filter((entry) =>
        entry.kind === "tracked" && entry.index !== " " && entry.index !== "?"
      ).length;
      const unstaged = local.filter((entry) =>
        entry.kind === "tracked" && entry.worktree !== " "
      ).length;
      const unmerged = local.filter((entry) => entry.kind === "unmerged").length;
      const untracked = local.filter((entry) => entry.kind === "untracked").length;
      // The summary carries only repository-owned counts, never paths or
      // output from the failed observation.
      throw observationFailure(
        `Target Checkout is not clean (staged=${staged}, unstaged=${unstaged}, ` +
        `unmerged=${unmerged}, untracked=${untracked})`,
      );
    },
    async requireUnchanged(before, checkoutPath) {
      const after = await observe(checkoutPath);
      if (
        after.head !== before.head ||
        canonicalEntries(after.entries) !== canonicalEntries(before.entries)
      ) {
        throw observationFailure("Target Checkout changed during a read-only stage");
      }
      return after;
    },
  };
}
