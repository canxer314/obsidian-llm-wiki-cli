export interface CancellableWait {
  readonly completed: Promise<void>;
  cancel(): void;
}

export type Wait = (milliseconds: number) => Promise<void> | CancellableWait;

function cancellable(wait: Promise<void> | CancellableWait): CancellableWait {
  if ("completed" in wait) return wait;
  return { completed: wait, cancel: () => {} };
}

function deadline(milliseconds: number): CancellableWait {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return {
    completed: new Promise((resolve) => {
      timer = setTimeout(resolve, milliseconds);
    }),
    cancel: () => {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
    },
  };
}

function signalGroup(
  kill: (pid: number, signal: NodeJS.Signals) => void,
  pid: number,
  signal: NodeJS.Signals,
): { readonly status: "sent-or-absent" } | { readonly status: "failed"; readonly error: unknown } {
  try {
    kill(-pid, signal);
    return { status: "sent-or-absent" };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") {
      return { status: "sent-or-absent" };
    }
    return { status: "failed", error };
  }
}

async function raceGroupWithGrace(
  groupExited: Promise<void>,
  graceMilliseconds: number,
  wait: Wait,
): Promise<
  | { readonly status: "exited" }
  | { readonly status: "elapsed" }
  | { readonly status: "observation-failed"; readonly error: unknown }
> {
  const grace = cancellable(wait(graceMilliseconds));
  try {
    const result = await Promise.race([
      groupExited.then(
        () => ({ status: "exited" as const }),
        (error: unknown) => ({ status: "observation-failed" as const, error }),
      ),
      grace.completed.then(() => ({ status: "elapsed" as const })),
    ]);
    if (result.status === "observation-failed") await grace.completed;
    return result;
  } finally {
    grace.cancel();
  }
}

export async function terminateJobProcessGroup(options: {
  readonly pid: number;
  readonly groupExited: Promise<void>;
  readonly renewGroupExited?: (() => Promise<void>) | undefined;
  readonly graceMilliseconds: number;
  readonly kill: (pid: number, signal: NodeJS.Signals) => void;
  readonly wait: Wait;
}): Promise<void> {
  const throwFailures = (failures: readonly unknown[], message: string): never => {
    const distinct = failures.filter((failure, index) => failures.indexOf(failure) === index);
    if (distinct.length === 1) throw distinct[0];
    throw new AggregateError(distinct, message, { cause: distinct[0] });
  };
  const confirmAfterObservationFailure = async (
    error: unknown,
    signalFailures: readonly unknown[],
  ): Promise<never> => {
    if (options.renewGroupExited === undefined) {
      return throwFailures(
        [error, ...signalFailures],
        "Process-group observation and signaling failed before final exit confirmation",
      );
    }
    try {
      await options.renewGroupExited();
    } catch (confirmationError) {
      return throwFailures(
        [error, ...signalFailures, confirmationError],
        "Process-group cleanup could not be confirmed",
      );
    }
    return throwFailures(
      [error, ...signalFailures],
      "Process-group observation and signaling failed during cleanup",
    );
  };

  const signalFailures: unknown[] = [];
  const terminated = signalGroup(options.kill, options.pid, "SIGTERM");
  if (terminated.status === "failed") signalFailures.push(terminated.error);
  const graceful = await raceGroupWithGrace(
    options.groupExited,
    options.graceMilliseconds,
    options.wait,
  );
  if (graceful.status !== "exited") {
    const killed = signalGroup(options.kill, options.pid, "SIGKILL");
    if (killed.status === "failed") signalFailures.push(killed.error);
  }
  if (graceful.status === "observation-failed") {
    return await confirmAfterObservationFailure(graceful.error, signalFailures);
  }
  try {
    await options.groupExited;
  } catch (error) {
    return await confirmAfterObservationFailure(error, signalFailures);
  }
  if (signalFailures.length > 0) {
    return throwFailures(signalFailures, "Process-group signaling failed during cleanup");
  }
}

export async function runJobWithTimeout(options: {
  readonly start: () => {
    readonly pid: number;
    readonly exited: Promise<void>;
    readonly groupExited: Promise<void>;
    readonly renewGroupExited?: (() => Promise<void>) | undefined;
  };
  readonly timeoutMilliseconds: number;
  readonly graceMilliseconds: number;
  readonly kill: (pid: number, signal: NodeJS.Signals) => void;
  readonly wait: Wait;
}): Promise<{ readonly status: "completed" | "timed-out" }> {
  const raceWithGroupFailure = <T>(promise: Promise<T>, groupExited: Promise<void>): Promise<T> => {
    const groupFailure = new Promise<never>((_resolve, reject) => {
      void groupExited.catch(reject);
    });
    return Promise.race([promise, groupFailure]);
  };
  const terminateGroup = (
    child: {
      readonly pid: number;
      readonly groupExited: Promise<void>;
    },
    renewGroupExited?: (() => Promise<void>) | undefined,
  ): Promise<void> => terminateJobProcessGroup({
    pid: child.pid,
    groupExited: child.groupExited,
    renewGroupExited,
    graceMilliseconds: options.graceMilliseconds,
    kill: options.kill,
    wait: options.wait,
  });

  const child = options.start();
  const cleanupAfterFailure = async (
    error: unknown,
    groupExited: Promise<void>,
    renewGroupExited?: (() => Promise<void>) | undefined,
  ): Promise<never> => {
    try {
      await terminateGroup({ pid: child.pid, groupExited }, renewGroupExited);
    } catch (cleanupError) {
      const failureMessage = error instanceof Error ? error.message : String(error);
      throw new AggregateError(
        [error, cleanupError],
        `Worker process failed (${failureMessage}) and process-group cleanup could not be confirmed`,
        { cause: error },
      );
    }
    throw error;
  };
  const cleanupAfterGroupFailure = (error: unknown): Promise<never> => {
    const groupExited = child.renewGroupExited?.();
    if (groupExited === undefined) throw error;
    return cleanupAfterFailure(error, groupExited);
  };
  const timeoutDeadline = deadline(options.timeoutMilliseconds);
  try {
    let outcome;
    try {
      outcome = await raceWithGroupFailure(Promise.race([
        child.exited.then(
          () => ({ status: "completed" as const }),
          (error: unknown) => ({ status: "failed" as const, error }),
        ),
        timeoutDeadline.completed.then(() => ({ status: "timed-out" as const })),
      ]), child.groupExited);
    } catch (error) {
      return await cleanupAfterGroupFailure(error);
    }
    if (outcome.status === "failed") {
      return await cleanupAfterFailure(
        outcome.error,
        child.groupExited,
        child.renewGroupExited,
      );
    }
    if (outcome.status === "completed") {
      try {
        const groupExit = await raceGroupWithGrace(
          child.groupExited,
          options.graceMilliseconds,
          options.wait,
        );
        if (groupExit.status === "observation-failed") throw groupExit.error;
        if (groupExit.status === "elapsed") await terminateGroup(child);
        return { status: "completed" };
      } catch (error) {
        return await cleanupAfterGroupFailure(error);
      }
    }

    try {
      await terminateGroup(child);
      return { status: "timed-out" };
    } catch (error) {
      return await cleanupAfterGroupFailure(error);
    }
  } finally {
    timeoutDeadline.cancel();
  }
}
