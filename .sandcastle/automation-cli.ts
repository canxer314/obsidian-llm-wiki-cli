export class AutomationCliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AutomationCliError";
  }
}

export async function runAutomationCli<TReview, TImplement, TFeedback>(
  argv: readonly string[],
  dependencies: {
    readonly runReview: (pullRequestNumber: number) => Promise<TReview>;
    readonly runImplement: (issueNumber: number) => Promise<TImplement>;
    readonly runFeedback: (pullRequestNumber: number) => Promise<TFeedback>;
  },
): Promise<TReview | TImplement | TFeedback> {
  const [command, operation, number, ...remaining] = argv;
  if (
    command !== "run" ||
    (operation !== "review" && operation !== "implement" && operation !== "feedback") ||
    number === undefined ||
    remaining.length > 0
  ) {
    if (
      command === "run" &&
      operation !== undefined &&
      operation !== "review" &&
      operation !== "implement" &&
      operation !== "feedback"
    ) {
      throw new AutomationCliError(`Unknown automation operation: ${operation}`);
    }
    throw new AutomationCliError("Expected: run review <pull-request-number>, run feedback <pull-request-number>, or run implement <issue-number>");
  }
  if (!/^[1-9]\d*$/u.test(number) || !Number.isSafeInteger(Number(number))) {
    throw new AutomationCliError(`${operation} requires a positive ${operation === "implement" ? "Issue" : "Pull Request"} number`);
  }
  if (operation === "review") return dependencies.runReview(Number(number));
  if (operation === "feedback") return dependencies.runFeedback(Number(number));
  return dependencies.runImplement(Number(number));
}
