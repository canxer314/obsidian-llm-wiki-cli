import { describe, expect, it, vi } from "vitest";
import { executeNewImplementationTransition } from "../src/new-implementation.js";
import type { ImplementationStageRequest } from "../src/implementation.js";

const request: ImplementationStageRequest & {
  workflowRunId: string;
  trustedActor: { login: string; type: "Bot" };
} = {
  repository: "owner/repo",
  ticket: { number: 65, title: "Ticket", body: "Spec" },
  repositoryInstructions: [],
  domainDocuments: [],
  architectureDecisions: [],
  targetBranch: "master",
  validationCommands: ["npm test"],
  transitionId: "afk-v1-test",
  workflowRunId: "run-1",
  trustedActor: { login: "delivery-bot", type: "Bot" },
  policy: {
    model: "claude-opus-5",
    contextWindow: 1_000_000,
    maximumIterations: 24,
    timeoutMs: 60_000,
    cpuLimit: 2,
  },
};

describe("new implementation transition", () => {
  it("does not publish when the stage produces no commit", async () => {
    const ensureRemoteBranch = vi.fn();
    const result = await executeNewImplementationTransition(request, {
      stage: {
        createWorktree: async () => ({ path: "/worktree", branch: "afk/65", baseRevision: "a".repeat(40) }),
        runAgent: async () => ({ exitCode: 0, stdout: "no changes", stderr: "" }),
        resolveHeadRevision: async () => "a".repeat(40),
        removeWorktree: async () => undefined,
      },
      publication: {
        findRemoteBranchRevision: async () => undefined,
        ensureRemoteBranch,
        findOpenPullRequests: async () => [],
        createPullRequest: async () => { throw new Error("must not create PR"); },
        postComment: async () => { throw new Error("must not comment"); },
      },
    });

    expect(result).toEqual({
      status: "failed",
      stage: {
        status: "failed",
        reason: "implementation stage produced no commit",
        narrative: "no changes",
      },
    });
    expect(ensureRemoteBranch).not.toHaveBeenCalled();
  });

  it("resumes a pushed Revision without rerunning the agent and authenticates fresh GitHub state", async () => {
    const revision = "b".repeat(40);
    const runAgent = vi.fn();
    const comments: Array<{
      author: { login: string; type: "Bot" | "App" | "User" };
      body: string;
    }> = [];
    const record = {
      number: 101,
      headRevision: revision,
      headBranch: "afk/ticket-65-afk-v1-test",
      baseBranch: "master",
      body: "Closes #65\n\n<!-- afk-managed-pr:65:afk-v1-test -->",
      comments,
    };
    const result = await executeNewImplementationTransition(request, {
      stage: {
        createWorktree: async () => { throw new Error("must not create workspace"); },
        runAgent,
        resolveHeadRevision: async () => { throw new Error("must not inspect workspace"); },
        removeWorktree: async () => undefined,
      },
      publication: {
        findRemoteBranchRevision: async () => revision,
        ensureRemoteBranch: async () => undefined,
        findOpenPullRequests: async () => comments.length === 0 ? [] : [record],
        createPullRequest: async () => record,
        postComment: async (_prNumber, body) => {
          comments.push({ author: request.trustedActor, body });
        },
      },
    });

    expect(result).toMatchObject({ status: "published", prNumber: 101, outputRevision: revision });
    expect(runAgent).not.toHaveBeenCalled();
  });
});
