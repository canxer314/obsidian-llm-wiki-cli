import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createFileSystemChangeSetDataSource } from "../src/file-system-change-set-data-source.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("filesystem Change Set preflight adapter", () => {
  it("rejects a case-folded alias of an existing canonical path", async () => {
    const root = await mkdtemp(join(tmpdir(), "vault-change-set-"));
    roots.push(root);
    await mkdir(join(root, "Notes"));
    await writeFile(join(root, "Notes", "A.md"), "alpha");
    const dataSource = createFileSystemChangeSetDataSource(root, {
      exists: async () => false,
      readBinary: async () => new ArrayBuffer(0),
      stat: async () => null,
    });

    await expect(dataSource.isContained("Notes/A.md")).resolves.toBe(true);
    await expect(dataSource.isContained("notes/A.md")).resolves.toBe(false);
    await expect(dataSource.isContained("Notes/New.md")).resolves.toBe(true);
  });
});
