import { describe, expect, it, vi } from "vitest";

import { createManagedOperationGithub } from "../.sandcastle/target-operation-github.js";

const revision = "a".repeat(40);

describe("managed Target operation GitHub view", () => {
  it("virtualizes acquisition labels without repeating their GitHub mutations", async () => {
    const addIssueLabel = vi.fn(async () => {});
    const removeIssueLabel = vi.fn(async () => {});
    const github = createManagedOperationGithub({
      readIssue: async () => ({ state: "OPEN", labels: ["agent:in-progress"], baseRevision: revision }),
      addIssueLabel,
      removeIssueLabel,
    }, "implement-issue", 219, { revision, acquired: true });

    expect(await github.readIssue(219)).toMatchObject({ labels: ["agent:implement"] });
    await github.addIssueLabel(219, "agent:in-progress");
    expect(await github.readIssue(219)).toMatchObject({
      labels: expect.arrayContaining(["agent:implement", "agent:in-progress"]),
    });
    await github.removeIssueLabel(219, "agent:implement");
    expect(await github.readIssue(219)).toMatchObject({ labels: ["agent:in-progress"] });
    await github.addIssueLabel(219, "agent:blocked");
    await github.removeIssueLabel(219, "agent:in-progress");

    expect(addIssueLabel).not.toHaveBeenCalled();
    expect(removeIssueLabel).not.toHaveBeenCalled();
  });

  it.each([
    ["physical SHA", { headSha: "b".repeat(40) }],
    ["head ref", { headRefName: "other-head" }],
    ["base ref", { baseRefName: "other-base" }],
    ["base repository", { baseRepository: "other/base" }],
    ["head repository", { headRepository: "other/head" }],
  ])("rejects pre-confirmation Pull Request drift in %s", async (_field, drift) => {
    const github = createManagedOperationGithub({
      readPullRequest: async () => ({
        headSha: revision,
        headRefName: "feature-branch",
        baseRefName: "master",
        baseRepository: "owner/repository",
        headRepository: "owner/repository",
        labels: ["agent:review"],
        ...drift,
      }),
      addPullRequestLabel: vi.fn(async () => {}),
      removePullRequestLabel: vi.fn(async () => {}),
    }, "review", 219, {
      revision,
      acquired: true,
      pullRequest: {
        headSha: revision,
        headRefName: "feature-branch",
        baseRefName: "master",
        baseRepository: "owner/repository",
        headRepository: "owner/repository",
      },
    });

    await expect(github.readPullRequest(219)).rejects.toThrow(
      "Pull Request #219 changed after acquisition",
    );
  });

  it.each([
    ["head ref", { headRefName: "other-head" }],
    ["base ref", { baseRefName: "other-base" }],
    ["base repository", { baseRepository: "other/base" }],
    ["head repository", { headRepository: "other/head" }],
  ])("continues to reject post-confirmation drift in %s after publication SHA convergence", async (_field, drift) => {
    const github = createManagedOperationGithub({
      readPullRequest: async () => ({
        headSha: "b".repeat(40),
        headRefName: "feature-branch",
        baseRefName: "master",
        baseRepository: "owner/repository",
        headRepository: "owner/repository",
        labels: ["agent:in-progress"],
        ...drift,
      }),
      addPullRequestLabel: vi.fn(async () => {}),
      removePullRequestLabel: vi.fn(async () => {}),
    }, "implement-feedback", 219, {
      revision,
      acquired: true,
      pullRequest: {
        headSha: revision,
        headRefName: "feature-branch",
        baseRefName: "master",
        baseRepository: "owner/repository",
        headRepository: "owner/repository",
      },
    });

    await github.addPullRequestLabel(219, "agent:in-progress");
    await github.removePullRequestLabel(219, "agent:implement");
    await expect(github.readPullRequest(219)).rejects.toThrow(
      "Pull Request #219 changed after acquisition",
    );
  });

  it("allows feedback convergence to observe its published head after acquisition confirmation", async () => {
    const publishedRevision = "b".repeat(40);
    let readCount = 0;
    const readPullRequest = vi.fn(async () => {
      readCount += 1;
      return {
        headSha: readCount < 4 ? revision : publishedRevision,
        headRefName: "feature-branch",
        baseRefName: "master",
        baseRepository: "owner/repository",
        headRepository: "owner/repository",
        labels: ["agent:in-progress"],
      };
    });
    const github = createManagedOperationGithub({
      readPullRequest,
      addPullRequestLabel: vi.fn(async () => {}),
      removePullRequestLabel: vi.fn(async () => {}),
    }, "implement-feedback", 219, {
      revision,
      acquired: true,
      pullRequest: {
        headSha: revision,
        headRefName: "feature-branch",
        baseRefName: "master",
        baseRepository: "owner/repository",
        headRepository: "owner/repository",
      },
    });

    await expect(github.readPullRequest(219)).resolves.toMatchObject({ headSha: revision });
    await github.addPullRequestLabel(219, "agent:in-progress");
    await expect(github.readPullRequest(219)).resolves.toMatchObject({ headSha: revision });
    await github.removePullRequestLabel(219, "agent:implement");
    await expect(github.readPullRequest(219)).resolves.toMatchObject({ headSha: revision });
    await expect(github.readPullRequest(219)).resolves.toMatchObject({ headSha: publishedRevision });
  });

  it("publishes a later PRD continuation trigger as a business transition", async () => {
    const addIssueLabel = vi.fn(async () => {});
    const github = createManagedOperationGithub({
      readPrd: async () => ({ state: "OPEN", labels: ["agent:in-progress"], baseRevision: revision }),
      addIssueLabel,
      removeIssueLabel: vi.fn(async () => {}),
    }, "implement-prd", 219, { revision, acquired: true });

    await github.addIssueLabel(219, "agent:in-progress");
    await github.removeIssueLabel(219, "agent:implement");
    await github.addIssueLabel(219, "agent:implement");

    expect(addIssueLabel).toHaveBeenCalledExactlyOnceWith(219, "agent:implement");
  });
});
