import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ChangeSetService, InjectedChangeSetCrash, parseChangeSetRegistryState, type ChangeSetRegistryState } from "../change-set.js";
import { createFileSystemChangeSetExecutionAdapter, createNodeFileSystemChangeSetHost } from "../file-system-change-set-execution.js";
import { installReleaseToManagedVaults, type InstallReleaseOptions } from "../lifecycle/install-release.js";
import { isReleaseManagedFile, managedVaultPluginDirectory } from "../lifecycle/release-managed-files.js";
import { openRecoveryJournal } from "../recovery-journal.js";
import type { VerifiedReleaseBundle } from "../release/verify-release-bundle.js";
import { cleanupTestVault, compareInventories, provisionTestVault, snapshotInventory } from "./test-vault.js";
import type { RegisteredRuntimeProfile } from "./runtime-profile.js";

const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
export interface OfflineLifecycleRetainedStateOptions {
  readonly candidate: VerifiedReleaseBundle;
  readonly workingDirectory: string;
  readonly runId?: string;
  readonly profile: RegisteredRuntimeProfile;
  readonly profileName: string;
  readonly configDirectoryName?: string;
  readonly record: (kind: "assertion", name: string, value: unknown) => void;
  readonly assertion: (name: string) => void;
  /** The existing installer failure-injection boundary, never a verification bypass. */
  readonly repairOptions?: InstallReleaseOptions;
}

/** A separate offline file-installer slice. No Obsidian load, recovery, Operator
 * action or Journal clearing occurs. Product submission persists the queue;
 * product execution writes PREPARED and the crash boundary freezes that state. */
export async function runOfflineLifecycleRetainedStateSlice(options: OfflineLifecycleRetainedStateOptions) {
  const runId = options.runId ?? randomUUID();
  const config = options.configDirectoryName ?? ".obsidian";
  const vault = await provisionTestVault({ workingDirectory: options.workingDirectory, runId: `${runId}-retained`, configDirectoryName: config });
  const pluginId = options.candidate.identity.pluginId;
  const pluginDirectory = managedVaultPluginDirectory(vault.vaultPath, config, pluginId);
  const dataPath = join(pluginDirectory, "data.json");
  const stateDirectory = join(vault.vaultPath, ".llm-wiki");
  const journalPath = join(stateDirectory, "recovery-journal.bin");
  let failedStage: string | null = null;
  let stage = "install";
  let before: Awaited<ReturnType<typeof inventory>> | null = null;
  let after: Awaited<ReturnType<typeof inventory>> | null = null;
  let repair: { action: string; outcome: string } | null = null;
  let cleanup: { attempted: boolean; residualPaths: string[] } | null = null;
  let execution: Awaited<ReturnType<typeof createFileSystemChangeSetExecutionAdapter>> | null = null;
  const events: { sequence: number; name: string; sourceSha256: string }[] = [];
  const event = (name: string, value: unknown) => events.push({ sequence: events.length + 1, name, sourceSha256: hash(JSON.stringify(value)) });
  const target = { vaultPath: vault.vaultPath, configDirectoryName: config, obsidianVersion: options.profile.versions.obsidian };
  async function inventory() {
    const directories: string[] = [];
    const walk = async (directory: string, prefix: string): Promise<void> => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
        if (entry.isSymbolicLink() || (!entry.isFile() && !entry.isDirectory())) throw new Error("Retained state inventory is uncertain");
        if (entry.isDirectory()) { directories.push(path); await walk(join(directory, entry.name), path); }
      }
    };
    await walk(vault.vaultPath, "");
    const prefix = `${config}/plugins/${pluginId}/`;
    const files = (await snapshotInventory(vault.vaultPath)).filter(entry => !entry.path.startsWith(prefix) || !isReleaseManagedFile(entry.path.slice(prefix.length)));
    const settingsBytes = await readFile(dataPath);
    const settings = JSON.parse(settingsBytes.toString());
    const registry = parseChangeSetRegistryState(settings.changeSets);
    const queued = registry.entries.filter(entry => entry.execution?.phase === "queued");
    const executing = registry.entries.filter(entry => entry.execution?.phase === "executing");
    if (queued.length !== 1 || executing.length !== 1 || registry.entries.length !== 2 || typeof settings.vaultId !== "string" || !Number.isInteger(settings.port)) throw new Error("Nonempty durable queue evidence is missing");
    const journalHandle = await open(journalPath, "r");
    let recovered;
    try { recovered = await (await openRecoveryJournal(journalHandle)).recover(); } finally { await journalHandle.close(); }
    if (recovered?.phase !== "PREPARED" || recovered.sequence !== 1) throw new Error("Readable PREPARED Journal evidence is missing");
    const directoryManifest = directories.sort().join("\n");
    return { inventorySha256: hash(`${compareInventories(files, files).beforeDigest}\n${directoryManifest}`),
      directoryManifestSha256: hash(directoryManifest), directoryCount: directories.length, fileCount: files.length,
      vaultIdSha256: hash(settings.vaultId), port: settings.port, settingsSha256: hash(settingsBytes),
      recordsSha256: hash(JSON.stringify(registry)), keysSha256: hash(JSON.stringify(registry.entries.map(entry => entry.submissionKey))),
      queueSha256: hash(JSON.stringify(queued)), queuedCount: queued.length, executingCount: executing.length, recordCount: registry.entries.length,
      journalSha256: hash(await readFile(journalPath)), journalPhase: recovered.phase, journalSequence: recovered.sequence,
      journalPayloadSha256: hash(JSON.stringify(recovered.payload)) };
  }
  try {
    const installed = (await installReleaseToManagedVaults(options.candidate, [target])).targets[0];
    if (installed?.outcome !== "success" || installed.action !== "installed") throw new Error("Retained-state initial install failed");
    event(stage, { action: installed.action }); stage = "persist-queue";
    const settings = { schemaVersion: 2, vaultId: randomUUID(), port: 27123, diagnosticPath: join(stateDirectory, "diagnostic.json"),
      changeSets: { schemaVersion: 2, nextEnqueueSeq: 1, entries: [], tombstones: [] } as ChangeSetRegistryState };
    await writeFile(dataPath, JSON.stringify(settings));
    // Submission without an execution adapter persists both entries through the
    // production store path. It cannot mutate content or fabricate a terminal.
    const store = {
      load: async () => JSON.parse(await readFile(dataPath, "utf8")).changeSets,
      save: async (changeSets: ChangeSetRegistryState) => { settings.changeSets = changeSets; await writeFile(dataPath, JSON.stringify(settings)); },
    };
    const host = await createNodeFileSystemChangeSetHost({ basePath: vault.vaultPath, stateDirectory, referenced: async () => false,
      awaitSemanticEvidence: async () => {}, publishSearchSnapshot: async () => {} });
    const dataSource = { readBinary: host.readBinary!, pathKind: host.pathKind, isContained: async () => true };
    const queuedService = await ChangeSetService.open({ store, dataSource });
    const requestState = { vault: { writeGate: "open", writeState: "writable" } as const, effectiveGate: null };
    for (const [index, path] of ["DurableExecuting", "DurableQueued"].entries()) {
      const result = await queuedService.submit({ submissionKey: `durable-key-${runId}-${index}`, operations: [{ operationId: `mkdir-${index}`, kind: "create_directory", path, ifExists: "reject" }] }, requestState);
      if (result.outcome !== "registered" || result.changeSet.state !== "in_progress") throw new Error("Product did not persist queued submission");
    }
    event(stage, { queuedCount: settings.changeSets.entries.filter(entry => entry.execution?.phase === "queued").length });
    stage = "prepared-boundary";
    execution = await createFileSystemChangeSetExecutionAdapter({ journalPath, slotCapacity: 16 * 1024, host });
    try {
      await ChangeSetService.open({ store, dataSource, execution, vaultId: settings.vaultId,
        crashInjector: point => { if (point === "after_prepared") throw new InjectedChangeSetCrash(point); } });
      throw new Error("Product did not reach PREPARED crash boundary");
    } catch (error) { if (!(error instanceof InjectedChangeSetCrash) || error.point !== "after_prepared") throw error; }
    await execution.close?.(); execution = null;
    // The process-owning runtime is never loaded. Frozen queue and Journal stay
    // unresolved; neither readback nor install may recover or clear them.
    await mkdir(join(vault.vaultPath, ".obsidian-public/empty/nested"), { recursive: true });
    await writeFile(join(vault.vaultPath, ".obsidian-public/retain.bin"), "retained-public-root");
    before = await inventory(); event(stage, before); stage = "damage-repair";
    const mainPath = join(pluginDirectory, "main.js"); const bytes = await readFile(mainPath); bytes[0] = bytes[0]! ^ 0xff; await writeFile(mainPath, bytes);
    const repaired = (await installReleaseToManagedVaults(options.candidate, [target], options.repairOptions)).targets[0];
    if (repaired?.outcome !== "success" || repaired.action !== "repaired" || repaired.repairedFiles.join(",") !== "main.js") throw new Error("Retained-state same-version repair failed");
    repair = { action: repaired.action, outcome: repaired.outcome }; event(stage, repair); stage = "state-preservation";
    after = await inventory();
    if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error("Retained queue, keys, records, settings or Journal changed");
    event(stage, after);
  } catch { failedStage = stage; }
  finally {
    if (execution !== null) { try { await execution.close?.(); } catch { failedStage ??= "close-state-writer"; } }
    try { const report = await cleanupTestVault(vault); cleanup = { attempted: report.attempted, residualPaths: report.residualPaths.map(() => "generated_runtime_residue") };
      if (!report.attempted || report.residualPaths.length !== 0) failedStage ??= "cleanup";
    } catch { cleanup = { attempted: true, residualPaths: ["cleanup_unconfirmed"] }; failedStage ??= "cleanup"; }
    event("cleanup", cleanup);
  }
  const verdict = failedStage === null && before !== null && after !== null && cleanup?.attempted === true && cleanup.residualPaths.length === 0 ? "partial" : "failed";
  const result = { scope: "offline-repair-durable-queue-prepared-journal" as const, verdict: verdict as "partial" | "failed", runId,
    candidateBundleSha256: options.candidate.identity.bundleSha256, releaseTag: options.candidate.tag, attestationSource: options.candidate.attestationSource,
    profileName: options.profileName, vaultPathSha256: hash(vault.vaultPath), seedManifestSha256: vault.seedManifestSha256,
    manifestSha256: hash(JSON.stringify({ version: 1, seed: "475-durable-queue-prepared-v1", scenarios: ["product-queued", "product-prepared", "same-version-damage-repair", "full-state-preservation"] })),
    before, after, repair, statePreserved: before !== null && after !== null && JSON.stringify(before) === JSON.stringify(after), cleanup, failedStage, events,
    installedAuthority: false as const };
  options.record("assertion", "offline-lifecycle-retained-state-partial", result);
  if (verdict === "partial") options.assertion("lifecycle:offline-repair-nonempty-durable-queue-and-prepared-journal");
  return result;
}
