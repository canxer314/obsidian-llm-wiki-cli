import type { ChildProcess } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

import {
  runJobWithTimeout,
  terminateJobProcessGroup,
  type CancellableWait,
  type Wait,
} from "./job-timeout.ts";
import { INHERITED_JOB_PROCESS_GROUP } from "./worker-process.ts";

export type WorkerProcessRole = "owner" | "nested";

export interface WorkerProcessLaunchDisposition {
  readonly role: WorkerProcessRole;
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
  | {
    readonly status: "timed-out";
    readonly outputSinkError?: unknown;
  };

interface CapturedChildOutput {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number | null;
  readonly outputSinkError?: unknown;
}

interface ObservedChild {
  readonly output: Promise<CapturedChildOutput>;
  readonly exited: Promise<void>;
  dispose(error?: unknown): void;
}

interface GroupExitObservation extends CancellableWait {}

interface WorkerProcessLifecycleOptions {
  readonly kill?: (pid: number, signal: NodeJS.Signals) => void;
  readonly wait?: Wait;
  readonly probeGroup?: (pid: number) => void;
  readonly groupExited?: (pid: number) => Promise<void> | GroupExitObservation;
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

function wait(milliseconds: number): CancellableWait {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return {
    completed: new Promise((resolve) => {
      timer = setTimeout(resolve, milliseconds);
      timer.unref();
    }),
    cancel: () => {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
    },
  };
}

function isGroupAbsent(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ESRCH";
}

function dispositionFor(
  role: WorkerProcessRole,
  environment: Readonly<Record<string, string | undefined>>,
): WorkerProcessLaunchDisposition {
  const inherited = role === "nested" && environment[INHERITED_JOB_PROCESS_GROUP] === "1";
  return { role, detached: !inherited, inherited };
}

function observeChild(
  child: ChildProcess,
  outputSink: WorkerProcessRunOptions["outputSink"],
): ObservedChild {
  let stdout = "";
  let stderr = "";
  const decoders = {
    stdout: new StringDecoder("utf8"),
    stderr: new StringDecoder("utf8"),
  };
  let outputSinkFailed = false;
  let outputSinkError: unknown;
  let exitSettled = false;
  let outputSettled = false;
  let resolveExit!: () => void;
  let rejectExit!: (error: unknown) => void;
  let resolveOutput!: (output: CapturedChildOutput) => void;
  let rejectOutput!: (error: unknown) => void;

  const exited = new Promise<void>((resolve, reject) => {
    resolveExit = resolve;
    rejectExit = reject;
  });
  const output = new Promise<CapturedChildOutput>((resolve, reject) => {
    resolveOutput = resolve;
    rejectOutput = reject;
  });
  const removeExitListeners = (): void => {
    child.off("exit", onExit);
    child.off("close", onExit);
    child.off("error", onExitError);
  };
  const removeOutputListeners = (): void => {
    child.stdout?.off?.("data", onStdout);
    child.stderr?.off?.("data", onStderr);
    child.stdout?.off?.("error", onOutputError);
    child.stderr?.off?.("error", onOutputError);
    child.stdin?.off?.("error", onOutputError);
    child.off("error", onOutputError);
    child.off("close", onClose);
  };
  const settleExit = (error?: unknown): void => {
    if (exitSettled) return;
    exitSettled = true;
    removeExitListeners();
    if (error === undefined) resolveExit();
    else rejectExit(error);
  };
  const settleOutput = (code?: number | null, error?: unknown): void => {
    if (outputSettled) return;
    outputSettled = true;
    removeOutputListeners();
    if (error !== undefined) rejectOutput(error);
    else {
      stdout += decoders.stdout.end();
      stderr += decoders.stderr.end();
      resolveOutput({
        stdout,
        stderr,
        code: code ?? null,
        ...(outputSinkFailed ? { outputSinkError } : {}),
      });
    }
  };
  function onExit(): void {
    settleExit();
  }
  function onExitError(error: Error): void {
    settleExit(error);
    settleOutput(undefined, error);
  }
  const append = (stream: "stdout" | "stderr", chunk: Buffer | string): void => {
    const decoder = decoders[stream];
    const decoded = typeof chunk === "string" ? decoder.end() + chunk : decoder.write(chunk);
    if (stream === "stdout") stdout += decoded;
    else stderr += decoded;
    if (outputSink === undefined || outputSinkFailed) return;
    try {
      outputSink(stream, chunk);
    } catch (error) {
      outputSinkFailed = true;
      outputSinkError = error;
    }
  };
  function onStdout(chunk: Buffer | string): void {
    append("stdout", chunk);
  }
  function onStderr(chunk: Buffer | string): void {
    append("stderr", chunk);
  }
  function onOutputError(error: Error): void {
    settleExit(error);
    settleOutput(undefined, error);
  }
  function onClose(code: number | null): void {
    settleOutput(code);
  }
  const dispose = (error?: unknown): void => {
    settleExit(error ?? new Error("Worker process observation was cancelled"));
    settleOutput(undefined, error ?? new Error("Worker process observation was cancelled"));
  };

  try {
    child.once("exit", onExit);
    child.once("close", onExit);
    child.once("error", onExitError);
    child.stdout?.on("data", onStdout);
    child.stderr?.on("data", onStderr);
    child.stdout?.once("error", onOutputError);
    child.stderr?.once("error", onOutputError);
    child.stdin?.once?.("error", onOutputError);
    child.once("error", onOutputError);
    child.once("close", onClose);
  } catch (error) {
    dispose(error);
  }

  void output.catch(() => undefined);
  void exited.catch(() => undefined);
  return { output, exited, dispose };
}

function groupExitObservation(
  pid: number,
  options: WorkerProcessLifecycleOptions,
): GroupExitObservation {
  const observed = (): GroupExitObservation => {
    if (options.groupExited !== undefined) {
      const observation = options.groupExited(pid);
      if ("completed" in observation) return observation;
      return { completed: observation, cancel: () => {} };
    }

    const probe = options.probeGroup ?? ((groupPid: number) => process.kill(-groupPid, 0));
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cancelled = false;
    const completed = new Promise<void>((resolve, reject) => {
      const check = (): void => {
        if (cancelled) return;
        try {
          probe(pid);
        } catch (error) {
          if (isGroupAbsent(error)) resolve();
          else reject(error);
          return;
        }
        timer = setTimeout(check, 10);
        timer.unref();
      };
      check();
    });
    return {
      completed,
      cancel: () => {
        cancelled = true;
        if (timer !== undefined) clearTimeout(timer);
        timer = undefined;
      },
    };
  };
  const observation = observed();
  void observation.completed.catch(() => undefined);
  return observation;
}

export function createWorkerProcessLifecycle(options: WorkerProcessLifecycleOptions = {}) {
  const environment = process.env;

  return {
    async run(runOptions: WorkerProcessRunOptions): Promise<WorkerProcessLifecycleOutcome> {
      const disposition = dispositionFor(runOptions.role, environment);
      let child: ChildProcess | undefined;
      let observed: ObservedChild | undefined;
      let groupObservation: GroupExitObservation | undefined;
      let cleanupDelegated = false;
      const admit = (admitted: ChildProcess): void => {
        if (child !== undefined) throw new Error("Worker process was admitted more than once");
        child = admitted;
        observed = observeChild(admitted, runOptions.outputSink);
      };
      const launch = async (): Promise<void> => {
        try {
          runOptions.launch(admit, disposition);
          if (child === undefined || observed === undefined) {
            throw new Error("Worker process was not admitted");
          }
          if (child.pid === undefined) {
            await Promise.race([
              observed.exited,
              observed.output.then(() => undefined),
              new Promise<void>((resolve) => setImmediate(resolve)),
            ]);
            if (child.pid === undefined) throw new Error("Worker process did not expose a process ID");
          }
          child.stdin?.end(runOptions.startup);
        } catch (error) {
          throw error;
        }
      };
      const cleanupOwnedGroup = async (failure: unknown): Promise<void> => {
        if (disposition.inherited || child?.pid === undefined) return;
        groupObservation?.cancel();
        groupObservation = groupExitObservation(child.pid, options);
        try {
          await terminateJobProcessGroup({
            pid: child.pid,
            groupExited: groupObservation.completed,
            graceMilliseconds: runOptions.graceMilliseconds,
            kill: options.kill ?? process.kill,
            wait: options.wait ?? wait,
          });
        } catch (cleanupError) {
          const failureMessage = failure instanceof Error ? failure.message : String(failure);
          throw new AggregateError(
            [failure, cleanupError],
            `Worker process failed (${failureMessage}) and process-group cleanup could not be confirmed`,
            { cause: failure },
          );
        }
      };

      try {
        if (disposition.inherited) {
          await launch();
          const completed = await observed!.output;
          return { status: "completed", ...completed };
        }

        await launch();
        cleanupDelegated = true;
        const result = await runJobWithTimeout({
          start: () => {
            groupObservation = groupExitObservation(child!.pid!, options);
            return {
              pid: child!.pid!,
              exited: observed!.exited,
              groupExited: groupObservation.completed,
              renewGroupExited: () => {
                groupObservation?.cancel();
                groupObservation = groupExitObservation(child!.pid!, options);
                return groupObservation.completed;
              },
            };
          },
          timeoutMilliseconds: runOptions.timeoutMilliseconds,
          graceMilliseconds: runOptions.graceMilliseconds,
          kill: options.kill ?? process.kill,
          wait: options.wait ?? wait,
        });
        if (result.status === "timed-out") {
          const completed = await observed!.output;
          return {
            status: "timed-out",
            ...(Object.hasOwn(completed, "outputSinkError")
              ? { outputSinkError: completed.outputSinkError }
              : {}),
          };
        }
        return { status: "completed", ...(await observed!.output) };
      } catch (error) {
        if (!cleanupDelegated) await cleanupOwnedGroup(error);
        throw error;
      } finally {
        groupObservation?.cancel();
        if (observed !== undefined) {
          observed.dispose();
          void observed.output.catch(() => undefined);
          void observed.exited.catch(() => undefined);
        }
      }
    },
  };
}
