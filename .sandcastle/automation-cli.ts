export class AutomationCliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AutomationCliError";
  }
}

export async function runAutomationCli<TReview, TImplement>(
  argv: readonly string[],
  dependencies: {
    readonly runReview: (pullRequestNumber: number) => Promise<TReview>;
    readonly runImplement: (issueNumber: number) => Promise<TImplement>;
  },
): Promise<TReview | TImplement> {
  const [command, operation, number, ...remaining] = argv;
  if (
    command !== "run" ||
    (operation !== "review" && operation !== "implement") ||
    number === undefined ||
    remaining.length > 0
  ) {
    if (command === "run" && operation !== undefined && operation !== "review" && operation !== "implement") {
      throw new AutomationCliError(`Unknown automation operation: ${operation}`);
    }
    throw new AutomationCliError("Expected: run review <pull-request-number> or run implement <issue-number>");
  }
  if (!/^[1-9]\d*$/u.test(number) || !Number.isSafeInteger(Number(number))) {
    throw new AutomationCliError(`${operation} requires a positive ${operation === "review" ? "Pull Request" : "Issue"} number`);
  }
  return operation === "review"
    ? dependencies.runReview(Number(number))
    : dependencies.runImplement(Number(number));
}
