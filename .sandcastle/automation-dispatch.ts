import {
  validateAutomationCommand,
} from "./automation-command-route.ts";
import {
  commandEligibility,
  compareCommands,
  type AutomationCommand,
} from "./automation-command.ts";
import type { QueuePromotionResult } from "./queue-promotion-automation.ts";

export interface AutomationDispatchPorts {
  readonly scheduler: {
    acquire(): Promise<{ release(): Promise<void> } | undefined>;
    prepare(): Promise<void>;
    track(identity: string, action: () => Promise<void>): Promise<void>;
  };
  readonly github: {
    verifyLabels(): Promise<void>;
    listCommands(): Promise<readonly AutomationCommand[]>;
  };
  readonly promotion: {
    scan(): Promise<QueuePromotionResult>;
  };
  readonly readiness: {
    // Read-only GitHub authentication probe inside the exact Agent image and
    // GitHub-capable environment; must fail closed before any acquisition,
    // promotion, label, or diagnostic mutation.
    verifyGithubAgentAuthentication(): Promise<void>;
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
    await ports.readiness.verifyGithubAgentAuthentication();
    await ports.scheduler.prepare();
    await ports.github.verifyLabels();
    const limit = request.concurrency ?? 2;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 8) {
      throw new Error("Dispatch concurrency must be between 1 and 8");
    }
    const commands = await ports.github.listCommands();
    const identities = new Set<string>();
    const frontier = commands
      .map((command) => {
        if (command.operation !== "unknown") validateAutomationCommand(command);
        return command;
      })
      .filter((command) => commandEligibility(command) === "eligible")
      .sort(compareCommands)
      .filter((command) => !identities.has(command.identity) && (identities.add(command.identity), true));
    let next = 0;
    const workers = Array.from({ length: Math.min(limit, frontier.length) }, async () => {
      for (;;) {
        const command = frontier[next];
        if (command === undefined) return;
        next += 1;
        await ports.scheduler.track(command.identity, () => ports.run(command));
      }
    });
    const outcomes = await Promise.allSettled(workers);
    const promotionFailure = await ports.promotion.scan().then(
      () => undefined,
      (reason: unknown) => ({ reason }),
    );
    const failure = outcomes.find((outcome): outcome is PromiseRejectedResult => outcome.status === "rejected");
    if (failure !== undefined) throw failure.reason;
    if (promotionFailure !== undefined) throw promotionFailure.reason;
    return { status: "dispatched", selected: frontier };
  } finally {
    await lock.release();
  }
}
