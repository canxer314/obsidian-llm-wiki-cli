import { describe, expect, it, vi } from "vitest";

import {
  SandcastleCliError,
  runSandcastleCli,
  type SandcastleGithubPort,
} from "../.sandcastle/cli.js";

function githubPort(): SandcastleGithubPort {
  return {
    ensureLabel: vi.fn(),
    getIssue: vi.fn(),
    listCandidateIssues: vi.fn().mockResolvedValue([]),
    claimIssue: vi.fn(async (number, runId) => ({
      issueNumber: number,
      runId,
      branch: `sandcastle/issue-${number}`,
      baseSha: "a".repeat(40),
    })),
  };
}

function deferred(): {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
} {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

describe("Sandcastle CLI", () => {
  it.each([
    ["duplicate inspector", ["--inspect-claim", "206", "--inspect-claim", "207"]],
    ["watch mode", ["--inspect-claim", "206", "--watch"]],
    ["live execution option", ["--inspect-claim", "206", "--no-live-status"]],
  ])("rejects inspect mode combined with $0", async (_name, argv) => {
    const github = githubPort();
    const inspectClaim = vi.fn();

    await expect(runSandcastleCli(argv, {
      github,
      inspectClaim,
      processIssue: vi.fn(),
    })).rejects.toMatchObject<SandcastleCliError>({ exitCode: 2 });

    expect(inspectClaim).not.toHaveBeenCalled();
    expect(github.ensureLabel).not.toHaveBeenCalled();
  });

  it("dispatches claim inspection before every execution side effect", async () => {
    const github = githubPort();
    const inspectClaim = vi.fn().mockResolvedValue(undefined);
    const processIssue = vi.fn();
    const createRunId = vi.fn(() => "must-not-run");
    const handleFailure = vi.fn();

    await runSandcastleCli(["--inspect-claim", "206", "--status-format", "json"], {
      github,
      inspectClaim,
      processIssue,
      createRunId,
      handleFailure,
    });

    expect(inspectClaim).toHaveBeenCalledOnce();
    expect(inspectClaim).toHaveBeenCalledWith(206, "json");
    expect(createRunId).not.toHaveBeenCalled();
    expect(github.ensureLabel).not.toHaveBeenCalled();
    expect(github.getIssue).not.toHaveBeenCalled();
    expect(github.listCandidateIssues).not.toHaveBeenCalled();
    expect(github.claimIssue).not.toHaveBeenCalled();
    expect(processIssue).not.toHaveBeenCalled();
    expect(handleFailure).not.toHaveBeenCalled();
  });

  it("requires an explicit Issue in the default mode without scanning the backlog", async () => {
    const github = githubPort();
    const processIssue = vi.fn();

    await expect(
      runSandcastleCli([], { github, processIssue }),
    ).rejects.toMatchObject<SandcastleCliError>({
      message: "Missing required --issue <number>; use --watch to scan the backlog",
      exitCode: 2,
    });

    expect(github.getIssue).not.toHaveBeenCalled();
    expect(processIssue).not.toHaveBeenCalled();
  });

  it("rejects --issue and --watch together with a non-zero exit result", async () => {
    const github = githubPort();
    const processIssue = vi.fn();

    await expect(
      runSandcastleCli(["--issue", "100", "--watch"], {
        github,
        processIssue,
      }),
    ).rejects.toMatchObject<SandcastleCliError>({
      message: "--issue and --watch cannot be used together",
      exitCode: 2,
    });

    expect(github.getIssue).not.toHaveBeenCalled();
    expect(processIssue).not.toHaveBeenCalled();
  });

  it.each([
    "0",
    "-1",
    "+1",
    "1.5",
    "1e2",
    "0x64",
    " 100",
    "100 ",
    "9007199254740992",
    "not-a-number",
  ])(
    "rejects invalid Issue number %s before startup",
    async (value) => {
      const github = githubPort();

      await expect(
        runSandcastleCli(["--issue", value], {
          github,
          processIssue: vi.fn(),
        }),
      ).rejects.toMatchObject<SandcastleCliError>({
        message: "--issue requires a positive integer",
        exitCode: 2,
      });

      expect(github.ensureLabel).not.toHaveBeenCalled();
    },
  );

  it("prepares the failure label when watch mode starts", async () => {
    const github = githubPort();
    const stop = new Error("stop fake clock");

    await expect(runSandcastleCli(["--watch"], {
      github,
      processIssue: vi.fn(),
      sleep: vi.fn().mockRejectedValue(stop),
    })).rejects.toBe(stop);

    expect(github.ensureLabel).toHaveBeenCalledWith("sandcastle:failed");
    expect(github.getIssue).not.toHaveBeenCalled();
  });

  it("polls immediately and then every five minutes in watch mode", async () => {
    const github = githubPort();
    const stop = new Error("stop fake clock");
    const firstWait = deferred();
    const sleep = vi
      .fn<(milliseconds: number) => Promise<void>>()
      .mockReturnValueOnce(firstWait.promise)
      .mockRejectedValueOnce(stop);

    const watching = runSandcastleCli(["--watch"], {
      github,
      processIssue: vi.fn(),
      sleep,
    });
    await vi.waitFor(() => expect(github.listCandidateIssues).toHaveBeenCalledTimes(1));
    expect(sleep).toHaveBeenNthCalledWith(1, 300_000);

    firstWait.resolve();
    await expect(watching).rejects.toBe(stop);
    expect(github.listCandidateIssues).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenNthCalledWith(2, 300_000);
  });

  it("retries candidate discovery on the next tick after a transient failure", async () => {
    const github = githubPort();
    const failure = new Error("GitHub temporarily unavailable");
    vi.mocked(github.listCandidateIssues)
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce([]);
    const firstWait = deferred();
    const stop = new Error("stop fake clock");
    const sleep = vi
      .fn<(milliseconds: number) => Promise<void>>()
      .mockReturnValueOnce(firstWait.promise)
      .mockRejectedValueOnce(stop);

    const watching = runSandcastleCli(["--watch"], {
      github,
      processIssue: vi.fn(),
      sleep,
    });
    const stopped = watching.catch((error: unknown) => error);
    await vi.waitFor(() => expect(sleep).toHaveBeenCalledWith(300_000));
    firstWait.resolve();

    await expect(stopped).resolves.toBe(stop);
    expect(github.listCandidateIssues).toHaveBeenCalledTimes(2);
  });

  it("records one isolated watch batch when one of two Issues fails", async () => {
    const github = githubPort();
    vi.mocked(github.listCandidateIssues).mockResolvedValueOnce([
      { number: 116, state: "OPEN", labels: ["Sandcastle"] },
      { number: 117, state: "OPEN", labels: ["Sandcastle"] },
    ]);
    vi.mocked(github.getIssue).mockImplementation(async (number) => ({
      number,
      state: "OPEN",
      labels: ["Sandcastle"],
    }));
    const issue116 = deferred();
    const issue117 = deferred();
    const processIssue = vi.fn((number: number) => {
      if (number === 116) return issue116.promise.then(() => "merged");
      return issue117.promise.then(() => Promise.reject(new Error("review failed")));
    });
    const events: unknown[] = [];
    const runId = "acceptance-run";
    const stop = new Error("stop fake clock");
    const firstWait = deferred();
    const watching = runSandcastleCli(["--watch"], {
      github,
      processIssue,
      createRunId: () => runId,
      recordWatchEvent: (event) => events.push(event),
      sleep: vi.fn()
        .mockReturnValueOnce(firstWait.promise)
        .mockRejectedValueOnce(stop),
    });
    const stopped = watching.catch((error: unknown) => error);

    await vi.waitFor(() => expect(processIssue).toHaveBeenCalledTimes(2));
    issue117.resolve();
    await vi.waitFor(() => expect(events).toContainEqual({
      kind: "issue-finished",
      runId,
      batchId: 1,
      issueNumber: 117,
      outcome: "failure",
      activeCount: 1,
    }));
    issue116.resolve();
    await vi.waitFor(() => expect(events).toContainEqual({
      kind: "issue-finished",
      runId,
      batchId: 1,
      issueNumber: 116,
      outcome: "success",
      activeCount: 0,
    }));
    firstWait.resolve();
    await expect(stopped).resolves.toBe(stop);

    expect(events.slice(0, 3)).toEqual([
      { kind: "batch-started", runId, batchId: 1, issueNumbers: [116, 117] },
      { kind: "issue-started", runId, batchId: 1, issueNumber: 116, activeCount: 1 },
      { kind: "issue-started", runId, batchId: 1, issueNumber: 117, activeCount: 2 },
    ]);
    expect(processIssue.mock.calls.map(([issueNumber, execution]) => ({
      issueNumber,
      execution,
    }))).toEqual([
      {
        issueNumber: 116,
        execution: expect.objectContaining({ runId, batchId: 1, issueNumber: 116 }),
      },
      {
        issueNumber: 117,
        execution: expect.objectContaining({ runId, batchId: 1, issueNumber: 117 }),
      },
    ]);
    expect(events).not.toContainEqual(expect.objectContaining({ activeCount: 3 }));
  });

  it("keeps an in-flight Issue attributed to its starting batch", async () => {
    const github = githubPort();
    vi.mocked(github.listCandidateIssues)
      .mockResolvedValueOnce([
        { number: 116, state: "OPEN", labels: ["Sandcastle"] },
        { number: 117, state: "OPEN", labels: ["Sandcastle"] },
      ])
      .mockResolvedValueOnce([
        { number: 118, state: "OPEN", labels: ["Sandcastle"] },
      ]);
    vi.mocked(github.getIssue).mockImplementation(async (number) => ({
      number,
      state: "OPEN",
      labels: ["Sandcastle"],
    }));
    const workflows = new Map([
      [116, deferred()],
      [117, deferred()],
      [118, deferred()],
    ]);
    const events: unknown[] = [];
    const firstWait = deferred();
    const secondWait = deferred();
    const stop = new Error("stop fake clock");
    const watching = runSandcastleCli(["--watch"], {
      github,
      processIssue: (number) => workflows.get(number)!.promise,
      recordWatchEvent: (event) => events.push(event),
      sleep: vi.fn()
        .mockReturnValueOnce(firstWait.promise)
        .mockReturnValueOnce(secondWait.promise)
        .mockRejectedValueOnce(stop),
    });
    const stopped = watching.catch((error: unknown) => error);

    await vi.waitFor(() => expect(events).toContainEqual(expect.objectContaining({
      kind: "issue-started",
      batchId: 1,
      issueNumber: 117,
      activeCount: 2,
    })));
    workflows.get(117)!.resolve();
    await vi.waitFor(() => expect(events).toContainEqual(expect.objectContaining({
      kind: "issue-finished",
      issueNumber: 117,
    })));
    firstWait.resolve();
    await vi.waitFor(() => expect(events).toContainEqual(expect.objectContaining({
      kind: "issue-started",
      batchId: 2,
      issueNumber: 118,
      activeCount: 2,
    })));

    workflows.get(116)!.resolve();
    await vi.waitFor(() => expect(events).toContainEqual(expect.objectContaining({
      kind: "issue-finished",
      batchId: 1,
      issueNumber: 116,
      outcome: "success",
      activeCount: 1,
    })));
    workflows.get(118)!.resolve();
    secondWait.resolve();
    await expect(stopped).resolves.toBe(stop);
  });

  it("runs at most two candidate Issues concurrently", async () => {
    const github = githubPort();
    vi.mocked(github.listCandidateIssues)
      .mockResolvedValueOnce([
        { number: 101, state: "OPEN", labels: ["Sandcastle"] },
        { number: 102, state: "OPEN", labels: ["Sandcastle"] },
        { number: 103, state: "OPEN", labels: ["Sandcastle"] },
      ])
      .mockResolvedValue([{ number: 103, state: "OPEN", labels: ["Sandcastle"] }]);
    vi.mocked(github.getIssue).mockImplementation(async (number) => ({
      number,
      state: "OPEN",
      labels: ["Sandcastle"],
    }));
    const workflows = new Map([
      [101, deferred()],
      [102, deferred()],
      [103, deferred()],
    ]);
    const processIssue = vi.fn((number: number) => workflows.get(number)!.promise);
    const stop = new Error("stop fake clock");
    const firstWait = deferred();
    const watching = runSandcastleCli(["--watch"], {
      github,
      processIssue,
      sleep: vi
        .fn<(milliseconds: number) => Promise<void>>()
        .mockReturnValueOnce(firstWait.promise)
        .mockRejectedValueOnce(stop),
    });
    const stopped = watching.catch((error: unknown) => error);
    await vi.waitFor(() => expect(processIssue).toHaveBeenCalledTimes(2));
    expect(processIssue.mock.calls.map(([number]) => number)).toEqual([101, 102]);

    workflows.get(101)!.resolve();
    await vi.waitFor(() => expect(processIssue).toHaveBeenCalledTimes(2));
    await Promise.resolve();
    firstWait.resolve();
    await vi.waitFor(() => expect(processIssue).toHaveBeenCalledWith(
      103,
      expect.objectContaining({ issueNumber: 103 }),
    ));
    workflows.get(102)!.resolve();
    workflows.get(103)!.resolve();
    await expect(stopped).resolves.toBe(stop);
  });

  it("does not overlap polling ticks or restart an in-flight Issue", async () => {
    const github = githubPort();
    const firstPoll = deferred();
    vi.mocked(github.listCandidateIssues)
      .mockImplementationOnce(async () => {
        await firstPoll.promise;
        return [{ number: 101, state: "OPEN", labels: ["Sandcastle"] }];
      })
      .mockResolvedValue([{ number: 101, state: "OPEN", labels: ["Sandcastle"] }]);
    vi.mocked(github.getIssue).mockResolvedValue({
      number: 101,
      state: "OPEN",
      labels: ["Sandcastle"],
    });
    const workflow = deferred();
    const processIssue = vi.fn().mockReturnValue(workflow.promise);
    const firstWait = deferred();
    const stop = new Error("stop fake clock");
    const sleep = vi
      .fn<(milliseconds: number) => Promise<void>>()
      .mockReturnValueOnce(firstWait.promise)
      .mockRejectedValueOnce(stop);

    const watching = runSandcastleCli(["--watch"], { github, processIssue, sleep });
    const stopped = watching.catch((error: unknown) => error);
    await Promise.resolve();
    expect(sleep).not.toHaveBeenCalled();
    expect(github.listCandidateIssues).toHaveBeenCalledTimes(1);

    firstPoll.resolve();
    await vi.waitFor(() => expect(processIssue).toHaveBeenCalledTimes(1));
    firstWait.resolve();
    await expect(stopped).resolves.toBe(stop);
    expect(github.listCandidateIssues).toHaveBeenCalledTimes(2);
    expect(processIssue).toHaveBeenCalledTimes(1);
    workflow.resolve();
  });

  it("skips failed candidates and loses remote claim races without starting work", async () => {
    const github = githubPort();
    vi.mocked(github.listCandidateIssues).mockResolvedValue([
      { number: 101, state: "OPEN", labels: ["Sandcastle", "sandcastle:failed"] },
      { number: 102, state: "OPEN", labels: ["Sandcastle"] },
    ]);
    vi.mocked(github.getIssue).mockResolvedValue({
      number: 102,
      state: "OPEN",
      labels: ["Sandcastle"],
    });
    vi.mocked(github.claimIssue).mockResolvedValue(null);
    const events: unknown[] = [];
    const stop = new Error("stop fake clock");

    await expect(runSandcastleCli(["--watch"], {
      github,
      processIssue: vi.fn(),
      recordWatchEvent: (event) => events.push(event),
      sleep: vi.fn().mockRejectedValue(stop),
    })).rejects.toBe(stop);

    expect(github.getIssue).toHaveBeenCalledTimes(1);
    expect(github.claimIssue).toHaveBeenCalledWith(102, expect.any(String));
    expect(events).toEqual([]);
  });

  it.each([
    {
      name: "does not exist",
      issue: null,
      message: "Issue #100 does not exist",
    },
    {
      name: "is closed",
      issue: { number: 100, state: "CLOSED", labels: ["Sandcastle"] },
      message: "Issue #100 must be open",
    },
    {
      name: "does not have the Sandcastle label",
      issue: { number: 100, state: "OPEN", labels: ["ready-for-agent"] },
      message: "Issue #100 must have the Sandcastle label",
    },
  ])("stops before Planner when the target $name", async ({ issue, message }) => {
    const github = githubPort();
    vi.mocked(github.getIssue).mockResolvedValue(issue);
    const processIssue = vi.fn();

    await expect(
      runSandcastleCli(["--issue", "100"], { github, processIssue }),
    ).rejects.toMatchObject<SandcastleCliError>({ message, exitCode: 2 });

    expect(github.ensureLabel).toHaveBeenCalledWith("sandcastle:failed");
    expect(github.claimIssue).not.toHaveBeenCalled();
    expect(processIssue).not.toHaveBeenCalled();
  });

  it("skips Planner when the target is already claimed", async () => {
    const github = githubPort();
    vi.mocked(github.getIssue).mockResolvedValue({
      number: 100,
      state: "OPEN",
      labels: ["Sandcastle"],
    });
    vi.mocked(github.claimIssue).mockResolvedValue(null);
    const processIssue = vi.fn();

    await runSandcastleCli(["--issue", "100"], { github, processIssue });

    expect(github.claimIssue).toHaveBeenCalledWith(100, expect.any(String));
    expect(processIssue).not.toHaveBeenCalled();
  });

  it("finalizes a claim failure after the target was eligible", async () => {
    const github = githubPort();
    vi.mocked(github.getIssue).mockResolvedValue({
      number: 100,
      state: "OPEN",
      labels: ["Sandcastle"],
    });
    const failure = new Error("local fetch failed after remote claim");
    vi.mocked(github.claimIssue).mockRejectedValue(failure);
    const handleFailure = vi.fn().mockResolvedValue(undefined);

    await expect(runSandcastleCli(["--issue", "100"], {
      github,
      processIssue: vi.fn(),
      handleFailure,
    })).rejects.toBe(failure);

    expect(handleFailure).toHaveBeenCalledWith(100, "claim", failure);
  });

  it("emits one-shot transitions, heartbeats, and terminal status as JSONL", async () => {
    const github = githubPort();
    vi.mocked(github.getIssue).mockResolvedValue({
      number: 100,
      state: "OPEN",
      labels: ["Sandcastle"],
    });
    const workflow = deferred();
    const lines: string[] = [];
    const intervals: Array<() => void> = [];
    let monotonicMs = 1_000;

    const running = runSandcastleCli(["--issue", "100", "--status-format", "json"], {
      github,
      createRunId: () => "status-run",
      processIssue: async (_issueNumber, execution) => {
        execution.liveStatus?.transition("planner");
        await workflow.promise;
        return "merged";
      },
      liveStatus: {
        sink: (line) => lines.push(line),
        monotonicNow: () => monotonicMs,
        utcNow: () => new Date("2026-08-20T12:00:00.000Z"),
        setInterval: (callback, milliseconds) => {
          expect(milliseconds).toBe(30_000);
          intervals.push(callback);
          return callback;
        },
        clearInterval: vi.fn(),
      },
    });

    await vi.waitFor(() => expect(intervals).toHaveLength(1));
    monotonicMs = 31_000;
    intervals[0]!();
    workflow.resolve();
    await expect(running).resolves.toBe("merged");

    expect(lines.map((line) => JSON.parse(line).sandcastleStatus)).toEqual([
      {
        version: 1,
        kind: "transition",
        runId: "status-run",
        batchId: 0,
        issueNumber: 100,
        timestamp: "2026-08-20T12:00:00.000Z",
        elapsedMs: 0,
        sequence: 1,
        workflowStage: "startup",
        role: null,
        health: "active",
        lastObservedActivity: null,
        activityAgeMs: null,
        stageElapsedMs: 0,
        warning: null,
      },
      expect.objectContaining({
        kind: "transition",
        sequence: 2,
        workflowStage: "planner",
        role: "planner",
        health: "active",
      }),
      expect.objectContaining({
        kind: "heartbeat",
        elapsedMs: 30_000,
        sequence: 3,
        workflowStage: "planner",
        role: "planner",
      }),
      expect.objectContaining({
        kind: "transition",
        sequence: 4,
        workflowStage: "terminal",
        role: null,
        health: "completed",
      }),
    ]);
  });

  it("emits one idle status per empty watch polling tick", async () => {
    const github = githubPort();
    const lines: string[] = [];
    const firstWait = deferred();
    const stop = new Error("stop fake clock");
    let monotonicMs = 500;
    const watching = runSandcastleCli(["--watch", "--status-format", "json"], {
      github,
      processIssue: vi.fn(),
      createRunId: () => "idle-run",
      sleep: vi.fn()
        .mockReturnValueOnce(firstWait.promise)
        .mockRejectedValueOnce(stop),
      liveStatus: {
        sink: (line) => lines.push(line),
        monotonicNow: () => monotonicMs,
        utcNow: () => new Date("2026-08-20T12:00:00.000Z"),
      },
    });
    const stopped = watching.catch((error: unknown) => error);

    await vi.waitFor(() => expect(lines).toHaveLength(1));
    monotonicMs = 300_500;
    firstWait.resolve();
    await expect(stopped).resolves.toBe(stop);

    expect(lines.map((line) => JSON.parse(line).sandcastleStatus)).toEqual([
      expect.objectContaining({
        kind: "idle",
        issueNumber: null,
        elapsedMs: 0,
        sequence: 1,
      }),
      expect.objectContaining({
        kind: "idle",
        issueNumber: null,
        elapsedMs: 300_000,
        sequence: 2,
      }),
    ]);
  });

  it("orders concurrent Issue status globally without mixing their stages", async () => {
    const github = githubPort();
    vi.mocked(github.listCandidateIssues).mockResolvedValueOnce([
      { number: 116, state: "OPEN", labels: ["Sandcastle"] },
      { number: 117, state: "OPEN", labels: ["Sandcastle"] },
    ]);
    vi.mocked(github.getIssue).mockImplementation(async (number) => ({
      number,
      state: "OPEN",
      labels: ["Sandcastle"],
    }));
    const workflows = new Map([[116, deferred()], [117, deferred()]]);
    const lines: string[] = [];
    const intervals: Array<() => void> = [];
    const wait = deferred();
    const stop = new Error("stop fake clock");
    const watching = runSandcastleCli(["--watch", "--status-format", "json"], {
      github,
      createRunId: () => "concurrent-run",
      processIssue: async (number, execution) => {
        execution.liveStatus?.transition(number === 116 ? "implementer" : "reviewer");
        execution.liveStatus?.observeAgentEvent({
          type: "toolCall",
          name: number === 116 ? "Edit" : "Read",
          formattedArgs: "token=secret /home/private $(curl endpoint) 源码",
        });
        await workflows.get(number)!.promise;
      },
      sleep: vi.fn().mockReturnValueOnce(wait.promise).mockRejectedValueOnce(stop),
      liveStatus: {
        sink: (line) => lines.push(line),
        monotonicNow: () => 1_000,
        utcNow: () => new Date("2026-08-20T12:00:00.000Z"),
        setInterval: (callback) => {
          intervals.push(callback);
          return callback;
        },
        clearInterval: vi.fn(),
      },
    });
    const stopped = watching.catch((error: unknown) => error);

    await vi.waitFor(() => expect(lines).toHaveLength(6));
    intervals[0]!();
    workflows.get(116)!.resolve();
    workflows.get(117)!.resolve();
    await vi.waitFor(() => expect(lines).toHaveLength(10));
    wait.resolve();
    await expect(stopped).resolves.toBe(stop);

    const events = lines.map((line) => JSON.parse(line).sandcastleStatus);
    expect(events.map((event) => event.sequence)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    expect(events.at(-1)).toEqual(expect.objectContaining({
      kind: "idle",
      issueNumber: null,
      sequence: 11,
    }));
    expect(events.filter((event) => event.issueNumber === 116).map((event) => event.workflowStage))
      .toEqual(["startup", "implementer", "implementer", "implementer", "terminal"]);
    expect(events.filter((event) => event.issueNumber === 117).map((event) => event.workflowStage))
      .toEqual(["startup", "reviewer", "reviewer", "reviewer", "terminal"]);
    expect(events.filter((event) => event.issueNumber === 116).at(-2).lastObservedActivity)
      .toBe("editing");
    expect(events.filter((event) => event.issueNumber === 117).at(-2).lastObservedActivity)
      .toBe("inspecting-repository");
    expect(JSON.stringify(events)).not.toContain("token=secret");
  });

  it("uses append-only human status on a TTY", async () => {
    const github = githubPort();
    vi.mocked(github.getIssue).mockResolvedValue({
      number: 100,
      state: "OPEN",
      labels: ["Sandcastle"],
    });
    const lines: string[] = [];

    await runSandcastleCli(["--issue", "100"], {
      github,
      createRunId: () => "human-run",
      processIssue: async (_number, execution) => {
        execution.liveStatus?.transition("merge");
      },
      liveStatus: {
        sink: (line) => lines.push(line),
        isTty: () => true,
        monotonicNow: () => 0,
        utcNow: () => new Date("2026-08-20T12:00:00.000Z"),
        setInterval: (callback) => callback,
        clearInterval: vi.fn(),
      },
    });

    expect(lines).toEqual([
      "[sandcastle 1 2026-08-20T12:00:00.000Z +0ms] run=human-run issue=#100 transition stage=startup health=active",
      "[sandcastle 2 2026-08-20T12:00:00.000Z +0ms] run=human-run issue=#100 transition stage=merge health=active",
      "[sandcastle 3 2026-08-20T12:00:00.000Z +0ms] run=human-run issue=#100 transition stage=terminal health=completed",
    ]);
  });

  it("can disable live status without changing the business result", async () => {
    const github = githubPort();
    vi.mocked(github.getIssue).mockResolvedValue({
      number: 100,
      state: "OPEN",
      labels: ["Sandcastle"],
    });
    const sink = vi.fn();
    const setInterval = vi.fn();

    await expect(runSandcastleCli(["--issue", "100", "--no-live-status"], {
      github,
      processIssue: vi.fn().mockResolvedValue("merged"),
      liveStatus: { sink, setInterval },
    })).resolves.toBe("merged");

    expect(sink).not.toHaveBeenCalled();
    expect(setInterval).not.toHaveBeenCalled();
  });

  it("does not inspect the terminal or clock when live status is disabled", async () => {
    const github = githubPort();
    vi.mocked(github.getIssue).mockResolvedValue({
      number: 100,
      state: "OPEN",
      labels: ["Sandcastle"],
    });

    await expect(runSandcastleCli(["--issue", "100", "--no-live-status"], {
      github,
      processIssue: vi.fn().mockResolvedValue("merged"),
      liveStatus: {
        isTty: () => {
          throw new Error("TTY unavailable");
        },
        monotonicNow: () => {
          throw new Error("clock unavailable");
        },
      },
    })).resolves.toBe("merged");
  });

  it("fails open after one status sink failure and warns at most once", async () => {
    const github = githubPort();
    vi.mocked(github.getIssue).mockResolvedValue({
      number: 100,
      state: "OPEN",
      labels: ["Sandcastle"],
    });
    const sink = vi.fn(() => {
      throw new Error("stderr closed");
    });
    const warningSink = vi.fn();
    const processIssue = vi.fn(async (_number, execution) => {
      execution.liveStatus?.transition("planner");
      return "merged";
    });

    await expect(runSandcastleCli(["--issue", "100"], {
      github,
      processIssue,
      liveStatus: { sink, warningSink },
    })).resolves.toBe("merged");

    expect(processIssue).toHaveBeenCalledOnce();
    expect(sink).toHaveBeenCalledOnce();
    expect(warningSink).toHaveBeenCalledOnce();
    expect(warningSink).toHaveBeenCalledWith(
      "Sandcastle live status disabled after output failure",
    );
  });

  it("fails open when heartbeat timer setup fails", async () => {
    const github = githubPort();
    vi.mocked(github.getIssue).mockResolvedValue({
      number: 100,
      state: "OPEN",
      labels: ["Sandcastle"],
    });
    const warningSink = vi.fn();

    await expect(runSandcastleCli(["--issue", "100"], {
      github,
      processIssue: vi.fn().mockResolvedValue("merged"),
      liveStatus: {
        sink: vi.fn(),
        warningSink,
        setInterval: () => {
          throw new Error("timer unavailable");
        },
      },
    })).resolves.toBe("merged");

    expect(warningSink).toHaveBeenCalledOnce();
  });

  it("fails open when status shutdown fails after a sink failure", async () => {
    const github = githubPort();
    vi.mocked(github.getIssue).mockResolvedValue({
      number: 100,
      state: "OPEN",
      labels: ["Sandcastle"],
    });
    let writes = 0;

    await expect(runSandcastleCli(["--issue", "100"], {
      github,
      processIssue: async (_number, execution) => {
        execution.liveStatus?.transition("planner");
        return "merged";
      },
      liveStatus: {
        sink: () => {
          writes += 1;
          if (writes === 2) throw new Error("stderr closed");
        },
        warningSink: vi.fn(),
        setInterval: (callback) => callback,
        clearInterval: () => {
          throw new Error("timer shutdown failed");
        },
      },
    })).resolves.toBe("merged");
  });

  it("fails open when an enabled status clock fails", async () => {
    const github = githubPort();
    vi.mocked(github.getIssue).mockResolvedValue({
      number: 100,
      state: "OPEN",
      labels: ["Sandcastle"],
    });
    const warningSink = vi.fn();

    await expect(runSandcastleCli(["--issue", "100"], {
      github,
      processIssue: vi.fn().mockResolvedValue("merged"),
      liveStatus: {
        monotonicNow: () => {
          throw new Error("clock unavailable");
        },
        warningSink,
      },
    })).resolves.toBe("merged");

    expect(warningSink).toHaveBeenCalledOnce();
  });

  it("clears the heartbeat when watch polling exits unexpectedly", async () => {
    const github = githubPort();
    vi.mocked(github.listCandidateIssues).mockResolvedValueOnce([
      { number: 100, state: "OPEN", labels: ["Sandcastle"] },
    ]);
    vi.mocked(github.getIssue).mockResolvedValue({
      number: 100,
      state: "OPEN",
      labels: ["Sandcastle"],
    });
    const workflow = deferred();
    const interval = Symbol("heartbeat");
    const clearInterval = vi.fn();
    const stop = new Error("polling stopped");

    await expect(runSandcastleCli(["--watch"], {
      github,
      processIssue: vi.fn().mockReturnValue(workflow.promise),
      sleep: vi.fn().mockRejectedValue(stop),
      liveStatus: {
        sink: vi.fn(),
        setInterval: () => interval,
        clearInterval,
      },
    })).rejects.toBe(stop);

    expect(clearInterval).toHaveBeenCalledWith(interval);
    workflow.resolve();
  });

  it("rejects an unsupported explicit status format", async () => {
    const github = githubPort();

    await expect(runSandcastleCli(["--issue", "100", "--status-format", "xml"], {
      github,
      processIssue: vi.fn(),
    })).rejects.toMatchObject<SandcastleCliError>({
      message: "--status-format requires human or json",
      exitCode: 2,
    });

    expect(github.ensureLabel).not.toHaveBeenCalled();
  });

  it("rejects a claim receipt that is not bound to the requested Issue and run", async () => {
    const github = githubPort();
    vi.mocked(github.getIssue).mockResolvedValue({
      number: 100,
      state: "OPEN",
      labels: ["Sandcastle"],
    });
    vi.mocked(github.claimIssue).mockResolvedValue({
      issueNumber: 101,
      runId: "other-run",
      branch: "sandcastle/issue-101",
      baseSha: "a".repeat(40),
    });
    const processIssue = vi.fn();

    await expect(runSandcastleCli(["--issue", "100"], {
      github,
      createRunId: () => "current-run",
      processIssue,
    })).rejects.toThrow("claim receipt identity");
    expect(processIssue).not.toHaveBeenCalled();
  });

  it("claims an eligible target before starting Planner", async () => {
    const github = githubPort();
    vi.mocked(github.getIssue).mockResolvedValue({
      number: 100,
      state: "OPEN",
      labels: ["documentation", "Sandcastle"],
    });
    const plan = {
      status: "ready" as const,
      implementationSummary: "Implement the target Issue.",
      blockingReason: null,
      allowsAutomationChanges: false,
      issue: {
        number: 100,
        title: "Target",
        body: "Do the work.",
        labels: ["Sandcastle"],
        comments: [],
      },
    };
    const processIssue = vi.fn().mockResolvedValue(plan);

    await expect(
      runSandcastleCli(["--issue", "100"], { github, processIssue }),
    ).resolves.toEqual(plan);

    expect(github.claimIssue).toHaveBeenCalledWith(100, expect.any(String));
    expect(processIssue).toHaveBeenCalledWith(
      100,
      expect.objectContaining({ batchId: 0, issueNumber: 100 }),
    );
  });
});
