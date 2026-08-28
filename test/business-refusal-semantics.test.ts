import { describe, expect, it, vi } from "vitest";

import { runArchitectureReviewAutomationCommand } from "../.sandcastle/architecture-review-automation.js";
import { runBranchUpdateAutomationCommand } from "../.sandcastle/branch-update-automation.js";
import { runFeedbackImplementationAutomationCommand } from "../.sandcastle/feedback-implementation-automation.js";
import { runImplementationAutomationCommand } from "../.sandcastle/implementation-automation.js";
import { runPrdImplementationAutomationCommand } from "../.sandcastle/prd-implementation-automation.js";
import { runPrdSplitAutomationCommand } from "../.sandcastle/prd-split-automation.js";
import { runQueuePromotionScan } from "../.sandcastle/queue-promotion-automation.js";
import { runReviewAutomationCommand } from "../.sandcastle/review-automation.js";

// #219 story 17 / #247: every operation shares one business-refusal
// semantic — remove the trigger, explain on the Work Item, never add
// agent:blocked, never leave agent:in-progress residue, and produce no
// execution side effects. Execution failure remains the only blocked path.

const REVISION = "0123456789abcdef0123456789abcdef01234567";
const lease = { acquire: vi.fn(async () => ({ release: async () => {} })) };

function issue(overrides = {}) {
  return {
    number: 247,
    state: "OPEN",
    labels: ["agent:implement"],
    baseRevision: REVISION,
    ...overrides,
  };
}

function prd(overrides = {}) {
  return {
    number: 248,
    title: "A PRD",
    state: "OPEN",
    labels: ["agent:implement"],
    baseRevision: REVISION,
    subIssueCount: 2,
    ...overrides,
  };
}

function pullRequest(trigger: string, overrides = {}) {
  return {
    number: 249,
    state: "OPEN",
    isDraft: true,
    baseRepository: "canxer314/obsidian-llm-wiki-cli",
    headRepository: "canxer314/obsidian-llm-wiki-cli",
    baseRefName: "master",
    headRefName: "sandcastle/issue-247",
    headSha: REVISION,
    labels: [trigger],
    ...overrides,
  };
}

const issueRefusals: readonly (readonly [string, Record<string, unknown>, string])[] = [
  ["a closed Issue", { state: "CLOSED" }, "Issue #247 is not open"],
  ["an Issue without the trigger", { labels: [] }, "Issue #247 is not queued for implementation"],
  ["an in-progress Issue", { labels: ["agent:implement", "agent:in-progress"] }, "Issue #247 is already in progress"],
  ["a blocked Issue", { labels: ["agent:implement", "agent:blocked"] }, "Issue #247 is blocked"],
  ["an invalid authorized base revision", { baseRevision: "not-a-sha" }, "Issue #247 has an invalid authorized base revision"],
];

const prdPreflightRefusals: readonly (readonly [string, Record<string, unknown>, string])[] = [
  ["a closed PRD", { state: "CLOSED" }, "Issue #248 is not open"],
  ["a PRD without the trigger", { labels: [] }, "Issue #248 is not queued for implementation"],
  ["an in-progress PRD", { labels: ["agent:implement", "agent:in-progress"] }, "Issue #248 is already in progress"],
  ["a blocked PRD", { labels: ["agent:implement", "agent:blocked"] }, "Issue #248 is blocked"],
  ["an Issue without sub-issues", { subIssueCount: 0 }, "Issue #248 has no sub-issues and is not a PRD"],
  ["an invalid authorized base revision", { baseRevision: "not-a-sha" }, "Issue #248 has an invalid authorized base revision"],
];

const splitRefusals: readonly (readonly [string, Record<string, unknown>, string])[] = [
  ["a closed PRD", { state: "CLOSED" }, "Issue #248 is not open"],
  ["a PRD without the trigger", { labels: [] }, "Issue #248 is not queued for PRD splitting"],
  ["an in-progress PRD", { labels: ["agent:to-issues", "agent:in-progress"] }, "Issue #248 is already in progress"],
  ["a blocked PRD", { labels: ["agent:to-issues", "agent:blocked"] }, "Issue #248 is blocked"],
  ["a PRD that already has children", { subIssueCount: 1 }, "Issue #248 already has 1 sub-issue(s)"],
  ["a sub-issue", { parentNumber: 100 }, "Issue #248 is itself a sub-issue of #100"],
  ["an invalid authorized base revision", { baseRevision: "not-a-sha" }, "Issue #248 has an invalid authorized base revision"],
];

function pullRequestRefusals(trigger: string): readonly (readonly [string, Record<string, unknown>, string])[] {
  const queuedReason = {
    "agent:implement": "Pull Request #249 is not queued for feedback implementation",
    "agent:update-branch": "Pull Request #249 is not queued for branch update",
    "agent:review": "Pull Request #249 is not queued for review",
  }[trigger]!;
  return [
    ["a closed Pull Request", { state: "MERGED" }, "Pull Request #249 is not open"],
    ["a non-Draft Pull Request", { isDraft: false }, "Pull Request #249 is not a Draft"],
    ["a fork Pull Request", { headRepository: "contributor/obsidian-llm-wiki-cli" }, "Pull Request #249 must not originate from a fork"],
    ["an invalid head revision", { headSha: "not-a-sha" }, "Pull Request #249 has an invalid head revision"],
    ["a Pull Request without the trigger", { labels: [] }, queuedReason],
    ["an in-progress Pull Request", { labels: [trigger, "agent:in-progress"] }, "Pull Request #249 is already in progress"],
    ["a blocked Pull Request", { labels: [trigger, "agent:blocked"] }, "Pull Request #249 is blocked"],
  ];
}

describe("business refusal semantics (#247)", () => {
  describe("Issue implementation", () => {
    it.each(issueRefusals)("removes the trigger and explains when refusing %s", async (_case, overrides, reason) => {
      const github = {
        readIssue: vi.fn().mockResolvedValue(issue(overrides)),
        addIssueLabel: vi.fn(),
        removeIssueLabel: vi.fn(),
        addRefusalDiagnostic: vi.fn(),
      };
      const checkout = { withCheckout: vi.fn() };
      const implementer = { implement: vi.fn() };

      await expect(runImplementationAutomationCommand({ issueNumber: 247 }, { github, checkout, implementer, lease }))
        .resolves.toEqual({ status: "refused", reason });

      expect(github.removeIssueLabel).toHaveBeenCalledWith(247, "agent:implement");
      expect(github.addRefusalDiagnostic).toHaveBeenCalledWith(247, reason);
      expect(github.addIssueLabel).not.toHaveBeenCalled();
      expect(checkout.withCheckout).not.toHaveBeenCalled();
      expect(implementer.implement).not.toHaveBeenCalled();
    });
  });

  describe("PRD implementation", () => {
    const portsFor = (readPrd: ReturnType<typeof vi.fn>, listChildren: ReturnType<typeof vi.fn>) => ({
      github: {
        readPrd,
        listChildren,
        addIssueLabel: vi.fn(),
        removeIssueLabel: vi.fn(),
        addRefusalDiagnostic: vi.fn(),
        closeImplementedChild: vi.fn(),
      },
      pullRequests: {
        ensurePrdDraftPullRequest: vi.fn(),
        addPullRequestLabel: vi.fn(),
      },
      checkout: { withCheckout: vi.fn() },
      implementer: { implement: vi.fn() },
      lease,
    });

    it.each(prdPreflightRefusals)("removes the trigger and explains when refusing %s", async (_case, overrides, reason) => {
      const ports = portsFor(vi.fn().mockResolvedValue(prd(overrides)), vi.fn());

      await expect(runPrdImplementationAutomationCommand({ issueNumber: 248 }, ports))
        .resolves.toEqual({ status: "refused", reason });

      expect(ports.github.removeIssueLabel).toHaveBeenCalledWith(248, "agent:implement");
      expect(ports.github.addRefusalDiagnostic).toHaveBeenCalledWith(248, reason);
      expect(ports.github.addIssueLabel).not.toHaveBeenCalled();
      expect(ports.checkout.withCheckout).not.toHaveBeenCalled();
      expect(ports.implementer.implement).not.toHaveBeenCalled();
    });

    const shapeRefusals: readonly (readonly [string, Record<string, unknown>, readonly Record<string, unknown>[], string])[] = [
      ["a nested PRD", { parentNumber: 100 }, [], "Issue #248 has sub-issues but is itself a sub-issue of #100; nested PRDs are not supported"],
      [
        "a child with its own sub-issues",
        {},
        [{ number: 301, title: "Child", state: "OPEN", openBlockerCount: 0, subIssueCount: 1 }],
        "Sub-issue #301 itself has sub-issues; nested sub-issues are not supported",
      ],
      [
        "a PRD whose children are all closed",
        {},
        [{ number: 301, title: "Child", state: "CLOSED", openBlockerCount: 0, subIssueCount: 0 }],
        "Issue #248 has no open sub-issues to implement",
      ],
      [
        "a child whose blockers remain open",
        {},
        [{ number: 301, title: "Child", state: "OPEN", openBlockerCount: 2, subIssueCount: 0 }],
        "Sub-issue #301 cannot start while 2 blocker(s) remain open",
      ],
    ];

    it.each(shapeRefusals)("removes the trigger and explains, without blocking, when refusing %s", async (_case, overrides, children, reason) => {
      const ports = portsFor(
        vi.fn().mockResolvedValue(prd(overrides)),
        vi.fn().mockResolvedValue(children),
      );

      await expect(runPrdImplementationAutomationCommand({ issueNumber: 248 }, ports))
        .resolves.toEqual({ status: "refused", reason });

      expect(ports.github.removeIssueLabel).toHaveBeenCalledWith(248, "agent:implement");
      expect(ports.github.addRefusalDiagnostic).toHaveBeenCalledWith(248, reason);
      expect(ports.github.addIssueLabel).not.toHaveBeenCalled();
      expect(ports.checkout.withCheckout).not.toHaveBeenCalled();
      expect(ports.implementer.implement).not.toHaveBeenCalled();
    });
  });

  describe("PRD split", () => {
    it.each(splitRefusals)("removes the trigger and explains when refusing %s", async (_case, overrides, reason) => {
      const github = {
        readPrd: vi.fn().mockResolvedValue({
          number: 248,
          title: "A PRD",
          state: "OPEN",
          labels: ["agent:to-issues"],
          baseRevision: REVISION,
          subIssueCount: 0,
          ...overrides,
        }),
        addIssueLabel: vi.fn(),
        removeIssueLabel: vi.fn(),
        addRefusalDiagnostic: vi.fn(),
      };
      const checkout = { withCheckout: vi.fn() };
      const splitter = { split: vi.fn() };
      const publisher = { publishPrdSplit: vi.fn() };

      await expect(runPrdSplitAutomationCommand({ issueNumber: 248 }, { github, checkout, splitter, publisher }))
        .resolves.toEqual({ status: "refused", reason });

      expect(github.removeIssueLabel).toHaveBeenCalledWith(248, "agent:to-issues");
      expect(github.addRefusalDiagnostic).toHaveBeenCalledWith(248, reason);
      expect(github.addIssueLabel).not.toHaveBeenCalled();
      expect(checkout.withCheckout).not.toHaveBeenCalled();
      expect(splitter.split).not.toHaveBeenCalled();
      expect(publisher.publishPrdSplit).not.toHaveBeenCalled();
    });
  });

  describe("Pull Request feedback implementation", () => {
    it.each(pullRequestRefusals("agent:implement").filter(([name]) => name !== "a non-Draft Pull Request"))("removes the trigger and explains when refusing %s", async (_case, overrides, reason) => {
      const github = {
        readPullRequest: vi.fn().mockResolvedValue(pullRequest("agent:implement", overrides)),
        readFeedbackReplies: vi.fn().mockResolvedValue([]),
        readCommitParent: vi.fn().mockResolvedValue(undefined),
        readUnresolvedReviewThreads: vi.fn().mockResolvedValue([]),
        addPullRequestLabel: vi.fn(),
        removePullRequestLabel: vi.fn(),
        replyToReviewThread: vi.fn(),
        addRefusalDiagnostic: vi.fn(),
      };
      const checkout = { withCheckout: vi.fn() };
      const publisher = { prepare: vi.fn(), publish: vi.fn() };
      const implementer = { implement: vi.fn() };

      await expect(runFeedbackImplementationAutomationCommand({ pullRequestNumber: 249 }, {
        github, checkout, publisher, implementer, lease,
      })).resolves.toEqual({ status: "refused", reason });

      expect(github.removePullRequestLabel).toHaveBeenCalledWith(249, "agent:implement");
      expect(github.addRefusalDiagnostic).toHaveBeenCalledWith(249, reason);
      expect(github.addPullRequestLabel).not.toHaveBeenCalled();
      expect(checkout.withCheckout).not.toHaveBeenCalled();
      expect(publisher.publish).not.toHaveBeenCalled();
      expect(implementer.implement).not.toHaveBeenCalled();
    });

    it("continues feedback implementation after review marks the Pull Request ready", async () => {
      const readyPullRequest = pullRequest("agent:implement", { isDraft: false });
      const github = {
        readPullRequest: vi.fn()
          .mockResolvedValueOnce(readyPullRequest)
          .mockResolvedValueOnce(readyPullRequest)
          .mockResolvedValueOnce({
            ...readyPullRequest,
            labels: ["agent:in-progress"],
          }),
        readFeedbackReplies: vi.fn().mockResolvedValue([]),
        readCurrentUnresolvedFeedback: vi.fn().mockResolvedValue({
          unresolvedRootCommentIds: ["feedback-root"],
          replies: [],
        }),
        readCommitParent: vi.fn().mockResolvedValue(undefined),
        readUnresolvedReviewThreads: vi.fn().mockResolvedValue([]),
        addPullRequestLabel: vi.fn(),
        removePullRequestLabel: vi.fn(),
        replyToReviewThread: vi.fn(),
        addFeedbackBlockedDiagnostic: vi.fn(),
      };
      const checkout = {
        withCheckout: vi.fn().mockRejectedValue(new Error("execution sentinel")),
      };

      await expect(runFeedbackImplementationAutomationCommand({ pullRequestNumber: 249 }, {
        github,
        checkout,
        publisher: { prepare: vi.fn(), publish: vi.fn() },
        implementer: { implement: vi.fn() },
        lease,
        createJobId: () => "feedback-job",
      })).resolves.toMatchObject({
        status: "blocked",
        reason: "feedback-execution",
        jobId: "feedback-job",
      });

      expect(checkout.withCheckout).toHaveBeenCalledOnce();
      expect(github.addPullRequestLabel).toHaveBeenCalledWith(249, "agent:in-progress");
    });
  });

  describe("Pull Request branch update", () => {
    it.each(pullRequestRefusals("agent:update-branch").filter(([name]) => name !== "a non-Draft Pull Request"))("removes the trigger and explains when refusing %s", async (_case, overrides, reason) => {
      const github = {
        readPullRequest: vi.fn().mockResolvedValue(pullRequest("agent:update-branch", overrides)),
        addPullRequestLabel: vi.fn(),
        removePullRequestLabel: vi.fn(),
        addRefusalDiagnostic: vi.fn(),
      };
      const checkout = { withCheckout: vi.fn() };
      const updater = { update: vi.fn() };

      await expect(runBranchUpdateAutomationCommand({ pullRequestNumber: 249 }, { github, checkout, updater, lease }))
        .resolves.toEqual({ status: "refused", reason });

      expect(github.removePullRequestLabel).toHaveBeenCalledWith(249, "agent:update-branch");
      expect(github.addRefusalDiagnostic).toHaveBeenCalledWith(249, reason);
      expect(github.addPullRequestLabel).not.toHaveBeenCalled();
      expect(checkout.withCheckout).not.toHaveBeenCalled();
      expect(updater.update).not.toHaveBeenCalled();
    });

    it("continues branch update after review and feedback leave the Pull Request ready", async () => {
      const readyPullRequest = pullRequest("agent:update-branch", { isDraft: false });
      const github = {
        readPullRequest: vi.fn()
          .mockResolvedValueOnce(readyPullRequest)
          .mockResolvedValueOnce({
            ...readyPullRequest,
            labels: ["agent:in-progress"],
          }),
        addPullRequestLabel: vi.fn().mockResolvedValue(undefined),
        removePullRequestLabel: vi.fn().mockResolvedValue(undefined),
        addBranchUpdateComment: vi.fn().mockResolvedValue(undefined),
      };
      const checkout = {
        withCheckout: vi.fn(async (_request, action) => action("/checkout")),
      };
      const updater = {
        update: vi.fn().mockResolvedValue({ status: "up-to-date" }),
      };

      await expect(runBranchUpdateAutomationCommand({ pullRequestNumber: 249 }, {
        github,
        checkout,
        updater,
        lease,
      })).resolves.toEqual({ status: "up-to-date" });

      expect(checkout.withCheckout).toHaveBeenCalledWith({
        pullRequestNumber: 249,
        revision: REVISION,
      }, expect.any(Function));
      expect(updater.update).toHaveBeenCalledWith({
        pullRequestNumber: 249,
        branch: "sandcastle/issue-247",
        baseBranch: "master",
        revision: REVISION,
        checkoutPath: "/checkout",
      });
    });
  });

  describe("Pull Request review", () => {
    it.each(pullRequestRefusals("agent:review").filter(([name]) => name !== "an in-progress Pull Request"))("removes the trigger and explains when refusing %s", async (_case, overrides, reason) => {
      const github = {
        readPullRequest: vi.fn().mockResolvedValue(pullRequest("agent:review", overrides)),
        addPullRequestLabel: vi.fn(),
        removePullRequestLabel: vi.fn(),
        addRefusalDiagnostic: vi.fn(),
      };
      const checkout = { withCheckout: vi.fn() };
      const reviewer = { review: vi.fn() };
      const publisher = { publish: vi.fn() };

      await expect(runReviewAutomationCommand({ pullRequestNumber: 249 }, {
        github, checkout, reviewer, publisher, lease,
      })).resolves.toEqual({ status: "refused", reason });

      expect(github.removePullRequestLabel).toHaveBeenCalledWith(249, "agent:review");
      expect(github.addRefusalDiagnostic).toHaveBeenCalledWith(249, reason);
      expect(github.addPullRequestLabel).not.toHaveBeenCalled();
      expect(checkout.withCheckout).not.toHaveBeenCalled();
      expect(reviewer.review).not.toHaveBeenCalled();
      expect(publisher.publish).not.toHaveBeenCalled();
    });

    it("refuses an in-progress Pull Request without touching the trigger an in-flight run still owns", async () => {
      const github = {
        readPullRequest: vi.fn().mockResolvedValue(pullRequest("agent:review", { labels: ["agent:review", "agent:in-progress"] })),
        addPullRequestLabel: vi.fn(),
        removePullRequestLabel: vi.fn(),
        addRefusalDiagnostic: vi.fn(),
      };
      const checkout = { withCheckout: vi.fn() };
      const reviewer = { review: vi.fn() };

      await expect(runReviewAutomationCommand({ pullRequestNumber: 249 }, {
        github, checkout, reviewer, publisher: { publish: vi.fn() }, lease,
      })).resolves.toEqual({ status: "refused", reason: "Pull Request #249 is already in progress" });

      expect(github.addPullRequestLabel).not.toHaveBeenCalled();
      expect(github.removePullRequestLabel).not.toHaveBeenCalled();
      expect(github.addRefusalDiagnostic).not.toHaveBeenCalled();
      expect(checkout.withCheckout).not.toHaveBeenCalled();
      expect(reviewer.review).not.toHaveBeenCalled();
    });
  });

  describe("queue promotion", () => {
    it("clears the queue trigger and explains a queued sub-issue without blocking it", async () => {
      const github = {
        listQueuedIssues: vi.fn().mockResolvedValue([{ number: 250, labels: ["agent:queued"] }]),
        readPromotionState: vi.fn().mockResolvedValue({ labels: ["agent:queued"], parentNumber: 100, blockers: [] }),
        addIssueLabel: vi.fn(),
        removeIssueLabel: vi.fn(),
        addPromotionDiagnostic: vi.fn(),
        addSubIssueRefusalDiagnostic: vi.fn(),
      };

      await expect(runQueuePromotionScan({ github })).resolves.toEqual({
        status: "scanned",
        promoted: [],
        refused: [250],
      });

      expect(github.removeIssueLabel).toHaveBeenCalledWith(250, "agent:queued");
      expect(github.addSubIssueRefusalDiagnostic).toHaveBeenCalledWith(250, 100);
      expect(github.addIssueLabel).not.toHaveBeenCalled();
    });
  });

  describe("architecture review", () => {
    it("refuses a full backlog without any GitHub or execution side effects", async () => {
      const github = {
        countOpenArchitectureReviewProposals: vi.fn().mockResolvedValue(10),
        readBaseRevision: vi.fn(),
        listArchitectureReviewProposals: vi.fn(),
      };
      const checkout = { withCheckout: vi.fn() };
      const reviewer = { review: vi.fn() };
      const publisher = { publishArchitectureProposal: vi.fn() };

      await expect(runArchitectureReviewAutomationCommand({ github, checkout, reviewer, publisher }))
        .resolves.toEqual({ status: "refused", reason: "architecture-review-backlog" });

      expect(github.readBaseRevision).not.toHaveBeenCalled();
      expect(github.listArchitectureReviewProposals).not.toHaveBeenCalled();
      expect(checkout.withCheckout).not.toHaveBeenCalled();
      expect(reviewer.review).not.toHaveBeenCalled();
      expect(publisher.publishArchitectureProposal).not.toHaveBeenCalled();
    });
  });
});
