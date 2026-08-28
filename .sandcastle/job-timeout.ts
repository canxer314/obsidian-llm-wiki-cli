export async function runJobWithTimeout(options: {
  readonly start: () => {
    readonly pid: number;
    readonly exited: Promise<void>;
    readonly groupExited: Promise<void>;
  };
  readonly timeoutMilliseconds: number;
  readonly graceMilliseconds: number;
  readonly kill: (pid: number, signal: NodeJS.Signals) => void;
  readonly wait: (milliseconds: number) => Promise<void>;
}): Promise<{ readonly status: "completed" | "timed-out" }> {
  const signalGroup = (pid: number, signal: NodeJS.Signals): void => {
    try {
      options.kill(-pid, signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  };
  const child = options.start();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(true), options.timeoutMilliseconds);
  });
  const completed = child.exited.then(() => false);
  const timeout = await Promise.race([completed, timedOut]);
  if (timer !== undefined) clearTimeout(timer);
  if (!timeout) {
    const groupExited = await Promise.race([
      child.groupExited.then(() => false),
      options.wait(options.graceMilliseconds).then(() => true),
    ]);
    if (groupExited) {
      signalGroup(child.pid, "SIGTERM");
      const forced = await Promise.race([
        child.groupExited.then(() => false),
        options.wait(options.graceMilliseconds).then(() => true),
      ]);
      if (forced) signalGroup(child.pid, "SIGKILL");
      await child.groupExited;
    }
    return { status: "completed" };
  }

  signalGroup(child.pid, "SIGTERM");
  const forced = await Promise.race([
    child.groupExited.then(() => false),
    options.wait(options.graceMilliseconds).then(() => true),
  ]);
  if (forced) signalGroup(child.pid, "SIGKILL");
  await child.groupExited;
  return { status: "timed-out" };
}
