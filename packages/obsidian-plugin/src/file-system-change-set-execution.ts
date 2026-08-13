import { mkdir, open } from "node:fs/promises";
import { dirname } from "node:path";

import { RECOVERY_JOURNAL_FRAME_SCHEMA_VERSION } from "./change-set.js";
import type {
  ChangeSetExecutionAdapter,
  ChangeSetPathKind,
  RecoveryJournalFrame,
  SearchSnapshotTargetEvidence,
} from "./change-set.js";
import {
  openRecoveryJournal,
  type RecoveryJournal,
  type RecoveryJournalJson,
} from "./recovery-journal.js";

export const DEFAULT_RECOVERY_JOURNAL_SLOT_CAPACITY = 8 * 1024 * 1024;

export interface ChangeSetExecutionHost {
  pathKind(path: string): Promise<ChangeSetPathKind | null>;
  directoryIdentity(path: string): Promise<string | null>;
  prepareDirectory(stageId: string): Promise<string>;
  publishDirectory(stageId: string, path: string): Promise<void>;
  discardPreparedDirectory(stageId: string): Promise<void>;
  removeDirectory(path: string): Promise<void>;
  readBinary?(path: string): Promise<ArrayBuffer | Uint8Array | null>;
  fileIdentity?(path: string): Promise<string | null>;
  prepareFile?(stageId: string, bytes: Uint8Array): Promise<string>;
  publishFile?(stageId: string, path: string): Promise<void>;
  discardPreparedFile?(stageId: string): Promise<void>;
  removeFile?(path: string): Promise<void>;
  publishSearchSnapshot(targets?: readonly SearchSnapshotTargetEvidence[]): Promise<void>;
}

export type DirectoryExecutionHost = ChangeSetExecutionHost;

export interface FileSystemChangeSetExecutionOptions {
  journalPath: string;
  host: ChangeSetExecutionHost;
  slotCapacity?: number;
}

function parseFrame(value: unknown): RecoveryJournalFrame {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Recovery Journal payload is corrupt or incompatible");
  }
  const frame = value as Partial<RecoveryJournalFrame>;
  if (
    (frame.schemaVersion !== 1 &&
      frame.schemaVersion !== RECOVERY_JOURNAL_FRAME_SCHEMA_VERSION) ||
    typeof frame.vaultId !== "string" ||
    frame.vaultId.length === 0 ||
    typeof frame.changeSetId !== "string" ||
    frame.changeSetId.length === 0 ||
    !Number.isSafeInteger(frame.enqueueSeq) ||
    typeof frame.input !== "object" ||
    frame.input === null ||
    !Array.isArray(frame.directories) ||
    (frame.schemaVersion === 1 && frame.files !== undefined) ||
    (frame.schemaVersion === RECOVERY_JOURNAL_FRAME_SCHEMA_VERSION &&
      !Array.isArray(frame.files)) ||
    typeof frame.preview !== "object" ||
    frame.preview === null
  ) {
    throw new Error("Recovery Journal payload is corrupt or incompatible");
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
    ...(options.host.readBinary === undefined ? {} : { readBinary: options.host.readBinary }),
    ...(options.host.fileIdentity === undefined ? {} : { fileIdentity: options.host.fileIdentity }),
    ...(options.host.prepareFile === undefined ? {} : { prepareFile: options.host.prepareFile }),
    ...(options.host.publishFile === undefined ? {} : { publishFile: options.host.publishFile }),
    ...(options.host.discardPreparedFile === undefined
      ? {}
      : { discardPreparedFile: options.host.discardPreparedFile }),
    ...(options.host.removeFile === undefined ? {} : { removeFile: options.host.removeFile }),
    publishSearchSnapshot: options.host.publishSearchSnapshot,
    close: () => handle.close(),
  };
}
