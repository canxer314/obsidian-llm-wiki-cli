import { mkdir, open } from "node:fs/promises";
import { dirname } from "node:path";

import type {
  ChangeSetExecutionAdapter,
  ChangeSetPathKind,
  MoveSnapshotBarrier,
  RecoveryJournalFrame,
} from "./change-set.js";
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
  writeBinary?(path: string, bytes: Uint8Array): Promise<void>;
  removeFile?(path: string): Promise<void>;
  moveFile?(sourcePath: string, destinationPath: string): Promise<void>;
  publishSearchSnapshot(barrier?: MoveSnapshotBarrier): Promise<void>;
}

export interface FileSystemChangeSetExecutionOptions {
  journalPath: string;
  host: DirectoryExecutionHost;
  slotCapacity?: number;
}

function parseBase64(value: unknown): string {
  if (
    typeof value !== "string" ||
    Buffer.from(value, "base64").toString("base64") !== value
  ) throw new Error("Recovery Journal payload is corrupt or incompatible");
  return value;
}

function parseFileState(value: unknown): { kind: "absent" } | { kind: "file"; bytesBase64: string } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Recovery Journal payload is corrupt or incompatible");
  }
  const state = value as Record<string, unknown>;
  if (state.kind === "absent" && Object.keys(state).join(",") === "kind") {
    return { kind: "absent" };
  }
  if (
    state.kind === "file" &&
    Object.keys(state).sort().join(",") === "bytesBase64,kind"
  ) return { kind: "file", bytesBase64: parseBase64(state.bytesBase64) };
  throw new Error("Recovery Journal payload is corrupt or incompatible");
}

function parseBarrier(value: unknown): MoveSnapshotBarrier | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Recovery Journal payload is corrupt or incompatible");
  }
  const barrier = value as Record<string, unknown>;
  if (
    typeof barrier.presentPath !== "string" || barrier.presentPath.length === 0 ||
    typeof barrier.absentPath !== "string" || barrier.absentPath.length === 0 ||
    typeof barrier.presentVersion !== "string" ||
    !/^sha256:[0-9a-f]{64}$/u.test(barrier.presentVersion) ||
    !Array.isArray(barrier.closure)
  ) throw new Error("Recovery Journal payload is corrupt or incompatible");
  const paths = new Set<string>();
  const closure = barrier.closure.map((raw: unknown) => {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      throw new Error("Recovery Journal payload is corrupt or incompatible");
    }
    const item = raw as Record<string, unknown>;
    if (
      typeof item.path !== "string" || item.path.length === 0 || paths.has(item.path) ||
      typeof item.contentVersion !== "string" ||
      !/^sha256:[0-9a-f]{64}$/u.test(item.contentVersion) ||
      typeof item.resolvedPath !== "string" || item.resolvedPath.length === 0 ||
      !Number.isInteger(item.referenceCount) || (item.referenceCount as number) < 1
    ) throw new Error("Recovery Journal payload is corrupt or incompatible");
    paths.add(item.path);
    return {
      path: item.path,
      contentVersion: item.contentVersion,
      resolvedPath: item.resolvedPath,
      referenceCount: item.referenceCount as number,
    };
  });
  return {
    presentPath: barrier.presentPath,
    absentPath: barrier.absentPath,
    presentVersion: barrier.presentVersion,
    closure,
  };
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
    typeof frame.preview !== "object" ||
    frame.preview === null
  ) {
    throw new Error("Recovery Journal payload is corrupt or incompatible");
  }
  if (frame.files !== undefined && !Array.isArray(frame.files)) {
    throw new Error("Recovery Journal payload is corrupt or incompatible");
  }
  const files = frame.files === undefined
    ? undefined
    : frame.files.map((raw) => {
        if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
          throw new Error("Recovery Journal payload is corrupt or incompatible");
        }
        const file = raw as unknown as Record<string, unknown>;
        if (typeof file.path !== "string" || file.path.length === 0) {
          throw new Error("Recovery Journal payload is corrupt or incompatible");
        }
        return {
          path: file.path,
          before: parseFileState(file.before),
          expectedAfter: parseFileState(file.expectedAfter),
          ...(file.intermediate === undefined
            ? {}
            : {
                intermediate: Array.isArray(file.intermediate)
                  ? file.intermediate.map(parseFileState)
                  : (() => {
                      throw new Error("Recovery Journal payload is corrupt or incompatible");
                    })(),
              }),
        };
      });
  if (files !== undefined && new Set(files.map(({ path }) => path)).size !== files.length) {
    throw new Error("Recovery Journal payload is corrupt or incompatible");
  }
  return {
    ...structuredClone(value) as RecoveryJournalFrame,
    ...(files === undefined ? {} : { files }),
    ...(frame.successBarrier === undefined
      ? {}
      : { successBarrier: parseBarrier(frame.successBarrier) }),
    ...(frame.rollbackBarrier === undefined
      ? {}
      : { rollbackBarrier: parseBarrier(frame.rollbackBarrier) }),
  };
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
    ...(options.host.writeBinary === undefined ? {} : { writeBinary: options.host.writeBinary }),
    ...(options.host.removeFile === undefined ? {} : { removeFile: options.host.removeFile }),
    ...(options.host.moveFile === undefined ? {} : { moveFile: options.host.moveFile }),
    publishSearchSnapshot: options.host.publishSearchSnapshot,
    close: () => handle.close(),
  };
}
