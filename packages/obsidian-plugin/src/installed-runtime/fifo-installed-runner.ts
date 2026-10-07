import { connect } from "node:net";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { parseChangeSetSubmitResult, parseChangeSetStatusResult, type ChangeSetSubmitInput } from "@llm-wiki/vault-contracts";
import { EXPECTED_VAULT_ID_HEADER } from "../request-policy.js";
import { parseChangeSetRegistryState } from "../change-set.js";
import { installedRuntimeAcceptanceDescriptorSchema } from "./acceptance-driver-protocol.js";
import { installCandidateBundle } from "./candidate-bundle.js";
import { preflightRuntimeProfile } from "./runtime-profile.js";
import { provisionTestVault, cleanupTestVault, snapshotInventory, compareInventories } from "./test-vault.js";
import { readPersistedBridgeIdentity, waitForCondition, type ObsidianProcessHandle } from "./obsidian-process.js";
import { appendFifoEvent, loadFifoEvents, fifoDigest, fifoReportSchema } from "./installed-fifo-observer.js";
import { fifoCommandSchema, persistentFifoProofSchema, verifyFifoObservations, type FifoEntryIdentity } from "./fifo-observation.js";
import type { InstalledCrashRestorationSliceOptions } from "./installed-crash-restoration-slice.js";

export type InstalledFifoOptions = Omit<InstalledCrashRestorationSliceOptions, "crashPoint" | "mutationKind">;
const targetPath = "FifoProof/Target.md";
const dependencyPath = "FifoProof/Dependency.md";
const derivedPath = "FifoProof/Derived.md";
const originalTarget = "# Target\nOriginal target.\n";
const originalDependency = "# Dependency\nOriginal dependency.\n";
const originalDerived = "# Derived\nUnchanged.\n";
const changedTarget = "# Target\nExternal edit during queue wait.\n";
const changedDependency = "# Dependency\nExternal dependency edit during queue wait.\n";
const version = (text: string) => `sha256:${fifoDigest(text)}`;
const portOpen = (port: number): Promise<boolean> => new Promise(resolvePromise => {
  const socket = connect({ host: "127.0.0.1", port });
  socket.once("connect", () => { socket.destroy(); resolvePromise(true); });
  socket.once("error", () => resolvePromise(false));
});

export async function runInstalledPersistentFifoCorpus(options: InstalledFifoOptions) {
  if (options.probe.probeRunning === undefined) throw new Error("FIFO requires a registered running-runtime probe");
  const vault = await provisionTestVault({ workingDirectory: options.workingDirectory, runId: `${options.runId}-fifo`, configDirectoryName: options.configDirectoryName });
  let handle: ObsidianProcessHandle | null = null;
  let observedPort: number | undefined;
  let driverCleanup: (() => Promise<void>) | undefined;
  let shutdownConfirmed = true;
  let evidence: unknown;
  let failed = false;
  try {
    const seeds = [[targetPath, originalTarget], [dependencyPath, originalDependency], [derivedPath, originalDerived]] as const;
    for (const [path, text] of seeds) {
      const full = join(vault.vaultPath, path);
      await mkdir(dirname(full), { recursive: true });
      await writeFile(full, text, { flag: "wx" });
    }
    await installCandidateBundle(options.candidate, vault.vaultPath, options.configDirectoryName);
    const driver = await options.prepareAcceptanceDriver({ vaultPath: vault.vaultPath, pluginId: options.candidate.identity.pluginId,
      candidateBundleSha256: options.candidate.identity.bundleSha256, configDirectoryName: options.configDirectoryName ?? ".obsidian" });
    driverCleanup = driver.cleanup;
    let descriptor = driver.descriptor;
    if (descriptor.runId !== options.runId || descriptor.vaultPath !== resolve(vault.vaultPath) || descriptor.reportDirectory !== resolve(options.reportDirectory) ||
        descriptor.candidateBundleSha256 !== options.candidate.identity.bundleSha256 || descriptor.installedMainSha256 !== options.candidate.identity.files.find(f => f.path === "main.js")?.sha256) throw new Error("FIFO descriptor is not verified-candidate/run bound");
    const start = async () => {
      shutdownConfirmed = false;
      handle = await options.processControl.start({ vaultPath: vault.vaultPath, profileDirectory: vault.profileDirectory });
      const observed = await options.probe.probeRunning({ vaultPath: vault.vaultPath, profileDirectory: vault.profileDirectory });
      if (preflightRuntimeProfile(options.profile, observed).length) throw new Error("FIFO runtime profile mismatch");
      options.record("transport", "fifo-runtime-profile", { profile: options.profile.name, observed });
    };
    const stop = async () => {
      if (handle === null) throw new Error("FIFO process stop cannot be confirmed");
      await handle.stop();
      if (observedPort !== undefined) await waitForCondition(async () => !await portOpen(observedPort!), { timeoutMs: options.timeouts.portClosedMs, intervalMs: 25 });
      handle = null;
      shutdownConfirmed = true;
    };
    await start();
    let identity: Awaited<ReturnType<typeof readPersistedBridgeIdentity>> = null;
    await waitForCondition(async () => { identity = await readPersistedBridgeIdentity(vault.vaultPath, options.candidate.identity.pluginId, options.configDirectoryName); return identity !== null; }, { timeoutMs: options.timeouts.startupMs, intervalMs: 25 });
    if (identity === null) throw new Error("FIFO Bridge identity missing");
    const { vaultId, port } = identity as { vaultId: string; port: number };
    observedPort = port;
    const endpoint = new URL(`http://127.0.0.1:${port}/mcp`);
    await waitForCondition(async () => (await options.client.observeHealth(endpoint, vaultId)).health.readiness.searchSnapshot === "ready", { timeoutMs: options.timeouts.startupMs, intervalMs: 25 });
    // Arm before the next process startup; the observer must exist before open()
    // resumes a durable queue. Only generated fixture/observer authority is armed.
    await stop();
    const keys = ["head", "target", "dependency", "tail"].map(k => `${options.runId}-fifo-${k}`) as [string, string, string, string];
    descriptor = installedRuntimeAcceptanceDescriptorSchema.parse({ ...descriptor, command: fifoCommandSchema.parse({ action: "observe-persistent-fifo", sequence: 1, capabilityToken: descriptor.capabilityToken, expectedVaultId: vaultId, endpoint: endpoint.toString(), keys }) });
    await mkdir(descriptor.reportDirectory, { recursive: true });
    for (const path of [join(descriptor.reportDirectory, "persistent-fifo-events.jsonl"), join(descriptor.reportDirectory, "persistent-fifo-parked.json")]) {
      if (await stat(path).then(() => true, e => { if (e.code === "ENOENT") return false; throw e; })) throw new Error("FIFO evidence paths already exist");
    }
    const next = `${driver.path}.fifo.next`;
    await writeFile(next, JSON.stringify(descriptor), { flag: "wx", mode: 0o600 });
    await rename(next, driver.path);
    await start();
    await waitForCondition(async () => (await options.client.observeHealth(endpoint, vaultId)).health.readiness.searchSnapshot === "ready", { timeoutMs: options.timeouts.startupMs, intervalMs: 25 });
    const inputs: ChangeSetSubmitInput[] = [
      { submissionKey: keys[0], operations: [{ operationId: "head", kind: "create_note", ifExists: "reject", path: "FifoProof/Head.md", content: "# Head\n" }] },
      { submissionKey: keys[1], operations: [{ operationId: "target", kind: "edit_body", path: targetPath, targetVersion: version(originalTarget), edit: { kind: "replace_whole", replacement: "# Stale target write\n" } }] },
      { submissionKey: keys[2], readDependencies: [{ path: dependencyPath, contentVersion: version(originalDependency) }], operations: [{ operationId: "dependency", kind: "edit_body", path: derivedPath, targetVersion: version(originalDerived), edit: { kind: "replace_whole", replacement: "# Stale dependency write\n" } }] },
      { submissionKey: keys[3], operations: [{ operationId: "tail", kind: "create_note", ifExists: "reject", path: "FifoProof/Tail.md", content: "# Tail\n" }] },
    ];
    const call = async (tool: "vault_change_set_submit" | "vault_change_set_status", args: Record<string, unknown>) => {
      const client = new Client({ name: "installed-fifo", version: "1.0.0" });
      try {
        await client.connect(new StreamableHTTPClientTransport(endpoint, { requestInit: { headers: { [EXPECTED_VAULT_ID_HEADER]: vaultId } } }));
        const result = await client.callTool({ name: tool, arguments: args });
        if (result.structuredContent === undefined) throw new Error("FIFO wire omitted structured content");
        const value = tool === "vault_change_set_submit" ? parseChangeSetSubmitResult(result.structuredContent) : parseChangeSetStatusResult(result.structuredContent);
        if (!Array.isArray(result.content) || result.content.length !== 1 || result.content[0]?.type !== "text" || result.content[0].text !== JSON.stringify(value)) throw new Error("FIFO wire compatibility mismatch");
        const expectedError = tool === "vault_change_set_submit" && ("outcome" in value && (value.outcome !== "registered" || ("changeSet" in value && ["intent_not_applied", "result_unproven"].includes(value.changeSet.state))));
        if ((result.isError === true) !== expectedError) throw new Error("FIFO wire error disposition mismatch");
        return value;
      } finally { await client.close().catch(() => {}); }
    };
    const pending: Promise<unknown>[] = [];
    const queued: FifoEntryIdentity[] = [];
    const registry = async () => {
      const state = JSON.parse(await readFile(join(vault.vaultPath, ".llm-wiki", "bridge-state.json"), "utf8"));
      return parseChangeSetRegistryState(state.changeSets);
    };
    for (const input of inputs) {
      pending.push(call("vault_change_set_submit", input).catch(() => undefined));
      await waitForCondition(async () => (await registry()).entries.some(e => e.submissionKey === input.submissionKey), { timeoutMs: options.timeouts.startupMs, intervalMs: 25 });
      const entry = (await registry()).entries.find(e => e.submissionKey === input.submissionKey)!;
      if (entry.changeSet.state !== "in_progress" || entry.execution?.phase === "terminal") throw new Error("FIFO request did not enter persistent queue");
      queued.push({ submissionKey: entry.submissionKey, changeSetId: entry.changeSetId, enqueueSeq: entry.enqueueSeq });
      if (input === inputs[0]) {
        await waitForCondition(async () => {
          try {
            const report = fifoReportSchema.parse(JSON.parse(await readFile(join(descriptor.reportDirectory, "persistent-fifo-parked.json"), "utf8")));
            const events = await loadFifoEvents(descriptor);
            return report.event.kind === "committed" && report.event.submissionKey === keys[0] && events.some(e => e.kind === "committed" && e.submissionKey === keys[0]);
          } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return false; throw e; }
        }, { timeoutMs: options.timeouts.startupMs, intervalMs: 25 });
      }
    }
    const before = await snapshotInventory(vault.vaultPath);
    await writeFile(join(vault.vaultPath, targetPath), changedTarget);
    await writeFile(join(vault.vaultPath, dependencyPath), changedDependency);
    await appendFifoEvent(descriptor, { kind: "fixtures-changed", targetBefore: fifoDigest(originalTarget), targetAfter: fifoDigest(changedTarget), dependencyBefore: fifoDigest(originalDependency), dependencyAfter: fifoDigest(changedDependency) });
    await stop();
    await appendFifoEvent(descriptor, { kind: "restart", stopped: true });
    await Promise.all(pending);
    await start();
    await waitForCondition(async () => (await registry()).entries.filter(e => keys.includes(e.submissionKey)).every(e => e.execution?.phase === "terminal"), { timeoutMs: options.timeouts.startupMs, intervalMs: 25 });
    const terminal = await registry();
    const eventsBeforeReplay = await loadFifoEvents(descriptor);
    for (const input of inputs) {
      const status = parseChangeSetStatusResult(await call("vault_change_set_status", { submissionKey: input.submissionKey }));
      const replay = parseChangeSetSubmitResult(await call("vault_change_set_submit", input));
      const entry = terminal.entries.find(e => e.submissionKey === input.submissionKey)!;
      if (status.lookup !== "found" || replay.outcome !== "registered" || JSON.stringify(status.changeSet) !== JSON.stringify(replay.changeSet) || status.changeSet.changeSetId !== entry.changeSetId) throw new Error("FIFO restart/status/replay identity mismatch");
    }
    const events = await loadFifoEvents(descriptor);
    if (JSON.stringify(events) !== JSON.stringify(eventsBeforeReplay)) throw new Error("FIFO replay executed a bound key again");
    verifyFifoObservations({ events, expected: queued, staleKeys: keys.slice(1, 3) });
    const targetAfter = await readFile(join(vault.vaultPath, targetPath), "utf8");
    const dependencyAfter = await readFile(join(vault.vaultPath, dependencyPath), "utf8");
    const derivedAfter = await readFile(join(vault.vaultPath, derivedPath), "utf8");
    if (targetAfter !== changedTarget || dependencyAfter !== changedDependency || derivedAfter !== originalDerived) throw new Error("FIFO stale request changed a target");
    const after = await snapshotInventory(vault.vaultPath);
    const comparison = compareInventories(before, after);
    evidence = { scope: "persistent-fifo-and-pre-mutation-repreflight", source: "installed-obsidian", runId: options.runId,
      candidateBundleSha256: descriptor.candidateBundleSha256, installedMainSha256: descriptor.installedMainSha256,
      profile: options.profile.name, vaultIdSha256: fifoDigest(vaultId), seed: vault.seedManifestSha256,
      canonicalManifestSha256: fifoDigest(JSON.stringify(inputs)), beforeInventorySha256: comparison.beforeDigest, afterInventorySha256: comparison.afterDigest,
      enqueue: queued.map(e => ({ enqueueSeq: e.enqueueSeq, changeSetId: fifoDigest(e.changeSetId), submissionKey: fifoDigest(e.submissionKey) })),
      staleKeys: keys.slice(1, 3).map(fifoDigest),
      events: events.map(e => "submissionKey" in e ? { ...e, submissionKey: fifoDigest(e.submissionKey), changeSetId: fifoDigest(e.changeSetId) } : e),
      replay: { keysReplayed: 4, identitiesPreserved: 4, recordsUnchanged: 4, noAdditionalExecutionEvents: true },
      targetAfterSha256: fifoDigest(targetAfter), dependencyAfterSha256: fifoDigest(dependencyAfter), derivedAfterSha256: fifoDigest(derivedAfter) };
    options.assertion("concurrency/persistent-fifo:repreflight-and-restart-proven");
  } catch (error) { failed = true; throw error; }
  finally {
    let cleanup;
    try {
      if (handle !== null) {
        await (handle as ObsidianProcessHandle).stop();
        if (observedPort !== undefined) await waitForCondition(async () => !await portOpen(observedPort!), { timeoutMs: options.timeouts.portClosedMs, intervalMs: 25 });
        shutdownConfirmed = true; handle = null;
      }
      if (!shutdownConfirmed) throw new Error("FIFO shutdown unconfirmed; retain generated Vault");
      await driverCleanup?.();
      cleanup = await cleanupTestVault(vault);
      options.record("cleanup", "persistent-fifo-cleanup", cleanup);
      if (!cleanup.attempted || cleanup.residualPaths.length) throw new Error("FIFO cleanup not verified");
    } catch (error) { options.record("cleanup", "persistent-fifo-cleanup-failed", { shutdownConfirmed }); throw error; }
    if (!failed && evidence !== undefined) {
      const proof = persistentFifoProofSchema.parse({ ...(evidence as object), cleanupSucceeded: true, verdict: "passed" });
      options.record("assertion", "persistent-fifo-observed", proof);
    }
  }
  return persistentFifoProofSchema.parse({ ...(evidence as object), cleanupSucceeded: true, verdict: "passed" });
}
