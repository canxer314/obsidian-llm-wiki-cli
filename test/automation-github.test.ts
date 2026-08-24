import { describe, expect, it, vi } from "vitest";

import { createAutomationGithubPort } from "../.sandcastle/automation-github.js";

const revision = "0123456789abcdef0123456789abcdef01234567";

describe("automation GitHub port", () => {
  it("publishes ordered self-contained child Issues with parent and dependency relationships", async () => {
    const execute = vi.fn()
      .mockResolvedValueOnce({ stdout: "https://example.test/issues/301\n", stderr: "" })
      .mockResolvedValueOnce({ stdout: "3010\n", stderr: "" })
      .mockResolvedValueOnce({ stdout: "", stderr: "" })
      .mockResolvedValueOnce({ stdout: "https://example.test/issues/302\n", stderr: "" })
      .mockResolvedValueOnce({ stdout: "3020\n", stderr: "" })
      .mockResolvedValue({ stdout: "", stderr: "" });
    const github = createAutomationGithubPort({ execute });

    await expect(github.publishPrdSplit({
      prdNumber: 223,
      slices: [
        { title: "Prepare vertical path", whatToBuild: "Build the initial path.", acceptanceCriteria: ["Initial path works"] },
        { title: "Extend vertical path", whatToBuild: "Extend the path.", acceptanceCriteria: ["Extension works"] },
      ],
    })).resolves.toEqual([301, 302]);

    expect(execute).toHaveBeenNthCalledWith(3, "gh", [
      "api", "-X", "POST", "repos/{owner}/{repo}/issues/223/sub_issues", "-F", "sub_issue_id=3010",
    ], undefined);
    expect(execute).toHaveBeenNthCalledWith(6, "gh", [
      "api", "-X", "POST", "repos/{owner}/{repo}/issues/223/sub_issues", "-F", "sub_issue_id=3020",
    ], undefined);
    expect(execute).toHaveBeenNthCalledWith(7, "gh", [
      "api", "-X", "POST", "repos/{owner}/{repo}/issues/302/dependencies/blocked_by", "-F", "issue_id=3010",
    ], undefined);
  });

  it("normalizes lowercase REST issue states for command refusal checks", async () => {
    const execute = vi.fn()
      .mockResolvedValueOnce({ stdout: JSON.stringify({
        number: 221,
        state: "open",
        labels: [{ name: "agent:implement" }],
        pull_request: null,
      }), stderr: "" })
      .mockResolvedValueOnce({ stdout: `${revision}\n`, stderr: "" });
    const github = createAutomationGithubPort({ execute });

    await expect(github.readIssue(221)).resolves.toEqual(expect.objectContaining({ state: "OPEN" }));
  });

  it("counts all PRD sub-issues across REST pages", async () => {
    const execute = vi.fn()
      .mockResolvedValueOnce({ stdout: JSON.stringify({
        number: 226,
        title: "A PRD",
        state: "open",
        labels: [{ name: "agent:implement" }],
        pull_request: null,
      }), stderr: "" })
      .mockResolvedValueOnce({ stdout: `${revision}\n`, stderr: "" })
      .mockResolvedValueOnce({ stdout: "1\n".repeat(47), stderr: "" })
      .mockResolvedValueOnce({ stdout: "", stderr: "" });
    const github = createAutomationGithubPort({ execute });

    await expect(github.readPrd(226)).resolves.toEqual({
      number: 226,
      title: "A PRD",
      state: "OPEN",
      labels: ["agent:implement"],
      baseRevision: revision,
      subIssueCount: 47,
    });

    expect(execute).toHaveBeenNthCalledWith(3, "gh", [
      "api", "repos/{owner}/{repo}/issues/226/sub_issues", "--paginate", "--jq", ".[] | 1",
    ], undefined);
  });

  it("lists PRD children in order with open blockers and nested sub-issue counts", async () => {
    const execute = vi.fn()
      .mockResolvedValueOnce({
        stdout: '{"number":301,"title":"First","state":"closed"}\n{"number":302,"title":"Second","state":"open"}\n',
        stderr: "",
      })
      .mockResolvedValueOnce({ stdout: '{"blockedBy":0,"subIssues":0}', stderr: "" })
      .mockResolvedValueOnce({ stdout: '{"blockedBy":1,"subIssues":2}', stderr: "" });
    const github = createAutomationGithubPort({ execute });

    await expect(github.listChildren(226)).resolves.toEqual([
      { number: 301, title: "First", state: "CLOSED", openBlockerCount: 0, subIssueCount: 0 },
      { number: 302, title: "Second", state: "OPEN", openBlockerCount: 1, subIssueCount: 2 },
    ]);

    expect(execute).toHaveBeenNthCalledWith(1, "gh", [
      "api", "repos/{owner}/{repo}/issues/226/sub_issues", "--paginate", "--jq", ".[] | {number, title, state}",
    ], undefined);
    expect(execute).toHaveBeenNthCalledWith(2, "gh", [
      "api", "repos/{owner}/{repo}/issues/301", "--jq",
      "{blockedBy: (.issue_dependencies_summary.blocked_by // 0), subIssues: (.sub_issues_summary.total // 0)}",
    ], undefined);
  });

  it("closes an implemented child with its revision and PRD relationship", async () => {
    const execute = vi.fn().mockResolvedValue({ stdout: "", stderr: "" });
    const github = createAutomationGithubPort({ execute });

    await github.closeImplementedChild({ prdNumber: 226, childNumber: 301, revision });

    expect(execute).toHaveBeenCalledWith("gh", [
      "issue", "close", "301", "--comment", `Implemented in ${revision}. Part of #226.`,
    ], undefined);
  });

  it("reuses the existing upstream-equivalent Draft Pull Request for a PRD branch", async () => {
    const execute = vi.fn()
      .mockResolvedValueOnce({ stdout: JSON.stringify({ defaultBranchRef: { name: "master" } }), stderr: "" })
      .mockResolvedValueOnce({ stdout: JSON.stringify([{
        number: 401,
        url: "https://example.test/pull/401",
        isDraft: true,
        baseRefName: "master",
        headRefName: "sandcastle/prd-226",
        headRefOid: revision,
      }]), stderr: "" });
    const github = createAutomationGithubPort({ execute });

    await expect(github.ensurePrdDraftPullRequest({
      prdNumber: 226,
      branch: "sandcastle/prd-226",
      headSha: revision,
    })).resolves.toEqual({ number: 401, url: "https://example.test/pull/401" });

    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("rejects an existing PRD Pull Request whose head does not match the Implementer commit", async () => {
    const execute = vi.fn()
      .mockResolvedValueOnce({ stdout: JSON.stringify({ defaultBranchRef: { name: "master" } }), stderr: "" })
      .mockResolvedValueOnce({ stdout: JSON.stringify([{
        number: 401,
        url: "https://example.test/pull/401",
        isDraft: true,
        baseRefName: "master",
        headRefName: "sandcastle/prd-226",
        headRefOid: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      }]), stderr: "" });
    const github = createAutomationGithubPort({ execute });

    await expect(github.ensurePrdDraftPullRequest({
      prdNumber: 226,
      branch: "sandcastle/prd-226",
      headSha: revision,
    })).rejects.toThrow("head does not match the Implementer commit");
  });

  it("creates the PRD Draft Pull Request with its PRD relationship and verifies the published head", async () => {
    const execute = vi.fn()
      .mockResolvedValueOnce({ stdout: JSON.stringify({ defaultBranchRef: { name: "master" } }), stderr: "" })
      .mockResolvedValueOnce({ stdout: "[]", stderr: "" })
      .mockResolvedValueOnce({ stdout: "https://example.test/pull/401\n", stderr: "" })
      .mockResolvedValueOnce({ stdout: `${revision}\n`, stderr: "" });
    const github = createAutomationGithubPort({ execute });

    await expect(github.ensurePrdDraftPullRequest({
      prdNumber: 226,
      branch: "sandcastle/prd-226",
      headSha: revision,
    })).resolves.toEqual({ number: 401, url: "https://example.test/pull/401" });

    expect(execute).toHaveBeenNthCalledWith(3, "gh", [
      "pr", "create", "--draft", "--head", "sandcastle/prd-226",
      "--title", "Implement #226", "--body", "Part of #226",
    ], undefined);
    expect(execute).toHaveBeenNthCalledWith(4, "gh", [
      "pr", "view", "401", "--json", "headRefOid", "--jq", ".headRefOid",
    ], undefined);
  });

  it("rejects creating a PRD Pull Request when the branch head moved before publication", async () => {
    const execute = vi.fn()
      .mockResolvedValueOnce({ stdout: JSON.stringify({ defaultBranchRef: { name: "master" } }), stderr: "" })
      .mockResolvedValueOnce({ stdout: "[]", stderr: "" })
      .mockResolvedValueOnce({ stdout: "https://example.test/pull/401\n", stderr: "" })
      .mockResolvedValueOnce({ stdout: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\n", stderr: "" });
    const github = createAutomationGithubPort({ execute });

    await expect(github.ensurePrdDraftPullRequest({
      prdNumber: 226,
      branch: "sandcastle/prd-226",
      headSha: revision,
    })).rejects.toThrow("head changed before Pull Request publication");
  });

  it("publishes classified PRD implementation and child failure diagnostics", async () => {
    const execute = vi.fn().mockResolvedValue({ stdout: "", stderr: "" });
    const github = createAutomationGithubPort({ execute });

    await github.addPrdImplementationBlockedDiagnostic(226, {
      reason: "prd-implementation-execution",
      jobId: "job-226",
      summary: "push failed",
      childNumber: 301,
    });
    await github.addChildFailureDiagnostic(301, { prdNumber: 226, jobId: "job-226" });

    expect(execute).toHaveBeenNthCalledWith(1, "gh", [
      "issue", "comment", "226", "--body",
      "Automation PRD implementation is blocked (prd-implementation-execution; job job-226; push failed) while implementing sub-issue #301. Local diagnostics are retained at .sandcastle/jobs/prd-implementation-job-226. Remove agent:blocked, restore agent:implement, then retry.",
    ], undefined);
    expect(execute).toHaveBeenNthCalledWith(2, "gh", [
      "issue", "comment", "301", "--body",
      "Implementation attempt failed (job job-226). See PRD #226 for status.",
    ], undefined);
  });

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
    await github.publishReview({
      pullRequestNumber: 220,
      revision,
      review: {
        summary: "One problem.",
        inlineComments: [{ path: ".sandcastle/review-automation.ts", line: 93, body: "Incorrect boundary." }],
        replies: [],
      },
    });
    await github.markPullRequestReady(220);

    expect(execute).toHaveBeenNthCalledWith(1, "gh", [
      "pr", "view", "220", "--json",
      "number,state,isDraft,baseRepository,headRepository,baseRefName,headRefName,headRefOid,labels",
    ], undefined);
    expect(execute).toHaveBeenNthCalledWith(2, "gh", [
      "pr", "view", "220", "--json", "headRefOid", "--jq", ".headRefOid",
    ], undefined);
    expect(execute).toHaveBeenNthCalledWith(3, "gh", [
      "api", "repos/{owner}/{repo}/pulls/220/files", "--method", "GET", "--paginate",
    ], undefined);
    expect(execute).toHaveBeenLastCalledWith("gh", ["pr", "ready", "220"], undefined);
    expect(execute).toHaveBeenNthCalledWith(4, "gh", [
      "api", "repos/{owner}/{repo}/pulls/220/reviews", "--method", "POST",
      "-f", `commit_id=${revision}`, "-f", "event=COMMENT",
      "-f", "body=One problem.",
      "-f", "comments[0][path]=.sandcastle/review-automation.ts",
      "-f", "comments[0][line]=93",
      "-f", "comments[0][side]=RIGHT",
      "-f", "comments[0][body]=Incorrect boundary.",
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

    await expect(github.publishReview({
      pullRequestNumber: 220,
      revision,
      review: { summary: "Looks good.", inlineComments: [], replies: [] },
    })).rejects.toThrow("Pull Request head changed before review publication");
  });

  it("keeps a non-diff location in the review body without creating an inline comment", async () => {
    const execute = vi.fn()
      .mockResolvedValueOnce({ stdout: `${revision}\n`, stderr: "" })
      .mockResolvedValueOnce({ stdout: "[]", stderr: "" })
      .mockResolvedValue({ stdout: "", stderr: "" });
    const github = createAutomationGithubPort({ execute });

    await github.publishReview({
      pullRequestNumber: 220,
      revision,
      review: {
        summary: "One problem.",
        inlineComments: [{ path: ".sandcastle/review-automation.ts", line: 96, body: "Not in the diff." }],
        replies: [],
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

    await expect(github.publishReview({
      pullRequestNumber: 220,
      revision,
      review: {
        summary: "One problem.",
        inlineComments: [{ path: "../outside.ts", line: 96, body: "Invalid path." }],
        replies: [],
      },
    })).rejects.toThrow("Review inline comment location is invalid");
  });

  it("counts the open architecture-review backlog with the upstream limit", async () => {
    const execute = vi.fn().mockResolvedValue({ stdout: "3\n", stderr: "" });
    const github = createAutomationGithubPort({ execute });

    await expect(github.countOpenArchitectureReviewProposals()).resolves.toBe(3);
    expect(execute).toHaveBeenCalledWith("gh", [
      "issue", "list", "--state", "open", "--label", "source:architecture-review",
      "--limit", "10", "--json", "number", "--jq", "length",
    ], undefined);
  });

  it("lists prior architecture-review proposals across all states", async () => {
    const proposals = [
      { number: 101, title: "Deepen the vault index", state: "CLOSED", body: "Prior body" },
      { number: 108, title: "Deepen the search indexer", state: "OPEN", body: "Open body" },
    ];
    const execute = vi.fn().mockResolvedValue({ stdout: JSON.stringify(proposals), stderr: "" });
    const github = createAutomationGithubPort({ execute });

    await expect(github.listArchitectureReviewProposals()).resolves.toEqual(proposals);
    expect(execute).toHaveBeenCalledWith("gh", [
      "issue", "list", "--state", "all", "--label", "source:architecture-review",
      "--limit", "200", "--json", "number,title,state,body",
    ], undefined);
  });

  it("reads the trusted base revision", async () => {
    const execute = vi.fn().mockResolvedValue({ stdout: `${revision}\n`, stderr: "" });
    const github = createAutomationGithubPort({ execute });

    await expect(github.readBaseRevision()).resolves.toBe(revision);
    expect(execute).toHaveBeenCalledWith("gh", [
      "api", "repos/{owner}/{repo}/commits/HEAD", "--jq", ".sha",
    ], undefined);
  });

  it("publishes an accepted proposal with the upstream architecture source label", async () => {
    const execute = vi.fn()
      .mockResolvedValueOnce({ stdout: "", stderr: "" })
      .mockResolvedValueOnce({ stdout: "https://example.test/issues/240\n", stderr: "" });
    const github = createAutomationGithubPort({ execute });

    await expect(github.publishArchitectureProposal({
      title: "Deepen the search indexer",
      body: "## Architecture review\n\n...",
    })).resolves.toEqual({ issueNumber: 240, issueUrl: "https://example.test/issues/240" });

    expect(execute).toHaveBeenNthCalledWith(1, "gh", [
      "label", "create", "source:architecture-review", "--color", "5319E7",
      "--description", "PRDs proposed by the automated architecture-review workflow",
    ], undefined);
    expect(execute).toHaveBeenNthCalledWith(2, "gh", [
      "issue", "create", "--title", "Deepen the search indexer",
      "--body", "## Architecture review\n\n...", "--label", "source:architecture-review",
    ], undefined);
  });

  it("tolerates an already-existing architecture source label at publication", async () => {
    const execute = vi.fn()
      .mockRejectedValueOnce(new Error("label already exists"))
      .mockResolvedValueOnce({ stdout: "https://example.test/issues/241\n", stderr: "" });
    const github = createAutomationGithubPort({ execute });

    await expect(github.publishArchitectureProposal({
      title: "Deepen the search indexer",
      body: "body",
    })).resolves.toEqual({ issueNumber: 241, issueUrl: "https://example.test/issues/241" });
  });

  it("resolves a GraphQL node ID before posting a thread reply", async () => {
    const execute = vi.fn()
      .mockResolvedValueOnce({ stdout: "12345\n", stderr: "" })
      .mockResolvedValueOnce({ stdout: "", stderr: "" });
    const github = createAutomationGithubPort({ execute });

    await github.replyToReviewThread({ pullRequestNumber: 220, reply: { commentId: "PRRC_1", body: "Fixed." } });

    expect(execute).toHaveBeenNthCalledWith(1, "gh", expect.arrayContaining(["api", "graphql", "-F", "id=PRRC_1"]), undefined);
    expect(execute).toHaveBeenNthCalledWith(2, "gh", [
      "api", "repos/{owner}/{repo}/pulls/220/comments/12345/replies", "--method", "POST", "-f", "body=Fixed.",
    ], undefined);
  });
});
