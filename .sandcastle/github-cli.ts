import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { SandcastleGithubPort, SandcastleIssue } from "./cli.ts";
import type {
  ImplementerGithubPort,
  VerifiedPullRequest,
} from "./implementer.ts";
import type {
  LocalQualityCommitStatus,
  LocalQualityGithubPort,
} from "./local-quality.ts";

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

interface GhRepository {
  readonly nameWithOwner: string;
  readonly defaultBranchRef: { readonly name: string };
}

interface GhPullRequest {
  readonly number: number;
  readonly url: string;
  readonly state: string;
  readonly isDraft: boolean;
  readonly baseRefName: string;
  readonly headRefName: string;
  readonly headRefOid: string;
  readonly body: string;
}

interface GhChangedFile {
  readonly filename: string;
  readonly previousFilename?: string;
}

function decodeChangedFiles(output: string): GhChangedFile[] {
  return output.split("\n").filter((line) => line.length > 0).map((line) => {
    const [filename, previousFilename] = JSON.parse(
      Buffer.from(line, "base64").toString("utf8"),
    ) as [string, string];
    return {
      filename,
      ...(previousFilename.length === 0 ? {} : { previousFilename }),
    };
  });
}

export class GithubVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GithubVerificationError";
  }
}

const closingRelationship = (issueNumber: number): RegExp =>
  new RegExp(`(?:^|\\s)closes\\s+#${issueNumber}(?=\\s|$|[.,;:!?])`, "i");

const isAutomationPath = (path: string): boolean =>
  path === ".sandcastle" ||
  path.startsWith(".sandcastle/") ||
  path === ".github/workflows" ||
  path.startsWith(".github/workflows/");

export class GithubCliPort implements
  SandcastleGithubPort,
  ImplementerGithubPort,
  LocalQualityGithubPort {
  private readonly execute: Execute;

  constructor(execute: Execute = executeFile) {
    this.execute = execute;
  }

  async getPullRequestHead(pullRequestNumber: number): Promise<string> {
    const { stdout } = await this.execute("gh", [
      "pr",
      "view",
      String(pullRequestNumber),
      "--json",
      "headRefOid",
      "--jq",
      ".headRefOid",
    ]);
    return stdout.trim();
  }

  async publishCommitStatus(status: LocalQualityCommitStatus): Promise<void> {
    await this.execute("gh", [
      "api",
      `repos/{owner}/{repo}/statuses/${status.revision}`,
      "--method",
      "POST",
      "-f",
      `context=${status.context}`,
      "-f",
      `state=${status.state}`,
      "-f",
      `description=${status.description}`,
    ]);
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
      await this.execute("git", [
        "fetch",
        "--no-tags",
        "origin",
        `refs/heads/${branch}:refs/remotes/origin/${branch}`,
      ]);
      await this.execute("git", ["branch", "--force", branch, `origin/${branch}`]);
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

  async verifyImplementation(request: {
    readonly issueNumber: number;
    readonly branch: string;
    readonly expectedHeadSha: string;
    readonly allowsAutomationChanges: boolean;
  }): Promise<VerifiedPullRequest> {
    const { stdout: repositoryOutput } = await this.execute("gh", [
      "repo",
      "view",
      "--json",
      "nameWithOwner,defaultBranchRef",
    ]);
    const repository = JSON.parse(repositoryOutput) as GhRepository;
    const defaultBranch = repository.defaultBranchRef.name;
    const { stdout: pullRequestsOutput } = await this.execute("gh", [
      "pr",
      "list",
      "--head",
      request.branch,
      "--state",
      "all",
      "--json",
      "number,url,state,isDraft,baseRefName,headRefName,headRefOid,body",
      "--limit",
      "2",
    ]);
    const pullRequests = JSON.parse(pullRequestsOutput) as readonly GhPullRequest[];
    if (pullRequests.length !== 1) {
      throw new GithubVerificationError(
        `Expected one Pull Request for ${request.branch}; found ${pullRequests.length}`,
      );
    }
    const pullRequest = pullRequests[0]!;
    if (pullRequest.state.toUpperCase() !== "OPEN") {
      throw new GithubVerificationError(`Pull Request #${pullRequest.number} is not open`);
    }
    if (!pullRequest.isDraft) {
      throw new GithubVerificationError(`Pull Request #${pullRequest.number} is not a Draft`);
    }
    if (pullRequest.baseRefName !== defaultBranch) {
      throw new GithubVerificationError(
        `Pull Request #${pullRequest.number} targets ${pullRequest.baseRefName}; expected ${defaultBranch}`,
      );
    }
    if (pullRequest.headRefName !== request.branch) {
      throw new GithubVerificationError(
        `Pull Request #${pullRequest.number} uses ${pullRequest.headRefName}; expected ${request.branch}`,
      );
    }
    if (!closingRelationship(request.issueNumber).test(pullRequest.body)) {
      throw new GithubVerificationError(
        `Pull Request #${pullRequest.number} does not contain Closes #${request.issueNumber}`,
      );
    }
    const [owner, name] = repository.nameWithOwner.split("/");
    if (owner === undefined || name === undefined) {
      throw new GithubVerificationError("GitHub repository identity is invalid");
    }
    const { stdout: closingIssuesOutput } = await this.execute("gh", [
      "api",
      "graphql",
      "-f",
      `query=query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){closingIssuesReferences(first:100){nodes{number}}}}}`,
      "-F",
      `owner=${owner}`,
      "-F",
      `name=${name}`,
      "-F",
      `number=${pullRequest.number}`,
      "--jq",
      ".data.repository.pullRequest.closingIssuesReferences.nodes[].number",
    ]);
    const closingIssueNumbers = closingIssuesOutput
      .split("\n")
      .filter((number) => number.length > 0)
      .map(Number);
    if (!closingIssueNumbers.includes(request.issueNumber)) {
      throw new GithubVerificationError(
        `Pull Request #${pullRequest.number} does not close Issue #${request.issueNumber}`,
      );
    }
    if (pullRequest.headRefOid !== request.expectedHeadSha) {
      throw new GithubVerificationError(
        `Pull Request #${pullRequest.number} head does not match the Implementer commit`,
      );
    }

    const { stdout: remoteHeadOutput } = await this.execute("gh", [
      "api",
      `repos/{owner}/{repo}/git/ref/heads/${request.branch}`,
      "--jq",
      ".object.sha",
    ]);
    const remoteHeadSha = remoteHeadOutput.trim();
    if (remoteHeadSha !== request.expectedHeadSha) {
      throw new GithubVerificationError(
        `Remote branch ${request.branch} does not match the Implementer commit`,
      );
    }

    const { stdout: filesOutput } = await this.execute("gh", [
      "api",
      "--paginate",
      `repos/{owner}/{repo}/pulls/${pullRequest.number}/files`,
      "--jq",
      ".[] | [.filename, (.previous_filename // \"\")] | @base64",
    ]);
    const files = decodeChangedFiles(filesOutput);
    if (!request.allowsAutomationChanges) {
      const automationPath = files
        .flatMap((file) => [file.filename, file.previousFilename])
        .find((path) => path !== undefined && isAutomationPath(path));
      if (automationPath !== undefined) {
        throw new GithubVerificationError(
          `Issue #${request.issueNumber} does not allow automation change ${automationPath}`,
        );
      }
    }

    return {
      number: pullRequest.number,
      url: pullRequest.url,
      headSha: remoteHeadSha,
    };
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
