import { describe, expect, it, vi } from "vitest";

import {
  runFailureAwareWorkflow,
  SandcastleWorkflowError,
} from "../.sandcastle/failure-workflow.js";
import type { FailureGithubPort } from "../.sandcastle/failure-finalizer.js";

function githubPort(): FailureGithubPort {
  return {
    addIssueComment: vi.fn().mockResolvedValue(undefined),
    addPullRequestComment: vi.fn().mockResolvedValue(undefined),
    removeIssueLabel: vi.fn().mockResolvedValue(undefined),
    addIssueLabel: vi.fn().mockResolvedValue(undefined),
  };
}

describe("Sandcastle failure-aware workflow", () => {
  it.each([
    { stage: "startup", hasPullRequest: false },
    { stage: "planner", hasPullRequest: false },
    { stage: "implementer", hasPullRequest: false },
    { stage: "local-quality", hasPullRequest: true },
    { stage: "reviewer", hasPullRequest: true },
    { stage: "repair", hasPullRequest: true },
  ])(
    "finalizes a $stage exception without retrying the workflow",
    async ({ stage, hasPullRequest }) => {
      const github = githubPort();
      const run = vi.fn(async (progress: {
        enter(stage: string, pullRequest?: { number: number; headSha: string; url: string }): void;
      }) => {
        progress.enter(stage, hasPullRequest ? {
          number: 321,
          headSha: "a".repeat(40),
          url: "https://github.com/example/repo/pull/321",
        } : undefined);
        throw new Error(`${stage} failed`);
      });

      await expect(runFailureAwareWorkflow({
        issueNumber: 108,
        github,
        run,
      })).rejects.toMatchObject<SandcastleWorkflowError>({
        stage,
        finalizationFailures: [],
      });

      expect(run).toHaveBeenCalledOnce();
      if (hasPullRequest) {
        expect(github.addPullRequestComment).toHaveBeenCalledOnce();
        expect(github.addIssueComment).not.toHaveBeenCalled();
      } else {
        expect(github.addIssueComment).toHaveBeenCalledOnce();
        expect(github.addPullRequestComment).not.toHaveBeenCalled();
      }
    },
  );

  it("finalizes cancellation with a fixed interrupted reason", async () => {
    const github = githubPort();
    const cancellation = new Error("private agent payload /secret/path");
    cancellation.name = "AbortError";

    await expect(runFailureAwareWorkflow({
      issueNumber: 108,
      github,
      run: async (progress) => {
        progress.enter("implementer");
        throw cancellation;
      },
    })).rejects.toMatchObject<SandcastleWorkflowError>({ stage: "interrupted" });

    expect(github.addIssueComment).toHaveBeenCalledWith(
      108,
      expect.stringContaining("Failure stage: `interrupted`"),
    );
    const comment = vi.mocked(github.addIssueComment).mock.calls[0]![1];
    expect(comment).toContain("Sandcastle workflow interrupted");
    expect(comment).not.toContain("private agent payload");
    expect(comment).not.toContain("/secret/path");
  });

  it("finalizes an exception after implementation on the verified Draft Pull Request", async () => {
    const github = githubPort();

    await expect(runFailureAwareWorkflow({
      issueNumber: 108,
      github,
      run: async (progress) => {
        progress.enter("repair", { number: 321, headSha: "a".repeat(40) });
        throw new Error("repair failed");
      },
    })).rejects.toBeInstanceOf(SandcastleWorkflowError);

    expect(github.addPullRequestComment).toHaveBeenCalledWith(
      321,
      expect.stringContaining("repair failed"),
    );
  });

  it("finalizes a blocked Planner result without inventing a revision", async () => {
    const github = githubPort();

    await expect(runFailureAwareWorkflow({
      issueNumber: 108,
      github,
      run: vi.fn().mockResolvedValue({
        result: { status: "blocked" },
        terminalFailure: {
          stage: "planner:blocked",
          summary: "A dependency is unresolved",
        },
      }),
    })).rejects.toMatchObject<SandcastleWorkflowError>({
      stage: "planner:blocked",
    });

    const comment = vi.mocked(github.addIssueComment).mock.calls[0]![1];
    expect(comment).toContain("A dependency is unresolved");
    expect(comment).not.toContain("Related SHA");
  });

  it("finalizes an explicit terminal result and never reports it as success", async () => {
    const github = githubPort();
    const run = vi.fn().mockResolvedValue({
      result: { status: "stopped" },
      terminalFailure: {
        stage: "reviewer:repair-budget-exhausted",
        revision: "b".repeat(40),
        summary: "Changes remain",
      },
      pullRequest: { number: 321, headSha: "b".repeat(40) },
    });

    await expect(runFailureAwareWorkflow({ issueNumber: 108, github, run }))
      .rejects.toMatchObject<SandcastleWorkflowError>({
        stage: "reviewer:repair-budget-exhausted",
      });

    expect(run).toHaveBeenCalledOnce();
    expect(github.addPullRequestComment).toHaveBeenCalledOnce();
  });

  it("reports incomplete finalization while still attempting every operation", async () => {
    const github = githubPort();
    vi.mocked(github.addIssueComment).mockRejectedValue(new Error("comment denied"));

    await expect(runFailureAwareWorkflow({
      issueNumber: 108,
      github,
      run: async () => {
        throw new Error("planner failed");
      },
    })).rejects.toMatchObject<SandcastleWorkflowError>({
      finalizationFailures: ["comment: comment denied"],
    });

    expect(github.removeIssueLabel).toHaveBeenCalledOnce();
    expect(github.addIssueLabel).toHaveBeenCalledOnce();
  });
});
