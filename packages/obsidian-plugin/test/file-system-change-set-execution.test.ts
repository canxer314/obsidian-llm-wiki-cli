import { mkdir, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  RECOVERY_JOURNAL_FRAME_SCHEMA_VERSION,
  createFileSystemChangeSetExecutionAdapter,
  type ChangeSetExecutionHost,
  type RecoveryJournalJson,
} from "../src/index.js";
import { openRecoveryJournal } from "../src/recovery-journal.js";

const roots: string[] = [];

const host: ChangeSetExecutionHost = {
  pathKind: async () => null,
  directoryIdentity: async () => null,
  prepareDirectory: async () => "directory",
  publishDirectory: async () => undefined,
  discardPreparedDirectory: async () => undefined,
  removeDirectory: async () => undefined,
  publishSearchSnapshot: async () => undefined,
};

const frame = {
  vaultId: "vault-a",
  changeSetId: "change-set-a",
  enqueueSeq: 1,
  phase: "PREPARED" as const,
  input: {
    submissionKey: "key-a",
    operations: [
      {
        operationId: "dir-1",
        kind: "create_directory",
        path: "dir",
        ifExists: "reject",
      },
    ],
  },
  preview: {},
  directories: [],
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function writeFrame(
  schemaVersion: number,
  extra: Record<string, RecoveryJournalJson> = {},
): Promise<string> {
  const root = join(tmpdir(), `change-set-frame-${crypto.randomUUID()}`);
  roots.push(root);
  await mkdir(root);
  const journalPath = join(root, "recovery-journal.bin");
  const handle = await open(journalPath, "w+");
  const journal = await openRecoveryJournal(handle, { slotCapacity: 4096 });
  await journal.write({
    phase: "PREPARED",
    payload: { ...frame, schemaVersion, ...extra } as unknown as RecoveryJournalJson,
  });
  await handle.close();
  return journalPath;
}

describe("filesystem Change Set execution frame compatibility", () => {
  it("continues to recover legacy directory-only schema 1 frames", async () => {
    const journalPath = await writeFrame(1);
    const adapter = await createFileSystemChangeSetExecutionAdapter({
      journalPath,
      slotCapacity: 4096,
      host,
    });

    await expect(adapter.loadRecoveryFrame()).resolves.toMatchObject({
      schemaVersion: 1,
      directories: [],
    });
    await adapter.close?.();
  });

  it("rejects schema 2 frames without an explicit file footprint", async () => {
    const journalPath = await writeFrame(2);
    const adapter = await createFileSystemChangeSetExecutionAdapter({
      journalPath,
      slotCapacity: 4096,
      host,
    });

    await expect(adapter.loadRecoveryFrame()).rejects.toThrow(
      "Recovery Journal payload is corrupt or incompatible",
    );
    await adapter.close?.();
  });

  it("accepts schema 2 frames with an explicit file footprint", async () => {
    const journalPath = await writeFrame(2, { files: [] });
    const adapter = await createFileSystemChangeSetExecutionAdapter({
      journalPath,
      slotCapacity: 4096,
      host,
    });

    await expect(adapter.loadRecoveryFrame()).resolves.toMatchObject({
      schemaVersion: 2,
      files: [],
    });
    await adapter.close?.();
  });

  it("rejects schema 2 trash frames without durable reference evidence", async () => {
    const journalPath = await writeFrame(RECOVERY_JOURNAL_FRAME_SCHEMA_VERSION, {
      files: [],
      mutations: [{
        kind: "trash",
        operationId: "trash-1",
        path: "Note.md",
        before: {
          kind: "markdown",
          contentVersion:
            "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
          bytesBase64: "",
        },
        expectedAfter: { kind: "absent" },
        trashId: "change-set-a/0",
      }],
    });
    const adapter = await createFileSystemChangeSetExecutionAdapter({
      journalPath,
      slotCapacity: 4096,
      host,
    });

    await expect(adapter.loadRecoveryFrame()).rejects.toThrow(
      "Recovery Journal payload is corrupt or incompatible",
    );
    await adapter.close?.();
  });
});
