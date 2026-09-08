import { describe, expect, it, vi } from "vitest";

import type {
  CheckoutObserver,
  CheckoutSnapshot,
  CheckoutStatusEntry,
} from "../.sandcastle/checkout-safety.js";
import { StopRetryError, isStopRetry } from "../.sandcastle/invocation-recovery.js";
import {
  createReviewProduceRecovery,
  reviewProducePrompt,
  reviewProduceRecoveryPrompt,
} from "../.sandcastle/review-recovery.js";

const revision = "0123456789abcdef0123456789abcdef01234567";
const producedHead = "b".repeat(40);
const checkoutPath = "/safe/disposable-checkout";

const request = {
  pullRequestNumber: 220,
  branch: "feature/review",
  revision,
  reviewThreads: [{ commentId: "PRRC_1", author: "maintainer", body: "Please fix this." }],
  model: "reviewer-model",
  name: "review-pr-220",
};

const cleanSnapshot = (head = producedHead): CheckoutSnapshot => ({ head, entries: [] });

const residueEntries: readonly CheckoutStatusEntry[] = [
  { index: " ", worktree: "M", path: "src/file.ts", kind: "tracked" },
  { index: "?", worktree: "?", path: "notes.txt", kind: "untracked" },
];

function harness(
  runAgent: ReturnType<typeof vi.fn>,
  observe: ReturnType<typeof vi.fn>,
) {
  const observer = {
    observe,
    requireClean: vi.fn(),
    requireUnchanged: vi.fn(),
  } as unknown as CheckoutObserver;
  const wait = vi.fn(async () => {});
  const createAgent = vi.fn().mockReturnValue({ name: "fake-reviewer" });
  const recovery = createReviewProduceRecovery({
    sandbox: { kind: "fake-sandbox" } as never,
    hooks: { sandbox: { onSandboxReady: [] } },
    checkoutPath,
    observer,
    wait,
    runAgent: runAgent as never,
    createAgent: createAgent as never,
  });
  return { recovery, wait, createAgent, observer };
}

describe("reviewer produce recovery", () => {
  it("succeeds on the first attempt and freezes the clean post-produce snapshot", async () => {
    const resume = vi.fn();
    const runAgent = vi.fn().mockResolvedValue({ commits: [{ sha: producedHead }], resume });
    const observe = vi.fn().mockResolvedValue(cleanSnapshot());
    const { recovery, wait, createAgent } = harness(runAgent, observe);

    const outcome = await recovery.produce(request);

    expect(outcome.checkpoint.resume).toBe(resume);
    expect(outcome.snapshot).toEqual(cleanSnapshot());
    expect(runAgent).toHaveBeenCalledOnce();
    expect(createAgent).toHaveBeenCalledWith("reviewer-model");
    const produceRequest = runAgent.mock.calls[0]![0];
    expect(produceRequest).toEqual(expect.objectContaining({
      cwd: checkoutPath,
      maxIterations: 1,
      branchStrategy: { type: "head" },
      name: "review-pr-220",
    }));
    // Drift guard: the library's recursive output retry is never armed.
    expect(produceRequest).not.toHaveProperty("output");
    expect(produceRequest.prompt).toBe(reviewProducePrompt(request));
    expect(produceRequest.prompt).not.toContain("interrupted");
    // The produce contract is validated from observer state after the success.
    expect(observe).toHaveBeenCalledOnce();
    expect(observe).toHaveBeenCalledWith(checkoutPath);
    expect(wait).not.toHaveBeenCalled();
  });

  it("keeps a commit created before attempt one rejects when attempt two returns cleanly without a new commit", async () => {
    const resume = vi.fn();
    // Attempt one committed its improvement, then the invocation rejected;
    // attempt two recognizes the existing commit and returns without
    // creating another one. Acceptance is observer state, not which attempt
    // committed.
    const runAgent = vi.fn()
      .mockRejectedValueOnce(new Error("provider stream ended"))
      .mockResolvedValue({ commits: [], resume });
    const observe = vi.fn().mockResolvedValue(cleanSnapshot());
    const { recovery, wait } = harness(runAgent, observe);

    const outcome = await recovery.produce(request);

    expect(outcome.checkpoint.resume).toBe(resume);
    expect(runAgent).toHaveBeenCalledTimes(2);
    expect(runAgent.mock.calls[0]![0].prompt).toBe(reviewProducePrompt(request));
    expect(runAgent.mock.calls[1]![0].prompt).toBe(reviewProduceRecoveryPrompt(request));
    // No observation ran between the rejection and the recovery attempt: an
    // interrupted attempt may leave understood partial work in place.
    expect(observe).toHaveBeenCalledOnce();
    expect(wait).toHaveBeenCalledOnce();
    expect(wait).toHaveBeenCalledWith(2_000, undefined);
  });

  it("lets a recovery attempt complete dirty partial work left by an interrupted attempt", async () => {
    const resume = vi.fn();
    // The interrupted attempt left uncommitted partial edits; the recovery
    // attempt inspected, completed, and committed them before returning.
    const runAgent = vi.fn()
      .mockRejectedValueOnce(new Error("sandbox restarted"))
      .mockResolvedValue({ commits: [{ sha: producedHead }], resume });
    const observe = vi.fn().mockResolvedValue(cleanSnapshot());
    const { recovery } = harness(runAgent, observe);

    await expect(recovery.produce(request)).resolves.toMatchObject({
      snapshot: cleanSnapshot(),
    });
    expect(runAgent).toHaveBeenCalledTimes(2);
  });

  it("treats a successful return with residue as a recoverable produce-contract failure", async () => {
    const resume = vi.fn();
    const runAgent = vi.fn().mockResolvedValue({ commits: [], resume });
    const observe = vi.fn()
      .mockResolvedValueOnce({ head: producedHead, entries: residueEntries })
      .mockResolvedValueOnce(cleanSnapshot());
    const { recovery, wait } = harness(runAgent, observe);

    const outcome = await recovery.produce(request);

    expect(outcome.checkpoint.resume).toBe(resume);
    expect(runAgent).toHaveBeenCalledTimes(2);
    expect(observe).toHaveBeenCalledTimes(2);
    expect(wait).toHaveBeenCalledOnce();
    // The second attempt is a recovery attempt: it inspects and continues
    // the checkout's current state rather than starting over.
    expect(runAgent.mock.calls[1]![0].prompt).toBe(reviewProduceRecoveryPrompt(request));
  });

  it("retries a clean successful return that carries no resumable checkpoint", async () => {
    const resume = vi.fn();
    const runAgent = vi.fn()
      .mockResolvedValueOnce({ commits: [{ sha: producedHead }] })
      .mockResolvedValueOnce({ commits: [{ sha: producedHead }], resume });
    const observe = vi.fn().mockResolvedValue(cleanSnapshot());
    const { recovery } = harness(runAgent, observe);

    const outcome = await recovery.produce(request);

    expect(outcome.checkpoint.resume).toBe(resume);
    expect(runAgent).toHaveBeenCalledTimes(2);
  });

  it("surfaces the last failure unchanged after three exhausted produce attempts", async () => {
    const failures = [1, 2, 3].map((n) => new Error(`invocation failure ${n}`));
    const runAgent = vi.fn().mockImplementation(() =>
      Promise.reject(failures[runAgent.mock.calls.length - 1]));
    const observe = vi.fn();
    const { recovery, wait } = harness(runAgent, observe);

    await expect(recovery.produce(request)).rejects.toBe(failures[2]);
    expect(runAgent).toHaveBeenCalledTimes(3);
    expect(wait).toHaveBeenCalledTimes(2);
    expect(observe).not.toHaveBeenCalled();
  });

  it("exhausts the bounded window when every successful return leaves residue", async () => {
    const runAgent = vi.fn().mockResolvedValue({ commits: [], resume: vi.fn() });
    const observe = vi.fn().mockResolvedValue({ head: producedHead, entries: residueEntries });
    const { recovery } = harness(runAgent, observe);

    const failure = await recovery.produce(request).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain("unclean checkout");
    expect((failure as Error).message).toContain("unstaged=1");
    expect((failure as Error).message).toContain("untracked=1");
    // The residue summary never carries paths or observer output.
    expect((failure as Error).message).not.toContain("src/file.ts");
    expect((failure as Error).message).not.toContain("notes.txt");
    expect(runAgent).toHaveBeenCalledTimes(3);
  });

  it("stops the window immediately when the checkout becomes unobservable", async () => {
    const unobservable = new StopRetryError("Target Checkout path is missing");
    const runAgent = vi.fn().mockResolvedValue({ commits: [], resume: vi.fn() });
    const observe = vi.fn().mockRejectedValue(unobservable);
    const { recovery, wait } = harness(runAgent, observe);

    const failure = await recovery.produce(request).catch((error: unknown) => error);

    expect(failure).toBe(unobservable);
    expect(isStopRetry(failure)).toBe(true);
    expect(runAgent).toHaveBeenCalledOnce();
    expect(wait).not.toHaveBeenCalled();
  });
});

describe("reviewer produce prompts", () => {
  it("instructs the recovery attempt to inspect and continue the checkout's complete current state", () => {
    const prompt = reviewProduceRecoveryPrompt(request);

    expect(prompt).toContain(`Pull Request #${request.pullRequestNumber} on branch ${request.branch}`);
    expect(prompt).toContain(`exact revision ${revision}`);
    expect(prompt).toContain("interrupted");
    expect(prompt).toContain("git status");
    expect(prompt).toContain(`current diff against ${revision}`);
    expect(prompt).toContain("git log");
    expect(prompt).toContain("do not duplicate fixes");
    expect(prompt).toContain("complete current state");
    // The recovery prompt keeps the full produce contract: threads, no push,
    // and committing improvements on the existing branch.
    expect(prompt).toContain("PRRC_1");
    expect(prompt).toContain("commit every intended improvement");
    expect(prompt).toContain("controlled publisher will push");
  });

  it("keeps the first-attempt prompt free of recovery language", () => {
    const prompt = reviewProducePrompt(request);

    expect(prompt).toContain(`Pull Request #${request.pullRequestNumber} on branch ${request.branch}`);
    expect(prompt).toContain("PRRC_1");
    expect(prompt).not.toContain("interrupted");
    expect(prompt).not.toContain("git status");
  });
});
