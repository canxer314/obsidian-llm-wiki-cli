import {
  resolveTargetOperationRoute,
} from "./automation-command-route.ts";
import { diagnosticSummary } from "./redaction.ts";
import { classifyTargetOperationOutcome } from "./target-operation-outcome.ts";
import {
  invalidTargetOperationRevisionFailure,
  trustedFailureSummary,
  unauthorizedPullRequestFailure,
  unavailableWorkItemFailure,
  workItemChangedWhileSettlingFailure,
  workItemChangedWhileStartingFailure,
} from "./trusted-failure.ts";
import type { FeedbackReconcileAuthorization } from "./feedback-implementation-automation.ts";
import {
  parseAuthorizedTargetOperationInvocation,
  parseFeedbackReconcileAuthorization,
  type AuthorizedTargetOperationInvocation,
  type LabelTriggeredTargetOperationIdentity,
} from "./target-operation-invocation.ts";

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
      reconcile?: FeedbackReconcileAuthorization,
    ): Promise<unknown> {
      const route = resolveTargetOperationRoute(operation, number);
      if (reconcile !== undefined && operation !== "implement-feedback") {
        throw new Error("Only feedback implementation supports reconciliation");
      }
      const authorizedReconcile = reconcile === undefined
        ? undefined
        : parseFeedbackReconcileAuthorization(reconcile);

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

        const invocation = parseAuthorizedTargetOperationInvocation({
          operation,
          number,
          revision: acquired.revision,
          jobId,
          acquired: true,
          ...(acquired.pullRequest === undefined ? {} : { pullRequest: acquired.pullRequest }),
          ...(authorizedReconcile === undefined ? {} : { reconcile: authorizedReconcile }),
        });
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
// cannot recognize. Trusted runtime producers authenticate every specific
// public diagnostic without exposing authority that arbitrary thrown values can
// forge. Every unregistered value receives only a deterministic classification.
function failureDiagnosticSummary(error: unknown): string {
  const publicSummary = trustedFailureSummary(error);
  if (publicSummary !== undefined) return diagnosticSummary(publicSummary);
  return "Unknown Target operation failure";
}

function requireOperationSecurity(
  operation: LabelTriggeredTargetOperationIdentity,
  state: TargetOperationAcquisitionState,
  number: number,
): void {
  const pullRequestOperation = operation === "implement-feedback" || operation === "review" || operation === "update-branch";
  if (!pullRequestOperation) return;
  if (!isAuthorizedPullRequestState(state)) {
    throw unauthorizedPullRequestFailure(number);
  }
}

function isAuthorizedPullRequestState(
  state: TargetOperationAcquisitionState,
): boolean {
  const pullRequest: unknown = state.pullRequest;
  if (
    typeof pullRequest !== "object" ||
    pullRequest === null ||
    Array.isArray(pullRequest)
  ) return false;
  const authorizedKeys = new Set([
    "headSha",
    "headRefName",
    "baseRefName",
    "baseRepository",
    "headRepository",
  ]);
  const keys = Reflect.ownKeys(pullRequest);
  if (
    keys.length !== authorizedKeys.size ||
    !keys.every((key) =>
      typeof key === "string" && authorizedKeys.has(key)
    )
  ) return false;
  const authorization = pullRequest as Record<string, unknown>;
  return /^[0-9a-f]{40}$/u.test(state.revision) &&
    authorization.headSha === state.revision &&
    typeof authorization.headRefName === "string" &&
    authorization.headRefName.length > 0 &&
    typeof authorization.baseRefName === "string" &&
    authorization.baseRefName.length > 0 &&
    typeof authorization.baseRepository === "string" &&
    authorization.baseRepository.length > 0 &&
    typeof authorization.headRepository === "string" &&
    authorization.headRepository.length > 0 &&
    authorization.baseRepository === authorization.headRepository;
}

function requireRevision(revision: string): void {
  if (!/^[0-9a-f]{40}$/u.test(revision)) {
    throw invalidTargetOperationRevisionFailure();
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
    throw unavailableWorkItemFailure(number);
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
    throw workItemChangedWhileStartingFailure(number);
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
    throw workItemChangedWhileSettlingFailure(number);
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
