import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  FIXED_PERFORMANCE_FIXTURE_MANIFEST_FILENAME,
  FixtureLifecycleError,
  cleanupFixedPerformanceFixture,
  fixedPerformanceFixtureManifest,
  fixedPerformanceFixtureTargetPath,
  prepareFixedPerformanceFixture,
  restoreFixedPerformanceFixture,
  runFixedPerformanceFixture,
  verifyFixedPerformanceFixture,
  type FixedPerformanceFixtureFileSystem,
} from "../src/performance-fixture.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "fixed-performance-fixture-"));
  roots.push(root);
  return root;
}

function readOptions(workingDirectory: string) {
  return { workingDirectory, fixture: "read-v1" as const };
}

function changeOptions(workingDirectory: string) {
  return { workingDirectory, fixture: "change-v1" as const };
}

function fileSystemWith(
  overrides: Partial<FixedPerformanceFixtureFileSystem>,
): FixedPerformanceFixtureFileSystem {
  const passthrough: FixedPerformanceFixtureFileSystem = {
    async exists(path) {
      try {
        await stat(path);
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw error;
      }
    },
    async mkdir(path) {
      const { mkdir } = await import("node:fs/promises");
      await mkdir(path, { recursive: true });
    },
    async createDirectory(path) {
      const { mkdir } = await import("node:fs/promises");
      await mkdir(path);
    },
    async readFile(path) {
      return new Uint8Array(await readFile(path));
    },
    async writeFile(path, bytes) {
      await writeFile(path, bytes, { flag: "wx" });
    },
    async readdir(path) {
      const { readdir } = await import("node:fs/promises");
      return (await readdir(path, { withFileTypes: true })).map((entry) => ({
        name: entry.name,
        kind: entry.isFile() ? "file" as const : entry.isDirectory() ? "directory" as const : "other" as const,
      }));
    },
    async removeTree(path) {
      await rm(path, { recursive: true, force: true });
    },
  };
  return { ...passthrough, ...overrides };
}

describe("fixed performance fixture generation", () => {
  it("generates both fixed corpora with deterministic canonical manifests", async () => {
    const root = await makeRoot();

    const read = await prepareFixedPerformanceFixture(readOptions(root));
    const change = await prepareFixedPerformanceFixture(changeOptions(root));

    expect(read.manifest).toMatchObject({
      fixtureVersion: "read-v1",
      seed: "mvp-perf-read-v1",
      noteCount: 1_000,
      totalContentBytes: 7_531_464,
    });
    expect(read.manifest.inventory).toHaveLength(1_000);
    expect(read.manifest.inventory.filter((entry) => entry.sizeBytes === 2_608)).toHaveLength(500);
    expect(read.manifest.inventory.filter((entry) => entry.sizeBytes === 10_240)).toHaveLength(449);
    expect(read.manifest.inventory.filter((entry) => entry.sizeBytes === 29_316)).toHaveLength(50);
    expect(read.manifest.inventory.filter((entry) => entry.sizeBytes === 163_904)).toHaveLength(1);
    expect(read.manifest.workload).toMatchObject({
      discovery: { expectedPaths: expect.any(Array) },
      exactRead: { orderedPaths: expect.any(Array), expectedContentBytes: 52_160, continuation: "none" },
    });
    expect((read.manifest.workload.discovery as { expectedPaths: string[] }).expectedPaths).toHaveLength(20);
    expect((read.manifest.workload.exactRead as { orderedPaths: string[] }).orderedPaths).toHaveLength(20);
    expect(change.manifest).toMatchObject({
      fixtureVersion: "change-v1",
      seed: "mvp-perf-change-v1",
      noteCount: 20,
      totalContentBytes: 81_920,
    });
    expect((change.manifest.workload.changeSet as { operations: unknown[]; sourceNoteClosure: unknown[] }).operations).toHaveLength(20);
    expect((change.manifest.workload.changeSet as { operations: unknown[]; sourceNoteClosure: unknown[] }).sourceNoteClosure).toHaveLength(20);
    expect(read.evidence.verdict).toBe("passed");
    expect(change.evidence.verdict).toBe("passed");

    const verified = await verifyFixedPerformanceFixture(readOptions(root));
    expect(verified.manifest.manifestSha256).toBe(read.manifest.manifestSha256);
  });

  it("is repeatable only after cleanup and always refuses a pre-existing target", async () => {
    const root = await makeRoot();
    const first = await prepareFixedPerformanceFixture(readOptions(root));

    await expect(prepareFixedPerformanceFixture(readOptions(root))).rejects.toMatchObject({
      name: "FixtureLifecycleError",
      code: "target_exists",
    });
    await expect(readFile(join(first.fixturePath, "Evidence", "evidence-001.md"), "utf8")).resolves.toContain(
      "mvp-perf-read-v1-discovery-token",
    );

    const cleaned = await cleanupFixedPerformanceFixture(readOptions(root));
    expect(cleaned.evidence.cleanup).toEqual({ attempted: true, cleanupFailed: false, residualPaths: [] });
    const second = await prepareFixedPerformanceFixture(readOptions(root));
    expect(second.manifest.manifestSha256).toBe(first.manifest.manifestSha256);
  });

  it("refuses manifest tampering and content inventory mismatches", async () => {
    const root = await makeRoot();
    const prepared = await prepareFixedPerformanceFixture(changeOptions(root));
    const manifestPath = join(prepared.fixturePath, FIXED_PERFORMANCE_FIXTURE_MANIFEST_FILENAME);
    await writeFile(manifestPath, "{}\n", "utf8");

    await expect(verifyFixedPerformanceFixture(changeOptions(root))).rejects.toMatchObject({
      code: "manifest_invalid",
    });

    await restoreFixedPerformanceFixture(changeOptions(root));
    await writeFile(join(prepared.fixturePath, "Changes", "change-001.md"), "tampered\n", "utf8");
    await expect(verifyFixedPerformanceFixture(changeOptions(root))).rejects.toMatchObject({
      code: "inventory_mismatch",
    });
  });

  it("restores a mutated corpus to the exact canonical inventory before work", async () => {
    const root = await makeRoot();
    const prepared = await prepareFixedPerformanceFixture(changeOptions(root));
    const note = join(prepared.fixturePath, "Changes", "change-001.md");
    await writeFile(note, "mutated\n", "utf8");
    await writeFile(join(prepared.fixturePath, "unexpected.md"), "residue\n", "utf8");

    const restored = await restoreFixedPerformanceFixture(changeOptions(root));
    expect(restored.evidence.verdict).toBe("passed");
    expect(restored.evidence.inventoryComparison.changedPaths).toContain("Changes/change-001.md");
    expect(restored.evidence.inventoryComparison.removedPaths).toContain("unexpected.md");
    await expect(verifyFixedPerformanceFixture(changeOptions(root))).resolves.toMatchObject({
      manifest: { manifestSha256: prepared.manifest.manifestSha256 },
    });
  });
});

describe("fixed performance fixture failure evidence", () => {
  it("reports setup failure and cleans partial setup without an Obsidian runtime", async () => {
    const root = await makeRoot();
    let writes = 0;
    const fileSystem = fileSystemWith({
      async writeFile(path, bytes) {
        writes += 1;
        if (writes === 5) throw new Error("injected setup write failure");
        await writeFile(path, bytes, { flag: "wx" });
      },
    });

    await expect(
      prepareFixedPerformanceFixture({ ...readOptions(root), fileSystem }),
    ).rejects.toMatchObject({
      code: "setup_failed",
      evidence: {
        cleanup: { attempted: true, cleanupFailed: false, residualPaths: [] },
      },
    });
    await expect(stat(fixedPerformanceFixtureTargetPath(readOptions(root)))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reports restore failure with cleanup evidence after an injected partial failure", async () => {
    const root = await makeRoot();
    await prepareFixedPerformanceFixture(readOptions(root));
    let failing = false;
    let writes = 0;
    const fileSystem = fileSystemWith({
      async writeFile(path, bytes) {
        if (failing && ++writes === 4) throw new Error("injected restore write failure");
        await writeFile(path, bytes, { flag: "wx" });
      },
    });
    failing = true;

    await expect(
      restoreFixedPerformanceFixture({ ...readOptions(root), fileSystem }),
    ).rejects.toMatchObject({
      code: "restore_failed",
      evidence: {
        cleanup: { attempted: true, cleanupFailed: false, residualPaths: [] },
      },
    });
  });

  it("never turns a cleanup failure or residual content into success", async () => {
    const root = await makeRoot();
    await prepareFixedPerformanceFixture(readOptions(root));
    const rootPath = fixedPerformanceFixtureTargetPath(readOptions(root));
    const fileSystem = fileSystemWith({
      async removeTree() {
        throw new Error("injected cleanup refusal");
      },
    });

    await expect(cleanupFixedPerformanceFixture({ ...readOptions(root), fileSystem })).rejects.toMatchObject({
      code: "cleanup_failed",
      evidence: {
        verdict: "failed",
        cleanup: { attempted: true, cleanupFailed: true, residualPaths: expect.any(Array) },
      },
    });
    await expect(stat(rootPath)).resolves.toBeDefined();
  });

  it("runs cleanup in finally when the benchmark action fails", async () => {
    const root = await makeRoot();
    const target = fixedPerformanceFixtureTargetPath(readOptions(root));

    await expect(
      runFixedPerformanceFixture(readOptions(root), async ({ restore }) => {
        await restore();
        throw new Error("benchmark action failure");
      }),
    ).rejects.toMatchObject({ code: "setup_failed" });
    await expect(stat(target)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("publishes the fixed canonical definition independent of local paths", () => {
    const manifest = fixedPerformanceFixtureManifest("read-v1");
    expect(manifest.root).toBe(".mvp-perf-fixture/read-v1");
    expect(manifest.inventory.every((entry) => !entry.path.startsWith("/"))).toBe(true);
  });
});
