import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  synchronizationStagingRef,
  type ManagedPullRequestContinuationPorts,
} from "./managed-pr-continuation.js";
import type {
  ManagedPullRequestRecoveryPorts,
  RecoveryPullRequestCandidate,
} from "./managed-pr-recovery.js";
import {
  envelopeComment,
  type ManagedImplementationPorts,
  type ManagedPullRequestRecord,
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

function parseJsonLines<Value>(raw: string): Value[] {
  return raw.length === 0
    ? []
    : raw.split("\n").filter(Boolean).map((line) => JSON.parse(line) as Value);
}

interface GhRecoveryPullRequest extends GhPullRequest {
  state: "OPEN" | "CLOSED" | "MERGED";
  headRepository: { nameWithOwner: string } | null;
  baseRefOid: string;
  mergeable: "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
  statusCheckRollup: Array<{ status?: string; conclusion?: string }>;
  closingIssuesReferences: Array<{ number: number }>;
}

export function createGitHubContinuationEffects(input: {
  repository: string;
  trustedActor: { login: string; type: "Bot" | "App" };
  command?: Command;
}): Pick<
  ManagedPullRequestContinuationPorts,
  "recordControlComment" | "recordNeedsHuman" | "createFollowUpIssue" | "recordMergeReport" | "mergeExactRevision"
> {
  const command = input.command ?? defaultCommand;
  async function recordExists(prNumber: number, idempotencyKey: string): Promise<boolean> {
    const raw = await command("gh", [
      "api", `repos/${input.repository}/issues/${prNumber}/comments`, "--paginate",
      "--jq", ".[] | {body: .body, author: {login: .user.login, type: .user.type}}",
    ]);
    const comments = parseJsonLines<GhComment>(raw);
    const marker = `<!-- afk-effect:${idempotencyKey} -->`;
    return comments.some((comment) =>
      comment.author.login === input.trustedActor.login &&
      comment.author.type === input.trustedActor.type &&
      comment.body.includes(marker),
    );
  }
  async function post(prNumber: number, body: string): Promise<void> {
    await command("gh", [
      "pr", "comment", String(prNumber), "--repo", input.repository, "--body", body,
    ]);
  }
  return {
    async createFollowUpIssue(record) {
      const marker = `<!-- afk-effect:${record.idempotencyKey} -->`;
      const sourceTicket = `Source Delivery Ticket: #${record.ticketNumber}`;
      const sourcePr = `Source Managed PR: #${record.prNumber}`;
      const raw = await command("gh", [
        "api", `repos/${input.repository}/issues?state=all&per_page=100`, "--paginate",
        "--jq", ".[] | {number, html_url, body, user: {login: .user.login, type: .user.type}}",
      ]);
      const existing = parseJsonLines<{
        number: number;
        html_url: string;
        body: string;
        user: { login: string; type: "Bot" | "App" | "User" };
      }>(raw).find((issue) =>
        issue.user.login === input.trustedActor.login && issue.user.type === input.trustedActor.type &&
        issue.body.includes(marker) && issue.body.includes(sourceTicket) && issue.body.includes(sourcePr)
      );
      if (existing !== undefined) {
        return { number: existing.number, url: existing.html_url, created: false };
      }
      const title = record.observation.replace(/^F-[1-9]\d*:\s*/u, "").slice(0, 120);
      const body = [marker, record.observation, "", sourceTicket, sourcePr, "",
        "This follow-up is intentionally not authorized for AFK Delivery."].join("\n");
      const url = await command("gh", [
        "issue", "create", "--repo", input.repository, "--title", title, "--body", body,
      ]);
      const match = /\/issues\/(\d+)\/?$/u.exec(url.trim());
      if (match?.[1] === undefined) throw new Error("GitHub did not return the follow-up issue number");
      return { number: Number(match[1]), url: url.trim(), created: true };
    },
    async recordMergeReport(record) {
      if (await recordExists(record.prNumber, record.idempotencyKey)) return { created: false };
      const marker = `<!-- afk-effect:${record.idempotencyKey} -->`;
      await post(record.prNumber, [
        marker,
        envelopeComment(record.envelope as Parameters<typeof envelopeComment>[0], record.narrative),
      ].join("\n"));
      return { created: true };
    },
    async mergeExactRevision(record) {
      const raw = await command("gh", [
        "pr", "view", String(record.prNumber), "--repo", input.repository,
        "--json", "state,headRefOid,mergedAt",
      ]);
      const pr = JSON.parse(raw) as {
        state: "OPEN" | "CLOSED" | "MERGED";
        headRefOid: string;
        mergedAt: string | null;
      };
      if (pr.state === "MERGED" && pr.mergedAt !== null) return { merged: false };
      if (pr.state !== "OPEN" || pr.headRefOid !== record.exactRevision) {
        throw new Error("GitHub PR is not open at the proven exact Revision");
      }
      if (!await record.authorize()) return { merged: false, authorizationFailed: true };
      const strategy = {
        merge: "--merge",
        squash: "--squash",
        rebase: "--rebase",
      }[record.strategy];
      await command("gh", [
        "pr", "merge", String(record.prNumber), "--repo", input.repository,
        strategy, "--match-head-commit", record.exactRevision,
      ]);
      return { merged: true };
    },
    async recordControlComment(record) {
      if (await recordExists(record.prNumber, record.idempotencyKey)) return { created: false };
      const marker = `<!-- afk-effect:${record.idempotencyKey} -->`;
      await post(record.prNumber, [
        marker,
        envelopeComment(record.envelope as Parameters<typeof envelopeComment>[0], record.narrative ?? ""),
      ].join("\n"));
      return { created: true };
    },
    async recordNeedsHuman(record) {
      const subjectNumber = record.prNumber ?? record.ticketNumber;
      if (await recordExists(subjectNumber, record.idempotencyKey)) return { created: false };
      const evidence = [
        "",
        "Evidence:",
        ...record.evidenceLinks.map((link) => `- ${link}`),
      ];
      const body = record.envelope === undefined
        ? [
            `<!-- afk-effect:${record.idempotencyKey} -->`,
            `AFK Delivery needs human intervention for Delivery Ticket #${record.ticketNumber}.`,
            "",
            record.reason,
            ...evidence,
          ].join("\n")
        : [
            `<!-- afk-effect:${record.idempotencyKey} -->`,
            envelopeComment(record.envelope as Parameters<typeof envelopeComment>[0], record.reason),
            ...evidence,
          ].join("\n");
      if (record.prNumber === undefined) {
        await command("gh", [
          "issue", "comment", String(record.ticketNumber), "--repo", input.repository, "--body", body,
        ]);
      } else {
        await post(record.prNumber, body);
      }
      return { created: true };
    },
  };
}

export function createGitHubManagedPullRequestRecoveryPorts(input: {
  repository: string;
  command?: Command;
}): ManagedPullRequestRecoveryPorts {
  const command = input.command ?? defaultCommand;
  return {
    async readSynchronizationStaging(staging) {
      const ref = synchronizationStagingRef({
        prNumber: staging.prNumber,
        expectedHeadRevision: staging.inputRevision,
        targetRevision: staging.targetRevision,
      }).replace(/^refs\//u, "");
      let revision: string;
      try {
        revision = await command("gh", [
          "api", `repos/${input.repository}/git/ref/${ref}`, "--jq", ".object.sha",
        ]);
      } catch {
        return undefined;
      }
      const raw = await command("gh", [
        "api", `repos/${input.repository}/git/commits/${revision}`,
        "--jq", "{parents: [.parents[].sha]}",
      ]);
      const commit = JSON.parse(raw) as { parents: string[] };
      return { revision, parents: commit.parents };
    },
    async listOpenPullRequests(limit) {
      const raw = await command("gh", [
        "pr", "list", "--repo", input.repository, "--state", "open",
        "--limit", String(limit + 1), "--json", "number",
      ]);
      const references = JSON.parse(raw || "[]") as Array<{ number: number }>;
      const candidates: RecoveryPullRequestCandidate[] = [];
      for (const reference of references) {
        const detailRaw = await command("gh", [
          "pr", "view", String(reference.number), "--repo", input.repository,
          "--json", [
            "number", "state", "headRefName", "headRefOid", "headRepository",
            "baseRefName", "baseRefOid", "body", "mergeable", "statusCheckRollup",
            "closingIssuesReferences",
          ].join(","),
        ]);
        const detail = JSON.parse(detailRaw) as GhRecoveryPullRequest;
        const diff = await command("gh", [
          "pr", "diff", String(detail.number), "--repo", input.repository,
        ]);
        if (!diff.startsWith("diff --git ")) {
          throw new Error(`GitHub did not provide a complete textual diff for PR #${detail.number}`);
        }
        const baseRevision = await command("gh", [
          "api", `repos/${input.repository}/compare/${detail.baseRefOid}...${detail.headRefOid}`,
          "--jq", ".merge_base_commit.sha",
        ]);
        const commentsRaw = await command("gh", [
          "api", `repos/${input.repository}/issues/${detail.number}/comments`, "--paginate",
          "--jq", ".[] | {body: .body, author: {login: .user.login, type: .user.type}}",
        ]);
        const comments = parseJsonLines<GhComment>(commentsRaw);
        const commitRaw = await command("gh", [
          "api", `repos/${input.repository}/git/commits/${detail.headRefOid}`,
          "--jq", "{parents: [.parents[].sha], message: .message, author: {name: .author.name, email: .author.email}}",
        ]);
        const commit = JSON.parse(commitRaw) as {
          parents: string[];
          message: string;
          author: { name: string; email: string };
        };
        candidates.push({
          repository: input.repository,
          headRepository: detail.headRepository?.nameWithOwner ?? "",
          open: detail.state === "OPEN",
          ticketNumbers: detail.closingIssuesReferences.map((ticket) => ticket.number),
          number: detail.number,
          headRevision: detail.headRefOid,
          headBranch: detail.headRefName,
          baseBranch: detail.baseRefName,
          baseRevision,
          mergeable: detail.mergeable === "MERGEABLE" ? true
            : detail.mergeable === "CONFLICTING" ? false : "unknown",
          requiredChecksPass: detail.statusCheckRollup.length > 0 &&
            detail.statusCheckRollup.every((check) => check.status === "COMPLETED" && check.conclusion === "SUCCESS"),
          headParents: commit.parents,
          headMessage: commit.message,
          headAuthor: commit.author,
          diff,
          body: detail.body,
          comments,
        });
      }
      return candidates;
    },
  };
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
    return parseJsonLines<GhComment>(raw);
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
