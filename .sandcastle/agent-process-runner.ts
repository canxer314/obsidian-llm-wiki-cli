import { spawn, type ChildProcess } from "node:child_process";
import { resolve } from "node:path";

import {
  appendJobOutputFromEnvironment,
  inheritedJobLogEnvironment,
  type JobLog,
} from "./job-logs.ts";
import { createWorkerProcessLifecycle, type WorkerProcessRole } from "./worker-process-lifecycle.ts";
import { INHERITED_JOB_PROCESS_GROUP } from "./worker-process.ts";

const AGENT_JOB_TIMEOUT_MILLISECONDS = 60 * 60 * 1000;
const AGENT_JOB_GRACE_MILLISECONDS = 10 * 1000;

export class AgentWorkerTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentWorkerTimeoutError";
  }
}

export class AgentWorkerExitError extends Error {
  declare readonly code: number | null;
  declare readonly publicSummary: string;

  constructor(options: {
    readonly workerName: string;
    readonly code: number | null;
    readonly diagnostics: string;
  }) {
    const publicSummary = `${options.workerName} worker exited with ${options.code ?? "signal"}`;
    super(`${publicSummary}: ${options.diagnostics}`);
    this.name = "AgentWorkerExitError";
    Object.defineProperties(this, {
      code: {
        configurable: false,
        enumerable: true,
        value: options.code,
        writable: false,
      },
      publicSummary: {
        configurable: false,
        enumerable: true,
        value: publicSummary,
        writable: false,
      },
    });
  }
}

export interface AgentWorkerResult {
  readonly output: string;
  readonly code: number | null;
  readonly diagnostics: string;
}

interface FixedAgentWorkerOptions {
  readonly checkoutPath: string;
  readonly workerFile: string;
  readonly workerName: string;
  readonly arguments_: readonly string[];
  readonly input?: string | undefined;
  readonly timeoutMessage: string;
  readonly start?: ((arguments_: readonly string[]) => ChildProcess) | undefined;
}

export type AgentWorkerOptions = FixedAgentWorkerOptions;

export interface TargetJobOptions extends FixedAgentWorkerOptions {
  readonly timeoutMilliseconds: number;
  readonly graceMilliseconds: number;
  readonly log?: JobLog | undefined;
}

function inheritedJobLogEnvironmentFromProcess(): Readonly<Record<string, string>> {
  return Object.fromEntries([
    "SANDCASTLE_JOB_STDOUT_LOG",
    "SANDCASTLE_JOB_STDERR_LOG",
  ].flatMap((name) => process.env[name] === undefined ? [] : [[name, process.env[name]!]]));
}

function outputEnvironment(
  role: WorkerProcessRole,
  log: JobLog | undefined,
): Readonly<Record<string, string | undefined>> {
  return role === "owner" ? log === undefined ? {} : inheritedJobLogEnvironment(log) : process.env;
}

function processEnvironment(
  role: WorkerProcessRole,
  log: JobLog | undefined,
): Readonly<Record<string, string>> {
  return {
    HOME: process.env.HOME ?? "",
    PATH: process.env.PATH ?? "",
    [INHERITED_JOB_PROCESS_GROUP]: "1",
    ...(role === "owner" ? log === undefined ? {} : inheritedJobLogEnvironment(log) : inheritedJobLogEnvironmentFromProcess()),
  };
}

async function runFixedAgentWorker(
  options: FixedAgentWorkerOptions,
  role: WorkerProcessRole,
  timeoutMilliseconds: number,
  graceMilliseconds: number,
  log?: JobLog,
): Promise<AgentWorkerResult> {
  const lifecycle = createWorkerProcessLifecycle();
  let outputSinkEnvironment: Readonly<Record<string, string | undefined>> = {};
  const result = await lifecycle.run({
    role,
    timeoutMilliseconds,
    graceMilliseconds,
    ...(options.input === undefined ? {} : { startup: options.input }),
    outputSink: (stream, chunk) => appendJobOutputFromEnvironment(
      outputSinkEnvironment,
      stream,
      chunk,
    ),
    launch: (admit, { detached }) => {
      outputSinkEnvironment = outputEnvironment(role, log);
      const start = options.start ?? ((arguments_: readonly string[]) => spawn(process.execPath, [
        "--experimental-strip-types",
        resolve(options.checkoutPath, ".sandcastle", options.workerFile),
        ...arguments_,
      ], {
        detached,
        stdio: ["pipe", "pipe", "pipe"],
        env: processEnvironment(role, log),
      }));
      admit(start(options.arguments_));
    },
  });
  if (result.status === "timed-out") throw new AgentWorkerTimeoutError(options.timeoutMessage);
  if (result.outputSinkError !== undefined) throw result.outputSinkError;
  return { output: result.stdout, code: result.code, diagnostics: result.stderr };
}

export function runAgentWorker(options: AgentWorkerOptions): Promise<AgentWorkerResult> {
  return runFixedAgentWorker(
    options,
    "nested",
    AGENT_JOB_TIMEOUT_MILLISECONDS,
    AGENT_JOB_GRACE_MILLISECONDS,
  );
}

export function runTargetJob(options: TargetJobOptions): Promise<AgentWorkerResult> {
  return runFixedAgentWorker(
    options,
    "owner",
    options.timeoutMilliseconds,
    options.graceMilliseconds,
    options.log,
  );
}

export function workerJson<TResult>(
  result: AgentWorkerResult,
  workerName: string,
  exitError: (options: {
    readonly workerName: string;
    readonly code: number | null;
    readonly diagnostics: string;
  }) => Error = (options) => new AgentWorkerExitError(options),
): TResult {
  if (result.code !== 0) {
    throw exitError({
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
