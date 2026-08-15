import { describe, expect, it } from "vitest";
import { createGitHubManagedImplementationPorts } from "../src/github-publication.js";

describe("GitHub Managed PR publication adapter", () => {
  it("finds every open PR closing the ticket regardless of head branch", async () => {
    const calls: string[][] = [];
    const command = async (_file: string, args: string[]): Promise<string> => {
      calls.push(args);
      if (args[0] === "pr" && args[1] === "list") {
        return JSON.stringify([
          {
            number: 7,
            headRefName: "other-implementation",
            baseRefName: "master",
            headRefOid: "b".repeat(40),
            body: "Fixes #65",
          },
          {
            number: 8,
            headRefName: "unrelated",
            baseRefName: "master",
            headRefOid: "c".repeat(40),
            body: "Mentions #65 without closing it",
          },
        ]);
      }
      if (args[0] === "api") return "";
      throw new Error(`unexpected command: ${args.join(" ")}`);
    };
    const ports = createGitHubManagedImplementationPorts({
      repositoryPath: "/repo",
      repository: "owner/repo",
      command,
    });

    const pullRequests = await ports.findOpenPullRequests(65, "afk/65", "master");

    expect(pullRequests.map((pr) => pr.number)).toEqual([7]);
    expect(calls[0]).not.toContain("--head");
  });
});
