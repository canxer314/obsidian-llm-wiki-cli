import { describe, expect, it, vi } from "vitest";

import {
  reviewPullRequest,
  type ReviewGithubPort,
} from "../.sandcastle/review.js";
import type { ReviewerAgentSession } from "../.sandcastle/reviewer-session.js";

const revision = "0123456789abcdef0123456789abcdef01234567";

function github(): ReviewGithubPort {
  return {
    getPullRequestHead: vi.fn(async () => revision),
    publishCommitStatus: vi.fn(async () => undefined),
    addPullRequestComment: vi.fn(async () => undefined),
  };
}

describe("Sandcastle Pull Request review", () => {
  it("maps an Approved review of the quality-checked revision to status and audit comment", async () => {
    const reviewGithub = github();
    const session: ReviewerAgentSession = {
      run: vi.fn(async () => ({
        verdict: "Approved",
        summary: "The implementation matches the Issue and passes its checks.",
        findings: [],
      })),
    };

    await expect(reviewPullRequest({
      pullRequestNumber: 321,
      revision,
      localQuality: { status: "success", revision },
      model: "reviewer-model",
      session,
      github: reviewGithub,
    })).resolves.toEqual({
      status: "success",
      revision,
      verdict: "Approved",
      summary: "The implementation matches the Issue and passes its checks.",
      findings: [],
    });

    expect(session.run).toHaveBeenCalledWith({
      pullRequestNumber: 321,
      revision,
      model: "reviewer-model",
    });
    expect(vi.mocked(reviewGithub.publishCommitStatus).mock.calls).toEqual([
      [{
        revision,
        context: "sandcastle/review",
        state: "pending",
        description: "Independent review started",
      }],
      [{
        revision,
        context: "sandcastle/review",
        state: "success",
        description: "Independent review approved",
      }],
    ]);
    expect(reviewGithub.addPullRequestComment).toHaveBeenCalledWith(321, [
      "## Sandcastle review: Approved",
      "",
      "The implementation matches the Issue and passes its checks.",
      "",
      "### Findings",
      "",
      "None.",
      "",
      `Reviewed revision: \`${revision}\``,
    ].join("\n"));
  });

  it("maps Changes requested to failure and includes concrete findings", async () => {
    const reviewGithub = github();
    const session: ReviewerAgentSession = {
      run: vi.fn(async () => ({
        verdict: "Changes requested",
        summary: "One correctness issue remains.",
        findings: [{
          summary: "Wrong fallback",
          details: "The empty-input path returns the previous value.",
        }],
      })),
    };

    await expect(reviewPullRequest({
      pullRequestNumber: 321,
      revision,
      localQuality: { status: "success", revision },
      model: "reviewer-model",
      session,
      github: reviewGithub,
    })).resolves.toMatchObject({
      status: "failure",
      revision,
      verdict: "Changes requested",
    });

    expect(vi.mocked(reviewGithub.publishCommitStatus).mock.calls.at(-1)?.[0]).toEqual({
      revision,
      context: "sandcastle/review",
      state: "failure",
      description: "Independent review requested changes",
    });
    expect(reviewGithub.addPullRequestComment).toHaveBeenCalledWith(
      321,
      expect.stringContaining(
        "- **Wrong fallback** — The empty-input path returns the previous value.",
      ),
    );
  });

  it.each([
    { status: "failure" as const, stage: "test" as const },
    { status: "error" as const, stage: "setup" as const },
  ])("does not start review after $status local quality", async (localQuality) => {
    const reviewGithub = github();
    const session: ReviewerAgentSession = { run: vi.fn() };

    await expect(reviewPullRequest({
      pullRequestNumber: 321,
      revision,
      localQuality: { ...localQuality, revision },
      model: "reviewer-model",
      session,
      github: reviewGithub,
    })).rejects.toThrow("requires successful local quality");

    expect(session.run).not.toHaveBeenCalled();
    expect(reviewGithub.publishCommitStatus).not.toHaveBeenCalled();
  });

  it("does not start review when local quality belongs to another revision", async () => {
    const reviewGithub = github();
    const session: ReviewerAgentSession = { run: vi.fn() };

    await expect(reviewPullRequest({
      pullRequestNumber: 321,
      revision,
      localQuality: {
        status: "success",
        revision: "89abcdef0123456789abcdef0123456789abcdef",
      },
      model: "reviewer-model",
      session,
      github: reviewGithub,
    })).rejects.toThrow("requires local quality for the same revision");

    expect(session.run).not.toHaveBeenCalled();
  });

  it("does not start review when the head changed after local quality completed", async () => {
    const successorRevision = "89abcdef0123456789abcdef0123456789abcdef";
    const reviewGithub = github();
    vi.mocked(reviewGithub.getPullRequestHead).mockResolvedValue(successorRevision);
    const session: ReviewerAgentSession = { run: vi.fn() };

    await expect(reviewPullRequest({
      pullRequestNumber: 321,
      revision,
      localQuality: { status: "success", revision },
      model: "reviewer-model",
      session,
      github: reviewGithub,
    })).resolves.toEqual({ status: "error", revision });

    expect(session.run).not.toHaveBeenCalled();
    expect(vi.mocked(reviewGithub.publishCommitStatus).mock.calls).toEqual([
      [{
        revision,
        context: "sandcastle/review",
        state: "error",
        description: "Independent review stale before start",
      }],
    ]);
  });

  it("publishes terminal error when a pending review aborts", async () => {
    const reviewGithub = github();
    const session: ReviewerAgentSession = {
      run: vi.fn(async () => ({
        verdict: "Approved",
        summary: "The reviewed revision is correct.",
        findings: [],
      })),
    };
    vi.mocked(reviewGithub.getPullRequestHead)
      .mockResolvedValueOnce(revision)
      .mockRejectedValueOnce(new Error("GitHub transport failed"));

    await expect(reviewPullRequest({
      pullRequestNumber: 321,
      revision,
      localQuality: { status: "success", revision },
      model: "reviewer-model",
      session,
      github: reviewGithub,
    })).rejects.toThrow("GitHub transport failed");

    expect(vi.mocked(reviewGithub.publishCommitStatus).mock.calls).toEqual([
      [{
        revision,
        context: "sandcastle/review",
        state: "pending",
        description: "Independent review started",
      }],
      [{
        revision,
        context: "sandcastle/review",
        state: "error",
        description: "Independent review could not complete",
      }],
    ]);
  });
  it("maps session and structured-output failures to error without exposing details", async () => {
    const reviewGithub = github();
    const session: ReviewerAgentSession = {
      run: vi.fn(async () => {
        throw new Error("invalid output contained SECRET_TOKEN");
      }),
    };

    await expect(reviewPullRequest({
      pullRequestNumber: 321,
      revision,
      localQuality: { status: "success", revision },
      model: "reviewer-model",
      session,
      github: reviewGithub,
    })).resolves.toEqual({ status: "error", revision });

    expect(vi.mocked(reviewGithub.publishCommitStatus).mock.calls.at(-1)?.[0]).toEqual({
      revision,
      context: "sandcastle/review",
      state: "error",
      description: "Independent review session failed",
    });
    expect(reviewGithub.addPullRequestComment).toHaveBeenCalledWith(
      321,
      [
        "## Sandcastle review error",
        "",
        "The independent Reviewer session failed before producing a valid verdict.",
        "",
        `Reviewed revision: \`${revision}\``,
      ].join("\n"),
    );
    expect(JSON.stringify(vi.mocked(reviewGithub.publishCommitStatus).mock.calls)).not.toContain(
      "SECRET_TOKEN",
    );
    expect(JSON.stringify(vi.mocked(reviewGithub.addPullRequestComment).mock.calls)).not.toContain(
      "SECRET_TOKEN",
    );
  });

  it("invalidates the verdict when the Pull Request head changes during review", async () => {
    const successorRevision = "89abcdef0123456789abcdef0123456789abcdef";
    const reviewGithub = github();
    vi.mocked(reviewGithub.getPullRequestHead)
      .mockResolvedValueOnce(revision)
      .mockResolvedValueOnce(successorRevision);
    const session: ReviewerAgentSession = {
      run: vi.fn(async () => ({
        verdict: "Approved",
        summary: "The reviewed revision is correct.",
        findings: [],
      })),
    };

    await expect(reviewPullRequest({
      pullRequestNumber: 321,
      revision,
      localQuality: { status: "success", revision },
      model: "reviewer-model",
      session,
      github: reviewGithub,
    })).resolves.toEqual({ status: "error", revision });

    expect(reviewGithub.addPullRequestComment).toHaveBeenCalledWith(
      321,
      [
        "## Sandcastle review discarded",
        "",
        "The Pull Request head changed before this review could be published.",
        "",
        `Reviewed revision: \`${revision}\``,
      ].join("\n"),
    );
    expect(vi.mocked(reviewGithub.publishCommitStatus).mock.calls.at(-1)?.[0]).toEqual({
      revision,
      context: "sandcastle/review",
      state: "error",
      description: "Independent review stale after head changed",
    });
    expect(JSON.stringify(vi.mocked(reviewGithub.publishCommitStatus).mock.calls)).not.toContain(
      successorRevision,
    );
  });

  it("maps audit comment failure to error instead of leaving success", async () => {
    const reviewGithub = github();
    vi.mocked(reviewGithub.addPullRequestComment).mockRejectedValue(
      new Error("GitHub comment failed"),
    );
    const session: ReviewerAgentSession = {
      run: vi.fn(async () => ({
        verdict: "Approved",
        summary: "The reviewed revision is correct.",
        findings: [],
      })),
    };

    await expect(reviewPullRequest({
      pullRequestNumber: 321,
      revision,
      localQuality: { status: "success", revision },
      model: "reviewer-model",
      session,
      github: reviewGithub,
    })).resolves.toEqual({ status: "error", revision });

    expect(vi.mocked(reviewGithub.publishCommitStatus).mock.calls.at(-1)?.[0]).toEqual({
      revision,
      context: "sandcastle/review",
      state: "error",
      description: "Independent review audit comment failed",
    });
    expect(vi.mocked(reviewGithub.publishCommitStatus).mock.calls).not.toContainEqual([
      expect.objectContaining({ state: "success" }),
    ]);
  });

  it("records that the audit is discarded when the head changes after comment", async () => {
    const successorRevision = "89abcdef0123456789abcdef0123456789abcdef";
    const reviewGithub = github();
    vi.mocked(reviewGithub.getPullRequestHead)
      .mockResolvedValueOnce(revision)
      .mockResolvedValueOnce(revision)
      .mockResolvedValueOnce(successorRevision);
    const session: ReviewerAgentSession = {
      run: vi.fn(async () => ({
        verdict: "Approved",
        summary: "The reviewed revision is correct.",
        findings: [],
      })),
    };

    await expect(reviewPullRequest({
      pullRequestNumber: 321,
      revision,
      localQuality: { status: "success", revision },
      model: "reviewer-model",
      session,
      github: reviewGithub,
    })).resolves.toEqual({ status: "error", revision });

    expect(vi.mocked(reviewGithub.publishCommitStatus).mock.calls.at(-1)?.[0]).toEqual({
      revision,
      context: "sandcastle/review",
      state: "error",
      description: "Independent review stale after head changed",
    });
    expect(reviewGithub.addPullRequestComment).toHaveBeenLastCalledWith(
      321,
      expect.stringContaining("head changed after the review audit was recorded"),
    );
  });

  it("overwrites a terminal verdict with error when the head changes during status publication", async () => {
    const successorRevision = "89abcdef0123456789abcdef0123456789abcdef";
    const reviewGithub = github();
    vi.mocked(reviewGithub.getPullRequestHead)
      .mockResolvedValueOnce(revision)
      .mockResolvedValueOnce(revision)
      .mockResolvedValueOnce(revision)
      .mockResolvedValueOnce(successorRevision);
    const session: ReviewerAgentSession = {
      run: vi.fn(async () => ({
        verdict: "Approved",
        summary: "The reviewed revision is correct.",
        findings: [],
      })),
    };

    await expect(reviewPullRequest({
      pullRequestNumber: 321,
      revision,
      localQuality: { status: "success", revision },
      model: "reviewer-model",
      session,
      github: reviewGithub,
    })).resolves.toEqual({ status: "error", revision });

    expect(vi.mocked(reviewGithub.publishCommitStatus).mock.calls.slice(-2)).toEqual([
      [{
        revision,
        context: "sandcastle/review",
        state: "success",
        description: "Independent review approved",
      }],
      [{
        revision,
        context: "sandcastle/review",
        state: "error",
        description: "Independent review stale after head changed",
      }],
    ]);
    expect(reviewGithub.addPullRequestComment).toHaveBeenLastCalledWith(
      321,
      expect.stringContaining("changed while the review status was being published"),
    );
  });
});
