import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { assembleReleaseBundle } from "../src/release/assemble-release-bundle.js";
import { verifyReleaseBundle } from "../src/release/verify-release-bundle.js";
import { runOfflineLifecycleRetainedStateSlice } from "../src/installed-runtime/lifecycle-retained-state-slice.js";
import { MVP_PERF_REF_LINUX_1 } from "../src/installed-runtime/runtime-profile.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function arrange() {
  const root = await mkdtemp(join(tmpdir(), "475-durable-state-")); roots.push(root);
  const packageRoot = join(root, "pkg"); await mkdir(join(packageRoot, "dist"), { recursive: true });
  await writeFile(join(packageRoot, "manifest.json"), JSON.stringify({ id: "llm-wiki-vault-bridge", name: "Fixture", version: "0.1.0", minAppVersion: "1.13.4", isDesktopOnly: true }));
  await writeFile(join(packageRoot, "package.json"), '{"version":"0.1.0"}');
  await writeFile(join(packageRoot, "dist/main.js"), "// fixture, not real installed acceptance\n");
  const bundleDirectory = join(root, "bundle"); await assembleReleaseBundle({ tag: "v0.1.0", packageRoot, bundleDirectory });
  return { root, candidate: await verifyReleaseBundle({ bundleDirectory, expectedTag: "v0.1.0" }) };
}

it("repairs a verified same-version bundle while preserving a nonempty product-persisted queue and readable PREPARED Journal", async () => {
  const { root, candidate } = await arrange();
  const records: unknown[] = [];
  const result = await runOfflineLifecycleRetainedStateSlice({ candidate, workingDirectory: root, runId: "durable",
    profile: MVP_PERF_REF_LINUX_1, profileName: MVP_PERF_REF_LINUX_1.name,
    record: (_kind, _name, value) => records.push(value), assertion: () => {},
  });
  expect(result).toMatchObject({ scope: "offline-repair-durable-queue-prepared-journal", verdict: "partial", repair: { action: "repaired" },
    before: { queuedCount: 1, executingCount: 1, recordCount: 2, journalPhase: "PREPARED" },
    after: { queuedCount: 1, executingCount: 1, recordCount: 2, journalPhase: "PREPARED" },
    statePreserved: true, cleanup: { attempted: true, residualPaths: [] },
  });
  expect(result.before).toEqual(result.after);
  expect(result.before?.journalSequence).toBe(1);
  expect(JSON.stringify(records)).not.toContain(root);
  expect(JSON.stringify(records)).not.toContain("durable-key");
  expect(JSON.stringify(records)).not.toContain("beforeImages");
});

for (const damaged of ["journal", "queued-record", "empty-directory", "public-prefix"] as const) {
  it(`fails retained-state evidence when repair staging loses ${damaged}`, async () => {
    const { root, candidate } = await arrange();
    const result = await runOfflineLifecycleRetainedStateSlice({ candidate, workingDirectory: root, runId: `loss-${damaged}`,
      profile: MVP_PERF_REF_LINUX_1, profileName: MVP_PERF_REF_LINUX_1.name, record: () => {}, assertion: () => { throw new Error("Lost state cannot assert success"); },
      repairOptions: { hooks: { duringSwap: async ({ vaultPath }) => {
        if (damaged === "journal") await writeFile(join(vaultPath, ".llm-wiki/recovery-journal.bin"), "LRJNL001-state-bytes\n");
        if (damaged === "empty-directory") await rm(join(vaultPath, ".obsidian-public/empty"), { recursive: true });
        if (damaged === "public-prefix") await rm(join(vaultPath, ".obsidian-public/retain.bin"));
        if (damaged === "queued-record") {
          const { readdir } = await import("node:fs/promises");
          const plugins = join(vaultPath, ".obsidian/plugins");
          const staged = (await readdir(plugins)).find(name => name.includes(".staging-"));
          if (staged === undefined) throw new Error("No staging directory");
          const data = join(plugins, staged, "data.json");
          const settings = JSON.parse(await readFile(data, "utf8"));
          settings.changeSets.entries = settings.changeSets.entries.filter((entry: { execution?: { phase: string } }) => entry.execution?.phase !== "queued");
          await writeFile(data, JSON.stringify(settings));
        }
      } } },
    });
    expect(result).toMatchObject({ verdict: "failed", statePreserved: false });
    expect(result.before).toMatchObject({ queuedCount: 1, journalPhase: "PREPARED" });
    expect(result.repair).toMatchObject({ action: "repaired" });
    expect(result.failedStage).toBe("state-preservation");
  });
}
