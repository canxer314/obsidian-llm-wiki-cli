import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  rmdir,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { ChangeSetRecord } from "@llm-wiki/vault-contracts";

import {
  ChangeSetService,
  InjectedChangeSetCrash,
  createFileSystemChangeSetExecutionAdapter,
  createNodeFileSystemChangeSetHost,
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

class FileAdapter extends DirectoryAdapter {
  readonly files = new Map<string, Uint8Array>();
  readonly stagedFiles = new Map<string, Uint8Array>();
  readonly managedTrash = new Map<string, Uint8Array>();
  readonly evidenceRequests: {
    readonly mode: "apply" | "restore";
    readonly operations: readonly unknown[];
    readonly publicPaths: readonly string[];
    readonly hiddenTrash: boolean;
    readonly requiredEvents: readonly unknown[];
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
    this.stagedFiles.delete(stageId);
  }

  async discardPreparedFile(stageId: string): Promise<void> {
    this.stagedFiles.delete(stageId);
  }

  async removeFile(path: string): Promise<void> {
    this.events.push(`remove-file:${path}`);
    this.files.delete(path);
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

  async awaitSemanticEvidence(request: {
    readonly mode: "apply" | "restore";
    readonly operations: readonly unknown[];
    readonly publicPaths: readonly string[];
    readonly hiddenTrash: boolean;
    readonly requiredEvents: readonly unknown[];
  }): Promise<void> {
    this.evidenceRequests.push(request);
    this.events.push(`evidence:${request.publicPaths.join(",")}`);
  }
}

async function createRealFileExecution(root: string) {
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
  return {
    execution,
    dataSource: {
      readBinary: host.readBinary!,
      pathKind: host.pathKind,
      isContained: async () => true,
    },
  };
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
    expect(JSON.stringify(result)).not.toContain("contentVersion");
  });

  it("restores a trashed attachment with exact SHA-256 bytes after restart", async () => {
    const bytes = Uint8Array.from([11, 22, 33, 0, 255]);
    const expectedSha256 = createHash("sha256").update(bytes).digest("hex");
    const store = new MemoryStore();
    const adapter = new FileAdapter();
    adapter.directories.add("assets");
    adapter.files.set("assets/restore.bin", bytes);
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

    const recovered = await ChangeSetService.open({ store, dataSource, execution: adapter });

    expect(adapter.files.get("assets/restore.bin")).toEqual(bytes);
    expect(adapter.managedTrash.size).toBe(0);
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
      "inspect:Projects",
      "rmdir:Projects/Alpha",
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

  it("performs no rollback action after discovering third-party state during comparison", async () => {
    const sourceBytes = Uint8Array.from([40, 41, 42]);
    const sha256 = createHash("sha256").update(sourceBytes).digest("hex");
    const store = new MemoryStore();
    const adapter = new FileAdapter();
    adapter.directories.add("assets");
    adapter.files.set("assets/source.bin", sourceBytes);
    const dataSource = {
      readBinary: (path: string) => adapter.readBinary(path),
      pathKind: (path: string) => adapter.pathKind(path),
      isContained: async () => true,
    };
    const crashing = await ChangeSetService.open({
      store,
      dataSource,
      execution: adapter,
      createChangeSetId: () => "change-set-rollback-third-party",
      crashInjector: (point) => {
        if (point === "after_mutation:0") throw new InjectedChangeSetCrash(point);
      },
    });
    await expect(
      crashing.submit(
        {
          submissionKey: "rollback-third-party-key",
          operations: [
            {
              operationId: "copy-rollback-third-party",
              kind: "copy_attachment",
              sourcePath: "assets/source.bin",
              destinationPath: "assets/intermediate.bin",
              expectedSha256: sha256,
            },
            {
              operationId: "move-rollback-third-party",
              afterOperationId: "copy-rollback-third-party",
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
    adapter.files.set("assets/final.bin", Uint8Array.from([99]));
    const mutationsBefore = adapter.events.filter((event) =>
      ["remove-file", "move-file", "restore:"].some((prefix) => event.startsWith(prefix))
    );

    const recovered = await ChangeSetService.open({
      store,
      dataSource,
      execution: adapter,
      runtimeState: {
        setQueue: () => undefined,
        blockWritesForUnproven: () => undefined,
      },
    });

    expect(adapter.files.get("assets/final.bin")).toEqual(Uint8Array.from([99]));
    expect(adapter.events.filter((event) =>
      ["remove-file", "move-file", "restore:"].some((prefix) => event.startsWith(prefix))
    )).toEqual(mutationsBefore);
    await expect(
      recovered.status({ changeSetId: "change-set-rollback-third-party" }, requestState),
    ).resolves.toMatchObject({ lookup: "found", changeSet: { state: "result_unproven" } });
  });

  for (const rollbackPoint of ["before_rollback", "after_rollback_mutation:0"] as const) {
    it(`resumes restore after a rollback crash at ${rollbackPoint}`, async () => {
      const bytes = Uint8Array.from([31, 32, 33]);
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
      let crashes = 0;
      const crashing = await ChangeSetService.open({
        store,
        dataSource,
        execution: adapter,
        createChangeSetId: () => "change-set-rollback-crash",
        crashInjector: (point) => {
          if (
            point === "after_mutation:0" ||
            (crashes === 0 && point === rollbackPoint)
          ) {
            crashes += 1;
            throw new InjectedChangeSetCrash(point);
          }
        },
      });
      await expect(
        crashing.submit(
          {
            submissionKey: "rollback-crash-key",
            operations: [{
              operationId: "rollback-crash",
              kind: "copy_attachment",
              sourcePath: "assets/source.bin",
              destinationPath: "assets/copy.bin",
              expectedSha256: sha256,
            }],
          },
          requestState,
        ),
      ).rejects.toThrow(InjectedChangeSetCrash);

      const recovered = await ChangeSetService.open({ store, dataSource, execution: adapter });

      expect(adapter.files.get("assets/source.bin")).toEqual(bytes);
      expect(adapter.files.has("assets/copy.bin")).toBe(false);
      await expect(
        recovered.status({ changeSetId: "change-set-rollback-crash" }, requestState),
      ).resolves.toMatchObject({
        lookup: "found",
        changeSet: { state: "intent_not_applied" },
      });
    });
  }

  it("blocks recovery when a checksummed Journal frame mismatches its registry entry", async () => {
    const store = new MemoryStore();
    const adapter = new DirectoryAdapter();
    const crashing = await ChangeSetService.open({
      store,
      dataSource: {
        readBinary: async () => null,
        pathKind: async () => null,
        isContained: async () => true,
      },
      execution: adapter,
      createChangeSetId: () => "change-set-journal-mismatch",
      crashInjector: (point) => {
        if (point === "after_prepared") throw new InjectedChangeSetCrash(point);
      },
    });
    await expect(crashing.submit(createDirectory(), requestState)).rejects.toThrow(
      InjectedChangeSetCrash,
    );
    adapter.frame = { ...adapter.frame!, enqueueSeq: 99 };
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
        blockWritesForUnproven: (changeSetId) => blocked.push(changeSetId),
      },
    });

    expect(blocked).toEqual(["change-set-journal-mismatch"]);
    await expect(
      recovered.status({ changeSetId: "change-set-journal-mismatch" }, requestState),
    ).resolves.toMatchObject({ lookup: "found", changeSet: { state: "result_unproven" } });
  });

  it("blocks committed recovery without exact authoritative final-path evidence", async () => {
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
      createChangeSetId: () => "change-set-committed-evidence",
    });
    await expect(service.submit(createDirectory(), requestState)).rejects.toThrow(
      "injected registry failure",
    );
    adapter.frame = { ...adapter.frame!, finalPaths: undefined };
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
        blockWritesForUnproven: (changeSetId) => blocked.push(changeSetId),
      },
    });

    expect(blocked).toEqual(["change-set-committed-evidence"]);
    await expect(
      recovered.status({ changeSetId: "change-set-committed-evidence" }, requestState),
    ).resolves.toMatchObject({ lookup: "found", changeSet: { state: "result_unproven" } });
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
