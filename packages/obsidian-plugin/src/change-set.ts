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
export const RECOVERY_JOURNAL_SCHEMA_VERSION = 2;

export interface ChangeSetExecutionState {
  phase: "queued" | "executing" | "terminal";
  input: ChangeSetSubmitInput;
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
      kind: "trash";
      operationId: string;
      path: string;
      before: RecoveryFileState;
      expectedAfter: RecoveryFileState;
      trashId: string;
    };

export interface RecoveryJournalFrame {
  schemaVersion: 1 | typeof RECOVERY_JOURNAL_SCHEMA_VERSION;
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
  finalPaths?: Extract<ChangeSetRecord, { state: "intent_applied" }>["paths"];
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
  prepareFile?(stageId: string, bytes: Uint8Array): Promise<void>;
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
  publishSearchSnapshot(): Promise<void>;
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

function recoveryBytes(state: RecoveryFileState): Uint8Array | null {
  return state.kind === "absent" ? null : Buffer.from(state.bytesBase64, "base64");
}

async function readExecutionBytes(
  execution: ChangeSetExecutionAdapter,
  path: string,
): Promise<Uint8Array | null> {
  const value = await execution.readBinary?.(path);
  if (value === undefined || value === null) return null;
  return Uint8Array.from(value instanceof Uint8Array ? value : new Uint8Array(value));
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
    const mutation = mutations[mutationIndex++];
    if (mutation === undefined || mutation.operationId !== operation.operationId) return false;
    if (operation.kind === "copy_attachment") {
      const source = states.get(operation.sourcePath);
      const destination = states.get(operation.destinationPath);
      if (
        mutation.kind !== operation.kind ||
        mutation.sourcePath !== operation.sourcePath ||
        mutation.destinationPath !== operation.destinationPath ||
        mutation.stageId !== `${frame.changeSetId}/file/${operationIndex}` ||
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
): Promise<PreflightResult> {
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
      const projection = await dataSource.projectMove?.(operation, sourceBytes);
      if (projection === undefined || projection === null) return { accepted: false };
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

  #mutationPlan(
    entry: ChangeSetRegistryEntry,
  ): { input: ChangeSetSubmitInput; preview: Preview; directories: string[] } | null {
    if (
      entry.execution === undefined ||
      entry.changeSet.state !== "in_progress" ||
      entry.changeSet.preview === undefined ||
      entry.execution.input.operations.some(
        ({ kind }) =>
          kind !== "create_directory" &&
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
      if (execution.semanticEvidencePublishesSnapshot !== true) {
        await execution.publishSearchSnapshot();
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
    if (this.#options.execution === undefined || this.#recoveryBlocked) return;
    const queued = [...this.#state.entries]
      .filter((entry) => entry.execution?.phase !== "terminal")
      .sort((left, right) => left.enqueueSeq - right.enqueueSeq);
    for (const entry of queued) await this.#executeMutation(entry.changeSetId);
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
    const operationKinds = plan.input.operations.map(({ kind }) => kind);
    if (
      operationKinds.some((kind) => kind !== "create_directory") &&
      (execution.readBinary === undefined || execution.awaitSemanticEvidence === undefined)
    ) {
      throw new Error("Change Set execution adapter does not support file evidence");
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
    const fileState = (
      state: Preview["paths"][number]["preState"],
      bytes: Uint8Array | null | undefined,
    ): RecoveryFileState => {
      if (state.kind === "absent") return { kind: "absent" };
      if (state.kind === "directory" || bytes === null || bytes === undefined) {
        throw new Error("Recovery file evidence is incomplete");
      }
      const bytesBase64 = Buffer.from(bytes).toString("base64");
      return state.kind === "attachment"
        ? { kind: "attachment", sha256: state.sha256, bytesBase64 }
        : { kind: "markdown", contentVersion: state.contentVersion, bytesBase64 };
    };
    const files: RecoveryFileFootprint[] = plan.preview.paths
      .filter(
        ({ preState, projectedFinalState }) =>
          preState.kind !== "directory" && projectedFinalState.kind !== "directory",
      )
      .map(({ path, preState, projectedFinalState }) => {
        const beforeBytes = checked.observedBytes?.get(path);
        const expectedBytes = checked.projectedBytes?.has(path)
          ? checked.projectedBytes.get(path)
          : beforeBytes;
        return {
          path,
          before: fileState(preState, beforeBytes),
          expectedAfter: fileState(projectedFinalState, expectedBytes),
        };
      });
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
            stageId: `${entry.changeSetId}/file/${index}`,
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
      schemaVersion: RECOVERY_JOURNAL_SCHEMA_VERSION,
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
      ...(files.length === 0 ? {} : { files }),
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
      await execution.beginSemanticEvidence?.(semanticRequest);
      let mutationIndex = 0;
      for (const directory of plan.directories) {
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
      for (const mutation of mutations) {
        if (mutation.kind === "copy_attachment") {
          const bytes = recoveryBytes(mutation.sourceState);
          if (bytes === null) throw new Error("Attachment source evidence is incomplete");
          await execution.prepareFile!(mutation.stageId, bytes);
          await execution.publishFile!(mutation.stageId, mutation.destinationPath);
        } else if (mutation.kind === "move_attachment") {
          await execution.moveFile!(mutation.sourcePath, mutation.destinationPath);
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
      await execution.awaitSemanticEvidence?.(semanticRequest);
      await this.#crash("after_semantic_evidence");
      if (execution.semanticEvidencePublishesSnapshot !== true) {
        await execution.publishSearchSnapshot();
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
        await this.#executeMutation(registered.changeSet.changeSetId);
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
    if (gate?.code === "recovery_blocked") {
      changeSet = { changeSetId, state: "intent_not_applied" };
      historicalGate = gate;
    } else {
      const checked = await preflight(this.#options.dataSource, input);
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
      input.operations.every(
        ({ kind }) =>
          kind === "create_directory" ||
          kind === "copy_attachment" ||
          kind === "move_attachment" ||
          kind === "trash",
      )
        ? {
            execution: {
              phase: "queued" as const,
              input: structuredClone(input),
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
