import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

import type {
  AuthenticatedGitHubSnapshot,
  RepositoryPolicy,
} from "@llm-wiki/afk-delivery-core";
import {
  continueManagedPullRequest,
  type ManagedPullRequestContinuationPorts,
} from "../src/managed-pr-continuation.js";
import { executeNewImplementationTransition } from "../src/new-implementation.js";
import { discoverDeliveryFrontier, type GitHubReadPort } from "../src/index.js";

const execFileAsync = promisify(execFile);
const directories: string[] = [];
const repository = "owner/disposable";
const actor = { login: "delivery-bot", type: "Bot" as const };
const policy: RepositoryPolicy = {
  schemaVersion: 1,
  targetBranch: "master",
  readyLabel: "ready-for-agent",
  prohibitedLabel: "afk:prohibited",
  needsHumanLabel: "afk:needs-human",
  trustedActors: [actor],
  maximumRepairRounds: 2,
  requiredValidationCommands: ["npm test"],
  reviewSkill: { path: "/skills/code-review/SKILL.md", revision: "sha256:pinned-review" },
  mergeStrategy: "merge",
};

async function git(directory: string, ...args: string[]): Promise<string> {
  return (await execFileAsync("git", ["-C", directory, ...args])).stdout.trim();
}

function githubDiscovery(blockerOpen: () => boolean): GitHubReadPort {
  return {
    async request(path) {
      if (path.includes("/dependencies/blocked_by")) {
        return Response.json(blockerOpen()
          ? [{ number: 68, state: "open", labels: [], issue_dependencies_summary: { blocked_by: 0 } }]
          : []);
      }
      if (path.includes("/issues?")) {
        return Response.json([{
          number: 69,
          state: "open",
          labels: ["ready-for-agent"],
          issue_dependencies_summary: { blocked_by: blockerOpen() ? 1 : 0 },
        }]);
      }
      throw new Error(`unexpected GitHub path: ${path}`);
    },
  };
}

function reviewNarrative(disposition: "approved" | "changes-required"): string {
  if (disposition === "changes-required") {
    return [
      "## Verdict", "changes-required", "", "## Standards", "### F-1", "Persist retry identity.",
      "", "## Spec", "No additional findings.", "", "## Interactions", "Preserve delivery state.",
      "", "## Constraints", "Do not weaken exact-Revision validation.",
    ].join("\n");
  }
  return [
    "## Verdict", "approved", "", "## Standards", "### F-2", "Document the incident-safe timeout in a follow-up.",
    "", "## Spec", "No findings.", "", "## Interactions", "No findings.",
    "", "## Constraints", "No findings.",
  ].join("\n");
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

describe("AFK Delivery disposable repository acceptance", () => {
  it("waits, repairs, proves one Revision, merges it once, and replays without duplicates", async () => {
    const temporaryRoot = process.env.CLAUDE_JOB_DIR === undefined
      ? tmpdir()
      : join(process.env.CLAUDE_JOB_DIR, "tmp");
    const root = await mkdtemp(join(temporaryRoot, "afk-delivery-acceptance-"));
    directories.push(root);
    await git(root, "init", "-b", "master");
    await git(root, "config", "user.name", "AFK Acceptance");
    await git(root, "config", "user.email", "afk-acceptance@example.invalid");
    await writeFile(join(root, "delivery.txt"), "base\n");
    await git(root, "add", "delivery.txt");
    await git(root, "commit", "-m", "base");
    const baseRevision = await git(root, "rev-parse", "HEAD");

    let blockerOpen = true;
    const discovery = githubDiscovery(() => blockerOpen);
    await expect(discoverDeliveryFrontier(discovery, {
      owner: "owner", repository: "disposable", readyLabel: "ready-for-agent", prohibitedLabel: "afk:prohibited",
    })).resolves.toEqual({
      frontier: [],
      excluded: [{ ticketNumber: 69, reason: "open-blockers", openBlockerNumbers: [68] }],
    });
    blockerOpen = false;
    await expect(discoverDeliveryFrontier(discovery, {
      owner: "owner", repository: "disposable", readyLabel: "ready-for-agent", prohibitedLabel: "afk:prohibited",
    })).resolves.toMatchObject({ frontier: [{ number: 69 }], excluded: [] });

    const pullRequestComments: string[] = [];
    let implementationRevision = "";
    const implementation = await executeNewImplementationTransition({
      repository,
      ticket: { number: 69, title: "Prove and merge", body: "Implement the delivery change." },
      repositoryInstructions: [], domainDocuments: [], architectureDecisions: [],
      targetBranch: "master", validationCommands: ["npm test"],
      transitionId: "afk-v1-acceptance", workflowRunId: "run-implementation", trustedActor: actor,
      policy: { model: "claude-opus-5", contextWindow: 1_000_000, maximumIterations: 24, timeoutMs: 60_000, cpuLimit: 2 },
    }, {
      stage: {
        createWorktree: async (request) => {
          const branch = `afk/ticket-${request.ticket.number}-${request.transitionId}`;
          await git(root, "checkout", "-b", branch, "master");
          return { path: root, branch, baseRevision };
        },
        runAgent: async () => {
          await writeFile(join(root, "delivery.txt"), "implementation\n");
          await git(root, "add", "delivery.txt");
          await git(root, "commit", "-m", "implement ticket 69");
          return { exitCode: 0, stdout: "Implemented ticket 69.", stderr: "" };
        },
        resolveHeadRevision: async () => git(root, "rev-parse", "HEAD"),
        removeWorktree: async () => undefined,
      },
      publication: {
        findRemoteBranchRevision: async () => undefined,
        ensureRemoteBranch: async (_branch, revision) => { implementationRevision = revision; },
        findOpenPullRequests: async () => pullRequestComments.length === 0 ? [] : [{
          number: 70, headRevision: implementationRevision,
          headBranch: "afk/ticket-69-afk-v1-acceptance", baseBranch: "master",
          body: "Closes #69\n\n<!-- afk-managed-pr:69:afk-v1-acceptance -->",
          comments: pullRequestComments.map((body) => ({ author: actor, body })),
        }],
        createPullRequest: async (input) => ({
          number: 70, headRevision: implementationRevision, headBranch: input.headBranch,
          baseBranch: input.baseBranch, body: input.body, comments: [],
        }),
        postComment: async (_prNumber, body) => { pullRequestComments.push(body); },
      },
    });
    expect(implementation).toMatchObject({ status: "published", prNumber: 70, created: true });
    expect(pullRequestComments).toHaveLength(1);

    let currentRevision = implementationRevision;
    let ticketClosed = false;
    let mergedRevision: string | undefined;
    let reviewRuns = 0;
    const validatedRevisions: string[] = [];
    const followUps = new Map<string, { number: number; url: string }>();
    const reports = new Set<string>();
    let mergeMutations = 0;
    const controlComments: AuthenticatedGitHubSnapshot["controlComments"] = [{
      commentId: "managed-1", author: actor,
      envelope: {
        schemaVersion: 1, kind: "managed-pr", repository, ticketNumber: 69, prNumber: 70,
        round: 0, transitionId: "afk-v1-acceptance", inputRevision: implementationRevision,
        outputRevision: implementationRevision, disposition: "succeeded", workflowRunId: "run-implementation",
      },
      narrative: "Implemented ticket 69.",
    }];
    const snapshot = (): AuthenticatedGitHubSnapshot => ({
      repository,
      targetBranchRevision: baseRevision,
      repositoryInstructions: "Repository instructions",
      domainDocuments: [{ path: "CONTEXT.md", content: "AFK Delivery" }],
      architectureDecisions: [{ path: "docs/adr/0002.md", content: "Exact Revision merge" }],
      ticket: {
        number: 69, open: true, labels: ["ready-for-agent"], openBlockerNumbers: [],
        dependencyDataComplete: true, body: "Implement the delivery change.",
      },
      pullRequests: [{
        number: 70, ticketNumber: 69, open: true, targetBranch: "master",
        headBranch: "afk/ticket-69-afk-v1-acceptance", headRevision: currentRevision,
        baseRevision, mergeable: true, requiredChecksPass: true, managed: true,
        diff: "diff --git a/delivery.txt b/delivery.txt\n+delivery change",
      }],
      controlComments: [...controlComments],
    });
    let commentSequence = 0;
    const ports: ManagedPullRequestContinuationPorts = {
      reconstruct: async () => ({ snapshot: snapshot() }),
      publishPreparedSynchronization: async () => { throw new Error("no synchronization expected"); },
      synchronize: async () => { throw new Error("no synchronization expected"); },
      resolveConflicts: async () => { throw new Error("no conflict expected"); },
      recordControlComment: async (record) => {
        controlComments.push({
          commentId: `control-${++commentSequence}`, author: actor,
          envelope: record.envelope, narrative: record.narrative ?? "",
        });
        return { created: true };
      },
      recordNeedsHuman: async () => { throw new Error("acceptance flow must not need human intervention"); },
      runValidation: async (request) => {
        validatedRevisions.push(request.revision);
        return {
          kind: "validation", status: "succeeded", revision: request.revision, round: request.round,
          commands: request.checks.map((check, index) => ({
            command: check.command, exitCode: 0, checkId: `validation-${request.round}-${index}`, timedOut: false,
          })),
        };
      },
      runReview: async (request) => {
        reviewRuns += 1;
        const disposition = reviewRuns === 1 ? "changes-required" : "approved";
        return {
          kind: "review", status: "succeeded", revision: request.headRevision,
          baseRevision: request.baseRevision, round: request.round, disposition,
          narrative: reviewNarrative(disposition), capabilities: request.capabilities,
        };
      },
      runRepair: async (request) => {
        expect(request.rejectedRevision).toBe(implementationRevision);
        await writeFile(join(root, "delivery.txt"), "implementation with stable retry identity\n");
        await git(root, "add", "delivery.txt");
        await git(root, "commit", "-m", "repair F-1");
        currentRevision = await git(root, "rev-parse", "HEAD");
        return {
          kind: "repair", status: "succeeded", inputRevision: request.rejectedRevision,
          outputRevision: currentRevision, round: request.round, reviewTransitionId: request.reviewTransitionId,
          narrative: [
            "## Changes", "Persisted retry identity.", "", "## Preserved Behavior", "Delivery state is preserved.",
            "", "## Finding Dispositions", "### F-1", "addressed", "Retry identity is now stable.",
            "", "## Validation", "npm test", "", "## Resulting Revision", currentRevision,
          ].join("\n"),
          findings: [{ findingId: "F-1", disposition: "addressed", rationale: "Retry identity is now stable." }],
          findingsComplete: true,
        };
      },
      createFollowUpIssue: async (record) => {
        const existing = followUps.get(record.idempotencyKey);
        if (existing !== undefined) return { ...existing, created: false };
        const issue = { number: 91, url: "https://github.example/owner/disposable/issues/91" };
        followUps.set(record.idempotencyKey, issue);
        expect(record.observation).toContain("F-2");
        return { ...issue, created: true };
      },
      recordMergeReport: async (record) => {
        if (reports.has(record.idempotencyKey)) return { created: false };
        reports.add(record.idempotencyKey);
        expect(record.report.headRevision).toBe(currentRevision);
        expect(record.report.validatedRevision).toBe(currentRevision);
        expect(record.report.approvedRevision).toBe(currentRevision);
        expect(record.report.followUpIssues).toEqual([{
          number: 91, url: "https://github.example/owner/disposable/issues/91",
        }]);
        controlComments.push({
          commentId: "merge-report-1", author: actor,
          envelope: record.envelope, narrative: record.narrative,
        });
        return { created: true };
      },
      mergeExactRevision: async (record) => {
        expect(record.exactRevision).toBe(currentRevision);
        if (mergedRevision === record.exactRevision) return { merged: false };
        expect(await git(root, "rev-parse", "HEAD")).toBe(record.exactRevision);
        await git(root, "checkout", "master");
        await git(root, "merge", "--ff-only", record.exactRevision);
        mergedRevision = record.exactRevision;
        mergeMutations += 1;
        ticketClosed = true;
        return { merged: true };
      },
    };
    const request = {
      repository, ticketNumber: 69,
      lease: { status: "acquired" as const, leaseId: "lease-69" },
      policy, workflowRun: { id: "run-delivery", attempt: 1 },
    };

    await expect(continueManagedPullRequest(request, ports)).resolves.toMatchObject({
      status: "selected", transition: { kind: "record-validation", round: 1 },
    });
    await expect(continueManagedPullRequest(request, ports)).resolves.toMatchObject({
      status: "selected", transition: { kind: "record-review-handoff", round: 1 },
    });
    expect(controlComments.at(-1)?.envelope).toMatchObject({
      kind: "review-handoff", disposition: "changes-required", inputRevision: implementationRevision,
    });
    await expect(continueManagedPullRequest(request, ports)).resolves.toMatchObject({
      status: "selected", transition: { kind: "record-repair-handoff", round: 1 },
    });
    const repairedRevision = currentRevision;
    expect(repairedRevision).not.toBe(implementationRevision);
    await expect(continueManagedPullRequest(request, ports)).resolves.toMatchObject({
      status: "selected", transition: { kind: "record-validation", round: 2 },
    });
    await expect(continueManagedPullRequest(request, ports)).resolves.toMatchObject({
      status: "selected", transition: { kind: "record-review-handoff", round: 2 },
    });
    expect(controlComments.at(-1)?.envelope).toMatchObject({
      kind: "review-handoff", disposition: "approved", inputRevision: repairedRevision,
    });
    expect(validatedRevisions).toEqual([implementationRevision, repairedRevision]);

    await expect(continueManagedPullRequest(request, ports)).resolves.toMatchObject({
      status: "merged", exactRevision: repairedRevision, reportCreated: true, merged: true,
    });
    await expect(continueManagedPullRequest(request, ports)).resolves.toMatchObject({
      status: "merged", exactRevision: repairedRevision, reportCreated: false, merged: false,
    });

    expect(await git(root, "rev-parse", "master")).toBe(repairedRevision);
    expect(ticketClosed).toBe(true);
    expect(followUps.size).toBe(1);
    expect(reports.size).toBe(1);
    expect(mergeMutations).toBe(1);
  });
});
