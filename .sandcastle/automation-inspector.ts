import {
  commandEligibility,
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
          ? { retry: `remove agent:blocked, restore agent:${command.operation}, then retry` }
          : eligibility === "stale-in-progress" || eligibility === "inconsistent"
            ? { retry: "inspect the Automation Work Item and resolve labels manually; do not adopt or clear state automatically" }
            : {}),
      };
    }),
    activeJobs,
  };
}
