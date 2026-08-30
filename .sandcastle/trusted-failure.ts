const trustedFailureSummaries = new WeakMap<object, string>();

const trustedAgentWorkerNames = new Set([
  "Target job",
  "Target operation implement-issue",
  "Target operation implement-prd",
  "Target operation implement-feedback",
  "Target operation review",
  "Target operation update-branch",
  "Target operation split-prd",
  "Target operation architecture-review",
]);

export type TrustedAgentWorkerName =
  | "Target job"
  | `Target operation ${
    | "implement-issue"
    | "implement-prd"
    | "implement-feedback"
    | "review"
    | "update-branch"
    | "split-prd"
    | "architecture-review"}`;

export function trustFailureDiagnostic<T extends object>(
  failure: T,
  summary: string,
): T {
  trustedFailureSummaries.set(failure, summary);
  return failure;
}

export function trustAgentWorkerExit<T extends object>(
  failure: T,
  workerName: TrustedAgentWorkerName,
  code: number | null,
): T {
  if (!trustedAgentWorkerNames.has(workerName)) {
    throw new Error("Trusted Agent worker classification is invalid");
  }
  return trustFailureDiagnostic(
    failure,
    `${workerName} worker exited with ${code ?? "signal"}`,
  );
}

export function trustedFailureSummary(failure: unknown): string | undefined {
  if (
    (typeof failure !== "object" || failure === null) &&
    typeof failure !== "function"
  ) {
    return undefined;
  }
  return trustedFailureSummaries.get(failure);
}
