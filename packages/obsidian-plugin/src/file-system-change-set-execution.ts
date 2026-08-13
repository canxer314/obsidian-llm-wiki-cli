import { mkdir, open } from "node:fs/promises";
import { dirname } from "node:path";

import type {
  ChangeSetExecutionAdapter,
  ChangeSetPathKind,
  RecoveryJournalFrame,
} from "./change-set.js";
import { contentVersion } from "./content-version.js";
import {
  openRecoveryJournal,
  type RecoveryJournal,
  type RecoveryJournalJson,
} from "./recovery-journal.js";

export const DEFAULT_RECOVERY_JOURNAL_SLOT_CAPACITY = 8 * 1024 * 1024;

export interface DirectoryExecutionHost {
  pathKind(path: string): Promise<ChangeSetPathKind | null>;
  directoryIdentity(path: string): Promise<string | null>;
  prepareDirectory(stageId: string): Promise<string>;
  publishDirectory(stageId: string, path: string): Promise<void>;
  discardPreparedDirectory(stageId: string): Promise<void>;
  removeDirectory(path: string): Promise<void>;
  readBinary?(path: string): Promise<ArrayBuffer | Uint8Array | null>;
  prepareFile?(stageId: string, bytes: Uint8Array): Promise<void>;
  publishFile?(stageId: string, path: string): Promise<void>;
  discardPreparedFile?(stageId: string): Promise<void>;
  publishSearchSnapshot(): Promise<void>;
}

export interface FileSystemChangeSetExecutionOptions {
  journalPath: string;
  host: DirectoryExecutionHost;
  slotCapacity?: number;
}

function canonicalBase64(value: string): Buffer | null {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) {
    return null;
  }
  const bytes = Buffer.from(value, "base64");
  return bytes.toString("base64") === value ? bytes : null;
}

function parseFrame(value: unknown): RecoveryJournalFrame {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Recovery Journal payload is corrupt or incompatible");
  }
  const frame = value as Partial<RecoveryJournalFrame>;
  if (
    frame.schemaVersion !== 1 ||
    typeof frame.vaultId !== "string" ||
    frame.vaultId.length === 0 ||
    typeof frame.changeSetId !== "string" ||
    frame.changeSetId.length === 0 ||
    !Number.isSafeInteger(frame.enqueueSeq) ||
    typeof frame.input !== "object" ||
    frame.input === null ||
    !Array.isArray(frame.directories) ||
    (frame.files !== undefined && !Array.isArray(frame.files)) ||
    typeof frame.preview !== "object" ||
    frame.preview === null
  ) {
    throw new Error("Recovery Journal payload is corrupt or incompatible");
  }
  for (const file of frame.files ?? []) {
    if (typeof file !== "object" || file === null) {
      throw new Error("Recovery Journal payload is corrupt or incompatible");
    }
    const before = canonicalBase64(file.beforeBase64);
    const expectedAfter = canonicalBase64(file.expectedAfterBase64);
    if (
      typeof file.path !== "string" ||
      file.path.length === 0 ||
      typeof file.stageId !== "string" ||
      file.stageId.length === 0 ||
      before === null ||
      expectedAfter === null ||
      !/^sha256:[0-9a-f]{64}$/u.test(file.beforeVersion) ||
      !/^sha256:[0-9a-f]{64}$/u.test(file.expectedAfterVersion) ||
      contentVersion(before) !== file.beforeVersion ||
      contentVersion(expectedAfter) !== file.expectedAfterVersion
    ) {
      throw new Error("Recovery Journal payload is corrupt or incompatible");
    }
  }
  return structuredClone(value) as RecoveryJournalFrame;
}

export async function createFileSystemChangeSetExecutionAdapter(
  options: FileSystemChangeSetExecutionOptions,
): Promise<ChangeSetExecutionAdapter> {
  await mkdir(dirname(options.journalPath), { recursive: true });
  const handle = await open(options.journalPath, "r+").catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
      return open(options.journalPath, "w+");
    },
  );
  let journal: RecoveryJournal;
  try {
    journal = await openRecoveryJournal(handle, {
      slotCapacity: options.slotCapacity ?? DEFAULT_RECOVERY_JOURNAL_SLOT_CAPACITY,
    });
  } catch (error) {
    await handle.close();
    throw error;
  }
  return {
    loadRecoveryFrame: async () => {
      const record = await journal.recover();
      if (record === undefined) return null;
      const frame = parseFrame(record.payload);
      if (record.phase !== frame.phase) {
        throw new Error("Recovery Journal phase is inconsistent");
      }
      return frame;
    },
    persistRecoveryFrame: async (frame) => {
      await journal.write({
        phase: frame.phase,
        payload: structuredClone(frame) as unknown as RecoveryJournalJson,
      });
    },
    pathKind: options.host.pathKind,
    directoryIdentity: options.host.directoryIdentity,
    prepareDirectory: options.host.prepareDirectory,
    publishDirectory: options.host.publishDirectory,
    discardPreparedDirectory: options.host.discardPreparedDirectory,
    removeDirectory: options.host.removeDirectory,
    ...(options.host.readBinary === undefined
      ? {}
      : { readBinary: options.host.readBinary }),
    ...(options.host.prepareFile === undefined
      ? {}
      : { prepareFile: options.host.prepareFile }),
    ...(options.host.publishFile === undefined
      ? {}
      : { publishFile: options.host.publishFile }),
    ...(options.host.discardPreparedFile === undefined
      ? {}
      : { discardPreparedFile: options.host.discardPreparedFile }),
    publishSearchSnapshot: options.host.publishSearchSnapshot,
    close: () => handle.close(),
  };
}
