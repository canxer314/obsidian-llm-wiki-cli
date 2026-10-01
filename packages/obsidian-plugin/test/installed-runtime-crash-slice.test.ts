import { activateInstalledRuntimeAcceptanceDriver, createInstalledRuntimeAcceptanceDescriptor } from "../src/installed-runtime/smoke-command.js";
import { requestInstalledCrashRestorationScenario } from "../src/installed-runtime/crash-restoration-protocol.js";
import { mkdtemp, mkdir, readdir, open, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { crashRestorationBoundaryPath, loadCrashBoundaryReport, writeCrashRestorationBoundaryReport } from "../src/installed-runtime/crash-restoration-protocol.js";
import { openRecoveryJournal } from "../src/recovery-journal.js";
import { readInstalledCrashJournal, runInstalledCrashRestorationSlice } from "../src/installed-runtime/installed-crash-restoration-slice.js";
import { brandVerifiedCandidateBundle, inspectCandidateBundle } from "../src/installed-runtime/candidate-bundle.js";
import { ObsidianProcessError } from "../src/installed-runtime/obsidian-process.js";
import type { InstalledCrashRestorationSliceOptions } from "../src/installed-runtime/installed-crash-restoration-slice.js";

it("checks a persisted crash listener before deleting roots after a preflight failure", async () => {
  const root = await mkdtemp(join(tmpdir(), "installed-crash-preflight-stop-"));
  const candidateDirectory = join(root, "candidate");
  await mkdir(candidateDirectory);
  await writeFile(join(candidateDirectory, "manifest.json"), JSON.stringify({ id: "crash-plugin", version: "0.1.0", minAppVersion: "1.0.0" }));
  await writeFile(join(candidateDirectory, "main.js"), "candidate");
  const candidate = brandVerifiedCandidateBundle({
    bundleDirectory: candidateDirectory, identity: await inspectCandidateBundle(candidateDirectory),
    tag: "v0.1.0", repository: "test/crash", workflowRef: "test", attestationSource: "local-candidate",
  });
  const { createServer } = await import("node:net");
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  let vaultPath = "";
  let cleanedDescriptor = false;
  try {
    await expect(runInstalledCrashRestorationSlice({
      runId: "preflight-stop", workingDirectory: root, reportDirectory: join(root, "reports"), candidate,
      processControl: { start: async request => {
        vaultPath = request.vaultPath;
        await writeFile(join(vaultPath, ".obsidian", "plugins", "crash-plugin", "data.json"), JSON.stringify({ vaultId: "preflight-vault", port }));
        return { stop: async () => undefined };
      } },
      client: {}, profile: {}, probe: { probeRunning: async () => { throw new Error("Runtime preflight refused"); } },
      timeouts: { startupMs: 10, stopMs: 10, portClosedMs: 30 },
      prepareAcceptanceDriver: async request => {
        const created = await createInstalledRuntimeAcceptanceDescriptor({ ...request, runId: "preflight-stop", reportDirectory: join(root, "reports") });
        return { ...created, cleanup: async () => { cleanedDescriptor = true; } };
      }, record: () => undefined, assertion: () => undefined,
    } as InstalledCrashRestorationSliceOptions)).rejects.toBeInstanceOf(ObsidianProcessError);
    expect(cleanedDescriptor).toBe(false);
    expect(await readdir(vaultPath)).toContain(".obsidian");
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

it("rejects a crash descriptor for a foreign Vault, plugin, or installed entry point before startup", async () => {
  const root = await mkdtemp(join(tmpdir(), "installed-crash-binding-"));
  const candidateDirectory = join(root, "candidate");
  await mkdir(candidateDirectory);
  await writeFile(join(candidateDirectory, "manifest.json"), JSON.stringify({ id: "crash-plugin", version: "0.1.0", minAppVersion: "1.0.0" }));
  await writeFile(join(candidateDirectory, "main.js"), "candidate");
  const candidate = brandVerifiedCandidateBundle({
    bundleDirectory: candidateDirectory, identity: await inspectCandidateBundle(candidateDirectory),
    tag: "v0.1.0", repository: "test/crash", workflowRef: "test", attestationSource: "local-candidate",
  });
  let starts = 0;
  try {
    for (const changed of [
      { vaultPath: join(root, "foreign-vault") },
      { pluginId: "foreign-plugin" },
      { installedMainSha256: "f".repeat(64) },
    ]) {
      await expect(runInstalledCrashRestorationSlice({
        runId: "binding", workingDirectory: root, reportDirectory: join(root, "reports"), candidate,
        processControl: { start: async () => { starts += 1; throw new Error("Unexpected runtime startup"); } },
        client: {}, profile: {}, probe: {}, timeouts: { startupMs: 10, stopMs: 10, portClosedMs: 10 },
        prepareAcceptanceDriver: async (request) => {
          const created = await createInstalledRuntimeAcceptanceDescriptor({ ...request, runId: "binding", reportDirectory: join(root, "reports") });
          return { ...created, descriptor: { ...created.descriptor, ...changed }, cleanup: async () => undefined };
        },
        record: () => undefined, assertion: () => undefined,
      } as InstalledCrashRestorationSliceOptions)).rejects.toThrow("descriptor is not candidate/run bound");
    }
    expect(starts).toBe(0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("continues inspecting an authenticated command after rejecting a malformed descriptor update", async () => {
  const root = await mkdtemp(join(tmpdir(), "installed-crash-invalid-update-"));
  const vaultPath = join(root, "installed-runtime-vault-invalid-update");
  const pluginDirectory = join(vaultPath, ".obsidian", "plugins", "crash-plugin");
  await mkdir(pluginDirectory, { recursive: true });
  await writeFile(join(pluginDirectory, "main.js"), "candidate");
  const created = await createInstalledRuntimeAcceptanceDescriptor({
    runId: "invalid-update", vaultPath, pluginId: "crash-plugin", reportDirectory: join(root, "reports"),
    candidateBundleSha256: "a".repeat(64),
  });
  let dispatched = 0;
  const activation = await activateInstalledRuntimeAcceptanceDriver({
    vaultPath, pluginId: "crash-plugin",
    executeCrashRestorationScenario: async () => { dispatched += 1; return { boundary: "after_prepared", journalPhase: "PREPARED" }; },
  });
  try {
    await writeFile(created.path, "{not-json");
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(dispatched).toBe(0);
    await writeFile(created.path, JSON.stringify(created.descriptor));
    await requestInstalledCrashRestorationScenario({
      descriptorPath: created.path, descriptor: created.descriptor,
      expectedVaultId: "update-vault", endpoint: new URL("http://127.0.0.1:32123/mcp"),
      input: { submissionKey: "update-key" }, crashPoint: "after_prepared",
    });
    await expect.poll(() => dispatched, { timeout: 1000 }).toBe(1);
  } finally { activation?.dispose(); await rm(root, { recursive: true, force: true }); }
});

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

it("does not leak a crash capability marker through a report-root symlink outside the generated workspace", async () => {
  const root = await mkdtemp(join(tmpdir(), "installed-crash-root-"));
  const outside = await mkdtemp(join(tmpdir(), "installed-crash-outside-"));
  const vaultPath = join(root, "installed-runtime-vault-root");
  const pluginDirectory = join(vaultPath, ".obsidian", "plugins", "crash-plugin");
  await mkdir(pluginDirectory, { recursive: true });
  await writeFile(join(pluginDirectory, "main.js"), "candidate");
  const reportDirectory = join(root, "reports");
  const created = await createInstalledRuntimeAcceptanceDescriptor({
    runId: "report-root", vaultPath, pluginId: "crash-plugin", reportDirectory,
    candidateBundleSha256: "a".repeat(64),
  });
  try {
    await rm(reportDirectory, { recursive: true, force: true });
    await symlink(outside, reportDirectory, "dir");
    await expect(writeCrashRestorationBoundaryReport({
      descriptor: created.descriptor, journalPhase: "PREPARED",
      command: { sequence: 1, capabilityToken: created.descriptor.capabilityToken,
        action: "run-crash-restoration-scenario", scenario: "create_note/after_prepared",
        expectedVaultId: "root-vault", endpoint: "http://127.0.0.1:32123/mcp",
        submissionKey: "root-key", input: {} },
    })).rejects.toThrow("report root");
    expect(await readdir(outside)).toEqual([]);
  } finally { await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); }
});

it("preserves the first durable crash marker when publication is repeated", async () => {
  const root = await mkdtemp(join(tmpdir(), "installed-crash-one-shot-"));
  const vaultPath = join(root, "installed-runtime-vault-one-shot");
  const pluginDirectory = join(vaultPath, ".obsidian", "plugins", "crash-plugin");
  await mkdir(pluginDirectory, { recursive: true });
  await writeFile(join(pluginDirectory, "main.js"), "candidate");
  const created = await createInstalledRuntimeAcceptanceDescriptor({
    runId: "one-shot", vaultPath, pluginId: "crash-plugin", reportDirectory: join(root, "reports"),
    candidateBundleSha256: "a".repeat(64),
  });
  const command = { sequence: 1, capabilityToken: created.descriptor.capabilityToken,
    action: "run-crash-restoration-scenario" as const, scenario: "create_note/after_prepared" as const,
    expectedVaultId: "one-shot-vault", endpoint: "http://127.0.0.1:32123/mcp", submissionKey: "first-key", input: {} };
  try {
    await mkdir(created.descriptor.reportDirectory);
    await expect(writeCrashRestorationBoundaryReport({
      descriptor: created.descriptor, command: { ...command, capabilityToken: "f".repeat(64) }, journalPhase: "PREPARED",
    })).rejects.toThrow("capability");
    expect(await readdir(created.descriptor.reportDirectory)).toEqual([]);
    await writeCrashRestorationBoundaryReport({ descriptor: created.descriptor, command, journalPhase: "PREPARED" });
    await expect(writeCrashRestorationBoundaryReport({
      descriptor: created.descriptor, command: { ...command, submissionKey: "second-key" }, journalPhase: "PREPARED",
    })).rejects.toMatchObject({ code: "EEXIST" });
    const retained = await loadCrashBoundaryReport({ ...created.descriptor,
      vaultId: command.expectedVaultId, endpoint: command.endpoint, submissionKey: command.submissionKey });
    expect(retained.submissionKey).toBe("first-key");
    expect(await readdir(created.descriptor.reportDirectory)).toEqual(["crash-restoration-after-prepared-boundary.json"]);
  } finally { await rm(root, { recursive: true, force: true }); }
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
