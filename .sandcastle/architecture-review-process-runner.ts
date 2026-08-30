import { spawn, type ChildProcess } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import {
  createWorkerProcessLifecycle,
  type WorkerProcessLaunchDisposition,
} from "./worker-process-lifecycle.ts";
import { workerProcessEnvironment } from "./worker-process.ts";
import type {
  ArchitectureReviewOutcome,
  ArchitectureReviewProposal,
} from "./architecture-review-automation.ts";
import { architectureReviewSchema } from "./architecture-review-extraction.ts";

// Upstream architecture-review jobs time out after twenty minutes. The worker
// aborts itself at that mark so a timeout stays a classified graceful failure;
// the outer clock adds a margin and only force-kills a worker that ignored it.
const WORKER_TIMEOUT_MILLISECONDS = 20 * 60 * 1000;
const FORCE_KILL_MARGIN_MILLISECONDS = 60 * 1000;
const ARCHITECTURE_REVIEW_GRACE_MILLISECONDS = 10 * 1000;

function parseOutcome(result: {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number | null;
}): ArchitectureReviewOutcome {
  if (result.code !== 0) {
    throw new Error(`Architecture review worker exited with ${result.code ?? "signal"}: ${result.stderr}`);
  }
  const output = result.stdout.trim();
  if (output.length === 0) throw new Error("Architecture review worker did not return an outcome");
  const line = output.split("\n").at(-1)!;
  const parsed: unknown = JSON.parse(line);
  const outcome = architectureReviewSchema.safeParse(parsed);
  if (!outcome.success) {
    throw new Error("Architecture review worker returned an invalid outcome");
  }
  return outcome.data;
}

export function createProcessArchitectureReviewRunner(options: {
  readonly startup: string;
  readonly start?: (arguments_: readonly string[]) => ChildProcess;
  readonly writeInput?: (path: string, priorProposals: readonly ArchitectureReviewProposal[]) => void;
}) {
  const lifecycle = createWorkerProcessLifecycle();
  const start = (arguments_: readonly string[], disposition: WorkerProcessLaunchDisposition) =>
    options.start?.(arguments_) ?? spawn(process.execPath, [
    "--experimental-strip-types",
    resolve(import.meta.dirname, "architecture-review-worker.ts"),
    ...arguments_,
  ], {
    detached: disposition.detached,
    stdio: ["pipe", "pipe", "pipe"],
    env: workerProcessEnvironment(disposition),
  });
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
      const result = await lifecycle.run({
        role: "nested",
        startup: options.startup,
        timeoutMilliseconds: WORKER_TIMEOUT_MILLISECONDS + FORCE_KILL_MARGIN_MILLISECONDS,
        graceMilliseconds: ARCHITECTURE_REVIEW_GRACE_MILLISECONDS,
        launch: (admit, disposition) => admit(start(arguments_, disposition)),
      });
      if (result.status === "timed-out") throw new Error("Architecture review execution timed out");
      return parseOutcome(result);
    },
  };
}
