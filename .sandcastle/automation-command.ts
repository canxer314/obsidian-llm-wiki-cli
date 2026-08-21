export type AutomationOperation = "review";

export interface AutomationCommand {
  readonly number: number;
  readonly operation: AutomationOperation;
  readonly identity: string;
  readonly labels: readonly string[];
}

export type AutomationCommandEligibility =
  | "eligible"
  | "blocked"
  | "stale-in-progress"
  | "inconsistent"
  | "ineligible";

export function commandEligibility(command: AutomationCommand): AutomationCommandEligibility {
  const trigger = `agent:${command.operation}`;
  const hasTrigger = command.labels.includes(trigger);
  const inProgress = command.labels.includes("agent:in-progress");
  if (command.labels.includes("agent:blocked")) return "blocked";
  if (hasTrigger && inProgress) return "inconsistent";
  if (inProgress) return "stale-in-progress";
  return hasTrigger ? "eligible" : "ineligible";
}

export function commandPriority(_command: AutomationCommand): number {
  return 2;
}

export function compareCommands(left: AutomationCommand, right: AutomationCommand): number {
  return commandPriority(left) - commandPriority(right) || left.number - right.number;
}
