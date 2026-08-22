import { describe, expect, it, vi } from "vitest";

import { GithubCliPort, GithubVerificationError } from "../.sandcastle/github-cli.js";

const encodedFile = (filename: string, previousFilename = ""): string =>
  Buffer.from(JSON.stringify([filename, previousFilename])).toString("base64");

describe("Sandcastle GitHub CLI adapter", () => {
  it("verifies the Draft Pull Request against remote branch, Issue, and head state", async () => {
    const pullRequest = {
      number: 321,
      url: "https://github.com/example/repo/pull/321",
      state: "OPEN",
      isDraft: true,
      baseRefName: "master",
      headRefName: "sandcastle/issue-103",
      headRefOid: "abc123",
      body: "Implements the requested behavior.\n\nCloses #103",
    };
    const execute = vi
      .fn()
      .mockResolvedValueOnce({ stdout: '{"nameWithOwner":"example/repo","defaultBranchRef":{"name":"master"}}\n', stderr: "" })
      .mockResolvedValueOnce({ stdout: `${JSON.stringify([pullRequest])}\n`, stderr: "" })
      .mockResolvedValueOnce({ stdout: "103\n", stderr: "" })
      .mockResolvedValueOnce({ stdout: "abc123\n", stderr: "" })
      .mockResolvedValueOnce({
        stdout: `${encodedFile("packages/example/src/index.ts")}\n`,
        stderr: "",
      });
    const github = new GithubCliPort(execute);

    await expect(github.verifyImplementation({
      issueNumber: 103,
      branch: "sandcastle/issue-103",
      expectedHeadSha: "abc123",
      allowsAutomationChanges: false,
    })).resolves.toEqual({
      number: 321,
      url: "https://github.com/example/repo/pull/321",
      headSha: "abc123",
    });

    expect(execute.mock.calls).toEqual([
      ["gh", ["repo", "view", "--json", "nameWithOwner,defaultBranchRef"]],
      ["gh", [
        "pr", "list", "--head", "sandcastle/issue-103", "--state", "all",
        "--json", "number,url,state,isDraft,baseRefName,headRefName,headRefOid,body",
        "--limit", "2",
      ]],
      ["gh", [
        "api", "graphql", "-f",
        "query=query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){closingIssuesReferences(first:100){nodes{number}}}}}",
        "-F", "owner=example", "-F", "name=repo", "-F", "number=321", "--jq",
        ".data.repository.pullRequest.closingIssuesReferences.nodes[].number",
      ]],
      ["gh", [
        "api", "repos/{owner}/{repo}/git/ref/heads/sandcastle/issue-103", "--jq", ".object.sha",
      ]],
      ["gh", [
        "api", "--paginate", "repos/{owner}/{repo}/pulls/321/files", "--jq",
        ".[] | [.filename, (.previous_filename // \"\")] | @base64",
      ]],
    ]);
  });

  it.each([
    { name: "not Draft", change: { isDraft: false } },
    { name: "not open", change: { state: "CLOSED" } },
    { name: "wrong base", change: { baseRefName: "release" } },
    { name: "wrong head branch", change: { headRefName: "other" } },
    { name: "missing closing relationship", change: { body: "Refs #103" } },
    {
      name: "unparsed closing relationship",
      change: {},
      closingIssues: [],
    },
    {
      name: "wrong closing Issue",
      change: { body: "Closes #104" },
      closingIssues: [104],
    },
    { name: "unexpected head SHA", change: { headRefOid: "def456" } },
    {
      name: "out-of-scope Sandcastle change",
      change: {},
      files: [[".sandcastle/main.ts"]],
    },
    {
      name: "out-of-scope workflow change",
      change: {},
      files: [[".github/workflows/quality.yml"]],
    },
    {
      name: "rename from out-of-scope automation",
      change: {},
      files: [[
        "packages/example/src/old-workflow.yml",
        ".github/workflows/quality.yml",
      ]],
    },
  ])("rejects a Pull Request that is $name", async ({ change, files, closingIssues }) => {
    const pullRequest = {
      number: 321,
      url: "https://github.com/example/repo/pull/321",
      state: "OPEN",
      isDraft: true,
      baseRefName: "master",
      headRefName: "sandcastle/issue-103",
      headRefOid: "abc123",
      body: "Closes #103",
      ...change,
    };
    const execute = vi
      .fn()
      .mockResolvedValueOnce({ stdout: '{"nameWithOwner":"example/repo","defaultBranchRef":{"name":"master"}}\n', stderr: "" })
      .mockResolvedValueOnce({ stdout: `${JSON.stringify([pullRequest])}\n`, stderr: "" })
      .mockResolvedValueOnce({
        stdout: `${(closingIssues ?? [103]).join("\n")}\n`,
        stderr: "",
      })
      .mockResolvedValueOnce({ stdout: "abc123\n", stderr: "" })
      .mockResolvedValue({
        stdout: `${(files ?? [["packages/example/src/index.ts"]])
          .map(([filename, previousFilename]) => encodedFile(filename!, previousFilename))
          .join("\n")}\n`,
        stderr: "",
      });
    const github = new GithubCliPort(execute);

    await expect(github.verifyImplementation({
      issueNumber: 103,
      branch: "sandcastle/issue-103",
      expectedHeadSha: "abc123",
      allowsAutomationChanges: false,
    })).rejects.toBeInstanceOf(GithubVerificationError);
  });

  it("rejects a remote branch that advanced after Pull Request metadata was read", async () => {
    const pullRequest = {
      number: 321,
      url: "https://github.com/example/repo/pull/321",
      state: "OPEN",
      isDraft: true,
      baseRefName: "master",
      headRefName: "sandcastle/issue-103",
      headRefOid: "abc123",
      body: "Closes #103",
    };
    const execute = vi
      .fn()
      .mockResolvedValueOnce({ stdout: '{"nameWithOwner":"example/repo","defaultBranchRef":{"name":"master"}}\n', stderr: "" })
      .mockResolvedValueOnce({ stdout: JSON.stringify([pullRequest]), stderr: "" })
      .mockResolvedValueOnce({ stdout: "103\n", stderr: "" })
      .mockResolvedValueOnce({ stdout: "def456\n", stderr: "" });
    const github = new GithubCliPort(execute);

    await expect(github.verifyImplementation({
      issueNumber: 103,
      branch: "sandcastle/issue-103",
      expectedHeadSha: "abc123",
      allowsAutomationChanges: false,
    })).rejects.toBeInstanceOf(GithubVerificationError);

    expect(execute).toHaveBeenCalledTimes(4);
  });

  it("allows automation changes only when the Issue explicitly permits them", async () => {
    const pullRequest = {
      number: 321,
      url: "https://github.com/example/repo/pull/321",
      state: "OPEN",
      isDraft: true,
      baseRefName: "master",
      headRefName: "sandcastle/issue-103",
      headRefOid: "abc123",
      body: "Closes #103",
    };
    const execute = vi
      .fn()
      .mockResolvedValueOnce({ stdout: '{"nameWithOwner":"example/repo","defaultBranchRef":{"name":"master"}}\n', stderr: "" })
      .mockResolvedValueOnce({ stdout: `${JSON.stringify([pullRequest])}\n`, stderr: "" })
      .mockResolvedValueOnce({ stdout: "103\n", stderr: "" })
      .mockResolvedValueOnce({ stdout: "abc123\n", stderr: "" })
      .mockResolvedValueOnce({
        stdout: `${encodedFile(".sandcastle/main.ts")}\n`,
        stderr: "",
      });
    const github = new GithubCliPort(execute);

    await expect(github.verifyImplementation({
      issueNumber: 103,
      branch: "sandcastle/issue-103",
      expectedHeadSha: "abc123",
      allowsAutomationChanges: true,
    })).resolves.toMatchObject({ number: 321, headSha: "abc123" });
  });

  it("rejects missing or duplicate Pull Requests for the deterministic branch", async () => {
    for (const pullRequests of [[], [{ number: 1 }, { number: 2 }]]) {
      const execute = vi
        .fn()
        .mockResolvedValueOnce({ stdout: '{"nameWithOwner":"example/repo","defaultBranchRef":{"name":"master"}}\n', stderr: "" })
        .mockResolvedValueOnce({ stdout: JSON.stringify(pullRequests), stderr: "" });
      const github = new GithubCliPort(execute);

      await expect(github.verifyImplementation({
        issueNumber: 103,
        branch: "sandcastle/issue-103",
        expectedHeadSha: "abc123",
        allowsAutomationChanges: false,
      })).rejects.toBeInstanceOf(GithubVerificationError);
    }
  });
});
