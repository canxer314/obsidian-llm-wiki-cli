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
export const CHANGE_SET_REGISTRY_SCHEMA_VERSION = 2;
const LEGACY_CHANGE_SET_REGISTRY_SCHEMA_VERSION = 1;
export const RECOVERY_JOURNAL_FRAME_SCHEMA_VERSION = 2;

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

export type ChangeSetWriteMode =
  | "manual_paused"
  | "maintenance_pending"
  | "maintenance_paused"
  | "maintenance_failed";

export interface PersistedChangeSetLifecycle {
  upgrade: "succeeded" | "failed";
  migration: "succeeded" | "failed";
}

export interface ChangeSetRegistryState {
  schemaVersion:
    | typeof LEGACY_CHANGE_SET_REGISTRY_SCHEMA_VERSION
    | typeof CHANGE_SET_REGISTRY_SCHEMA_VERSION;
  nextEnqueueSeq: number;
  entries: ChangeSetRegistryEntry[];
  tombstones: ChangeSetRegistryTombstone[];
  writeMode?: ChangeSetWriteMode;
  lifecycle?: PersistedChangeSetLifecycle;
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

export type RecoveryFileState =
  | { kind: "absent" }
  | {
      kind: "markdown";
      contentVersion: string;
      bytesBase64: string;
    }
  | {
      kind: "attachment";
      sha256: string;
      bytesBase64: string;
    };

export interface RecoveryFileFootprint {
  path: string;
  before: RecoveryFileState;
  expectedAfter: RecoveryFileState;
  /** Inode-level identity of the pre-state file (Markdown durable evidence). */
  beforeIdentity?: string;
  /** Inode-level identity captured right after staging (Markdown durable evidence). */
  identity?: string;
  stageId?: string;
  trashId?: string;
}

export type RecoveryMutation =
  | {
      kind: "copy_attachment";
      operationId: string;
      sourcePath: string;
      sourceState: RecoveryFileState;
      destinationPath: string;
      destinationBefore: RecoveryFileState;
      destinationAfter: RecoveryFileState;
      stageId: string;
    }
  | {
      kind: "move_attachment";
      operationId: string;
      sourcePath: string;
      sourceBefore: RecoveryFileState;
      sourceAfter: RecoveryFileState;
      destinationPath: string;
      destinationBefore: RecoveryFileState;
      destinationAfter: RecoveryFileState;
    }
  | {
      // Markdown note move: the rename itself plus the evidence needed to
      // restore the source content when the move rewrote self-references.
      kind: "move";
      operationId: string;
      sourcePath: string;
      sourceBefore: RecoveryFileState;
      sourceAfter: RecoveryFileState;
      destinationPath: string;
      destinationBefore: RecoveryFileState;
      destinationAfter: RecoveryFileState;
      stageId: string;
    }
  | {
      kind: "trash";
      operationId: string;
      path: string;
      before: RecoveryFileState;
      expectedAfter: RecoveryFileState;
      trashId: string;
    };

export interface RecoveryJournalFrame {
  schemaVersion: 1 | typeof RECOVERY_JOURNAL_FRAME_SCHEMA_VERSION;
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
  mutations?: readonly RecoveryMutation[];
  successBarrier?: MoveSnapshotBarrier;
  rollbackBarrier?: MoveSnapshotBarrier;
  finalPaths?: Extract<ChangeSetRecord, { state: "intent_applied" }>["paths"];
}

/**
 * Success-barrier evidence for a note move: after the mutation the successor
 * Search Snapshot must show `presentPath` at `presentVersion`, must not show
 * `absentPath`, and every closure note must resolve its references to
 * `resolvedPath` exactly `referenceCount` times (issue #38).
 */
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

export type ChangeSetSemanticEvent =
  | { readonly kind: "create" | "delete"; readonly path: string }
  | { readonly kind: "rename"; readonly oldPath: string; readonly path: string };

export interface ChangeSetSemanticEvidenceRequest {
  readonly mode: "apply" | "restore";
  readonly operations: readonly ChangeSetOperation[];
  readonly publicPaths: readonly string[];
  readonly hiddenTrash: boolean;
  readonly requiredEvents: readonly ChangeSetSemanticEvent[];
}

export interface SearchSnapshotTargetEvidence {
  path: string;
  contentVersion: string;
  /** true: a create/edit must observe metadata for this exact version. */
  requireSemanticMatch: boolean;
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
  beginSemanticEvidence?(request: ChangeSetSemanticEvidenceRequest): Promise<void>;
  awaitSemanticEvidence?(request: ChangeSetSemanticEvidenceRequest): Promise<void>;
  readonly semanticEvidencePublishesSnapshot?: boolean;
  publishSearchSnapshot(
    targets?: readonly SearchSnapshotTargetEvidence[],
    moveBarrier?: MoveSnapshotBarrier,
  ): Promise<void>;
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

function gateForWriteMode(mode: ChangeSetWriteMode | undefined): ChangeSetGate | null {
  if (mode === undefined) return null;
  return {
    code:
      mode === "maintenance_pending" || mode === "maintenance_failed"
        ? "upgrade_in_progress"
        : "writes_paused",
  };
}

export interface ChangeSetPauseObserver {
  started(): void;
  completed(): void;
}

export interface ChangeSetMaintenanceObserver {
  started(): void;
  failed(): void;
  completed(): void;
}

export interface ChangeSetRequestState {
  vault: VaultState;
  effectiveGate: ChangeSetGate | null;
}

const OPERATIONAL_GATE_PRECEDENCE: readonly ChangeSetGate["code"][] = [
  "incompatible_protocol",
  "recovery_blocked",
  "recovery_in_progress",
  "upgrade_in_progress",
  "writes_paused",
];

function selectOperationalGate(
  ...gates: readonly (ChangeSetGate | null)[]
): ChangeSetGate | null {
  const code = OPERATIONAL_GATE_PRECEDENCE.find((candidate) =>
    gates.some((gate) => gate?.code === candidate),
  );
  return code === undefined ? null : { code };
}

const utf8Decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const utf8Encoder = new TextEncoder();

/**
 * Name of the Bridge-private state directory inside the Vault. main.ts places
 * staging, the Recovery Journal, and managed trash under this directory, and
 * the protected-roots check below rejects any Change Set path targeting it.
 * Keep a single source of truth so the two can never drift apart.
 */
export const BRIDGE_STATE_DIRECTORY_NAME = ".llm-wiki";

const protectedRoots = [".git", ".obsidian", BRIDGE_STATE_DIRECTORY_NAME, ".trash"];

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
  const isLegacy = state.schemaVersion === LEGACY_CHANGE_SET_REGISTRY_SCHEMA_VERSION;
  if (
    (!isLegacy && state.schemaVersion !== CHANGE_SET_REGISTRY_SCHEMA_VERSION) ||
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
  const writeMode = state.writeMode;
  if (
    (isLegacy && writeMode !== undefined) ||
    (writeMode !== undefined &&
      ![
        "manual_paused",
        "maintenance_pending",
        "maintenance_paused",
        "maintenance_failed",
      ].includes(writeMode))
  ) {
    throw new Error("Change Set registry is corrupt or incompatible");
  }
  const lifecycle = state.lifecycle;
  if (
    (isLegacy && lifecycle !== undefined) ||
    (lifecycle !== undefined &&
      (typeof lifecycle !== "object" ||
        lifecycle === null ||
        !["succeeded", "failed"].includes(lifecycle.upgrade) ||
        !["succeeded", "failed"].includes(lifecycle.migration)))
  ) {
    throw new Error("Change Set registry is corrupt or incompatible");
  }
  return {
    schemaVersion: CHANGE_SET_REGISTRY_SCHEMA_VERSION,
    nextEnqueueSeq: state.nextEnqueueSeq!,
    entries,
    tombstones,
    ...(writeMode === undefined ? {} : { writeMode }),
    ...(lifecycle === undefined ? {} : { lifecycle }),
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

function recoveryFileState(
  state: Preview["paths"][number]["preState"],
  bytes: Uint8Array | null | undefined,
): RecoveryFileState {
  if (state.kind === "absent") return { kind: "absent" };
  if (state.kind === "directory" || bytes === null || bytes === undefined) {
    throw new Error("Recovery file evidence is incomplete");
  }
  const bytesBase64 = Buffer.from(bytes).toString("base64");
  return state.kind === "attachment"
    ? { kind: "attachment", sha256: state.sha256, bytesBase64 }
    : { kind: "markdown", contentVersion: state.contentVersion, bytesBase64 };
}

function recoveryBytes(state: RecoveryFileState): Uint8Array | null {
  return state.kind === "absent" ? null : Buffer.from(state.bytesBase64, "base64");
}

function bytesMatchState(bytes: Uint8Array | null, state: RecoveryFileState): boolean {
  if (state.kind === "absent") return bytes === null;
  if (bytes === null) return false;
  return state.kind === "attachment"
    ? attachmentHash(bytes) === state.sha256
    : contentVersion(bytes) === state.contentVersion;
}

async function executionPathMatches(
  execution: ChangeSetExecutionAdapter,
  path: string,
  state: RecoveryFileState,
): Promise<boolean> {
  const kind = await execution.pathKind(path);
  if (state.kind === "absent") return kind === null;
  if (kind !== "file") return false;
  return bytesMatchState(await readExecutionBytes(execution, path), state);
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

function findSubarray(haystack: Uint8Array, needle: Uint8Array, fromIndex = 0): number {
  if (needle.length === 0) return fromIndex <= haystack.length ? fromIndex : -1;
  outer: for (let index = fromIndex; index <= haystack.length - needle.length; index += 1) {
    for (let offset = 0; offset < needle.length; offset += 1) {
      if (haystack[index + offset] !== needle[offset]) continue outer;
    }
    return index;
  }
  return -1;
}

function findOccurrences(
  content: Uint8Array,
  old: Uint8Array,
): { count: number; firstIndex: number } {
  if (old.length === 0) return { count: content.length + 1, firstIndex: 0 };
  let count = 0;
  let firstIndex = -1;
  let index = 0;
  while ((index = findSubarray(content, old, index)) !== -1) {
    if (firstIndex === -1) firstIndex = index;
    count += 1;
    index += 1;
  }
  return { count, firstIndex };
}

type BodyEditProjection =
  | { outcome: "projected"; bytes: Uint8Array }
  | { outcome: "invalid_utf8" }
  | { outcome: "exact_match_count_mismatch"; actualOccurrences: number };

function projectBodyBytes(
  bytes: Uint8Array,
  edit: Extract<ChangeSetOperation, { kind: "edit_body" }>["edit"],
): BodyEditProjection {
  try {
    utf8Decoder.decode(bytes);
  } catch {
    return { outcome: "invalid_utf8" };
  }
  const hasBom = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  const payload = bytes.subarray(hasBom ? 3 : 0);
  if (edit.kind === "replace_whole") {
    const replacement = utf8Encoder.encode(edit.replacement);
    return {
      outcome: "projected",
      bytes: Uint8Array.from(
        Buffer.concat([bytes.subarray(0, hasBom ? 3 : 0), replacement]),
      ),
    };
  }
  const old = utf8Encoder.encode(edit.old);
  const occurrences = findOccurrences(payload, old);
  if (occurrences.count !== 1) {
    return {
      outcome: "exact_match_count_mismatch",
      actualOccurrences: occurrences.count,
    };
  }
  const replacement = utf8Encoder.encode(edit.replacement);
  return {
    outcome: "projected",
    bytes: Uint8Array.from(
      Buffer.concat([
        bytes.subarray(0, (hasBom ? 3 : 0) + occurrences.firstIndex),
        replacement,
        payload.subarray(occurrences.firstIndex + old.length),
      ]),
    ),
  };
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
  observedBytes?: ReadonlyMap<string, Uint8Array | null>;
  projectedBytes?: ReadonlyMap<string, Uint8Array | null>;
  boundMoves?: BoundMoveProjection[];
}

function recoveryStatesEqual(
  left: RecoveryFileState | undefined,
  right: RecoveryFileState | undefined,
): boolean {
  return (
    left !== undefined &&
    right !== undefined &&
    JSON.stringify(canonicalize(left)) === JSON.stringify(canonicalize(right))
  );
}

function recoveryPublicState(
  state: RecoveryFileState,
): Preview["paths"][number]["preState"] {
  if (state.kind === "absent") return state;
  return state.kind === "attachment"
    ? { kind: state.kind, sha256: state.sha256 }
    : { kind: state.kind, contentVersion: state.contentVersion };
}

function recoveryPlanMatchesFrame(frame: RecoveryJournalFrame): boolean {
  const expectedDirectories = frame.preview.paths
    .filter(
      ({ preState, projectedFinalState }) =>
        preState.kind === "absent" && projectedFinalState.kind === "directory",
    )
    .map(({ path }) => path)
    .sort((left, right) => {
      const depth = left.split("/").length - right.split("/").length;
      return depth || compareCodeUnits(left, right);
    });
  if (
    JSON.stringify(frame.directories.map(({ path }) => path)) !==
    JSON.stringify(expectedDirectories)
  ) return false;

  const expectedFiles = frame.preview.paths.filter(
    ({ preState, projectedFinalState }) =>
      preState.kind !== "directory" && projectedFinalState.kind !== "directory",
  );
  const files = frame.files ?? [];
  if (files.length !== expectedFiles.length) return false;
  for (const [index, expected] of expectedFiles.entries()) {
    const file = files[index];
    if (
      file === undefined ||
      file.path !== expected.path ||
      JSON.stringify(canonicalize(recoveryPublicState(file.before))) !==
        JSON.stringify(canonicalize(expected.preState)) ||
      JSON.stringify(canonicalize(recoveryPublicState(file.expectedAfter))) !==
        JSON.stringify(canonicalize(expected.projectedFinalState))
    ) return false;
  }

  const states = new Map(files.map(({ path, before }) => [path, before]));
  const mutations = frame.mutations ?? [];
  let mutationIndex = 0;
  for (const [operationIndex, operation] of frame.input.operations.entries()) {
    if (operation.kind === "create_directory") continue;
    if (operation.kind === "create_note" || operation.kind === "edit_body") {
      // Markdown mutations are journaled as file footprints, not RecoveryMutations.
      const footprint = files.find(({ path }) => path === operation.path);
      if (footprint === undefined) return false;
      states.set(operation.path, footprint.expectedAfter);
      continue;
    }
    if (operation.kind === "move") {
      // A note move journals the rename as a RecoveryMutation and its
      // reference rewrites as ordinary Markdown file footprints.
      const mutation = mutations[mutationIndex++];
      const source = states.get(operation.sourcePath);
      const destination = states.get(operation.destinationPath);
      const absent = { kind: "absent" } as const;
      if (
        mutation === undefined ||
        mutation.operationId !== operation.operationId ||
        mutation.kind !== "move" ||
        mutation.sourcePath !== operation.sourcePath ||
        mutation.destinationPath !== operation.destinationPath ||
        mutation.stageId !== `${frame.changeSetId}/move/${operationIndex}` ||
        source?.kind !== "markdown" ||
        source.contentVersion !== operation.targetVersion ||
        !recoveryStatesEqual(mutation.sourceBefore, source) ||
        !recoveryStatesEqual(mutation.sourceAfter, absent) ||
        !recoveryStatesEqual(mutation.destinationBefore, destination) ||
        mutation.destinationAfter.kind !== "markdown" ||
        frame.successBarrier === undefined ||
        frame.rollbackBarrier === undefined ||
        frame.successBarrier.presentPath !== operation.destinationPath ||
        frame.successBarrier.absentPath !== operation.sourcePath ||
        frame.rollbackBarrier.presentPath !== operation.sourcePath ||
        frame.rollbackBarrier.absentPath !== operation.destinationPath
      ) return false;
      states.set(operation.sourcePath, absent);
      states.set(operation.destinationPath, mutation.destinationAfter);
      for (const file of files) {
        if (
          file.path === operation.sourcePath ||
          file.path === operation.destinationPath
        ) continue;
        states.set(file.path, file.expectedAfter);
      }
      continue;
    }
    const mutation = mutations[mutationIndex++];
    if (mutation === undefined || mutation.operationId !== operation.operationId) return false;
    if (operation.kind === "copy_attachment") {
      const source = states.get(operation.sourcePath);
      const destination = states.get(operation.destinationPath);
      if (
        mutation.kind !== operation.kind ||
        mutation.sourcePath !== operation.sourcePath ||
        mutation.destinationPath !== operation.destinationPath ||
        mutation.stageId !== `${frame.changeSetId}/attachment/${operationIndex}` ||
        source?.kind !== "attachment" ||
        source.sha256 !== operation.expectedSha256 ||
        !recoveryStatesEqual(mutation.sourceState, source) ||
        !recoveryStatesEqual(mutation.destinationBefore, destination) ||
        !recoveryStatesEqual(mutation.destinationAfter, source)
      ) return false;
      states.set(operation.destinationPath, source);
      continue;
    }
    if (operation.kind === "move_attachment") {
      const source = states.get(operation.sourcePath);
      const destination = states.get(operation.destinationPath);
      const absent = { kind: "absent" } as const;
      if (
        mutation.kind !== operation.kind ||
        mutation.sourcePath !== operation.sourcePath ||
        mutation.destinationPath !== operation.destinationPath ||
        source?.kind !== "attachment" ||
        source.sha256 !== operation.expectedSha256 ||
        !recoveryStatesEqual(mutation.sourceBefore, source) ||
        !recoveryStatesEqual(mutation.sourceAfter, absent) ||
        !recoveryStatesEqual(mutation.destinationBefore, destination) ||
        !recoveryStatesEqual(mutation.destinationAfter, source)
      ) return false;
      states.set(operation.sourcePath, absent);
      states.set(operation.destinationPath, source);
      continue;
    }
    if (operation.kind === "trash") {
      const before = states.get(operation.path);
      const absent = { kind: "absent" } as const;
      const evidenceMatches = before !== undefined && before.kind !== "absent" && (
        "targetVersion" in operation
          ? before.kind === "markdown" && before.contentVersion === operation.targetVersion
          : before.kind === "attachment" && before.sha256 === operation.expectedSha256
      );
      if (
        mutation.kind !== operation.kind ||
        mutation.path !== operation.path ||
        mutation.trashId !== `${frame.changeSetId}/${operationIndex}` ||
        !evidenceMatches ||
        !recoveryStatesEqual(mutation.before, before) ||
        !recoveryStatesEqual(mutation.expectedAfter, absent)
      ) return false;
      states.set(operation.path, absent);
      continue;
    }
    return false;
  }
  if (mutationIndex !== mutations.length) return false;
  return files.every(({ path, expectedAfter }) =>
    recoveryStatesEqual(states.get(path), expectedAfter));
}

async function readBinary(
  source: { readBinary(path: string): Promise<ArrayBuffer | Uint8Array | null> },
  path: string,
): Promise<Uint8Array | null> {
  const value = await source.readBinary(path);
  if (value === null) return null;
  return Uint8Array.from(value instanceof Uint8Array ? value : new Uint8Array(value));
}

async function readBytes(
  dataSource: ChangeSetPreflightDataSource,
  path: string,
): Promise<Uint8Array | null> {
  return readBinary(dataSource, path);
}

async function readExecutionBytes(
  execution: ChangeSetExecutionAdapter,
  path: string,
): Promise<Uint8Array | null> {
  if (execution.readBinary === undefined) return null;
  return readBinary(execution as Required<Pick<ChangeSetExecutionAdapter, "readBinary">>, path);
}

async function preflight(
  dataSource: ChangeSetPreflightDataSource,
  input: ChangeSetSubmitInput,
  boundMoves: readonly BoundMoveProjection[] = [],
): Promise<PreflightResult> {
  const nextBoundMoves: BoundMoveProjection[] = [];  for (const operation of input.operations) {
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
  const observedBytes = new Map<string, Uint8Array | null>();
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
    const bytes = await readBytes(dataSource, path);
    if (!observedBytes.has(path)) observedBytes.set(path, bytes);
    return bytes;
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
      operation.kind === "edit_frontmatter"
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
        const projected = projectBodyBytes(bytes, operation.edit);
        if (projected.outcome === "invalid_utf8") {
          return { accepted: false, failure: { code: "stale_observation" } };
        }
        if (projected.outcome === "exact_match_count_mismatch") {
          return {
            accepted: false,
            failure: {
              code: "exact_match_count_mismatch",
              operationId: operation.operationId,
              actualOccurrences: projected.actualOccurrences,
            },
          };
        }
        const finalBytes = projected.bytes;
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
      }
    } else if (operation.kind === "trash") {
      const bytes = await currentBytes(operation.path);
      if (bytes === null) {
        return { accepted: false, failure: { code: "stale_observation" } };
      }
      const currentState = "targetVersion" in operation
        ? ({ kind: "markdown" as const, contentVersion: operation.targetVersion })
        : ({ kind: "attachment" as const, sha256: operation.expectedSha256 });
      const evidenceMatches = "targetVersion" in operation
        ? contentVersion(bytes) === operation.targetVersion
        : attachmentHash(bytes) === operation.expectedSha256;
      if (!evidenceMatches) {
        return { accepted: false, failure: { code: "stale_observation" } };
      }
      projectPath(operation.path, currentState, { kind: "absent" });
      projectedBytes.set(operation.path, null);
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
        // The projection bound at submission is authoritative: recompute it
        // and reject the whole Change Set when the Vault drifted (issue #38
        // AC6), rather than silently executing a stale reference closure.
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
    observedBytes,
    projectedBytes,
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
  #controlTail: Promise<void> = Promise.resolve();
  #recoveryBlocked = false;
  #dequeuePaused = false;
  #admissionGate: ChangeSetGate | null = null;
  #currentExecutionId: string | null = null;

  private constructor(options: ChangeSetServiceOptions, state: ChangeSetRegistryState) {
    this.#options = {
      ...options,
      now: options.now ?? Date.now,
      createChangeSetId: options.createChangeSetId ?? randomUUID,
    };
    this.#state = state;
    this.#dequeuePaused = state.writeMode !== undefined;
    this.#admissionGate = gateForWriteMode(state.writeMode);
  }

  static async open(options: ChangeSetServiceOptions): Promise<ChangeSetService> {
    const state = parseChangeSetRegistryState(await options.store.load());
    const service = new ChangeSetService(options, state);
    let recoveryBlocked = false;
    try {
      await service.#recover();
    } catch (error) {
      if (error instanceof InjectedChangeSetCrash) throw error;
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
    options.runtimeState?.setQueue(service.#queueState(null));
    return service;
  }

  async #crash(point: string): Promise<void> {
    await this.#options.crashInjector?.(point);
  }

  #mutationPlan(entry: ChangeSetRegistryEntry): {
    input: ChangeSetSubmitInput;
    preview: Preview;
    directories: string[];
  } | null {
    if (
      entry.execution === undefined ||
      entry.changeSet.state !== "in_progress" ||
      entry.changeSet.preview === undefined ||
      entry.execution.input.operations.some(
        ({ kind }) =>
          kind !== "create_directory" &&
          kind !== "create_note" &&
          kind !== "edit_body" &&
          kind !== "copy_attachment" &&
          kind !== "move_attachment" &&
          kind !== "trash",
      )
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
      const restoreEvidence: ChangeSetSemanticEvidenceRequest = {
        mode: "restore",
        operations: frame.input.operations,
        publicPaths: frame.preview.paths.map(({ path }) => path),
        hiddenTrash: frame.input.operations.some(({ kind }) => kind === "trash"),
        requiredEvents: [],
      };
      const actions: (() => Promise<void>)[] = [];
      for (const mutation of [...(frame.mutations ?? [])].reverse()) {
        if (mutation.kind === "copy_attachment") {
          const destinationAfter = await executionPathMatches(
            execution,
            mutation.destinationPath,
            mutation.destinationAfter,
          );
          const destinationBefore = await executionPathMatches(
            execution,
            mutation.destinationPath,
            mutation.destinationBefore,
          );
          const destinationRemoved = await executionPathMatches(
            execution,
            mutation.destinationPath,
            { kind: "absent" },
          );
          if (!destinationAfter && !destinationBefore && !destinationRemoved) {
            throw new Error("third-party path state");
          }
          if (destinationAfter || destinationBefore || destinationRemoved) {
            if (execution.removeFile === undefined) throw new Error("File removal is unavailable");
            actions.push(async () => {
              if (
                await executionPathMatches(
                  execution,
                  mutation.destinationPath,
                  mutation.destinationAfter,
                )
              ) {
                await execution.removeFile!(mutation.destinationPath);
              } else if (
                !(await executionPathMatches(
                  execution,
                  mutation.destinationPath,
                  mutation.destinationBefore,
                ))
              ) {
                throw new Error("third-party path state");
              }
            });
          }
          actions.push(async () => {
            await execution.discardPreparedFile?.(mutation.stageId);
          });
          continue;
        }
        if (mutation.kind === "move_attachment") {
          const sourceBefore = await executionPathMatches(
            execution,
            mutation.sourcePath,
            mutation.sourceBefore,
          );
          const sourceAfter = await executionPathMatches(
            execution,
            mutation.sourcePath,
            mutation.sourceAfter,
          );
          const destinationBefore = await executionPathMatches(
            execution,
            mutation.destinationPath,
            mutation.destinationBefore,
          );
          const destinationAfter = await executionPathMatches(
            execution,
            mutation.destinationPath,
            mutation.destinationAfter,
          );
          const destinationRemoved = await executionPathMatches(
            execution,
            mutation.destinationPath,
            { kind: "absent" },
          );
          if (sourceBefore && (destinationBefore || destinationRemoved)) continue;
          if (sourceAfter && destinationAfter) {
            if (execution.moveFile === undefined) throw new Error("File move is unavailable");
            actions.push(() =>
              execution.moveFile!(mutation.destinationPath, mutation.sourcePath)
            );
            continue;
          }
          if (sourceBefore && destinationAfter) {
            if (execution.removeFile === undefined) throw new Error("File removal is unavailable");
            actions.push(() => execution.removeFile!(mutation.destinationPath));
            continue;
          }
          throw new Error("third-party path state");
        }
        if (mutation.kind === "move") {
          // Unlike an attachment move, the note content itself may have been
          // rewritten before the rename (self-references), so the source can
          // legitimately hold the destination bytes at crash time.
          const sourceBefore = await executionPathMatches(
            execution,
            mutation.sourcePath,
            mutation.sourceBefore,
          );
          const sourceMoved = await executionPathMatches(
            execution,
            mutation.sourcePath,
            mutation.destinationAfter,
          );
          const sourceAfter = await executionPathMatches(
            execution,
            mutation.sourcePath,
            mutation.sourceAfter,
          );
          const destinationBefore = await executionPathMatches(
            execution,
            mutation.destinationPath,
            mutation.destinationBefore,
          );
          const destinationAfter = await executionPathMatches(
            execution,
            mutation.destinationPath,
            mutation.destinationAfter,
          );
          const restoreSourceContent = async (): Promise<void> => {
            if (recoveryStatesEqual(mutation.sourceBefore, mutation.destinationAfter)) return;
            if (sourceBefore) return;
            const beforeBytes = recoveryBytes(mutation.sourceBefore);
            if (
              beforeBytes === null ||
              execution.prepareFile === undefined ||
              execution.publishFile === undefined
            ) {
              throw new Error("file rollback evidence is incomplete");
            }
            const rollbackStageId = `${mutation.stageId}/rollback`;
            await execution.discardPreparedFile?.(rollbackStageId);
            await execution.prepareFile(rollbackStageId, beforeBytes);
            await execution.publishFile(rollbackStageId, mutation.sourcePath);
          };
          const discardStaged = async (): Promise<void> => {
            await execution.discardPreparedFile?.(mutation.stageId);
          };
          if (destinationBefore && !destinationAfter && (sourceBefore || sourceMoved)) {
            // The rename never happened (or was fully rolled back already).
            actions.push(async () => {
              await discardStaged();
              await restoreSourceContent();
            });
            continue;
          }
          if (sourceAfter && destinationAfter) {
            if (execution.moveFile === undefined) throw new Error("File move is unavailable");
            actions.push(async () => {
              await execution.moveFile!(mutation.destinationPath, mutation.sourcePath);
              await discardStaged();
              await restoreSourceContent();
            });
            continue;
          }
          if ((sourceBefore || sourceMoved) && destinationAfter) {
            // Crash inside the rename itself (linked but not unlinked).
            if (execution.removeFile === undefined) throw new Error("File removal is unavailable");
            actions.push(async () => {
              await execution.removeFile!(mutation.destinationPath);
              await discardStaged();
              await restoreSourceContent();
            });
            continue;
          }
          throw new Error("third-party path state");
        }
        const sourceBefore = await executionPathMatches(
          execution,
          mutation.path,
          mutation.before,
        );
        const sourceAfter = await executionPathMatches(
          execution,
          mutation.path,
          mutation.expectedAfter,
        );
        const trashBytes = await execution.readTrash?.(mutation.trashId);
        const trashMatches =
          trashBytes !== undefined &&
          trashBytes !== null &&
          bytesMatchState(
            Uint8Array.from(
              trashBytes instanceof Uint8Array ? trashBytes : new Uint8Array(trashBytes),
            ),
            mutation.before,
          );
        if (sourceAfter && trashMatches) {
          if (execution.restoreFromTrash === undefined) {
            throw new Error("Managed trash restore is unavailable");
          }
          actions.push(() => execution.restoreFromTrash!(mutation.trashId, mutation.path));
        } else if (sourceBefore && (trashMatches || trashBytes === null)) {
          if (trashMatches) actions.push(async () => {
            await execution.discardTrash?.(mutation.trashId);
          });
        } else {
          throw new Error("third-party path state");
        }
      }
      // Markdown files are journaled as staged footprints rather than
      // RecoveryMutations; restore them in reverse order. Entries without a
      // stageId are evidence-only (never staged or published).
      for (const file of [...(frame.files ?? [])].reverse()) {
        if (file.stageId === undefined) continue;
        const current = await execution.pathKind(file.path);
        const currentIdentity =
          current === "file" ? await execution.fileIdentity?.(file.path) : null;
        const currentBytes =
          current === "file" ? await readExecutionBytes(execution, file.path) : null;
        const beforeBytes = recoveryBytes(file.before);
        if (current === null) {
          await execution.discardPreparedFile?.(file.stageId);
          if (file.before.kind !== "absent") throw new Error("original file disappeared");
          continue;
        }
        if (
          current === "file" &&
          file.before.kind !== "absent" &&
          beforeBytes !== null &&
          currentBytes !== null &&
          Buffer.from(currentBytes).equals(beforeBytes)
        ) {
          await execution.discardPreparedFile?.(file.stageId);
          continue;
        }
        if (
          current !== "file" ||
          file.identity === undefined ||
          currentIdentity !== file.identity ||
          !bytesMatchState(currentBytes, file.expectedAfter)
        ) {
          throw new Error("third-party path state");
        }
        if (file.before.kind === "absent") {
          await execution.removeFile?.(file.path);
        } else {
          if (beforeBytes === null || execution.prepareFile === undefined || execution.publishFile === undefined) {
            throw new Error("file rollback evidence is incomplete");
          }
          const rollbackStageId = `${file.stageId}/rollback`;
          await execution.discardPreparedFile?.(rollbackStageId);
          await execution.prepareFile(rollbackStageId, beforeBytes);
          await this.#crash(`recovery_after_file_prepared:${file.path}`);
          await execution.publishFile(rollbackStageId, file.path);
          await this.#crash(`recovery_after_file_published:${file.path}`);
        }
      }
      const directoryActions: (() => Promise<void>)[] = [];
      for (const directory of [...frame.directories].reverse()) {
        const current = await execution.pathKind(directory.path);
        if (current === null) {
          if (directory.stageId !== undefined) {
            directoryActions.push(() =>
              execution.discardPreparedDirectory(directory.stageId!)
            );
          }
          continue;
        }
        if (
          current !== "directory" ||
          directory.identity === undefined ||
          (await execution.directoryIdentity(directory.path)) !== directory.identity
        ) {
          throw new Error("third-party path state");
        }
        directoryActions.push(() => execution.removeDirectory(directory.path));
      }
      await execution.beginSemanticEvidence?.(restoreEvidence);
      await this.#crash("before_rollback");
      for (const [index, action] of [...actions, ...directoryActions].entries()) {
        await action();
        await this.#crash(`after_rollback_mutation:${index}`);
      }
      for (const file of frame.files ?? []) {
        if (!(await executionPathMatches(execution, file.path, file.before))) {
          throw new Error("before state was not restored");
        }
      }
      for (const directory of frame.directories) {
        if ((await execution.pathKind(directory.path)) !== null) {
          throw new Error("before state was not restored");
        }
      }
      await this.#crash("after_rollback_verification");
      await execution.awaitSemanticEvidence?.(restoreEvidence);
      await this.#crash("after_rollback_evidence");
      if (
        execution.semanticEvidencePublishesSnapshot !== true ||
        frame.rollbackBarrier !== undefined
      ) {
        await execution.publishSearchSnapshot(undefined, frame.rollbackBarrier);
      }
      await this.#crash("before_rolled_back");
      await execution.persistRecoveryFrame({ ...frame, phase: "ROLLED_BACK" });
      rolledBackDurable = true;
      await this.#crash("after_rolled_back");
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
      if (error instanceof InjectedChangeSetCrash) throw error;
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
    if (
      frame.enqueueSeq !== entry.enqueueSeq ||
      entry.execution === undefined ||
      frame.input.submissionKey !== entry.submissionKey ||
      fingerprintChangeSetRequest(frame.input) !== entry.fingerprint ||
      !recoveryPlanMatchesFrame(frame) ||
      entry.changeSet.state === "in_progress" &&
        entry.changeSet.preview !== undefined &&
        JSON.stringify(canonicalize(frame.preview)) !==
          JSON.stringify(canonicalize(entry.changeSet.preview))
    ) {
      await this.#markUnproven(entry);
      return;
    }
    if (frame.vaultId !== (this.#options.vaultId ?? "vault")) {
      await this.#markUnproven(entry);
      return;
    }
    if (frame.phase === "PREPARED") {
      if (entry.changeSet.state === "intent_not_applied" || entry.changeSet.state === "result_unproven") {
        return;
      }
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
    if (frame.phase === "COMMITTED") {
      if (entry.changeSet.state === "intent_applied") return;
      if (entry.changeSet.state !== "in_progress") {
        await this.#markUnproven(entry);
        return;
      }
      const expectedFinalPaths = frame.preview.paths.map(
        ({ path, projectedOutcome, projectedFinalState }) => ({
          path,
          outcome: projectedOutcome,
          finalState: projectedFinalState,
        }),
      );
      if (
        frame.finalPaths === undefined ||
        JSON.stringify(frame.finalPaths) !== JSON.stringify(expectedFinalPaths)
      ) {
        await this.#markUnproven(entry);
        return;
      }
      await this.#updateEntry(entry.changeSetId, (current) => {
        current.changeSet = this.#appliedRecord(
          current,
          frame.preview,
          frame.finalPaths!,
        );
        if (current.execution !== undefined) current.execution.phase = "terminal";
      });
      return;
    }
    if (frame.phase === "ROLLED_BACK") {
      if (entry.changeSet.state === "intent_not_applied") return;
      if (entry.changeSet.state !== "in_progress") {
        await this.#markUnproven(entry);
        return;
      }
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
    if (
      this.#options.execution === undefined ||
      this.#recoveryBlocked ||
      this.#dequeuePaused
    ) {
      return;
    }
    const queued = [...this.#state.entries]
      .filter((entry) => entry.execution?.phase !== "terminal")
      .sort((left, right) => left.enqueueSeq - right.enqueueSeq);
    for (const entry of queued) {
      if (this.#dequeuePaused) break;
      await this.#executeEntry(entry.changeSetId);
    }
  }

  async #setWriteMode(
    mode: ChangeSetWriteMode | undefined,
    lifecycle?: PersistedChangeSetLifecycle,
  ): Promise<void> {
    await this.#serialize(async () => {
      const nextState = structuredClone(this.#state);
      if (mode === undefined) delete nextState.writeMode;
      else nextState.writeMode = mode;
      if (lifecycle !== undefined) nextState.lifecycle = lifecycle;
      await this.#save(nextState);
      this.#dequeuePaused = mode !== undefined;
      this.#admissionGate = gateForWriteMode(mode);
    });
  }

  async pause(observer?: ChangeSetPauseObserver): Promise<void> {
    await this.#withControlLease(async () => {
      if (
        this.#state.writeMode === "maintenance_pending" ||
        this.#state.writeMode === "maintenance_failed" ||
        this.#state.writeMode === "maintenance_paused"
      ) {
        throw new Error("Maintenance must resume before manual pause can replace it");
      }
      await this.#setWriteMode("manual_paused");
      observer?.started();
      await this.#withWriteLease(async () => undefined);
      observer?.completed();
    });
  }

  async runMaintenance(
    migrate: () => void | Promise<void>,
    observer: ChangeSetMaintenanceObserver,
  ): Promise<void> {
    await this.#withControlLease(async () => {
      await this.#setWriteMode("maintenance_pending");
      observer.started();
      await this.#withWriteLease(async () => {
        try {
          await migrate();
        } catch (error) {
          await this.#setWriteMode("maintenance_failed", {
            upgrade: "failed",
            migration: "failed",
          });
          observer.failed();
          throw error;
        }
        await this.#setWriteMode("maintenance_paused", {
          upgrade: "succeeded",
          migration: "succeeded",
        });
        observer.completed();
      });
    });
  }

  async resume(
    assertSafe?: () => void,
    onAdmissionOpened?: () => void,
  ): Promise<void> {
    await this.#withControlLease(() =>
      this.#withWriteLease(async () => {
        assertSafe?.();
        await this.#serialize(async () => {
          if (this.#admissionGate?.code === "upgrade_in_progress") {
            throw new Error("Maintenance has not completed and writes remain blocked");
          }
          const nextState = structuredClone(this.#state);
          delete nextState.writeMode;
          await this.#save(nextState);
          this.#dequeuePaused = false;
          this.#admissionGate = null;
        });
        onAdmissionOpened?.();
        await this.#resumeQueue();
      }),
    );
  }

  #queueState(currentExecutionId: string | null): {
    currentExecutionId: string | null;
    length: number;
    headChangeSetId: string | null;
  } {
    const pending = this.#state.entries
      .filter(({ execution }) => execution !== undefined && execution.phase !== "terminal")
      .sort((left, right) => left.enqueueSeq - right.enqueueSeq);
    return {
      currentExecutionId,
      length: pending.length,
      headChangeSetId: pending[0]?.changeSetId ?? null,
    };
  }

  async #executeEntry(changeSetId: string): Promise<void> {
    const entry = this.#state.entries.find((candidate) => candidate.changeSetId === changeSetId);
    if (entry === undefined) return;
    if (this.#mutationPlan(entry) !== null) {
      await this.#executeMutation(changeSetId);
      return;
    }
    if (
      entry.execution?.input.operations.length === 1 &&
      entry.execution.input.operations[0]?.kind === "move"
    ) {
      await this.#executeMove(changeSetId);
    }
  }

  /**
   * Durable execution of a single note move with its bound reference
   * rewrites (issue #38). Reference rewrites are journaled as staged
   * Markdown footprints exactly like #executeMutation; the rename itself is
   * journaled as a `move` RecoveryMutation so a crash anywhere can be
   * rolled back to the pre-move Vault state.
   */
  async #executeMove(changeSetId: string): Promise<void> {
    const execution = this.#options.execution;
    if (
      execution?.readBinary === undefined ||
      execution.fileIdentity === undefined ||
      execution.prepareFile === undefined ||
      execution.publishFile === undefined ||
      execution.discardPreparedFile === undefined ||
      execution.moveFile === undefined ||
      execution.removeFile === undefined
    ) return;
    const entry = this.#state.entries.find((candidate) => candidate.changeSetId === changeSetId);
    if (entry === undefined) return;
    const head = this.#state.entries
      .filter(
        ({ execution }) => execution !== undefined && execution.phase !== "terminal",
      )
      .sort((left, right) => left.enqueueSeq - right.enqueueSeq)[0];
    if (head?.changeSetId !== entry.changeSetId) return;
    if (
      entry.changeSet.state !== "in_progress" ||
      entry.changeSet.preview === undefined ||
      entry.execution === undefined
    ) return;
    const operation = entry.execution.input.operations[0];
    if (operation?.kind !== "move") return;
    const bound = entry.execution.boundMoves?.find(
      (candidate) => candidate.operationId === operation.operationId,
    );
    if (bound === undefined) return;
    const frozenPreview = entry.changeSet.preview;
    this.#currentExecutionId = entry.changeSetId;
    this.#options.runtimeState?.setQueue(this.#queueState(this.#currentExecutionId));
    const reject = async (failure?: ChangeSetFailure): Promise<void> => {
      await this.#updateEntry(entry.changeSetId, (current) => {
        current.changeSet = {
          changeSetId: current.changeSetId,
          state: "intent_not_applied",
          preview: frozenPreview,
          ...(failure === undefined ? {} : { failure }),
        };
        if (current.execution !== undefined) current.execution.phase = "terminal";
      });
      this.#currentExecutionId = null;
      this.#options.runtimeState?.setQueue(this.#queueState(null));
    };
    const checked = await preflight(
      this.#options.dataSource,
      entry.execution.input,
      entry.execution.boundMoves,
    );
    if (!checked.accepted || JSON.stringify(checked.preview) !== JSON.stringify(frozenPreview)) {
      await reject(checked.failure);
      return;
    }
    const sourceBytes = checked.observedBytes?.get(operation.sourcePath) ?? null;
    const movedBytes = checked.projectedBytes?.get(operation.destinationPath) ?? null;
    if (sourceBytes === null || movedBytes === null) {
      await reject({ code: "stale_observation" });
      return;
    }
    // The source content changes only when the note references itself; in
    // that case the rewritten bytes are staged under the mutation stage id
    // and published over the source right before the rename.
    const sourceChanged = !Buffer.from(sourceBytes).equals(Buffer.from(movedBytes));
    const directories = frozenPreview.paths
      .filter(
        ({ preState, projectedFinalState }) =>
          preState.kind === "absent" && projectedFinalState.kind === "directory",
      )
      .map(({ path }) => path)
      .sort((left, right) => {
        const depth = left.split("/").length - right.split("/").length;
        return depth || compareCodeUnits(left, right);
      });
    const previewFiles = frozenPreview.paths.filter(
      ({ preState, projectedFinalState }) =>
        preState.kind !== "directory" && projectedFinalState.kind !== "directory",
    );
    const stagedPaths = new Set(
      previewFiles
        .filter(({ path, projectedOutcome, projectedFinalState }) => {
          if (projectedOutcome !== "changed") return false;
          // The destination is created by the rename, never staged.
          if (path === operation.destinationPath) return false;
          if (path === operation.sourcePath) return false;
          return projectedFinalState.kind === "markdown";
        })
        .map(({ path }) => path),
    );
    const files: RecoveryFileFootprint[] = [];
    let stagedIndex = 0;
    for (const { path, preState, projectedFinalState } of previewFiles) {
      const beforeBytes = checked.observedBytes?.get(path);
      const expectedBytes = checked.projectedBytes?.has(path)
        ? checked.projectedBytes.get(path)
        : beforeBytes;
      const footprint: RecoveryFileFootprint = {
        path,
        before: recoveryFileState(preState, beforeBytes),
        expectedAfter: recoveryFileState(projectedFinalState, expectedBytes),
      };
      if (!stagedPaths.has(path)) {
        files.push(footprint);
        continue;
      }
      // Staged rewrites carry fresh pre-state bytes and inode identity so
      // recovery can prove the published file is the one this Change Set
      // wrote and can restore exact before bytes after a crash.
      const freshBytes =
        preState.kind === "markdown" ? await readBytes(this.#options.dataSource, path) : null;
      const beforeIdentity =
        preState.kind === "markdown" ? await execution.fileIdentity(path) : null;
      if (
        preState.kind !== "markdown" ||
        freshBytes === null ||
        beforeIdentity === null ||
        beforeIdentity === undefined ||
        contentVersion(freshBytes) !== preState.contentVersion
      ) {
        throw new Error("File pre-state evidence changed after locked preflight");
      }
      files.push({
        path,
        before: {
          kind: "markdown",
          contentVersion: preState.contentVersion,
          bytesBase64: Buffer.from(freshBytes).toString("base64"),
        },
        expectedAfter: footprint.expectedAfter,
        beforeIdentity,
        stageId: `${entry.changeSetId}/file/${stagedIndex++}`,
      });
    }
    // The source stays evidence-only even when its content is rewritten:
    // the rename-back and the content restore are both driven by the move
    // mutation during recovery.
    const sourceFootprint = files.find(({ path }) => path === operation.sourcePath);
    const destinationFootprint = files.find(({ path }) => path === operation.destinationPath);
    if (sourceFootprint === undefined || destinationFootprint === undefined) {
      throw new Error("Move recovery evidence is incomplete");
    }
    if (sourceChanged) {
      const sourceIdentity = await execution.fileIdentity(operation.sourcePath);
      const freshSource = await readBytes(this.#options.dataSource, operation.sourcePath);
      if (
        sourceIdentity === null ||
        sourceIdentity === undefined ||
        freshSource === null ||
        contentVersion(freshSource) !== contentVersion(sourceBytes)
      ) {
        throw new Error("File pre-state evidence changed after locked preflight");
      }
      sourceFootprint.beforeIdentity = sourceIdentity;
    }
    if ((await execution.pathKind(operation.destinationPath)) !== null) {
      throw new Error("File pre-state evidence changed after locked preflight");
    }
    const mutation: RecoveryMutation = {
      kind: "move",
      operationId: operation.operationId,
      sourcePath: operation.sourcePath,
      sourceBefore: sourceFootprint.before,
      sourceAfter: { kind: "absent" },
      destinationPath: operation.destinationPath,
      destinationBefore: destinationFootprint.before,
      destinationAfter: destinationFootprint.expectedAfter,
      stageId: `${entry.changeSetId}/move/0`,
    };
    const successBarrier: MoveSnapshotBarrier = {
      presentPath: operation.destinationPath,
      absentPath: operation.sourcePath,
      presentVersion: contentVersion(movedBytes),
      closure: bound.derivedEffects
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
      presentVersion: contentVersion(sourceBytes),
      closure: bound.derivedEffects
        .filter((effect) => effect.referenceCount !== undefined)
        .map((effect) => {
          const footprint = files.find(({ path }) => path === effect.path);
          const bytes = footprint === undefined ? null : recoveryBytes(footprint.before);
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
      schemaVersion: RECOVERY_JOURNAL_FRAME_SCHEMA_VERSION,
      vaultId: this.#options.vaultId ?? "vault",
      changeSetId: entry.changeSetId,
      enqueueSeq: entry.enqueueSeq,
      phase: "PREPARED",
      input: structuredClone(entry.execution.input),
      preview: frozenPreview,
      directories: directories.map((path, index) => ({
        path,
        before: "absent",
        expectedAfter: "directory",
        stageId: `${entry.changeSetId}/directory/${index}`,
      })),
      files,
      mutations: [mutation],
      successBarrier,
      rollbackBarrier,
    };
    await this.#crash("before_prepared");
    await execution.persistRecoveryFrame(frame);
    let committedDurable = false;
    try {
      await this.#updateEntry(entry.changeSetId, (current) => {
        if (current.execution !== undefined) current.execution.phase = "executing";
      });
      await this.#crash("after_prepared");
      const semanticRequest: ChangeSetSemanticEvidenceRequest = {
        mode: "apply",
        operations: entry.execution.input.operations,
        publicPaths: frozenPreview.paths.map(({ path }) => path),
        hiddenTrash: false,
        requiredEvents: [
          { kind: "rename", oldPath: operation.sourcePath, path: operation.destinationPath },
        ],
      };
      // Stage Markdown rewrites first so their post-staging identities are
      // journaled before any mutation becomes visible.
      const preparedByPath = new Map<string, RecoveryFileFootprint>();
      for (const file of frame.files ?? []) {
        if (file.stageId === undefined) continue;
        const projected = checked.projectedBytes?.get(file.path);
        if (projected === undefined || projected === null) {
          throw new Error("Projected file bytes are missing");
        }
        const identity = await execution.prepareFile(file.stageId, projected);
        preparedByPath.set(file.path, { ...file, identity });
      }
      if (preparedByPath.size > 0) {
        frame = {
          ...frame,
          files: (frame.files ?? []).map(
            (candidate) => preparedByPath.get(candidate.path) ?? candidate,
          ),
        };
        await execution.persistRecoveryFrame(frame);
      }
      if (sourceChanged) {
        await execution.discardPreparedFile(mutation.stageId);
        await execution.prepareFile(mutation.stageId, movedBytes);
      }
      await execution.beginSemanticEvidence?.(semanticRequest);
      let mutationIndex = 0;
      for (const directory of directories) {
        if ((await execution.pathKind(directory)) !== null) {
          throw new Error("Directory absence changed before mutation");
        }
        const stageId = frame.directories.find(
          (candidate) => candidate.path === directory,
        )?.stageId;
        if (stageId === undefined) throw new Error("Directory staging identity is missing");
        const identity = await execution.prepareDirectory(stageId);
        frame = {
          ...frame,
          directories: frame.directories.map((candidate) =>
            candidate.path === directory ? { ...candidate, identity, stageId } : candidate,
          ),
        };
        await execution.persistRecoveryFrame(frame);
        await execution.publishDirectory(stageId, directory);
        await this.#crash(`after_mutation:${mutationIndex++}`);
      }
      let stagedPublishIndex = 0;
      for (const file of frame.files ?? []) {
        if (file.stageId === undefined) continue;
        const currentBytes = await readExecutionBytes(execution, file.path);
        const currentIdentity = await execution.fileIdentity(file.path);
        if (
          currentBytes === null ||
          !bytesMatchState(currentBytes, file.before) ||
          currentIdentity !== file.beforeIdentity
        ) {
          throw new Error("File pre-state changed before mutation");
        }
        await execution.publishFile(file.stageId, file.path);
        await this.#crash(`after_file_mutation:${stagedPublishIndex++}`);
      }
      if (sourceChanged) {
        const currentBytes = await readExecutionBytes(execution, operation.sourcePath);
        const currentIdentity = await execution.fileIdentity(operation.sourcePath);
        if (
          currentBytes === null ||
          !bytesMatchState(currentBytes, mutation.sourceBefore) ||
          currentIdentity !== sourceFootprint.beforeIdentity
        ) {
          throw new Error("File pre-state changed before mutation");
        }
        await execution.publishFile(mutation.stageId, operation.sourcePath);
        await this.#crash(`after_file_mutation:${stagedPublishIndex++}`);
      }
      if ((await execution.pathKind(operation.destinationPath)) !== null) {
        throw new Error("File pre-state changed before mutation");
      }
      await execution.moveFile(operation.sourcePath, operation.destinationPath);
      await this.#crash(`after_mutation:${mutationIndex++}`);
      for (const directory of directories) {
        if ((await execution.pathKind(directory)) !== "directory") {
          throw new Error("Final directory evidence did not match");
        }
      }
      for (const file of files) {
        if (!(await executionPathMatches(execution, file.path, file.expectedAfter))) {
          throw new Error("Final file evidence did not match");
        }
      }
      await this.#crash("after_raw_verification");
      const snapshotTargets: SearchSnapshotTargetEvidence[] = frozenPreview.paths
        .filter(({ projectedFinalState }) => projectedFinalState.kind === "markdown")
        .map(({ path, projectedOutcome, projectedFinalState }) => {
          if (projectedFinalState.kind !== "markdown") {
            throw new Error("Projected snapshot evidence is invalid");
          }
          return {
            path,
            contentVersion: projectedFinalState.contentVersion,
            requireSemanticMatch: projectedOutcome === "changed",
          };
        });
      await execution.awaitSemanticEvidence?.(semanticRequest);
      await this.#crash("after_semantic_evidence");
      // The move barrier always runs, even when the evidence tracker already
      // published a snapshot: only it proves the reference closure resolved
      // to the destination.
      await execution.publishSearchSnapshot(snapshotTargets, frame.successBarrier);
      for (const file of files) {
        if (!(await executionPathMatches(execution, file.path, file.expectedAfter))) {
          throw new Error("Final file evidence changed during the success barrier");
        }
      }
      for (const directory of directories) {
        if ((await execution.pathKind(directory)) !== "directory") {
          throw new Error("Final directory evidence changed during the success barrier");
        }
      }
      const finalPaths: Extract<ChangeSetRecord, { state: "intent_applied" }>["paths"] =
        frozenPreview.paths.map(({ path, projectedFinalState, projectedOutcome }) => ({
          path,
          outcome: projectedOutcome,
          finalState: projectedFinalState,
        }));
      await this.#crash("after_snapshot");
      await execution.persistRecoveryFrame({
        ...frame,
        phase: "COMMITTED",
        finalPaths,
      });
      committedDurable = true;
      await this.#crash("after_committed");
      await this.#updateEntry(entry.changeSetId, (current) => {
        current.changeSet = this.#appliedRecord(current, frozenPreview, finalPaths);
        if (current.execution !== undefined) current.execution.phase = "terminal";
      });
    } catch (error) {
      if (error instanceof InjectedChangeSetCrash || committedDurable) throw error;
      await this.#restorePrepared(entry, frame);
    } finally {
      this.#currentExecutionId = null;
      this.#options.runtimeState?.setQueue(this.#queueState(null));
    }
  }

  async #executeMutation(changeSetId: string): Promise<void> {
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
    const plan = this.#mutationPlan(entry);
    if (plan === null) return;
    this.#currentExecutionId = entry.changeSetId;
    this.#options.runtimeState?.setQueue(this.#queueState(this.#currentExecutionId));
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
      this.#currentExecutionId = null;
      this.#options.runtimeState?.setQueue(this.#queueState(null));
      return;
    }
    const operationKinds = plan.input.operations.map(({ kind }) => kind);
    const projectedMarkdown = plan.preview.paths.filter(
      ({ projectedFinalState }) => projectedFinalState.kind === "markdown",
    );
    const changedOperationIds = new Set(
      plan.preview.requestedEffects
        .filter(({ projectedOutcome }) => projectedOutcome === "changed")
        .map(({ operationId }) => operationId),
    );
    const projectedFiles = projectedMarkdown.filter(
      ({ path, projectedOutcome }) =>
        projectedOutcome === "changed" ||
        plan.input.operations.some(
          (operation) =>
            "path" in operation &&
            operation.path === path &&
            changedOperationIds.has(operation.operationId),
        ),
    );
    const stagedPaths = new Set(projectedFiles.map(({ path }) => path));
    const hasSemanticOperations = operationKinds.some(
      (kind) =>
        kind === "copy_attachment" || kind === "move_attachment" || kind === "trash",
    );
    if (
      (projectedMarkdown.length > 0 || hasSemanticOperations) &&
      execution.readBinary === undefined
    ) {
      throw new Error("Change Set execution adapter cannot prove final file bytes");
    }
    if (hasSemanticOperations && execution.awaitSemanticEvidence === undefined) {
      throw new Error("Change Set execution adapter does not support file evidence");
    }
    if (
      projectedFiles.length > 0 &&
      (execution.fileIdentity === undefined ||
        execution.prepareFile === undefined ||
        execution.publishFile === undefined ||
        execution.discardPreparedFile === undefined ||
        execution.removeFile === undefined)
    ) {
      throw new Error("Change Set execution adapter does not support files");
    }
    if (
      operationKinds.includes("copy_attachment") &&
      (execution.prepareFile === undefined || execution.publishFile === undefined)
    ) {
      throw new Error("Change Set execution adapter does not support attachment copies");
    }
    if (
      operationKinds.includes("move_attachment") &&
      execution.moveFile === undefined
    ) {
      throw new Error("Change Set execution adapter does not support attachment moves");
    }
    if (
      operationKinds.includes("trash") &&
      (execution.moveToTrash === undefined ||
        execution.restoreFromTrash === undefined ||
        execution.readTrash === undefined)
    ) {
      throw new Error("Change Set execution adapter does not support managed trash");
    }
    const files: RecoveryFileFootprint[] = await Promise.all(
      plan.preview.paths
        .filter(
          ({ preState, projectedFinalState }) =>
            preState.kind !== "directory" && projectedFinalState.kind !== "directory",
        )
        .map(async ({ path, preState, projectedFinalState }) => {
          const beforeBytes = checked.observedBytes?.get(path);
          const expectedBytes = checked.projectedBytes?.has(path)
            ? checked.projectedBytes.get(path)
            : beforeBytes;
          const footprint: RecoveryFileFootprint = {
            path,
            before: recoveryFileState(preState, beforeBytes),
            expectedAfter: recoveryFileState(projectedFinalState, expectedBytes),
          };
          const stagedIndex = projectedFiles.findIndex((candidate) => candidate.path === path);
          if (stagedIndex === -1) return footprint;
          // Staged Markdown files carry fresh pre-state bytes and inode identity
          // so recovery can prove the published file is the one this Change Set
          // wrote and can restore exact before bytes after a crash.
          const freshBytes =
            preState.kind === "markdown"
              ? await readBytes(this.#options.dataSource, path)
              : null;
          const beforeIdentity =
            preState.kind === "markdown" ? await execution.fileIdentity?.(path) : null;
          if (
            (preState.kind === "markdown" &&
              (freshBytes === null ||
                beforeIdentity === null ||
                beforeIdentity === undefined ||
                contentVersion(freshBytes) !== preState.contentVersion)) ||
            (preState.kind === "absent" &&
              (freshBytes !== null || (await execution.pathKind(path)) !== null))
          ) {
            throw new Error("File pre-state evidence changed after locked preflight");
          }
          return {
            path,
            before:
              preState.kind === "markdown" && freshBytes !== null
                ? {
                    kind: "markdown" as const,
                    contentVersion: preState.contentVersion,
                    bytesBase64: Buffer.from(freshBytes).toString("base64"),
                  }
                : footprint.before,
            expectedAfter: footprint.expectedAfter,
            ...(beforeIdentity === null || beforeIdentity === undefined
              ? {}
              : { beforeIdentity }),
            stageId: `${entry.changeSetId}/file/${stagedIndex}`,
          };
        }),
    );
    const mutationStates = new Map(files.map(({ path, before }) => [path, before]));
    const mutations: RecoveryMutation[] = plan.input.operations.flatMap(
      (operation, index): RecoveryMutation[] => {
        if (operation.kind === "copy_attachment") {
          const sourceState = mutationStates.get(operation.sourcePath);
          const destinationBefore = mutationStates.get(operation.destinationPath);
          if (
            sourceState?.kind !== "attachment" ||
            destinationBefore === undefined
          ) {
            throw new Error("Attachment copy recovery evidence is incomplete");
          }
          mutationStates.set(operation.destinationPath, sourceState);
          return [{
            kind: operation.kind,
            operationId: operation.operationId,
            sourcePath: operation.sourcePath,
            sourceState,
            destinationPath: operation.destinationPath,
            destinationBefore,
            destinationAfter: sourceState,
            stageId: `${entry.changeSetId}/attachment/${index}`,
          }];
        }
        if (operation.kind === "move_attachment") {
          const sourceBefore = mutationStates.get(operation.sourcePath);
          const destinationBefore = mutationStates.get(operation.destinationPath);
          if (
            sourceBefore?.kind !== "attachment" ||
            destinationBefore === undefined
          ) {
            throw new Error("Attachment move recovery evidence is incomplete");
          }
          const sourceAfter = { kind: "absent" } as const;
          mutationStates.set(operation.sourcePath, sourceAfter);
          mutationStates.set(operation.destinationPath, sourceBefore);
          return [{
            kind: operation.kind,
            operationId: operation.operationId,
            sourcePath: operation.sourcePath,
            sourceBefore,
            sourceAfter,
            destinationPath: operation.destinationPath,
            destinationBefore,
            destinationAfter: sourceBefore,
          }];
        }
        if (operation.kind === "trash") {
          const before = mutationStates.get(operation.path);
          if (before === undefined || before.kind === "absent") {
            throw new Error("Managed trash recovery evidence is incomplete");
          }
          const expectedAfter = { kind: "absent" } as const;
          mutationStates.set(operation.path, expectedAfter);
          return [{
            kind: operation.kind,
            operationId: operation.operationId,
            path: operation.path,
            before,
            expectedAfter,
            trashId: `${entry.changeSetId}/${index}`,
          }];
        }
        return [];
      },
    );
    let frame: RecoveryJournalFrame = {
      schemaVersion: RECOVERY_JOURNAL_FRAME_SCHEMA_VERSION,
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
        stageId: `${entry.changeSetId}/directory/${index}`,
      })),
      files,
      ...(mutations.length === 0 ? {} : { mutations }),
    };
    await this.#crash("before_prepared");
    await execution.persistRecoveryFrame(frame);
    let committedDurable = false;
    try {
      await this.#updateEntry(entry.changeSetId, (current) => {
        if (current.execution !== undefined) current.execution.phase = "executing";
      });
      await this.#crash("after_prepared");
      const requiredEvents: ChangeSetSemanticEvent[] = [];
      for (const operation of plan.input.operations) {
        if (operation.kind === "copy_attachment") {
          requiredEvents.push({ kind: "create", path: operation.destinationPath });
        } else if (operation.kind === "move_attachment") {
          requiredEvents.push({
            kind: "rename",
            oldPath: operation.sourcePath,
            path: operation.destinationPath,
          });
        }
      }
      const semanticRequest: ChangeSetSemanticEvidenceRequest = {
        mode: "apply",
        operations: plan.input.operations,
        publicPaths: plan.preview.paths.map(({ path }) => path),
        hiddenTrash: operationKinds.includes("trash"),
        requiredEvents,
      };
      // Stage Markdown files first so their post-staging identities are
      // journaled before any mutation becomes visible.
      const preparedByPath = new Map<string, RecoveryFileFootprint>();
      for (const file of frame.files ?? []) {
        if (file.stageId === undefined) continue;
        const projected = checked.projectedBytes?.get(file.path);
        if (projected === undefined || projected === null) {
          throw new Error("Projected file bytes are missing");
        }
        const identity = await execution.prepareFile!(file.stageId, projected);
        preparedByPath.set(file.path, { ...file, identity });
      }
      if (preparedByPath.size > 0) {
        frame = {
          ...frame,
          files: (frame.files ?? []).map(
            (candidate) => preparedByPath.get(candidate.path) ?? candidate,
          ),
        };
        await execution.persistRecoveryFrame(frame);
      }
      await execution.beginSemanticEvidence?.(semanticRequest);
      let mutationIndex = 0;
      for (const directory of plan.directories) {
        if ((await execution.pathKind(directory)) !== null) {
          throw new Error("Directory absence changed before mutation");
        }
        const stageId = frame.directories.find(
          (candidate) => candidate.path === directory,
        )?.stageId;
        if (stageId === undefined) throw new Error("Directory staging identity is missing");
        const identity = await execution.prepareDirectory(stageId);
        frame = {
          ...frame,
          directories: frame.directories.map((candidate) =>
            candidate.path === directory ? { ...candidate, identity, stageId } : candidate,
          ),
        };
        await execution.persistRecoveryFrame(frame);
        await execution.publishDirectory(stageId, directory);
        await this.#crash(`after_mutation:${mutationIndex++}`);
      }
      let stagedPublishIndex = 0;
      for (const file of frame.files ?? []) {
        if (file.stageId === undefined) continue;
        const currentBytes = await readExecutionBytes(execution, file.path);
        const currentIdentity = await execution.fileIdentity?.(file.path);
        if (
          (file.before.kind === "absent" &&
            (currentBytes !== null || (await execution.pathKind(file.path)) !== null)) ||
          (file.before.kind !== "absent" &&
            (currentBytes === null ||
              !bytesMatchState(currentBytes, file.before) ||
              currentIdentity !== file.beforeIdentity))
        ) {
          throw new Error("File pre-state changed before mutation");
        }
        await execution.publishFile!(file.stageId, file.path);
        await this.#crash(`after_file_mutation:${stagedPublishIndex++}`);
      }
      for (const mutation of mutations) {
        if (mutation.kind === "copy_attachment") {
          const bytes = recoveryBytes(mutation.sourceState);
          if (bytes === null) throw new Error("Attachment source evidence is incomplete");
          await execution.prepareFile!(mutation.stageId, bytes);
          await execution.publishFile!(mutation.stageId, mutation.destinationPath);
        } else if (mutation.kind === "move_attachment") {
          await execution.moveFile!(mutation.sourcePath, mutation.destinationPath);
        } else if (mutation.kind === "move") {
          // Note moves execute through #executeMove, never the unified path.
          throw new Error("Note move mutation reached the unified executor");
        } else {
          await execution.moveToTrash!(mutation.path, mutation.trashId);
        }
        await this.#crash(`after_mutation:${mutationIndex++}`);
      }
      for (const directory of plan.directories) {
        if ((await execution.pathKind(directory)) !== "directory") {
          throw new Error("Final directory evidence did not match");
        }
      }
      for (const file of files) {
        if (!(await executionPathMatches(execution, file.path, file.expectedAfter))) {
          throw new Error("Final file evidence did not match");
        }
      }
      for (const mutation of mutations) {
        if (mutation.kind !== "trash") continue;
        const trashBytes = await execution.readTrash?.(mutation.trashId);
        if (
          trashBytes === undefined ||
          trashBytes === null ||
          !bytesMatchState(
            Uint8Array.from(
              trashBytes instanceof Uint8Array ? trashBytes : new Uint8Array(trashBytes),
            ),
            mutation.before,
          )
        ) {
          throw new Error("Managed trash evidence did not match");
        }
      }
      await this.#crash("after_raw_verification");
      const snapshotTargets: SearchSnapshotTargetEvidence[] = projectedMarkdown.map(
        ({ path, projectedOutcome, projectedFinalState }) => {
          if (projectedFinalState.kind !== "markdown") {
            throw new Error("Projected snapshot evidence is invalid");
          }
          return {
            path,
            contentVersion: projectedFinalState.contentVersion,
            requireSemanticMatch: projectedOutcome === "changed",
          };
        },
      );
      if (hasSemanticOperations) {
        await execution.awaitSemanticEvidence?.(semanticRequest);
        await this.#crash("after_semantic_evidence");
        if (execution.semanticEvidencePublishesSnapshot !== true) {
          await execution.publishSearchSnapshot(snapshotTargets);
        }
        for (const mutation of mutations) {
          if (mutation.kind !== "trash") continue;
          const trashBytes = await execution.readTrash?.(mutation.trashId);
          if (
            trashBytes === undefined ||
            trashBytes === null ||
            !bytesMatchState(
              Uint8Array.from(
                trashBytes instanceof Uint8Array ? trashBytes : new Uint8Array(trashBytes),
              ),
              mutation.before,
            )
          ) {
            throw new Error("Managed trash evidence changed during the success barrier");
          }
        }
      } else {
        await execution.publishSearchSnapshot(snapshotTargets);
      }
      const finalPaths: Extract<ChangeSetRecord, { state: "intent_applied" }>["paths"] = [];
      for (const projected of plan.preview.paths) {
        if (projected.projectedFinalState.kind === "directory") {
          if ((await execution.pathKind(projected.path)) !== "directory") {
            throw new Error("Final directory evidence changed during the success barrier");
          }
        } else {
          const file = files.find(({ path }) => path === projected.path);
          if (
            file === undefined ||
            !(await executionPathMatches(execution, file.path, file.expectedAfter))
          ) {
            throw new Error("Final file evidence changed during the success barrier");
          }
        }
        finalPaths.push({
          path: projected.path,
          outcome: projected.projectedOutcome,
          finalState: projected.projectedFinalState,
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
      this.#currentExecutionId = null;
      this.#options.runtimeState?.setQueue(this.#queueState(null));
    }
  }

  async #withControlLease<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.#controlTail;
    let release!: () => void;
    this.#controlTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
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
    this.#options.runtimeState?.setQueue(this.#queueState(this.#currentExecutionId));
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
      if (!this.#recoveryBlocked && !this.#dequeuePaused) {
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

    const gate = selectOperationalGate(
      this.#admissionGate,
      requestState.effectiveGate,
    );
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
      (input.operations.every(
        ({ kind }) =>
          kind === "create_directory" ||
          kind === "create_note" ||
          kind === "edit_body" ||
          kind === "copy_attachment" ||
          kind === "move_attachment" ||
          kind === "trash",
      ) ||
        (input.operations.length === 1 &&
          input.operations[0]?.kind === "move" &&
          boundMoves?.length === 1))
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
