import { describe, expect, it, vi } from "vitest";

import { inspectAutomationCommands } from "../.sandcastle/automation-inspector.js";
import { dispatchAutomationCommands } from "../.sandcastle/automation-dispatch.js";

const sha = "a".repeat(40);

function command(overrides: Partial<{
  number: number;
  operation: "review";
  identity: string;
  labels: readonly string[];
}> = {}) {
  const operation = overrides.operation ?? "review";
  return {
    number: overrides.number ?? 10,
    operation,
    identity: overrides.identity ?? `pull-request:${overrides.number ?? 10}`,
    labels: overrides.labels ?? [`agent:${operation}`],
  } as const;
}

describe("Automation Command dispatch", () => {
  it("selects one bounded deterministic compatible frontier and waits for it", async () => {
    const first = command({ number: 20, identity: "pull-request:20" });
    const second = command({ number: 10, operation: "review", identity: "pull-request:10" });
    const conflicting = command({ number: 11, operation: "review", identity: "pull-request:10" });
    const executed: number[] = [];
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    const run = vi.fn(async (selected: typeof first) => {
      executed.push(selected.number);
      await waiting;
    });

    const round = dispatchAutomationCommands({ concurrency: 2 }, {
      scheduler: { acquire: async () => ({ release: async () => {} }), prepare: async () => {}, track: async (_identity, action) => action() },
      github: { verifyLabels: async () => {}, listCommands: async () => [first, second, conflicting] },
      run,
    });

    await vi.waitFor(() => expect(executed).toEqual([10, 20]));
    release();
    await expect(round).resolves.toEqual({ status: "dispatched", selected: [second, first] });
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("does no discovery while the host scheduler lock is unavailable", async () => {
    const listCommands = vi.fn();
    await expect(dispatchAutomationCommands({}, {
      scheduler: { acquire: async () => undefined, prepare: async () => {}, track: async (_identity, action) => action() },
      github: { verifyLabels: async () => {}, listCommands },
      run: vi.fn(),
    })).resolves.toEqual({ status: "locked" });
    expect(listCommands).not.toHaveBeenCalled();
  });

  it("fails closed before execution when labels are inconsistent or blocked", async () => {
    const inconsistent = command({ labels: ["agent:review", "agent:in-progress"] });
    const blocked = command({ number: 11, labels: ["agent:review", "agent:blocked"] });
    const run = vi.fn();
    await dispatchAutomationCommands({}, {
      scheduler: { acquire: async () => ({ release: async () => {} }), prepare: async () => {}, track: async (_identity, action) => action() },
      github: { verifyLabels: async () => {}, listCommands: async () => [inconsistent, blocked] },
      run,
    });
    expect(run).not.toHaveBeenCalled();
  });
});

describe("Automation Command inspection", () => {
  it("reports eligibility, blocked and stale/inconsistent state without mutations", async () => {
    const addLabel = vi.fn();
    const result = await inspectAutomationCommands({
      github: {
        listCommands: async () => [
          command(),
          command({ number: 11, labels: ["agent:review", "agent:blocked"] }),
          command({ number: 12, labels: ["agent:in-progress"] }),
          command({ number: 13, labels: ["agent:review", "agent:in-progress"] }),
        ],
      },
      scheduler: { activeJobs: async () => [{ identity: "pull-request:10", jobId: "local-1" }] },
    });

    expect(result.commands).toEqual([
      expect.objectContaining({ number: 10, eligibility: "eligible" }),
      expect.objectContaining({ number: 11, eligibility: "blocked", retry: "remove agent:blocked, restore agent:review, then retry" }),
      expect.objectContaining({ number: 12, eligibility: "stale-in-progress", retry: "inspect the Automation Work Item and resolve labels manually; do not adopt or clear state automatically" }),
      expect.objectContaining({ number: 13, eligibility: "inconsistent", retry: "inspect the Automation Work Item and resolve labels manually; do not adopt or clear state automatically" }),
    ]);
    expect(result.activeJobs).toEqual([{ identity: "pull-request:10", jobId: "local-1" }]);
    expect(addLabel).not.toHaveBeenCalled();
  });
});
