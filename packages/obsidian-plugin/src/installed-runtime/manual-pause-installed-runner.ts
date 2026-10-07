import { connect } from "node:net";
import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { parseChangeSetSubmitResult, parseChangeSetStatusResult, parseDiscoverResult, parseReadToolResult, parseContinueResult, type ChangeSetSubmitInput } from "@llm-wiki/vault-contracts";
import { EXPECTED_VAULT_ID_HEADER } from "../request-policy.js";
import { parseChangeSetRegistryState, type ChangeSetRegistryState } from "../change-set.js";
import type { StandardDiagnosticBundle } from "../diagnostic-bundle.js";
import { installCandidateBundle } from "./candidate-bundle.js";
import { installedRuntimeAcceptanceDescriptorSchema, type InstalledRuntimeAcceptanceDescriptor } from "./acceptance-driver-protocol.js";
import { provisionTestVault, cleanupTestVault, snapshotInventory, compareInventories, type ProvisionedTestVault, type CleanupReport } from "./test-vault.js";
import { lookupRegisteredRuntimeProfile, preflightRuntimeProfile, type ObservedRuntimeEnvironment } from "./runtime-profile.js";
import { readPersistedBridgeIdentity, waitForCondition, type ObsidianProcessHandle } from "./obsidian-process.js";
import { loadFifoEvents, fifoDigest, fifoReportSchema } from "./installed-fifo-observer.js";
import { type FifoEntryIdentity, type FifoEvent } from "./fifo-observation.js";
import { verifyManualPauseObservations, manualPauseProofSchema, type ManualPauseProof } from "./manual-pause-observation.js";
import { waitForNextInstalledLocalControlReport } from "./local-operator-report.js";
import { HealthObservationError, type ObservedHealth } from "./loopback-client.js";
import type { InstalledFifoOptions } from "./fifo-installed-runner.js";

export type InstalledManualPauseOptions = InstalledFifoOptions & { readonly operatorReportTimeoutMs?: number };
const contentPath = "ManualPauseProof/Content.md";
const content = "# Generated pause content\n" + "Generated acceptance bytes.\n".repeat(12000);
const paths = ["Head", "First", "Second", "Third"].map(name => `ManualPauseProof/${name}.md`);
const portOpen = (port: number): Promise<boolean> => new Promise((resolve, reject) => {
  const socket = connect({ host: "127.0.0.1", port });
  const timer = setTimeout(() => { socket.destroy(); reject(new Error("Manual pause listener probe timed out")); }, 1000);
  socket.once("connect", () => { clearTimeout(timer); socket.destroy(); resolve(true); });
  socket.once("error", (error: NodeJS.ErrnoException) => { clearTimeout(timer); socket.destroy(); if (error.code === "ECONNREFUSED") resolve(false); else reject(error); });
});
interface LiveVault {
  vault: ProvisionedTestVault;
  driver: Awaited<ReturnType<InstalledFifoOptions["prepareAcceptanceDriver"]>>;
  descriptor: InstalledRuntimeAcceptanceDescriptor;
  handle: ObsidianProcessHandle | null;
  stopped: boolean;
  port?: number;
  vaultId?: string;
  endpoint?: URL;
  runtime?: ObservedRuntimeEnvironment;
  reportDirectory?: string;
  reportIdentity?: { dev: number; ino: number };
}
const registrySummary = (registry: ChangeSetRegistryState) => registry.entries.map(entry => ({
  submissionKey: fifoDigest(entry.submissionKey), changeSetId: fifoDigest(entry.changeSetId), enqueueSeq: entry.enqueueSeq,
  state: entry.changeSet.state, executionPhase: entry.execution?.phase ?? null,
}));
const healthSummary = (health: ObservedHealth) => ({ write: health.write, recovery: health.recovery.state,
  effectiveGate: health.effectiveGate?.code ?? null, queue: { ...health.queue,
    currentExecutionId: health.queue.currentExecutionId === null ? null : fifoDigest(health.queue.currentExecutionId),
    headChangeSetId: health.queue.headChangeSetId === null ? null : fifoDigest(health.queue.headChangeSetId) } });

/** Installed A-30 slice. No callback or private command can pause/resume on behalf of the Primary Operator. */
export async function runInstalledManualPauseCorpus(options: InstalledManualPauseOptions): Promise<ManualPauseProof> {
  const registered = lookupRegisteredRuntimeProfile(options.profile.name);
  if (registered === null || JSON.stringify(registered) !== JSON.stringify(options.profile)) throw new Error("Manual pause requires an unchanged registered runtime profile");
  if (options.probe.probeRunning === undefined) throw new Error("Manual pause requires a running-runtime probe");
  const operatorTimeout = options.operatorReportTimeoutMs ?? 180000;
  if (!Number.isSafeInteger(operatorTimeout) || operatorTimeout < 1) throw new Error("Manual pause requires a positive Operator timeout");
  const live: LiveVault[] = [];
  const cleanup: CleanupReport[] = [];
  const contentClients = new Map<LiveVault, Client>();
  let evidence: Omit<ManualPauseProof, "cleanup" | "cleanupSucceeded" | "verdict"> | undefined;
  let succeeded = false;
  const prepare = async (label: "vault-a" | "vault-b") => {
    const vault = await provisionTestVault({ workingDirectory: options.workingDirectory, runId: `${options.runId}-pause-${label}`, configDirectoryName: options.configDirectoryName });
    // Track the root before any fallible preparation so cleanup cannot miss it.
    const item = { vault, handle: null, stopped: true } as LiveVault;
    live.push(item);
    await mkdir(join(vault.vaultPath, "ManualPauseProof"));
    await writeFile(join(vault.vaultPath, contentPath), content, { flag: "wx" });
    await installCandidateBundle(options.candidate, vault.vaultPath, options.configDirectoryName);
    const reportDirectory = join(options.reportDirectory, `manual-pause-${label}`);
    await mkdir(reportDirectory, { recursive: false });
    item.reportDirectory = reportDirectory;
    const reportIdentity = await lstat(reportDirectory);
    if (!reportIdentity.isDirectory() || reportIdentity.isSymbolicLink()) throw new Error("Manual pause report root ownership unconfirmed");
    item.reportIdentity = { dev: reportIdentity.dev, ino: reportIdentity.ino };
    const driver = await options.prepareAcceptanceDriver({ vaultPath: vault.vaultPath, pluginId: options.candidate.identity.pluginId,
      candidateBundleSha256: options.candidate.identity.bundleSha256, configDirectoryName: options.configDirectoryName ?? ".obsidian", reportDirectory });
    item.driver = driver;
    item.descriptor = driver.descriptor;
    const descriptor = item.descriptor;
    if (descriptor.runId !== options.runId || descriptor.vaultPath !== resolve(vault.vaultPath) || descriptor.reportDirectory !== resolve(reportDirectory) ||
        descriptor.candidateBundleSha256 !== options.candidate.identity.bundleSha256 || descriptor.installedMainSha256 !== options.candidate.identity.files.find(f => f.path === "main.js")?.sha256 ||
        descriptor.command.action !== "idle") throw new Error("Manual pause descriptor is not verified-candidate/run bound");
    if ((await readdir(reportDirectory)).length) throw new Error("Manual pause rejects stale local reports");
    return item;
  };
  const start = async (item: LiveVault) => {
    item.stopped = false;
    item.handle = await options.processControl.start({ vaultPath: item.vault.vaultPath, profileDirectory: item.vault.profileDirectory });
    item.runtime = await options.probe.probeRunning({ vaultPath: item.vault.vaultPath, profileDirectory: item.vault.profileDirectory });
    if (preflightRuntimeProfile(options.profile, item.runtime).length) throw new Error("Manual pause running runtime profile mismatch");
    await waitForCondition(async () => {
      const identity = await readPersistedBridgeIdentity(item.vault.vaultPath, options.candidate.identity.pluginId, options.configDirectoryName);
      if (identity === null) return false;
      if (item.vaultId !== undefined && (identity.vaultId !== item.vaultId || identity.port !== item.port)) throw new Error("Manual pause identity changed on restart");
      item.vaultId = identity.vaultId; item.port = identity.port; item.endpoint = new URL(`http://127.0.0.1:${identity.port}/mcp`);
      return true;
    }, { timeoutMs: options.timeouts.startupMs, intervalMs: 25 });
    await waitForCondition(async () => {
      try { return (await options.client.observeHealth(item.endpoint!, item.vaultId!)).health.readiness.searchSnapshot === "ready"; }
      catch (error) { if (error instanceof HealthObservationError && error.code === "health_unreachable") return false; throw error; }
    }, { timeoutMs: options.timeouts.startupMs, intervalMs: 25 });
  };
  const stop = async (item: LiveVault) => {
    if (item.handle === null) { if (!item.stopped) throw new Error("Manual pause shutdown unconfirmed"); return; }
    await item.handle.stop();
    if (item.port !== undefined) await waitForCondition(async () => !await portOpen(item.port!), { timeoutMs: options.timeouts.portClosedMs, intervalMs: 25 });
    item.stopped = true; item.handle = null;
  };
  const registry = async (item: LiveVault) => parseChangeSetRegistryState(JSON.parse(await readFile(join(item.vault.vaultPath, ".llm-wiki/bridge-state.json"), "utf8")).changeSets);
  const health = async (item: LiveVault) => (await options.client.observeHealth(item.endpoint!, item.vaultId!)).health;
  const call = async (item: LiveVault, name: string, arguments_: Record<string, unknown>, parse: (value: unknown) => any, expectedError = false) => {
    const persistent = name === "vault_read" || name === "vault_continue";
    let client = persistent ? contentClients.get(item) : undefined;
    const connected = client !== undefined;
    client ??= new Client({ name: "installed-manual-pause", version: "1.0.0" });
    if (persistent) contentClients.set(item, client);
    try {
      if (!connected) await client.connect(new StreamableHTTPClientTransport(item.endpoint!, { requestInit: { headers: { [EXPECTED_VAULT_ID_HEADER]: item.vaultId! } } }));
      const result = await client.callTool({ name, arguments: arguments_ });
      const value = parse(result.structuredContent);
      if ((result.isError === true) !== expectedError || !Array.isArray(result.content) || result.content.length !== 1 ||
          result.content[0]?.type !== "text" || result.content[0].text !== JSON.stringify(value)) throw new Error("Manual pause wire representation/error mismatch");
      options.record("tool", `manual-pause/${name}`, { vaultIdSha256: fifoDigest(item.vaultId!), resultSha256: fifoDigest(JSON.stringify(value)), isError: expectedError });
      return value;
    } finally { if (!persistent) await client.close().catch(() => {}); }
  };
  const publicInventory = async (item: LiveVault) => (await snapshotInventory(item.vault.vaultPath)).filter(entry => !entry.path.startsWith(".llm-wiki/") && !entry.path.startsWith(`${options.configDirectoryName ?? ".obsidian"}/`));
  const assertOpen = (value: ObservedHealth) => { if (value.write.state !== "writable" || value.write.gate !== "open" || value.write.pauseSource !== null || value.effectiveGate !== null || value.recovery.state !== "none") throw new Error("Manual pause expected independent writable Vault"); };
  const assertPaused = (value: ObservedHealth, entries: FifoEntryIdentity[]) => {
    if (value.write.state !== "paused" || value.write.pauseSource !== "manual" || value.write.gate !== "open" || value.effectiveGate?.code !== "writes_paused" ||
        value.recovery.state !== "none" || value.queue.currentExecutionId !== null || value.queue.length !== entries.length - 1 || value.queue.headChangeSetId !== entries[1]?.changeSetId) throw new Error("Manual pause did not retain the paused live FIFO queue");
  };
  const verifyReport = (bundle: StandardDiagnosticBundle, entries: ReturnType<typeof registrySummary>, value?: ObservedHealth) => {
    const outcomes = bundle.changeSetOutcomes.map(e => ({ enqueueSeq: e.enqueueSeq, state: e.state, executionPhase: e.executionPhase }));
    if (JSON.stringify(outcomes) !== JSON.stringify(entries.map(e => ({ enqueueSeq: e.enqueueSeq, state: e.state, executionPhase: e.executionPhase })))) throw new Error("Manual pause local report contradicts durable registry outcomes");
    if (value && (JSON.stringify(bundle.health.write) !== JSON.stringify(value.write) || bundle.health.recovery !== value.recovery.state || bundle.health.effectiveGate !== (value.effectiveGate?.code ?? null) ||
        bundle.queueTimeline.length !== 1 || bundle.queueTimeline[0]!.length !== value.queue.length || (bundle.queueTimeline[0]!.currentExecutionAlias === null) !== (value.queue.currentExecutionId === null) ||
        (bundle.queueTimeline[0]!.headChangeSetAlias === null) !== (value.queue.headChangeSetId === null))) throw new Error("Manual pause local report contradicts live health/queue");
    const queue = bundle.queueTimeline[0];
    if (queue?.headChangeSetAlias !== null) {
      const head = entries.find(e => e.executionPhase !== "terminal");
      if (!head || bundle.changeSetOutcomes.find(e => e.enqueueSeq === head.enqueueSeq)?.changeSetAlias !== queue?.headChangeSetAlias) throw new Error("Manual pause local report contradicts FIFO head alias");
    }
  };
  try {
    await mkdir(options.reportDirectory, { recursive: true });
    const a = await prepare("vault-a");
    const b = await prepare("vault-b");
    await start(a); await start(b);
    if (a.vaultId === b.vaultId || a.port === b.port) throw new Error("Manual pause Vault identities are not independent");
    assertOpen(await health(a)); assertOpen(await health(b));
    await stop(a);
    const keys = ["head", "first", "second", "third"].map(name => `${options.runId}-pause-${name}`) as [string, string, string, string];
    a.descriptor = installedRuntimeAcceptanceDescriptorSchema.parse({ ...a.descriptor, command: { action: "observe-persistent-fifo", sequence: 1,
      capabilityToken: a.descriptor.capabilityToken, expectedVaultId: a.vaultId, endpoint: a.endpoint!.toString(), keys, holdUntil: "observed-manual-pausing" } });
    const next = `${a.driver.path}.pause.next`;
    await writeFile(next, JSON.stringify(a.descriptor), { flag: "wx", mode: 0o600 }); await rename(next, a.driver.path);
    await start(a);
    const beforeA = await publicInventory(a); const beforeB = await publicInventory(b);
    const beforeRegistryB = await registry(b);
    const inputs: ChangeSetSubmitInput[] = keys.map((key, index) => ({ submissionKey: key, operations: [{ operationId: `pause-${index}`, kind: "create_note", ifExists: "reject", path: paths[index]!, content: `# Pause ${index}\n` }] }));
    const pending: Promise<unknown>[] = [];
    const entries: FifoEntryIdentity[] = [];
    const events = () => loadFifoEvents(a.descriptor);
    for (const [index, input] of inputs.entries()) {
      pending.push(call(a, "vault_change_set_submit", input, parseChangeSetSubmitResult).catch(() => undefined));
      await waitForCondition(async () => (await registry(a)).entries.some(e => e.submissionKey === input.submissionKey), { timeoutMs: options.timeouts.startupMs, intervalMs: 25 });
      const entry = (await registry(a)).entries.find(e => e.submissionKey === input.submissionKey)!;
      entries.push({ submissionKey: entry.submissionKey, changeSetId: entry.changeSetId, enqueueSeq: entry.enqueueSeq });
      await waitForCondition(async () => { try { return (await events()).some(e => e.kind === "enqueued" && e.submissionKey === input.submissionKey); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; } }, { timeoutMs: options.timeouts.startupMs, intervalMs: 25 });
      if (index === 0) await waitForCondition(async () => { try {
        const marker = fifoReportSchema.parse(JSON.parse(await readFile(join(a.descriptor.reportDirectory, "persistent-fifo-parked.json"), "utf8")));
        return marker.event.kind === "committed" && (await events()).some(e => e.kind === "committed" && e.submissionKey === keys[0]);
      } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; } }, { timeoutMs: options.timeouts.startupMs, intervalMs: 25 });
    }
    const parkedRegistry = registrySummary(await registry(a));
    if (parkedRegistry.length !== 4 || parkedRegistry.some((entry, index) => entry.state !== "in_progress" || entry.executionPhase !== (index === 0 ? "executing" : "queued"))) throw new Error("Manual pause fixture did not retain a durable in-flight FIFO");
    options.record("transport", "manual-pause/pause-local-control-report-required", { vaultIdSha256: fifoDigest(a.vaultId!), action: "pause-writes" });
    let pausing!: ObservedHealth;
    await waitForCondition(async () => {
      const value = await health(a);
      if (value.write.state === "writable") return false;
      if (value.write.state !== "pausing" || value.write.pauseSource !== "manual" || value.effectiveGate?.code !== "writes_paused" ||
          value.queue.currentExecutionId !== entries[0]!.changeSetId || value.queue.length !== 4 || value.queue.headChangeSetId !== entries[0]!.changeSetId) throw new Error("Manual pause missed real in-flight pausing");
      pausing = value; return true;
    }, { timeoutMs: operatorTimeout, intervalMs: 25 }).catch(error => { throw new Error("Manual pause requires live Primary Operator pausing before the deadline", { cause: error }); });
    const pausingEventCount = (await events()).length;
    if (pausingEventCount !== 8 || (await events()).filter(e => e.kind === "started").length !== 1) throw new Error("Manual pause next queued item started while draining");
    // This is ONLY release of a generated fixture hold after real pausing.
    await writeFile(join(a.descriptor.reportDirectory, "persistent-fifo-release.json"), JSON.stringify({ schemaVersion: 1, runId: options.runId,
      candidateBundleSha256: a.descriptor.candidateBundleSha256, installedMainSha256: a.descriptor.installedMainSha256, capabilityToken: a.descriptor.capabilityToken,
      vaultId: a.vaultId, endpoint: a.endpoint!.toString(), headChangeSetId: entries[0]!.changeSetId, pausingObserved: true }), { flag: "wx", mode: 0o600 });
    const pause = await waitForNextInstalledLocalControlReport({ descriptor: a.descriptor, vaultId: a.vaultId!, endpoint: a.endpoint!, configDirectoryName: options.configDirectoryName,
      action: "pause-writes", consumedInvocationIds: [], timeoutMs: operatorTimeout });
    if (pause.action !== "pause-writes" || pause.outcome !== "accepted") throw new Error("Manual pause requires an accepted local Primary Operator pause");
    const paused = await health(a); assertPaused(paused, entries);
    const pausedRegistry = registrySummary(await registry(a));
    verifyReport(pause.before, parkedRegistry); verifyReport(pause.after, pausedRegistry, paused);
    if (pause.before.health.write.state !== "writable" || pause.before.queueTimeline[0]?.currentExecutionAlias === null) throw new Error("Manual pause report is stale, not an in-flight pause");
    const pausedEvents = await events(); const pausedEventCount = pausedEvents.length;
    const pausedInventory = await publicInventory(a);
    for (const [index, entry] of entries.entries()) {
      const status = await call(a, "vault_change_set_status", { submissionKey: entry.submissionKey }, parseChangeSetStatusResult);
      if (status.lookup !== "found" || status.changeSet.changeSetId !== entry.changeSetId || status.changeSet.state !== (index === 0 ? "intent_applied" : "in_progress")) throw new Error("Manual pause status disagrees with retained terminal/queue");
    }
    const unbound = `${options.runId}-pause-unbound`;
    const blocked = await call(a, "vault_change_set_submit", { ...inputs[0], submissionKey: unbound }, parseChangeSetSubmitResult, true);
    const absent = await call(a, "vault_change_set_status", { submissionKey: unbound }, parseChangeSetStatusResult);
    if (blocked.outcome !== "operationally_blocked" || blocked.gate.code !== "writes_paused" || absent.lookup !== "unknown" ||
        (await registry(a)).entries.some(e => e.submissionKey === unbound)) throw new Error("Manual pause bound a new unbound Submission Key");
    const discovered = await call(a, "vault_discover", { query: { path: { prefix: "ManualPauseProof/" } }, projection: { matches: false }, order: { by: "path", direction: "asc" }, page: { maxItems: 1000, continuation: null } }, parseDiscoverResult);
    if (discovered.outcome !== "results" || !discovered.complete || !discovered.items.some((item: any) => item.path === contentPath)) throw new Error("Manual pause discovery unavailable");
    const read = await call(a, "vault_read", { items: [{ kind: "exact", path: contentPath }] }, parseReadToolResult);
    if (read.outcome !== "page" || read.continuation === null) throw new Error("Manual pause did not produce a real continuation");
    const pages = [read]; let continuation = read.continuation;
    while (continuation !== null) {
      const page = await call(a, "vault_continue", { continuation }, parseContinueResult);
      if (page.outcome !== "page") throw new Error("Manual pause continuation unavailable");
      pages.push(page); continuation = page.continuation;
    }
    let combined = ""; let expectedStart = 0;
    for (const page of pages) for (const item of page.items) {
      if (!("content" in item) || !("start" in item) || item.path !== contentPath || item.start !== expectedStart ||
          item.contentVersion !== `sha256:${fifoDigest(content)}` || item.end - item.start !== Buffer.byteLength(item.content)) throw new Error("Manual pause Exact Read page evidence mismatch");
      combined += item.content; expectedStart = item.end;
    }
    if (combined !== content || expectedStart !== Buffer.byteLength(content)) throw new Error("Manual pause Exact Read content mismatch");
    assertOpen(await health(b));
    if (JSON.stringify(await registry(b)) !== JSON.stringify(beforeRegistryB) || JSON.stringify(await publicInventory(b)) !== JSON.stringify(beforeB)) throw new Error("Manual pause altered Vault B queue or bytes");
    const bInput: ChangeSetSubmitInput = { submissionKey: `${options.runId}-pause-b-progress`, operations: [{ operationId: "b-progress", kind: "create_note", ifExists: "reject", path: "ManualPauseProof/Independent.md", content: "# Independent\n" }] };
    const progress = await call(b, "vault_change_set_submit", bInput, parseChangeSetSubmitResult);
    if (progress.outcome !== "registered" || progress.changeSet.state !== "intent_applied") throw new Error("Manual pause blocked independent Vault B progress");
    const bStatus = await call(b, "vault_change_set_status", { submissionKey: bInput.submissionKey }, parseChangeSetStatusResult);
    if (bStatus.lookup !== "found" || bStatus.changeSet.changeSetId !== progress.changeSet.changeSetId || await readFile(join(b.vault.vaultPath, "ManualPauseProof/Independent.md"), "utf8") !== "# Independent\n") throw new Error("Manual pause Vault B progress not independently proven");
    assertOpen(await health(b));
    const afterBProgress = await publicInventory(b); const registryBProgress = await registry(b);
    assertPaused(await health(a), entries);
    if (JSON.stringify(registrySummary(await registry(a))) !== JSON.stringify(pausedRegistry) || JSON.stringify(await publicInventory(a)) !== JSON.stringify(pausedInventory) || JSON.stringify(await events()) !== JSON.stringify(pausedEvents)) throw new Error("Manual pause automatically resumed or lost queued work");
    const controlFiles = (await readdir(a.descriptor.reportDirectory)).filter(name => name.startsWith("local-write-control-"));
    if (controlFiles.length !== 1) throw new Error("Manual pause resume was not independently requested after retained observation");
    const resumeEventCount = (await events()).length;
    options.record("transport", "manual-pause/resume-local-control-report-required", { vaultIdSha256: fifoDigest(a.vaultId!), action: "resume-writes" });
    const resume = await waitForNextInstalledLocalControlReport({ descriptor: a.descriptor, vaultId: a.vaultId!, endpoint: a.endpoint!, configDirectoryName: options.configDirectoryName,
      action: "resume-writes", consumedInvocationIds: [pause.invocationId], timeoutMs: operatorTimeout });
    if (resume.action !== "resume-writes" || resume.outcome !== "accepted" || resume.invocationId === pause.invocationId || resume.before.health.write.state !== "paused" || resume.before.health.write.pauseSource !== "manual") throw new Error("Manual pause requires a fresh independent local resume");
    const resumed = await health(a); assertOpen(resumed);
    if (resumed.queue.length !== 0 || resumed.queue.currentExecutionId !== null) throw new Error("Manual pause resume did not finish retained work");
    const finalRegistry = registrySummary(await registry(a));
    verifyReport(resume.before, pausedRegistry, paused); verifyReport(resume.after, finalRegistry, resumed);
    const finalEvents = await events();
    verifyManualPauseObservations({ events: finalEvents, expected: entries, pausingEventCount, pausedEventCount, resumeEventCount });
    for (const [index, entry] of entries.entries()) {
      const status = await call(a, "vault_change_set_status", { submissionKey: entry.submissionKey }, parseChangeSetStatusResult);
      if (status.lookup !== "found" || status.changeSet.changeSetId !== entry.changeSetId || status.changeSet.state !== "intent_applied" ||
          await readFile(join(a.vault.vaultPath, paths[index]!), "utf8") !== `# Pause ${index}\n`) throw new Error("Manual pause resumed status/bytes contradict FIFO terminal");
    }
    await Promise.all(pending);
    assertOpen(await health(b));
    if (JSON.stringify(await registry(b)) !== JSON.stringify(registryBProgress) || JSON.stringify(await publicInventory(b)) !== JSON.stringify(afterBProgress)) throw new Error("Manual pause resume affected independent Vault B");
    const afterA = await publicInventory(a); const afterB = await publicInventory(b);
    const summarizeInventory = (before: Awaited<ReturnType<typeof publicInventory>>, after: typeof before) => {
      const comparison = compareInventories(before, after);
      return { before, after, ...comparison, addedPaths: [...comparison.addedPaths], removedPaths: [...comparison.removedPaths], changedPaths: [...comparison.changedPaths] };
    };
    evidence = { scope: "manual-pause-drain-and-fifo", source: "installed-obsidian", runId: options.runId, profile: options.profile.name,
      candidateBundleSha256: a.descriptor.candidateBundleSha256, installedMainSha256: a.descriptor.installedMainSha256,
      canonicalManifestSha256: fifoDigest(JSON.stringify({ scenario: "manual-pause-drain-and-fifo-v1", paths, contentSha256: fifoDigest(content), operations: inputs.map(input => input.operations) })),
      vaults: [a, b].map((item, index) => ({ label: index === 0 ? "vault-a" : "vault-b", vaultIdSha256: fifoDigest(item.vaultId!), seed: item.vault.seedManifestSha256,
        runtime: { platform: item.runtime!.platform, osBuild: item.runtime!.osBuild!, obsidianVersion: item.runtime!.obsidianVersion!,
          electronVersion: item.runtime!.electronVersion!, nodeVersion: item.runtime!.nodeVersion!, capabilities: [...item.runtime!.capabilities] },
        inventory: summarizeInventory(index === 0 ? beforeA : beforeB, index === 0 ? afterA : afterB), registry: index === 0 ? finalRegistry : registrySummary(registryBProgress) })),
      enqueue: entries.map(entry => ({ ...entry, submissionKey: fifoDigest(entry.submissionKey), changeSetId: fifoDigest(entry.changeSetId) })),
      events: finalEvents.map(event => "submissionKey" in event ? { ...event, submissionKey: fifoDigest(event.submissionKey), changeSetId: fifoDigest(event.changeSetId) } : event),
      pausingEventCount, pausedEventCount, resumeEventCount, health: { pausing: healthSummary(pausing), paused: healthSummary(paused), resumed: healthSummary(resumed) },
      localActions: [{ action: pause.action, invocationIdSha256: fifoDigest(pause.invocationId), beforeSha256: fifoDigest(JSON.stringify(pause.before)), afterSha256: fifoDigest(JSON.stringify(pause.after)) },
        { action: resume.action, invocationIdSha256: fifoDigest(resume.invocationId), beforeSha256: fifoDigest(JSON.stringify(resume.before)), afterSha256: fifoDigest(JSON.stringify(resume.after)) }],
      unboundKeySha256: fifoDigest(unbound), contentSha256: fifoDigest(content), independentProgressChangeSetIdSha256: fifoDigest(progress.changeSet.changeSetId) };
    succeeded = true;
  } finally {
    for (const client of contentClients.values()) await client.close().catch(() => {});
    let cleanupFailure: unknown;
    for (const item of live.toReversed()) {
      let report: CleanupReport = { attempted: true, residualPaths: ["cleanup_unconfirmed"] };
      try {
        await stop(item);
        await item.driver?.cleanup();
        if (item.reportDirectory !== undefined) {
          const current = await lstat(item.reportDirectory);
          if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== item.reportIdentity?.dev || current.ino !== item.reportIdentity.ino) {
            throw new Error("Manual pause report root ownership unconfirmed");
          }
          await rm(item.reportDirectory, { recursive: true });
          const remaining = await lstat(item.reportDirectory).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; });
          if (remaining !== null) throw new Error("Manual pause report cleanup unconfirmed");
        }
        report = await cleanupTestVault(item.vault);
        if (!report.attempted || report.residualPaths.length) throw new Error("Manual pause generated Vault cleanup unconfirmed");
      } catch (error) {
        cleanupFailure ??= error;
        options.record("cleanup", "manual-pause-cleanup-failed", { shutdownConfirmed: item.stopped });
      }
      cleanup.unshift(report);
    }
    options.record("cleanup", "manual-pause-cleanup", { vaults: cleanup });
    if (cleanupFailure !== undefined) throw cleanupFailure;
  }
  if (!succeeded) throw new Error("Manual pause scene incomplete");
  const proof = manualPauseProofSchema.parse({ ...evidence, cleanup, cleanupSucceeded: true, verdict: "passed" });
  options.record("assertion", "manual-pause-observed", proof);
  options.assertion("manual-pause/drain-and-fifo-retention:installed-observed");
  return proof;
}
