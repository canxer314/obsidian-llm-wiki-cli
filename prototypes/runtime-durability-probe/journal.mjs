import { createHash } from "node:crypto";
import { open, mkdir, rename, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";

export const SLOT_BYTES = 256 * 1024;
const MAGIC = Buffer.from("LLMCLIWAL1\n", "ascii");

export function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function encodeFrame(frame) {
  const payload = Buffer.from(JSON.stringify(frame), "utf8");
  const header = Buffer.from(JSON.stringify({ length: payload.length, checksum: sha256(payload) }) + "\n", "utf8");
  if (MAGIC.length + header.length + payload.length > SLOT_BYTES) throw new Error("journal_frame_too_large");
  return Buffer.concat([MAGIC, header, payload, Buffer.alloc(SLOT_BYTES - MAGIC.length - header.length - payload.length)]);
}

export function decodeFrame(bytes) {
  if (!bytes.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error("journal_magic_invalid");
  const headerEnd = bytes.indexOf(0x0a, MAGIC.length);
  if (headerEnd < 0) throw new Error("journal_header_truncated");
  const header = JSON.parse(bytes.subarray(MAGIC.length, headerEnd).toString("utf8"));
  const payload = bytes.subarray(headerEnd + 1, headerEnd + 1 + header.length);
  if (payload.length !== header.length) throw new Error("journal_payload_truncated");
  if (sha256(payload) !== header.checksum) throw new Error("journal_checksum_invalid");
  return JSON.parse(payload.toString("utf8"));
}

export async function initializeJournal(journalDir) {
  await mkdir(journalDir, { recursive: true });
  for (const name of ["slot-0.wal", "slot-1.wal"]) {
    const path = join(journalDir, name);
    const handle = await open(path, "w+");
    try {
      await handle.truncate(SLOT_BYTES);
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
  const dirHandle = await open(journalDir, "r");
  try {
    await dirHandle.sync();
    return { directorySync: "supported" };
  } catch (error) {
    if (error.code === "EPERM" || error.code === "EINVAL") {
      return { directorySync: "unsupported", error: error.code };
    }
    throw error;
  } finally {
    await dirHandle.close();
  }
}

export async function writeFrame(journalDir, frame, { injectDiskFull = false } = {}) {
  if (injectDiskFull) {
    const error = new Error("injected disk full");
    error.code = "ENOSPC";
    throw error;
  }
  const slot = frame.sequence % 2;
  const path = join(journalDir, `slot-${slot}.wal`);
  const bytes = encodeFrame(frame);
  const handle = await open(path, "r+");
  try {
    await handle.write(bytes, 0, bytes.length, 0);
    await handle.sync();
  } finally {
    await handle.close();
  }
  return path;
}

export async function readLatestFrame(journalDir, expectedVaultIdentity) {
  const frames = [];
  const errors = [];
  for (const slot of [0, 1]) {
    const path = join(journalDir, `slot-${slot}.wal`);
    try {
      const handle = await open(path, "r");
      try {
        const bytes = Buffer.alloc(SLOT_BYTES);
        const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
        if (bytesRead !== SLOT_BYTES) throw new Error("journal_slot_truncated");
        frames.push(decodeFrame(bytes));
      } finally {
        await handle.close();
      }
    } catch (error) {
      errors.push({ slot, error: error.message });
    }
  }
  if (!frames.length) return { frame: null, errors };
  frames.sort((a, b) => b.sequence - a.sequence);
  const frame = frames[0];
  if (frame.vaultIdentity !== expectedVaultIdentity) throw new Error("journal_wrong_vault_identity");
  return { frame, errors };
}

export async function capturePath(path) {
  try {
    const info = await stat(path);
    if (!info.isFile()) throw new Error("unsupported_non_file_path");
    const handle = await open(path, "r");
    try {
      const bytes = await handle.readFile();
      return { exists: true, bytes: bytes.toString("base64"), sha256: sha256(bytes) };
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (error.code === "ENOENT") return { exists: false, bytes: null, sha256: null };
    throw error;
  }
}

export async function writeSynced(path, bytes) {
  await mkdir(dirname(path), { recursive: true });
  const handle = await open(path, "w");
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function restorePath(path, before, expectedAfter) {
  const current = await capturePath(path);
  if (current.exists === before.exists && current.sha256 === before.sha256) return "already_before";
  if (current.exists !== expectedAfter.exists || current.sha256 !== expectedAfter.sha256) {
    throw new Error(`restoration_conflict:${path}`);
  }
  if (before.exists) await writeSynced(path, Buffer.from(before.bytes, "base64"));
  else await rm(path, { force: true });
  return "restored";
}

export async function renameSynced(from, to) {
  await mkdir(dirname(to), { recursive: true });
  await rename(from, to);
  const dirHandle = await open(dirname(to), "r");
  try {
    await dirHandle.sync();
    return { directorySync: "supported" };
  } catch (error) {
    if (error.code === "EPERM" || error.code === "EINVAL") {
      return { directorySync: "unsupported", error: error.code };
    }
    throw error;
  } finally {
    await dirHandle.close();
  }
}
