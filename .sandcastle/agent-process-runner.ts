import { spawn, type ChildProcess } from "node:child_process";
import { resolve } from "node:path";

import { runJobWithTimeout } from "./job-timeout.ts";
import {
  appendJobOutputFromEnvironment,
} from "./job-logs.ts";
import { workerProcessOptions } from "./worker-process.ts";

// Upstream agent workflows time out after sixty minutes. These workers carry
// no inner clock, so the outer process-group clock fires at that mark itself;
// after the grace interval the whole descendant tree is force-killed.
const AGENT_JOB_TIMEOUT_MILLISECONDS = 60 * 60 * 1000;
const AGENT_JOB_GRACE_MILLISECONDS = 10 * 1000;

export class AgentWorkerTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentWorkerTimeoutError";
  }
}

// A worker that exits unsuccessfully may be untrusted Target revision code
// whose stderr carries operation-transformed secrets. The full message stays
// available for local diagnosis; `publicSummary` is the only classification
// trusted GitHub diagnostics may publish, because pattern redaction cannot
// recognize transformed secrets (e.g. base64-encoded credentials).
export class AgentWorkerExitError extends Error {
  readonly publicSummary: string;

  constructor(options: {
    readonly workerName: string;
    readonly code: number | null;
    readonly diagnostics: string;
  }) {
    const publicSummary = `${options.workerName} worker exited with ${options.code ?? "signal"}`;
    super(`${publicSummary}: ${options.diagnostics}`);
    this.name = "AgentWorkerExitError";
    this.publicSummary = publicSummary;
  }
}

export interface AgentWorkerResult {
  readonly output: string;
  readonly code: number | null;
  readonly diagnostics: string;
}

interface CapturedAgentWorkerResult extends AgentWorkerResult {
  readonly logError?: unknown;
}

function outputOf(
  child: ChildProcess,
  environment: Readonly<Record<string, string>> | undefined,
): Promise<CapturedAgentWorkerResult> {
  return new Promise((resolveOutput, reject) => {
    let output = "";
    let diagnostics = "";
    let logError: unknown;
    const append = (
      stream: "stdout" | "stderr",
      chunk: Buffer | string,
    ): void => {
      if (environment === undefined || logError !== undefined) return;
      try {
        appendJobOutputFromEnvironment(environment, stream, chunk);
      } catch (error) {
        logError = error;
      }
    };
    child.stdout?.on("data", (chunk: Buffer | string) => {
      output += String(chunk);
      append("stdout", chunk);
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      diagnostics += String(chunk);
      append("stderr", chunk);
    });
    child.once("error", reject);
    child.once("close", (code) => resolveOutput({
      output,
      code,
      diagnostics,
      ...(logError === undefined ? {} : { logError }),
    }));
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

export interface AgentWorkerOptions {
  readonly checkoutPath: string;
  readonly workerFile: string;
  readonly workerName: string;
  readonly arguments_: readonly string[];
  readonly input?: string | undefined;
  readonly timeoutMessage: string;
  readonly timeoutMilliseconds?: number | undefined;
  readonly graceMilliseconds?: number | undefined;
  readonly start?: ((arguments_: readonly string[]) => ChildProcess) | undefined;
  readonly kill?: ((pid: number, signal: NodeJS.Signals) => void) | undefined;
  readonly wait?: ((milliseconds: number) => Promise<void>) | undefined;
  readonly groupExited?: ((pid: number) => Promise<void>) | undefined;
  readonly processGroupOwner?: boolean | undefined;
  readonly inheritedEnvironment?: Readonly<Record<string, string>> | undefined;
}

export async function runAgentWorker(options: AgentWorkerOptions): Promise<AgentWorkerResult> {
  const processOptions = workerProcessOptions(
    options.processGroupOwner === true ? "owner" : "nested",
    options.inheritedEnvironment,
  );
  const start = options.start ?? ((arguments_) => spawn(process.execPath, [
    "--experimental-strip-types",
    resolve(options.checkoutPath, ".sandcastle", options.workerFile),
    ...arguments_,
  ], {
    detached: processOptions.detached,
    stdio: ["pipe", "pipe", "pipe"],
    env: processOptions.environment,
  }));
  const captureEnvironment = options.processGroupOwner === true
    ? options.inheritedEnvironment
    : undefined;
  if (processOptions.inherited) {
    const child = start(options.arguments_);
    child.stdin?.end(options.input);
    return outputOf(child, captureEnvironment);
  }
  let output: Promise<CapturedAgentWorkerResult> | undefined;
  const result = await runJobWithTimeout({
    start: () => {
      const child = start(options.arguments_);
      if (child.pid === undefined) throw new Error(`${options.workerName} worker did not expose a process ID`);
      child.stdin?.end(options.input);
      output = outputOf(child, captureEnvironment);
      return {
        pid: child.pid,
        exited: output.then(() => undefined),
        groupExited: (options.groupExited ?? groupExit)(child.pid),
      };
    },
    timeoutMilliseconds: options.timeoutMilliseconds ?? AGENT_JOB_TIMEOUT_MILLISECONDS,
    graceMilliseconds: options.graceMilliseconds ?? AGENT_JOB_GRACE_MILLISECONDS,
    kill: options.kill ?? process.kill,
    wait: options.wait ?? (async (milliseconds) => new Promise((resolveWait) => {
      const timer = setTimeout(resolveWait, milliseconds);
      timer.unref();
    })),
  });
  if (result.status === "timed-out") {
    throw new AgentWorkerTimeoutError(options.timeoutMessage);
  }
  const captured = await output!;
  if (captured.logError !== undefined) throw captured.logError;
  return captured;
}

export function workerJson<TResult>(result: AgentWorkerResult, workerName: string): TResult {
  if (result.code !== 0) {
    throw new AgentWorkerExitError({
      workerName,
      code: result.code,
      diagnostics: result.diagnostics,
    });
  }
  const output = result.output.trim();
  if (output.length === 0) throw new Error(`${workerName} worker did not return a result`);
  const line = output.split("\n").at(-1)!;
  try {
    return JSON.parse(line) as TResult;
  } catch {
    throw new Error(`${workerName} worker returned invalid JSON`);
  }
}
