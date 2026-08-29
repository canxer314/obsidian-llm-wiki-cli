import type { TargetOperationIdentity } from "./target-operation.ts";

export type TargetCheckoutDisposition = "cleanup" | "retain";

type TargetOperationOutcome = Readonly<Record<string, unknown>> & { readonly status: string };

export interface TargetOperationOutcomeClassification {
  readonly outcome: TargetOperationOutcome;
  readonly checkout: TargetCheckoutDisposition;
  readonly jobLog: "completed" | "failed";
  readonly automation: "completed" | "blocked";
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

export function classifyTargetOperationOutcome(
  operation: TargetOperationIdentity,
  value: unknown,
): TargetOperationOutcomeClassification {
  if (
    typeof value !== "object" || value === null || Array.isArray(value) ||
    !("status" in value) || typeof value.status !== "string" ||
    !acceptedStatuses[operation].has(value.status)
  ) {
    throw new Error("Target operation returned an invalid outcome");
  }
  const outcome = value as TargetOperationOutcome;
  if (outcome.status === "blocked") {
    return { outcome, checkout: "retain", jobLog: "failed", automation: "blocked" };
  }
  return { outcome, checkout: "cleanup", jobLog: "completed", automation: "completed" };
}
