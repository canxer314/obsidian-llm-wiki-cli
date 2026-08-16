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

  it("publishes an authenticated Merge Report once and merges with an exact-head precondition", async () => {
    const head = "a".repeat(40);
    const mergeCalls: string[][] = [];
    const posts: string[] = [];
    let trustedReportExists = false;
    let merged = false;
    const effects = createGitHubContinuationEffects({
      repository: "owner/repo",
      trustedActor: { login: "delivery-bot", type: "Bot" },
      command: async (_file, args) => {
        if (args[0] === "api" && args[1]?.endsWith("/comments")) {
          return trustedReportExists
            ? JSON.stringify({
                body: "<!-- afk-effect:report-effect -->",
                author: { login: "delivery-bot", type: "Bot" },
              })
            : "";
        }
        if (args[0] === "pr" && args[1] === "comment") {
          posts.push(args.at(-1) ?? "");
          trustedReportExists = true;
          return "";
        }
        if (args[0] === "pr" && args[1] === "view") {
          return JSON.stringify({ state: merged ? "MERGED" : "OPEN", headRefOid: head, mergedAt: merged ? "2026-08-16T00:00:00Z" : null });
        }
        if (args[0] === "pr" && args[1] === "merge") {
          mergeCalls.push(args);
          merged = true;
          return "";
        }
        throw new Error(`unexpected command: ${args.join(" ")}`);
      },
    });
    const envelope: ControlEnvelope = {
      schemaVersion: 1, kind: "merge-report", repository: "owner/repo", ticketNumber: 66,
      prNumber: 73, round: 1, transitionId: "merge-report-1", inputRevision: head,
      baseRevision: "b".repeat(40), disposition: "ready", workflowRunId: "run-merge", workflowRunAttempt: 1,
    };
    const report = {
      repository: "owner/repo", ticketNumber: 66, prNumber: 73,
      baseRevision: "b".repeat(40), headRevision: head, validatedRevision: head, approvedRevision: head,
      validationRound: 1, reviewRound: 1,
      validationEvidence: { transitionId: "validation-1", commands: [] },
      reviewRounds: [], repairRounds: [], followUpIssues: [], remainingNonBlockingObservations: [],
      mergeStrategy: "squash" as const, workflowRun: { id: "run-merge", attempt: 1 },
    };

    await expect(effects.recordMergeReport!({
      prNumber: 73, envelope, report, narrative: "Complete report", strategy: "squash", idempotencyKey: "report-effect",
    })).resolves.toEqual({ created: true });
    await expect(effects.recordMergeReport!({
      prNumber: 73, envelope, report, narrative: "Complete report", strategy: "squash", idempotencyKey: "report-effect",
    })).resolves.toEqual({ created: false });
    await expect(effects.mergeExactRevision!({
      prNumber: 73, exactRevision: head, strategy: "squash", idempotencyKey: "merge-effect",
    })).resolves.toEqual({ merged: true });
    await expect(effects.mergeExactRevision!({
      prNumber: 73, exactRevision: head, strategy: "squash", idempotencyKey: "merge-effect",
    })).resolves.toEqual({ merged: false });

    expect(posts).toHaveLength(1);
    expect(posts[0]).toContain("Complete report");
    expect(posts[0]).toContain('"kind":"merge-report"');
    expect(mergeCalls).toEqual([[
      "pr", "merge", "73", "--repo", "owner/repo", "--squash", "--match-head-commit", head,
    ]]);
  });

  it("creates an idempotent linked follow-up without authorizing it for AFK Delivery", async () => {
    const calls: string[][] = [];
    let existing = false;
    const effects = createGitHubContinuationEffects({
      repository: "owner/repo",
      trustedActor: { login: "delivery-bot", type: "Bot" },
      command: async (_file, args) => {
        calls.push(args);
        if (args[0] === "issue" && args[1] === "list") {
          return existing
            ? JSON.stringify([{ number: 91, url: "https://github.com/owner/repo/issues/91", body: "<!-- afk-effect:follow-up-1 -->" }])
            : "[]";
        }
        if (args[0] === "issue" && args[1] === "create") {
          existing = true;
          return "https://github.com/owner/repo/issues/91";
        }
        throw new Error(`unexpected command: ${args.join(" ")}`);
      },
    });
    const input = {
      ticketNumber: 66,
      prNumber: 73,
      observation: "F-9: Document the recovery timeout.",
      idempotencyKey: "follow-up-1",
    };

    await expect(effects.createFollowUpIssue!(input)).resolves.toEqual({
      number: 91, url: "https://github.com/owner/repo/issues/91", created: true,
    });
    await expect(effects.createFollowUpIssue!(input)).resolves.toEqual({
      number: 91, url: "https://github.com/owner/repo/issues/91", created: false,
    });
    const create = calls.find((args) => args[0] === "issue" && args[1] === "create");
    expect(create).toBeDefined();
    expect(create).not.toContain("--label");
    expect(create?.join(" ")).not.toContain("ready-for-agent");
    expect(create?.at(-1)).toContain("Source Delivery Ticket: #66");
    expect(create?.at(-1)).toContain("Source Managed PR: #73");
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
