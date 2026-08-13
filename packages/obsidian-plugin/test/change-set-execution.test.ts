import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  rename,
  rm,
  rmdir,
  stat,
  symlink,
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
  createNodeFileSystemChangeSetHost,
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
import { createFileSystemChangeSetDataSource } from "../src/file-system-change-set-data-source.js";

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

// Windows only permits file symlinks with developer mode or elevation, so
// file-symlink coverage skips cleanly where the filesystem refuses them.
async function probeFileSymlinkSupport(): Promise<boolean> {
  const probe = await mkdtemp(join(tmpdir(), "file-symlink-capability-"));
  try {
    const target = join(probe, "target.bin");
    await writeFile(target, "x");
    await symlink(target, join(probe, "link.bin"), "file");
    return true;
  } catch {
    return false;
  } finally {
    await rm(probe, { recursive: true, force: true });
  }
}
const fileSymlinkSupported = await probeFileSymlinkSupport();

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

class FileAdapter extends DirectoryAdapter {
  readonly files = new Map<string, Uint8Array>();
  readonly stagedFiles = new Map<string, Uint8Array>();
  readonly managedTrash = new Map<string, Uint8Array>();
  readonly references = new Map<string, boolean>();
  readonly evidenceRequests: {
    readonly mode: "apply" | "restore";
    readonly operations: readonly unknown[];
    readonly publicPaths: readonly string[];
    readonly hiddenTrash: boolean;
    readonly requiredEvents: readonly unknown[];
    readonly referenceBaselines?: readonly { path: string; referenced: boolean }[];
  }[] = [];

  override async pathKind(path: string): Promise<"directory" | "file" | null> {
    this.events.push(`inspect:${path}`);
    if (this.directories.has(path)) return "directory";
    return this.files.has(path) ? "file" : null;
  }

  async readBinary(path: string): Promise<Uint8Array | null> {
    const bytes = this.files.get(path);
    return bytes === undefined ? null : Uint8Array.from(bytes);
  }

  async prepareFile(stageId: string, bytes: Uint8Array): Promise<string> {
    this.events.push(`stage-file:${stageId}`);
    this.stagedFiles.set(stageId, Uint8Array.from(bytes));
    return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  }

  async publishFile(stageId: string, path: string): Promise<void> {
    const bytes = this.stagedFiles.get(stageId);
    if (bytes === undefined) throw new Error("prepared file is missing");
    this.events.push(`publish-file:${path}`);
    this.files.set(path, bytes);
    this.fileIdentities.set(path, `sha256:${createHash("sha256").update(bytes).digest("hex")}`);
    this.stagedFiles.delete(stageId);
  }

  async discardPreparedFile(stageId: string): Promise<void> {
    this.stagedFiles.delete(stageId);
  }

  async removeFile(path: string): Promise<void> {
    this.events.push(`remove-file:${path}`);
    this.files.delete(path);
    this.fileIdentities.delete(path);
  }

  async moveFile(sourcePath: string, destinationPath: string): Promise<void> {
    const bytes = this.files.get(sourcePath);
    if (bytes === undefined || this.files.has(destinationPath)) {
      throw new Error("file move precondition failed");
    }
    this.events.push(`move-file:${sourcePath}->${destinationPath}`);
    this.files.set(destinationPath, bytes);
    this.files.delete(sourcePath);
  }

  async moveToTrash(path: string, trashId: string): Promise<void> {
    const bytes = this.files.get(path);
    if (bytes === undefined || this.managedTrash.has(trashId)) {
      throw new Error("managed trash precondition failed");
    }
    this.events.push(`trash:${path}`);
    this.managedTrash.set(trashId, bytes);
    this.files.delete(path);
  }

  async restoreFromTrash(trashId: string, path: string): Promise<void> {
    const bytes = this.managedTrash.get(trashId);
    if (bytes === undefined || this.files.has(path)) {
      throw new Error("managed trash restore precondition failed");
    }
    this.events.push(`restore:${path}`);
    this.files.set(path, bytes);
    this.managedTrash.delete(trashId);
  }

  async discardTrash(trashId: string): Promise<void> {
    this.managedTrash.delete(trashId);
  }

  async readTrash(trashId: string): Promise<Uint8Array | null> {
    const bytes = this.managedTrash.get(trashId);
    return bytes === undefined ? null : Uint8Array.from(bytes);
  }

  async referenced(path: string): Promise<boolean> {
    this.events.push(`references:${path}`);
    return this.references.get(path) ?? false;
  }

  async awaitSemanticEvidence(request: {
    readonly mode: "apply" | "restore";
    readonly operations: readonly unknown[];
    readonly publicPaths: readonly string[];
    readonly hiddenTrash: boolean;
    readonly requiredEvents: readonly unknown[];
    readonly referenceBaselines?: readonly { path: string; referenced: boolean }[];
  }): Promise<void> {
    this.evidenceRequests.push(request);
    this.events.push(`evidence:${request.publicPaths.join(",")}`);
  }
}

async function createRealFileExecution(root: string) {
  const host = await createNodeFileSystemChangeSetHost({
    basePath: root,
    stateDirectory: join(root, ".llm-wiki"),
    referenced: async () => false,
    awaitSemanticEvidence: async () => undefined,
    publishSearchSnapshot: async () => undefined,
  });
  const execution = await createFileSystemChangeSetExecutionAdapter({
    journalPath: join(root, ".llm-wiki", "recovery-journal.bin"),
    slotCapacity: 16 * 1024,
    host,
  });
  return {
    execution,
    dataSource: {
      readBinary: host.readBinary!,
      pathKind: host.pathKind,
      isContained: async () => true,
    },
  };
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

async function listFiles(directory: string): Promise<string[]> {
  try {
    const entries = await readdir(directory, { recursive: true, withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile())
      .map((entry) => join(entry.parentPath, entry.name));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
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
      // Rollback first inspects every directory, then executes the removals.
      "inspect:Projects/Alpha",
      "inspect:Projects",
      "rmdir:Projects/Alpha",
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

describe("durable attachment and managed-trash Change Set execution", () => {
  it("copies exact attachment bytes and commits typed hash evidence after the success barrier", async () => {
    const bytes = Uint8Array.from([0, 255, 35, 13, 10, 128]);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const store = new MemoryStore();
    const adapter = new FileAdapter();
    adapter.directories.add("assets");
    adapter.files.set("assets/source.bin", bytes);
    const service = await ChangeSetService.open({
      store,
      dataSource: {
        readBinary: (path) => adapter.readBinary(path),
        pathKind: (path) => adapter.pathKind(path),
        isContained: async () => true,
      },
      execution: adapter,
      createChangeSetId: () => "change-set-copy-attachment",
    });

    const result = await service.submit(
      {
        submissionKey: "copy-attachment-key",
        operations: [
          {
            operationId: "copy-1",
            kind: "copy_attachment",
            sourcePath: "assets/source.bin",
            destinationPath: "assets/copy.bin",
            expectedSha256: sha256,
          },
        ],
      },
      requestState,
    );
    const record = appliedRecord(result);

    expect(adapter.files.get("assets/source.bin")).toEqual(bytes);
    expect(adapter.files.get("assets/copy.bin")).toEqual(bytes);
    expect(record.paths).toEqual([
      {
        path: "assets/copy.bin",
        outcome: "changed",
        finalState: { kind: "attachment", sha256 },
      },
      {
        path: "assets/source.bin",
        outcome: "unchanged",
        finalState: { kind: "attachment", sha256 },
      },
    ]);
    expect(adapter.events).toContain("evidence:assets/copy.bin,assets/source.bin");
    expect(adapter.events.indexOf("evidence:assets/copy.bin,assets/source.bin")).toBeLessThan(
      adapter.events.indexOf("snapshot"),
    );
    expect(adapter.events.at(-1)).toBe("journal:COMMITTED");
  });
  it("rolls back attachment copy when semantic evidence fails closed", async () => {
    const bytes = Uint8Array.from([6, 7, 8]);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const store = new MemoryStore();
    const adapter = new FileAdapter();
    adapter.directories.add("assets");
    adapter.files.set("assets/source.bin", bytes);
    adapter.awaitSemanticEvidence = async (request) => {
      if (request.mode === "apply") throw new Error("semantic timeout");
      adapter.events.push("restore-evidence");
    };
    const service = await ChangeSetService.open({
      store,
      dataSource: {
        readBinary: (path) => adapter.readBinary(path),
        pathKind: (path) => adapter.pathKind(path),
        isContained: async () => true,
      },
      execution: adapter,
      createChangeSetId: () => "change-set-semantic-timeout",
    });

    const result = await service.submit(
      {
        submissionKey: "semantic-timeout-key",
        operations: [{
          operationId: "copy-timeout",
          kind: "copy_attachment",
          sourcePath: "assets/source.bin",
          destinationPath: "assets/copy.bin",
          expectedSha256: sha256,
        }],
      },
      requestState,
    );

    expect(result).toMatchObject({
      outcome: "registered",
      changeSet: { state: "intent_not_applied" },
    });
    expect(adapter.files.get("assets/source.bin")).toEqual(bytes);
    expect(adapter.files.has("assets/copy.bin")).toBe(false);
    expect(adapter.frame?.phase).toBe("ROLLED_BACK");
  });

  it("fails closed before managed trash when reference evidence is unavailable", async () => {
    const bytes = Buffer.from("# Keep me\n");
    const targetVersion = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    const store = new MemoryStore();
    const adapter = new FileAdapter();
    adapter.files.set("Keep.md", bytes);
    adapter.referenced = undefined as never;
    const service = await ChangeSetService.open({
      store,
      dataSource: {
        readBinary: (path) => adapter.readBinary(path),
        pathKind: (path) => adapter.pathKind(path),
        isContained: async () => true,
      },
      execution: adapter,
      createChangeSetId: () => "change-set-missing-reference-evidence",
    });

    await expect(
      service.submit(
        {
          submissionKey: "missing-reference-evidence-key",
          operations: [{
            operationId: "trash-without-reference-evidence",
            kind: "trash",
            path: "Keep.md",
            targetVersion,
          }],
        },
        requestState,
      ),
    ).rejects.toThrow("Managed trash reference evidence is unavailable");

    expect(adapter.files.get("Keep.md")).toEqual(bytes);
    expect(adapter.events).not.toContain("trash:Keep.md");
    expect(adapter.frame).toBeNull();
  });

  it("retains committed managed trash privately so the operation remains reversible", async () => {
    const bytes = Buffer.from("# Clean me\n");
    const targetVersion = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    const store = new MemoryStore();
    const adapter = new FileAdapter();
    adapter.files.set("Clean.md", bytes);
    const discarded: string[] = [];
    const originalDiscard = adapter.discardTrash.bind(adapter);
    adapter.discardTrash = async (trashId) => {
      discarded.push(trashId);
      expect(adapter.frame?.phase).toBe("COMMITTED");
      await originalDiscard(trashId);
    };
    const service = await ChangeSetService.open({
      store,
      dataSource: {
        readBinary: (path) => adapter.readBinary(path),
        pathKind: (path) => adapter.pathKind(path),
        isContained: async () => true,
      },
      execution: adapter,
      createChangeSetId: () => "change-set-trash-cleanup",
    });

    const record = appliedRecord(
      await service.submit(
        {
          submissionKey: "trash-cleanup-key",
          operations: [{
            operationId: "trash-cleanup",
            kind: "trash",
            path: "Clean.md",
            targetVersion,
          }],
        },
        requestState,
      ),
    );

    expect(record.paths).toEqual([
      { path: "Clean.md", outcome: "changed", finalState: { kind: "absent" } },
    ]);
    expect(discarded).toEqual([]);
    expect(adapter.managedTrash.size).toBe(1);
  });

  it("moves exact attachment bytes and reports source absence with typed destination evidence", async () => {
    const bytes = Uint8Array.from([137, 80, 78, 71, 0, 255]);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const store = new MemoryStore();
    const adapter = new FileAdapter();
    adapter.directories.add("assets");
    adapter.files.set("assets/old.bin", bytes);
    const service = await ChangeSetService.open({
      store,
      dataSource: {
        readBinary: (path) => adapter.readBinary(path),
        pathKind: (path) => adapter.pathKind(path),
        isContained: async () => true,
      },
      execution: adapter,
      createChangeSetId: () => "change-set-move-attachment",
    });

    const record = appliedRecord(
      await service.submit(
        {
          submissionKey: "move-attachment-key",
          operations: [
            {
              operationId: "move-attachment-1",
              kind: "move_attachment",
              sourcePath: "assets/old.bin",
              destinationPath: "assets/new.bin",
              expectedSha256: sha256,
            },
          ],
        },
        requestState,
      ),
    );

    expect(adapter.files.has("assets/old.bin")).toBe(false);
    expect(adapter.files.get("assets/new.bin")).toEqual(bytes);
    expect(record.paths).toEqual([
      {
        path: "assets/new.bin",
        outcome: "changed",
        finalState: { kind: "attachment", sha256 },
      },
      {
        path: "assets/old.bin",
        outcome: "changed",
        finalState: { kind: "absent" },
      },
    ]);
  });

  it("trashes a binary attachment with SHA-256 evidence and no content version", async () => {
    const bytes = Uint8Array.from([0, 255, 1, 254]);
    const expectedSha256 = createHash("sha256").update(bytes).digest("hex");
    const store = new MemoryStore();
    const adapter = new FileAdapter();
    adapter.directories.add("assets");
    adapter.files.set("assets/private.bin", bytes);
    const service = await ChangeSetService.open({
      store,
      dataSource: {
        readBinary: (path) => adapter.readBinary(path),
        pathKind: (path) => adapter.pathKind(path),
        isContained: async () => true,
      },
      execution: adapter,
      createChangeSetId: () => "change-set-trash-attachment",
    });

    const result = await service.submit(
      {
        submissionKey: "trash-attachment-key",
        operations: [{
          operationId: "trash-attachment",
          kind: "trash",
          path: "assets/private.bin",
          expectedSha256,
        }],
      },
      requestState,
    );
    const record = appliedRecord(result);

    expect(record.preview.paths).toEqual([{
      path: "assets/private.bin",
      preState: { kind: "attachment", sha256: expectedSha256 },
      projectedFinalState: { kind: "absent" },
      projectedOutcome: "changed",
    }]);
    expect(record.paths).toEqual([{
      path: "assets/private.bin",
      outcome: "changed",
      finalState: { kind: "absent" },
    }]);
    expect([...adapter.managedTrash.values()]).toEqual([bytes]);
    expect(adapter.frame?.mutations).toEqual([
      expect.objectContaining({
        kind: "trash",
        path: "assets/private.bin",
        referencedBefore: false,
      }),
    ]);
    expect(JSON.stringify(result)).not.toContain("contentVersion");
  });

  it("restores a trashed attachment with exact SHA-256 bytes after restart", async () => {
    const bytes = Uint8Array.from([11, 22, 33, 0, 255]);
    const expectedSha256 = createHash("sha256").update(bytes).digest("hex");
    const store = new MemoryStore();
    const adapter = new FileAdapter();
    adapter.directories.add("assets");
    adapter.files.set("assets/restore.bin", bytes);
    adapter.references.set("assets/restore.bin", true);
    const dataSource = {
      readBinary: (path: string) => adapter.readBinary(path),
      pathKind: (path: string) => adapter.pathKind(path),
      isContained: async () => true,
    };
    const crashing = await ChangeSetService.open({
      store,
      dataSource,
      execution: adapter,
      createChangeSetId: () => "change-set-trash-attachment-crash",
      crashInjector: (point) => {
        if (point === "after_mutation:0") throw new InjectedChangeSetCrash(point);
      },
    });
    await expect(
      crashing.submit(
        {
          submissionKey: "trash-attachment-crash-key",
          operations: [{
            operationId: "trash-attachment-crash",
            kind: "trash",
            path: "assets/restore.bin",
            expectedSha256,
          }],
        },
        requestState,
      ),
    ).rejects.toThrow(InjectedChangeSetCrash);
    expect([...adapter.managedTrash.values()]).toEqual([bytes]);
    expect(adapter.frame?.mutations).toEqual([
      expect.objectContaining({
        kind: "trash",
        path: "assets/restore.bin",
        referencedBefore: true,
      }),
    ]);
    expect(adapter.events.indexOf("references:assets/restore.bin")).toBeLessThan(
      adapter.events.indexOf("journal:PREPARED"),
    );
    expect(adapter.events.indexOf("journal:PREPARED")).toBeLessThan(
      adapter.events.indexOf("trash:assets/restore.bin"),
    );

    const recovered = await ChangeSetService.open({ store, dataSource, execution: adapter });

    expect(adapter.files.get("assets/restore.bin")).toEqual(bytes);
    expect(adapter.managedTrash.size).toBe(0);
    expect(adapter.evidenceRequests.at(-1)).toMatchObject({
      mode: "restore",
      referenceBaselines: [{ path: "assets/restore.bin", referenced: true }],
    });
    await expect(
      recovered.status({ changeSetId: "change-set-trash-attachment-crash" }, requestState),
    ).resolves.toMatchObject({ lookup: "found", changeSet: { state: "intent_not_applied" } });
  });

  it("moves Markdown into private managed trash without exposing its mapping", async () => {
    const bytes = Buffer.from("# Private note\n");
    const targetVersion = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    const store = new MemoryStore();
    const adapter = new FileAdapter();
    adapter.files.set("Private.md", bytes);
    const service = await ChangeSetService.open({
      store,
      dataSource: {
        readBinary: (path) => adapter.readBinary(path),
        pathKind: (path) => adapter.pathKind(path),
        isContained: async () => true,
      },
      execution: adapter,
      createChangeSetId: () => "change-set-trash",
    });

    const result = await service.submit(
      {
        submissionKey: "trash-key",
        operations: [
          {
            operationId: "trash-1",
            kind: "trash",
            path: "Private.md",
            targetVersion,
          },
        ],
      },
      requestState,
    );
    const record = appliedRecord(result);

    expect(adapter.files.has("Private.md")).toBe(false);
    expect([...adapter.managedTrash.values()]).toEqual([bytes]);
    expect(record.paths).toEqual([
      { path: "Private.md", outcome: "changed", finalState: { kind: "absent" } },
    ]);
    expect(JSON.stringify(result)).not.toContain("change-set-trash/0");
    expect(adapter.evidenceRequests).toContainEqual({
      mode: "apply",
      operations: [{
        operationId: "trash-1",
        kind: "trash",
        path: "Private.md",
        targetVersion,
      }],
      publicPaths: ["Private.md"],
      hiddenTrash: true,
      requiredEvents: [],
    });
  });

  it("restores a chained attachment path from an intermediate crash state", async () => {
    const bytes = Uint8Array.from([2, 4, 6, 8]);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const store = new MemoryStore();
    const adapter = new FileAdapter();
    adapter.directories.add("assets");
    adapter.files.set("assets/source.bin", bytes);
    const dataSource = {
      readBinary: (path: string) => adapter.readBinary(path),
      pathKind: (path: string) => adapter.pathKind(path),
      isContained: async () => true,
    };
    const crashing = await ChangeSetService.open({
      store,
      dataSource,
      execution: adapter,
      createChangeSetId: () => "change-set-chain-crash",
      crashInjector: (point) => {
        if (point === "after_mutation:1") throw new InjectedChangeSetCrash(point);
      },
    });
    await expect(
      crashing.submit(
        {
          submissionKey: "chain-crash-key",
          operations: [
            {
              operationId: "copy-chain",
              kind: "copy_attachment",
              sourcePath: "assets/source.bin",
              destinationPath: "assets/intermediate.bin",
              expectedSha256: sha256,
            },
            {
              operationId: "move-chain",
              afterOperationId: "copy-chain",
              kind: "move_attachment",
              sourcePath: "assets/intermediate.bin",
              destinationPath: "assets/final.bin",
              expectedSha256: sha256,
            },
          ],
        },
        requestState,
      ),
    ).rejects.toThrow(InjectedChangeSetCrash);

    const recovered = await ChangeSetService.open({ store, dataSource, execution: adapter });

    expect(adapter.files.get("assets/source.bin")).toEqual(bytes);
    expect(adapter.frame?.phase).toBe("ROLLED_BACK");
    expect(adapter.files.has("assets/intermediate.bin")).toBe(false);
    expect(adapter.files.has("assets/final.bin")).toBe(false);
    await expect(
      recovered.status({ changeSetId: "change-set-chain-crash" }, requestState),
    ).resolves.toMatchObject({ lookup: "found", changeSet: { state: "intent_not_applied" } });
  });

  it("copies exact bytes through the production filesystem host", async () => {
    const root = await mkdtemp(join(tmpdir(), "attachment-copy-"));
    temporaryRoots.push(root);
    await mkdir(join(root, "assets"));
    const bytes = Uint8Array.from([0, 255, 13, 10, 128, 35]);
    await writeFile(join(root, "assets", "source.bin"), bytes);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const store = new MemoryStore();
    const { execution, dataSource } = await createRealFileExecution(root);
    const service = await ChangeSetService.open({
      store,
      dataSource,
      execution,
      createChangeSetId: () => "real-copy",
    });

    const result = await service.submit(
      {
        submissionKey: "real-copy-key",
        operations: [{
          operationId: "real-copy-operation",
          kind: "copy_attachment",
          sourcePath: "assets/source.bin",
          destinationPath: "assets/copy.bin",
          expectedSha256: sha256,
        }],
      },
      requestState,
    );

    expect(appliedRecord(result).paths).toContainEqual({
      path: "assets/copy.bin",
      outcome: "changed",
      finalState: { kind: "attachment", sha256 },
    });
    expect(await readFile(join(root, "assets", "source.bin"))).toEqual(Buffer.from(bytes));
    expect(await readFile(join(root, "assets", "copy.bin"))).toEqual(Buffer.from(bytes));
    await execution.close?.();
  });

  for (const operation of ["move_attachment", "trash"] as const) {
    it(`reopens the production journal and restores ${operation} exact bytes`, async () => {
      const root = await mkdtemp(join(tmpdir(), `real-${operation}-`));
      temporaryRoots.push(root);
      await mkdir(join(root, "assets"));
      const bytes = operation === "trash"
        ? Buffer.from("# Durable trash\r\n")
        : Uint8Array.from([9, 8, 7, 0, 255]);
      const sourcePath = operation === "trash" ? "Note.md" : "assets/source.bin";
      await writeFile(join(root, ...sourcePath.split("/")), bytes);
      const digest = createHash("sha256").update(bytes).digest("hex");
      const store = new MemoryStore();
      const first = await createRealFileExecution(root);
      const crashing = await ChangeSetService.open({
        store,
        dataSource: first.dataSource,
        execution: first.execution,
        vaultId: "real-vault",
        createChangeSetId: () => `real-${operation}`,
        crashInjector: (point) => {
          if (point === "after_mutation:0") throw new InjectedChangeSetCrash(point);
        },
      });
      const input = operation === "trash"
        ? {
            submissionKey: "real-trash-key",
            operations: [{
              operationId: "real-trash-operation",
              kind: "trash" as const,
              path: sourcePath,
              targetVersion: `sha256:${digest}`,
            }],
          }
        : {
            submissionKey: "real-move-key",
            operations: [{
              operationId: "real-move-operation",
              kind: "move_attachment" as const,
              sourcePath,
              destinationPath: "assets/destination.bin",
              expectedSha256: digest,
            }],
          };
      await expect(crashing.submit(input, requestState)).rejects.toThrow(InjectedChangeSetCrash);
      await first.execution.close?.();

      const second = await createRealFileExecution(root);
      const recovered = await ChangeSetService.open({
        store,
        dataSource: second.dataSource,
        execution: second.execution,
        vaultId: "real-vault",
      });

      expect(await readFile(join(root, ...sourcePath.split("/")))).toEqual(
        Buffer.from(bytes),
      );
      await expect(readFile(join(root, "assets", "destination.bin"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(
        recovered.status({ changeSetId: `real-${operation}` }, requestState),
      ).resolves.toMatchObject({
        lookup: "found",
        changeSet: { state: "intent_not_applied" },
      });
      await second.execution.close?.();
    });
  }

  it("rejects a junction that escapes the Vault at the production mutation boundary", async () => {
    const root = await mkdtemp(join(tmpdir(), "attachment-junction-"));
    temporaryRoots.push(root);
    const outside = await mkdtemp(join(tmpdir(), "attachment-outside-"));
    temporaryRoots.push(outside);
    await mkdir(join(root, "assets"));
    const bytes = Uint8Array.from([4, 5, 6]);
    await writeFile(join(outside, "outside.bin"), bytes);
    await symlink(outside, join(root, "assets", "escape"), "junction");
    const host = await createNodeFileSystemChangeSetHost({
      basePath: root,
      stateDirectory: join(root, ".llm-wiki"),
      awaitSemanticEvidence: async () => undefined,
      publishSearchSnapshot: async () => undefined,
    });

    await expect(host.readBinary?.("assets/escape/outside.bin")).rejects.toThrow(
      "Vault path escaped containment",
    );
    await expect(readFile(join(outside, "outside.bin"))).resolves.toEqual(Buffer.from(bytes));
  });

  it("rejects a private managed-trash junction that escapes the Vault", async () => {
    const root = await mkdtemp(join(tmpdir(), "private-trash-junction-"));
    temporaryRoots.push(root);
    const outside = await mkdtemp(join(tmpdir(), "private-trash-outside-"));
    temporaryRoots.push(outside);
    await mkdir(join(root, ".llm-wiki"), { recursive: true });
    await symlink(outside, join(root, ".llm-wiki", "trash"), "junction");
    const host = await createNodeFileSystemChangeSetHost({
      basePath: root,
      stateDirectory: join(root, ".llm-wiki"),
      awaitSemanticEvidence: async () => undefined,
      publishSearchSnapshot: async () => undefined,
    });

    await expect(host.readTrash?.("change-set/0")).rejects.toThrow(
      "Bridge private path escaped containment",
    );
  });

  it.skipIf(!fileSymlinkSupported)(
    "rejects file symlinks at the production mutation boundary",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "attachment-file-symlink-"));
      temporaryRoots.push(root);
      const outside = await mkdtemp(join(tmpdir(), "attachment-symlink-outside-"));
      temporaryRoots.push(outside);
      await mkdir(join(root, "assets"));
      const bytes = Uint8Array.from([4, 5, 6]);
      await writeFile(join(outside, "outside.bin"), bytes);
      await symlink(join(outside, "outside.bin"), join(root, "assets", "link.bin"), "file");
      const host = await createNodeFileSystemChangeSetHost({
        basePath: root,
        stateDirectory: join(root, ".llm-wiki"),
        awaitSemanticEvidence: async () => undefined,
        publishSearchSnapshot: async () => undefined,
      });

      await expect(host.readBinary?.("assets/link.bin")).rejects.toThrow(
        "Symbolic links cannot be mutated through Change Sets",
      );
      await expect(host.removeFile?.("assets/link.bin")).rejects.toThrow(
        "Symbolic links cannot be mutated through Change Sets",
      );
      await expect(host.pathKind("assets/link.bin")).rejects.toThrow(
        "Symbolic links cannot be mutated through Change Sets",
      );
      await expect(readFile(join(outside, "outside.bin"))).resolves.toEqual(
        Buffer.from(bytes),
      );
    },
  );

  it("rejects end-to-end escapes through copy, move, and trash submission", async () => {
    const root = await mkdtemp(join(tmpdir(), "attachment-e2e-escape-"));
    temporaryRoots.push(root);
    const outside = await mkdtemp(join(tmpdir(), "attachment-e2e-outside-"));
    temporaryRoots.push(outside);
    await mkdir(join(root, "assets"));
    const bytes = Uint8Array.from([8, 8, 8]);
    const outsideBytes = Uint8Array.from([6, 6, 6]);
    await writeFile(join(root, "assets", "source.bin"), bytes);
    await writeFile(join(outside, "outside.bin"), outsideBytes);
    await symlink(outside, join(root, "assets", "escape"), "junction");
    const host = await createNodeFileSystemChangeSetHost({
      basePath: root,
      stateDirectory: join(root, ".llm-wiki"),
      awaitSemanticEvidence: async () => undefined,
      publishSearchSnapshot: async () => undefined,
    });
    const execution = await createFileSystemChangeSetExecutionAdapter({
      journalPath: join(root, ".llm-wiki", "recovery-journal.bin"),
      slotCapacity: 16 * 1024,
      host,
    });
    const vaultAdapter = {
      exists: async (path: string) =>
        (await stat(join(root, ...path.split("/"))).catch(() => null)) !== null,
      readBinary: (path: string) => readFile(join(root, ...path.split("/"))),
      stat: async (path: string) => {
        try {
          const value = await stat(join(root, ...path.split("/")));
          return { type: value.isDirectory() ? ("folder" as const) : ("file" as const) };
        } catch {
          return null;
        }
      },
    };
    const dataSource = createFileSystemChangeSetDataSource(root, vaultAdapter);
    const store = new MemoryStore();
    const service = await ChangeSetService.open({
      store,
      dataSource,
      execution,
      vaultId: "escape-vault",
    });
    const digest = (content: Uint8Array) =>
      createHash("sha256").update(content).digest("hex");
    const cases = [
      {
        key: "escape-copy",
        operation: {
          operationId: "escape-copy",
          kind: "copy_attachment" as const,
          sourcePath: "assets/source.bin",
          destinationPath: "assets/escape/copied.bin",
          expectedSha256: digest(bytes),
        },
      },
      {
        key: "escape-move",
        operation: {
          operationId: "escape-move",
          kind: "move_attachment" as const,
          sourcePath: "assets/escape/outside.bin",
          destinationPath: "assets/moved.bin",
          expectedSha256: digest(outsideBytes),
        },
      },
      {
        key: "escape-trash",
        operation: {
          operationId: "escape-trash",
          kind: "trash" as const,
          path: "assets/escape/outside.bin",
          expectedSha256: digest(outsideBytes),
        },
      },
    ];

    for (const { key, operation } of cases) {
      const result = await service.submit(
        { submissionKey: key, operations: [operation] },
        requestState,
      );
      expect(result).toMatchObject({
        outcome: "registered",
        changeSet: {
          state: "intent_not_applied",
          failure: { code: "path_conflict" },
        },
      });
    }

    expect(await readFile(join(outside, "outside.bin"))).toEqual(
      Buffer.from(outsideBytes),
    );
    await expect(stat(join(outside, "copied.bin"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await readFile(join(root, "assets", "source.bin"))).toEqual(Buffer.from(bytes));
    await execution.close?.();
  });

  it.skipIf(!fileSymlinkSupported)(
    "rejects end-to-end copy, move, and trash submission through a file symlink",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "trash-file-symlink-"));
      temporaryRoots.push(root);
      const outside = await mkdtemp(join(tmpdir(), "trash-symlink-outside-"));
      temporaryRoots.push(outside);
      await mkdir(join(root, "assets"));
      const outsideBytes = Uint8Array.from([3, 2, 1]);
      await writeFile(join(outside, "outside.bin"), outsideBytes);
      await symlink(join(outside, "outside.bin"), join(root, "link.bin"), "file");
      const host = await createNodeFileSystemChangeSetHost({
        basePath: root,
        stateDirectory: join(root, ".llm-wiki"),
        awaitSemanticEvidence: async () => undefined,
        publishSearchSnapshot: async () => undefined,
      });
      const execution = await createFileSystemChangeSetExecutionAdapter({
        journalPath: join(root, ".llm-wiki", "recovery-journal.bin"),
        slotCapacity: 16 * 1024,
        host,
      });
      const vaultAdapter = {
        exists: async (path: string) =>
          (await stat(join(root, ...path.split("/"))).catch(() => null)) !== null,
        readBinary: (path: string) => readFile(join(root, ...path.split("/"))),
        stat: async (path: string) => {
          try {
            const value = await stat(join(root, ...path.split("/")));
            return { type: value.isDirectory() ? ("folder" as const) : ("file" as const) };
          } catch {
            return null;
          }
        },
      };
      const store = new MemoryStore();
      const service = await ChangeSetService.open({
        store,
        dataSource: createFileSystemChangeSetDataSource(root, vaultAdapter),
        execution,
        vaultId: "escape-vault",
      });
      const outsideSha256 = createHash("sha256").update(outsideBytes).digest("hex");
      const cases = [
        {
          key: "escape-file-symlink-copy",
          operation: {
            operationId: "escape-file-symlink-copy",
            kind: "copy_attachment" as const,
            sourcePath: "link.bin",
            destinationPath: "assets/copied.bin",
            expectedSha256: outsideSha256,
          },
        },
        {
          key: "escape-file-symlink-move",
          operation: {
            operationId: "escape-file-symlink-move",
            kind: "move_attachment" as const,
            sourcePath: "link.bin",
            destinationPath: "assets/moved.bin",
            expectedSha256: outsideSha256,
          },
        },
        {
          key: "escape-file-symlink-trash",
          operation: {
            operationId: "escape-file-symlink-trash",
            kind: "trash" as const,
            path: "link.bin",
            expectedSha256: outsideSha256,
          },
        },
      ];

      for (const { key, operation } of cases) {
        const result = await service.submit(
          { submissionKey: key, operations: [operation] },
          requestState,
        );
        expect(result).toMatchObject({
          outcome: "registered",
          changeSet: {
            state: "intent_not_applied",
            failure: { code: "path_conflict" },
          },
        });
      }

      expect(await readFile(join(outside, "outside.bin"))).toEqual(
        Buffer.from(outsideBytes),
      );
      await expect(stat(join(root, "assets", "copied.bin"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(stat(join(root, "assets", "moved.bin"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      await execution.close?.();
    },
  );

  it("fails closed on an on-disk journal frame that is valid but mismatches the registry", async () => {
    const root = await mkdtemp(join(tmpdir(), "real-journal-mismatch-"));
    temporaryRoots.push(root);
    const store = new MemoryStore();
    const first = await createRealFileExecution(root);
    const crashing = await ChangeSetService.open({
      store,
      dataSource: first.dataSource,
      execution: first.execution,
      vaultId: "real-journal-mismatch-vault",
      createChangeSetId: () => "change-set-journal-mismatch",
      crashInjector: (point) => {
        if (point === "before_prepared") throw new InjectedChangeSetCrash(point);
      },
    });
    const input = {
      submissionKey: "journal-mismatch-key",
      operations: [{
        operationId: "mkdir-1",
        kind: "create_directory" as const,
        path: "Projects/Alpha",
        ifExists: "reject" as const,
      }],
    };
    await expect(crashing.submit(input, requestState)).rejects.toThrow(
      InjectedChangeSetCrash,
    );
    await first.execution.close?.();

    // Rewrite the journal on disk through the real frame writer: the frame
    // carries a fresh valid checksum and parses cleanly, but its enqueueSeq
    // does not match the Change Set registry entry.
    const journalPath = join(root, ".llm-wiki", "recovery-journal.bin");
    const handle = await open(journalPath, "r+");
    const journal = await openRecoveryJournal(handle, { slotCapacity: 16 * 1024 });
    await journal.write({
      phase: "PREPARED",
      payload: {
        schemaVersion: RECOVERY_JOURNAL_FRAME_SCHEMA_VERSION,
        vaultId: "real-journal-mismatch-vault",
        changeSetId: "change-set-journal-mismatch",
        enqueueSeq: 999,
        phase: "PREPARED",
        input,
        preview: { requestedEffects: [], derivedEffects: [], paths: [] },
        directories: [],
        files: [],
      },
    });
    await handle.close();
    const blocked: string[] = [];

    const second = await createRealFileExecution(root);
    const recovered = await ChangeSetService.open({
      store,
      dataSource: second.dataSource,
      execution: second.execution,
      vaultId: "real-journal-mismatch-vault",
      runtimeState: {
        setQueue: () => undefined,
        blockWritesForUnproven: (changeSetId) => blocked.push(changeSetId),
      },
    });

    expect(blocked).toEqual(["change-set-journal-mismatch"]);
    await expect(
      recovered.status({ changeSetId: "change-set-journal-mismatch" }, requestState),
    ).resolves.toMatchObject({
      lookup: "found",
      changeSet: { state: "result_unproven" },
    });
    await second.execution.close?.();
  });

  it("recovers a legacy v1 COMMITTED frame with final-path evidence as applied", async () => {
    const root = await mkdtemp(join(tmpdir(), "real-v1-committed-"));
    temporaryRoots.push(root);
    const store = new MemoryStore();
    const first = await createRealFileExecution(root);
    const crashing = await ChangeSetService.open({
      store,
      dataSource: first.dataSource,
      execution: first.execution,
      vaultId: "real-v1-committed-vault",
      createChangeSetId: () => "change-set-v1-committed",
      crashInjector: (point) => {
        if (point === "before_prepared") throw new InjectedChangeSetCrash(point);
      },
    });
    await expect(
      crashing.submit(
        {
          submissionKey: "v1-committed-key",
          operations: [{
            operationId: "mkdir-1",
            kind: "create_directory" as const,
            path: "Projects/Alpha",
            ifExists: "reject" as const,
          }],
        },
        requestState,
      ),
    ).rejects.toThrow(InjectedChangeSetCrash);
    await first.execution.close?.();

    const entry = store.state?.entries[0];
    if (
      entry === undefined ||
      entry.execution === undefined ||
      entry.changeSet.state !== "in_progress" ||
      entry.changeSet.preview === undefined
    ) {
      throw new Error("expected a queued in-progress registry entry");
    }
    const preview = entry.changeSet.preview;
    // The v1 (directory-only) writer always journaled finalPaths on COMMITTED,
    // so a well-formed legacy frame still converges to intent_applied.
    const journalPath = join(root, ".llm-wiki", "recovery-journal.bin");
    const handle = await open(journalPath, "r+");
    const journal = await openRecoveryJournal(handle, { slotCapacity: 16 * 1024 });
    await journal.write({
      phase: "COMMITTED",
      payload: {
        schemaVersion: 1,
        vaultId: "real-v1-committed-vault",
        changeSetId: "change-set-v1-committed",
        enqueueSeq: entry.enqueueSeq,
        phase: "COMMITTED",
        input: entry.execution.input,
        preview,
        directories: [
          { path: "Projects", before: "absent", expectedAfter: "directory" },
          { path: "Projects/Alpha", before: "absent", expectedAfter: "directory" },
        ],
        finalPaths: preview.paths.map(({ path, projectedOutcome, projectedFinalState }) => ({
          path,
          outcome: projectedOutcome,
          finalState: projectedFinalState,
        })),
      },
    });
    await handle.close();
    const blocked: string[] = [];

    const second = await createRealFileExecution(root);
    const recovered = await ChangeSetService.open({
      store,
      dataSource: second.dataSource,
      execution: second.execution,
      vaultId: "real-v1-committed-vault",
      runtimeState: {
        setQueue: () => undefined,
        blockWritesForUnproven: (changeSetId) => blocked.push(changeSetId),
      },
    });

    expect(blocked).toEqual([]);
    await expect(
      recovered.status({ changeSetId: "change-set-v1-committed" }, requestState),
    ).resolves.toMatchObject({
      lookup: "found",
      changeSet: { state: "intent_applied" },
    });
    await second.execution.close?.();
  });

  it("fails closed on a legacy v1 COMMITTED frame without final-path evidence", async () => {
    const root = await mkdtemp(join(tmpdir(), "real-v1-unproven-"));
    temporaryRoots.push(root);
    const store = new MemoryStore();
    const first = await createRealFileExecution(root);
    const crashing = await ChangeSetService.open({
      store,
      dataSource: first.dataSource,
      execution: first.execution,
      vaultId: "real-v1-unproven-vault",
      createChangeSetId: () => "change-set-v1-unproven",
      crashInjector: (point) => {
        if (point === "before_prepared") throw new InjectedChangeSetCrash(point);
      },
    });
    await expect(
      crashing.submit(
        {
          submissionKey: "v1-unproven-key",
          operations: [{
            operationId: "mkdir-1",
            kind: "create_directory" as const,
            path: "Projects/Alpha",
            ifExists: "reject" as const,
          }],
        },
        requestState,
      ),
    ).rejects.toThrow(InjectedChangeSetCrash);
    await first.execution.close?.();

    const entry = store.state?.entries[0];
    if (
      entry === undefined ||
      entry.execution === undefined ||
      entry.changeSet.state !== "in_progress" ||
      entry.changeSet.preview === undefined
    ) {
      throw new Error("expected a queued in-progress registry entry");
    }
    // A COMMITTED frame without finalPaths can only come from a torn or
    // corrupted write; the Bridge must not infer success from the preview.
    const journalPath = join(root, ".llm-wiki", "recovery-journal.bin");
    const handle = await open(journalPath, "r+");
    const journal = await openRecoveryJournal(handle, { slotCapacity: 16 * 1024 });
    await journal.write({
      phase: "COMMITTED",
      payload: {
        schemaVersion: 1,
        vaultId: "real-v1-unproven-vault",
        changeSetId: "change-set-v1-unproven",
        enqueueSeq: entry.enqueueSeq,
        phase: "COMMITTED",
        input: entry.execution.input,
        preview: entry.changeSet.preview,
        directories: [
          { path: "Projects", before: "absent", expectedAfter: "directory" },
          { path: "Projects/Alpha", before: "absent", expectedAfter: "directory" },
        ],
      },
    });
    await handle.close();
    const blocked: string[] = [];

    const second = await createRealFileExecution(root);
    const recovered = await ChangeSetService.open({
      store,
      dataSource: second.dataSource,
      execution: second.execution,
      vaultId: "real-v1-unproven-vault",
      runtimeState: {
        setQueue: () => undefined,
        blockWritesForUnproven: (changeSetId) => blocked.push(changeSetId),
      },
    });

    expect(blocked).toEqual(["change-set-v1-unproven"]);
    await expect(
      recovered.status({ changeSetId: "change-set-v1-unproven" }, requestState),
    ).resolves.toMatchObject({
      lookup: "found",
      changeSet: { state: "result_unproven" },
    });
    await second.execution.close?.();
  });

  it("rejects attachment collisions and protected locations on the real filesystem", async () => {
    const root = await mkdtemp(join(tmpdir(), "real-collision-protected-"));
    temporaryRoots.push(root);
    const bytes = Uint8Array.from([1, 2, 3]);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    await mkdir(join(root, "assets"));
    await mkdir(join(root, ".git"));
    await mkdir(join(root, ".obsidian"));
    await mkdir(join(root, ".trash"));
    await writeFile(join(root, "assets", "source.bin"), bytes);
    const existing = Uint8Array.from([9]);
    await writeFile(join(root, "assets", "existing.bin"), existing);
    for (const destinationPath of [
      "assets/existing.bin",
      ".git/object.bin",
      ".obsidian/plugin.bin",
      ".llm-wiki/private.bin",
      ".trash/hidden.bin",
    ]) {
      const store = new MemoryStore();
      const { execution, dataSource } = await createRealFileExecution(root);
      const service = await ChangeSetService.open({
        store,
        dataSource,
        execution,
        createChangeSetId: () => `change-set-real-protected-${destinationPath}`,
      });

      const result = await service.submit(
        {
          submissionKey: `real-protected-${destinationPath}`,
          operations: [{
            operationId: "copy-protected",
            kind: "copy_attachment",
            sourcePath: "assets/source.bin",
            destinationPath,
            expectedSha256: sha256,
          }],
        },
        requestState,
      );

      expect(result).toMatchObject({
        outcome: "registered",
        changeSet: {
          state: "intent_not_applied",
          failure: { code: "path_conflict", path: destinationPath },
        },
      });
      await execution.close?.();
    }
    expect(await readFile(join(root, "assets", "existing.bin"))).toEqual(
      Buffer.from(existing),
    );
    await expect(stat(join(root, ".git", "object.bin"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(stat(join(root, ".obsidian", "plugin.bin"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(stat(join(root, ".llm-wiki", "private.bin"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(stat(join(root, ".trash", "hidden.bin"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("blocks recovery rather than overwriting a third-party attachment on the real filesystem", async () => {
    const root = await mkdtemp(join(tmpdir(), "real-third-party-"));
    temporaryRoots.push(root);
    await mkdir(join(root, "assets"));
    const bytes = Uint8Array.from([1, 2, 3, 4]);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    await writeFile(join(root, "assets", "source.bin"), bytes);
    const store = new MemoryStore();
    const first = await createRealFileExecution(root);
    const crashing = await ChangeSetService.open({
      store,
      dataSource: first.dataSource,
      execution: first.execution,
      vaultId: "real-third-party-vault",
      createChangeSetId: () => "change-set-real-third-party",
      crashInjector: (point) => {
        if (point === "after_mutation:0") throw new InjectedChangeSetCrash(point);
      },
    });
    await expect(
      crashing.submit(
        {
          submissionKey: "real-third-party-key",
          operations: [{
            operationId: "copy-third-party",
            kind: "copy_attachment",
            sourcePath: "assets/source.bin",
            destinationPath: "assets/copy.bin",
            expectedSha256: sha256,
          }],
        },
        requestState,
      ),
    ).rejects.toThrow(InjectedChangeSetCrash);
    await first.execution.close?.();
    const thirdParty = Uint8Array.from([9, 9, 9]);
    await writeFile(join(root, "assets", "copy.bin"), thirdParty);
    const blocked: string[] = [];

    const second = await createRealFileExecution(root);
    const recovered = await ChangeSetService.open({
      store,
      dataSource: second.dataSource,
      execution: second.execution,
      vaultId: "real-third-party-vault",
      runtimeState: {
        setQueue: () => undefined,
        blockWritesForUnproven: (changeSetId) => blocked.push(changeSetId),
      },
    });

    expect(await readFile(join(root, "assets", "copy.bin"))).toEqual(
      Buffer.from(thirdParty),
    );
    expect(blocked).toEqual(["change-set-real-third-party"]);
    await expect(
      recovered.status({ changeSetId: "change-set-real-third-party" }, requestState),
    ).resolves.toMatchObject({
      lookup: "found",
      changeSet: { state: "result_unproven" },
    });
    await second.execution.close?.();
  });

  it("discards stale staging files when a crash recovery rolls back", async () => {
    const root = await mkdtemp(join(tmpdir(), "real-staging-cleanup-"));
    temporaryRoots.push(root);
    const store = new MemoryStore();
    const first = await createRealFileExecution(root);
    const crashing = await ChangeSetService.open({
      store,
      dataSource: first.dataSource,
      execution: first.execution,
      vaultId: "real-staging-cleanup-vault",
      createChangeSetId: () => "change-set-staging-cleanup",
      crashInjector: (point) => {
        // The derived Notes directory is published; the staged note file is
        // still waiting under the private staging tree.
        if (point === "after_mutation:0") throw new InjectedChangeSetCrash(point);
      },
    });
    await expect(
      crashing.submit(
        {
          submissionKey: "staging-cleanup-key",
          operations: [{
            operationId: "create-note",
            kind: "create_note",
            path: "Notes/New.md",
            content: "# Discard me\n",
            ifExists: "reject",
          }],
        },
        requestState,
      ),
    ).rejects.toThrow(InjectedChangeSetCrash);
    await first.execution.close?.();
    expect((await listFiles(join(root, ".llm-wiki", "staging"))).length).toBeGreaterThan(0);

    const second = await createRealFileExecution(root);
    const recovered = await ChangeSetService.open({
      store,
      dataSource: second.dataSource,
      execution: second.execution,
      vaultId: "real-staging-cleanup-vault",
    });

    expect(await listFiles(join(root, ".llm-wiki", "staging"))).toEqual([]);
    expect(await fileSystemPathKind(root, "Notes")).toBe(null);
    await expect(
      recovered.status({ changeSetId: "change-set-staging-cleanup" }, requestState),
    ).resolves.toMatchObject({
      lookup: "found",
      changeSet: { state: "intent_not_applied" },
    });
    await second.execution.close?.();
  });

  it("leaves no orphaned managed-trash entries after a crash recovery restores", async () => {
    const root = await mkdtemp(join(tmpdir(), "real-trash-cleanup-"));
    temporaryRoots.push(root);
    const bytes = Buffer.from("# Restore me\r\n");
    await writeFile(join(root, "Note.md"), bytes);
    const digest = createHash("sha256").update(bytes).digest("hex");
    const store = new MemoryStore();
    const first = await createRealFileExecution(root);
    const crashing = await ChangeSetService.open({
      store,
      dataSource: first.dataSource,
      execution: first.execution,
      vaultId: "real-trash-cleanup-vault",
      createChangeSetId: () => "change-set-trash-cleanup",
      crashInjector: (point) => {
        if (point === "after_mutation:0") throw new InjectedChangeSetCrash(point);
      },
    });
    await expect(
      crashing.submit(
        {
          submissionKey: "trash-cleanup-key",
          operations: [{
            operationId: "trash-note",
            kind: "trash",
            path: "Note.md",
            targetVersion: `sha256:${digest}`,
          }],
        },
        requestState,
      ),
    ).rejects.toThrow(InjectedChangeSetCrash);
    await first.execution.close?.();
    expect((await listFiles(join(root, ".llm-wiki", "trash"))).length).toBeGreaterThan(0);

    const second = await createRealFileExecution(root);
    const recovered = await ChangeSetService.open({
      store,
      dataSource: second.dataSource,
      execution: second.execution,
      vaultId: "real-trash-cleanup-vault",
    });

    expect(await readFile(join(root, "Note.md"))).toEqual(bytes);
    expect(await listFiles(join(root, ".llm-wiki", "trash"))).toEqual([]);
    await expect(
      recovered.status({ changeSetId: "change-set-trash-cleanup" }, requestState),
    ).resolves.toMatchObject({
      lookup: "found",
      changeSet: { state: "intent_not_applied" },
    });
    await second.execution.close?.();
  });

  it("rejects attachment collisions and every protected location before mutation", async () => {
    const bytes = Uint8Array.from([1, 2, 3]);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    for (const destinationPath of [
      "assets/existing.bin",
      ".git/object.bin",
      ".obsidian/plugin.bin",
      ".llm-wiki/private.bin",
      ".trash/hidden.bin",
    ]) {
      const store = new MemoryStore();
      const adapter = new FileAdapter();
      adapter.directories.add("assets");
      adapter.files.set("assets/source.bin", bytes);
      if (destinationPath === "assets/existing.bin") {
        adapter.files.set(destinationPath, Uint8Array.from([9]));
      }
      const service = await ChangeSetService.open({
        store,
        dataSource: {
          readBinary: (path) => adapter.readBinary(path),
          pathKind: (path) => adapter.pathKind(path),
          isContained: async () => true,
        },
        execution: adapter,
        createChangeSetId: () => `change-set-protected-${destinationPath}`,
      });

      const result = await service.submit(
        {
          submissionKey: `protected-${destinationPath}`,
          operations: [{
            operationId: "copy-protected",
            kind: "copy_attachment",
            sourcePath: "assets/source.bin",
            destinationPath,
            expectedSha256: sha256,
          }],
        },
        requestState,
      );

      expect(result).toMatchObject({
        outcome: "registered",
        changeSet: {
          state: "intent_not_applied",
          failure: { code: "path_conflict", path: destinationPath },
        },
      });
      expect(adapter.events.some((event) => event.startsWith("publish-file:"))).toBe(false);
    }
  });

  it("rejects stale attachment SHA-256 evidence before any mutation", async () => {
    const bytes = Uint8Array.from([1, 2, 3]);
    const staleSha256 = "0".repeat(64);
    const cases = [
      {
        operationId: "copy-stale",
        kind: "copy_attachment" as const,
        sourcePath: "assets/source.bin",
        destinationPath: "assets/copy.bin",
        expectedSha256: staleSha256,
      },
      {
        operationId: "move-stale",
        kind: "move_attachment" as const,
        sourcePath: "assets/source.bin",
        destinationPath: "assets/moved.bin",
        expectedSha256: staleSha256,
      },
      {
        operationId: "trash-stale",
        kind: "trash" as const,
        path: "assets/source.bin",
        expectedSha256: staleSha256,
      },
    ];
    for (const [index, operation] of cases.entries()) {
      const store = new MemoryStore();
      const adapter = new FileAdapter();
      adapter.directories.add("assets");
      adapter.files.set("assets/source.bin", bytes);
      const service = await ChangeSetService.open({
        store,
        dataSource: {
          readBinary: (path) => adapter.readBinary(path),
          pathKind: (path) => adapter.pathKind(path),
          isContained: async () => true,
        },
        execution: adapter,
        createChangeSetId: () => `change-set-stale-sha256-${index}`,
      });

      const result = await service.submit(
        { submissionKey: `stale-sha256-${index}`, operations: [operation] },
        requestState,
      );

      expect(result).toMatchObject({
        outcome: "registered",
        changeSet: {
          state: "intent_not_applied",
          failure: { code: "stale_observation" },
        },
      });
      expect(adapter.files.get("assets/source.bin")).toEqual(bytes);
      expect(adapter.files.has("assets/copy.bin")).toBe(false);
      expect(adapter.files.has("assets/moved.bin")).toBe(false);
      expect(adapter.events.some((event) => event.startsWith("publish-file:"))).toBe(false);
    }
  });

  it("blocks recovery rather than overwriting a third-party attachment", async () => {
    const bytes = Uint8Array.from([1, 2, 3, 4]);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const store = new MemoryStore();
    const adapter = new FileAdapter();
    adapter.directories.add("assets");
    adapter.files.set("assets/source.bin", bytes);
    const dataSource = {
      readBinary: (path: string) => adapter.readBinary(path),
      pathKind: (path: string) => adapter.pathKind(path),
      isContained: async () => true,
    };
    const crashing = await ChangeSetService.open({
      store,
      dataSource,
      execution: adapter,
      createChangeSetId: () => "change-set-third-party-attachment",
      crashInjector: (point) => {
        if (point === "after_mutation:0") throw new InjectedChangeSetCrash(point);
      },
    });
    await expect(
      crashing.submit(
        {
          submissionKey: "third-party-attachment-key",
          operations: [{
            operationId: "copy-third-party",
            kind: "copy_attachment",
            sourcePath: "assets/source.bin",
            destinationPath: "assets/copy.bin",
            expectedSha256: sha256,
          }],
        },
        requestState,
      ),
    ).rejects.toThrow(InjectedChangeSetCrash);
    adapter.files.set("assets/copy.bin", Uint8Array.from([9, 9, 9]));
    const blocked: string[] = [];

    const recovered = await ChangeSetService.open({
      store,
      dataSource,
      execution: adapter,
      runtimeState: {
        setQueue: () => undefined,
        blockWritesForUnproven: (changeSetId) => blocked.push(changeSetId),
      },
    });

    expect(adapter.files.get("assets/copy.bin")).toEqual(Uint8Array.from([9, 9, 9]));
    expect(blocked).toEqual(["change-set-third-party-attachment"]);
    await expect(
      recovered.status({ changeSetId: "change-set-third-party-attachment" }, requestState),
    ).resolves.toMatchObject({ lookup: "found", changeSet: { state: "result_unproven" } });
  });

  for (const operation of ["move_attachment", "trash"] as const) {
    it(`restores exact before state after ${operation} crashes before commit`, async () => {
      const bytes = operation === "trash" ? Buffer.from("# Restore me\n") : Uint8Array.from([0, 1, 2, 255]);
      const digest = createHash("sha256").update(bytes).digest("hex");
      const sourcePath = operation === "trash" ? "Restore.md" : "assets/source.bin";
      const store = new MemoryStore();
      const adapter = new FileAdapter();
      if (operation !== "trash") adapter.directories.add("assets");
      adapter.files.set(sourcePath, bytes);
      const input = operation === "trash"
        ? {
            submissionKey: "crash-trash-key",
            operations: [{
              operationId: "trash-crash",
              kind: "trash" as const,
              path: sourcePath,
              targetVersion: `sha256:${digest}`,
            }],
          }
        : {
            submissionKey: "crash-move-key",
            operations: [{
              operationId: "move-crash",
              kind: "move_attachment" as const,
              sourcePath,
              destinationPath: "assets/destination.bin",
              expectedSha256: digest,
            }],
          };
      const dataSource = {
        readBinary: (path: string) => adapter.readBinary(path),
        pathKind: (path: string) => adapter.pathKind(path),
        isContained: async () => true,
      };
      const crashing = await ChangeSetService.open({
        store,
        dataSource,
        execution: adapter,
        createChangeSetId: () => `change-set-crash-${operation}`,
        crashInjector: (point) => {
          if (point === "after_mutation:0") throw new InjectedChangeSetCrash(point);
        },
      });
      await expect(crashing.submit(input, requestState)).rejects.toThrow(InjectedChangeSetCrash);

      const recovered = await ChangeSetService.open({ store, dataSource, execution: adapter });

      expect(adapter.files.get(sourcePath)).toEqual(bytes);
      expect(adapter.files.has("assets/destination.bin")).toBe(false);
      expect(adapter.managedTrash.size).toBe(0);
      await expect(
        recovered.status({ changeSetId: `change-set-crash-${operation}` }, requestState),
      ).resolves.toMatchObject({
        lookup: "found",
        changeSet: { state: "intent_not_applied" },
      });
    });
  }

  it("applies mixed Markdown and attachment operations in one Change Set", async () => {
    const noteContent = "# Mixed\n";
    const noteVersion =
      `sha256:${createHash("sha256").update(noteContent).digest("hex")}` as const;
    const bytes = Uint8Array.from([5, 4, 3, 2, 1, 0]);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const store = new MemoryStore();
    const adapter = new FileAdapter();
    adapter.directories.add("Notes");
    adapter.directories.add("assets");
    adapter.files.set("assets/source.bin", bytes);
    const service = await ChangeSetService.open({
      store,
      dataSource: {
        readBinary: (path) => adapter.readBinary(path),
        pathKind: (path) => adapter.pathKind(path),
        isContained: async () => true,
      },
      execution: adapter,
      createChangeSetId: () => "change-set-mixed",
    });

    const result = await service.submit(
      {
        submissionKey: "mixed-key",
        operations: [
          {
            operationId: "create-note",
            kind: "create_note",
            path: "Notes/Mixed.md",
            content: noteContent,
            ifExists: "reject",
          },
          {
            operationId: "copy-asset",
            afterOperationId: "create-note",
            kind: "copy_attachment",
            sourcePath: "assets/source.bin",
            destinationPath: "assets/copy.bin",
            expectedSha256: sha256,
          },
        ],
      },
      requestState,
    );
    const record = appliedRecord(result);

    expect(adapter.files.get("Notes/Mixed.md")).toEqual(
      Uint8Array.from(Buffer.from(noteContent)),
    );
    expect(adapter.files.get("assets/copy.bin")).toEqual(bytes);
    expect(adapter.files.get("assets/source.bin")).toEqual(bytes);
    expect(record.paths).toContainEqual({
      path: "Notes/Mixed.md",
      outcome: "changed",
      finalState: { kind: "markdown", contentVersion: noteVersion },
    });
    expect(record.paths).toContainEqual({
      path: "assets/copy.bin",
      outcome: "changed",
      finalState: { kind: "attachment", sha256 },
    });
    expect(adapter.evidenceRequests).toHaveLength(1);
    expect(adapter.evidenceRequests[0]).toMatchObject({
      mode: "apply",
      hiddenTrash: false,
      requiredEvents: [{ kind: "create", path: "assets/copy.bin" }],
    });
    expect(adapter.events.indexOf("snapshot")).toBeGreaterThan(-1);
    expect(adapter.events.at(-1)).toBe("journal:COMMITTED");
  });

  it("restores mixed Markdown and attachment state after a crash before commit", async () => {
    const noteContent = "# Do not keep\n";
    const bytes = Uint8Array.from([7, 7, 7, 7]);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const store = new MemoryStore();
    const adapter = new FileAdapter();
    adapter.directories.add("Notes");
    adapter.directories.add("assets");
    adapter.files.set("assets/source.bin", bytes);
    const dataSource = {
      readBinary: (path: string) => adapter.readBinary(path),
      pathKind: (path: string) => adapter.pathKind(path),
      isContained: async () => true,
    };
    const crashing = await ChangeSetService.open({
      store,
      dataSource,
      execution: adapter,
      createChangeSetId: () => "change-set-mixed-crash",
      crashInjector: (point) => {
        // Crash right after the attachment copy is published; the staged note
        // is already visible and the copy destination exists.
        if (point === "after_mutation:0") throw new InjectedChangeSetCrash(point);
      },
    });

    await expect(
      crashing.submit(
        {
          submissionKey: "mixed-crash-key",
          operations: [
            {
              operationId: "create-note",
              kind: "create_note",
              path: "Notes/Mixed.md",
              content: noteContent,
              ifExists: "reject",
            },
            {
              operationId: "copy-asset",
              afterOperationId: "create-note",
              kind: "copy_attachment",
              sourcePath: "assets/source.bin",
              destinationPath: "assets/copy.bin",
              expectedSha256: sha256,
            },
          ],
        },
        requestState,
      ),
    ).rejects.toThrow(InjectedChangeSetCrash);
    expect(adapter.files.has("Notes/Mixed.md")).toBe(true);
    expect(adapter.files.has("assets/copy.bin")).toBe(true);

    const recovered = await ChangeSetService.open({ store, dataSource, execution: adapter });

    expect(adapter.files.has("Notes/Mixed.md")).toBe(false);
    expect(adapter.files.has("assets/copy.bin")).toBe(false);
    expect(adapter.files.get("assets/source.bin")).toEqual(bytes);
    expect(adapter.stagedFiles.size).toBe(0);
    expect(adapter.managedTrash.size).toBe(0);
    expect(adapter.frame?.phase).toBe("ROLLED_BACK");
    await expect(
      recovered.status({ changeSetId: "change-set-mixed-crash" }, requestState),
    ).resolves.toMatchObject({
      lookup: "found",
      changeSet: { state: "intent_not_applied" },
    });
  });
});
