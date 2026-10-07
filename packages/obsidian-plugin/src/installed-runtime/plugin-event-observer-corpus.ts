import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { parseChangeSetSubmitResult, parseChangeSetStatusResult } from "@llm-wiki/vault-contracts";
import { EXACT_FIXTURE, EXACT_ORIGINAL_BYTES, EXACT_COMMITTED_BYTES } from "../corpus/edit-fixtures.js";
import { replaceExactCorpusProfile } from "../corpus/edit-body-corpus.js";
import { EXPECTED_VAULT_ID_HEADER } from "../request-policy.js";
import { installCandidateBundle, type VerifiedCandidateBundle } from "./candidate-bundle.js";
import { provisionTestVault, cleanupTestVault, snapshotInventory, compareInventories } from "./test-vault.js";
import { readPersistedBridgeIdentity, waitForCondition, type ObsidianProcessControl, type ObsidianProcessHandle } from "./obsidian-process.js";
import { preflightRuntimeProfile, type RegisteredRuntimeProfile, type RuntimeEnvironmentProbe } from "./runtime-profile.js";
import { type LoopbackMcpClient } from "./loopback-client.js";
import { installPluginEventObserver, OBSERVER_CONFIG_FILE, EVENT_OBSERVER_PLUGIN_SOURCE } from "./plugin-event-observer-plugin.js";
import { verifyPluginEventObserverWindow, type PluginEventObserverBinding } from "./plugin-event-observer.js";
import { requestInstalledCrashRestorationScenario, loadCrashBoundaryReport } from "./crash-restoration-protocol.js";
import { readInstalledCrashJournal } from "./installed-crash-restoration-slice.js";
import { requestInstalledSemanticEvidenceScenario, type InstalledRuntimeAcceptanceDriverHandle } from "./smoke-command.js";
import type { InstalledSemanticEvidenceScenarioRunner } from "./semantic-evidence-corpus.js";
import { pluginEventObserverCorpusEvidenceSchema, observerProjectionSha256, type PluginEventObserverCorpusEvidence } from "./plugin-event-observer-evidence.js";
import { requireObserverInSupervisedProcessTree } from "./plugin-event-observer-process.js";

export const PLUGIN_EVENT_OBSERVER_SCENARIOS = ["success", "rollback", "startup-recovery"] as const;
export type PluginEventObserverScenario = typeof PLUGIN_EVENT_OBSERVER_SCENARIOS[number];
const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
/** Consume the private sealed source, not another copy of the public summary. */
export async function readPluginEventObserverSourceReport(options: Omit<Parameters<typeof verifyPluginEventObserverWindow>[0], "events" | "expectedPid"> & {
  scenario: PluginEventObserverScenario; reportDirectory: string; configDirectoryName: string; supervisorPid: number;
  window: ReturnType<typeof verifyPluginEventObserverWindow> & { supervisorPid: number; supervisedProcessTreeVerified: true };
}): Promise<PluginEventObserverCorpusEvidence["sourceReports"][number]> {
  const { binding } = options;
  const pluginsDirectory = join(binding.vaultPath, options.configDirectoryName, "plugins");
  const observerMain = await readFile(join(pluginsDirectory, "llm-wiki-event-observer", "main.js"));
  const candidateMain = await readFile(join(pluginsDirectory, options.candidatePluginId, "main.js"));
  const identity = await readPersistedBridgeIdentity(binding.vaultPath, options.candidatePluginId, options.configDirectoryName);
  const enabledPlugins: unknown = JSON.parse(await readFile(join(binding.vaultPath, options.configDirectoryName, "community-plugins.json"), "utf8"));
  if (hash(observerMain) !== hash(EVENT_OBSERVER_PLUGIN_SOURCE) || hash(observerMain) !== binding.observerMainSha256 ||
      hash(candidateMain) !== binding.installedMainSha256 || identity === null || identity.vaultId !== binding.vaultId ||
      !Array.isArray(enabledPlugins) || JSON.stringify(enabledPlugins.slice().sort()) !== JSON.stringify(["llm-wiki-event-observer", options.candidatePluginId].sort())) {
    throw new Error("Observer independent source installed identity changed");
  }
  const transcript = await readFile(join(options.reportDirectory, `observer-generation-${binding.generation}.sealed.jsonl`), "utf8");
  const events = transcript.trim().split("\n").map(line => JSON.parse(line) as { payload: { pid: number } });
  const rendererPid = events[0]?.payload.pid;
  if (rendererPid === undefined) throw new Error("Observer independent source renderer is absent");
  const sourceWindow = verifyPluginEventObserverWindow({ ...options, events, expectedPid: rendererPid });
  await requireObserverInSupervisedProcessTree(rendererPid, options.supervisorPid);
  if (JSON.stringify(options.window) !== JSON.stringify({ ...sourceWindow, supervisorPid: options.supervisorPid, supervisedProcessTreeVerified: true })) {
    throw new Error("Observer summary differs from independent authenticated source");
  }
  return { scenario: options.scenario, runId: binding.runId, vaultIdSha256: hash(identity.vaultId), vaultPathSha256: hash(binding.vaultPath),
    candidateBundleSha256: binding.candidateBundleSha256, installedMainSha256: hash(candidateMain), profileName: binding.profileName,
    generation: binding.generation, observerMainSha256: hash(observerMain), rendererPid, supervisorPid: options.supervisorPid,
    transcriptSha256: sourceWindow.transcriptSha256, projectionSha256: observerProjectionSha256(sourceWindow) };
}
export type PluginEventObserverSourceObservation = Omit<Parameters<typeof readPluginEventObserverSourceReport>[0], "window"> & { window: Parameters<typeof readPluginEventObserverSourceReport>[0]["window"] };
export interface PluginEventObserverConsumptionContext {
  runId: string; candidateBundleSha256: string; installedMainSha256: string; profileName: string; candidatePluginId: string;
  observations: { verification: Parameters<typeof verifyPluginEventObserverWindow>[0]; scenario: PluginEventObserverScenario;
    supervisorPid: number; source: PluginEventObserverCorpusEvidence["sourceReports"][number] }[];
}
/** The caller owns this context outside the public report, retaining authenticated source bytes after Vault cleanup. */
export async function retainPluginEventObserverSource(options: PluginEventObserverSourceObservation) {
  const source = await readPluginEventObserverSourceReport(options);
  const events: unknown = (await readFile(join(options.reportDirectory, `observer-generation-${options.binding.generation}.sealed.jsonl`), "utf8"))
    .trim().split("\n").map(line => JSON.parse(line));
  const verification = { binding: structuredClone(options.binding), candidatePluginId: options.candidatePluginId, expectedPid: source.rendererPid,
    files: structuredClone(options.files), maxSilenceMs: options.maxSilenceMs, events,
    ...(options.requiredVisibleStates === undefined ? {} : { requiredVisibleStates: structuredClone(options.requiredVisibleStates) }),
    ...(options.requiredTransition === undefined ? {} : { requiredTransition: structuredClone(options.requiredTransition) }),
    ...(options.requiredCallbackPaths === undefined ? {} : { requiredCallbackPaths: structuredClone(options.requiredCallbackPaths) }) };
  const retained = verifyPluginEventObserverWindow(verification);
  if (retained.transcriptSha256 !== source.transcriptSha256) throw new Error("Observer sealed source changed during retention");
  return { verification, scenario: options.scenario, supervisorPid: options.supervisorPid, source };
}
export interface PluginEventObserverCorpusOptions {
  runId: string; workingDirectory: string; reportDirectory: string; candidate: VerifiedCandidateBundle;
  processControl: ObsidianProcessControl; client: LoopbackMcpClient; profile: RegisteredRuntimeProfile;
  probe: RuntimeEnvironmentProbe; configDirectoryName?: string;
  prepareAcceptanceDriver(options: { vaultPath: string; pluginId: string; candidateBundleSha256: string; configDirectoryName: string; reportDirectory: string }): Promise<InstalledRuntimeAcceptanceDriverHandle>;
  semanticEvidenceScenarioRunner: InstalledSemanticEvidenceScenarioRunner;
  timeouts: { startupMs: number; stopMs: number; portClosedMs: number };
  retainObservation(options: PluginEventObserverSourceObservation): Promise<void>;
}

/** Independently runnable generated correctness scenario. Never a performance measurement. */
export async function runPluginEventObserverScenario(options: PluginEventObserverCorpusOptions & { scenario: PluginEventObserverScenario }) {
  if (!/^[A-Za-z0-9_-]+$/u.test(options.runId) || !(PLUGIN_EVENT_OBSERVER_SCENARIOS as readonly string[]).includes(options.scenario)) throw new Error("Observer scenario or run identity is invalid");
  if (options.configDirectoryName !== undefined && (options.configDirectoryName.includes("/") || options.configDirectoryName.includes("\\") || options.configDirectoryName === "." || options.configDirectoryName === "..")) throw new Error("Observer configuration directory is unsafe");
  if (options.probe.probeRunning === undefined) throw new Error("Correctness observer requires installed runtime observation");
  const runId = `${options.runId}-observer-${options.scenario}`;
  const vault = await provisionTestVault({ workingDirectory: options.workingDirectory, runId, configDirectoryName: options.configDirectoryName });
  const configDirectoryName = options.configDirectoryName ?? ".obsidian";
  const reportDirectory = join(options.reportDirectory, options.scenario);
  let handle: ObsidianProcessHandle | null = null;
  let driver: InstalledRuntimeAcceptanceDriverHandle | undefined;
  let stopUnconfirmed = false;
  let endpointForCleanup: URL | undefined;
  let vaultIdForCleanup: string | undefined;
  let result: unknown;
  let failure: unknown;
  const windows: (ReturnType<typeof verifyPluginEventObserverWindow> & { supervisorPid: number; supervisedProcessTreeVerified: true })[] = [];
  const sourceReports: PluginEventObserverCorpusEvidence["sourceReports"] = [];
  try {
    // Fixture generation occurs only before any enabled plugin starts.
    const target = join(vault.vaultPath, ...EXACT_FIXTURE.path.split("/"));
    await mkdir(dirname(target), { recursive: true });
    if (options.scenario !== "rollback") await writeFile(target, EXACT_ORIGINAL_BYTES, { flag: "wx" });
    await installCandidateBundle(options.candidate, vault.vaultPath, configDirectoryName);
    driver = await options.prepareAcceptanceDriver({ vaultPath: vault.vaultPath, pluginId: options.candidate.identity.pluginId,
      candidateBundleSha256: options.candidate.identity.bundleSha256, configDirectoryName, reportDirectory });
    const descriptor = driver.descriptor;
    if (descriptor.runId !== options.runId || descriptor.vaultPath !== vault.vaultPath || descriptor.reportDirectory !== reportDirectory || descriptor.candidateBundleSha256 !== options.candidate.identity.bundleSha256) throw new Error("Observer acceptance driver is not candidate/run bound");
    const observer = await installPluginEventObserver({ vaultPath: vault.vaultPath, configDirectoryName, reportDirectory,
      candidatePluginId: options.candidate.identity.pluginId,
      binding: { runId: options.runId, vaultPath: vault.vaultPath, vaultId: null, candidateBundleSha256: descriptor.candidateBundleSha256,
        installedMainSha256: descriptor.installedMainSha256, profileName: options.profile.name, generation: 1 } });
    let binding = observer.binding;
    let commandSequence = 0;
    const command = async (action: "begin" | "end", vaultId: string) => {
      const path = join(observer.directory, "window-command.json");
      await writeFile(`${path}.next`, JSON.stringify({ action, vaultId, sequence: ++commandSequence, generation: binding.generation, runId: binding.runId, capabilityToken: binding.capabilityToken }), { mode: 0o600 });
      await rename(`${path}.next`, path);
    };
    const loadEvents = async (sealed = false) => (await readFile(join(reportDirectory, `observer-generation-${binding.generation}${sealed ? ".sealed" : ""}.jsonl`), "utf8")).trim().split("\n").map(line => JSON.parse(line) as { payload: { kind: string; pid: number } });
    const waitMarker = async (kind: string) => await waitForCondition(async () => {
      try { return (await loadEvents()).some(event => event.payload.kind === kind); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError) return false; throw error; }
    }, { timeoutMs: options.timeouts.startupMs, intervalMs: 25 });
    const start = async () => {
      handle = await options.processControl.start({ vaultPath: vault.vaultPath, profileDirectory: vault.profileDirectory });
      if (handle.pid === undefined) throw new Error("Observer requires supervised installed process identity");
      const observed = await options.probe.probeRunning!({ vaultPath: vault.vaultPath, profileDirectory: vault.profileDirectory });
      if (preflightRuntimeProfile(options.profile, observed).length !== 0) throw new Error("Observer installed runtime does not match registered profile");
      await waitMarker("candidate-start");
      return observed;
    };
    const runtime = await start();
    let identity: Awaited<ReturnType<typeof readPersistedBridgeIdentity>> = null;
    await waitForCondition(async () => {
      identity = await readPersistedBridgeIdentity(vault.vaultPath, options.candidate.identity.pluginId, configDirectoryName);
      return identity !== null;
    }, { timeoutMs: options.timeouts.startupMs, intervalMs: 25 });
    if (identity === null) throw new Error("Observer Managed Vault identity missing");
    const vaultId = (identity as { vaultId: string; port: number }).vaultId;
    const endpoint = new URL(`http://127.0.0.1:${(identity as { port: number }).port}/mcp`);
    endpointForCleanup = endpoint; vaultIdForCleanup = vaultId;
    await waitForCondition(async () => (await options.client.observeHealth(endpoint, vaultId)).health.readiness.searchSnapshot === "ready", { timeoutMs: options.timeouts.startupMs, intervalMs: 25 });
    binding = { ...binding, vaultId };
    await command("begin", vaultId); await waitMarker("window-begin");
    const beforeInventory = await snapshotInventory(vault.vaultPath);
    const files = [
      ...vault.seedNotes.map(note => ({ path: note.path, before: new TextEncoder().encode(note.content), after: new TextEncoder().encode(note.content) })),
      { path: EXACT_FIXTURE.path, before: EXACT_ORIGINAL_BYTES, after: EXACT_COMMITTED_BYTES, allowFixtureLifecycleAbsence: options.scenario === "rollback" },
    ];
    const call = async (name: string, args: Record<string, unknown>) => {
      const client = new Client({ name: "plugin-event-observer-correctness", version: "1.0.0" });
      try {
        await client.connect(new StreamableHTTPClientTransport(endpoint, { requestInit: { headers: { [EXPECTED_VAULT_ID_HEADER]: vaultId } } }));
        const response = await client.callTool({ name, arguments: args });
        if (response.structuredContent === undefined) throw new Error("Observer wire result is absent");
        return response.structuredContent;
      } finally { await client.close(); }
    };
    const closeWindow = async () => {
      // Require a target indexing callback in this generation, not unrelated
      // initial cache traffic or a post-window read of the final fixture.
      await waitForCondition(async () => (await loadEvents()).some(event => {
        const payload = event.payload as typeof event.payload & { path?: string };
        return payload.path === EXACT_FIXTURE.path && (payload.kind === "changed" || payload.kind === "resolved");
      }), { timeoutMs: options.timeouts.startupMs, intervalMs: 25 });
      await command("end", vaultId); await waitMarker("window-end");
      await waitForCondition(async () => {
        try { await loadEvents(true); return true; }
        catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
      }, { timeoutMs: options.timeouts.startupMs, intervalMs: 25 });
      const requiredBytes = options.scenario === "rollback" ? [EXACT_ORIGINAL_BYTES, EXACT_COMMITTED_BYTES] :
        options.scenario === "startup-recovery" && binding.generation === 2 ? [EXACT_ORIGINAL_BYTES] : [EXACT_COMMITTED_BYTES];
      const sealedEvents = await loadEvents(true);
      const rendererPid = sealedEvents[0]?.payload.pid;
      if (rendererPid === undefined) throw new Error("Observer renderer process identity missing");
      const verification = { binding, candidatePluginId: options.candidate.identity.pluginId, files, maxSilenceMs: 2_000,
        requiredVisibleStates: requiredBytes.map(bytes => ({ path: EXACT_FIXTURE.path, bytes })),
        ...(options.scenario === "rollback" ? { requiredTransition: { path: EXACT_FIXTURE.path, states: [EXACT_COMMITTED_BYTES, EXACT_ORIGINAL_BYTES] } } : {}) };
      const window = { ...verifyPluginEventObserverWindow({ ...verification, events: sealedEvents, expectedPid: rendererPid }),
        supervisorPid: handle!.pid!, supervisedProcessTreeVerified: true as const };
      const source = await readPluginEventObserverSourceReport({ ...verification, scenario: options.scenario, reportDirectory, configDirectoryName,
        supervisorPid: handle!.pid!, window });
      await options.retainObservation({ ...verification, scenario: options.scenario, reportDirectory, configDirectoryName, supervisorPid: handle!.pid!, window });
      sourceReports.push(source);
      windows.push(window);
    };
    const seed = `${runId}-edit`;
    const input = replaceExactCorpusProfile().buildSubmitInput(seed);
    if (options.scenario === "success") {
      const submit = parseChangeSetSubmitResult(await call("vault_change_set_submit", input));
      if (submit.outcome !== "registered" || submit.changeSet.state !== "intent_applied") throw new Error("Observer success Change Set did not commit");
      if (!Buffer.from(await readFile(target)).equals(EXACT_COMMITTED_BYTES)) throw new Error("Observer committed fixture bytes differ");
      await closeWindow();
    } else if (options.scenario === "rollback") {
      // Existing fixture induces a real deadline rollback; observer remains independent
      // of the candidate's intentionally filtered Semantic Evidence callbacks.
      const scenario = "edit_body/missing_observation_deadline" as const;
      await requestInstalledSemanticEvidenceScenario({ descriptorPath: driver.path, descriptor, scenario, expectedVaultId: vaultId, endpoint });
      const summary = await options.semanticEvidenceScenarioRunner.run({ scenario, endpoint, expectedVaultId: vaultId, workingDirectory: options.workingDirectory });
      if (summary.proofState !== "intent_not_applied" || summary.statusProofState !== "intent_not_applied" || !summary.cleanupSucceeded) throw new Error("Observer rollback fixture did not restore");
      const rollbackJournal = await readInstalledCrashJournal(join(vault.vaultPath, ".llm-wiki", "recovery-journal.bin"));
      if (rollbackJournal.phase !== "ROLLED_BACK") throw new Error("Observer rollback fixture lacks durable restoration");
      await closeWindow();
    } else {
      await requestInstalledCrashRestorationScenario({ descriptorPath: driver.path, descriptor, expectedVaultId: vaultId,
        endpoint, input, crashPoint: "after_file_mutation:0", mutationKind: "edit_body" });
      await waitForCondition(async () => {
        try { await loadCrashBoundaryReport({ reportDirectory, runId: options.runId, vaultId, candidateBundleSha256: descriptor.candidateBundleSha256,
          installedMainSha256: descriptor.installedMainSha256, capabilityToken: descriptor.capabilityToken, endpoint: endpoint.toString(), submissionKey: input.submissionKey as string,
          crashPoint: "after_file_mutation:0", mutationKind: "edit_body" }); return true; }
        catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
      }, { timeoutMs: options.timeouts.startupMs, intervalMs: 25 });
      const crashJournal = await readInstalledCrashJournal(join(vault.vaultPath, ".llm-wiki", "recovery-journal.bin"));
      if (crashJournal.phase !== "PREPARED" || !Buffer.from(await readFile(target)).equals(EXACT_COMMITTED_BYTES) ||
          typeof crashJournal.payload !== "object" || crashJournal.payload === null || Array.isArray(crashJournal.payload) ||
          crashJournal.payload.vaultId !== vaultId || JSON.stringify(crashJournal.payload.input) !== JSON.stringify(input)) throw new Error("Observer crash fixture did not park bound PREPARED after mutation");
      await closeWindow();
      await handle!.stop(); handle = null;
      await waitForCondition(async () => {
        try { await options.client.observeHealth(endpoint, vaultId); return false; }
        catch (error) { return (error as { code?: string }).code === "health_unreachable"; }
      }, { timeoutMs: options.timeouts.portClosedMs, intervalMs: 25 });
      binding = { ...binding, generation: 2 };
      commandSequence = 0;
      await writeFile(join(observer.directory, OBSERVER_CONFIG_FILE), JSON.stringify({ binding, observerId: "llm-wiki-event-observer", candidatePluginId: options.candidate.identity.pluginId, reportDirectory }), { mode: 0o600 });
      await writeFile(join(observer.directory, "window-command.json"), JSON.stringify({ sequence: 0 }));
      await start(); // Gate begins the bound recovery window before runtime.load.
      await waitMarker("window-begin");
      await waitForCondition(async () => {
        try { const health = (await options.client.observeHealth(endpoint, vaultId)).health; return health.readiness.searchSnapshot === "ready" && health.recovery.state === "none"; }
        catch (error) { if ((error as { code?: string }).code === "health_unreachable") return false; throw error; }
      }, { timeoutMs: options.timeouts.startupMs, intervalMs: 25 });
      const status = parseChangeSetStatusResult(await call("vault_change_set_status", { submissionKey: input.submissionKey }));
      const recoveredJournal = await readInstalledCrashJournal(join(vault.vaultPath, ".llm-wiki", "recovery-journal.bin"));
      if (recoveredJournal.phase !== "ROLLED_BACK" || status.lookup !== "found" || status.changeSet.state !== "intent_not_applied" || !Buffer.from(await readFile(target)).equals(EXACT_ORIGINAL_BYTES)) throw new Error("Observed startup recovery did not restore full original bytes");
      await closeWindow();
    }
    const afterInventory = await snapshotInventory(vault.vaultPath);
    const comparison = compareInventories(beforeInventory, afterInventory);
    await writeFile(join(reportDirectory, "observer-inventories.private.json"), JSON.stringify({ beforeInventory, afterInventory }), { flag: "wx", mode: 0o600 });
    result = { scenario: options.scenario, runId: options.runId, vaultIdSha256: hash(vaultId), vaultPathSha256: hash(vault.vaultPath),
      candidateBundleSha256: descriptor.candidateBundleSha256, installedMainSha256: descriptor.installedMainSha256,
      profileName: options.profile.name, runtime, purpose: "isolated-correctness-not-performance", seed: runId, seedManifestSha256: vault.seedManifestSha256,
      inventory: { beforeDigest: comparison.beforeDigest, afterDigest: comparison.afterDigest,
        addedPaths: comparison.addedPaths.map(hash), removedPaths: comparison.removedPaths.map(hash), changedPaths: comparison.changedPaths.map(hash) }, windows };
  } catch (error) {
    if ((error as { code?: string }).code === "obsidian_stop_failed") stopUnconfirmed = true;
    failure = error;
  }
  finally {
    try {
      await (handle as ObsidianProcessHandle | null)?.stop(); handle = null;
      if (endpointForCleanup !== undefined && vaultIdForCleanup !== undefined) await waitForCondition(async () => {
        try { await options.client.observeHealth(endpointForCleanup!, vaultIdForCleanup!); return false; }
        catch (error) { return (error as { code?: string }).code === "health_unreachable"; }
      }, { timeoutMs: options.timeouts.portClosedMs, intervalMs: 25 });
    } catch { stopUnconfirmed = true; }
    if (stopUnconfirmed) throw new Error("Observer process shutdown unconfirmed; generated roots retained");
    await driver?.cleanup();
    const cleanup = await cleanupTestVault(vault);
    if (!cleanup.attempted || cleanup.residualPaths.length !== 0) throw new Error("Observer generated Vault cleanup unconfirmed");
    if (failure !== undefined) throw failure;
  }
  if (result === undefined) throw new Error("Observer scenario produced no evidence");
  return { ...result as Record<string, unknown>, sourceReports, cleanup: { attempted: true, residualPaths: [] }, verdict: "passed" as const };
}

export async function runPluginEventObserverCorpus(options: PluginEventObserverCorpusOptions) {
  const scenarios = [];
  const sourceReports: PluginEventObserverCorpusEvidence["sourceReports"] = [];
  for (const scenario of PLUGIN_EVENT_OBSERVER_SCENARIOS) {
    const { sourceReports: sources, ...result } = await runPluginEventObserverScenario({ ...options, scenario });
    sourceReports.push(...sources);
    scenarios.push(result);
  }
  return pluginEventObserverCorpusEvidenceSchema.parse({ scenarios, sourceReports, candidateBundleSha256: options.candidate.identity.bundleSha256, runId: options.runId, profileName: options.profile.name,
    purpose: "isolated-correctness-not-performance", scenarioManifestSha256: hash(JSON.stringify(PLUGIN_EVENT_OBSERVER_SCENARIOS)),
    assertions: ["observer:real-enabled-plugin-complete-before-after-success-rollback-startup-recovery"], verdict: "passed" as const });
}
