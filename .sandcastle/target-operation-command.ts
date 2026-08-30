import {
  resolveTargetOperationRoute,
} from "./automation-command-route.ts";
import { diagnosticSummary } from "./redaction.ts";
import { classifyTargetOperationOutcome } from "./target-operation-outcome.ts";
import {
  trustedFailureSummary,
  trustFailureDiagnostic,
} from "./trusted-failure.ts";
import type {
  AuthorizedTargetOperationInvocation,
  LabelTriggeredTargetOperationInvocation,
  LabelTriggeredTargetOperationIdentity,
} from "./target-operation.ts";

export interface TargetOperationAcquisitionState {
  readonly state: string;
  readonly labels: readonly string[];
  readonly revision: string;
  readonly pullRequest?: {
    readonly headSha: string;
    readonly headRefName: string;
    readonly baseRefName: string;
    readonly baseRepository: string;
    readonly headRepository: string;
  };
}

export function createTargetOperationCommandRunner(options: {
  readonly target: {
    run(invocation: AuthorizedTargetOperationInvocation): Promise<unknown>;
  };
  readonly acquisition: {
    read(operation: LabelTriggeredTargetOperationIdentity, number: number): Promise<TargetOperationAcquisitionState>;
    addInProgress(operation: LabelTriggeredTargetOperationIdentity, number: number): Promise<void>;
    removeTrigger(operation: LabelTriggeredTargetOperationIdentity, number: number): Promise<void>;
    addBlocked(operation: LabelTriggeredTargetOperationIdentity, number: number): Promise<void>;
    addBlockedDiagnostic(
      operation: LabelTriggeredTargetOperationIdentity,
      number: number,
      diagnostic: { readonly jobId: string; readonly summary: string },
    ): Promise<void>;
    removeInProgress(operation: LabelTriggeredTargetOperationIdentity, number: number): Promise<void>;
  };
  readonly createJobId: () => string;
}) {
  return {
    async run(
      operation: LabelTriggeredTargetOperationIdentity,
      number: number,
      reconcile?: LabelTriggeredTargetOperationInvocation["reconcile"],
    ): Promise<unknown> {
      const route = resolveTargetOperationRoute(operation, number);
      if (reconcile !== undefined && operation !== "implement-feedback") {
        throw new Error("Only feedback implementation supports reconciliation");
      }

      const initial = await options.acquisition.read(route.targetOperation, number);
      requireAvailable(initial, route.trigger, number);
      requireOperationSecurity(operation, initial, number);
      const jobId = options.createJobId();
      await options.acquisition.addInProgress(route.targetOperation, number);
      let acquisitionSettled = false;
      try {
        const acquired = await options.acquisition.read(route.targetOperation, number);
        requireAcquiring(acquired, route.trigger, number);
        requireOperationSecurity(operation, acquired, number);
        requireRevision(acquired.revision);
        await options.acquisition.removeTrigger(route.targetOperation, number);
        const settled = await options.acquisition.read(route.targetOperation, number);
        requireSettled(settled, acquired, route.trigger, number);
        acquisitionSettled = true;

        const invocation: AuthorizedTargetOperationInvocation = {
          operation,
          number,
          revision: acquired.revision,
          jobId,
          acquired: true,
          ...(acquired.pullRequest === undefined ? {} : { pullRequest: acquired.pullRequest }),
          ...(reconcile === undefined ? {} : { reconcile }),
        };
        const result = await options.target.run(invocation);
        const outcome = classifyTargetOperationOutcome(operation, result);
        if (outcome.kind === "blocked") {
          await options.acquisition.addBlocked(route.targetOperation, number);
        }
        return outcome.outcome;
      } catch (error) {
        const summary = failureDiagnosticSummary(error);
        await Promise.allSettled([
          options.acquisition.addBlocked(route.targetOperation, number),
          options.acquisition.addBlockedDiagnostic(route.targetOperation, number, {
            jobId,
            summary,
          }),
        ]);
        throw error;
      } finally {
        // An unconfirmed acquisition keeps its visible ownership evidence for
        // inspection; only a settled command may clear in-progress (#219).
        if (acquisitionSettled) {
          await options.acquisition.removeInProgress(route.targetOperation, number).catch(() => undefined);
        }
      }
    },
  };
}

// Errors that embed child-process stderr — worker exits and checkout command
// failures — may carry operation-transformed secrets that pattern redaction
// cannot recognize. Trusted runtime producers authenticate every object-originated
// public diagnostic without exposing a property that arbitrary thrown values can
// forge. Unregistered objects receive only a deterministic classification.
function failureDiagnosticSummary(error: unknown): string {
  const publicSummary = trustedFailureSummary(error);
  if (publicSummary !== undefined) return diagnosticSummary(publicSummary);
  if (
    (typeof error === "object" && error !== null) ||
    typeof error === "function"
  ) {
    return "Unknown Target operation failure";
  }
  try {
    return diagnosticSummary(String(error));
  } catch {
    return "Unknown Target operation failure";
  }
}

function commandFailure(message: string): Error {
  const failure = new Error(message);
  return trustFailureDiagnostic(failure, message);
}

function requireOperationSecurity(
  operation: LabelTriggeredTargetOperationIdentity,
  state: TargetOperationAcquisitionState,
  number: number,
): void {
  const pullRequestOperation = operation === "implement-feedback" || operation === "review" || operation === "update-branch";
  if (!pullRequestOperation) return;
  if (
    state.pullRequest === undefined ||
    state.pullRequest.headSha !== state.revision ||
    state.pullRequest.baseRepository !== state.pullRequest.headRepository
  ) {
    throw commandFailure(`Pull Request #${number} is not an authorized same-repository revision`);
  }
}

function requireRevision(revision: string): void {
  if (!/^[0-9a-f]{40}$/u.test(revision)) {
    throw commandFailure("Target operation requires a full authorized revision");
  }
}

function requireAvailable(
  state: TargetOperationAcquisitionState,
  trigger: string,
  number: number,
): void {
  if (
    state.state !== "OPEN" ||
    !state.labels.includes(trigger) ||
    state.labels.includes("agent:in-progress") ||
    state.labels.includes("agent:blocked")
  ) {
    throw commandFailure(`Work Item #${number} is not available for acquisition`);
  }
}

function requireAcquiring(
  state: TargetOperationAcquisitionState,
  trigger: string,
  number: number,
): void {
  if (
    state.state !== "OPEN" ||
    !state.labels.includes(trigger) ||
    !state.labels.includes("agent:in-progress") ||
    state.labels.includes("agent:blocked")
  ) {
    throw commandFailure(`Work Item #${number} changed while acquisition was starting`);
  }
}

function requireSettled(
  state: TargetOperationAcquisitionState,
  acquired: TargetOperationAcquisitionState,
  trigger: string,
  number: number,
): void {
  if (
    state.state !== "OPEN" ||
    state.revision !== acquired.revision ||
    !samePullRequest(state.pullRequest, acquired.pullRequest) ||
    state.labels.includes(trigger) ||
    !state.labels.includes("agent:in-progress") ||
    state.labels.includes("agent:blocked")
  ) {
    throw commandFailure(`Work Item #${number} changed while acquisition was settling`);
  }
}

function samePullRequest(
  left: TargetOperationAcquisitionState["pullRequest"],
  right: TargetOperationAcquisitionState["pullRequest"],
): boolean {
  if (left === undefined || right === undefined) return left === right;
  return left.headSha === right.headSha &&
    left.headRefName === right.headRefName &&
    left.baseRefName === right.baseRefName &&
    left.baseRepository === right.baseRepository &&
    left.headRepository === right.headRepository;
}
