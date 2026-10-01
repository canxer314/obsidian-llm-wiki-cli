import { activateInstalledRuntimeAcceptanceDriver, createInstalledRuntimeAcceptanceDescriptor } from "../src/installed-runtime/smoke-command.js";
import { requestInstalledCrashRestorationScenario } from "../src/installed-runtime/crash-restoration-protocol.js";
import { mkdtemp, mkdir, readdir, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { crashRestorationBoundaryPath, loadCrashBoundaryReport } from "../src/installed-runtime/crash-restoration-protocol.js";
import { openRecoveryJournal } from "../src/recovery-journal.js";
import { readInstalledCrashJournal } from "../src/installed-runtime/installed-crash-restoration-slice.js";

it("does not publish a PREPARED marker merely because a private crash command was dispatched", async () => {
  const root = await mkdtemp(join(tmpdir(), "installed-crash-dispatch-"));
  const vaultPath = join(root, "installed-runtime-vault-crash-dispatch");
  const pluginDirectory = join(vaultPath, ".obsidian", "plugins", "crash-plugin");
  await mkdir(pluginDirectory, { recursive: true });
  await writeFile(join(pluginDirectory, "main.js"), "candidate");
  const reportDirectory = join(root, "reports");
  const created = await createInstalledRuntimeAcceptanceDescriptor({
    runId: "dispatch", vaultPath, pluginId: "crash-plugin", reportDirectory,
    candidateBundleSha256: "a".repeat(64),
  });
  let dispatched = false;
  const activation = await activateInstalledRuntimeAcceptanceDriver({
    vaultPath, pluginId: "crash-plugin",
    executeCrashRestorationScenario: async () => {
      dispatched = true;
      return { boundary: "after_prepared", journalPhase: "PREPARED" };
    },
  });
  try {
    await requestInstalledCrashRestorationScenario({
      descriptorPath: created.path, descriptor: created.descriptor,
      expectedVaultId: "dispatch-vault", endpoint: new URL("http://127.0.0.1:32123/mcp"),
      input: { submissionKey: "dispatch-key" }, crashPoint: "after_prepared",
    });
    await expect.poll(() => dispatched).toBe(true);
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(await readdir(reportDirectory)).toEqual([]);
  } finally { activation?.dispose(); await rm(root, { recursive: true, force: true }); }
});

it("rejects a crash marker bound to a foreign endpoint or submission", async () => {
  const root = await mkdtemp(join(tmpdir(), "installed-crash-marker-"));
  const binding = {
    reportDirectory: root, runId: "marker-run", vaultId: "marker-vault",
    candidateBundleSha256: "a".repeat(64), installedMainSha256: "b".repeat(64),
    capabilityToken: "c".repeat(64), endpoint: "http://127.0.0.1:32123/mcp", submissionKey: "expected-key",
  };
  try {
    const report = {
      schemaVersion: 1, runId: binding.runId, vaultId: binding.vaultId,
      candidateBundleSha256: binding.candidateBundleSha256, installedMainSha256: binding.installedMainSha256,
      capabilityToken: binding.capabilityToken, scenario: "create_note/after_prepared",
      endpoint: binding.endpoint, submissionKey: binding.submissionKey,
      point: "after_prepared", journalPhase: "PREPARED",
    };
    for (const changed of [{ endpoint: "http://127.0.0.1:32124/mcp" }, { submissionKey: "foreign-key" }]) {
      await writeFile(crashRestorationBoundaryPath(root), JSON.stringify({ ...report, ...changed }));
      await expect(loadCrashBoundaryReport(binding)).rejects.toThrow("not bound");
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("observes the latest checksummed binary crash journal without modifying its bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "installed-crash-journal-"));
  const path = join(root, "recovery-journal.bin");
  const handle = await open(path, "wx+");
  try {
    const journal = await openRecoveryJournal(handle, { slotCapacity: 4096 });
    await journal.write({ phase: "PREPARED", payload: { submissionKey: "prepared-key" } });
    await journal.write({ phase: "ROLLED_BACK", payload: { submissionKey: "prepared-key" } });
    const before = await handle.readFile();
    const observed = await readInstalledCrashJournal(path);
    expect(observed).toEqual({ sequence: 2, phase: "ROLLED_BACK", payload: { submissionKey: "prepared-key" } });
    const bytes = Buffer.alloc(before.length);
    await handle.read(bytes, 0, bytes.length, 0);
    expect(bytes).toEqual(before);
  } finally {
    await handle.close();
    await rm(root, { recursive: true, force: true });
  }
});
