import { createHash, randomUUID } from "node:crypto";
import { TextDecoder } from "node:util";

import {
  parseChangeSetStatusResult,
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

export interface ChangeSetRegistryEntry {
  submissionKey: string;
  fingerprint: string;
  changeSetId: string;
  enqueueSeq: number;
  acceptedAt: number;
  expiresAt: number;
  historicalGate?: ChangeSetGate;
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

export interface ChangeSetServiceOptions {
  store: ChangeSetRegistryStore;
  dataSource: ChangeSetPreflightDataSource;
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
    return { ...entry, changeSet };
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
  const canonical = canonicalize({
    operations: input.operations,
    readDependencies: input.readDependencies ?? [],
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

type Preview = NonNullable<Extract<ChangeSetRecord, { state: "in_progress" }>["preview"]>;

interface PreflightResult {
  accepted: boolean;
  failure?: ChangeSetFailure;
  preview?: Preview;
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
  };
}

export class ChangeSetService {
  readonly #options: Required<
    Pick<ChangeSetServiceOptions, "now" | "createChangeSetId">
  > &
    Omit<ChangeSetServiceOptions, "now" | "createChangeSetId">;
  #state: ChangeSetRegistryState;
  #operationTail: Promise<void> = Promise.resolve();

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
    return new ChangeSetService(options, state);
  }

  async #serialize<T>(operation: () => Promise<T>): Promise<T> {
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
    return this.#serialize(() => this.#submitUnlocked(input, requestState));
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
