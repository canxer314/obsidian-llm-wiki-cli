import { writeFileSync } from "node:fs";
import { runInstalledDiagnosticPrivacyAcceptance } from "../src/installed-runtime/privacy-recovery-installed-runner.js";
import { validateInstalledDiagnosticPrivacyProof, diagnosticCanonicalJson } from "../src/installed-runtime/installed-diagnostic-privacy.js";
import { userInfo } from "node:os";
import { readInstalledCrashJournal } from "../src/installed-runtime/installed-crash-restoration-slice.js";
import { prepareInstalledDiagnosticPrivacyFixture } from "../src/installed-runtime/installed-diagnostic-privacy.js";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { expect, it } from "vitest";
import { brandVerifiedCandidateBundle, inspectCandidateBundle } from "../src/installed-runtime/candidate-bundle.js";
import { activateInstalledRuntimeAcceptanceDriver, createInstalledRuntimeAcceptanceDescriptor } from "../src/installed-runtime/smoke-command.js";
import { createHash, randomUUID } from "node:crypto";
import { createContentInclusiveDiagnosticBundle } from "../src/content-inclusive-diagnostic-bundle.js";
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

async function reportFixture(mode: "missing" | "foreign" | "standard" | "shared" | "blocked", controls: "missing" | "real" = "missing", blockedSnapshotUnavailable = false, content: "missing" | "real" | "cancel-only" = "missing", diagnosticSources = false, mutateSecondVaultPrivateState = false, earlyContentConfirmation = false, mutateRejectedWirePrivateState = false) {
  const root = await mkdtemp(join(tmpdir(), "privacy-report-"));
  const candidateDirectory = join(root, "candidate");
  await mkdir(candidateDirectory);
  await writeFile(join(candidateDirectory, "manifest.json"), JSON.stringify({ id: "privacy-plugin", version: "0.1.0", minAppVersion: "1.0.0" }));
  await writeFile(join(candidateDirectory, "main.js"), "candidate");
  const candidate = brandVerifiedCandidateBundle({ bundleDirectory: candidateDirectory, identity: await inspectCandidateBundle(candidateDirectory), tag: "v0.1.0", repository: "test/privacy", workflowRef: "test", attestationSource: "local-candidate" });
  const environments = new Map<string, Record<string, string>>();
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
    ...(diagnosticSources ? { retainDiagnosticObservation: async () => undefined } : {}),
    profileName: profile.name, profile, probe: { probeRunning: async () => ({ platform: profile.os.platform, osBuild: profile.os.build,
      obsidianVersion: profile.versions.obsidian, electronVersion: profile.versions.electron, nodeVersion: profile.versions.node, capabilities: profile.capabilities }) },
    client: createLoopbackMcpClient(), processControl: { start: async ({ vaultPath, diagnosticPrivacyEnvironment }: { vaultPath: string; diagnosticPrivacyEnvironment?: Record<string, string> }) => {
      if (diagnosticPrivacyEnvironment !== undefined) environments.set(vaultPath, diagnosticPrivacyEnvironment);
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
      const bridge = createBridgeInstance({ port: 0, health: { ...structuredClone(health), vault: { id: vaultPath, name: "private-name", path: vaultPath } },
        ...(blockedSnapshotUnavailable && vaultPath.includes("vault-a") ? {
          searchSnapshotReadiness: () => events.includes("real-blocked-fixture-completed") ? "unavailable" as const : "ready" as const,
        } : {}),
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
          const suffix = environments.get(vaultPath)?.LLM_WIKI_ACCEPTANCE_DIAGNOSTIC_MARKER.slice("privacy_environment_".length);
          const bytes = Buffer.from(diagnosticSources ? `# Private blocked fixture\nprivacy_before_image_${suffix}\n` : "# Private blocked fixture\n");
          const submissionKey = diagnosticSources ? `installed-semantic-privacy_request_${suffix}` : "real-blocked-fixture";
          await writeFile(join(vaultPath, "blocked.md"), bytes);
          const client = new Client({ name: "fixture", version: "1.0.0" });
          await client.connect(new StreamableHTTPClientTransport(bridge.endpoint, { requestInit: { headers: { "X-Expected-Vault-ID": vaultPath } } }));
          try {
            const result = await client.callTool({ name: "vault_change_set_submit", arguments: { submissionKey,
              operations: [{ operationId: diagnosticSources ? `privacy_operation_${suffix}` : "trash", kind: "trash", path: "blocked.md", targetVersion: contentVersion(bytes) }] } });
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
      if (mutateRejectedWirePrivateState && name === "vault-a-rejected-vault_diagnostic_bundle") {
        const affected = [...bridges.keys()].find(path => path.includes("vault-a"))!;
        writeFileSync(join(affected, ".llm-wiki", "wire-side-effect.bin"), "side effect");
      }
      if (earlyContentConfirmation && name === "vault-a-standard-local-report-observed") {
        const [vaultPath, created] = [...descriptors.entries()].find(([path]) => path.includes("vault-a"))!;
        const bridge = bridges.get(vaultPath)!;
        const selection = (readFile(join(vaultPath, "diagnostic-privacy", "selection.md"), "utf8"));
        writes.push(selection.then(async text => {
          const activation = await activateInstalledRuntimeAcceptanceDriver({ vaultPath, pluginId: "privacy-plugin" });
          try { await activation!.recordContentInclusiveDiagnosticCopy({ vaultId: vaultPath, endpoint: bridge.endpoint,
            confirmationId: "pre-request-cancel", outcome: "cancelled", selection: text.split("\n").at(-2)! }); } finally { activation?.dispose(); }
        }));
      }
      if (controls === "real" && name.endsWith("local-control-report-required")) {
        const [vaultPath] = [...descriptors.entries()].find(([path]) => path.includes(name.startsWith("vault-a") ? "vault-a" : "vault-b"))!;
        const bridge = bridges.get(vaultPath)!;
        const action = name.includes("resume-writes") ? "resume-writes" : "accept-recovery-baseline";
        writes.push((async () => {
          const capture = async () => {
            const observed = (await createLoopbackMcpClient().observeHealth(bridge.endpoint, vaultPath)).health;
            if (observed.outcome !== "observed") throw new Error("Missing fixture health");
            return createStandardDiagnosticBundle({ vaultId: vaultPath, versions: observed.versions,
              health: { readiness: observed.readiness, recovery: observed.recovery.state, write: observed.write,
                effectiveGate: observed.effectiveGate?.code ?? null, overall: observed.overall, reasonCodes: observed.reasonCodes, operatorAction: observed.operatorAction },
              listener: observed.listener, queue: observed.queue, lifecycle: observed.lifecycle,
              journal: executions.has(vaultPath) ? await executions.get(vaultPath)!.diagnosticJournalFacts() : { availability: "unavailable", frames: [] },
              changeSets: [], machineEvents: [] });
          };
          const before = await capture();
          let outcome: "accepted" | "rejected" = "accepted";
          try { if (action === "resume-writes") await bridge.resumeWrites(); else await bridge.acceptTrustedRecoveryBaseline(async () => undefined); }
          catch { outcome = "rejected"; }
          expect(outcome).toBe(vaultPath.includes("vault-b") ? "rejected" : "accepted");
          const after = await capture();
          const activation = await activateInstalledRuntimeAcceptanceDriver({ vaultPath, pluginId: "privacy-plugin" });
          try { await activation!.recordLocalWriteControl({ vaultId: vaultPath, endpoint: bridge.endpoint, invocationId: randomUUID(), action, outcome, before, after }); }
          finally { activation?.dispose(); }
          events.push(`${name}-published-${outcome}`);
        })());
      }
      if ((content === "real" || content === "cancel-only" && name.includes("cancelled")) && name.endsWith("local-content-report-required")) {
        const [vaultPath] = [...descriptors.entries()].find(([path]) => path.includes("vault-a"))!;
        const bridge = bridges.get(vaultPath)!;
        const outcome = name.includes("cancelled") ? "cancelled" : "copied";
        writes.push((async () => {
          expect(events).not.toContain("stop");
          const observed = (await createLoopbackMcpClient().observeHealth(bridge.endpoint, vaultPath)).health;
          if (observed.outcome !== "observed") throw new Error("Missing content fixture health");
          const selection = diagnosticSources ? (await readFile(join(vaultPath, "diagnostic-privacy", "selection.md"), "utf8")).split("\n").at(-2)! : "private explicit selection";
          const evidence = { vaultId: vaultPath, versions: observed.versions,
            health: { readiness: observed.readiness, recovery: observed.recovery.state, write: observed.write,
              effectiveGate: observed.effectiveGate?.code ?? null, overall: observed.overall, reasonCodes: observed.reasonCodes, operatorAction: observed.operatorAction },
            listener: observed.listener, queue: observed.queue, lifecycle: observed.lifecycle,
            journal: { availability: "unavailable", frames: [] }, changeSets: [], machineEvents: [] };
          const activation = await activateInstalledRuntimeAcceptanceDriver({ vaultPath, pluginId: "privacy-plugin" });
          if (outcome === "copied" && mutateSecondVaultPrivateState) {
            const second = [...bridges.keys()].find(path => path.includes("vault-b"))!;
            await writeFile(join(second, ".llm-wiki", "foreign-private-state.bin"), "side effect");
          }
          const contentBundle = outcome === "copied" ? createContentInclusiveDiagnosticBundle(evidence, selection) : undefined;
          try { await activation!.recordContentInclusiveDiagnosticCopy({ vaultId: vaultPath, endpoint: bridge.endpoint,
            confirmationId: randomUUID(), outcome, selection,
            ...(contentBundle === undefined ? {} : { bundle: contentBundle,
              ...(diagnosticSources ? { copiedTextSha256: createHash("sha256").update(JSON.stringify(contentBundle)).digest("hex") } : {}) }) }); }
          finally { activation?.dispose(); }
        })());
      }
      if (!name.endsWith("standard-local-report-required") || mode === "missing" || mode === "shared") return;
      if (mode === "blocked") expect(events.filter(event => event === "real-blocked-fixture-cleanup-completed").length).toBe(1);
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
        const frame = diagnosticSources && vaultPath.includes("vault-a") ? await readInstalledCrashJournal(join(vaultPath, ".llm-wiki", "recovery-journal.bin")) : undefined;
        const payload = frame?.payload as any;
        const statusResponse = payload === undefined ? undefined : await (async () => {
          const client = new Client({ name: "privacy-status-fixture", version: "1.0.0" });
          await client.connect(new StreamableHTTPClientTransport(bridge.endpoint, { requestInit: { headers: { "X-Expected-Vault-ID": vaultPath } } }));
          try { return await client.callTool({ name: "vault_change_set_status", arguments: { submissionKey: payload.input.submissionKey } }); } finally { await client.close(); }
        })();
        const outcomeFacts = (statusResponse?.structuredContent as any)?.changeSet;
        const currentBundle = mode === "blocked" ? createStandardDiagnosticBundle({ vaultId: vaultPath,
          versions: observed.versions, health: { readiness: observed.readiness, recovery: observed.recovery.state,
            write: observed.write, effectiveGate: observed.effectiveGate?.code ?? null, overall: observed.overall,
            reasonCodes: observed.reasonCodes, operatorAction: observed.operatorAction }, listener: observed.listener,
          queue: observed.queue, lifecycle: observed.lifecycle, journal: await executions.get(vaultPath)!.diagnosticJournalFacts(),
          changeSets: outcomeFacts === undefined ? [] : [{ changeSetId: payload.changeSetId, submissionKey: payload.input.submissionKey,
            enqueueSeq: payload.enqueueSeq, state: outcomeFacts.state, executionPhase: outcomeFacts.executionPhase ?? (outcomeFacts.state !== "in_progress" ? "terminal" : null) }], machineEvents: [] }) : bundle;
        await writeFile(join(descriptor.reportDirectory, "local-standard-diagnostic-copy.json"), JSON.stringify({ schemaVersion: 1,
          runId: descriptor.runId, candidateBundleSha256: descriptor.candidateBundleSha256, installedMainSha256: descriptor.installedMainSha256,
          capabilityToken: descriptor.capabilityToken, vaultId: mode === "foreign" ? "foreign" : vaultPath, endpoint: bridge.endpoint.toString(),
          ...(diagnosticSources ? { diagnosticPrivacySources: { environment: environments.get(vaultPath), username: userInfo().username } } : {}),
          action: "standard-diagnostic-copy", checksumVerified: true, bundle: currentBundle }), { mode: 0o600 });
      }));
    }, assertion: () => undefined,
  } as unknown as InstalledPrivacyBoundaryOptions;
  return { root, options, events, cleanup: async () => { for (const timer of scenarioTimers) clearInterval(timer); await Promise.all(writes); for (const bridge of bridges.values()) await bridge.stop(); for (const execution of executions.values()) await execution.close?.(); await rm(root, { recursive: true, force: true }); } };
}

it("requires an external source-retention consumer before issuing a composable A33 proof", async () => {
  const fixture = await reportFixture("blocked", "missing", false, "real", true);
  try {
    await expect(runInstalledDiagnosticPrivacyAcceptance({ ...fixture.options, retainDiagnosticObservation: undefined })).rejects.toThrow("source retention");
  } finally { await fixture.cleanup(); }
});

it("rejects private durable mutation after explicit wire rejection even with unchanged health/status", async () => {
  const fixture = await reportFixture("blocked", "missing", false, "real", true, false, false, true);
  try {
    await expect(runInstalledDiagnosticPrivacyAcceptance(fixture.options)).rejects.toThrow("wire authority attempts changed private state");
  } finally { await fixture.cleanup(); }
});

it("rejects a current-run confirmation produced before its requested fresh observation window", async () => {
  const fixture = await reportFixture("blocked", "missing", false, "real", true, false, true);
  try {
    await expect(runInstalledDiagnosticPrivacyAcceptance(fixture.options)).rejects.toThrow("fresh confirmation");
  } finally { await fixture.cleanup(); }
});

it("runs standalone A33 without invoking or requesting recovery baseline/resume (inner seam only)", async () => {
  const fixture = await reportFixture("blocked", "missing", false, "real", true);
  try {
    const proof = await runInstalledDiagnosticPrivacyAcceptance(fixture.options);
    expect(proof.scope).toBe("installed-diagnostic-privacy-A33");
    expect(proof.verdict).toBe("passed");
    expect(fixture.events.some(event => event.includes("local-control-report-required"))).toBe(false);
  } finally { await fixture.cleanup(); }
});

it("rejects second Vault private-state mutation even when public health/status and note inventory are unchanged", async () => {
  const fixture = await reportFixture("blocked", "missing", false, "real", true, true);
  try {
    await expect(runInstalledPrivacyRecoveryAuthorityCorpus({ ...fixture.options, diagnosticPrivacy: true })).rejects.toThrow("second Vault");
  } finally { await fixture.cleanup(); }
});

it("composes a redacted A33 proof only after all live report observations and cleanup (inner seam, not installed acceptance)", async () => {
  const fixture = await reportFixture("blocked", "missing", false, "real", true);
  try {
    let trusted: import("../src/installed-runtime/installed-diagnostic-privacy.js").InstalledDiagnosticTrustedContext | undefined;
    let expectedPin: import("../src/installed-runtime/installed-diagnostic-privacy.js").InstalledDiagnosticSourcePin | undefined;
    const result = await runInstalledPrivacyRecoveryAuthorityCorpus({ ...fixture.options, diagnosticPrivacy: true,
      retainDiagnosticObservation: async (context, sourcePin) => {
        expect(fixture.events.filter(event => event === "stop")).toHaveLength(2);
        expect(context.observation.removedRoots).toHaveLength(6);
        trusted = structuredClone(context);
        expectedPin = structuredClone(sourcePin);
      } });
    expect(result.verdict).toBe("partial");
    expect(result.diagnosticProof).toMatchObject({ scope: "installed-diagnostic-privacy-A33", verdict: "passed", wireRejections: 16,
      cleanup: { verified: true, vaultCount: 2, residualCount: 0 } });
    const binding = { runId: fixture.options.runId, candidateBundleSha256: fixture.options.candidate.identity.bundleSha256, profileName: profile.name, installedMainSha256: fixture.options.candidate.identity.files.find(file => file.path === "main.js")!.sha256 };
    // A public proof cannot promote itself to trusted evidence; context is retained from the actual runner separately.
    expect(() => validateInstalledDiagnosticPrivacyProof(result.diagnosticProof, binding)).toThrow("trusted observation");
    const restoredContext = JSON.parse(JSON.stringify(trusted!));
    expect(() => validateInstalledDiagnosticPrivacyProof(result.diagnosticProof, binding, restoredContext)).toThrow("source pin");
    expect(validateInstalledDiagnosticPrivacyProof(JSON.parse(JSON.stringify(result.diagnosticProof)), binding, restoredContext, expectedPin)).toEqual(result.diagnosticProof);
    expect(() => validateInstalledDiagnosticPrivacyProof(result.diagnosticProof, binding, restoredContext, { ...expectedPin!, observationSha256: "0".repeat(64) })).toThrow("source binding");
    for (const field of ["runId", "candidateBundleSha256", "installedMainSha256", "profileName"] as const) {
      const foreignPin = structuredClone(expectedPin!);
      (foreignPin.binding as any)[field] = field.endsWith("Sha256") ? "0".repeat(64) : "foreign";
      expect(() => validateInstalledDiagnosticPrivacyProof(result.diagnosticProof, binding, restoredContext, foreignPin)).toThrow("source binding");
    }
    // Even a coherent replacement transcript and self-selected digest cannot change the separately retained root.
    const fabricatedSource = structuredClone(restoredContext);
    fabricatedSource.observation.confirmations[1].copiedTextSha256 = "6".repeat(64);
    const fabricatedProof = structuredClone(result.diagnosticProof!);
    (fabricatedProof.confirmations[1] as any).copiedTextSha256 = "6".repeat(64);
    for (const event of fabricatedProof.eventLog) {
      if (event.name === "vault-a-copied-local-content-report-observed") (event as any).detailSha256 = createHash("sha256").update(diagnosticCanonicalJson(fabricatedProof.confirmations[1])).digest("hex");
    }
    fabricatedSource.observation.events = structuredClone(fabricatedProof.eventLog);
    fabricatedSource.expectedObservationSha256 = createHash("sha256").update(diagnosticCanonicalJson(fabricatedSource.observation)).digest("hex");
    expect(() => validateInstalledDiagnosticPrivacyProof(fabricatedProof, binding, fabricatedSource, expectedPin)).toThrow("source binding");
    expect(JSON.stringify(restoredContext)).not.toContain("privacy_body_");
    expect(JSON.stringify(restoredContext)).not.toContain(fixture.root);
    for (const mutation of ["marker-count", "marker-manifest", "copied-bytes", "fixture-manifest", "cleanup"] as const) {
      const forged = structuredClone(result.diagnosticProof!);
      if (mutation === "marker-count") (forged.vaults[0] as any).markerCount = 12000;
      if (mutation === "marker-manifest") (forged.vaults[0] as any).markerManifestSha256 = "5".repeat(64);
      if (mutation === "fixture-manifest") (forged.vaults[0] as any).manifestSha256 = "5".repeat(64);
      if (mutation === "copied-bytes") (forged.confirmations[1] as any).copiedTextSha256 = "6".repeat(64);
      if (mutation === "cleanup") (forged.eventLog as any).pop();
      for (const event of forged.eventLog) {
        if (event.name.endsWith("standard-local-report-observed")) (event as any).detailSha256 = createHash("sha256").update(diagnosticCanonicalJson(forged.vaults[event.name.startsWith("vault-a") ? 0 : 1])).digest("hex");
        if (event.name.endsWith("local-content-report-observed")) (event as any).detailSha256 = createHash("sha256").update(diagnosticCanonicalJson(forged.confirmations[event.name.includes("cancelled") ? 0 : 1])).digest("hex");
      }
      expect(() => validateInstalledDiagnosticPrivacyProof(forged, binding, restoredContext, expectedPin)).toThrow();
    }
    const wrongSource = structuredClone(restoredContext);
    wrongSource.observation.binding.runId = "foreign-run";
    expect(() => validateInstalledDiagnosticPrivacyProof(result.diagnosticProof, binding, wrongSource, expectedPin)).toThrow("source binding");
    const missingCleanup = structuredClone(restoredContext);
    missingCleanup.observation.removedRoots = [];
    expect(() => validateInstalledDiagnosticPrivacyProof(result.diagnosticProof, binding, missingCleanup, expectedPin)).toThrow("source binding");
    expect(validateInstalledDiagnosticPrivacyProof(result.diagnosticProof, binding, trusted, expectedPin)).toEqual(result.diagnosticProof);
    for (const invalid of [
      { ...result.diagnosticProof, runId: "foreign" },
      { ...result.diagnosticProof, vaults: result.diagnosticProof!.vaults.map(vault => ({ ...vault, installedMainSha256: "0".repeat(64) })) },
      { ...result.diagnosticProof, cleanup: { verified: false, vaultCount: 2, residualCount: 0 } },
      { ...result.diagnosticProof, coverage: [] },
      { ...result.diagnosticProof, vaults: [result.diagnosticProof!.vaults[0], result.diagnosticProof!.vaults[0]] },
      { ...result.diagnosticProof, capabilityToken: "private" },
      { ...result.diagnosticProof, vaults: result.diagnosticProof!.vaults.map(vault => ({ ...vault, checksum: `sha256:${"0".repeat(64)}` })) },
      { ...result.diagnosticProof, confirmations: result.diagnosticProof!.confirmations.map(confirmation => confirmation.outcome === "copied" ? { ...confirmation, copiedTextSha256: "0".repeat(64) } : confirmation) },
      { ...result.diagnosticProof, eventLog: result.diagnosticProof!.eventLog.filter(event => event.name.endsWith("generated-vault")).map((event, index) => ({ ...event, sequence: index + 1 })) },
      { ...result.diagnosticProof, confirmations: [result.diagnosticProof!.confirmations[0], { ...result.diagnosticProof!.confirmations[1], selectionSha256: "0".repeat(64) }] },
    ]) expect(() => validateInstalledDiagnosticPrivacyProof(invalid, binding, trusted, expectedPin)).toThrow();
    expect(result.diagnosticProof!.vaults).toHaveLength(2);
    expect(result.diagnosticProof!.vaults[0]!.markerCategories).toHaveLength(12);
    expect(result.diagnosticProof!.confirmations.map(item => item.outcome)).toEqual(["cancelled", "copied"]);
    expect(JSON.stringify(result)).not.toContain("privacy_body_");
    expect(JSON.stringify(result)).not.toContain(fixture.root);
    expect(fixture.events.filter(event => event === "stop")).toHaveLength(2);
  } finally { await fixture.cleanup(); }
});

it("requires installed process source evidence instead of upgrading a standard report to A33 passed", async () => {
  const fixture = await reportFixture("blocked");
  try {
    await expect(runInstalledPrivacyRecoveryAuthorityCorpus({ ...fixture.options, diagnosticPrivacy: true, retainDiagnosticObservation: async () => undefined })).rejects.toThrow("process environment source");
  } finally { await fixture.cleanup(); }
});

it("rejects claimed empty cleanup when generated roots still exist", async () => {
  const fixture = await reportFixture("standard");
  try {
    await expect(runInstalledPrivacyRecoveryAuthorityCorpus({ ...fixture.options, cleanupVault: async () => ({ attempted: true, residualPaths: [] }) })).rejects.toThrow("cleanup left");
  } finally { await fixture.cleanup(); }
});

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
    ]);
    expect(fixture.events).toContain("vault-a-recovery-blocked-gate-row-observed");
    expect(fixture.events.filter(event => event === "real-blocked-fixture-completed")).toHaveLength(1);
    expect(result.verdict).toBe("partial");
    expect(result.humanRequired).toContain("recovery-baseline");
  } finally { await fixture.cleanup(); }
});

it("requires an independently observed Vault B rejected baseline report before consuming Vault A recovery controls", async () => {
  const fixture = await reportFixture("blocked");
  try {
    await expect(runInstalledPrivacyRecoveryAuthorityCorpus({ ...fixture.options, recoveryControls: true } as InstalledPrivacyBoundaryOptions)).rejects.toThrow("Local Primary Operator report is required for accept-recovery-baseline");
    expect(fixture.events).toContain("vault-b-accept-recovery-baseline-local-control-report-required");
    expect(fixture.events.filter(event => event === "stop")).toHaveLength(2);
  } finally { await fixture.cleanup(); }
});

it("consumes rejected B then accepted A baseline reports while preserving terminal public proof", async () => {
  const fixture = await reportFixture("blocked", "real");
  try {
    const result = await runInstalledPrivacyRecoveryAuthorityCorpus({ ...fixture.options, recoveryControls: true });
    expect(result.recoveryControlObservations).toEqual([
      expect.objectContaining({ label: "vault-b", action: "accept-recovery-baseline", outcome: "rejected", liveHealthUnchanged: true }),
      expect.objectContaining({ label: "vault-a", action: "accept-recovery-baseline", outcome: "accepted", liveWriteState: "paused", journalCleared: true, terminalStatusUnchanged: true }),
      expect.objectContaining({ label: "vault-a", action: "resume-writes", outcome: "accepted", liveWriteState: "writable", terminalStatusUnchanged: true }),
    ]);
    expect(result.verdict).toBe("partial");
  } finally { await fixture.cleanup(); }
});

it("observes real blocked recovery handoff even when the post-cleanup Search Snapshot is unavailable", async () => {
  const fixture = await reportFixture("blocked", "missing", true);
  try {
    const result = await runInstalledPrivacyRecoveryAuthorityCorpus(fixture.options);
    expect(result.recoveryHandoff).toHaveLength(1);
    expect(result.recoveryHandoff[0]).toMatchObject({ journalPhase: "FAILED", recovery: "blocked", effectiveGate: "recovery_blocked" });
    expect(fixture.events).toContain("vault-a-standard-local-report-required");
  } finally { await fixture.cleanup(); }
});

it("rejects an invalid content selection digest before provisioning", async () => {
  const fixture = await reportFixture("missing");
  let provisions = 0;
  try {
    await expect(runInstalledPrivacyRecoveryAuthorityCorpus({ ...fixture.options,
      contentConfirmation: { expectedSelectionSha256: "not-a-digest" },
      provisionVault: async request => { provisions += 1; return provisionTestVault(request); },
    } as InstalledPrivacyBoundaryOptions)).rejects.toThrow("Local content selection digest must be SHA-256");
    expect(provisions).toBe(0);
  } finally { await fixture.cleanup(); }
});

it("consumes cancelled then distinct copied local confirmations for the same selection while runtimes remain alive", async () => {
  const fixture = await reportFixture("standard", "missing", false, "real");
  try {
    const result = await runInstalledPrivacyRecoveryAuthorityCorpus({ ...fixture.options,
      contentConfirmation: { expectedSelectionSha256: createHash("sha256").update("private explicit selection").digest("hex") } });
    expect(result.contentConfirmationObservations).toEqual([
      expect.objectContaining({ outcome: "cancelled" }),
      expect.objectContaining({ outcome: "copied", checksumVerified: true, bundleVersion: "1.0" }),
    ]);
    expect(result.contentConfirmationObservations[0]!.confirmationIdSha256).not.toBe(result.contentConfirmationObservations[1]!.confirmationIdSha256);
    expect(JSON.stringify(result)).not.toContain("private explicit selection");
    expect(result.verdict).toBe("partial");
  } finally { await fixture.cleanup(); }
});

it("does not reuse a cancelled confirmation as copied evidence and cleans up after the copy report timeout", async () => {
  const fixture = await reportFixture("standard", "missing", false, "cancel-only");
  try {
    await expect(runInstalledPrivacyRecoveryAuthorityCorpus({ ...fixture.options,
      contentConfirmation: { expectedSelectionSha256: createHash("sha256").update("private explicit selection").digest("hex") },
    })).rejects.toThrow("Local Primary Operator report is required for content-inclusive-diagnostic-copy");
    expect(fixture.events).toContain("vault-a-copied-local-content-report-required");
    expect(fixture.events.filter(event => event === "stop")).toHaveLength(2);
    expect(fixture.events.filter(event => event === "clean-vault")).toHaveLength(2);
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
