import type { ChildProcess } from "node:child_process";

import { runJobWithTimeout } from "./job-timeout.ts";
import { INHERITED_JOB_PROCESS_GROUP } from "./worker-process.ts";

export type WorkerProcessRole = "owner" | "nested";

export interface WorkerProcessLaunchDisposition {
  readonly detached: boolean;
  readonly inherited: boolean;
}

export type WorkerProcessLifecycleOutcome =
  | {
    readonly status: "completed";
    readonly stdout: string;
    readonly stderr: string;
    readonly code: number | null;
    readonly outputSinkError?: unknown;
  }
  | { readonly status: "timed-out" };

interface CapturedChildOutput {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number | null;
  readonly outputSinkError?: unknown;
}

interface ObservedChild {
  readonly output: Promise<CapturedChildOutput>;
  readonly exited: Promise<void>;
}

interface WorkerProcessLifecycleOptions {
  readonly kill?: (pid: number, signal: NodeJS.Signals) => void;
  readonly wait?: (milliseconds: number) => Promise<void>;
  readonly probeGroup?: (pid: number) => void;
  readonly groupExited?: (pid: number) => Promise<void>;
}

interface WorkerProcessRunOptions {
  readonly role: WorkerProcessRole;
  readonly timeoutMilliseconds: number;
  readonly graceMilliseconds: number;
  readonly startup?: string;
  readonly outputSink?: (stream: "stdout" | "stderr", chunk: Buffer | string) => void;
  readonly launch: (
    admit: (child: ChildProcess) => void,
    disposition: WorkerProcessLaunchDisposition,
  ) => void;
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    timer.unref();
  });
}

function isGroupAbsent(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ESRCH";
}

function dispositionFor(
  role: WorkerProcessRole,
  environment: Readonly<Record<string, string | undefined>>,
): WorkerProcessLaunchDisposition {
  const inherited = role === "nested" && environment[INHERITED_JOB_PROCESS_GROUP] === "1";
  return { detached: !inherited, inherited };
}

function observeChild(
  child: ChildProcess,
  outputSink: WorkerProcessRunOptions["outputSink"],
): ObservedChild {
  let resolveExit!: () => void;
  let rejectExit!: (error: Error) => void;
  const exitSignal = new Promise<void>((resolve, reject) => {
    resolveExit = resolve;
    rejectExit = reject;
  });
  const onExit = (): void => resolveExit();
  const onExitError = (error: Error): void => rejectExit(error);
  child.once("exit", onExit);
  child.once("close", onExit);
  child.once("error", onExitError);
  const output = new Promise<CapturedChildOutput>((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let outputSinkError: unknown;
    let settled = false;
    const settle = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      removeListeners();
      callback();
    };
    const append = (stream: "stdout" | "stderr", chunk: Buffer | string): void => {
      if (stream === "stdout") stdout += String(chunk);
      else stderr += String(chunk);
      if (outputSink === undefined || outputSinkError !== undefined) return;
      try {
        outputSink(stream, chunk);
      } catch (error) {
        outputSinkError = error;
      }
    };
    const onStdout = (chunk: Buffer | string): void => append("stdout", chunk);
    const onStderr = (chunk: Buffer | string): void => append("stderr", chunk);
    const onError = (error: Error): void => settle(() => reject(error));
    const onClose = (code: number | null): void => settle(() => resolve({
      stdout,
      stderr,
      code,
      ...(outputSinkError === undefined ? {} : { outputSinkError }),
    }));
    const removeListeners = (): void => {
      child.stdout?.off?.("data", onStdout);
      child.stderr?.off?.("data", onStderr);
      child.stdout?.off?.("error", onError);
      child.stderr?.off?.("error", onError);
      child.stdin?.off?.("error", onError);
      child.off("error", onError);
      child.off("close", onClose);
    };

    try {
      child.stdout?.on("data", onStdout);
      child.stderr?.on("data", onStderr);
      child.stdout?.once("error", onError);
      child.stderr?.once("error", onError);
      child.stdin?.once?.("error", onError);
      child.once("error", onError);
      child.once("close", onClose);
    } catch (error) {
      settle(() => reject(error));
    }
  });
  const exited = Promise.race([
    exitSignal,
    output.then(() => undefined),
  ]);
  return { output, exited };
}

export function createWorkerProcessLifecycle(options: WorkerProcessLifecycleOptions = {}) {
  const environment = process.env;
  const groupExited = options.groupExited ?? ((pid: number) => new Promise<void>((resolve, reject) => {
    const probe = options.probeGroup ?? ((groupPid: number) => process.kill(-groupPid, 0));
    const check = (): void => {
      try {
        probe(pid);
      } catch (error) {
        if (isGroupAbsent(error)) {
          resolve();
          return;
        }
        reject(error);
        return;
      }
      const timer = setTimeout(check, 10);
      timer.unref();
    };
    check();
  }));

  return {
    async run(runOptions: WorkerProcessRunOptions): Promise<WorkerProcessLifecycleOutcome> {
      const disposition = dispositionFor(runOptions.role, environment);
      let child: ChildProcess | undefined;
      let observed: ObservedChild | undefined;
      const admit = (admitted: ChildProcess): void => {
        if (child !== undefined) throw new Error("Worker process was admitted more than once");
        child = admitted;
        observed = observeChild(admitted, runOptions.outputSink);
      };
      const launch = (): void => {
        runOptions.launch(admit, disposition);
        if (child === undefined || observed === undefined) {
          throw new Error("Worker process was not admitted");
        }
        if (child.pid === undefined) throw new Error("Worker process did not expose a process ID");
        child.stdin?.end(runOptions.startup);
      };

      if (disposition.inherited) {
        launch();
        const completed = await observed!.output;
        return { status: "completed", ...completed };
      }

      const result = await runJobWithTimeout({
        start: () => {
          launch();
          return {
            pid: child!.pid!,
            exited: observed!.exited,
            groupExited: groupExited(child!.pid!),
          };
        },
        timeoutMilliseconds: runOptions.timeoutMilliseconds,
        graceMilliseconds: runOptions.graceMilliseconds,
        kill: options.kill ?? process.kill,
        wait: options.wait ?? wait,
      });
      if (result.status === "timed-out") return { status: "timed-out" };
      return { status: "completed", ...(await observed!.output) };
    },
  };
}
