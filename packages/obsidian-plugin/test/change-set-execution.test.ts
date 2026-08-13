import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, rm, rmdir, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { ChangeSetRecord } from "@llm-wiki/vault-contracts";

import {
  ChangeSetService,
  InjectedChangeSetCrash,
  createFileSystemChangeSetDataSource,
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

class FrontmatterAdapter extends DirectoryAdapter {
  readonly files = new Map<string, Buffer>();
  readonly preparedFiles = new Map<string, Buffer>();

  override async pathKind(path: string): Promise<"directory" | "file" | null> {
    this.events.push(`inspect:${path}`);
    if (this.files.has(path)) return "file";
    return this.directories.has(path) ? "directory" : null;
  }

  async readBinary(path: string): Promise<Uint8Array | null> {
    this.events.push(`read:${path}`);
    const bytes = this.files.get(path);
    return bytes === undefined ? null : Buffer.from(bytes);
  }

  async prepareFile(stageId: string, bytes: Uint8Array): Promise<void> {
    this.events.push(`prepare-file:${stageId}`);
    this.preparedFiles.set(stageId, Buffer.from(bytes));
  }

  async publishFile(stageId: string, path: string): Promise<void> {
    this.events.push(`write:${path}`);
    const bytes = this.preparedFiles.get(stageId);
    if (bytes === undefined) throw new Error("prepared file is missing");
    this.preparedFiles.delete(stageId);
    this.files.set(path, Buffer.from(bytes));
  }

  async discardPreparedFile(stageId: string): Promise<void> {
    this.preparedFiles.delete(stageId);
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

const VERSION = (bytes: Uint8Array | string) =>
  `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

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

function editFrontmatter(
  targetVersion: string,
  submissionKey = "frontmatter-key",
  path = "Note.md",
) {
  return {
    submissionKey,
    operations: [
      {
        operationId: "frontmatter-1",
        kind: "edit_frontmatter" as const,
        path,
        targetVersion,
        changes: [{ kind: "set" as const, key: "title", value: "New" }],
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

async function openRealFileExecution(root: string, publishSnapshot: () => void) {
  const stagingRoot = join(root, ".llm-wiki", "staging");
  return createFileSystemChangeSetExecutionAdapter({
    journalPath: join(root, ".llm-wiki", "recovery-journal.bin"),
    slotCapacity: 16 * 1024,
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
      directoryIdentity: async () => null,
      prepareDirectory: async () => {
        throw new Error("directory staging is not expected");
      },
      publishDirectory: async () => {
        throw new Error("directory publication is not expected");
      },
      discardPreparedDirectory: async () => undefined,
      removeDirectory: async () => {
        throw new Error("directory removal is not expected");
      },
      readBinary: async (path) => {
        try {
          return await readFile(join(root, ...path.split("/")));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
          throw error;
        }
      },
      prepareFile: async (stageId, bytes) => {
        const stagePath = join(stagingRoot, ...stageId.split("/"));
        await mkdir(dirname(stagePath), { recursive: true });
        await writeFile(stagePath, bytes);
      },
      publishFile: async (stageId, path) => {
        await rename(
          join(stagingRoot, ...stageId.split("/")),
          join(root, ...path.split("/")),
        );
      },
      discardPreparedFile: async (stageId) => {
        await unlink(join(stagingRoot, ...stageId.split("/"))).catch(
          (error: NodeJS.ErrnoException) => {
            if (error.code !== "ENOENT") throw error;
          },
        );
      },
      publishSearchSnapshot: async () => {
        publishSnapshot();
      },
    },
  });
}

describe("durable Frontmatter Change Set execution", () => {
  it("commits exact projected bytes only after locked revalidation and final proof", async () => {
    const store = new MemoryStore();
    const adapter = new FrontmatterAdapter();
    const original = Buffer.from(
      "---\r\ntitle: 'Old'\r\naliases: [one, \"two\"]\r\n---\r\nBody unchanged.\r\n",
    );
    const projected = Buffer.from(
      "---\r\ntitle: \"New\"\r\naliases: [one, \"two\"]\r\n---\r\nBody unchanged.\r\n",
    );
    adapter.files.set("Note.md", original);
    let preflightReads = 0;
    const dataSource = {
      readBinary: async (path: string) => {
        preflightReads += 1;
        return adapter.readBinary(path);
      },
      pathKind: adapter.pathKind.bind(adapter),
      isContained: async () => true,
      projectFrontmatter: createFileSystemChangeSetDataSource(".", {
        exists: async () => false,
        readBinary: async () => new ArrayBuffer(0),
        stat: async () => null,
      }).projectFrontmatter,
    };
    const service = await ChangeSetService.open({
      store,
      dataSource,
      execution: adapter,
      createChangeSetId: () => "change-set-frontmatter",
    });

    const submitted = await service.submit(
      editFrontmatter(VERSION(original)),
      requestState,
    );
    const record = appliedRecord(submitted);

    expect(preflightReads).toBe(2);
    expect(adapter.files.get("Note.md")).toEqual(projected);
    expect(record.preview.paths).toEqual([
      {
        path: "Note.md",
        preState: { kind: "markdown", contentVersion: VERSION(original) },
        projectedFinalState: {
          kind: "markdown",
          contentVersion: VERSION(projected),
        },
        projectedOutcome: "changed",
      },
    ]);
    expect(record.paths).toEqual([
      {
        path: "Note.md",
        outcome: "changed",
        finalState: { kind: "markdown", contentVersion: VERSION(projected) },
      },
    ]);
    expect(adapter.events).toEqual([
      "read:Note.md",
      "read:Note.md",
      "journal:PREPARED",
      "prepare-file:change-set-frontmatter/file/0",
      "write:Note.md",
      "read:Note.md",
      "snapshot",
      "read:Note.md",
      "journal:COMMITTED",
    ]);
  });
  it("executes directory and Frontmatter effects in one shared proof path", async () => {
    const store = new MemoryStore();
    const adapter = new FrontmatterAdapter();
    const original = Buffer.from("---\ntitle: Old\n---\nbody\n");
    adapter.files.set("Note.md", original);
    const projector = createFileSystemChangeSetDataSource(".", {
      exists: async () => false,
      readBinary: async () => new ArrayBuffer(0),
      stat: async () => null,
    }).projectFrontmatter;
    const service = await ChangeSetService.open({
      store,
      dataSource: {
        readBinary: adapter.readBinary.bind(adapter),
        pathKind: adapter.pathKind.bind(adapter),
        isContained: async () => true,
        projectFrontmatter: projector,
      },
      execution: adapter,
      createChangeSetId: () => "change-set-mixed-frontmatter",
    });

    const submitted = await service.submit(
      {
        submissionKey: "mixed-frontmatter",
        operations: [
          {
            operationId: "directory-1",
            kind: "create_directory",
            path: "Archive",
            ifExists: "reject",
          },
          {
            operationId: "frontmatter-1",
            kind: "edit_frontmatter",
            path: "Note.md",
            targetVersion: VERSION(original),
            changes: [{ kind: "set", key: "title", value: "New" }],
          },
        ],
      },
      requestState,
    );
    const record = appliedRecord(submitted);

    expect(adapter.directories).toEqual(new Set(["Archive"]));
    expect(adapter.events.indexOf("mkdir:Archive")).toBeLessThan(
      adapter.events.indexOf("write:Note.md"),
    );
    expect(record.requestedEffects).toEqual([
      { operationId: "directory-1", kind: "create_directory", outcome: "changed" },
      { operationId: "frontmatter-1", kind: "edit_frontmatter", outcome: "changed" },
    ]);
    expect(adapter.frame?.phase).toBe("COMMITTED");
    expect(adapter.frame?.directories).toHaveLength(1);
    expect(adapter.frame?.files).toHaveLength(1);
  });

  it("proves an already-satisfied Frontmatter operation without writing bytes", async () => {
    const store = new MemoryStore();
    const adapter = new FrontmatterAdapter();
    const original = Buffer.from("---\ncount: 1.0 # preserve\n---\nbody\n");
    adapter.files.set("Note.md", original);
    const projector = createFileSystemChangeSetDataSource(".", {
      exists: async () => false,
      readBinary: async () => new ArrayBuffer(0),
      stat: async () => null,
    }).projectFrontmatter;
    const service = await ChangeSetService.open({
      store,
      dataSource: {
        readBinary: adapter.readBinary.bind(adapter),
        pathKind: adapter.pathKind.bind(adapter),
        isContained: async () => true,
        projectFrontmatter: projector,
      },
      execution: adapter,
      createChangeSetId: () => "change-set-frontmatter-noop",
    });

    const submitted = await service.submit(
      {
        submissionKey: "frontmatter-noop",
        operations: [
          {
            operationId: "frontmatter-noop-1",
            kind: "edit_frontmatter",
            path: "Note.md",
            targetVersion: VERSION(original),
            changes: [{ kind: "set", key: "count", value: 1 }],
          },
        ],
      },
      requestState,
    );
    const record = appliedRecord(submitted);

    expect(adapter.files.get("Note.md")).toEqual(original);
    expect(adapter.events).not.toContain("write:Note.md");
    expect(adapter.frame?.files).toEqual([
      {
        path: "Note.md",
        beforeBase64: original.toString("base64"),
        expectedAfterBase64: original.toString("base64"),
        beforeVersion: VERSION(original),
        expectedAfterVersion: VERSION(original),
        stageId: "change-set-frontmatter-noop/file/0",
      },
    ]);
    expect(record.requestedEffects).toEqual([
      {
        operationId: "frontmatter-noop-1",
        kind: "edit_frontmatter",
        outcome: "already_satisfied",
      },
    ]);
    expect(record.paths).toEqual([
      {
        path: "Note.md",
        outcome: "unchanged",
        finalState: { kind: "markdown", contentVersion: VERSION(original) },
      },
    ]);
  });

  it.each([
    ["invalid UTF-8", Buffer.from([0x2d, 0x2d, 0x2d, 0x0a, 0xff, 0x0a])],
    [
      "ambiguous duplicate keys",
      Buffer.from("---\ntitle: one\ntitle: two\n---\nbody\n"),
    ],
  ])("fails closed before PREPARED for %s", async (_name, original) => {
    const store = new MemoryStore();
    const adapter = new FrontmatterAdapter();
    adapter.files.set("Note.md", original);
    const projector = createFileSystemChangeSetDataSource(".", {
      exists: async () => false,
      readBinary: async () => new ArrayBuffer(0),
      stat: async () => null,
    }).projectFrontmatter;
    const service = await ChangeSetService.open({
      store,
      dataSource: {
        readBinary: adapter.readBinary.bind(adapter),
        pathKind: adapter.pathKind.bind(adapter),
        isContained: async () => true,
        projectFrontmatter: projector,
      },
      execution: adapter,
      createChangeSetId: () => "change-set-unsafe-frontmatter",
    });

    const submitted = await service.submit(
      editFrontmatter(VERSION(original), `unsafe-${_name}`),
      requestState,
    );

    expect(submitted).toMatchObject({
      outcome: "registered",
      changeSet: { state: "intent_not_applied" },
    });
    expect(adapter.files.get("Note.md")).toEqual(original);
    expect(adapter.frame).toBeNull();
    expect(adapter.events).not.toContain("write:Note.md");
  });

  it("rejects a stale target during locked revalidation before PREPARED", async () => {
    const store = new MemoryStore();
    const adapter = new FrontmatterAdapter();
    const original = Buffer.from("---\ntitle: Old\n---\nbody\n");
    const changed = Buffer.from("---\ntitle: Third party\n---\nbody\n");
    adapter.files.set("Note.md", original);
    let reads = 0;
    const projector = createFileSystemChangeSetDataSource(".", {
      exists: async () => false,
      readBinary: async () => new ArrayBuffer(0),
      stat: async () => null,
    }).projectFrontmatter;
    const service = await ChangeSetService.open({
      store,
      dataSource: {
        readBinary: async (path) => {
          reads += 1;
          if (reads === 2) adapter.files.set(path, changed);
          return adapter.readBinary(path);
        },
        pathKind: adapter.pathKind.bind(adapter),
        isContained: async () => true,
        projectFrontmatter: projector,
      },
      execution: adapter,
      createChangeSetId: () => "change-set-stale-frontmatter",
    });

    const submitted = await service.submit(
      editFrontmatter(VERSION(original), "stale-frontmatter-key"),
      requestState,
    );

    expect(submitted).toMatchObject({
      outcome: "registered",
      changeSet: {
        state: "intent_not_applied",
        failure: { code: "stale_observation" },
      },
    });
    expect(adapter.files.get("Note.md")).toEqual(changed);
    expect(adapter.frame).toBeNull();
    expect(adapter.events).not.toContain("write:Note.md");
  });

  for (const crashPoint of [
    "after_prepared",
    "after_mutation:0",
    "after_raw_verification",
    "after_snapshot",
  ]) {
    it(`restores exact Frontmatter before bytes after a crash at ${crashPoint}`, async () => {
      const store = new MemoryStore();
      const adapter = new FrontmatterAdapter();
      const original = Buffer.from("---\r\ntitle: 'Old'\r\n---\r\nExact body.\r\n");
      adapter.files.set("Note.md", original);
      const projector = createFileSystemChangeSetDataSource(".", {
        exists: async () => false,
        readBinary: async () => new ArrayBuffer(0),
        stat: async () => null,
      }).projectFrontmatter;
      const dataSource = {
        readBinary: adapter.readBinary.bind(adapter),
        pathKind: adapter.pathKind.bind(adapter),
        isContained: async () => true,
        projectFrontmatter: projector,
      };
      const crashing = await ChangeSetService.open({
        store,
        dataSource,
        execution: adapter,
        createChangeSetId: () => `change-set-frontmatter-${crashPoint}`,
        crashInjector: (point) => {
          if (point === crashPoint) throw new InjectedChangeSetCrash(point);
        },
      });
      await expect(
        crashing.submit(
          editFrontmatter(VERSION(original), `frontmatter-${crashPoint}`),
          requestState,
        ),
      ).rejects.toThrow(InjectedChangeSetCrash);

      const recovered = await ChangeSetService.open({ store, dataSource, execution: adapter });

      expect(adapter.files.get("Note.md")).toEqual(original);
      expect(adapter.frame?.phase).toBe("ROLLED_BACK");
      await expect(
        recovered.status(
          { changeSetId: `change-set-frontmatter-${crashPoint}` },
          requestState,
        ),
      ).resolves.toMatchObject({
        lookup: "found",
        changeSet: { state: "intent_not_applied" },
      });
    });
  }

  for (const recoveryCrashPoint of ["during_rollback:1", "after_rolled_back"]) {
    it(`resumes Frontmatter recovery after another crash at ${recoveryCrashPoint}`, async () => {
      const store = new MemoryStore();
      const adapter = new FrontmatterAdapter();
      const original = Buffer.from("---\ntitle: Old\n---\nbody\n");
      adapter.files.set("Note.md", original);
      const projector = createFileSystemChangeSetDataSource(".", {
        exists: async () => false,
        readBinary: async () => new ArrayBuffer(0),
        stat: async () => null,
      }).projectFrontmatter;
      const dataSource = {
        readBinary: adapter.readBinary.bind(adapter),
        pathKind: adapter.pathKind.bind(adapter),
        isContained: async () => true,
        projectFrontmatter: projector,
      };
      const mutationCrash = await ChangeSetService.open({
        store,
        dataSource,
        execution: adapter,
        createChangeSetId: () => `change-set-recovery-${recoveryCrashPoint}`,
        crashInjector: (point) => {
          if (point === "after_mutation:0") throw new InjectedChangeSetCrash(point);
        },
      });
      await expect(
        mutationCrash.submit(
          editFrontmatter(VERSION(original), `recovery-${recoveryCrashPoint}`),
          requestState,
        ),
      ).rejects.toThrow(InjectedChangeSetCrash);

      await expect(
        ChangeSetService.open({
          store,
          dataSource,
          execution: adapter,
          crashInjector: (point) => {
            if (point === recoveryCrashPoint) throw new InjectedChangeSetCrash(point);
          },
        }),
      ).rejects.toThrow(InjectedChangeSetCrash);

      const recovered = await ChangeSetService.open({ store, dataSource, execution: adapter });
      expect(adapter.files.get("Note.md")).toEqual(original);
      await expect(
        recovered.status(
          { changeSetId: `change-set-recovery-${recoveryCrashPoint}` },
          requestState,
        ),
      ).resolves.toMatchObject({
        lookup: "found",
        changeSet: { state: "intent_not_applied" },
      });
    });
  }

  it("keeps proven Frontmatter bytes after a crash following durable COMMITTED", async () => {
    const store = new MemoryStore();
    const adapter = new FrontmatterAdapter();
    const original = Buffer.from("---\ntitle: Old\n---\nbody\n");
    const projected = Buffer.from("---\ntitle: \"New\"\n---\nbody\n");
    adapter.files.set("Note.md", original);
    const projector = createFileSystemChangeSetDataSource(".", {
      exists: async () => false,
      readBinary: async () => new ArrayBuffer(0),
      stat: async () => null,
    }).projectFrontmatter;
    const dataSource = {
      readBinary: adapter.readBinary.bind(adapter),
      pathKind: adapter.pathKind.bind(adapter),
      isContained: async () => true,
      projectFrontmatter: projector,
    };
    const crashing = await ChangeSetService.open({
      store,
      dataSource,
      execution: adapter,
      createChangeSetId: () => "change-set-frontmatter-committed",
      crashInjector: (point) => {
        if (point === "after_committed") throw new InjectedChangeSetCrash(point);
      },
    });
    await expect(
      crashing.submit(editFrontmatter(VERSION(original)), requestState),
    ).rejects.toThrow(InjectedChangeSetCrash);

    const recovered = await ChangeSetService.open({ store, dataSource, execution: adapter });

    expect(adapter.files.get("Note.md")).toEqual(projected);
    await expect(
      recovered.status({ changeSetId: "change-set-frontmatter-committed" }, requestState),
    ).resolves.toMatchObject({
      lookup: "found",
      changeSet: { state: "intent_applied" },
    });
  });

  it("restores exact bytes from a real recovery journal after restart", async () => {
    const root = await mkdtemp(join(tmpdir(), "frontmatter-recovery-"));
    temporaryRoots.push(root);
    const store = new MemoryStore();
    const original = Buffer.from(
      "﻿---\r\ntitle: 'Old'\r\naliases: [one, \"two\"]\r\n---\r\nExact body bytes.\r\n",
    );
    await writeFile(join(root, "Note.md"), original);
    const adapterSource = {
      exists: async (path: string) => {
        try {
          await stat(join(root, ...path.split("/")));
          return true;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
          throw error;
        }
      },
      readBinary: async (path: string) => readFile(join(root, ...path.split("/"))),
      stat: async (path: string) => {
        try {
          const value = await stat(join(root, ...path.split("/")));
          return { type: value.isDirectory() ? "folder" as const : "file" as const };
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
          throw error;
        }
      },
    };
    const dataSource = createFileSystemChangeSetDataSource(root, adapterSource);
    let snapshots = 0;
    const execution = await openRealFileExecution(root, () => {
      snapshots += 1;
    });
    const crashing = await ChangeSetService.open({
      store,
      dataSource,
      execution,
      vaultId: "vault-real-frontmatter",
      createChangeSetId: () => "change-set-real-frontmatter",
      crashInjector: (point) => {
        if (point === "after_mutation:0") throw new InjectedChangeSetCrash(point);
      },
    });
    await expect(
      crashing.submit(editFrontmatter(VERSION(original)), requestState),
    ).rejects.toThrow(InjectedChangeSetCrash);
    expect(await readFile(join(root, "Note.md"))).not.toEqual(original);
    await execution.close?.();

    const reopenedExecution = await openRealFileExecution(root, () => {
      snapshots += 1;
    });
    const recovered = await ChangeSetService.open({
      store,
      dataSource,
      execution: reopenedExecution,
      vaultId: "vault-real-frontmatter",
    });

    expect(await readFile(join(root, "Note.md"))).toEqual(original);
    expect(snapshots).toBe(1);
    await expect(
      recovered.status({ changeSetId: "change-set-real-frontmatter" }, requestState),
    ).resolves.toMatchObject({
      lookup: "found",
      changeSet: { state: "intent_not_applied" },
    });
    await reopenedExecution.close?.();
  });

  it("does not overwrite third-party bytes during Frontmatter recovery", async () => {
    const store = new MemoryStore();
    const adapter = new FrontmatterAdapter();
    const original = Buffer.from("---\ntitle: Old\n---\nbody\n");
    const thirdParty = Buffer.from("---\ntitle: Someone else\n---\nbody\n");
    adapter.files.set("Note.md", original);
    const projector = createFileSystemChangeSetDataSource(".", {
      exists: async () => false,
      readBinary: async () => new ArrayBuffer(0),
      stat: async () => null,
    }).projectFrontmatter;
    const dataSource = {
      readBinary: adapter.readBinary.bind(adapter),
      pathKind: adapter.pathKind.bind(adapter),
      isContained: async () => true,
      projectFrontmatter: projector,
    };
    const crashing = await ChangeSetService.open({
      store,
      dataSource,
      execution: adapter,
      createChangeSetId: () => "change-set-frontmatter-third-party",
      crashInjector: (point) => {
        if (point === "after_mutation:0") throw new InjectedChangeSetCrash(point);
      },
    });
    await expect(
      crashing.submit(editFrontmatter(VERSION(original)), requestState),
    ).rejects.toThrow(InjectedChangeSetCrash);
    adapter.files.set("Note.md", thirdParty);
    const blocked: string[] = [];

    const recovered = await ChangeSetService.open({
      store,
      dataSource,
      execution: adapter,
      runtimeState: {
        setQueue: () => undefined,
        blockWritesForUnproven: (changeSetId) => {
          blocked.push(changeSetId);
        },
      },
    });

    expect(adapter.files.get("Note.md")).toEqual(thirdParty);
    expect(adapter.frame?.phase).toBe("FAILED");
    expect(blocked).toEqual(["change-set-frontmatter-third-party"]);
    await expect(
      recovered.status(
        { changeSetId: "change-set-frontmatter-third-party" },
        requestState,
      ),
    ).resolves.toMatchObject({
      lookup: "found",
      changeSet: { state: "result_unproven" },
    });
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
