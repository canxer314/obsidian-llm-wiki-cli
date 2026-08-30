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

export async function runJobWithTimeout(options: {
  readonly start: () => {
    readonly pid: number;
    readonly exited: Promise<void>;
    readonly groupExited: Promise<void>;
  };
  readonly timeoutMilliseconds: number;
  readonly graceMilliseconds: number;
  readonly kill: (pid: number, signal: NodeJS.Signals) => void;
  readonly wait: Wait;
}): Promise<{ readonly status: "completed" | "timed-out" }> {
  const signalGroup = (pid: number, signal: NodeJS.Signals): void => {
    try {
      options.kill(-pid, signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  };
  const raceWithGroupFailure = <T>(promise: Promise<T>, groupExited: Promise<void>): Promise<T> => {
    const groupFailure = new Promise<never>((_resolve, reject) => {
      void groupExited.catch(reject);
    });
    return Promise.race([promise, groupFailure]);
  };
  const raceGroupWithGrace = async (groupExited: Promise<void>): Promise<boolean> => {
    const grace = cancellable(options.wait(options.graceMilliseconds));
    try {
      return await Promise.race([
        groupExited.then(() => false),
        grace.completed.then(() => true),
      ]);
    } finally {
      grace.cancel();
    }
  };

  const terminateGroup = async (child: {
    readonly pid: number;
    readonly groupExited: Promise<void>;
  }): Promise<void> => {
    signalGroup(child.pid, "SIGTERM");
    const forced = await raceGroupWithGrace(child.groupExited);
    if (forced) signalGroup(child.pid, "SIGKILL");
    await child.groupExited;
  };

  const child = options.start();
  const timeoutDeadline = deadline(options.timeoutMilliseconds);
  try {
    const outcome = await raceWithGroupFailure(Promise.race([
      child.exited.then(
        () => ({ status: "completed" as const }),
        (error: unknown) => ({ status: "failed" as const, error }),
      ),
      timeoutDeadline.completed.then(() => ({ status: "timed-out" as const })),
    ]), child.groupExited);
    if (outcome.status === "failed") {
      await terminateGroup(child);
      throw outcome.error;
    }
    if (outcome.status === "completed") {
      const groupExited = await raceGroupWithGrace(child.groupExited);
      if (groupExited) await terminateGroup(child);
      return { status: "completed" };
    }

    await terminateGroup(child);
    return { status: "timed-out" };
  } finally {
    timeoutDeadline.cancel();
  }
}
