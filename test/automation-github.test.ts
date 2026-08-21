import { describe, expect, it, vi } from "vitest";

import { createAutomationGithubPort } from "../.sandcastle/automation-github.js";

const revision = "0123456789abcdef0123456789abcdef01234567";

describe("automation GitHub port", () => {
  it("re-reads PR labels and publishes a review pinned to its acquired commit", async () => {
    const execute = vi.fn()
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          number: 220,
          state: "OPEN",
          isDraft: true,
          baseRepository: { nameWithOwner: "canxer314/obsidian-llm-wiki-cli" },
          headRepository: { nameWithOwner: "canxer314/obsidian-llm-wiki-cli" },
          headRefName: "feedback-branch",
          headRefOid: revision,
          labels: [{ name: "agent:review" }],
        }),
        stderr: "",
      })
      .mockResolvedValueOnce({ stdout: `${revision}\n`, stderr: "" })
      .mockResolvedValueOnce({
        stdout: JSON.stringify([{
          filename: ".sandcastle/review-automation.ts",
          patch: "@@ -92,6 +92,10 @@\n export async function runReviewAutomationCommand(\n+  const review = await reviewer.review();",
        }]),
        stderr: "",
      })
      .mockResolvedValue({ stdout: "", stderr: "" });
    const github = createAutomationGithubPort({ execute });

    await expect(github.readPullRequest(220)).resolves.toEqual({
      number: 220,
      state: "OPEN",
      isDraft: true,
      baseRepository: "canxer314/obsidian-llm-wiki-cli",
      headRepository: "canxer314/obsidian-llm-wiki-cli",
      headRefName: "feedback-branch",
      headSha: revision,
      labels: ["agent:review"],
    });
    await github.publish({
      pullRequestNumber: 220,
      revision,
      review: {
        verdict: "Changes requested",
        summary: "One problem.",
        findings: [{
          summary: "Incorrect boundary",
          details: "The condition excludes the final record.",
          location: { path: ".sandcastle/review-automation.ts", line: 93, side: "RIGHT" },
        }],
      },
    });

    expect(execute).toHaveBeenNthCalledWith(1, "gh", [
      "pr", "view", "220", "--json",
      "number,state,isDraft,baseRepository,headRepository,headRefName,headRefOid,labels",
    ], undefined);
    expect(execute).toHaveBeenNthCalledWith(2, "gh", [
      "pr", "view", "220", "--json", "headRefOid", "--jq", ".headRefOid",
    ], undefined);
    expect(execute).toHaveBeenNthCalledWith(3, "gh", [
      "api", "repos/{owner}/{repo}/pulls/220/files", "--method", "GET", "--paginate",
    ], undefined);
    expect(execute).toHaveBeenLastCalledWith("gh", [
      "api", "repos/{owner}/{repo}/pulls/220/reviews", "--method", "POST",
      "-f", `commit_id=${revision}`, "-f", "event=REQUEST_CHANGES",
      "-f", "body=One problem.\n\n- **Incorrect boundary**: The condition excludes the final record.",
      "-f", "comments[0][path]=.sandcastle/review-automation.ts",
      "-f", "comments[0][line]=93",
      "-f", "comments[0][side]=RIGHT",
      "-f", "comments[0][body]=**Incorrect boundary**: The condition excludes the final record.",
    ], undefined);
  });

  it("reads an ordinary Issue whose REST pull request field is null", async () => {
    const execute = vi.fn()
      .mockResolvedValueOnce({ stdout: JSON.stringify({
        number: 221,
        state: "OPEN",
        labels: [{ name: "agent:implement" }],
        pull_request: null,
      }), stderr: "" })
      .mockResolvedValueOnce({ stdout: `${revision}\n`, stderr: "" });
    const github = createAutomationGithubPort({ execute });

    await expect(github.readIssue(221)).resolves.toEqual({
      number: 221,
      state: "OPEN",
      labels: ["agent:implement"],
      baseRevision: revision,
    });
  });

  it("rejects a Pull Request supplied as an implementation work item", async () => {
    const execute = vi.fn()
      .mockResolvedValueOnce({ stdout: JSON.stringify({
        number: 221,
        state: "OPEN",
        labels: [{ name: "agent:implement" }],
        pull_request: {},
      }), stderr: "" })
      .mockResolvedValueOnce({ stdout: `${revision}\n`, stderr: "" });
    const github = createAutomationGithubPort({ execute });

    await expect(github.readIssue(221)).rejects.toThrow("is a Pull Request");
  });

  it("recognizes exactly one equivalent Draft Pull Request for implementation re-invocation", async () => {
    const execute = vi.fn()
      .mockResolvedValueOnce({ stdout: JSON.stringify({ defaultBranchRef: { name: "master" } }), stderr: "" })
      .mockResolvedValueOnce({ stdout: JSON.stringify([{
        url: "https://example.test/pr/221",
        state: "OPEN",
        isDraft: true,
        baseRefName: "master",
        headRefName: "sandcastle/issue-221",
        body: "Closes #221",
      }]), stderr: "" })
      .mockResolvedValueOnce({ stdout: JSON.stringify([{ ref: "refs/heads/sandcastle/issue-221" }]), stderr: "" });
    const github = createAutomationGithubPort({ execute });

    await expect(github.findReusableImplementation?.({
      issueNumber: 221,
      branch: "sandcastle/issue-221",
    })).resolves.toEqual({
      status: "pull-request",
      branch: "sandcastle/issue-221",
      pullRequestUrl: "https://example.test/pr/221",
    });
  });

  it("recovers Draft Pull Request publication from an existing deterministic branch", async () => {
    const execute = vi.fn()
      .mockResolvedValueOnce({ stdout: JSON.stringify({ defaultBranchRef: { name: "master" } }), stderr: "" })
      .mockResolvedValueOnce({ stdout: "[]", stderr: "" })
      .mockResolvedValueOnce({ stdout: JSON.stringify([{ ref: "refs/heads/sandcastle/issue-221" }]), stderr: "" })
      .mockResolvedValueOnce({ stdout: "https://example.test/pr/221\n", stderr: "" });
    const github = createAutomationGithubPort({ execute });

    await expect(github.findReusableImplementation?.({
      issueNumber: 221,
      branch: "sandcastle/issue-221",
    })).resolves.toEqual({ status: "branch", branch: "sandcastle/issue-221" });
    await expect(github.publishExistingImplementation?.({
      issueNumber: 221,
      branch: "sandcastle/issue-221",
    })).resolves.toEqual({
      branch: "sandcastle/issue-221",
      pullRequestUrl: "https://example.test/pr/221",
    });
  });

  it("rejects a non-equivalent existing implementation Pull Request", async () => {
    const execute = vi.fn()
      .mockResolvedValueOnce({ stdout: JSON.stringify({ defaultBranchRef: { name: "master" } }), stderr: "" })
      .mockResolvedValueOnce({ stdout: JSON.stringify([{
        url: "https://example.test/pr/221",
        state: "OPEN",
        isDraft: false,
        baseRefName: "master",
        headRefName: "sandcastle/issue-221",
        body: "Closes #221",
      }]), stderr: "" })
      .mockResolvedValueOnce({ stdout: JSON.stringify([{ ref: "refs/heads/sandcastle/issue-221" }]), stderr: "" });
    const github = createAutomationGithubPort({ execute });

    await expect(github.findReusableImplementation?.({
      issueNumber: 221,
      branch: "sandcastle/issue-221",
    })).rejects.toThrow("not an upstream-equivalent Draft");
  });

  it("rejects publication if the acquired Pull Request head changed", async () => {
    const github = createAutomationGithubPort({
      execute: vi.fn().mockResolvedValue({ stdout: `${"a".repeat(40)}\n`, stderr: "" }),
    });

    await expect(github.publish({
      pullRequestNumber: 220,
      revision,
      review: { verdict: "Approved", summary: "Looks good.", findings: [] },
    })).rejects.toThrow("Pull Request head changed before review publication");
  });

  it("keeps a non-diff location in the review body without creating an inline comment", async () => {
    const execute = vi.fn()
      .mockResolvedValueOnce({ stdout: `${revision}\n`, stderr: "" })
      .mockResolvedValueOnce({ stdout: "[]", stderr: "" })
      .mockResolvedValue({ stdout: "", stderr: "" });
    const github = createAutomationGithubPort({ execute });

    await github.publish({
      pullRequestNumber: 220,
      revision,
      review: {
        verdict: "Changes requested",
        summary: "One problem.",
        findings: [{
          summary: "Incorrect boundary",
          details: "The condition excludes the final record.",
          location: { path: ".sandcastle/review-automation.ts", line: 96, side: "RIGHT" },
        }],
      },
    });

    expect(execute).toHaveBeenLastCalledWith("gh", expect.not.arrayContaining([
      "-f", "comments[0][path]=.sandcastle/review-automation.ts",
    ]), undefined);
  });

  it("rejects an inline location that GitHub cannot safely identify", async () => {
    const github = createAutomationGithubPort({
      execute: vi.fn()
        .mockResolvedValueOnce({ stdout: `${revision}\n`, stderr: "" })
        .mockResolvedValueOnce({ stdout: "[]", stderr: "" }),
    });

    await expect(github.publish({
      pullRequestNumber: 220,
      revision,
      review: {
        verdict: "Changes requested",
        summary: "One problem.",
        findings: [{
          summary: "Incorrect boundary",
          details: "The condition excludes the final record.",
          location: { path: "../outside.ts", line: 96, side: "RIGHT" },
        }],
      },
    })).rejects.toThrow("Review inline comment location is invalid");
  });
});
