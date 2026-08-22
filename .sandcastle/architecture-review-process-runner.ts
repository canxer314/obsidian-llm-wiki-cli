import { spawn, type ChildProcess } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { runJobWithTimeout } from "./job-timeout.ts";
import type {
  ArchitectureReviewOutcome,
  ArchitectureReviewProposal,
} from "./architecture-review-automation.ts";

// Upstream architecture-review jobs time out after twenty minutes. The worker
// aborts itself at that mark so a timeout stays a classified graceful failure;
// the outer clock adds a margin and only force-kills a worker that ignored it.
const WORKER_TIMEOUT_MILLISECONDS = 20 * 60 * 1000;
const FORCE_KILL_MARGIN_MILLISECONDS = 60 * 1000;
const ARCHITECTURE_REVIEW_GRACE_MILLISECONDS = 10 * 1000;

function outputOf(child: ChildProcess): Promise<{ readonly output: string; readonly code: number | null; readonly diagnostics: string }> {
  return new Promise((resolveOutput, reject) => {
    let output = "";
    let diagnostics = "";
    child.stdout?.on("data", (chunk: Buffer | string) => { output += String(chunk); });
    child.stderr?.on("data", (chunk: Buffer | string) => { diagnostics += String(chunk); });
    child.once("error", reject);
    child.once("close", (code) => resolveOutput({ output, code, diagnostics }));
  });
}

function groupExit(pid: number): Promise<void> {
  return new Promise((resolveExit) => {
    const check = () => {
      try {
        process.kill(-pid, 0);
        setTimeout(check, 10);
      } catch {
        resolveExit();
      }
    };
    check();
  });
}

function parseOutcome(result: { readonly output: string; readonly code: number | null; readonly diagnostics: string }): ArchitectureReviewOutcome {
  if (result.code !== 0) {
    throw new Error(`Architecture review worker exited with ${result.code ?? "signal"}: ${result.diagnostics}`);
  }
  const line = result.output.trim().split("\n").at(-1);
  if (line === undefined) throw new Error("Architecture review worker did not return an outcome");
  return JSON.parse(line) as ArchitectureReviewOutcome;
}

export function createProcessArchitectureReviewRunner(options: {
  readonly timeoutMilliseconds?: number;
  readonly graceMilliseconds?: number;
  readonly start?: (arguments_: readonly string[]) => ChildProcess;
  readonly writeInput?: (path: string, priorProposals: readonly ArchitectureReviewProposal[]) => void;
  readonly kill?: (pid: number, signal: NodeJS.Signals) => void;
  readonly wait?: (milliseconds: number) => Promise<void>;
  readonly groupExited?: (pid: number) => Promise<void>;
}) {
  const start = options.start ?? ((arguments_) => spawn(process.execPath, [
    "--experimental-strip-types",
    resolve(import.meta.dirname, "architecture-review-worker.ts"),
    ...arguments_,
  ], {
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      HOME: process.env.HOME ?? "",
      PATH: process.env.PATH ?? "",
    },
  }));
  // The worker runs with a stripped environment, so the trusted parent hands
  // the prior proposals over through the local job artifact directory. The
  // write is synchronous so output listeners attach before callers can emit.
  const writeInput = options.writeInput ?? ((path, priorProposals) => {
    writeFileSync(path, JSON.stringify(priorProposals), { mode: 0o600 });
  });
  return {
    async review(request: {
      readonly revision: string;
      readonly checkoutPath: string;
      readonly priorProposals: readonly ArchitectureReviewProposal[];
      readonly model: string;
      readonly artifactDirectory: string;
    }): Promise<ArchitectureReviewOutcome> {
      writeInput(
        join(request.artifactDirectory, "architecture-review-input.json"),
        request.priorProposals,
      );
      const arguments_ = [
        request.revision,
        request.checkoutPath,
        request.model,
        request.artifactDirectory,
      ];
      let child: ChildProcess | undefined;
      let output: Promise<{ readonly output: string; readonly code: number | null; readonly diagnostics: string }> | undefined;
      const result = await runJobWithTimeout({
        start: () => {
          child = start(arguments_);
          if (child.pid === undefined) throw new Error("Architecture review worker did not expose a process ID");
          output = outputOf(child);
          return {
            pid: child.pid,
            exited: output.then(() => undefined),
            groupExited: (options.groupExited ?? groupExit)(child.pid),
          };
        },
        timeoutMilliseconds: options.timeoutMilliseconds ?? WORKER_TIMEOUT_MILLISECONDS + FORCE_KILL_MARGIN_MILLISECONDS,
        graceMilliseconds: options.graceMilliseconds ?? ARCHITECTURE_REVIEW_GRACE_MILLISECONDS,
        kill: options.kill ?? process.kill,
        wait: options.wait ?? (async (milliseconds) => new Promise((resolveWait) => setTimeout(resolveWait, milliseconds))),
      });
      if (result.status === "timed-out") throw new Error("Architecture review execution timed out");
      return parseOutcome(await output!);
    },
  };
}
