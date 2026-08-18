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
  listCandidateIssues(): Promise<readonly SandcastleIssue[]>;
  claimIssue(number: number): Promise<boolean>;
}

export interface SandcastleCliDependencies<TResult = unknown> {
  readonly github: SandcastleGithubPort;
  readonly processIssue: (issueNumber: number) => Promise<TResult>;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly handleFailure?: (
    issueNumber: number,
    stage: "claim",
    error: unknown,
  ) => Promise<void>;
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

const WATCH_INTERVAL_MS = 300_000;
const MAX_ACTIVE_ISSUES = 2;

async function runIssue<TResult>(
  issueNumber: number,
  dependencies: SandcastleCliDependencies<TResult>,
): Promise<TResult | undefined> {
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

  let claimed: boolean;
  try {
    claimed = await dependencies.github.claimIssue(issueNumber);
  } catch (error) {
    await dependencies.handleFailure?.(issueNumber, "claim", error);
    throw error;
  }
  if (!claimed) return;

  return dependencies.processIssue(issueNumber);
}

export async function runSandcastleCli<TResult>(
  argv: readonly string[],
  dependencies: SandcastleCliDependencies<TResult>,
): Promise<TResult | undefined> {
  const options = parseCliOptions(argv);
  await dependencies.github.ensureLabel("sandcastle:failed");
  if (options.watch) {
    const sleep = dependencies.sleep ?? ((milliseconds: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
    const active = new Map<number, Promise<unknown>>();
    for (;;) {
      let candidates: readonly SandcastleIssue[] = [];
      try {
        candidates = await dependencies.github.listCandidateIssues();
      } catch {
        // A later polling tick retries transient discovery failures.
      }
      for (const issue of candidates) {
        if (active.size >= MAX_ACTIVE_ISSUES) break;
        if (active.has(issue.number) || issue.labels.includes("sandcastle:failed")) continue;
        const workflow = runIssue(issue.number, dependencies)
          .catch(() => undefined)
          .finally(() => active.delete(issue.number));
        active.set(issue.number, workflow);
      }
      await sleep(WATCH_INTERVAL_MS);
    }
  }

  return runIssue(options.issueNumber!, dependencies);
}
