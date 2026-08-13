import { readFileSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { FrontmatterChange } from "../src/change-set.js";
import { createFileSystemChangeSetDataSource } from "../src/file-system-change-set-data-source.js";

interface FrontmatterFixture {
  name: string;
  original: string;
  changes: FrontmatterChange[];
  projected: string;
}

const frontmatterFixtures = JSON.parse(
  readFileSync(new URL("./frontmatter-fixtures.json", import.meta.url), "utf8"),
) as FrontmatterFixture[];
const roots: string[] = [];

async function frontmatterDataSource() {
  const root = await mkdtemp(join(tmpdir(), "vault-change-set-"));
  roots.push(root);
  return createFileSystemChangeSetDataSource(root, {
    exists: async () => false,
    readBinary: async () => new ArrayBuffer(0),
    stat: async () => null,
  });
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("filesystem Change Set preflight adapter", () => {
  it.each(frontmatterFixtures)("$name", async ({ original, changes, projected }) => {
    const dataSource = await frontmatterDataSource();

    const actual = await dataSource.projectFrontmatter?.(Buffer.from(original), changes);

    expect(Buffer.from(actual ?? [])).toEqual(Buffer.from(projected));
  });

  it("adds a field to an empty verified Frontmatter span", async () => {
    const dataSource = await frontmatterDataSource();
    const original = Buffer.from("---\n---\nbody\n");

    const projected = await dataSource.projectFrontmatter?.(original, [
      { kind: "set", key: "ready", value: true },
    ]);

    expect(Buffer.from(projected ?? [])).toEqual(
      Buffer.from("---\n\"ready\": true\n---\nbody\n"),
    );
  });

  it.each([
    ["invalid UTF-8", Buffer.from([0x2d, 0x2d, 0x2d, 0x0a, 0xff, 0x0a])],
    ["missing closing marker", Buffer.from("---\ntitle: Old\n")],
    ["non-mapping Frontmatter", Buffer.from("---\n- one\n---\nbody")],
    ["duplicate keys", Buffer.from("---\ntitle: one\ntitle: two\n---\nbody")],
    ["mixed newlines", Buffer.from("---\r\ntitle: one\n---\r\nbody")],
    ["YAML aliases", Buffer.from("---\nbase: &base one\nalias: *base\n---\nbody")],
    ["custom YAML tags", Buffer.from("---\nvalue: !unsafe one\n---\nbody")],
  ])("fails closed for %s", async (_name, original) => {
    const dataSource = await frontmatterDataSource();

    await expect(
      dataSource.projectFrontmatter?.(original, [
        { kind: "set", key: "title", value: "New" },
      ]),
    ).resolves.toBeNull();
  });

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
