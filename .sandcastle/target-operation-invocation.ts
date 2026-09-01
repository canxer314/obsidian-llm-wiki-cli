import type { FeedbackReconcileAuthorization } from "./feedback-implementation-automation.ts";

export type TargetOperationIdentity =
  | "implement-issue"
  | "implement-prd"
  | "implement-feedback"
  | "review"
  | "update-branch"
  | "split-prd"
  | "architecture-review";

export type LabelTriggeredTargetOperationIdentity = Exclude<
  TargetOperationIdentity,
  "architecture-review"
>;

type IssueTargetOperationIdentity =
  | "implement-issue"
  | "implement-prd"
  | "split-prd";

type PullRequestTargetOperationIdentity = "review" | "update-branch";

export interface TargetPullRequestAuthorization {
  readonly headSha: string;
  readonly headRefName: string;
  readonly baseRefName: string;
  readonly baseRepository: string;
  readonly headRepository: string;
}

interface AcquiredTargetOperationInvocation {
  readonly revision: string;
  readonly jobId: string;
  readonly acquired: true;
}

interface OuterTargetOperationInvocation {
  readonly number: number;
}

export type AuthorizedTargetOperationInvocation =
  | (AcquiredTargetOperationInvocation & OuterTargetOperationInvocation & {
      readonly operation: IssueTargetOperationIdentity;
    })
  | (AcquiredTargetOperationInvocation & OuterTargetOperationInvocation & {
      readonly operation: PullRequestTargetOperationIdentity;
      readonly pullRequest: TargetPullRequestAuthorization;
    })
  | (AcquiredTargetOperationInvocation & OuterTargetOperationInvocation & {
      readonly operation: "implement-feedback";
      readonly pullRequest: TargetPullRequestAuthorization;
      readonly reconcile?: FeedbackReconcileAuthorization;
    })
  | {
      readonly operation: "architecture-review";
      readonly revision: string;
      readonly jobId: string;
    };

export type TargetOperationWorkerInvocation =
  | (AcquiredTargetOperationInvocation & {
      readonly operation: IssueTargetOperationIdentity;
    })
  | (AcquiredTargetOperationInvocation & {
      readonly operation: PullRequestTargetOperationIdentity;
      readonly pullRequest: TargetPullRequestAuthorization;
    })
  | (AcquiredTargetOperationInvocation & {
      readonly operation: "implement-feedback";
      readonly pullRequest: TargetPullRequestAuthorization;
      readonly reconcile?: FeedbackReconcileAuthorization;
    })
  | {
      readonly operation: "architecture-review";
      readonly revision: string;
      readonly jobId: string;
    };

export interface ParsedTargetOperationWorkerInvocation {
  readonly number: number | undefined;
  readonly invocation: TargetOperationWorkerInvocation;
}

const FULL_REVISION = /^[0-9a-f]{40}$/u;
const POSITIVE_INTEGER = /^[1-9]\d*$/u;
const targetOperations = new Set<TargetOperationIdentity>([
  "implement-issue",
  "implement-prd",
  "implement-feedback",
  "review",
  "update-branch",
  "split-prd",
  "architecture-review",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: object, authorizedKeys: ReadonlySet<string>): boolean {
  const keys = Reflect.ownKeys(value);
  return keys.length === authorizedKeys.size &&
    keys.every((key) => typeof key === "string" && authorizedKeys.has(key));
}

function isFullRevision(value: unknown): value is string {
  return typeof value === "string" && FULL_REVISION.test(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isTargetOperation(value: unknown): value is TargetOperationIdentity {
  return typeof value === "string" && targetOperations.has(value as TargetOperationIdentity);
}

function isFeedbackReplyIntent(value: unknown): boolean {
  return isRecord(value) &&
    hasOnlyKeys(value, new Set(["rootCommentId", "body"])) &&
    isNonEmptyString(value.rootCommentId) &&
    typeof value.body === "string";
}

function isFeedbackReconcileAuthorization(value: unknown): boolean {
  if (!isRecord(value) || value.invocation !== "reconcile") return false;
  const keys = new Set(["invocation"]);
  if ("baseRevision" in value) keys.add("baseRevision");
  if ("expectedPost" in value) keys.add("expectedPost");
  if ("expectedReply" in value) keys.add("expectedReply");
  return hasOnlyKeys(value, keys) &&
    (!("baseRevision" in value) || isFullRevision(value.baseRevision)) &&
    (!("expectedPost" in value) || isFullRevision(value.expectedPost)) &&
    (!("expectedReply" in value) || isFeedbackReplyIntent(value.expectedReply));
}

function isPullRequestAuthorization(value: unknown, revision: string): boolean {
  if (!isRecord(value)) return false;
  if (!hasOnlyKeys(value, new Set([
    "headSha",
    "headRefName",
    "baseRefName",
    "baseRepository",
    "headRepository",
  ]))) return false;
  return isFullRevision(value.headSha) &&
    value.headSha === revision &&
    isNonEmptyString(value.headRefName) &&
    isNonEmptyString(value.baseRefName) &&
    isNonEmptyString(value.baseRepository) &&
    isNonEmptyString(value.headRepository) &&
    value.baseRepository === value.headRepository;
}

function labelInvocationKeys(
  operation: LabelTriggeredTargetOperationIdentity,
  outer: boolean,
  hasReconcile: boolean,
): ReadonlySet<string> {
  const keys = new Set([
    "operation",
    "revision",
    "jobId",
    "acquired",
    ...(outer ? ["number"] : []),
  ]);
  if (
    operation === "implement-feedback" ||
    operation === "review" ||
    operation === "update-branch"
  ) keys.add("pullRequest");
  if (operation === "implement-feedback" && hasReconcile) keys.add("reconcile");
  return keys;
}

function requireScheduledInvocation(
  value: Record<string, unknown>,
  message: string,
): void {
  if (
    value.operation !== "architecture-review" ||
    !isFullRevision(value.revision) ||
    !isNonEmptyString(value.jobId) ||
    !hasOnlyKeys(value, new Set(["operation", "revision", "jobId"]))
  ) throw new Error(message);
}

function requireLabelInvocation(
  value: Record<string, unknown>,
  operation: LabelTriggeredTargetOperationIdentity,
  outer: boolean,
): void {
  if (!isFullRevision(value.revision) || !isNonEmptyString(value.jobId)) {
    throw new Error(outer
      ? "Target operation requires an authorized invocation"
      : "Target operation invocation is invalid");
  }
  if (outer && (!Number.isSafeInteger(value.number) || (value.number as number) < 1)) {
    throw new Error("Target operation Work Item number is invalid");
  }
  if (value.acquired !== true) {
    throw new Error("Target operation invocation is not acquired");
  }
  if (
    (operation === "implement-feedback" || operation === "review" || operation === "update-branch") &&
    !isPullRequestAuthorization(value.pullRequest, value.revision)
  ) {
    throw new Error("Target Pull Request operation requires an acquired same-repository revision");
  }
  if (
    operation === "implement-feedback" &&
    "reconcile" in value &&
    !isFeedbackReconcileAuthorization(value.reconcile)
  ) {
    throw new Error("Target feedback reconciliation authorization is invalid");
  }
  if (!hasOnlyKeys(
    value,
    labelInvocationKeys(operation, outer, "reconcile" in value),
  )) {
    throw new Error("Target operation invocation is invalid");
  }
}

function materializePullRequestAuthorization(
  value: Record<string, unknown>,
): TargetPullRequestAuthorization {
  return {
    headSha: value.headSha as string,
    headRefName: value.headRefName as string,
    baseRefName: value.baseRefName as string,
    baseRepository: value.baseRepository as string,
    headRepository: value.headRepository as string,
  };
}

function materializeFeedbackReconcileAuthorization(
  value: Record<string, unknown>,
): FeedbackReconcileAuthorization {
  return {
    invocation: "reconcile",
    ...(value.baseRevision === undefined ? {} : {
      baseRevision: value.baseRevision as string,
    }),
    ...(value.expectedPost === undefined ? {} : {
      expectedPost: value.expectedPost as string,
    }),
    ...(value.expectedReply === undefined ? {} : {
      expectedReply: {
        rootCommentId: (value.expectedReply as Record<string, unknown>).rootCommentId as string,
        body: (value.expectedReply as Record<string, unknown>).body as string,
      },
    }),
  };
}

function materializeOuterInvocation(
  value: Record<string, unknown>,
): AuthorizedTargetOperationInvocation {
  const common = {
    operation: value.operation as LabelTriggeredTargetOperationIdentity,
    number: value.number as number,
    revision: value.revision as string,
    jobId: value.jobId as string,
    acquired: true as const,
  };
  if (common.operation === "implement-feedback") {
    return {
      ...common,
      operation: common.operation,
      pullRequest: materializePullRequestAuthorization(
        value.pullRequest as Record<string, unknown>,
      ),
      ...(value.reconcile === undefined ? {} : {
        reconcile: materializeFeedbackReconcileAuthorization(
          value.reconcile as Record<string, unknown>,
        ),
      }),
    };
  }
  if (common.operation === "review" || common.operation === "update-branch") {
    return {
      ...common,
      operation: common.operation,
      pullRequest: materializePullRequestAuthorization(
        value.pullRequest as Record<string, unknown>,
      ),
    };
  }
  return {
    ...common,
    operation: common.operation,
  };
}

function materializeWorkerInvocation(
  value: Record<string, unknown>,
): TargetOperationWorkerInvocation {
  const common = {
    operation: value.operation as LabelTriggeredTargetOperationIdentity,
    revision: value.revision as string,
    jobId: value.jobId as string,
    acquired: true as const,
  };
  if (common.operation === "implement-feedback") {
    return {
      ...common,
      operation: common.operation,
      pullRequest: materializePullRequestAuthorization(
        value.pullRequest as Record<string, unknown>,
      ),
      ...(value.reconcile === undefined ? {} : {
        reconcile: materializeFeedbackReconcileAuthorization(
          value.reconcile as Record<string, unknown>,
        ),
      }),
    };
  }
  if (common.operation === "review" || common.operation === "update-branch") {
    return {
      ...common,
      operation: common.operation,
      pullRequest: materializePullRequestAuthorization(
        value.pullRequest as Record<string, unknown>,
      ),
    };
  }
  return {
    ...common,
    operation: common.operation,
  };
}

export function parseAuthorizedTargetOperationInvocation(
  value: unknown,
): AuthorizedTargetOperationInvocation {
  if (!isRecord(value) || !isTargetOperation(value.operation)) {
    throw new Error("Target operation requires an authorized invocation");
  }
  if (value.operation === "architecture-review") {
    requireScheduledInvocation(
      value,
      "Scheduled architecture review invocation is invalid",
    );
    return {
      operation: "architecture-review",
      revision: value.revision as string,
      jobId: value.jobId as string,
    };
  }
  requireLabelInvocation(value, value.operation, true);
  return materializeOuterInvocation(value);
}

export function targetOperationWorkerArguments(
  invocation: AuthorizedTargetOperationInvocation,
): readonly string[] {
  if (invocation.operation === "architecture-review") {
    return [JSON.stringify(invocation)];
  }
  const { number, ...workerInvocation } = invocation;
  return [String(number), JSON.stringify(workerInvocation)];
}

function parseSerializedInvocation(value: string | undefined): Record<string, unknown> {
  if (value === undefined) throw new Error("Target operation invocation is missing");
  try {
    const parsed: unknown = JSON.parse(value);
    if (!isRecord(parsed)) throw new Error();
    return parsed;
  } catch {
    throw new Error("Target operation invocation is invalid");
  }
}

export function parseTargetOperationWorkerInvocation(
  operation: TargetOperationIdentity,
  argv: readonly string[],
): ParsedTargetOperationWorkerInvocation {
  const scheduled = operation === "architecture-review";
  if (argv.length > (scheduled ? 1 : 2)) {
    throw new Error("Target operation invocation is invalid");
  }
  const numberArgument = scheduled ? undefined : argv[0];
  const invocationArgument = scheduled ? argv[0] : argv[1];
  const number = numberArgument === undefined ? undefined : Number(numberArgument);
  if (
    !scheduled &&
    (numberArgument === undefined || !POSITIVE_INTEGER.test(numberArgument) ||
      !Number.isSafeInteger(number))
  ) {
    throw new Error("Target operation Work Item number is invalid");
  }
  const invocation = parseSerializedInvocation(invocationArgument);
  if (
    !isFullRevision(invocation.revision) ||
    typeof invocation.operation !== "string" ||
    !isNonEmptyString(invocation.jobId)
  ) {
    throw new Error("Target operation invocation is invalid");
  }
  if (invocation.operation !== operation) {
    throw new Error("Target operation wrapper does not match the authorized invocation");
  }
  let authorizedInvocation: TargetOperationWorkerInvocation;
  if (scheduled) {
    requireScheduledInvocation(invocation, "Target operation invocation is invalid");
    authorizedInvocation = {
      operation: "architecture-review",
      revision: invocation.revision as string,
      jobId: invocation.jobId as string,
    };
  } else {
    requireLabelInvocation(invocation, operation, false);
    authorizedInvocation = materializeWorkerInvocation(invocation);
  }
  return {
    number,
    invocation: authorizedInvocation,
  };
}
