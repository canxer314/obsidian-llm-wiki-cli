import { describe, expect, it, vi } from "vitest";

import { inspectAutomationCommands } from "../.sandcastle/automation-inspector.js";
import {
  DISPATCH_SESSION_IDLE_POLL_MILLISECONDS,
  dispatchAutomationCommands,
} from "../.sandcastle/automation-dispatch.js";
import { GithubAgentReadinessError } from "../.sandcastle/github-readiness.js";
import { commandEligibility, commandPriority, compareCommands, type AutomationOperation } from "../.sandcastle/automation-command.js";

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

type TestCommand = ReturnType<typeof command>;

const promotion = { scan: async () => ({ status: "scanned" as const, promoted: [], refused: [] }) };
const readiness = { verifyGithubAgentAuthentication: async () => {} };
// Recovery is always on in production; these scenarios stub it as a no-op so
// they stay focused on session behavior (recovery itself is covered by
// interrupted-automation-recovery.test.ts).
const recovery = { recoverInterrupted: async () => [] };
const scheduler = {
  acquire: async () => ({ release: async () => {} }),
  prepare: async () => {},
  track: async (_identity: string, action: () => Promise<void>) => action(),
};

// A fake discovery store models the trigger lifecycle: dispatching a command
// consumes its own trigger, so later discoveries no longer return it — exactly
// how the real acquisition removes the dispatched operation's trigger label
// (a different operation's trigger on the same Work Item survives).
function discoveryStore(initial: readonly TestCommand[]) {
  const store: TestCommand[] = [...initial];
  return {
    store,
    listCommands: vi.fn(async () => store.slice()),
    consume(selected: TestCommand) {
      for (let index = store.length - 1; index >= 0; index -= 1) {
        const entry = store[index]!;
        if (entry.identity === selected.identity && entry.operation === selected.operation) {
          store.splice(index, 1);
        }
      }
    },
  };
}

// The idle-poll wait port, gated so each test decides when a poll fires. A
// never-resolving wait pins completion-driven refills; the gate releases
// poll-driven ones.
const neverPoll = vi.fn((_milliseconds: number) => new Promise<void>(() => {}));

function pollGate() {
  const waits: number[] = [];
  // The loop cancels a poll that loses the race against a worker completion
  // (a plain-promise wait gets a no-op cancel); count cancellations to pin
  // that behavior.
  let cancels = 0;
  let pending: (() => void) | undefined;
  const wait = vi.fn((milliseconds: number) => {
    waits.push(milliseconds);
    return {
      completed: new Promise<void>((resolve) => {
        pending = resolve;
      }),
      cancel: () => {
        cancels += 1;
      },
    };
  });
  return {
    wait,
    waits,
    get cancels() {
      return cancels;
    },
    release() {
      pending?.();
      pending = undefined;
    },
  };
}

describe("Automation Command dispatch session", () => {
  it("dispatches one bounded deterministic deduplicated frontier and waits for its workers", async () => {
    const first = command({ number: 20, identity: "pull-request:20" });
    const second = command({ number: 10, operation: "review", identity: "pull-request:10" });
    const conflicting = command({ number: 10, operation: "review", identity: "pull-request:10" });
    const discovery = discoveryStore([first, second, conflicting]);
    const executed: number[] = [];
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    const run = vi.fn(async (selected: TestCommand) => {
      discovery.consume(selected);
      executed.push(selected.number);
      await waiting;
    });

    const session = dispatchAutomationCommands({ concurrency: 2 }, {
      scheduler,
      promotion,
      readiness,
      recovery,
      wait: neverPoll,
      github: { verifyLabels: async () => {}, listCommands: discovery.listCommands },
      run,
    });

    await vi.waitFor(() => expect(executed).toEqual([10, 20]));
    release();
    await expect(session).resolves.toEqual({ status: "dispatched", selected: [second, first] });
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("fails malformed known identity before scheduler tracking or command execution", async () => {
    const track = vi.fn(async (_identity: string, action: () => Promise<void>) => action());
    const run = vi.fn(async () => {});

    await expect(dispatchAutomationCommands({}, {
      scheduler: { ...scheduler, track },
      promotion,
      readiness,
      recovery,
      github: {
        verifyLabels: async () => {},
        listCommands: async () => [command({ number: 220, operation: "review", identity: "issue:220" })],
      },
      run,
    })).rejects.toThrow("Automation Command identity is not canonical");

    expect(track).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  it("bounds execution concurrency while dispatching every selected command", async () => {
    const commands = [
      command({ number: 1, identity: "pull-request:1" }),
      command({ number: 2, identity: "pull-request:2" }),
      command({ number: 3, identity: "pull-request:3" }),
    ];
    const discovery = discoveryStore(commands);
    let active = 0;
    let maxActive = 0;
    const run = vi.fn(async (selected: TestCommand) => {
      discovery.consume(selected);
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active -= 1;
    });

    const result = await dispatchAutomationCommands({ concurrency: 2 }, {
      scheduler,
      promotion,
      readiness,
      recovery,
      wait: neverPoll,
      github: { verifyLabels: async () => {}, listCommands: discovery.listCommands },
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

  it("serializes Spec implementation and Spec split on their shared per-Spec identity across refills", async () => {
    const implementSpec = command({ number: 30, operation: "implement-spec", identity: "spec:30", labels: ["agent:implement"] });
    const splitSpec = command({ number: 30, operation: "split-spec", identity: "spec:30", labels: ["agent:to-tickets"] });
    const discovery = discoveryStore([splitSpec, implementSpec]);
    let active = 0;
    let maxActive = 0;
    const run = vi.fn(async (selected: TestCommand) => {
      discovery.consume(selected);
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
    });
    const result = await dispatchAutomationCommands({}, {
      scheduler,
      promotion,
      readiness,
      recovery,
      wait: neverPoll,
      github: { verifyLabels: async () => {}, listCommands: discovery.listCommands },
      run,
    });
    // The split trigger survives implementation and is re-dispatched by a
    // later refill in the same session, never concurrently.
    expect(run).toHaveBeenCalledTimes(2);
    expect(run).toHaveBeenNthCalledWith(1, implementSpec);
    expect(run).toHaveBeenNthCalledWith(2, splitSpec);
    expect(maxActive).toBe(1);
    expect(result).toEqual({ status: "dispatched", selected: [implementSpec, splitSpec] });
  });

  it("runs Issue implementation and Spec implementation with independent identities concurrently", async () => {
    const implementIssue = command({ number: 31, operation: "implement-issue", identity: "issue:31", labels: ["agent:implement"] });
    const implementSpec = command({ number: 32, operation: "implement-spec", identity: "spec:32", labels: ["agent:implement"] });
    const discovery = discoveryStore([implementIssue, implementSpec]);
    const run = vi.fn(async (selected: TestCommand) => {
      discovery.consume(selected);
    });
    const result = await dispatchAutomationCommands({ concurrency: 2 }, {
      scheduler,
      promotion,
      readiness,
      recovery,
      wait: neverPoll,
      github: { verifyLabels: async () => {}, listCommands: discovery.listCommands },
      run,
    });
    expect(run).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ status: "dispatched", selected: [implementIssue, implementSpec] });
  });

  it("refills a freed slot immediately when a worker finishes, without waiting for the idle poll", async () => {
    const first = command({ number: 1, identity: "pull-request:1" });
    const late = command({ number: 2, identity: "pull-request:2" });
    const discovery = discoveryStore([first]);
    const gate = pollGate();
    const executed: number[] = [];
    const gates = new Map<number, () => void>();
    const run = vi.fn(async (selected: TestCommand) => {
      discovery.consume(selected);
      executed.push(selected.number);
      await new Promise<void>((resolve) => { gates.set(selected.number, resolve); });
    });

    const session = dispatchAutomationCommands({ concurrency: 1 }, {
      scheduler,
      promotion,
      readiness,
      recovery,
      wait: gate.wait,
      github: { verifyLabels: async () => {}, listCommands: discovery.listCommands },
      run,
    });

    await vi.waitFor(() => expect(executed).toEqual([1]));
    // The command becomes eligible while the only worker is busy.
    discovery.store.push(late);
    gates.get(1)!();
    // The completion refills the freed slot: the late command runs without
    // any poll firing (no slot was free, so the poll was never armed).
    await vi.waitFor(() => expect(executed).toEqual([1, 2]));
    expect(gate.waits).toEqual([]);
    gates.get(2)!();
    await expect(session).resolves.toEqual({ status: "dispatched", selected: [first, late] });
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("re-discovers on the idle poll and fills a free slot while another worker is running", async () => {
    const running = command({ number: 1, identity: "pull-request:1" });
    const appearing = command({ number: 2, identity: "pull-request:2" });
    const discovery = discoveryStore([running]);
    const gate = pollGate();
    const executed: number[] = [];
    const order: string[] = [];
    const gates = new Map<number, () => void>();
    const run = vi.fn(async (selected: TestCommand) => {
      discovery.consume(selected);
      executed.push(selected.number);
      order.push(`run:${selected.number}`);
      await new Promise<void>((resolve) => { gates.set(selected.number, resolve); });
    });

    const session = dispatchAutomationCommands({ concurrency: 2 }, {
      scheduler,
      promotion: {
        scan: async () => {
          order.push("promote");
          return { status: "scanned" as const, promoted: [], refused: [] };
        },
      },
      readiness,
      recovery,
      wait: gate.wait,
      github: {
        verifyLabels: async () => {},
        listCommands: async () => {
          order.push("discover");
          return discovery.listCommands();
        },
      },
      run,
    });

    await vi.waitFor(() => expect(executed).toEqual([1]));
    await vi.waitFor(() => expect(gate.waits).toEqual([DISPATCH_SESSION_IDLE_POLL_MILLISECONDS]));
    // The poll fires while pull-request:1 is still running; the newly
    // eligible command fills the free slot in the same session.
    discovery.store.push(appearing);
    gate.release();
    await vi.waitFor(() => expect(executed).toEqual([1, 2]));
    gates.get(1)!();
    gates.get(2)!();
    await expect(session).resolves.toEqual({ status: "dispatched", selected: [running, appearing] });
    expect(run).toHaveBeenCalledTimes(2);
    // The poll-triggered refill runs queue promotion before its fresh
    // discovery, and the discovered command fills the free slot before the
    // drain refill's own promotion and clean empty discovery.
    expect(order).toEqual([
      "discover", "run:1", "promote", "discover", "run:2", "promote", "discover",
    ]);
  });

  it("runs queue promotion before each refill discovery so a promoted command dispatches in the same session", async () => {
    const promoted = command({ number: 219, operation: "implement-issue", identity: "issue:219", labels: ["agent:implement"] });
    const discovery = discoveryStore([]);
    const order: string[] = [];
    const run = vi.fn(async (selected: TestCommand) => {
      order.push(`run:${selected.number}`);
      discovery.consume(selected);
    });

    const result = await dispatchAutomationCommands({}, {
      scheduler,
      readiness,
      recovery,
      wait: neverPoll,
      github: {
        verifyLabels: async () => {},
        listCommands: async () => {
          order.push("discover");
          return discovery.listCommands();
        },
      },
      promotion: {
        scan: async () => {
          order.push("promote");
          // The first promotion unblocks the queued Work Item; it becomes
          // visible to the discovery of the same refill.
          if (discovery.store.length === 0 && !order.includes("run:219")) discovery.store.push(promoted);
          return { status: "scanned" as const, promoted: [], refused: [] };
        },
      },
      run,
    });

    expect(result).toEqual({ status: "dispatched", selected: [promoted] });
    expect(order).toEqual(["discover", "promote", "discover", "run:219", "promote", "discover"]);
    expect(run).toHaveBeenCalledOnce();
  });

  it("promotes a queued Work Item after a Spec split and dispatches it in the same session", async () => {
    const splitSpec = command({ number: 218, operation: "split-spec", identity: "spec:218" });
    const promoted = command({ number: 219, operation: "implement-issue", identity: "issue:219", labels: ["agent:implement"] });
    const discovery = discoveryStore([splitSpec]);
    const order: string[] = [];
    const run = vi.fn(async (selected: TestCommand) => {
      order.push(`run:${selected.number}`);
      discovery.consume(selected);
    });

    const result = await dispatchAutomationCommands({}, {
      scheduler,
      recovery,
      wait: neverPoll,
      github: {
        verifyLabels: async () => {},
        listCommands: async () => {
          order.push("discover");
          return discovery.listCommands();
        },
      },
      promotion: {
        scan: async () => {
          order.push("promote");
          if (order.includes("run:218") && !order.includes("run:219") && discovery.store.length === 0) {
            discovery.store.push(promoted);
            return { status: "scanned" as const, promoted: [219], refused: [] };
          }
          return { status: "scanned" as const, promoted: [], refused: [] };
        },
      },
      readiness: { verifyGithubAgentAuthentication: async () => { order.push("probe"); } },
      run,
    });

    expect(result).toEqual({ status: "dispatched", selected: [splitSpec, promoted] });
    expect(order).toEqual([
      "probe", "discover", "run:218", "promote", "discover", "run:219", "promote", "discover",
    ]);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("records a single job failure without ending the session and reports it when the session drains", async () => {
    const failing = command({ number: 1, identity: "pull-request:1" });
    const slow = command({ number: 2, identity: "pull-request:2" });
    const discovery = discoveryStore([failing, slow]);
    let releaseSlow!: () => void;
    const slowFinished = new Promise<void>((resolve) => { releaseSlow = resolve; });
    let slowCompleted = false;
    const refillsWhileSlowRan: string[] = [];
    const run = vi.fn(async (selected: TestCommand) => {
      discovery.consume(selected);
      if (selected.number === 1) throw new Error("review failed");
      await slowFinished;
      slowCompleted = true;
    });
    const scan = vi.fn(async () => {
      // A refill triggered by the failure runs while the slow job is still in
      // flight: the session does not wait for every worker before refilling.
      if (!slowCompleted) refillsWhileSlowRan.push("promote");
      return { status: "scanned" as const, promoted: [], refused: [] };
    });

    const session = dispatchAutomationCommands({ concurrency: 2 }, {
      scheduler,
      promotion: { scan },
      readiness,
      recovery,
      wait: neverPoll,
      github: { verifyLabels: async () => {}, listCommands: discovery.listCommands },
      run,
    });
    const settled = vi.fn();
    void session.catch(() => {}).then(settled);

    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(refillsWhileSlowRan).not.toEqual([]));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(settled).not.toHaveBeenCalled();

    releaseSlow();
    // The drained session reports the failure together with everything it
    // dispatched — the failing command stays in the cumulative list.
    await expect(session).resolves.toEqual({
      status: "failed",
      selected: [failing, slow],
      failures: ["review failed"],
    });
    expect(slowCompleted).toBe(true);
  });

  it("reuses the slot of a rejected worker for unrelated work the failure-triggered refill discovers", async () => {
    const failing = command({ number: 1, identity: "pull-request:1" });
    const late = command({ number: 2, identity: "pull-request:2" });
    const discovery = discoveryStore([failing]);
    const executed: number[] = [];
    const run = vi.fn(async (selected: TestCommand) => {
      discovery.consume(selected);
      executed.push(selected.number);
      if (selected.number === 1) {
        // The unrelated command becomes eligible exactly as the only worker
        // rejects; its freed slot must stay usable in the same session.
        discovery.store.push(late);
        throw new Error("review failed");
      }
    });

    const session = dispatchAutomationCommands({ concurrency: 1 }, {
      scheduler,
      promotion,
      readiness,
      recovery,
      wait: neverPoll,
      github: { verifyLabels: async () => {}, listCommands: discovery.listCommands },
      run,
    });

    // The rejection ends neither the session nor the slot: the refill the
    // failure triggers dispatches the unrelated command into it.
    await vi.waitFor(() => expect(executed).toEqual([1, 2]));
    // The CLI prints this result (cumulative list plus failure evidence) and
    // exits non-zero for the "failed" status.
    await expect(session).resolves.toEqual({
      status: "failed",
      selected: [failing, late],
      failures: ["review failed"],
    });
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("reports every command dispatched before and after a failed refill without refill duplicates", async () => {
    const first = command({ number: 1, identity: "pull-request:1" });
    const late = command({ number: 2, identity: "pull-request:2" });
    const discovery = discoveryStore([first]);
    const gate = pollGate();
    const listCommands = vi.fn()
      .mockImplementationOnce(() => Promise.resolve(discovery.store.slice()))
      .mockRejectedValueOnce(new Error("discovery snapshot unavailable"))
      .mockImplementation(() => Promise.resolve(discovery.store.slice()));
    const run = vi.fn(async (selected: TestCommand) => {
      discovery.consume(selected);
    });

    const session = dispatchAutomationCommands({ concurrency: 1 }, {
      scheduler,
      promotion,
      readiness,
      recovery,
      wait: gate.wait,
      github: { verifyLabels: async () => {}, listCommands },
      run,
    });
    const settled = vi.fn();
    void session.then(settled, settled);

    // first dispatches from the session-start snapshot; its completion refill
    // fails discovery, which neither drains nor ends the session.
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(gate.waits).toEqual([DISPATCH_SESSION_IDLE_POLL_MILLISECONDS]));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(settled).not.toHaveBeenCalled();

    // The retried refill discovers the late command and dispatches it.
    discovery.store.push(late);
    gate.release();
    await expect(session).resolves.toEqual({
      status: "failed",
      selected: [first, late],
      failures: ["discovery snapshot unavailable"],
    });
    expect(run).toHaveBeenCalledTimes(2);
    // Session start, the failed refill, the retry that dispatched late, and
    // the clean empty drain discovery.
    expect(listCommands).toHaveBeenCalledTimes(4);
  });

  it("retries a transient refill failure on the idle poll instead of draining the session", async () => {
    const gate = pollGate();
    const listCommands = vi.fn()
      .mockResolvedValueOnce([] as const)
      .mockRejectedValueOnce(new Error("discovery snapshot unavailable"))
      .mockResolvedValue([] as TestCommand[]);
    const scan = vi.fn()
      .mockRejectedValueOnce(new Error("GitHub dependency state is unavailable"))
      .mockResolvedValue({ status: "scanned" as const, promoted: [], refused: [] });

    const session = dispatchAutomationCommands({}, {
      scheduler,
      promotion: { scan },
      readiness,
      recovery,
      wait: gate.wait,
      github: { verifyLabels: async () => {}, listCommands },
      run: vi.fn(),
    });
    const settled = vi.fn();
    void session.catch(() => {}).then(settled);

    // The failed refill neither drains nor ends the session: it waits for the
    // next idle poll and retries.
    await vi.waitFor(() => expect(gate.waits).toEqual([DISPATCH_SESSION_IDLE_POLL_MILLISECONDS]));
    expect(settled).not.toHaveBeenCalled();
    gate.release();

    // The session drains on the later clean empty discovery and reports both
    // recorded failures — the promotion failure and the discovery failure —
    // in recording order, with an empty but intact command list.
    await expect(session).resolves.toEqual({
      status: "failed",
      selected: [],
      failures: ["GitHub dependency state is unavailable", "discovery snapshot unavailable"],
    });
    expect(scan).toHaveBeenCalledTimes(2);
    expect(listCommands).toHaveBeenCalledTimes(3);
  });

  it("drains only when a clean discovery finds nothing eligible and no worker is running", async () => {
    const eligible = command({ number: 1, identity: "pull-request:1" });
    const discovery = discoveryStore([eligible]);
    const gate = pollGate();
    let release!: () => void;
    const running = new Promise<void>((resolve) => { release = resolve; });
    const run = vi.fn(async (selected: TestCommand) => {
      discovery.consume(selected);
      await running;
    });

    const session = dispatchAutomationCommands({ concurrency: 2 }, {
      scheduler,
      promotion,
      readiness,
      recovery,
      wait: gate.wait,
      github: { verifyLabels: async () => {}, listCommands: discovery.listCommands },
      run,
    });
    const settled = vi.fn();
    void session.then(settled, settled);

    await vi.waitFor(() => expect(run).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(gate.waits).toEqual([DISPATCH_SESSION_IDLE_POLL_MILLISECONDS]));
    // A clean empty discovery while the worker is still running is not a
    // drain: the session holds the lock and waits for the completion.
    gate.release();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(settled).not.toHaveBeenCalled();

    release();
    await expect(session).resolves.toEqual({ status: "dispatched", selected: [eligible] });
  });

  it("discards a refill discovery raced by a worker completion instead of draining on the stale snapshot", async () => {
    // The second worker finishes while the refill discovery its colleague
    // triggered is still in flight: the captured snapshot predates that
    // completion's label changes, so its empty result must not drain the
    // session. The pending completion wake re-discovers immediately — no
    // idle poll has to fire.
    const first = command({ number: 1, identity: "pull-request:1" });
    const second = command({ number: 2, identity: "pull-request:2" });
    const late = command({ number: 3, identity: "pull-request:3" });
    const discovery = discoveryStore([first, second]);
    const gate = pollGate();
    const gates = new Map<number, () => void>();
    const run = vi.fn(async (selected: TestCommand) => {
      discovery.consume(selected);
      await new Promise<void>((resolve) => { gates.set(selected.number, resolve); });
      // The second command's completion makes new work eligible.
      if (selected.number === 2) discovery.store.push(late);
    });
    let discoveries = 0;
    let resolveStale: (() => void) | undefined;
    const listCommands = vi.fn(() => {
      discoveries += 1;
      // The snapshot is captured when the discovery is issued, exactly how a
      // list call in flight predates a concurrent label change.
      const snapshot = discovery.store.slice();
      if (discoveries === 2) {
        return new Promise<readonly TestCommand[]>((resolve) => {
          resolveStale = () => resolve(snapshot);
        });
      }
      return Promise.resolve(snapshot);
    });

    const session = dispatchAutomationCommands({ concurrency: 2 }, {
      scheduler,
      promotion,
      readiness,
      recovery,
      wait: gate.wait,
      github: { verifyLabels: async () => {}, listCommands },
      run,
    });

    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));
    // The first completion triggers a refill whose discovery is held...
    gates.get(1)!();
    await vi.waitFor(() => expect(discoveries).toBe(2));
    // ...and the second completion lands while that discovery is in flight.
    gates.get(2)!();
    await new Promise((resolve) => setTimeout(resolve, 20));
    // Resolving with the stale (empty) snapshot must neither drain the
    // session nor dispatch from it: the pending wake refills immediately.
    resolveStale!();
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(3));
    gates.get(3)!();

    await expect(session).resolves.toEqual({ status: "dispatched", selected: [first, second, late] });
    expect(run).toHaveBeenNthCalledWith(3, late);
    // Session start, the discarded stale discovery, the immediate refill
    // that dispatched the late command, and the clean empty drain.
    expect(listCommands).toHaveBeenCalledTimes(4);
    // Both armed idle polls lost their race against completion wakes; no
    // poll had to fire for the session to make progress.
    expect(gate.waits).toEqual([
      DISPATCH_SESSION_IDLE_POLL_MILLISECONDS,
      DISPATCH_SESSION_IDLE_POLL_MILLISECONDS,
    ]);
    expect(gate.cancels).toBe(2);
  });

  it("does not re-dispatch a command whose trigger was consumed while the refill discovery was in flight", async () => {
    // The stale snapshot still shows the second command's trigger because
    // the list call was issued before the finishing job consumed it: filling
    // from that snapshot would run the same operation twice.
    const first = command({ number: 1, identity: "pull-request:1" });
    const second = command({ number: 2, identity: "pull-request:2" });
    const discovery = discoveryStore([first, second]);
    const gates = new Map<number, () => void>();
    const run = vi.fn(async (selected: TestCommand) => {
      await new Promise<void>((resolve) => { gates.set(selected.number, resolve); });
      // The second command consumes its trigger only as the job finishes,
      // after the in-flight discovery already captured it.
      discovery.consume(selected);
    });
    let discoveries = 0;
    let resolveStale: (() => void) | undefined;
    const listCommands = vi.fn(() => {
      discoveries += 1;
      const snapshot = discovery.store.slice();
      if (discoveries === 2) {
        return new Promise<readonly TestCommand[]>((resolve) => {
          resolveStale = () => resolve(snapshot);
        });
      }
      return Promise.resolve(snapshot);
    });

    const session = dispatchAutomationCommands({ concurrency: 2 }, {
      scheduler,
      promotion,
      readiness,
      recovery,
      wait: neverPoll,
      github: { verifyLabels: async () => {}, listCommands },
      run,
    });

    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));
    gates.get(1)!();
    await vi.waitFor(() => expect(discoveries).toBe(2));
    // The second worker finishes — consuming its trigger — while the refill
    // discovery that still contains it is in flight.
    gates.get(2)!();
    await new Promise((resolve) => setTimeout(resolve, 20));
    resolveStale!();

    await expect(session).resolves.toEqual({ status: "dispatched", selected: [first, second] });
    expect(run).toHaveBeenCalledTimes(2);
    // Session start, the discarded stale discovery, and the immediate
    // refill's clean empty drain discovery.
    expect(listCommands).toHaveBeenCalledTimes(3);
  });

  it("never runs two operations for the same Work Item identity concurrently", async () => {
    const eligible = command({ number: 1, identity: "pull-request:1" });
    const discovery = discoveryStore([eligible]);
    const gate = pollGate();
    let release!: () => void;
    const running = new Promise<void>((resolve) => { release = resolve; });
    const run = vi.fn(async (_selected: TestCommand) => {
      // The trigger stays visible to discovery until the job settles, so a
      // refill re-discovers the identity while it is still running.
      await running;
      discovery.consume(eligible);
    });

    const session = dispatchAutomationCommands({ concurrency: 2 }, {
      scheduler,
      promotion,
      readiness,
      recovery,
      wait: gate.wait,
      github: { verifyLabels: async () => {}, listCommands: discovery.listCommands },
      run,
    });

    await vi.waitFor(() => expect(run).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(gate.waits).toEqual([DISPATCH_SESSION_IDLE_POLL_MILLISECONDS]));
    // The refill re-discovers the running identity and excludes it instead of
    // dispatching a second operation for the same Work Item.
    gate.release();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(run).toHaveBeenCalledOnce();

    release();
    await expect(session).resolves.toEqual({ status: "dispatched", selected: [eligible] });
    expect(run).toHaveBeenCalledOnce();
  });

  it("reapplies the accepted priority-then-number order on every refill", async () => {
    const implementIssue = command({ number: 9, operation: "implement-issue", identity: "issue:9", labels: ["agent:implement"] });
    const updateBranch = command({ number: 2, operation: "update-branch", identity: "pull-request:2" });
    const review = command({ number: 5, operation: "review", identity: "pull-request:5" });
    const discovery = discoveryStore([implementIssue]);
    const gate = pollGate();
    const executed: number[] = [];
    const gates = new Map<number, () => void>();
    const run = vi.fn(async (selected: TestCommand) => {
      discovery.consume(selected);
      executed.push(selected.number);
      await new Promise<void>((resolve) => { gates.set(selected.number, resolve); });
    });

    const session = dispatchAutomationCommands({ concurrency: 2 }, {
      scheduler,
      promotion,
      readiness,
      recovery,
      wait: gate.wait,
      github: { verifyLabels: async () => {}, listCommands: discovery.listCommands },
      run,
    });

    await vi.waitFor(() => expect(executed).toEqual([9]));
    await vi.waitFor(() => expect(gate.waits).toEqual([DISPATCH_SESSION_IDLE_POLL_MILLISECONDS]));
    // A higher-priority command appearing in a later refill takes the next
    // free slot ahead of a lower-priority one discovered at the same time.
    discovery.store.push(review, updateBranch);
    gate.release();
    await vi.waitFor(() => expect(executed).toEqual([9, 2]));
    expect(run).not.toHaveBeenCalledWith(review);

    gates.get(9)!();
    await vi.waitFor(() => expect(executed).toEqual([9, 2, 5]));
    gates.get(2)!();
    gates.get(5)!();
    await expect(session).resolves.toEqual({
      status: "dispatched",
      selected: [implementIssue, updateBranch, review],
    });
  });

  it("runs the probe, prepare, label verification, and recovery once per session and the lock exactly once", async () => {
    const first = command({ number: 1, identity: "pull-request:1" });
    const second = command({ number: 2, identity: "pull-request:2" });
    const discovery = discoveryStore([first, second]);
    const acquire = vi.fn(async () => ({ release: async () => { events.push("release"); } }));
    const prepare = vi.fn(async () => {});
    const verifyLabels = vi.fn(async () => {});
    const verifyGithubAgentAuthentication = vi.fn(async () => {});
    const recoverInterrupted = vi.fn(async () => [] as readonly string[]);
    const events: string[] = [];
    const run = vi.fn(async (selected: TestCommand) => {
      discovery.consume(selected);
      events.push(`run:${selected.number}`);
    });

    // Concurrency 1 forces a second refill to dispatch the second command, so
    // the session spans several refills before draining.
    const result = await dispatchAutomationCommands({ concurrency: 1 }, {
      scheduler: { acquire, prepare, track: scheduler.track },
      promotion,
      readiness: { verifyGithubAgentAuthentication },
      recovery: { recoverInterrupted },
      wait: neverPoll,
      github: { verifyLabels, listCommands: discovery.listCommands },
      run,
    });

    expect(result).toEqual({ status: "dispatched", selected: [first, second] });
    expect(run).toHaveBeenCalledTimes(2);
    expect(verifyGithubAgentAuthentication).toHaveBeenCalledOnce();
    expect(prepare).toHaveBeenCalledOnce();
    expect(verifyLabels).toHaveBeenCalledOnce();
    expect(recoverInterrupted).toHaveBeenCalledOnce();
    expect(acquire).toHaveBeenCalledOnce();
    // The lock is released exactly once, after everything the session ran.
    expect(events).toEqual(["run:1", "run:2", "release"]);
  });

  it("keeps a Work Item whose identity recovery repaired out of the session-start frontier and re-dispatches it through ordinary refill discovery", async () => {
    // ADR-0004 recovery returns the identities it repaired so the frontier
    // built from the repairing discovery snapshot never runs them; a later
    // refill's ordinary discovery picks the repaired Work Item up.
    const eligible = command({ number: 90, identity: "pull-request:90" });
    const discovery = discoveryStore([eligible]);
    const recoverInterrupted = vi.fn(async () => [eligible.identity]);
    const order: string[] = [];
    const run = vi.fn(async (selected: TestCommand) => {
      order.push("run");
      discovery.consume(selected);
    });
    const result = await dispatchAutomationCommands({}, {
      scheduler,
      promotion,
      readiness,
      wait: neverPoll,
      github: { verifyLabels: async () => {}, listCommands: discovery.listCommands },
      recovery: {
        recoverInterrupted: async (commands: readonly TestCommand[]) => {
          order.push("recover");
          return recoverInterrupted(commands);
        },
      },
      run,
    });
    expect(order).toEqual(["recover", "run"]);
    expect(run).toHaveBeenCalledOnce();
    expect(run).toHaveBeenCalledWith(eligible);
    expect(recoverInterrupted).toHaveBeenCalledOnce();
    expect(result).toEqual({ status: "dispatched", selected: [eligible] });
  });

  it("records a refill promotion failure, retries on the idle poll instead of draining, and reports the failure", async () => {
    const existing = command({ number: 218 });
    const discovery = discoveryStore([existing]);
    const gate = pollGate();
    const run = vi.fn(async (selected: TestCommand) => {
      discovery.consume(selected);
    });
    const scan = vi.fn()
      .mockRejectedValueOnce(new Error("GitHub dependency state is unavailable"))
      .mockResolvedValue({ status: "scanned" as const, promoted: [], refused: [] });

    const session = dispatchAutomationCommands({}, {
      scheduler,
      github: { verifyLabels: async () => {}, listCommands: discovery.listCommands },
      promotion: { scan },
      readiness,
      recovery,
      wait: gate.wait,
      run,
    });
    const settled = vi.fn();
    void session.then(settled, settled);

    // The completion-triggered refill wins its race against the idle poll
    // (the losing poll is cancelled); its promotion failure is recorded and
    // its empty discovery cannot drain the session — a failed refill never
    // satisfies the clean-empty drain condition, so the session waits for the
    // next idle poll.
    await vi.waitFor(() => expect(gate.waits).toEqual([
      DISPATCH_SESSION_IDLE_POLL_MILLISECONDS,
      DISPATCH_SESSION_IDLE_POLL_MILLISECONDS,
    ]));
    expect(gate.cancels).toBe(1);
    expect(settled).not.toHaveBeenCalled();

    // The retried refill's promotion succeeds and its clean empty discovery
    // drains the session, which reports the recorded failure.
    gate.release();
    await expect(session).resolves.toEqual({
      status: "failed",
      selected: [existing],
      failures: ["GitHub dependency state is unavailable"],
    });
    // Session start, the failed refill, and the retry's drain discovery.
    expect(discovery.listCommands).toHaveBeenCalledTimes(3);
    expect(scan).toHaveBeenCalledTimes(2);
    expect(run).toHaveBeenCalledOnce();
    expect(run).toHaveBeenCalledWith(existing);
  });

  it("does no discovery while the host scheduler lock is unavailable", async () => {
    const listCommands = vi.fn();
    const verifyGithubAgentAuthentication = vi.fn();
    await expect(dispatchAutomationCommands({}, {
      scheduler: { ...scheduler, acquire: async () => undefined },
      promotion,
      readiness: { verifyGithubAgentAuthentication },
      recovery,
      github: { verifyLabels: async () => {}, listCommands },
      run: vi.fn(),
    })).resolves.toEqual({ status: "locked" });
    expect(listCommands).not.toHaveBeenCalled();
    expect(verifyGithubAgentAuthentication).not.toHaveBeenCalled();
  });

  it("rejects invalid concurrency before command discovery", async () => {
    const listCommands = vi.fn();
    await expect(dispatchAutomationCommands({ concurrency: 0 }, {
      scheduler,
      promotion,
      readiness,
      recovery,
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
      scheduler,
      promotion,
      readiness,
      recovery,
      github: { verifyLabels: async () => {}, listCommands: async () => [inconsistent, blocked] },
      run,
    });
    expect(run).not.toHaveBeenCalled();
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
      recovery,
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
      scheduler,
      github: {
        verifyLabels: async () => {},
        listCommands: async () => { order.push("discover"); return []; },
      },
      promotion: { scan: async () => { order.push("promote"); } },
      readiness: { verifyGithubAgentAuthentication: async () => { order.push("probe"); } },
      recovery,
      run: vi.fn(),
    })).resolves.toEqual({ status: "dispatched", selected: [] });
    // Session start discovers once for recovery and the initial fill; the
    // first refill then runs promotion before its own discovery, after which
    // the clean empty discovery drains the session.
    expect(order).toEqual(["probe", "discover", "promote", "discover"]);
  });
});

describe("Automation Command inspection", () => {
  // ADR-0004: stale-in-progress and inconsistent Work Items are Interrupted
  // Automation, which the Dispatcher recovers automatically in a later
  // Dispatch Session once the owning job is provably dead. Only evidence that
  // fails closed keeps such a Work Item on the manual-inspection path; Blocked
  // Automation stays manual-only and is never implied auto-recoverable.
  const interruptedAutomationRetry =
    "the Dispatcher automatically recovers this Interrupted Automation in a later Dispatch Session when the owning job is provably dead; if recovery evidence fails closed, inspect the Automation Work Item and resolve labels manually";
  const blockedUnknownRetry =
    "inspect the Automation Work Item and restore the appropriate trigger manually before retrying";

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
      expect.objectContaining({ number: 12, eligibility: "stale-in-progress", retry: interruptedAutomationRetry }),
      expect.objectContaining({ number: 13, eligibility: "inconsistent", retry: interruptedAutomationRetry }),
      expect.objectContaining({ number: 14, eligibility: "blocked", retry: "remove agent:blocked, restore agent:implement, then retry" }),
      expect.objectContaining({ number: 15, eligibility: "blocked", retry: "remove agent:blocked, restore agent:to-tickets, then retry" }),
    ]);
    expect(result.activeJobs).toEqual([{ identity: "pull-request:10", jobId: "local-1" }]);
    expect(addLabel).not.toHaveBeenCalled();
  });

  it("keeps Blocked Automation manual-only and expresses both Interrupted Automation recovery paths", async () => {
    const result = await inspectAutomationCommands({
      github: {
        listCommands: async () => [
          command({ number: 20, labels: ["agent:review", "agent:blocked"] }),
          command({ number: 21, labels: ["agent:in-progress"] }),
          command({ number: 22, labels: ["agent:review", "agent:in-progress"] }),
          command({ number: 23, operation: "unknown", identity: "pull-request:23", labels: ["agent:blocked"] }),
          command({ number: 24, operation: "unknown", identity: "pull-request:24", labels: ["agent:in-progress"] }),
        ],
      },
      scheduler: { activeJobs: async () => [] },
    });

    const byNumber = new Map(result.commands.map((entry) => [entry.number, entry]));
    for (const number of [21, 22, 24]) {
      const { eligibility, retry } = byNumber.get(number)!;
      expect(["stale-in-progress", "inconsistent"]).toContain(eligibility);
      expect(retry).toBe(interruptedAutomationRetry);
      expect(retry).toContain("automatically recovers this Interrupted Automation");
      expect(retry).toContain("if recovery evidence fails closed, inspect the Automation Work Item and resolve labels manually");
    }
    expect(byNumber.get(20)!.retry).toBe("remove agent:blocked, restore agent:review, then retry");
    expect(byNumber.get(23)!.retry).toBe(blockedUnknownRetry);
    for (const number of [20, 23]) {
      expect(byNumber.get(number)!.retry).not.toContain("automatically recovers");
      expect(byNumber.get(number)!.retry).not.toContain("provably dead");
    }
  });
});
