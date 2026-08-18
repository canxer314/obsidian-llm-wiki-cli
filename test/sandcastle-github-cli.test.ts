import { describe, expect, it, vi } from "vitest";

import { GithubCliPort, GithubVerificationError } from "../.sandcastle/github-cli.js";
import type { LocalQualityCommitStatus } from "../.sandcastle/local-quality.js";
import type { ReviewCommitStatus } from "../.sandcastle/review.js";

const encodedFile = (filename: string, previousFilename = ""): string =>
  Buffer.from(JSON.stringify([filename, previousFilename])).toString("base64");

describe("Sandcastle GitHub CLI adapter", () => {
  it("reads the exact Pull Request head SHA", async () => {
    const execute = vi.fn().mockResolvedValue({ stdout: "abc123\n", stderr: "" });
    const github = new GithubCliPort(execute);

    await expect(github.getPullRequestHead(321)).resolves.toBe("abc123");
    expect(execute).toHaveBeenCalledWith("gh", [
      "pr", "view", "321", "--json", "headRefOid", "--jq", ".headRefOid",
    ]);
  });

  it("publishes local quality status to the requested commit SHA", async () => {
    const execute = vi.fn().mockResolvedValue({ stdout: "", stderr: "" });
    const github = new GithubCliPort(execute);
    const status: LocalQualityCommitStatus = {
      revision: "abc123",
      context: "sandcastle/local-quality",
      state: "pending",
      description: "Local quality checks started",
    };

    await github.publishCommitStatus(status);

    expect(execute).toHaveBeenCalledWith("gh", [
      "api", "repos/{owner}/{repo}/statuses/abc123", "--method", "POST",
      "-f", "context=sandcastle/local-quality", "-f", "state=pending",
      "-f", "description=Local quality checks started",
    ]);
  });

  it("publishes review status and a regular Pull Request comment", async () => {
    const execute = vi.fn().mockResolvedValue({ stdout: "", stderr: "" });
    const github = new GithubCliPort(execute);
    const status: ReviewCommitStatus = {
      revision: "abc123",
      context: "sandcastle/review",
      state: "failure",
      description: "Independent review requested changes",
    };

    await github.publishCommitStatus(status);
    await github.addPullRequestComment(321, "## Sandcastle review: Changes requested");

    expect(execute.mock.calls).toEqual([
      ["gh", [
        "api", "repos/{owner}/{repo}/statuses/abc123", "--method", "POST",
        "-f", "context=sandcastle/review", "-f", "state=failure",
        "-f", "description=Independent review requested changes",
      ]],
      ["gh", [
        "pr", "comment", "321", "--body", "## Sandcastle review: Changes requested",
      ]],
    ]);
  });

  it("creates and pushes a clean merge commit from the latest target and Pull Request heads", async () => {
    const oldHead = "a".repeat(40);
    const targetHead = "b".repeat(40);
    const tree = "c".repeat(40);
    const mergedHead = "d".repeat(40);
    const execute = vi.fn()
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          baseRefName: "master",
          headRefName: "sandcastle/issue-109",
          headRefOid: oldHead,
        }),
        stderr: "",
      })
      .mockResolvedValueOnce({ stdout: `${targetHead}\n`, stderr: "" })
      .mockResolvedValueOnce({ stdout: "", stderr: "" })
      .mockResolvedValueOnce({ stdout: `${targetHead}\n`, stderr: "" })
      .mockResolvedValueOnce({ stdout: "", stderr: "" })
      .mockResolvedValueOnce({ stdout: `${oldHead}\n`, stderr: "" })
      .mockRejectedValueOnce(Object.assign(new Error("not ancestor"), { code: 1 }))
      .mockResolvedValueOnce({ stdout: `${tree}\n`, stderr: "" })
      .mockResolvedValueOnce({ stdout: `${mergedHead}\n`, stderr: "" })
      .mockResolvedValueOnce({ stdout: "", stderr: "" })
      .mockResolvedValueOnce({ stdout: `${mergedHead}\n`, stderr: "" });
    const github = new GithubCliPort(execute);

    await expect(github.synchronizePullRequest({
      number: 321,
      url: "https://github.com/example/repo/pull/321",
      headSha: oldHead,
    })).resolves.toEqual({
      status: "synced",
      pullRequest: {
        number: 321,
        url: "https://github.com/example/repo/pull/321",
        headSha: mergedHead,
      },
    });

    expect(execute.mock.calls).toEqual([
      ["gh", ["pr", "view", "321", "--json", "baseRefName,headRefName,headRefOid"]],
      ["gh", ["api", "repos/{owner}/{repo}/git/ref/heads/master", "--jq", ".object.sha"]],
      ["git", ["fetch", "--no-tags", "origin", "refs/heads/master"]],
      ["git", ["rev-parse", "FETCH_HEAD"]],
      ["git", ["fetch", "--no-tags", "origin", "refs/heads/sandcastle/issue-109"]],
      ["git", ["rev-parse", "FETCH_HEAD"]],
      ["git", ["merge-base", "--is-ancestor", targetHead, oldHead]],
      ["git", ["merge-tree", "--write-tree", oldHead, targetHead]],
      ["git", ["commit-tree", tree, "-p", oldHead, "-p", targetHead, "-m", "Merge master into sandcastle/issue-109"]],
      ["git", ["push", "origin", `${mergedHead}:refs/heads/sandcastle/issue-109`]],
      ["gh", ["pr", "view", "321", "--json", "headRefOid", "--jq", ".headRefOid"]],
    ]);
  });

  it("skips synchronization when the target is already in the Pull Request history", async () => {
    const head = "a".repeat(40);
    const target = "b".repeat(40);
    const execute = vi.fn()
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          baseRefName: "master",
          headRefName: "sandcastle/issue-109",
          headRefOid: head,
        }),
        stderr: "",
      })
      .mockResolvedValueOnce({ stdout: `${target}\n`, stderr: "" })
      .mockResolvedValueOnce({ stdout: "", stderr: "" })
      .mockResolvedValueOnce({ stdout: `${target}\n`, stderr: "" })
      .mockResolvedValueOnce({ stdout: "", stderr: "" })
      .mockResolvedValueOnce({ stdout: `${head}\n`, stderr: "" })
      .mockResolvedValueOnce({ stdout: "", stderr: "" });
    const github = new GithubCliPort(execute);
    const pullRequest = {
      number: 321,
      url: "https://github.com/example/repo/pull/321",
      headSha: head,
    };

    await expect(github.synchronizePullRequest(pullRequest)).resolves.toEqual({
      status: "unchanged",
      pullRequest,
    });
    expect(execute).not.toHaveBeenCalledWith("git", expect.arrayContaining(["push"]));
  });

  it("detects an outdated target without pushing when synchronization is bounded", async () => {
    const head = "a".repeat(40);
    const target = "b".repeat(40);
    const execute = vi.fn()
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          baseRefName: "master",
          headRefName: "sandcastle/issue-109",
          headRefOid: head,
        }),
        stderr: "",
      })
      .mockResolvedValueOnce({ stdout: `${target}\n`, stderr: "" })
      .mockResolvedValueOnce({ stdout: "", stderr: "" })
      .mockResolvedValueOnce({ stdout: `${target}\n`, stderr: "" })
      .mockResolvedValueOnce({ stdout: "", stderr: "" })
      .mockResolvedValueOnce({ stdout: `${head}\n`, stderr: "" })
      .mockRejectedValueOnce(Object.assign(new Error("not ancestor"), { code: 1 }));
    const github = new GithubCliPort(execute);
    const pullRequest = {
      number: 321,
      url: "https://github.com/example/repo/pull/321",
      headSha: head,
    };

    await expect(github.synchronizePullRequest(pullRequest, false)).resolves.toEqual({
      status: "outdated",
      pullRequest,
    });
    expect(execute).not.toHaveBeenCalledWith("git", expect.arrayContaining(["merge-tree"]));
    expect(execute).not.toHaveBeenCalledWith("git", expect.arrayContaining(["push"]));
  });

  it("reports a real merge conflict without creating or pushing a commit", async () => {
    const head = "a".repeat(40);
    const target = "b".repeat(40);
    const execute = vi.fn()
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          baseRefName: "master",
          headRefName: "sandcastle/issue-109",
          headRefOid: head,
        }),
        stderr: "",
      })
      .mockResolvedValueOnce({ stdout: `${target}\n`, stderr: "" })
      .mockResolvedValueOnce({ stdout: "", stderr: "" })
      .mockResolvedValueOnce({ stdout: `${target}\n`, stderr: "" })
      .mockResolvedValueOnce({ stdout: "", stderr: "" })
      .mockResolvedValueOnce({ stdout: `${head}\n`, stderr: "" })
      .mockRejectedValueOnce(Object.assign(new Error("not ancestor"), { code: 1 }))
      .mockRejectedValueOnce(Object.assign(new Error("CONFLICT"), { code: 1 }));
    const github = new GithubCliPort(execute);
    const pullRequest = {
      number: 321,
      url: "https://github.com/example/repo/pull/321",
      headSha: head,
    };

    await expect(github.synchronizePullRequest(pullRequest)).resolves.toEqual({
      status: "conflict",
      pullRequest,
      summary: "Target master conflicts with sandcastle/issue-109",
    });
    expect(execute).not.toHaveBeenCalledWith("git", expect.arrayContaining(["commit-tree"]));
    expect(execute).not.toHaveBeenCalledWith("git", expect.arrayContaining(["push"]));
  });

  it("rejects a target or Pull Request race discovered while fetching", async () => {
    const head = "a".repeat(40);
    const target = "b".repeat(40);
    const changedTarget = "c".repeat(40);
    const execute = vi.fn()
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          baseRefName: "master",
          headRefName: "sandcastle/issue-109",
          headRefOid: head,
        }),
        stderr: "",
      })
      .mockResolvedValueOnce({ stdout: `${target}\n`, stderr: "" })
      .mockResolvedValueOnce({ stdout: "", stderr: "" })
      .mockResolvedValueOnce({ stdout: `${changedTarget}\n`, stderr: "" })
      .mockResolvedValueOnce({ stdout: "", stderr: "" })
      .mockResolvedValueOnce({ stdout: `${head}\n`, stderr: "" });
    const github = new GithubCliPort(execute);

    await expect(github.synchronizePullRequest({
      number: 321,
      url: "https://github.com/example/repo/pull/321",
      headSha: head,
    })).rejects.toThrow("Target or Pull Request head changed during fetch");
    expect(execute).not.toHaveBeenCalledWith("git", expect.arrayContaining(["push"]));
  });

  it("atomically creates the deterministic remote branch from the default branch", async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce({ stdout: "[]\n", stderr: "" })
      .mockResolvedValueOnce({ stdout: "abc123\n", stderr: "" })
      .mockResolvedValueOnce({ stdout: "", stderr: "" })
      .mockResolvedValueOnce({ stdout: "", stderr: "" })
      .mockResolvedValueOnce({ stdout: "", stderr: "" });
    const github = new GithubCliPort(execute);

    await expect(github.claimIssue(102)).resolves.toBe(true);

    expect(execute.mock.calls).toEqual([
      [
        "gh",
        [
          "pr",
          "list",
          "--head",
          "sandcastle/issue-102",
          "--state",
          "all",
          "--json",
          "number",
          "--limit",
          "1",
        ],
      ],
      [
        "gh",
        ["api", "repos/{owner}/{repo}/commits/HEAD", "--jq", ".sha"],
      ],
      [
        "gh",
        [
          "api",
          "repos/{owner}/{repo}/git/refs",
          "--method",
          "POST",
          "-f",
          "ref=refs/heads/sandcastle/issue-102",
          "-f",
          "sha=abc123",
        ],
      ],
      [
        "git",
        [
          "fetch",
          "--no-tags",
          "origin",
          "refs/heads/sandcastle/issue-102:refs/remotes/origin/sandcastle/issue-102",
        ],
      ],
      [
        "git",
        ["branch", "--force", "sandcastle/issue-102", "origin/sandcastle/issue-102"],
      ],
    ]);
  });

  it("fails the claim when an existing local branch cannot be aligned to the claimed remote ref", async () => {
    const checkedOut = new Error("fatal: cannot force update the branch checked out at another worktree");
    const execute = vi
      .fn()
      .mockResolvedValueOnce({ stdout: "[]\n", stderr: "" })
      .mockResolvedValueOnce({ stdout: "abc123\n", stderr: "" })
      .mockResolvedValueOnce({ stdout: "", stderr: "" })
      .mockResolvedValueOnce({ stdout: "", stderr: "" })
      .mockRejectedValueOnce(checkedOut);
    const github = new GithubCliPort(execute);

    await expect(github.claimIssue(102)).rejects.toBe(checkedOut);
  });

  it("skips a target with an associated Pull Request", async () => {
    const execute = vi.fn().mockResolvedValue({
      stdout: '[{"number":321}]\n',
      stderr: "",
    });
    const github = new GithubCliPort(execute);

    await expect(github.claimIssue(102)).resolves.toBe(false);

    expect(execute).toHaveBeenCalledOnce();
  });

  it("skips a target whose deterministic remote branch already exists", async () => {
    const conflict = Object.assign(new Error("gh api failed"), {
      stderr: "gh: Reference already exists (HTTP 422)\n",
    });
    const execute = vi
      .fn()
      .mockResolvedValueOnce({ stdout: "[]\n", stderr: "" })
      .mockResolvedValueOnce({ stdout: "abc123\n", stderr: "" })
      .mockRejectedValueOnce(conflict);
    const github = new GithubCliPort(execute);

    await expect(github.claimIssue(102)).resolves.toBe(false);
  });

  it("allows only one concurrent runner to claim the same target", async () => {
    let created = false;
    const execute = vi.fn(async (_file: string, arguments_: readonly string[]) => {
      if (arguments_[0] === "pr") return { stdout: "[]\n", stderr: "" };
      if (arguments_[0] === "api" && arguments_[1]?.endsWith("/commits/HEAD")) {
        return { stdout: "abc123\n", stderr: "" };
      }
      if (_file === "git") return { stdout: "", stderr: "" };
      await Promise.resolve();
      if (created) {
        throw Object.assign(new Error("gh api failed"), {
          stderr: "gh: Reference already exists (HTTP 422)\n",
        });
      }
      created = true;
      return { stdout: "", stderr: "" };
    });
    const first = new GithubCliPort(execute);
    const second = new GithubCliPort(execute);

    await expect(
      Promise.all([first.claimIssue(102), second.claimIssue(102)]),
    ).resolves.toEqual([true, false]);
  });

  it("does not hide unrelated remote branch creation failures", async () => {
    const failure = Object.assign(new Error("gh api failed"), {
      stderr: "gh: API rate limit exceeded (HTTP 403)\n",
    });
    const execute = vi
      .fn()
      .mockResolvedValueOnce({ stdout: "[]\n", stderr: "" })
      .mockResolvedValueOnce({ stdout: "abc123\n", stderr: "" })
      .mockRejectedValueOnce(failure);
    const github = new GithubCliPort(execute);

    await expect(github.claimIssue(102)).rejects.toBe(failure);
  });

  it("publishes Issue diagnostics and edits failure labels", async () => {
    const execute = vi.fn().mockResolvedValue({ stdout: "", stderr: "" });
    const github = new GithubCliPort(execute);

    await github.addIssueComment(108, "diagnosis");
    await github.removeIssueLabel(108, "Sandcastle");
    await github.addIssueLabel(108, "sandcastle:failed");

    expect(execute.mock.calls).toEqual([
      ["gh", ["issue", "comment", "108", "--body", "diagnosis"]],
      ["gh", ["issue", "edit", "108", "--remove-label", "Sandcastle"]],
      ["gh", ["issue", "edit", "108", "--add-label", "sandcastle:failed"]],
    ]);
  });

  it("idempotently creates or updates the failure label", async () => {
    const execute = vi.fn().mockResolvedValue({ stdout: "", stderr: "" });
    const github = new GithubCliPort(execute);

    await github.ensureLabel("sandcastle:failed");

    expect(execute).toHaveBeenCalledWith("gh", [
      "label",
      "create",
      "sandcastle:failed",
      "--color",
      "B60205",
      "--description",
      "Sandcastle automation could not complete this Issue",
      "--force",
    ]);
  });

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
