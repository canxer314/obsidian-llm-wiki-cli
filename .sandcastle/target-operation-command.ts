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

      const initial = acquisitionSnapshot(
        operation,
        await options.acquisition.read(route.targetOperation, number),
        number,
      );
      requireAvailable(initial, route.trigger, number);
      requireOperationAuthorization(operation, initial, number);
      const jobId = options.createJobId();
      await options.acquisition.addInProgress(route.targetOperation, number);
      let acquisitionSettled = false;
      try {
        const acquired = acquisitionSnapshot(
          operation,
          await options.acquisition.read(route.targetOperation, number),
          number,
        );
        requireAcquiring(acquired, route.trigger, number);
        requireOperationAuthorization(operation, acquired, number);
        await options.acquisition.removeTrigger(route.targetOperation, number);
        const settled = acquisitionSnapshot(
          operation,
          await options.acquisition.read(route.targetOperation, number),
          number,
        );
        requireOperationAuthorization(operation, settled, number);
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

const ACQUISITION_KEYS = new Set(["state", "labels", "revision"]);
const PULL_REQUEST_ACQUISITION_KEYS = new Set([
  ...ACQUISITION_KEYS,
  "pullRequest",
]);
const PULL_REQUEST_KEYS = new Set([
  "headSha",
  "headRefName",
  "baseRefName",
  "baseRepository",
  "headRepository",
]);

function isPullRequestOperation(
  operation: LabelTriggeredTargetOperationIdentity,
): boolean {
  return operation === "implement-feedback" ||
    operation === "review" ||
    operation === "update-branch";
}

function ownDataDescriptors(
  value: unknown,
): Readonly<Record<PropertyKey, PropertyDescriptor>> | undefined {
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return undefined;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return undefined;
    return Object.getOwnPropertyDescriptors(value) as Record<
      PropertyKey,
      PropertyDescriptor
    >;
  } catch {
    return undefined;
  }
}

function hasExactDataDescriptors(
  descriptors: Readonly<Record<PropertyKey, PropertyDescriptor>>,
  expectedKeys: ReadonlySet<string>,
): boolean {
  const keys = Reflect.ownKeys(descriptors);
  return keys.length === expectedKeys.size &&
    keys.every((key) =>
      typeof key === "string" &&
      expectedKeys.has(key) &&
      Object.hasOwn(descriptors[key]!, "value")
    );
}

function snapshotLabels(value: unknown): readonly string[] | undefined {
  try {
    if (!Array.isArray(value)) return undefined;
    const descriptors = Object.getOwnPropertyDescriptors(value) as Record<
      string,
      PropertyDescriptor
    >;
    const length = descriptors.length;
    if (
      length === undefined ||
      !Object.hasOwn(length, "value") ||
      typeof length.value !== "number" ||
      !Number.isSafeInteger(length.value) ||
      length.value < 0
    ) return undefined;
    const keys = Reflect.ownKeys(descriptors);
    if (keys.length !== length.value + 1) return undefined;
    const labels: string[] = [];
    for (let index = 0; index < length.value; index += 1) {
      const descriptor = descriptors[String(index)];
      if (
        descriptor === undefined ||
        !Object.hasOwn(descriptor, "value") ||
        typeof descriptor.value !== "string"
      ) return undefined;
      labels.push(descriptor.value);
    }
    return Object.freeze(labels);
  } catch {
    return undefined;
  }
}

function snapshotPullRequest(
  value: unknown,
): TargetOperationAcquisitionState["pullRequest"] {
  const descriptors = ownDataDescriptors(value);
  if (
    descriptors === undefined ||
    !hasExactDataDescriptors(descriptors, PULL_REQUEST_KEYS)
  ) return undefined;
  const snapshot = Object.create(null) as NonNullable<
    TargetOperationAcquisitionState["pullRequest"]
  >;
  Object.assign(snapshot, {
    headSha: descriptors.headSha!.value as string,
    headRefName: descriptors.headRefName!.value as string,
    baseRefName: descriptors.baseRefName!.value as string,
    baseRepository: descriptors.baseRepository!.value as string,
    headRepository: descriptors.headRepository!.value as string,
  });
  return Object.freeze(snapshot);
}

function acquisitionSnapshot(
  operation: LabelTriggeredTargetOperationIdentity,
  value: unknown,
  number: number,
): TargetOperationAcquisitionState {
  const pullRequestOperation = isPullRequestOperation(operation);
  const descriptors = ownDataDescriptors(value);
  const expectedKeys = pullRequestOperation
    ? PULL_REQUEST_ACQUISITION_KEYS
    : ACQUISITION_KEYS;
  if (
    descriptors === undefined ||
    !hasExactDataDescriptors(descriptors, expectedKeys)
  ) {
    throw new Error("Target operation acquisition authorization is invalid");
  }
  const labels = snapshotLabels(descriptors.labels!.value);
  if (labels === undefined) {
    throw new Error("Target operation acquisition authorization is invalid");
  }
  const common = Object.assign(
    Object.create(null) as {
      state: string;
      labels: readonly string[];
      revision: string;
    },
    {
      state: descriptors.state!.value as string,
      labels,
      revision: descriptors.revision!.value as string,
    },
  );
  if (!pullRequestOperation) return Object.freeze(common);
  const pullRequest = snapshotPullRequest(descriptors.pullRequest!.value);
  if (pullRequest === undefined) throw unauthorizedPullRequestFailure(number);
  const snapshot = Object.assign(
    Object.create(null) as TargetOperationAcquisitionState,
    common,
    { pullRequest },
  );
  return Object.freeze(snapshot);
}

function requireOperationAuthorization(
  operation: LabelTriggeredTargetOperationIdentity,
  state: TargetOperationAcquisitionState,
  number: number,
): void {
  requireRevision(state.revision);
  const pullRequestOperation = operation === "implement-feedback" || operation === "review" || operation === "update-branch";
  if (!pullRequestOperation) {
    if (Object.hasOwn(state, "pullRequest")) {
      throw new Error("Target operation acquisition authorization is invalid");
    }
    return;
  }
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

function requireRevision(revision: unknown): asserts revision is string {
  if (typeof revision !== "string" || !/^[0-9a-f]{40}$/u.test(revision)) {
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
