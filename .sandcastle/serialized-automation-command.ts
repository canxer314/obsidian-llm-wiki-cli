export interface SerializedAutomationScheduler {
  acquire(): Promise<{ release(): Promise<void> } | undefined>;
  prepare(): Promise<void>;
  track(identity: string, action: () => Promise<void>): Promise<void>;
}

export async function runSerializedAutomationCommand<TResult>(
  scheduler: SerializedAutomationScheduler,
  identity: string,
  action: () => Promise<TResult>,
): Promise<TResult> {
  const lock = await scheduler.acquire();
  if (lock === undefined) throw new Error("Dispatcher is already running");
  try {
    await scheduler.prepare();
    let result!: TResult;
    await scheduler.track(identity, async () => {
      result = await action();
    });
    return result;
  } finally {
    await lock.release();
  }
}
