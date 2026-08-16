import { describe, expect, it, vi } from "vitest";

import type { RepairRequest } from "@llm-wiki/afk-delivery-core";
import {
  buildRepairPrompt,
  runRepairStage,
  type RepairStagePorts,
} from "../src/repair.js";
import type { ImplementationAgentInvocation } from "../src/implementation.js";

const REJECTED = "a".repeat(40);
const REPAIRED = "b".repeat(40);
const stagePolicy = {
  model: "fable",
  contextWindow: 372_000,
  maximumIterations: 24,
  maximumInfrastructureAttempts: 2,
  timeoutMs: 60_000,
  cpuLimit: 2,
};
const reviewHandoff = [
  "## Verdict", "changes-required", "", "## Standards", "### F-1", "`src/retry.ts:10` duplicates comments.",
  "", "## Spec", "### F-2", "`src/state.ts:20` omits bound exhaustion.",
  "", "## Interactions", "F-1 and F-2 share the retry path.", "", "## Constraints", "Preserve validation.",
].join("\n");

function request(): RepairRequest {
  return {
    ticket: {
      number: 68,
      open: true,
      labels: ["ready-for-agent"],
      openBlockerNumbers: [],
      dependencyDataComplete: true,
      body: "Run the bounded Review-Repair loop.",
    },
    prNumber: 73,
    headBranch: "afk/ticket-68",
    round: 1,
    rejectedRevision: REJECTED,
    reviewTransitionId: "review-1",
    reviewHandoff,
    repositoryPolicy: {
      schemaVersion: 1,
      targetBranch: "master",
      readyLabel: "ready-for-agent",
      prohibitedLabel: "afk:prohibited",
      needsHumanLabel: "afk:needs-human",
      trustedActors: [{ login: "delivery-bot", type: "Bot" }],
      maximumRepairRounds: 2,
      requiredValidationCommands: ["npm test"],
      reviewSkill: { path: "/skills/code-review/SKILL.md", revision: "sha256:review" },
      mergeStrategy: "squash",
    },
    repositoryInstructions: "Repository instructions",
    domainDocuments: [{ path: "CONTEXT.md", content: "AFK Delivery" }],
    architectureDecisions: [{ path: "docs/adr/0001.md", content: "GitHub is durable state" }],
    capabilities: {
      sourceReadOnly: false,
      canEdit: true,
      canCommit: true,
      canPush: false,
      canComment: false,
      canApprove: false,
      githubCredentials: false,
    },
  };
}

function ports(narrative: string, outputRevision = REPAIRED): RepairStagePorts {
  return {
    createWorktree: async () => ({ path: "/repair", branch: "afk/ticket-68", baseRevision: REJECTED }),
    runAgent: async () => ({ exitCode: 0, stdout: narrative, stderr: "" }),
    resolveHeadRevision: async () => outputRevision,
    publishRevision: async () => undefined,
    removeWorktree: async () => undefined,
  };
}

const completeHandoff = [
  "## Changes", "Fixed retry identity and bounded exhaustion.",
  "", "## Preserved Behavior", "Exact-Revision validation remains required.",
  "", "## Finding Dispositions", "### F-1", "addressed", "Stable comment identity now prevents duplicates.",
  "", "### F-2", "intentionally-unaddressed", "The existing core transition already enforces the bound.",
  "", "## Validation", "`npm test` passed.",
  "", "## Resulting Revision", REPAIRED,
].join("\n");

describe("repair stage", () => {
  it("runs a fresh bounded agent with complete trusted context and accepts an exhaustive Repair Handoff", async () => {
    const value = request();
    let invocation: ImplementationAgentInvocation | undefined;
    const stagePorts = ports(completeHandoff);
    stagePorts.runAgent = async (input) => {
      invocation = input;
      return { exitCode: 0, stdout: completeHandoff, stderr: "" };
    };
    expect(buildRepairPrompt(value)).toContain(reviewHandoff);
    expect(buildRepairPrompt(value)).toContain("GitHub is durable state");

    await expect(runRepairStage(value, stagePolicy, stagePorts)).resolves.toEqual({
      kind: "repair",
      status: "succeeded",
      inputRevision: REJECTED,
      outputRevision: REPAIRED,
      round: 1,
      reviewTransitionId: "review-1",
      narrative: completeHandoff,
      findings: [
        { findingId: "F-1", disposition: "addressed", rationale: "Stable comment identity now prevents duplicates." },
        { findingId: "F-2", disposition: "intentionally-unaddressed", rationale: "The existing core transition already enforces the bound." },
      ],
      findingsComplete: true,
    });
    expect(invocation).toMatchObject({
      worktreePath: "/repair",
      environment: {},
      runAsNonRoot: true,
      readOnlyRootFilesystem: true,
      privileged: false,
      mountDockerSocket: false,
      mountHostClaudeConfig: false,
    });
  });

  it("rejects a repair request that grants the agent forbidden authority", async () => {
    const value = request();
    const createWorktree = vi.fn(ports(completeHandoff).createWorktree);
    value.capabilities = {
      ...value.capabilities,
      canPush: true,
    } as RepairRequest["capabilities"];

    await expect(runRepairStage(value, stagePolicy, { ...ports(completeHandoff), createWorktree })).rejects.toThrow("capability profile");
    expect(createWorktree).not.toHaveBeenCalled();
  });

  it.each(["agent", "publication"])("returns a failed outcome for %s infrastructure failure", async (boundary) => {
    const stagePorts = ports(completeHandoff);
    if (boundary === "agent") {
      stagePorts.runAgent = async () => { throw new Error("agent transport unavailable"); };
    } else {
      stagePorts.publishRevision = async () => { throw new Error("lease publication unavailable"); };
    }

    await expect(runRepairStage(request(), stagePolicy, stagePorts)).resolves.toMatchObject({
      kind: "repair",
      status: "failed",
      findingsComplete: false,
      narrative: expect.stringContaining("infrastructure failure"),
    });
  });

  it("retries only worktree acquisition and fails after the configured infrastructure bound", async () => {
    const createWorktree = vi.fn(async () => {
      throw new Error("clone unavailable");
    });
    const runAgent = vi.fn(ports(completeHandoff).runAgent);

    await expect(runRepairStage(request(), stagePolicy, {
      ...ports(completeHandoff),
      createWorktree,
      runAgent,
    })).resolves.toMatchObject({
      status: "failed",
      narrative: "repair worktree infrastructure retries exhausted after 2 attempts",
    });
    expect(createWorktree).toHaveBeenCalledTimes(2);
    expect(runAgent).not.toHaveBeenCalled();
  });

  it("does not retry an agent boundary that may already have produced a commit", async () => {
    const runAgent = vi.fn(async () => {
      throw new Error("agent response lost");
    });

    await expect(runRepairStage(request(), stagePolicy, {
      ...ports(completeHandoff),
      runAgent,
    })).resolves.toMatchObject({
      status: "failed",
      narrative: "repair agent infrastructure failure",
    });
    expect(runAgent).toHaveBeenCalledTimes(1);
  });

  it("redacts credentials from the durable Repair Handoff", async () => {
    const secret = "ghp_12345678901234567890";
    const narrative = completeHandoff.replace(
      "Stable comment identity now prevents duplicates.",
      `Stable comment identity now prevents duplicates without ${secret}.`,
    );

    const result = await runRepairStage(request(), stagePolicy, ports(narrative));

    expect(result.status).toBe("succeeded");
    expect(result.narrative).not.toContain(secret);
    expect(result.findings[0]).toEqual({
      findingId: "F-1",
      disposition: "addressed",
      rationale: "Stable comment identity now prevents duplicates without [REDACTED].",
    });
  });

  it.each([
    ["missing finding", completeHandoff.replace(/\n### F-2[\s\S]*?(?=\n## Validation)/u, "")],
    ["unknown finding", completeHandoff.replace("### F-2", "### F-3")],
    ["missing rationale", completeHandoff.replace("The existing core transition already enforces the bound.", "")],
    ["contradictory Revision", completeHandoff.replace(REPAIRED, "c".repeat(40))],
    ["extra preamble", `untrusted preamble\n\n${completeHandoff}`],
    ["extra section", completeHandoff.replace("## Validation", "## Unexpected\nextra\n\n## Validation")],
  ])("fails closed for %s", async (_name, narrative) => {
    await expect(runRepairStage(request(), stagePolicy, ports(narrative))).resolves.toMatchObject({
      kind: "repair",
      status: "failed",
      findingsComplete: false,
    });
  });
});
