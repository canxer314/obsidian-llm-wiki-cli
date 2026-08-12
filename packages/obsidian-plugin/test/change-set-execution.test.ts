import { mkdir, mkdtemp, rename, rm, rmdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { ChangeSetRecord } from "@llm-wiki/vault-contracts";

import {
  ChangeSetService,
  InjectedChangeSetCrash,
  createFileSystemChangeSetExecutionAdapter,
  type ChangeSetExecutionAdapter,
  type ChangeSetRegistryState,
  type ChangeSetRegistryStore,
  type RecoveryJournalFrame,
} from "../src/index.js";

class MemoryStore implements ChangeSetRegistryStore {
  state: ChangeSetRegistryState | undefined;
  failWhen: ((state: ChangeSetRegistryState) => boolean) | undefined;

  async load(): Promise<unknown> {
    return structuredClone(this.state);
  }

  async save(state: ChangeSetRegistryState): Promise<void> {
    if (this.failWhen?.(state) === true) {
      this.failWhen = undefined;
      throw new Error("injected registry failure");
    }
    this.state = structuredClone(state);
  }
}

class DirectoryAdapter implements ChangeSetExecutionAdapter {
  readonly directories = new Set<string>();
  readonly identities = new Map<string, string>();
  readonly prepared = new Map<string, string>();
  readonly events: string[] = [];
  frame: RecoveryJournalFrame | null = null;
  #nextIdentity = 0;

  async loadRecoveryFrame(): Promise<RecoveryJournalFrame | null> {
    return structuredClone(this.frame);
  }

  async persistRecoveryFrame(frame: RecoveryJournalFrame): Promise<void> {
    this.events.push(`journal:${frame.phase}`);
    this.frame = structuredClone(frame);
  }

  async pathKind(path: string): Promise<"directory" | "file" | null> {
    this.events.push(`inspect:${path}`);
    return this.directories.has(path) ? "directory" : null;
  }

  async directoryIdentity(path: string): Promise<string | null> {
    return this.identities.get(path) ?? null;
  }

  async prepareDirectory(stageId: string): Promise<string> {
    this.#nextIdentity += 1;
    const identity = `directory-${this.#nextIdentity}`;
    this.prepared.set(stageId, identity);
    return identity;
  }

  async publishDirectory(stageId: string, path: string): Promise<void> {
    this.events.push(`mkdir:${path}`);
    this.directories.add(path);
    const identity = this.prepared.get(stageId);
    if (identity === undefined) throw new Error("prepared directory is missing");
    this.prepared.delete(stageId);
    this.identities.set(path, identity);
  }

  async discardPreparedDirectory(stageId: string): Promise<void> {
    this.prepared.delete(stageId);
  }

  async removeDirectory(path: string): Promise<void> {
    this.events.push(`rmdir:${path}`);
    this.directories.delete(path);
    this.identities.delete(path);
  }

  async publishSearchSnapshot(): Promise<void> {
    this.events.push("snapshot");
  }
}

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

const requestState = {
  vault: { writeGate: "open", writeState: "writable" } as const,
  effectiveGate: null,
};

function createDirectory(submissionKey = "directory-key", path = "Projects/Alpha") {
  return {
    submissionKey,
    operations: [
      {
        operationId: "mkdir-1",
        kind: "create_directory" as const,
        path,
        ifExists: "reject" as const,
      },
    ],
  };
}

function appliedRecord(value: unknown): Extract<ChangeSetRecord, { state: "intent_applied" }> {
  const result = value as { outcome: string; changeSet: ChangeSetRecord };
  expect(result.outcome).toBe("registered");
  expect(result.changeSet.state).toBe("intent_applied");
  return result.changeSet as Extract<ChangeSetRecord, { state: "intent_applied" }>;
}

describe("durable create-directory Change Set execution", () => {
  it("commits only after locked preflight, final-path proof, and snapshot publication", async () => {
    const store = new MemoryStore();
    const adapter = new DirectoryAdapter();
    let preflightReads = 0;
    const service = await ChangeSetService.open({
      store,
      dataSource: {
        readBinary: async () => null,
        pathKind: async (path) => {
          preflightReads += 1;
          return adapter.directories.has(path) ? "directory" : null;
        },
        isContained: async () => true,
      },
      execution: adapter,
      createChangeSetId: () => "change-set-directory",
    });

    const submitted = await service.submit(createDirectory(), requestState);
    const record = appliedRecord(submitted);
    const status = await service.status({ changeSetId: record.changeSetId }, requestState);

    expect(preflightReads).toBe(4);
    expect(record.preview).toEqual({
      requestedEffects: [
        {
          operationId: "mkdir-1",
          kind: "create_directory",
          projectedOutcome: "changed",
        },
      ],
      derivedEffects: [
        {
          operationId: "derived/mkdir-1/directory/Projects",
          causedByOperationId: "mkdir-1",
          kind: "create_directory",
          projectedOutcome: "changed",
        },
      ],
      paths: [
        {
          path: "Projects",
          preState: { kind: "absent" },
          projectedFinalState: { kind: "directory" },
          projectedOutcome: "changed",
        },
        {
          path: "Projects/Alpha",
          preState: { kind: "absent" },
          projectedFinalState: { kind: "directory" },
          projectedOutcome: "changed",
        },
      ],
    });
    expect(record.requestedEffects).toEqual([
      { operationId: "mkdir-1", kind: "create_directory", outcome: "changed" },
    ]);
    expect(record.derivedEffects).toEqual([
      {
        operationId: "derived/mkdir-1/directory/Projects",
        causedByOperationId: "mkdir-1",
        kind: "create_directory",
        outcome: "changed",
      },
    ]);
    expect(record.paths).toEqual([
      { path: "Projects", outcome: "changed", finalState: { kind: "directory" } },
      {
        path: "Projects/Alpha",
        outcome: "changed",
        finalState: { kind: "directory" },
      },
    ]);
    expect(status).toEqual({
      lookup: "found",
      changeSet: record,
      vault: requestState.vault,
    });
    expect(adapter.events).toEqual([
      "journal:PREPARED",
      "journal:PREPARED",
      "mkdir:Projects",
      "journal:PREPARED",
      "mkdir:Projects/Alpha",
      "inspect:Projects",
      "inspect:Projects/Alpha",
      "snapshot",
      "inspect:Projects",
      "inspect:Projects/Alpha",
      "journal:COMMITTED",
    ]);
  });

  it("executes concurrent submissions in persisted FIFO order under one write lease", async () => {
    const store = new MemoryStore();
    const adapter = new DirectoryAdapter();
    let activeMutations = 0;
    let maximumActiveMutations = 0;
    let secondAdmissionObserved = false;
    const originalPublishDirectory = adapter.publishDirectory.bind(adapter);
    adapter.publishDirectory = async (stageId, path) => {
      activeMutations += 1;
      maximumActiveMutations = Math.max(maximumActiveMutations, activeMutations);
      if (path === "First") {
        await new Promise((resolve) => setTimeout(resolve, 5));
        secondAdmissionObserved = store.state?.entries.length === 2;
      } else {
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
      await originalPublishDirectory(stageId, path);
      activeMutations -= 1;
    };
    let nextId = 0;
    const service = await ChangeSetService.open({
      store,
      dataSource: {
        readBinary: async () => null,
        pathKind: async (path) => (adapter.directories.has(path) ? "directory" : null),
        isContained: async () => true,
      },
      execution: adapter,
      createChangeSetId: () => `change-set-${++nextId}`,
    });

    const [first, second] = await Promise.all([
      service.submit(createDirectory("first-key", "First"), requestState),
      service.submit(createDirectory("second-key", "Second"), requestState),
    ]);

    expect(appliedRecord(first).changeSetId).toBe("change-set-1");
    expect(appliedRecord(second).changeSetId).toBe("change-set-2");
    expect(maximumActiveMutations).toBe(1);
    expect(secondAdmissionObserved).toBe(true);
    expect(adapter.events.filter((event) => event.startsWith("mkdir:"))).toEqual([
      "mkdir:First",
      "mkdir:Second",
    ]);
    expect(store.state?.entries.map(({ enqueueSeq }) => enqueueSeq)).toEqual([1, 2]);
  });

  it("keeps unsupported operations outside the directory execution FIFO", async () => {
    const store = new MemoryStore();
    const adapter = new DirectoryAdapter();
    let nextId = 0;
    const service = await ChangeSetService.open({
      store,
      dataSource: {
        readBinary: async () => null,
        pathKind: async (path) => (adapter.directories.has(path) ? "directory" : null),
        isContained: async () => true,
      },
      execution: adapter,
      createChangeSetId: () => `change-set-${++nextId}`,
    });

    const unsupported = await service.submit(
      {
        submissionKey: "note-key",
        operations: [
          {
            operationId: "note-1",
            kind: "create_note",
            path: "Note.md",
            content: "body",
            ifExists: "reject",
          },
        ],
      },
      requestState,
    );
    const directory = await service.submit(
      createDirectory("directory-key", "Directory"),
      requestState,
    );

    expect(unsupported).toMatchObject({ changeSet: { state: "in_progress" } });
    expect(directory).toMatchObject({ changeSet: { state: "intent_applied" } });
    expect(adapter.directories).toEqual(new Set(["Directory"]));
    expect(adapter.events).toContain("mkdir:Directory");
    expect(store.state?.entries.map(({ enqueueSeq }) => enqueueSeq)).toEqual([1, 2]);
  });

  it("recovers committed intent after the durable commit outlives registry publication", async () => {
    const store = new MemoryStore();
    const adapter = new DirectoryAdapter();
    store.failWhen = (state) =>
      state.entries.some(({ changeSet }) => changeSet.state === "intent_applied");
    const service = await ChangeSetService.open({
      store,
      dataSource: {
        readBinary: async () => null,
        pathKind: async (path) => (adapter.directories.has(path) ? "directory" : null),
        isContained: async () => true,
      },
      execution: adapter,
      createChangeSetId: () => "change-set-commit-recovery",
    });

    await expect(service.submit(createDirectory(), requestState)).rejects.toThrow(
      "injected registry failure",
    );
    expect(adapter.frame?.phase).toBe("COMMITTED");
    expect(adapter.directories).toEqual(new Set(["Projects", "Projects/Alpha"]));
    expect(adapter.events).not.toContain("rmdir:Projects");

    const replayed = await service.submit(createDirectory(), requestState);
    expect(replayed).toMatchObject({
      outcome: "registered",
      changeSet: { state: "intent_applied" },
    });
    expect(adapter.directories).toEqual(new Set(["Projects", "Projects/Alpha"]));

    const recovered = await ChangeSetService.open({
      store,
      dataSource: {
        readBinary: async () => null,
        pathKind: async (path) => (adapter.directories.has(path) ? "directory" : null),
        isContained: async () => true,
      },
      execution: adapter,
    });
    await expect(
      recovered.status({ changeSetId: "change-set-commit-recovery" }, requestState),
    ).resolves.toMatchObject({
      lookup: "found",
      changeSet: { state: "intent_applied" },
    });
  });

  it("restores the whole directory plan before resuming queued work after a crash", async () => {
    const store = new MemoryStore();
    const adapter = new DirectoryAdapter();
    const crashing = await ChangeSetService.open({
      store,
      dataSource: {
        readBinary: async () => null,
        pathKind: async (path) => (adapter.directories.has(path) ? "directory" : null),
        isContained: async () => true,
      },
      execution: adapter,
      createChangeSetId: () => "change-set-crash",
      crashInjector: (point) => {
        if (point === "after_mutation:1") throw new InjectedChangeSetCrash(point);
      },
    });

    await expect(crashing.submit(createDirectory(), requestState)).rejects.toThrow(
      InjectedChangeSetCrash,
    );
    expect(adapter.directories).toEqual(new Set(["Projects", "Projects/Alpha"]));
    expect(adapter.frame?.phase).toBe("PREPARED");

    const recovered = await ChangeSetService.open({
      store,
      dataSource: {
        readBinary: async () => null,
        pathKind: async (path) => (adapter.directories.has(path) ? "directory" : null),
        isContained: async () => true,
      },
      execution: adapter,
    });
    const status = await recovered.status({ changeSetId: "change-set-crash" }, requestState);

    expect(adapter.directories.size).toBe(0);
    expect(adapter.frame?.phase).toBe("ROLLED_BACK");
    expect(status).toMatchObject({
      lookup: "found",
      changeSet: { state: "intent_not_applied" },
    });
    expect(adapter.events.slice(-8)).toEqual([
      "inspect:Projects/Alpha",
      "rmdir:Projects/Alpha",
      "inspect:Projects",
      "rmdir:Projects",
      "inspect:Projects",
      "inspect:Projects/Alpha",
      "snapshot",
      "journal:ROLLED_BACK",
    ]);
  });

  it("restores a prepared real-filesystem journal before new writes after restart", async () => {
    const root = await mkdtemp(join(tmpdir(), "change-set-recovery-"));
    temporaryRoots.push(root);
    const store = new MemoryStore();
    let snapshots = 0;
    const adapter = await createFileSystemChangeSetExecutionAdapter({
      journalPath: join(root, ".llm-wiki", "recovery-journal.bin"),
      slotCapacity: 4096,
      host: {
        pathKind: async (path) => {
          try {
            const value = await stat(join(root, ...path.split("/")));
            return value.isDirectory() ? "directory" : "file";
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
            throw error;
          }
        },
        directoryIdentity: async (path) => {
          try {
            const value = await stat(join(root, ...path.split("/")));
            return value.isDirectory()
              ? `${value.dev}:${value.ino}:${value.birthtimeMs}`
              : null;
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
            throw error;
          }
        },
        prepareDirectory: async (stageId) => {
          const stagePath = join(root, ".llm-wiki", "staging", ...stageId.split("/"));
          await mkdir(stagePath, { recursive: true });
          const value = await stat(stagePath);
          return `${value.dev}:${value.ino}:${value.birthtimeMs}`;
        },
        publishDirectory: async (stageId, path) => {
          await rename(
            join(root, ".llm-wiki", "staging", ...stageId.split("/")),
            join(root, ...path.split("/")),
          );
        },
        discardPreparedDirectory: async (stageId) => {
          await rmdir(join(root, ".llm-wiki", "staging", ...stageId.split("/"))).catch(
            (error: NodeJS.ErrnoException) => {
              if (error.code !== "ENOENT") throw error;
            },
          );
        },
        removeDirectory: async (path) => {
          await rmdir(join(root, ...path.split("/")));
        },
        publishSearchSnapshot: async () => {
          snapshots += 1;
        },
      },
    });
    const dataSource = {
      readBinary: async () => null,
      pathKind: adapter.pathKind,
      isContained: async () => true,
    };
    const crashing = await ChangeSetService.open({
      store,
      dataSource,
      execution: adapter,
      vaultId: "vault-real",
      createChangeSetId: () => "change-set-real",
      crashInjector: (point) => {
        if (point === "after_mutation:1") throw new InjectedChangeSetCrash(point);
      },
    });
    await expect(crashing.submit(createDirectory(), requestState)).rejects.toThrow(
      InjectedChangeSetCrash,
    );
    await adapter.close?.();

    const reopenedAdapter = await createFileSystemChangeSetExecutionAdapter({
      journalPath: join(root, ".llm-wiki", "recovery-journal.bin"),
      slotCapacity: 4096,
      host: {
        pathKind: async (path) => {
          try {
            const value = await stat(join(root, ...path.split("/")));
            return value.isDirectory() ? "directory" : "file";
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
            throw error;
          }
        },
        directoryIdentity: async (path) => {
          try {
            const value = await stat(join(root, ...path.split("/")));
            return value.isDirectory()
              ? `${value.dev}:${value.ino}:${value.birthtimeMs}`
              : null;
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
            throw error;
          }
        },
        prepareDirectory: async (stageId) => {
          const stagePath = join(root, ".llm-wiki", "staging", ...stageId.split("/"));
          await mkdir(stagePath, { recursive: true });
          const value = await stat(stagePath);
          return `${value.dev}:${value.ino}:${value.birthtimeMs}`;
        },
        publishDirectory: async (stageId, path) => {
          await rename(
            join(root, ".llm-wiki", "staging", ...stageId.split("/")),
            join(root, ...path.split("/")),
          );
        },
        discardPreparedDirectory: async (stageId) => {
          await rmdir(join(root, ".llm-wiki", "staging", ...stageId.split("/"))).catch(
            (error: NodeJS.ErrnoException) => {
              if (error.code !== "ENOENT") throw error;
            },
          );
        },
        removeDirectory: async (path) => {
          await rmdir(join(root, ...path.split("/")));
        },
        publishSearchSnapshot: async () => {
          snapshots += 1;
        },
      },
    });
    const recovered = await ChangeSetService.open({
      store,
      dataSource: {
        ...dataSource,
        pathKind: reopenedAdapter.pathKind,
      },
      execution: reopenedAdapter,
      vaultId: "vault-real",
    });

    await expect(stat(join(root, "Projects"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      recovered.status({ changeSetId: "change-set-real" }, requestState),
    ).resolves.toMatchObject({
      lookup: "found",
      changeSet: { state: "intent_not_applied" },
    });
    expect(snapshots).toBe(1);
    await reopenedAdapter.close?.();
  });

  for (const crashPoint of [
    "after_prepared",
    "after_mutation:0",
    "after_mutation:1",
    "after_raw_verification",
    "after_snapshot",
  ]) {
    it(`restores all directory effects after a crash at ${crashPoint}`, async () => {
      const store = new MemoryStore();
      const adapter = new DirectoryAdapter();
      const crashing = await ChangeSetService.open({
        store,
        dataSource: {
          readBinary: async () => null,
          pathKind: async (path) => (adapter.directories.has(path) ? "directory" : null),
          isContained: async () => true,
        },
        execution: adapter,
        createChangeSetId: () => `change-set-${crashPoint}`,
        crashInjector: (point) => {
          if (point === crashPoint) throw new InjectedChangeSetCrash(point);
        },
      });
      await expect(crashing.submit(createDirectory(), requestState)).rejects.toThrow(
        InjectedChangeSetCrash,
      );

      const recovered = await ChangeSetService.open({
        store,
        dataSource: {
          readBinary: async () => null,
          pathKind: async (path) => (adapter.directories.has(path) ? "directory" : null),
          isContained: async () => true,
        },
        execution: adapter,
      });
      expect(adapter.directories.size).toBe(0);
      await expect(
        recovered.status({ changeSetId: `change-set-${crashPoint}` }, requestState),
      ).resolves.toMatchObject({
        lookup: "found",
        changeSet: { state: "intent_not_applied" },
      });
    });
  }

  it("keeps committed effects after a crash following durable COMMITTED", async () => {
    const store = new MemoryStore();
    const adapter = new DirectoryAdapter();
    const crashing = await ChangeSetService.open({
      store,
      dataSource: {
        readBinary: async () => null,
        pathKind: async (path) => (adapter.directories.has(path) ? "directory" : null),
        isContained: async () => true,
      },
      execution: adapter,
      createChangeSetId: () => "change-set-after-committed",
      crashInjector: (point) => {
        if (point === "after_committed") throw new InjectedChangeSetCrash(point);
      },
    });
    await expect(crashing.submit(createDirectory(), requestState)).rejects.toThrow(
      InjectedChangeSetCrash,
    );

    const recovered = await ChangeSetService.open({
      store,
      dataSource: {
        readBinary: async () => null,
        pathKind: async (path) => (adapter.directories.has(path) ? "directory" : null),
        isContained: async () => true,
      },
      execution: adapter,
    });
    expect(adapter.directories).toEqual(new Set(["Projects", "Projects/Alpha"]));
    await expect(
      recovered.status({ changeSetId: "change-set-after-committed" }, requestState),
    ).resolves.toMatchObject({
      lookup: "found",
      changeSet: { state: "intent_applied" },
    });
  });

  it("fails closed and does not resume queued writes when journal recovery is corrupt", async () => {
    const store = new MemoryStore();
    const adapter = new DirectoryAdapter();
    const preview = {
      requestedEffects: [
        {
          operationId: "mkdir-1",
          kind: "create_directory" as const,
          projectedOutcome: "changed" as const,
        },
      ],
      derivedEffects: [],
      paths: [
        {
          path: "Directory",
          preState: { kind: "absent" as const },
          projectedFinalState: { kind: "directory" as const },
          projectedOutcome: "changed" as const,
        },
      ],
    };
    store.state = {
      schemaVersion: 1,
      nextEnqueueSeq: 2,
      entries: [
        {
          submissionKey: "directory-key",
          fingerprint: `sha256:${"a".repeat(64)}`,
          changeSetId: "change-set-corrupt-journal",
          enqueueSeq: 1,
          acceptedAt: 0,
          expiresAt: 7 * 24 * 60 * 60 * 1_000,
          execution: {
            phase: "queued",
            input: createDirectory("directory-key", "Directory"),
          },
          changeSet: {
            changeSetId: "change-set-corrupt-journal",
            state: "in_progress",
            preview,
          },
        },
      ],
      tombstones: [],
    };
    adapter.loadRecoveryFrame = async () => {
      throw new Error("corrupt journal");
    };
    const blocked: string[] = [];

    const service = await ChangeSetService.open({
      store,
      dataSource: {
        readBinary: async () => null,
        pathKind: async () => null,
        isContained: async () => true,
      },
      execution: adapter,
      now: () => 0,
      runtimeState: {
        setQueue: () => undefined,
        blockWritesForUnproven: (changeSetId) => {
          blocked.push(changeSetId);
        },
      },
    });

    expect(adapter.events).toEqual([]);
    expect(blocked).toEqual(["change-set-corrupt-journal"]);
    await expect(
      service.status(
        { changeSetId: "change-set-corrupt-journal" },
        {
          vault: { writeGate: "blocked", writeState: "paused" },
          effectiveGate: { code: "recovery_blocked" },
        },
      ),
    ).resolves.toMatchObject({
      lookup: "found",
      changeSet: { state: "result_unproven" },
    });
  });

  it("does not remove a third-party directory recreated at the same path", async () => {
    const store = new MemoryStore();
    const adapter = new DirectoryAdapter();
    const crashing = await ChangeSetService.open({
      store,
      dataSource: {
        readBinary: async () => null,
        pathKind: async (path) => (adapter.directories.has(path) ? "directory" : null),
        isContained: async () => true,
      },
      execution: adapter,
      createChangeSetId: () => "change-set-recreated-directory",
      crashInjector: (point) => {
        if (point === "after_mutation:1") throw new InjectedChangeSetCrash(point);
      },
    });
    await expect(crashing.submit(createDirectory(), requestState)).rejects.toThrow(
      InjectedChangeSetCrash,
    );
    adapter.identities.set("Projects/Alpha", "third-party-directory");
    const blocked: string[] = [];

    const recovered = await ChangeSetService.open({
      store,
      dataSource: {
        readBinary: async () => null,
        pathKind: async (path) => (adapter.directories.has(path) ? "directory" : null),
        isContained: async () => true,
      },
      execution: adapter,
      runtimeState: {
        setQueue: () => undefined,
        blockWritesForUnproven: (changeSetId) => {
          blocked.push(changeSetId);
        },
      },
    });

    expect(adapter.directories.has("Projects/Alpha")).toBe(true);
    expect(adapter.events).not.toContain("rmdir:Projects/Alpha");
    expect(blocked).toEqual(["change-set-recreated-directory"]);
    await expect(
      recovered.status({ changeSetId: "change-set-recreated-directory" }, requestState),
    ).resolves.toMatchObject({
      lookup: "found",
      changeSet: { state: "result_unproven" },
    });
  });

  it("does not overwrite third-party state during recovery and blocks the Vault", async () => {
    const store = new MemoryStore();
    const adapter = new DirectoryAdapter();
    const crashing = await ChangeSetService.open({
      store,
      dataSource: {
        readBinary: async () => null,
        pathKind: async (path) => (adapter.directories.has(path) ? "directory" : null),
        isContained: async () => true,
      },
      execution: adapter,
      createChangeSetId: () => "change-set-third-party",
      crashInjector: (point) => {
        if (point === "after_prepared") throw new InjectedChangeSetCrash(point);
      },
    });
    await expect(crashing.submit(createDirectory(), requestState)).rejects.toThrow(
      InjectedChangeSetCrash,
    );
    const originalPathKind = adapter.pathKind.bind(adapter);
    adapter.pathKind = async (path) =>
      path === "Projects/Alpha" ? "file" : originalPathKind(path);
    const blocked: string[] = [];

    const recovered = await ChangeSetService.open({
      store,
      dataSource: {
        readBinary: async () => null,
        pathKind: async () => null,
        isContained: async () => true,
      },
      execution: adapter,
      runtimeState: {
        setQueue: () => undefined,
        blockWritesForUnproven: (changeSetId) => {
          blocked.push(changeSetId);
        },
      },
    });
    const status = await recovered.status(
      { changeSetId: "change-set-third-party" },
      {
        vault: { writeGate: "blocked", writeState: "paused" },
        effectiveGate: { code: "recovery_blocked" },
      },
    );

    expect(adapter.events).not.toContain("rmdir:Projects/Alpha");
    expect(adapter.frame?.phase).toBe("FAILED");
    expect(blocked).toEqual(["change-set-third-party"]);
    expect(status).toMatchObject({
      lookup: "found",
      changeSet: { state: "result_unproven" },
      vault: { writeGate: "blocked" },
    });
  });
});
