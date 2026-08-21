import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type {
  ClaimBranchFact,
  ClaimIssueFact,
  ClaimPullRequestFact,
  ClaimReconciliationDockerPort,
  ClaimReconciliationGithubPort,
  ClaimReconciliationGitPort,
  ClaimReconciliationInput,
} from "./claim-reconciliation.ts";

const execFileAsync = promisify(execFile);
const MAX_READ_ATTEMPTS = 3;
const MAX_PULL_REQUEST_PAGES = 10;

export interface ReadCommandOptions {
  readonly cwd?: string;
}

export type ReadCommand = (
  file: string,
  arguments_: readonly string[],
  options?: ReadCommandOptions,
) => Promise<{ readonly stdout: string; readonly stderr: string }>;

const executeReadCommand: ReadCommand = async (file, arguments_, options) => {
  const result = await execFileAsync(file, [...arguments_], { ...options, encoding: "utf8" });
  return { stdout: result.stdout, stderr: result.stderr };
};

export class ClaimReadError extends Error {
  readonly source: "github" | "git" | "docker";

  constructor(source: "github" | "git" | "docker") {
    super(`Could not read ${source} claim facts`);
    this.source = source;
    this.name = "ClaimReadError";
  }
}

function parseJson<T>(text: string, source: ClaimReadError["source"]): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new ClaimReadError(source);
  }
}

function isNotFound(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const value = error as { readonly status?: unknown; readonly code?: unknown; readonly stderr?: unknown };
  return value.status === 404 || value.code === 404 ||
    (typeof value.stderr === "string" && /(?:HTTP 404|not found)/iu.test(value.stderr));
}

function isTransient(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const value = error as { readonly code?: unknown; readonly stderr?: unknown; readonly status?: unknown };
  if (value.status === 429 || (typeof value.status === "number" && value.status >= 500)) return true;
  if (typeof value.code === "string" && ["ECONNRESET", "ETIMEDOUT", "EAI_AGAIN"].includes(value.code)) {
    return true;
  }
  return typeof value.stderr === "string" &&
    /(?:HTTP (?:429|5\d\d)|timed? out|connection reset|temporary failure)/iu.test(value.stderr);
}

async function retryRead<T>(source: ClaimReadError["source"], operation: () => Promise<T>): Promise<T> {
  for (let attempt = 1; attempt <= MAX_READ_ATTEMPTS; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (isNotFound(error)) throw error;
      if (!isTransient(error) || attempt === MAX_READ_ATTEMPTS) {
        if (error instanceof ClaimReadError) throw error;
        throw new ClaimReadError(source);
      }
    }
  }
  throw new ClaimReadError(source);
}

interface GithubIssueJson {
  readonly state: unknown;
  readonly labels: unknown;
}

interface GithubPullRequestPage {
  readonly nodes: readonly {
    readonly number: unknown;
    readonly state: unknown;
    readonly headRefOid: unknown;
    readonly closingIssuesReferences: {
      readonly nodes: readonly { readonly number: unknown }[];
    };
  }[];
  readonly pageInfo: {
    readonly hasNextPage: unknown;
    readonly endCursor: unknown;
  };
}

function validSha(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{40}$/u.test(value);
}

export class GithubClaimReadAdapter implements ClaimReconciliationGithubPort {
  private readonly run: ReadCommand;

  constructor(run: ReadCommand = executeReadCommand) {
    this.run = run;
  }

  async getIssue(input: ClaimReconciliationInput): Promise<ClaimIssueFact> {
    try {
      return await retryRead("github", async () => {
        const { stdout } = await this.run("gh", [
          "api",
          `repos/${input.repository}/issues/${input.issueNumber}`,
          "--jq",
          "{state,labels:[.labels[].name]}",
        ]);
        const issue = parseJson<GithubIssueJson>(stdout, "github");
        if ((issue.state !== "open" && issue.state !== "closed") ||
          !Array.isArray(issue.labels) || !issue.labels.every((label) => typeof label === "string")) {
          throw new ClaimReadError("github");
        }
        return {
          existence: "present",
          state: issue.state,
          eligible: issue.state === "open" && issue.labels.includes("Sandcastle"),
        };
      });
    } catch (error) {
      if (isNotFound(error)) return { existence: "absent", state: "unknown", eligible: false };
      throw error;
    }
  }

  async getBranch(input: ClaimReconciliationInput): Promise<ClaimBranchFact> {
    try {
      return await retryRead("github", async () => {
        const { stdout } = await this.run("gh", [
          "api",
          `repos/${input.repository}/git/ref/heads/${encodeURIComponent(input.branch)}`,
          "--jq",
          ".object.sha",
        ]);
        const headSha = stdout.trim();
        if (!validSha(headSha)) throw new ClaimReadError("github");
        return { state: "present", headSha };
      });
    } catch (error) {
      if (isNotFound(error)) return { state: "absent" };
      throw error;
    }
  }

  async listPullRequests(input: ClaimReconciliationInput): Promise<readonly ClaimPullRequestFact[]> {
    const [owner, name, extra] = input.repository.split("/");
    if (owner === undefined || name === undefined || extra !== undefined || owner === "" || name === "") {
      throw new ClaimReadError("github");
    }
    const pullRequests: ClaimPullRequestFact[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < MAX_PULL_REQUEST_PAGES; page += 1) {
      const pageResult: GithubPullRequestPage = await retryRead("github", async () => {
        const { stdout } = await this.run("gh", [
          "api",
          "graphql",
          "-f",
          "query=query($owner:String!,$name:String!,$branch:String!,$cursor:String){repository(owner:$owner,name:$name){pullRequests(first:100,after:$cursor,headRefName:$branch,states:[OPEN,CLOSED,MERGED]){nodes{number,state,headRefOid,closingIssuesReferences(first:100){nodes{number}}}pageInfo{hasNextPage,endCursor}}}}",
          "-F",
          `owner=${owner}`,
          "-F",
          `name=${name}`,
          "-F",
          `branch=${input.branch}`,
          ...(cursor === null ? [] : ["-F", `cursor=${cursor}`]),
          "--jq",
          ".data.repository.pullRequests",
        ]);
        return parseJson<GithubPullRequestPage>(stdout, "github");
      });
      if (!Array.isArray(pageResult.nodes) || typeof pageResult.pageInfo?.hasNextPage !== "boolean") {
        throw new ClaimReadError("github");
      }
      for (const pullRequest of pageResult.nodes) {
        const state = typeof pullRequest.state === "string" ? pullRequest.state.toLowerCase() : "";
        if (!Number.isSafeInteger(pullRequest.number) ||
          (state !== "open" && state !== "closed" && state !== "merged") ||
          !validSha(pullRequest.headRefOid) ||
          !Array.isArray(pullRequest.closingIssuesReferences?.nodes)) {
          throw new ClaimReadError("github");
        }
        pullRequests.push({
          number: pullRequest.number as number,
          state,
          headSha: pullRequest.headRefOid,
          closesIssue: pullRequest.closingIssuesReferences.nodes.some(
            (issue: { readonly number: unknown }) => issue.number === input.issueNumber,
          ),
        });
      }
      if (!pageResult.pageInfo.hasNextPage) return pullRequests;
      if (typeof pageResult.pageInfo.endCursor !== "string" || pageResult.pageInfo.endCursor === "") {
        throw new ClaimReadError("github");
      }
      cursor = pageResult.pageInfo.endCursor;
    }
    throw new ClaimReadError("github");
  }
}

function parseCommitCounts(stdout: string): readonly [number, number] {
  const match = /^(\d+)\s+(\d+)\s*$/u.exec(stdout);
  if (match === null) throw new ClaimReadError("git");
  const behind = Number(match[1]);
  const ahead = Number(match[2]);
  if (!Number.isSafeInteger(behind) || !Number.isSafeInteger(ahead)) {
    throw new ClaimReadError("git");
  }
  return [behind, ahead];
}

interface WorktreeRecord {
  path?: string;
  branch?: string;
}

function worktreeRecords(output: string): readonly WorktreeRecord[] {
  return output.trim().split(/\n\n+/u).flatMap((block) => {
    if (block === "") return [];
    const record: { path?: string; branch?: string } = {};
    for (const line of block.split("\n")) {
      if (line.startsWith("worktree ")) record.path = line.slice("worktree ".length);
      if (line.startsWith("branch ")) record.branch = line.slice("branch ".length);
    }
    return [record];
  });
}

export class GitClaimReadAdapter implements ClaimReconciliationGitPort {
  private readonly repositoryPath: string;
  private readonly run: ReadCommand;

  constructor(
    repositoryPath: string,
    run: ReadCommand = executeReadCommand,
  ) {
    this.repositoryPath = repositoryPath;
    this.run = run;
  }

  private async commitCounts(input: ClaimReconciliationInput & { readonly branchHeadSha: string }) {
    return retryRead("git", async () => {
      const { stdout } = await this.run("git", [
        "rev-list",
        "--left-right",
        "--count",
        `${input.comparisonBaseSha}...${input.branchHeadSha}`,
      ], { cwd: this.repositoryPath });
      return parseCommitCounts(stdout);
    });
  }

  async compareCommits(input: ClaimReconciliationInput & { readonly branchHeadSha: string }) {
    const [behind, ahead] = await this.commitCounts(input);
    if (behind === 0 && ahead === 0) return "equal" as const;
    if (behind === 0) return "ahead" as const;
    if (ahead === 0) return "behind" as const;
    return "diverged" as const;
  }

  async countUniqueCommits(input: ClaimReconciliationInput & { readonly branchHeadSha: string }) {
    const [, ahead] = await this.commitCounts(input);
    return ahead;
  }

  async getWorktree(input: ClaimReconciliationInput) {
    return retryRead("git", async () => {
      const { stdout } = await this.run("git", ["worktree", "list", "--porcelain"], {
        cwd: this.repositoryPath,
      });
      const matches = worktreeRecords(stdout).filter(
        (record) => record.branch === `refs/heads/${input.branch}`,
      );
      if (matches.length === 0) return "absent" as const;
      if (matches.length !== 1 || matches[0]!.path === undefined) throw new ClaimReadError("git");
      const status = await this.run("git", ["status", "--porcelain", "--untracked-files=normal"], {
        cwd: matches[0]!.path,
      });
      return status.stdout === "" ? "clean" as const : "dirty" as const;
    });
  }
}

export class ClaimResourceReleaseError extends Error {
  constructor() {
    super("Claim resource changed before release");
    this.name = "ClaimResourceReleaseError";
  }
}

export class ClaimResourceReleaseAdapter {
  private readonly repositoryPath: string;
  private readonly run: ReadCommand;

  constructor(repositoryPath: string, run: ReadCommand = executeReadCommand) {
    this.repositoryPath = repositoryPath;
    this.run = run;
  }

  private containerFilters(input: ClaimReconciliationInput): readonly string[] {
    return [
      `label=com.sandcastle.repository=${input.repository}`,
      `label=com.sandcastle.issue=${input.issueNumber}`,
      `label=com.sandcastle.branch=${input.branch}`,
    ];
  }

  async removeStoppedContainer(input: ClaimReconciliationInput): Promise<void> {
    const { stdout } = await this.run("docker", [
      "container",
      "ls",
      "--all",
      ...this.containerFilters(input).flatMap((filter) => ["--filter", filter]),
      "--format",
      "{{json .ID}}",
    ]);
    const ids = stdout.trim() === "" ? [] : stdout.trim().split("\n").map((line) =>
      parseJson<unknown>(line, "docker")
    );
    if (ids.length !== 1 || typeof ids[0] !== "string" || !/^[0-9a-f]{12,64}$/u.test(ids[0])) {
      throw new ClaimResourceReleaseError();
    }
    const id = ids[0];
    const { stdout: runningOutput } = await this.run("docker", [
      "container",
      "inspect",
      "--format",
      "{{json .State.Running}}",
      id,
    ]);
    if (parseJson<unknown>(runningOutput.trim(), "docker") !== false) {
      throw new ClaimResourceReleaseError();
    }
    await this.run("docker", ["container", "rm", id]);
  }

  async compareAndDeleteLocalBranch(input: ClaimReconciliationInput & {
    readonly expectedHeadSha: string;
  }): Promise<void> {
    await this.run("git", [
      "update-ref",
      "-d",
      `refs/heads/${input.branch}`,
      input.expectedHeadSha,
    ], { cwd: this.repositoryPath });
  }

  async removeCleanWorktree(input: ClaimReconciliationInput): Promise<void> {
    const { stdout } = await this.run("git", ["worktree", "list", "--porcelain"], {
      cwd: this.repositoryPath,
    });
    const matches = worktreeRecords(stdout).filter(
      (record) => record.branch === `refs/heads/${input.branch}`,
    );
    if (matches.length !== 1 || matches[0]!.path === undefined) {
      throw new ClaimResourceReleaseError();
    }
    const path = matches[0]!.path;
    const status = await this.run("git", ["status", "--porcelain", "--untracked-files=normal"], {
      cwd: path,
    });
    if (status.stdout !== "") throw new ClaimResourceReleaseError();
    await this.run("git", ["worktree", "remove", path], { cwd: this.repositoryPath });
  }
}

export class DockerClaimReadAdapter implements ClaimReconciliationDockerPort {
  private readonly run: ReadCommand;

  constructor(run: ReadCommand = executeReadCommand) {
    this.run = run;
  }

  async getContainer(input: ClaimReconciliationInput) {
    return retryRead("docker", async () => {
      const filters = [
        `label=com.sandcastle.repository=${input.repository}`,
        `label=com.sandcastle.issue=${input.issueNumber}`,
        `label=com.sandcastle.branch=${input.branch}`,
      ];
      const { stdout } = await this.run("docker", [
        "container",
        "ls",
        "--all",
        ...filters.flatMap((filter) => ["--filter", filter]),
        "--format",
        "{{json .ID}}",
      ]);
      const ids = stdout.trim() === "" ? [] : stdout.trim().split("\n").map((line) =>
        parseJson<unknown>(line, "docker")
      );
      if (!ids.every((id): id is string => typeof id === "string" && /^[0-9a-f]{12,64}$/u.test(id))) {
        throw new ClaimReadError("docker");
      }
      if (ids.length > 1) throw new ClaimReadError("docker");
      if (ids.length === 0) {
        const { stdout: unownedOutput } = await this.run("docker", [
          "container",
          "ls",
          "--all",
          "--filter",
          "name=^sandcastle-",
          "--format",
          "{{json .ID}}",
        ]);
        if (unownedOutput.trim() !== "") throw new ClaimReadError("docker");
        return "absent" as const;
      }
      const { stdout: inspectOutput } = await this.run("docker", [
        "container",
        "inspect",
        "--format",
        "{{json .State.Running}}",
        ...ids,
      ]);
      const runningStates = inspectOutput.trim().split("\n").map((line) =>
        parseJson<unknown>(line, "docker")
      );
      if (runningStates.length !== ids.length ||
        !runningStates.every((running): running is boolean => typeof running === "boolean")) {
        throw new ClaimReadError("docker");
      }
      return runningStates.some(Boolean) ? "active" as const : "present" as const;
    });
  }
}
