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
    claimIssue: vi.fn().mockResolvedValue(true),
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

  it.each(["1", "100", "9007199254740991"])(
    "accepts canonical positive decimal Issue number %s",
    async (value) => {
      const github = githubPort();
      const issueNumber = Number(value);
      vi.mocked(github.getIssue).mockResolvedValue({
        number: issueNumber,
        state: "OPEN",
        labels: ["Sandcastle"],
      });
      const processIssue = vi.fn();

      await runSandcastleCli(["--issue", value], { github, processIssue });

      expect(github.claimIssue).toHaveBeenCalledWith(issueNumber);
      expect(processIssue).toHaveBeenCalledWith(
        issueNumber,
        expect.objectContaining({ issueNumber }),
      );
    },
  );

  it.each([
    "0",
    "-1",
    "+1",
    "01",
    "1.5",
    "1e2",
    "0x64",
    " 100",
    "100 ",
    "9007199254740992",
    "not-a-number",
  ])(
    "rejects non-canonical Issue number %s before startup",
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
      { issueNumber: 116, execution: { runId, batchId: 1, issueNumber: 116 } },
      { issueNumber: 117, execution: { runId, batchId: 1, issueNumber: 117 } },
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
    vi.mocked(github.claimIssue).mockResolvedValue(false);
    const events: unknown[] = [];
    const stop = new Error("stop fake clock");

    await expect(runSandcastleCli(["--watch"], {
      github,
      processIssue: vi.fn(),
      recordWatchEvent: (event) => events.push(event),
      sleep: vi.fn().mockRejectedValue(stop),
    })).rejects.toBe(stop);

    expect(github.getIssue).toHaveBeenCalledTimes(1);
    expect(github.claimIssue).toHaveBeenCalledWith(102);
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
    vi.mocked(github.claimIssue).mockResolvedValue(false);
    const processIssue = vi.fn();

    await runSandcastleCli(["--issue", "100"], { github, processIssue });

    expect(github.claimIssue).toHaveBeenCalledWith(100);
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

    expect(github.claimIssue).toHaveBeenCalledWith(100);
    expect(processIssue).toHaveBeenCalledWith(
      100,
      expect.objectContaining({ batchId: 0, issueNumber: 100 }),
    );
  });
});
