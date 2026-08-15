import { describe, expect, it } from "vitest";
import {
  createManagedPullRequestReconstructor,
  discoverManagedPullRequestRecovery,
  reconstructManagedPullRequestSnapshot,
  type ManagedPullRequestRecoveryPorts,
  type RecoveryPullRequestCandidate,
} from "../src/managed-pr-recovery.js";

const REVISION = "a".repeat(40);
const repository = "canxer314/obsidian-llm-wiki-cli";
const trustedActor = { login: "delivery-bot", type: "Bot" as const };

function candidate(overrides: Partial<RecoveryPullRequestCandidate> = {}): RecoveryPullRequestCandidate {
  const ticketNumber = overrides.ticketNumbers?.[0] ?? 66;
  const transitionId = `afk-v1-managed-${ticketNumber}`;
  return {
    repository,
    headRepository: repository,
    open: true,
    ticketNumbers: [ticketNumber],
    number: 73,
    headRevision: REVISION,
    headBranch: "afk/ticket-66",
    baseBranch: "master",
    baseRevision: "b".repeat(40),
    mergeable: true,
    requiredChecksPass: true,
    headParents: [],
    headMessage: "Implementation",
    headAuthor: { name: "Developer", email: "developer@example.com" },
    body: `Closes #${ticketNumber}\n\n<!-- afk-managed-pr:${ticketNumber}:${transitionId} -->`,
    comments: [{
      author: trustedActor,
      body: [
        "<!-- afk-control-envelope",
        JSON.stringify({
          schemaVersion: 1,
          kind: "managed-pr",
          repository,
          ticketNumber,
          prNumber: overrides.number ?? 73,
          round: 0,
          transitionId,
          inputRevision: REVISION,
          outputRevision: REVISION,
          disposition: "succeeded",
          workflowRunId: "run-1",
        }),
        "-->",
        "",
        "Initial management record",
      ].join("\n"),
    }],
    ...overrides,
  };
}

function ports(candidates: RecoveryPullRequestCandidate[]): {
  value: ManagedPullRequestRecoveryPorts;
  limits: number[];
} {
  const limits: number[] = [];
  return {
    limits,
    value: {
      readSynchronizationStaging: async () => undefined,
      listOpenPullRequests: async (limit) => {
        limits.push(limit);
        return candidates;
      },
    },
  };
}

describe("Managed PR recovery discovery", () => {
  it("recovers a pushed merge only when a trusted ready record authorizes its exact output", async () => {
    const targetRevision = "b".repeat(40);
    const inputRevision = REVISION;
    const outputRevision = "c".repeat(40);
    const started = {
      author: trustedActor,
      body: [
        "<!-- afk-control-envelope",
        JSON.stringify({
          schemaVersion: 1,
          kind: "synchronization",
          repository,
          ticketNumber: 66,
          prNumber: 73,
          targetRevision,
          round: 0,
          transitionId: "afk-v1-sync:intent",
          inputRevision,
          disposition: "started",
          workflowRunId: "run-2",
        }),
        "-->",
      ].join("\n"),
    };
    const ready = {
      author: trustedActor,
      body: [
        "<!-- afk-control-envelope",
        JSON.stringify({
          schemaVersion: 1,
          kind: "synchronization",
          repository,
          ticketNumber: 66,
          prNumber: 73,
          targetRevision,
          round: 0,
          transitionId: "afk-v1-sync:ready",
          inputRevision,
          outputRevision,
          disposition: "ready",
          workflowRunId: "run-2",
        }),
        "-->",
      ].join("\n"),
    };
    const merged = candidate({
      headRevision: outputRevision,
      baseRevision: targetRevision,
      headParents: [inputRevision, targetRevision],
      comments: [...candidate().comments, started, ready],
    });
    const reconstructor = createManagedPullRequestReconstructor({
      repository,
      targetBranch: "master",
      trustedActors: [trustedActor],
      maximumPullRequests: 25,
      candidates: ports([merged]).value,
      loadTicket: async () => ({
        number: 66, open: true, labels: ["ready-for-agent"],
        openBlockerNumbers: [], dependencyDataComplete: true,
      }),
      loadTargetRevision: async () => targetRevision,
    });

    await expect(reconstructor.reconstruct()).resolves.toMatchObject({
      interruptedSynchronization: {
        prNumber: 73,
        inputRevision,
        outputRevision,
        targetRevision,
      },
    });

    const preparedCandidate = candidate({
      headRevision: inputRevision,
      baseRevision: inputRevision,
      headParents: [],
      comments: [...candidate().comments, started, ready],
    });
    const prepared = createManagedPullRequestReconstructor({
      repository,
      targetBranch: "master",
      trustedActors: [trustedActor],
      maximumPullRequests: 25,
      candidates: ports([preparedCandidate]).value,
      loadTicket: async () => ({
        number: 66, open: true, labels: ["ready-for-agent"],
        openBlockerNumbers: [], dependencyDataComplete: true,
      }),
      loadTargetRevision: async () => targetRevision,
    });
    await expect(prepared.reconstruct()).resolves.toMatchObject({
      preparedSynchronization: {
        prNumber: 73,
        headBranch: "afk/ticket-66",
        inputRevision,
        outputRevision,
        targetRevision,
      },
    });

    const withoutIntent = createManagedPullRequestReconstructor({
      repository,
      targetBranch: "master",
      trustedActors: [trustedActor],
      maximumPullRequests: 25,
      candidates: ports([{ ...merged, comments: candidate().comments }]).value,
      loadTicket: async () => ({
        number: 66, open: true, labels: ["ready-for-agent"],
        openBlockerNumbers: [], dependencyDataComplete: true,
      }),
      loadTargetRevision: async () => targetRevision,
    });
    await expect(withoutIntent.reconstruct()).resolves.not.toHaveProperty("interruptedSynchronization");
  });

  it("reconstructs a trusted ready record from an exact staged merge after pre-ready worker loss", async () => {
    const targetRevision = "b".repeat(40);
    const outputRevision = "c".repeat(40);
    const started = {
      author: trustedActor,
      body: [
        "<!-- afk-control-envelope",
        JSON.stringify({
          schemaVersion: 1,
          kind: "synchronization",
          repository,
          ticketNumber: 66,
          prNumber: 73,
          targetRevision,
          round: 0,
          transitionId: "afk-v1-sync:intent",
          inputRevision: REVISION,
          disposition: "started",
          workflowRunId: "run-2",
        }),
        "-->",
      ].join("\n"),
    };
    const input = ports([candidate({ comments: [...candidate().comments, started] })]);
    input.value.readSynchronizationStaging = async () => ({
      revision: outputRevision,
      parents: [REVISION, targetRevision],
    });
    const reconstructor = createManagedPullRequestReconstructor({
      repository,
      targetBranch: "master",
      trustedActors: [trustedActor],
      maximumPullRequests: 25,
      candidates: input.value,
      loadTicket: async () => ({
        number: 66, open: true, labels: ["ready-for-agent"],
        openBlockerNumbers: [], dependencyDataComplete: true,
      }),
      loadTargetRevision: async () => targetRevision,
    });

    await expect(reconstructor.reconstruct()).resolves.toMatchObject({
      preparedSynchronization: {
        inputRevision: REVISION,
        outputRevision,
        targetRevision,
        readyEnvelope: {
          transitionId: "afk-v1-sync:ready",
          disposition: "ready",
          inputRevision: REVISION,
          outputRevision,
          targetRevision,
        },
      },
    });

    input.value.readSynchronizationStaging = async () => ({
      revision: outputRevision,
      parents: [targetRevision],
    });
    await expect(reconstructor.reconstruct()).resolves.not.toHaveProperty("preparedSynchronization");
  });

  it("reconstructs the same authenticated snapshot on a fresh worker", async () => {
    const input = ports([candidate()]);
    const ticket = {
      number: 66,
      open: true,
      labels: ["ready-for-agent"],
      openBlockerNumbers: [],
      dependencyDataComplete: true,
      body: "Continue the Managed PR",
    };
    const reconstruct = () => reconstructManagedPullRequestSnapshot({
      repository,
      targetBranch: "master",
      targetBranchRevision: "b".repeat(40),
      ticket,
      candidates: input.value,
      trustedActors: [trustedActor],
      maximumPullRequests: 25,
    });

    const first = await reconstruct();
    const freshWorker = await reconstruct();

    expect(freshWorker).toEqual(first);
    expect(first.pullRequests).toMatchObject([{
      number: 73,
      ticketNumber: 66,
      managed: true,
      headRevision: REVISION,
      baseRevision: "b".repeat(40),
    }]);
    expect(first.controlComments[0]).toMatchObject({
      commentId: "pr-73-comment-1",
      author: trustedActor,
      envelope: { kind: "managed-pr", ticketNumber: 66, prNumber: 73 },
    });
  });

  it("keeps forged management history visible but does not authenticate the PR", async () => {
    const forged = candidate({
      comments: [{ ...candidate().comments[0]!, author: { login: "mallory", type: "User" } }],
    });
    const input = ports([forged]);
    const value = await reconstructManagedPullRequestSnapshot({
      repository,
      targetBranch: "master",
      targetBranchRevision: "b".repeat(40),
      ticket: {
        number: 66, open: true, labels: ["ready-for-agent"],
        openBlockerNumbers: [], dependencyDataComplete: true,
      },
      candidates: input.value,
      trustedActors: [trustedActor],
      maximumPullRequests: 25,
    });

    expect(value.pullRequests[0]?.managed).toBe(false);
    expect(value.controlComments).toHaveLength(1);
  });

  it("returns only authenticated open same-repository Managed PRs within the configured bound", async () => {
    const valid = candidate();
    const forged = candidate({
      number: 74,
      ticketNumbers: [67],
      body: "Closes #67\n\n<!-- afk-managed-pr:67:afk-v1-managed-67 -->",
      comments: [{ ...candidate({ ticketNumbers: [67], number: 74 }).comments[0]!, author: { login: "mallory", type: "User" } }],
    });
    const external = candidate({ number: 75, ticketNumbers: [68], headRepository: "outside/fork" });
    const unrelated = candidate({ number: 76, ticketNumbers: [] });
    const input = ports([valid, forged, external, unrelated]);

    await expect(discoverManagedPullRequestRecovery(input.value, {
      repository,
      targetBranch: "master",
      trustedActors: [trustedActor],
      maximumPullRequests: 25,
    })).resolves.toEqual({
      managedPullRequests: [{ ticketNumber: 66, prNumber: 73, headRevision: REVISION }],
      ambiguousTicketNumbers: [],
    });
    expect(input.limits).toEqual([25]);
  });

  it("fails closed when the adapter exceeds the recovery bound", async () => {
    const input = ports([candidate(), candidate({ number: 74 })]);
    await expect(discoverManagedPullRequestRecovery(input.value, {
      repository,
      targetBranch: "master",
      trustedActors: [trustedActor],
      maximumPullRequests: 1,
    })).rejects.toThrow("recovery scan exceeded");
  });

  it("reports duplicate authenticated Managed PRs for one ticket as ambiguous", async () => {
    const input = ports([candidate(), candidate({ number: 74 })]);
    await expect(discoverManagedPullRequestRecovery(input.value, {
      repository,
      targetBranch: "master",
      trustedActors: [trustedActor],
      maximumPullRequests: 25,
    })).resolves.toEqual({
      managedPullRequests: [],
      ambiguousTicketNumbers: [66],
    });
  });

  it("fails closed when a candidate has multiple native ticket links", async () => {
    const input = ports([
      candidate({ ticketNumbers: [66, 67], body: "Closes #66 and closes #67" }),
      candidate({ open: false }),
      candidate({ baseBranch: "release" }),
    ]);
    const snapshot = await reconstructManagedPullRequestSnapshot({
      repository,
      targetBranch: "master",
      targetBranchRevision: "b".repeat(40),
      ticket: {
        number: 66, open: true, labels: ["ready-for-agent"],
        openBlockerNumbers: [], dependencyDataComplete: true,
      },
      candidates: input.value,
      trustedActors: [trustedActor],
      maximumPullRequests: 25,
    });
    expect(snapshot.pullRequests).toContainEqual(expect.objectContaining({ number: 73, managed: false }));
    expect(snapshot.pullRequests.find((pr) => pr.targetBranch === "release")?.managed).toBe(false);

    await expect(discoverManagedPullRequestRecovery(input.value, {
      repository,
      targetBranch: "master",
      trustedActors: [trustedActor],
      maximumPullRequests: 25,
    })).resolves.toEqual({ managedPullRequests: [], ambiguousTicketNumbers: [] });
  });
});
