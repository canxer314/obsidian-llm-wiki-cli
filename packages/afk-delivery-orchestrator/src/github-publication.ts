import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type {
  ManagedImplementationPorts,
  ManagedPullRequestRecord,
} from "./managed-pr.js";

const execFileAsync = promisify(execFile);

type Command = (file: string, args: string[]) => Promise<string>;

async function defaultCommand(file: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(file, args, { timeout: 120_000, maxBuffer: 10 * 1024 * 1024 });
  return stdout.trim();
}

interface GhPullRequest {
  number: number;
  headRefName: string;
  baseRefName: string;
  headRefOid: string;
  body: string;
}

interface GhComment {
  body: string;
  author: { login: string; type: "Bot" | "App" | "User" };
}

export function createGitHubManagedImplementationPorts(input: {
  repositoryPath: string;
  repository: string;
  command?: Command;
}): ManagedImplementationPorts {
  const command = input.command ?? defaultCommand;

  async function comments(prNumber: number): Promise<ManagedPullRequestRecord["comments"]> {
    const raw = await command("gh", [
      "api", `repos/${input.repository}/issues/${prNumber}/comments`, "--paginate",
      "--jq", ".[] | {body: .body, author: {login: .user.login, type: .user.type}}",
    ]);
    if (raw.length === 0) return [];
    return raw.split("\n").map((line) => {
      const parsed = JSON.parse(line) as GhComment;
      return {
        author: parsed.author,
        body: parsed.body,
      };
    });
  }

  async function toRecord(pr: GhPullRequest): Promise<ManagedPullRequestRecord> {
    return {
      number: pr.number,
      headRevision: pr.headRefOid,
      headBranch: pr.headRefName,
      baseBranch: pr.baseRefName,
      body: pr.body,
      comments: await comments(pr.number),
    };
  }

  return {
    async findRemoteBranchRevision(branch) {
      return await command("git", [
        "-C", input.repositoryPath, "ls-remote", "--heads", "origin", `refs/heads/${branch}`,
      ]).then((value) => value.split(/\s+/u)[0] || undefined);
    },
    async ensureRemoteBranch(branch, exactRevision) {
      const remoteRevision = await this.findRemoteBranchRevision(branch);
      if (remoteRevision === exactRevision) return;
      if (remoteRevision !== undefined) {
        throw new Error(`remote implementation branch ${branch} points at a different Revision`);
      }
      await command("git", [
        "-C", input.repositoryPath, "push", "origin", `${exactRevision}:refs/heads/${branch}`,
      ]);
    },
    async findOpenPullRequests(ticketNumber, _branch, targetBranch) {
      const raw = await command("gh", [
        "pr", "list", "--repo", input.repository, "--state", "open",
        "--base", targetBranch, "--limit", "100",
        "--json", "number,headRefName,baseRefName,headRefOid,body",
      ]);
      const pullRequests = (JSON.parse(raw || "[]") as GhPullRequest[])
        .filter((pr) => new RegExp(`(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\\s+#${ticketNumber}\\b`, "iu").test(pr.body));
      return Promise.all(pullRequests.map(toRecord));
    },
    async createPullRequest(pr) {
      const url = await command("gh", [
        "pr", "create", "--repo", input.repository,
        "--head", pr.headBranch, "--base", pr.baseBranch,
        "--title", pr.title, "--body", pr.body,
      ]);
      const match = /\/pull\/(\d+)\/?$/u.exec(url);
      if (match?.[1] === undefined) throw new Error("GitHub did not return the created PR number");
      const raw = await command("gh", [
        "pr", "view", match[1], "--repo", input.repository,
        "--json", "number,headRefName,baseRefName,headRefOid,body",
      ]);
      return toRecord(JSON.parse(raw) as GhPullRequest);
    },
    async postComment(prNumber, body) {
      await command("gh", [
        "pr", "comment", String(prNumber), "--repo", input.repository, "--body", body,
      ]);
    },
  };
}
