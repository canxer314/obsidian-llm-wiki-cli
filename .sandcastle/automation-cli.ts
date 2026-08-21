export class AutomationCliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AutomationCliError";
  }
}

export async function runAutomationCli<TReview, TImplement, TSplit>(
  argv: readonly string[],
  dependencies: {
    readonly runReview: (pullRequestNumber: number) => Promise<TReview>;
    readonly runImplement: (issueNumber: number) => Promise<TImplement>;
    readonly runSplit: (issueNumber: number) => Promise<TSplit>;
  },
): Promise<TReview | TImplement | TSplit> {
  const [command, operation, number, ...remaining] = argv;
  if (
    command !== "run" ||
    (operation !== "review" && operation !== "implement" && operation !== "split") ||
    number === undefined ||
    remaining.length > 0
  ) {
    if (command === "run" && operation !== undefined && operation !== "review" && operation !== "implement" && operation !== "split") {
      throw new AutomationCliError(`Unknown automation operation: ${operation}`);
    }
    throw new AutomationCliError("Expected: run review <pull-request-number>, run implement <issue-number>, or run split <issue-number>");
  }
  if (!/^[1-9]\d*$/u.test(number) || !Number.isSafeInteger(Number(number))) {
    throw new AutomationCliError(`${operation} requires a positive ${operation === "review" ? "Pull Request" : "Issue"} number`);
  }
  if (operation === "review") return dependencies.runReview(Number(number));
  if (operation === "implement") return dependencies.runImplement(Number(number));
  return dependencies.runSplit(Number(number));
}
