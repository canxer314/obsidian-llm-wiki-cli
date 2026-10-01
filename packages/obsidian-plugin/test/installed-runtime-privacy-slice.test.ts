import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { expect, it } from "vitest";
import { brandVerifiedCandidateBundle, inspectCandidateBundle } from "../src/installed-runtime/candidate-bundle.js";
import { createInstalledRuntimeAcceptanceDescriptor } from "../src/installed-runtime/smoke-command.js";
import { runInstalledPrivacyRecoveryAuthorityCorpus, type InstalledPrivacyBoundaryOptions } from "../src/installed-runtime/privacy-recovery-installed-runner.js";
import { provisionTestVault, cleanupTestVault } from "../src/installed-runtime/test-vault.js";
import { ObsidianProcessError } from "../src/installed-runtime/obsidian-process.js";
import { createBridgeInstance } from "../src/bridge-instance.js";
import { createLoopbackMcpClient } from "../src/installed-runtime/loopback-client.js";
import { createStandardDiagnosticBundle } from "../src/diagnostic-bundle.js";
import { MVP_PERF_REF_LINUX_1 as profile } from "../src/installed-runtime/runtime-profile.js";
import { createChangeSetSemanticEvidenceTracker, createFileSystemChangeSetExecutionAdapter, createNodeFileSystemChangeSetHost } from "../src/file-system-change-set-execution.js";
import { parseChangeSetSubmitResult } from "@llm-wiki/vault-contracts";
import { contentVersion } from "../src/content-version.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

it("rejects a foreign privacy descriptor before starting the generated runtime", async () => {
  const root = await mkdtemp(join(tmpdir(), "privacy-foreign-descriptor-"));
  const candidateDirectory = join(root, "candidate");
  await mkdir(candidateDirectory);
  await writeFile(join(candidateDirectory, "manifest.json"), JSON.stringify({ id: "privacy-plugin", version: "0.1.0", minAppVersion: "1.0.0" }));
  await writeFile(join(candidateDirectory, "main.js"), "candidate");
  const candidate = brandVerifiedCandidateBundle({
    bundleDirectory: candidateDirectory, identity: await inspectCandidateBundle(candidateDirectory),
    tag: "v0.1.0", repository: "test/privacy", workflowRef: "test", attestationSource: "local-candidate",
  });
  let starts = 0;
  try {
    await expect(runInstalledPrivacyRecoveryAuthorityCorpus({
      runId: "privacy-binding", workingDirectory: root, candidate, configDirectoryName: ".obsidian", operatorReportTimeoutMs: 500,
      profileName: "test", profile: { name: "test" }, probe: { probeRunning: async () => { throw new Error("Must not probe"); } }, client: {},
      processControl: { start: async () => { starts += 1; throw new Error("Unexpected startup"); } },
      timeouts: { startupMs: 10, stopMs: 10, portClosedMs: 10 }, provisionVault: provisionTestVault, cleanupVault: cleanupTestVault,
      prepareInstalledRuntimeAcceptanceDriver: async request => {
        const created = await createInstalledRuntimeAcceptanceDescriptor({ ...request, runId: "privacy-binding", reportDirectory: join(root, "reports") });
        return { ...created, descriptor: { ...created.descriptor, runId: "foreign-run" }, cleanup: async () => undefined };
      }, record: () => undefined, assertion: () => undefined,
    } as InstalledPrivacyBoundaryOptions)).rejects.toThrow("descriptor does not match");
    expect(starts).toBe(0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

async function reportFixture(mode: "missing" | "foreign" | "standard" | "shared" | "blocked") {
  const root = await mkdtemp(join(tmpdir(), "privacy-report-"));
  const candidateDirectory = join(root, "candidate");
  await mkdir(candidateDirectory);
  await writeFile(join(candidateDirectory, "manifest.json"), JSON.stringify({ id: "privacy-plugin", version: "0.1.0", minAppVersion: "1.0.0" }));
  await writeFile(join(candidateDirectory, "main.js"), "candidate");
  const candidate = brandVerifiedCandidateBundle({ bundleDirectory: candidateDirectory, identity: await inspectCandidateBundle(candidateDirectory), tag: "v0.1.0", repository: "test/privacy", workflowRef: "test", attestationSource: "local-candidate" });
  const bridges = new Map<string, ReturnType<typeof createBridgeInstance>>();
  const descriptors = new Map<string, Awaited<ReturnType<typeof createInstalledRuntimeAcceptanceDescriptor>>>();
  const executions = new Map<string, Awaited<ReturnType<typeof createFileSystemChangeSetExecutionAdapter>>>();
  const scenarioTimers: ReturnType<typeof setInterval>[] = [];
  const events: string[] = [];
  const writes: Promise<void>[] = [];
  const health = { readiness: { searchSnapshot: "ready", cache: "ready", index: "ready" }, recovery: { state: "none" },
    write: { gate: "open", state: "writable", pauseSource: null }, queue: { currentExecutionId: null, length: 0, headChangeSetId: null },
    lifecycle: { startup: "ready", upgrade: "not_run", migration: "not_run", recovery: "not_run" }, effectiveGate: null, overall: "healthy", reasonCodes: [], operatorAction: "none" } as const;
  const options = {
    runId: "privacy-report", workingDirectory: root, candidate, configDirectoryName: ".obsidian", operatorReportTimeoutMs: 500,
    ...(mode === "blocked" ? { recoveryFixture: "trash_note/restore_evidence_deadline_blocks_writes" } : {}),
    profileName: profile.name, profile, probe: { probeRunning: async () => ({ platform: profile.os.platform, osBuild: profile.os.build,
      obsidianVersion: profile.versions.obsidian, electronVersion: profile.versions.electron, nodeVersion: profile.versions.node, capabilities: profile.capabilities }) },
    client: createLoopbackMcpClient(), processControl: { start: async ({ vaultPath }: { vaultPath: string }) => {
      const unused = async (): Promise<never> => { throw new Error("Not exercised by the privacy report seam"); };
      let execution: Awaited<ReturnType<typeof createFileSystemChangeSetExecutionAdapter>> | undefined;
      const dataSource = { readBinary: async (path: string) => readFile(join(vaultPath, path)).catch(() => null),
        pathKind: async (path: string) => { const facts = await stat(join(vaultPath, path)).catch(() => null); return facts === null ? null : facts.isDirectory() ? "directory" as const : "file" as const; },
        isContained: async () => true };
      if (mode === "blocked") {
        const tracker = createChangeSetSemanticEvidenceTracker({ publishSuccessorSearchSnapshot: async () => undefined,
          deadlineMs: 1, probes: { cacheVisible: async () => true, referenced: async () => false } });
        const stateDirectory = join(vaultPath, ".llm-wiki");
        const host = await createNodeFileSystemChangeSetHost({ basePath: vaultPath, stateDirectory,
          beginSemanticEvidence: request => tracker.begin(request), awaitSemanticEvidence: request => tracker.await(request),
          referenced: async () => true, publishSearchSnapshot: async () => undefined });
        execution = await createFileSystemChangeSetExecutionAdapter({ journalPath: join(stateDirectory, "recovery-journal.bin"), host, slotCapacity: 16384 });
        executions.set(vaultPath, execution);
      }
      const bridge = createBridgeInstance({ port: 0, health: { ...health, vault: { id: vaultPath, name: "private-name", path: vaultPath } },
        discoverService: { execute: unused, releaseClient: () => undefined },
        readDataSource: { readBinary: unused, parseFrontmatter: () => null, headings: () => [] },
        changeSets: { store: { load: async () => undefined, save: async () => undefined },
          dataSource, ...(execution === undefined ? {} : { execution }) } });
      await bridge.start(); bridges.set(vaultPath, bridge);
      if (mode === "blocked") {
        const descriptor = descriptors.get(vaultPath)!;
        let dispatched = false;
        scenarioTimers.push(setInterval(() => { void (async () => {
          if (dispatched) return;
          const text = await readFile(descriptor.path, "utf8").catch(() => null);
          if (text === null || dispatched) return;
          const current = JSON.parse(text);
          if (current.command.action !== "run-semantic-evidence-scenario") return;
          dispatched = true;
          expect(current.command.scenario).toBe("trash_note/restore_evidence_deadline_blocks_writes");
          const bytes = Buffer.from("# Private blocked fixture\n");
          await writeFile(join(vaultPath, "blocked.md"), bytes);
          const client = new Client({ name: "fixture", version: "1.0.0" });
          await client.connect(new StreamableHTTPClientTransport(bridge.endpoint, { requestInit: { headers: { "X-Expected-Vault-ID": vaultPath } } }));
          try {
            const result = await client.callTool({ name: "vault_change_set_submit", arguments: { submissionKey: "real-blocked-fixture",
              operations: [{ operationId: "trash", kind: "trash", path: "blocked.md", targetVersion: contentVersion(bytes) }] } });
            if (result.structuredContent === undefined) throw new Error(JSON.stringify(result));
            const submitted = parseChangeSetSubmitResult(result.structuredContent);
            expect(submitted.outcome).toBe("registered");
            if (submitted.outcome !== "registered") throw new Error("Fixture submission was not registered");
            expect(submitted.changeSet.state).toBe("result_unproven");
            expect((await executions.get(vaultPath)!.loadRecoveryFrame())?.phase).toBe("FAILED");
            events.push("real-blocked-fixture-completed");
            await rm(join(vaultPath, "blocked.md"));
            await new Promise(resolve => setTimeout(resolve, 30));
            await writeFile(join(descriptor.descriptor.reportDirectory, "semantic-evidence-trash_note_restore_evidence_deadline_blocks_writes.json"), JSON.stringify({
              schemaVersion: 1, runId: descriptor.descriptor.runId, vaultId: vaultPath, endpoint: bridge.endpoint.toString(),
              scenario: current.command.scenario, candidateBundleSha256: descriptor.descriptor.candidateBundleSha256,
              installedMainSha256: descriptor.descriptor.installedMainSha256, capabilityToken: descriptor.descriptor.capabilityToken,
              summary: { scenario: current.command.scenario, proofState: submitted.changeSet.state, statusProofState: submitted.changeSet.state,
                journalPhase: (await executions.get(vaultPath)!.loadRecoveryFrame())!.phase, writesBlocked: true, cleanupSucceeded: true },
            }), { mode: 0o600 });
            events.push("real-blocked-fixture-cleanup-completed");
          } finally { await client.close(); }
        })(); }, 5));
      }
      await writeFile(join(vaultPath, ".obsidian", "plugins", "privacy-plugin", "data.json"), JSON.stringify({ vaultId: vaultPath, port: bridge.port }));
      return { pid: 1, stop: async () => { events.push("stop"); await bridge.stop(); } };
    } }, timeouts: { startupMs: 1000, stopMs: 1000, portClosedMs: 1000 }, provisionVault: provisionTestVault,
    cleanupVault: async (vault: Parameters<typeof cleanupTestVault>[0]) => { events.push("clean-vault"); return cleanupTestVault(vault); },
    prepareInstalledRuntimeAcceptanceDriver: async (request: Parameters<InstalledPrivacyBoundaryOptions["prepareInstalledRuntimeAcceptanceDriver"]>[0]) => {
      const created = await createInstalledRuntimeAcceptanceDescriptor({ ...request, runId: "privacy-report", reportDirectory: mode === "shared" ? join(root, "shared") : join(root, `reports-${descriptors.size}`) });
      await mkdir(created.descriptor.reportDirectory, { recursive: true });
      descriptors.set(request.vaultPath, created);
      return { ...created, cleanup: async () => { events.push("clean-descriptor"); } };
    }, record: (_kind: string, name: string) => {
      events.push(name);
      if (!name.endsWith("standard-local-report-required") || mode === "missing" || mode === "shared") return;
      if (mode === "blocked") expect(events.filter(event => event === "real-blocked-fixture-cleanup-completed").length).toBe(name.startsWith("vault-a") ? 1 : 2);
      const [vaultPath, { descriptor }] = [...descriptors.entries()].find(([path]) => path.includes(name.startsWith("vault-a") ? "vault-a" : "vault-b"))!;
      const bridge = bridges.get(vaultPath)!;
      const bundle = createStandardDiagnosticBundle({ vaultId: vaultPath,
        versions: { bridge: "0.1.0", plugin: "0.1.0", protocol: "1.0", persistentStateSchema: 2, recoveryJournalSchema: 1 },
        health: { readiness: health.readiness, recovery: "none", write: health.write, effectiveGate: null,
          overall: "healthy", reasonCodes: [], operatorAction: "none" }, listener: { address: "127.0.0.1", port: bridge.port }, queue: health.queue,
        lifecycle: health.lifecycle, journal: { availability: "unavailable", frames: [] }, changeSets: [], machineEvents: [] });
      writes.push(new Promise<void>(resolve => setTimeout(resolve, 15)).then(async () => {
        expect(events).not.toContain("stop");
        const observed = (await createLoopbackMcpClient().observeHealth(bridge.endpoint, vaultPath)).health;
        if (observed.outcome !== "observed") throw new Error("Missing live health");
        const currentBundle = mode === "blocked" ? createStandardDiagnosticBundle({ vaultId: vaultPath,
          versions: observed.versions, health: { readiness: observed.readiness, recovery: observed.recovery.state,
            write: observed.write, effectiveGate: observed.effectiveGate?.code ?? null, overall: observed.overall,
            reasonCodes: observed.reasonCodes, operatorAction: observed.operatorAction }, listener: observed.listener,
          queue: observed.queue, lifecycle: observed.lifecycle, journal: await executions.get(vaultPath)!.diagnosticJournalFacts(),
          changeSets: [], machineEvents: [] }) : bundle;
        await writeFile(join(descriptor.reportDirectory, "local-standard-diagnostic-copy.json"), JSON.stringify({ schemaVersion: 1,
          runId: descriptor.runId, candidateBundleSha256: descriptor.candidateBundleSha256, installedMainSha256: descriptor.installedMainSha256,
          capabilityToken: descriptor.capabilityToken, vaultId: mode === "foreign" ? "foreign" : vaultPath, endpoint: bridge.endpoint.toString(),
          action: "standard-diagnostic-copy", checksumVerified: true, bundle: currentBundle }), { mode: 0o600 });
      }));
    }, assertion: () => undefined,
  } as unknown as InstalledPrivacyBoundaryOptions;
  return { root, options, events, cleanup: async () => { for (const timer of scenarioTimers) clearInterval(timer); await Promise.all(writes); for (const bridge of bridges.values()) await bridge.stop(); for (const execution of executions.values()) await execution.close?.(); await rm(root, { recursive: true, force: true }); } };
}

it("rejects an invalid operator report timeout before provisioning generated runtimes", async () => {
  const fixture = await reportFixture("missing");
  let provisions = 0;
  try {
    for (const timeout of [0, -1, Number.NaN, 1.5]) {
      await expect(runInstalledPrivacyRecoveryAuthorityCorpus({
        ...fixture.options,
        operatorReportTimeoutMs: timeout,
        provisionVault: async request => { provisions += 1; return provisionTestVault(request); },
      })).rejects.toThrow("Local Primary Operator report timeout must be a positive integer");
    }
    expect(provisions).toBe(0);
  } finally { await fixture.cleanup(); }
});

it("waits for missing standard reports then stops listeners before generated-root cleanup", async () => {
  const fixture = await reportFixture("missing");
  try {
    await expect(runInstalledPrivacyRecoveryAuthorityCorpus(fixture.options)).rejects.toThrow("Local Primary Operator report is required");
    expect(fixture.events.filter(event => event === "stop")).toHaveLength(2);
    expect(fixture.events.indexOf("stop")).toBeLessThan(fixture.events.indexOf("clean-descriptor"));
    expect((await readdir(fixture.root)).filter(name => name.startsWith("installed-runtime-vault-"))).toEqual([]);
  } finally { await fixture.cleanup(); }
});

it("consumes independent private standard reports with verified redaction facts while both runtimes remain alive", async () => {
  const fixture = await reportFixture("standard");
  try {
    const result = await runInstalledPrivacyRecoveryAuthorityCorpus(fixture.options);
    expect(result.verdict).toBe("partial");
    expect(result.standardDiagnostics).toEqual([
      expect.objectContaining({ label: "vault-a", checksumVerified: true, redactionVerified: true }),
      expect.objectContaining({ label: "vault-b", checksumVerified: true, redactionVerified: true }),
    ]);
    expect(JSON.stringify(result)).not.toContain(fixture.root);
    expect(fixture.events.filter(event => event === "stop")).toHaveLength(2);
  } finally { await fixture.cleanup(); }
});

it("rejects foreign standard report identity and still confirms listener shutdown and cleanup", async () => {
  const fixture = await reportFixture("foreign");
  try {
    await expect(runInstalledPrivacyRecoveryAuthorityCorpus(fixture.options)).rejects.toThrow("identity does not match");
    expect(fixture.events.filter(event => event === "stop")).toHaveLength(2);
    expect(fixture.events.filter(event => event === "clean-vault")).toHaveLength(2);
  } finally { await fixture.cleanup(); }
});

it("rejects shared report roots instead of consuming two Vaults through one fixed standard filename", async () => {
  const fixture = await reportFixture("shared");
  try {
    await expect(runInstalledPrivacyRecoveryAuthorityCorpus(fixture.options)).rejects.toThrow("independent report root");
  } finally { await fixture.cleanup(); }
});

it("hands off real disk FAILED journals and live blocked recovery without dispatching local baseline authority", async () => {
  const fixture = await reportFixture("blocked");
  try {
    const result = await runInstalledPrivacyRecoveryAuthorityCorpus(fixture.options);
    expect(result.recoveryHandoff).toEqual([
      expect.objectContaining({ label: "vault-a", journalPhase: "FAILED", proofState: "result_unproven", recovery: "blocked", effectiveGate: "recovery_blocked" }),
      expect.objectContaining({ label: "vault-b", journalPhase: "FAILED", proofState: "result_unproven", recovery: "blocked", effectiveGate: "recovery_blocked" }),
    ]);
    expect(fixture.events.filter(event => event === "real-blocked-fixture-completed")).toHaveLength(2);
    expect(result.verdict).toBe("partial");
    expect(result.humanRequired).toContain("recovery-baseline");
  } finally { await fixture.cleanup(); }
});

it("preserves privacy roots if a listener survives a running-profile probe failure", async () => {
  const root = await mkdtemp(join(tmpdir(), "privacy-preflight-listener-"));
  const candidateDirectory = join(root, "candidate");
  await mkdir(candidateDirectory);
  await writeFile(join(candidateDirectory, "manifest.json"), JSON.stringify({ id: "privacy-plugin", version: "0.1.0", minAppVersion: "1.0.0" }));
  await writeFile(join(candidateDirectory, "main.js"), "candidate");
  const candidate = brandVerifiedCandidateBundle({
    bundleDirectory: candidateDirectory, identity: await inspectCandidateBundle(candidateDirectory),
    tag: "v0.1.0", repository: "test/privacy", workflowRef: "test", attestationSource: "local-candidate",
  });
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  let cleanupCalls = 0;
  try {
    await expect(runInstalledPrivacyRecoveryAuthorityCorpus({
      runId: "privacy-listener", workingDirectory: root, candidate, configDirectoryName: ".obsidian", operatorReportTimeoutMs: 500,
      profileName: "test", profile: { name: "test" }, probe: { probeRunning: async () => { throw new Error("Profile probe refused"); } }, client: {},
      processControl: { start: async request => {
        await writeFile(join(request.vaultPath, ".obsidian", "plugins", "privacy-plugin", "data.json"), JSON.stringify({ vaultId: "privacy-vault", port }));
        return { pid: 1, stop: async () => undefined };
      } },
      timeouts: { startupMs: 10, stopMs: 10, portClosedMs: 30 }, provisionVault: provisionTestVault,
      cleanupVault: async vault => { cleanupCalls += 1; return cleanupTestVault(vault); },
      prepareInstalledRuntimeAcceptanceDriver: async request => {
        const created = await createInstalledRuntimeAcceptanceDescriptor({ ...request, runId: "privacy-listener", reportDirectory: join(root, "reports") });
        return { ...created, cleanup: async () => { cleanupCalls += 1; } };
      }, record: () => undefined, assertion: () => undefined,
    } as InstalledPrivacyBoundaryOptions)).rejects.toThrow("teardown was not confirmed");
    expect(cleanupCalls).toBe(0);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

it("retains the generated privacy roots when startup cannot confirm shutdown without returning a handle", async () => {
  const root = await mkdtemp(join(tmpdir(), "privacy-startup-stop-"));
  const candidateDirectory = join(root, "candidate");
  await mkdir(candidateDirectory);
  await writeFile(join(candidateDirectory, "manifest.json"), JSON.stringify({ id: "privacy-plugin", version: "0.1.0", minAppVersion: "1.0.0" }));
  await writeFile(join(candidateDirectory, "main.js"), "candidate");
  const candidate = brandVerifiedCandidateBundle({
    bundleDirectory: candidateDirectory, identity: await inspectCandidateBundle(candidateDirectory),
    tag: "v0.1.0", repository: "test/privacy", workflowRef: "test", attestationSource: "local-candidate",
  });
  let cleanupCalls = 0;
  let descriptorCleanupCalls = 0;
  const unconfirmed = new ObsidianProcessError("Startup process group survived", "obsidian_stop_failed");
  try {
    await expect(runInstalledPrivacyRecoveryAuthorityCorpus({
      runId: "privacy-stop", workingDirectory: root, candidate, configDirectoryName: ".obsidian", operatorReportTimeoutMs: 500,
      profileName: "test", profile: { name: "test" }, probe: { probeRunning: async () => { throw new Error("Must not probe"); } }, client: {},
      processControl: { start: async () => { throw unconfirmed; } },
      timeouts: { startupMs: 10, stopMs: 10, portClosedMs: 10 }, provisionVault: provisionTestVault,
      cleanupVault: async vault => { cleanupCalls += 1; return cleanupTestVault(vault); },
      prepareInstalledRuntimeAcceptanceDriver: async request => {
        const created = await createInstalledRuntimeAcceptanceDescriptor({ ...request, runId: "privacy-stop", reportDirectory: join(root, "reports") });
        return { ...created, cleanup: async () => { descriptorCleanupCalls += 1; } };
      }, record: () => undefined, assertion: () => undefined,
    } as InstalledPrivacyBoundaryOptions)).rejects.toBe(unconfirmed);
    expect(cleanupCalls).toBe(0);
    expect(descriptorCleanupCalls).toBe(0);
    expect((await readdir(root)).some(name => name.startsWith("installed-runtime-vault-"))).toBe(true);
  } finally { await rm(root, { recursive: true, force: true }); }
});
