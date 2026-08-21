export class AutomationCliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AutomationCliError";
  }
}

export async function runAutomationCli<TReview, TImplement, TFeedback, TSplit, TDispatch, TInspect>(
  argv: readonly string[],
  dependencies: {
    readonly runReview: (pullRequestNumber: number) => Promise<TReview>;
    readonly runImplement: (issueNumber: number) => Promise<TImplement>;
    readonly runFeedback: (pullRequestNumber: number) => Promise<TFeedback>;
    readonly runSplit: (issueNumber: number) => Promise<TSplit>;
    readonly dispatch?: (concurrency?: number) => Promise<TDispatch>;
    readonly inspect?: () => Promise<TInspect>;
  },
): Promise<TReview | TImplement | TFeedback | TSplit | TDispatch | TInspect> {
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
    (operation !== "review" && operation !== "implement" && operation !== "feedback" && operation !== "split") ||
    number === undefined ||
    remaining.length > 0
  ) {
    if (command === "run" && operation !== undefined && !["review", "implement", "feedback", "split"].includes(operation)) {
      throw new AutomationCliError(`Unknown automation operation: ${operation}`);
    }
    throw new AutomationCliError("Expected: run review <pull-request-number>, run feedback <pull-request-number>, run implement <issue-number>, or run split <issue-number>");
  }
  if (!/^[1-9]\d*$/u.test(number) || !Number.isSafeInteger(Number(number))) {
    throw new AutomationCliError(`${operation} requires a positive ${operation === "implement" || operation === "split" ? "Issue" : "Pull Request"} number`);
  }
  if (operation === "review") return dependencies.runReview(Number(number));
  if (operation === "feedback") return dependencies.runFeedback(Number(number));
  if (operation === "implement") return dependencies.runImplement(Number(number));
  return dependencies.runSplit(Number(number));
}
