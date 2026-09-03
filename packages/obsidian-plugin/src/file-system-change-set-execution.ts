import { createHash } from "node:crypto";
import {
  link,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rm,
  rmdir,
  stat,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import {
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";

import { parseChangeSetSubmitInput } from "@llm-wiki/vault-contracts";

import { RECOVERY_JOURNAL_FRAME_SCHEMA_VERSION } from "./change-set.js";
import type {
  ChangeSetExecutionAdapter,
  ChangeSetPathKind,
  ChangeSetSemanticEvent,
  ChangeSetSemanticEvidenceRequest,
  MoveSnapshotBarrier,
  RecoveryJournalFrame,
  SearchSnapshotTargetEvidence,
} from "./change-set.js";
import {
  RecoveryJournalIncompatibleError,
  openRecoveryJournal,
  type RecoveryJournal,
  type RecoveryJournalJson,
} from "./recovery-journal.js";

export const DEFAULT_RECOVERY_JOURNAL_SLOT_CAPACITY = 8 * 1024 * 1024;
export const CHANGE_SET_SEMANTIC_EVIDENCE_DEADLINE_MS = 5_000;

type VaultMutationEvent = ChangeSetSemanticEvidenceRequest["requiredEvents"][number];

export interface ChangeSetSemanticEvidenceTracker {
  begin(request: ChangeSetSemanticEvidenceRequest): void;
  record(event: VaultMutationEvent): void;
  await(request: ChangeSetSemanticEvidenceRequest): Promise<void>;
}

/**
 * Targeted postconditions that stand in for the generic Vault events hidden
 * trash and restore never emit (spec A-38). Both probes are polled until the
 * evidence deadline, so asynchronous metadata-cache updates may catch up
 * while the barrier waits. A hidden-trash request evaluated without probes can never
 * converge: raw path state alone does not prove the result, so the barrier
 * fails closed at the deadline.
 */
export interface ChangeSetSemanticProbes {
  /** True while Obsidian still serves a metadata-cache entry for the path. */
  cacheVisible(path: string): Promise<boolean>;
  /** True while any note's resolved references still point at the path. */
  referenced(path: string): Promise<boolean>;
}

export interface ChangeSetSemanticEvidenceTrackerOptions {
  publishSuccessorSearchSnapshot(): Promise<void>;
  probes?: ChangeSetSemanticProbes;
  deadlineMs?: number;
  now?: () => number;
  delay?: (milliseconds: number) => Promise<void>;
}

function semanticRequestsMatch(
  left: ChangeSetSemanticEvidenceRequest,
  right: ChangeSetSemanticEvidenceRequest,
): boolean {
  return (
    left.mode === right.mode &&
    left.hiddenTrash === right.hiddenTrash &&
    JSON.stringify(left.operations) === JSON.stringify(right.operations) &&
    JSON.stringify(left.publicPaths) === JSON.stringify(right.publicPaths) &&
    JSON.stringify(left.referenceBaselines) === JSON.stringify(right.referenceBaselines)
  );
}

export function createChangeSetSemanticEvidenceTracker(
  options: ChangeSetSemanticEvidenceTrackerOptions,
): ChangeSetSemanticEvidenceTracker {
  let active: ChangeSetSemanticEvidenceRequest | null = null;
  let events: VaultMutationEvent[] = [];
  const now = options.now ?? Date.now;
  const delay = options.delay ?? ((milliseconds) =>
    new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const expectedEvents = (request: ChangeSetSemanticEvidenceRequest): number =>
    request.requiredEvents.length;
  const hasEvent = (expected: VaultMutationEvent): boolean =>
    events.some((event) => JSON.stringify(event) === JSON.stringify(expected));
  const probesSatisfied = async (
    request: ChangeSetSemanticEvidenceRequest,
  ): Promise<boolean> => {
    if (!request.hiddenTrash) return true;
    const probes = options.probes;
    if (probes === undefined) return false;
    for (const operation of request.operations) {
      if (operation.kind !== "trash") continue;
      if (request.mode === "apply") {
        if (await probes.referenced(operation.path)) return false;
        if ("targetVersion" in operation && (await probes.cacheVisible(operation.path))) {
          return false;
        }
      } else {
        const baseline = request.referenceBaselines?.find(
          ({ path }) => path === operation.path,
        );
        if (
          baseline === undefined ||
          ("targetVersion" in operation && !(await probes.cacheVisible(operation.path))) ||
          (await probes.referenced(operation.path)) !== baseline.referenced
        ) {
          return false;
        }
      }
    }
    return true;
  };
  return {
    begin(request) {
      active = structuredClone(request);
      events = [];
    },
    record(event) {
      if (active !== null) events.push(event);
    },
    async await(request) {
      if (active === null || !semanticRequestsMatch(active, request)) {
        throw new Error("Change Set semantic evidence baseline is unavailable");
      }
      const deadline = now() +
        (options.deadlineMs ?? CHANGE_SET_SEMANTIC_EVIDENCE_DEADLINE_MS);
      const required = expectedEvents(request);
      while (
        events.length < required ||
        request.requiredEvents.some((expected) => !hasEvent(expected)) ||
        !(await probesSatisfied(request))
      ) {
        if (now() >= deadline) {
          active = null;
          throw new Error("Change Set semantic evidence timed out");
        }
        await delay(Math.min(10, Math.max(0, deadline - now())));
      }
      try {
        const remaining = deadline - now();
        if (remaining <= 0) throw new Error("Change Set semantic evidence timed out");
        let timeout: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([
          options.publishSuccessorSearchSnapshot(),
          new Promise<never>((_, reject) => {
            timeout = setTimeout(
              () => reject(new Error("Change Set semantic evidence timed out")),
              remaining,
            );
          }),
        ]).finally(() => {
          active = null;
          if (timeout !== undefined) clearTimeout(timeout);
        });
      } finally {
        active = null;
      }
    },
  };
}

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
  moveFile?(sourcePath: string, destinationPath: string): Promise<void>;
  removeFile?(path: string): Promise<void>;
  moveToTrash?(path: string, trashId: string): Promise<void>;
  restoreFromTrash?(trashId: string, path: string): Promise<void>;
  discardTrash?(trashId: string): Promise<void>;
  readTrash?(trashId: string): Promise<ArrayBuffer | Uint8Array | null>;
  referenced?(path: string): Promise<boolean>;
  beginSemanticEvidence?: ChangeSetExecutionAdapter["beginSemanticEvidence"];
  awaitSemanticEvidence?: ChangeSetExecutionAdapter["awaitSemanticEvidence"];
  semanticEvidencePublishesSnapshot?: boolean;
  publishSearchSnapshot(
    targets?: readonly SearchSnapshotTargetEvidence[],
    moveBarrier?: MoveSnapshotBarrier,
  ): Promise<void>;
}

export type DirectoryExecutionHost = ChangeSetExecutionHost;

export interface NodeFileSystemChangeSetHostOptions {
  basePath: string;
  stateDirectory: string;
  /**
   * Optional test-only crash seam inside the host's private file operations.
   * Only the process-crash corpus (issue #191) passes a crash injector; the
   * production host leaves it unset and these hooks are no-ops.
   */
  crashInjector?(point: string): void | Promise<void>;
  /**
   * Optional test-only storage/permission fault seam inside the host's public
   * mutating operations. Returned errors fail the declared operation before any
   * bytes change. The process-crash fault corpus (issue #192) uses it to prove
   * that a permission failure during rollback preserves current state and fails
   * closed; production leaves it unset and it is a no-op.
   */
  operationFault?(
    operation: string,
    context: { path?: string; stageId?: string },
  ): Error | null | Promise<Error | null>;
  /** Optional observer of public-path mutations, used to synthesize the host semantic events a real Obsidian metadata-cache watcher would emit (process-crash corpus, issue #189). */
  recordEvent?(event: ChangeSetSemanticEvent): void;
  publishFile?(stageId: string, path: string): Promise<void>;
  moveFile?(sourcePath: string, destinationPath: string): Promise<void>;
  removeFile?(path: string): Promise<void>;
  moveToTrash?(path: string, trashId: string): Promise<void>;
  restoreFromTrash?(
    trashId: string,
    path: string,
    bytes: Uint8Array,
  ): Promise<void>;
  referenced?(path: string): Promise<boolean>;
  beginSemanticEvidence?: NonNullable<ChangeSetExecutionAdapter["beginSemanticEvidence"]>;
  awaitSemanticEvidence: NonNullable<ChangeSetExecutionAdapter["awaitSemanticEvidence"]>;
  semanticEvidencePublishesSnapshot?: boolean;
  publishSearchSnapshot(
    targets?: readonly SearchSnapshotTargetEvidence[],
    moveBarrier?: MoveSnapshotBarrier,
  ): Promise<void>;
}

function isWithin(root: string, candidate: string): boolean {
  const relativePath = relative(root, candidate);
  return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

export async function createNodeFileSystemChangeSetHost(
  options: NodeFileSystemChangeSetHostOptions,
): Promise<ChangeSetExecutionHost> {
  const root = await realpath(options.basePath);
  const statePath = resolve(options.stateDirectory);
  if (!isWithin(root, statePath)) {
    throw new Error("Bridge private state escaped Vault containment");
  }
  await mkdir(statePath, { recursive: true });
  const privateRoot = await realpath(statePath);
  if (!isWithin(root, privateRoot)) {
    throw new Error("Bridge private state escaped Vault containment");
  }
  const stagingDirectory = join(privateRoot, "staging");
  const managedTrashDirectory = join(privateRoot, "trash");
  const publicPath = (path: string): string => resolve(options.basePath, ...path.split("/"));
  const stagePath = (stageId: string): string =>
    join(stagingDirectory, ...stageId.split("/"));
  const trashPath = (trashId: string): string =>
    join(managedTrashDirectory, ...trashId.split("/"));
  const assertPrivateContained = async (path: string): Promise<string> => {
    if (!isWithin(privateRoot, path)) {
      throw new Error("Bridge private path escaped containment");
    }
    let nearest = path;
    while (nearest !== privateRoot) {
      try {
        nearest = await realpath(nearest);
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        nearest = dirname(nearest);
      }
    }
    if (!isWithin(privateRoot, nearest)) {
      throw new Error("Bridge private path escaped containment");
    }
    return path;
  };
  const fault = async (
    operation: string,
    context: { path?: string; stageId?: string },
  ): Promise<void> => {
    const error = options.operationFault === undefined
      ? null
      : await options.operationFault(operation, context);
    if (error !== null && error !== undefined) throw error;
  };
  const assertContained = async (
    path: string,
    mode: "existing" | "destination",
  ): Promise<string> => {
    const absolute = publicPath(path);
    if (!isWithin(root, absolute)) throw new Error("Vault path escaped containment");
    const inspected = mode === "destination" ? dirname(absolute) : absolute;
    if (mode === "existing") {
      try {
        if ((await lstat(absolute)).isSymbolicLink()) {
          throw new Error("Symbolic links cannot be mutated through Change Sets");
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    let nearest = inspected;
    while (true) {
      try {
        nearest = await realpath(nearest);
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        nearest = dirname(nearest);
      }
    }
    if (!isWithin(root, nearest)) throw new Error("Vault path escaped containment");
    return absolute;
  };
  return {
    pathKind: async (path) => {
      try {
        const value = await lstat(await assertContained(path, "existing"));
        if (value.isSymbolicLink()) return null;
        return value.isDirectory() ? "directory" : value.isFile() ? "file" : null;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
    },
    directoryIdentity: async (path) => {
      try {
        const value = await stat(await assertContained(path, "existing"));
        return value.isDirectory() ? `${value.dev}:${value.ino}:${value.birthtimeMs}` : null;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
    },
    prepareDirectory: async (stageId) => {
      const path = await assertPrivateContained(stagePath(stageId));
      await mkdir(path, { recursive: true });
      const value = await stat(path);
      return `${value.dev}:${value.ino}:${value.birthtimeMs}`;
    },
    publishDirectory: async (stageId, path) => {
      await fault("publishDirectory", { stageId, path });
      await rename(
        await assertPrivateContained(stagePath(stageId)),
        await assertContained(path, "destination"),
      );
    },
    discardPreparedDirectory: async (stageId) => {
      await fault("discardPreparedDirectory", { stageId });
      await rmdir(await assertPrivateContained(stagePath(stageId))).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
    },
    removeDirectory: async (path) => {
      await fault("removeDirectory", { path });
      await rmdir(await assertContained(path, "existing"));
    },
    readBinary: async (path) => {
      try {
        return await readFile(await assertContained(path, "existing"));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
    },
    fileIdentity: async (path) => {
      try {
        const value = await stat(await assertContained(path, "existing"));
        return value.isFile() ? `${value.dev}:${value.ino}:${value.birthtimeMs}` : null;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
    },
    prepareFile: async (stageId, bytes) => {
      await fault("prepareFile", { stageId });
      const path = await assertPrivateContained(stagePath(stageId));
      await mkdir(dirname(path), { recursive: true });
      const handle = await open(path, "wx");
      try {
        await handle.writeFile(bytes);
        await handle.sync();
      } finally {
        await handle.close();
      }
      const value = await stat(path);
      return `${value.dev}:${value.ino}:${value.birthtimeMs}`;
    },
    publishFile: async (stageId, path) => {
      await fault("publishFile", { stageId, path });
      const source = await assertPrivateContained(stagePath(stageId));
      const destination = await assertContained(path, "destination");
      if (options.publishFile !== undefined) {
        await options.publishFile(stageId, path);
        return;
      }
      await rename(source, destination);
      options.recordEvent?.({ kind: "create", path });
    },
    discardPreparedFile: async (stageId) => {
      await fault("discardPreparedFile", { stageId });
      const path = await assertPrivateContained(stagePath(stageId));
      // A rollback restore stages under `${stageId}/rollback` and then publishes
      // that file away, leaving the base stage path as an empty directory. When
      // recovery re-runs a rollback after a crash mid-rollback, the base stage
      // path is a directory rather than a file; `rm` without `recursive` would
      // fail closed (EISDIR) and block writes. Recursing keeps discard
      // idempotent so a repeated rollback attempt can converge to ROLLED_BACK.
      await rm(path, { force: true, recursive: true });
    },
    moveFile: async (sourcePath, destinationPath) => {
      await fault("moveFile", { path: sourcePath });
      const source = await assertContained(sourcePath, "existing");
      const destination = await assertContained(destinationPath, "destination");
      if (options.moveFile !== undefined) {
        await options.moveFile(sourcePath, destinationPath);
        options.recordEvent?.({ kind: "rename", oldPath: sourcePath, path: destinationPath });
        return;
      }
      await link(source, destination);
      await unlink(source);
      // The corpus host has no Obsidian metadata-cache watcher to emit the
      // rename event the Change Set semantic barrier waits for, so the node-fs
      // host itself reports the public rename it just made (issue #189).
      options.recordEvent?.({ kind: "rename", oldPath: sourcePath, path: destinationPath });
    },
    removeFile: async (path) => {
      await fault("removeFile", { path });
      const source = await assertContained(path, "existing");
      if (options.removeFile !== undefined) {
        await options.removeFile(path);
        return;
      }
      await unlink(source);
    },
    moveToTrash: async (path, trashId) => {
      await fault("moveToTrash", { path });
      const source = await assertContained(path, "existing");
      const destination = await assertPrivateContained(trashPath(trashId));
      await mkdir(dirname(destination), { recursive: true });
      await link(source, destination);
      // Test-only crash seam: the Bridge-owned private copy is durable and the
      // public path still exists. A termination here must recover without losing
      // bytes or duplicating public content (issue #191 AC5). No-op in production.
      await options.crashInjector?.("after_trash_hidden_copy");
      if (options.moveToTrash !== undefined) {
        await options.moveToTrash(path, trashId);
      } else if (options.removeFile !== undefined) {
        await options.removeFile(path);
      } else {
        await unlink(source);
      }
    },
    restoreFromTrash: async (trashId, path) => {
      await fault("restoreFromTrash", { path });
      const source = await assertPrivateContained(trashPath(trashId));
      const destination = await assertContained(path, "destination");
      if (options.restoreFromTrash !== undefined) {
        const bytes = Uint8Array.from(await readFile(source));
        await options.restoreFromTrash(trashId, path, bytes);
        // Test-only crash seam between public restore and private cleanup.
        await options.crashInjector?.("after_trash_restore_public");
        await rm(source, { force: true });
        return;
      }
      await link(source, destination);
      // Test-only crash seam: the public bytes are restored but the private
      // trash entry is not yet removed; recovery must discard the private copy
      // rather than duplicate the public content (issue #191 AC5).
      await options.crashInjector?.("after_trash_restore_public");
      await unlink(source);
    },
    discardTrash: async (trashId) =>
      rm(await assertPrivateContained(trashPath(trashId)), { force: true }),
    readTrash: async (trashId) => {
      try {
        return await readFile(await assertPrivateContained(trashPath(trashId)));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
    },
    ...(options.referenced === undefined ? {} : { referenced: options.referenced }),
    beginSemanticEvidence: options.beginSemanticEvidence,
    awaitSemanticEvidence: options.awaitSemanticEvidence,
    semanticEvidencePublishesSnapshot: options.semanticEvidencePublishesSnapshot,
    publishSearchSnapshot: options.publishSearchSnapshot,
  };
}

export interface FileSystemChangeSetExecutionOptions {
  journalPath: string;
  host: ChangeSetExecutionHost;
  slotCapacity?: number;
  /**
   * Optional test-only seam that wraps the journal `FileHandle` after it is
   * opened so a storage fault can strike exactly one declared durable frame
   * write (issue #192). Production leaves it unset; the owning process corpus
   * uses it to inject disk-full/short-write/no-progress/sync failures.
   */
  wrapJournalHandle?(handle: FileHandle): FileHandle;
}

function isPrivateId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    !value.includes("\\") &&
    !value.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  );
}

function isRecoveryState(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const state = value as Record<string, unknown>;
  if (state.kind === "absent") return Object.keys(state).length === 1;
  if (typeof state.bytesBase64 !== "string") return false;
  const decoded = Buffer.from(state.bytesBase64, "base64");
  if (decoded.toString("base64") !== state.bytesBase64) return false;
  if (state.kind === "attachment") {
    return (
      typeof state.sha256 === "string" &&
      /^[0-9a-f]{64}$/u.test(state.sha256) &&
      createHash("sha256").update(decoded).digest("hex") === state.sha256
    );
  }
  return (
    state.kind === "markdown" &&
    typeof state.contentVersion === "string" &&
    /^sha256:[0-9a-f]{64}$/u.test(state.contentVersion) &&
    `sha256:${createHash("sha256").update(decoded).digest("hex")}` ===
      state.contentVersion
  );
}

function isMoveBarrier(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const barrier = value as Record<string, unknown>;
  if (
    typeof barrier.presentPath !== "string" ||
    barrier.presentPath.length === 0 ||
    typeof barrier.absentPath !== "string" ||
    barrier.absentPath.length === 0 ||
    typeof barrier.presentVersion !== "string" ||
    !/^sha256:[0-9a-f]{64}$/u.test(barrier.presentVersion) ||
    !Array.isArray(barrier.closure)
  ) return false;
  const paths = new Set<string>();
  return barrier.closure.every((raw: unknown) => {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return false;
    const item = raw as Record<string, unknown>;
    if (
      typeof item.path !== "string" ||
      item.path.length === 0 ||
      paths.has(item.path) ||
      typeof item.contentVersion !== "string" ||
      !/^sha256:[0-9a-f]{64}$/u.test(item.contentVersion) ||
      typeof item.resolvedPath !== "string" ||
      item.resolvedPath.length === 0 ||
      !Number.isInteger(item.referenceCount) ||
      (item.referenceCount as number) < 1
    ) return false;
    paths.add(item.path);
    return true;
  });
}

function parseFrame(value: unknown): RecoveryJournalFrame {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Recovery Journal payload is corrupt or incompatible");
  }
  const frame = value as Partial<RecoveryJournalFrame>;
  if (
    typeof frame.schemaVersion === "number" &&
    Number.isInteger(frame.schemaVersion) &&
    frame.schemaVersion > RECOVERY_JOURNAL_FRAME_SCHEMA_VERSION
  ) {
    throw new RecoveryJournalIncompatibleError(
      "Recovery Journal payload schema is not supported",
    );
  }
  if (
    (frame.schemaVersion !== 1 &&
      frame.schemaVersion !== 2 &&
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
    (frame.schemaVersion !== 1 && !Array.isArray(frame.files)) ||
    typeof frame.preview !== "object" ||
    frame.preview === null
  ) {
    throw new Error("Recovery Journal payload is corrupt or incompatible");
  }
  if (
    frame.schemaVersion === 1 &&
    (frame.files !== undefined ||
      frame.mutations !== undefined ||
      frame.successBarrier !== undefined ||
      frame.rollbackBarrier !== undefined)
  ) {
    throw new Error("Recovery Journal payload is corrupt or incompatible");
  }
  if (
    (frame.successBarrier !== undefined && !isMoveBarrier(frame.successBarrier)) ||
    (frame.rollbackBarrier !== undefined && !isMoveBarrier(frame.rollbackBarrier))
  ) {
    throw new Error("Recovery Journal payload is corrupt or incompatible");
  }
  try {
    parseChangeSetSubmitInput(frame.input);
  } catch {
    throw new Error("Recovery Journal payload is corrupt or incompatible");
  }
  if (
    frame.directories.some(
      (directory) =>
        typeof directory !== "object" ||
        directory === null ||
        typeof directory.path !== "string" ||
        directory.before !== "absent" ||
        directory.expectedAfter !== "directory" ||
        (directory.stageId !== undefined && !isPrivateId(directory.stageId)),
    ) ||
    (frame.files !== undefined &&
      (!Array.isArray(frame.files) ||
        frame.files.some(
          (file) =>
            typeof file !== "object" ||
            file === null ||
            typeof file.path !== "string" ||
            !isRecoveryState(file.before) ||
            !isRecoveryState(file.expectedAfter) ||
            (file.beforeIdentity !== undefined &&
              typeof file.beforeIdentity !== "string") ||
            (file.identity !== undefined && typeof file.identity !== "string") ||
            (file.stageId !== undefined && !isPrivateId(file.stageId)),
        ))) ||
    (frame.mutations !== undefined &&
      (!Array.isArray(frame.mutations) ||
        frame.mutations.some((mutation) => {
          if (typeof mutation !== "object" || mutation === null) return true;
          if (
            typeof mutation.operationId !== "string" ||
            !["copy_attachment", "move_attachment", "move", "trash"].includes(mutation.kind)
          ) return true;
          if (mutation.kind === "trash") {
            return (
              typeof mutation.path !== "string" ||
              !isPrivateId(mutation.trashId) ||
              !isRecoveryState(mutation.before) ||
              !isRecoveryState(mutation.expectedAfter) ||
              (frame.schemaVersion === RECOVERY_JOURNAL_FRAME_SCHEMA_VERSION &&
                typeof mutation.referencedBefore !== "boolean") ||
              (mutation.referencedBefore !== undefined &&
                typeof mutation.referencedBefore !== "boolean")
            );
          }
          return (
            typeof mutation.sourcePath !== "string" ||
            typeof mutation.destinationPath !== "string" ||
            (mutation.kind === "copy_attachment" &&
              (!isPrivateId(mutation.stageId) ||
                !isRecoveryState(mutation.sourceState) ||
                !isRecoveryState(mutation.destinationBefore) ||
                !isRecoveryState(mutation.destinationAfter))) ||
            (mutation.kind === "move_attachment" &&
              (!isRecoveryState(mutation.sourceBefore) ||
                !isRecoveryState(mutation.sourceAfter) ||
                !isRecoveryState(mutation.destinationBefore) ||
                !isRecoveryState(mutation.destinationAfter))) ||
            (mutation.kind === "move" &&
              (!isPrivateId(mutation.stageId) ||
                !isRecoveryState(mutation.sourceBefore) ||
                !isRecoveryState(mutation.sourceAfter) ||
                !isRecoveryState(mutation.destinationBefore) ||
                !isRecoveryState(mutation.destinationAfter)))
          );
        })))
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
  const journalHandle =
    options.wrapJournalHandle === undefined ? handle : options.wrapJournalHandle(handle);
  let journal: RecoveryJournal;
  try {
    journal = await openRecoveryJournal(journalHandle, {
      slotCapacity: options.slotCapacity ?? DEFAULT_RECOVERY_JOURNAL_SLOT_CAPACITY,
    });
  } catch (error) {
    await journalHandle.close();
    throw error;
  }
  try {
    const recovered = await journal.recover();
    if (recovered !== undefined) parseFrame(recovered.payload);
  } catch (error) {
    if (error instanceof RecoveryJournalIncompatibleError) {
      await journalHandle.close();
      throw error;
    }
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
    ...(options.host.moveFile === undefined ? {} : { moveFile: options.host.moveFile }),
    ...(options.host.removeFile === undefined ? {} : { removeFile: options.host.removeFile }),
    ...(options.host.moveToTrash === undefined
      ? {}
      : { moveToTrash: options.host.moveToTrash }),
    ...(options.host.restoreFromTrash === undefined
      ? {}
      : { restoreFromTrash: options.host.restoreFromTrash }),
    ...(options.host.discardTrash === undefined
      ? {}
      : { discardTrash: options.host.discardTrash }),
    ...(options.host.readTrash === undefined ? {} : { readTrash: options.host.readTrash }),
    ...(options.host.referenced === undefined ? {} : { referenced: options.host.referenced }),
    ...(options.host.beginSemanticEvidence === undefined
      ? {}
      : { beginSemanticEvidence: options.host.beginSemanticEvidence }),
    ...(options.host.awaitSemanticEvidence === undefined
      ? {}
      : { awaitSemanticEvidence: options.host.awaitSemanticEvidence }),
    ...(options.host.semanticEvidencePublishesSnapshot === undefined
      ? {}
      : { semanticEvidencePublishesSnapshot: options.host.semanticEvidencePublishesSnapshot }),
    publishSearchSnapshot: options.host.publishSearchSnapshot,
    close: () => journalHandle.close(),
  };
}
