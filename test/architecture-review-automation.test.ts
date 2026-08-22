import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ARCHITECTURE_REVIEW_IDENTITY,
  runArchitectureReviewAutomationCommand,
} from "../.sandcastle/architecture-review-automation.js";
import { createAutomationScheduler } from "../.sandcastle/automation-scheduler.js";

const revision = "0123456789abcdef0123456789abcdef01234567";

const priorProposals = [
  { number: 101, title: "Deepen the vault index", state: "CLOSED", body: "Prior body" },
];

function eligibleGithub() {
  return {
    countOpenArchitectureReviewProposals: vi.fn(async () => 3),
    readBaseRevision: vi.fn(async () => revision),
    listArchitectureReviewProposals: vi.fn(async () => priorProposals),
  };
}

describe("architecture review automation command", () => {
  it("publishes an accepted proposal as an architecture-review Work Item at the base revision", async () => {
    const events: string[] = [];
    const github = eligibleGithub();
    const checkout = {
      withCheckout: vi.fn(async (request, action) => {
        events.push(`checkout:${request.revision}`);
        return action("/safe/disposable-checkout");
      }),
    };
    const reviewer = {
      review: vi.fn(async (request) => {
        events.push(`review:${request.revision}`);
        return {
          status: "proposed" as const,
          title: "Deepen the search indexer",
          body: "## Architecture review\n\n...",
          oneLineSummary: "One deep module for indexing.",
          candidatesConsidered: ["indexer", "cache"],
        };
      }),
    };
    const publisher = {
      publishArchitectureProposal: vi.fn(async (request) => {
        events.push(`publish:${request.title}`);
        return { issueNumber: 240, issueUrl: "https://github.com/canxer314/obsidian-llm-wiki-cli/issues/240" };
      }),
    };

    await expect(runArchitectureReviewAutomationCommand({
      github,
      checkout,
      reviewer,
      publisher,
    })).resolves.toEqual({
      status: "proposed",
      revision,
      issueNumber: 240,
      issueUrl: "https://github.com/canxer314/obsidian-llm-wiki-cli/issues/240",
    });

    expect(events).toEqual([
      `checkout:${revision}`,
      `review:${revision}`,
      "publish:Deepen the search indexer",
    ]);
    expect(reviewer.review).toHaveBeenCalledWith({
      revision,
      checkoutPath: "/safe/disposable-checkout",
      priorProposals,
    });
    expect(publisher.publishArchitectureProposal).toHaveBeenCalledWith({
      title: "Deepen the search indexer",
      body: "## Architecture review\n\n...",
    });
  });

  it("publishes nothing when the upstream-equivalent outcome is a skip", async () => {
    const publisher = { publishArchitectureProposal: vi.fn() };

    await expect(runArchitectureReviewAutomationCommand({
      github: eligibleGithub(),
      checkout: {
        withCheckout: vi.fn(async (_request, action) => action("/safe/disposable-checkout")),
      },
      reviewer: {
        review: vi.fn(async () => ({
          status: "skipped" as const,
          reason: "Every candidate is covered by #101.",
        })),
      },
      publisher,
    })).resolves.toEqual({
      status: "skipped",
      revision,
      reason: "Every candidate is covered by #101.",
    });

    expect(publisher.publishArchitectureProposal).not.toHaveBeenCalled();
  });

  it("refuses to run when the open architecture-review backlog is full without creating a Work Item", async () => {
    const github = eligibleGithub();
    github.countOpenArchitectureReviewProposals.mockResolvedValue(10);
    const checkout = { withCheckout: vi.fn() };
    const reviewer = { review: vi.fn() };
    const publisher = { publishArchitectureProposal: vi.fn() };

    await expect(runArchitectureReviewAutomationCommand({
      github,
      checkout,
      reviewer,
      publisher,
    })).resolves.toEqual({ status: "refused", reason: "architecture-review-backlog" });

    expect(checkout.withCheckout).not.toHaveBeenCalled();
    expect(reviewer.review).not.toHaveBeenCalled();
    expect(publisher.publishArchitectureProposal).not.toHaveBeenCalled();
  });

  it("returns a classified failure without fabricating a proposal when execution fails", async () => {
    const publisher = { publishArchitectureProposal: vi.fn() };

    await expect(runArchitectureReviewAutomationCommand({
      github: eligibleGithub(),
      checkout: {
        withCheckout: vi.fn(async (_request, action) => action("/safe/disposable-checkout")),
      },
      reviewer: { review: vi.fn().mockRejectedValue(new Error("Agent execution failed")) },
      publisher,
      createJobId: () => "job-228",
    })).resolves.toEqual({
      status: "blocked",
      reason: "architecture-review-execution",
      jobId: "job-228",
      summary: "Agent execution failed",
    });

    expect(publisher.publishArchitectureProposal).not.toHaveBeenCalled();
  });

  it("returns a classified failure when extraction exhausts its bounded retries", async () => {
    await expect(runArchitectureReviewAutomationCommand({
      github: eligibleGithub(),
      checkout: {
        withCheckout: vi.fn(async (_request, action) => action("/safe/disposable-checkout")),
      },
      reviewer: { review: vi.fn().mockRejectedValue(new Error("Structured output extraction failed")) },
      publisher: { publishArchitectureProposal: vi.fn() },
    })).resolves.toEqual({
      status: "blocked",
      reason: "architecture-review-execution",
      jobId: "local-architecture-review-job",
      summary: "Structured output extraction failed",
    });
  });

  it("classifies publication failure after an accepted proposal without fabricating one", async () => {
    await expect(runArchitectureReviewAutomationCommand({
      github: eligibleGithub(),
      checkout: {
        withCheckout: vi.fn(async (_request, action) => action("/safe/disposable-checkout")),
      },
      reviewer: {
        review: vi.fn(async () => ({
          status: "proposed" as const,
          title: "Deepen the search indexer",
          body: "body",
          oneLineSummary: "summary",
          candidatesConsidered: ["indexer"],
        })),
      },
      publisher: {
        publishArchitectureProposal: vi.fn().mockRejectedValue(new Error("GitHub unavailable")),
      },
      createJobId: () => "job-228",
    })).resolves.toEqual({
      status: "blocked",
      reason: "architecture-review-publication",
      jobId: "job-228",
      summary: "GitHub unavailable",
    });
  });

  it("returns a classified locally diagnosable failure when the Target Checkout cannot be created", async () => {
    await expect(runArchitectureReviewAutomationCommand({
      github: eligibleGithub(),
      checkout: { withCheckout: vi.fn().mockRejectedValue(new Error("Target Checkout requires a full Git revision")) },
      reviewer: { review: vi.fn() },
      publisher: { publishArchitectureProposal: vi.fn() },
      createJobId: () => "job-228",
    })).resolves.toEqual({
      status: "blocked",
      reason: "architecture-review-execution",
      jobId: "job-228",
      summary: "Target Checkout requires a full Git revision",
    });
  });

  describe("dedicated concurrency identity", () => {
    let repositoryPath: string;
    afterEach(async () => {
      await rm(repositoryPath, { recursive: true, force: true });
    });

    it("cannot overlap another architecture-review job and remains inspectable while active", async () => {
      repositoryPath = await mkdtemp(join(tmpdir(), "architecture-review-scheduler-"));
      await mkdir(join(repositoryPath, ".sandcastle"), { recursive: true });
      const scheduler = createAutomationScheduler({ repositoryPath });
      const first = await scheduler.acquire();
      expect(first).toBeDefined();

      let observed: readonly { jobId: string; identity: string }[] = [];
      await scheduler.track(ARCHITECTURE_REVIEW_IDENTITY, async () => {
        expect(await scheduler.acquire()).toBeUndefined();
        observed = await scheduler.activeJobs();
      });

      expect(ARCHITECTURE_REVIEW_IDENTITY).toBe("architecture-review");
      expect(observed).toHaveLength(1);
      expect(observed[0]!.identity).toBe("architecture-review");
      expect(await scheduler.activeJobs()).toEqual([]);
      await first!.release();
    });
  });
});
