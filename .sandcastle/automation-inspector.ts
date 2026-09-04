import {
  commandEligibility,
  commandTriggerLabel,
  type AutomationCommand,
  type AutomationCommandEligibility,
} from "./automation-command.ts";

export async function inspectAutomationCommands(ports: {
  readonly github: { listCommands(): Promise<readonly AutomationCommand[]> };
  readonly scheduler: { activeJobs(): Promise<readonly { readonly identity: string; readonly jobId: string }[]> };
}): Promise<{
  readonly commands: readonly {
    readonly number: number;
    readonly operation: AutomationCommand["operation"];
    readonly identity: string;
    readonly eligibility: AutomationCommandEligibility;
    readonly retry?: string;
  }[];
  readonly activeJobs: readonly { readonly identity: string; readonly jobId: string }[];
}> {
  const [commands, activeJobs] = await Promise.all([ports.github.listCommands(), ports.scheduler.activeJobs()]);
  return {
    commands: commands.map((command) => {
      const eligibility = commandEligibility(command);
      return {
        number: command.number,
        operation: command.operation,
        identity: command.identity,
        eligibility,
        ...(eligibility === "blocked"
          ? command.operation === "unknown"
            ? { retry: "inspect the Automation Work Item and restore the appropriate trigger manually before retrying" }
            : { retry: `remove agent:blocked, restore ${commandTriggerLabel(command)}, then retry` }
          : eligibility === "stale-in-progress" || eligibility === "inconsistent"
            // ADR-0004: the Dispatcher recovers provably dead Interrupted
            // Automation on a later dispatch round (agent:in-progress cleared,
            // trigger restored when absent); missing, ambiguous, conflicting,
            // live, or too-recent evidence fails closed and stays an
            // operator-inspection path.
            ? { retry: "the Dispatcher automatically recovers this Interrupted Automation on a later dispatch round when the owning job is provably dead; if recovery evidence fails closed, inspect the Automation Work Item and resolve labels manually" }
            : {}),
      };
    }),
    activeJobs,
  };
}
