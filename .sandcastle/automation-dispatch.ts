import {
  validateAutomationCommand,
} from "./automation-command-route.ts";
import {
  commandEligibility,
  compareCommands,
  type AutomationCommand,
} from "./automation-command.ts";
import type { QueuePromotionResult } from "./queue-promotion-automation.ts";

// ADR-0005: a Dispatch Session re-discovers whenever a worker finishes and on
// a fixed one-minute idle poll that runs only while at least one worker slot
// is free. The interval is not configurable.
export const DISPATCH_SESSION_IDLE_POLL_MILLISECONDS = 60_000;

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
  // ADR-0004: always-on proof-gated recovery of Interrupted Automation. Runs
  // once per session on the immutable session-start discovery snapshot before
  // frontier construction and returns the repaired Work Item identities so
  // they stay out of that snapshot's frontier.
  readonly recovery: {
    recoverInterrupted(commands: readonly AutomationCommand[]): Promise<readonly string[]>;
  };
  readonly readiness: {
    // Read-only GitHub authentication probe inside the exact Agent image and
    // GitHub-capable environment; must fail closed before any acquisition,
    // promotion, label, or diagnostic mutation.
    verifyGithubAgentAuthentication(): Promise<void>;
  };
  readonly run: (command: AutomationCommand) => Promise<void>;
  // Idle-poll wait, injected so tests advance the session deterministically
  // without real timers. The default is an unref'd timer so a drained session
  // never delays process exit.
  readonly wait?: (milliseconds: number) => Promise<void>;
}

const defaultWait = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    timer.unref?.();
  });

// The outcome of one Dispatch Session. "locked" means the scheduling lock was
// unavailable and nothing ran. "dispatched" means the session drained with no
// recorded failure. "failed" means the session still drained (a clean empty
// discovery with no worker running) but recorded at least one job or refill
// failure along the way; it carries the same cumulative selected list plus a
// summary of every recorded failure so the evidence survives in the CLI
// output, which exits non-zero for it.
export type AutomationDispatchResult =
  | { readonly status: "locked" }
  | { readonly status: "dispatched"; readonly selected: readonly AutomationCommand[] }
  | {
      readonly status: "failed";
      readonly selected: readonly AutomationCommand[];
      readonly failures: readonly string[];
    };

// One Dispatch Session (ADR-0005): acquire the scheduling lock once, run the
// readiness probe, prepare, label verification, and Interrupted Automation
// recovery once at session start, then keep the bounded workers refilled until
// a clean discovery finds no eligible Automation Command and no worker is
// running. A single job or refill failure is recorded but never ends the
// session; a session that recorded any failure drains into a "failed" result
// carrying the cumulative dispatched-command list and every recorded failure
// instead of throwing, so the reporting layer keeps both the failure evidence
// and everything the session dispatched successfully.
export async function dispatchAutomationCommands(
  request: { readonly concurrency?: number },
  ports: AutomationDispatchPorts,
): Promise<AutomationDispatchResult> {
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
    const wait = ports.wait ?? defaultWait;

    // Cumulative ordered list of everything the session dispatched.
    const dispatched: AutomationCommand[] = [];
    const failures: unknown[] = [];
    // Identities with a worker in flight; excluded from every refill so one
    // Work Item never runs two operations concurrently.
    const running = new Set<string>();
    let wake: () => void = () => {};
    let settled = new Promise<void>((resolve) => {
      wake = resolve;
    });

    const start = (command: AutomationCommand): void => {
      dispatched.push(command);
      running.add(command.identity);
      void (async () => {
        try {
          await ports.scheduler.track(command.identity, () => ports.run(command));
        } catch (reason: unknown) {
          failures.push(reason);
        } finally {
          running.delete(command.identity);
          // A worker completion triggers a fresh refill immediately.
          wake();
        }
      })();
    };

    // Validate, filter to eligible commands, drop the given identities (the
    // session-start snapshot drops the identities recovery just repaired),
    // reapply the accepted priority-then-number order, deduplicate by
    // identity, and exclude identities with a worker in flight.
    const select = (
      commands: readonly AutomationCommand[],
      excluded: ReadonlySet<string>,
    ): AutomationCommand[] => {
      const identities = new Set<string>();
      return commands
        .map((command) => {
          if (command.operation !== "unknown") validateAutomationCommand(command);
          return command;
        })
        .filter((command) => commandEligibility(command) === "eligible")
        .filter((command) => !excluded.has(command.identity))
        .sort(compareCommands)
        .filter((command) => !identities.has(command.identity) && (identities.add(command.identity), true))
        .filter((command) => !running.has(command.identity));
    };

    const fill = (frontier: readonly AutomationCommand[]): void => {
      for (const command of frontier) {
        if (running.size >= limit) return;
        start(command);
      }
    };

    // Session start: one discovery snapshot feeds both proof-gated recovery
    // and the initial fill. A repaired Work Item stays out of this frontier;
    // it re-enters only through ordinary discovery on a later refill.
    const snapshot = await ports.github.listCommands();
    const repaired = new Set(await ports.recovery.recoverInterrupted(snapshot));
    fill(select(snapshot, repaired));

    // The drain condition is evaluated on refill discoveries only: an empty
    // initial fill still owes the session one promotion pass, so the first
    // refill runs immediately when no worker started.
    let cleanEmpty = false;
    let firstRefill = true;
    for (;;) {
      if (!firstRefill && cleanEmpty && running.size === 0) break;
      if (!firstRefill || running.size > 0) {
        if (running.size === 0) {
          // No worker can complete (the last discovery failed); the idle poll
          // is the only refill trigger left.
          await wait(DISPATCH_SESSION_IDLE_POLL_MILLISECONDS);
        } else if (running.size < limit) {
          await Promise.race([settled, wait(DISPATCH_SESSION_IDLE_POLL_MILLISECONDS)]);
        } else {
          await settled;
        }
        settled = new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
      firstRefill = false;
      // Promotion runs before every refill discovery so a promoted command is
      // visible to the same refill. A promotion failure is recorded and the
      // refill still discovers, so a clean empty discovery can drain.
      try {
        await ports.promotion.scan();
      } catch (reason: unknown) {
        failures.push(reason);
      }
      try {
        const frontier = select(await ports.github.listCommands(), new Set());
        cleanEmpty = frontier.length === 0;
        fill(frontier);
      } catch (reason: unknown) {
        failures.push(reason);
        cleanEmpty = false;
      }
    }
    // Draining never throws a recorded failure away: the cumulative command
    // list and every recorded failure summary ride the result so the caller
    // can print the evidence and still exit non-zero.
    if (failures.length > 0) {
      return {
        status: "failed",
        selected: dispatched,
        failures: failures.map((reason) => reason instanceof Error ? reason.message : String(reason)),
      };
    }
    return { status: "dispatched", selected: dispatched };
  } finally {
    await lock.release();
  }
}
