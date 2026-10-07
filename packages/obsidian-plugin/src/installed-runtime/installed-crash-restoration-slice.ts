import { createHash } from "node:crypto";
import { connect } from "node:net";
import { mkdir, open, readFile, rename, writeFile } from "node:fs/promises";
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
import { crashBoundaryPhase, inspectCrashPrivateFootprint, crashPrivateResidue, crashDigest, crashInventory, crashProfile, loadCrashBoundaryReport, requestInstalledCrashRestorationScenario, verifyCrashInventory, verifyCrashPublicProof, type CrashInventoryEntry, type InstalledCrashKind, type InstalledCrashPoint } from "./crash-restoration-protocol.js";
import type { InstalledRuntimeAcceptanceDescriptor } from "./acceptance-driver-protocol.js";
import { installPluginEventObserver, OBSERVER_CONFIG_FILE } from "./plugin-event-observer-plugin.js";
import { verifyPluginEventObserverWindow } from "./plugin-event-observer.js";
import { retainPluginEventObserverSource } from "./plugin-event-observer-corpus.js";
import { observerProjectionSha256 } from "./plugin-event-observer-evidence.js";

export interface InstalledMoveObserverContext {
  readonly runId: string;
  readonly candidateBundleSha256: string;
  readonly installedMainSha256: string;
  readonly profileName: string;
  readonly observations: Awaited<ReturnType<typeof retainPluginEventObserverSource>>[];
}
/** Caller-owned private context is retained before cleanup, never reconstructed from a public verdict. */
export function verifyInstalledMoveObserverSource(record: InstalledCrashRestorationSliceRecord, context: InstalledMoveObserverContext): void {
  if (!record.cleanupSucceeded || record.verdict !== "passed" || !record.wholeStateVerified || record.mutationKind !== "move_note" || record.observer === undefined || record.runId !== context.runId || record.candidateBundleSha256 !== context.candidateBundleSha256 || record.installedMainSha256 !== context.installedMainSha256 || record.runtimeProfile !== context.profileName || record.observer.windows.length !== record.processGenerations.length || context.observations.length !== record.processGenerations.length) throw new Error("Installed move observer independent source context missing or changed");
  for (const [index, generation] of record.processGenerations.entries()) {
    const retained = context.observations[index]!;
    const { binding } = retained.verification;
    if (index === record.processGenerations.length - 1 && retained.verification.forbidVaultMutationsAfterSequence === undefined) throw new Error("Installed move observer replay boundary missing from retained source context");
    const verified = verifyPluginEventObserverWindow(retained.verification);
    const source = retained.source;
    const window = { ...verified, supervisorPid: retained.supervisorPid, supervisedProcessTreeVerified: true as const };
    if (binding.runId !== context.runId || binding.vaultId !== record.vaultId || binding.candidateBundleSha256 !== context.candidateBundleSha256 || binding.installedMainSha256 !== context.installedMainSha256 || binding.profileName !== context.profileName || binding.generation !== generation.generation || retained.supervisorPid !== generation.pid || source.runId !== binding.runId || source.vaultIdSha256 !== createHash("sha256").update(record.vaultId).digest("hex") || source.vaultPathSha256 !== createHash("sha256").update(binding.vaultPath).digest("hex") || source.candidateBundleSha256 !== binding.candidateBundleSha256 || source.installedMainSha256 !== binding.installedMainSha256 || source.profileName !== binding.profileName || source.generation !== binding.generation || source.observerMainSha256 !== binding.observerMainSha256 || source.supervisorPid !== generation.pid || source.rendererPid !== verified.pid || source.transcriptSha256 !== verified.transcriptSha256 || source.projectionSha256 !== observerProjectionSha256(verified) || JSON.stringify(window) !== JSON.stringify(record.observer.windows[index]) || JSON.stringify(source) !== JSON.stringify(record.observer.sourceReports[index])) throw new Error("Installed move observer summary differs from authenticated retained source");
  }
}


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
  readonly moveClosure?: readonly { readonly path: string; readonly beforeVersion: string | null; readonly boundaryVersion: string | null; readonly afterVersion: string | null }[];
  readonly privateFootprint?: { readonly before: { readonly stagingFiles: 0; readonly trashFiles: 0 }; readonly boundary: { readonly stagingFiles: number; readonly trashFiles: number }; readonly after: { readonly stagingFiles: 0; readonly trashFiles: 0 } };
  readonly markerSha256: string;
  readonly durableFrameSha256: string | null;
  readonly terminalProofSha256: string;
  readonly eventOrder: readonly string[];
  readonly observer?: { readonly purpose: "isolated-correctness-not-performance"; readonly windows: readonly (ReturnType<typeof verifyPluginEventObserverWindow> & { supervisorPid: number; supervisedProcessTreeVerified: true })[]; readonly sourceReports: readonly Awaited<ReturnType<typeof retainPluginEventObserverSource>>["source"][] };
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
  readonly prepareAcceptanceDriver: (options: { readonly vaultPath: string; readonly pluginId: string; readonly candidateBundleSha256: string; readonly configDirectoryName: string; readonly reportDirectory?: string }) => Promise<{ readonly path: string; readonly descriptor: InstalledRuntimeAcceptanceDescriptor; cleanup(): Promise<void> }>;
  readonly record: (kind: "transport" | "tool" | "assertion" | "cleanup", name: string, detail: unknown) => void;
  readonly assertion: (name: string) => void;
  /** Required by the authoritative move composition; absent only in explicit Node wire regressions. */
  readonly moveObserverContext?: InstalledMoveObserverContext;
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
  let sealObserver: (() => Promise<void>) | undefined;
  const stop = async (seal = false): Promise<void> => {
    if (processHandle === null) return;
    if (seal) await sealObserver?.();
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
    const observerContext = options.moveObserverContext;
    if (observerContext !== undefined && (mutationKind !== "move_note" || observerContext.runId !== options.runId || observerContext.candidateBundleSha256 !== installed.candidateBundleSha256 || observerContext.installedMainSha256 !== installed.installedMainSha256 || observerContext.profileName !== options.profile.name || observerContext.observations.length !== 0)) throw new Error("Installed move observer source pin is not this verified candidate/run/profile");
    const observer = observerContext === undefined ? undefined : await installPluginEventObserver({ vaultPath: vault.vaultPath, configDirectoryName, reportDirectory: options.reportDirectory, candidatePluginId: options.candidate.identity.pluginId,
      binding: { runId: options.runId, vaultPath: vault.vaultPath, vaultId: null, candidateBundleSha256: installed.candidateBundleSha256, installedMainSha256: installed.installedMainSha256, profileName: options.profile.name, generation: 1 } });
    let observerBinding = observer?.binding;
    const observerPins: { generation: number; supervisorPid: number; binding: import("./plugin-event-observer.js").PluginEventObserverBinding }[] = [];
    let observerSequence = 0;
    let replayObservationSequence: number | undefined;
    let observerFrom: InstalledCrashPoint = "after_prepared";
    let observerTo: InstalledCrashPoint = "after_prepared";
    const observerWindows: NonNullable<InstalledCrashRestorationSliceRecord["observer"]>["windows"][number][] = [];
    const observerSources: NonNullable<InstalledCrashRestorationSliceRecord["observer"]>["sourceReports"][number][] = [];
    const observerCommand = async (action: "begin" | "end") => {
      if (observer === undefined || observerBinding === undefined || identity === null) return;
      const path = join(observer.directory, "window-command.json");
      await writeFile(`${path}.next`, JSON.stringify({ action, vaultId: identity.vaultId, sequence: ++observerSequence, generation: observerBinding.generation, runId: observerBinding.runId, capabilityToken: observerBinding.capabilityToken }), { mode: 0o600 });
      await rename(`${path}.next`, path);
    };
    const observerEvents = async (sealed = false) => JSON.parse(`[${(await readFile(join(options.reportDirectory, `observer-generation-${observerBinding!.generation}${sealed ? ".sealed" : ""}.jsonl`), "utf8")).trim().split("\n").join(",")}]`) as { payload: { kind: string; pid: number } }[];
    const observerMarker = async (kind: string) => waitForCondition(async () => {
      try { return (await observerEvents()).some(event => event.payload.kind === kind); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError) return false; throw error; }
    }, { timeoutMs: options.timeouts.startupMs, intervalMs: POLL_MS });
    sealObserver = async () => {
      if (observerBinding === undefined || observerContext === undefined || processHandle?.pid === undefined) return;
      const pin = observerPins.find(pin => pin.generation === running!.generation);
      if (pin === undefined || pin.supervisorPid !== processHandle.pid || Object.entries(pin.binding).some(([key, value]) => key !== "vaultId" && observerBinding![key as keyof typeof observerBinding] !== value)) throw new Error("Installed move observer source differs from pre-start pin");
      const from = profile.expectedBoundary({ point: observerFrom === "after_semantic_evidence" || observerFrom === "before_committed" ? "after_snapshot" : observerFrom, phase: "apply" });
      const to = profile.expectedBoundary({ point: observerTo === "after_semantic_evidence" || observerTo === "before_committed" ? "after_snapshot" : observerTo, phase: "apply" });
      const changed = profile.files.filter(file => from.files.find(entry => entry.path === file.path)!.state !== to.files.find(entry => entry.path === file.path)!.state && to.files.find(entry => entry.path === file.path)!.state !== "absent");
      const requiredVisibleStates = changed.map(file => ({ path: file.path, bytes: to.files.find(entry => entry.path === file.path)!.state === "committed" ? file.committedBytes! : file.originalBytes! }));
      await waitForCondition(async () => {
        const events = await observerEvents();
        return requiredVisibleStates.every(required => events.some(event => {
          const payload = event.payload as typeof event.payload & { path?: string; rawBytesBase64?: string };
          return payload.path === required.path && ["changed", "resolved"].includes(payload.kind) && payload.rawBytesBase64 === Buffer.from(required.bytes).toString("base64");
        }));
      }, { timeoutMs: options.timeouts.startupMs, intervalMs: POLL_MS });
      await observerCommand("end"); await observerMarker("window-end");
      let events: Awaited<ReturnType<typeof observerEvents>> = [];
      await waitForCondition(async () => { try { events = await observerEvents(true); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; } }, { timeoutMs: options.timeouts.startupMs, intervalMs: POLL_MS });
      const files = [...vault.seedNotes.map(note => ({ path: note.path, before: new TextEncoder().encode(note.content), after: new TextEncoder().encode(note.content) })), ...profile.files.map(file => ({ path: file.path, before: file.originalBytes, after: file.committedBytes }))];
      const verification = { binding: observerBinding, candidatePluginId: options.candidate.identity.pluginId, files, maxSilenceMs: 2_000, requiredVisibleStates, requiredCallbackPaths: changed.map(file => file.path), ...(replayObservationSequence === undefined ? {} : { forbidVaultMutationsAfterSequence: replayObservationSequence }) };
      const window = { ...verifyPluginEventObserverWindow({ ...verification, events, expectedPid: events[0]!.payload.pid }), supervisorPid: processHandle.pid, supervisedProcessTreeVerified: true as const };
      const retained = await retainPluginEventObserverSource({ ...verification, window, scenario: running!.generation === 1 ? "success" : rollback && running!.generation === 2 ? "rollback" : "startup-recovery", reportDirectory: options.reportDirectory, configDirectoryName, supervisorPid: processHandle.pid });
      observerContext.observations.push(retained); observerSources.push(retained.source); observerWindows.push(window);
      eventOrder.push(`sealed-authenticated-enabled-observer-generation:${running!.generation}`);
    };
    const start = async (): Promise<void> => {
      if (observer !== undefined && observerBinding !== undefined && generations.length > 0) {
        observerBinding = { ...observerBinding, vaultId: identity!.vaultId, generation: generations.length + 1 };
        observerSequence = 0;
        await writeFile(join(observer.directory, OBSERVER_CONFIG_FILE), JSON.stringify({ binding: observerBinding, observerId: "llm-wiki-event-observer", candidatePluginId: options.candidate.identity.pluginId, reportDirectory: options.reportDirectory }), { mode: 0o600 });
        await writeFile(join(observer.directory, "window-command.json"), JSON.stringify({ sequence: 0 }));
      }
      processHandle = await options.processControl.start({ vaultPath: vault.vaultPath, profileDirectory: vault.profileDirectory });
      const observed = await options.probe.probeRunning({ vaultPath: vault.vaultPath, profileDirectory: vault.profileDirectory });
      if (preflightRuntimeProfile(options.profile, observed).length > 0) throw new Error("Installed crash runtime does not match the registered profile");
      running = { generation: generations.length + 1, pid: processHandle.pid ?? null, runtime: observed };
      if (observer !== undefined) {
        if (processHandle.pid === undefined) throw new Error("Installed move observer requires supervised process identity");
        observerPins.push({ generation: running.generation, supervisorPid: processHandle.pid, binding: structuredClone(observerBinding!) });
        await observerMarker("candidate-start");
        if (generations.length > 0) await observerMarker("window-begin");
      }
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
    if (observerBinding !== undefined) {
      observerBinding = { ...observerBinding, vaultId: identity.vaultId };
      await observerCommand("begin"); await observerMarker("window-begin");
    }
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
      const privateFootprint = mutationKind === "move_note" ? await inspectCrashPrivateFootprint(vault.vaultPath) : mutationKind === "copy_attachment" || mutationKind === "move_attachment" ? await crashPrivateResidue(vault.vaultPath) : undefined;
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
    observerTo = initialPoint;
    await stop(true);
    observerFrom = initialPoint;
    if (rollback) {
      if (boundary.frame?.phase !== "PREPARED") throw new Error("Installed rollback lead-in is not PREPARED");
      const recoverySequence = await requestInstalledCrashRestorationScenario({ descriptorPath: driver.path, descriptor: installed, expectedVaultId: identity.vaultId, endpoint, input, crashPoint, mutationKind, recovery: { changeSetId: beforeRecord.changeSetId, frameSha256: crashDigest(boundary.frame.payload) } });
      await start();
      boundary = await observeBoundary(crashPoint, recoverySequence);
      // Recovery is parked before Bridge.start may bind: new writes must not reach it.
      if (await isPortOpen(identity.port)) throw new Error("Installed recovery accepted a listener before whole-state restore");
      eventOrder.push("recovery-park-listener-remained-closed");
      observerTo = crashPoint;
      await stop(true);
      observerFrom = crashPoint;
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
    replayObservationSequence = observerBinding === undefined ? undefined : (await observerEvents()).length;
    const replay = await submit(input, !committed);
    if (replayObservationSequence !== undefined && (await observerEvents()).slice(replayObservationSequence).some(event => {
      const payload = event.payload as typeof event.payload & { path?: string };
      return ["create", "modify", "rename", "delete"].includes(payload.kind) && profile.files.some(file => file.path === payload.path);
    })) throw new Error("Installed move replay performed a duplicate closure rewrite");
    if (replay.outcome !== "registered" || JSON.stringify(replay.changeSet) !== JSON.stringify(recovered.changeSet)) throw new Error("Recovered Bridge did not replay the retained terminal record");
    verifyCrashInventory(before, await crashInventory(vault.vaultPath, configDirectoryName), mutationKind, committed ? "committed" : "original");
    if (JSON.stringify(await readInstalledCrashJournal(journalPath)) !== JSON.stringify(recoveredFrame)) throw new Error("Installed crash replay changed the durable terminal frame");
    eventOrder.push("complete-public-proof-status-and-identical-replay-observed");
    observerTo = committed ? "after_committed" : "after_rolled_back";
    // Seal before the unrelated sentinel, but after replay so a duplicate rewrite
    // cannot hide behind unchanged final bytes or a stable terminal Journal.
    await sealObserver?.();
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
    const moveClosure = mutationKind === "move_note" ? profile.files.map(file => {
      const version = (entries: readonly CrashInventoryEntry[]) => { const entry = entries.find(entry => entry.path === file.path); return entry === undefined ? null : `sha256:${entry.sha256}`; };
      return { path: file.path, beforeVersion: version(before), boundaryVersion: version(boundary.inventory), afterVersion: version(after) };
    }) : undefined;
    proof = { source: "installed-obsidian", mutationKind, runId: options.runId, vaultId: identity.vaultId, candidateBundleSha256: installed.candidateBundleSha256, installedMainSha256: installed.installedMainSha256, runtimeProfile: options.profile.name, seed, manifestSha256: crashDigest({ seedManifest: vault.seedManifestSha256, input, before }), crashPoint, processStoppedBeforeRestart: true, processGenerations: generations, preparedJournalPhase: boundary.frame?.phase as "PREPARED" | "COMMITTED" | "ROLLED_BACK" | undefined ?? null, journalPhase: terminalPhase, proofState: terminalState, before, boundary: boundary.inventory, after, ...(attachmentPaths.length === 0 ? {} : { attachmentPaths }), ...(boundary.privateFootprint === undefined ? {} : { privateFootprint: { before: privateBefore, boundary: boundary.privateFootprint, after: privateAfter } }), markerSha256: crashDigest(boundary.marker), durableFrameSha256: boundary.frame === null ? null : crashDigest(boundary.frame.payload), terminalProofSha256: terminalDigest, eventOrder, ...(moveClosure === undefined ? {} : { moveClosure }), ...(observer === undefined ? {} : { observer: { purpose: "isolated-correctness-not-performance" as const, windows: observerWindows, sourceReports: observerSources } }), wholeStateVerified: true, sentinelAppliedAfterRestore: true, originalFileAbsentAfterRecovery: !after.some(entry => entry.path === profile.primaryPath), ...(!committed && mutationKind !== "create_note" ? { originalFileBytesPreservedAfterRecovery: true as const } : {}), ...(committed ? { committedFileBytesPreservedAfterRecovery: true as const } : {}), healthRecoveryState: "none" };
    options.assertion(`crash-${label}:whole-state-proof-status-replay-before-new-write`);
  } catch (error) {
    if (error instanceof ObsidianProcessError && error.code === "obsidian_stop_failed") shutdownUnconfirmed = true;
    failure = error;
  } finally {
    try { await stop(); } catch { shutdownUnconfirmed = true; }
    if (shutdownUnconfirmed) throw new ObsidianProcessError("Generated crash-slice shutdown was not confirmed; roots retained", "obsidian_stop_failed");
    if (failure !== undefined) {
      // A rejected/unproven run is not terminal recovery evidence. Keep the driver,
      // Journal and hidden mutation input together so a later startup can recover.
      const journal = await readInstalledCrashJournalOrNull(join(vault.vaultPath, ".llm-wiki", "recovery-journal.bin")).then(frame => ({ verified: true as const, phase: frame?.phase ?? null })).catch(() => ({ verified: false as const, phase: null }));
      const privateFootprint = await inspectCrashPrivateFootprint(vault.vaultPath).catch(() => null);
      options.record("cleanup", `installed-crash-${label}-retained`, { attempted: false, cleanupSucceeded: false, rootsRetained: true, journal, privateFootprint, eventOrder });
      throw failure;
    }
    await acceptanceCleanup?.();
    const cleanup = await cleanupTestVault(vault);
    if (!cleanup.attempted || cleanup.residualPaths.length > 0) throw new Error("Installed crash slice left generated Vault residue");
    options.record("cleanup", `installed-crash-${label}-cleanup`, { residualPaths: cleanup.residualPaths.length, eventOrder });
  }
  if (proof === undefined) throw new Error("Installed crash slice did not produce proof");
  const record = { ...proof, processGenerations: generations, cleanupSucceeded: true as const, verdict: "passed" as const };
  if (options.moveObserverContext !== undefined) verifyInstalledMoveObserverSource(record, options.moveObserverContext);
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
