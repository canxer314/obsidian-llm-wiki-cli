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

// Accepted priority order (#219): 1 branch update, 2 Pull Request feedback
// implementation, 3 Pull Request review, 4 PRD or Issue implementation,
// 5 PRD split, 6 queue promotion, 7 architecture review. The trusted registry
// currently runs only the already-supported review operation.
const operationPriority: Readonly<Record<AutomationOperation, number>> = {
  review: 3,
};

export function commandPriority(command: AutomationCommand): number {
  return operationPriority[command.operation];
}

export function compareCommands(left: AutomationCommand, right: AutomationCommand): number {
  return commandPriority(left) - commandPriority(right) || left.number - right.number;
}
