export class AutomationCliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AutomationCliError";
  }
}

export async function runAutomationCli<TReview, TImplement, TImplementPrd, TFeedback, TSplit, TUpdate, TDispatch, TInspect, TSetup, TArchitectureReview>(
  argv: readonly string[],
  dependencies: {
    readonly runReview: (pullRequestNumber: number) => Promise<TReview>;
    readonly runImplement: (issueNumber: number) => Promise<TImplement>;
    readonly runImplementPrd: (issueNumber: number) => Promise<TImplementPrd>;
    readonly runFeedback: (pullRequestNumber: number) => Promise<TFeedback>;
    readonly runSplit: (issueNumber: number) => Promise<TSplit>;
    readonly runUpdate: (pullRequestNumber: number) => Promise<TUpdate>;
    readonly dispatch?: (concurrency?: number) => Promise<TDispatch>;
    readonly inspect?: () => Promise<TInspect>;
    readonly setupLabels?: () => Promise<TSetup>;
    readonly architectureReview?: () => Promise<TArchitectureReview>;
  },
): Promise<TReview | TImplement | TImplementPrd | TFeedback | TSplit | TUpdate | TDispatch | TInspect | TSetup | TArchitectureReview> {
  if (argv[0] === "architecture-review") {
    if (argv.length !== 1 || dependencies.architectureReview === undefined) throw new AutomationCliError("Expected: architecture-review");
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
  if (argv[0] === "dispatch") {
    const [_command, option, value, ...remaining] = argv;
    if (dependencies.dispatch === undefined || remaining.length > 0 || (option !== undefined && option !== "--concurrency")) {
      throw new AutomationCliError("Expected: dispatch [--concurrency <positive-number>]");
    }
    if (option === undefined) return dependencies.dispatch();
    if (value === undefined || !/^[1-9]\d*$/u.test(value) || !Number.isSafeInteger(Number(value))) {
      throw new AutomationCliError("dispatch concurrency requires a positive number");
    }
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
    throw new AutomationCliError("Expected: run review <pull-request-number>, run feedback <pull-request-number>, run implement <issue-number>, run implement-prd <issue-number>, run split <issue-number>, or run update-branch <pull-request-number>");
  }
  if (!/^[1-9]\d*$/u.test(number) || !Number.isSafeInteger(Number(number))) {
    throw new AutomationCliError(`${operation} requires a positive ${operation === "implement" || operation === "implement-prd" || operation === "split" ? "Issue" : "Pull Request"} number`);
  }
  if (operation === "review") return dependencies.runReview(Number(number));
  if (operation === "feedback") return dependencies.runFeedback(Number(number));
  if (operation === "implement") return dependencies.runImplement(Number(number));
  if (operation === "implement-prd") return dependencies.runImplementPrd(Number(number));
  if (operation === "split") return dependencies.runSplit(Number(number));
  return dependencies.runUpdate(Number(number));
}
