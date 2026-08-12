import { open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  RecoveryJournalCapacityError,
  RecoveryJournalCorruptError,
  openRecoveryJournal,
} from "../src/recovery-journal.js";

const paths: string[] = [];

async function journalFile(): Promise<{
  path: string;
  handle: Awaited<ReturnType<typeof open>>;
}> {
  const path = join(tmpdir(), `recovery-journal-${crypto.randomUUID()}.bin`);
  paths.push(path);
  return { path, handle: await open(path, "w+") };
}

afterEach(async () => {
  await Promise.all(paths.splice(0).map((path) => rm(path, { force: true })));
});

describe("recovery journal", () => {
  it("round-trips a committed record with complete before/after JSON", async () => {
    const { handle } = await journalFile();
    const journal = await openRecoveryJournal(handle, { slotCapacity: 1024 });
    const payload = {
      before: { path: "Notes/a.md", content: "before", bytes: [1, 2] },
      after: { path: "Notes/a.md", content: "after", bytes: [3, 4] },
    };

    await expect(journal.recover()).resolves.toBeUndefined();
    await journal.write({ phase: "COMMITTED", payload });

    await expect(journal.recover()).resolves.toEqual({
      sequence: 1,
      phase: "COMMITTED",
      payload,
    });
    await handle.close();
  });

  it("alternates slots while preserving the newest sequence", async () => {
    const { handle } = await journalFile();
    const journal = await openRecoveryJournal(handle, { slotCapacity: 1024 });

    await journal.write({ phase: "PREPARED", payload: { step: 1 } });
    await journal.write({ phase: "COMMITTED", payload: { step: 2 } });
    await journal.write({ phase: "ROLLED_BACK", payload: { step: 3 } });

    await expect(journal.recover()).resolves.toEqual({
      sequence: 3,
      phase: "ROLLED_BACK",
      payload: { step: 3 },
    });
    await handle.close();
  });

  it("falls back to the older slot when the newest slot is corrupted", async () => {
    const { path, handle } = await journalFile();
    const journal = await openRecoveryJournal(handle, { slotCapacity: 1024 });
    await journal.write({ phase: "PREPARED", payload: { version: "old" } });
    await journal.write({ phase: "COMMITTED", payload: { version: "new" } });
    await handle.close();

    const file = await open(path, "r+");
    await file.write(Buffer.from([0xff]), 0, 1, 40 + 1024 + 16);
    await file.close();

    const reopened = await open(path, "r+");
    const recovered = await openRecoveryJournal(reopened, { slotCapacity: 1024 });
    await expect(recovered.recover()).resolves.toEqual({
      sequence: 1,
      phase: "PREPARED",
      payload: { version: "old" },
    });
    await reopened.close();
  });

  it("reports corrupt rather than empty when both slots are unusable", async () => {
    const { path, handle } = await journalFile();
    const journal = await openRecoveryJournal(handle, { slotCapacity: 1024 });
    await journal.write({ phase: "PREPARED", payload: { version: 1 } });
    await journal.write({ phase: "FAILED", payload: { version: 2 } });
    await handle.close();

    const file = await open(path, "r+");
    await file.write(Buffer.from([0xff]), 0, 1, 40 + 16);
    await file.write(Buffer.from([0xff]), 0, 1, 40 + 1024 + 16);
    await file.close();

    const reopened = await open(path, "r+");
    const recovered = await openRecoveryJournal(reopened, { slotCapacity: 1024 });
    await expect(recovered.recover()).rejects.toBeInstanceOf(RecoveryJournalCorruptError);
    await reopened.close();
  });

  it("rejects oversized records before replacing the recoverable record", async () => {
    const { handle } = await journalFile();
    const journal = await openRecoveryJournal(handle, { slotCapacity: 128 });
    await journal.write({ phase: "PREPARED", payload: { retained: true } });

    await expect(
      journal.write({
        phase: "COMMITTED",
        payload: { body: "x".repeat(200) },
      }),
    ).rejects.toBeInstanceOf(RecoveryJournalCapacityError);

    await expect(journal.recover()).resolves.toEqual({
      sequence: 1,
      phase: "PREPARED",
      payload: { retained: true },
    });
    await handle.close();
  });
});
