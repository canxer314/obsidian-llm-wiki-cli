import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  open,
  readFile,
  rename,
  rm,
  rmdir,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { ChangeSetRecord } from "@llm-wiki/vault-contracts";

import {
  ChangeSetService,
  InjectedChangeSetCrash,
  RECOVERY_JOURNAL_FRAME_SCHEMA_VERSION,
  createFileSystemChangeSetExecutionAdapter,
  type ChangeSetExecutionAdapter,
  type ChangeSetRegistryState,
  type ChangeSetRegistryStore,
  type ChangeSetRuntimeStatePort,
  type RecoveryJournalFrame,
} from "../src/index.js";
import {
  RecoveryJournalIncompatibleError,
  openRecoveryJournal,
} from "../src/recovery-journal.js";

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
  readonly files = new Map<string, Uint8Array>();
  readonly fileIdentities = new Map<string, string>();
  readonly preparedFiles = new Map<string, { bytes: Uint8Array; identity: string }>();
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
    return this.directories.has(path)
      ? "directory"
      : this.files.has(path)
        ? "file"
        : null;
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

  async readBinary(path: string): Promise<Uint8Array | null> {
    const bytes = this.files.get(path);
    return bytes === undefined ? null : Uint8Array.from(bytes);
  }

  async fileIdentity(path: string): Promise<string | null> {
    return this.fileIdentities.get(path) ?? null;
  }

  async prepareFile(stageId: string, bytes: Uint8Array): Promise<string> {
    this.#nextIdentity += 1;
    const identity = `file-${this.#nextIdentity}`;
    this.preparedFiles.set(stageId, { bytes: Uint8Array.from(bytes), identity });
    return identity;
  }

  async publishFile(stageId: string, path: string): Promise<void> {
    const prepared = this.preparedFiles.get(stageId);
    if (prepared === undefined) throw new Error("prepared file is missing");
    this.events.push(`write:${path}`);
    this.files.set(path, prepared.bytes);
    this.fileIdentities.set(path, prepared.identity);
    this.preparedFiles.delete(stageId);
  }

  async discardPreparedFile(stageId: string): Promise<void> {
    this.preparedFiles.delete(stageId);
  }

  async removeFile(path: string): Promise<void> {
    this.events.push(`unlink:${path}`);
    this.files.delete(path);
    this.fileIdentities.delete(path);
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

async function fileSystemPathKind(
  root: string,
  path: string,
): Promise<"directory" | "file" | null> {
  try {
    const value = await stat(join(root, ...path.split("/")));
    return value.isDirectory() ? "directory" : "file";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function fileSystemIdentity(root: string, path: string): Promise<string | null> {
  try {
    const value = await stat(join(root, ...path.split("/")));
    return `${value.dev}:${value.ino}:${value.birthtimeMs}`;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function realExecutionAdapter(
  root: string,
  publishSearchSnapshot: () => Promise<void>,
): Promise<ChangeSetExecutionAdapter> {
  const staging = join(root, ".llm-wiki", "staging");
  return createFileSystemChangeSetExecutionAdapter({
    journalPath: join(root, ".llm-wiki", "recovery-journal.bin"),
    slotCapacity: 32 * 1024,
    host: {
      pathKind: (path) => fileSystemPathKind(root, path),
      directoryIdentity: (path) => fileSystemIdentity(root, path),
      prepareDirectory: async (stageId) => {
        const stagePath = join(staging, ...stageId.split("/"));
        await mkdir(stagePath, { recursive: true });
        return (await fileSystemIdentity(staging, stageId))!;
      },
      publishDirectory: (stageId, path) =>
        rename(join(staging, ...stageId.split("/")), join(root, ...path.split("/"))),
      discardPreparedDirectory: async (stageId) => {
        await rmdir(join(staging, ...stageId.split("/"))).catch(
          (error: NodeJS.ErrnoException) => {
            if (error.code !== "ENOENT") throw error;
          },
        );
      },
      removeDirectory: (path) => rmdir(join(root, ...path.split("/"))),
      readBinary: async (path) => {
        try {
          return await readFile(join(root, ...path.split("/")));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
          throw error;
        }
      },
      fileIdentity: (path) => fileSystemIdentity(root, path),
      prepareFile: async (stageId, bytes) => {
        const stagePath = join(staging, ...stageId.split("/"));
        await mkdir(dirname(stagePath), { recursive: true });
        await writeFile(stagePath, bytes, { flag: "wx" });
        return (await fileSystemIdentity(staging, stageId))!;
      },
      publishFile: (stageId, path) =>
        rename(join(staging, ...stageId.split("/")), join(root, ...path.split("/"))),
      discardPreparedFile: async (stageId) => {
        await unlink(join(staging, ...stageId.split("/"))).catch(
          (error: NodeJS.ErrnoException) => {
            if (error.code !== "ENOENT") throw error;
          },
        );
      },
      removeFile: (path) => unlink(join(root, ...path.split("/"))),
      publishSearchSnapshot,
    },
  });
}

describe("durable Markdown Change Set execution", () => {
  it("creates and edits Markdown through the real filesystem Journal adapter", async () => {
    const root = await mkdtemp(join(tmpdir(), "change-set-markdown-real-"));
    temporaryRoots.push(root);
    const store = new MemoryStore();
    let snapshots = 0;
    const adapter = await realExecutionAdapter(root, async () => {
      snapshots += 1;
    });
    const dataSource = {
      readBinary: async (path: string) => {
        try {
          return await readFile(join(root, ...path.split("/")));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
          throw error;
        }
      },
      pathKind: (path: string) => fileSystemPathKind(root, path),
      isContained: async () => true,
    };
    const service = await ChangeSetService.open({
      store,
      dataSource,
      execution: adapter,
      vaultId: "vault-real-markdown",
      createChangeSetId: () => "change-set-real-markdown",
    });
    const first = "# First\r\nold\r\n";
    const second = "# Second\n";
    const version = (content: string) =>
      `sha256:${createHash("sha256").update(content).digest("hex")}` as const;
    const input = {
      submissionKey: "real-markdown-key",
      operations: [
        {
          operationId: "create-first",
          kind: "create_note" as const,
          path: "Notes/First.md",
          content: first,
          ifExists: "reject" as const,
        },
        {
          operationId: "edit-first",
          afterOperationId: "create-first",
          kind: "edit_body" as const,
          path: "Notes/First.md",
          targetVersion: version(first),
          edit: {
            kind: "replace_exact" as const,
            old: "old",
            replacement: "new",
            expectedOccurrences: 1 as const,
          },
        },
        {
          operationId: "create-second",
          kind: "create_note" as const,
          path: "Notes/Second.md",
          content: second,
          ifExists: "reject" as const,
        },
      ],
    };

    const submitted = await service.submit(input, requestState);
    const record = appliedRecord(submitted);

    expect(await readFile(join(root, "Notes", "First.md"), "utf8")).toBe(
      "# First\r\nnew\r\n",
    );
    expect(await readFile(join(root, "Notes", "Second.md"), "utf8")).toBe(second);
    expect(record.paths).toMatchObject([
      { path: "Notes", finalState: { kind: "directory" } },
      { path: "Notes/First.md", finalState: { kind: "markdown" } },
      { path: "Notes/Second.md", finalState: { kind: "markdown" } },
    ]);
    expect(snapshots).toBe(1);
    await adapter.close?.();
  });

  it("restores real edited bytes from PREPARED after restart", async () => {
    const root = await mkdtemp(join(tmpdir(), "change-set-edit-recovery-real-"));
    temporaryRoots.push(root);
    await mkdir(join(root, "Notes"));
    const before = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from("before 🚀\r\n", "utf8"),
    ]);
    await writeFile(join(root, "Notes", "Edit.md"), before);
    const store = new MemoryStore();
    let snapshots = 0;
    const adapter = await realExecutionAdapter(root, async () => {
      snapshots += 1;
    });
    const dataSource = {
      readBinary: async (path: string) => {
        try {
          return await readFile(join(root, ...path.split("/")));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
          throw error;
        }
      },
      pathKind: (path: string) => fileSystemPathKind(root, path),
      isContained: async () => true,
    };
    const crashing = await ChangeSetService.open({
      store,
      dataSource,
      execution: adapter,
      vaultId: "vault-real-edit-recovery",
      createChangeSetId: () => "change-set-real-edit-recovery",
      crashInjector: (point) => {
        if (point === "after_file_mutation:0") throw new InjectedChangeSetCrash(point);
      },
    });
    const beforeVersion = `sha256:${createHash("sha256").update(before).digest("hex")}` as const;

    await expect(
      crashing.submit(
        {
          submissionKey: "real-edit-recovery-key",
          operations: [
            {
              operationId: "edit-real",
              kind: "edit_body",
              path: "Notes/Edit.md",
              targetVersion: beforeVersion,
              edit: { kind: "replace_whole", replacement: "after\n" },
            },
          ],
        },
        requestState,
      ),
    ).rejects.toThrow(InjectedChangeSetCrash);
    expect(await readFile(join(root, "Notes", "Edit.md"))).toEqual(
      Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("after\n")]),
    );
    await adapter.close?.();

    const reopened = await realExecutionAdapter(root, async () => {
      snapshots += 1;
    });
    const recovered = await ChangeSetService.open({
      store,
      dataSource,
      execution: reopened,
      vaultId: "vault-real-edit-recovery",
    });

    expect(await readFile(join(root, "Notes", "Edit.md"))).toEqual(before);
    await expect(
      recovered.status({ submissionKey: "real-edit-recovery-key" }, requestState),
    ).resolves.toMatchObject({
      lookup: "found",
      changeSet: { state: "intent_not_applied" },
    });
    expect(snapshots).toBe(1);
    await reopened.close?.();
  });

  it("creates a nested note with durable final evidence stable across replay and status", async () => {
    const store = new MemoryStore();
    const adapter = new DirectoryAdapter();
    const service = await ChangeSetService.open({
      store,
      dataSource: {
        readBinary: (path) => adapter.readBinary(path),
        pathKind: async (path) =>
          adapter.directories.has(path) ? "directory" : adapter.files.has(path) ? "file" : null,
        isContained: async () => true,
      },
      execution: adapter,
      createChangeSetId: () => "change-set-note",
    });
    const input = {
      submissionKey: "note-key",
      operations: [
        {
          operationId: "note-1",
          kind: "create_note" as const,
          path: "Projects/Alpha.md",
          content: "# Alpha\r\n你好\r\n",
          ifExists: "reject" as const,
        },
      ],
    };

    const submitted = await service.submit(input, requestState);
    const record = appliedRecord(submitted);
    const replayed = await service.submit(input, requestState);
    const status = await service.status({ submissionKey: "note-key" }, requestState);

    expect(Buffer.from(adapter.files.get("Projects/Alpha.md") ?? []).toString()).toBe(
      "# Alpha\r\n你好\r\n",
    );
    expect(record).toMatchObject({
      changeSetId: "change-set-note",
      requestedEffects: [
        { operationId: "note-1", kind: "create_note", outcome: "changed" },
      ],
      derivedEffects: [
        {
          operationId: "derived/note-1/directory/Projects",
          causedByOperationId: "note-1",
          kind: "create_directory",
          outcome: "changed",
        },
      ],
      paths: [
        { path: "Projects", outcome: "changed", finalState: { kind: "directory" } },
        {
          path: "Projects/Alpha.md",
          outcome: "changed",
          finalState: {
            kind: "markdown",
            contentVersion: "sha256:1b6719ff94dc86dfa3609075be2be99addc1901b57b4645827c239a2361f751d",
          },
        },
      ],
    });
    expect(replayed).toEqual(submitted);
    expect(status).toEqual({ lookup: "found", changeSet: record, vault: requestState.vault });
  });

  it("restores created and edited notes after a crash before COMMITTED", async () => {
    for (const kind of ["create", "edit"] as const) {
      const store = new MemoryStore();
      const adapter = new DirectoryAdapter();
      adapter.directories.add("Notes");
      if (kind === "edit") {
        adapter.files.set("Notes/Crash.md", Buffer.from("before"));
        adapter.fileIdentities.set("Notes/Crash.md", "before-file");
      }
      const version = `sha256:${createHash("sha256").update("before").digest("hex")}` as const;
      const input = {
        submissionKey: `crash-${kind}-key`,
        operations: [
          kind === "create"
            ? {
                operationId: "create-crash",
                kind: "create_note" as const,
                path: "Notes/Crash.md",
                content: "after",
                ifExists: "reject" as const,
              }
            : {
                operationId: "edit-crash",
                kind: "edit_body" as const,
                path: "Notes/Crash.md",
                targetVersion: version,
                edit: { kind: "replace_whole" as const, replacement: "after" },
              },
        ],
      };
      const crashing = await ChangeSetService.open({
        store,
        dataSource: {
          readBinary: (path) => adapter.readBinary(path),
          pathKind: (path) => adapter.pathKind(path),
          isContained: async () => true,
        },
        execution: adapter,
        createChangeSetId: () => `change-set-crash-${kind}`,
        crashInjector: (point) => {
          if (point === "after_file_mutation:0") throw new InjectedChangeSetCrash(point);
        },
      });

      await expect(crashing.submit(input, requestState)).rejects.toThrow(
        InjectedChangeSetCrash,
      );
      expect(Buffer.from(adapter.files.get("Notes/Crash.md") ?? []).toString()).toBe(
        "after",
      );
      expect(adapter.frame?.phase).toBe("PREPARED");

      const recovered = await ChangeSetService.open({
        store,
        dataSource: {
          readBinary: (path) => adapter.readBinary(path),
          pathKind: (path) => adapter.pathKind(path),
          isContained: async () => true,
        },
        execution: adapter,
      });
      const status = await recovered.status(
        { changeSetId: `change-set-crash-${kind}` },
        requestState,
      );

      expect(
        adapter.files.has("Notes/Crash.md")
          ? Buffer.from(adapter.files.get("Notes/Crash.md") ?? []).toString()
          : null,
      ).toBe(kind === "create" ? null : "before");
      expect(adapter.frame?.phase).toBe("ROLLED_BACK");
      expect(status).toMatchObject({
        lookup: "found",
        changeSet: { state: "intent_not_applied" },
      });
    }
  });

  it("recovers exact final note evidence after durable COMMITTED", async () => {
    const store = new MemoryStore();
    const adapter = new DirectoryAdapter();
    adapter.directories.add("Notes");
    adapter.files.set("Notes/Committed.md", Buffer.from("before"));
    adapter.fileIdentities.set("Notes/Committed.md", "before-file");
    const beforeVersion = `sha256:${createHash("sha256").update("before").digest("hex")}` as const;
    const afterVersion = `sha256:${createHash("sha256").update("after 🚀\r\n").digest("hex")}` as const;
    const crashing = await ChangeSetService.open({
      store,
      dataSource: {
        readBinary: (path) => adapter.readBinary(path),
        pathKind: (path) => adapter.pathKind(path),
        isContained: async () => true,
      },
      execution: adapter,
      createChangeSetId: () => "change-set-file-committed",
      crashInjector: (point) => {
        if (point === "after_committed") throw new InjectedChangeSetCrash(point);
      },
    });
    const input = {
      submissionKey: "file-committed-key",
      operations: [
        {
          operationId: "edit-committed",
          kind: "edit_body" as const,
          path: "Notes/Committed.md",
          targetVersion: beforeVersion,
          edit: { kind: "replace_whole" as const, replacement: "after 🚀\r\n" },
        },
      ],
    };

    await expect(crashing.submit(input, requestState)).rejects.toThrow(
      InjectedChangeSetCrash,
    );
    expect(adapter.frame?.phase).toBe("COMMITTED");

    const recovered = await ChangeSetService.open({
      store,
      dataSource: {
        readBinary: (path) => adapter.readBinary(path),
        pathKind: (path) => adapter.pathKind(path),
        isContained: async () => true,
      },
      execution: adapter,
    });
    const status = await recovered.status(
      { submissionKey: "file-committed-key" },
      requestState,
    );

    expect(Buffer.from(adapter.files.get("Notes/Committed.md") ?? []).toString()).toBe(
      "after 🚀\r\n",
    );
    expect(status).toMatchObject({
      lookup: "found",
      changeSet: {
        state: "intent_applied",
        paths: [
          {
            path: "Notes/Committed.md",
            finalState: { kind: "markdown", contentVersion: afterVersion },
          },
        ],
      },
    });
  });

  for (const recoveryCrashPoint of [
    "recovery_after_file_prepared:Notes/Retry.md",
    "recovery_after_file_published:Notes/Retry.md",
  ]) {
    it(`retries file rollback after a crash at ${recoveryCrashPoint}`, async () => {
      const store = new MemoryStore();
      const adapter = new DirectoryAdapter();
      adapter.directories.add("Notes");
      adapter.files.set("Notes/Retry.md", Buffer.from("before"));
      adapter.fileIdentities.set("Notes/Retry.md", "retry-before");
      const beforeVersion = `sha256:${createHash("sha256").update("before").digest("hex")}` as const;
      const input = {
        submissionKey: `rollback-retry-${recoveryCrashPoint}`,
        operations: [
          {
            operationId: "edit-retry",
            kind: "edit_body" as const,
            path: "Notes/Retry.md",
            targetVersion: beforeVersion,
            edit: { kind: "replace_whole" as const, replacement: "after" },
          },
        ],
      };
      const crashingExecution = await ChangeSetService.open({
        store,
        dataSource: {
          readBinary: (path) => adapter.readBinary(path),
          pathKind: (path) => adapter.pathKind(path),
          isContained: async () => true,
        },
        execution: adapter,
        createChangeSetId: () => `change-set-${recoveryCrashPoint}`,
        crashInjector: (point) => {
          if (point === "after_file_mutation:0") throw new InjectedChangeSetCrash(point);
        },
      });
      await expect(crashingExecution.submit(input, requestState)).rejects.toThrow(
        InjectedChangeSetCrash,
      );

      await expect(
        ChangeSetService.open({
          store,
          dataSource: {
            readBinary: (path) => adapter.readBinary(path),
            pathKind: (path) => adapter.pathKind(path),
            isContained: async () => true,
          },
          execution: adapter,
          crashInjector: (point) => {
            if (point === recoveryCrashPoint) throw new InjectedChangeSetCrash(point);
          },
        }),
      ).rejects.toThrow(InjectedChangeSetCrash);
      expect(adapter.frame?.phase).toBe("PREPARED");

      const recovered = await ChangeSetService.open({
        store,
        dataSource: {
          readBinary: (path) => adapter.readBinary(path),
          pathKind: (path) => adapter.pathKind(path),
          isContained: async () => true,
        },
        execution: adapter,
      });

      expect(Buffer.from(adapter.files.get("Notes/Retry.md") ?? []).toString()).toBe(
        "before",
      );
      expect(adapter.frame?.phase).toBe("ROLLED_BACK");
      await expect(
        recovered.status(
          { changeSetId: `change-set-${recoveryCrashPoint}` },
          requestState,
        ),
      ).resolves.toMatchObject({
        lookup: "found",
        changeSet: { state: "intent_not_applied" },
      });
    });
  }

  it("does not overwrite third-party file bytes during recovery", async () => {
    const store = new MemoryStore();
    const adapter = new DirectoryAdapter();
    adapter.directories.add("Notes");
    adapter.files.set("Notes/ThirdParty.md", Buffer.from("before"));
    adapter.fileIdentities.set("Notes/ThirdParty.md", "before-file");
    const beforeVersion = `sha256:${createHash("sha256").update("before").digest("hex")}` as const;
    const crashing = await ChangeSetService.open({
      store,
      dataSource: {
        readBinary: (path) => adapter.readBinary(path),
        pathKind: (path) => adapter.pathKind(path),
        isContained: async () => true,
      },
      execution: adapter,
      createChangeSetId: () => "change-set-third-party-file",
      crashInjector: (point) => {
        if (point === "after_file_mutation:0") throw new InjectedChangeSetCrash(point);
      },
    });

    await expect(
      crashing.submit(
        {
          submissionKey: "third-party-file-key",
          operations: [
            {
              operationId: "edit-third-party",
              kind: "edit_body",
              path: "Notes/ThirdParty.md",
              targetVersion: beforeVersion,
              edit: { kind: "replace_whole", replacement: "expected after" },
            },
          ],
        },
        requestState,
      ),
    ).rejects.toThrow(InjectedChangeSetCrash);
    adapter.files.set("Notes/ThirdParty.md", Buffer.from("third-party bytes"));
    adapter.fileIdentities.set("Notes/ThirdParty.md", "third-party-file");
    const blocked: string[] = [];

    const recovered = await ChangeSetService.open({
      store,
      dataSource: {
        readBinary: (path) => adapter.readBinary(path),
        pathKind: (path) => adapter.pathKind(path),
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

    expect(Buffer.from(adapter.files.get("Notes/ThirdParty.md") ?? []).toString()).toBe(
      "third-party bytes",
    );
    expect(adapter.frame?.phase).toBe("FAILED");
    expect(blocked).toEqual(["change-set-third-party-file"]);
    await expect(
      recovered.status({ submissionKey: "third-party-file-key" }, requestState),
    ).resolves.toMatchObject({
      lookup: "found",
      changeSet: { state: "result_unproven" },
    });
  });

  it("revalidates target versions, absence, and Read Dependencies under the write lease", async () => {
    const scenarios = ["target", "absence", "dependency"] as const;
    for (const scenario of scenarios) {
      const store = new MemoryStore();
      const adapter = new DirectoryAdapter();
      adapter.directories.add("Notes");
      adapter.files.set("Notes/Target.md", Buffer.from("old"));
      adapter.fileIdentities.set("Notes/Target.md", "target-before");
      adapter.files.set("Notes/Dependency.md", Buffer.from("observed"));
      adapter.fileIdentities.set("Notes/Dependency.md", "dependency-before");
      let targetReads = 0;
      let dependencyReads = 0;
      let destinationChecks = 0;
      const version = (content: string) =>
        `sha256:${createHash("sha256").update(content).digest("hex")}` as const;
      const service = await ChangeSetService.open({
        store,
        dataSource: {
          readBinary: async (path) => {
            if (path === "Notes/Target.md") {
              targetReads += 1;
              return Buffer.from(
                scenario === "target" && targetReads > 1 ? "changed outside lease" : "old",
              );
            }
            if (path === "Notes/Dependency.md") {
              dependencyReads += 1;
              return Buffer.from(
                scenario === "dependency" && dependencyReads > 1
                  ? "changed outside lease"
                  : "observed",
              );
            }
            return null;
          },
          pathKind: async (path) => {
            if (path === "Notes/New.md") {
              destinationChecks += 1;
              return scenario === "absence" && destinationChecks > 1 ? "file" : null;
            }
            return path === "Notes" ? "directory" : adapter.files.has(path) ? "file" : null;
          },
          isContained: async () => true,
        },
        execution: adapter,
        createChangeSetId: () => `change-set-stale-${scenario}`,
      });
      const input =
        scenario === "absence"
          ? {
              submissionKey: `stale-${scenario}`,
              operations: [
                {
                  operationId: "create-1",
                  kind: "create_note" as const,
                  path: "Notes/New.md",
                  content: "new",
                  ifExists: "reject" as const,
                },
              ],
            }
          : {
              submissionKey: `stale-${scenario}`,
              operations: [
                {
                  operationId: "edit-1",
                  kind: "edit_body" as const,
                  path: "Notes/Target.md",
                  targetVersion: version("old"),
                  edit: { kind: "replace_whole" as const, replacement: "new" },
                },
              ],
              ...(scenario === "dependency"
                ? {
                    readDependencies: [
                      {
                        path: "Notes/Dependency.md",
                        contentVersion: version("observed"),
                      },
                    ],
                  }
                : {}),
            };

      const submitted = await service.submit(input, requestState);

      expect(submitted).toMatchObject({
        outcome: "registered",
        changeSet: {
          state: "intent_not_applied",
          ...(scenario === "absence"
            ? {
                failure: {
                  code: "path_conflict",
                  operationId: "create-1",
                  path: "Notes/New.md",
                },
              }
            : { failure: { code: "stale_observation" } }),
        },
      });
      expect(adapter.events.some((event) => event.startsWith("write:"))).toBe(false);
    }
  });

  it("reports already-satisfied without rewriting the target", async () => {
    const store = new MemoryStore();
    const adapter = new DirectoryAdapter();
    adapter.directories.add("Notes");
    adapter.files.set("Notes/Same.md", Buffer.from("same"));
    adapter.fileIdentities.set("Notes/Same.md", "same-before");
    const service = await ChangeSetService.open({
      store,
      dataSource: {
        readBinary: (path) => adapter.readBinary(path),
        pathKind: (path) => adapter.pathKind(path),
        isContained: async () => true,
      },
      execution: adapter,
      createChangeSetId: () => "change-set-already-satisfied",
    });
    const version = `sha256:${createHash("sha256").update("same").digest("hex")}` as const;

    const submitted = await service.submit(
      {
        submissionKey: "already-satisfied-key",
        operations: [
          {
            operationId: "same-1",
            kind: "edit_body",
            path: "Notes/Same.md",
            targetVersion: version,
            edit: { kind: "replace_whole", replacement: "same" },
          },
        ],
      },
      requestState,
    );
    const record = appliedRecord(submitted);

    expect(record.requestedEffects).toEqual([
      { operationId: "same-1", kind: "edit_body", outcome: "already_satisfied" },
    ]);
    expect(record.paths).toEqual([
      {
        path: "Notes/Same.md",
        outcome: "unchanged",
        finalState: { kind: "markdown", contentVersion: version },
      },
    ]);
    expect(adapter.events).not.toContain("write:Notes/Same.md");
  });

  it("executes changed operations even when their chained final bytes equal the pre-state", async () => {
    const store = new MemoryStore();
    const adapter = new DirectoryAdapter();
    adapter.directories.add("Notes");
    adapter.files.set("Notes/RoundTrip.md", Buffer.from("start"));
    adapter.fileIdentities.set("Notes/RoundTrip.md", "round-trip-before");
    const version = (content: string) =>
      `sha256:${createHash("sha256").update(content).digest("hex")}` as const;
    const service = await ChangeSetService.open({
      store,
      dataSource: {
        readBinary: (path) => adapter.readBinary(path),
        pathKind: (path) => adapter.pathKind(path),
        isContained: async () => true,
      },
      execution: adapter,
      createChangeSetId: () => "change-set-round-trip",
    });

    const submitted = await service.submit(
      {
        submissionKey: "round-trip-key",
        operations: [
          {
            operationId: "to-middle",
            kind: "edit_body",
            path: "Notes/RoundTrip.md",
            targetVersion: version("start"),
            edit: { kind: "replace_whole", replacement: "middle" },
          },
          {
            operationId: "to-start",
            afterOperationId: "to-middle",
            kind: "edit_body",
            path: "Notes/RoundTrip.md",
            targetVersion: version("middle"),
            edit: { kind: "replace_whole", replacement: "start" },
          },
        ],
      },
      requestState,
    );
    const record = appliedRecord(submitted);

    expect(record.requestedEffects).toEqual([
      { operationId: "to-middle", kind: "edit_body", outcome: "changed" },
      { operationId: "to-start", kind: "edit_body", outcome: "changed" },
    ]);
    expect(record.paths).toEqual([
      {
        path: "Notes/RoundTrip.md",
        outcome: "unchanged",
        finalState: { kind: "markdown", contentVersion: version("start") },
      },
    ]);
    expect(adapter.events).toContain("write:Notes/RoundTrip.md");
  });

  it("rejects overlapping exact matches without mutating the file", async () => {
    const store = new MemoryStore();
    const adapter = new DirectoryAdapter();
    adapter.directories.add("Notes");
    adapter.files.set("Notes/Overlap.md", Buffer.from("aaa"));
    adapter.fileIdentities.set("Notes/Overlap.md", "overlap-file");
    const service = await ChangeSetService.open({
      store,
      dataSource: {
        readBinary: (path) => adapter.readBinary(path),
        pathKind: (path) => adapter.pathKind(path),
        isContained: async () => true,
      },
      execution: adapter,
      createChangeSetId: () => "change-set-overlap",
    });

    const submitted = await service.submit(
      {
        submissionKey: "overlap-key",
        operations: [
          {
            operationId: "overlap-1",
            kind: "edit_body",
            path: "Notes/Overlap.md",
            targetVersion: `sha256:${createHash("sha256").update("aaa").digest("hex")}`,
            edit: {
              kind: "replace_exact",
              old: "aa",
              replacement: "x",
              expectedOccurrences: 1,
            },
          },
        ],
      },
      requestState,
    );

    expect(submitted).toMatchObject({
      outcome: "registered",
      changeSet: {
        state: "intent_not_applied",
        failure: {
          code: "exact_match_count_mismatch",
          operationId: "overlap-1",
          actualOccurrences: 2,
        },
      },
    });
    expect(Buffer.from(adapter.files.get("Notes/Overlap.md") ?? []).toString()).toBe("aaa");
    expect(adapter.events.some((event) => event.startsWith("write:"))).toBe(false);
  });

  it("rolls back instead of committing when target semantic evidence never converges", async () => {
    const store = new MemoryStore();
    const adapter = new DirectoryAdapter();
    adapter.directories.add("Notes");
    adapter.files.set("Notes/Stale.md", Buffer.from("before"));
    adapter.fileIdentities.set("Notes/Stale.md", "stale-before");
    adapter.publishSearchSnapshot = async (targets) => {
      if (targets !== undefined) {
        expect(targets).toEqual([
          {
            path: "Notes/Stale.md",
            contentVersion: `sha256:${createHash("sha256").update("after").digest("hex")}`,
            requireSemanticMatch: true,
          },
        ]);
      }
      throw new Error("Successor Search Snapshot target evidence did not match");
    };
    const service = await ChangeSetService.open({
      store,
      dataSource: {
        readBinary: (path) => adapter.readBinary(path),
        pathKind: (path) => adapter.pathKind(path),
        isContained: async () => true,
      },
      execution: adapter,
      createChangeSetId: () => "change-set-stale-semantic",
    });

    const submitted = await service.submit(
      {
        submissionKey: "stale-semantic-key",
        operations: [
          {
            operationId: "edit-stale",
            kind: "edit_body",
            path: "Notes/Stale.md",
            targetVersion: `sha256:${createHash("sha256").update("before").digest("hex")}`,
            edit: { kind: "replace_whole", replacement: "after" },
          },
        ],
      },
      requestState,
    );

    expect(submitted).toMatchObject({
      outcome: "registered",
      changeSet: { state: "result_unproven" },
    });
    expect(Buffer.from(adapter.files.get("Notes/Stale.md") ?? []).toString()).toBe("before");
    expect(adapter.frame?.phase).toBe("FAILED");
  });

  it("preserves BOM, CRLF, Unicode, and untouched bytes around an exact replacement", async () => {
    const store = new MemoryStore();
    const adapter = new DirectoryAdapter();
    const prefix = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from("front 🚀\r\n", "utf8"),
    ]);
    const suffix = Buffer.from("\r\ntail ́\r\n", "utf8");
    const initialBytes = Buffer.concat([prefix, Buffer.from("needle"), suffix]);
    const finalBytes = Buffer.concat([prefix, Buffer.from("改变"), suffix]);
    adapter.directories.add("Notes");
    adapter.files.set("Notes/Exact.md", initialBytes);
    adapter.fileIdentities.set("Notes/Exact.md", "exact-file");
    const version = (bytes: Uint8Array) =>
      `sha256:${createHash("sha256").update(bytes).digest("hex")}` as const;
    const service = await ChangeSetService.open({
      store,
      dataSource: {
        readBinary: (path) => adapter.readBinary(path),
        pathKind: async (path) =>
          adapter.directories.has(path) ? "directory" : adapter.files.has(path) ? "file" : null,
        isContained: async () => true,
      },
      execution: adapter,
      createChangeSetId: () => "change-set-exact-bytes",
    });

    const submitted = await service.submit(
      {
        submissionKey: "exact-byte-key",
        operations: [
          {
            operationId: "exact-byte-1",
            kind: "edit_body",
            path: "Notes/Exact.md",
            targetVersion: version(initialBytes),
            edit: {
              kind: "replace_exact",
              old: "needle",
              replacement: "改变",
              expectedOccurrences: 1,
            },
          },
        ],
      },
      requestState,
    );
    const record = appliedRecord(submitted);
    const actual = Buffer.from(adapter.files.get("Notes/Exact.md") ?? []);

    expect(actual).toEqual(finalBytes);
    expect(actual.subarray(0, prefix.length)).toEqual(prefix);
    expect(actual.subarray(actual.length - suffix.length)).toEqual(suffix);
    expect(record.paths).toEqual([
      {
        path: "Notes/Exact.md",
        outcome: "changed",
        finalState: { kind: "markdown", contentVersion: version(finalBytes) },
      },
    ]);
  });

  it("chains exact and whole body edits with byte-preserving splicing and final versions", async () => {
    const store = new MemoryStore();
    const adapter = new DirectoryAdapter();
    const initialBytes = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from("front 🚀\r\nneedle\r\ntail ́\r\n", "utf8"),
    ]);
    adapter.directories.add("Notes");
    adapter.files.set("Notes/Source.md", initialBytes);
    adapter.fileIdentities.set("Notes/Source.md", "source-file");
    const service = await ChangeSetService.open({
      store,
      dataSource: {
        readBinary: (path) => adapter.readBinary(path),
        pathKind: async (path) =>
          adapter.directories.has(path) ? "directory" : adapter.files.has(path) ? "file" : null,
        isContained: async () => true,
      },
      execution: adapter,
      createChangeSetId: () => "change-set-edit-chain",
    });
    const exactFinal = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from("front 🚀\r\nchanged\r\ntail ́\r\n", "utf8"),
    ]);
    const wholeFinal = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from("whole\n", "utf8"),
    ]);
    const contentVersion = (bytes: Uint8Array) =>
      `sha256:${createHash("sha256").update(bytes).digest("hex")}` as const;
    const input = {
      submissionKey: "edit-chain-key",
      operations: [
        {
          operationId: "exact-1",
          kind: "edit_body" as const,
          path: "Notes/Source.md",
          targetVersion: contentVersion(initialBytes),
          edit: {
            kind: "replace_exact" as const,
            old: "needle",
            replacement: "changed",
            expectedOccurrences: 1 as const,
          },
        },
        {
          operationId: "whole-1",
          afterOperationId: "exact-1",
          kind: "edit_body" as const,
          path: "Notes/Source.md",
          targetVersion: contentVersion(exactFinal),
          edit: { kind: "replace_whole" as const, replacement: "whole\n" },
        },
      ],
    };

    const submitted = await service.submit(input, requestState);
    const record = appliedRecord(submitted);
    const replayed = await service.submit(input, requestState);

    expect(Buffer.from(adapter.files.get("Notes/Source.md") ?? [])).toEqual(wholeFinal);
    expect(record).toMatchObject({
      requestedEffects: [
        { operationId: "exact-1", kind: "edit_body", outcome: "changed" },
        { operationId: "whole-1", kind: "edit_body", outcome: "changed" },
      ],
      paths: [
        {
          path: "Notes/Source.md",
          outcome: "changed",
          finalState: {
            kind: "markdown",
            contentVersion: contentVersion(wholeFinal),
          },
        },
      ],
    });
    expect(replayed).toEqual(submitted);
  });
});

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
      "inspect:Projects",
      "journal:PREPARED",
      "mkdir:Projects",
      "inspect:Projects/Alpha",
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

  it("drains only the current Change Set while paused and resumes retained FIFO work", async () => {
    const store = new MemoryStore();
    const adapter = new DirectoryAdapter();
    let releaseFirst!: () => void;
    let firstStarted!: () => void;
    const firstStartedPromise = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const originalPublishDirectory = adapter.publishDirectory.bind(adapter);
    adapter.publishDirectory = async (stageId, path) => {
      if (path === "First") {
        firstStarted();
        await firstBlocked;
      }
      await originalPublishDirectory(stageId, path);
    };
    let nextId = 0;
    const runtimeState = new RecordingRuntimeState();
    const service = await ChangeSetService.open({
      store,
      dataSource: {
        readBinary: async () => null,
        pathKind: async (path) => (adapter.directories.has(path) ? "directory" : null),
        isContained: async () => true,
      },
      execution: adapter,
      runtimeState,
      createChangeSetId: () => `change-set-${++nextId}`,
    });

    const first = service.submit(createDirectory("first-key", "First"), requestState);
    await firstStartedPromise;
    const second = service.submit(createDirectory("second-key", "Second"), requestState);
    const paused = service.pause();
    releaseFirst();

    await Promise.all([first, second, paused]);
    expect(adapter.directories).toEqual(new Set(["First"]));
    expect(store.state?.entries.map(({ execution }) => execution?.phase)).toEqual([
      "terminal",
      "queued",
    ]);
    expect(runtimeState.queue).toEqual({
      currentExecutionId: null,
      length: 1,
      headChangeSetId: "change-set-2",
    });

    const blocked = await service.submit(
      createDirectory("blocked-key", "Blocked"),
      requestState,
    );
    expect(blocked).toEqual({
      outcome: "operationally_blocked",
      gate: { code: "writes_paused" },
    });
    expect(store.state?.entries).toHaveLength(2);

    const restarted = await ChangeSetService.open({
      store,
      dataSource: {
        readBinary: async () => null,
        pathKind: async (path) => (adapter.directories.has(path) ? "directory" : null),
        isContained: async () => true,
      },
      execution: adapter,
      runtimeState,
      createChangeSetId: () => `change-set-${++nextId}`,
    });
    expect(adapter.directories).toEqual(new Set(["First"]));
    expect(
      await restarted.submit(createDirectory("restart-blocked", "RestartBlocked"), requestState),
    ).toEqual({
      outcome: "operationally_blocked",
      gate: { code: "writes_paused" },
    });

    await restarted.resume();
    expect(adapter.directories).toEqual(new Set(["First", "Second"]));
    expect(adapter.events.filter((event) => event.startsWith("mkdir:"))).toEqual([
      "mkdir:First",
      "mkdir:Second",
    ]);
  });

  it("keeps gate, queue, and maintenance state isolated across two Vault services", async () => {
    const alphaStore = new MemoryStore();
    const alphaAdapter = new DirectoryAdapter();
    const betaStore = new MemoryStore();
    const betaAdapter = new DirectoryAdapter();
    const makeService = (
      adapter: DirectoryAdapter,
      store: MemoryStore,
      ids: () => string,
    ) =>
      ChangeSetService.open({
        store,
        dataSource: {
          readBinary: async () => null,
          pathKind: async (path) => (adapter.directories.has(path) ? "directory" : null),
          isContained: async () => true,
        },
        execution: adapter,
        createChangeSetId: ids,
      });
    let alphaId = 0;
    let betaId = 0;
    const alpha = await makeService(alphaAdapter, alphaStore, () => `alpha-${++alphaId}`);
    const beta = await makeService(betaAdapter, betaStore, () => `beta-${++betaId}`);

    await alpha.runMaintenance(async () => undefined, {
      started: () => undefined,
      failed: () => undefined,
      completed: () => undefined,
    });
    expect(
      await alpha.submit(createDirectory("alpha-paused", "AlphaPaused"), requestState),
    ).toEqual({
      outcome: "operationally_blocked",
      gate: { code: "writes_paused" },
    });
    const betaApplied = await beta.submit(
      createDirectory("beta-queued", "Beta"),
      requestState,
    );
    expect(appliedRecord(betaApplied).changeSetId).toBe("beta-1");
    expect(betaAdapter.directories).toEqual(new Set(["Beta"]));
    expect(alphaAdapter.directories).toEqual(new Set());
    expect(alphaStore.state?.entries ?? []).toHaveLength(0);

    await alpha.resume();
    const alphaApplied = await alpha.submit(
      createDirectory("alpha-resumed", "Alpha"),
      requestState,
    );
    expect(appliedRecord(alphaApplied).changeSetId).toBe("alpha-1");
    expect(alphaAdapter.directories).toEqual(new Set(["Alpha"]));
    expect(betaAdapter.directories).toEqual(new Set(["Beta"]));
  });

  it("fails closed through maintenance until an explicit resume", async () => {
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

    await service.runMaintenance(
      async () => {
        expect(
          await service.submit(createDirectory("recovery-key", "RecoveryBlocked"), {
            vault: { writeGate: "blocked", writeState: "paused" },
            effectiveGate: { code: "recovery_blocked" },
          }),
        ).toMatchObject({
          outcome: "registered",
          changeSet: { state: "intent_not_applied" },
          gate: { code: "recovery_blocked" },
        });
        expect(
          await service.submit(
            createDirectory("upgrade-key", "DuringUpgrade"),
            requestState,
          ),
        ).toEqual({
          outcome: "operationally_blocked",
          gate: { code: "upgrade_in_progress" },
        });
      },
      {
        started: () => undefined,
        failed: () => undefined,
        completed: () => undefined,
      },
    );
    expect(store.state?.writeMode).toBe("maintenance_paused");
    expect(store.state?.lifecycle).toEqual({
      upgrade: "succeeded",
      migration: "succeeded",
    });
    expect(
      await service.submit(createDirectory("paused-key", "StillPaused"), requestState),
    ).toEqual({
      outcome: "operationally_blocked",
      gate: { code: "writes_paused" },
    });
    expect(store.state?.entries ?? []).toHaveLength(1);

    await service.resume();
    await service.submit(createDirectory("resumed-key", "Resumed"), requestState);
    expect(adapter.directories).toEqual(new Set(["Resumed"]));
  });

  it("closes admission before maintenance waits for the current Change Set", async () => {
    const store = new MemoryStore();
    const adapter = new DirectoryAdapter();
    let releaseCurrent!: () => void;
    let currentStarted!: () => void;
    const currentStartedPromise = new Promise<void>((resolve) => {
      currentStarted = resolve;
    });
    const currentBlocked = new Promise<void>((resolve) => {
      releaseCurrent = resolve;
    });
    const originalPublishDirectory = adapter.publishDirectory.bind(adapter);
    adapter.publishDirectory = async (stageId, path) => {
      currentStarted();
      await currentBlocked;
      await originalPublishDirectory(stageId, path);
    };
    const service = await ChangeSetService.open({
      store,
      dataSource: {
        readBinary: async () => null,
        pathKind: async (path) => (adapter.directories.has(path) ? "directory" : null),
        isContained: async () => true,
      },
      execution: adapter,
      createChangeSetId: () => "change-set-current",
    });
    const current = service.submit(createDirectory("current-key", "Current"), requestState);
    await currentStartedPromise;
    const maintenance = service.runMaintenance(async () => undefined, {
      started: () => undefined,
      failed: () => undefined,
      completed: () => undefined,
    });
    await vi.waitFor(() => expect(store.state?.writeMode).toBe("maintenance_pending"));

    expect(
      await service.submit(createDirectory("blocked-key", "Blocked"), requestState),
    ).toEqual({
      outcome: "operationally_blocked",
      gate: { code: "upgrade_in_progress" },
    });
    expect(store.state?.entries).toHaveLength(1);

    releaseCurrent();
    await Promise.all([current, maintenance]);
    expect(store.state?.writeMode).toBe("maintenance_paused");
  });

  it("serializes maintenance and resume across the whole migration", async () => {
    const service = await ChangeSetService.open({
      store: new MemoryStore(),
      dataSource: {
        readBinary: async () => null,
        pathKind: async () => null,
        isContained: async () => true,
      },
    });
    const events: string[] = [];
    let releaseFirst!: () => void;
    let firstStarted!: () => void;
    const firstStartedPromise = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const observer = {
      started: () => undefined,
      failed: () => undefined,
      completed: () => undefined,
    };

    const first = service.runMaintenance(async () => {
      events.push("first:start");
      firstStarted();
      await firstBlocked;
      events.push("first:end");
    }, observer);
    await firstStartedPromise;
    const second = service.runMaintenance(async () => {
      events.push("second:start");
      events.push("second:end");
    }, observer);
    const resumed = service.resume(undefined, () => {
      events.push("resume");
    });
    await Promise.resolve();
    expect(events).toEqual(["first:start"]);

    releaseFirst();
    await Promise.all([first, second, resumed]);
    expect(events).toEqual([
      "first:start",
      "first:end",
      "second:start",
      "second:end",
      "resume",
    ]);
  });

  it("executes concurrent submissions in persisted FIFO order under one write lease", async () => {
    const store = new MemoryStore();
    const adapter = new DirectoryAdapter();
    let activeMutations = 0;
    let maximumActiveMutations = 0;
    let secondAdmissionObserved = false;
    let observedQueue: RecordingRuntimeState["queue"] | undefined;
    const runtimeState = new RecordingRuntimeState();
    const originalPublishDirectory = adapter.publishDirectory.bind(adapter);
    adapter.publishDirectory = async (stageId, path) => {
      activeMutations += 1;
      maximumActiveMutations = Math.max(maximumActiveMutations, activeMutations);
      if (path === "First") {
        await new Promise((resolve) => setTimeout(resolve, 5));
        secondAdmissionObserved = store.state?.entries.length === 2;
        observedQueue = structuredClone(runtimeState.queue);
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
      runtimeState,
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
    expect(observedQueue).toEqual({
      currentExecutionId: "change-set-1",
      length: 2,
      headChangeSetId: "change-set-1",
    });
    expect(adapter.events.filter((event) => event.startsWith("mkdir:"))).toEqual([
      "mkdir:First",
      "mkdir:Second",
    ]);
    expect(store.state?.entries.map(({ enqueueSeq }) => enqueueSeq)).toEqual([1, 2]);
  });

  it("keeps Markdown and directory submissions in the same execution FIFO", async () => {
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

    expect(unsupported).toMatchObject({ changeSet: { state: "intent_applied" } });
    expect(directory).toMatchObject({ changeSet: { state: "intent_applied" } });
    expect(adapter.directories).toEqual(new Set(["Directory"]));
    expect(adapter.files.has("Note.md")).toBe(true);
    expect(adapter.events).toContain("write:Note.md");
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

  it("classifies a future Recovery Journal payload schema before composition", async () => {
    const root = await mkdtemp(join(tmpdir(), "change-set-incompatible-"));
    temporaryRoots.push(root);
    const journalPath = join(root, ".llm-wiki", "recovery-journal.bin");
    await mkdir(join(root, ".llm-wiki"), { recursive: true });
    const handle = await open(journalPath, "w+");
    const journal = await openRecoveryJournal(handle, { slotCapacity: 4096 });
    await journal.write({
      phase: "PREPARED",
      payload: { schemaVersion: RECOVERY_JOURNAL_FRAME_SCHEMA_VERSION + 1 },
    });
    await handle.close();

    await expect(
      createFileSystemChangeSetExecutionAdapter({
        journalPath,
        slotCapacity: 4096,
        host: {
          pathKind: async () => null,
          directoryIdentity: async () => null,
          prepareDirectory: async () => "directory",
          publishDirectory: async () => undefined,
          discardPreparedDirectory: async () => undefined,
          removeDirectory: async () => undefined,
          publishSearchSnapshot: async () => undefined,
        },
      }),
    ).rejects.toThrow(RecoveryJournalIncompatibleError);
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
