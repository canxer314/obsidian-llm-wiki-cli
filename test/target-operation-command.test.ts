import { describe, expect, it, vi } from "vitest";

import { createTargetOperationCommandRunner } from "../.sandcastle/target-operation-command.js";

const revision = "a".repeat(40);

function acquisitionFor(states: Array<{
  state: string;
  labels: string[];
  revision: string;
  pullRequest?: typeof pullRequest;
}>) {
  const events: string[] = [];
  let next = 0;
  return {
    events,
    ports: {
      read: vi.fn(async () => states[next++] ?? states.at(-1)!),
      addInProgress: vi.fn(async () => { events.push("add-in-progress"); }),
      removeTrigger: vi.fn(async () => { events.push("remove-trigger"); }),
      addBlocked: vi.fn(async () => { events.push("add-blocked"); }),
      addBlockedDiagnostic: vi.fn(async () => { events.push("add-blocked-diagnostic"); }),
      removeInProgress: vi.fn(async () => { events.push("remove-in-progress"); }),
    },
  };
}

const pullRequest = {
  headSha: revision,
  headRefName: "feature-branch",
  baseRefName: "master",
  baseRepository: "owner/repository",
  headRepository: "owner/repository",
};
const available = { state: "OPEN", labels: ["agent:review"], revision, pullRequest };
const acquiring = { state: "OPEN", labels: ["agent:review", "agent:in-progress"], revision, pullRequest };
const acquired = { state: "OPEN", labels: ["agent:in-progress"], revision, pullRequest };

describe("trusted Target operation command acquisition", () => {
  it("assigns unique job identities to concurrent commands in the same operation family", async () => {
    const reads = new Map<number, number>();
    const issueStates = [
      { state: "OPEN", labels: ["agent:implement"], revision },
      { state: "OPEN", labels: ["agent:implement", "agent:in-progress"], revision },
      { state: "OPEN", labels: ["agent:in-progress"], revision },
    ];
    const invocations: Array<{ readonly number: number; readonly jobId: string }> = [];
    let releaseTargets!: () => void;
    const bothTargetsStarted = new Promise<void>((resolve) => { releaseTargets = resolve; });
    const target = {
      run: vi.fn(async (invocation: { readonly number: number; readonly jobId: string }) => {
        invocations.push(invocation);
        if (invocations.length === 2) releaseTargets();
        await bothTargetsStarted;
        return { status: "implemented" };
      }),
    };
    const acquisition = {
      read: vi.fn(async (_operation: string, number: number) => {
        const next = reads.get(number) ?? 0;
        reads.set(number, next + 1);
        return issueStates[next] ?? issueStates.at(-1)!;
      }),
      addInProgress: vi.fn(async () => {}),
      removeTrigger: vi.fn(async () => {}),
      addBlocked: vi.fn(async () => {}),
      addBlockedDiagnostic: vi.fn(async () => {}),
      removeInProgress: vi.fn(async () => {}),
    };
    const jobIds = ["job-221", "job-222"];
    const runner = createTargetOperationCommandRunner({
      target,
      acquisition,
      createJobId: () => jobIds.shift()!,
    });

    await expect(Promise.all([
      runner.run("implement-issue", 221),
      runner.run("implement-issue", 222),
    ])).resolves.toEqual([
      { status: "implemented" },
      { status: "implemented" },
    ]);

    expect(new Set(invocations.map(({ jobId }) => jobId))).toEqual(new Set(["job-221", "job-222"]));
    expect(new Set(invocations.map(({ number }) => number))).toEqual(new Set([221, 222]));
  });

  it("acquires a visible feedback command before explicit reconciliation", async () => {
    const acquisition = acquisitionFor([
      { ...available, labels: ["agent:implement"] },
      { ...acquiring, labels: ["agent:implement", "agent:in-progress"] },
      acquired,
    ]);
    const target = {
      run: vi.fn(async () => ({ status: "implemented", revision, reconciled: true })),
    };
    const runner = createTargetOperationCommandRunner({
      target,
      acquisition: acquisition.ports,
      createJobId: () => "job-219",
    });
    const reconcile = {
      invocation: "reconcile" as const,
      expectedPost: revision,
    };

    await expect(runner.run("implement-feedback", 219, reconcile)).resolves.toMatchObject({
      status: "implemented",
      reconciled: true,
    });
    expect(target.run).toHaveBeenCalledWith({
      operation: "implement-feedback",
      number: 219,
      revision,
      jobId: "job-219",
      acquired: true,
      pullRequest,
      reconcile,
    });
    expect(acquisition.events).toEqual([
      "add-in-progress",
      "remove-trigger",
      "remove-in-progress",
    ]);
  });

  it("refuses explicit feedback reconciliation without a visible command", async () => {
    const acquisition = acquisitionFor([{
      ...available,
      labels: ["agent:blocked"],
    }]);
    const target = { run: vi.fn() };
    const runner = createTargetOperationCommandRunner({
      target,
      acquisition: acquisition.ports,
      createJobId: () => "job-219",
    });

    await expect(runner.run("implement-feedback", 219, {
      invocation: "reconcile",
      expectedPost: revision,
    })).rejects.toThrow("Work Item #219 is not available for acquisition");
    expect(target.run).not.toHaveBeenCalled();
    expect(acquisition.events).toEqual([]);
  });

  it("rejects fork authorization before mutating acquisition labels", async () => {
    const target = { run: vi.fn() };
    const acquisition = acquisitionFor([{
      ...available,
      pullRequest: { ...pullRequest, headRepository: "fork/repository" },
    }]);
    const runner = createTargetOperationCommandRunner({
      target,
      acquisition: acquisition.ports,
      createJobId: () => "job-219",
    });

    await expect(runner.run("review", 219)).rejects.toThrow(
      "Pull Request #219 is not an authorized same-repository revision",
    );
    expect(target.run).not.toHaveBeenCalled();
    expect(acquisition.events).toEqual([]);
  });

  it("does not execute target code after partial acquisition", async () => {
    const target = { run: vi.fn() };
    const acquisition = acquisitionFor([
      available,
      { ...acquiring, labels: ["agent:review", "agent:in-progress", "agent:blocked"] },
    ]);
    const runner = createTargetOperationCommandRunner({
      target,
      acquisition: acquisition.ports,
      createJobId: () => "job-219",
    });

    await expect(runner.run("review", 219)).rejects.toThrow(
      "Work Item #219 changed while acquisition was starting",
    );
    expect(target.run).not.toHaveBeenCalled();
    expect(acquisition.events).toEqual(["add-in-progress"]);
  });

  it("owns blocked and finally labels for a typed target failure", async () => {
    const acquisition = acquisitionFor([available, acquiring, acquired]);
    const target = {
      run: vi.fn(async () => ({ status: "blocked", reason: "review-execution", jobId: "job-219" })),
    };
    const runner = createTargetOperationCommandRunner({
      target,
      acquisition: acquisition.ports,
      createJobId: () => "job-219",
    });

    await expect(runner.run("review", 219)).resolves.toMatchObject({ status: "blocked" });
    expect(acquisition.events).toEqual([
      "add-in-progress",
      "remove-trigger",
      "add-blocked",
      "remove-in-progress",
    ]);
  });

  it("blocks a malformed target outcome before cleanup", async () => {
    const acquisition = acquisitionFor([available, acquiring, acquired]);
    const target = { run: vi.fn(async () => ({ unexpected: true })) };
    const runner = createTargetOperationCommandRunner({
      target,
      acquisition: acquisition.ports,
      createJobId: () => "job-219",
    });

    await expect(runner.run("review", 219)).rejects.toThrow(
      "Target operation returned an invalid outcome",
    );
    expect(acquisition.events).toEqual([
      "add-in-progress",
      "remove-trigger",
      "add-blocked",
      "add-blocked-diagnostic",
      "remove-in-progress",
    ]);
  });

  it("settles a whole-job timeout as Blocked Automation with finally cleanup", async () => {
    const acquisition = acquisitionFor([available, acquiring, acquired]);
    const target = {
      run: vi.fn(async () => {
        throw new Error("Target operation review timed out");
      }),
    };
    const runner = createTargetOperationCommandRunner({
      target,
      acquisition: acquisition.ports,
      createJobId: () => "job-219-timeout",
    });

    await expect(runner.run("review", 219)).rejects.toThrow(
      "Target operation review timed out",
    );
    expect(acquisition.events).toEqual([
      "add-in-progress",
      "remove-trigger",
      "add-blocked",
      "add-blocked-diagnostic",
      "remove-in-progress",
    ]);
    expect(acquisition.ports.addBlockedDiagnostic).toHaveBeenCalledWith(
      "review",
      219,
      {
        jobId: "job-219-timeout",
        summary: "Target operation review timed out",
      },
    );
  });

  it("publishes only a short redacted diagnostic and keeps the transcript local", async () => {
    const acquisition = acquisitionFor([available, acquiring, acquired]);
    const token = `ghp_${"a".repeat(36)}`;
    const transcript = "FULL_AGENT_TRANSCRIPT_MUST_STAY_LOCAL";
    const target = {
      run: vi.fn(async () => {
        throw new Error(
          `Target job worker exited with 1: authorization: Bearer ${token}; setup failed\n` +
          `${transcript}\nlocal log: /trusted/jobs/logs/job-219/stderr.log`,
        );
      }),
    };
    const runner = createTargetOperationCommandRunner({
      target,
      acquisition: acquisition.ports,
      createJobId: () => "job-219",
    });

    await expect(runner.run("review", 219)).rejects.toThrow(transcript);

    const diagnostic = vi.mocked(acquisition.ports.addBlockedDiagnostic).mock.calls[0]?.[2];
    expect(diagnostic).toEqual({
      jobId: "job-219",
      summary: "Target job worker exited with 1: authorization: [REDACTED]; setup failed",
    });
    expect(JSON.stringify(diagnostic)).not.toContain(transcript);
    expect(JSON.stringify(diagnostic)).not.toContain(token);
    expect(JSON.stringify(diagnostic)).not.toContain("/trusted/jobs/logs");
  });

  it("owns blocked and finally labels when the target process fails", async () => {
    const acquisition = acquisitionFor([available, acquiring, acquired]);
    const target = { run: vi.fn(async () => { throw new Error("worker crashed"); }) };
    const runner = createTargetOperationCommandRunner({
      target,
      acquisition: acquisition.ports,
      createJobId: () => "job-219",
    });

    await expect(runner.run("review", 219)).rejects.toThrow("worker crashed");
    expect(acquisition.events).toEqual([
      "add-in-progress",
      "remove-trigger",
      "add-blocked",
      "add-blocked-diagnostic",
      "remove-in-progress",
    ]);
  });
});
