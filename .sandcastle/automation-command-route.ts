import type { AutomationCommand, AutomationOperation } from "./automation-command.ts";
import type { LabelTriggeredTargetOperationIdentity } from "./target-operation.ts";

export type AutomationCommandReceiver = "issue" | "pull-request";

type RoutedAutomationOperation = Exclude<AutomationOperation, "unknown">;

export interface VerifiedAutomationCommandRoute {
  readonly operation: RoutedAutomationOperation;
  readonly targetOperation: LabelTriggeredTargetOperationIdentity;
  readonly trigger: string;
  readonly receiver: AutomationCommandReceiver;
  readonly identity: string;
  readonly number: number;
}

interface RoutePolicy {
  readonly operation: RoutedAutomationOperation;
  readonly targetOperation: LabelTriggeredTargetOperationIdentity;
  readonly trigger: string;
  readonly receiver: AutomationCommandReceiver;
  readonly identityNamespace: "issue" | "prd" | "pull-request";
}

const routePolicies: readonly RoutePolicy[] = [
  {
    operation: "update-branch",
    targetOperation: "update-branch",
    trigger: "agent:update-branch",
    receiver: "pull-request",
    identityNamespace: "pull-request",
  },
  {
    operation: "implement",
    targetOperation: "implement-feedback",
    trigger: "agent:implement",
    receiver: "pull-request",
    identityNamespace: "pull-request",
  },
  {
    operation: "review",
    targetOperation: "review",
    trigger: "agent:review",
    receiver: "pull-request",
    identityNamespace: "pull-request",
  },
  {
    operation: "implement-issue",
    targetOperation: "implement-issue",
    trigger: "agent:implement",
    receiver: "issue",
    identityNamespace: "issue",
  },
  {
    operation: "implement-prd",
    targetOperation: "implement-prd",
    trigger: "agent:implement",
    receiver: "issue",
    identityNamespace: "prd",
  },
  {
    operation: "split-prd",
    targetOperation: "split-prd",
    trigger: "agent:to-issues",
    receiver: "issue",
    identityNamespace: "prd",
  },
];

function requireNumber(value: unknown): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new Error("Automation Command Work Item number is invalid");
  }
}

function materialize(policy: RoutePolicy, number: number): VerifiedAutomationCommandRoute {
  requireNumber(number);
  return Object.freeze({
    operation: policy.operation,
    targetOperation: policy.targetOperation,
    trigger: policy.trigger,
    receiver: policy.receiver,
    identity: `${policy.identityNamespace}:${number}`,
    number,
  });
}

function routeFor<T extends keyof RoutePolicy>(key: T, value: RoutePolicy[T]): RoutePolicy {
  const route = routePolicies.find((candidate) => candidate[key] === value);
  if (route === undefined) throw new Error("Automation Command route is unknown");
  return route;
}

export function resolveAutomationCommandRoute(
  operation: unknown,
  number: unknown,
): VerifiedAutomationCommandRoute {
  if (typeof operation !== "string") throw new Error("Automation Command route is unknown");
  return materialize(routeFor("operation", operation as RoutedAutomationOperation), number as number);
}

export function resolveTargetOperationRoute(
  operation: unknown,
  number: unknown,
): VerifiedAutomationCommandRoute {
  if (typeof operation !== "string") throw new Error("Target operation route is unknown");
  return materialize(
    routeFor("targetOperation", operation as LabelTriggeredTargetOperationIdentity),
    number as number,
  );
}

export function validateAutomationCommand(command: AutomationCommand): VerifiedAutomationCommandRoute {
  const route = resolveAutomationCommandRoute(command.operation, command.number);
  if (command.identity !== route.identity) {
    throw new Error("Automation Command identity is not canonical");
  }
  return route;
}

function requireReceiver(value: unknown): asserts value is AutomationCommandReceiver {
  if (value !== "issue" && value !== "pull-request") {
    throw new Error("Automation Command receiver is unknown");
  }
}

export function commandRoutesForReceiver(
  receiver: AutomationCommandReceiver,
  number: number,
): readonly VerifiedAutomationCommandRoute[] {
  requireReceiver(receiver);
  requireNumber(number);
  return Object.freeze(routePolicies
    .filter((route) => route.receiver === receiver)
    .map((route) => materialize(route, number)));
}

export function canonicalAutomationTriggerLabels(): readonly string[] {
  return Object.freeze([...new Set(routePolicies.map((route) => route.trigger))]);
}
