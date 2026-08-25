import { describe, expect, it, vi } from "vitest";

import { createAutomationDispatchGithubPort } from "../.sandcastle/automation-github.js";

describe("Automation Command GitHub discovery", () => {
  const emptyIssueListings = ["agent:implement", "agent:to-issues", "agent:in-progress", "agent:blocked"]
    .map(() => ({ stdout: "[]", stderr: "" }));

  it("discovers trusted Pull Request trigger and state labels with one shared identity", async () => {
    const execute = vi.fn()
      .mockResolvedValueOnce({ stdout: JSON.stringify([{ number: 19, labels: [{ name: "agent:update-branch" }] }]), stderr: "" })
      .mockResolvedValueOnce({ stdout: JSON.stringify([{ number: 20, labels: [{ name: "agent:implement" }] }]), stderr: "" })
      .mockResolvedValueOnce({ stdout: JSON.stringify([{ number: 20, labels: [{ name: "agent:implement" }, { name: "agent:review" }] }]), stderr: "" })
      .mockResolvedValueOnce({ stdout: JSON.stringify([{ number: 21, labels: [{ name: "agent:in-progress" }] }]), stderr: "" })
      .mockResolvedValueOnce({ stdout: JSON.stringify([{ number: 19, labels: [{ name: "agent:update-branch" }, { name: "agent:blocked" }] }]), stderr: "" });
    for (const listing of emptyIssueListings) execute.mockResolvedValueOnce(listing);
    const port = createAutomationDispatchGithubPort({ execute });

    await expect(port.listCommands()).resolves.toEqual([
      { number: 19, operation: "update-branch", identity: "pull-request:19", labels: ["agent:update-branch", "agent:blocked"] },
      { number: 20, operation: "implement", identity: "pull-request:20", labels: ["agent:implement", "agent:review"] },
      { number: 20, operation: "review", identity: "pull-request:20", labels: ["agent:implement", "agent:review"] },
    ]);
    expect(execute).toHaveBeenCalledTimes(9);
    expect(execute).toHaveBeenNthCalledWith(1, "gh", ["pr", "list", "--state", "open", "--label", "agent:update-branch", "--json", "number,labels", "--limit", "100"], undefined);
    expect(execute).toHaveBeenNthCalledWith(2, "gh", ["pr", "list", "--state", "open", "--label", "agent:implement", "--json", "number,labels", "--limit", "100"], undefined);
    expect(execute).toHaveBeenNthCalledWith(3, "gh", ["pr", "list", "--state", "open", "--label", "agent:review", "--json", "number,labels", "--limit", "100"], undefined);
    expect(execute).toHaveBeenNthCalledWith(4, "gh", ["pr", "list", "--state", "open", "--label", "agent:in-progress", "--json", "number,labels", "--limit", "100"], undefined);
    expect(execute).toHaveBeenNthCalledWith(5, "gh", ["pr", "list", "--state", "open", "--label", "agent:blocked", "--json", "number,labels", "--limit", "100"], undefined);
    expect(execute).toHaveBeenNthCalledWith(6, "gh", ["issue", "list", "--state", "open", "--label", "agent:implement", "--json", "number,labels", "--limit", "100"], undefined);
    expect(execute).toHaveBeenNthCalledWith(7, "gh", ["issue", "list", "--state", "open", "--label", "agent:to-issues", "--json", "number,labels", "--limit", "100"], undefined);
    expect(execute).toHaveBeenNthCalledWith(8, "gh", ["issue", "list", "--state", "open", "--label", "agent:in-progress", "--json", "number,labels", "--limit", "100"], undefined);
    expect(execute).toHaveBeenNthCalledWith(9, "gh", ["issue", "list", "--state", "open", "--label", "agent:blocked", "--json", "number,labels", "--limit", "100"], undefined);
  });

  const emptyPullRequestListings = () => Array.from({ length: 5 }, () => ({ stdout: "[]", stderr: "" }));

  function shapeResponse(parent: number | null, subIssueCount: number) {
    return {
      stdout: JSON.stringify({
        ...(parent === null ? { parent: null } : { parent: { number: parent } }),
        subIssues: { totalCount: subIssueCount },
      }),
      stderr: "",
    };
  }

  it("discovers Issue implementation, PRD implementation, and PRD split commands with per-Work-Item identities", async () => {
    const execute = vi.fn();
    for (const listing of emptyPullRequestListings()) execute.mockResolvedValueOnce(listing);
    execute
      // agent:implement Issues: plain, PRD, sub-issue, and one with an open Pull Request
      .mockResolvedValueOnce({
        stdout: JSON.stringify([
          { number: 31, labels: [{ name: "agent:implement" }] },
          { number: 32, labels: [{ name: "agent:implement" }] },
          { number: 33, labels: [{ name: "agent:implement" }] },
          { number: 34, labels: [{ name: "agent:implement" }] },
        ]),
        stderr: "",
      })
      // agent:to-issues Issues
      .mockResolvedValueOnce({ stdout: JSON.stringify([{ number: 35, labels: [{ name: "agent:to-issues" }] }]), stderr: "" })
      .mockResolvedValueOnce({ stdout: "[]", stderr: "" })
      .mockResolvedValueOnce({ stdout: "[]", stderr: "" })
      // shape reads in ascending Issue order
      .mockResolvedValueOnce(shapeResponse(null, 0))
      .mockResolvedValueOnce(shapeResponse(null, 2))
      .mockResolvedValueOnce(shapeResponse(12, 0))
      .mockResolvedValueOnce(shapeResponse(null, 0))
      .mockResolvedValueOnce(shapeResponse(null, 0))
      // open Pull Request checks for the plain implementation candidates
      .mockResolvedValueOnce({ stdout: "[]", stderr: "" })
      .mockResolvedValueOnce({ stdout: JSON.stringify([{ number: 88 }]), stderr: "" });
    const port = createAutomationDispatchGithubPort({ execute });

    await expect(port.listCommands()).resolves.toEqual([
      { number: 31, operation: "implement-issue", identity: "issue:31", labels: ["agent:implement"] },
      { number: 32, operation: "implement-prd", identity: "prd:32", labels: ["agent:implement"] },
      { number: 35, operation: "split-prd", identity: "prd:35", labels: ["agent:to-issues"] },
    ]);
    expect(execute).toHaveBeenCalledTimes(16);
    // Sub-issues and Issues with an open Pull Request are not discovered.
    expect(execute).toHaveBeenNthCalledWith(15, "gh", ["pr", "list", "--head", "sandcastle/issue-31", "--state", "open", "--json", "number", "--limit", "1"], undefined);
    expect(execute).toHaveBeenNthCalledWith(16, "gh", ["pr", "list", "--head", "sandcastle/issue-34", "--state", "open", "--json", "number", "--limit", "1"], undefined);
  });

  it("passes repository template fields to the graphql shape read as -F so gh expands them", async () => {
    // gh 2.46 expands {owner}/{repo} placeholders in -F (typed) field values
    // but not in -f (raw) field values; dispatch discovery failed closed with
    // "Could not resolve to a Repository with the name '{owner}/{repo}'" when
    // the shape read passed them as -f.
    const execute = vi.fn();
    for (const listing of emptyPullRequestListings()) execute.mockResolvedValueOnce(listing);
    execute
      .mockResolvedValueOnce({ stdout: JSON.stringify([{ number: 31, labels: [{ name: "agent:implement" }] }]), stderr: "" })
      .mockResolvedValueOnce({ stdout: "[]", stderr: "" })
      .mockResolvedValueOnce({ stdout: "[]", stderr: "" })
      .mockResolvedValueOnce({ stdout: "[]", stderr: "" })
      .mockResolvedValueOnce(shapeResponse(null, 0))
      .mockResolvedValueOnce({ stdout: "[]", stderr: "" });
    const port = createAutomationDispatchGithubPort({ execute });

    await expect(port.listCommands()).resolves.toEqual([
      { number: 31, operation: "implement-issue", identity: "issue:31", labels: ["agent:implement"] },
    ]);
    expect(execute).toHaveBeenNthCalledWith(10, "gh", [
      "api", "graphql", "-f",
      "query=query($owner:String!,$repo:String!,$number:Int!){repository(owner:$owner,name:$repo){issue(number:$number){parent{number} subIssues(first:1){totalCount}}}}",
      "-F", "owner={owner}", "-F", "repo={repo}", "-F", "number=31",
      "--jq", ".data.repository.issue",
    ], undefined);
  });

  it("discovers only the implementation command when an Issue carries both implementation and split triggers", async () => {
    const execute = vi.fn();
    for (const listing of emptyPullRequestListings()) execute.mockResolvedValueOnce(listing);
    execute
      .mockResolvedValueOnce({
        stdout: JSON.stringify([{ number: 36, labels: [{ name: "agent:implement" }, { name: "agent:to-issues" }] }]),
        stderr: "",
      })
      .mockResolvedValueOnce({
        stdout: JSON.stringify([{ number: 36, labels: [{ name: "agent:implement" }, { name: "agent:to-issues" }] }]),
        stderr: "",
      })
      .mockResolvedValueOnce({ stdout: "[]", stderr: "" })
      .mockResolvedValueOnce({ stdout: "[]", stderr: "" })
      .mockResolvedValueOnce(shapeResponse(null, 0))
      .mockResolvedValueOnce({ stdout: "[]", stderr: "" });
    const port = createAutomationDispatchGithubPort({ execute });

    // Implementation has the higher priority (#219); the split trigger stays
    // for a later round once implementation has consumed its own trigger.
    await expect(port.listCommands()).resolves.toEqual([
      { number: 36, operation: "implement-issue", identity: "issue:36", labels: ["agent:implement", "agent:to-issues"] },
    ]);
  });

  it("fails closed when an Issue command shape is unreadable", async () => {
    const execute = vi.fn();
    for (const listing of emptyPullRequestListings()) execute.mockResolvedValueOnce(listing);
    execute
      .mockResolvedValueOnce({ stdout: JSON.stringify([{ number: 31, labels: [{ name: "agent:implement" }] }]), stderr: "" })
      .mockResolvedValueOnce({ stdout: "[]", stderr: "" })
      .mockResolvedValueOnce({ stdout: "[]", stderr: "" })
      .mockResolvedValueOnce({ stdout: "[]", stderr: "" })
      .mockResolvedValueOnce({ stdout: "null", stderr: "" });
    const port = createAutomationDispatchGithubPort({ execute });

    await expect(port.listCommands()).rejects.toThrow("Issue #31 shape is unreadable");
  });

  it("fails closed when the agent:queued label is missing and sets it up idempotently", async () => {
    const missing = vi.fn().mockResolvedValue({
      stdout: JSON.stringify(["agent:update-branch", "agent:implement", "agent:review", "agent:in-progress", "agent:blocked", "agent:to-issues"].map((name) => ({ name }))),
      stderr: "",
    });
    await expect(createAutomationDispatchGithubPort({ execute: missing }).verifyLabels())
      .rejects.toThrow("Missing required Automation Command label: agent:queued");

    const baseLabels = ["agent:update-branch", "agent:implement", "agent:review", "agent:in-progress", "agent:blocked"];
    const setup = vi.fn()
      .mockResolvedValueOnce({ stdout: JSON.stringify(baseLabels.map((name) => ({ name }))), stderr: "" })
      .mockResolvedValueOnce({ stdout: "", stderr: "" })
      .mockResolvedValueOnce({ stdout: "", stderr: "" })
      .mockResolvedValueOnce({ stdout: JSON.stringify([...baseLabels, "agent:queued", "agent:to-issues"].map((name) => ({ name }))), stderr: "" });
    const port = createAutomationDispatchGithubPort({ execute: setup });
    await port.ensureLabels();
    expect(setup).toHaveBeenCalledWith("gh", ["label", "create", "agent:queued", "--color", "0E8A16"], undefined);
    expect(setup).toHaveBeenCalledWith("gh", ["label", "create", "agent:to-issues", "--color", "0E8A16"], undefined);
    await port.ensureLabels();
    expect(setup).toHaveBeenCalledTimes(4);
  });

  it("lists open queued Issues for promotion", async () => {
    const execute = vi.fn().mockResolvedValue({
      stdout: JSON.stringify([
        { number: 5, labels: [{ name: "agent:queued" }] },
        { number: 9, labels: [{ name: "agent:queued" }, { name: "agent:in-progress" }] },
      ]),
      stderr: "",
    });
    const port = createAutomationDispatchGithubPort({ execute });

    await expect(port.listQueuedIssues()).resolves.toEqual([
      { number: 5, labels: ["agent:queued"] },
      { number: 9, labels: ["agent:queued", "agent:in-progress"] },
    ]);
    expect(execute).toHaveBeenCalledWith(
      "gh", ["issue", "list", "--state", "open", "--label", "agent:queued", "--json", "number,labels", "--limit", "100"], undefined,
    );
  });

  it("reads current labels, parent, and native blocker state for a queued Issue", async () => {
    const execute = vi.fn().mockResolvedValue({
      stdout: JSON.stringify({
        labels: { nodes: [{ name: "agent:queued" }], pageInfo: { hasNextPage: false } },
        parent: { number: 12 },
        blockedBy: { nodes: [{ number: 7, state: "CLOSED" }, { number: 8, state: "OPEN" }], pageInfo: { hasNextPage: false } },
      }),
      stderr: "",
    });
    const port = createAutomationDispatchGithubPort({ execute });

    await expect(port.readPromotionState(5)).resolves.toEqual({
      labels: ["agent:queued"],
      parentNumber: 12,
      blockers: [{ number: 7, state: "CLOSED" }, { number: 8, state: "OPEN" }],
    });
    const [file, arguments_] = execute.mock.calls[0]!;
    expect(file).toBe("gh");
    expect(arguments_[0]).toBe("api");
    expect(arguments_[1]).toBe("graphql");
    expect(arguments_).toContain("-F");
    expect(arguments_).toContain("number=5");
  });

  it("reads a queued Issue without a parent and fails closed when the Issue is unreadable", async () => {
    const execute = vi.fn()
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          labels: { nodes: [{ name: "agent:queued" }], pageInfo: { hasNextPage: false } },
          parent: null,
          blockedBy: { nodes: [], pageInfo: { hasNextPage: false } },
        }),
        stderr: "",
      })
      .mockResolvedValueOnce({ stdout: "null", stderr: "" });
    const port = createAutomationDispatchGithubPort({ execute });

    await expect(port.readPromotionState(5)).resolves.toEqual({ labels: ["agent:queued"], blockers: [] });
    await expect(port.readPromotionState(404)).rejects.toThrow("dependency state is unreadable");
  });

  it("fails closed when blocker or label state is truncated", async () => {
    const execute = vi.fn()
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          labels: { nodes: [{ name: "agent:queued" }], pageInfo: { hasNextPage: false } },
          parent: null,
          blockedBy: { nodes: [{ number: 7, state: "CLOSED" }], pageInfo: { hasNextPage: true } },
        }),
        stderr: "",
      })
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          labels: { nodes: [{ name: "agent:queued" }], pageInfo: { hasNextPage: true } },
          parent: null,
          blockedBy: { nodes: [], pageInfo: { hasNextPage: false } },
        }),
        stderr: "",
      });
    const port = createAutomationDispatchGithubPort({ execute });

    await expect(port.readPromotionState(5)).rejects.toThrow("dependency state is unreadable");
    await expect(port.readPromotionState(5)).rejects.toThrow("dependency state is unreadable");
  });
});
