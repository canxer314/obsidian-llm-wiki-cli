import { spawn, type ChildProcess } from "node:child_process";
import { resolve } from "node:path";

import { runJobWithTimeout } from "./job-timeout.ts";

// Upstream agent workflows time out after sixty minutes. These workers carry
// no inner clock, so the outer process-group clock fires at that mark itself;
// after the grace interval the whole descendant tree is force-killed.
const AGENT_JOB_TIMEOUT_MILLISECONDS = 60 * 60 * 1000;
const AGENT_JOB_GRACE_MILLISECONDS = 10 * 1000;

export interface AgentWorkerResult {
  readonly output: string;
  readonly code: number | null;
  readonly diagnostics: string;
}

function outputOf(child: ChildProcess): Promise<AgentWorkerResult> {
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

export interface AgentWorkerOptions {
  readonly workerFile: string;
  readonly workerName: string;
  readonly arguments_: readonly string[];
  readonly timeoutMessage: string;
  readonly timeoutMilliseconds?: number | undefined;
  readonly graceMilliseconds?: number | undefined;
  readonly start?: ((arguments_: readonly string[]) => ChildProcess) | undefined;
  readonly kill?: ((pid: number, signal: NodeJS.Signals) => void) | undefined;
  readonly wait?: ((milliseconds: number) => Promise<void>) | undefined;
  readonly groupExited?: ((pid: number) => Promise<void>) | undefined;
}

export async function runAgentWorker(options: AgentWorkerOptions): Promise<AgentWorkerResult> {
  const start = options.start ?? ((arguments_) => spawn(process.execPath, [
    "--experimental-strip-types",
    resolve(import.meta.dirname, options.workerFile),
    ...arguments_,
  ], {
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      HOME: process.env.HOME ?? "",
      PATH: process.env.PATH ?? "",
    },
  }));
  let output: Promise<AgentWorkerResult> | undefined;
  const result = await runJobWithTimeout({
    start: () => {
      const child = start(options.arguments_);
      if (child.pid === undefined) throw new Error(`${options.workerName} worker did not expose a process ID`);
      output = outputOf(child);
      return {
        pid: child.pid,
        exited: output.then(() => undefined),
        groupExited: (options.groupExited ?? groupExit)(child.pid),
      };
    },
    timeoutMilliseconds: options.timeoutMilliseconds ?? AGENT_JOB_TIMEOUT_MILLISECONDS,
    graceMilliseconds: options.graceMilliseconds ?? AGENT_JOB_GRACE_MILLISECONDS,
    kill: options.kill ?? process.kill,
    wait: options.wait ?? (async (milliseconds) => new Promise((resolveWait) => setTimeout(resolveWait, milliseconds))),
  });
  if (result.status === "timed-out") throw new Error(options.timeoutMessage);
  return output!;
}

export function workerJson<TResult>(result: AgentWorkerResult, workerName: string): TResult {
  if (result.code !== 0) {
    throw new Error(`${workerName} worker exited with ${result.code ?? "signal"}: ${result.diagnostics}`);
  }
  const line = result.output.trim().split("\n").at(-1);
  if (line === undefined) throw new Error(`${workerName} worker did not return a result`);
  return JSON.parse(line) as TResult;
}
