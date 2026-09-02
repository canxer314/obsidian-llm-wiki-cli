import { createHash, randomBytes } from "node:crypto";

import type { RecoveryJournalDiagnosticFacts } from "./recovery-journal.js";

/**
 * Fixed, closed, versioned standard diagnostic bundle (spec §9.4, PR #28).
 *
 * The producer accepts only the narrow operational evidence described by
 * {@link StandardDiagnosticEvidence}; anything else fails before a bundle is
 * emitted. The emitted payload contains the closed health summary, listener
 * and queue timelines, lifecycle outcomes, Recovery Journal frame/checksum
 * facts without before images, filtered machine codes and path-free stack
 * symbols, stable within-bundle aliases or irreversible Submission Key
 * digests, and a verifiable checksum over the canonical redacted content.
 *
 * The bundle is generated only through a local interactive Primary Operator
 * command; it is never an MCP tool result.
 */

export const STANDARD_DIAGNOSTIC_BUNDLE_SCHEMA_VERSION = 1;
export const STANDARD_DIAGNOSTIC_BUNDLE_VERSION = "1.0";

const MACHINE_CODES = [
  "content_tools_not_ready",
  "search_snapshot_building",
  "search_snapshot_unavailable",
  "writes_paused",
  "mutation_executor_not_ready",
  "upgrade_failed",
  "upgrade_in_progress",
  "recovery_blocked",
  "recovery_in_progress",
] as const;

type MachineCode = (typeof MACHINE_CODES)[number];

const readinessStates = ["ready", "building", "unavailable"] as const;
const recoveryStates = ["none", "in_progress", "blocked"] as const;
const overallStates = ["healthy", "degraded", "blocked"] as const;
const operatorActions = [
  "none",
  "finish_initialization",
  "wait_for_readiness",
  "wait_for_recovery",
  "review_recovery",
  "resume_writes",
  "finish_upgrade",
] as const;
const gateCodes = [
  "writes_paused",
  "upgrade_in_progress",
  "recovery_in_progress",
  "recovery_blocked",
] as const;
const lifecycleStartupStates = ["ready", "failed"] as const;
const lifecycleOutcomeStates = ["not_run", "succeeded", "failed"] as const;
const changeSetStates = [
  "in_progress",
  "intent_applied",
  "intent_not_applied",
  "result_unproven",
] as const;
const executionPhases = ["queued", "executing", "terminal"] as const;
const journalFrameStates = ["empty", "invalid", "valid"] as const;
const journalChecksumStates = ["not_present", "invalid", "valid"] as const;
const journalPhases = ["PREPARED", "COMMITTED", "ROLLED_BACK", "FAILED"] as const;

type ReadinessState = (typeof readinessStates)[number];
type RecoveryState = (typeof recoveryStates)[number];
type OverallState = (typeof overallStates)[number];
type OperatorAction = (typeof operatorActions)[number];
type GateCode = (typeof gateCodes)[number];
type ChangeSetState = (typeof changeSetStates)[number];
type ExecutionPhase = (typeof executionPhases)[number];
type JournalPhase = (typeof journalPhases)[number];

interface ReadinessField {
  readonly searchSnapshot: ReadinessState;
  readonly cache: ReadinessState;
  readonly index: ReadinessState;
}

interface WriteField {
  readonly gate: "open" | "blocked";
  readonly state: "writable" | "pausing" | "paused";
  readonly pauseSource: "manual" | "maintenance" | null;
}

interface HealthField {
  readonly readiness: ReadinessField;
  readonly recovery: RecoveryState;
  readonly write: WriteField;
  readonly effectiveGate: GateCode | null;
  readonly overall: OverallState;
  readonly reasonCodes: readonly MachineCode[];
  readonly operatorAction: OperatorAction;
}

/** Runtime and protocol versions shared by the standard evidence seam. */
export interface VersionField {
  readonly bridge: string;
  readonly plugin: string;
  readonly protocol: string;
  readonly persistentStateSchema: number;
  readonly recoveryJournalSchema: number;
}

interface LifecycleField {
  readonly startup: (typeof lifecycleStartupStates)[number];
  readonly upgrade: (typeof lifecycleOutcomeStates)[number];
  readonly migration: (typeof lifecycleOutcomeStates)[number];
  readonly recovery: (typeof lifecycleOutcomeStates)[number];
}

interface ChangeSetEvidenceEntry {
  readonly changeSetId: string;
  readonly submissionKey: string;
  readonly enqueueSeq: number;
  readonly state: ChangeSetState;
  readonly executionPhase: ExecutionPhase | null;
}

interface MachineEvent {
  readonly sequence: number;
  readonly code: MachineCode;
  readonly stackSymbols: readonly string[];
}

/** Allowed operational evidence accepted by the closed bundle producer. */
export interface StandardDiagnosticEvidence {
  readonly vaultId: string;
  readonly versions: VersionField;
  readonly health: HealthField;
  readonly listener: { readonly address: "127.0.0.1"; readonly port: number };
  readonly queue: {
    readonly currentExecutionId: string | null;
    readonly length: number;
    readonly headChangeSetId: string | null;
  };
  readonly lifecycle: LifecycleField;
  readonly journal: RecoveryJournalDiagnosticFacts;
  readonly changeSets: readonly ChangeSetEvidenceEntry[];
  readonly machineEvents: readonly MachineEvent[];
}

type RedactedJournalFacts =
  | {
      readonly availability: "unavailable";
      readonly frames: readonly [];
    }
  | {
      readonly availability: "available";
      readonly journalVersion: number;
      readonly headerChecksum: "valid";
      readonly frames: readonly RedactedJournalFrame[];
    };

type RedactedJournalFrame =
  | { readonly slot: 0 | 1; readonly state: "empty"; readonly checksum: "not_present" }
  | { readonly slot: 0 | 1; readonly state: "invalid"; readonly checksum: "invalid" }
  | {
      readonly slot: 0 | 1;
      readonly state: "valid";
      readonly checksum: "valid";
      readonly sequence: number;
      readonly phase: JournalPhase;
      readonly frameSchemaVersion: number;
      readonly changeSetAlias: string;
    };

/** The redacted, versioned bundle content (the checksum covers this exactly). */
export interface StandardDiagnosticBundleContent {
  readonly schemaVersion: typeof STANDARD_DIAGNOSTIC_BUNDLE_SCHEMA_VERSION;
  readonly bundleVersion: typeof STANDARD_DIAGNOSTIC_BUNDLE_VERSION;
  readonly vault: { readonly alias: string };
  readonly versions: VersionField;
  readonly health: HealthField;
  readonly listenerTimeline: readonly {
    readonly ordinal: 1;
    readonly state: "listening";
    readonly address: "loopback";
    readonly port: number;
  }[];
  readonly queueTimeline: readonly {
    readonly ordinal: 1;
    readonly currentExecutionAlias: string | null;
    readonly length: number;
    readonly headChangeSetAlias: string | null;
  }[];
  readonly lifecycleOutcomes: LifecycleField;
  readonly journal: RedactedJournalFacts;
  readonly changeSetOutcomes: readonly {
    readonly changeSetAlias: string;
    readonly submissionKeyDigest: string;
    readonly enqueueSeq: number;
    readonly state: ChangeSetState;
    readonly executionPhase: ExecutionPhase | null;
  }[];
  readonly machineEvents: readonly MachineEvent[];
}

export interface StandardDiagnosticBundle extends StandardDiagnosticBundleContent {
  readonly checksum: {
    readonly algorithm: "sha256";
    readonly canonicalPayload: string;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function incompatible(location: string): TypeError {
  return new TypeError(`Standard diagnostic evidence is incompatible at ${location}`);
}

function requireRecord(value: unknown, keys: readonly string[], location: string): Record<string, unknown> {
  if (!isRecord(value) || !hasOnlyKeys(value, keys)) {
    throw incompatible(location);
  }
  return value;
}

function requireExactRecord(
  value: unknown,
  keys: readonly string[],
  location: string,
): Record<string, unknown> {
  const record = requireRecord(value, keys, location);
  if (Object.keys(record).length !== keys.length) throw incompatible(location);
  return record;
}

function requireString(value: unknown, location: string): string {
  if (typeof value !== "string" || value.length === 0) throw incompatible(location);
  return value;
}

function requireNullableString(value: unknown, location: string): string | null {
  return value === null ? null : requireString(value, location);
}

function requireInteger(
  value: unknown,
  location: string,
  minimum = 0,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < minimum ||
    (value as number) > maximum
  ) {
    throw incompatible(location);
  }
  return value as number;
}

function requireOneOf<const T extends readonly string[]>(
  value: unknown,
  allowed: T,
  location: string,
): T[number] {
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
    throw incompatible(location);
  }
  return value as T[number];
}

function requireStringArray(value: unknown, location: string): string[] {
  if (!Array.isArray(value)) throw incompatible(location);
  return value.map((item, index) => requireString(item, `${location}[${index}]`));
}

const SHA256_DIGEST = /^sha256:[0-9a-f]{64}$/u;

/** Path-free stack symbol: an identifier chain, never a filesystem path. */
function isPathFreeStackSymbol(value: string): boolean {
  return /^[A-Za-z_$][A-Za-z0-9_$]*(?:[.#][A-Za-z_$][A-Za-z0-9_$]*)*$/u.test(value);
}

function parseVersionField(value: unknown, location: string): VersionField {
  const record = requireExactRecord(
    value,
    ["bridge", "plugin", "protocol", "persistentStateSchema", "recoveryJournalSchema"],
    location,
  );
  const protocol = requireString(record.protocol, `${location}.protocol`);
  if (!/^\d+\.\d+$/u.test(protocol)) throw incompatible(`${location}.protocol`);
  return {
    bridge: requireString(record.bridge, `${location}.bridge`),
    plugin: requireString(record.plugin, `${location}.plugin`),
    protocol,
    persistentStateSchema: requireInteger(
      record.persistentStateSchema,
      `${location}.persistentStateSchema`,
      1,
    ),
    recoveryJournalSchema: requireInteger(
      record.recoveryJournalSchema,
      `${location}.recoveryJournalSchema`,
      1,
    ),
  };
}

function parseReadinessField(value: unknown, location: string): ReadinessField {
  const record = requireExactRecord(
    value,
    ["searchSnapshot", "cache", "index"],
    location,
  );
  return {
    searchSnapshot: requireOneOf(record.searchSnapshot, readinessStates, `${location}.searchSnapshot`),
    cache: requireOneOf(record.cache, readinessStates, `${location}.cache`),
    index: requireOneOf(record.index, readinessStates, `${location}.index`),
  };
}

function parseHealthField(value: unknown, location: string): HealthField {
  const record = requireExactRecord(
    value,
    ["readiness", "recovery", "write", "effectiveGate", "overall", "reasonCodes", "operatorAction"],
    location,
  );
  const write = requireExactRecord(record.write, ["gate", "state", "pauseSource"], `${location}.write`);
  const reasonCodes = requireStringArray(record.reasonCodes, `${location}.reasonCodes`).map(
    (code, index) => requireOneOf(code, MACHINE_CODES, `${location}.reasonCodes[${index}]`),
  );
  if (new Set(reasonCodes).size !== reasonCodes.length) {
    throw incompatible(`${location}.reasonCodes`);
  }
  return {
    readiness: parseReadinessField(record.readiness, `${location}.readiness`),
    recovery: requireOneOf(record.recovery, recoveryStates, `${location}.recovery`),
    write: {
      gate: requireOneOf(write.gate, ["open", "blocked"] as const, `${location}.write.gate`),
      state: requireOneOf(write.state, ["writable", "pausing", "paused"] as const, `${location}.write.state`),
      pauseSource:
        write.pauseSource === null
          ? null
          : requireOneOf(
              write.pauseSource,
              ["manual", "maintenance"] as const,
              `${location}.write.pauseSource`,
            ),
    },
    effectiveGate:
      record.effectiveGate === null
        ? null
        : requireOneOf(record.effectiveGate, gateCodes, `${location}.effectiveGate`),
    overall: requireOneOf(record.overall, overallStates, `${location}.overall`),
    reasonCodes,
    operatorAction: requireOneOf(record.operatorAction, operatorActions, `${location}.operatorAction`),
  };
}

function parseLifecycleField(value: unknown, location: string): LifecycleField {
  const record = requireExactRecord(
    value,
    ["startup", "upgrade", "migration", "recovery"],
    location,
  );
  return {
    startup: requireOneOf(record.startup, lifecycleStartupStates, `${location}.startup`),
    upgrade: requireOneOf(record.upgrade, lifecycleOutcomeStates, `${location}.upgrade`),
    migration: requireOneOf(record.migration, lifecycleOutcomeStates, `${location}.migration`),
    recovery: requireOneOf(record.recovery, lifecycleOutcomeStates, `${location}.recovery`),
  };
}

function parseJournalFacts(value: unknown, location: string): RecoveryJournalDiagnosticFacts {
  const record = requireRecord(
    value,
    ["availability", "journalVersion", "headerChecksum", "frames"],
    location,
  );
  const availability = requireOneOf(
    record.availability,
    ["available", "unavailable"] as const,
    `${location}.availability`,
  );
  if (availability === "unavailable") {
    if (
      Object.keys(record).length !== 2 ||
      !Array.isArray(record.frames) ||
      record.frames.length !== 0
    ) {
      throw incompatible(location);
    }
    return { availability, frames: [] };
  }
  if (Object.keys(record).length !== 4 || record.headerChecksum !== "valid") {
    throw incompatible(location);
  }
  const journalVersion = requireInteger(record.journalVersion, `${location}.journalVersion`, 1);
  if (!Array.isArray(record.frames)) throw incompatible(`${location}.frames`);
  const seenSlots = new Set<number>();
  const frames = record.frames.map((raw, index) => {
    const frame = requireRecord(
      raw,
      ["slot", "state", "checksum", "sequence", "phase", "frameSchemaVersion", "changeSetId"],
      `${location}.frames[${index}]`,
    );
    const slot = requireInteger(frame.slot, `${location}.frames[${index}].slot`, 0, 1) as 0 | 1;
    if (seenSlots.has(slot)) {
      throw incompatible(`${location}.frames[${index}].slot`);
    }
    seenSlots.add(slot);
    const state = requireOneOf(
      frame.state,
      journalFrameStates,
      `${location}.frames[${index}].state`,
    );
    const checksum = requireOneOf(
      frame.checksum,
      journalChecksumStates,
      `${location}.frames[${index}].checksum`,
    );
    if (state !== "valid") {
      if (
        (state === "empty" && checksum !== "not_present") ||
        (state === "invalid" && checksum !== "invalid") ||
        Object.keys(frame).length !== 3
      ) {
        throw incompatible(`${location}.frames[${index}]`);
      }
      return { slot, state, checksum };
    }
    if (checksum !== "valid" || Object.keys(frame).length !== 7) {
      throw incompatible(`${location}.frames[${index}]`);
    }
    return {
      slot,
      state,
      checksum,
      sequence: requireInteger(frame.sequence, `${location}.frames[${index}].sequence`, 1),
      phase: requireOneOf(
        frame.phase,
        journalPhases,
        `${location}.frames[${index}].phase`,
      ),
      frameSchemaVersion: requireInteger(
        frame.frameSchemaVersion,
        `${location}.frames[${index}].frameSchemaVersion`,
        1,
      ),
      changeSetId: requireString(frame.changeSetId, `${location}.frames[${index}].changeSetId`),
    };
  });
  if (seenSlots.size !== 2) throw incompatible(`${location}.frames`);
  return { availability, journalVersion, headerChecksum: "valid", frames };
}

function parseChangeSetEvidenceEntries(value: unknown, location: string): ChangeSetEvidenceEntry[] {
  if (!Array.isArray(value)) throw incompatible(location);
  const changeSetIds = new Set<string>();
  const submissionKeys = new Set<string>();
  const enqueueSequences = new Set<number>();
  return value.map((raw, index) => {
    const entry = requireExactRecord(
      raw,
      ["changeSetId", "submissionKey", "enqueueSeq", "state", "executionPhase"],
      `${location}[${index}]`,
    );
    const changeSetId = requireString(entry.changeSetId, `${location}[${index}].changeSetId`);
    const submissionKey = requireString(entry.submissionKey, `${location}[${index}].submissionKey`);
    const enqueueSeq = requireInteger(entry.enqueueSeq, `${location}[${index}].enqueueSeq`, 1);
    if (
      changeSetIds.has(changeSetId) ||
      submissionKeys.has(submissionKey) ||
      enqueueSequences.has(enqueueSeq)
    ) {
      throw incompatible(`${location}[${index}]`);
    }
    changeSetIds.add(changeSetId);
    submissionKeys.add(submissionKey);
    enqueueSequences.add(enqueueSeq);
    return {
      changeSetId,
      submissionKey,
      enqueueSeq,
      state: requireOneOf(entry.state, changeSetStates, `${location}[${index}].state`),
      executionPhase:
        entry.executionPhase === null
          ? null
          : requireOneOf(entry.executionPhase, executionPhases, `${location}[${index}].executionPhase`),
    };
  });
}

function parseMachineEvents(value: unknown, location: string): MachineEvent[] {
  if (!Array.isArray(value)) throw incompatible(location);
  let previousSequence = 0;
  return value.map((raw, index) => {
    const event = requireExactRecord(raw, ["sequence", "code", "stackSymbols"], `${location}[${index}]`);
    const sequence = requireInteger(event.sequence, `${location}[${index}].sequence`, 1);
    if (sequence <= previousSequence) throw incompatible(`${location}[${index}].sequence`);
    previousSequence = sequence;
    const stackSymbols = requireStringArray(
      event.stackSymbols,
      `${location}[${index}].stackSymbols`,
    );
    if (!stackSymbols.every(isPathFreeStackSymbol)) {
      throw incompatible(`${location}[${index}].stackSymbols`);
    }
    return {
      sequence,
      code: requireOneOf(event.code, MACHINE_CODES, `${location}[${index}].code`),
      stackSymbols,
    };
  });
}

/**
 * Strictly parses one standard evidence object against the closed grammar.
 * The content-inclusive diagnostic producer reuses this same evidence seam so
 * both producers accept only the same narrow operational evidence and fail
 * closed on any unknown or content-bearing source field.
 */
export function parseEvidence(value: unknown): StandardDiagnosticEvidence {
  const root = requireExactRecord(
    value,
    [
      "vaultId",
      "versions",
      "health",
      "listener",
      "queue",
      "lifecycle",
      "journal",
      "changeSets",
      "machineEvents",
    ],
    "root",
  );
  const listener = requireExactRecord(root.listener, ["address", "port"], "listener");
  if (listener.address !== "127.0.0.1") throw incompatible("listener.address");
  const queue = requireExactRecord(
    root.queue,
    ["currentExecutionId", "length", "headChangeSetId"],
    "queue",
  );
  return {
    vaultId: requireString(root.vaultId, "vaultId"),
    versions: parseVersionField(root.versions, "versions"),
    health: parseHealthField(root.health, "health"),
    listener: {
      address: "127.0.0.1",
      port: requireInteger(listener.port, "listener.port", 1, 65_535),
    },
    queue: {
      currentExecutionId: requireNullableString(
        queue.currentExecutionId,
        "queue.currentExecutionId",
      ),
      length: requireInteger(queue.length, "queue.length"),
      headChangeSetId: requireNullableString(queue.headChangeSetId, "queue.headChangeSetId"),
    },
    lifecycle: parseLifecycleField(root.lifecycle, "lifecycle"),
    journal: parseJournalFacts(root.journal, "journal"),
    changeSets: parseChangeSetEvidenceEntries(root.changeSets, "changeSets"),
    machineEvents: parseMachineEvents(root.machineEvents, "machineEvents"),
  };
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => compareCodeUnits(left, right))
      .map(([key, member]) => [key, canonicalize(member)]),
  );
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Serializes the redacted bundle content canonically so a copied bundle's
 * checksum can be recomputed without the correlation salt or source data.
 */
export function canonicalizeDiagnosticPayload(payload: StandardDiagnosticBundleContent): string {
  return JSON.stringify(canonicalize(payload));
}

function sha256Digest(value: string | Uint8Array): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

const ALIAS_LABELS: Record<"vault" | "change-set", string> = {
  vault: "vault",
  "change-set": "change_set",
};

/**
 * Per-bundle opaque aliases. The salt is generated fresh for every bundle and
 * never emitted, so equal identifiers correlate only within one bundle and no
 * cross-bundle correlation is introduced. Submission Keys are digested
 * irreversibly with the same salt.
 */
class CorrelationAliases {
  readonly #salt: Uint8Array;
  readonly #aliases = new Map<string, string>();

  constructor(salt: Uint8Array) {
    if (salt.byteLength !== 32) throw new TypeError("Diagnostic correlation salt is invalid");
    this.#salt = Uint8Array.from(salt);
  }

  #frame(...parts: readonly string[]): Buffer {
    return Buffer.from(JSON.stringify(parts), "utf8");
  }

  alias(kind: "vault" | "change-set", value: string): string {
    const key = this.#frame(kind, value).toString("utf8");
    const existing = this.#aliases.get(key);
    if (existing !== undefined) return existing;
    const digest = sha256Digest(
      Buffer.concat([Buffer.from(this.#salt), this.#frame(kind, value)]),
    ).slice("sha256:".length);
    const alias = `${ALIAS_LABELS[kind]}_${digest.slice(0, 32)}`;
    this.#aliases.set(key, alias);
    return alias;
  }

  submissionKeyDigest(value: string): string {
    return sha256Digest(
      Buffer.concat([Buffer.from(this.#salt), this.#frame("submission-key", value)]),
    );
  }
}

function redactJournal(
  journal: RecoveryJournalDiagnosticFacts,
  aliases: CorrelationAliases,
): RedactedJournalFacts {
  if (journal.availability === "unavailable") return { availability: "unavailable", frames: [] };
  return {
    availability: "available",
    journalVersion: journal.journalVersion as number,
    headerChecksum: "valid",
    frames: [...journal.frames]
      .sort((left, right) => left.slot - right.slot)
      .map((frame): RedactedJournalFrame => {
        if (frame.state === "empty") {
          return { slot: frame.slot, state: "empty", checksum: "not_present" };
        }
        if (frame.state === "invalid") {
          return { slot: frame.slot, state: "invalid", checksum: "invalid" };
        }
        return {
          slot: frame.slot,
          state: "valid",
          checksum: "valid",
          sequence: frame.sequence as number,
          phase: frame.phase as JournalPhase,
          frameSchemaVersion: frame.frameSchemaVersion as number,
          changeSetAlias: aliases.alias("change-set", frame.changeSetId as string),
        };
      }),
  };
}

/**
 * Produces one fixed, closed standard diagnostic bundle. The evidence input is
 * validated against a strict closed grammar, so unknown or content-bearing
 * source fields fail before any bundle is emitted.
 */
export function createStandardDiagnosticBundle(evidence: unknown): StandardDiagnosticBundle {
  const parsed = parseEvidence(evidence);
  const aliases = new CorrelationAliases(randomBytes(32));
  const content: StandardDiagnosticBundleContent = {
    schemaVersion: STANDARD_DIAGNOSTIC_BUNDLE_SCHEMA_VERSION,
    bundleVersion: STANDARD_DIAGNOSTIC_BUNDLE_VERSION,
    vault: { alias: aliases.alias("vault", parsed.vaultId) },
    versions: parsed.versions,
    health: parsed.health,
    listenerTimeline: [
      {
        ordinal: 1,
        state: "listening",
        address: "loopback",
        port: parsed.listener.port,
      },
    ],
    queueTimeline: [
      {
        ordinal: 1,
        currentExecutionAlias:
          parsed.queue.currentExecutionId === null
            ? null
            : aliases.alias("change-set", parsed.queue.currentExecutionId),
        length: parsed.queue.length,
        headChangeSetAlias:
          parsed.queue.headChangeSetId === null
            ? null
            : aliases.alias("change-set", parsed.queue.headChangeSetId),
      },
    ],
    lifecycleOutcomes: parsed.lifecycle,
    journal: redactJournal(parsed.journal, aliases),
    changeSetOutcomes: [...parsed.changeSets]
      .sort((left, right) => left.enqueueSeq - right.enqueueSeq)
      .map((entry) => ({
        changeSetAlias: aliases.alias("change-set", entry.changeSetId),
        submissionKeyDigest: aliases.submissionKeyDigest(entry.submissionKey),
        enqueueSeq: entry.enqueueSeq,
        state: entry.state,
        executionPhase: entry.executionPhase,
      })),
    machineEvents: parsed.machineEvents,
  };
  return {
    ...content,
    checksum: {
      algorithm: "sha256",
      canonicalPayload: sha256Digest(canonicalizeDiagnosticPayload(content)),
    },
  };
}

function parseRedactedJournal(value: unknown, location: string): RedactedJournalFacts {
  const record = requireRecord(
    value,
    ["availability", "journalVersion", "headerChecksum", "frames"],
    location,
  );
  const availability = requireOneOf(
    record.availability,
    ["available", "unavailable"] as const,
    `${location}.availability`,
  );
  if (availability === "unavailable") {
    if (
      Object.keys(record).length !== 2 ||
      !Array.isArray(record.frames) ||
      record.frames.length !== 0
    ) {
      throw incompatible(location);
    }
    return { availability, frames: [] };
  }
  if (Object.keys(record).length !== 4 || record.headerChecksum !== "valid") {
    throw incompatible(location);
  }
  const journalVersion = requireInteger(record.journalVersion, `${location}.journalVersion`, 1);
  if (!Array.isArray(record.frames)) throw incompatible(`${location}.frames`);
  const seenSlots = new Set<number>();
  const frames = record.frames.map((raw, index) => {
    const frame = requireRecord(
      raw,
      ["slot", "state", "checksum", "sequence", "phase", "frameSchemaVersion", "changeSetAlias"],
      `${location}.frames[${index}]`,
    );
    const slot = requireInteger(frame.slot, `${location}.frames[${index}].slot`, 0, 1) as 0 | 1;
    if (seenSlots.has(slot)) throw incompatible(`${location}.frames[${index}].slot`);
    seenSlots.add(slot);
    const state = requireOneOf(
      frame.state,
      journalFrameStates,
      `${location}.frames[${index}].state`,
    );
    const checksum = requireOneOf(
      frame.checksum,
      journalChecksumStates,
      `${location}.frames[${index}].checksum`,
    );
    if (state === "empty") {
      if (
        checksum !== "not_present" ||
        Object.keys(frame).length !== 3
      ) {
        throw incompatible(`${location}.frames[${index}]`);
      }
      return { slot, state: "empty" as const, checksum: "not_present" as const };
    }
    if (state === "invalid") {
      if (
        checksum !== "invalid" ||
        Object.keys(frame).length !== 3
      ) {
        throw incompatible(`${location}.frames[${index}]`);
      }
      return { slot, state: "invalid" as const, checksum: "invalid" as const };
    }
    if (checksum !== "valid" || Object.keys(frame).length !== 7) {
      throw incompatible(`${location}.frames[${index}]`);
    }
    const changeSetAlias = requireString(
      frame.changeSetAlias,
      `${location}.frames[${index}].changeSetAlias`,
    );
    if (!/^change_set_[0-9a-f]{32}$/u.test(changeSetAlias)) {
      throw incompatible(`${location}.frames[${index}].changeSetAlias`);
    }
    return {
      slot,
      state: "valid" as const,
      checksum: "valid" as const,
      sequence: requireInteger(frame.sequence, `${location}.frames[${index}].sequence`, 1),
      phase: requireOneOf(
        frame.phase,
        journalPhases,
        `${location}.frames[${index}].phase`,
      ),
      frameSchemaVersion: requireInteger(
        frame.frameSchemaVersion,
        `${location}.frames[${index}].frameSchemaVersion`,
        1,
      ),
      changeSetAlias,
    };
  });
  if (seenSlots.size !== 2) throw incompatible(`${location}.frames`);
  return { availability, journalVersion, headerChecksum: "valid", frames };
}

function parseRedactedBundle(value: unknown): StandardDiagnosticBundleContent {
  const root = requireExactRecord(
    value,
    [
      "schemaVersion",
      "bundleVersion",
      "vault",
      "versions",
      "health",
      "listenerTimeline",
      "queueTimeline",
      "lifecycleOutcomes",
      "journal",
      "changeSetOutcomes",
      "machineEvents",
      "checksum",
    ],
    "root",
  );
  if (
    root.schemaVersion !== STANDARD_DIAGNOSTIC_BUNDLE_SCHEMA_VERSION ||
    root.bundleVersion !== STANDARD_DIAGNOSTIC_BUNDLE_VERSION
  ) {
    throw incompatible("root.schemaVersion");
  }
  const vault = requireExactRecord(root.vault, ["alias"], "vault");
  const alias = requireString(vault.alias, "vault.alias");
  if (!/^vault_[0-9a-f]{32}$/u.test(alias)) throw incompatible("vault.alias");

  if (!Array.isArray(root.listenerTimeline) || root.listenerTimeline.length !== 1) {
    throw incompatible("listenerTimeline");
  }
  const listenerEntry = requireExactRecord(
    root.listenerTimeline[0],
    ["ordinal", "state", "address", "port"],
    "listenerTimeline[0]",
  );
  if (
    listenerEntry.ordinal !== 1 ||
    listenerEntry.state !== "listening" ||
    listenerEntry.address !== "loopback"
  ) {
    throw incompatible("listenerTimeline[0]");
  }
  requireInteger(listenerEntry.port, "listenerTimeline[0].port", 1, 65_535);

  if (!Array.isArray(root.queueTimeline) || root.queueTimeline.length !== 1) {
    throw incompatible("queueTimeline");
  }
  const queueEntry = requireExactRecord(
    root.queueTimeline[0],
    ["ordinal", "currentExecutionAlias", "length", "headChangeSetAlias"],
    "queueTimeline[0]",
  );
  if (queueEntry.ordinal !== 1) throw incompatible("queueTimeline[0]");
  const currentExecutionAlias = requireNullableString(
    queueEntry.currentExecutionAlias,
    "queueTimeline[0].currentExecutionAlias",
  );
  const headChangeSetAlias = requireNullableString(
    queueEntry.headChangeSetAlias,
    "queueTimeline[0].headChangeSetAlias",
  );
  if (
    (currentExecutionAlias !== null && !/^change_set_[0-9a-f]{32}$/u.test(currentExecutionAlias)) ||
    (headChangeSetAlias !== null && !/^change_set_[0-9a-f]{32}$/u.test(headChangeSetAlias))
  ) {
    throw incompatible("queueTimeline[0]");
  }
  requireInteger(queueEntry.length, "queueTimeline[0].length");

  if (!Array.isArray(root.changeSetOutcomes)) throw incompatible("changeSetOutcomes");
  const enqueueSequences = new Set<number>();
  const changeSetOutcomes = root.changeSetOutcomes.map((raw, index) => {
    const entry = requireExactRecord(
      raw,
      ["changeSetAlias", "submissionKeyDigest", "enqueueSeq", "state", "executionPhase"],
      `changeSetOutcomes[${index}]`,
    );
    const changeSetAlias = requireString(
      entry.changeSetAlias,
      `changeSetOutcomes[${index}].changeSetAlias`,
    );
    if (!/^change_set_[0-9a-f]{32}$/u.test(changeSetAlias)) {
      throw incompatible(`changeSetOutcomes[${index}].changeSetAlias`);
    }
    const submissionKeyDigest = requireString(
      entry.submissionKeyDigest,
      `changeSetOutcomes[${index}].submissionKeyDigest`,
    );
    if (!SHA256_DIGEST.test(submissionKeyDigest)) {
      throw incompatible(`changeSetOutcomes[${index}].submissionKeyDigest`);
    }
    const enqueueSeq = requireInteger(
      entry.enqueueSeq,
      `changeSetOutcomes[${index}].enqueueSeq`,
      1,
    );
    if (enqueueSequences.has(enqueueSeq)) {
      throw incompatible(`changeSetOutcomes[${index}].enqueueSeq`);
    }
    enqueueSequences.add(enqueueSeq);
    return {
      changeSetAlias,
      submissionKeyDigest,
      enqueueSeq,
      state: requireOneOf(entry.state, changeSetStates, `changeSetOutcomes[${index}].state`),
      executionPhase:
        entry.executionPhase === null
          ? null
          : requireOneOf(
              entry.executionPhase,
              executionPhases,
              `changeSetOutcomes[${index}].executionPhase`,
            ),
    };
  });

  const checksum = requireExactRecord(
    root.checksum,
    ["algorithm", "canonicalPayload"],
    "checksum",
  );
  if (checksum.algorithm !== "sha256") throw incompatible("checksum.algorithm");
  const canonicalPayload = requireString(checksum.canonicalPayload, "checksum.canonicalPayload");
  if (!SHA256_DIGEST.test(canonicalPayload)) throw incompatible("checksum.canonicalPayload");

  const content: StandardDiagnosticBundleContent = {
    schemaVersion: STANDARD_DIAGNOSTIC_BUNDLE_SCHEMA_VERSION,
    bundleVersion: STANDARD_DIAGNOSTIC_BUNDLE_VERSION,
    vault: { alias },
    versions: parseVersionField(root.versions, "versions"),
    health: parseHealthField(root.health, "health"),
    listenerTimeline: [
      {
        ordinal: 1,
        state: "listening",
        address: "loopback",
        port: requireInteger(listenerEntry.port, "listenerTimeline[0].port", 1, 65_535),
      },
    ],
    queueTimeline: [
      {
        ordinal: 1,
        currentExecutionAlias,
        length: requireInteger(queueEntry.length, "queueTimeline[0].length"),
        headChangeSetAlias,
      },
    ],
    lifecycleOutcomes: parseLifecycleField(root.lifecycleOutcomes, "lifecycleOutcomes"),
    journal: parseRedactedJournal(root.journal, "journal"),
    changeSetOutcomes,
    machineEvents: parseMachineEvents(root.machineEvents, "machineEvents"),
  };
  const expected = sha256Digest(canonicalizeDiagnosticPayload(content));
  if (canonicalPayload !== expected) throw incompatible("checksum.canonicalPayload");
  return content;
}

/**
 * Verifies a copied bundle without needing its correlation salt or any source
 * data: the structure is closed, and the checksum is recomputed over the
 * canonical redacted content.
 */
export function verifyStandardDiagnosticBundle(value: unknown): boolean {
  try {
    parseRedactedBundle(value);
    return true;
  } catch {
    return false;
  }
}
