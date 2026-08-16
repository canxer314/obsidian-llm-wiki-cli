import type { ControlEnvelope } from "@llm-wiki/afk-delivery-core";
import { describe, expect, it } from "vitest";
import {
  createGitHubContinuationEffects,
  createGitHubManagedImplementationPorts,
  createGitHubManagedPullRequestRecoveryPorts,
} from "../src/github-publication.js";

describe("GitHub Managed PR publication adapter", () => {
  it("posts a continuation control record once and ignores forged idempotency markers", async () => {
    const envelope: ControlEnvelope = {
      schemaVersion: 1,
      kind: "synchronization",
      repository: "owner/repo",
      ticketNumber: 66,
      prNumber: 73,
      round: 0,
      transitionId: "afk-v1-sync",
      inputRevision: "a".repeat(40),
      outputRevision: "c".repeat(40),
      disposition: "succeeded",
      workflowRunId: "run-2",
    };
    let listed = 0;
    const posts: string[] = [];
    const command = async (_file: string, args: string[]): Promise<string> => {
      if (args[0] === "api" && args[1]?.endsWith("/comments")) {
        listed += 1;
        return listed === 1
          ? JSON.stringify({ body: "<!-- afk-effect:effect-1 -->", author: { login: "mallory", type: "User" } })
          : JSON.stringify({
              body: "<!-- afk-effect:effect-1 -->", author: { login: "delivery-bot", type: "Bot" },
            });
      }
      if (args[0] === "pr" && args[1] === "comment") {
        posts.push(args.at(-1) ?? "");
        return "";
      }
      throw new Error(`unexpected command: ${args.join(" ")}`);
    };
    const effects = createGitHubContinuationEffects({
      repository: "owner/repo",
      trustedActor: { login: "delivery-bot", type: "Bot" },
      command,
    });

    await expect(effects.recordControlComment({
      prNumber: 73,
      envelope,
      narrative: "Synchronized",
      idempotencyKey: "effect-1",
    })).resolves.toEqual({ created: true });
    await expect(effects.recordControlComment({
      prNumber: 73,
      envelope,
      narrative: "Synchronized",
      idempotencyKey: "effect-1",
    })).resolves.toEqual({ created: false });
    expect(posts).toHaveLength(1);
    expect(posts[0]).toContain('"kind":"synchronization"');
    expect(posts[0]).toContain("<!-- afk-effect:effect-1 -->");
  });

  it("records Needs Human with a trusted reason and evidence links", async () => {
    const posts: string[] = [];
    const effects = createGitHubContinuationEffects({
      repository: "owner/repo",
      trustedActor: { login: "delivery-bot", type: "Bot" },
      command: async (_file, args) => {
        if (args[0] === "api") return "";
        if (args[0] === "pr" && args[1] === "comment") {
          posts.push(args.at(-1) ?? "");
          return "";
        }
        throw new Error(`unexpected command: ${args.join(" ")}`);
      },
    });

    await effects.recordNeedsHuman({
      ticketNumber: 68,
      prNumber: 73,
      reason: "repair worktree infrastructure retries exhausted after 2 attempts",
      evidenceLinks: ["https://github.com/owner/repo/pull/73"],
      idempotencyKey: "repair-needs-human",
    });

    expect(posts[0]).toContain("repair worktree infrastructure retries exhausted after 2 attempts");
    expect(posts[0]).toContain("Evidence:\n- https://github.com/owner/repo/pull/73");
  });

  it("performs a bounded open-PR recovery scan and hydrates native ticket links and comments", async () => {
    const calls: Array<{ file: string; args: string[] }> = [];
    const command = async (file: string, args: string[]): Promise<string> => {
      calls.push({ file, args });
      if (args[0] === "pr" && args[1] === "list") {
        return JSON.stringify([{ number: 73 }]);
      }
      if (args[0] === "pr" && args[1] === "diff") {
        return "diff --git a/file.ts b/file.ts\n+complete diff\n";
      }
      if (args[0] === "pr" && args[1] === "view") {
        return JSON.stringify({
          number: 73,
          state: "OPEN",
          headRefName: "afk/ticket-66",
          headRefOid: "a".repeat(40),
          headRepository: { nameWithOwner: "owner/repo" },
          baseRefName: "master",
          baseRefOid: "b".repeat(40),
          body: "Closes #66",
          mergeable: "UNKNOWN",
          statusCheckRollup: [],
          closingIssuesReferences: [{ number: 66 }],
        });
      }
      if (args[0] === "api" && args[1]?.endsWith("/comments")) {
        return [
          JSON.stringify({ body: "control-1", author: { login: "delivery-app", type: "App" } }),
          JSON.stringify({ body: "control-2", author: { login: "delivery-app", type: "App" } }),
        ].join("\n");
      }
      if (args[0] === "api" && args.at(-2) === "--jq") {
        if (args[1]?.includes("/git/commits/")) return JSON.stringify({
          parents: ["a".repeat(40)],
          message: "Implementation",
          author: { name: "Developer", email: "developer@example.com" },
        });
        return "b".repeat(40);
      }
      throw new Error(`unexpected command: ${file} ${args.join(" ")}`);
    };
    const ports = createGitHubManagedPullRequestRecoveryPorts({ repository: "owner/repo", command });

    await expect(ports.listOpenPullRequests(25)).resolves.toEqual([{
      repository: "owner/repo",
      headRepository: "owner/repo",
      open: true,
      ticketNumbers: [66],
      number: 73,
      headRevision: "a".repeat(40),
      headBranch: "afk/ticket-66",
      baseBranch: "master",
      baseRevision: "b".repeat(40),
      mergeable: "unknown",
      requiredChecksPass: false,
      headParents: ["a".repeat(40)],
      headMessage: "Implementation",
      headAuthor: { name: "Developer", email: "developer@example.com" },
      diff: "diff --git a/file.ts b/file.ts\n+complete diff\n",
      body: "Closes #66",
      comments: [
        { author: { login: "delivery-app", type: "App" }, body: "control-1" },
        { author: { login: "delivery-app", type: "App" }, body: "control-2" },
      ],
    }]);
    expect(calls[0]).toEqual({
      file: "gh",
      args: [
        "pr", "list", "--repo", "owner/repo", "--state", "open",
        "--limit", "26", "--json", "number",
      ],
    });
    const jsonFields = calls[1]?.args.at(calls[1]!.args.indexOf("--json") + 1) ?? "";
    expect(jsonFields).toContain("closingIssuesReferences");
    expect(jsonFields).toContain("headRepository");
    const commentsCall = calls.find((call) => call.args[1]?.endsWith("/comments"));
    expect(commentsCall?.args).toContain("--paginate");
    expect(commentsCall?.args.at(-2)).toBe("--jq");
    expect(commentsCall?.args.at(-1)).toContain("author:");
    const diffCall = calls.find((call) => call.args[0] === "pr" && call.args[1] === "diff");
    expect(diffCall?.args).toEqual(["pr", "diff", "73", "--repo", "owner/repo"]);
  });

  it("fails closed when GitHub does not provide a complete textual PR diff", async () => {
    const command = async (_file: string, args: string[]): Promise<string> => {
      if (args[0] === "pr" && args[1] === "list") return JSON.stringify([{ number: 73 }]);
      if (args[0] === "pr" && args[1] === "diff") return "diff unavailable";
      if (args[0] === "pr" && args[1] === "view") return JSON.stringify({
        number: 73, state: "OPEN", headRefName: "afk/ticket-66", headRefOid: "a".repeat(40),
        headRepository: { nameWithOwner: "owner/repo" }, baseRefName: "master", baseRefOid: "b".repeat(40),
        body: "Closes #66", mergeable: "UNKNOWN", statusCheckRollup: [], closingIssuesReferences: [{ number: 66 }],
      });
      if (args[0] === "api" && args[1]?.endsWith("/comments")) return "";
      if (args[0] === "api" && args[1]?.includes("/compare/")) return "b".repeat(40);
      if (args[0] === "api" && args[1]?.includes("/git/commits/")) return JSON.stringify({
        parents: [], message: "Implementation", author: { name: "Developer", email: "developer@example.com" },
      });
      throw new Error(`unexpected command: ${args.join(" ")}`);
    };

    await expect(createGitHubManagedPullRequestRecoveryPorts({ repository: "owner/repo", command })
      .listOpenPullRequests(25)).rejects.toThrow("complete textual diff");
  });

  it("reads an exact staged synchronization from the versioned durable ref", async () => {
    const output = "c".repeat(40);
    const inputRevision = "a".repeat(40);
    const targetRevision = "b".repeat(40);
    const calls: string[][] = [];
    const ports = createGitHubManagedPullRequestRecoveryPorts({
      repository: "owner/repo",
      command: async (_file, args) => {
        calls.push(args);
        if (args[1]?.includes("/git/ref/afk-delivery/v1/synchronizations/73/")) return output;
        if (args[1]?.includes(`/git/commits/${output}`)) {
          return JSON.stringify({ parents: [inputRevision, targetRevision] });
        }
        throw new Error(`unexpected command: ${args.join(" ")}`);
      },
    });

    await expect(ports.readSynchronizationStaging({
      prNumber: 73,
      inputRevision,
      targetRevision,
    })).resolves.toEqual({ revision: output, parents: [inputRevision, targetRevision] });
    expect(calls[0]?.[1]).toContain("git/ref/afk-delivery/v1/synchronizations/73");
  });

  it("finds every open PR closing the ticket regardless of head branch", async () => {
    const calls: string[][] = [];
    const command = async (_file: string, args: string[]): Promise<string> => {
      calls.push(args);
      if (args[0] === "pr" && args[1] === "list") {
        return JSON.stringify([
          {
            number: 7,
            headRefName: "other-implementation",
            baseRefName: "master",
            headRefOid: "b".repeat(40),
            body: "Fixes #65",
          },
          {
            number: 8,
            headRefName: "unrelated",
            baseRefName: "master",
            headRefOid: "c".repeat(40),
            body: "Mentions #65 without closing it",
          },
        ]);
      }
      if (args[0] === "api") return "";
      throw new Error(`unexpected command: ${args.join(" ")}`);
    };
    const ports = createGitHubManagedImplementationPorts({
      repositoryPath: "/repo",
      repository: "owner/repo",
      command,
    });

    const pullRequests = await ports.findOpenPullRequests(65, "afk/65", "master");

    expect(pullRequests.map((pr) => pr.number)).toEqual([7]);
    expect(calls[0]).not.toContain("--head");
  });
});
