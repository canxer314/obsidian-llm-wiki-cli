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

function failingAcquisition(failure: "acquired-read" | "remove-trigger" | "settled-read") {
  const labels = ["agent:review"];
  let reads = 0;
  const remove = (label: string) => {
    const index = labels.indexOf(label);
    if (index !== -1) labels.splice(index, 1);
  };
  return {
    labels,
    ports: {
      read: vi.fn(async () => {
        reads += 1;
        if (
          (failure === "acquired-read" && reads === 2) ||
          (failure === "settled-read" && reads === 3)
        ) {
          throw new Error(`${failure} failed`);
        }
        return { state: "OPEN", labels: [...labels], revision, pullRequest };
      }),
      addInProgress: vi.fn(async () => { labels.push("agent:in-progress"); }),
      removeTrigger: vi.fn(async () => {
        if (failure === "remove-trigger") throw new Error("remove-trigger failed");
        remove("agent:review");
      }),
      addBlocked: vi.fn(async () => { labels.push("agent:blocked"); }),
      addBlockedDiagnostic: vi.fn(async () => {}),
      removeInProgress: vi.fn(async () => { remove("agent:in-progress"); }),
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
  it("does not expose scheduled architecture review to label-triggered acquisition", async () => {
    const target = { run: vi.fn() };
    const acquisition = acquisitionFor([{ state: "OPEN", labels: [], revision }]);
    const runner = createTargetOperationCommandRunner({
      target,
      acquisition: acquisition.ports,
      createJobId: () => "scheduled-job",
    });

    await expect((runner.run as (operation: string, number: number) => Promise<unknown>)("architecture-review", 1)).rejects.toThrow(
      "Automation Command route is unknown",
    );
    expect(target.run).not.toHaveBeenCalled();
    expect(acquisition.ports.read).not.toHaveBeenCalled();
  });

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

  it.each([
    ["missing Pull Request metadata", { ...available, pullRequest: undefined }],
    ["a mismatched Pull Request head SHA", {
      ...available,
      pullRequest: { ...pullRequest, headSha: "b".repeat(40) },
    }],
  ])("rejects initial acquisition with %s before mutating labels", async (_caseName, initial) => {
    const target = { run: vi.fn() };
    const acquisition = acquisitionFor([initial]);
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

  it.each([
    ["missing Pull Request metadata", undefined],
    ["a mismatched Pull Request head SHA", { ...pullRequest, headSha: "b".repeat(40) }],
    ["a forked Pull Request", { ...pullRequest, headRepository: "fork/repository" }],
  ])("rejects acquired acquisition with %s and settles Blocked Automation", async (_caseName, pullRequest) => {
    const target = { run: vi.fn() };
    const acquisition = acquisitionFor([
      available,
      { ...acquiring, pullRequest },
    ]);
    const runner = createTargetOperationCommandRunner({
      target,
      acquisition: acquisition.ports,
      createJobId: () => "job-219",
    });

    await expect(runner.run("review", 219)).rejects.toThrow(
      "Pull Request #219 is not an authorized same-repository revision",
    );
    expect(target.run).not.toHaveBeenCalled();
    expect(acquisition.events).toEqual([
      "add-in-progress",
      "add-blocked",
      "add-blocked-diagnostic",
    ]);
  });

  it.each([
    ["revision", { ...acquired, revision: "b".repeat(40), pullRequest }],
    ["head SHA", { ...acquired, pullRequest: { ...pullRequest, headSha: "b".repeat(40) } }],
    ["head ref", { ...acquired, pullRequest: { ...pullRequest, headRefName: "other-head" } }],
    ["base ref", { ...acquired, pullRequest: { ...pullRequest, baseRefName: "other-base" } }],
    ["base repository", { ...acquired, pullRequest: { ...pullRequest, baseRepository: "other/base" } }],
    ["head repository", { ...acquired, pullRequest: { ...pullRequest, headRepository: "other/head" } }],
  ])("rejects settled acquisition drift in %s before Target execution", async (_field, settled) => {
    const target = { run: vi.fn() };
    const acquisition = acquisitionFor([available, acquiring, settled]);
    const runner = createTargetOperationCommandRunner({
      target,
      acquisition: acquisition.ports,
      createJobId: () => "job-219",
    });

    await expect(runner.run("review", 219)).rejects.toThrow(
      "Work Item #219 changed while acquisition was settling",
    );
    expect(target.run).not.toHaveBeenCalled();
    expect(acquisition.events).toEqual([
      "add-in-progress",
      "remove-trigger",
      "add-blocked",
      "add-blocked-diagnostic",
    ]);
  });

  it("does not settle when in-progress ownership was not established", async () => {
    const target = { run: vi.fn() };
    const acquisition = failingAcquisition("acquired-read");
    acquisition.ports.addInProgress.mockRejectedValueOnce(
      new Error("add-in-progress failed"),
    );
    const runner = createTargetOperationCommandRunner({
      target,
      acquisition: acquisition.ports,
      createJobId: () => "job-219-acquisition",
    });

    await expect(runner.run("review", 219)).rejects.toThrow(
      "add-in-progress failed",
    );

    expect(target.run).not.toHaveBeenCalled();
    expect(acquisition.labels).toEqual(["agent:review"]);
    expect(acquisition.ports.addBlocked).not.toHaveBeenCalled();
    expect(acquisition.ports.addBlockedDiagnostic).not.toHaveBeenCalled();
    expect(acquisition.ports.removeInProgress).not.toHaveBeenCalled();
  });

  it("settles visible ownership when acquired-state validation fails", async () => {
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
    expect(acquisition.events).toEqual([
      "add-in-progress",
      "add-blocked",
      "add-blocked-diagnostic",
    ]);
  });

  it("settles visible ownership when the acquired-state read fails", async () => {
    const target = { run: vi.fn() };
    const acquisition = failingAcquisition("acquired-read");
    const runner = createTargetOperationCommandRunner({
      target,
      acquisition: acquisition.ports,
      createJobId: () => "job-219-acquisition",
    });

    await expect(runner.run("review", 219)).rejects.toThrow("acquired-read failed");

    expect(target.run).not.toHaveBeenCalled();
    expect(acquisition.labels).toEqual([
      "agent:review",
      "agent:in-progress",
      "agent:blocked",
    ]);
    expect(acquisition.ports.addBlockedDiagnostic).toHaveBeenCalledWith(
      "review",
      219,
      {
        jobId: "job-219-acquisition",
        summary: "acquired-read failed",
      },
    );
  });

  it("blocks uncertain ownership when trigger removal fails", async () => {
    const target = { run: vi.fn() };
    const acquisition = failingAcquisition("remove-trigger");
    const runner = createTargetOperationCommandRunner({
      target,
      acquisition: acquisition.ports,
      createJobId: () => "job-219-acquisition",
    });

    await expect(runner.run("review", 219)).rejects.toThrow("remove-trigger failed");

    expect(target.run).not.toHaveBeenCalled();
    expect(acquisition.labels).toEqual([
      "agent:review",
      "agent:in-progress",
      "agent:blocked",
    ]);
    expect(acquisition.ports.addBlockedDiagnostic).toHaveBeenCalledWith(
      "review",
      219,
      {
        jobId: "job-219-acquisition",
        summary: "remove-trigger failed",
      },
    );
  });

  it("blocks uncertain ownership when the settled-state read fails", async () => {
    const target = { run: vi.fn() };
    const acquisition = failingAcquisition("settled-read");
    const runner = createTargetOperationCommandRunner({
      target,
      acquisition: acquisition.ports,
      createJobId: () => "job-219-acquisition",
    });

    await expect(runner.run("review", 219)).rejects.toThrow("settled-read failed");

    expect(target.run).not.toHaveBeenCalled();
    expect(acquisition.labels).toEqual([
      "agent:in-progress",
      "agent:blocked",
    ]);
    expect(acquisition.ports.addBlockedDiagnostic).toHaveBeenCalledWith(
      "review",
      219,
      {
        jobId: "job-219-acquisition",
        summary: "settled-read failed",
      },
    );
  });

  it("does not block or diagnose an accepted refusal", async () => {
    const acquisition = acquisitionFor([available, acquiring, acquired]);
    const target = { run: vi.fn(async () => ({ status: "refused", reason: "already handled" })) };
    const runner = createTargetOperationCommandRunner({
      target,
      acquisition: acquisition.ports,
      createJobId: () => "job-219",
    });

    await expect(runner.run("review", 219)).resolves.toEqual({
      status: "refused",
      reason: "already handled",
    });
    expect(acquisition.events).toEqual([
      "add-in-progress",
      "remove-trigger",
      "remove-in-progress",
    ]);
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

  it("rejects an operation-mismatched result with bounded exception settlement", async () => {
    const acquisition = acquisitionFor([available, acquiring, acquired]);
    const target = { run: vi.fn(async () => ({ status: "implemented", secret: "untrusted payload" })) };
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
    expect(acquisition.ports.addBlockedDiagnostic).toHaveBeenCalledWith("review", 219, {
      jobId: "job-219",
      summary: "Target operation returned an invalid outcome",
    });
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
