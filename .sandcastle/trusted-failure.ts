const trustedFailureSummaries = new WeakMap<object, string>();

const trustedTargetOperations = [
  "implement-issue",
  "implement-prd",
  "implement-feedback",
  "review",
  "update-branch",
  "split-prd",
  "architecture-review",
] as const;
const trustedTargetOperationSet = new Set<string>(trustedTargetOperations);
const trustedAgentWorkerNames = new Set<string>([
  "Target job",
  ...trustedTargetOperations.map((operation) => `Target operation ${operation}`),
]);

export type TrustedTargetOperationIdentity = typeof trustedTargetOperations[number];
export type TrustedAgentWorkerName =
  | "Target job"
  | `Target operation ${TrustedTargetOperationIdentity}`;

function trustFailure<T extends object>(failure: T, summary: string): T {
  trustedFailureSummaries.set(failure, summary);
  return failure;
}

function trustedCommandFailure(summary: string): Error {
  const failure = new Error(summary);
  return trustFailure(failure, summary);
}

function requireWorkItemNumber(number: unknown): number {
  if (typeof number !== "number" || !Number.isSafeInteger(number) || number < 1) {
    throw new Error("Trusted Target operation command classification is invalid");
  }
  return number;
}

export function unauthorizedPullRequestFailure(number: unknown): Error {
  const workItemNumber = requireWorkItemNumber(number);
  return trustedCommandFailure(
    `Pull Request #${workItemNumber} is not an authorized same-repository revision`,
  );
}

export function invalidTargetOperationRevisionFailure(): Error {
  return trustedCommandFailure("Target operation requires a full authorized revision");
}

export function unavailableWorkItemFailure(number: unknown): Error {
  const workItemNumber = requireWorkItemNumber(number);
  return trustedCommandFailure(`Work Item #${workItemNumber} is not available for acquisition`);
}

export function workItemChangedWhileStartingFailure(number: unknown): Error {
  const workItemNumber = requireWorkItemNumber(number);
  return trustedCommandFailure(
    `Work Item #${workItemNumber} changed while acquisition was starting`,
  );
}

export function workItemChangedWhileSettlingFailure(number: unknown): Error {
  const workItemNumber = requireWorkItemNumber(number);
  return trustedCommandFailure(
    `Work Item #${workItemNumber} changed while acquisition was settling`,
  );
}

export function trustInvalidTargetOperationOutcome<T extends object>(failure: T): T {
  return trustFailure(failure, "Target operation returned an invalid outcome");
}

export function trustTargetOperationTimeout<T extends object>(
  failure: T,
  operation: unknown,
): T {
  if (typeof operation !== "string" || !trustedTargetOperationSet.has(operation)) {
    throw new Error("Trusted Target operation timeout classification is invalid");
  }
  return trustFailure(failure, `Target operation ${operation} timed out`);
}

export function trustAgentWorkerExit<T extends object>(
  failure: T,
  workerName: unknown,
  code: number | null,
): T {
  if (
    typeof workerName !== "string" || !trustedAgentWorkerNames.has(workerName) ||
    (code !== null && (!Number.isSafeInteger(code) || code < 0))
  ) {
    throw new Error("Trusted Agent worker classification is invalid");
  }
  return trustFailure(
    failure,
    `${workerName} worker exited with ${code ?? "signal"}`,
  );
}

export function trustCheckoutCommandExit<T extends object>(
  failure: T,
  file: unknown,
  code: number | null,
): T {
  if (
    (file !== "git" && file !== "npm") ||
    (code !== null && (!Number.isSafeInteger(code) || code < 0))
  ) {
    throw new Error("Trusted Target Checkout command classification is invalid");
  }
  return trustFailure(failure, `${file} exited with ${code ?? "signal"}`);
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
