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
    claimIssue: vi.fn(async (number, runId) => ({
      issueNumber: number,
      runId,
      branch: `sandcastle/issue-${number}`,
      baseSha: "a".repeat(40),
    })),
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
  it("finalizes only the current run receipt after controlled single-Issue teardown", async () => {
    const signals = fakeSignals();
    const teardown = deferred();
    const finalizeInterruption = vi.fn(async () => undefined);
    const running = runSandcastleCli(["--issue", "209"], {
      github: githubPort([209]),
      createRunId: () => "run-current-process",
      signalSource: signals,
      finalizeInterruption,
      processIssue: async (_number, execution) => {
        await teardown.promise;
        throw execution.signal.reason;
      },
    });

    await vi.waitFor(() => expect(vi.mocked(finalizeInterruption)).not.toHaveBeenCalled());
    signals.emit("SIGTERM");
    expect(finalizeInterruption).not.toHaveBeenCalled();
    teardown.resolve();
    await expect(running).rejects.toMatchObject({ name: "AbortError" });
    expect(finalizeInterruption).toHaveBeenCalledWith({
      issueNumber: 209,
      runId: "run-current-process",
      branch: "sandcastle/issue-209",
      baseSha: "a".repeat(40),
    });
  });

  it("returns a nonzero failure when interruption finalization fails", async () => {
    const signals = fakeSignals();
    const teardown = deferred();
    const cleanupFailure = new Error("interrupted cleanup failed");
    const running = runSandcastleCli(["--issue", "209"], {
      github: githubPort([209]),
      signalSource: signals,
      finalizeInterruption: vi.fn().mockRejectedValue(cleanupFailure),
      processIssue: async (_number, execution) => {
        await teardown.promise;
        throw execution.signal.reason;
      },
    });

    await vi.waitFor(() => expect(signals.size()).toBe(1));
    signals.emit("SIGTERM");
    teardown.resolve();
    await expect(running).rejects.toBe(cleanupFailure);
  });

  it("returns a nonzero watch failure when interruption finalization fails", async () => {
    const signals = fakeSignals();
    const teardown = deferred();
    const cleanupFailure = new Error("interrupted cleanup failed");
    let started = false;
    const running = runSandcastleCli(["--watch"], {
      github: githubPort([209]),
      signalSource: signals,
      finalizeInterruption: vi.fn().mockRejectedValue(cleanupFailure),
      processIssue: async (_number, execution) => {
        started = true;
        await teardown.promise;
        throw execution.signal.reason;
      },
    });

    await vi.waitFor(() => expect(started).toBe(true));
    signals.emit("SIGINT");
    signals.emit("SIGTERM");
    teardown.resolve();
    await expect(running).rejects.toBe(cleanupFailure);
  });

  it("does not finalize a receipt after normal completion or non-signal failure", async () => {
    const finalizeInterruption = vi.fn(async () => undefined);
    await runSandcastleCli(["--issue", "209"], {
      github: githubPort([209]),
      finalizeInterruption,
      processIssue: vi.fn().mockResolvedValue(undefined),
    });
    expect(finalizeInterruption).not.toHaveBeenCalled();

    await expect(runSandcastleCli(["--issue", "210"], {
      github: githubPort([210]),
      finalizeInterruption,
      processIssue: vi.fn().mockRejectedValue(new Error("ordinary failure")),
    })).rejects.toThrow("ordinary failure");
    expect(finalizeInterruption).not.toHaveBeenCalled();
  });

  it("isolates receipts when two watch Issues are cancelled", async () => {
    const signals = fakeSignals();
    const workflows = new Map([[208, deferred()], [209, deferred()]]);
    const sleep = deferred();
    const finalized: number[] = [];
    const started = new Set<number>();
    const running = runSandcastleCli(["--watch"], {
      github: githubPort([208, 209]),
      createRunId: () => "run-watch",
      signalSource: signals,
      sleep: () => sleep.promise,
      finalizeInterruption: async (claimReceipt) => { finalized.push(claimReceipt.issueNumber); },
      processIssue: async (number, execution) => {
        started.add(number);
        await workflows.get(number)!.promise;
        throw execution.signal.reason;
      },
    });

    await vi.waitFor(() => expect(started.size).toBe(2));
    signals.emit("SIGINT");
    signals.emit("SIGTERM");
    workflows.get(208)!.resolve();
    workflows.get(209)!.resolve();
    await expect(running).resolves.toBeUndefined();
    expect(finalized.sort()).toEqual([208, 209]);
  });

  it("does not infer ownership when no receipt was created", async () => {
    const signals = fakeSignals();
    const github = githubPort([209]);
    vi.mocked(github.claimIssue).mockResolvedValue(null);
    const finalizeInterruption = vi.fn(async () => undefined);
    const running = runSandcastleCli(["--issue", "209"], {
      github,
      signalSource: signals,
      finalizeInterruption,
      processIssue: vi.fn(),
    });

    await expect(running).resolves.toBeUndefined();
    signals.emit("SIGTERM");
    expect(finalizeInterruption).not.toHaveBeenCalled();
  });

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

  it("finalizes a receipt cancelled before active workflow registration", async () => {
    const signals = fakeSignals();
    const claim = deferred();
    const github = githubPort([207]);
    vi.mocked(github.claimIssue).mockImplementation(async (_number, runId) => {
      await claim.promise;
      return {
        issueNumber: 207,
        runId,
        branch: "sandcastle/issue-207",
        baseSha: "a".repeat(40),
      };
    });
    const processIssue = vi.fn().mockResolvedValue(undefined);
    const finalizeInterruption = vi.fn(async () => undefined);
    const running = runSandcastleCli(["--watch"], {
      github,
      signalSource: signals,
      processIssue,
      finalizeInterruption,
    });

    await vi.waitFor(() => expect(github.claimIssue).toHaveBeenCalledOnce());
    signals.emit("SIGINT");
    signals.emit("SIGTERM");
    claim.resolve();
    await expect(running).resolves.toBeUndefined();
    expect(processIssue).not.toHaveBeenCalled();
    expect(finalizeInterruption).toHaveBeenCalledWith(expect.objectContaining({
      issueNumber: 207,
      branch: "sandcastle/issue-207",
    }));
  });

  it("finalizes instead of starting when cancellation arrives after launch selection", async () => {
    const signals = fakeSignals();
    const processIssue = vi.fn().mockResolvedValue(undefined);
    const finalizeInterruption = vi.fn(async () => undefined);
    const running = runSandcastleCli(["--watch"], {
      github: githubPort([207]),
      signalSource: signals,
      processIssue,
      finalizeInterruption,
      recordWatchEvent: (event) => {
        if (event.kind === "batch-started") {
          signals.emit("SIGINT");
          signals.emit("SIGTERM");
        }
      },
    });

    await expect(running).resolves.toBeUndefined();
    expect(processIssue).not.toHaveBeenCalled();
    expect(finalizeInterruption).toHaveBeenCalledWith(expect.objectContaining({
      issueNumber: 207,
    }));
  });

  it("starts a successfully claimed Issue conservatively when drain races with the claim", async () => {
    const signals = fakeSignals();
    const claim = deferred();
    const github = githubPort([207]);
    vi.mocked(github.claimIssue).mockImplementation(async (number, runId) => {
      await claim.promise;
      return {
        issueNumber: number,
        runId,
        branch: `sandcastle/issue-${number}`,
        baseSha: "a".repeat(40),
      };
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
