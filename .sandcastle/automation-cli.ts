import type { FeedbackReconcileAuthorization } from "./feedback-implementation-automation.ts";

export class AutomationCliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AutomationCliError";
  }
}

// A controlled feedback reconcile authorization (#293): the operator supplies
// the durable facts — acquired revision, expected POST, reply intent — that
// plain observe-first dispatch deliberately never assumes.
export type FeedbackReconcileRequest = FeedbackReconcileAuthorization;

const RECONCILE_USAGE =
  "Expected: reconcile feedback <pull-request-number> [--base-revision <revision>] [--expected-post <revision>] [--reply-root <id>] [--reply-body <text>]";
const FULL_REVISION = /^[0-9a-f]{40}$/u;

export function parseReconcileFlags(flags: readonly string[]): FeedbackReconcileRequest {
  let baseRevision: string | undefined;
  let expectedPost: string | undefined;
  let replyRoot: string | undefined;
  let replyBody: string | undefined;
  for (let index = 0; index < flags.length; index += 2) {
    const flag = flags[index];
    const value = flags[index + 1];
    if (value === undefined) throw new AutomationCliError(`${flag} requires a value`);
    if (flag === "--base-revision" || flag === "--expected-post") {
      if (!FULL_REVISION.test(value)) throw new AutomationCliError(`${flag} requires a 40-character revision`);
      if (flag === "--base-revision") baseRevision = value;
      else expectedPost = value;
    } else if (flag === "--reply-root") {
      replyRoot = value;
    } else if (flag === "--reply-body") {
      replyBody = value;
    } else {
      throw new AutomationCliError(`Unknown reconcile flag: ${flag}`);
    }
  }
  if ((replyRoot === undefined) !== (replyBody === undefined)) {
    throw new AutomationCliError("--reply-root and --reply-body must be provided together");
  }
  return {
    invocation: "reconcile",
    ...(baseRevision === undefined ? {} : { baseRevision }),
    ...(expectedPost === undefined ? {} : { expectedPost }),
    ...(replyRoot === undefined || replyBody === undefined ? {} : { expectedReply: { rootCommentId: replyRoot, body: replyBody } }),
  };
}

export async function runAutomationCli<TReview, TImplement, TImplementPrd, TFeedback, TSplit, TUpdate, TDispatch, TInspect, TSetup, TBuildImage, TArchitectureReview>(
  argv: readonly string[],
  dependencies: {
    readonly runReview: (pullRequestNumber: number) => Promise<TReview>;
    readonly runImplement: (issueNumber: number) => Promise<TImplement>;
    readonly runImplementPrd: (issueNumber: number) => Promise<TImplementPrd>;
    readonly runFeedback: (pullRequestNumber: number, reconcile?: FeedbackReconcileRequest) => Promise<TFeedback>;
    readonly runSplit: (issueNumber: number) => Promise<TSplit>;
    readonly runUpdate: (pullRequestNumber: number) => Promise<TUpdate>;
    readonly dispatch?: (concurrency?: number) => Promise<TDispatch>;
    readonly preflight?: (operation: string) => Promise<void>;
    readonly inspect?: () => Promise<TInspect>;
    readonly setupLabels?: () => Promise<TSetup>;
    readonly buildImage?: () => Promise<TBuildImage>;
    readonly architectureReview?: () => Promise<TArchitectureReview>;
  },
): Promise<TReview | TImplement | TImplementPrd | TFeedback | TSplit | TUpdate | TDispatch | TInspect | TSetup | TBuildImage | TArchitectureReview> {
  if (argv[0] === "build-image") {
    if (argv.length !== 1 || dependencies.buildImage === undefined) throw new AutomationCliError("Expected: build-image");
    return dependencies.buildImage();
  }
  if (argv[0] === "architecture-review") {
    if (argv.length !== 1 || dependencies.architectureReview === undefined) throw new AutomationCliError("Expected: architecture-review");
    await dependencies.preflight?.("architecture-review");
    return dependencies.architectureReview();
  }
  if (argv[0] === "setup-labels") {
    if (argv.length !== 1 || dependencies.setupLabels === undefined) throw new AutomationCliError("Expected: setup-labels");
    return dependencies.setupLabels();
  }
  if (argv[0] === "inspect") {
    if (argv.length !== 1 || dependencies.inspect === undefined) throw new AutomationCliError("Expected: inspect");
    return dependencies.inspect();
  }
  if (argv[0] === "reconcile") {
    const [_command, operation, number, ...flags] = argv;
    if (operation !== "feedback" || number === undefined) throw new AutomationCliError(RECONCILE_USAGE);
    if (!/^[1-9]\d*$/u.test(number) || !Number.isSafeInteger(Number(number))) {
      throw new AutomationCliError("reconcile feedback requires a positive Pull Request number");
    }
    await dependencies.preflight?.("feedback");
    return dependencies.runFeedback(Number(number), parseReconcileFlags(flags));
  }
  if (argv[0] === "dispatch") {
    const [_command, option, value, ...remaining] = argv;
    if (dependencies.dispatch === undefined || remaining.length > 0 || (option !== undefined && option !== "--concurrency")) {
      throw new AutomationCliError("Expected: dispatch [--concurrency <positive-number>]");
    }
    if (option === undefined) {
      await dependencies.preflight?.("dispatch");
      return dependencies.dispatch();
    }
    if (value === undefined || !/^[1-9]\d*$/u.test(value) || !Number.isSafeInteger(Number(value))) {
      throw new AutomationCliError("dispatch concurrency requires a positive number");
    }
    await dependencies.preflight?.("dispatch");
    return dependencies.dispatch(Number(value));
  }
  const [command, operation, number, ...remaining] = argv;
  if (
    command !== "run" ||
    (operation !== "review" && operation !== "implement" && operation !== "implement-prd" && operation !== "feedback" && operation !== "split" && operation !== "update-branch") ||
    number === undefined ||
    remaining.length > 0
  ) {
    if (command === "run" && operation !== undefined && !["review", "implement", "implement-prd", "feedback", "split", "update-branch"].includes(operation)) {
      throw new AutomationCliError(`Unknown automation operation: ${operation}`);
    }
    throw new AutomationCliError(`Expected: run review <pull-request-number>, run feedback <pull-request-number>, run implement <issue-number>, run implement-prd <issue-number>, run split <issue-number>, run update-branch <pull-request-number>, or ${RECONCILE_USAGE.replace("Expected: ", "")}`);
  }
  if (!/^[1-9]\d*$/u.test(number) || !Number.isSafeInteger(Number(number))) {
    throw new AutomationCliError(`${operation} requires a positive ${operation === "implement" || operation === "implement-prd" || operation === "split" ? "Issue" : "Pull Request"} number`);
  }
  await dependencies.preflight?.(operation);
  if (operation === "review") return dependencies.runReview(Number(number));
  if (operation === "feedback") return dependencies.runFeedback(Number(number));
  if (operation === "implement") return dependencies.runImplement(Number(number));
  if (operation === "implement-prd") return dependencies.runImplementPrd(Number(number));
  if (operation === "split") return dependencies.runSplit(Number(number));
  return dependencies.runUpdate(Number(number));
}
