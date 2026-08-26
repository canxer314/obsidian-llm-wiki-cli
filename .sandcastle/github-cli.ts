import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type {
  ImplementerGithubPort,
  VerifiedPullRequest,
} from "./implementer.ts";

const execFileAsync = promisify(execFile);

type Execute = (
  file: string,
  arguments_: readonly string[],
) => Promise<{ readonly stdout: string; readonly stderr: string }>;

type Wait = (milliseconds: number) => Promise<void>;

const wait: Wait = (milliseconds) => new Promise((resolve) => {
  setTimeout(resolve, milliseconds);
});

const MAX_GITHUB_ATTEMPTS = 3;
const RETRY_DELAYS_MS = [100, 250] as const;
const DEFAULT_RATE_LIMIT_RETRY_DELAY_MILLISECONDS = 60_000;
const now = () => Date.now();

export type GithubReadErrorClassification =
  | { readonly kind: "transient" }
  | { readonly kind: "rate-limited"; readonly retryAfterMilliseconds?: number }
  | { readonly kind: "deterministic" };

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

export class GithubCliPort implements ImplementerGithubPort {
  private readonly run: Execute;
  private readonly wait: Wait;

  constructor(
    execute?: Execute,
    waitForRetry: Wait = wait,
    environment?: Readonly<Record<string, string>>,
  ) {
    this.run = execute ?? (async (file, arguments_) => {
      const result = await execFileAsync(file, [...arguments_], environment === undefined ? {} : { env: environment });
      return { stdout: result.stdout, stderr: result.stderr };
    });
    this.wait = waitForRetry;
  }

  private async execute(
    file: string,
    arguments_: readonly string[],
  ): Promise<{ readonly stdout: string; readonly stderr: string }> {
    if (file === "gh" && isRetrySafeGithubRead(arguments_)) {
      return this.executeWithRetry(arguments_);
    }
    return this.run(file, arguments_);
  }

  private async executeWithRetry(
    arguments_: readonly string[],
  ): Promise<{ readonly stdout: string; readonly stderr: string }> {
    let rateLimitRetried = false;
    let normalAttempts = 0;
    for (;;) {
      try {
        return await this.run("gh", arguments_);
      } catch (error) {
        const classification = classifyGithubReadError(error);
        if (classification.kind === "deterministic") throw error;
        if (classification.kind === "rate-limited") {
          if (rateLimitRetried) throw error;
          rateLimitRetried = true;
          await this.wait(classification.retryAfterMilliseconds ?? DEFAULT_RATE_LIMIT_RETRY_DELAY_MILLISECONDS);
          continue;
        }
        if (normalAttempts === MAX_GITHUB_ATTEMPTS - 1) throw error;
        await this.wait(RETRY_DELAYS_MS[normalAttempts]!);
        normalAttempts += 1;
      }
    }
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
}

function isRetrySafeGithubRead(arguments_: readonly string[]): boolean {
  if (arguments_[0] === "repo") return arguments_[1] === "view";
  if (arguments_[0] === "pr") {
    return arguments_[1] === "view" || arguments_[1] === "list";
  }
  if (arguments_[0] === "issue") {
    return arguments_[1] === "view" || arguments_[1] === "list";
  }
  if (arguments_[0] !== "api") return false;
  if (arguments_[1] === "graphql") return true;
  const methodIndex = arguments_.indexOf("--method");
  return methodIndex === -1 || arguments_[methodIndex + 1]?.toUpperCase() === "GET";
}

export function classifyGithubReadError(error: unknown): GithubReadErrorClassification {
  const message = [
    error instanceof Error ? error.message : "",
    errorStderr(error) ?? "",
  ].join("\n").toLowerCase();
  if (
    /\b429\b/.test(message)
    || /(?:api |secondary )?rate limit exceeded/.test(message)
    || /exceeded a secondary rate limit/.test(message)
  ) {
    return { kind: "rate-limited", ...retryAfterHintMilliseconds(message) };
  }
  if (
    /(?:unexpected )?eof/.test(message) ||
    /(?:connection|network|transport).*(?:reset|refused|closed|timeout|timed out|unavailable)/.test(message) ||
    /(?:tls handshake|i\/o) timeout|context deadline exceeded|client\.timeout exceeded/.test(message) ||
    /(?:http )?(?:500|502|503|504)\b/.test(message) ||
    /service unavailable|bad gateway|gateway timeout/.test(message)
  ) {
    return { kind: "transient" };
  }
  return { kind: "deterministic" };
}

export function isTransientGithubReadError(error: unknown): boolean {
  return classifyGithubReadError(error).kind === "transient";
}

function retryAfterHintMilliseconds(message: string): { readonly retryAfterMilliseconds?: number } {
  const retryAfter = /retry[- ]after\s*[:=]?\s*(\d+)\s*(?:s|sec|seconds)?\b/.exec(message);
  if (retryAfter !== null) return { retryAfterMilliseconds: Math.max(60_000, Number(retryAfter[1]) * 1000) };
  const reset = /x-ratelimit-reset\s*[:=]\s*(\d+)\b/.exec(message);
  if (reset !== null) return { retryAfterMilliseconds: Math.max(60_000, Number(reset[1]) * 1000 - now()) };
  return {};
}

function errorStderr(error: unknown): string | null {
  if (typeof error !== "object" || error === null || !("stderr" in error)) {
    return null;
  }
  return String(error.stderr);
}
