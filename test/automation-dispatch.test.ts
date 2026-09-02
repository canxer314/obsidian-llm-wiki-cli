import { describe, expect, it, vi } from "vitest";

import { inspectAutomationCommands } from "../.sandcastle/automation-inspector.js";
import { dispatchAutomationCommands } from "../.sandcastle/automation-dispatch.js";
import { GithubAgentReadinessError } from "../.sandcastle/github-readiness.js";
import { commandEligibility, commandPriority, compareCommands, type AutomationOperation } from "../.sandcastle/automation-command.js";

const sha = "a".repeat(40);

// Trigger labels as specified by #219: Pull Request operations use their own
// label; Issue and Spec implementation share agent:implement; Spec split uses
// agent:to-tickets.
const triggerLabels: Readonly<Record<AutomationOperation, string>> = {
  "update-branch": "agent:update-branch",
  implement: "agent:implement",
  review: "agent:review",
  "implement-issue": "agent:implement",
  "implement-spec": "agent:implement",
  "split-spec": "agent:to-tickets",
};

function command(overrides: Partial<{
  number: number;
  operation: AutomationOperation;
  identity: string;
  labels: readonly string[];
}> = {}) {
  const operation = overrides.operation ?? "review";
  return {
    number: overrides.number ?? 10,
    operation,
    identity: overrides.identity ?? `pull-request:${overrides.number ?? 10}`,
    labels: overrides.labels ?? [triggerLabels[operation]],
  } as const;
}

const promotion = { scan: async () => ({ status: "scanned" as const, promoted: [], refused: [] }) };
const readiness = { verifyGithubAgentAuthentication: async () => {} };

describe("Automation Command dispatch", () => {
  it("selects one bounded deterministic compatible frontier and waits for it", async () => {
    const first = command({ number: 20, identity: "pull-request:20" });
    const second = command({ number: 10, operation: "review", identity: "pull-request:10" });
    const conflicting = command({ number: 10, operation: "review", identity: "pull-request:10" });
    const executed: number[] = [];
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    const run = vi.fn(async (selected: typeof first) => {
      executed.push(selected.number);
      await waiting;
    });

    const round = dispatchAutomationCommands({ concurrency: 2 }, {
      scheduler: { acquire: async () => ({ release: async () => {} }), prepare: async () => {}, track: async (_identity, action) => action() },
      promotion,
      readiness,
      github: { verifyLabels: async () => {}, listCommands: async () => [first, second, conflicting] },
      run,
    });

    await vi.waitFor(() => expect(executed).toEqual([10, 20]));
    release();
    await expect(round).resolves.toEqual({ status: "dispatched", selected: [second, first] });
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("fails malformed known identity before scheduler tracking or command execution", async () => {
    const track = vi.fn(async (_identity: string, action: () => Promise<void>) => action());
    const run = vi.fn(async () => {});

    await expect(dispatchAutomationCommands({}, {
      scheduler: { acquire: async () => ({ release: async () => {} }), prepare: async () => {}, track },
      promotion,
      readiness,
      github: {
        verifyLabels: async () => {},
        listCommands: async () => [command({ number: 220, operation: "review", identity: "issue:220" })],
      },
      run,
    })).rejects.toThrow("Automation Command identity is not canonical");

    expect(track).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });
  it("bounds execution concurrency without truncating the selected frontier", async () => {
    const commands = [
      command({ number: 1, identity: "pull-request:1" }),
      command({ number: 2, identity: "pull-request:2" }),
      command({ number: 3, identity: "pull-request:3" }),
    ];
    let active = 0;
    let maxActive = 0;
    const run = vi.fn(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active -= 1;
    });

    const result = await dispatchAutomationCommands({ concurrency: 2 }, {
      scheduler: { acquire: async () => ({ release: async () => {} }), prepare: async () => {}, track: async (_identity, action) => action() },
      promotion,
      readiness,
      github: { verifyLabels: async () => {}, listCommands: async () => commands },
      run,
    });

    expect(run).toHaveBeenCalledTimes(3);
    expect(maxActive).toBe(2);
    expect(result).toEqual({ status: "dispatched", selected: commands });
  });

  it("pins Pull Request update, feedback, and review to their accepted priorities and breaks ties by ascending number", () => {
    expect(commandPriority(command({ operation: "update-branch" }))).toBe(1);
    expect(commandPriority(command({ operation: "implement" }))).toBe(2);
    expect(commandPriority(command({ number: 9 }))).toBe(3);
    expect(compareCommands(command({ operation: "update-branch", number: 9 }), command({ number: 4 }))).toBeLessThan(0);
    expect(compareCommands(command({ operation: "implement", number: 9 }), command({ number: 4 }))).toBeLessThan(0);
    expect(compareCommands(command({ number: 9 }), command({ number: 4 }))).toBeGreaterThan(0);
    expect(compareCommands(command({ number: 4 }), command({ number: 9 }))).toBeLessThan(0);
  });

  it("pins Issue and Spec implementation ahead of Spec split and breaks ties by ascending number", () => {
    expect(commandPriority(command({ operation: "implement-issue" }))).toBe(4);
    expect(commandPriority(command({ operation: "implement-spec" }))).toBe(4);
    expect(commandPriority(command({ operation: "split-spec" }))).toBe(5);
    // Every Pull Request family stays ahead of Issue and Spec implementation.
    expect(compareCommands(command({ operation: "update-branch", number: 9 }), command({ operation: "implement-issue", number: 4 }))).toBeLessThan(0);
    expect(compareCommands(command({ number: 9 }), command({ operation: "implement-spec", number: 4 }))).toBeLessThan(0);
    // Spec/Issue implementation runs before Spec split regardless of number.
    expect(compareCommands(command({ operation: "implement-issue", number: 9 }), command({ operation: "split-spec", number: 4 }))).toBeLessThan(0);
    expect(compareCommands(command({ operation: "split-spec", number: 4 }), command({ operation: "implement-issue", number: 9 }))).toBeGreaterThan(0);
    // The shared implementation priority breaks ties by ascending number.
    expect(compareCommands(command({ operation: "implement-spec", number: 3 }), command({ operation: "implement-issue", number: 7 }))).toBeLessThan(0);
    expect(compareCommands(command({ operation: "implement-issue", number: 7 }), command({ operation: "implement-spec", number: 3 }))).toBeGreaterThan(0);
  });

  it("applies the shared Issue and Spec trigger labels to command eligibility", () => {
    expect(commandEligibility(command({ operation: "implement-issue" }))).toBe("eligible");
    expect(commandEligibility(command({ operation: "implement-spec" }))).toBe("eligible");
    expect(commandEligibility(command({ operation: "split-spec" }))).toBe("eligible");
    expect(commandEligibility(command({ operation: "implement-spec", labels: ["agent:implement", "agent:in-progress"] }))).toBe("inconsistent");
    expect(commandEligibility(command({ operation: "implement-issue", labels: ["agent:implement", "agent:blocked"] }))).toBe("blocked");
    expect(commandEligibility(command({ operation: "split-spec", labels: ["agent:in-progress"] }))).toBe("stale-in-progress");
    expect(commandEligibility(command({ operation: "implement-spec", labels: [] }))).toBe("ineligible");
  });

  it("serializes Spec implementation and Spec split on their shared per-Spec identity", async () => {
    const implementSpec = command({ number: 30, operation: "implement-spec", identity: "spec:30", labels: ["agent:implement"] });
    const splitSpec = command({ number: 30, operation: "split-spec", identity: "spec:30", labels: ["agent:to-tickets"] });
    const run = vi.fn(async () => {});
    const result = await dispatchAutomationCommands({}, {
      scheduler: { acquire: async () => ({ release: async () => {} }), prepare: async () => {}, track: async (_identity, action) => action() },
      promotion,
      readiness,
      github: { verifyLabels: async () => {}, listCommands: async () => [splitSpec, implementSpec] },
      run,
    });
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith(implementSpec);
    expect(result).toEqual({ status: "dispatched", selected: [implementSpec] });
  });

  it("runs Issue implementation and Spec implementation with independent identities concurrently", async () => {
    const implementIssue = command({ number: 31, operation: "implement-issue", identity: "issue:31", labels: ["agent:implement"] });
    const implementSpec = command({ number: 32, operation: "implement-spec", identity: "spec:32", labels: ["agent:implement"] });
    const run = vi.fn(async () => {});
    const result = await dispatchAutomationCommands({ concurrency: 2 }, {
      scheduler: { acquire: async () => ({ release: async () => {} }), prepare: async () => {}, track: async (_identity, action) => action() },
      promotion,
      readiness,
      github: { verifyLabels: async () => {}, listCommands: async () => [implementIssue, implementSpec] },
      run,
    });
    expect(run).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ status: "dispatched", selected: [implementIssue, implementSpec] });
  });

  it("waits for every selected job before the round fails when one job rejects", async () => {
    const failing = command({ number: 1, identity: "pull-request:1" });
    const slow = command({ number: 2, identity: "pull-request:2" });
    let releaseSlow!: () => void;
    const slowFinished = new Promise<void>((resolve) => { releaseSlow = resolve; });
    let slowCompleted = false;
    const run = vi.fn(async (selected: typeof failing) => {
      if (selected.number === 1) throw new Error("review failed");
      await slowFinished;
      slowCompleted = true;
    });

    const scan = vi.fn(async () => {
      expect(slowCompleted).toBe(true);
      throw new Error("GitHub dependency state is unavailable");
    });
    const round = dispatchAutomationCommands({ concurrency: 2 }, {
      scheduler: { acquire: async () => ({ release: async () => {} }), prepare: async () => {}, track: async (_identity, action) => action() },
      promotion: { scan },
      readiness,
      github: { verifyLabels: async () => {}, listCommands: async () => [failing, slow] },
      run,
    });
    const settled = vi.fn();
    void round.catch(() => {}).then(settled);

    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(settled).not.toHaveBeenCalled();

    releaseSlow();
    await expect(round).rejects.toThrow("review failed");
    expect(slowCompleted).toBe(true);
    expect(scan).toHaveBeenCalledOnce();
  });

  it("does no discovery while the host scheduler lock is unavailable", async () => {
    const listCommands = vi.fn();
    const verifyGithubAgentAuthentication = vi.fn();
    await expect(dispatchAutomationCommands({}, {
      scheduler: { acquire: async () => undefined, prepare: async () => {}, track: async (_identity, action) => action() },
      promotion,
      readiness: { verifyGithubAgentAuthentication },
      github: { verifyLabels: async () => {}, listCommands },
      run: vi.fn(),
    })).resolves.toEqual({ status: "locked" });
    expect(listCommands).not.toHaveBeenCalled();
    expect(verifyGithubAgentAuthentication).not.toHaveBeenCalled();
  });

  it("rejects invalid concurrency before command discovery", async () => {
    const listCommands = vi.fn();
    await expect(dispatchAutomationCommands({ concurrency: 0 }, {
      scheduler: { acquire: async () => ({ release: async () => {} }), prepare: async () => {}, track: async (_identity, action) => action() },
      promotion,
      readiness,
      github: { verifyLabels: async () => {}, listCommands },
      run: vi.fn(),
    })).rejects.toThrow("Dispatch concurrency must be between 1 and 8");
    expect(listCommands).not.toHaveBeenCalled();
  });

  it("fails closed before execution when labels are inconsistent or blocked", async () => {
    const inconsistent = command({ labels: ["agent:review", "agent:in-progress"] });
    const blocked = command({ number: 11, labels: ["agent:review", "agent:blocked"] });
    const run = vi.fn();
    await dispatchAutomationCommands({}, {
      scheduler: { acquire: async () => ({ release: async () => {} }), prepare: async () => {}, track: async (_identity, action) => action() },
      promotion,
      readiness,
      github: { verifyLabels: async () => {}, listCommands: async () => [inconsistent, blocked] },
      run,
    });
    expect(run).not.toHaveBeenCalled();
  });

  it("runs queue promotion after Spec split and defers promoted commands until the next bounded round", async () => {
    const order: string[] = [];
    const splitSpec = command({ number: 218, operation: "split-spec", identity: "spec:218" });
    const commands: ReturnType<typeof command>[] = [splitSpec];
    const run = vi.fn(async () => { order.push("split"); });
    const result = await dispatchAutomationCommands({}, {
      scheduler: { acquire: async () => ({ release: async () => {} }), prepare: async () => {}, track: async (_identity, action) => action() },
      github: {
        verifyLabels: async () => {},
        listCommands: async () => { order.push("discover"); return commands.slice(); },
      },
      promotion: {
        scan: async () => {
          order.push("promote");
          commands.push(command({ number: 219, operation: "implement-issue", identity: "issue:219" }));
          return { status: "scanned", promoted: [219], refused: [] };
        },
      },
      readiness: { verifyGithubAgentAuthentication: async () => { order.push("probe"); } },
      run,
    });
    expect(result).toEqual({ status: "dispatched", selected: [splitSpec] });
    expect(order).toEqual(["probe", "discover", "split", "promote"]);
    expect(run).toHaveBeenCalledOnce();
  });

  it("fails the round after the frozen frontier without executing promoted commands when promotion cannot read dependency state", async () => {
    const existing = command({ number: 218 });
    const listCommands = vi.fn(async () => [existing]);
    const run = vi.fn();
    await expect(dispatchAutomationCommands({}, {
      scheduler: { acquire: async () => ({ release: async () => {} }), prepare: async () => {}, track: async (_identity, action) => action() },
      github: { verifyLabels: async () => {}, listCommands },
      promotion: { scan: async () => { throw new Error("GitHub dependency state is unavailable"); } },
      readiness,
      run,
    })).rejects.toThrow("GitHub dependency state is unavailable");
    expect(listCommands).toHaveBeenCalledOnce();
    expect(run).toHaveBeenCalledOnce();
    expect(run).toHaveBeenCalledWith(existing);
  });

  it.each([
    { classification: "missing" as const },
    { classification: "invalid" as const },
  ])("fails closed before any acquisition, promotion, or GitHub mutation when container authentication is $classification", async ({ classification }) => {
    const events: string[] = [];
    const listCommands = vi.fn(async () => { events.push("discover"); return []; });
    const verifyLabels = vi.fn(async () => { events.push("labels"); });
    const scan = vi.fn(async () => { events.push("promote"); });
    const prepare = vi.fn(async () => { events.push("prepare"); });
    const run = vi.fn(async () => { events.push("run"); });
    const readinessError = new GithubAgentReadinessError(classification);

    await expect(dispatchAutomationCommands({}, {
      scheduler: {
        acquire: async () => ({ release: async () => {} }),
        prepare,
        track: async (_identity, action) => action(),
      },
      github: { verifyLabels, listCommands },
      promotion: { scan },
      readiness: { verifyGithubAgentAuthentication: async () => { events.push("probe"); throw readinessError; } },
      run,
    })).rejects.toBe(readinessError);

    // The probe is the first step after the lock: no promotion, label
    // verification, discovery, or execution happens after it fails.
    expect(events).toEqual(["probe"]);
    expect(listCommands).not.toHaveBeenCalled();
    expect(verifyLabels).not.toHaveBeenCalled();
    expect(scan).not.toHaveBeenCalled();
    expect(prepare).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  it("runs the container GitHub authentication probe before discovery and promotion", async () => {
    const order: string[] = [];
    await expect(dispatchAutomationCommands({}, {
      scheduler: { acquire: async () => ({ release: async () => {} }), prepare: async () => {}, track: async (_identity, action) => action() },
      github: {
        verifyLabels: async () => {},
        listCommands: async () => { order.push("discover"); return []; },
      },
      promotion: { scan: async () => { order.push("promote"); } },
      readiness: { verifyGithubAgentAuthentication: async () => { order.push("probe"); } },
      run: vi.fn(),
    })).resolves.toEqual({ status: "dispatched", selected: [] });
    expect(order).toEqual(["probe", "discover", "promote"]);
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
          command({ number: 14, operation: "implement-issue", identity: "issue:14", labels: ["agent:implement", "agent:blocked"] }),
          command({ number: 15, operation: "split-spec", identity: "spec:15", labels: ["agent:to-tickets", "agent:blocked"] }),
        ],
      },
      scheduler: { activeJobs: async () => [{ identity: "pull-request:10", jobId: "local-1" }] },
    });

    expect(result.commands).toEqual([
      expect.objectContaining({ number: 10, eligibility: "eligible" }),
      expect.objectContaining({ number: 11, eligibility: "blocked", retry: "remove agent:blocked, restore agent:review, then retry" }),
      expect.objectContaining({ number: 12, eligibility: "stale-in-progress", retry: "inspect the Automation Work Item and resolve labels manually; do not adopt or clear state automatically" }),
      expect.objectContaining({ number: 13, eligibility: "inconsistent", retry: "inspect the Automation Work Item and resolve labels manually; do not adopt or clear state automatically" }),
      expect.objectContaining({ number: 14, eligibility: "blocked", retry: "remove agent:blocked, restore agent:implement, then retry" }),
      expect.objectContaining({ number: 15, eligibility: "blocked", retry: "remove agent:blocked, restore agent:to-tickets, then retry" }),
    ]);
    expect(result.activeJobs).toEqual([{ identity: "pull-request:10", jobId: "local-1" }]);
    expect(addLabel).not.toHaveBeenCalled();
  });
});
