import {
  resolveTargetOperationRoute,
} from "./automation-command-route.ts";
import { diagnosticSummary } from "./redaction.ts";
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
        requireTargetOutcome(result);
        if (isBlocked(result)) {
          await options.acquisition.addBlocked(route.targetOperation, number);
        }
        return result;
      } catch (error) {
        const summary = diagnosticSummary(
          error instanceof Error ? error.message : String(error),
        );
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
    throw new Error(`Pull Request #${number} is not an authorized same-repository revision`);
  }
}

function requireRevision(revision: string): void {
  if (!/^[0-9a-f]{40}$/u.test(revision)) {
    throw new Error("Target operation requires a full authorized revision");
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
    throw new Error(`Work Item #${number} is not available for acquisition`);
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
    throw new Error(`Work Item #${number} changed while acquisition was starting`);
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
    throw new Error(`Work Item #${number} changed while acquisition was settling`);
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

const targetOutcomeStatuses = new Set([
  "implemented",
  "reviewed",
  "updated",
  "up-to-date",
  "split",
  "proposed",
  "skipped",
  "refused",
  "blocked",
]);

function requireTargetOutcome(value: unknown): void {
  if (
    typeof value !== "object" || value === null ||
    !("status" in value) || typeof value.status !== "string" ||
    !targetOutcomeStatuses.has(value.status)
  ) {
    throw new Error("Target operation returned an invalid outcome");
  }
}

function isBlocked(value: unknown): boolean {
  return typeof value === "object" && value !== null &&
    "status" in value && value.status === "blocked";
}
