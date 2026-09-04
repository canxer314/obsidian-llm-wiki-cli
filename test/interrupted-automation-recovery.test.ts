import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { AutomationCommand } from "../.sandcastle/automation-command.js";
import { dispatchAutomationCommands } from "../.sandcastle/automation-dispatch.js";
import {
  createInterruptedAutomationRecovery,
  createJobLogEvidenceScanner,
  INTERRUPTED_AUTOMATION_GRACE_MILLISECONDS,
  type InterruptedAutomationJobRecord,
} from "../.sandcastle/interrupted-automation-recovery.js";
import { completeJobLog, createJobLog } from "../.sandcastle/job-logs.js";

const NOW = 1_800_000_000_000;
const OLD = NOW - INTERRUPTED_AUTOMATION_GRACE_MILLISECONDS - 1_000;
const INSIDE_GRACE = NOW - 60_000;

function runningRecord(overrides: Partial<InterruptedAutomationJobRecord> = {}): InterruptedAutomationJobRecord {
  return {
    jobId: "dead-job-1",
    operation: "implement-issue",
    number: 41,
    status: "running",
    startedAt: OLD,
    ...overrides,
  };
}

function harness(options: {
  readonly commands: readonly AutomationCommand[];
  readonly records?: readonly InterruptedAutomationJobRecord[];
  readonly unreadable?: readonly string[];
  readonly activeJobs?: readonly { readonly identity: string; readonly jobId: string }[];
}) {
  const events: string[] = [];
  const labels = new Map(options.commands.map((command) => [command.number, new Set(command.labels)]));
  const recovery = createInterruptedAutomationRecovery({
    scheduler: { activeJobs: async () => options.activeJobs ?? [] },
    evidence: {
      scan: async () => ({ records: options.records ?? [], unreadable: options.unreadable ?? [] }),
    },
    github: {
      removeIssueLabel: async (issueNumber, label) => {
        labels.get(issueNumber)?.delete(label);
        events.push(`remove:${issueNumber}:${label}`);
      },
      addIssueLabel: async (issueNumber, label) => {
        labels.get(issueNumber)?.add(label);
        events.push(`add:${issueNumber}:${label}`);
      },
      addRecoveryDiagnostic: async (issueNumber, diagnostic) => {
        events.push(
          `diagnostic:${issueNumber}:${diagnostic.jobId}:${diagnostic.operation}:${diagnostic.trigger}:${diagnostic.triggerRestored}`,
        );
      },
    },
    now: () => NOW,
  });
  const run = vi.fn(async () => { events.push("run"); });
  const dispatch = () => dispatchAutomationCommands({ concurrency: 1 }, {
    scheduler: {
      acquire: async () => ({ release: async () => {} }),
      prepare: async () => {},
      track: async (_identity: string, action: () => Promise<void>) => action(),
    },
    github: {
      verifyLabels: async () => {},
      listCommands: async () => { events.push("discover"); return options.commands; },
    },
    recovery,
    readiness: { verifyGithubAgentAuthentication: async () => {} },
    promotion: { scan: async () => ({ status: "scanned" as const, promoted: [], refused: [] }) },
    run,
  });
  return { events, labels, run, dispatch };
}

function expectNoMutation(events: readonly string[]): void {
  expect(events.some((event) =>
    event.startsWith("remove:") || event.startsWith("add:") || event.startsWith("diagnostic:"))).toBe(false);
}

describe("Interrupted Automation recovery", () => {
  it("recovers a provably-dead Issue implementation and excludes it from the same frontier", async () => {
    const stale: AutomationCommand = {
      number: 41, operation: "implement-issue", identity: "issue:41", labels: ["agent:in-progress"],
    };
    const eligible: AutomationCommand = {
      number: 10, operation: "review", identity: "pull-request:10", labels: ["agent:review"],
    };
    const { events, labels, run, dispatch } = harness({
      commands: [stale, eligible],
      records: [runningRecord()],
    });

    await expect(dispatch()).resolves.toEqual({ status: "dispatched", selected: [eligible] });

    // Recovery runs on the discovery snapshot before the frontier executes.
    expect(events).toEqual([
      "discover",
      "remove:41:agent:in-progress",
      "add:41:agent:implement",
      "diagnostic:41:dead-job-1:implement-issue:agent:implement:true",
      "run",
    ]);
    expect(run).toHaveBeenCalledOnce();
    expect(run).toHaveBeenCalledWith(eligible);
    expect(labels.get(41)).toEqual(new Set(["agent:implement"]));
  });

  it("recovers a provably-dead Spec implementation without re-adding its present trigger", async () => {
    const inconsistent: AutomationCommand = {
      number: 42,
      operation: "implement-spec",
      identity: "spec:42",
      labels: ["agent:implement", "agent:in-progress"],
    };
    const { events, labels, run, dispatch } = harness({
      commands: [inconsistent],
      records: [runningRecord({ operation: "implement-spec", number: 42 })],
    });

    await expect(dispatch()).resolves.toEqual({ status: "dispatched", selected: [] });

    expect(events).toEqual([
      "discover",
      "remove:42:agent:in-progress",
      "diagnostic:42:dead-job-1:implement-spec:agent:implement:false",
    ]);
    expect(run).not.toHaveBeenCalled();
    expect(labels.get(42)).toEqual(new Set(["agent:implement"]));
  });

  it("reconstructs a state-only Work Item operation from exactly one running record", async () => {
    const stateOnly: AutomationCommand = {
      number: 43, operation: "unknown", identity: "issue:43", labels: ["agent:in-progress"],
    };
    const { events, labels, dispatch } = harness({
      commands: [stateOnly],
      records: [runningRecord({ operation: "implement-spec", number: 43 })],
    });

    await expect(dispatch()).resolves.toEqual({ status: "dispatched", selected: [] });

    expect(events).toEqual([
      "discover",
      "remove:43:agent:in-progress",
      "add:43:agent:implement",
      "diagnostic:43:dead-job-1:implement-spec:agent:implement:true",
    ]);
    expect(labels.get(43)).toEqual(new Set(["agent:implement"]));
  });

  it("re-discovers a repaired Work Item as eligible on a later dispatch", async () => {
    const stale: AutomationCommand = {
      number: 41, operation: "implement-issue", identity: "issue:41", labels: ["agent:in-progress"],
    };
    const first = harness({ commands: [stale], records: [runningRecord()] });
    await expect(first.dispatch()).resolves.toEqual({ status: "dispatched", selected: [] });

    // A later dispatch sees the repaired labels through ordinary discovery;
    // the dead job evidence no longer gates anything.
    const rediscovered: AutomationCommand = {
      ...stale, labels: [...first.labels.get(41)!],
    };
    const second = harness({ commands: [rediscovered], records: [] });
    await expect(second.dispatch()).resolves.toEqual({ status: "dispatched", selected: [rediscovered] });
    expect(second.run).toHaveBeenCalledOnce();
    expect(second.run).toHaveBeenCalledWith(rediscovered);
  });

  it("refuses when a live scheduler job owns the identity", async () => {
    const stale: AutomationCommand = {
      number: 41, operation: "implement-issue", identity: "issue:41", labels: ["agent:in-progress"],
    };
    const { events, labels, dispatch } = harness({
      commands: [stale],
      records: [runningRecord()],
      activeJobs: [{ identity: "issue:41", jobId: "local-dispatch-7-1" }],
    });

    await expect(dispatch()).resolves.toEqual({ status: "dispatched", selected: [] });

    expectNoMutation(events);
    expect(labels.get(41)).toEqual(new Set(["agent:in-progress"]));
  });

  it("refuses while the job is inside the five-minute grace period", async () => {
    const stale: AutomationCommand = {
      number: 41, operation: "implement-issue", identity: "issue:41", labels: ["agent:in-progress"],
    };
    const { events, dispatch } = harness({
      commands: [stale],
      records: [runningRecord({ startedAt: INSIDE_GRACE })],
    });

    await expect(dispatch()).resolves.toEqual({ status: "dispatched", selected: [] });

    expectNoMutation(events);
  });

  it("refuses when no running record matches the identity", async () => {
    const stale: AutomationCommand = {
      number: 41, operation: "implement-issue", identity: "issue:41", labels: ["agent:in-progress"],
    };
    const { events, dispatch } = harness({
      commands: [stale],
      records: [runningRecord({ status: "failed" })],
    });

    await expect(dispatch()).resolves.toEqual({ status: "dispatched", selected: [] });

    expectNoMutation(events);
  });

  it("refuses when a second interruption left multiple running records", async () => {
    const stale: AutomationCommand = {
      number: 41, operation: "implement-issue", identity: "issue:41", labels: ["agent:in-progress"],
    };
    const { events, dispatch } = harness({
      commands: [stale],
      records: [runningRecord(), runningRecord({ jobId: "dead-job-2" })],
    });

    await expect(dispatch()).resolves.toEqual({ status: "dispatched", selected: [] });

    expectNoMutation(events);
  });

  it("refuses the whole round when any job evidence is unreadable", async () => {
    const stale: AutomationCommand = {
      number: 41, operation: "implement-issue", identity: "issue:41", labels: ["agent:in-progress"],
    };
    const { events, dispatch } = harness({
      commands: [stale],
      records: [runningRecord()],
      unreadable: ["mystery-job"],
    });

    await expect(dispatch()).resolves.toEqual({ status: "dispatched", selected: [] });

    expectNoMutation(events);
  });

  it("refuses when present labels contradict the recorded operation", async () => {
    // Discovery routed #44 as a plain Issue implementation, but the recorded
    // job was a Spec implementation: the label evidence and the job evidence
    // disagree, so recovery fails closed.
    const contradicting: AutomationCommand = {
      number: 44, operation: "implement-issue", identity: "issue:44", labels: ["agent:in-progress"],
    };
    const { events, dispatch } = harness({
      commands: [contradicting],
      records: [runningRecord({ operation: "implement-spec", number: 44 })],
    });

    await expect(dispatch()).resolves.toEqual({ status: "dispatched", selected: [] });

    expectNoMutation(events);
  });

  it("leaves Blocked Automation untouched even with matching dead-job evidence", async () => {
    const blocked: AutomationCommand = {
      number: 45,
      operation: "implement-issue",
      identity: "issue:45",
      labels: ["agent:implement", "agent:blocked"],
    };
    const { events, run, dispatch } = harness({
      commands: [blocked],
      records: [runningRecord({ number: 45 })],
    });

    await expect(dispatch()).resolves.toEqual({ status: "dispatched", selected: [] });

    expectNoMutation(events);
    expect(run).not.toHaveBeenCalled();
  });
});

describe("Interrupted Automation job-log evidence", () => {
  it("reads running and terminal records, marks unreadable metadata, and ignores non-job entries", async () => {
    const root = await mkdtemp(join(tmpdir(), "interrupted-automation-"));
    try {
      const running = await createJobLog({
        root, jobId: "running-job", operation: "implement-issue", number: 41, revision: "r", now: OLD,
      });
      expect(running.metadataPath.endsWith(join("running-job", "metadata.json"))).toBe(true);
      const finished = await createJobLog({
        root, jobId: "finished-job", operation: "implement-spec", number: 42, revision: "r", now: OLD,
      });
      await completeJobLog(finished, { status: "failed", now: NOW });
      await writeFile(join(root, "stray-file"), "not a job directory");
      await mkdir(join(root, "corrupt-job"));
      await writeFile(join(root, "corrupt-job", "metadata.json"), "{ not json");

      const evidence = await createJobLogEvidenceScanner({ root }).scan();

      expect(evidence.records).toEqual([
        {
          jobId: "finished-job",
          operation: "implement-spec",
          number: 42,
          status: "failed",
          startedAt: OLD,
        },
        {
          jobId: "running-job",
          operation: "implement-issue",
          number: 41,
          status: "running",
          startedAt: OLD,
        },
      ]);
      expect(evidence.unreadable).toEqual(["corrupt-job"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("treats a missing job-log root as empty evidence", async () => {
    const root = join(await mkdtemp(join(tmpdir(), "interrupted-automation-")), "absent");
    await expect(createJobLogEvidenceScanner({ root }).scan()).resolves.toEqual({
      records: [],
      unreadable: [],
    });
  });
});
