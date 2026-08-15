import { describe, expect, it } from "vitest";
import {
  adoptManagedPullRequest,
  publishManagedImplementation,
  recognizeManagedPullRequest,
  type ManagedImplementationPorts,
  type ManagedPullRequestRecord,
} from "../src/managed-pr.js";

const revision = "b".repeat(40);
const request = {
  repository: "canxer314/obsidian-llm-wiki-cli",
  ticket: { number: 65, title: "Implement a Delivery Ticket as a Managed PR" },
  targetBranch: "master",
  branch: "afk/ticket-65-afk-v1-test",
  baseRevision: "a".repeat(40),
  outputRevision: revision,
  transitionId: "afk-v1-test",
  workflowRunId: "1234",
  trustedActor: { login: "delivery-bot", type: "Bot" as const },
  narrative: "Implementation completed",
};

function fakePorts(existing?: ManagedPullRequestRecord): {
  ports: ManagedImplementationPorts;
  calls: string[];
  records: ManagedPullRequestRecord[];
} {
  const calls: string[] = [];
  const records = existing === undefined ? [] : [existing];
  const ports: ManagedImplementationPorts = {
    findRemoteBranchRevision: async () => existing === undefined ? undefined : revision,
    ensureRemoteBranch: async (branch, exactRevision) => {
      calls.push(`push:${branch}:${exactRevision}`);
    },
    findOpenPullRequests: async (ticketNumber, branch, targetBranch) => {
      calls.push(`find-pr:${ticketNumber}:${branch}:${targetBranch}`);
      return records;
    },
    createPullRequest: async (input) => {
      calls.push(`create-pr:${input.body}`);
      const record: ManagedPullRequestRecord = {
        number: 101,
        headRevision: revision,
        headBranch: input.headBranch,
        baseBranch: input.baseBranch,
        body: input.body,
        comments: [],
      };
      records.push(record);
      return record;
    },
    postComment: async (prNumber, body) => {
      calls.push(`comment:${prNumber}:${body}`);
      records[0]?.comments.push({ author: { login: "delivery-bot", type: "Bot" }, body });
    },
  };
  return { ports, calls, records };
}

describe("Managed PR publication", () => {
  it("pushes the exact Revision, creates a closing-linked PR, and records initial management", async () => {
    const { ports, calls, records } = fakePorts();

    await expect(publishManagedImplementation(request, ports)).resolves.toEqual({
      prNumber: 101,
      outputRevision: revision,
      created: true,
      managementRecordCreated: true,
    });

    expect(calls[0]).toBe(`push:${request.branch}:${revision}`);
    expect(calls.some((call) => call.includes("Closes #65"))).toBe(true);
    expect(calls.some((call) => call.includes('"kind":"managed-pr"'))).toBe(true);
    expect(recognizeManagedPullRequest(records[0]!, {
      repository: request.repository,
      ticketNumber: 65,
      trustedActors: [{ login: "delivery-bot", type: "Bot" }],
    })).toEqual({ managed: true, ticketNumber: 65, initialRevision: revision });
  });

  it("retries without duplicating the branch, PR, or initial management comment", async () => {
    const initial = fakePorts();
    await publishManagedImplementation(request, initial.ports);
    initial.calls.length = 0;

    await expect(publishManagedImplementation(request, initial.ports)).resolves.toEqual({
      prNumber: 101,
      outputRevision: revision,
      created: false,
      managementRecordCreated: false,
    });
    expect(initial.calls.filter((call) => call.startsWith("push:"))).toHaveLength(1);
    expect(initial.calls.filter((call) => call.startsWith("create-pr:"))).toHaveLength(0);
    expect(initial.calls.filter((call) => call.startsWith("comment:"))).toHaveLength(0);
  });

  it("ignores an untrusted copied envelope when deciding whether to post management", async () => {
    const initial = fakePorts();
    await publishManagedImplementation(request, initial.ports);
    const body = initial.records[0]!.comments[0]!.body;
    initial.records[0]!.comments = [{ author: { login: "attacker", type: "User" }, body }];
    initial.calls.length = 0;

    const result = await publishManagedImplementation(request, initial.ports);

    expect(result.managementRecordCreated).toBe(true);
    expect(initial.calls.filter((call) => call.startsWith("comment:"))).toHaveLength(1);
  });

  it("recognizes the original trusted management record after the PR head advances", async () => {
    const initial = fakePorts();
    await publishManagedImplementation(request, initial.ports);
    initial.records[0]!.headRevision = "c".repeat(40);

    expect(recognizeManagedPullRequest(initial.records[0]!, {
      repository: request.repository,
      ticketNumber: 65,
      trustedActors: [request.trustedActor],
    })).toEqual({ managed: true, ticketNumber: 65, initialRevision: revision });
  });

  it("adopts an eligible PR through one trusted record bound to its current Revision and target", async () => {
    const existing: ManagedPullRequestRecord = {
      number: 104,
      headRevision: revision,
      headBranch: "human/issue-65",
      baseBranch: "master",
      body: "Closes #65",
      comments: [],
    };
    const initial = fakePorts(existing);
    const adoption = {
      repository: request.repository,
      ticketNumber: 65,
      prNumber: 104,
      targetBranch: "master",
      currentRevision: revision,
      transitionId: "afk-v1-adopt-104",
      workflowRunId: "2000",
      trustedActor: request.trustedActor,
      narrative: "Adopted for autonomous continuation",
    };

    await expect(adoptManagedPullRequest(adoption, initial.ports)).resolves.toEqual({
      prNumber: 104,
      currentRevision: revision,
      managementRecordCreated: true,
    });
    await expect(adoptManagedPullRequest(adoption, initial.ports)).resolves.toEqual({
      prNumber: 104,
      currentRevision: revision,
      managementRecordCreated: false,
    });
    expect(initial.calls.filter((call) => call.startsWith("comment:"))).toHaveLength(1);
    expect(recognizeManagedPullRequest(existing, {
      repository: request.repository,
      ticketNumber: 65,
      targetBranch: "master",
      trustedActors: [request.trustedActor],
    })).toEqual({ managed: true, ticketNumber: 65, initialRevision: revision });
  });

  it("rejects adoption when the published record is not authored by the trusted actor", async () => {
    const existing: ManagedPullRequestRecord = {
      number: 104,
      headRevision: revision,
      headBranch: "human/issue-65",
      baseBranch: "master",
      body: "Closes #65",
      comments: [],
    };
    const initial = fakePorts(existing);
    initial.ports.postComment = async (_prNumber, body) => {
      existing.comments.push({ author: { login: "operator", type: "User" }, body });
    };

    await expect(adoptManagedPullRequest({
      repository: request.repository,
      ticketNumber: 65,
      prNumber: 104,
      targetBranch: "master",
      currentRevision: revision,
      transitionId: "afk-v1-adopt-104",
      workflowRunId: "2000",
      trustedActor: request.trustedActor,
      narrative: "Adopt",
    }, initial.ports)).rejects.toThrow("could not be authenticated");
  });

  it("rejects adoption after the PR head or target changes", async () => {
    const existing: ManagedPullRequestRecord = {
      number: 104,
      headRevision: "c".repeat(40),
      headBranch: "human/issue-65",
      baseBranch: "release",
      body: "Closes #65",
      comments: [],
    };
    const initial = fakePorts(existing);

    await expect(adoptManagedPullRequest({
      repository: request.repository,
      ticketNumber: 65,
      prNumber: 104,
      targetBranch: "master",
      currentRevision: revision,
      transitionId: "afk-v1-adopt-104",
      workflowRunId: "2000",
      trustedActor: request.trustedActor,
      narrative: "Adopt",
    }, initial.ports)).rejects.toThrow("current Revision and target branch");
    expect(initial.calls.filter((call) => call.startsWith("comment:"))).toHaveLength(0);
  });

  it("fails closed when more than one open PR matches the deterministic identity", async () => {
    const one = fakePorts();
    await publishManagedImplementation(request, one.ports);
    const duplicate = { ...one.records[0]!, number: 102, comments: [] };
    one.records.push(duplicate);

    await expect(publishManagedImplementation(request, one.ports)).rejects.toThrow(
      "multiple open Implementation PRs",
    );
  });
});
