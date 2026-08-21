export class AutomationCliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AutomationCliError";
  }
}

export async function runAutomationCli<TResult>(
  argv: readonly string[],
  dependencies: { readonly runReview: (pullRequestNumber: number) => Promise<TResult> },
): Promise<TResult> {
  const [command, operation, number, ...remaining] = argv;
  if (command !== "run" || operation !== "review" || number === undefined || remaining.length > 0) {
    if (command === "run" && operation !== undefined && operation !== "review") {
      throw new AutomationCliError(`Unknown automation operation: ${operation}`);
    }
    throw new AutomationCliError("Expected: run review <pull-request-number>");
  }
  if (!/^[1-9]\d*$/u.test(number) || !Number.isSafeInteger(Number(number))) {
    throw new AutomationCliError("review requires a positive Pull Request number");
  }
  return dependencies.runReview(Number(number));
}
