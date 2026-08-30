import { types } from "node:util";

import type { TargetOperationIdentity } from "./target-operation.ts";

type TargetOperationOutcome = Readonly<Record<string, unknown>> & { readonly status: string };

export interface TargetOperationOutcomeClassification {
  readonly kind: "completed" | "blocked";
  readonly outcome: TargetOperationOutcome;
}

const acceptedStatuses: Readonly<Record<TargetOperationIdentity, ReadonlySet<string>>> = {
  "implement-issue": new Set(["implemented", "refused", "blocked"]),
  "implement-prd": new Set(["implemented", "refused", "blocked"]),
  "implement-feedback": new Set(["implemented", "refused", "blocked"]),
  review: new Set(["reviewed", "refused", "blocked"]),
  "update-branch": new Set(["updated", "up-to-date", "refused", "blocked"]),
  "split-prd": new Set(["split", "refused", "blocked"]),
  "architecture-review": new Set(["proposed", "skipped", "refused", "blocked"]),
};

export class InvalidTargetOperationOutcomeError extends Error {
  constructor() {
    super("Target operation returned an invalid outcome");
    this.name = "InvalidTargetOperationOutcomeError";
  }
}

function invalidTargetOperationOutcome(): never {
  throw new InvalidTargetOperationOutcomeError();
}

function statusFor(
  operation: TargetOperationIdentity,
  value: unknown,
): string {
  try {
    if (
      typeof value !== "object" || value === null || Array.isArray(value) ||
      types.isProxy(value)
    ) {
      return invalidTargetOperationOutcome();
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, "status");
    if (
      descriptor === undefined || !("value" in descriptor) ||
      typeof descriptor.value !== "string" || !acceptedStatuses[operation].has(descriptor.value)
    ) {
      return invalidTargetOperationOutcome();
    }
    return descriptor.value;
  } catch {
    return invalidTargetOperationOutcome();
  }
}

export function classifyTargetOperationOutcome(
  operation: TargetOperationIdentity,
  value: unknown,
): TargetOperationOutcomeClassification {
  const status = statusFor(operation, value);
  const outcome = value as TargetOperationOutcome;
  if (status === "blocked") {
    return { kind: "blocked", outcome };
  }
  return { kind: "completed", outcome };
}
