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

function isMissingIssueError(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("stderr" in error)) {
    return false;
  }
  const stderr = String(error.stderr);
  return (
    stderr.includes("Could not resolve to an Issue") ||
    stderr.includes("HTTP 404")
  );
}
