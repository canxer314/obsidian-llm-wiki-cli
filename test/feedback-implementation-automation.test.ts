import { describe, expect, it, vi } from "vitest";

import { runFeedbackImplementationAutomationCommand } from "../.sandcastle/feedback-implementation-automation.js";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

function pullRequest(headSha = SHA_A, labels = ["agent:implement"]) {
  return {
    number: 224,
    state: "OPEN",
    isDraft: true,
    baseRepository: "canxer314/obsidian-llm-wiki-cli",
    headRepository: "canxer314/obsidian-llm-wiki-cli",
    headRefName: "feature/feedback",
    headSha,
    labels,
  };
}

function ports() {
  const github = {
    readPullRequest: vi.fn()
      .mockResolvedValueOnce(pullRequest())
      .mockResolvedValueOnce(pullRequest())
      .mockResolvedValueOnce(pullRequest(SHA_A, ["agent:in-progress"]))
      .mockResolvedValueOnce(pullRequest(SHA_B, ["agent:in-progress"])),
    addPullRequestLabel: vi.fn().mockResolvedValue(undefined),
    removePullRequestLabel: vi.fn().mockResolvedValue(undefined),
    addFeedbackBlockedDiagnostic: vi.fn().mockResolvedValue(undefined),
  };
  const publisher = {
    prepare: vi.fn().mockResolvedValue(undefined),
    publish: vi.fn().mockResolvedValue(SHA_B),
  };
  const implementer = { implement: vi.fn().mockResolvedValue(undefined) };
  return {
    github,
    publisher,
    implementer,
    checkout: {
      withCheckout: vi.fn(async (_request, action) => action("/checkout")),
    },
    createJobId: () => "feedback-job",
  };
}

describe("feedback implementation automation", () => {
  it("publishes only through the controlled publisher and verifies the existing PR head", async () => {
    const subject = ports();

    await expect(runFeedbackImplementationAutomationCommand({ pullRequestNumber: 224 }, subject))
      .resolves.toEqual({ status: "implemented", revision: SHA_B });

    expect(subject.publisher.prepare).toHaveBeenCalledWith("/checkout", "feature/feedback", SHA_A);
    expect(subject.implementer.implement).toHaveBeenCalledWith({
      pullRequestNumber: 224,
      branch: "feature/feedback",
      revision: SHA_A,
      checkoutPath: "/checkout",
    });
    expect(subject.publisher.publish).toHaveBeenCalledWith({
      checkoutPath: "/checkout",
      branch: "feature/feedback",
      expectedRevision: SHA_A,
    });
  });

  it("blocks the work item when the PR head differs after publication", async () => {
    const subject = ports();
    subject.github.readPullRequest.mockReset()
      .mockResolvedValueOnce(pullRequest())
      .mockResolvedValueOnce(pullRequest())
      .mockResolvedValueOnce(pullRequest(SHA_A, ["agent:in-progress"]))
      .mockResolvedValueOnce(pullRequest("c".repeat(40), ["agent:in-progress"]));

    await expect(runFeedbackImplementationAutomationCommand({ pullRequestNumber: 224 }, subject))
      .resolves.toEqual({ status: "blocked", reason: "feedback-execution", jobId: "feedback-job" });

    expect(subject.github.addPullRequestLabel).toHaveBeenCalledWith(224, "agent:blocked");
    expect(subject.github.removePullRequestLabel).toHaveBeenCalledWith(224, "agent:in-progress");
  });
});
