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
const CHANGES_REQUIRED_REVIEW = [
  "## Verdict", "changes-required", "", "## Standards", "### F-1\nRetry duplicates the comment.",
  "", "## Spec", "No additional findings.", "", "## Interactions", "Preserve recovery.",
  "", "## Constraints", "Do not weaken validation.",
].join("\n");
const REPAIR_HANDOFF = "## Changes\nFixed retry identity.\n\n## Preserved Behavior\nRecovery remains unchanged.\n\n## Finding Dispositions\n### F-1\naddressed\ncomment identity is stable\n\n## Validation\nnpm test\n\n## Resulting Revision\n" + SYNCHRONIZED;

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
    revision: "sha256:bab450f3b140af9327d945cf9bb12dc5c68bc0381f9afb1aea42083709fa5035",
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

function repairSnapshot(overrides: Partial<AuthenticatedGitHubSnapshot> = {}): AuthenticatedGitHubSnapshot {
  const base = snapshot({
    targetBranchRevision: INITIAL,
    repositoryInstructions: "Repository instructions",
    domainDocuments: [{ path: "CONTEXT.md", content: "Domain" }],
    architectureDecisions: [{ path: "docs/adr/0001.md", content: "Decision" }],
    pullRequests: [{ ...snapshot().pullRequests[0]!, diff: "diff --git a/a b/a\n+change" }],
    controlComments: [
      ...snapshot().controlComments,
      {
        commentId: "validation-1",
        author: { login: "delivery-bot", type: "Bot" as const },
        envelope: {
          schemaVersion: 1 as const, kind: "validation" as const, repository: "canxer314/obsidian-llm-wiki-cli",
          ticketNumber: 66, prNumber: 73, round: 1, transitionId: "validation-1", inputRevision: INITIAL,
          disposition: "succeeded", workflowRunId: "run-2", workflowRunAttempt: 1,
          commands: [
            { command: "npm test", exitCode: 0, checkId: "test", timedOut: false },
            { command: "npm run typecheck", exitCode: 0, checkId: "types", timedOut: false },
          ],
        },
        narrative: "",
      },
      {
        commentId: "review-1",
        author: { login: "delivery-bot", type: "Bot" as const },
        envelope: {
          schemaVersion: 1 as const, kind: "review-handoff" as const, repository: "canxer314/obsidian-llm-wiki-cli",
          ticketNumber: 66, prNumber: 73, round: 1, transitionId: "review-1", inputRevision: INITIAL,
          baseRevision: INITIAL, disposition: "changes-required", workflowRunId: "run-2", workflowRunAttempt: 1,
        },
        narrative: CHANGES_REQUIRED_REVIEW,
      },
    ],
  });
  return { ...base, ...overrides };
}

function approvedSnapshot(overrides: Partial<AuthenticatedGitHubSnapshot> = {}): AuthenticatedGitHubSnapshot {
  const initial = snapshot({
    targetBranchRevision: INITIAL,
    repositoryInstructions: "Repository instructions",
    domainDocuments: [{ path: "CONTEXT.md", content: "Domain" }],
    architectureDecisions: [{ path: "docs/adr/0001.md", content: "Decision" }],
    pullRequests: [{ ...snapshot().pullRequests[0]!, baseRevision: INITIAL, diff: "diff --git a/a b/a\n+change" }],
  });
  return {
    ...initial,
    controlComments: [
      ...initial.controlComments,
      {
        commentId: "validation-1",
        author: { login: "delivery-bot", type: "Bot" as const },
        envelope: {
          schemaVersion: 1 as const, kind: "validation" as const, repository: initial.repository,
          ticketNumber: 66, prNumber: 73, round: 1, transitionId: "validation-1", inputRevision: INITIAL,
          disposition: "succeeded", workflowRunId: "run-2", workflowRunAttempt: 1,
          commands: [
            { command: "npm test", exitCode: 0, checkId: "test", timedOut: false },
            { command: "npm run typecheck", exitCode: 0, checkId: "types", timedOut: false },
          ],
        },
        narrative: "",
      },
      {
        commentId: "review-1",
        author: { login: "delivery-bot", type: "Bot" as const },
        envelope: {
          schemaVersion: 1 as const, kind: "review-handoff" as const, repository: initial.repository,
          ticketNumber: 66, prNumber: 73, round: 1, transitionId: "review-1", inputRevision: INITIAL,
          baseRevision: INITIAL, disposition: "approved", workflowRunId: "run-2", workflowRunAttempt: 1,
        },
        narrative: [
          "## Verdict", "approved", "", "## Standards", "No findings.", "", "## Spec", "No findings.",
          "", "## Interactions", "None.", "", "## Constraints", "None.",
        ].join("\n"),
      },
    ],
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

  it("executes repair from the rejected Revision and persists its complete handoff after fresh reconstruction", async () => {
    const reviewNarrative = CHANGES_REQUIRED_REVIEW;
    const initial = snapshot({
      targetBranchRevision: INITIAL,
      repositoryInstructions: "Repository instructions",
      domainDocuments: [{ path: "CONTEXT.md", content: "Domain" }],
      architectureDecisions: [{ path: "docs/adr/0001.md", content: "Decision" }],
      controlComments: [
        ...snapshot().controlComments,
        {
          commentId: "validation-1",
          author: { login: "delivery-bot", type: "Bot" as const },
          envelope: {
            schemaVersion: 1 as const, kind: "validation" as const, repository: "canxer314/obsidian-llm-wiki-cli",
            ticketNumber: 66, prNumber: 73, round: 1, transitionId: "validation-1", inputRevision: INITIAL,
            disposition: "succeeded", workflowRunId: "run-2", workflowRunAttempt: 1,
            commands: [
              { command: "npm test", exitCode: 0, checkId: "test", timedOut: false },
              { command: "npm run typecheck", exitCode: 0, checkId: "types", timedOut: false },
            ],
          },
          narrative: "",
        },
        {
          commentId: "review-1",
          author: { login: "delivery-bot", type: "Bot" as const },
          envelope: {
            schemaVersion: 1 as const, kind: "review-handoff" as const, repository: "canxer314/obsidian-llm-wiki-cli",
            ticketNumber: 66, prNumber: 73, round: 1, transitionId: "review-1", inputRevision: INITIAL,
            baseRevision: INITIAL, disposition: "changes-required", workflowRunId: "run-2", workflowRunAttempt: 1,
          },
          narrative: reviewNarrative,
        },
      ],
    });
    let current = initial;
    const fake = fakePorts(initial);
    fake.ports.reconstruct = async () => ({ snapshot: current });
    let repairRequest: Parameters<NonNullable<ManagedPullRequestContinuationPorts["runRepair"]>>[0] | undefined;
    let recorded: Parameters<ManagedPullRequestContinuationPorts["recordControlComment"]>[0] | undefined;
    let commentSequence = 0;
    const repairHandoff = REPAIR_HANDOFF;
    fake.ports.runRepair = async (request) => {
      repairRequest = request;
      current = {
        ...current,
        pullRequests: current.pullRequests.map((pr) => ({ ...pr, headRevision: SYNCHRONIZED })),
      };
      return {
        kind: "repair", status: "succeeded", inputRevision: INITIAL, outputRevision: SYNCHRONIZED,
        round: 1, narrative: repairHandoff,
        reviewTransitionId: request.reviewTransitionId,
        findings: [{ findingId: "F-1", disposition: "addressed", rationale: "comment identity is stable" }],
        findingsComplete: true,
      };
    };
    fake.ports.recordControlComment = async (record) => {
      recorded = record;
      commentSequence += 1;
      current = {
        ...current,
        controlComments: [...current.controlComments, {
          commentId: `repair-${commentSequence}`,
          author: { login: "delivery-bot", type: "Bot" as const },
          envelope: record.envelope,
          narrative: record.narrative ?? "",
        }],
      };
      return { created: true };
    };

    const result = await continueManagedPullRequest({
      repository: initial.repository,
      ticketNumber: 66,
      lease: { status: "acquired", leaseId: "lease-1" },
      policy,
      workflowRun: { id: "run-3", attempt: 1 },
    }, fake.ports);

    expect(repairRequest).toMatchObject({
      rejectedRevision: INITIAL,
      reviewHandoff: reviewNarrative,
      repositoryInstructions: "Repository instructions",
      capabilities: { canEdit: true, canCommit: true, canPush: false, canApprove: false, githubCredentials: false },
    });
    expect(recorded).toMatchObject({
      narrative: repairHandoff,
      envelope: { kind: "repair-handoff", inputRevision: INITIAL, outputRevision: SYNCHRONIZED, round: 1 },
    });
    expect(result).toMatchObject({ status: "selected", transition: { kind: "record-repair-handoff" } });
  });

  it("does not run repair when its durable start intent cannot be recorded", async () => {
    const initial = repairSnapshot();
    const fake = fakePorts(initial);
    let repairCalls = 0;
    fake.ports.recordControlComment = async () => {
      throw new Error("GitHub comment unavailable");
    };
    fake.ports.runRepair = async () => {
      repairCalls += 1;
      throw new Error("repair must not run without durable intent");
    };

    await expect(continueManagedPullRequest({
      repository: initial.repository,
      ticketNumber: 66,
      lease: { status: "acquired", leaseId: "lease-1" },
      policy,
      workflowRun: { id: "run-3", attempt: 1 },
    }, fake.ports)).rejects.toThrow("GitHub comment unavailable");
    expect(repairCalls).toBe(0);
  });

  it("records Needs Human after a failed repair without publishing a Repair Handoff", async () => {
    let current = repairSnapshot();
    const fake = fakePorts(current);
    const controlKinds: string[] = [];
    let needsHumanReason = "";
    fake.ports.reconstruct = async () => ({ snapshot: current });
    fake.ports.recordControlComment = async (record) => {
      controlKinds.push(`${record.envelope.kind}:${record.envelope.disposition}`);
      current = {
        ...current,
        controlComments: [...current.controlComments, {
          commentId: `control-${controlKinds.length}`,
          author: { login: "delivery-bot", type: "Bot" as const },
          envelope: record.envelope,
          narrative: record.narrative ?? "",
        }],
      };
      return { created: true };
    };
    fake.ports.runRepair = async (request) => ({
      kind: "repair", status: "failed", inputRevision: request.rejectedRevision,
      outputRevision: request.rejectedRevision, round: request.round,
      reviewTransitionId: request.reviewTransitionId,
      narrative: "repair agent exited with 1", findings: [], findingsComplete: false,
    });
    fake.ports.recordNeedsHuman = async (record) => {
      needsHumanReason = record.reason;
      return { created: true };
    };

    await expect(continueManagedPullRequest({
      repository: current.repository,
      ticketNumber: 66,
      lease: { status: "acquired", leaseId: "lease-1" },
      policy,
      workflowRun: { id: "run-3", attempt: 1 },
    }, fake.ports)).resolves.toMatchObject({
      status: "needs-human",
      reason: "repair stage did not succeed",
    });
    expect(controlKinds).toEqual(["repair-handoff:started"]);
    expect(needsHumanReason).toBe("repair stage did not succeed");
  });

  it("records Needs Human when publication may have succeeded before its response was lost", async () => {
    let current = repairSnapshot();
    const fake = fakePorts(current);
    let needsHuman = 0;
    fake.ports.reconstruct = async () => ({ snapshot: current });
    fake.ports.recordControlComment = async (record) => {
      current = {
        ...current,
        controlComments: [...current.controlComments, {
          commentId: "repair-start",
          author: { login: "delivery-bot", type: "Bot" as const },
          envelope: record.envelope,
          narrative: record.narrative ?? "",
        }],
      };
      return { created: true };
    };
    fake.ports.runRepair = async (request) => {
      current = {
        ...current,
        pullRequests: current.pullRequests.map((pr) => ({ ...pr, headRevision: SYNCHRONIZED })),
      };
      return {
        kind: "repair", status: "failed", inputRevision: request.rejectedRevision,
        outputRevision: SYNCHRONIZED, round: request.round,
        reviewTransitionId: request.reviewTransitionId,
        narrative: "repair publication infrastructure failure", findings: [], findingsComplete: false,
      };
    };
    fake.ports.recordNeedsHuman = async () => {
      needsHuman += 1;
      return { created: true };
    };

    await expect(continueManagedPullRequest({
      repository: current.repository,
      ticketNumber: 66,
      lease: { status: "acquired", leaseId: "lease-1" },
      policy,
      workflowRun: { id: "run-3", attempt: 1 },
    }, fake.ports)).resolves.toMatchObject({ status: "needs-human" });
    expect(needsHuman).toBe(1);
  });

  it("does not publish a Repair Handoff when repair leaves the head unchanged", async () => {
    const initial = repairSnapshot();
    const fake = fakePorts(initial);
    const controlKinds: string[] = [];
    fake.ports.recordControlComment = async (record) => {
      controlKinds.push(`${record.envelope.kind}:${record.envelope.disposition}`);
      return { created: true };
    };
    fake.ports.runRepair = async (request) => ({
      kind: "repair", status: "succeeded", inputRevision: request.rejectedRevision,
      outputRevision: request.rejectedRevision, round: request.round,
      reviewTransitionId: request.reviewTransitionId,
      narrative: REPAIR_HANDOFF.replace(SYNCHRONIZED, INITIAL),
      findings: [{ findingId: "F-1", disposition: "addressed", rationale: "comment identity is stable" }],
      findingsComplete: true,
    });

    await expect(continueManagedPullRequest({
      repository: initial.repository,
      ticketNumber: 66,
      lease: { status: "acquired", leaseId: "lease-1" },
      policy,
      workflowRun: { id: "run-3", attempt: 1 },
    }, fake.ports)).rejects.toThrow("repair did not produce a new Revision");
    expect(controlKinds).toEqual(["repair-handoff:started"]);
  });

  it.each([
    ["after the agent committed but before publication", INITIAL],
    ["after publication but before reconstruction", SYNCHRONIZED],
  ])("does not duplicate repair on retry %s", async (_boundary, currentHead) => {
    const initial = repairSnapshot();
    const started = initial.controlComments.concat({
      commentId: "repair-started",
      author: { login: "delivery-bot", type: "Bot" as const },
      envelope: {
        schemaVersion: 1 as const,
        kind: "repair-handoff" as const,
        repository: initial.repository,
        ticketNumber: 66,
        prNumber: 73,
        round: 1,
        transitionId: "repair-started",
        inputRevision: INITIAL,
        disposition: "started",
        workflowRunId: "run-3",
        workflowRunAttempt: 1,
        reviewTransitionId: "review-1",
      },
      narrative: "Repair started.",
    });
    const retry = {
      ...initial,
      pullRequests: initial.pullRequests.map((pr) => ({ ...pr, headRevision: currentHead })),
      controlComments: started,
    };
    const fake = fakePorts(retry);
    let repairCalls = 0;
    let needsHumanCalls = 0;
    fake.ports.runRepair = async () => {
      repairCalls += 1;
      throw new Error("repair must not run twice");
    };
    fake.ports.recordNeedsHuman = async () => {
      needsHumanCalls += 1;
      return { created: true };
    };

    await expect(continueManagedPullRequest({
      repository: retry.repository,
      ticketNumber: 66,
      lease: { status: "acquired", leaseId: "lease-retry" },
      policy,
      workflowRun: { id: "run-4", attempt: 2 },
    }, fake.ports)).resolves.toMatchObject({ status: "needs-human" });
    expect(repairCalls).toBe(0);
    expect(needsHumanCalls).toBe(1);
  });

  it("continues with fresh validation when the Repair Handoff write response was lost", async () => {
    const initial = repairSnapshot();
    const recovered = {
      ...initial,
      pullRequests: initial.pullRequests.map((pr) => ({
        ...pr,
        headRevision: SYNCHRONIZED,
        diff: "diff --git a/a b/a\n+repaired",
      })),
      controlComments: [
        ...initial.controlComments,
        {
          commentId: "repair-started",
          author: { login: "delivery-bot", type: "Bot" as const },
          envelope: {
            schemaVersion: 1 as const, kind: "repair-handoff" as const,
            repository: initial.repository, ticketNumber: 66, prNumber: 73, round: 1,
            transitionId: "repair-started", inputRevision: INITIAL, disposition: "started",
            workflowRunId: "run-3", workflowRunAttempt: 1, reviewTransitionId: "review-1",
          },
          narrative: "Repair started.",
        },
        {
          commentId: "repair-succeeded",
          author: { login: "delivery-bot", type: "Bot" as const },
          envelope: {
            schemaVersion: 1 as const, kind: "repair-handoff" as const,
            repository: initial.repository, ticketNumber: 66, prNumber: 73, round: 1,
            transitionId: "repair-succeeded", inputRevision: INITIAL, outputRevision: SYNCHRONIZED,
            disposition: "succeeded", workflowRunId: "run-3", workflowRunAttempt: 1,
            reviewTransitionId: "review-1",
          },
          narrative: REPAIR_HANDOFF,
        },
      ],
    };
    const fake = fakePorts(recovered);
    let repairCalls = 0;
    let validationCalls = 0;
    const recordedKinds: string[] = [];
    fake.ports.runRepair = async () => {
      repairCalls += 1;
      throw new Error("repair must not run twice");
    };
    fake.ports.runValidation = async (request) => {
      validationCalls += 1;
      return {
        kind: "validation", status: "succeeded", revision: request.revision, round: request.round,
        commands: request.checks.map((check, index) => ({
          command: check.command, exitCode: 0, checkId: `recovered-${index}`, timedOut: false,
        })),
      };
    };
    fake.ports.recordControlComment = async (record) => {
      recordedKinds.push(record.envelope.kind);
      return { created: true };
    };

    await expect(continueManagedPullRequest({
      repository: recovered.repository,
      ticketNumber: 66,
      lease: { status: "acquired", leaseId: "lease-retry" },
      policy,
      workflowRun: { id: "run-4", attempt: 2 },
    }, fake.ports)).resolves.toMatchObject({
      status: "selected",
      transition: { kind: "record-validation", round: 2 },
    });
    expect({ repairCalls, validationCalls }).toEqual({ repairCalls: 0, validationCalls: 1 });
    expect(recordedKinds).toEqual(["validation"]);
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

  it("publishes the complete Merge Report, rechecks GitHub, and merges only the proven exact Revision", async () => {
    let current = approvedSnapshot();
    const fake = fakePorts(current);
    const calls: string[] = [];
    fake.ports.reconstruct = async () => {
      calls.push("reconstruct");
      return { snapshot: current };
    };
    fake.ports.recordMergeReport = async (record) => {
      calls.push(`report:${record.report.headRevision}:${record.strategy}`);
      current = {
        ...current,
        controlComments: [...current.controlComments, {
          commentId: "merge-report-1",
          author: { login: "delivery-bot", type: "Bot" as const },
          envelope: record.envelope,
          narrative: record.narrative,
        }],
      };
      return { created: true };
    };
    fake.ports.mergeExactRevision = async (request) => {
      calls.push(`merge:${request.exactRevision}:${request.strategy}`);
      return { merged: true };
    };

    await expect(continueManagedPullRequest({
      repository: current.repository,
      ticketNumber: 66,
      lease: { status: "acquired", leaseId: "lease-merge" },
      policy,
      workflowRun: { id: "run-merge", attempt: 1 },
    }, fake.ports)).resolves.toMatchObject({
      status: "merged",
      prNumber: 73,
      exactRevision: INITIAL,
      reportCreated: true,
    });
    expect(calls).toEqual([
      "reconstruct",
      `report:${INITIAL}:squash`,
      "reconstruct",
      `merge:${INITIAL}:squash`,
    ]);
  });

  it.each([
    ["closed ticket", (value: AuthenticatedGitHubSnapshot) => ({ ...value, ticket: { ...value.ticket, open: false } })],
    ["removed authorization", (value: AuthenticatedGitHubSnapshot) => ({ ...value, ticket: { ...value.ticket, labels: [] } })],
    ["new blocker", (value: AuthenticatedGitHubSnapshot) => ({ ...value, ticket: { ...value.ticket, openBlockerNumbers: [65] } })],
    ["AFK prohibition", (value: AuthenticatedGitHubSnapshot) => ({ ...value, ticket: { ...value.ticket, labels: ["ready-for-agent", "afk:prohibited"] } })],
    ["second Managed PR", (value: AuthenticatedGitHubSnapshot) => ({ ...value, pullRequests: [...value.pullRequests, { ...value.pullRequests[0]!, number: 74 }] })],
    ["failed required checks", (value: AuthenticatedGitHubSnapshot) => ({ ...value, pullRequests: value.pullRequests.map((pr) => ({ ...pr, requiredChecksPass: false })) })],
    ["unknown mergeability", (value: AuthenticatedGitHubSnapshot) => ({ ...value, pullRequests: value.pullRequests.map((pr) => ({ ...pr, mergeable: "unknown" as const })) })],
    ["new changes-required history", (value: AuthenticatedGitHubSnapshot) => ({
      ...value,
      controlComments: [...value.controlComments, {
        commentId: "late-review",
        author: { login: "delivery-bot", type: "Bot" as const },
        envelope: {
          schemaVersion: 1 as const, kind: "review-handoff" as const, repository: value.repository,
          ticketNumber: 66, prNumber: 73, round: 1, transitionId: "late-review", inputRevision: INITIAL,
          baseRevision: INITIAL, disposition: "changes-required", workflowRunId: "run-late", workflowRunAttempt: 1,
        },
        narrative: CHANGES_REQUIRED_REVIEW,
      }],
    })],
  ] as const)("fails closed when %s appears after Merge Report publication", async (_name, mutate) => {
    let current = approvedSnapshot();
    const fake = fakePorts(current);
    let mergeCalls = 0;
    let needsHumanCalls = 0;
    fake.ports.reconstruct = async () => ({ snapshot: current });
    fake.ports.recordMergeReport = async (record) => {
      current = mutate({
        ...current,
        controlComments: [...current.controlComments, {
          commentId: "merge-report-1",
          author: { login: "delivery-bot", type: "Bot" as const },
          envelope: record.envelope,
          narrative: record.narrative,
        }],
      });
      return { created: true };
    };
    fake.ports.mergeExactRevision = async () => {
      mergeCalls += 1;
      return { merged: true };
    };
    fake.ports.recordNeedsHuman = async () => {
      needsHumanCalls += 1;
      return { created: true };
    };

    await expect(continueManagedPullRequest({
      repository: current.repository,
      ticketNumber: 66,
      lease: { status: "acquired", leaseId: "lease-merge" },
      policy,
      workflowRun: { id: "run-merge", attempt: 1 },
    }, fake.ports)).resolves.toMatchObject({ status: "needs-human" });
    expect({ mergeCalls, needsHumanCalls }).toEqual({ mergeCalls: 0, needsHumanCalls: 1 });
  });

  it("aborts merge when the PR head changes after Merge Report publication", async () => {
    let current = approvedSnapshot();
    const fake = fakePorts(current);
    let mergeCalls = 0;
    fake.ports.reconstruct = async () => ({ snapshot: current });
    fake.ports.recordMergeReport = async () => {
      current = {
        ...current,
        pullRequests: current.pullRequests.map((pr) => ({ ...pr, headRevision: SYNCHRONIZED })),
      };
      return { created: true };
    };
    fake.ports.mergeExactRevision = async () => {
      mergeCalls += 1;
      return { merged: true };
    };

    await expect(continueManagedPullRequest({
      repository: current.repository,
      ticketNumber: 66,
      lease: { status: "acquired", leaseId: "lease-merge" },
      policy,
      workflowRun: { id: "run-merge", attempt: 1 },
    }, fake.ports)).resolves.toMatchObject({ status: "needs-human" });
    expect(mergeCalls).toBe(0);
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
