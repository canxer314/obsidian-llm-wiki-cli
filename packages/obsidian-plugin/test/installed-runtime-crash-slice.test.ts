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

it("rejects an installed crash command targeting a remote endpoint even with the correct capability", async () => {
  const root = await mkdtemp(join(tmpdir(), "installed-crash-remote-"));
  const vaultPath = join(root, "installed-runtime-vault-remote");
  const pluginDirectory = join(vaultPath, ".obsidian", "plugins", "crash-plugin");
  await mkdir(pluginDirectory, { recursive: true });
  await writeFile(join(pluginDirectory, "main.js"), "candidate");
  const created = await createInstalledRuntimeAcceptanceDescriptor({
    runId: "remote", vaultPath, pluginId: "crash-plugin", reportDirectory: join(root, "reports"),
    candidateBundleSha256: "a".repeat(64),
  });
  let dispatched = 0;
  const activation = await activateInstalledRuntimeAcceptanceDriver({
    vaultPath, pluginId: "crash-plugin",
    executeCrashRestorationScenario: async () => { dispatched += 1; return { boundary: "after_prepared", journalPhase: "PREPARED" }; },
  });
  try {
    await writeFile(created.path, JSON.stringify({ ...created.descriptor, command: {
      sequence: 1, capabilityToken: created.descriptor.capabilityToken,
      action: "run-crash-restoration-scenario", scenario: "create_note/after_prepared",
      expectedVaultId: "remote-vault", endpoint: "https://example.com/mcp", submissionKey: "remote-key", input: {},
    } }));
    await new Promise(resolve => setTimeout(resolve, 150));
    expect(dispatched).toBe(0);
    await writeFile(created.path, JSON.stringify(created.descriptor));
    await requestInstalledCrashRestorationScenario({
      descriptorPath: created.path, descriptor: created.descriptor,
      expectedVaultId: "remote-vault", endpoint: new URL("http://127.0.0.1:32123/mcp"),
      input: { submissionKey: "local-key" }, crashPoint: "after_prepared",
    });
    await expect.poll(() => dispatched, { timeout: 1000 }).toBe(1);
  } finally { activation?.dispose(); await rm(root, { recursive: true, force: true }); }
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

it("publishes a separate authenticated COMMITTED command and boundary without accepting it as PREPARED", async () => {
  const root = await mkdtemp(join(tmpdir(), "installed-crash-committed-"));
  const vaultPath = join(root, "installed-runtime-vault-committed");
  const pluginDirectory = join(vaultPath, ".obsidian", "plugins", "crash-plugin");
  await mkdir(pluginDirectory, { recursive: true });
  await writeFile(join(pluginDirectory, "main.js"), "candidate");
  const created = await createInstalledRuntimeAcceptanceDescriptor({
    runId: "committed", vaultPath, pluginId: "crash-plugin", reportDirectory: join(root, "reports"),
    candidateBundleSha256: "a".repeat(64),
  });
  try {
    await requestInstalledCrashRestorationScenario({ descriptorPath: created.path, descriptor: created.descriptor,
      expectedVaultId: "committed-vault", endpoint: new URL("http://127.0.0.1:32123/mcp"),
      input: { submissionKey: "committed-key" }, crashPoint: "after_committed" });
    const { readFile } = await import("node:fs/promises");
    const updated = JSON.parse(await readFile(created.path, "utf8"));
    expect(updated.command.scenario).toBe("create_note/after_committed");
    await mkdir(created.descriptor.reportDirectory);
    await writeCrashRestorationBoundaryReport({ descriptor: created.descriptor, command: updated.command, journalPhase: "COMMITTED" });
    const binding = { ...created.descriptor, vaultId: "committed-vault", endpoint: updated.command.endpoint, submissionKey: "committed-key" };
    expect(await loadCrashBoundaryReport({ ...binding, crashPoint: "after_committed" })).toMatchObject({ point: "after_committed", journalPhase: "COMMITTED" });
    await expect(loadCrashBoundaryReport(binding)).rejects.toMatchObject({ code: "ENOENT" });
  } finally { await rm(root, { recursive: true, force: true }); }
});


it("rejects a private crash command against a dirty durable journal without arming execution", async () => {
  const root = await mkdtemp(join(tmpdir(), "installed-crash-dirty-command-"));
  const vaultPath = join(root, "installed-runtime-vault-dirty-command");
  const pluginDirectory = join(vaultPath, ".obsidian", "plugins", "crash-plugin");
  await mkdir(pluginDirectory, { recursive: true });
  await writeFile(join(pluginDirectory, "main.js"), "candidate");
  const created = await createInstalledRuntimeAcceptanceDescriptor({
    runId: "dirty-command", vaultPath, pluginId: "crash-plugin", reportDirectory: join(root, "reports"),
    candidateBundleSha256: "a".repeat(64),
  });
  await mkdir(join(vaultPath, ".llm-wiki"));
  const handle = await open(join(vaultPath, ".llm-wiki", "recovery-journal.bin"), "wx+");
  const journal = await openRecoveryJournal(handle, { slotCapacity: 4096 });
  await journal.write({ phase: "PREPARED", payload: { submissionKey: "another-submission" } });
  await handle.close();
  let armed = 0;
  const activation = await activateInstalledRuntimeAcceptanceDriver({
    vaultPath, pluginId: "crash-plugin",
    executeCrashRestorationScenario: async () => { armed += 1; return { boundary: "after_prepared", journalPhase: "PREPARED" }; },
  });
  try {
    await requestInstalledCrashRestorationScenario({ descriptorPath: created.path, descriptor: created.descriptor,
      expectedVaultId: "dirty-vault", endpoint: new URL("http://127.0.0.1:32123/mcp"),
      input: { submissionKey: "dirty-key" }, crashPoint: "after_prepared" });
    await new Promise(resolve => setTimeout(resolve, 150));
    expect(armed).toBe(0);
    expect(await readdir(created.descriptor.reportDirectory)).toEqual([]);
  } finally { activation?.dispose(); await rm(root, { recursive: true, force: true }); }
});


// Orchestration-only fixture. This is deliberately not installed-Obsidian evidence.
async function arrangeCrashOrchestration(root: string, replayId: string, crashPoint: "after_prepared" | "after_committed" = "after_prepared", mutationKind: "create_note" | "edit_body" = "create_note") {
  const { createServer } = await import("node:http");
  const { readFile } = await import("node:fs/promises");
  const candidateDirectory = join(root, "candidate");
  await mkdir(candidateDirectory);
  await writeFile(join(candidateDirectory, "manifest.json"), JSON.stringify({ id: "crash-plugin", version: "0.1.0", minAppVersion: "1.0.0" }));
  await writeFile(join(candidateDirectory, "main.js"), "orchestration-only candidate");
  const candidate = brandVerifiedCandidateBundle({ bundleDirectory: candidateDirectory,
    identity: await inspectCandidateBundle(candidateDirectory), tag: "v0.1.0", repository: "test/crash",
    workflowRef: "test", attestationSource: "local-candidate" });
  await mkdir(join(root, "reports"));
  let starts = 0;
  let descriptorPath = "";
  let vaultPath = "";
  let publish: Promise<void> = Promise.resolve();
  const vault = { writeGate: "open", writeState: "writable" };
  const terminal = () => crashPoint === "after_prepared"
    ? { state: "intent_not_applied" }
    : { state: "intent_applied", preview: { requestedEffects: [], derivedEffects: [], paths: [] }, requestedEffects: [], derivedEffects: [], paths: [] };
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", chunk => chunks.push(chunk));
    request.on("end", () => {
      if (chunks.length === 0) { response.writeHead(200).end(); return; }
      const message = JSON.parse(Buffer.concat(chunks).toString());
      if (message.method === "notifications/initialized") { response.writeHead(202).end(); return; }
      let result: unknown;
      if (message.method === "initialize") result = { protocolVersion: message.params.protocolVersion,
        capabilities: {}, serverInfo: { name: "orchestration-only", version: "0" } };
      else {
        const submitting = message.params.name === "vault_change_set_submit";
        const changeSet = { changeSetId: submitting ? replayId : "bound-change-set",
          ...(starts % 2 === 1 ? { state: "in_progress" } : terminal()) };
        const structuredContent = submitting ? { outcome: "registered", changeSet, vault } : { lookup: "found", changeSet, vault };
        result = { isError: submitting && crashPoint === "after_prepared", structuredContent, content: [{ type: "text", text: JSON.stringify(structuredContent) }] };
      }
      response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  const profile = { name: "orchestration", os: { platform: "linux", build: "test" },
    versions: { obsidian: "test", electron: "test", node: "test" }, capabilities: [], profileRequirement: "dedicated_candidate_only" };
  const writeFrame = async (phase: "PREPARED" | "ROLLED_BACK" | "COMMITTED", input: unknown) => {
    await mkdir(join(vaultPath, ".llm-wiki"), { recursive: true });
    const handle = await open(join(vaultPath, ".llm-wiki", "recovery-journal.bin"), starts % 2 === 1 ? "wx+" : "r+");
    try { await (await openRecoveryJournal(handle, { slotCapacity: 4096 })).write({ phase, payload: { vaultId: "orchestration-vault", changeSetId: "bound-change-set", input } }); }
    finally { await handle.close(); }
  };
  const options = {
    runId: "orchestration", crashPoint, mutationKind, workingDirectory: root, reportDirectory: join(root, "reports"), candidate,
    profile, probe: { probeRunning: async () => ({ platform: "linux", osBuild: "test", obsidianVersion: "test", electronVersion: "test", nodeVersion: "test", capabilities: [] }) },
    processControl: { start: async request => {
      starts += 1; vaultPath = request.vaultPath;
      await new Promise<void>(resolve => server.listen(port, "127.0.0.1", resolve));
      await writeFile(join(vaultPath, ".obsidian", "plugins", "crash-plugin", "data.json"), JSON.stringify({ vaultId: "orchestration-vault", port }));
      if (starts % 2 === 0) { const descriptor = JSON.parse(await readFile(descriptorPath, "utf8")); await writeFrame(crashPoint === "after_prepared" ? "ROLLED_BACK" : "COMMITTED", descriptor.command.input); }
      return { stop: async () => { await publish; await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); } };
    } },
    client: { observeHealth: async () => {
      return { health: { readiness: { searchSnapshot: "ready" }, recovery: { state: "none" } } };
    } },
    timeouts: { startupMs: 500, stopMs: 500, portClosedMs: 500 },
    prepareAcceptanceDriver: async request => { const created = await createInstalledRuntimeAcceptanceDescriptor({ ...request, runId: "orchestration", reportDirectory: join(root, "reports") }); descriptorPath = created.path; return { ...created, cleanup: async () => undefined }; },
    record: () => undefined, assertion: () => undefined,
  } as InstalledCrashRestorationSliceOptions;
  // Publish after the real file command becomes visible; no private runner internals are mocked.
  let publishingPath = "";
  const timer = setInterval(() => {
    if (starts % 2 === 0 || descriptorPath === "") return;
    void readFile(descriptorPath, "utf8").then(JSON.parse).then(async descriptor => {
      if (descriptor.command.action === "idle") return;
      if (publishingPath === descriptorPath) return;
      publishingPath = descriptorPath;
      crashPoint = descriptor.command.scenario.endsWith("/after_prepared") ? "after_prepared" : "after_committed";
      publish = (async () => {
        if (descriptor.command.scenario.endsWith("/after_committed")) {
          await mkdir(join(vaultPath, "Corpus", "Notes"), { recursive: true });
          const { CREATE_NOTE_BYTES } = await import("../src/corpus/create-note-corpus.js");
          if (descriptor.command.scenario.startsWith("edit_body/")) {
            const { EXACT_COMMITTED_BYTES } = await import("../src/corpus/edit-fixtures.js");
            await writeFile(join(vaultPath, "Corpus", "Edits", "Exact.md"), EXACT_COMMITTED_BYTES);
          } else await writeFile(join(vaultPath, "Corpus", "Notes", "Alpha.md"), CREATE_NOTE_BYTES);
        }
        const phase = descriptor.command.scenario.endsWith("/after_prepared") ? "PREPARED" : "COMMITTED";
        await writeFrame(phase, descriptor.command.input);
        await writeCrashRestorationBoundaryReport({ descriptor, command: descriptor.command, journalPhase: phase }); })();
      await publish;
    }).catch(() => undefined);
  }, 10);
  return { options, cleanup: async () => { clearInterval(timer); if (server.listening) await new Promise<void>(resolve => server.close(() => resolve())); } };
}

it("rejects a terminal replay with a foreign Change Set identity at the public run boundary", async () => {
  const root = await mkdtemp(join(tmpdir(), "installed-crash-replay-identity-"));
  const fixture = await arrangeCrashOrchestration(root, "foreign-change-set");
  try {
    await expect(runInstalledCrashRestorationSlice(fixture.options)).rejects.toThrow("replay the retained terminal record");
  } finally { await fixture.cleanup(); await rm(root, { recursive: true, force: true }); }
});


it("orchestrates COMMITTED process stop, restart and retained replay without promoting full crash acceptance", async () => {
  const root = await mkdtemp(join(tmpdir(), "installed-crash-committed-orchestration-"));
  const fixture = await arrangeCrashOrchestration(root, "bound-change-set", "after_committed");
  try {
    const outcome = await runInstalledCrashRestorationSlice(fixture.options);
    expect(outcome.scope).toBe("single-after-committed-installed-replay-slice");
    expect(outcome.records).toMatchObject([{ crashPoint: "after_committed", preparedJournalPhase: "COMMITTED",
      journalPhase: "COMMITTED", proofState: "intent_applied", originalFileAbsentAfterRecovery: false,
      committedFileBytesPreservedAfterRecovery: true, processStoppedBeforeRestart: true, cleanupSucceeded: true }]);
  } finally { await fixture.cleanup(); await rm(root, { recursive: true, force: true }); }
});


it("keeps both wired installed crash boundaries partial at the authoritative corpus run boundary", async () => {
  const root = await mkdtemp(join(tmpdir(), "installed-crash-partial-orchestration-"));
  const fixture = await arrangeCrashOrchestration(root, "bound-change-set");
  const { createAuthoritativeInstalledRuntimeRunners } = await import("../src/installed-runtime/smoke-command.js");
  const records: unknown[] = [];
  try {
    await expect(createAuthoritativeInstalledRuntimeRunners().runCrashRestorationRetainedAuthorityCorpus({
      installed: fixture.options, workingDirectory: root,
      record: (_kind, name, detail) => { if (name.startsWith("installed-crash-")) records.push(detail); },
      assertion: () => undefined,
    })).rejects.toThrow("partial");
    expect(records).toHaveLength(4);
    expect(records).toMatchObject([
      { scope: "single-after-prepared-installed-rollback-slice" },
      { scope: "single-after-committed-installed-replay-slice" },
      { scope: "single-after-prepared-installed-rollback-slice", records: [{ mutationKind: "edit_body" }] },
      { scope: "single-after-committed-installed-replay-slice", records: [{ mutationKind: "edit_body" }] },
    ]);
  } finally { await fixture.cleanup(); await rm(root, { recursive: true, force: true }); }
});


it("orchestrates edit_body PREPARED with exact original bytes and full retained status replay", async () => {
  const root = await mkdtemp(join(tmpdir(), "installed-crash-edit-prepared-"));
  const fixture = await arrangeCrashOrchestration(root, "bound-change-set", "after_prepared", "edit_body");
  try {
    const outcome = await runInstalledCrashRestorationSlice(fixture.options);
    expect(outcome.records).toMatchObject([{ mutationKind: "edit_body", crashPoint: "after_prepared",
      proofState: "intent_not_applied", originalFileAbsentAfterRecovery: false, originalFileBytesPreservedAfterRecovery: true }]);
  } finally { await fixture.cleanup(); await rm(root, { recursive: true, force: true }); }
});


it("orchestrates edit_body COMMITTED with exact intended bytes and full retained status replay", async () => {
  const root = await mkdtemp(join(tmpdir(), "installed-crash-edit-committed-"));
  const fixture = await arrangeCrashOrchestration(root, "bound-change-set", "after_committed", "edit_body");
  try {
    const outcome = await runInstalledCrashRestorationSlice(fixture.options);
    expect(outcome.records).toMatchObject([{ mutationKind: "edit_body", crashPoint: "after_committed",
      proofState: "intent_applied", journalPhase: "COMMITTED", originalFileAbsentAfterRecovery: false,
      committedFileBytesPreservedAfterRecovery: true }]);
  } finally { await fixture.cleanup(); await rm(root, { recursive: true, force: true }); }
});
