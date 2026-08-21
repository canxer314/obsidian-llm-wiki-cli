import { createHash, randomBytes } from "node:crypto";

import type { RecoveryJournalDiagnosticFacts } from "./recovery-journal.js";

/** The fixed, local-only standard diagnostic bundle format. */
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

const changeSetStates = [
  "in_progress",
  "intent_applied",
  "intent_not_applied",
  "result_unproven",
] as const;
const executionPhases = ["queued", "executing", "terminal"] as const;
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

export interface StandardDiagnosticEvidence {
  readonly vaultId: string;
  readonly versions: {
    readonly bridge: string;
    readonly plugin: string;
    readonly protocol: string;
    readonly persistentStateSchema: number;
    readonly recoveryJournalSchema: number;
  };
  readonly health: {
    readonly readiness: {
      readonly searchSnapshot: "ready" | "building" | "unavailable";
      readonly cache: "ready" | "building" | "unavailable";
      readonly index: "ready" | "building" | "unavailable";
    };
    readonly recovery: "none" | "in_progress" | "blocked";
    readonly write: {
      readonly gate: "open" | "blocked";
      readonly state: "writable" | "pausing" | "paused";
      readonly pauseSource: "manual" | "maintenance" | null;
    };
    readonly effectiveGate: (typeof gateCodes)[number] | null;
    readonly overall: (typeof overallStates)[number];
    readonly reasonCodes: readonly MachineCode[];
    readonly operatorAction: (typeof operatorActions)[number];
  };
  readonly listener: { readonly address: "127.0.0.1"; readonly port: number };
  readonly queue: {
    readonly currentExecutionId: string | null;
    readonly length: number;
    readonly headChangeSetId: string | null;
  };
  readonly lifecycle: {
    readonly startup: "ready" | "failed";
    readonly upgrade: "not_run" | "succeeded" | "failed";
    readonly migration: "not_run" | "succeeded" | "failed";
    readonly recovery: "not_run" | "succeeded" | "failed";
  };
  readonly journal: RecoveryJournalDiagnosticFacts;
  readonly changeSets: readonly {
    readonly changeSetId: string;
    readonly submissionKey: string;
    readonly enqueueSeq: number;
    readonly state: (typeof changeSetStates)[number];
    readonly executionPhase: (typeof executionPhases)[number] | null;
  }[];
  /** Only closed machine codes and path-free stack symbols are accepted. */
  readonly machineEvents: readonly {
    readonly sequence: number;
    readonly code: MachineCode;
    readonly stackSymbols: readonly string[];
  }[];
}

interface DiagnosticBundlePayload {
  readonly schemaVersion: typeof STANDARD_DIAGNOSTIC_BUNDLE_SCHEMA_VERSION;
  readonly bundleVersion: typeof STANDARD_DIAGNOSTIC_BUNDLE_VERSION;
  readonly vault: { readonly alias: string };
  readonly versions: StandardDiagnosticEvidence["versions"];
  readonly health: StandardDiagnosticEvidence["health"];
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
  readonly lifecycleOutcomes: StandardDiagnosticEvidence["lifecycle"];
  readonly journal: RedactedJournalFacts;
  readonly changeSetOutcomes: readonly {
    readonly changeSetAlias: string;
    readonly submissionKeyDigest: string;
    readonly enqueueSeq: number;
    readonly state: (typeof changeSetStates)[number];
    readonly executionPhase: (typeof executionPhases)[number] | null;
  }[];
  readonly machineEvents: readonly {
    readonly sequence: number;
    readonly code: MachineCode;
    readonly stackSymbols: readonly string[];
  }[];
}

export interface StandardDiagnosticBundle extends DiagnosticBundlePayload {
  readonly checksum: {
    readonly algorithm: "sha256";
    readonly canonicalPayload: string;
  };
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
      readonly frames: readonly {
        readonly slot: 0 | 1;
        readonly state: "empty" | "invalid" | "valid";
        readonly checksum: "not_present" | "invalid" | "valid";
        readonly sequence?: number;
        readonly phase?: "PREPARED" | "COMMITTED" | "ROLLED_BACK" | "FAILED";
        readonly frameSchemaVersion?: number;
        readonly changeSetAlias?: string;
      }[];
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const expected = new Set(keys);
  return Object.keys(value).every((key) => expected.has(key));
}

function requireRecord(
  value: unknown,
  keys: readonly string[],
  location: string,
): Record<string, unknown> {
  if (!isRecord(value) || !hasOnlyKeys(value, keys)) {
    throw new TypeError(`Standard diagnostic evidence is incompatible at ${location}`);
  }
  return value;
}

function requireString(value: unknown, location: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`Standard diagnostic evidence is incompatible at ${location}`);
  }
  return value;
}

function requireInteger(
  value: unknown,
  location: string,
  minimum = 0,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new TypeError(`Standard diagnostic evidence is incompatible at ${location}`);
  }
  return value as number;
}

function requireOneOf<const T extends readonly string[]>(
  value: unknown,
  allowed: T,
  location: string,
): T[number] {
  if (typeof value !== "string" || !allowed.includes(value)) {
    throw new TypeError(`Standard diagnostic evidence is incompatible at ${location}`);
  }
  return value as T[number];
}

function requireNullableString(value: unknown, location: string): string | null {
  return value === null ? null : requireString(value, location);
}

function requireStringArray(value: unknown, location: string): string[] {
  if (!Array.isArray(value)) {
    throw new TypeError(`Standard diagnostic evidence is incompatible at ${location}`);
  }
  return value.map((item, index) => requireString(item, `${location}[${index}]`));
}

function parseJournal(value: unknown): RecoveryJournalDiagnosticFacts {
  const journal = requireRecord(value, ["availability", "journalVersion", "headerChecksum", "frames"], "journal");
  const availability = requireOneOf(journal.availability, ["available", "unavailable"] as const, "journal.availability");
  if (availability === "unavailable") {
    if (
      Object.keys(journal).length !== 2 ||
      !Array.isArray(journal.frames) ||
      journal.frames.length !== 0
    ) {
      throw new TypeError("Standard diagnostic evidence is incompatible at journal");
    }
    return { availability, frames: [] };
  }
  if (
    Object.keys(journal).length !== 4 ||
    !Array.isArray(journal.frames) ||
    journal.headerChecksum !== "valid"
  ) {
    throw new TypeError("Standard diagnostic evidence is incompatible at journal");
  }
  const journalVersion = requireInteger(journal.journalVersion, "journal.journalVersion", 1);
  const seenSlots = new Set<number>();
  const frames = journal.frames.map((raw, index) => {
    const frame = requireRecord(
      raw,
      ["slot", "state", "checksum", "sequence", "phase", "frameSchemaVersion", "changeSetId"],
      `journal.frames[${index}]`,
    );
    const slot = requireInteger(frame.slot, `journal.frames[${index}].slot`, 0, 1) as 0 | 1;
    if (seenSlots.has(slot)) {
      throw new TypeError("Standard diagnostic evidence has duplicate journal slots");
    }
    seenSlots.add(slot);
    const state = requireOneOf(
      frame.state,
      ["empty", "invalid", "valid"] as const,
      `journal.frames[${index}].state`,
    );
    const checksum = requireOneOf(
      frame.checksum,
      ["not_present", "invalid", "valid"] as const,
      `journal.frames[${index}].checksum`,
    );
    if (state !== "valid") {
      if (
        (state === "empty" && checksum !== "not_present") ||
        (state === "invalid" && checksum !== "invalid") ||
        Object.keys(frame).length !== 3
      ) {
        throw new TypeError(`Standard diagnostic evidence is incompatible at journal.frames[${index}]`);
      }
      return { slot, state, checksum };
    }
    if (checksum !== "valid" || Object.keys(frame).length !== 7) {
      throw new TypeError(`Standard diagnostic evidence is incompatible at journal.frames[${index}]`);
    }
    return {
      slot,
      state,
      checksum,
      sequence: requireInteger(frame.sequence, `journal.frames[${index}].sequence`, 1),
      phase: requireOneOf(
        frame.phase,
        ["PREPARED", "COMMITTED", "ROLLED_BACK", "FAILED"] as const,
        `journal.frames[${index}].phase`,
      ),
      frameSchemaVersion: requireInteger(
        frame.frameSchemaVersion,
        `journal.frames[${index}].frameSchemaVersion`,
        1,
      ),
      changeSetId: requireString(frame.changeSetId, `journal.frames[${index}].changeSetId`),
    };
  });
  if (seenSlots.size !== 2) {
    throw new TypeError("Standard diagnostic evidence must describe both journal slots");
  }
  return { availability, journalVersion, headerChecksum: "valid", frames };
}

function parseEvidence(value: unknown): StandardDiagnosticEvidence {
  const evidence = requireRecord(
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
  if (Object.keys(evidence).length !== 9) {
    throw new TypeError("Standard diagnostic evidence is incompatible at root");
  }
  const versions = requireRecord(
    evidence.versions,
    ["bridge", "plugin", "protocol", "persistentStateSchema", "recoveryJournalSchema"],
    "versions",
  );
  if (Object.keys(versions).length !== 5) throw new TypeError("Standard diagnostic evidence is incompatible at versions");
  const health = requireRecord(
    evidence.health,
    ["readiness", "recovery", "write", "effectiveGate", "overall", "reasonCodes", "operatorAction"],
    "health",
  );
  if (Object.keys(health).length !== 7) throw new TypeError("Standard diagnostic evidence is incompatible at health");
  const readiness = requireRecord(health.readiness, ["searchSnapshot", "cache", "index"], "health.readiness");
  if (Object.keys(readiness).length !== 3) throw new TypeError("Standard diagnostic evidence is incompatible at health.readiness");
  const write = requireRecord(health.write, ["gate", "state", "pauseSource"], "health.write");
  if (Object.keys(write).length !== 3) throw new TypeError("Standard diagnostic evidence is incompatible at health.write");
  const listener = requireRecord(evidence.listener, ["address", "port"], "listener");
  if (Object.keys(listener).length !== 2 || listener.address !== "127.0.0.1") {
    throw new TypeError("Standard diagnostic evidence is incompatible at listener");
  }
  const queue = requireRecord(evidence.queue, ["currentExecutionId", "length", "headChangeSetId"], "queue");
  if (Object.keys(queue).length !== 3) throw new TypeError("Standard diagnostic evidence is incompatible at queue");
  const lifecycle = requireRecord(evidence.lifecycle, ["startup", "upgrade", "migration", "recovery"], "lifecycle");
  if (Object.keys(lifecycle).length !== 4) throw new TypeError("Standard diagnostic evidence is incompatible at lifecycle");
  if (!Array.isArray(evidence.changeSets) || !Array.isArray(evidence.machineEvents)) {
    throw new TypeError("Standard diagnostic evidence is incompatible at root");
  }
  const changeSetIds = new Set<string>();
  const submissionKeys = new Set<string>();
  const enqueueSequences = new Set<number>();
  const changeSets = evidence.changeSets.map((raw, index) => {
    const entry = requireRecord(
      raw,
      ["changeSetId", "submissionKey", "enqueueSeq", "state", "executionPhase"],
      `changeSets[${index}]`,
    );
    if (Object.keys(entry).length !== 5) throw new TypeError(`Standard diagnostic evidence is incompatible at changeSets[${index}]`);
    const changeSetId = requireString(entry.changeSetId, `changeSets[${index}].changeSetId`);
    const submissionKey = requireString(entry.submissionKey, `changeSets[${index}].submissionKey`);
    const enqueueSeq = requireInteger(entry.enqueueSeq, `changeSets[${index}].enqueueSeq`, 1);
    if (changeSetIds.has(changeSetId) || submissionKeys.has(submissionKey) || enqueueSequences.has(enqueueSeq)) {
      throw new TypeError("Standard diagnostic evidence has duplicate Change Set identity");
    }
    changeSetIds.add(changeSetId);
    submissionKeys.add(submissionKey);
    enqueueSequences.add(enqueueSeq);
    const executionPhase = entry.executionPhase === null
      ? null
      : requireOneOf(entry.executionPhase, executionPhases, `changeSets[${index}].executionPhase`);
    return {
      changeSetId,
      submissionKey,
      enqueueSeq,
      state: requireOneOf(entry.state, changeSetStates, `changeSets[${index}].state`),
      executionPhase,
    };
  });
  let previousEventSequence = 0;
  const machineEvents = evidence.machineEvents.map((raw, index) => {
    const event = requireRecord(raw, ["sequence", "code", "stackSymbols"], `machineEvents[${index}]`);
    if (Object.keys(event).length !== 3) throw new TypeError(`Standard diagnostic evidence is incompatible at machineEvents[${index}]`);
    const sequence = requireInteger(event.sequence, `machineEvents[${index}].sequence`, 1);
    if (sequence <= previousEventSequence) {
      throw new TypeError("Standard diagnostic evidence machine events are not ordered");
    }
    previousEventSequence = sequence;
    const stackSymbols = requireStringArray(event.stackSymbols, `machineEvents[${index}].stackSymbols`);
    if (!stackSymbols.every(isPathFreeStackSymbol)) {
      throw new TypeError("Standard diagnostic evidence contains a filesystem stack path");
    }
    return {
      sequence,
      code: requireOneOf(event.code, MACHINE_CODES, `machineEvents[${index}].code`),
      stackSymbols,
    };
  });
  const reasonCodes = requireStringArray(health.reasonCodes, "health.reasonCodes").map((code, index) =>
    requireOneOf(code, MACHINE_CODES, `health.reasonCodes[${index}]`),
  );
  if (new Set(reasonCodes).size !== reasonCodes.length) {
    throw new TypeError("Standard diagnostic evidence has duplicate reason codes");
  }
  const parsedJournal = parseJournal(evidence.journal);
  return {
    vaultId: requireString(evidence.vaultId, "vaultId"),
    versions: {
      bridge: requireString(versions.bridge, "versions.bridge"),
      plugin: requireString(versions.plugin, "versions.plugin"),
      protocol: requireString(versions.protocol, "versions.protocol"),
      persistentStateSchema: requireInteger(versions.persistentStateSchema, "versions.persistentStateSchema", 1),
      recoveryJournalSchema: requireInteger(versions.recoveryJournalSchema, "versions.recoveryJournalSchema", 1),
    },
    health: {
      readiness: {
        searchSnapshot: requireOneOf(readiness.searchSnapshot, readinessStates, "health.readiness.searchSnapshot"),
        cache: requireOneOf(readiness.cache, readinessStates, "health.readiness.cache"),
        index: requireOneOf(readiness.index, readinessStates, "health.readiness.index"),
      },
      recovery: requireOneOf(health.recovery, recoveryStates, "health.recovery"),
      write: {
        gate: requireOneOf(write.gate, ["open", "blocked"] as const, "health.write.gate"),
        state: requireOneOf(write.state, ["writable", "pausing", "paused"] as const, "health.write.state"),
        pauseSource: write.pauseSource === null
          ? null
          : requireOneOf(write.pauseSource, ["manual", "maintenance"] as const, "health.write.pauseSource"),
      },
      effectiveGate: health.effectiveGate === null
        ? null
        : requireOneOf(health.effectiveGate, gateCodes, "health.effectiveGate"),
      overall: requireOneOf(health.overall, overallStates, "health.overall"),
      reasonCodes,
      operatorAction: requireOneOf(health.operatorAction, operatorActions, "health.operatorAction"),
    },
    listener: {
      address: "127.0.0.1",
      port: requireInteger(listener.port, "listener.port", 1, 65_535),
    },
    queue: {
      currentExecutionId: requireNullableString(queue.currentExecutionId, "queue.currentExecutionId"),
      length: requireInteger(queue.length, "queue.length"),
      headChangeSetId: requireNullableString(queue.headChangeSetId, "queue.headChangeSetId"),
    },
    lifecycle: {
      startup: requireOneOf(lifecycle.startup, lifecycleStartupStates, "lifecycle.startup"),
      upgrade: requireOneOf(lifecycle.upgrade, lifecycleOutcomeStates, "lifecycle.upgrade"),
      migration: requireOneOf(lifecycle.migration, lifecycleOutcomeStates, "lifecycle.migration"),
      recovery: requireOneOf(lifecycle.recovery, lifecycleOutcomeStates, "lifecycle.recovery"),
    },
    journal: parsedJournal,
    changeSets,
    machineEvents,
  };
}

function isPathFreeStackSymbol(value: string): boolean {
  return /^[A-Za-z_$][A-Za-z0-9_$]*(?:[.#][A-Za-z_$][A-Za-z0-9_$]*)*$/u.test(value);
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
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

export function canonicalizeDiagnosticPayload(payload: DiagnosticBundlePayload): string {
  return JSON.stringify(canonicalize(payload));
}

function sha256(value: string | Uint8Array): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

class CorrelationAliases {
  readonly #salt: Uint8Array;
  readonly #aliases = new Map<string, string>();

  constructor(salt: Uint8Array) {
    if (salt.byteLength !== 32) throw new TypeError("Diagnostic correlation salt is invalid");
    this.#salt = Uint8Array.from(salt);
  }

  alias(kind: "vault" | "change-set", value: string): string {
    const key = `${kind} ${value}`;
    const existing = this.#aliases.get(key);
    if (existing !== undefined) return existing;
    const alias = `${kind.replace("-", "_")}_${sha256(Buffer.concat([
      Buffer.from(this.#salt),
      Buffer.from(" ", "utf8"),
      Buffer.from(kind, "utf8"),
      Buffer.from(" ", "utf8"),
      Buffer.from(value, "utf8"),
    ])).slice("sha256:".length, "sha256:".length + 24)}`;
    this.#aliases.set(key, alias);
    return alias;
  }

  submissionKeyDigest(value: string): string {
    return sha256(Buffer.concat([
      Buffer.from(this.#salt),
      Buffer.from(" submission-key ", "utf8"),
      Buffer.from(value, "utf8"),
    ]));
  }
}

function redactJournal(
  journal: RecoveryJournalDiagnosticFacts,
  aliases: CorrelationAliases,
): RedactedJournalFacts {
  if (journal.availability === "unavailable") return { availability: "unavailable", frames: [] };
  return {
    availability: "available",
    journalVersion: journal.journalVersion,
    headerChecksum: "valid",
    frames: journal.frames
      .sort((left, right) => left.slot - right.slot)
      .map((frame) =>
        frame.state === "valid"
          ? {
              slot: frame.slot,
              state: "valid" as const,
              checksum: "valid" as const,
              sequence: frame.sequence,
              phase: frame.phase,
              frameSchemaVersion: frame.frameSchemaVersion,
              changeSetAlias: aliases.alias("change-set", frame.changeSetId),
            }
          : {
              slot: frame.slot,
              state: frame.state,
              checksum: frame.checksum,
            },
      ),
  };
}

/**
 * Produces the fixed, closed payload copied by the Primary Operator command.
 * It accepts only the narrow evidence shape above; content or unknown source
 * fields fail before any bundle is emitted.
 */
export function createStandardDiagnosticBundle(evidence: unknown): StandardDiagnosticBundle {
  const parsed = parseEvidence(evidence);
  const aliases = new CorrelationAliases(randomBytes(32));
  const payload: DiagnosticBundlePayload = {
    schemaVersion: STANDARD_DIAGNOSTIC_BUNDLE_SCHEMA_VERSION,
    bundleVersion: STANDARD_DIAGNOSTIC_BUNDLE_VERSION,
    vault: { alias: aliases.alias("vault", parsed.vaultId) },
    versions: parsed.versions,
    health: parsed.health,
    listenerTimeline: [{ ordinal: 1, state: "listening", address: "loopback", port: parsed.listener.port }],
    queueTimeline: [{
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
    }],
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
    ...payload,
    checksum: {
      algorithm: "sha256",
      canonicalPayload: sha256(canonicalizeDiagnosticPayload(payload)),
    },
  };
}

function isDiagnosticBundle(value: unknown): value is StandardDiagnosticBundle {
  if (!isRecord(value) || !hasOnlyKeys(value, [
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
  ])) return false;
  const { checksum, ...payload } = value;
  if (!isRecord(checksum) || !hasOnlyKeys(checksum, ["algorithm", "canonicalPayload"])) return false;
  if (checksum.algorithm !== "sha256" || typeof checksum.canonicalPayload !== "string") return false;
  try {
    // The fixed output is accepted only if it can be reduced to the same closed
    // evidence grammar. The replacements below are synthetic opaque values;
    // they validate structure without treating aliases or digests as sources.
    const journal = payload.journal;
    if (!isRecord(journal)) return false;
    const reconstructed = {
      vaultId: "opaque-vault",
      versions: payload.versions,
      health: payload.health,
      listener: {
        address: "127.0.0.1",
        port: (Array.isArray(payload.listenerTimeline) ? payload.listenerTimeline[0] : undefined as unknown as Record<string, unknown>)?.port,
      },
      queue: {
        currentExecutionId: null,
        length: (Array.isArray(payload.queueTimeline) ? payload.queueTimeline[0] : undefined as unknown as Record<string, unknown>)?.length,
        headChangeSetId: null,
      },
      lifecycle: payload.lifecycleOutcomes,
      journal: journal.availability === "unavailable"
        ? { availability: "unavailable", frames: [] }
        : {
            availability: "available",
            journalVersion: journal.journalVersion,
            headerChecksum: journal.headerChecksum,
            frames: Array.isArray(journal.frames)
              ? journal.frames.map((frame: unknown) => {
                  if (!isRecord(frame)) return frame;
                  if (frame.state !== "valid") return frame;
                  return { ...frame, changeSetId: "opaque-change-set" };
                })
              : journal.frames,
          },
      changeSets: Array.isArray(payload.changeSetOutcomes)
        ? payload.changeSetOutcomes.map((entry: unknown, index) => {
            if (!isRecord(entry)) return entry;
            return {
              changeSetId: `opaque-change-set-${index}`,
              submissionKey: `opaque-submission-key-${index}`,
              enqueueSeq: entry.enqueueSeq,
              state: entry.state,
              executionPhase: entry.executionPhase,
            };
          })
        : payload.changeSetOutcomes,
      machineEvents: payload.machineEvents,
    };
    parseEvidence(reconstructed);
    const expected = sha256(canonicalizeDiagnosticPayload(payload as DiagnosticBundlePayload));
    return checksum.canonicalPayload === expected;
  } catch {
    return false;
  }
}

/** Verifies a copied bundle without needing its correlation salt or source data. */
export function verifyStandardDiagnosticBundle(value: unknown): boolean {
  return isDiagnosticBundle(value);
}
