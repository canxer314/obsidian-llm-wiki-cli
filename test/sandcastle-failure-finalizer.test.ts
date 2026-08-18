import { describe, expect, it, vi } from "vitest";

import {
  finalizeFailure,
  type FailureGithubPort,
} from "../.sandcastle/failure-finalizer.js";

function githubPort(): FailureGithubPort {
  return {
    addIssueComment: vi.fn().mockResolvedValue(undefined),
    addPullRequestComment: vi.fn().mockResolvedValue(undefined),
    removeIssueLabel: vi.fn().mockResolvedValue(undefined),
    addIssueLabel: vi.fn().mockResolvedValue(undefined),
  };
}

describe("Sandcastle failure finalization", () => {
  it("publishes a redacted Pull Request diagnosis and migrates the Issue labels", async () => {
    const github = githubPort();
    const secret = `ghp_${"x".repeat(30)}`;
    const bearer = "opaque-session-secret";
    const quoted = "my-private-value";
    const jsonSecret = "json-private-value";

    await expect(finalizeFailure({
      issueNumber: 108,
      pullRequestNumber: 321,
      stage: "local-quality:test",
      revision: "a".repeat(40),
      summary: `Tests failed with token=${secret}\nAuthorization: Bearer ${bearer}\ntoken="${quoted}"\n{"api_key":"${jsonSecret}"}`,
    }, github)).resolves.toEqual({ failures: [] });

    const comment = vi.mocked(github.addPullRequestComment).mock.calls[0]![1];
    expect(comment).toContain("local-quality:test");
    expect(comment).toContain("a".repeat(40));
    expect(comment).toContain("token=[REDACTED]");
    expect(comment).not.toContain(secret);
    expect(comment).not.toContain(bearer);
    expect(comment).not.toContain(quoted);
    expect(comment).not.toContain(jsonSecret);
    expect(github.addIssueComment).not.toHaveBeenCalled();
    expect(github.removeIssueLabel).toHaveBeenCalledWith(108, "Sandcastle");
    expect(github.addIssueLabel).toHaveBeenCalledWith(108, "sandcastle:failed");
  });

  it("uses the open Issue when no verified Pull Request is available", async () => {
    const github = githubPort();

    await finalizeFailure({
      issueNumber: 108,
      stage: "planner",
      summary: "Planner session failed",
    }, github);

    expect(github.addIssueComment).toHaveBeenCalledWith(
      108,
      expect.stringContaining("Planner session failed"),
    );
    expect(github.addPullRequestComment).not.toHaveBeenCalled();
  });

  it("keeps the claim label when adding the failure label fails", async () => {
    const github = githubPort();
    vi.mocked(github.addIssueLabel).mockRejectedValue(new Error("add denied"));

    await expect(finalizeFailure({
      issueNumber: 108,
      stage: "planner",
      summary: "Planner failed",
    }, github)).resolves.toEqual({ failures: ["add-label: add denied"] });

    expect(github.removeIssueLabel).not.toHaveBeenCalled();
  });

  it("attempts every diagnostic operation and reports partial failures", async () => {
    const github = githubPort();
    vi.mocked(github.addIssueComment).mockRejectedValue(new Error("comment denied"));
    vi.mocked(github.removeIssueLabel).mockRejectedValue(new Error("remove denied"));

    await expect(finalizeFailure({
      issueNumber: 108,
      stage: "implementer",
      summary: "Implementer failed",
    }, github)).resolves.toEqual({
      failures: ["comment: comment denied", "remove-label: remove denied"],
    });

    expect(github.addIssueLabel).toHaveBeenCalledWith(108, "sandcastle:failed");
  });
});
