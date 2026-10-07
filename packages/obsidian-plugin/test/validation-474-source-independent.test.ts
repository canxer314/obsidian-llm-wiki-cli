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
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createContentInclusiveDiagnosticBundle } from "../src/content-inclusive-diagnostic-bundle.js";
import { runInstalledPrivacyRecoveryAuthorityCorpus, type InstalledPrivacyBoundaryOptions } from "../src/installed-runtime/privacy-recovery-installed-runner.js";
import { parseChangeSetRegistryState } from "../src/change-set.js";
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

async function reportFixture(mode: "missing" | "foreign" | "standard" | "shared" | "blocked", controls: "missing" | "real" | "stale" | "foreign-before" | "foreign-after" | "cross-vault" | "early-cross-vault" = "missing", blockedSnapshotUnavailable = false, content: "missing" | "real" | "cancel-only" = "missing", diagnosticSources = false, mutateSecondVaultPrivateState = false, earlyContentConfirmation = false, mutateRejectedWirePrivateState = false) {
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
  const registries = new Map<string, import("../src/change-set.js").ChangeSetRegistryState>();
  const scenarioTimers: ReturnType<typeof setInterval>[] = [];
  const events: string[] = [];
  const privateSalts: string[] = [];
  const publicRecords: unknown[] = [];
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
      const statePath = join(vaultPath, ".llm-wiki", "bridge-state.json");
      const initialState = parseChangeSetRegistryState(undefined);
      await mkdir(join(vaultPath, ".llm-wiki"), { recursive: true });
      await writeFile(statePath, JSON.stringify({ vaultId: vaultPath, changeSets: initialState }), { flag: "wx" });
      registries.set(vaultPath, initialState);
      const bridge = createBridgeInstance({ port: 0, health: { ...structuredClone(health), vault: { id: vaultPath, name: "private-name", path: vaultPath } },
        ...(blockedSnapshotUnavailable && vaultPath.includes("vault-a") ? {
          searchSnapshotReadiness: () => events.includes("real-blocked-fixture-completed") ? "unavailable" as const : "ready" as const,
        } : {}),
        discoverService: { execute: unused, releaseClient: () => undefined },
        readDataSource: { readBinary: unused, parseFrontmatter: () => null, headings: () => [] },
        changeSets: { store: { load: async () => JSON.parse(await readFile(statePath, "utf8")).changeSets, save: async state => {
          registries.set(vaultPath, structuredClone(state));
          await mkdir(join(vaultPath, ".llm-wiki"), { recursive: true });
          await writeFile(join(vaultPath, ".llm-wiki", "bridge-state.json"), JSON.stringify({ vaultId: vaultPath, changeSets: state }));
        } },
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
    }, record: (_kind: string, name: string, detail: unknown) => {
      publicRecords.push({ name, detail });
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
      if (controls === "stale" && name === "vault-a-standard-local-report-required") {
        const [vaultPath, { descriptor }] = [...descriptors.entries()].find(([path]) => path.includes("vault-a"))!;
        const invocationId = "stale-current-run-control";
        writeFileSync(join(descriptor.reportDirectory, `local-write-control-${createHash("sha256").update(invocationId).digest("hex")}.json`),
          JSON.stringify({ schemaVersion: 1, runId: descriptor.runId, candidateBundleSha256: descriptor.candidateBundleSha256,
            installedMainSha256: descriptor.installedMainSha256, capabilityToken: descriptor.capabilityToken,
            vaultId: vaultPath, endpoint: bridges.get(vaultPath)!.endpoint.toString(), invocationId, action: "resume-writes" }), { mode: 0o600 });
      }
      if (controls === "early-cross-vault" && name === "vault-a-standard-local-report-required") {
        const [secondPath] = [...descriptors.entries()].find(([path]) => path.includes("vault-b"))!;
        writes.push(writeFile(join(secondPath, "Notes", "Welcome.md"), "Early cross-Vault bytes changed"));
      }
      if (controls === "cross-vault" && name.endsWith("local-control-report-required")) {
        const [vaultPath] = [...descriptors.entries()].find(([path]) => path.includes("vault-b"))!;
        writes.push(writeFile(join(vaultPath, "Notes", "Welcome.md"), "Cross-Vault bytes changed"));
      }
      if ((controls === "real" || controls === "foreign-before" || controls === "foreign-after") && name.endsWith("local-control-report-required")) {
        const [vaultPath] = [...descriptors.entries()].find(([path]) => path.includes(name.startsWith("vault-a") ? "vault-a" : "vault-b"))!;
        const bridge = bridges.get(vaultPath)!;
        const action = name.includes("resume-writes") ? "resume-writes" : "accept-recovery-baseline";
        writes.push((async () => {
          const capture = async (salt: Uint8Array, phase: "before" | "after") => {
            const observed = (await createLoopbackMcpClient().observeHealth(bridge.endpoint, vaultPath)).health;
            if (observed.outcome !== "observed") throw new Error("Missing fixture health");
            const journal = executions.has(vaultPath) ? await executions.get(vaultPath)!.diagnosticJournalFacts() : { availability: "unavailable", frames: [] };
            // Keep both real rejected controls intact. Substitute identities only at A's successful baseline.
            const foreign = vaultPath.includes("vault-a") && action === "accept-recovery-baseline" && controls === `foreign-${phase}`;
            const sourceId = (value: string) => foreign ? `foreign-474-${value}` : value;
            return createStandardDiagnosticBundle({ vaultId: foreign ? "foreign-474-vault" : vaultPath, versions: observed.versions,
              health: { readiness: observed.readiness, recovery: observed.recovery.state, write: observed.write,
                effectiveGate: observed.effectiveGate?.code ?? null, overall: observed.overall, reasonCodes: observed.reasonCodes, operatorAction: observed.operatorAction },
              listener: observed.listener, queue: observed.queue, lifecycle: observed.lifecycle,
              journal: { ...journal, frames: journal.frames.map(frame => frame.state === "valid" ? { ...frame, changeSetId: sourceId(frame.changeSetId) } : frame) },
              changeSets: (registries.get(vaultPath)?.entries ?? []).map(entry => ({ changeSetId: sourceId(entry.changeSetId),
                submissionKey: sourceId(entry.submissionKey), enqueueSeq: entry.enqueueSeq, state: entry.changeSet.state, executionPhase: entry.execution?.phase ?? null })), machineEvents: [] }, salt);
          };
          const beforeSalt = randomBytes(32);
          const afterSalt = randomBytes(32);
          const before = await capture(beforeSalt, "before");
          let outcome: "accepted" | "rejected" = "accepted";
          try { if (action === "resume-writes") await bridge.resumeWrites(); else await bridge.acceptTrustedRecoveryBaseline(async () => undefined); }
          catch { outcome = "rejected"; }
          expect(outcome).toBe(vaultPath.includes("vault-b") || action === "resume-writes" && before.health.recovery === "blocked" ? "rejected" : "accepted");
          const after = await capture(afterSalt, "after");
          privateSalts.push(beforeSalt.toString("hex"), afterSalt.toString("hex"));
          for (const salt of privateSalts) expect(JSON.stringify({ before, after })).not.toContain(salt);
          const activation = await activateInstalledRuntimeAcceptanceDriver({ vaultPath, pluginId: "privacy-plugin" });
          try { await activation!.recordLocalWriteControl({ vaultId: vaultPath, endpoint: bridge.endpoint, invocationId: randomUUID(), action, outcome, before, after,
            diagnosticCorrelationSalts: { before: beforeSalt.toString("hex"), after: afterSalt.toString("hex") } }); }
          finally { activation?.dispose(); }
          const controlFiles = (await readdir(descriptors.get(vaultPath)!.descriptor.reportDirectory)).filter(filename => filename.startsWith("local-write-control-"));
          for (const filename of controlFiles) {
            const facts = await stat(join(descriptors.get(vaultPath)!.descriptor.reportDirectory, filename));
            if (process.platform !== "win32") expect(facts.mode & 0o077).toBe(0);
          }
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
  return { root, options, events, privateSalts, publicRecords, cleanup: async () => { for (const timer of scenarioTimers) clearInterval(timer); await Promise.all(writes); for (const bridge of bridges.values()) await bridge.stop(); for (const execution of executions.values()) await execution.close?.(); await rm(root, { recursive: true, force: true }); } };
}

it("474 refuses a pending current-run control before requesting its fresh observation window", async () => {
  const fixture = await reportFixture("blocked", "stale");
  try {
    await expect(runInstalledPrivacyRecoveryAuthorityCorpus({ ...fixture.options, recoveryControls: true }))
      .rejects.toThrow("Local control report predates independent before source observation");
    expect(fixture.events).not.toContain("vault-a-resume-writes-local-control-report-required");
  } finally { await fixture.cleanup(); }
});

it.each(["before", "after"] as const)("474 rejects foreign %s at successful A baseline even with correct private salts and two real rejections", async phase => {
  const fixture = await reportFixture("blocked", `foreign-${phase}`);
  try {
    await expect(runInstalledPrivacyRecoveryAuthorityCorpus({ ...fixture.options, recoveryControls: true }))
      .rejects.toThrow(`Local control ${phase} diagnostic does not match independently observed sources`);
    expect(fixture.events).toContain("baseline-invalid-resume-explicitly-rejected");
    expect(fixture.events).toContain("baseline-vault-b-accept-recovery-baseline-rejected-observed");
    expect(fixture.events).toContain("vault-a-accept-recovery-baseline-local-control-report-required-published-accepted");
  } finally { await fixture.cleanup(); }
});

it("474 independently consumes all four real controls, preserves history, continues with a new key and cleans generated roots", async () => {
  const fixture = await reportFixture("blocked", "real");
  try {
    const result = await runInstalledPrivacyRecoveryAuthorityCorpus({ ...fixture.options, recoveryControls: true });
    expect(result.verdict).toBe("partial");
    expect(result.recoveryControlObservations.map(row => `${row.label}/${row.action}/${row.outcome}`)).toEqual([
      "vault-a/resume-writes/rejected", "vault-b/accept-recovery-baseline/rejected",
      "vault-a/accept-recovery-baseline/accepted", "vault-a/resume-writes/accepted",
    ]);
    for (const name of ["baseline-independent-cleared-journal-paused-progress", "baseline-independent-explicit-resume",
      "baseline-new-key-continuation-and-vault-b-isolation"]) expect(fixture.events).toContain(name);
    expect(result.baselineResumeEvidence?.cleanup).toEqual({ confirmed: true, residualCount: 0 });
    expect(fixture.privateSalts).toHaveLength(8);
    for (const salt of fixture.privateSalts) expect(JSON.stringify({ result, records: fixture.publicRecords })).not.toContain(salt);
    expect((await readdir(fixture.root)).filter(name => name.startsWith("reports-") || name.startsWith("installed-runtime-vault-"))).toEqual([]);
  } finally { await fixture.cleanup(); }
});
