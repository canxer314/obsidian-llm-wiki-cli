import { redact } from "./redaction.ts";

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

export const redactFailureSummary = redact;

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
  const comment = context.pullRequestNumber === undefined
    ? github.addIssueComment(context.issueNumber, failureComment(context))
    : github.addPullRequestComment(context.pullRequestNumber, failureComment(context));
  try {
    await comment;
  } catch (error) {
    failures.push(`comment: ${errorMessage(error)}`);
  }

  let failureLabelAdded = false;
  try {
    await github.addIssueLabel(context.issueNumber, "sandcastle:failed");
    failureLabelAdded = true;
  } catch (error) {
    failures.push(`add-label: ${errorMessage(error)}`);
  }

  if (failureLabelAdded) {
    try {
      await github.removeIssueLabel(context.issueNumber, "Sandcastle");
    } catch (error) {
      failures.push(`remove-label: ${errorMessage(error)}`);
    }
  }
  return { failures };
}
