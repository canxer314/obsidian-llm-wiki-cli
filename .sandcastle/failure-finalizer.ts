const MAX_SUMMARY_LENGTH = 20_000;

export interface FailureContext {
  readonly issueNumber: number;
  readonly pullRequestNumber?: number;
  readonly stage: string;
  readonly revision?: string;
  readonly summary: string;
}

export interface FailureGithubPort {
  addIssueComment(issueNumber: number, body: string): Promise<void>;
  addPullRequestComment(pullRequestNumber: number, body: string): Promise<void>;
  removeIssueLabel(issueNumber: number, label: string): Promise<void>;
  addIssueLabel(issueNumber: number, label: string): Promise<void>;
}

export interface FailureFinalizationResult {
  readonly failures: readonly string[];
}

export function redactFailureSummary(text: string): string {
  return text
    .replace(
      /\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|sk-ant-[A-Za-z0-9_-]{20,}|AKIA[A-Z0-9]{16})\b/gu,
      "[REDACTED]",
    )
    .replace(
      /((?:token|password|secret|api[_-]?key|authorization)\s*[:=]\s*)([^\s,;]+)/giu,
      "$1[REDACTED]",
    )
    .slice(0, MAX_SUMMARY_LENGTH);
}

function failureComment(context: FailureContext): string {
  const lines = [
    "## Sandcastle could not complete this Issue",
    "",
    `- Failure stage: \`${context.stage}\``,
  ];
  if (context.revision !== undefined) {
    lines.push(`- Related SHA: \`${context.revision}\``);
  }
  lines.push("", "### Key output", "", "```text", redactFailureSummary(context.summary), "```");
  return lines.join("\n");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function finalizeFailure(
  context: FailureContext,
  github: FailureGithubPort,
): Promise<FailureFinalizationResult> {
  const failures: string[] = [];
  const operations: readonly [string, () => Promise<void>][] = [
    ["comment", () => context.pullRequestNumber === undefined
      ? github.addIssueComment(context.issueNumber, failureComment(context))
      : github.addPullRequestComment(context.pullRequestNumber, failureComment(context))],
    ["remove-label", () => github.removeIssueLabel(context.issueNumber, "Sandcastle")],
    ["add-label", () => github.addIssueLabel(context.issueNumber, "sandcastle:failed")],
  ];

  for (const [name, operation] of operations) {
    try {
      await operation();
    } catch (error) {
      failures.push(`${name}: ${errorMessage(error)}`);
    }
  }
  return { failures };
}
