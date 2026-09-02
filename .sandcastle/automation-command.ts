import { resolveAutomationCommandRoute } from "./automation-command-route.ts";

export type AutomationOperation =
  | "update-branch"
  | "implement"
  | "review"
  | "implement-issue"
  | "implement-spec"
  | "split-spec"
  // A state-only Work Item has consumed its trigger, so its originating
  // operation cannot be reconstructed safely. It is inspection-only.
  | "unknown";

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

export function commandTriggerLabel(command: AutomationCommand): string {
  return command.operation === "unknown"
    ? "an appropriate trigger label"
    : resolveAutomationCommandRoute(command.operation, command.number).trigger;
}

export function commandEligibility(command: AutomationCommand): AutomationCommandEligibility {
  if (command.operation === "unknown") {
    return command.labels.includes("agent:blocked")
      ? "blocked"
      : command.labels.includes("agent:in-progress")
        ? "stale-in-progress"
        : "ineligible";
  }
  const trigger = commandTriggerLabel(command);
  const hasTrigger = command.labels.includes(trigger);
  const inProgress = command.labels.includes("agent:in-progress");
  if (command.labels.includes("agent:blocked")) return "blocked";
  if (hasTrigger && inProgress) return "inconsistent";
  if (inProgress) return "stale-in-progress";
  return hasTrigger ? "eligible" : "ineligible";
}

// Accepted priority order (#219): 1 branch update, 2 Pull Request feedback
// implementation, 3 Pull Request review, 4 Spec or Issue implementation,
// 5 Spec split, 6 queue promotion, 7 architecture review. Queue promotion runs
// after the frozen label-triggered frontier and architecture review on its own
// schedule, so the registry runs the six label-triggered families.
const operationPriority: Readonly<Record<AutomationOperation, number>> = {
  "update-branch": 1,
  implement: 2,
  review: 3,
  "implement-issue": 4,
  "implement-spec": 4,
  "split-spec": 5,
  unknown: Number.MAX_SAFE_INTEGER,
};

export function commandPriority(command: AutomationCommand): number {
  return operationPriority[command.operation];
}

export function compareCommands(left: AutomationCommand, right: AutomationCommand): number {
  return commandPriority(left) - commandPriority(right) || left.number - right.number;
}
