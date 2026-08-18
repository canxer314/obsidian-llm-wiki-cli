import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { SandcastleGithubPort, SandcastleIssue } from "./cli.ts";

const execFileAsync = promisify(execFile);

type Execute = (
  file: string,
  arguments_: readonly string[],
) => Promise<{ readonly stdout: string; readonly stderr: string }>;

const executeFile: Execute = async (file, arguments_) => {
  const result = await execFileAsync(file, [...arguments_]);
  return { stdout: result.stdout, stderr: result.stderr };
};

interface GhIssue {
  readonly number: number;
  readonly state: string;
  readonly labels: readonly { readonly name: string }[];
}

export class GithubCliPort implements SandcastleGithubPort {
  private readonly execute: Execute;

  constructor(execute: Execute = executeFile) {
    this.execute = execute;
  }

  async claimIssue(number: number): Promise<boolean> {
    const branch = `sandcastle/issue-${number}`;
    const { stdout: pullRequests } = await this.execute("gh", [
      "pr",
      "list",
      "--head",
      branch,
      "--state",
      "all",
      "--json",
      "number",
      "--limit",
      "1",
    ]);
    if ((JSON.parse(pullRequests) as readonly unknown[]).length > 0) return false;

    const { stdout: defaultBranchOid } = await this.execute("gh", [
      "api",
      "repos/{owner}/{repo}/commits/HEAD",
      "--jq",
      ".sha",
    ]);
    try {
      await this.execute("gh", [
        "api",
        "repos/{owner}/{repo}/git/refs",
        "--method",
        "POST",
        "-f",
        `ref=refs/heads/${branch}`,
        "-f",
        `sha=${defaultBranchOid.trim()}`,
      ]);
    } catch (error) {
      if (isExistingReferenceError(error)) return false;
      throw error;
    }
    return true;
  }

  async ensureLabel(name: string): Promise<void> {
    await this.execute("gh", [
      "label",
      "create",
      name,
      "--color",
      "B60205",
      "--description",
      "Sandcastle automation could not complete this Issue",
      "--force",
    ]);
  }

  async getIssue(number: number): Promise<SandcastleIssue | null> {
    try {
      const { stdout } = await this.execute("gh", [
        "issue",
        "view",
        String(number),
        "--json",
        "number,state,labels",
      ]);
      const issue = JSON.parse(stdout) as GhIssue;
      return {
        number: issue.number,
        state: issue.state,
        labels: issue.labels.map((label) => label.name),
      };
    } catch (error) {
      if (isMissingIssueError(error)) return null;
      throw error;
    }
  }
}

function errorStderr(error: unknown): string | null {
  if (typeof error !== "object" || error === null || !("stderr" in error)) {
    return null;
  }
  return String(error.stderr);
}

function isExistingReferenceError(error: unknown): boolean {
  return errorStderr(error)?.includes("Reference already exists") ?? false;
}

function isMissingIssueError(error: unknown): boolean {
  const stderr = errorStderr(error);
  if (stderr === null) return false;
  return (
    stderr.includes("Could not resolve to an Issue") ||
    stderr.includes("HTTP 404")
  );
}
