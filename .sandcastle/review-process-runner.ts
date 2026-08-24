import { spawn, type ChildProcess } from "node:child_process";
import { resolve } from "node:path";

import { runJobWithTimeout } from "./job-timeout.ts";
import type { ExtractedReview } from "./review-extraction.ts";

const REVIEW_TIMEOUT_MILLISECONDS = 30 * 60 * 1000;
const REVIEW_GRACE_MILLISECONDS = 10 * 1000;

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
function parseReview(result: { readonly output: string; readonly code: number | null; readonly diagnostics: string }): ExtractedReview {
  if (result.code !== 0) {
    throw new Error(`Reviewer worker exited with ${result.code ?? "signal"}: ${result.diagnostics}`);
  }
  const line = result.output.trim().split("\n").at(-1);
  if (line === undefined) throw new Error("Reviewer worker did not return a review");
  return JSON.parse(line) as ExtractedReview;
}

export function createProcessReviewRunner(options: {
  readonly timeoutMilliseconds?: number;
  readonly graceMilliseconds?: number;
  readonly start?: (arguments_: readonly string[]) => ChildProcess;
  readonly kill?: (pid: number, signal: NodeJS.Signals) => void;
  readonly wait?: (milliseconds: number) => Promise<void>;
  readonly groupExited?: (pid: number) => Promise<void>;
}) {
  const start = options.start ?? ((arguments_) => spawn(process.execPath, [
    "--experimental-strip-types",
    resolve(import.meta.dirname, "review-worker.ts"),
    ...arguments_,
  ], {
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      HOME: process.env.HOME ?? "",
      PATH: process.env.PATH ?? "",
    },
  }));
  return {
    async review(request: {
      readonly pullRequestNumber: number;
      readonly branch: string;
      readonly revision: string;
      readonly checkoutPath: string;
      readonly reviewThreads: readonly import("./review-automation.ts").ReviewThreadComment[];
      readonly model: string;
      readonly artifactDirectory: string;
    }): Promise<ExtractedReview> {
      const arguments_ = [
        String(request.pullRequestNumber),
        request.branch,
        request.revision,
        request.checkoutPath,
        JSON.stringify(request.reviewThreads),
        request.model,
        request.artifactDirectory,
      ];
      let child: ChildProcess | undefined;
      let output: Promise<{ readonly output: string; readonly code: number | null; readonly diagnostics: string }> | undefined;
      const result = await runJobWithTimeout({
        start: () => {
          child = start(arguments_);
          if (child.pid === undefined) throw new Error("Reviewer worker did not expose a process ID");
          output = outputOf(child);
          return {
            pid: child.pid,
            exited: output.then(() => undefined),
            groupExited: (options.groupExited ?? groupExit)(child.pid),
          };
        },
        timeoutMilliseconds: options.timeoutMilliseconds ?? REVIEW_TIMEOUT_MILLISECONDS,
        graceMilliseconds: options.graceMilliseconds ?? REVIEW_GRACE_MILLISECONDS,
        kill: options.kill ?? process.kill,
        wait: options.wait ?? (async (milliseconds) => new Promise((resolveWait) => setTimeout(resolveWait, milliseconds))),
      });
      if (result.status === "timed-out") throw new Error("Reviewer execution timed out");
      return parseReview(await output!);
    },
  };
}
