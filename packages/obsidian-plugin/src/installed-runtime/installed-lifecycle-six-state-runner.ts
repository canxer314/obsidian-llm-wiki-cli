import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { connect } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { parseChangeSetSubmitResult } from "@llm-wiki/vault-contracts";
import { installReleaseToManagedVaults } from "../lifecycle/install-release.js";
import { verifyManagedVaultLifecycle, type ManagedVaultLifecycleState } from "../lifecycle/lifecycle-status.js";
import { isReleaseManagedFile, managedVaultPluginDirectory } from "../lifecycle/release-managed-files.js";
import { createRegistrationCommand } from "../registration-command.js";
import { isVerifiedCandidateBundle } from "./candidate-bundle.js";
import { createLoopbackMcpClient } from "./loopback-client.js";
import { ObsidianProcessError, readPersistedBridgeIdentity, waitForCondition, type ObsidianProcessHandle, type PersistedBridgeIdentity } from "./obsidian-process.js";
import { lookupRegisteredRuntimeProfile, preflightRuntimeProfile, type ObservedRuntimeEnvironment } from "./runtime-profile.js";
import { cleanupTestVault, compareInventories, provisionTestVault, snapshotInventory, type ProvisionedTestVault } from "./test-vault.js";
import { observeIsolatedMcpRegistration, type AgentRegistrationCommand } from "./installed-lifecycle-registration.js";
import type { InstalledReleaseLifecycleSliceOptions } from "./installed-release-lifecycle-runner.js";

export interface LifecycleOperatorObservationRequest {
  readonly action: "enable-plugin" | "register-mcp";
  readonly vaultPath: string;
  readonly configDirectory: string;
  readonly pluginId: string;
  readonly serverName: string;
  readonly vaultId: string;
  readonly endpoint: string;
  readonly registrationCommand: string | null;
}
export interface InstalledLifecycleSixStateOptions extends InstalledReleaseLifecycleSliceOptions {
  /** Notification/wait seam only. Production runner never enables or registers. */
  readonly operatorObservation?: (request: LifecycleOperatorObservationRequest) => Promise<void>;
  readonly runAgentCommand?: AgentRegistrationCommand;
  readonly operatorTimeoutMs?: number;
}
const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const STATES = ["not_installed", "installed_not_enabled", "bridge_offline", "mcp_not_registered", "ready", "identity_mismatch"] as const;
const MANIFEST = { version: 1, seed: "spec44-installed-lifecycle-475-v1", states: STATES,
  transitions: ["files-only", "operator-enable", "stop-before-offline", "operator-local-registration", "wrong-header-rejected", "offline-unchanged", "offline-damage-repair", "restart-health", "process-exit", "listener-close", "cleanup"] };

async function listenerClosed(port: number, timeoutMs: number): Promise<void> {
  await waitForCondition(() => new Promise<boolean>((resolvePromise, reject) => {
    const socket = connect({ host: "127.0.0.1", port });
    const timer = setTimeout(() => { socket.destroy(); reject(new Error("Listener closure uncertain")); }, Math.min(timeoutMs, 1000));
    socket.once("connect", () => { clearTimeout(timer); socket.destroy(); resolvePromise(false); });
    socket.once("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(timer); socket.destroy();
      if (error.code === "ECONNREFUSED") resolvePromise(true); else reject(error);
    });
  }), { timeoutMs, intervalMs: 25 });
}

/** Hash every actual non-release byte, including Vault content, settings,
 * registry/keys/queue and the entire hidden Journal area. No private paths leave
 * this module. Offline snapshots cannot race the plugin's state persistence. */
async function retainedInventory(vault: ProvisionedTestVault, pluginId: string, config: string) {
  const directories: string[] = [];
  const walkDirectories = async (directory: string, prefix: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isSymbolicLink()) throw new Error("Lifecycle inventory rejects symlinks");
      if (entry.isDirectory()) { directories.push(path); await walkDirectories(join(directory, entry.name), path); }
      else if (!entry.isFile()) throw new Error("Lifecycle inventory contains an uncertain file type");
    }
  };
  await walkDirectories(vault.vaultPath, "");
  const directoryManifest = directories.sort().join("\n");
  const prefix = `${config}/plugins/${pluginId}/`;
  const inventory = (await snapshotInventory(vault.vaultPath)).filter(entry =>
    !entry.path.startsWith(prefix) || !isReleaseManagedFile(entry.path.slice(prefix.length)));
  const settingsPath = `${prefix}data.json`;
  if (!inventory.some(entry => entry.path === settingsPath)) throw new Error("Repair settings inventory is absent");
  if (!inventory.some(entry => entry.path === ".llm-wiki/recovery-journal.bin")) throw new Error("Repair Journal inventory is absent");
  const data = JSON.parse(await readFile(join(vault.vaultPath, settingsPath), "utf8"));
  if (!Array.isArray(data.changeSets?.entries) || data.changeSets.entries.length === 0) throw new Error("Repair requires real persisted Submission Key and record evidence");
  return { inventory, summary: {
    files: inventory.length, directoryCount: directories.length,
    directoryManifestSha256: hash(directoryManifest),
    inventorySha256: hash(`${compareInventories(inventory, inventory).beforeDigest}\n${directoryManifest}`),
    vaultIdSha256: hash(data.vaultId), port: data.port,
    settingsSha256: inventory.find(entry => entry.path === settingsPath)!.sha256,
    journalSha256: inventory.find(entry => entry.path === ".llm-wiki/recovery-journal.bin")!.sha256,
    recordsSha256: hash(JSON.stringify(data.changeSets)),
    keysSha256: hash(JSON.stringify(data.changeSets.entries.map((entry: { submissionKey: string }) => entry.submissionKey))),
    queueSha256: hash(JSON.stringify(data.changeSets.entries.filter((entry: { execution?: { phase?: string } }) => entry.execution?.phase === "queued"))),
    recordCount: data.changeSets.entries.length,
  } };
}

async function realMcpWork(identity: PersistedBridgeIdentity, runId: string) {
  const client = new Client({ name: "installed-lifecycle-475", version: "1.0.0" });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${identity.port}/mcp`), {
      requestInit: { headers: { "X-Expected-Vault-ID": identity.vaultId } },
    }));
    const raw = await client.callTool({ name: "vault_change_set_submit", arguments: { submissionKey: `lifecycle-${runId}`,
      operations: [{ operationId: "lifecycle-mkdir", kind: "create_directory", path: "Lifecycle475", ifExists: "reject" }] } });
    const result = parseChangeSetSubmitResult(raw.structuredContent);
    if (raw.isError === true || result.outcome !== "registered" || result.changeSet.state !== "intent_applied" ||
        !Array.isArray(raw.content) || raw.content.find((block: { type: string; text?: string }) => block.type === "text")?.text !== JSON.stringify(result)) {
      throw new Error("Lifecycle state seed was not applied through real MCP");
    }
    return { submissionKeySha256: hash(`lifecycle-${runId}`), changeSetIdSha256: hash(result.changeSet.changeSetId) };
  } finally { await client.close(); }
}

/** Independent A-32 slice. Always partial for the complete release lifecycle
 * (upgrade/resume/uninstall/purge are elsewhere). Neither a printed command nor
 * a caller's passed report can advance an observation. */
export async function runInstalledLifecycleSixStateSlice(options: InstalledLifecycleSixStateOptions) {
  if (!isVerifiedCandidateBundle(options.candidate) || options.candidate.attestationSource !== "github-artifact-attestation") {
    throw new Error("Installed lifecycle acceptance requires a verified release, not a local candidate");
  }
  if (lookupRegisteredRuntimeProfile(options.profileName) !== options.profile || options.profileName !== options.profile.name || options.probe.probeRunning === undefined) {
    throw new Error("Installed lifecycle requires a registered profile and running runtime provenance");
  }
  const host = await options.probe.probe();
  if (host.platform !== options.profile.os.platform || host.osBuild !== options.profile.os.build || options.profile.capabilities.some(value => !host.capabilities.includes(value))) {
    throw new Error("Installed lifecycle host does not match registered runtime profile");
  }
  const runId = options.runId ?? randomUUID();
  const config = options.configDirectoryName ?? ".obsidian";
  const startupMs = options.timeouts?.startupMs ?? 120_000;
  const stopMs = options.timeouts?.stopMs ?? 30_000;
  const operatorMs = options.operatorTimeoutMs ?? 180_000;
  const client = createLoopbackMcpClient({ timeoutMs: startupMs });
  const events: { sequence: number; name: string; sourceSha256: string }[] = [];
  const states: ManagedVaultLifecycleState[] = [];
  const event = (name: string, source: unknown) => events.push({ sequence: events.length + 1, name, sourceSha256: hash(JSON.stringify(source)) });
  let vault: ProvisionedTestVault | null = null;
  let handle: ObsidianProcessHandle | null = null;
  let shutdownUnconfirmed = false;
  let identity: PersistedBridgeIdentity | null = null;
  const runtime: ObservedRuntimeEnvironment[] = [];
  let before: Awaited<ReturnType<typeof retainedInventory>> | null = null;
  let after: Awaited<ReturnType<typeof retainedInventory>> | null = null;
  let install: { outcome: string; action: string | null } | null = null;
  let repair: { outcome: string; action: string | null } | null = null;
  let registration: Awaited<ReturnType<typeof observeIsolatedMcpRegistration>> | null = null;
  let work: Awaited<ReturnType<typeof realMcpWork>> | null = null;
  let cleanup: { attempted: boolean; residualPaths: string[] } | null = null;
  let failedStage: string | null = null;
  let stage = "provision";
  const statusTarget = () => ({ vaultPath: vault!.vaultPath, configDirectoryName: config, expectedPluginId: options.candidate.identity.pluginId });
  const configDirectory = () => join(vault!.profileDirectory, "agent");
  const registrationObservation = () => observeIsolatedMcpRegistration({ vaultPath: vault!.vaultPath, configDirectory: configDirectory(),
    vaultId: identity!.vaultId, port: identity!.port, ...(options.runAgentCommand === undefined ? {} : { runAgentCommand: options.runAgentCommand }) });
  const observe = async (expected: ManagedVaultLifecycleState, bridge = false) => {
    stage = expected;
    const status = await verifyManagedVaultLifecycle(statusTarget(), {
      observeBridge: async persisted => {
        if (!bridge) { await listenerClosed(persisted.port, stopMs); return null; }
        const result = await client.observeHealth(new URL(`http://127.0.0.1:${persisted.port}/mcp`), persisted.vaultId);
        if (result.health.versions.plugin !== options.candidate.identity.pluginVersion) throw new Error("Executing plugin differs from verified release version");
        return { vaultId: result.health.vault.id, port: result.health.listener.port };
      },
      isMcpRegistered: async () => { registration = await registrationObservation(); return registration.state === "registered"; },
    });
    if (status.state !== expected) throw new Error("Lifecycle fact differs from required state");
    states.push(expected); event(expected, status);
  };
  const stop = async () => {
    stage = "process-exit";
    if (handle === null) return;
    const ports = new Set<number>();
    if (identity !== null) ports.add(identity.port);
    let uncertainIdentity = false;
    try {
      const current = await readPersistedBridgeIdentity(vault!.vaultPath, options.candidate.identity.pluginId, config);
      if (current !== null) { ports.add(current.port); identity ??= current; }
    } catch { uncertainIdentity = true; }
    await handle.stop();
    try {
      const current = await readPersistedBridgeIdentity(vault!.vaultPath, options.candidate.identity.pluginId, config);
      if (current !== null) { ports.add(current.port); identity ??= current; }
    } catch { uncertainIdentity = true; }
    event("process-exit", { pid: handle.pid });
    for (const port of ports) { await listenerClosed(port, stopMs); event("listener-close", { port }); }
    if (uncertainIdentity) throw new Error("Shutdown listener identity is uncertain");
    handle = null;
  };
  const start = async () => {
    stage = "runtime-start";
    const installed = await readFile(join(managedVaultPluginDirectory(vault!.vaultPath, config, options.candidate.identity.pluginId), "main.js"));
    if (hash(installed) !== options.candidate.identity.files.find(file => file.path === "main.js")?.sha256) throw new Error("Installed executable bytes differ from verified release");
    try { handle = await options.processControl.start(vault!); } catch (error) {
      if (error instanceof ObsidianProcessError && error.code === "obsidian_stop_failed") shutdownUnconfirmed = true;
      throw error;
    }
    const observed = await options.probe.probeRunning!(vault!);
    if (preflightRuntimeProfile(options.profile, observed).length !== 0) throw new Error("Running process differs from registered profile");
    runtime.push(observed); event("runtime-start", { mainSha256: hash(installed), observed });
  };
  try {
    vault = await provisionTestVault({ workingDirectory: resolve(options.workingDirectory), runId, configDirectoryName: config });
    event("provision", { seedManifestSha256: vault.seedManifestSha256 });
    await mkdir(configDirectory());
    // Empty isolated config only; there is no automatic MCP server registration.
    await writeFile(join(configDirectory(), ".claude.json"), "{\"projects\":{}}\n", { flag: "wx", mode: 0o600 });
    const configBefore = hash(await readFile(join(configDirectory(), ".claude.json")));
    await observe("not_installed");
    stage = "first-install";
    const batch = await installReleaseToManagedVaults(options.candidate, [{ vaultPath: vault.vaultPath, configDirectoryName: config, obsidianVersion: options.profile.versions.obsidian }]);
    const installed = batch.targets[0];
    if (installed?.outcome !== "success" || installed.action !== "installed") throw new Error("Verified release first install failed");
    install = { outcome: installed.outcome, action: installed.action }; event(stage, install);
    if (hash(await readFile(join(configDirectory(), ".claude.json"))) !== configBefore) throw new Error("Install modified local Agent config");
    await observe("installed_not_enabled");
    await start();
    stage = "operator-enable";
    await options.operatorObservation?.({ action: "enable-plugin", vaultPath: vault.vaultPath, configDirectory: configDirectory(), pluginId: options.candidate.identity.pluginId,
      serverName: "", vaultId: "", endpoint: "", registrationCommand: null });
    await waitForCondition(async () => {
      try { return JSON.parse(await readFile(join(vault!.vaultPath, config, "community-plugins.json"), "utf8")).includes(options.candidate.identity.pluginId); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
    }, { timeoutMs: operatorMs, intervalMs: 25 });
    event(stage, await readFile(join(vault.vaultPath, config, "community-plugins.json"), "utf8"));
    await stop(); await observe("bridge_offline");
    await start();
    await waitForCondition(async () => { identity = await readPersistedBridgeIdentity(vault!.vaultPath, options.candidate.identity.pluginId, config); return identity !== null; }, { timeoutMs: startupMs });
    await observe("mcp_not_registered", true);
    stage = "operator-register";
    await options.operatorObservation?.({ action: "register-mcp", vaultPath: vault.vaultPath, configDirectory: configDirectory(), pluginId: options.candidate.identity.pluginId,
      serverName: `vault-${identity!.vaultId}`, vaultId: identity!.vaultId, endpoint: `http://127.0.0.1:${identity!.port}/mcp`,
      registrationCommand: createRegistrationCommand(identity!.vaultId, identity!.port) });
    await waitForCondition(async () => {
      registration = await registrationObservation();
      if (registration.state === "identity_mismatch") throw new Error("Local MCP registration identity mismatch");
      return registration.state === "registered";
    }, { timeoutMs: operatorMs, intervalMs: 25 });
    event(stage, registration); await observe("ready", true);
    stage = "identity_mismatch";
    const foreignId = randomUUID();
    const rejected = await fetch(`http://127.0.0.1:${identity!.port}/mcp`, { method: "POST", signal: AbortSignal.timeout(startupMs), headers: {
      "content-type": "application/json", "accept": "application/json, text/event-stream", "X-Expected-Vault-ID": foreignId },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "lifecycle-mismatch", version: "1" } } }) });
    const rejection = await rejected.json() as { error?: { message?: string } };
    if (foreignId === identity!.vaultId || rejected.status !== 403 || rejection.error?.message !== "mismatched_expected_vault_id") throw new Error("Wrong lifecycle identity was not rejected on real MCP wire");
    states.push("identity_mismatch"); event(stage, { status: rejected.status, rejection });
    stage = "state-seed"; work = await realMcpWork(identity!, runId); event(stage, work);
    await stop();
    stage = "repair-inventory";
    before = await retainedInventory(vault, options.candidate.identity.pluginId, config); event(stage, before.summary);
    const target = { vaultPath: vault.vaultPath, configDirectoryName: config, obsidianVersion: options.profile.versions.obsidian };
    stage = "same-version-unchanged";
    if ((await installReleaseToManagedVaults(options.candidate, [target])).targets[0]?.outcome !== "unchanged") throw new Error("Same-version reinstall was not unchanged");
    event(stage, { outcome: "unchanged" });
    stage = "damage-repair";
    const main = join(managedVaultPluginDirectory(vault.vaultPath, config, options.candidate.identity.pluginId), "main.js");
    const bytes = await readFile(main); bytes[0] = bytes[0]! ^ 0xff; await writeFile(main, bytes);
    const repaired = (await installReleaseToManagedVaults(options.candidate, [target])).targets[0];
    if (repaired?.outcome !== "success" || repaired.action !== "repaired" || repaired.repairedFiles.join(",") !== "main.js") throw new Error("Same-version repair did not restore the damaged entrypoint");
    repair = { outcome: repaired.outcome, action: repaired.action }; event(stage, repair);
    after = await retainedInventory(vault, options.candidate.identity.pluginId, config);
    if (before.summary.inventorySha256 !== after.summary.inventorySha256 || JSON.stringify(before.summary) !== JSON.stringify(after.summary)) throw new Error("Repair lost Vault operational or content state");
    event("state-preserved", after.summary);
    await start();
    const runningRetained = await retainedInventory(vault, options.candidate.identity.pluginId, config);
    if (after.summary.inventorySha256 !== runningRetained.summary.inventorySha256) throw new Error("Repaired executable lost retained Vault state on startup");
    event("repaired-executable-state", runningRetained.summary);
    const restoredIdentity = await readPersistedBridgeIdentity(vault.vaultPath, options.candidate.identity.pluginId, config);
    if (restoredIdentity?.vaultId !== identity!.vaultId || restoredIdentity?.port !== identity!.port) throw new Error("Repaired executable changed persisted identity");
    const health = await client.observeHealth(new URL(`http://127.0.0.1:${identity!.port}/mcp`), identity!.vaultId);
    if (health.health.versions.plugin !== options.candidate.identity.pluginVersion) throw new Error("Repaired executable did not load verified release version");
    event("repaired-executable-health", health); await stop();
  } catch { failedStage = stage; }
  finally {
    if (handle !== null) { try { await stop(); } catch { shutdownUnconfirmed = true; } }
    if (vault !== null && handle === null && !shutdownUnconfirmed) {
      try {
        const report = await cleanupTestVault(vault);
        cleanup = { attempted: report.attempted, residualPaths: report.residualPaths.map(() => "generated_runtime_residue") };
        if (!report.attempted || report.residualPaths.length !== 0) failedStage ??= "cleanup";
      } catch { cleanup = { attempted: true, residualPaths: ["cleanup_unconfirmed"] }; failedStage ??= "cleanup"; }
    } else if (vault !== null) { cleanup = { attempted: false, residualPaths: ["shutdown_unconfirmed"] }; failedStage ??= "cleanup"; }
    if (cleanup !== null) event("cleanup", cleanup);
  }
  const finalRegistration = registration as Awaited<ReturnType<typeof observeIsolatedMcpRegistration>> | null;
  const finalIdentity = identity as PersistedBridgeIdentity | null;
  const verdict = failedStage === null && states.join(",") === STATES.join(",") && runtime.length === 3 && before !== null && after !== null && finalRegistration?.state === "registered" && cleanup?.attempted === true && cleanup.residualPaths.length === 0 ? "partial" : "failed";
  const result = { scope: "installed-six-state-install-repair" as const, verdict: verdict as "partial" | "failed", runId,
    candidateBundleSha256: options.candidate.identity.bundleSha256, releaseTag: options.candidate.tag,
    attestationSource: options.candidate.attestationSource, profileName: options.profileName,
    vaultPathSha256: vault === null ? null : hash(vault.vaultPath), vaultIdSha256: finalIdentity === null ? null : hash(finalIdentity.vaultId),
    seed: MANIFEST.seed, seedManifestSha256: vault?.seedManifestSha256 ?? null, manifestSha256: hash(JSON.stringify(MANIFEST)),
    states, runtime, install, repair, registration: finalRegistration, work, events,
    inventoryBeforeRepairSha256: before?.summary.inventorySha256 ?? null, inventoryAfterRepairSha256: after?.summary.inventorySha256 ?? null,
    before: before?.summary ?? null, after: after?.summary ?? null, statePreserved: before !== null && after !== null && JSON.stringify(before.summary) === JSON.stringify(after.summary),
    cleanup, failedStage, humanRequired: ["upgrade-and-explicit-resume", "uninstall", "purge"] };
  options.record("assertion", "installed-lifecycle-six-state-partial", result);
  if (verdict === "partial") options.assertion("lifecycle:installed-six-state-first-install-and-same-version-repair");
  return result;
}
