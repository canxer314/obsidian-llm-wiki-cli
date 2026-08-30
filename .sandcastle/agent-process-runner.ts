import { spawn, type ChildProcess } from "node:child_process";
import { resolve } from "node:path";

import { appendJobOutputFromEnvironment } from "./job-logs.ts";
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
  readonly timeoutMilliseconds?: number | undefined;
  readonly graceMilliseconds?: number | undefined;
  readonly start?: ((arguments_: readonly string[]) => ChildProcess) | undefined;
}

export type AgentWorkerOptions = FixedAgentWorkerOptions;

export interface TargetJobOptions extends FixedAgentWorkerOptions {
  readonly environment?: Readonly<Record<string, string>> | undefined;
}

function inheritedJobLogEnvironment(): Readonly<Record<string, string>> {
  return Object.fromEntries([
    "SANDCASTLE_JOB_STDOUT_LOG",
    "SANDCASTLE_JOB_STDERR_LOG",
  ].flatMap((name) => process.env[name] === undefined ? [] : [[name, process.env[name]!]]));
}

function processEnvironment(
  role: WorkerProcessRole,
  environment: Readonly<Record<string, string>> | undefined,
  inherited: boolean,
): Readonly<Record<string, string>> {
  return {
    HOME: process.env.HOME ?? "",
    PATH: process.env.PATH ?? "",
    ...(role === "owner" || inherited ? { [INHERITED_JOB_PROCESS_GROUP]: "1" } : {}),
    ...(role === "owner" ? environment : inheritedJobLogEnvironment()),
  };
}

async function runFixedAgentWorker(
  options: FixedAgentWorkerOptions,
  role: WorkerProcessRole,
  environment?: Readonly<Record<string, string>>,
): Promise<AgentWorkerResult> {
  const lifecycle = createWorkerProcessLifecycle();
  let outputSinkEnvironment: Readonly<Record<string, string | undefined>> = {};
  const result = await lifecycle.run({
    role,
    timeoutMilliseconds: options.timeoutMilliseconds ?? AGENT_JOB_TIMEOUT_MILLISECONDS,
    graceMilliseconds: options.graceMilliseconds ?? AGENT_JOB_GRACE_MILLISECONDS,
    ...(options.input === undefined ? {} : { startup: options.input }),
    outputSink: (stream, chunk) => appendJobOutputFromEnvironment(
      outputSinkEnvironment,
      stream,
      chunk,
    ),
    launch: (admit, disposition) => {
      outputSinkEnvironment = role === "owner" ? environment ?? {} : disposition.inherited
        ? process.env
        : {};
      const start = options.start ?? ((arguments_: readonly string[]) => spawn(process.execPath, [
        "--experimental-strip-types",
        resolve(options.checkoutPath, ".sandcastle", options.workerFile),
        ...arguments_,
      ], {
        detached: disposition.detached,
        stdio: ["pipe", "pipe", "pipe"],
        env: processEnvironment(role, environment, disposition.inherited),
      }));
      admit(start(options.arguments_));
    },
  });
  if (result.status === "timed-out") throw new AgentWorkerTimeoutError(options.timeoutMessage);
  if (result.outputSinkError !== undefined) throw result.outputSinkError;
  return { output: result.stdout, code: result.code, diagnostics: result.stderr };
}

export function runAgentWorker(options: AgentWorkerOptions): Promise<AgentWorkerResult> {
  return runFixedAgentWorker(options, "nested");
}

export function runTargetJob(options: TargetJobOptions): Promise<AgentWorkerResult> {
  return runFixedAgentWorker(options, "owner", options.environment);
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
