import { createHash } from "node:crypto";
import type { FileHandle } from "node:fs/promises";

const HEADER_MAGIC = Buffer.from("LRJNL001", "ascii");
const FRAME_MAGIC = Buffer.from("FRM1", "ascii");
const JOURNAL_VERSION = 1;
const SLOT_COUNT = 2;
const HEADER_CHECKSUM_OFFSET = 32;
const FRAME_FIXED_SIZE = 53;

export const RECOVERY_JOURNAL_HEADER_SIZE = 40;

export type RecoveryJournalPhase =
  | "PREPARED"
  | "COMMITTED"
  | "ROLLED_BACK"
  | "FAILED";

export type RecoveryJournalJson =
  | null
  | boolean
  | number
  | string
  | RecoveryJournalJson[]
  | { [key: string]: RecoveryJournalJson };

export interface RecoveryJournalRecord {
  readonly sequence: number;
  readonly phase: RecoveryJournalPhase;
  readonly payload: RecoveryJournalJson;
}

export interface RecoveryJournalWrite {
  readonly phase: RecoveryJournalPhase;
  readonly payload: RecoveryJournalJson;
}

/**
 * Closed Recovery Journal facts admissible to the standard diagnostic bundle
 * (spec §9.4). Facts describe slot health, frame checksums, sequence, phase,
 * and schema version, plus the opaque Change Set identity needed to correlate
 * a frame with other evidence inside one bundle. They never include before
 * images, mutations, paths, input, or preview content.
 */
export interface RecoveryJournalDiagnosticFacts {
  readonly availability: "unavailable" | "available";
  readonly journalVersion?: number;
  readonly headerChecksum?: "valid";
  readonly frames: readonly {
    readonly slot: 0 | 1;
    readonly state: "empty" | "invalid" | "valid";
    readonly checksum: "not_present" | "invalid" | "valid";
    readonly sequence?: number;
    readonly phase?: RecoveryJournalPhase;
    readonly frameSchemaVersion?: number;
    /** Opaque to the journal; only the diagnostic producer correlates it. */
    readonly changeSetId?: string;
  }[];
}

export interface RecoveryJournal {
  recover(): Promise<RecoveryJournalRecord | undefined>;
  diagnosticFacts(): Promise<RecoveryJournalDiagnosticFacts>;
  write(record: RecoveryJournalWrite): Promise<RecoveryJournalRecord>;
}

export interface OpenRecoveryJournalOptions {
  readonly slotCapacity?: number;
}

export class RecoveryJournalCapacityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RecoveryJournalCapacityError";
  }
}

export class RecoveryJournalCorruptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RecoveryJournalCorruptError";
  }
}

export class RecoveryJournalIncompatibleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RecoveryJournalIncompatibleError";
  }
}

const phases: readonly RecoveryJournalPhase[] = [
  "PREPARED",
  "COMMITTED",
  "ROLLED_BACK",
  "FAILED",
];

function checksum(bytes: Uint8Array): Buffer {
  return createHash("sha256").update(bytes).digest();
}

function isJson(value: unknown): value is RecoveryJournalJson {
  if (value === null || typeof value === "boolean" || typeof value === "string") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJson);
  if (typeof value !== "object") return false;
  return Object.values(value).every(isJson);
}

function equal(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  let difference = 0;
  for (let index = 0; index < left.byteLength; index += 1) {
    difference |= left[index]! ^ right[index]!;
  }
  return difference === 0;
}

async function readExactly(
  handle: FileHandle,
  length: number,
  position: number,
): Promise<Buffer | undefined> {
  const bytes = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const result = await handle.read(bytes, offset, length - offset, position + offset);
    if (result.bytesRead === 0) return undefined;
    offset += result.bytesRead;
  }
  return bytes;
}

async function writeExactly(
  handle: FileHandle,
  bytes: Uint8Array,
  position: number,
): Promise<void> {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const result = await handle.write(bytes, offset, bytes.byteLength - offset, position + offset);
    if (result.bytesWritten === 0) throw new Error("Recovery journal write made no progress");
    offset += result.bytesWritten;
  }
}

interface Layout {
  readonly capacity: number;
  readonly offsets: readonly [number, number];
}

function createHeader(layout: Layout): Buffer {
  const header = Buffer.alloc(RECOVERY_JOURNAL_HEADER_SIZE);
  HEADER_MAGIC.copy(header, 0);
  header.writeUInt32LE(JOURNAL_VERSION, 8);
  header.writeUInt32LE(RECOVERY_JOURNAL_HEADER_SIZE, 12);
  header.writeUInt32LE(layout.capacity, 16);
  header.writeUInt32LE(SLOT_COUNT, 20);
  header.writeUInt32LE(layout.offsets[0], 24);
  header.writeUInt32LE(layout.offsets[1], 28);
  checksum(header.subarray(0, HEADER_CHECKSUM_OFFSET)).copy(
    header,
    HEADER_CHECKSUM_OFFSET,
    0,
    8,
  );
  return header;
}

async function openLayout(handle: FileHandle, requestedCapacity?: number): Promise<Layout> {
  const { size } = await handle.stat();
  if (size === 0) {
    const capacity = requestedCapacity;
    if (
      typeof capacity !== "number" ||
      !Number.isSafeInteger(capacity) ||
      capacity < FRAME_FIXED_SIZE
    ) {
      throw new RecoveryJournalIncompatibleError(
        "A new recovery journal requires a usable slotCapacity",
      );
    }
    const layout: Layout = {
      capacity,
      offsets: [RECOVERY_JOURNAL_HEADER_SIZE, RECOVERY_JOURNAL_HEADER_SIZE + capacity],
    };
    await writeExactly(handle, createHeader(layout), 0);
    await handle.truncate(RECOVERY_JOURNAL_HEADER_SIZE + capacity * SLOT_COUNT);
    await handle.sync();
    return layout;
  }
  if (size < RECOVERY_JOURNAL_HEADER_SIZE) {
    throw new RecoveryJournalCorruptError("Recovery journal header is truncated");
  }
  const header = await readExactly(handle, RECOVERY_JOURNAL_HEADER_SIZE, 0);
  if (header === undefined || !header.subarray(0, 8).equals(HEADER_MAGIC)) {
    throw new RecoveryJournalIncompatibleError("Recovery journal magic is not recognized");
  }
  if (
    !equal(
      header.subarray(HEADER_CHECKSUM_OFFSET),
      checksum(header.subarray(0, HEADER_CHECKSUM_OFFSET)).subarray(0, 8),
    )
  ) {
    throw new RecoveryJournalCorruptError("Recovery journal header checksum is invalid");
  }
  const version = header.readUInt32LE(8);
  const headerSize = header.readUInt32LE(12);
  const capacity = header.readUInt32LE(16);
  const slotCount = header.readUInt32LE(20);
  const first = header.readUInt32LE(24);
  const second = header.readUInt32LE(28);
  if (
    version !== JOURNAL_VERSION ||
    headerSize !== RECOVERY_JOURNAL_HEADER_SIZE ||
    slotCount !== SLOT_COUNT
  ) {
    throw new RecoveryJournalIncompatibleError("Recovery journal schema is not supported");
  }
  if (
    capacity < FRAME_FIXED_SIZE ||
    first !== RECOVERY_JOURNAL_HEADER_SIZE ||
    second !== first + capacity ||
    size < second + capacity
  ) {
    throw new RecoveryJournalCorruptError(
      "Recovery journal header layout is invalid or truncated",
    );
  }
  if (requestedCapacity !== undefined && requestedCapacity !== capacity) {
    throw new RecoveryJournalIncompatibleError(
      "Recovery journal slotCapacity does not match the existing file",
    );
  }
  return { capacity, offsets: [first, second] };
}

type Slot =
  | { readonly state: "empty" }
  | { readonly state: "invalid" }
  | { readonly state: "valid"; readonly record: RecoveryJournalRecord };

function isEmpty(bytes: Uint8Array): boolean {
  return bytes.every((byte) => byte === 0);
}

function decodeSlot(bytes: Buffer): Slot {
  if (isEmpty(bytes)) return { state: "empty" };
  if (bytes.byteLength < FRAME_FIXED_SIZE || !bytes.subarray(0, 4).equals(FRAME_MAGIC)) {
    return { state: "invalid" };
  }
  if (bytes.readUInt32LE(4) !== JOURNAL_VERSION) return { state: "invalid" };
  const sequence = Number(bytes.readBigUInt64LE(8));
  const phaseIndex = bytes.readUInt8(16);
  const payloadLength = bytes.readUInt32LE(17);
  if (
    !Number.isSafeInteger(sequence) ||
    sequence < 1 ||
    phaseIndex >= phases.length ||
    payloadLength > bytes.byteLength - FRAME_FIXED_SIZE
  ) {
    return { state: "invalid" };
  }
  const payload = bytes.subarray(FRAME_FIXED_SIZE, FRAME_FIXED_SIZE + payloadLength);
  const covered = Buffer.concat([bytes.subarray(0, 21), payload]);
  if (!equal(bytes.subarray(21, 53), checksum(covered))) return { state: "invalid" };
  try {
    const parsed: unknown = JSON.parse(payload.toString("utf8"));
    if (!isJson(parsed)) return { state: "invalid" };
    const phase = phases[phaseIndex];
    if (phase === undefined) return { state: "invalid" };
    return { state: "valid", record: { sequence, phase, payload: parsed } };
  } catch {
    return { state: "invalid" };
  }
}

class FileRecoveryJournal implements RecoveryJournal {
  #tail: Promise<void> = Promise.resolve();
  readonly #handle: FileHandle;
  readonly #layout: Layout;

  constructor(handle: FileHandle, layout: Layout) {
    this.#handle = handle;
    this.#layout = layout;
  }

  async recover(): Promise<RecoveryJournalRecord | undefined> {
    await this.#tail;
    return this.#readLatest();
  }

  async diagnosticFacts(): Promise<RecoveryJournalDiagnosticFacts> {
    await this.#tail;
    const slots = await Promise.all(
      this.#layout.offsets.map(async (offset, slot) => {
        const bytes = await readExactly(this.#handle, this.#layout.capacity, offset);
        const decoded = bytes === undefined ? ({ state: "invalid" } as Slot) : decodeSlot(bytes);
        if (decoded.state === "empty") {
          return { slot: slot as 0 | 1, state: "empty" as const, checksum: "not_present" as const };
        }
        if (decoded.state === "invalid") {
          return { slot: slot as 0 | 1, state: "invalid" as const, checksum: "invalid" as const };
        }
        const payload = decoded.record.payload;
        const frame =
          typeof payload === "object" && payload !== null && !Array.isArray(payload)
            ? (payload as Record<string, RecoveryJournalJson>)
            : undefined;
        const frameSchemaVersion = frame?.schemaVersion;
        const changeSetId = frame?.changeSetId;
        return {
          slot: slot as 0 | 1,
          state: "valid" as const,
          checksum: "valid" as const,
          sequence: decoded.record.sequence,
          phase: decoded.record.phase,
          ...(typeof frameSchemaVersion === "number" && Number.isSafeInteger(frameSchemaVersion)
            ? { frameSchemaVersion }
            : {}),
          ...(typeof changeSetId === "string" && changeSetId.length > 0 ? { changeSetId } : {}),
        };
      }),
    );
    return {
      availability: "available",
      journalVersion: JOURNAL_VERSION,
      headerChecksum: "valid",
      frames: slots,
    };
  }

  write(record: RecoveryJournalWrite): Promise<RecoveryJournalRecord> {
    const operation = this.#tail.then(() => this.#write(record));
    this.#tail = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  async #readLatest(): Promise<RecoveryJournalRecord | undefined> {
    const slots = await Promise.all(
      this.#layout.offsets.map(async (offset) => {
        const bytes = await readExactly(this.#handle, this.#layout.capacity, offset);
        return bytes === undefined ? ({ state: "invalid" } as Slot) : decodeSlot(bytes);
      }),
    );
    const valid = slots.filter(
      (slot): slot is Extract<Slot, { state: "valid" }> => slot.state === "valid",
    );
    if (valid.length === 0) {
      if (slots.every((slot) => slot.state === "empty")) return undefined;
      throw new RecoveryJournalCorruptError("Recovery journal has no valid frame");
    }
    const firstValid = valid[0];
    const secondValid = valid[1];
    if (
      firstValid !== undefined &&
      secondValid !== undefined &&
      firstValid.record.sequence === secondValid.record.sequence
    ) {
      throw new RecoveryJournalCorruptError(
        "Recovery journal slots have conflicting sequences",
      );
    }
    return valid.reduce((latest, slot) =>
      latest.record.sequence > slot.record.sequence ? latest : slot,
    ).record;
  }

  async #write(record: RecoveryJournalWrite): Promise<RecoveryJournalRecord> {
    if (!phases.includes(record.phase) || !isJson(record.payload)) {
      throw new TypeError("Recovery journal records require a known phase and JSON payload");
    }
    const payload = Buffer.from(JSON.stringify(record.payload), "utf8");
    if (FRAME_FIXED_SIZE + payload.byteLength > this.#layout.capacity) {
      throw new RecoveryJournalCapacityError(
        "Recovery journal frame exceeds the fixed slot capacity",
      );
    }
    const previous = await this.#readLatest();
    const sequence = (previous?.sequence ?? 0) + 1;
    if (!Number.isSafeInteger(sequence)) {
      throw new RecoveryJournalCapacityError("Recovery journal sequence is exhausted");
    }
    const target = previous === undefined || previous.sequence % 2 === 0 ? 0 : 1;
    const frameLength = FRAME_FIXED_SIZE + payload.byteLength;
    const slot = Buffer.alloc(frameLength);
    FRAME_MAGIC.copy(slot, 0);
    slot.writeUInt32LE(JOURNAL_VERSION, 4);
    slot.writeBigUInt64LE(BigInt(sequence), 8);
    slot.writeUInt8(phases.indexOf(record.phase), 16);
    slot.writeUInt32LE(payload.byteLength, 17);
    checksum(Buffer.concat([slot.subarray(0, 21), payload])).copy(slot, 21);
    payload.copy(slot, FRAME_FIXED_SIZE);
    const targetOffset = this.#layout.offsets[target];
    if (targetOffset === undefined) {
      throw new RecoveryJournalCorruptError("Recovery journal slot is unavailable");
    }
    await writeExactly(this.#handle, slot, targetOffset);
    await this.#handle.sync();
    return { sequence, phase: record.phase, payload: record.payload };
  }
}

export async function openRecoveryJournal(
  handle: FileHandle,
  options: OpenRecoveryJournalOptions = {},
): Promise<RecoveryJournal> {
  return new FileRecoveryJournal(handle, await openLayout(handle, options.slotCapacity));
}
