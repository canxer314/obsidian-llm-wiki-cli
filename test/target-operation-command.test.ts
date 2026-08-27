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
  it("runs explicit feedback reconciliation without reacquiring a consumed trigger", async () => {
    const acquisition = acquisitionFor([{
      ...available,
      labels: ["agent:blocked"],
    }]);
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
      pullRequest,
      reconcile,
    });
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
