import {
  commandEligibility,
  compareCommands,
  type AutomationCommand,
} from "./automation-command.ts";

export interface AutomationDispatchPorts {
  readonly scheduler: {
    acquire(): Promise<{ release(): Promise<void> } | undefined>;
    prepare(): Promise<void>;
  };
  readonly github: {
    ensureLabels(): Promise<void>;
    listCommands(): Promise<readonly AutomationCommand[]>;
  };
  readonly run: (command: AutomationCommand) => Promise<void>;
}

export async function dispatchAutomationCommands(
  request: { readonly concurrency?: number },
  ports: AutomationDispatchPorts,
): Promise<{ readonly status: "locked" | "dispatched"; readonly selected?: readonly AutomationCommand[] }> {
  const lock = await ports.scheduler.acquire();
  if (lock === undefined) return { status: "locked" };
  try {
    await ports.scheduler.prepare();
    await ports.github.ensureLabels();
    const limit = request.concurrency ?? 2;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 8) {
      throw new Error("Dispatch concurrency must be between 1 and 8");
    }
    const identities = new Set<string>();
    const selected = ports.github.listCommands().then((commands) => commands
      .filter((command) => commandEligibility(command) === "eligible")
      .sort(compareCommands)
      .filter((command) => !identities.has(command.identity) && (identities.add(command.identity), true))
      .slice(0, limit));
    const frontier = await selected;
    await Promise.all(frontier.map((command) => ports.run(command)));
    return { status: "dispatched", selected: frontier };
  } finally {
    await lock.release();
  }
}
