import { describe, expect, it, vi } from "vitest";

import type { CheckoutObserver, CheckoutSnapshot } from "../.sandcastle/checkout-safety.js";
import {
  FEEDBACK_FORMATTING_CONTRACT,
  createFeedbackImplementerSession,
} from "../.sandcastle/feedback-implementer-session.js";
import { StopRetryError, isStopRetry } from "../.sandcastle/invocation-recovery.js";

const revision = "0123456789abcdef0123456789abcdef01234567";
const producedHead = "b".repeat(40);
const request = {
  pullRequestNumber: 224,
  branch: "feature/feedback",
  revision,
  checkoutPath: "/safe/disposable-checkout",
  rootCommentId: "PRRC_root",
  model: "implementer-model",
};

const tagged = (value: unknown) => `<feedback-reply>${JSON.stringify(value)}</feedback-reply>`;
const cleanReply = { rootCommentId: "PRRC_root", body: "Fixed." };

function fakeObserver(snapshot?: CheckoutSnapshot) {
  const frozen = snapshot ?? { head: producedHead, entries: [] };
  const observe = vi.fn().mockResolvedValue(frozen);
  const requireClean = vi.fn().mockResolvedValue(frozen);
  const requireUnchanged = vi.fn().mockResolvedValue(frozen);
  const observer = { observe, requireClean, requireUnchanged } as CheckoutObserver;
  return { observer, observe, requireClean, requireUnchanged, frozen };
}

function harness(
  runAgent: ReturnType<typeof vi.fn>,
  overrides: Record<string, unknown> = {},
) {
  const fakes = fakeObserver(overrides.snapshot as CheckoutSnapshot | undefined);
  const wait = vi.fn(async () => {});
  const createAgent = vi.fn().mockReturnValue({ name: "fake-implementer" });
  const session = createFeedbackImplementerSession({
    sandbox: { kind: "fake-sandbox" } as never,
    hooks: { sandbox: { onSandboxReady: [] } },
    observer: fakes.observer,
    wait,
    runAgent: runAgent as never,
    createAgent: createAgent as never,
    ...overrides,
  });
  return { session, wait, createAgent, ...fakes };
}

describe("feedback Implementer session", () => {
  it("produces through the bounded window, then formats through the frozen produce session as an immutable stage", async () => {
    const resume = vi.fn().mockResolvedValue({ commits: [], stdout: tagged(cleanReply) });
    const runAgent = vi.fn().mockResolvedValue({ commits: [{ sha: producedHead }], resume });
    const { session, observe, requireClean, requireUnchanged } = harness(runAgent);

    await expect(session.run(request)).resolves.toEqual(cleanReply);

    // Produce: one bounded invocation against the prepared Target Checkout.
    expect(runAgent).toHaveBeenCalledOnce();
    const produceRequest = runAgent.mock.calls[0]![0];
    expect(produceRequest).toEqual(expect.objectContaining({
      cwd: request.checkoutPath,
      maxIterations: 1,
      branchStrategy: { type: "head" },
      name: "implementer-feedback-pr-224",
    }));
    expect(produceRequest.prompt).toContain("Pull Request #224");
    expect(produceRequest.prompt).toContain(`acquired full revision ${revision}`);
    expect(produceRequest.prompt).toContain("Do not create an Issue, branch, or Pull Request");
    expect(produceRequest.prompt).toContain("Do not run gh auth setup-git, git push, rebase, or force-push");
    expect(produceRequest.prompt).toContain("controlled publisher");
    expect(produceRequest.prompt).not.toContain("git push origin feature/feedback");
    expect(produceRequest).not.toHaveProperty("output");
    expect(observe).toHaveBeenCalledOnce();

    // Formatting baseline: requireClean at the frozen post-produce HEAD, then
    // the driver's own clean proof and unchanged proof around the resume.
    expect(requireClean).toHaveBeenCalledTimes(2);
    // Formatting resumes the produce session with the no-mutation contract;
    // no run call carries an output definition.
    expect(resume).toHaveBeenCalledOnce();
    const [formatPrompt] = resume.mock.calls[0]!;
    expect(formatPrompt).toContain("<feedback-reply>");
    expect(formatPrompt).toContain("one JSON object inside <feedback-reply> tags");
    expect(formatPrompt).toContain("Do not put rootCommentId or body in XML tag attributes");
    expect(formatPrompt).toContain(`The rootCommentId must be exactly ${request.rootCommentId}`);
    expect(formatPrompt).toContain("do not substitute another unresolved root or a reply comment");
    expect(formatPrompt).toContain(FEEDBACK_FORMATTING_CONTRACT);
    expect(requireUnchanged).toHaveBeenCalledOnce();
    // Two Agent executions total: one produce, one formatting.
    expect(runAgent.mock.calls.length + resume.mock.calls.length).toBe(2);
  });

  it("recovers a well-formed earlier <feedback-reply> block when the last closed block is malformed, with no re-emit", async () => {
    const stdout = [tagged(cleanReply), "<feedback-reply>not JSON at all</feedback-reply>"].join("\n");
    const resume = vi.fn().mockResolvedValue({
      commits: [],
      iterations: [{ sessionId: "feedback-session-1" }],
      stdout,
    });
    const runAgent = vi.fn().mockResolvedValue({
      commits: [],
      iterations: [{ sessionId: "feedback-session-1" }],
      resume,
    });
    const { session } = harness(runAgent);

    await expect(session.run(request)).resolves.toEqual(cleanReply);

    // Recovery consumed no retry: one produce invocation and one formatting
    // invocation, no same-session re-emit.
    expect(runAgent).toHaveBeenCalledOnce();
    expect(resume).toHaveBeenCalledOnce();
  });

  it("recovers formatting through a bounded structured attempt whose correction prompt repeats the no-mutation contract", async () => {
    const correctionResume = vi.fn().mockResolvedValue({ commits: [], stdout: tagged(cleanReply) });
    const produceResume = vi.fn().mockResolvedValue({
      commits: [],
      iterations: [{ sessionId: "feedback-session-2" }],
      stdout: "<feedback-reply>{oops</feedback-reply>",
      resume: correctionResume,
    });
    const runAgent = vi.fn().mockResolvedValue({ commits: [], resume: produceResume });
    const { session, requireUnchanged, wait } = harness(runAgent);

    await expect(session.run(request)).resolves.toEqual(cleanReply);

    expect(produceResume).toHaveBeenCalledOnce();
    expect(correctionResume).toHaveBeenCalledOnce();
    // A parse handoff never spends an invocation attempt: no backoff wait.
    expect(wait).not.toHaveBeenCalled();
    const [correctionPrompt] = correctionResume.mock.calls[0]!;
    expect(correctionPrompt).toContain("did not contain valid JSON");
    expect(correctionPrompt).toContain("structured attempt 2 of 3");
    expect(correctionPrompt).toContain(FEEDBACK_FORMATTING_CONTRACT);
    expect(correctionPrompt).not.toContain("{oops");
    // The unchanged proof ran after both formatting invocations.
    expect(requireUnchanged).toHaveBeenCalledTimes(2);
  });

  it("rejects malformed structured output after the bounded structured attempts", async () => {
    const resume = vi.fn().mockResolvedValue({ commits: [], stdout: "<feedback-reply>{oops</feedback-reply>" });
    const runAgent = vi.fn().mockResolvedValue({ commits: [], resume });
    const { session } = harness(runAgent);

    const failure = await session.run(request).catch((error: unknown) => error);

    expect((failure as Error).message).toContain("could not be parsed after 3 attempts");
    expect((failure as Error).message).not.toContain("{oops");
    expect(runAgent).toHaveBeenCalledOnce();
    // Three structured attempts, each resuming the retained produce
    // checkpoint (invalid completions carried no fresh checkpoint).
    expect(resume).toHaveBeenCalledTimes(3);
  });

  it("retries a produce attempt that leaves the session identity unavailable, then fails closed after three attempts", async () => {
    const runAgent = vi.fn().mockResolvedValue({ commits: [] });
    const { session, requireClean, wait } = harness(runAgent);

    await expect(session.run(request)).rejects.toThrow("Feedback Implementer session identity is unavailable");
    expect(runAgent).toHaveBeenCalledTimes(3);
    expect(wait).toHaveBeenCalledTimes(2);
    // Formatting never started: no baseline proof and no resume call.
    expect(requireClean).not.toHaveBeenCalled();
  });

  it("rejects a no-change produce success and never reaches formatting when HEAD stays at the acquired revision", async () => {
    const resume = vi.fn();
    const runAgent = vi.fn().mockResolvedValue({ commits: [], resume });
    const { session, requireClean } = harness(runAgent, {
      snapshot: { head: revision, entries: [] },
    });

    await expect(session.run(request)).rejects.toThrow("without changing the Target Checkout HEAD");
    expect(runAgent).toHaveBeenCalledTimes(3);
    // Formatting never started: no baseline proof and no resume call.
    expect(requireClean).not.toHaveBeenCalled();
    expect(resume).not.toHaveBeenCalled();
  });

  it("stops before any formatting Agent call when the baseline drifts from the frozen post-produce HEAD", async () => {
    const resume = vi.fn();
    const runAgent = vi.fn().mockResolvedValue({ commits: [], resume });
    const drifted = { head: "c".repeat(40), entries: [] };
    const observe = vi.fn().mockResolvedValue({ head: producedHead, entries: [] });
    const requireClean = vi.fn().mockResolvedValue(drifted);
    const observer = { observe, requireClean, requireUnchanged: vi.fn() } as unknown as CheckoutObserver;
    const session = createFeedbackImplementerSession({
      sandbox: { kind: "fake-sandbox" } as never,
      hooks: { sandbox: { onSandboxReady: [] } },
      observer,
      wait: vi.fn(async () => {}),
      runAgent: runAgent as never,
      createAgent: vi.fn().mockReturnValue({ name: "fake-implementer" }) as never,
    });

    const failure = await session.run(request).catch((error: unknown) => error);

    expect(isStopRetry(failure)).toBe(true);
    expect((failure as Error).message).toContain("frozen post-produce HEAD");
    expect(resume).not.toHaveBeenCalled();
  });

  it("stops recovery immediately when a formatting invocation mutates HEAD or the checkout", async () => {
    const resume = vi.fn().mockResolvedValue({ commits: [], stdout: tagged(cleanReply) });
    const runAgent = vi.fn().mockResolvedValue({ commits: [], resume });
    const { session, requireUnchanged, wait } = harness(runAgent);
    requireUnchanged.mockRejectedValueOnce(
      new StopRetryError("Target Checkout changed during a read-only stage"),
    );

    const failure = await session.run(request).catch((error: unknown) => error);

    expect(isStopRetry(failure)).toBe(true);
    expect(runAgent).toHaveBeenCalledOnce();
    expect(resume).toHaveBeenCalledOnce();
    expect(wait).not.toHaveBeenCalled();
  });

  it("keeps the selected immutable feedback root pinned even when the emitted reply names another root", async () => {
    // A wrong rootCommentId is schema-valid, so the session returns the
    // extracted intent unchanged; the orchestrator's pre-publication check
    // rejects the mismatch. The session's guarantee is prompt fidelity: the
    // initial formatting prompt pins the selected root verbatim.
    const wrongRoot = { rootCommentId: "PRRC_other", body: "Fixed." };
    const resume = vi.fn().mockResolvedValue({ commits: [], stdout: tagged(wrongRoot) });
    const runAgent = vi.fn().mockResolvedValue({ commits: [], resume });
    const { session } = harness(runAgent);

    await expect(session.run(request)).resolves.toEqual(wrongRoot);
    expect(resume.mock.calls[0]![0]).toContain(
      `The rootCommentId must be exactly ${request.rootCommentId}`,
    );
  });

  it("stays within the normative twelve Agent executions before surfacing exhaustion", async () => {
    // Produce: two rejections, then a clean success (3 executions).
    // Formatting: every structured attempt rejects twice, then completes
    // with an invalid payload that carries no fresh checkpoint (9 executions).
    const resume = vi.fn();
    const runAgent = vi.fn()
      .mockRejectedValueOnce(new Error("gateway unavailable"))
      .mockRejectedValueOnce(new Error("gateway unavailable"))
      .mockResolvedValueOnce({ commits: [], resume });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      resume
        .mockRejectedValueOnce(new Error("gateway unavailable"))
        .mockRejectedValueOnce(new Error("gateway unavailable"))
        .mockResolvedValueOnce({ commits: [], stdout: "<feedback-reply>{broken</feedback-reply>" });
    }
    const { session, wait } = harness(runAgent);

    const failure = await session.run(request).catch((error: unknown) => error);

    const executions = runAgent.mock.calls.length + resume.mock.calls.length;
    expect(executions).toBe(12);
    expect(runAgent).toHaveBeenCalledTimes(3);
    expect(resume).toHaveBeenCalledTimes(9);
    expect(wait).toHaveBeenCalledTimes(8);
    expect((failure as Error).message).toContain("could not be parsed after 3 attempts");
  });
});
