export class SandcastleCliError extends Error {
  readonly exitCode = 2;

  constructor(message: string) {
    super(message);
    this.name = "SandcastleCliError";
  }
}

export interface SandcastleIssue {
  readonly number: number;
  readonly state: string;
  readonly labels: readonly string[];
}

export interface SandcastleGithubPort {
  ensureLabel(name: string): Promise<void>;
  getIssue(number: number): Promise<SandcastleIssue | null>;
  claimIssue(number: number): Promise<boolean>;
}

export interface SandcastleCliDependencies<TResult = unknown> {
  readonly github: SandcastleGithubPort;
  readonly processIssue: (issueNumber: number) => Promise<TResult>;
}

interface CliOptions {
  readonly issueNumber?: number;
  readonly watch: boolean;
}

function parseCliOptions(argv: readonly string[]): CliOptions {
  let issueNumber: number | undefined;
  let watch = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--watch") {
      watch = true;
      continue;
    }
    if (argument === "--issue") {
      const value = argv[index + 1];
      if (value === undefined) {
        throw new SandcastleCliError("--issue requires a number");
      }
      issueNumber = Number(value);
      if (!Number.isSafeInteger(issueNumber) || issueNumber <= 0) {
        throw new SandcastleCliError("--issue requires a positive integer");
      }
      index += 1;
      continue;
    }
    throw new SandcastleCliError(`Unknown argument: ${argument}`);
  }

  if (issueNumber !== undefined && watch) {
    throw new SandcastleCliError("--issue and --watch cannot be used together");
  }
  if (issueNumber === undefined && !watch) {
    throw new SandcastleCliError(
      "Missing required --issue <number>; use --watch to scan the backlog",
    );
  }

  return { ...(issueNumber === undefined ? {} : { issueNumber }), watch };
}

export async function runSandcastleCli<TResult>(
  argv: readonly string[],
  dependencies: SandcastleCliDependencies<TResult>,
): Promise<TResult | undefined> {
  const options = parseCliOptions(argv);
  await dependencies.github.ensureLabel("sandcastle:failed");
  if (options.watch) return;

  const issueNumber = options.issueNumber!;
  const issue = await dependencies.github.getIssue(issueNumber);
  if (issue === null) {
    throw new SandcastleCliError(`Issue #${issueNumber} does not exist`);
  }
  if (issue.state.toUpperCase() !== "OPEN") {
    throw new SandcastleCliError(`Issue #${issueNumber} must be open`);
  }
  if (!issue.labels.includes("Sandcastle")) {
    throw new SandcastleCliError(
      `Issue #${issueNumber} must have the Sandcastle label`,
    );
  }

  const claimed = await dependencies.github.claimIssue(issueNumber);
  if (!claimed) return;

  return dependencies.processIssue(issueNumber);
}
