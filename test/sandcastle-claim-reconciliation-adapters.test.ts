import { describe, expect, it, vi } from "vitest";

import {
  ClaimReadError,
  DockerClaimReadAdapter,
  GitClaimReadAdapter,
  GithubClaimReadAdapter,
  type ReadCommand,
} from "../.sandcastle/claim-reconciliation-adapters.ts";

const BASE = "a".repeat(40);
const HEAD = "b".repeat(40);
const input = {
  repository: "example/repository",
  issueNumber: 208,
  branch: "sandcastle/issue-208",
  comparisonBaseSha: BASE,
} as const;

function command(...outputs: readonly string[]): ReadCommand {
  let index = 0;
  return vi.fn().mockImplementation(async () => ({
    stdout: outputs[index++] ?? "",
    stderr: "",
  }));
}

describe("GitHub claim read adapter", () => {
  it("reads public Issue, exact branch head and all historical PR states", async () => {
    const run = command(
      JSON.stringify({ state: "open", labels: ["Sandcastle", "ready-for-agent"] }),
      `${HEAD}\n`,
      JSON.stringify({
        nodes: [
          {
            number: 310,
            state: "CLOSED",
            headRefOid: HEAD,
            closingIssuesReferences: { nodes: [{ number: 208 }] },
          },
          {
            number: 312,
            state: "MERGED",
            headRefOid: "c".repeat(40),
            closingIssuesReferences: { nodes: [{ number: 208 }] },
          },
        ],
        pageInfo: { hasNextPage: false, endCursor: null },
      }),
    );
    const adapter = new GithubClaimReadAdapter(run);

    await expect(adapter.getIssue(input)).resolves.toEqual({
      existence: "present",
      state: "open",
      eligible: true,
    });
    await expect(adapter.getBranch(input)).resolves.toEqual({ state: "present", headSha: HEAD });
    await expect(adapter.listPullRequests(input)).resolves.toEqual([
      { number: 310, state: "closed", headSha: HEAD, closesIssue: true },
      { number: 312, state: "merged", headSha: "c".repeat(40), closesIssue: true },
    ]);

    const calls = vi.mocked(run).mock.calls;
    expect(calls[2]?.[1]).toContain("query=query($owner:String!,$name:String!,$branch:String!,$cursor:String){repository(owner:$owner,name:$name){pullRequests(first:100,after:$cursor,headRefName:$branch,states:[OPEN,CLOSED,MERGED]){nodes{number,state,headRefOid,closingIssuesReferences(first:100){nodes{number}}}pageInfo{hasNextPage,endCursor}}}}");
    expect(calls.flatMap((call) => call[1])).not.toContain("--method");
  });

  it("maps GitHub not-found responses to explicit absence", async () => {
    const run = vi.fn().mockRejectedValue(Object.assign(new Error("missing"), {
      status: 404,
      stderr: "token=secret /host/private/path HTTP 404",
    }));
    const adapter = new GithubClaimReadAdapter(run);

    await expect(adapter.getIssue(input)).resolves.toEqual({
      existence: "absent",
      state: "unknown",
      eligible: false,
    });
    await expect(adapter.getBranch(input)).resolves.toEqual({ state: "absent" });
  });

  it("retries transient reads within a fixed bound and redacts final errors", async () => {
    const run = vi.fn().mockRejectedValue(Object.assign(new Error("token=secret"), {
      code: "ETIMEDOUT",
      stderr: "/host/private/path token=secret",
    }));
    const adapter = new GithubClaimReadAdapter(run);

    const error = await adapter.getIssue(input).catch((caught: unknown) => caught);

    expect(run).toHaveBeenCalledTimes(3);
    expect(error).toBeInstanceOf(ClaimReadError);
    expect(String(error)).toBe("ClaimReadError: Could not read github claim facts");
    expect(String(error)).not.toMatch(/secret|private/u);
  });
});

describe("Git claim read adapter", () => {
  it.each([
    ["0\t0\n", "equal", 0],
    ["0\t2\n", "ahead", 2],
    ["3\t0\n", "behind", 0],
    ["3\t2\n", "diverged", 2],
  ] as const)("normalizes commit counts %s", async (output, relation, count) => {
    const run = command(output, output);
    const adapter = new GitClaimReadAdapter("/repository", run);
    const commitInput = { ...input, branchHeadSha: HEAD };

    await expect(adapter.compareCommits(commitInput)).resolves.toBe(relation);
    await expect(adapter.countUniqueCommits(commitInput)).resolves.toBe(count);

    for (const call of vi.mocked(run).mock.calls) {
      expect(call[0]).toBe("git");
      expect(call[1]).toEqual([
        "rev-list",
        "--left-right",
        "--count",
        `${BASE}...${HEAD}`,
      ]);
    }
  });

  it.each([
    ["", undefined, "absent"],
    ["worktree /agent/worktree\nbranch refs/heads/sandcastle/issue-208\n", "", "clean"],
    ["worktree /agent/worktree\nbranch refs/heads/sandcastle/issue-208\n", "?? secret.txt\n", "dirty"],
  ] as const)("reports worktree state without returning paths or files", async (
    listing,
    status,
    expected,
  ) => {
    const run = command(listing, ...(status === undefined ? [] : [status]));
    const adapter = new GitClaimReadAdapter("/repository", run);

    const result = await adapter.getWorktree(input);

    expect(result).toBe(expected);
    expect(JSON.stringify(result)).not.toMatch(/agent|secret/u);
    expect(vi.mocked(run).mock.calls.flatMap((call) => call[1])).not.toContain("remove");
  });
});

describe("Docker claim read adapter", () => {
  it.each([
    ["", undefined, "absent"],
    [JSON.stringify("abcdef123456"), JSON.stringify({ Id: "abcdef123456", State: { Running: false } }), "present"],
    [JSON.stringify("abcdef123456"), JSON.stringify({ Id: "abcdef123456", State: { Running: true } }), "active"],
  ] as const)("reports %s containers through fixed labels", async (listing, inspect, expected) => {
    const run = command(listing, ...(inspect === undefined ? [] : [inspect]));
    const adapter = new DockerClaimReadAdapter(run);

    await expect(adapter.getContainer(input)).resolves.toBe(expected);

    const args = vi.mocked(run).mock.calls[0]?.[1] ?? [];
    expect(args).toContain("label=com.sandcastle.repository=example/repository");
    expect(args).toContain("label=com.sandcastle.issue=208");
    expect(args).toContain("label=com.sandcastle.branch=sandcastle/issue-208");
    expect(args).not.toContain("rm");
    expect(args).not.toContain("stop");
  });

  it("raises a fixed error when Docker output is malformed", async () => {
    const adapter = new DockerClaimReadAdapter(command("credential=/secret/path"));

    const error = await adapter.getContainer(input).catch((caught: unknown) => caught);

    expect(String(error)).toBe("ClaimReadError: Could not read docker claim facts");
    expect(String(error)).not.toMatch(/credential|secret/u);
  });
});
