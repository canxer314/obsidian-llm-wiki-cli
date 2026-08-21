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
        findings: [{ summary: "Incorrect boundary", details: "The condition excludes the final record." }],
      },
    });

    expect(execute).toHaveBeenNthCalledWith(1, "gh", [
      "pr", "view", "220", "--json",
      "number,state,isDraft,baseRepository,headRepository,headRefOid,labels",
    ], undefined);
    expect(execute).toHaveBeenLastCalledWith("gh", [
      "api", "repos/{owner}/{repo}/pulls/220/reviews", "--method", "POST",
      "-f", `commit_id=${revision}`, "-f", "event=REQUEST_CHANGES",
      "-f", "body=One problem.\n\n- **Incorrect boundary**: The condition excludes the final record.",
    ], undefined);
  });
});
