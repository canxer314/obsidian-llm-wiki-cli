/**
 * Submission Key replay and seven-day retention corpus (issue #195, part of
 * #43; PR #28 §6.5, §7.1–§7.5, §12.5–§12.7, A-18–A-23, A-34–A-35, A-43).
 *
 * In-process scenarios drive `ChangeSetService` directly with a deterministic
 * clock, a counting execution adapter, and a gateable registry store to prove:
 *
 * - same-key/same-request retries at every timing (before the registration
 *   acknowledgement, while queued, while executing, after the mutation, after
 *   the durable terminal proof, after a transport disconnect, and after a
 *   restart) return the same Change Set identity and current proof state
 *   without another execution (at-most-once);
 * - concurrent same-key submissions produce exactly one binding and one
 *   execution, and same-key/different-request races deterministically resolve
 *   to `submission_key_conflict` without touching the original binding;
 * - just-before / exact / just-after seven-day retention boundaries without
 *   wall-clock sleeps, with no early removal and no expiry racing an active
 *   queue, execution, or recovery reference;
 * - fail-closed behavior when the registry is missing, truncated, corrupt, or
 *   inconsistent while a live Recovery Journal frame still requires an answer;
 * - a `recovery_blocked` bind/replay disposition and its ordinary status view
 *   stay stable across restart and retention processing.
 *
 * Headless scenarios (via the supervised owning-process runners) prove the
 * same over real process crashes, reconnects, and restarts. Every report
 * records deterministic times, concurrent call ordering, irreversible key
 * digests (never a raw Submission Key), record identities, execution counts,
 * proof/gate states, and a machine verdict.
 */

import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { ChangeSetSubmitInput } from "@llm-wiki/vault-contracts";

import {
  CHANGE_SET_RECORD_RETENTION_MS,
  ChangeSetService,
  RECOVERY_JOURNAL_FRAME_SCHEMA_VERSION,
  createBridgeInstance,
  fingerprintChangeSetRequest,
  type BridgeHealthState,
  type ChangeSetExecutionAdapter,
  type ChangeSetPreflightDataSource,
  type ChangeSetRegistryState,
  type ChangeSetRegistryStore,
  type ChangeSetRequestState,
  type ChangeSetRuntimeStatePort,
  type RecoveryJournalFrame,
} from "../src/index.js";
import {
  CREATE_NOTE_PATH,
  createNoteCorpusProfile,
} from "../src/corpus/create-note-corpus.js";
import {
  runSubmissionKeyCrashReplayScenario,
  runSubmissionKeyRecoveryBlockedScenario,
  runSubmissionKeyRegistryFaultScenario,
  runSubmissionKeyReplayScenario,
  type SubmissionKeyCorpusEvidence,
} from "../src/corpus/crash-corpus-runner.js";

const RETENTION = CHANGE_SET_RECORD_RETENTION_MS;
const textEncoder = new TextEncoder();

const temporaryReportRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryReportRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function reportDir(label: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `sk195-${label}-`));
  temporaryReportRoots.push(root);
  return root;
}

async function writeReport(
  directory: string,
  name: string,
  report: Record<string, unknown>,
): Promise<string> {
  const path = join(directory, `${name}.json`);
  await writeFile(path, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return path;
}

function digestKey(submissionKey: string): string {
  return `sha256:${createHash("sha256").update(submissionKey, "utf8").digest("hex")}`;
}

/** Canonical JSON (sorted member order) so cross-call result equality is deterministic. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, member]) => member !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, member]) => `${JSON.stringify(key)}:${canonicalJson(member)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

const OPEN: ChangeSetRequestState = {
  vault: { writeGate: "open", writeState: "writable" },
  effectiveGate: null,
};
const RECOVERY_BLOCKED: ChangeSetRequestState = {
  vault: { writeGate: "blocked", writeState: "paused" },
  effectiveGate: { code: "recovery_blocked" },
};

function noteInput(
  submissionKey: string,
  path: string,
  content: string,
  operationId = "op-1",
): ChangeSetSubmitInput {
  return {
    submissionKey,
    operations: [
      { operationId, kind: "create_note", path, content, ifExists: "reject" },
    ],
  };
}

/** Registry store whose next `save` can be parked before it acknowledges. */
class MemoryStore implements ChangeSetRegistryStore {
  state: ChangeSetRegistryState | undefined;
  saves = 0;
  #pendingSave: { entered: () => void; gate: Promise<void> } | null = null;

  armSaveGate(): { entered: Promise<void>; release: () => void } {
    let enteredResolve!: () => void;
    let releaseResolve!: () => void;
    const entered = new Promise<void>((resolve) => (enteredResolve = resolve));
    const gate = new Promise<void>((resolve) => (releaseResolve = resolve));
    this.#pendingSave = { entered: enteredResolve, gate };
    return { entered, release: releaseResolve };
  }

  async load(): Promise<unknown> {
    return structuredClone(this.state);
  }

  async save(state: ChangeSetRegistryState): Promise<void> {
    this.saves += 1;
    const pending = this.#pendingSave;
    if (pending !== null) {
      this.#pendingSave = null;
      pending.entered();
      await pending.gate;
    }
    this.state = structuredClone(state);
  }
}

/**
 * In-memory execution adapter that counts every externally visible effect (a
 * file publish, a directory publish, a snapshot barrier, a durable PREPARED
 * frame) and can park the next occurrence of a declared event so a retry can
 * be injected at an exact execution timing.
 */
class CountingExecutionAdapter implements ChangeSetExecutionAdapter {
  readonly directories = new Set<string>();
  readonly files = new Map<string, Uint8Array>();
  readonly identities = new Map<string, string>();
  readonly stagedDirectories = new Map<string, string>();
  readonly stagedFiles = new Map<string, { bytes: Uint8Array; identity: string }>();
  frame: RecoveryJournalFrame | null = null;
  readonly filePublishes: string[] = [];
  readonly directoryPublishes: string[] = [];
  /** Distinct Change Set identities that ever persisted a PREPARED frame. */
  readonly preparedChangeSetIds = new Set<string>();
  snapshots = 0;
  #identity = 0;
  #park: { event: string; parked: () => void; gate: Promise<void> } | null = null;

  armPark(event: "prepareDirectory" | "publishFile" | "snapshot"): {
    parked: Promise<void>;
    release: () => void;
  } {
    let parkedResolve!: () => void;
    let releaseResolve!: () => void;
    const parked = new Promise<void>((resolve) => (parkedResolve = resolve));
    const gate = new Promise<void>((resolve) => (releaseResolve = resolve));
    this.#park = { event, parked: parkedResolve, gate };
    return { parked, release: releaseResolve };
  }

  async #maybePark(event: string): Promise<void> {
    const park = this.#park;
    if (park === null || park.event !== event) return;
    this.#park = null;
    park.parked();
    await park.gate;
  }

  async loadRecoveryFrame(): Promise<RecoveryJournalFrame | null> {
    return structuredClone(this.frame);
  }

  async persistRecoveryFrame(frame: RecoveryJournalFrame): Promise<void> {
    if (frame.phase === "PREPARED") this.preparedChangeSetIds.add(frame.changeSetId);
    this.frame = structuredClone(frame);
  }

  async pathKind(path: string): Promise<"directory" | "file" | null> {
    return this.directories.has(path) ? "directory" : this.files.has(path) ? "file" : null;
  }

  async directoryIdentity(path: string): Promise<string | null> {
    return this.identities.get(path) ?? null;
  }

  async prepareDirectory(stageId: string): Promise<string> {
    await this.#maybePark("prepareDirectory");
    const identity = `directory-${++this.#identity}`;
    this.stagedDirectories.set(stageId, identity);
    return identity;
  }

  async publishDirectory(stageId: string, path: string): Promise<void> {
    const identity = this.stagedDirectories.get(stageId);
    if (identity === undefined) throw new Error("missing staged directory");
    this.stagedDirectories.delete(stageId);
    this.directoryPublishes.push(path);
    this.directories.add(path);
    this.identities.set(path, identity);
  }

  async discardPreparedDirectory(stageId: string): Promise<void> {
    this.stagedDirectories.delete(stageId);
  }

  async removeDirectory(path: string): Promise<void> {
    this.directories.delete(path);
    this.identities.delete(path);
  }

  async readBinary(path: string): Promise<Uint8Array | null> {
    const bytes = this.files.get(path);
    return bytes === undefined ? null : Uint8Array.from(bytes);
  }

  async fileIdentity(path: string): Promise<string | null> {
    return this.identities.get(path) ?? null;
  }

  async prepareFile(stageId: string, bytes: Uint8Array): Promise<string> {
    const identity = `file-${++this.#identity}`;
    this.stagedFiles.set(stageId, { bytes: Uint8Array.from(bytes), identity });
    return identity;
  }

  async publishFile(stageId: string, path: string): Promise<void> {
    await this.#maybePark("publishFile");
    const stagedFile = this.stagedFiles.get(stageId);
    if (stagedFile === undefined) throw new Error("missing staged file");
    this.stagedFiles.delete(stageId);
    this.filePublishes.push(path);
    this.files.set(path, stagedFile.bytes);
    this.identities.set(path, stagedFile.identity);
  }

  async discardPreparedFile(stageId: string): Promise<void> {
    this.stagedFiles.delete(stageId);
  }

  async removeFile(path: string): Promise<void> {
    this.files.delete(path);
    this.identities.delete(path);
  }

  async publishSearchSnapshot(): Promise<void> {
    await this.#maybePark("snapshot");
    this.snapshots += 1;
  }
}

class RecordingRuntimeState implements ChangeSetRuntimeStatePort {
  queue = {
    currentExecutionId: null as string | null,
    length: 0,
    headChangeSetId: null as string | null,
  };
  blocked: string[] = [];

  setQueue(state: {
    currentExecutionId: string | null;
    length: number;
    headChangeSetId: string | null;
  }): void {
    this.queue = state;
  }

  blockWritesForUnproven(changeSetId: string): void {
    this.blocked.push(changeSetId);
  }
}

interface Rig {
  readonly store: MemoryStore;
  readonly adapter: CountingExecutionAdapter;
  readonly runtime: RecordingRuntimeState;
  readonly service: ChangeSetService;
  readonly generatedIds: () => number;
}

function rigDataSource(adapter: CountingExecutionAdapter): ChangeSetPreflightDataSource {
  return {
    readBinary: async (path) => {
      const bytes = adapter.files.get(path);
      return bytes === undefined ? null : Uint8Array.from(bytes);
    },
    pathKind: async (path) =>
      adapter.directories.has(path) ? "directory" : adapter.files.has(path) ? "file" : null,
    isContained: async () => true,
  };
}

async function openRig(options: {
  store?: MemoryStore;
  adapter?: CountingExecutionAdapter;
  now?: () => number;
  runtime?: RecordingRuntimeState;
}): Promise<Rig> {
  const store = options.store ?? new MemoryStore();
  const adapter = options.adapter ?? new CountingExecutionAdapter();
  const runtime = options.runtime ?? new RecordingRuntimeState();
  let generated = 0;
  const service = await ChangeSetService.open({
    store,
    dataSource: rigDataSource(adapter),
    execution: adapter,
    runtimeState: runtime,
    createChangeSetId: () => `cs-${++generated}`,
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  return { store, adapter, runtime, service, generatedIds: () => generated };
}

function healthState(): BridgeHealthState {
  return {
    vault: { id: "vault-a", name: "Alpha", path: "D:/Vaults/Alpha" },
    readiness: { searchSnapshot: "ready", cache: "ready", index: "ready" },
    recovery: { state: "none" },
    write: { gate: "open", state: "writable", pauseSource: null },
    queue: { currentExecutionId: null, length: 0, headChangeSetId: null },
    lifecycle: {
      startup: "ready",
      upgrade: "not_run",
      migration: "not_run",
      recovery: "not_run",
    },
    effectiveGate: null,
    overall: "healthy",
    reasonCodes: [],
    operatorAction: "none",
  };
}

async function connect(endpoint: URL): Promise<Client> {
  const client = new Client({ name: "sk195-test", version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(endpoint, {
      requestInit: { headers: { "X-Expected-Vault-ID": "vault-a" } },
    }),
  );
  return client;
}

/** A durable PREPARED frame the registry is expected to answer for. */
function durablePreparedFrame(
  input: ChangeSetSubmitInput,
  changeSetId: string,
): RecoveryJournalFrame {
  const operation = input.operations[0]!;
  if (operation.kind !== "create_note") throw new Error("frame fixture expects create_note");
  return {
    schemaVersion: RECOVERY_JOURNAL_FRAME_SCHEMA_VERSION,
    vaultId: "vault",
    changeSetId,
    enqueueSeq: 1,
    phase: "PREPARED",
    input: structuredClone(input),
    preview: {
      requestedEffects: [
        {
          operationId: operation.operationId,
          kind: "create_note",
          projectedOutcome: "changed",
        },
      ],
      derivedEffects: [],
      paths: [
        {
          path: operation.path,
          preState: { kind: "absent" },
          projectedFinalState: {
            kind: "markdown",
            contentVersion: `sha256:${createHash("sha256").update(operation.content).digest("hex")}`,
          },
          projectedOutcome: "changed",
        },
      ],
    },
    directories: [],
  };
}

describe("Submission Key replay corpus (issue #195)", () => {
  it("keeps the seven-day retention minimum unchanged", () => {
    // Non-goal: the retention minimum is a fixed surface the corpus exercises.
    expect(RETENTION).toBe(7 * 24 * 60 * 60 * 1_000);
  });

  it("replays the same identity before the registration acknowledgement without another execution", async () => {
    const dir = await reportDir("timing-before-ack");
    const rig = await openRig({});
    const input = noteInput("sk195-before-ack", "Replay/BeforeAck.md", "# before ack\n");

    const gate = rig.store.armSaveGate();
    const first = rig.service.submit(input, OPEN);
    await gate.entered; // the durable binding is being persisted; no ack yet
    const replay = rig.service.submit(input, OPEN); // retry before the ack
    gate.release();
    const [firstResult, replayResult] = await Promise.all([first, replay]);

    expect(firstResult.outcome).toBe("registered");
    expect(replayResult.outcome).toBe("registered");
    expect(canonicalJson(replayResult)).toBe(canonicalJson(firstResult));
    expect(firstResult).toMatchObject({
      outcome: "registered",
      changeSet: { changeSetId: "cs-1", state: "intent_applied" },
    });
    // At-most-once: exactly one binding, one PREPARED frame, one file publish.
    expect(rig.generatedIds()).toBe(1);
    expect(rig.adapter.preparedChangeSetIds.size).toBe(1);
    expect(rig.adapter.filePublishes).toEqual(["Replay/BeforeAck.md"]);

    const reportPath = await writeReport(dir, "before-ack", {
      corpus: "submission_key_retention",
      scenario: "retry_timing/before_registration_ack",
      callOrder: ["submit:original(save in flight)", "submit:retry(before ack)"],
      keyDigests: { primary: digestKey(input.submissionKey) },
      changeSetIds: { primary: "cs-1" },
      executionCounts: { executions: rig.adapter.preparedChangeSetIds.size, filePublishes: rig.adapter.filePublishes.length },
      proofStates: { original: "intent_applied", retry: "intent_applied" },
      registry: { entries: rig.store.state?.entries.length ?? -1, tombstones: rig.store.state?.tombstones.length ?? -1 },
      verdict: "pass",
      cleanup: { success: true, message: "in-memory fixtures; report written by the test" },
    });
    expect(await readFile(reportPath, "utf8")).not.toContain(input.submissionKey);
  });

  it("replays the same identity while executing (before any mutation) and while queued", async () => {
    const dir = await reportDir("timing-executing");
    const rig = await openRig({});
    const inputA = noteInput("sk195-executing-a", "TimingA/Note.md", "# executing a\n", "op-a");
    const inputB = noteInput("sk195-queued-b", "TimingB/Note.md", "# queued b\n", "op-b");

    // A parks inside the execution before any mutation becomes visible.
    const park = rig.adapter.armPark("prepareDirectory");
    const firstA = rig.service.submit(inputA, OPEN);
    await park.parked;

    // Retry of the still-executing A: replays the binding, then queues behind
    // the write lease until A completes.
    const replayA = rig.service.submit(inputA, OPEN);
    // B registers behind A: its entry sits queued in the persisted FIFO.
    const firstB = rig.service.submit(inputB, OPEN);
    // A status lookup observes B's queued in-progress record immediately.
    const statusB = await rig.service.status({ submissionKey: inputB.submissionKey }, OPEN);
    expect(statusB).toMatchObject({
      lookup: "found",
      changeSet: { changeSetId: "cs-2", state: "in_progress" },
    });
    // Retry of the still-queued B.
    const replayB = rig.service.submit(inputB, OPEN);
    park.release();
    const [resultA, resultReplayA, resultB, resultReplayB] = await Promise.all([
      firstA,
      replayA,
      firstB,
      replayB,
    ]);

    expect(canonicalJson(resultReplayA)).toBe(canonicalJson(resultA));
    expect(canonicalJson(resultReplayB)).toBe(canonicalJson(resultB));
    expect(resultA).toMatchObject({ changeSet: { changeSetId: "cs-1", state: "intent_applied" } });
    expect(resultB).toMatchObject({ changeSet: { changeSetId: "cs-2", state: "intent_applied" } });
    expect(rig.generatedIds()).toBe(2);
    expect(
      rig.adapter.filePublishes.filter((path) => path === "TimingA/Note.md"),
    ).toHaveLength(1);
    expect(
      rig.adapter.filePublishes.filter((path) => path === "TimingB/Note.md"),
    ).toHaveLength(1);

    const reportPath = await writeReport(dir, "executing-and-queued", {
      corpus: "submission_key_retention",
      scenario: "retry_timing/executing_and_queued",
      callOrder: [
        "submit:A(parked executing before mutation)",
        "submit:retryA(while executing)",
        "submit:B(queued behind the write lease)",
        "status:B(found in_progress)",
        "submit:retryB(while queued)",
      ],
      keyDigests: { a: digestKey(inputA.submissionKey), b: digestKey(inputB.submissionKey) },
      changeSetIds: { a: "cs-1", b: "cs-2" },
      executionCounts: {
        executions: rig.adapter.preparedChangeSetIds.size,
        filePublishesA: rig.adapter.filePublishes.filter((path) => path === "TimingA/Note.md").length,
        filePublishesB: rig.adapter.filePublishes.filter((path) => path === "TimingB/Note.md").length,
      },
      proofStates: { a: "intent_applied", b: "intent_applied", queuedStatusB: "in_progress" },
      verdict: "pass",
      cleanup: { success: true, message: "in-memory fixtures; report written by the test" },
    });
    expect(await readFile(reportPath, "utf8")).not.toContain(inputA.submissionKey);
    expect(await readFile(reportPath, "utf8")).not.toContain(inputB.submissionKey);
  });

  it("replays the same identity after the mutation, after the durable terminal proof, and after a restart", async () => {
    const dir = await reportDir("timing-after-mutation");
    const store = new MemoryStore();
    const adapter = new CountingExecutionAdapter();
    const rig = await openRig({ store, adapter });
    const input = noteInput("sk195-after-mutation", "Replay/AfterMutation.md", "# after mutation\n");

    // Park after the mutation (file published) but before the durable COMMITTED.
    const park = adapter.armPark("snapshot");
    const first = rig.service.submit(input, OPEN);
    await park.parked;
    expect(adapter.files.has("Replay/AfterMutation.md")).toBe(true);
    expect(adapter.frame?.phase).toBe("PREPARED");
    const replayAfterMutation = rig.service.submit(input, OPEN);
    park.release();
    const [firstResult, mutationReplayResult] = await Promise.all([first, replayAfterMutation]);
    expect(canonicalJson(mutationReplayResult)).toBe(canonicalJson(firstResult));
    expect(adapter.filePublishes).toEqual(["Replay/AfterMutation.md"]);

    // After the durable terminal proof the retry returns the same identity.
    const replayAfterTerminal = await rig.service.submit(input, OPEN);
    expect(canonicalJson(replayAfterTerminal)).toBe(canonicalJson(firstResult));
    expect(rig.generatedIds()).toBe(1);
    expect(adapter.preparedChangeSetIds.size).toBe(1);
    expect(adapter.filePublishes).toHaveLength(1);

    // After a restart the binding, record, and proof state are still answerable.
    const restarted = await openRig({ store, adapter });
    const replayAfterRestart = await restarted.service.submit(input, OPEN);
    expect(canonicalJson(replayAfterRestart)).toBe(canonicalJson(firstResult));
    const status = await restarted.service.status({ submissionKey: input.submissionKey }, OPEN);
    expect(status).toMatchObject({
      lookup: "found",
      changeSet: { changeSetId: "cs-1", state: "intent_applied" },
    });
    expect(adapter.preparedChangeSetIds.size).toBe(1);
    expect(adapter.filePublishes).toHaveLength(1);

    const reportPath = await writeReport(dir, "after-mutation-terminal-restart", {
      corpus: "submission_key_retention",
      scenario: "retry_timing/after_mutation_terminal_restart",
      callOrder: [
        "submit:original(parked after mutation)",
        "submit:retry(after mutation, before COMMITTED)",
        "submit:retry(after durable terminal proof)",
        "restart",
        "submit:retry(after restart)",
        "status:by-key(after restart)",
      ],
      keyDigests: { primary: digestKey(input.submissionKey) },
      changeSetIds: { primary: "cs-1" },
      executionCounts: { executions: adapter.preparedChangeSetIds.size, filePublishes: adapter.filePublishes.length },
      proofStates: { afterMutation: "intent_applied", afterTerminal: "intent_applied", afterRestart: "intent_applied" },
      verdict: "pass",
      cleanup: { success: true, message: "in-memory fixtures; report written by the test" },
    });
    expect(await readFile(reportPath, "utf8")).not.toContain(input.submissionKey);
  });

  it("replays the same identity after a transport disconnect over the real MCP surface", async () => {
    const dir = await reportDir("timing-transport-disconnect");
    const store = new MemoryStore();
    const adapter = new CountingExecutionAdapter();
    const bridge = createBridgeInstance({
      port: 0,
      health: healthState(),
      changeSets: {
        store,
        dataSource: rigDataSource(adapter),
        execution: adapter,
        createChangeSetId: () => "cs-disconnect-1",
      },
    });
    await bridge.start();
    try {
      const input = noteInput("sk195-transport", "Replay/Transport.md", "# transport\n");
      const park = adapter.armPark("snapshot");
      const clientA = await connect(bridge.endpoint);
      const callA = clientA
        .callTool({ name: "vault_change_set_submit", arguments: input })
        .then(
          (result) => ({ kind: "settled" as const, result }),
          () => ({ kind: "disconnected" as const }),
        );
      await park.parked;

      // The retry on a second session stays in flight behind the write lease.
      const clientB = await connect(bridge.endpoint);
      const callB = clientB
        .callTool({ name: "vault_change_set_submit", arguments: input })
        .then(
          (result) => ({ kind: "settled" as const, result }),
          () => ({ kind: "disconnected" as const }),
        );
      // Transport disconnect: the original caller goes away mid-flight.
      await clientA.close();
      park.release();
      const [outcomeA, outcomeB] = await Promise.all([callA, callB]);
      expect(outcomeB.kind).toBe("settled");
      const retried = outcomeB.kind === "settled" ? outcomeB.result : null;
      expect(retried?.structuredContent).toMatchObject({
        outcome: "registered",
        changeSet: { changeSetId: "cs-disconnect-1", state: "intent_applied" },
      });
      expect(adapter.filePublishes).toEqual(["Replay/Transport.md"]);
      await clientB.close();

      // A fresh session after the disconnect observes the same record.
      const clientC = await connect(bridge.endpoint);
      const replayed = await clientC.callTool({
        name: "vault_change_set_submit",
        arguments: input,
      });
      expect(replayed.structuredContent).toMatchObject({
        outcome: "registered",
        changeSet: { changeSetId: "cs-disconnect-1", state: "intent_applied" },
      });
      const status = await clientC.callTool({
        name: "vault_change_set_status",
        arguments: { submissionKey: input.submissionKey },
      });
      expect(status.structuredContent).toMatchObject({
        lookup: "found",
        changeSet: { changeSetId: "cs-disconnect-1", state: "intent_applied" },
      });
      await clientC.close();
      expect(adapter.filePublishes).toHaveLength(1);

      const reportPath = await writeReport(dir, "transport-disconnect", {
        corpus: "submission_key_retention",
        scenario: "retry_timing/transport_disconnect",
        callOrder: [
          "sessionA:submit(parked after mutation)",
          "sessionB:submit retry(in flight behind the write lease)",
          "sessionA:transport-disconnect",
          `sessionA:outcome=${outcomeA.kind}`,
          `sessionB:outcome=${outcomeB.kind}`,
          "sessionC:submit retry(after reconnect)",
          "sessionC:status(after reconnect)",
        ],
        keyDigests: { primary: digestKey(input.submissionKey) },
        changeSetIds: { primary: "cs-disconnect-1" },
        executionCounts: { filePublishes: adapter.filePublishes.length },
        proofStates: { retryAfterDisconnect: "intent_applied" },
        verdict: "pass",
        cleanup: { success: true, message: "bridge stopped by the test" },
      });
      expect(await readFile(reportPath, "utf8")).not.toContain(input.submissionKey);
    } finally {
      await bridge.stop();
    }
  });

  it("binds concurrent same-key/same-request submissions once and executes at most once", async () => {
    const dir = await reportDir("concurrent-same-request");
    const rig = await openRig({});
    const input = noteInput("sk195-concurrent", "Replay/Concurrent.md", "# concurrent\n");

    const results = await Promise.all([
      rig.service.submit(input, OPEN),
      rig.service.submit(input, OPEN),
      rig.service.submit(input, OPEN),
      rig.service.submit(input, OPEN),
    ]);

    for (const result of results) {
      expect(canonicalJson(result)).toBe(canonicalJson(results[0]));
    }
    expect(results[0]).toMatchObject({
      outcome: "registered",
      changeSet: { changeSetId: "cs-1", state: "intent_applied" },
    });
    // One binding, one execution.
    expect(rig.generatedIds()).toBe(1);
    expect(rig.store.state?.entries).toHaveLength(1);
    expect(rig.adapter.preparedChangeSetIds.size).toBe(1);
    expect(rig.adapter.filePublishes).toEqual(["Replay/Concurrent.md"]);

    const reportPath = await writeReport(dir, "concurrent-same-request", {
      corpus: "submission_key_retention",
      scenario: "concurrency/same_key_same_request",
      callOrder: ["issue:submit×4(same key, same request)", "settled:4 identical registered results"],
      keyDigests: { primary: digestKey(input.submissionKey) },
      changeSetIds: { primary: "cs-1" },
      executionCounts: { executions: rig.adapter.preparedChangeSetIds.size, filePublishes: rig.adapter.filePublishes.length },
      proofStates: { all: "intent_applied" },
      registry: { entries: rig.store.state?.entries.length ?? -1, tombstones: 0 },
      verdict: "pass",
      cleanup: { success: true, message: "in-memory fixtures; report written by the test" },
    });
    expect(await readFile(reportPath, "utf8")).not.toContain(input.submissionKey);
  });

  it("resolves concurrent same-key/different-request races deterministically without changing the original binding", async () => {
    const dir = await reportDir("concurrent-different-request");
    const inputX = noteInput("sk195-race", "Race/X.md", "# x\n", "op-x");
    const inputY = noteInput("sk195-race", "Race/Y.md", "# y\n", "op-y");

    const races: { winner: string; loser: string; winnerId: string }[] = [];
    for (const order of ["XY", "YX"] as const) {
      const rig = await openRig({});
      const [first, second] = order === "XY" ? [inputX, inputY] : [inputY, inputX];
      const [firstResult, secondResult] = await Promise.all([
        rig.service.submit(first, OPEN),
        rig.service.submit(second, OPEN),
      ]);
      // Deterministic by call order: the first submission binds; the racing
      // different request returns submission_key_conflict.
      expect(firstResult).toMatchObject({
        outcome: "registered",
        changeSet: { changeSetId: "cs-1", state: "intent_applied" },
      });
      expect(secondResult).toEqual({ outcome: "submission_key_conflict" });
      // The original binding and record are unchanged by the race.
      expect(rig.store.state?.entries).toHaveLength(1);
      expect(rig.store.state?.entries[0]?.fingerprint).toBe(
        fingerprintChangeSetRequest(first),
      );
      expect(rig.adapter.filePublishes).toEqual([
        order === "XY" ? "Race/X.md" : "Race/Y.md",
      ]);
      // Both dispositions stay stable on replay.
      const replayWinner = await rig.service.submit(first, OPEN);
      expect(replayWinner).toMatchObject({
        outcome: "registered",
        changeSet: { changeSetId: "cs-1", state: "intent_applied" },
      });
      const replayLoser = await rig.service.submit(second, OPEN);
      expect(replayLoser).toEqual({ outcome: "submission_key_conflict" });
      races.push({
        winner: order === "XY" ? "Race/X.md" : "Race/Y.md",
        loser: order === "XY" ? "Race/Y.md" : "Race/X.md",
        winnerId: "cs-1",
      });
    }

    const reportPath = await writeReport(dir, "concurrent-different-request", {
      corpus: "submission_key_retention",
      scenario: "concurrency/same_key_different_request",
      callOrder: races.map((race, index) => `race${index}:winner=${race.winner},loser=${race.loser}`),
      keyDigests: { raced: digestKey("sk195-race") },
      fingerprints: {
        x: fingerprintChangeSetRequest(inputX),
        y: fingerprintChangeSetRequest(inputY),
      },
      proofStates: { winner: "intent_applied", loser: "submission_key_conflict" },
      verdict: "pass",
      cleanup: { success: true, message: "in-memory fixtures; report written by the test" },
    });
    const reportText = await readFile(reportPath, "utf8");
    expect(reportText).not.toContain("sk195-race");
  });

  it("walks just-before, exact, and just-after retention boundaries with an injected clock", async () => {
    const dir = await reportDir("retention-boundaries");
    const T0 = 1_700_000_000_000;
    let now = T0;
    const rig = await openRig({ now: () => now });
    const input = noteInput("sk195-retention", "Replay/Retention.md", "# retention\n");

    const first = await rig.service.submit(input, OPEN);
    expect(first).toMatchObject({
      outcome: "registered",
      changeSet: { changeSetId: "cs-1", state: "intent_applied" },
    });
    const entry = rig.store.state?.entries[0];
    expect(entry?.acceptedAt).toBe(T0);
    expect(entry?.expiresAt).toBe(T0 + RETENTION);

    // Just before the boundary: the eligible record is not removed early, and
    // a replay still returns the same identity.
    now = T0 + RETENTION - 1;
    const justBefore = await rig.service.status({ submissionKey: input.submissionKey }, OPEN);
    expect(justBefore).toMatchObject({
      lookup: "found",
      changeSet: { changeSetId: "cs-1", state: "intent_applied" },
    });
    const replayJustBefore = await rig.service.submit(input, OPEN);
    expect(canonicalJson(replayJustBefore)).toBe(canonicalJson(first));
    expect(rig.store.state?.entries).toHaveLength(1);
    expect(rig.store.state?.tombstones).toHaveLength(0);

    // Exact boundary: the record expires into a tombstone.
    now = T0 + RETENTION;
    const exact = await rig.service.status({ submissionKey: input.submissionKey }, OPEN);
    expect(exact).toEqual({
      lookup: "expired",
      vault: { writeGate: "open", writeState: "writable" },
    });
    const exactById = await rig.service.status({ changeSetId: "cs-1" }, OPEN);
    expect(exactById.lookup).toBe("expired");
    expect(rig.store.state?.entries).toHaveLength(0);
    expect(rig.store.state?.tombstones).toEqual([
      { submissionKey: input.submissionKey, changeSetId: "cs-1" },
    ]);

    // Just after: the tombstone keeps the key from ever being rebound.
    now = T0 + RETENTION + 1;
    const replayAfter = await rig.service.submit(input, OPEN);
    expect(replayAfter).toEqual({ outcome: "submission_key_conflict" });
    const rebind = await rig.service.submit(
      noteInput(input.submissionKey, "Replay/Rebound.md", "# rebound\n", "op-rebound"),
      OPEN,
    );
    expect(rebind).toEqual({ outcome: "submission_key_conflict" });
    const after = await rig.service.status({ submissionKey: input.submissionKey }, OPEN);
    expect(after.lookup).toBe("expired");
    // A key nothing requires an answer for keeps the ordinary unknown disposition.
    const neverSeen = await rig.service.status({ submissionKey: "sk195-never-seen" }, OPEN);
    expect(neverSeen.lookup).toBe("unknown");
    expect(rig.generatedIds()).toBe(1);

    const reportPath = await writeReport(dir, "retention-boundaries", {
      corpus: "submission_key_retention",
      scenario: "retention/seven_day_boundaries",
      deterministicTimeMs: {
        acceptedAt: T0,
        expiresAt: T0 + RETENTION,
        justBefore: T0 + RETENTION - 1,
        exact: T0 + RETENTION,
        justAfter: T0 + RETENTION + 1,
        retentionMs: RETENTION,
      },
      keyDigests: { primary: digestKey(input.submissionKey) },
      changeSetIds: { primary: "cs-1" },
      proofStates: { justBefore: "found", exact: "expired", justAfter: "expired" },
      dispositions: {
        replayJustBefore: "registered",
        replayJustAfter: "submission_key_conflict",
        rebindJustAfter: "submission_key_conflict",
        neverSeen: "unknown",
      },
      registry: { entries: 0, tombstones: 1 },
      verdict: "pass",
      cleanup: { success: true, message: "in-memory fixtures; report written by the test" },
    });
    const reportText = await readFile(reportPath, "utf8");
    expect(reportText).not.toContain(input.submissionKey);
  });

  it("never expires a record while an active execution or queued entry still references it", async () => {
    const dir = await reportDir("retention-active-race");
    const T0 = 1_700_000_000_000;
    let now = T0;
    const rig = await openRig({ now: () => now });
    const inputA = noteInput("sk195-active-a", "ActiveA/Note.md", "# active a\n", "op-a");
    const inputB = noteInput("sk195-active-b", "ActiveB/Note.md", "# active b\n", "op-b");

    // A parks mid-execution; B registers queued behind the write lease. The
    // clock only advances once B's binding is durable (its queue position is
    // observable), so both records share the same acceptance time.
    const park = rig.adapter.armPark("snapshot");
    const firstA = rig.service.submit(inputA, OPEN);
    await park.parked;
    const firstB = rig.service.submit(inputB, OPEN);
    const queuedB = await rig.service.status({ submissionKey: inputB.submissionKey }, OPEN);
    expect(queuedB).toMatchObject({
      lookup: "found",
      changeSet: { changeSetId: "cs-2", state: "in_progress" },
    });

    // The retention boundary passes while both records are still active.
    now = T0 + 30 * 24 * 60 * 60 * 1_000;
    const statusA = await rig.service.status({ submissionKey: inputA.submissionKey }, OPEN);
    expect(statusA).toMatchObject({
      lookup: "found",
      changeSet: { changeSetId: "cs-1", state: "in_progress" },
    });
    const statusB = await rig.service.status({ submissionKey: inputB.submissionKey }, OPEN);
    expect(statusB.lookup).toBe("found");
    expect(rig.store.state?.entries).toHaveLength(2);
    expect(rig.store.state?.tombstones).toHaveLength(0);

    // The queue was not raced by expiry: both execute in FIFO order.
    park.release();
    const [resultA, resultB] = await Promise.all([firstA, firstB]);
    expect(resultA).toMatchObject({ changeSet: { changeSetId: "cs-1", state: "intent_applied" } });
    expect(resultB).toMatchObject({ changeSet: { changeSetId: "cs-2", state: "intent_applied" } });
    expect(rig.adapter.filePublishes).toEqual(["ActiveA/Note.md", "ActiveB/Note.md"]);

    // Once terminal, the same clock expires both records into tombstones.
    const expiredA = await rig.service.status({ submissionKey: inputA.submissionKey }, OPEN);
    expect(expiredA.lookup).toBe("expired");
    expect(rig.store.state?.entries).toHaveLength(0);
    expect(rig.store.state?.tombstones).toHaveLength(2);

    const reportPath = await writeReport(dir, "retention-active-race", {
      corpus: "submission_key_retention",
      scenario: "retention/expiry_cannot_race_active_execution",
      deterministicTimeMs: { acceptedAt: T0, expiryProbe: T0 + 30 * 24 * 60 * 60 * 1_000 },
      callOrder: [
        "submit:A(parked after mutation)",
        "submit:B(queued)",
        "status:B(found in_progress, queued binding durable)",
        "clock:+30d",
        "status:A(found in_progress, retained)",
        "status:B(found, retained)",
        "release; A and B complete in FIFO order",
        "status:A(expired once terminal)",
      ],
      keyDigests: { a: digestKey(inputA.submissionKey), b: digestKey(inputB.submissionKey) },
      changeSetIds: { a: "cs-1", b: "cs-2" },
      executionCounts: { filePublishes: rig.adapter.filePublishes.length },
      verdict: "pass",
      cleanup: { success: true, message: "in-memory fixtures; report written by the test" },
    });
    const reportText = await readFile(reportPath, "utf8");
    expect(reportText).not.toContain(inputA.submissionKey);
    expect(reportText).not.toContain(inputB.submissionKey);
  });

  it("fails closed when a missing or truncated registry cannot answer a live Recovery Journal frame", async () => {
    const dir = await reportDir("failclosed-missing-truncated");
    const input = noteInput("sk195-unanswerable", "Recovered/Note.md", "# unanswerable\n");
    const frame = durablePreparedFrame(input, "cs-unanswerable");

    for (const variant of ["missing", "truncated"] as const) {
      const store = new MemoryStore();
      if (variant === "truncated") {
        // Structurally valid but the live entry was dropped.
        store.state = {
          schemaVersion: 2,
          nextEnqueueSeq: 9,
          entries: [],
          tombstones: [],
        };
      }
      const adapter = new CountingExecutionAdapter();
      adapter.frame = frame;
      const rig = await openRig({ store, adapter });

      // Startup recovery failed closed without mutating anything.
      expect(rig.runtime.blocked).toEqual(["unknown"]);
      expect(adapter.filePublishes).toHaveLength(0);
      expect(adapter.directoryPublishes).toHaveLength(0);

      // The still-required key/identity must not degrade to ordinary `unknown`.
      const byKey = await rig.service.status({ submissionKey: input.submissionKey }, RECOVERY_BLOCKED);
      expect(byKey).toEqual({
        lookup: "operationally_blocked",
        gate: { code: "recovery_blocked" },
      });
      const byId = await rig.service.status({ changeSetId: "cs-unanswerable" }, RECOVERY_BLOCKED);
      expect(byId).toEqual({
        lookup: "operationally_blocked",
        gate: { code: "recovery_blocked" },
      });
      const unrelated = await rig.service.status({ submissionKey: "sk195-unrelated" }, RECOVERY_BLOCKED);
      expect(unrelated.lookup).toBe("unknown");

      // A resubmission under the blocked gate binds the historical disposition
      // without executing, and status then reports that disposition.
      const resubmitted = await rig.service.submit(input, RECOVERY_BLOCKED);
      expect(resubmitted).toMatchObject({
        outcome: "registered",
        changeSet: { state: "intent_not_applied" },
        gate: { code: "recovery_blocked" },
      });
      expect(adapter.filePublishes).toHaveLength(0);
    }

    const reportPath = await writeReport(dir, "failclosed-missing-truncated", {
      corpus: "submission_key_retention",
      scenario: "fail_closed/registry_missing_or_truncated",
      callOrder: [
        "open(recovery journal references an unanswerable Change Set)",
        "status:by-key(operationally_blocked, not unknown)",
        "status:by-id(operationally_blocked)",
        "status:unrelated(unknown)",
        "submit:resubmission under recovery_blocked(historical bind, no execution)",
      ],
      keyDigests: { unanswerable: digestKey(input.submissionKey) },
      changeSetIds: { unanswerable: "cs-unanswerable" },
      executionCounts: { filePublishes: 0, directoryPublishes: 0 },
      gates: { effective: "recovery_blocked" },
      verdict: "pass",
      cleanup: { success: true, message: "in-memory fixtures; report written by the test" },
    });
    expect(await readFile(reportPath, "utf8")).not.toContain(input.submissionKey);
  });

  it("fails closed when the registry disagrees with the Recovery Journal, and refuses a corrupt registry", async () => {
    const dir = await reportDir("failclosed-inconsistent-corrupt");
    const input = noteInput("sk195-inconsistent", "Recovered/Inconsistent.md", "# inconsistent\n");
    const frame = durablePreparedFrame(input, "cs-inconsistent");

    // Inconsistent: the registry entry exists but its fingerprint does not
    // match the journaled request — recovery marks it unproven instead of
    // answering from untrusted state.
    const store = new MemoryStore();
    store.state = {
      schemaVersion: 2,
      nextEnqueueSeq: 2,
      entries: [
        {
          submissionKey: input.submissionKey,
          fingerprint: `sha256:${"0".repeat(64)}`,
          changeSetId: "cs-inconsistent",
          enqueueSeq: 1,
          acceptedAt: 0,
          expiresAt: RETENTION,
          execution: { phase: "executing", input: structuredClone(input) },
          changeSet: {
            changeSetId: "cs-inconsistent",
            state: "in_progress",
            preview: frame.preview,
          },
        },
      ],
      tombstones: [],
    };
    const adapter = new CountingExecutionAdapter();
    adapter.frame = frame;
    const rig = await openRig({ store, adapter, now: () => 0 });
    expect(rig.runtime.blocked).toEqual(["cs-inconsistent"]);
    const unproven = await rig.service.status({ submissionKey: input.submissionKey }, RECOVERY_BLOCKED);
    expect(unproven).toMatchObject({
      lookup: "found",
      changeSet: { changeSetId: "cs-inconsistent", state: "result_unproven" },
    });
    expect(adapter.filePublishes).toHaveLength(0);

    // Corrupt: the registry cannot be parsed at all, so the service refuses to
    // open (the managed runtime turns this into a refused boot; covered
    // end-to-end by the headless corrupt-registry scenario).
    const corruptStore = new MemoryStore();
    corruptStore.state = "corrupt-not-a-registry" as unknown as ChangeSetRegistryState;
    await expect(
      openRig({ store: corruptStore, adapter: new CountingExecutionAdapter() }),
    ).rejects.toThrow("corrupt or incompatible");

    // A tombstone must not downgrade a live PREPARED frame to `expired`.
    const tombstoned = new MemoryStore();
    tombstoned.state = {
      schemaVersion: 2,
      nextEnqueueSeq: 5,
      entries: [],
      tombstones: [{ submissionKey: input.submissionKey, changeSetId: "cs-inconsistent" }],
    };
    const tombstonedAdapter = new CountingExecutionAdapter();
    tombstonedAdapter.frame = frame;
    const tombstonedRig = await openRig({ store: tombstoned, adapter: tombstonedAdapter, now: () => 0 });
    expect(tombstonedRig.runtime.blocked).toEqual(["unknown"]);
    const blockedInsteadOfExpired = await tombstonedRig.service.status(
      { submissionKey: input.submissionKey },
      RECOVERY_BLOCKED,
    );
    expect(blockedInsteadOfExpired).toEqual({
      lookup: "operationally_blocked",
      gate: { code: "recovery_blocked" },
    });

    const reportPath = await writeReport(dir, "failclosed-inconsistent-corrupt", {
      corpus: "submission_key_retention",
      scenario: "fail_closed/registry_inconsistent_corrupt_tombstoned",
      callOrder: [
        "open(fingerprint mismatch → result_unproven, blocked)",
        "status:by-key(found result_unproven)",
        "open(corrupt registry → refused)",
        "open(tombstone + live PREPARED → blocked, not expired)",
      ],
      keyDigests: { inconsistent: digestKey(input.submissionKey) },
      changeSetIds: { inconsistent: "cs-inconsistent" },
      gates: { effective: "recovery_blocked" },
      executionCounts: { filePublishes: 0 },
      verdict: "pass",
      cleanup: { success: true, message: "in-memory fixtures; report written by the test" },
    });
    expect(await readFile(reportPath, "utf8")).not.toContain(input.submissionKey);
  });

  it("keeps a recovery_blocked bind and its ordinary status view stable across restart and retention", async () => {
    const dir = await reportDir("blocked-disposition");
    const T0 = 1_700_000_000_000;
    let now = T0;
    const store = new MemoryStore();
    const adapter = new CountingExecutionAdapter();
    const input = noteInput("sk195-blocked", "Blocked/Note.md", "# blocked\n");

    const rig = await openRig({ store, adapter, now: () => now });
    const submitted = await rig.service.submit(input, RECOVERY_BLOCKED);
    expect(submitted).toMatchObject({
      outcome: "registered",
      changeSet: { changeSetId: "cs-1", state: "intent_not_applied" },
      gate: { code: "recovery_blocked" },
    });
    // A blocked disposition never executes and never touches the data source.
    expect(adapter.preparedChangeSetIds.size).toBe(0);
    expect(adapter.filePublishes).toHaveLength(0);

    const replayed = await rig.service.submit(input, RECOVERY_BLOCKED);
    expect(canonicalJson(replayed)).toBe(canonicalJson(submitted));
    const status = await rig.service.status({ submissionKey: input.submissionKey }, RECOVERY_BLOCKED);
    expect(status).toMatchObject({
      lookup: "found",
      changeSet: { changeSetId: "cs-1", state: "intent_not_applied" },
    });
    expect(status).not.toHaveProperty("gate");

    // Across a restart the historical bind/replay disposition is stable, even
    // after the current gate clears: the replay still reports the historical
    // gate while the ordinary status view omits it.
    const restarted = await openRig({ store, adapter, now: () => now });
    const replayedAfterRestart = await restarted.service.submit(input, RECOVERY_BLOCKED);
    expect(canonicalJson(replayedAfterRestart)).toBe(canonicalJson(submitted));
    const replayedGateCleared = await restarted.service.submit(input, OPEN);
    expect(replayedGateCleared).toMatchObject({
      outcome: "registered",
      changeSet: { changeSetId: "cs-1", state: "intent_not_applied" },
      gate: { code: "recovery_blocked" },
    });
    const statusAfterRestart = await restarted.service.status(
      { submissionKey: input.submissionKey },
      OPEN,
    );
    expect(statusAfterRestart).toMatchObject({
      lookup: "found",
      changeSet: { changeSetId: "cs-1", state: "intent_not_applied" },
    });
    expect(statusAfterRestart).not.toHaveProperty("gate");

    // Retention processing: the bind expires into a tombstone at the boundary
    // and the key can never be rebound.
    now = T0 + RETENTION;
    const expired = await restarted.service.status({ submissionKey: input.submissionKey }, OPEN);
    expect(expired.lookup).toBe("expired");
    const replayedAfterExpiry = await restarted.service.submit(input, OPEN);
    expect(replayedAfterExpiry).toEqual({ outcome: "submission_key_conflict" });
    expect(rig.generatedIds()).toBe(1);

    const reportPath = await writeReport(dir, "blocked-disposition", {
      corpus: "submission_key_retention",
      scenario: "recovery_blocked/disposition_stability",
      deterministicTimeMs: { acceptedAt: T0, expiresAt: T0 + RETENTION },
      callOrder: [
        "submit(under recovery_blocked → historical bind)",
        "submit:replay(identical)",
        "status(found, no gate)",
        "restart",
        "submit:replay(identical, gate persisted)",
        "submit:replay with cleared gate(historical gate returned)",
        "status(found, no gate)",
        "clock:+7d → status(expired), replay(submission_key_conflict)",
      ],
      keyDigests: { primary: digestKey(input.submissionKey) },
      changeSetIds: { primary: "cs-1" },
      gates: { historical: "recovery_blocked", statusView: null },
      executionCounts: { preparedFrames: 0, filePublishes: 0 },
      proofStates: { bind: "intent_not_applied", afterRetention: "expired" },
      verdict: "pass",
      cleanup: { success: true, message: "in-memory fixtures; report written by the test" },
    });
    expect(await readFile(reportPath, "utf8")).not.toContain(input.submissionKey);
  });
});

// ---------------------------------------------------------------------------
// Real owning-process proof: reconnects, process crashes, and restarts through
// the production Bridge MCP surface.
// ---------------------------------------------------------------------------

function assertHeadlessPass(evidence: SubmissionKeyCorpusEvidence): void {
  expect(evidence.failures, JSON.stringify(evidence, null, 2)).toEqual([]);
  expect(evidence.verdict).toBe("pass");
  expect(evidence.cleanup.success).toBe(true);
}

async function assertReportRedacted(evidence: SubmissionKeyCorpusEvidence, rawKeys: string[]): Promise<void> {
  const onDisk = JSON.parse(await readFile(evidence.reportPath, "utf8")) as { verdict?: string };
  expect(onDisk.verdict).toBe("pass");
  const text = await readFile(evidence.reportPath, "utf8");
  for (const key of rawKeys) {
    expect(text, `report must never contain the raw Submission Key ${digestKey(key)}`).not.toContain(key);
  }
}

describe("Submission Key corpus through the real owning process (issue #195)", () => {
  const profile = createNoteCorpusProfile();

  it(
    "preserves the accepted binding and complete record across reconnect and restart without re-execution",
    async () => {
      const seed = "sk195-replay";
      const evidence = await runSubmissionKeyReplayScenario({
        profile,
        seed,
        reportDir: await reportDir("headless-replay"),
      });

      assertHeadlessPass(evidence);
      expect(evidence.changeSetIds.primary).toBeDefined();
      expect(evidence.generations.map(({ generation }) => generation)).toEqual([1, 2]);
      expect(evidence.generations[0]?.executionRuns).toBe(1);
      expect(evidence.generations[1]?.executionRuns).toBe(0);
      expect(evidence.generations[1]?.recoveryRuns).toBe(0);

      // The complete record — immutable preview, requested/derived effect
      // identities and order, final paths, and proof state — is identical on
      // every surface: same session, reconnected session, status by key/id,
      // and after the restart.
      const original = evidence.results.original as Record<string, unknown>;
      const originalChangeSet = original.changeSet as Record<string, unknown>;
      expect(originalChangeSet.state).toBe("intent_applied");
      for (const label of [
        "replaySameSession",
        "replayReconnectedSession",
        "replayAfterRestart",
      ] as const) {
        expect(evidence.results[label]).toEqual(original);
      }
      for (const label of ["statusByKey", "statusByChangeSetId"] as const) {
        const status = evidence.results[label] as Record<string, unknown>;
        expect(status.lookup).toBe("found");
        expect(status.changeSet).toEqual(originalChangeSet);
      }
      expect(originalChangeSet.paths).toEqual([
        expect.objectContaining({ path: "Corpus" }),
        expect.objectContaining({ path: "Corpus/Notes" }),
        expect.objectContaining({ path: CREATE_NOTE_PATH }),
      ]);

      // The persisted registry holds exactly one binding with the seven-day
      // retention window; the report records the key only as a digest.
      expect(evidence.registryAfter?.entryCount).toBe(1);
      const persisted = evidence.registryAfter?.entries[0];
      expect(persisted?.keyDigest).toBe(digestKey(profile.submissionKey(seed)));
      expect(persisted?.state).toBe("intent_applied");
      expect(persisted?.executionPhase).toBe("terminal");
      expect(persisted?.retentionMs).toBe(RETENTION);
      expect(evidence.keyDigests.primary).toBe(digestKey(profile.submissionKey(seed)));
      await assertReportRedacted(evidence, [profile.submissionKey(seed)]);
    },
    180_000,
  );

  it(
    "answers an in-flight replay after a crash at after_prepared with the same identity and a rolled-back record",
    async () => {
      const seed = "sk195-crash-prepared";
      const evidence = await runSubmissionKeyCrashReplayScenario({
        profile,
        seed,
        reportDir: await reportDir("headless-crash-prepared"),
        crashPoint: "after_prepared",
        expectedProof: "intent_not_applied",
      });

      assertHeadlessPass(evidence);
      expect(evidence.generations.map(({ generation }) => generation)).toEqual([1, 2]);
      expect(evidence.generations[0]?.outcome).toBe("parked_then_terminated");
      expect(evidence.generations[1]?.executionRuns).toBe(0);
      // Recovery rolled the parked Change Set back instead of re-executing it.
      expect(evidence.generations[1]?.recoveryRuns).toBeGreaterThanOrEqual(1);

      // While parked, the in-progress record was already queryable under the
      // same identity; the post-restart replay returns that identity at the
      // converged terminal proof.
      const parked = evidence.results.parkedStatus as Record<string, unknown>;
      expect(parked.lookup).toBe("found");
      expect((parked.changeSet as Record<string, unknown>).changeSetId).toBe(
        evidence.changeSetIds.primary,
      );
      const replayed = evidence.results.replayAfterRestart as Record<string, unknown>;
      expect(replayed.outcome).toBe("registered");
      expect(replayed.changeSet).toMatchObject({
        changeSetId: evidence.changeSetIds.primary,
        state: "intent_not_applied",
      });
      expect(evidence.registryAfter?.entryCount).toBe(1);
      expect(evidence.registryAfter?.entries[0]?.state).toBe("intent_not_applied");
      expect(evidence.registryAfter?.entries[0]?.executionPhase).toBe("terminal");
      await assertReportRedacted(evidence, [profile.submissionKey(seed)]);
    },
    180_000,
  );

  it(
    "answers an in-flight replay after a crash at after_committed with the same identity and the applied record",
    async () => {
      const seed = "sk195-crash-committed";
      const evidence = await runSubmissionKeyCrashReplayScenario({
        profile,
        seed,
        reportDir: await reportDir("headless-crash-committed"),
        crashPoint: "after_committed",
        expectedProof: "intent_applied",
      });

      assertHeadlessPass(evidence);
      expect(evidence.generations[1]?.executionRuns).toBe(0);
      expect(evidence.generations[1]?.recoveryRuns).toBe(0);
      const replayed = evidence.results.replayAfterRestart as Record<string, unknown>;
      expect(replayed.changeSet).toMatchObject({
        changeSetId: evidence.changeSetIds.primary,
        state: "intent_applied",
      });
      expect(evidence.registryAfter?.entries[0]?.state).toBe("intent_applied");
      await assertReportRedacted(evidence, [profile.submissionKey(seed)]);
    },
    180_000,
  );

  it(
    "keeps a recovery_blocked bind/replay disposition and its ordinary status view stable across generations",
    async () => {
      const seed = "sk195-blocked";
      const residueBytes = textEncoder.encode(
        "# Third-party residue 你好\n\nForeign bytes no Change Set wrote.\n",
      );
      const evidence = await runSubmissionKeyRecoveryBlockedScenario({
        profile,
        seed,
        reportDir: await reportDir("headless-blocked"),
        residueBytes,
        blockedNotePath: "Corpus/Notes/Blocked.md",
      });

      assertHeadlessPass(evidence);
      expect(evidence.generations.map(({ generation }) => generation)).toEqual([2, 3]);
      for (const generation of evidence.generations) {
        expect(generation.effectiveGate).toBe("recovery_blocked");
        expect(generation.executionRuns).toBe(0);
      }

      const blockedFirst = evidence.results.blockedFirst as Record<string, unknown>;
      expect(blockedFirst.outcome).toBe("registered");
      expect(blockedFirst.changeSet).toMatchObject({ state: "intent_not_applied" });
      expect(blockedFirst.gate).toEqual({ code: "recovery_blocked" });
      expect(evidence.results.blockedReplay).toEqual(blockedFirst);
      expect(evidence.results.restartedReplay).toEqual(blockedFirst);
      for (const label of ["blockedStatus", "restartedStatus"] as const) {
        const status = evidence.results[label] as Record<string, unknown>;
        expect(status.lookup).toBe("found");
        expect(status).not.toHaveProperty("gate");
      }
      // The unproven original record survives both restarts.
      for (const label of ["originalStatus", "restartedOriginal"] as const) {
        const status = evidence.results[label] as Record<string, unknown>;
        expect(status.changeSet).toMatchObject({ state: "result_unproven" });
      }

      // Both bindings persist with the seven-day window and the historical
      // gate provenance recorded only on the blocked submission.
      expect(evidence.registryAfter?.entryCount).toBe(2);
      const byDigest = new Map(
        (evidence.registryAfter?.entries ?? []).map((entry) => [entry.keyDigest, entry]),
      );
      const original = byDigest.get(digestKey(profile.submissionKey(seed)));
      const blocked = byDigest.get(digestKey(profile.submissionKey(`${seed}-blocked`)));
      expect(original?.state).toBe("result_unproven");
      expect(original?.historicalGate).toBeNull();
      expect(blocked?.state).toBe("intent_not_applied");
      expect(blocked?.historicalGate).toBe("recovery_blocked");
      expect(original?.retentionMs).toBe(RETENTION);
      expect(blocked?.retentionMs).toBe(RETENTION);
      await assertReportRedacted(evidence, [
        profile.submissionKey(seed),
        profile.submissionKey(`${seed}-blocked`),
      ]);
    },
    180_000,
  );

  it(
    "fails closed (blocked, never ordinary unknown) when the registry is missing but the Recovery Journal still requires an answer",
    async () => {
      const seed = "sk195-registry-missing";
      const evidence = await runSubmissionKeyRegistryFaultScenario({
        profile,
        seed,
        reportDir: await reportDir("headless-registry-missing"),
        fault: "missing",
      });

      assertHeadlessPass(evidence);
      // The pre-fault registry held the parked executing entry.
      expect(evidence.registryBefore?.entryCount).toBe(1);
      expect(evidence.registryBefore?.entries[0]?.executionPhase).toBe("executing");
      // Generation 2 booted into the blocked state; recovery never began.
      expect(evidence.generations[1]?.outcome).toBe("ready");
      expect(evidence.generations[1]?.executionRuns).toBe(0);
      expect(evidence.generations[1]?.recoveryRuns).toBe(0);
      expect(evidence.generations[1]?.effectiveGate).toBe("recovery_blocked");
      const statusByKey = evidence.results.statusByKey as Record<string, unknown>;
      expect(statusByKey.lookup).toBe("operationally_blocked");
      expect(statusByKey.gate).toEqual({ code: "recovery_blocked" });
      expect(
        (evidence.results.unrelatedStatus as Record<string, unknown>).lookup,
      ).toBe("unknown");
      // Public state is byte-identical across the fault: recovery never mutated.
      expect(evidence.after).toEqual(evidence.before);
      await assertReportRedacted(evidence, [profile.submissionKey(seed)]);
    },
    180_000,
  );

  it(
    "refuses to boot over a corrupt registry without touching public state",
    async () => {
      const seed = "sk195-registry-corrupt";
      const evidence = await runSubmissionKeyRegistryFaultScenario({
        profile,
        seed,
        reportDir: await reportDir("headless-registry-corrupt"),
        fault: "corrupt",
      });

      assertHeadlessPass(evidence);
      expect(evidence.registryBefore?.entryCount).toBe(1);
      expect(evidence.generations[1]?.outcome).toBe("boot_refused");
      expect(evidence.after).toEqual(evidence.before);
      await assertReportRedacted(evidence, [profile.submissionKey(seed)]);
    },
    180_000,
  );
});
