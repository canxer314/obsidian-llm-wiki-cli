import { createHash } from "node:crypto";
import { connect } from "node:net";
import { mkdir, open, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { parseChangeSetStatusResult, parseChangeSetSubmitResult, parseChangeSetSubmitInput, serializeChangeSetStatusCompatibilityText, serializeChangeSetSubmitCompatibilityText } from "@llm-wiki/vault-contracts";
import { EXPECTED_VAULT_ID_HEADER } from "../request-policy.js";
import { openRecoveryJournal } from "../recovery-journal.js";
import { preflightRuntimeProfile, type ObservedRuntimeEnvironment, type RegisteredRuntimeProfile, type RuntimeEnvironmentProbe } from "./runtime-profile.js";
import { ObsidianProcessError, waitForCondition, readPersistedBridgeIdentity, type ObsidianProcessControl, type ObsidianProcessHandle, type PersistedBridgeIdentity } from "./obsidian-process.js";
import { type VerifiedCandidateBundle, installCandidateBundle } from "./candidate-bundle.js";
import { provisionTestVault, cleanupTestVault } from "./test-vault.js";
import { HealthObservationError, type LoopbackMcpClient } from "./loopback-client.js";
import { crashBoundaryPhase, crashPrivateResidue, crashDigest, crashInventory, crashProfile, loadCrashBoundaryReport, requestInstalledCrashRestorationScenario, verifyCrashInventory, verifyCrashPublicProof, type CrashInventoryEntry, type InstalledCrashKind, type InstalledCrashPoint } from "./crash-restoration-protocol.js";
import type { InstalledRuntimeAcceptanceDescriptor } from "./acceptance-driver-protocol.js";

export type CrashAttachmentPathState = { readonly kind: "absent" } | { readonly kind: "attachment"; readonly sizeBytes: number; readonly sha256: string };
export interface InstalledCrashRestorationSliceRecord {
  readonly source: "installed-obsidian";
  readonly mutationKind: InstalledCrashKind;
  readonly runId: string;
  readonly vaultId: string;
  readonly candidateBundleSha256: string;
  readonly installedMainSha256: string;
  readonly runtimeProfile: string;
  readonly seed: string;
  readonly manifestSha256: string;
  readonly crashPoint: InstalledCrashPoint;
  readonly processStoppedBeforeRestart: true;
  readonly processGenerations: readonly { readonly generation: number; readonly pid: number | null; readonly runtime: ObservedRuntimeEnvironment; readonly stopped: true; readonly listenerClosed: true }[];
  readonly preparedJournalPhase: "PREPARED" | "COMMITTED" | "ROLLED_BACK" | null;
  readonly journalPhase: "ROLLED_BACK" | "COMMITTED";
  readonly proofState: "intent_not_applied" | "intent_applied";
  readonly before: readonly CrashInventoryEntry[];
  readonly boundary: readonly CrashInventoryEntry[];
  readonly after: readonly CrashInventoryEntry[];
  readonly attachmentPaths?: readonly { readonly path: string; readonly before: CrashAttachmentPathState; readonly boundary: CrashAttachmentPathState; readonly after: CrashAttachmentPathState }[];
  readonly privateFootprint?: { readonly before: { readonly stagingFiles: 0; readonly trashFiles: 0 }; readonly boundary: { readonly stagingFiles: 0; readonly trashFiles: 0 }; readonly after: { readonly stagingFiles: 0; readonly trashFiles: 0 } };
  readonly markerSha256: string;
  readonly durableFrameSha256: string | null;
  readonly terminalProofSha256: string;
  readonly eventOrder: readonly string[];
  readonly wholeStateVerified: true;
  readonly sentinelAppliedAfterRestore: true;
  readonly originalFileAbsentAfterRecovery: boolean;
  readonly committedFileBytesPreservedAfterRecovery?: true;
  readonly originalFileBytesPreservedAfterRecovery?: true;
  readonly healthRecoveryState: "none";
  readonly cleanupSucceeded: true;
  readonly verdict: "passed";
}
export interface InstalledCrashRestorationSliceOutcome {
  readonly scope: "single-after-prepared-installed-rollback-slice" | "single-after-committed-installed-replay-slice" | "single-installed-crash-boundary-slice";
  readonly records: readonly [InstalledCrashRestorationSliceRecord];
  readonly verdict: "passed";
}
export type InstalledCrashRestorationSliceRunner = (options: InstalledCrashRestorationSliceOptions) => Promise<InstalledCrashRestorationSliceOutcome>;
export interface InstalledCrashRestorationSliceOptions {
  readonly crashPoint?: InstalledCrashPoint;
  readonly mutationKind?: InstalledCrashKind;
  readonly boundaryTimeoutMs?: number;
  readonly runId: string;
  readonly workingDirectory: string;
  readonly reportDirectory: string;
  readonly candidate: VerifiedCandidateBundle;
  readonly processControl: ObsidianProcessControl;
  readonly client: LoopbackMcpClient;
  readonly configDirectoryName?: string;
  readonly timeouts: { readonly startupMs: number; readonly stopMs: number; readonly portClosedMs: number };
  readonly profile: RegisteredRuntimeProfile;
  readonly probe: RuntimeEnvironmentProbe & { probeRunning(request: { readonly vaultPath: string; readonly profileDirectory: string }): Promise<ObservedRuntimeEnvironment> };
  readonly prepareAcceptanceDriver: (options: { readonly vaultPath: string; readonly pluginId: string; readonly candidateBundleSha256: string; readonly configDirectoryName: string }) => Promise<{ readonly path: string; readonly descriptor: InstalledRuntimeAcceptanceDescriptor; cleanup(): Promise<void> }>;
  readonly record: (kind: "transport" | "tool" | "assertion" | "cleanup", name: string, detail: unknown) => void;
  readonly assertion: (name: string) => void;
}
const POLL_MS = 25;
const MAX_SLICE_MS = 120_000;

async function loopbackCall<T>(options: { endpoint: URL; vaultId: string; name: string; args: Record<string, unknown>; parse(value: unknown): T; serialize(value: T): string; expectedError?: boolean }): Promise<T> {
  const client = new Client({ name: "installed-crash-restoration-slice", version: "1.0.0" });
  try {
    await client.connect(new StreamableHTTPClientTransport(options.endpoint, { requestInit: { headers: { [EXPECTED_VAULT_ID_HEADER]: options.vaultId } } }));
    const result = await client.callTool({ name: options.name, arguments: options.args });
    if ((result.isError === true) !== (options.expectedError === true) || result.structuredContent === undefined) throw new Error("Installed crash wire call failed");
    const parsed = options.parse(result.structuredContent);
    if (!Array.isArray(result.content) || result.content.length !== 1 || result.content[0]?.type !== "text" || result.content[0].text !== options.serialize(parsed)) throw new Error("Installed crash wire compatibility text diverged");
    return parsed;
  } finally { await client.close().catch(() => undefined); }
}
async function waitForIdentity(check: () => Promise<PersistedBridgeIdentity | null>, timeoutMs: number): Promise<PersistedBridgeIdentity> {
  let identity: PersistedBridgeIdentity | null = null;
  await waitForCondition(async () => { identity = await check(); return identity !== null; }, { timeoutMs, intervalMs: POLL_MS });
  if (identity === null) throw new Error("Installed crash Bridge identity unavailable");
  return identity;
}

/** One generated Vault per fixed scenario; no Node fallback or local recovery authorization. */
export async function runInstalledCrashRestorationSlice(options: InstalledCrashRestorationSliceOptions): Promise<InstalledCrashRestorationSliceOutcome> {
  const crashPoint = options.crashPoint ?? "after_prepared";
  const mutationKind = options.mutationKind ?? "create_note";
  const profile = crashProfile(mutationKind);
  const rollback = crashPoint.includes("rollback") || crashPoint.includes("rolled_back");
  const committed = crashPoint === "after_committed" || crashPoint === "before_prepared";
  const terminalPhase = committed ? "COMMITTED" : "ROLLED_BACK";
  const terminalState = committed ? "intent_applied" : "intent_not_applied";
  const label = `${mutationKind}-${crashPoint.replace(/[^A-Za-z0-9-]/gu, "-")}`;
  const configDirectoryName = options.configDirectoryName ?? ".obsidian";
  const vault = await provisionTestVault({ workingDirectory: options.workingDirectory, runId: `${options.runId}-crash-${label}`, configDirectoryName });
  let processHandle: ObsidianProcessHandle | null = null;
  let identity: PersistedBridgeIdentity | null = null;
  let acceptanceCleanup: (() => Promise<void>) | undefined;
  let shutdownUnconfirmed = false;
  let failure: unknown;
  let proof: Omit<InstalledCrashRestorationSliceRecord, "cleanupSucceeded" | "verdict"> | undefined;
  const eventOrder: string[] = [];
  const generations: Array<{ generation: number; pid: number | null; runtime: ObservedRuntimeEnvironment; stopped: true; listenerClosed: true }> = [];
  let running: { generation: number; pid: number | null; runtime: ObservedRuntimeEnvironment } | null = null;
  const stop = async (): Promise<void> => {
    if (processHandle === null) return;
    await processHandle.stop();
    identity ??= await readPersistedBridgeIdentity(vault.vaultPath, options.candidate.identity.pluginId, configDirectoryName);
    await waitForCondition(async () => identity === null || !await isPortOpen(identity.port), { timeoutMs: options.timeouts.portClosedMs, intervalMs: POLL_MS });
    processHandle = null;
    if (running !== null) generations.push({ ...running, stopped: true, listenerClosed: true });
    running = null;
    eventOrder.push("supervisor-process-exited-and-listener-closed");
  };
  try {
    for (const fixture of profile.files) {
      if (fixture.originalBytes === null) continue;
      const path = join(vault.vaultPath, fixture.path);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, fixture.originalBytes, { flag: "wx" });
    }
    const before = await crashInventory(vault.vaultPath, configDirectoryName);
    const privateBefore = await crashPrivateResidue(vault.vaultPath);
    await installCandidateBundle(options.candidate, vault.vaultPath, configDirectoryName);
    const driver = await options.prepareAcceptanceDriver({ vaultPath: vault.vaultPath, pluginId: options.candidate.identity.pluginId, candidateBundleSha256: options.candidate.identity.bundleSha256, configDirectoryName });
    acceptanceCleanup = driver.cleanup;
    const installed = driver.descriptor;
    if (installed.reportDirectory !== resolve(options.reportDirectory) || installed.runId !== options.runId || installed.vaultPath !== resolve(vault.vaultPath) || installed.pluginId !== options.candidate.identity.pluginId || installed.installedMainSha256 !== options.candidate.identity.files.find(file => file.path === "main.js")?.sha256 || installed.candidateBundleSha256 !== options.candidate.identity.bundleSha256) throw new Error("Crash slice acceptance descriptor is not candidate/run bound");
    const start = async (): Promise<void> => {
      processHandle = await options.processControl.start({ vaultPath: vault.vaultPath, profileDirectory: vault.profileDirectory });
      const observed = await options.probe.probeRunning({ vaultPath: vault.vaultPath, profileDirectory: vault.profileDirectory });
      if (preflightRuntimeProfile(options.profile, observed).length > 0) throw new Error("Installed crash runtime does not match the registered profile");
      running = { generation: generations.length + 1, pid: processHandle.pid ?? null, runtime: observed };
      eventOrder.push("same-vault-process-started-profile-observed");
      options.record("transport", "crash-runtime-profile-observed", { profile: options.profile.name, generation: running.generation, observed });
    };
    await start();
    identity = await waitForIdentity(() => readPersistedBridgeIdentity(vault.vaultPath, options.candidate.identity.pluginId, configDirectoryName), options.timeouts.startupMs);
    const endpoint = new URL(`http://127.0.0.1:${identity.port}/mcp`);
    const ready = async (): Promise<void> => {
      await waitForCondition(async () => {
        try { const health = await options.client.observeHealth(endpoint, identity!.vaultId); return health.health.readiness.searchSnapshot === "ready" && health.health.recovery.state === "none"; }
        catch (error) { if (error instanceof HealthObservationError && error.code === "health_unreachable") return false; throw error; }
      }, { timeoutMs: options.timeouts.startupMs, intervalMs: POLL_MS });
      const current = await readPersistedBridgeIdentity(vault.vaultPath, options.candidate.identity.pluginId, configDirectoryName);
      if (current?.vaultId !== identity!.vaultId || current.port !== identity!.port) throw new Error("Installed crash restart identity changed");
    };
    await ready();
    const seed = `${options.runId}-${label}`;
    const input = parseChangeSetSubmitInput(profile.buildSubmitInput(seed));
    const status = () => loopbackCall({ endpoint, vaultId: identity!.vaultId, name: "vault_change_set_status", args: { submissionKey: input.submissionKey }, parse: parseChangeSetStatusResult, serialize: serializeChangeSetStatusCompatibilityText });
    const submit = (args: Record<string, unknown>, expectedError = false) => loopbackCall({ endpoint, vaultId: identity!.vaultId, name: "vault_change_set_submit", args, parse: parseChangeSetSubmitResult, serialize: serializeChangeSetSubmitCompatibilityText, expectedError });
    const journalPath = join(vault.vaultPath, ".llm-wiki", "recovery-journal.bin");
    const observeBoundary = async (point: InstalledCrashPoint, sequence: number) => {
      let marker: Awaited<ReturnType<typeof loadCrashBoundaryReport>> | undefined;
      await waitForCondition(async () => {
        try { marker = await loadCrashBoundaryReport({ reportDirectory: options.reportDirectory, runId: options.runId, vaultId: identity!.vaultId, candidateBundleSha256: installed.candidateBundleSha256, installedMainSha256: installed.installedMainSha256, capabilityToken: installed.capabilityToken, endpoint: endpoint.toString(), submissionKey: input.submissionKey, crashPoint: point, mutationKind, sequence }); return true; }
        catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
      }, { timeoutMs: options.boundaryTimeoutMs ?? MAX_SLICE_MS, intervalMs: POLL_MS });
      const frame = await readInstalledCrashJournalOrNull(journalPath);
      const inventory = await crashInventory(vault.vaultPath, configDirectoryName);
      const privateFootprint = mutationKind === "copy_attachment" || mutationKind === "move_attachment" ? await crashPrivateResidue(vault.vaultPath) : undefined;
      const phase = crashBoundaryPhase(point);
      const original = point === "before_prepared" || point === "after_prepared" || point.startsWith("after_mutation:") || point.startsWith("after_rollback") || point === "before_rolled_back" || point === "after_rolled_back";
      verifyCrashInventory(before, inventory, mutationKind, original ? "original" : "committed", point);
      if (marker === undefined || marker.journalPhase !== phase || frame?.phase !== phase && !(phase === null && frame === null) || marker.frameSha256 !== (frame === null ? null : crashDigest(frame.payload)) || marker.inventorySha256 !== crashDigest(inventory)) throw new Error("Installed crash marker phase/frame/whole-state bytes diverged");
      if (frame !== null) {
        const payload = frame.payload as { vaultId?: string; input?: unknown; changeSetId?: string };
        if (payload.vaultId !== identity!.vaultId || JSON.stringify(payload.input) !== JSON.stringify(input)) throw new Error("Installed crash did not observe its bound durable frame");
      }
      eventOrder.push(`bound-marker-durable-phase-and-whole-bytes:${point}`);
      return { marker, frame, inventory, privateFootprint };
    };
    const initialPoint = rollback ? "after_snapshot" : crashPoint;
    const sequence = await requestInstalledCrashRestorationScenario({ descriptorPath: driver.path, descriptor: installed, expectedVaultId: identity.vaultId, endpoint, input, crashPoint: initialPoint, mutationKind });
    let boundary = await observeBoundary(initialPoint, sequence);
    const preCrash = await status();
    const preHealth = await options.client.observeHealth(endpoint, identity.vaultId);
    if (preCrash.lookup !== "found" || preCrash.changeSet.state !== "in_progress" || preHealth.health.recovery.state !== "none") throw new Error("Installed Change Set did not remain in progress at crash boundary");
    const beforeRecord = preCrash.changeSet;
    if (boundary.frame !== null && (boundary.frame.payload as { changeSetId?: string }).changeSetId !== beforeRecord.changeSetId) throw new Error("Installed crash durable frame has a foreign Change Set");
    await stop();
    if (rollback) {
      if (boundary.frame?.phase !== "PREPARED") throw new Error("Installed rollback lead-in is not PREPARED");
      const recoverySequence = await requestInstalledCrashRestorationScenario({ descriptorPath: driver.path, descriptor: installed, expectedVaultId: identity.vaultId, endpoint, input, crashPoint, mutationKind, recovery: { changeSetId: beforeRecord.changeSetId, frameSha256: crashDigest(boundary.frame.payload) } });
      await start();
      boundary = await observeBoundary(crashPoint, recoverySequence);
      // Recovery is parked before Bridge.start may bind: new writes must not reach it.
      if (await isPortOpen(identity.port)) throw new Error("Installed recovery accepted a listener before whole-state restore");
      eventOrder.push("recovery-park-listener-remained-closed");
      await stop();
      // Remove the one-shot park, not the Journal; generation 3 must safely re-enter recovery.
      await requestInstalledCrashRestorationScenario({ descriptorPath: driver.path, descriptor: installed, expectedVaultId: identity.vaultId, endpoint, input, crashPoint: "after_prepared", mutationKind });
    }
    await start();
    await ready();
    eventOrder.push("whole-recovery-completed-before-write-admission");
    const terminalHealth = await options.client.observeHealth(endpoint, identity.vaultId);
    if (terminalHealth.health.recovery.state !== "none" || terminalHealth.health.write.gate !== "open" || terminalHealth.health.write.state !== "writable") throw new Error("Installed recovery requires local authority before any new write");
    let recovered = await status();
    if (crashPoint === "before_prepared") {
      // No durable intent exists. The retained queued intent may execute on restart;
      // unlike PREPARED it is not a rollback case and cannot claim a restored Journal.
      await waitForCondition(async () => { recovered = await status(); return recovered.lookup === "found" && recovered.changeSet.state !== "in_progress"; }, { timeoutMs: options.timeouts.startupMs, intervalMs: POLL_MS });
    }
    const after = await crashInventory(vault.vaultPath, configDirectoryName);
    const privateAfter = await crashPrivateResidue(vault.vaultPath);
    verifyCrashInventory(before, after, mutationKind, committed ? "committed" : "original");
    if (recovered.lookup !== "found") throw new Error("Installed recovered status missing");
    verifyCrashPublicProof(recovered.changeSet, beforeRecord, mutationKind, terminalState, input);
    const recoveredFrame = await readInstalledCrashJournal(journalPath);
    const payload = recoveredFrame.payload as { vaultId?: string; changeSetId?: string; input?: unknown };
    if (recoveredFrame.phase !== terminalPhase || payload.vaultId !== identity.vaultId || payload.changeSetId !== beforeRecord.changeSetId || JSON.stringify(payload.input) !== JSON.stringify(input)) throw new Error("Installed restart did not recover the bound durable terminal intent");
    const replay = await submit(input, !committed);
    if (replay.outcome !== "registered" || JSON.stringify(replay.changeSet) !== JSON.stringify(recovered.changeSet)) throw new Error("Recovered Bridge did not replay the retained terminal record");
    verifyCrashInventory(before, await crashInventory(vault.vaultPath, configDirectoryName), mutationKind, committed ? "committed" : "original");
    if (JSON.stringify(await readInstalledCrashJournal(journalPath)) !== JSON.stringify(recoveredFrame)) throw new Error("Installed crash replay changed the durable terminal frame");
    eventOrder.push("complete-public-proof-status-and-identical-replay-observed");
    const sentinelPath = "Notes/CrashSentinel.md";
    const sentinel = await submit({ submissionKey: `sentinel-${seed}`, operations: [{ operationId: "post-restore-sentinel", kind: "create_note", path: sentinelPath, content: "# Restore completed\n", ifExists: "reject" }] });
    if (sentinel.outcome !== "registered" || sentinel.changeSet.state !== "intent_applied" || !(await readFile(join(vault.vaultPath, sentinelPath))).equals(Buffer.from("# Restore completed\n"))) throw new Error("Installed recovery did not complete before new write");
    eventOrder.push("sentinel-new-write-applied-after-whole-restore");
    const terminalDigest = crashDigest(recovered.changeSet);
    const attachmentState = (inventory: readonly CrashInventoryEntry[], path: string): CrashAttachmentPathState => {
      const entry = inventory.find(entry => entry.path === path);
      if (entry === undefined) return { kind: "absent" };
      if (entry.kind !== "file" || entry.bytes === undefined || entry.sha256 === undefined || !/^[a-f0-9]{64}$/u.test(entry.sha256)) throw new Error("Installed attachment report has invalid byte evidence");
      return { kind: "attachment", sizeBytes: entry.bytes, sha256: entry.sha256 };
    };
    const attachmentPaths = profile.files.filter(file => file.kind === "attachment").map(file => ({ path: file.path, before: attachmentState(before, file.path), boundary: attachmentState(boundary.inventory, file.path), after: attachmentState(after, file.path) }));
    proof = { source: "installed-obsidian", mutationKind, runId: options.runId, vaultId: identity.vaultId, candidateBundleSha256: installed.candidateBundleSha256, installedMainSha256: installed.installedMainSha256, runtimeProfile: options.profile.name, seed, manifestSha256: crashDigest({ seedManifest: vault.seedManifestSha256, input, before }), crashPoint, processStoppedBeforeRestart: true, processGenerations: generations, preparedJournalPhase: boundary.frame?.phase as "PREPARED" | "COMMITTED" | "ROLLED_BACK" | undefined ?? null, journalPhase: terminalPhase, proofState: terminalState, before, boundary: boundary.inventory, after, ...(attachmentPaths.length === 0 ? {} : { attachmentPaths, privateFootprint: { before: privateBefore, boundary: boundary.privateFootprint!, after: privateAfter } }), markerSha256: crashDigest(boundary.marker), durableFrameSha256: boundary.frame === null ? null : crashDigest(boundary.frame.payload), terminalProofSha256: terminalDigest, eventOrder, wholeStateVerified: true, sentinelAppliedAfterRestore: true, originalFileAbsentAfterRecovery: !after.some(entry => entry.path === profile.primaryPath), ...(!committed && mutationKind !== "create_note" ? { originalFileBytesPreservedAfterRecovery: true as const } : {}), ...(committed ? { committedFileBytesPreservedAfterRecovery: true as const } : {}), healthRecoveryState: "none" };
    options.assertion(`crash-${label}:whole-state-proof-status-replay-before-new-write`);
  } catch (error) {
    if (error instanceof ObsidianProcessError && error.code === "obsidian_stop_failed") shutdownUnconfirmed = true;
    failure = error;
  } finally {
    try { await stop(); } catch { shutdownUnconfirmed = true; }
    if (shutdownUnconfirmed) throw new ObsidianProcessError("Generated crash-slice shutdown was not confirmed; roots retained", "obsidian_stop_failed");
    await acceptanceCleanup?.();
    const cleanup = await cleanupTestVault(vault);
    if (!cleanup.attempted || cleanup.residualPaths.length > 0) throw new Error("Installed crash slice left generated Vault residue");
    options.record("cleanup", `installed-crash-${label}-cleanup`, { residualPaths: cleanup.residualPaths.length, eventOrder });
    if (failure !== undefined) throw failure;
  }
  if (proof === undefined) throw new Error("Installed crash slice did not produce proof");
  const record = { ...proof, processGenerations: generations, cleanupSucceeded: true as const, verdict: "passed" as const };
  options.record("assertion", `installed-crash-${label}-proof`, record);
  return { scope: crashPoint === "after_prepared" ? "single-after-prepared-installed-rollback-slice" : crashPoint === "after_committed" ? "single-after-committed-installed-replay-slice" : "single-installed-crash-boundary-slice", records: [record], verdict: "passed" };
}
export async function readInstalledCrashJournalOrNull(path: string) {
  const handle = await open(path, "r").catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; });
  if (handle === null) return null;
  try { return await (await openRecoveryJournal(handle)).recover() ?? null; } finally { await handle.close(); }
}
export async function readInstalledCrashJournal(path: string) {
  const record = await readInstalledCrashJournalOrNull(path);
  if (record === null) throw new Error("Installed crash journal has no durable frame");
  return record;
}
async function isPortOpen(port: number): Promise<boolean> {
  return new Promise(resolvePromise => {
    const socket = connect({ host: "127.0.0.1", port });
    socket.setTimeout(1_000);
    socket.once("connect", () => { socket.destroy(); resolvePromise(true); });
    socket.once("error", (error: NodeJS.ErrnoException) => { socket.destroy(); resolvePromise(error.code !== "ECONNREFUSED"); });
    socket.once("timeout", () => { socket.destroy(); resolvePromise(true); });
  });
}
