import { describe, expect, it, vi } from "vitest";

import {
  checkPullRequestLocalQuality,
  type LocalQualityGithubPort,
  type LocalQualityHost,
} from "../.sandcastle/local-quality.js";

const revision = "0123456789abcdef0123456789abcdef01234567";
const successorRevision = "89abcdef0123456789abcdef0123456789abcdef";

function host(): LocalQualityHost {
  return {
    setup: vi.fn(async () => undefined),
    run: vi.fn(async () => ({ exitCode: 0 })),
    dispose: vi.fn(async () => undefined),
  };
}

function github(): LocalQualityGithubPort {
  return {
    getPullRequestHead: vi.fn(async () => revision),
    publishCommitStatus: vi.fn(async () => undefined),
  };
}

describe("Sandcastle Pull Request local quality", () => {
  it("publishes pending and success to the exact Pull Request head", async () => {
    const qualityHost = host();
    const qualityGithub = github();

    await expect(
      checkPullRequestLocalQuality(321, qualityGithub, qualityHost),
    ).resolves.toEqual({ status: "success", revision });

    expect(qualityGithub.getPullRequestHead).toHaveBeenCalledTimes(2);
    expect(qualityHost.setup).toHaveBeenCalledWith(revision);
    expect(vi.mocked(qualityGithub.publishCommitStatus).mock.calls).toEqual([
      [{
        revision,
        context: "sandcastle/local-quality",
        state: "pending",
        description: "Local quality checks started",
      }],
      [{
        revision,
        context: "sandcastle/local-quality",
        state: "success",
        description: "Local quality checks passed",
      }],
    ]);
  });

  it.each([
    {
      name: "failure",
      run: vi.fn()
        .mockResolvedValueOnce({ exitCode: 0 })
        .mockResolvedValueOnce({ exitCode: 1, output: "build failed with SECRET_TOKEN" }),
      expected: { status: "failure", stage: "build", output: "build failed with SECRET_TOKEN" },
      description: "Local quality failed during build",
    },
    {
      name: "error",
      run: vi.fn()
        .mockResolvedValueOnce({ exitCode: 0 })
        .mockRejectedValueOnce(new Error("Docker failed with SECRET_TOKEN")),
      expected: { status: "error", stage: "build", output: "Docker failed with SECRET_TOKEN" },
      description: "Local quality error during build",
    },
  ])("publishes $name without exposing command output", async ({ run, expected, description }) => {
    const qualityHost = { ...host(), run };
    const qualityGithub = github();

    await expect(
      checkPullRequestLocalQuality(321, qualityGithub, qualityHost),
    ).resolves.toEqual({ ...expected, revision });

    expect(vi.mocked(qualityGithub.publishCommitStatus).mock.calls.at(-1)?.[0]).toEqual({
      revision,
      context: "sandcastle/local-quality",
      state: expected.status,
      description,
    });
    expect(JSON.stringify(vi.mocked(qualityGithub.publishCommitStatus).mock.calls)).not.toContain(
      "SECRET_TOKEN",
    );
  });

  it("publishes terminal error when a pending local quality gate aborts", async () => {
    const qualityHost = host();
    const qualityGithub = github();
    vi.mocked(qualityGithub.getPullRequestHead)
      .mockResolvedValueOnce(revision)
      .mockRejectedValueOnce(new Error("GitHub transport failed"));

    await expect(
      checkPullRequestLocalQuality(321, qualityGithub, qualityHost),
    ).rejects.toThrow("GitHub transport failed");

    expect(vi.mocked(qualityGithub.publishCommitStatus).mock.calls).toEqual([
      [{
        revision,
        context: "sandcastle/local-quality",
        state: "pending",
        description: "Local quality checks started",
      }],
      [{
        revision,
        context: "sandcastle/local-quality",
        state: "error",
        description: "Local quality gate could not complete",
      }],
    ]);
  });
  it("invalidates a failed result when the Pull Request head changes during checks", async () => {
    const qualityGithub = github();
    vi.mocked(qualityGithub.getPullRequestHead)
      .mockResolvedValueOnce(revision)
      .mockResolvedValueOnce(successorRevision);
    const qualityHost = {
      ...host(),
      run: vi.fn()
        .mockResolvedValueOnce({ exitCode: 0 })
        .mockResolvedValueOnce({ exitCode: 1, output: "old failure" }),
    };

    await expect(
      checkPullRequestLocalQuality(321, qualityGithub, qualityHost),
    ).resolves.toEqual({
      status: "error",
      stage: "setup",
      output: "Pull Request head changed during local quality checks",
      revision,
    });

    expect(vi.mocked(qualityGithub.publishCommitStatus).mock.calls.at(-1)?.[0]).toEqual({
      revision,
      context: "sandcastle/local-quality",
      state: "error",
      description: "Local quality result stale after head changed",
    });
  });

  it("invalidates a successful result when the Pull Request head changes during checks", async () => {
    const qualityHost = host();
    const qualityGithub = github();
    vi.mocked(qualityGithub.getPullRequestHead)
      .mockResolvedValueOnce(revision)
      .mockResolvedValueOnce(successorRevision);

    await expect(
      checkPullRequestLocalQuality(321, qualityGithub, qualityHost),
    ).resolves.toEqual({
      status: "error",
      stage: "setup",
      output: "Pull Request head changed during local quality checks",
      revision,
    });

    expect(vi.mocked(qualityGithub.publishCommitStatus).mock.calls).toEqual([
      [{
        revision,
        context: "sandcastle/local-quality",
        state: "pending",
        description: "Local quality checks started",
      }],
      [{
        revision,
        context: "sandcastle/local-quality",
        state: "error",
        description: "Local quality result stale after head changed",
      }],
    ]);
    expect(JSON.stringify(vi.mocked(qualityGithub.publishCommitStatus).mock.calls)).not.toContain(
      successorRevision,
    );
  });
});
