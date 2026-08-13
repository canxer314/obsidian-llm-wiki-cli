import { createHash, randomUUID } from "node:crypto";
import { TextDecoder } from "node:util";

import {
  parseChangeSetStatusResult,
  parseChangeSetSubmitInput,
  parseChangeSetSubmitResult,
  type ChangeSetOperation,
  type ChangeSetRecord,
  type ChangeSetStatusInput,
  type ChangeSetStatusResult,
  type ChangeSetSubmitInput,
  type ChangeSetSubmitResult,
  type VaultState,
} from "@llm-wiki/vault-contracts";

export const CHANGE_SET_RECORD_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
export const CHANGE_SET_REGISTRY_SCHEMA_VERSION = 1;

export interface BoundMoveDerivedEffect {
  operationId: string;
  path: string;
  targetVersion: string;
  projectedBytesBase64: string;
  referenceCount?: number;
}

export interface BoundMoveProjection {
  operationId: string;
  derivedEffects: BoundMoveDerivedEffect[];
}

export interface ChangeSetExecutionState {
  phase: "queued" | "executing" | "terminal";
  input: ChangeSetSubmitInput;
  boundMoves?: BoundMoveProjection[];
}

export interface ChangeSetRegistryEntry {
  submissionKey: string;
  fingerprint: string;
  changeSetId: string;
  enqueueSeq: number;
  acceptedAt: number;
  expiresAt: number;
  historicalGate?: ChangeSetGate;
  execution?: ChangeSetExecutionState;
  changeSet: ChangeSetRecord;
}

export interface ChangeSetRegistryTombstone {
  submissionKey: string;
  changeSetId: string;
}

export interface ChangeSetRegistryState {
  schemaVersion: typeof CHANGE_SET_REGISTRY_SCHEMA_VERSION;
  nextEnqueueSeq: number;
  entries: ChangeSetRegistryEntry[];
  tombstones: ChangeSetRegistryTombstone[];
}

export interface ChangeSetRegistryStore {
  load(): Promise<unknown>;
  save(state: ChangeSetRegistryState): Promise<void>;
}

export type ChangeSetPathKind = "file" | "directory";

export type FrontmatterChange = Extract<
  ChangeSetOperation,
  { kind: "edit_frontmatter" }
>["changes"][number];

export interface MoveDerivedProjection {
  operationId: string;
  path: string;
  targetVersion: string;
  projectedBytes: ArrayBuffer | Uint8Array;
  referenceCount?: number;
}

export interface MoveProjection {
  derivedEffects: MoveDerivedProjection[];
}

export interface ChangeSetPreflightDataSource {
  readBinary(path: string): Promise<ArrayBuffer | Uint8Array | null>;
  pathKind(path: string): Promise<ChangeSetPathKind | null>;
  isContained(path: string): Promise<boolean>;
  projectFrontmatter?(
    bytes: Uint8Array,
    changes: FrontmatterChange[],
  ): Promise<ArrayBuffer | Uint8Array | null>;
  projectMove?(
    operation: Extract<ChangeSetOperation, { kind: "move" }>,
    sourceBytes: Uint8Array,
  ): Promise<MoveProjection | null>;
}

export type RecoveryJournalPhase = "PREPARED" | "COMMITTED" | "ROLLED_BACK" | "FAILED";

export interface RecoveryFileState {
  kind: "absent" | "file";
  bytesBase64?: string;
}

export interface RecoveryFileFootprint {
  path: string;
  before: RecoveryFileState;
  expectedAfter: RecoveryFileState;
  intermediate?: RecoveryFileState[];
}

export interface RecoveryJournalFrame {
  schemaVersion: 1;
  vaultId: string;
  changeSetId: string;
  enqueueSeq: number;
  phase: RecoveryJournalPhase;
  input: ChangeSetSubmitInput;
  preview: ImmutableChangeSetPreview;
  directories: readonly {
    path: string;
    before: "absent";
    expectedAfter: "directory";
    identity?: string;
    stageId?: string;
  }[];
  files?: readonly RecoveryFileFootprint[];
  successBarrier?: MoveSnapshotBarrier;
  rollbackBarrier?: MoveSnapshotBarrier;
  finalPaths?: Extract<ChangeSetRecord, { state: "intent_applied" }>["paths"];
}

export interface MoveSnapshotBarrier {
  presentPath: string;
  absentPath: string;
  presentVersion: string;
  closure: readonly {
    path: string;
    contentVersion: string;
    resolvedPath: string;
    referenceCount: number;
  }[];
}

export interface ChangeSetExecutionAdapter {
  loadRecoveryFrame(): Promise<RecoveryJournalFrame | null>;
  persistRecoveryFrame(frame: RecoveryJournalFrame): Promise<void>;
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
  close?(): Promise<void>;
}

export interface ChangeSetRuntimeStatePort {
  setQueue(state: {
    currentExecutionId: string | null;
    length: number;
    headChangeSetId: string | null;
  }): void;
  blockWritesForUnproven(changeSetId: string): void | Promise<void>;
}

export class InjectedChangeSetCrash extends Error {
  constructor(readonly point: string) {
    super(`Injected Change Set crash at ${point}`);
    this.name = "InjectedChangeSetCrash";
  }
}

export interface ChangeSetServiceOptions {
  store: ChangeSetRegistryStore;
  dataSource: ChangeSetPreflightDataSource;
  execution?: ChangeSetExecutionAdapter;
  runtimeState?: ChangeSetRuntimeStatePort;
  vaultId?: string;
  crashInjector?: (point: string) => void | Promise<void>;
  now?: () => number;
  createChangeSetId?: () => string;
}

export interface ChangeSetGate {
  code:
    | "writes_paused"
    | "upgrade_in_progress"
    | "recovery_in_progress"
    | "recovery_blocked"
    | "incompatible_protocol";
}

export interface ChangeSetRequestState {
  vault: VaultState;
  effectiveGate: ChangeSetGate | null;
}

const utf8Decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const protectedRoots = [".git", ".obsidian", ".llm-wiki", ".trash"];

function emptyState(): ChangeSetRegistryState {
  return {
    schemaVersion: CHANGE_SET_REGISTRY_SCHEMA_VERSION,
    nextEnqueueSeq: 1,
    entries: [],
    tombstones: [],
  };
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function parseBoundMoves(value: unknown): BoundMoveProjection[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new Error("Change Set registry is corrupt or incompatible");
  }
  return value.map((rawMove: unknown) => {
    if (
      typeof rawMove !== "object" || rawMove === null
    ) throw new Error("Change Set registry is corrupt or incompatible");
    const move = rawMove as Record<string, unknown>;
    if (
      !isNonEmptyString(move.operationId) ||
      !Array.isArray(move.derivedEffects)
    ) throw new Error("Change Set registry is corrupt or incompatible");
    return {
      operationId: move.operationId,
      derivedEffects: move.derivedEffects.map((rawEffect: unknown) => {
        if (
          typeof rawEffect !== "object" || rawEffect === null
        ) throw new Error("Change Set registry is corrupt or incompatible");
        const effect = rawEffect as Record<string, unknown>;
        if (
          !isNonEmptyString(effect.operationId) ||
          !isNonEmptyString(effect.path) ||
          typeof effect.targetVersion !== "string" ||
          !/^sha256:[0-9a-f]{64}$/u.test(effect.targetVersion) ||
          typeof effect.projectedBytesBase64 !== "string" ||
          Buffer.from(effect.projectedBytesBase64, "base64").toString("base64") !==
            effect.projectedBytesBase64 ||
          (
            effect.referenceCount !== undefined &&
            (!Number.isInteger(effect.referenceCount) || (effect.referenceCount as number) < 1)
          )
        ) throw new Error("Change Set registry is corrupt or incompatible");
        return {
          operationId: effect.operationId,
          path: effect.path,
          targetVersion: effect.targetVersion,
          projectedBytesBase64: effect.projectedBytesBase64,
          ...(effect.referenceCount === undefined
            ? {}
            : { referenceCount: effect.referenceCount as number }),
        };
      }),
    };
  });
}

export function parseChangeSetRegistryState(value: unknown): ChangeSetRegistryState {
  if (value === undefined) return emptyState();
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Change Set registry is corrupt or incompatible");
  }
  const state = value as Partial<ChangeSetRegistryState>;
  if (
    state.schemaVersion !== CHANGE_SET_REGISTRY_SCHEMA_VERSION ||
    !Number.isInteger(state.nextEnqueueSeq) ||
    (state.nextEnqueueSeq ?? 0) < 1 ||
    !Array.isArray(state.entries) ||
    !Array.isArray(state.tombstones)
  ) {
    throw new Error("Change Set registry is corrupt or incompatible");
  }
  const entries = state.entries.map((entry) => {
    if (
      typeof entry !== "object" ||
      entry === null ||
      !isNonEmptyString(entry.submissionKey) ||
      !/^sha256:[0-9a-f]{64}$/u.test(entry.fingerprint) ||
      !isNonEmptyString(entry.changeSetId) ||
      !Number.isInteger(entry.enqueueSeq) ||
      !Number.isFinite(entry.acceptedAt) ||
      !Number.isFinite(entry.expiresAt) ||
      (entry.historicalGate !== undefined &&
        entry.historicalGate.code !== "recovery_blocked") ||
      entry.expiresAt - entry.acceptedAt < CHANGE_SET_RECORD_RETENTION_MS
    ) {
      throw new Error("Change Set registry is corrupt or incompatible");
    }
    const changeSet = parsePersistedChangeSet(entry.changeSet);
    if (changeSet.changeSetId !== entry.changeSetId) {
      throw new Error("Change Set registry is corrupt or incompatible");
    }
    let execution: ChangeSetExecutionState | undefined;
    if (entry.execution !== undefined) {
      if (
        typeof entry.execution !== "object" ||
        entry.execution === null ||
        !["queued", "executing", "terminal"].includes(entry.execution.phase)
      ) {
        throw new Error("Change Set registry is corrupt or incompatible");
      }
      execution = {
        phase: entry.execution.phase as ChangeSetExecutionState["phase"],
        input: parseChangeSetSubmitInput(entry.execution.input),
        ...(entry.execution.boundMoves === undefined
          ? {}
          : { boundMoves: parseBoundMoves(entry.execution.boundMoves) }),
      };
    }
    return {
      submissionKey: entry.submissionKey,
      fingerprint: entry.fingerprint,
      changeSetId: entry.changeSetId,
      enqueueSeq: entry.enqueueSeq,
      acceptedAt: entry.acceptedAt,
      expiresAt: entry.expiresAt,
      ...(entry.historicalGate === undefined
        ? {}
        : { historicalGate: entry.historicalGate }),
      ...(execution === undefined ? {} : { execution }),
      changeSet,
    };
  });
  const tombstones = state.tombstones.map((tombstone) => {
    if (
      typeof tombstone !== "object" ||
      tombstone === null ||
      !isNonEmptyString(tombstone.submissionKey) ||
      !isNonEmptyString(tombstone.changeSetId)
    ) {
      throw new Error("Change Set registry is corrupt or incompatible");
    }
    return {
      submissionKey: tombstone.submissionKey,
      changeSetId: tombstone.changeSetId,
    };
  });
  const submissionKeys = new Set<string>();
  const changeSetIds = new Set<string>();
  for (const record of [...entries, ...tombstones]) {
    if (submissionKeys.has(record.submissionKey) || changeSetIds.has(record.changeSetId)) {
      throw new Error("Change Set registry is corrupt or incompatible");
    }
    submissionKeys.add(record.submissionKey);
    changeSetIds.add(record.changeSetId);
  }
  return {
    schemaVersion: CHANGE_SET_REGISTRY_SCHEMA_VERSION,
    nextEnqueueSeq: state.nextEnqueueSeq!,
    entries,
    tombstones,
  };
}

function parsePersistedChangeSet(value: unknown): ChangeSetRecord {
  const parsed = parseChangeSetSubmitResult({
    outcome: "registered",
    changeSet: value,
    vault: { writeGate: "open", writeState: "writable" },
  });
  if (parsed.outcome !== "registered") throw new Error("Invalid persisted Change Set");
  return parsed.changeSet;
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, member]) => member !== undefined)
      .sort(([left], [right]) => compareCodeUnits(left, right))
      .map(([key, member]) => [key, canonicalize(member)]),
  );
}

export function fingerprintChangeSetRequest(input: ChangeSetSubmitInput): string {
  const readDependencies = [...(input.readDependencies ?? [])].sort(
    (left, right) =>
      compareCodeUnits(left.path, right.path) ||
      compareCodeUnits(left.contentVersion, right.contentVersion),
  );
  const canonical = canonicalize({
    operations: input.operations,
    readDependencies,
  });
  return `sha256:${createHash("sha256").update(JSON.stringify(canonical)).digest("hex")}`;
}

function operationPaths(operation: ChangeSetOperation): string[] {
  if ("sourcePath" in operation) return [operation.sourcePath, operation.destinationPath];
  return [operation.path];
}

function operationTargetPaths(operation: ChangeSetOperation): string[] {
  if ("destinationPath" in operation) return [operation.destinationPath];
  if (operation.kind === "create_directory" || operation.kind === "create_note") {
    return [operation.path];
  }
  return [];
}

function protectedPath(path: string): boolean {
  const root = path.split("/", 1)[0]?.toLocaleLowerCase("en-US");
  return root !== undefined && protectedRoots.includes(root);
}

function contentVersion(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function attachmentHash(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function fileState(bytes: Uint8Array | null): RecoveryFileState {
  return bytes === null
    ? { kind: "absent" }
    : { kind: "file", bytesBase64: Buffer.from(bytes).toString("base64") };
}

function fileStateBytes(state: RecoveryFileState): Uint8Array | null {
  if (state.kind === "absent") return null;
  if (state.bytesBase64 === undefined) {
    throw new Error("Recovery Journal file bytes are incomplete");
  }
  return Buffer.from(state.bytesBase64, "base64");
}

function sameBytes(left: Uint8Array | null, right: Uint8Array | null): boolean {
  if (left === null || right === null) return left === right;
  return Buffer.from(left).equals(Buffer.from(right));
}

function bindMoveProjection(
  operationId: string,
  projection: MoveProjection,
): BoundMoveProjection {
  return {
    operationId,
    derivedEffects: projection.derivedEffects.map((effect) => ({
      operationId: effect.operationId,
      path: effect.path,
      targetVersion: effect.targetVersion,
      projectedBytesBase64: Buffer.from(
        effect.projectedBytes instanceof Uint8Array
          ? effect.projectedBytes
          : new Uint8Array(effect.projectedBytes),
      ).toString("base64"),
      ...(effect.referenceCount === undefined ? {} : { referenceCount: effect.referenceCount }),
    })),
  };
}

function unbindMoveProjection(bound: BoundMoveProjection): MoveProjection {
  return {
    derivedEffects: bound.derivedEffects.map((effect) => ({
      operationId: effect.operationId,
      path: effect.path,
      targetVersion: effect.targetVersion,
      projectedBytes: Buffer.from(effect.projectedBytesBase64, "base64"),
      ...(effect.referenceCount === undefined ? {} : { referenceCount: effect.referenceCount }),
    })),
  };
}

function occurrenceCount(content: string, old: string): number {
  if (old.length === 0) return content.length + 1;
  let count = 0;
  let index = 0;
  while ((index = content.indexOf(old, index)) !== -1) {
    count += 1;
    index += old.length;
  }
  return count;
}

function parentPaths(path: string): string[] {
  const parts = path.split("/");
  const parents: string[] = [];
  for (let index = 1; index < parts.length; index += 1) {
    parents.push(parts.slice(0, index).join("/"));
  }
  return parents;
}

type ChangeSetFailure = Extract<
  ChangeSetRecord,
  { state: "intent_not_applied" }
>["failure"];

type ImmutableChangeSetPreview = NonNullable<
  Extract<ChangeSetRecord, { state: "in_progress" }>["preview"]
>;
type Preview = ImmutableChangeSetPreview;

interface PreflightResult {
  accepted: boolean;
  failure?: ChangeSetFailure;
  preview?: Preview;
  boundMoves?: BoundMoveProjection[];
}

async function readExecutionBytes(
  execution: Pick<ChangeSetExecutionAdapter, "readBinary">,
  path: string,
): Promise<Uint8Array | null> {
  const value = await execution.readBinary?.(path);
  if (value === undefined || value === null) return null;
  return Uint8Array.from(value instanceof Uint8Array ? value : new Uint8Array(value));
}

async function readBytes(
  dataSource: ChangeSetPreflightDataSource,
  path: string,
): Promise<Uint8Array | null> {
  const value = await dataSource.readBinary(path);
  if (value === null) return null;
  return Uint8Array.from(value instanceof Uint8Array ? value : new Uint8Array(value));
}

async function preflight(
  dataSource: ChangeSetPreflightDataSource,
  input: ChangeSetSubmitInput,
  boundMoves: readonly BoundMoveProjection[] = [],
): Promise<PreflightResult> {
  const nextBoundMoves: BoundMoveProjection[] = [];
  for (const operation of input.operations) {
    for (const path of operationPaths(operation)) {
      if (protectedPath(path) || !(await dataSource.isContained(path))) {
        return { accepted: false,
          failure: { code: "path_conflict", operationId: operation.operationId, path },
        };
      }
    }
    for (const parent of operationPaths(operation).flatMap(parentPaths)) {
      if (protectedPath(parent) || !(await dataSource.isContained(parent))) {
        return {
          accepted: false,
          failure: { code: "path_conflict", operationId: operation.operationId, path: parent },
        };
      }
    }
  }

  for (const dependency of input.readDependencies ?? []) {
    if (protectedPath(dependency.path) || !(await dataSource.isContained(dependency.path))) {
      return { accepted: false, failure: { code: "stale_observation" } };
    }
    const bytes = await readBytes(dataSource, dependency.path);
    if (bytes === null || contentVersion(bytes) !== dependency.contentVersion) {
      return { accepted: false, failure: { code: "stale_observation" } };
    }
  }

  type PathPreviewState = Preview["paths"][number];
  const pathStates = new Map<string, Omit<PathPreviewState, "path">>();
  const projectedBytes = new Map<string, Uint8Array | null>();
  const requestedEffects: Preview["requestedEffects"] = [];
  const derivedEffects: Preview["derivedEffects"] = [];
  const currentPathKind = async (path: string): Promise<ChangeSetPathKind | null> => {
    const projected = pathStates.get(path)?.projectedFinalState;
    if (projected !== undefined) {
      if (projected.kind === "absent") return null;
      return projected.kind === "directory" ? "directory" : "file";
    }
    return dataSource.pathKind(path);
  };
  const currentBytes = async (path: string): Promise<Uint8Array | null> => {
    if (projectedBytes.has(path)) return projectedBytes.get(path) ?? null;
    return readBytes(dataSource, path);
  };
  const sameState = (
    left: PathPreviewState["preState"],
    right: PathPreviewState["projectedFinalState"],
  ): boolean => JSON.stringify(left) === JSON.stringify(right);
  const projectPath = (
    path: string,
    preState: PathPreviewState["preState"],
    projectedFinalState: PathPreviewState["projectedFinalState"],
  ): void => {
    const initialState = pathStates.get(path)?.preState ?? preState;
    pathStates.set(path, {
      preState: initialState,
      projectedFinalState,
      projectedOutcome: sameState(initialState, projectedFinalState)
        ? "unchanged"
        : "changed",
    });
  };

  for (const operation of input.operations) {
    let projectedOutcome: "changed" | "already_satisfied" = "changed";
    const targetParents = new Set(
      operationTargetPaths(operation).flatMap(parentPaths),
    );
    const allParents = new Set(operationPaths(operation).flatMap(parentPaths));
    for (const parent of allParents) {
      const kind = await currentPathKind(parent);
      if (kind === "file" || (kind === null && !targetParents.has(parent))) {
        return {
          accepted: false,
          failure: {
            code: "path_conflict",
            operationId: operation.operationId,
            path: parent,
          },
        };
      }
      if (kind === null) {
        projectPath(parent, { kind: "absent" }, { kind: "directory" });
        projectedBytes.set(parent, null);
        derivedEffects.push({
          operationId: `derived/${operation.operationId}/directory/${parent}`,
          causedByOperationId: operation.operationId,
          kind: "create_directory",
          projectedOutcome: "changed",
        });
      }
    }
    if (operation.kind === "create_directory" || operation.kind === "create_note") {
      if ((await currentPathKind(operation.path)) !== null) {
        return {
          accepted: false,
          failure: {
            code: "path_conflict",
            operationId: operation.operationId,
            path: operation.path,
          },
        };
      }
      const finalState =
        operation.kind === "create_directory"
          ? ({ kind: "directory" } as const)
          : ({
              kind: "markdown",
              contentVersion: contentVersion(Buffer.from(operation.content)),
            } as const);
      projectPath(operation.path, { kind: "absent" }, finalState);
      projectedBytes.set(
        operation.path,
        operation.kind === "create_note" ? Buffer.from(operation.content) : null,
      );
    } else if (
      operation.kind === "edit_body" ||
      operation.kind === "edit_frontmatter" ||
      operation.kind === "trash"
    ) {
      const bytes = await currentBytes(operation.path);
      if (bytes === null || contentVersion(bytes) !== operation.targetVersion) {
        return { accepted: false, failure: { code: "stale_observation" } };
      }
      const currentState = {
        kind: "markdown" as const,
        contentVersion: operation.targetVersion,
      };
      if (operation.kind === "edit_body") {
        let content: string;
        try {
          content = utf8Decoder.decode(bytes);
        } catch {
          return { accepted: false, failure: { code: "stale_observation" } };
        }
        if (operation.edit.kind === "replace_exact") {
          const actualOccurrences = occurrenceCount(content, operation.edit.old);
          if (actualOccurrences !== operation.edit.expectedOccurrences) {
            return {
              accepted: false,
              failure: {
                code: "exact_match_count_mismatch",
                operationId: operation.operationId,
                actualOccurrences,
              },
            };
          }
        }
        const projectedContent =
          operation.edit.kind === "replace_whole"
            ? operation.edit.replacement
            : content.replace(operation.edit.old, operation.edit.replacement);
        const finalBytes = Buffer.from(projectedContent);
        const finalState = {
          kind: "markdown" as const,
          contentVersion: contentVersion(finalBytes),
        };
        projectedOutcome = sameState(currentState, finalState)
          ? "already_satisfied"
          : "changed";
        projectPath(operation.path, currentState, finalState);
        projectedBytes.set(operation.path, finalBytes);
      } else if (operation.kind === "edit_frontmatter") {
        const projection = await dataSource.projectFrontmatter?.(bytes, operation.changes);
        if (projection === undefined || projection === null) {
          return { accepted: false };
        }
        const finalBytes = Uint8Array.from(
          projection instanceof Uint8Array ? projection : new Uint8Array(projection),
        );
        const finalState = {
          kind: "markdown" as const,
          contentVersion: contentVersion(finalBytes),
        };
        projectedOutcome = sameState(currentState, finalState)
          ? "already_satisfied"
          : "changed";
        projectPath(operation.path, currentState, finalState);
        projectedBytes.set(operation.path, finalBytes);
      } else {
        projectPath(operation.path, currentState, { kind: "absent" });
        projectedBytes.set(operation.path, null);
      }
    } else if (operation.kind === "move") {
      const sourceBytes = await currentBytes(operation.sourcePath);
      if (
        sourceBytes === null ||
        contentVersion(sourceBytes) !== operation.targetVersion
      ) {
        return { accepted: false, failure: { code: "stale_observation" } };
      }
      if ((await currentPathKind(operation.destinationPath)) !== null) {
        return {
          accepted: false,
          failure: {
            code: "path_conflict",
            operationId: operation.operationId,
            path: operation.destinationPath,
          },
        };
      }
      const bound = boundMoves.find(
        (candidate) => candidate.operationId === operation.operationId,
      );
      let projection: MoveProjection | null | undefined;
      if (bound === undefined) {
        projection = await dataSource.projectMove?.(operation, sourceBytes);
      } else {
        const current = await dataSource.projectMove?.(operation, sourceBytes);
        if (
          current === undefined ||
          current === null ||
          JSON.stringify(bindMoveProjection(operation.operationId, current)) !==
            JSON.stringify(bound)
        ) return { accepted: false, failure: { code: "stale_observation" } };
        projection = unbindMoveProjection(bound);
      }
      if (projection === undefined || projection === null) return { accepted: false };
      nextBoundMoves.push(bound ?? bindMoveProjection(operation.operationId, projection));
      const effectIds = new Set<string>();
      const ordered = [...projection.derivedEffects].sort((left, right) => {
        const byPath = compareCodeUnits(left.path, right.path);
        return byPath === 0
          ? compareCodeUnits(left.operationId, right.operationId)
          : byPath;
      });
      for (const derived of ordered) {
        if (
          effectIds.has(derived.operationId) ||
          protectedPath(derived.path) ||
          !(await dataSource.isContained(derived.path))
        ) {
          return { accepted: false };
        }
        effectIds.add(derived.operationId);
        for (const parent of parentPaths(derived.path)) {
          if (
            protectedPath(parent) ||
            !(await dataSource.isContained(parent)) ||
            (await currentPathKind(parent)) === "file"
          ) {
            return { accepted: false };
          }
        }
        const original = await currentBytes(derived.path);
        if (
          original === null ||
          contentVersion(original) !== derived.targetVersion
        ) {
          return { accepted: false, failure: { code: "stale_observation" } };
        }
        const finalBytes = Uint8Array.from(
          derived.projectedBytes instanceof Uint8Array
            ? derived.projectedBytes
            : new Uint8Array(derived.projectedBytes),
        );
        const preState = {
          kind: "markdown" as const,
          contentVersion: derived.targetVersion,
        };
        const finalState = {
          kind: "markdown" as const,
          contentVersion: contentVersion(finalBytes),
        };
        projectPath(derived.path, preState, finalState);
        projectedBytes.set(derived.path, finalBytes);
        derivedEffects.push({
          operationId: derived.operationId,
          causedByOperationId: operation.operationId,
          kind: "edit_body",
          projectedOutcome: sameState(preState, finalState)
            ? "already_satisfied"
            : "changed",
        });
      }
      const sourceState = {
        kind: "markdown" as const,
        contentVersion: operation.targetVersion,
      };
      const movedBytes = projectedBytes.get(operation.sourcePath) ?? sourceBytes;
      const destinationState = {
        kind: "markdown" as const,
        contentVersion: contentVersion(movedBytes),
      };
      projectPath(operation.sourcePath, sourceState, { kind: "absent" });
      projectedBytes.set(operation.sourcePath, null);
      projectPath(operation.destinationPath, { kind: "absent" }, destinationState);
      projectedBytes.set(operation.destinationPath, movedBytes);
    } else {
      const bytes = await currentBytes(operation.sourcePath);
      if (bytes === null || attachmentHash(bytes) !== operation.expectedSha256) {
        return { accepted: false, failure: { code: "stale_observation" } };
      }
      if ((await currentPathKind(operation.destinationPath)) !== null) {
        return {
          accepted: false,
          failure: {
            code: "path_conflict",
            operationId: operation.operationId,
            path: operation.destinationPath,
          },
        };
      }
      const state = { kind: "attachment" as const, sha256: operation.expectedSha256 };
      projectPath(
        operation.sourcePath,
        state,
        operation.kind === "move_attachment" ? { kind: "absent" } : state,
      );
      if (operation.kind === "move_attachment") {
        projectedBytes.set(operation.sourcePath, null);
      }
      projectPath(operation.destinationPath, { kind: "absent" }, state);
      projectedBytes.set(operation.destinationPath, bytes);
    }
    requestedEffects.push({
      operationId: operation.operationId,
      kind: operation.kind,
      projectedOutcome,
    });
  }

  return {
    accepted: true,
    preview: {
      requestedEffects,
      derivedEffects,
      paths: [...pathStates.entries()]
        .sort(([left], [right]) => compareCodeUnits(left, right))
        .map(([path, state]) => ({ path, ...state })),
    },
    ...(nextBoundMoves.length === 0 ? {} : { boundMoves: nextBoundMoves }),
  };
}

export class ChangeSetService {
  readonly #options: Required<
    Pick<ChangeSetServiceOptions, "now" | "createChangeSetId">
  > &
    Omit<ChangeSetServiceOptions, "now" | "createChangeSetId">;
  #state: ChangeSetRegistryState;
  #operationTail: Promise<void> = Promise.resolve();
  #writeTail: Promise<void> = Promise.resolve();
  #recoveryBlocked = false;

  private constructor(options: ChangeSetServiceOptions, state: ChangeSetRegistryState) {
    this.#options = {
      ...options,
      now: options.now ?? Date.now,
      createChangeSetId: options.createChangeSetId ?? randomUUID,
    };
    this.#state = state;
  }

  static async open(options: ChangeSetServiceOptions): Promise<ChangeSetService> {
    const state = parseChangeSetRegistryState(await options.store.load());
    const service = new ChangeSetService(options, state);
    let recoveryBlocked = false;
    try {
      await service.#recover();
    } catch (error) {
      recoveryBlocked = true;
      service.#recoveryBlocked = true;
      const unfinished = service.#state.entries.filter(
        ({ execution }) => execution !== undefined && execution.phase !== "terminal",
      );
      for (const entry of unfinished) await service.#markUnproven(entry);
      if (unfinished.length === 0) {
        await options.runtimeState?.blockWritesForUnproven("unknown");
      }
      if (options.runtimeState === undefined) throw error;
    }
    if (!recoveryBlocked) await service.#resumeQueue();
    return service;
  }

  async #crash(point: string): Promise<void> {
    await this.#options.crashInjector?.(point);
  }

  #directoryPlan(
    entry: ChangeSetRegistryEntry,
  ): { input: ChangeSetSubmitInput; preview: Preview; directories: string[] } | null {
    if (
      entry.execution === undefined ||
      entry.changeSet.state !== "in_progress" ||
      entry.changeSet.preview === undefined ||
      entry.execution.input.operations.some(({ kind }) => kind !== "create_directory")
    ) {
      return null;
    }
    const directories = entry.changeSet.preview.paths
      .filter(
        ({ preState, projectedFinalState }) =>
          preState.kind === "absent" && projectedFinalState.kind === "directory",
      )
      .map(({ path }) => path)
      .sort((left, right) => {
        const depth = left.split("/").length - right.split("/").length;
        return depth || compareCodeUnits(left, right);
      });
    return {
      input: entry.execution.input,
      preview: entry.changeSet.preview,
      directories,
    };
  }

  async #movePlan(
    entry: ChangeSetRegistryEntry,
  ): Promise<{
    input: ChangeSetSubmitInput;
    preview: Preview;
    directories: string[];
    files: RecoveryFileFootprint[];
  } | null> {
    const execution = this.#options.execution;
    if (
      execution?.readBinary === undefined ||
      execution.writeBinary === undefined ||
      execution.removeFile === undefined ||
      execution.moveFile === undefined ||
      entry.execution === undefined ||
      entry.changeSet.state !== "in_progress" ||
      entry.changeSet.preview === undefined ||
      entry.execution.input.operations.length !== 1 ||
      entry.execution.input.operations[0]?.kind !== "move"
    ) return null;
    const operation = entry.execution.input.operations[0];
    const bound = entry.execution.boundMoves?.find(
      (candidate) => candidate.operationId === operation.operationId,
    );
    if (bound === undefined) return null;
    const projection = unbindMoveProjection(bound);
    const beforeByPath = new Map<string, Uint8Array | null>();
    for (const previewPath of entry.changeSet.preview.paths
      .filter(({ projectedFinalState }) => projectedFinalState.kind !== "directory")) {
      const bytes = await readBytes(this.#options.dataSource, previewPath.path);
      if (
        (previewPath.preState.kind === "absent" && bytes !== null) ||
        (
          previewPath.preState.kind === "markdown" &&
          (bytes === null || contentVersion(bytes) !== previewPath.preState.contentVersion)
        ) ||
        (
          previewPath.preState.kind !== "absent" &&
          previewPath.preState.kind !== "markdown"
        )
      ) return null;
      beforeByPath.set(previewPath.path, bytes);
    }
    const sourceBytes = beforeByPath.get(operation.sourcePath);
    if (sourceBytes === undefined || sourceBytes === null) return null;
    const afterByPath = new Map(beforeByPath);
    for (const effect of projection.derivedEffects) {
      afterByPath.set(effect.path, Uint8Array.from(
        effect.projectedBytes instanceof Uint8Array
          ? effect.projectedBytes
          : new Uint8Array(effect.projectedBytes),
      ));
    }
    const movedBytes = afterByPath.get(operation.sourcePath) ?? sourceBytes;
    afterByPath.set(operation.sourcePath, null);
    afterByPath.set(operation.destinationPath, movedBytes);
    return {
      input: entry.execution.input,
      preview: entry.changeSet.preview,
      directories: entry.changeSet.preview.paths
        .filter(({ preState, projectedFinalState }) =>
          preState.kind === "absent" && projectedFinalState.kind === "directory")
        .map(({ path }) => path)
        .sort((left, right) => {
          const depth = left.split("/").length - right.split("/").length;
          return depth || compareCodeUnits(left, right);
        }),
      files: [...beforeByPath.entries()]
        .sort(([left], [right]) => compareCodeUnits(left, right))
        .map(([path, before]) => ({
          path,
          before: fileState(before),
          expectedAfter: fileState(afterByPath.get(path) ?? null),
          ...(path === operation.sourcePath && !sameBytes(before, movedBytes)
            ? { intermediate: [fileState(movedBytes)] }
            : {}),
        })),
    };
  }

  #appliedRecord(
    entry: ChangeSetRegistryEntry,
    preview: Preview,
    finalPaths: Extract<ChangeSetRecord, { state: "intent_applied" }>["paths"],
  ): Extract<ChangeSetRecord, { state: "intent_applied" }> {
    return {
      changeSetId: entry.changeSetId,
      state: "intent_applied",
      preview,
      requestedEffects: preview.requestedEffects.map(({ projectedOutcome, ...effect }) => ({
        ...effect,
        outcome: projectedOutcome,
      })),
      derivedEffects: preview.derivedEffects.map(({ projectedOutcome, ...effect }) => ({
        ...effect,
        outcome: projectedOutcome,
      })),
      paths: finalPaths,
    };
  }

  async #updateEntry(
    changeSetId: string,
    update: (entry: ChangeSetRegistryEntry) => void,
  ): Promise<void> {
    await this.#serialize(async () => {
      const nextState = structuredClone(this.#state);
      const entry = nextState.entries.find((candidate) => candidate.changeSetId === changeSetId);
      if (entry === undefined) throw new Error("Change Set registry entry disappeared");
      update(entry);
      await this.#save(nextState);
    });
  }

  async #markUnproven(entry: ChangeSetRegistryEntry): Promise<void> {
    this.#recoveryBlocked = true;
    await this.#updateEntry(entry.changeSetId, (current) => {
      current.changeSet = {
        changeSetId: current.changeSetId,
        state: "result_unproven",
        ...(current.changeSet.state === "in_progress" && current.changeSet.preview !== undefined
          ? { preview: current.changeSet.preview }
          : {}),
      };
      if (current.execution !== undefined) current.execution.phase = "terminal";
    });
    await this.#options.runtimeState?.blockWritesForUnproven(entry.changeSetId);
  }

  async #restorePrepared(
    entry: ChangeSetRegistryEntry,
    frame: RecoveryJournalFrame,
  ): Promise<boolean> {
    const execution = this.#options.execution;
    if (execution === undefined) return false;
    let rolledBackDurable = false;
    try {
      const files = frame.files ?? [];
      const readBinary = execution.readBinary === undefined
        ? undefined
        : (path: string) => execution.readBinary!(path);
      const writeBinary = execution.writeBinary === undefined
        ? undefined
        : (path: string, bytes: Uint8Array) => execution.writeBinary!(path, bytes);
      const removeFile = execution.removeFile === undefined
        ? undefined
        : (path: string) => execution.removeFile!(path);
      if (
        files.length > 0 &&
        (readBinary === undefined || writeBinary === undefined || removeFile === undefined)
      ) throw new Error("file recovery execution is unavailable");
      const fileRestores: Array<{
        footprint: RecoveryFileFootprint;
        before: Uint8Array | null;
        restore: boolean;
      }> = [];
      if (readBinary !== undefined) {
        for (const footprint of files) {
          const currentBytes = await readExecutionBytes(execution, footprint.path);
          const before = fileStateBytes(footprint.before);
          const expectedAfter = fileStateBytes(footprint.expectedAfter);
          const intermediate = footprint.intermediate?.some((state) =>
            sameBytes(currentBytes, fileStateBytes(state))) ?? false;
          if (
            !sameBytes(currentBytes, before) &&
            !sameBytes(currentBytes, expectedAfter) &&
            !intermediate
          ) throw new Error("third-party path state");
          fileRestores.push({
            footprint,
            before,
            restore: !sameBytes(currentBytes, before),
          });
        }
      }
      const directoryRestores: Array<{
        directory: RecoveryJournalFrame["directories"][number];
        remove: boolean;
      }> = [];
      for (const directory of frame.directories) {
        const current = await execution.pathKind(directory.path);
        if (current === null) {
          directoryRestores.push({ directory, remove: false });
          continue;
        }
        if (
          current !== "directory" ||
          directory.identity === undefined ||
          (await execution.directoryIdentity(directory.path)) !== directory.identity
        ) throw new Error("third-party path state");
        directoryRestores.push({ directory, remove: true });
      }

      if (writeBinary !== undefined && removeFile !== undefined) {
        for (const { footprint, before, restore } of [...fileRestores].reverse()) {
          if (!restore) continue;
          if (before === null) await removeFile(footprint.path);
          else await writeBinary(footprint.path, before);
        }
      }
      for (const { directory, remove } of [...directoryRestores].reverse()) {
        if (!remove) {
          if (directory.stageId !== undefined) {
            await execution.discardPreparedDirectory(directory.stageId);
          }
          continue;
        }
        await execution.removeDirectory(directory.path);
      }

      if (readBinary !== undefined) {
        for (const footprint of files) {
          const currentBytes = await readExecutionBytes(execution, footprint.path);
          if (!sameBytes(currentBytes, fileStateBytes(footprint.before))) {
            throw new Error("before state was not restored");
          }
        }
      }
      for (const directory of frame.directories) {
        if ((await execution.pathKind(directory.path)) !== null) {
          throw new Error("before state was not restored");
        }
      }
      await execution.publishSearchSnapshot(frame.rollbackBarrier);
      await execution.persistRecoveryFrame({ ...frame, phase: "ROLLED_BACK" });
      rolledBackDurable = true;
      await this.#updateEntry(entry.changeSetId, (current) => {
        current.changeSet = {
          changeSetId: current.changeSetId,
          state: "intent_not_applied",
          preview: frame.preview,
        };
        if (current.execution !== undefined) current.execution.phase = "terminal";
      });
      return true;
    } catch (error) {
      if (rolledBackDurable) throw error;
      try {
        await execution.persistRecoveryFrame({ ...frame, phase: "FAILED" });
      } finally {
        await this.#markUnproven(entry);
      }
      return false;
    }
  }

  async #recover(): Promise<void> {
    const execution = this.#options.execution;
    if (execution === undefined) return;
    const frame = await execution.loadRecoveryFrame();
    if (frame === null) return;
    const entry = this.#state.entries.find(
      (candidate) => candidate.changeSetId === frame.changeSetId,
    );
    if (entry === undefined) {
      const expired = this.#state.tombstones.some(
        (candidate) => candidate.changeSetId === frame.changeSetId,
      );
      if (expired && frame.phase !== "PREPARED") return;
      throw new Error("Recovery Journal does not match the Change Set registry");
    }
    if (frame.vaultId !== (this.#options.vaultId ?? "vault")) {
      await this.#markUnproven(entry);
      throw new Error("Recovery Journal does not match the Change Set registry");
    }
    if (frame.phase === "PREPARED") {
      if (entry.changeSet.state !== "in_progress") {
        await this.#markUnproven(entry);
        return;
      }
      await this.#restorePrepared(entry, frame);
      return;
    }
    if (frame.phase === "FAILED") {
      await this.#markUnproven(entry);
      return;
    }
    if (frame.phase === "COMMITTED" && entry.changeSet.state === "in_progress") {
      if ((frame.files?.length ?? 0) > 0 && frame.finalPaths === undefined) {
        await this.#markUnproven(entry);
        throw new Error("Committed file Journal evidence is incomplete");
      }
      await this.#updateEntry(entry.changeSetId, (current) => {
        current.changeSet = this.#appliedRecord(
          current,
          frame.preview,
          frame.finalPaths ?? frame.preview.paths.map(({ path, projectedOutcome }) => ({
            path,
            outcome: projectedOutcome,
            finalState: { kind: "directory" },
          })),
        );
        if (current.execution !== undefined) current.execution.phase = "terminal";
      });
      return;
    }
    if (frame.phase === "ROLLED_BACK" && entry.changeSet.state === "in_progress") {
      await this.#updateEntry(entry.changeSetId, (current) => {
        current.changeSet = {
          changeSetId: current.changeSetId,
          state: "intent_not_applied",
          preview: frame.preview,
        };
        if (current.execution !== undefined) current.execution.phase = "terminal";
      });
    }
  }

  async #resumeQueue(): Promise<void> {
    if (this.#options.execution === undefined || this.#recoveryBlocked) return;
    const queued = [...this.#state.entries]
      .filter((entry) => entry.execution?.phase !== "terminal")
      .sort((left, right) => left.enqueueSeq - right.enqueueSeq);
    for (const entry of queued) await this.#executeEntry(entry.changeSetId);
  }

  async #executeEntry(changeSetId: string): Promise<void> {
    const entry = this.#state.entries.find((candidate) => candidate.changeSetId === changeSetId);
    if (entry === undefined) return;
    if (this.#directoryPlan(entry) !== null) {
      await this.#executeDirectory(changeSetId);
      return;
    }
    if (
      entry.execution?.input.operations.length === 1 &&
      entry.execution.input.operations[0]?.kind === "move"
    ) await this.#executeMove(changeSetId);
  }

  async #executeMove(changeSetId: string): Promise<void> {
    const execution = this.#options.execution;
    if (
      execution?.readBinary === undefined ||
      execution.writeBinary === undefined ||
      execution.removeFile === undefined ||
      execution.moveFile === undefined
    ) return;
    const entry = this.#state.entries.find((candidate) => candidate.changeSetId === changeSetId);
    if (entry === undefined) return;
    const head = this.#state.entries
      .filter(({ execution }) => execution !== undefined && execution.phase !== "terminal")
      .sort((left, right) => left.enqueueSeq - right.enqueueSeq)[0];
    if (head?.changeSetId !== entry.changeSetId) return;
    if (
      entry.changeSet.state !== "in_progress" ||
      entry.changeSet.preview === undefined ||
      entry.execution === undefined
    ) return;
    const frozenPreview = entry.changeSet.preview;
    this.#options.runtimeState?.setQueue({
      currentExecutionId: entry.changeSetId,
      length: this.#state.entries.filter(
        ({ execution }) => execution !== undefined && execution.phase !== "terminal",
      ).length,
      headChangeSetId: entry.changeSetId,
    });
    const checked = await preflight(
      this.#options.dataSource,
      entry.execution.input,
      entry.execution.boundMoves,
    );
    if (!checked.accepted || JSON.stringify(checked.preview) !== JSON.stringify(frozenPreview)) {
      await this.#updateEntry(entry.changeSetId, (current) => {
        current.changeSet = {
          changeSetId: current.changeSetId,
          state: "intent_not_applied",
          preview: frozenPreview,
          ...(checked.failure === undefined ? {} : { failure: checked.failure }),
        };
        if (current.execution !== undefined) current.execution.phase = "terminal";
      });
      this.#options.runtimeState?.setQueue({
        currentExecutionId: null,
        length: 0,
        headChangeSetId: null,
      });
      return;
    }
    const plan = await this.#movePlan(entry);
    if (plan === null) {
      await this.#updateEntry(entry.changeSetId, (current) => {
        current.changeSet = {
          changeSetId: current.changeSetId,
          state: "intent_not_applied",
          preview: frozenPreview,
          failure: { code: "stale_observation" },
        };
        if (current.execution !== undefined) current.execution.phase = "terminal";
      });
      this.#options.runtimeState?.setQueue({
        currentExecutionId: null,
        length: 0,
        headChangeSetId: null,
      });
      return;
    }
    const operation = plan.input.operations[0];
    if (operation?.kind !== "move") return;
    const sourceFootprint = plan.files.find(({ path }) => path === operation.sourcePath);
    const destinationFootprint = plan.files.find(({ path }) => path === operation.destinationPath);
    if (sourceFootprint === undefined || destinationFootprint === undefined) return;
    const movedBytes = fileStateBytes(destinationFootprint.expectedAfter);
    const sourceBeforeBytes = fileStateBytes(sourceFootprint.before);
    const boundMove = entry.execution?.boundMoves?.find(
      (candidate) => candidate.operationId === operation.operationId,
    );
    if (movedBytes === null || sourceBeforeBytes === null || boundMove === undefined) return;
    const successBarrier: MoveSnapshotBarrier = {
      presentPath: operation.destinationPath,
      absentPath: operation.sourcePath,
      presentVersion: contentVersion(movedBytes),
      closure: boundMove.derivedEffects
        .filter((effect) => effect.referenceCount !== undefined)
        .map((effect) => ({
          path: effect.path === operation.sourcePath ? operation.destinationPath : effect.path,
          contentVersion: contentVersion(
            effect.path === operation.sourcePath
              ? movedBytes
              : Buffer.from(effect.projectedBytesBase64, "base64"),
          ),
          resolvedPath: operation.destinationPath,
          referenceCount: effect.referenceCount!,
        })),
    };
    const rollbackBarrier: MoveSnapshotBarrier = {
      presentPath: operation.sourcePath,
      absentPath: operation.destinationPath,
      presentVersion: contentVersion(sourceBeforeBytes),
      closure: boundMove.derivedEffects
        .filter((effect) => effect.referenceCount !== undefined)
        .map((effect) => {
          const footprint = plan.files.find(({ path }) => path === effect.path);
          const bytes = footprint === undefined ? null : fileStateBytes(footprint.before);
          if (bytes === null) throw new Error("Rollback closure bytes are incomplete");
          return {
            path: effect.path,
            contentVersion: contentVersion(bytes),
            resolvedPath: operation.sourcePath,
            referenceCount: effect.referenceCount!,
          };
        }),
    };
    let frame: RecoveryJournalFrame = {
      schemaVersion: 1,
      vaultId: this.#options.vaultId ?? "vault",
      changeSetId: entry.changeSetId,
      enqueueSeq: entry.enqueueSeq,
      phase: "PREPARED",
      input: structuredClone(plan.input),
      preview: plan.preview,
      directories: plan.directories.map((path, index) => ({
        path,
        before: "absent",
        expectedAfter: "directory",
        stageId: `${entry.changeSetId}/move-directory/${index}`,
      })),
      files: plan.files,
      successBarrier,
      rollbackBarrier,
    };
    await this.#crash("before_prepared");
    await execution.persistRecoveryFrame(frame);
    for (const footprint of plan.files) {
      const currentBytes = await readExecutionBytes(execution, footprint.path);
      if (!sameBytes(currentBytes, fileStateBytes(footprint.before))) {
        await this.#restorePrepared(entry, frame);
        return;
      }
    }
    for (const directory of plan.directories) {
      if ((await execution.pathKind(directory)) !== null) {
        await this.#restorePrepared(entry, frame);
        return;
      }
    }
    let committedDurable = false;
    try {
      await this.#updateEntry(entry.changeSetId, (current) => {
        if (current.execution !== undefined) current.execution.phase = "executing";
      });
      await this.#crash("after_prepared");
      let mutationIndex = 0;
      for (const directory of plan.directories) {
        const stageId = frame.directories.find((candidate) => candidate.path === directory)?.stageId;
        if (stageId === undefined) throw new Error("Directory staging identity is missing");
        const identity = await execution.prepareDirectory(stageId);
        frame = {
          ...frame,
          directories: frame.directories.map((candidate) =>
            candidate.path === directory ? { ...candidate, identity } : candidate),
        };
        await execution.persistRecoveryFrame(frame);
        await execution.publishDirectory(stageId, directory);
        await this.#crash(`after_mutation:${mutationIndex++}`);
      }
      for (const footprint of plan.files) {
        if (footprint.path === operation.sourcePath || footprint.path === operation.destinationPath) {
          continue;
        }
        const bytes = fileStateBytes(footprint.expectedAfter);
        const before = fileStateBytes(footprint.before);
        if (sameBytes(before, bytes)) continue;
        if (bytes === null) await execution.removeFile(footprint.path);
        else await execution.writeBinary(footprint.path, bytes);
        await this.#crash(`after_mutation:${mutationIndex++}`);
      }
      const sourceBefore = fileStateBytes(sourceFootprint.before);
      if (!sameBytes(sourceBefore, movedBytes)) {
        await execution.writeBinary(operation.sourcePath, movedBytes);
        await this.#crash(`after_mutation:${mutationIndex++}`);
      }
      await execution.moveFile(operation.sourcePath, operation.destinationPath);
      await this.#crash(`after_mutation:${mutationIndex++}`);
      for (const footprint of plan.files) {
        const currentBytes = await readExecutionBytes(execution, footprint.path);
        if (!sameBytes(currentBytes, fileStateBytes(footprint.expectedAfter))) {
          throw new Error("Final file evidence did not match");
        }
      }
      for (const directory of plan.directories) {
        if ((await execution.pathKind(directory)) !== "directory") {
          throw new Error("Final directory evidence did not match");
        }
      }
      await this.#crash("after_raw_verification");
      await execution.publishSearchSnapshot(frame.successBarrier);
      for (const footprint of plan.files) {
        const currentBytes = await readExecutionBytes(execution, footprint.path);
        if (!sameBytes(currentBytes, fileStateBytes(footprint.expectedAfter))) {
          throw new Error("Final file evidence changed during the success barrier");
        }
      }
      for (const directory of plan.directories) {
        if ((await execution.pathKind(directory)) !== "directory") {
          throw new Error("Final directory evidence changed during the success barrier");
        }
      }
      const finalPaths = plan.preview.paths.map(({ path, projectedFinalState, projectedOutcome }) => ({
        path,
        outcome: projectedOutcome,
        finalState: projectedFinalState,
      }));
      await this.#crash("after_snapshot");
      await execution.persistRecoveryFrame({ ...frame, phase: "COMMITTED", finalPaths });
      committedDurable = true;
      await this.#crash("after_committed");
      await this.#updateEntry(entry.changeSetId, (current) => {
        current.changeSet = this.#appliedRecord(current, plan.preview, finalPaths);
        if (current.execution !== undefined) current.execution.phase = "terminal";
      });
    } catch (error) {
      if (error instanceof InjectedChangeSetCrash || committedDurable) throw error;
      await this.#restorePrepared(entry, frame);
    } finally {
      this.#options.runtimeState?.setQueue({
        currentExecutionId: null,
        length: 0,
        headChangeSetId: null,
      });
    }
  }

  async #executeDirectory(changeSetId: string): Promise<void> {
    const execution = this.#options.execution;
    if (execution === undefined) return;
    const entry = this.#state.entries.find((candidate) => candidate.changeSetId === changeSetId);
    if (entry === undefined) return;
    const head = this.#state.entries
      .filter(
        ({ execution }) => execution !== undefined && execution.phase !== "terminal",
      )
      .sort((left, right) => left.enqueueSeq - right.enqueueSeq)[0];
    if (head?.changeSetId !== entry.changeSetId) return;
    const plan = this.#directoryPlan(entry);
    if (plan === null) return;
    this.#options.runtimeState?.setQueue({
      currentExecutionId: entry.changeSetId,
      length: this.#state.entries.filter(
        ({ execution }) => execution !== undefined && execution.phase !== "terminal",
      ).length,
      headChangeSetId: entry.changeSetId,
    });
    const checked = await preflight(this.#options.dataSource, plan.input);
    if (!checked.accepted || JSON.stringify(checked.preview) !== JSON.stringify(plan.preview)) {
      await this.#updateEntry(entry.changeSetId, (current) => {
        current.changeSet = {
          changeSetId: current.changeSetId,
          state: "intent_not_applied",
          preview: plan.preview,
          ...(checked.failure === undefined ? {} : { failure: checked.failure }),
        };
        if (current.execution !== undefined) current.execution.phase = "terminal";
      });
      this.#options.runtimeState?.setQueue({
        currentExecutionId: null,
        length: 0,
        headChangeSetId: null,
      });
      return;
    }
    let frame: RecoveryJournalFrame = {
      schemaVersion: 1,
      vaultId: this.#options.vaultId ?? "vault",
      changeSetId: entry.changeSetId,
      enqueueSeq: entry.enqueueSeq,
      phase: "PREPARED",
      input: structuredClone(plan.input),
      preview: plan.preview,
      directories: plan.directories.map((path, index) => ({
        path,
        before: "absent",
        expectedAfter: "directory",
        stageId: `${entry.changeSetId}/${index}`,
      })),
    };
    await this.#crash("before_prepared");
    await execution.persistRecoveryFrame(frame);
    let committedDurable = false;
    try {
      await this.#updateEntry(entry.changeSetId, (current) => {
        if (current.execution !== undefined) current.execution.phase = "executing";
      });
      await this.#crash("after_prepared");
      for (const [index, directory] of plan.directories.entries()) {
        const stageId = frame.directories.find(
          (candidate) => candidate.path === directory,
        )?.stageId;
        if (stageId === undefined) throw new Error("Directory staging identity is missing");
        const identity = await execution.prepareDirectory(stageId);
        frame = {
          ...frame,
          directories: frame.directories.map((candidate) =>
            candidate.path === directory
              ? { ...candidate, identity, stageId }
              : candidate,
          ),
        };
        await execution.persistRecoveryFrame(frame);
        await execution.publishDirectory(stageId, directory);
        await this.#crash(`after_mutation:${index}`);
      }
      for (const directory of plan.directories) {
        if ((await execution.pathKind(directory)) !== "directory") {
          throw new Error("Final directory evidence did not match");
        }
      }
      await this.#crash("after_raw_verification");
      await execution.publishSearchSnapshot();
      const finalPaths: Extract<ChangeSetRecord, { state: "intent_applied" }>["paths"] = [];
      for (const path of plan.preview.paths.map(({ path }) => path)) {
        if ((await execution.pathKind(path)) !== "directory") {
          throw new Error("Final directory evidence changed during the success barrier");
        }
        const projected = plan.preview.paths.find((candidate) => candidate.path === path);
        if (projected === undefined) throw new Error("Final path evidence is incomplete");
        finalPaths.push({
          path,
          outcome: projected.projectedOutcome,
          finalState: { kind: "directory" },
        });
      }
      await this.#crash("after_snapshot");
      await execution.persistRecoveryFrame({
        ...frame,
        phase: "COMMITTED",
        finalPaths,
      });
      committedDurable = true;
      await this.#crash("after_committed");
      await this.#updateEntry(entry.changeSetId, (current) => {
        current.changeSet = this.#appliedRecord(current, plan.preview, finalPaths);
        if (current.execution !== undefined) current.execution.phase = "terminal";
      });
    } catch (error) {
      if (error instanceof InjectedChangeSetCrash || committedDurable) throw error;
      await this.#restorePrepared(entry, frame);
    } finally {
      this.#options.runtimeState?.setQueue({
        currentExecutionId: null,
        length: 0,
        headChangeSetId: null,
      });
    }
  }

  async #withWriteLease<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.#writeTail;
    let release!: () => void;
    this.#writeTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  async #serialize<T>(operation: () => T | Promise<T>): Promise<T> {
    const previous = this.#operationTail;
    let release!: () => void;
    this.#operationTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  async #save(nextState: ChangeSetRegistryState): Promise<void> {
    await this.#options.store.save(nextState);
    this.#state = nextState;
  }

  async #expireRecords(): Promise<void> {
    const now = this.#options.now();
    const expired = this.#state.entries.filter((entry) => entry.expiresAt <= now);
    if (expired.length === 0) return;
    const existingKeys = new Set(this.#state.tombstones.map(({ submissionKey }) => submissionKey));
    const nextState = structuredClone(this.#state);
    nextState.entries = nextState.entries.filter((entry) => entry.expiresAt > now);
    for (const entry of expired) {
      if (!existingKeys.has(entry.submissionKey)) {
        nextState.tombstones.push({
          submissionKey: entry.submissionKey,
          changeSetId: entry.changeSetId,
        });
      }
    }
    await this.#save(nextState);
  }

  async submit(
    input: ChangeSetSubmitInput,
    requestState: ChangeSetRequestState,
  ): Promise<ChangeSetSubmitResult> {
    const registered = await this.#serialize(() =>
      this.#submitUnlocked(input, requestState),
    );
    if (
      registered.outcome !== "registered" ||
      registered.changeSet.state !== "in_progress" ||
      this.#options.execution === undefined
    ) {
      return registered;
    }
    await this.#withWriteLease(async () => {
      await this.#recover();
      if (!this.#recoveryBlocked) {
        await this.#executeEntry(registered.changeSet.changeSetId);
      }
    });
    return this.#serialize(() => {
      const current = this.#state.entries.find(
        ({ submissionKey }) => submissionKey === input.submissionKey,
      );
      return parseChangeSetSubmitResult({
        outcome: "registered",
        changeSet: current?.changeSet ?? registered.changeSet,
        vault: requestState.vault,
        ...(current?.historicalGate === undefined
          ? {}
          : { gate: current.historicalGate }),
      });
    });
  }

  async #submitUnlocked(
    input: ChangeSetSubmitInput,
    requestState: ChangeSetRequestState,
  ): Promise<ChangeSetSubmitResult> {
    if (requestState.effectiveGate?.code === "incompatible_protocol") {
      return parseChangeSetSubmitResult({
        outcome: "operationally_blocked",
        gate: requestState.effectiveGate,
      });
    }
    await this.#expireRecords();
    const fingerprint = fingerprintChangeSetRequest(input);
    const existing = this.#state.entries.find(
      ({ submissionKey }) => submissionKey === input.submissionKey,
    );
    if (existing !== undefined) {
      if (existing.fingerprint !== fingerprint) {
        return parseChangeSetSubmitResult({ outcome: "submission_key_conflict" });
      }
      return parseChangeSetSubmitResult({
        outcome: "registered",
        changeSet: existing.changeSet,
        vault: requestState.vault,
        ...(existing.historicalGate === undefined
          ? {}
          : { gate: existing.historicalGate }),
      });
    }
    if (
      this.#state.tombstones.some(
        ({ submissionKey }) => submissionKey === input.submissionKey,
      )
    ) {
      return parseChangeSetSubmitResult({ outcome: "submission_key_conflict" });
    }

    const gate = requestState.effectiveGate;
    if (
      gate !== null &&
      ["writes_paused", "upgrade_in_progress", "recovery_in_progress"].includes(
        gate.code,
      )
    ) {
      return parseChangeSetSubmitResult({ outcome: "operationally_blocked", gate });
    }

    const changeSetId = this.#options.createChangeSetId();
    let changeSet: ChangeSetRecord;
    let historicalGate: ChangeSetGate | undefined;
    let boundMoves: BoundMoveProjection[] | undefined;
    if (gate?.code === "recovery_blocked") {
      changeSet = { changeSetId, state: "intent_not_applied" };
      historicalGate = gate;
    } else {
      const checked = await preflight(this.#options.dataSource, input);
      boundMoves = checked.boundMoves;
      changeSet = checked.accepted
        ? { changeSetId, state: "in_progress", preview: checked.preview }
        : {
            changeSetId,
            state: "intent_not_applied",
            ...(checked.preview === undefined ? {} : { preview: checked.preview }),
            ...(checked.failure === undefined ? {} : { failure: checked.failure }),
          };
    }

    const acceptedAt = this.#options.now();
    const nextState = structuredClone(this.#state);
    const entry: ChangeSetRegistryEntry = {
      submissionKey: input.submissionKey,
      fingerprint,
      changeSetId,
      enqueueSeq: nextState.nextEnqueueSeq,
      acceptedAt,
      expiresAt: acceptedAt + CHANGE_SET_RECORD_RETENTION_MS,
      ...(historicalGate === undefined ? {} : { historicalGate }),
      ...(changeSet.state === "in_progress" &&
      changeSet.preview !== undefined &&
      (
        input.operations.every(({ kind }) => kind === "create_directory") ||
        (
          input.operations.length === 1 &&
          input.operations[0]?.kind === "move" &&
          boundMoves?.length === 1
        )
      )
        ? {
            execution: {
              phase: "queued" as const,
              input: structuredClone(input),
              ...(boundMoves === undefined ? {} : { boundMoves }),
            },
          }
        : {}),
      changeSet,
    };
    nextState.nextEnqueueSeq += 1;
    nextState.entries.push(entry);
    await this.#save(nextState);
    return parseChangeSetSubmitResult({
      outcome: "registered",
      changeSet,
      vault: requestState.vault,
      ...(historicalGate === undefined ? {} : { gate: historicalGate }),
    });
  }

  async status(
    input: ChangeSetStatusInput,
    requestState: ChangeSetRequestState,
  ): Promise<ChangeSetStatusResult> {
    return this.#serialize(() => this.#statusUnlocked(input, requestState));
  }

  async #statusUnlocked(
    input: ChangeSetStatusInput,
    requestState: ChangeSetRequestState,
  ): Promise<ChangeSetStatusResult> {
    if (requestState.effectiveGate?.code === "incompatible_protocol") {
      return parseChangeSetStatusResult({
        lookup: "operationally_blocked",
        gate: requestState.effectiveGate,
      });
    }
    await this.#expireRecords();
    const matches = (record: ChangeSetRegistryEntry | ChangeSetRegistryTombstone) =>
      "submissionKey" in input
        ? record.submissionKey === input.submissionKey
        : record.changeSetId === input.changeSetId;
    const entry = this.#state.entries.find(matches);
    if (entry !== undefined) {
      return parseChangeSetStatusResult({
        lookup: "found",
        changeSet: entry.changeSet,
        vault: requestState.vault,
      });
    }
    return parseChangeSetStatusResult({
      lookup: this.#state.tombstones.some(matches) ? "expired" : "unknown",
      vault: requestState.vault,
    });
  }
}
