import { describe, expect, it } from "vitest";
import type {
  AuthenticatedGitHubSnapshot,
  RepositoryPolicy,
} from "@llm-wiki/afk-delivery-core";
import {
  continueManagedPullRequest,
  type ManagedPullRequestContinuationPorts,
} from "../src/managed-pr-continuation.js";

const INITIAL = "a".repeat(40);
const TARGET = "b".repeat(40);
const SYNCHRONIZED = "c".repeat(40);

const policy: RepositoryPolicy = {
  schemaVersion: 1,
  targetBranch: "master",
  readyLabel: "ready-for-agent",
  prohibitedLabel: "afk:prohibited",
  needsHumanLabel: "afk:needs-human",
  trustedActors: [{ login: "delivery-bot", type: "Bot" }],
  maximumRepairRounds: 2,
  requiredValidationCommands: ["npm test", "npm run typecheck"],
  reviewSkill: {
    path: "/home/agent/.claude/skills/code-review/SKILL.md",
    revision: "sha256:29f1ac715f1a2acb97a694b958531a032249ab0ad662aa28b40ba54c4bdb2ab0",
  },
  mergeStrategy: "squash",
};

function snapshot(overrides: Partial<AuthenticatedGitHubSnapshot> = {}): AuthenticatedGitHubSnapshot {
  return {
    repository: "canxer314/obsidian-llm-wiki-cli",
    targetBranchRevision: TARGET,
    ticket: {
      number: 66,
      open: true,
      labels: ["ready-for-agent"],
      openBlockerNumbers: [],
      dependencyDataComplete: true,
      body: "Continue the Managed PR",
    },
    pullRequests: [{
      number: 73,
      ticketNumber: 66,
      open: true,
      targetBranch: "master",
      headBranch: "afk/ticket-66",
      headRevision: INITIAL,
      baseRevision: INITIAL,
      mergeable: true,
      requiredChecksPass: true,
      managed: true,
    }],
    controlComments: [{
      commentId: "managed-1",
      author: { login: "delivery-bot", type: "Bot" },
      envelope: {
        schemaVersion: 1,
        kind: "managed-pr",
        repository: "canxer314/obsidian-llm-wiki-cli",
        ticketNumber: 66,
        prNumber: 73,
        round: 0,
        transitionId: "afk-v1-managed",
        inputRevision: INITIAL,
        outputRevision: INITIAL,
        disposition: "succeeded",
        workflowRunId: "run-1",
      },
      narrative: "Initial management record",
    }],
    ...overrides,
  };
}

function fakePorts(initial: AuthenticatedGitHubSnapshot): {
  ports: ManagedPullRequestContinuationPorts;
  calls: string[];
} {
  const calls: string[] = [];
  let current = initial;
  return {
    calls,
    ports: {
      reconstruct: async () => {
        calls.push("reconstruct");
        return { snapshot: current };
      },
      publishPreparedSynchronization: async () => {
        calls.push("publish-prepared");
      },
      synchronize: async (input) => {
        calls.push(`synchronize:${input.prNumber}:${input.headBranch}:${input.expectedHeadRevision}:${input.targetRevision}`);
        await input.authorizeOutput(SYNCHRONIZED);
        current = {
          ...current,
          pullRequests: current.pullRequests.map((pr) => pr.number === input.prNumber
            ? { ...pr, headRevision: SYNCHRONIZED, baseRevision: TARGET }
            : pr),
        };
        return {
          status: "succeeded",
          outputRevision: SYNCHRONIZED,
          narrative: "Synchronized cleanly",
        };
      },
      resolveConflicts: async () => {
        throw new Error("conflict resolver should not run");
      },
      recordControlComment: async (input) => {
        calls.push(`comment:${input.envelope.kind}:${input.envelope.outputRevision}`);
        return { created: true };
      },
      recordNeedsHuman: async () => {
        calls.push("needs-human");
        return { created: true };
      },
    },
  };
}

describe("Managed PR continuation", () => {
  it("publishes a trusted prepared output after worker loss without rerunning synchronization", async () => {
    const initial = snapshot();
    const synchronized = snapshot({
      pullRequests: [{ ...initial.pullRequests[0]!, headRevision: SYNCHRONIZED, baseRevision: TARGET }],
    });
    let current = initial;
    let synchronizeCalls = 0;
    let conflictCalls = 0;
    let publishCalls = 0;
    const recoveryOrder: string[] = [];
    const ports = fakePorts(initial).ports;
    ports.reconstruct = async () => current === initial
      ? {
          snapshot: current,
          preparedSynchronization: {
            prNumber: 73,
            headBranch: "afk/ticket-66",
            inputRevision: INITIAL,
            outputRevision: SYNCHRONIZED,
            targetRevision: TARGET,
            narrative: "Prepared output",
            readyEnvelope: {
              schemaVersion: 1,
              kind: "synchronization",
              repository: initial.repository,
              ticketNumber: 66,
              prNumber: 73,
              targetRevision: TARGET,
              round: 0,
              transitionId: "sync:ready",
              inputRevision: INITIAL,
              outputRevision: SYNCHRONIZED,
              disposition: "ready",
              workflowRunId: "run-2",
            },
          },
        }
      : { snapshot: current };
    ports.publishPreparedSynchronization = async () => {
      publishCalls += 1;
      recoveryOrder.push("publish");
      current = synchronized;
    };
    ports.recordControlComment = async (input) => {
      recoveryOrder.push(input.envelope.disposition);
      return { created: true };
    };
    ports.synchronize = async () => {
      synchronizeCalls += 1;
      throw new Error("must not rerun synchronization");
    };
    ports.resolveConflicts = async () => {
      conflictCalls += 1;
      throw new Error("must not rerun conflict resolution");
    };

    await expect(continueManagedPullRequest({
      repository: initial.repository,
      ticketNumber: 66,
      lease: { status: "acquired", leaseId: "ticket-66" },
      policy,
      workflowRun: { id: "run-3", attempt: 2 },
    }, ports)).resolves.toMatchObject({
      status: "synchronized",
      outputRevision: SYNCHRONIZED,
      recovered: true,
    });
    expect(recoveryOrder).toEqual(["ready", "publish", "succeeded"]);
    expect({ publishCalls, synchronizeCalls, conflictCalls }).toEqual({
      publishCalls: 1,
      synchronizeCalls: 0,
      conflictCalls: 0,
    });
  });

  it("records an already-pushed synchronization after worker loss without merging or pushing again", async () => {
    const synchronized = snapshot({
      pullRequests: [{
        ...snapshot().pullRequests[0]!,
        headRevision: SYNCHRONIZED,
        baseRevision: TARGET,
      }],
    });
    let syncCalls = 0;
    let commentEnvelope: unknown;
    const fake = fakePorts(synchronized);
    fake.ports.reconstruct = async () => ({
      snapshot: synchronized,
      interruptedSynchronization: {
        prNumber: 73,
        inputRevision: INITIAL,
        outputRevision: SYNCHRONIZED,
        targetRevision: TARGET,
        narrative: `Recovered synchronization Revision ${SYNCHRONIZED}.`,
      },
    });
    fake.ports.synchronize = async () => {
      syncCalls += 1;
      throw new Error("must not synchronize again");
    };
    fake.ports.recordControlComment = async (input) => {
      commentEnvelope = input.envelope;
      return { created: true };
    };

    await expect(continueManagedPullRequest({
      repository: synchronized.repository,
      ticketNumber: 66,
      lease: { status: "acquired", leaseId: "ticket-66" },
      policy,
      workflowRun: { id: "run-3", attempt: 2 },
    }, fake.ports)).resolves.toMatchObject({
      status: "synchronized",
      inputRevision: INITIAL,
      outputRevision: SYNCHRONIZED,
      recovered: true,
    });
    expect(syncCalls).toBe(0);
    expect(commentEnvelope).toMatchObject({
      kind: "synchronization",
      inputRevision: INITIAL,
      outputRevision: SYNCHRONIZED,
    });
  });

  it("uses one bounded conflict resolver with the ticket, conflict sides, and trusted history", async () => {
    const initial = snapshot();
    let current = initial;
    const calls: string[] = [];
    const ports: ManagedPullRequestContinuationPorts = {
      reconstruct: async () => ({ snapshot: current }),
      publishPreparedSynchronization: async () => {
        throw new Error("no prepared synchronization expected");
      },
      synchronize: async () => ({
        status: "conflicted",
        narrative: "Conflict in src/index.ts",
        conflicts: [{ path: "src/index.ts", ours: "feature", theirs: "master" }],
      }),
      resolveConflicts: async (input) => {
        calls.push(`resolve:${input.conflicts[0]?.path}:${input.ticket.body}:${input.controlComments[0]?.commentId}`);
        await input.authorizeOutput(SYNCHRONIZED);
        current = {
          ...current,
          pullRequests: current.pullRequests.map((pr) => ({
            ...pr,
            headRevision: SYNCHRONIZED,
            baseRevision: TARGET,
          })),
        };
        return { status: "succeeded", outputRevision: SYNCHRONIZED, narrative: "Resolved safely" };
      },
      recordControlComment: async () => {
        calls.push("comment");
        return { created: true };
      },
      recordNeedsHuman: async () => ({ created: true }),
    };

    await expect(continueManagedPullRequest({
      repository: initial.repository,
      ticketNumber: 66,
      lease: { status: "acquired", leaseId: "ticket-66" },
      policy,
      workflowRun: { id: "run-2", attempt: 1 },
    }, ports)).resolves.toMatchObject({
      status: "synchronized",
      outputRevision: SYNCHRONIZED,
      conflictResolved: true,
    });
    expect(calls).toEqual([
      "comment",
      "resolve:src/index.ts:Continue the Managed PR:managed-1",
      "comment",
      "comment",
    ]);
  });

  it("rejects a concurrent human push before recording synchronization evidence", async () => {
    const initial = snapshot();
    let reads = 0;
    let comments = 0;
    const ports = fakePorts(initial).ports;
    ports.reconstruct = async () => {
      reads += 1;
      if (reads === 1) return { snapshot: initial };
      return {
        snapshot: snapshot({
          pullRequests: [{ ...initial.pullRequests[0]!, headRevision: "d".repeat(40), baseRevision: TARGET }],
        }),
      };
    };
    ports.recordControlComment = async () => {
      comments += 1;
      return { created: true };
    };

    await expect(continueManagedPullRequest({
      repository: initial.repository,
      ticketNumber: 66,
      lease: { status: "acquired", leaseId: "ticket-66" },
      policy,
      workflowRun: { id: "run-2", attempt: 1 },
    }, ports)).rejects.toThrow("changed before its control record");
    expect(comments).toBe(2);
  });

  it("executes and persists validation for the exact selected Revision", async () => {
    const initial = snapshot({
      targetBranchRevision: INITIAL,
      pullRequests: [{ ...snapshot().pullRequests[0]!, diff: "diff --git a/a b/a\n+change" }],
    });
    const fake = fakePorts(initial);
    let validationRequest: Parameters<NonNullable<ManagedPullRequestContinuationPorts["runValidation"]>>[0] | undefined;
    let recorded: Parameters<ManagedPullRequestContinuationPorts["recordControlComment"]>[0] | undefined;
    fake.ports.runValidation = async (request) => {
      validationRequest = request;
      return {
        kind: "validation",
        status: "succeeded",
        revision: request.revision,
        round: request.round,
        commands: request.checks.map((check, index) => ({
          command: check.command,
          exitCode: 0,
          checkId: `check-${index}`,
          timedOut: false,
        })),
      };
    };
    fake.ports.recordControlComment = async (record) => {
      recorded = record;
      return { created: true };
    };

    const result = await continueManagedPullRequest({
      repository: initial.repository,
      ticketNumber: 66,
      lease: { status: "acquired", leaseId: "lease-1" },
      policy,
      workflowRun: { id: "run-2", attempt: 1 },
    }, fake.ports);

    expect(validationRequest).toMatchObject({
      revision: INITIAL,
      round: 1,
      workflowRun: { id: "run-2", attempt: 1 },
      checks: [
        { command: "npm test", source: "repository-policy" },
        { command: "npm run typecheck", source: "repository-policy" },
      ],
    });
    expect(recorded?.envelope).toMatchObject({
      kind: "validation",
      inputRevision: INITIAL,
      disposition: "succeeded",
      workflowRunAttempt: 1,
    });
    expect(result).toMatchObject({ status: "selected", transition: { kind: "record-validation" } });
  });

  it("executes and persists the complete isolated Review Handoff", async () => {
    const validation = {
      commentId: "validation-1",
      author: { login: "delivery-bot", type: "Bot" as const },
      envelope: {
        schemaVersion: 1 as const,
        kind: "validation" as const,
        repository: "canxer314/obsidian-llm-wiki-cli",
        ticketNumber: 66,
        prNumber: 73,
        round: 1,
        transitionId: "validation-1",
        inputRevision: INITIAL,
        disposition: "succeeded",
        workflowRunId: "run-2",
        workflowRunAttempt: 1,
        commands: [
          { command: "npm test", exitCode: 0, checkId: "test", timedOut: false },
          { command: "npm run typecheck", exitCode: 0, checkId: "types", timedOut: false },
        ],
      },
      narrative: "",
    };
    const initial = snapshot({
      targetBranchRevision: INITIAL,
      repositoryInstructions: "Repository instructions",
      domainDocuments: [{ path: "CONTEXT.md", content: "Domain" }],
      architectureDecisions: [{ path: "docs/adr/0001.md", content: "Decision" }],
      pullRequests: [{ ...snapshot().pullRequests[0]!, diff: "diff --git a/a b/a\n+change" }],
      controlComments: [...snapshot().controlComments, validation],
    });
    const narrative = [
      "## Verdict", "approved", "", "## Standards", "No findings.", "", "## Spec", "No findings.",
      "", "## Interactions", "None.", "", "## Constraints", "None.",
    ].join("\n");
    const fake = fakePorts(initial);
    let reviewRequest: Parameters<NonNullable<ManagedPullRequestContinuationPorts["runReview"]>>[0] | undefined;
    let recorded: Parameters<ManagedPullRequestContinuationPorts["recordControlComment"]>[0] | undefined;
    fake.ports.runReview = async (request) => {
      reviewRequest = request;
      return {
        kind: "review",
        status: "succeeded",
        revision: request.headRevision,
        baseRevision: request.baseRevision,
        round: request.round,
        disposition: "approved",
        narrative,
        capabilities: request.capabilities,
      };
    };
    fake.ports.recordControlComment = async (record) => {
      recorded = record;
      return { created: true };
    };

    const result = await continueManagedPullRequest({
      repository: initial.repository,
      ticketNumber: 66,
      lease: { status: "acquired", leaseId: "lease-1" },
      policy,
      workflowRun: { id: "run-3", attempt: 1 },
    }, fake.ports);

    expect(reviewRequest).toMatchObject({
      headRevision: INITIAL,
      baseRevision: INITIAL,
      round: 1,
      diff: "diff --git a/a b/a\n+change",
      capabilities: { sourceReadOnly: true, canEdit: false, githubCredentials: false },
    });
    expect(recorded).toMatchObject({
      narrative,
      envelope: {
        kind: "review-handoff",
        inputRevision: INITIAL,
        baseRevision: INITIAL,
        disposition: "approved",
      },
    });
    expect(result).toMatchObject({ status: "selected", transition: { kind: "record-review-handoff" } });
  });

  it("does not persist stage evidence after the PR head changes", async () => {
    const initial = snapshot({ targetBranchRevision: INITIAL });
    const fake = fakePorts(initial);
    fake.ports.runValidation = async (request) => ({
      kind: "validation",
      status: "succeeded",
      revision: request.revision,
      round: request.round,
      commands: request.checks.map((check, index) => ({
        command: check.command,
        exitCode: 0,
        checkId: `check-${index}`,
        timedOut: false,
      })),
    });
    let reconstructCount = 0;
    fake.ports.reconstruct = async () => {
      reconstructCount += 1;
      return reconstructCount === 1
        ? { snapshot: initial }
        : { snapshot: { ...initial, pullRequests: [{ ...initial.pullRequests[0]!, headRevision: SYNCHRONIZED }] } };
    };

    await expect(continueManagedPullRequest({
      repository: initial.repository,
      ticketNumber: 66,
      lease: { status: "acquired", leaseId: "lease-1" },
      policy,
      workflowRun: { id: "run-2", attempt: 1 },
    }, fake.ports)).rejects.toThrow("Revision changed before stage evidence was persisted");
    expect(fake.calls.some((call) => call.startsWith("comment:validation"))).toBe(false);
  });

  it("synchronizes the one authenticated Managed PR instead of creating another PR", async () => {
    const { ports, calls } = fakePorts(snapshot());

    await expect(continueManagedPullRequest({
      repository: "canxer314/obsidian-llm-wiki-cli",
      ticketNumber: 66,
      lease: { status: "acquired", leaseId: "ticket-66" },
      policy,
      workflowRun: { id: "run-2", attempt: 1 },
    }, ports)).resolves.toMatchObject({
      status: "synchronized",
      prNumber: 73,
      inputRevision: INITIAL,
      outputRevision: SYNCHRONIZED,
      conflictResolved: false,
    });

    expect(calls).toEqual([
      "reconstruct",
      `comment:synchronization:undefined`,
      `synchronize:73:afk/ticket-66:${INITIAL}:${TARGET}`,
      `comment:synchronization:${SYNCHRONIZED}`,
      "reconstruct",
      `comment:synchronization:${SYNCHRONIZED}`,
    ]);
  });
});
