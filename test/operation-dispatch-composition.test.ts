import { describe, expect, it, vi } from "vitest";

import { runArchitectureReviewAutomationCommand } from "../.sandcastle/architecture-review-automation.js";
import type { AutomationCommand, AutomationOperation } from "../.sandcastle/automation-command.js";
import { dispatchAutomationCommands } from "../.sandcastle/automation-dispatch.js";
import { runBranchUpdateAutomationCommand } from "../.sandcastle/branch-update-automation.js";
import { runFeedbackImplementationAutomationCommand } from "../.sandcastle/feedback-implementation-automation.js";
import { runImplementationAutomationCommand } from "../.sandcastle/implementation-automation.js";
import { runPrdImplementationAutomationCommand } from "../.sandcastle/prd-implementation-automation.js";
import { runPrdSplitAutomationCommand } from "../.sandcastle/prd-split-automation.js";
import { runQueuePromotionScan } from "../.sandcastle/queue-promotion-automation.js";
import { runReviewAutomationCommand } from "../.sandcastle/review-automation.js";
import { runSerializedAutomationCommand } from "../.sandcastle/serialized-automation-command.js";
import type {
  AuthorizedTargetOperationInvocation,
  TargetOperationIdentity,
} from "../.sandcastle/target-operation.js";
import { createTargetOperationCommandDispatch } from "../.sandcastle/target-operation-dispatch.js";
import { createManagedOperationGithub } from "../.sandcastle/target-operation-github.js";

const revision = "a".repeat(40);
const publishedRevision = "b".repeat(40);
const feedbackRoot = "PRRC_root";

type OrdinaryBehaviorCase = {
  readonly family:
    | "Issue implementation"
    | "PRD implementation"
    | "Pull Request feedback implementation"
    | "Pull Request review"
    | "branch update"
    | "PRD split";
  readonly kind: "ordinary";
  readonly operation: Exclude<AutomationOperation, "unknown">;
  readonly targetOperation: Exclude<TargetOperationIdentity, "architecture-review">;
  readonly number: number;
  readonly trigger: string;
  readonly identity: string;
  readonly workItem: "issue" | "pull-request";
  readonly subIssueCount?: number;
  readonly successStatus: string;
};

type BehaviorCase = OrdinaryBehaviorCase | {
  readonly family: "queue promotion";
  readonly kind: "queue";
} | {
  readonly family: "architecture review";
  readonly kind: "architecture";
};

const behaviorCases: readonly BehaviorCase[] = [
  {
    family: "Issue implementation",
    kind: "ordinary",
    operation: "implement-issue",
    targetOperation: "implement-issue",
    number: 221,
    trigger: "agent:implement",
    identity: "issue:221",
    workItem: "issue",
    subIssueCount: 0,
    successStatus: "implemented",
  },
  {
    family: "PRD implementation",
    kind: "ordinary",
    operation: "implement-prd",
    targetOperation: "implement-prd",
    number: 226,
    trigger: "agent:implement",
    identity: "prd:226",
    workItem: "issue",
    subIssueCount: 2,
    successStatus: "implemented",
  },
  {
    family: "Pull Request feedback implementation",
    kind: "ordinary",
    operation: "implement",
    targetOperation: "implement-feedback",
    number: 224,
    trigger: "agent:implement",
    identity: "pull-request:224",
    workItem: "pull-request",
    successStatus: "implemented",
  },
  {
    family: "Pull Request review",
    kind: "ordinary",
    operation: "review",
    targetOperation: "review",
    number: 220,
    trigger: "agent:review",
    identity: "pull-request:220",
    workItem: "pull-request",
    successStatus: "reviewed",
  },
  {
    family: "branch update",
    kind: "ordinary",
    operation: "update-branch",
    targetOperation: "update-branch",
    number: 225,
    trigger: "agent:update-branch",
    identity: "pull-request:225",
    workItem: "pull-request",
    successStatus: "updated",
  },
  {
    family: "PRD split",
    kind: "ordinary",
    operation: "split-prd",
    targetOperation: "split-prd",
    number: 223,
    trigger: "agent:to-issues",
    identity: "prd:223",
    workItem: "issue",
    subIssueCount: 0,
    successStatus: "split",
  },
  { family: "queue promotion", kind: "queue" },
  { family: "architecture review", kind: "architecture" },
];

type Scenario = "success" | "preflight" | "blocked";

function scheduler(events: string[]) {
  return {
    acquire: vi.fn(async () => ({
      release: async () => { events.push("scheduler:release"); },
    })),
    prepare: vi.fn(async () => undefined),
    track: vi.fn(async (_identity: string, action: () => Promise<void>) => {
      await action();
    }),
  };
}

function pullRequestShape(
  entry: OrdinaryBehaviorCase,
  labels: ReadonlySet<string>,
  headSha: string,
  scenario: Scenario,
) {
  return {
    number: entry.number,
    state: "OPEN",
    isDraft: scenario !== "preflight",
    labels: [...labels],
    headSha,
    headRefName: "feature/automation",
    baseRefName: "master",
    baseRepository: "owner/repository",
    headRepository: "owner/repository",
  };
}

function issueShape(
  entry: OrdinaryBehaviorCase,
  labels: ReadonlySet<string>,
  scenario: Scenario,
) {
  return {
    number: entry.number,
    title: `${entry.family} Work Item`,
    state: "OPEN",
    labels: [...labels],
    baseRevision: revision,
    subIssueCount: entry.targetOperation === "split-prd" && scenario === "preflight"
      ? 1
      : entry.subIssueCount ?? 0,
    parentNumber: undefined,
  };
}

async function executeOrdinaryBusinessOperation(options: {
  readonly entry: OrdinaryBehaviorCase;
  readonly scenario: Scenario;
  readonly invocation: AuthorizedTargetOperationInvocation;
  readonly rawGithub: ReturnType<typeof createOrdinaryGithub>;
  readonly events: string[];
}): Promise<unknown> {
  const { entry, scenario, invocation, rawGithub, events } = options;
  const github = createManagedOperationGithub(
    rawGithub,
    entry.targetOperation,
    entry.number,
    invocation,
  );
  const checkout = {
    async withCheckout<TResult>(
      request: { readonly revision: string },
      action: (path: string) => Promise<TResult>,
    ): Promise<TResult> {
      expect(request.revision).toBe(revision);
      events.push(`checkout:open:${request.revision}`);
      try {
        const result = await action(`/target/${entry.number}`);
        events.push(
          typeof result === "object" && result !== null &&
            "status" in result && result.status === "blocked"
            ? "checkout:retained"
            : "checkout:cleanup",
        );
        return result;
      } catch (error) {
        events.push("checkout:retained");
        throw error;
      }
    },
  };
  const lease = {
    acquire: async () => ({
      release: async () => { events.push("business-lease:release"); },
    }),
  };
  const fail = (): void => {
    if (scenario === "blocked") throw new Error(`${entry.family} process failed`);
  };

  switch (entry.targetOperation) {
    case "implement-issue":
      return runImplementationAutomationCommand({ issueNumber: entry.number }, {
        github,
        checkout,
        implementer: {
          implement: async (request) => {
            fail();
            events.push(`publish:implementation-pr:${request.baseRevision}`);
            return {
              branch: `sandcastle/issue-${entry.number}`,
              pullRequestUrl: `https://github.com/owner/repository/pull/${entry.number}`,
            };
          },
        },
        lease,
        createJobId: () => `${entry.targetOperation}-job`,
      });
    case "implement-prd": {
      let childClosed = false;
      const child = {
        number: 301,
        title: "First PRD child",
        state: "OPEN",
        openBlockerCount: scenario === "preflight" ? 1 : 0,
        subIssueCount: 0,
      };
      return runPrdImplementationAutomationCommand({ issueNumber: entry.number }, {
        github: {
          ...github,
          listChildren: async () => [
            { ...child, state: childClosed ? "CLOSED" : "OPEN" },
            { ...child, number: 302, title: "Second PRD child" },
          ],
          closeImplementedChild: async (request) => {
            childClosed = true;
            events.push(`publish:close-child:${request.childNumber}:${request.revision}`);
          },
        },
        pullRequests: {
          ensurePrdDraftPullRequest: async (request) => {
            events.push(`publish:prd-pr:${request.headSha}`);
            return {
              number: 401,
              url: "https://github.com/owner/repository/pull/401",
            };
          },
          addPullRequestLabel: async (_number, label) => {
            events.push(`publish:prd-pr-label:${label}`);
          },
        },
        checkout,
        implementer: {
          implement: async () => {
            fail();
            return {
              branch: `sandcastle/prd-${entry.number}`,
              headSha: publishedRevision,
            };
          },
        },
        lease,
        createJobId: () => `${entry.targetOperation}-job`,
      });
    }
    case "split-prd":
      return runPrdSplitAutomationCommand({ issueNumber: entry.number }, {
        github,
        checkout,
        splitter: {
          split: async () => {
            fail();
            return [{
              title: "Vertical slice",
              whatToBuild: "Deliver one complete path.",
              acceptanceCriteria: ["It works"],
            }];
          },
        },
        publisher: {
          publishPrdSplit: async (request) => {
            events.push(`publish:child-issues:${request.slices.length}`);
            return [301];
          },
        },
        createJobId: () => `${entry.targetOperation}-job`,
      });
    case "update-branch":
      return runBranchUpdateAutomationCommand({ pullRequestNumber: entry.number }, {
        github,
        checkout,
        updater: {
          update: async (request) => {
            fail();
            events.push(`publish:branch:${request.revision}`);
            return { status: "updated", revision: publishedRevision };
          },
        },
        lease,
        createJobId: () => `${entry.targetOperation}-job`,
      });
    case "review":
      return runReviewAutomationCommand({ pullRequestNumber: entry.number }, {
        github,
        checkout,
        reviewer: {
          review: async () => {
            fail();
            return { summary: "Reviewed", inlineComments: [], replies: [] };
          },
        },
        publisher: {
          prepare: async () => undefined,
          publish: async (request) => {
            events.push(`publish:review-branch:${request.expectedRevision}`);
            rawGithub.setHead(publishedRevision);
            return publishedRevision;
          },
        },
        lease,
        createJobId: () => `${entry.targetOperation}-job`,
      });
    case "implement-feedback":
      return runFeedbackImplementationAutomationCommand({
        pullRequestNumber: entry.number,
      }, {
        github,
        checkout,
        publisher: {
          prepare: async () => undefined,
          publish: async (request) => {
            events.push(`publish:feedback-branch:${request.expectedRevision}`);
            rawGithub.setHead(publishedRevision);
            return publishedRevision;
          },
        },
        implementer: {
          implement: async () => {
            fail();
            return {
              reply: { rootCommentId: feedbackRoot, body: "Fixed." },
            };
          },
        },
        lease,
        createJobId: () => `${entry.targetOperation}-job`,
        wait: async () => undefined,
      });
  }
}

function createOrdinaryGithub(
  entry: OrdinaryBehaviorCase,
  scenario: Scenario,
  events: string[],
) {
  const labels = new Set([entry.trigger]);
  let head = revision;
  let feedbackReplies: readonly {
    readonly rootCommentId: string;
    readonly replyCommentId: string;
    readonly body: string;
  }[] = [];
  const addLabel = async (label: string): Promise<void> => {
    labels.add(label);
  };
  const removeLabel = async (label: string): Promise<void> => {
    labels.delete(label);
  };
  return {
    labels,
    setHead(value: string): void { head = value; },
    readBaseRevision: async () => revision,
    readIssue: async () => ({
      ...issueShape(entry, labels, scenario),
      state: entry.targetOperation === "implement-issue" && scenario === "preflight"
        ? "CLOSED"
        : "OPEN",
    }),
    readPrd: async () => issueShape(entry, labels, scenario),
    readPullRequest: async () => pullRequestShape(entry, labels, head, scenario),
    addIssueLabel: async (_number: number, label: string) => addLabel(label),
    removeIssueLabel: async (_number: number, label: string) => removeLabel(label),
    addPullRequestLabel: async (_number: number, label: string) => addLabel(label),
    removePullRequestLabel: async (_number: number, label: string) => removeLabel(label),
    addRefusalDiagnostic: async (_number: number, reason: string) => {
      events.push(`refusal:${reason}`);
    },
    addImplementationBlockedDiagnostic: async () => undefined,
    addPrdImplementationBlockedDiagnostic: async () => undefined,
    addChildFailureDiagnostic: async () => undefined,
    addSplitBlockedDiagnostic: async () => undefined,
    addBranchUpdateBlockedDiagnostic: async () => undefined,
    addBlockedDiagnostic: async () => undefined,
    addFeedbackBlockedDiagnostic: async () => undefined,
    readUnresolvedReviewThreads: async () => [{
      commentId: feedbackRoot,
      author: "reviewer",
      body: "Please fix.",
    }],
    readCurrentUnresolvedFeedback: async () => ({
      unresolvedRootCommentIds: [feedbackRoot],
      replies: [],
    }),
    readCommitParent: async () => undefined,
    readFeedbackReplies: async () => feedbackReplies,
    replyToReviewThread: async (request: {
      readonly reply: { readonly body: string };
    }) => {
      events.push("publish:feedback-reply");
      feedbackReplies = [{
        rootCommentId: feedbackRoot,
        replyCommentId: "PRRC_reply",
        body: request.reply.body,
      }];
    },
    publishReview: async (request: { readonly revision: string }) => {
      events.push(`publish:review:${request.revision}`);
    },
    markPullRequestReady: async () => {
      events.push("publish:pull-request-ready");
    },
    closeImplementedChild: async () => undefined,
    ensurePrdDraftPullRequest: async () => ({
      number: 401,
      url: "https://github.com/owner/repository/pull/401",
    }),
  };
}

async function runOrdinaryScenario(
  entry: OrdinaryBehaviorCase,
  scenario: Scenario,
): Promise<{
  readonly events: readonly string[];
  readonly labels: ReadonlySet<string>;
  readonly outcome: unknown;
  readonly invocation: AuthorizedTargetOperationInvocation;
}> {
  const events: string[] = [];
  const github = createOrdinaryGithub(entry, scenario, events);
  let outcome: unknown;
  let invocation!: AuthorizedTargetOperationInvocation;
  const target = {
    run: async (authorized: AuthorizedTargetOperationInvocation) => {
      invocation = authorized;
      outcome = await executeOrdinaryBusinessOperation({
        entry,
        scenario,
        invocation: authorized,
        rawGithub: github,
        events,
      });
      return outcome;
    },
  };
  const operation = createTargetOperationCommandDispatch({
    github,
    target,
    createJobId: () => `${entry.targetOperation}-${scenario}-job`,
  });
  const command: AutomationCommand = {
    number: entry.number,
    operation: entry.operation,
    identity: entry.identity,
    labels: [entry.trigger],
  };
  const dispatchScheduler = scheduler(events);

  await expect(dispatchAutomationCommands({ concurrency: 1 }, {
    scheduler: dispatchScheduler,
    readiness: { verifyGithubAgentAuthentication: async () => undefined },
    github: {
      verifyLabels: async () => undefined,
      listCommands: async () => [command],
    },
    promotion: {
      scan: async () => ({ status: "scanned", promoted: [], refused: [] }),
    },
    run: async (selected) => { await operation.runCommand(selected); },
  })).resolves.toEqual({ status: "dispatched", selected: [command] });

  expect(dispatchScheduler.track).toHaveBeenCalledWith(
    entry.identity,
    expect.any(Function),
  );
  return { events, labels: github.labels, outcome, invocation };
}

async function verifyOrdinaryBehavior(entry: OrdinaryBehaviorCase): Promise<void> {
  const success = await runOrdinaryScenario(entry, "success");
  expect(success.outcome).toEqual(expect.objectContaining({
    status: entry.successStatus,
  }));
  expect(success.invocation).toEqual(expect.objectContaining({
    operation: entry.targetOperation,
    number: entry.number,
    revision,
    acquired: true,
  }));
  if (entry.workItem === "pull-request") {
    expect(success.invocation.pullRequest).toEqual({
      headSha: revision,
      headRefName: "feature/automation",
      baseRefName: "master",
      baseRepository: "owner/repository",
      headRepository: "owner/repository",
    });
  }
  expect(success.events).toContain(`checkout:open:${revision}`);
  expect(success.events).toContain("checkout:cleanup");
  expect(success.events.some((event) => event.startsWith("publish:"))).toBe(true);
  expect(success.labels.has("agent:in-progress")).toBe(false);
  expect(success.labels.has("agent:blocked")).toBe(false);
  expect(success.events.at(-1)).toBe("scheduler:release");

  const preflight = await runOrdinaryScenario(entry, "preflight");
  expect(preflight.outcome).toEqual(expect.objectContaining({ status: "refused" }));
  expect(preflight.events).not.toContain(`checkout:open:${revision}`);
  expect(preflight.events.some((event) => event.startsWith("publish:"))).toBe(false);
  expect(preflight.events.some((event) => event.startsWith("refusal:"))).toBe(true);
  expect(preflight.labels.has("agent:in-progress")).toBe(false);
  expect(preflight.labels.has("agent:blocked")).toBe(false);
  expect(preflight.events.at(-1)).toBe("scheduler:release");

  const blocked = await runOrdinaryScenario(entry, "blocked");
  expect(blocked.outcome).toEqual(expect.objectContaining({ status: "blocked" }));
  expect(blocked.events).toContain(`checkout:open:${revision}`);
  expect(blocked.events).toContain("checkout:retained");
  expect(blocked.events).not.toContain("checkout:cleanup");
  expect(blocked.events.some((event) => event.startsWith("publish:"))).toBe(false);
  expect(blocked.labels.has("agent:blocked")).toBe(true);
  expect(blocked.labels.has("agent:in-progress")).toBe(false);
  expect(blocked.events.at(-1)).toBe("scheduler:release");
}

async function verifyQueuePromotionBehavior(): Promise<void> {
  const run = async (scenario: Scenario) => {
    const events: string[] = [];
    const dispatchScheduler = scheduler(events);
    let scanResult: unknown;
    const state = {
      labels: ["agent:queued"],
      blockers: [],
      ...(scenario === "preflight" ? { parentNumber: 200 } : {}),
    };
    const scan = async () => {
      scanResult = await runQueuePromotionScan({
        github: {
          listQueuedIssues: async () => [{ number: 201, labels: ["agent:queued"] }],
          readPromotionState: async () => state,
          addIssueLabel: async (_number, label) => {
            if (scenario === "blocked" && label === "agent:implement") {
              throw new Error("promotion publication failed");
            }
            events.push(`publish:queue-label:${label}`);
          },
          removeIssueLabel: async (_number, label) => {
            events.push(`publish:queue-remove:${label}`);
          },
          addPromotionDiagnostic: async () => {
            events.push("publish:queue-diagnostic");
          },
          addPromotionBlockedDiagnostic: async (_number, diagnostic) => {
            events.push(`diagnostic:queue-blocked:${diagnostic.jobId}`);
          },
          addSubIssueRefusalDiagnostic: async (_number, parent) => {
            events.push(`refusal:queued-sub-issue:${parent}`);
          },
        },
      });
      return scanResult;
    };
    const execution = dispatchAutomationCommands({ concurrency: 1 }, {
      scheduler: dispatchScheduler,
      readiness: { verifyGithubAgentAuthentication: async () => undefined },
      github: {
        verifyLabels: async () => undefined,
        listCommands: async () => [],
      },
      promotion: { scan },
      run: async () => { throw new Error("queue promotion has no Target operation"); },
    });
    if (scenario === "blocked") await expect(execution).rejects.toThrow("promotion publication failed");
    else await expect(execution).resolves.toEqual({ status: "dispatched", selected: [] });
    return { events, scanResult, scheduler: dispatchScheduler };
  };

  const success = await run("success");
  expect(success.scanResult).toEqual({ status: "scanned", promoted: [201], refused: [] });
  expect(success.events).toContain("publish:queue-label:agent:implement");
  expect(success.scheduler.track).not.toHaveBeenCalled();
  expect(success.events.at(-1)).toBe("scheduler:release");

  const preflight = await run("preflight");
  expect(preflight.scanResult).toEqual({ status: "scanned", promoted: [], refused: [201] });
  expect(preflight.events).toContain("refusal:queued-sub-issue:200");
  expect(preflight.events).not.toContain("publish:queue-label:agent:blocked");
  expect(preflight.events.at(-1)).toBe("scheduler:release");

  const blocked = await run("blocked");
  expect(blocked.events).toContain("publish:queue-label:agent:blocked");
  expect(blocked.events).toContain("diagnostic:queue-blocked:local-queue-promotion-job");
  expect(blocked.events).not.toContain("publish:queue-remove:agent:queued");
  expect(blocked.events.at(-1)).toBe("scheduler:release");
}

async function verifyArchitectureReviewBehavior(): Promise<void> {
  const run = async (scenario: Scenario) => {
    const events: string[] = [];
    const commandScheduler = scheduler(events);
    const github = {
      readBaseRevision: async () => revision,
      readPrd: async () => { throw new Error("architecture review has no Work Item"); },
      readPullRequest: async () => { throw new Error("architecture review has no Work Item"); },
      addIssueLabel: async () => { throw new Error("architecture review has no labels"); },
      removeIssueLabel: async () => { throw new Error("architecture review has no labels"); },
      addPullRequestLabel: async () => { throw new Error("architecture review has no labels"); },
      removePullRequestLabel: async () => { throw new Error("architecture review has no labels"); },
    };
    let outcome: unknown;
    const target = {
      run: async (invocation: AuthorizedTargetOperationInvocation) => {
        outcome = await runArchitectureReviewAutomationCommand({
          github: {
            countOpenArchitectureReviewProposals: async () => scenario === "preflight" ? 10 : 3,
            readBaseRevision: async () => invocation.revision,
            listArchitectureReviewProposals: async () => [],
          },
          checkout: {
            withCheckout: async (request, action) => {
              events.push(`checkout:open:${request.revision}`);
              try {
                const result = await action("/target/architecture-review");
                events.push(
                  typeof result === "object" && result !== null &&
                    "status" in result && result.status === "blocked"
                    ? "checkout:retained"
                    : "checkout:cleanup",
                );
                return result;
              } catch (error) {
                events.push("checkout:retained");
                throw error;
              }
            },
          },
          reviewer: {
            review: async () => {
              if (scenario === "blocked") throw new Error("architecture review failed");
              return {
                status: "proposed",
                title: "Architecture proposal",
                body: "Proposal body",
                oneLineSummary: "Proposal summary",
                candidatesConsidered: ["candidate"],
              } as const;
            },
          },
          publisher: {
            publishArchitectureProposal: async () => {
              events.push("publish:architecture-issue:240");
              return {
                issueNumber: 240,
                issueUrl: "https://github.com/owner/repository/issues/240",
              };
            },
          },
          createJobId: () => "architecture-review-job",
        });
        return outcome;
      },
    };
    const operation = createTargetOperationCommandDispatch({
      github,
      target,
      createJobId: () => "architecture-review-job",
    });
    await runSerializedAutomationCommand(
      commandScheduler,
      "architecture-review",
      () => operation.runOperation("architecture-review", 1),
    );
    return { events, outcome, scheduler: commandScheduler };
  };

  const success = await run("success");
  expect(success.outcome).toEqual({
    status: "proposed",
    revision,
    issueNumber: 240,
    issueUrl: "https://github.com/owner/repository/issues/240",
  });
  expect(success.scheduler.track).toHaveBeenCalledWith(
    "architecture-review",
    expect.any(Function),
  );
  expect(success.events).toContain(`checkout:open:${revision}`);
  expect(success.events).toContain("publish:architecture-issue:240");
  expect(success.events.at(-1)).toBe("scheduler:release");

  const preflight = await run("preflight");
  expect(preflight.outcome).toEqual({
    status: "refused",
    reason: "architecture-review-backlog",
  });
  expect(preflight.events).not.toContain(`checkout:open:${revision}`);
  expect(preflight.events.some((event) => event.startsWith("publish:"))).toBe(false);
  expect(preflight.events.at(-1)).toBe("scheduler:release");

  const blocked = await run("blocked");
  expect(blocked.outcome).toEqual(expect.objectContaining({
    status: "blocked",
    reason: "architecture-review-execution",
    jobId: "architecture-review-job",
  }));
  expect(blocked.events).toContain("checkout:retained");
  expect(blocked.events).not.toContain("checkout:cleanup");
  expect(blocked.events.some((event) => event.startsWith("publish:"))).toBe(false);
  expect(blocked.events.at(-1)).toBe("scheduler:release");
}

describe("Dispatcher operation behavior mapping", () => {
  it.each(behaviorCases)(
    "$family crosses acquisition, Target Checkout execution, and GitHub publication",
    async (entry) => {
      if (entry.kind === "ordinary") {
        await verifyOrdinaryBehavior(entry);
      } else if (entry.kind === "queue") {
        await verifyQueuePromotionBehavior();
      } else {
        await verifyArchitectureReviewBehavior();
      }
    },
  );
});
