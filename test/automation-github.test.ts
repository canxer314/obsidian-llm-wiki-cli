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
      "number,state,isDraft,baseRepository,headRepository,headRefOid,labels",
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
