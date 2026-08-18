import { describe, expect, it, vi } from "vitest";

import {
  mergeVerifiedPullRequest,
  type MergeGithubPort,
  type MergePullRequestState,
} from "../.sandcastle/merge.js";

const revision = "a".repeat(40);
const successorRevision = "b".repeat(40);
const pullRequest = {
  number: 321,
  headSha: revision,
  url: "https://github.com/example/repo/pull/321",
};

function state(overrides: Partial<MergePullRequestState> = {}): MergePullRequestState {
  return {
    state: "OPEN",
    isDraft: false,
    repository: "example/repo",
    defaultBranch: "master",
    baseRepository: "example/repo",
    headRepository: "example/repo",
    baseRefName: "master",
    headRefName: "sandcastle/issue-110",
    headSha: revision,
    mergeable: "MERGEABLE",
    closingIssueNumbers: [110],
    ...overrides,
  };
}

function github(metadata = state()): MergeGithubPort {
  return {
    markPullRequestReady: vi.fn().mockResolvedValue(undefined),
    getPullRequestForMerge: vi.fn().mockResolvedValue(metadata),
    squashMergePullRequest: vi.fn().mockResolvedValue({ merged: true }),
    deleteBranch: vi.fn().mockResolvedValue(undefined),
  };
}

const gates = {
  localQuality: { status: "success" as const, revision },
  review: {
    status: "success" as const,
    revision,
    verdict: "Approved" as const,
    summary: "Looks good.",
    findings: [],
  },
};

describe("Sandcastle exact-head merge", () => {
  it("squash merges the twice-approved revision and deletes its remote branch", async () => {
    const mergeGithub = github();

    await expect(mergeVerifiedPullRequest({
      issueNumber: 110,
      pullRequest,
      ...gates,
      github: mergeGithub,
    })).resolves.toEqual({ pullRequest, mergedRevision: revision });

    expect(mergeGithub.markPullRequestReady).toHaveBeenCalledWith(321);
    expect(mergeGithub.squashMergePullRequest).toHaveBeenCalledWith(321, revision);
    expect(mergeGithub.deleteBranch).toHaveBeenCalledWith("sandcastle/issue-110");
  });

  it("rejects a Pull Request that remains Draft", async () => {
    const mergeGithub = github(state({ isDraft: true }));

    await expect(mergeVerifiedPullRequest({
      issueNumber: 110,
      pullRequest,
      ...gates,
      github: mergeGithub,
    })).rejects.toThrow("still a Draft");

    expect(mergeGithub.squashMergePullRequest).not.toHaveBeenCalled();
    expect(mergeGithub.deleteBranch).not.toHaveBeenCalled();
  });

  it("rejects a head that moved after either gate", async () => {
    const mergeGithub = github(state({ headSha: successorRevision }));

    await expect(mergeVerifiedPullRequest({
      issueNumber: 110,
      pullRequest,
      ...gates,
      github: mergeGithub,
    })).rejects.toThrow("head does not match both successful gates");

    expect(mergeGithub.squashMergePullRequest).not.toHaveBeenCalled();
  });

  it("rejects missing successful gate status", async () => {
    const mergeGithub = github();

    await expect(mergeVerifiedPullRequest({
      issueNumber: 110,
      pullRequest,
      localQuality: { status: "error", stage: "setup", revision },
      review: gates.review,
      github: mergeGithub,
    })).rejects.toThrow("requires successful local quality and review");

    expect(mergeGithub.markPullRequestReady).not.toHaveBeenCalled();
  });

  it.each([
    { name: "closed", metadata: state({ state: "CLOSED" }) },
    { name: "wrong base repository", metadata: state({ baseRepository: "other/repo" }) },
    { name: "fork head", metadata: state({ headRepository: "contributor/repo" }) },
    { name: "wrong base", metadata: state({ baseRefName: "release" }) },
    { name: "wrong head", metadata: state({ headRefName: "feature/other" }) },
    { name: "blocked merge", metadata: state({ mergeable: "CONFLICTING" }) },
    { name: "missing auto-close relationship", metadata: state({ closingIssueNumbers: [] }) },
  ])("preserves the Pull Request and Issue for $name", async ({ metadata }) => {
    const mergeGithub = github(metadata);

    await expect(mergeVerifiedPullRequest({
      issueNumber: 110,
      pullRequest,
      ...gates,
      github: mergeGithub,
    })).rejects.toThrow();

    expect(mergeGithub.squashMergePullRequest).not.toHaveBeenCalled();
    expect(mergeGithub.deleteBranch).not.toHaveBeenCalled();
  });

  it("preserves the branch when GitHub rejects an expected-head merge", async () => {
    const mergeGithub = github();
    vi.mocked(mergeGithub.squashMergePullRequest).mockRejectedValue(
      new Error("expectedHeadOid mismatch"),
    );

    await expect(mergeVerifiedPullRequest({
      issueNumber: 110,
      pullRequest,
      ...gates,
      github: mergeGithub,
    })).rejects.toThrow("expectedHeadOid mismatch");

    expect(mergeGithub.deleteBranch).not.toHaveBeenCalled();
  });
});
