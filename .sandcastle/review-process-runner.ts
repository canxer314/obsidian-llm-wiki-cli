import { spawn, type ChildProcess } from "node:child_process";
import { resolve } from "node:path";

import { workerProcessOptions } from "./worker-process.ts";
import { createWorkerProcessLifecycle } from "./worker-process-lifecycle.ts";
import type { ExtractedReview } from "./review-extraction.ts";

const REVIEW_TIMEOUT_MILLISECONDS = 30 * 60 * 1000;
const REVIEW_GRACE_MILLISECONDS = 10 * 1000;

function parseReview(result: { readonly stdout: string; readonly stderr: string; readonly code: number | null }): ExtractedReview {
  if (result.code !== 0) {
    throw new Error(`Reviewer worker exited with ${result.code ?? "signal"}: ${result.stderr}`);
  }
  const line = result.stdout.trim().split("\n").at(-1);
  if (line === undefined) throw new Error("Reviewer worker did not return a review");
  return JSON.parse(line) as ExtractedReview;
}

export function createProcessReviewRunner(options: {
  readonly startup: string;
  readonly timeoutMilliseconds?: number;
  readonly graceMilliseconds?: number;
  readonly start?: (arguments_: readonly string[], disposition: { readonly detached: boolean; readonly inherited: boolean }) => ChildProcess;
  readonly lifecycle?: ReturnType<typeof createWorkerProcessLifecycle>;
}) {
  const lifecycle = options.lifecycle ?? createWorkerProcessLifecycle();
  const start = options.start ?? ((arguments_, disposition) => {
    const processOptions = workerProcessOptions("nested");
    return spawn(process.execPath, [
      "--experimental-strip-types",
      resolve(import.meta.dirname, "review-worker.ts"),
      ...arguments_,
    ], {
      detached: disposition.detached,
      stdio: ["pipe", "pipe", "pipe"],
      env: processOptions.environment,
    });
  });
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
      const result = await lifecycle.run({
        role: "nested",
        timeoutMilliseconds: options.timeoutMilliseconds ?? REVIEW_TIMEOUT_MILLISECONDS,
        graceMilliseconds: options.graceMilliseconds ?? REVIEW_GRACE_MILLISECONDS,
        startup: options.startup,
        launch: (admit, disposition) => admit(start(arguments_, disposition)),
      });
      if (result.status === "timed-out") throw new Error("Reviewer execution timed out");
      return parseReview(result);
    },
  };
}
