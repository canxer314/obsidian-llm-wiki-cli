/**
 * Deterministic Recovery-Journal fault primitives for the supervised corpus
 * (issue #192, part of #43).
 *
 * Two distinct fault families are supported:
 *
 * 1. **Journal-state corruption** is applied by the *supervising process*
 *    between generations. The supervisor owns the scenario root, so it can read
 *    the double-buffered journal, identify the newest/older slot, and rewrite
 *    exact on-disk state (truncated header, checksum-invalid frame, zeroed slot,
 *    wrong-Vault payload, incompatible header). Corruption is applied to a
 *    declared target slot so the restart is deterministic and the report can
 *    record the durable frame/sequence/checksum observation before and after.
 *
 * 2. **Storage faults** strike *inside* a live owning process at a declared
 *    journal write. The child wraps the journal `FileHandle` and injects a
 *    single fault when the frame being written carries the declared phase and
 *    occurrence. The frame bytes are parsed from the write buffer itself (the
 *    frame magic/version/sequence/phase layout), so the injection point is
 *    exactly the declared durable-persistence step and cannot drift.
 *
 * No before-image or private content is ever recorded: observations are limited
 * to slot state, sequence, phase, and a checksum digest, matching the existing
 * report redaction style (spec A-33 / A-37).
 */

import { createHash } from "node:crypto";
import {
  readFile,
  writeFile,
  type FileHandle,
} from "node:fs/promises";

import type { RecoveryJournalPhase } from "../recovery-journal.js";

const HEADER_MAGIC = Buffer.from("LRJNL001", "ascii");
const FRAME_MAGIC = Buffer.from("FRM1", "ascii");
const JOURNAL_VERSION = 1;
const SLOT_COUNT = 2;
const HEADER_SIZE = 40;
const HEADER_CHECKSUM_OFFSET = 32;
const FRAME_FIXED_SIZE = 53;

const phases: readonly RecoveryJournalPhase[] = [
  "PREPARED",
  "COMMITTED",
  "ROLLED_BACK",
  "FAILED",
];

function checksum(bytes: Uint8Array): Buffer {
  return createHash("sha256").update(bytes).digest();
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return Buffer.from(left).equals(Buffer.from(right));
}

function digestPrefix(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex").slice(0, 16);
}

export interface RecoveryJournalFileLayout {
  readonly capacity: number;
  readonly size: number;
  readonly offsets: readonly [number, number];
}

/** Read the header of a Recovery Journal file, or throw when unparseable. */
export async function readJournalLayout(path: string): Promise<RecoveryJournalFileLayout> {
  const bytes = await readFile(path);
  if (bytes.byteLength < HEADER_SIZE) {
    throw new Error(`Recovery journal is truncated (${bytes.byteLength} bytes)`);
  }
  if (!bytes.subarray(0, 8).equals(HEADER_MAGIC)) {
    throw new Error("Recovery journal magic is not recognized");
  }
  const capacity = bytes.readUInt32LE(16);
  const slotCount = bytes.readUInt32LE(20);
  const first = bytes.readUInt32LE(24);
  const second = bytes.readUInt32LE(28);
  if (capacity < FRAME_FIXED_SIZE || slotCount !== SLOT_COUNT || second !== first + capacity) {
    throw new Error("Recovery journal layout is invalid");
  }
  return {
    capacity,
    size: bytes.byteLength,
    offsets: [first, second],
  };
}

export interface JournalSlotObservation {
  readonly state: "empty" | "valid" | "invalid";
  readonly sequence: number | null;
  readonly phase: RecoveryJournalPhase | null;
  /** Short checksum digest of the frame header+payload; never the payload content. */
  readonly checksumDigest: string | null;
}

export interface JournalObservation {
  readonly capacity: number;
  readonly recoverable: { sequence: number; phase: RecoveryJournalPhase } | null;
  readonly slots: readonly JournalSlotObservation[];
}

function isEmpty(bytes: Buffer): boolean {
  return bytes.every((byte) => byte === 0);
}

function decodeSlot(bytes: Buffer): JournalSlotObservation {
  if (isEmpty(bytes)) {
    return { state: "empty", sequence: null, phase: null, checksumDigest: null };
  }
  if (
    bytes.byteLength < FRAME_FIXED_SIZE ||
    !bytes.subarray(0, 4).equals(FRAME_MAGIC) ||
    bytes.readUInt32LE(4) !== JOURNAL_VERSION
  ) {
    return { state: "invalid", sequence: null, phase: null, checksumDigest: null };
  }
  const sequence = Number(bytes.readBigUInt64LE(8));
  const phaseIndex = bytes.readUInt8(16);
  const payloadLength = bytes.readUInt32LE(17);
  const phase = phases[phaseIndex];
  if (
    !Number.isSafeInteger(sequence) ||
    sequence < 1 ||
    phase === undefined ||
    payloadLength > bytes.byteLength - FRAME_FIXED_SIZE
  ) {
    return { state: "invalid", sequence: null, phase: null, checksumDigest: null };
  }
  const payload = bytes.subarray(FRAME_FIXED_SIZE, FRAME_FIXED_SIZE + payloadLength);
  const covered = Buffer.concat([bytes.subarray(0, 21), payload]);
  if (!bytesEqual(bytes.subarray(21, 53), checksum(covered))) {
    return { state: "invalid", sequence: null, phase: null, checksumDigest: null };
  }
  return {
    state: "valid",
    sequence,
    phase,
    checksumDigest: digestPrefix(bytes.subarray(21, 53)),
  };
}

/**
 * Observe the journal's two slots without decoding payload content. `recoverable`
 * mirrors `RecoveryJournal#recover`: the highest-sequence valid slot, or `null`
 * when the journal is empty, and an explicit error when no valid frame exists.
 */
export async function observeJournalFile(path: string): Promise<JournalObservation> {
  const layout = await readJournalLayout(path);
  const file = await readFile(path);
  const slots: JournalSlotObservation[] = layout.offsets.map((offset) =>
    decodeSlot(file.subarray(offset, offset + layout.capacity)),
  );
  const valid = slots.filter(
    (slot): slot is typeof slot & { state: "valid" } => slot.state === "valid",
  );
  const recoverable =
    valid.length === 0
      ? null
      : valid.reduce<{ sequence: number; phase: RecoveryJournalPhase } | null>(
          (latest, slot) =>
            latest === null || slot.sequence! > latest.sequence
              ? { sequence: slot.sequence!, phase: slot.phase! }
              : latest,
          null,
        );
  return { capacity: layout.capacity, recoverable, slots };
}

export type JournalSlotTarget = "older" | "newest" | "both";

/**
 * Journal-state corruption applied by the supervisor to a parked generation's
 * on-disk journal. `target` is resolved against the live slot contents so the
 * scenario never depends on which physical slot happens to hold the newest frame.
 */
export type JournalCorruption =
  | { readonly kind: "truncate_header" }
  | { readonly kind: "corrupt_frame_checksum"; readonly target: JournalSlotTarget }
  | { readonly kind: "zero_slot"; readonly target: JournalSlotTarget }
  | { readonly kind: "incompatible_magic" }
  | { readonly kind: "incompatible_version" };

export interface CorruptionObservation {
  readonly kind: string;
  readonly target: JournalSlotTarget | null;
  readonly after: JournalObservation;
}

async function resolveTargetIndex(
  layout: RecoveryJournalFileLayout,
  file: Buffer,
  target: JournalSlotTarget,
): Promise<number[]> {
  const decoded = layout.offsets.map((offset) =>
    decodeSlot(file.subarray(offset, offset + layout.capacity)),
  );
  const valid = decoded
    .map((slot, index) => ({ slot, index }))
    .filter((entry): entry is { slot: typeof entry.slot & { state: "valid" }; index: number } =>
      entry.slot.state === "valid",
    )
    .sort((left, right) => right.slot.sequence! - left.slot.sequence!);
  const newest = valid[0];
  const older = valid[1];
  if (target === "both") {
    return valid.map((entry) => entry.index);
  }
  if (target === "newest") {
    return newest === undefined ? [] : [newest.index];
  }
  return older === undefined ? (newest === undefined ? [] : [newest.index]) : [older.index];
}

/**
 * Apply one declared journal corruption to the on-disk journal. Returns the
 * resulting slot observation so the report can record the fault identity plus
 * the durable frame/sequence/checksum evidence without any payload content.
 */
export async function corruptJournalFile(
  path: string,
  corruption: JournalCorruption,
): Promise<CorruptionObservation> {
  const layout = await readJournalLayout(path);
  const file = await readFile(path);

  const writeWholeFile = async (next: Buffer): Promise<void> => {
    await writeFile(path, next);
  };
  const truncateTo = async (bytes: number): Promise<void> => {
    const fd = await import("node:fs/promises").then((m) => m.open(path, "r+"));
    try {
      await fd.truncate(bytes);
    } finally {
      await fd.close();
    }
  };
  const corruptSlot = (file: Buffer, index: number): Buffer => {
    const next: Buffer = Buffer.from(file);
    const start = layout.offsets[index]!;
    // Flip one byte of the frame checksum region so the slot becomes invalid
    // while the frame layout (and the other slot) stay byte-identical.
    const checksumByte = start + 21;
    next[checksumByte] = next[checksumByte]! ^ 0xff;
    return next;
  };
  const zeroSlot = (file: Buffer, index: number): Buffer => {
    const next: Buffer = Buffer.from(file);
    const start = layout.offsets[index]!;
    next.fill(0, start, start + layout.capacity);
    return next;
  };

  switch (corruption.kind) {
    case "truncate_header": {
      await truncateTo(16);
      break;
    }
    case "incompatible_magic": {
      const next = Buffer.from(file);
      next[0] = 0x4e; // 'N' replaces the leading 'L'
      await writeWholeFile(next);
      break;
    }
    case "incompatible_version": {
      // A schema-incompatible journal still carries a valid header checksum;
      // only the declared version changes so the header remains well-formed and
      // the journal is rejected as unsupported (not merely corrupt).
      const next = Buffer.from(file);
      next.writeUInt32LE(JOURNAL_VERSION + 1, 8);
      checksum(next.subarray(0, HEADER_CHECKSUM_OFFSET)).copy(next, HEADER_CHECKSUM_OFFSET, 0, 8);
      await writeWholeFile(next);
      break;
    }
    case "corrupt_frame_checksum": {
      const targets = await resolveTargetIndex(layout, file, corruption.target);
      let next: Buffer = Buffer.from(file);
      for (const index of targets) next = corruptSlot(next, index);
      await writeWholeFile(next);
      break;
    }
    case "zero_slot": {
      const targets = await resolveTargetIndex(layout, file, corruption.target);
      let next: Buffer = Buffer.from(file);
      for (const index of targets) next = zeroSlot(next, index);
      await writeWholeFile(next);
      break;
    }
  }

  return {
    kind: corruption.kind,
    target: "target" in corruption ? corruption.target : null,
    after: await observeJournalFile(path).catch(() => ({
      capacity: layout.capacity,
      recoverable: null,
      slots: [],
    })),
  };
}

/**
 * Rewrite the `vaultId` string inside the payload of one valid slot to a
 * different Vault identity and recompute the frame checksum so the slot stays
 * valid. The replacement keeps the exact byte length so the frame and slot
 * layout are untouched; the journal then reports a checksum-valid frame that
 * belongs to a foreign Vault (spec A-21/A-35 wrong-Vault case).
 */
export async function rewriteJournalFrameVaultId(
  path: string,
  currentVaultId: string,
  newVaultId: string,
  target: "newest" | "older",
): Promise<JournalObservation> {
  const layout = await readJournalLayout(path);
  const file = await readFile(path);
  const indexes = await resolveTargetIndex(layout, file, target);
  const index = indexes[0];
  if (index === undefined) {
    throw new Error("No valid journal slot to rewrite a Vault identity into");
  }
  const start = layout.offsets[index]!;
  const slot = file.subarray(start, start + layout.capacity);
  const payloadLength = slot.readUInt32LE(17);
  const payloadStart = FRAME_FIXED_SIZE;
  const payloadEnd = FRAME_FIXED_SIZE + payloadLength;
  const payloadText = slot.subarray(payloadStart, payloadEnd).toString("utf8");
  const needle = `"vaultId":"${currentVaultId}"`;
  const replacement = `"vaultId":"${newVaultId}"`;
  if (!payloadText.includes(needle)) {
    throw new Error("Recovery journal payload does not declare the current Vault identity");
  }
  if (Buffer.byteLength(replacement, "utf8") !== Buffer.byteLength(needle, "utf8")) {
    throw new Error("Wrong-Vault replacement must keep the payload byte length stable");
  }
  const next: Buffer = Buffer.from(file);
  const nextPayload = Buffer.from(payloadText.replace(needle, replacement), "utf8");
  nextPayload.copy(next, start + payloadStart);
  // Recompute the 32-byte FRM1 checksum over [0..21) + payload.
  const frame = next.subarray(start, start + FRAME_FIXED_SIZE + payloadLength);
  checksum(Buffer.concat([frame.subarray(0, 21), nextPayload])).copy(frame, 21);
  await writeFile(path, next);
  return observeJournalFile(path);
}

// ---------------------------------------------------------------------------
// Storage-fault injection inside a live owning process (child side).
// ---------------------------------------------------------------------------

export type JournalWriteStep =
  | "before_write"
  | "short_write"
  | "no_progress"
  | "sync"
  | "after_sync";

export interface JournalWriteFault {
  /** Fault the nth frame whose phase equals `phase` within this process. */
  readonly phase: RecoveryJournalPhase;
  readonly occurrence: number;
  readonly step: JournalWriteStep;
  /** Node-style error code surface for the injected failure. */
  readonly code: string;
  readonly message: string;
  /** Bytes written before a `short_write` fault aborts the frame. */
  readonly partialPrefixBytes?: number;
}

export interface FaultedWriteObservation {
  readonly fired: boolean;
  readonly sequence: number | null;
  readonly phase: RecoveryJournalPhase | null;
  readonly occurrence: number;
}

/**
 * Wrap a real journal `FileHandle` so that exactly one declared frame write
 * fails with a storage fault. Frame writes are identified by parsing the write
 * buffer (FRM1 magic), never by payload content. `onFired` lets the owning
 * process record strict-ordering evidence into its control directory.
 */
export function createFaultableJournalHandle(
  handle: FileHandle,
  fault: JournalWriteFault | null,
  onFired: (observation: FaultedWriteObservation) => void | Promise<void>,
): FileHandle {
  if (fault === null) return handle;

  let matchingCount = 0;
  let fired = false;
  let pendingSyncFault = false;

  const originalWrite = handle.write.bind(handle);
  const originalSync = handle.sync.bind(handle);
  const originalRead = handle.read.bind(handle);
  const originalStat = handle.stat.bind(handle);
  const originalTruncate = handle.truncate.bind(handle);
  const originalClose = handle.close.bind(handle);

  const isFrameWrite = (bytes: Buffer): boolean =>
    bytes.byteLength >= FRAME_FIXED_SIZE &&
    bytes.subarray(0, 4).equals(FRAME_MAGIC);

  const match = (bytes: Buffer): FaultedWriteObservation | null => {
    if (!isFrameWrite(bytes) || fired) return null;
    const sequence = Number(bytes.readBigUInt64LE(8));
    const phaseIndex = bytes.readUInt8(16);
    const phase = phases[phaseIndex];
    if (phase === undefined || phase !== fault.phase) return null;
    matchingCount += 1;
    if (matchingCount !== fault.occurrence) return null;
    fired = true;
    return { fired: true, sequence, phase, occurrence: matchingCount };
  };

  const injectedError = (): NodeJS.ErrnoException => {
    const error = new Error(fault.message) as NodeJS.ErrnoException;
    error.code = fault.code;
    return error;
  };

  const wrapped: FileHandle = {
    ...handle,
    fd: handle.fd,
    async read(
      buffer: Uint8Array,
      offset: number,
      length: number,
      position: number | null,
    ) {
      return originalRead(buffer, offset, length, position);
    },
    async write(
      buffer: Uint8Array,
      offset: number,
      length: number,
      position: number | null,
    ) {
      const bytes = Buffer.isBuffer(buffer)
        ? buffer.subarray(offset, offset + length)
        : Buffer.from(buffer.buffer, buffer.byteOffset + offset, length);
      const observation = match(bytes);
      if (observation !== null) {
        await onFired(observation);
        if (fault.step === "before_write") throw injectedError();
        if (fault.step === "no_progress") {
          return { bytesWritten: 0, buffer };
        }
        if (fault.step === "short_write") {
          const prefix = Math.min(bytes.byteLength, fault.partialPrefixBytes ?? 16);
          const partial = bytes.subarray(0, prefix);
          await originalWrite(partial, 0, partial.byteLength, position ?? 0);
          throw injectedError();
        }
        // `sync` / `after_sync`: the full frame bytes are written first; the
        // fault strikes at the following sync so the frame is on disk but the
        // persistence step still reports failure.
        pendingSyncFault = true;
      }
      return originalWrite(buffer, offset, length, position);
    },
    async sync() {
      if (pendingSyncFault && fault.step === "sync") {
        pendingSyncFault = false;
        throw injectedError();
      }
      if (pendingSyncFault && fault.step === "after_sync") {
        pendingSyncFault = false;
        // Perform the real fsync first, then report failure: the frame is
        // durable but the persistence step did not acknowledge it.
        await originalSync();
        throw injectedError();
      }
      return originalSync();
    },
    async truncate(length: number) {
      return originalTruncate(length);
    },
    async stat() {
      return originalStat();
    },
    async close() {
      return originalClose();
    },
  } as unknown as FileHandle;
  return wrapped;
}

/** The JSON-encoded `CORPUS_FAULT` the supervisor passes to a child process. */
export type CorpusChildFault =
  | { readonly kind: "journal_write"; readonly fault: JournalWriteFault }
  | {
      readonly kind: "host_operation";
      readonly operation: string;
      readonly occurrence: number;
      readonly code: string;
      readonly message: string;
    };

export function isJournalWriteFault(
  value: unknown,
): value is CorpusChildFault & { kind: "journal_write" } {
  return typeof value === "object" && value !== null && (value as { kind?: unknown }).kind === "journal_write";
}

export function isHostOperationFault(
  value: unknown,
): value is CorpusChildFault & { kind: "host_operation" } {
  return typeof value === "object" && value !== null && (value as { kind?: unknown }).kind === "host_operation";
}
