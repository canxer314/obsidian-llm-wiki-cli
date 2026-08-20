import { describe, expect, it, vi } from "vitest";

import {
  runSandcastleCli,
  type SandcastleGithubPort,
  type SandcastleSignal,
  type SandcastleSignalSource,
} from "../.sandcastle/cli.js";

function githubPort(issueNumbers: readonly number[] = [207]): SandcastleGithubPort {
  return {
    ensureLabel: vi.fn(),
    getIssue: vi.fn(async (number) => ({ number, state: "OPEN", labels: ["Sandcastle"] })),
    listCandidateIssues: vi.fn(async () =>
      issueNumbers.map((number) => ({ number, state: "OPEN", labels: ["Sandcastle"] }))),
    claimIssue: vi.fn(async () => true),
  };
}

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function fakeSignals(): SandcastleSignalSource & { emit(signal: SandcastleSignal): void; size(): number } {
  const listeners = new Set<(signal: SandcastleSignal) => void>();
  return {
    add(listener) { listeners.add(listener); },
    remove(listener) { listeners.delete(listener); },
    emit(signal) { for (const listener of [...listeners]) listener(signal); },
    size: () => listeners.size,
  };
}

describe("Sandcastle controlled cancellation", () => {
  it("aborts a single Issue once, waits for teardown, then allows forced exit", async () => {
    const signals = fakeSignals();
    const teardown = deferred();
    const warnings: string[] = [];
    const forceExit = vi.fn();
    let receivedSignal: AbortSignal | undefined;
    const running = runSandcastleCli(["--issue", "207"], {
      github: githubPort(),
      signalSource: signals,
      warningSink: (warning) => warnings.push(warning),
      forceExit,
      processIssue: async (_number, execution) => {
        receivedSignal = execution.signal;
        await teardown.promise;
        throw execution.signal.reason;
      },
    });
    const settled = vi.fn();
    void running.finally(settled).catch(() => undefined);

    await vi.waitFor(() => expect(receivedSignal).toBeDefined());
    signals.emit("SIGTERM");
    expect(receivedSignal!.aborted).toBe(true);
    expect(settled).not.toHaveBeenCalled();

    signals.emit("SIGINT");
    expect(forceExit).toHaveBeenCalledWith(1);
    expect(warnings).toEqual([
      "Sandcastle forced exit requested; finalization may be incomplete",
    ]);

    teardown.resolve();
    await expect(running).rejects.toBe(receivedSignal!.reason);
    expect(signals.size()).toBe(0);
  });

  it("does not claim a single Issue when cancellation arrives during startup", async () => {
    const signals = fakeSignals();
    const startup = deferred();
    const github = githubPort();
    vi.mocked(github.ensureLabel).mockImplementation(() => startup.promise);
    const processIssue = vi.fn().mockResolvedValue(undefined);
    const running = runSandcastleCli(["--issue", "207"], {
      github,
      signalSource: signals,
      processIssue,
    });

    await vi.waitFor(() => expect(github.ensureLabel).toHaveBeenCalledOnce());
    signals.emit("SIGINT");
    startup.resolve();
    await expect(running).rejects.toMatchObject({ name: "AbortError" });
    expect(github.claimIssue).not.toHaveBeenCalled();
    expect(processIssue).not.toHaveBeenCalled();
  });

  it("drains watch work on the first signal and cancels all active work on the second", async () => {
    const signals = fakeSignals();
    const workflows = new Map([[206, deferred()], [207, deferred()]]);
    const seenSignals = new Map<number, AbortSignal>();
    const sleep = deferred();
    const running = runSandcastleCli(["--watch"], {
      github: githubPort([206, 207]),
      signalSource: signals,
      sleep: vi.fn(() => sleep.promise),
      processIssue: async (number, execution) => {
        seenSignals.set(number, execution.signal);
        await workflows.get(number)!.promise;
        if (execution.signal.aborted) throw execution.signal.reason;
      },
    });

    await vi.waitFor(() => expect(seenSignals.size).toBe(2));
    signals.emit("SIGINT");
    expect([...seenSignals.values()].every((signal) => !signal.aborted)).toBe(true);

    signals.emit("SIGTERM");
    expect([...seenSignals.values()].every((signal) => signal.aborted)).toBe(true);
    workflows.get(206)!.resolve();
    workflows.get(207)!.resolve();
    await expect(running).resolves.toBeUndefined();
    expect(signals.size()).toBe(0);
  });

  it("forces watch exit on the third signal and records fixed interruption evidence", async () => {
    const signals = fakeSignals();
    const workflow = deferred();
    const warnings: string[] = [];
    const forceExit = vi.fn();
    const evidence: unknown[] = [];
    let monotonicMs = 1_000;
    const running = runSandcastleCli(["--watch", "--no-live-status"], {
      github: githubPort([207]),
      signalSource: signals,
      warningSink: (warning) => warnings.push(warning),
      forceExit,
      monotonicNow: () => monotonicMs,
      utcNow: () => new Date("2026-08-20T12:00:00.000Z"),
      recordInterruption: (event) => evidence.push(event),
      processIssue: async (_number, execution) => {
        await workflow.promise;
        if (execution.signal.aborted) throw execution.signal.reason;
      },
    });

    await vi.waitFor(() => expect(vi.mocked(forceExit)).not.toHaveBeenCalled());
    await vi.waitFor(() => expect(evidence).toHaveLength(0));
    signals.emit("SIGINT");
    monotonicMs = 1_250;
    signals.emit("SIGTERM");
    monotonicMs = 1_500;
    signals.emit("SIGINT");

    expect(forceExit).toHaveBeenCalledWith(1);
    expect(warnings).toEqual(["Sandcastle forced exit requested; finalization may be incomplete"]);
    expect(evidence).toEqual([
      expect.objectContaining({ lifecycle: "draining", outcome: "requested", elapsedMs: 0 }),
      expect.objectContaining({ lifecycle: "cancelling", outcome: "requested", elapsedMs: 250 }),
      {
        kind: "interruption-lifecycle",
        runId: expect.any(String),
        lifecycle: "forced-exit",
        timestamp: "2026-08-20T12:00:00.000Z",
        elapsedMs: 500,
        outcome: "incomplete",
      },
    ]);
    expect(JSON.stringify(evidence)).not.toContain("SIGINT");
    expect(JSON.stringify(evidence)).not.toContain("SIGTERM");

    workflow.resolve();
    await expect(running).resolves.toBeUndefined();
  });

  it("does not claim after watch enters drain while discovery is pending", async () => {
    const signals = fakeSignals();
    const discovery = deferred();
    const github = githubPort([207]);
    vi.mocked(github.listCandidateIssues).mockImplementation(async () => {
      await discovery.promise;
      return [{ number: 207, state: "OPEN", labels: ["Sandcastle"] }];
    });
    const running = runSandcastleCli(["--watch"], {
      github,
      signalSource: signals,
      processIssue: vi.fn().mockResolvedValue(undefined),
    });

    await vi.waitFor(() => expect(github.listCandidateIssues).toHaveBeenCalledOnce());
    signals.emit("SIGTERM");
    discovery.resolve();
    await expect(running).resolves.toBeUndefined();
    expect(github.claimIssue).not.toHaveBeenCalled();
  });

  it("starts a successfully claimed Issue conservatively when drain races with the claim", async () => {
    const signals = fakeSignals();
    const claim = deferred();
    const github = githubPort([207]);
    vi.mocked(github.claimIssue).mockImplementation(async () => {
      await claim.promise;
      return true;
    });
    const processIssue = vi.fn().mockResolvedValue(undefined);
    const running = runSandcastleCli(["--watch"], {
      github,
      signalSource: signals,
      processIssue,
    });

    await vi.waitFor(() => expect(github.claimIssue).toHaveBeenCalledOnce());
    signals.emit("SIGINT");
    claim.resolve();
    await expect(running).resolves.toBeUndefined();
    expect(processIssue).toHaveBeenCalledOnce();
  });
});
