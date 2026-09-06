import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, writeFile, open } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, describe, expect, it } from "vitest";

import {
  CHANGE_SET_RECORD_RETENTION_MS,
  createBridgeInstance,
  createFileSystemChangeSetExecutionAdapter,
  createLoopbackMcpClient,
  createNodeFileSystemChangeSetHost,
  InstallInterruptionError,
  installReleaseToManagedVaults,
  ManagedVaultBridgeRuntime,
  PURGE_LOST_CAPABILITIES,
  purgeManagedVaultState,
  RELEASE_MANAGED_CHECKSUM_FILE,
  RELEASE_REPOSITORY,
  RELEASE_WORKFLOW_PATH,
  ReleasePurgeError,
  UPGRADE_EVIDENCE_FILENAME,
  UPGRADE_EVIDENCE_SCHEMA_VERSION,
  verifyReleaseBundle,
  waitForCondition,
  type BridgeInstance,
  type ManagedVaultPurgeConfirmation,
  type ManagedVaultPurgeResult,
  type ManagedVaultUpgradeEvidence,
  type ObservedHealth,
  type PersistedBridgeSettings,
} from "../src/index.js";
import { openRecoveryJournal } from "../src/recovery-journal.js";

/**
 * Issue #201 orchestration tests (spec §9.3): the backup-backed interactive
 * purge as a distinct local operation — full enumeration before anything is
 * written, a verifiable backup outside the removed state with re-verification
 * against the source, the fail-closed recovery gate (every refusal
 * condition), explicit per-Vault interactive confirmation with
 * non-interactive/cancellation refusals, injected backup/verify/delete
 * failures that never masquerade as a complete purge, and deterministic
 * idempotent retries — composed over the real per-Vault runtime, real
 * loopback Bridges, the real installer, and the real Recovery Journal.
 */

const PLUGIN_ID = "purge-bridge";
const VERSION = "0.8.0";
const OBSIDIAN_VERSION = "1.13.4";

const digest = (content: string | Uint8Array): string =>
  createHash("sha256").update(content).digest("hex");

function manifest(version: string): string {
  return `${JSON.stringify(
    {
      id: PLUGIN_ID,
      name: "Purge Bridge",
      version,
      minAppVersion: "1.13.4",
      isDesktopOnly: true,
    },
    null,
    2,
  )}\n`;
}

const mainJs = (version: string): string => `// purge candidate main ${version}\n`;

async function verifiedBundle(root: string, name: string, version: string) {
  const directory = join(root, name);
  await mkdir(directory, { recursive: true });
  const manifestBytes = manifest(version);
  const mainBytes = mainJs(version);
  await writeFile(join(directory, "manifest.json"), manifestBytes, "utf8");
  await writeFile(join(directory, "main.js"), mainBytes, "utf8");
  const lines = [
    `${digest(mainBytes)}  main.js`,
    `${digest(manifestBytes)}  manifest.json`,
  ].sort();
  const checksums = `${lines.join("\n")}\n`;
  await writeFile(join(directory, RELEASE_MANAGED_CHECKSUM_FILE), checksums, "utf8");
  const tag = `v${version}`;
  const claims = {
    source: "local-candidate",
    repository: RELEASE_REPOSITORY,
    workflowRef: `${RELEASE_REPOSITORY}/${RELEASE_WORKFLOW_PATH}@refs/tags/${tag}`,
    subjects: [
      ...lines.map((line) => {
        const [subjectDigest, path] = line.split("  ");
        return { name: path, sha256: subjectDigest };
      }),
      { name: RELEASE_MANAGED_CHECKSUM_FILE, sha256: digest(checksums) },
    ].sort((left, right) => left.name!.localeCompare(right.name!)),
  };
  await writeFile(`${directory}.attestation.json`, `${JSON.stringify(claims, null, 2)}\n`, "utf8");
  return verifyReleaseBundle({
    bundleDirectory: directory,
    expectedTag: tag,
    expectedPluginId: PLUGIN_ID,
  });
}

async function reservePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

interface VaultHarness {
  readonly vaultPath: string;
  readonly pluginDirectory: string;
  readonly dataPath: string;
  readonly stateDirectory: string;
  readonly backupRoot: string;
  readonly port: number;
  currentRuntime: ManagedVaultBridgeRuntime | undefined;
  currentBridge: BridgeInstance | undefined;
  createRuntime(options?: { withExecutor?: boolean }): Promise<ManagedVaultBridgeRuntime>;
  observeHealth(): Promise<ObservedHealth>;
  submitChangeSet(submissionKey: string, path: string): Promise<unknown>;
  readPersistedState(): Promise<Record<string, unknown>>;
}

const liveRuntimes: ManagedVaultBridgeRuntime[] = [];

afterEach(async () => {
  await Promise.all(
    liveRuntimes.splice(0).map((runtime) => runtime.unload().catch(() => undefined)),
  );
});

async function arrangeVaultHarness(root: string, name: string): Promise<VaultHarness> {
  const vaultPath = join(root, name);
  await mkdir(join(vaultPath, ".obsidian"), { recursive: true });
  await writeFile(join(vaultPath, "note.md"), "needle\n", "utf8");
  const pluginDirectory = join(vaultPath, ".obsidian", "plugins", PLUGIN_ID);
  const dataPath = join(pluginDirectory, "data.json");
  const stateDirectory = join(vaultPath, ".llm-wiki");
  const backupRoot = join(root, `${name}-backups`);
  const port = await reservePort();
  const healthClient = createLoopbackMcpClient({ clientName: "purge-test" });

  const harness: VaultHarness = {
    vaultPath,
    pluginDirectory,
    dataPath,
    stateDirectory,
    backupRoot,
    port,
    currentRuntime: undefined,
    currentBridge: undefined,
    async createRuntime(options) {
      // The real filesystem execution adapter over the generated Vault, so
      // drained work leaves a real Recovery Journal on disk.
      const execution = options?.withExecutor === true
        ? await createFileSystemChangeSetExecutionAdapter({
            journalPath: join(stateDirectory, "recovery-journal.bin"),
            slotCapacity: 16 * 1024,
            host: await createNodeFileSystemChangeSetHost({
              basePath: vaultPath,
              stateDirectory,
              referenced: async () => false,
              awaitSemanticEvidence: async () => undefined,
              publishSearchSnapshot: async () => undefined,
            }),
          })
        : undefined;
      const dataSource = execution === undefined
        ? {
            readBinary: async () => null,
            pathKind: async () => null,
            isContained: async () => true,
          }
        : {
            readBinary: execution.readBinary!,
            pathKind: execution.pathKind,
            isContained: async () => true,
          };
      const runtime = new ManagedVaultBridgeRuntime({
        vault: { name, path: vaultPath },
        settings: {
          load: async () => {
            try {
              return JSON.parse(await readFile(dataPath, "utf8")) as PersistedBridgeSettings;
            } catch {
              return undefined;
            }
          },
          save: async (settings) => {
            await mkdir(pluginDirectory, { recursive: true });
            await writeFile(dataPath, JSON.stringify(settings), "utf8");
          },
        },
        searchDataSource: {
          listMarkdownPaths: async () => ["note.md"],
          readBinary: async () => new TextEncoder().encode("needle\n"),
        },
        changeSetDataSource: dataSource,
        ...(execution === undefined ? {} : { changeSetExecution: execution }),
        createBridge: (bridgeOptions) => {
          const bridge = createBridgeInstance(bridgeOptions);
          harness.currentBridge = bridge;
          return bridge;
        },
        createVaultId: () => "vault-a",
        selectInitialPort: () => port,
      });
      liveRuntimes.push(runtime);
      return runtime;
    },
    async observeHealth() {
      const bridge = harness.currentBridge;
      if (bridge === undefined) throw new Error("No Bridge is running");
      return (await healthClient.observeHealth(bridge.endpoint, "vault-a")).health;
    },
    async submitChangeSet(submissionKey, path) {
      const bridge = harness.currentBridge;
      if (bridge === undefined) throw new Error("No Bridge is running");
      const client = new Client({ name: "purge-test", version: "1.0.0" });
      await client.connect(
        new StreamableHTTPClientTransport(bridge.endpoint, {
          requestInit: { headers: { "X-Expected-Vault-ID": "vault-a" } },
        }),
      );
      try {
        return await client.callTool({
          name: "vault_change_set_submit",
          arguments: {
            submissionKey,
            operations: [
              { operationId: "mkdir-1", kind: "create_directory", path, ifExists: "reject" },
            ],
          },
        });
      } finally {
        await client.close();
      }
    },
    async readPersistedState() {
      return JSON.parse(await readFile(dataPath, "utf8")) as Record<string, unknown>;
    },
  };
  return harness;
}

/** A schema-valid persisted registry entry fixture. */
function registryEntry(
  submissionKey: string,
  changeSetId: string,
  enqueueSeq: number,
  executionPhase: "queued" | "executing" | "terminal" | null,
  changeSetState: string,
): Record<string, unknown> {
  return {
    submissionKey,
    fingerprint: `sha256:${"0".repeat(64)}`,
    changeSetId,
    enqueueSeq,
    acceptedAt: 1_000,
    expiresAt: 1_000 + CHANGE_SET_RECORD_RETENTION_MS,
    ...(executionPhase === null
      ? {}
      : {
          execution: {
            phase: executionPhase,
            input: {
              submissionKey,
              operations: [
                { operationId: "mkdir-1", kind: "create_directory", path: "Keep", ifExists: "reject" },
              ],
            },
          },
        }),
    changeSet: { changeSetId, state: changeSetState },
  };
}

function persistedStateFixture(registry: Record<string, unknown> | undefined): string {
  return JSON.stringify({
    schemaVersion: 2,
    vaultId: "vault-a",
    port: 24_000,
    diagnosticPath: "diagnostics",
    ...(registry === undefined ? {} : { changeSets: registry }),
  });
}

function emptyRegistry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 2,
    nextEnqueueSeq: 1,
    entries: [],
    tombstones: [],
    ...overrides,
  };
}

function upgradeEvidenceFixture(
  outcome: ManagedVaultUpgradeEvidence["outcome"],
  vaultId = "vault-a",
): string {
  return `${JSON.stringify(
    {
      schemaVersion: UPGRADE_EVIDENCE_SCHEMA_VERSION,
      pluginId: PLUGIN_ID,
      vaultId,
      fromVersion: "0.7.0",
      toVersion: VERSION,
      bundleTag: `v${VERSION}`,
      outcome,
      completedPhases: [],
      preUpgradeQueue: { length: 0, headChangeSetId: null },
      rollbackCeiling: { persistentStateSchema: 2, changeSetRegistrySchema: 2 },
      failure: null,
      rollback: { attempted: false, restored: false, refused: null },
    } satisfies ManagedVaultUpgradeEvidence,
    null,
    2,
  )}\n`;
}

/** A schema-shaped live health observation fixture for seam-driven refusals. */
function liveHealthFixture(overrides: {
  queue?: Partial<ObservedHealth["queue"]>;
  recovery?: ObservedHealth["recovery"]["state"];
  gate?: ObservedHealth["effectiveGate"];
  vaultId?: string;
  port?: number;
}): ObservedHealth {
  return {
    outcome: "observed",
    vault: { id: overrides.vaultId ?? "vault-a", name: "vault-a", path: "/vaults/vault-a" },
    versions: {
      bridge: "0.8.0",
      plugin: VERSION,
      protocol: "1.0",
      persistentStateSchema: 2,
      recoveryJournalSchema: 3,
    },
    listener: { address: "127.0.0.1", port: overrides.port ?? 24_000 },
    readiness: { searchSnapshot: "ready", cache: "ready", index: "ready" },
    recovery: { state: overrides.recovery ?? "none" },
    write: { gate: "open", state: "writable", pauseSource: null },
    queue: {
      currentExecutionId: null,
      length: 0,
      headChangeSetId: null,
      ...overrides.queue,
    },
    lifecycle: { startup: "ready", upgrade: "not_run", migration: "not_run", recovery: "not_run" },
    effectiveGate: overrides.gate ?? null,
    overall: "healthy",
    reasonCodes: [],
    operatorAction: "none",
  };
}

/** Writes a Recovery Journal whose latest frame carries the given phase. */
async function writeJournal(stateDirectory: string, phase: "PREPARED" | "COMMITTED" | "FAILED") {
  await mkdir(stateDirectory, { recursive: true });
  const handle = await open(join(stateDirectory, "recovery-journal.bin"), "w+");
  try {
    const journal = await openRecoveryJournal(handle, { slotCapacity: 16 * 1024 });
    await journal.write({
      phase,
      payload: { schemaVersion: 3, changeSetId: "cs-journaled" },
    });
  } finally {
    await handle.close();
  }
}

async function managedFilesPresent(pluginDirectory: string): Promise<string[]> {
  const managed = new Set(["manifest.json", "main.js", "styles.css", RELEASE_MANAGED_CHECKSUM_FILE]);
  try {
    return (await readdir(pluginDirectory)).filter((entry) => managed.has(entry)).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

/** Backup directories created under a backup root (empty when none exist). */
async function backupDirectories(backupRoot: string): Promise<string[]> {
  try {
    return (await readdir(backupRoot)).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await readFile(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/** Installs the bundle and persists a drained, settled operational state. */
async function arrangeDrainedVault(root: string): Promise<VaultHarness> {
  const bundle = await verifiedBundle(root, `bundle-${Math.random().toString(36).slice(2)}`, VERSION);
  const harness = await arrangeVaultHarness(root, `vault-${Math.random().toString(36).slice(2)}`);
  const batch = await installReleaseToManagedVaults(bundle, [
    { vaultPath: harness.vaultPath, obsidianVersion: OBSIDIAN_VERSION },
  ]);
  expect(batch.targets[0]?.outcome).toBe("success");
  await writeFile(harness.dataPath, persistedStateFixture(emptyRegistry()), "utf8");
  await writeJournal(harness.stateDirectory, "COMMITTED");
  return harness;
}

const affirmingConfirm = async () => true;

describe("Managed Vault state purge (issue #201)", () => {
  it("purges a drained Vault after backup and confirmation: state gone, managed files and Vault content intact, rerun already_purged", async () => {
    const root = await mkdtemp(join(tmpdir(), "lifecycle-purge-"));
    const bundle = await verifiedBundle(root, "bundle", VERSION);
    const harness = await arrangeVaultHarness(root, "vault-a");
    const batch = await installReleaseToManagedVaults(bundle, [
      { vaultPath: harness.vaultPath, obsidianVersion: OBSIDIAN_VERSION },
    ]);
    expect(batch.targets[0]?.outcome).toBe("success");
    await writeFile(
      join(harness.vaultPath, ".obsidian", "community-plugins.json"),
      `${JSON.stringify([PLUGIN_ID])}\n`,
      "utf8",
    );

    // Real work drains through the real executor, leaving a terminal
    // idempotency record and a COMMITTED Recovery Journal frame.
    const runtime = await harness.createRuntime({ withExecutor: true });
    harness.currentRuntime = runtime;
    await runtime.load();
    const submitted = (await harness.submitChangeSet("purge-key-1", "KeptDir")) as {
      isError?: boolean;
    };
    expect(submitted.isError).not.toBe(true);
    await waitForCondition(async () => (await harness.observeHealth()).queue.length === 0, {
      timeoutMs: 10_000,
    });
    await runtime.unload();
    harness.currentRuntime = undefined;
    harness.currentBridge = undefined;

    const dataBefore = new Uint8Array(await readFile(harness.dataPath));
    const journalBefore = new Uint8Array(
      await readFile(join(harness.stateDirectory, "recovery-journal.bin")),
    );
    const confirmations: ManagedVaultPurgeConfirmation[] = [];
    const result = await purgeManagedVaultState({
      target: { vaultPath: harness.vaultPath, obsidianVersion: OBSIDIAN_VERSION },
      pluginId: PLUGIN_ID,
      backupDirectory: harness.backupRoot,
      confirm: async (confirmation) => {
        confirmations.push(confirmation);
        return true;
      },
    });

    expect(result.outcome).toBe("purged");
    expect(result.failure).toBeNull();
    expect(result.vaultId).toBe("vault-a");
    expect(result.remainingState).toEqual([]);
    expect(result.deletedFiles).toEqual([
      ".obsidian/plugins/purge-bridge/data.json",
      ".llm-wiki/recovery-journal.bin",
    ]);

    // The full inventory was enumerated before anything was written.
    expect(result.inventory?.vaultId).toBe("vault-a");
    expect(result.inventory?.port).toBe(harness.port);
    expect(result.inventory?.queue.changeSetRecords).toBe(1);
    expect(result.inventory?.queue.submissionKeyRecords).toBe(1);
    expect(result.inventory?.queue.pendingChangeSets).toBe(0);
    expect(result.inventory?.files.map((file) => file.kind).sort()).toEqual([
      "recovery_journal",
      "settings",
    ]);
    expect(result.inventory?.lostCapabilities).toEqual(PURGE_LOST_CAPABILITIES);

    // The confirmation was explicit and tied to this Managed Vault.
    expect(confirmations).toHaveLength(1);
    expect(confirmations[0]?.vaultPath).toBe(harness.vaultPath);
    expect(confirmations[0]?.vaultId).toBe("vault-a");
    expect(confirmations[0]?.pluginId).toBe(PLUGIN_ID);
    expect(confirmations[0]?.backup.verified).toBe(true);

    // The backup lives outside the removed state and re-verifies: every copy
    // hash-matches the byte that was deleted, and the manifest covers them.
    const backup = result.backup;
    expect(backup?.verified).toBe(true);
    expect(backup!.directory.startsWith(harness.backupRoot)).toBe(true);
    const backupInventory = JSON.parse(await readFile(backup!.inventoryPath, "utf8")) as {
      purpose: string;
      vaultId: string;
      port: number;
      lostCapabilities: { capability: string; detail: string }[];
      files: { backupPath: string; sha256: string }[];
    };
    expect(backupInventory.purpose).toBe("managed-vault-purge-backup");
    expect(backupInventory.vaultId).toBe("vault-a");
    expect(backupInventory.port).toBe(harness.port);
    expect(backupInventory.lostCapabilities.map((entry) => entry.capability)).toEqual(
      PURGE_LOST_CAPABILITIES,
    );
    const manifestText = await readFile(backup!.checksumManifestPath, "utf8");
    const manifestLines = manifestText.trimEnd().split("\n");
    expect(manifestLines).toHaveLength(3);
    const backedUpSettings = new Uint8Array(
      await readFile(join(backup!.directory, "files/.obsidian/plugins/purge-bridge/data.json")),
    );
    const backedUpJournal = new Uint8Array(
      await readFile(join(backup!.directory, "files/.llm-wiki/recovery-journal.bin")),
    );
    expect(digest(backedUpSettings)).toBe(digest(dataBefore));
    expect(digest(backedUpJournal)).toBe(digest(journalBefore));
    for (const file of backup!.files) {
      expect(manifestText).toContain(`${file.sha256}  ${file.backupPath}`);
    }

    // Only the enumerated operational state was removed: the release-managed
    // files, the enablement record, and every byte of Vault content survive.
    expect(await pathExists(harness.dataPath)).toBe(false);
    expect(await pathExists(join(harness.stateDirectory, "recovery-journal.bin"))).toBe(false);
    expect(await managedFilesPresent(harness.pluginDirectory)).toEqual([
      RELEASE_MANAGED_CHECKSUM_FILE,
      "main.js",
      "manifest.json",
    ]);
    expect(await readFile(join(harness.vaultPath, "note.md"), "utf8")).toBe("needle\n");
    expect(await readFile(join(harness.vaultPath, ".obsidian", "community-plugins.json"), "utf8")).toBe(
      `${JSON.stringify([PLUGIN_ID])}\n`,
    );

    // Deterministic rerun: already purged, no new backup, no confirmation.
    const rerun = await purgeManagedVaultState({
      target: { vaultPath: harness.vaultPath, obsidianVersion: OBSIDIAN_VERSION },
      pluginId: PLUGIN_ID,
      backupDirectory: harness.backupRoot,
    });
    expect(rerun.outcome).toBe("already_purged");
    expect(rerun.failure).toBeNull();
    expect(rerun.backup).toBeNull();
    expect(await backupDirectories(harness.backupRoot)).toHaveLength(1);
  });

  it("refuses non-interactive execution: no confirmation seam, nothing deleted, verified backup retained and reported", async () => {
    const root = await mkdtemp(join(tmpdir(), "lifecycle-purge-"));
    const harness = await arrangeDrainedVault(root);
    const dataBefore = await readFile(harness.dataPath, "utf8");

    const result = await purgeManagedVaultState({
      target: { vaultPath: harness.vaultPath, obsidianVersion: OBSIDIAN_VERSION },
      pluginId: PLUGIN_ID,
      backupDirectory: harness.backupRoot,
    });

    expect(result.outcome).toBe("refused");
    expect(result.failure?.code).toBe("purge_confirmation_required");
    expect(result.inventory).not.toBeNull();
    expect(result.backup?.verified).toBe(true);
    expect(await pathExists(result.backup!.checksumManifestPath)).toBe(true);
    // Nothing was deleted.
    expect(await readFile(harness.dataPath, "utf8")).toBe(dataBefore);
    expect(await pathExists(join(harness.stateDirectory, "recovery-journal.bin"))).toBe(true);
    expect(await backupDirectories(harness.backupRoot)).toHaveLength(1);

    // A later confirmed run completes deterministically.
    const confirmed = await purgeManagedVaultState({
      target: { vaultPath: harness.vaultPath, obsidianVersion: OBSIDIAN_VERSION },
      pluginId: PLUGIN_ID,
      backupDirectory: harness.backupRoot,
      confirm: affirmingConfirm,
    });
    expect(confirmed.outcome).toBe("purged");
  });

  it("refuses when the operator cancels or the confirmation interaction fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "lifecycle-purge-"));
    const cancelledHarness = await arrangeDrainedVault(root);
    const dataBefore = await readFile(cancelledHarness.dataPath, "utf8");

    const cancelled = await purgeManagedVaultState({
      target: { vaultPath: cancelledHarness.vaultPath, obsidianVersion: OBSIDIAN_VERSION },
      pluginId: PLUGIN_ID,
      backupDirectory: cancelledHarness.backupRoot,
      confirm: async () => false,
    });
    expect(cancelled.outcome).toBe("refused");
    expect(cancelled.failure?.code).toBe("purge_confirmation_declined");
    expect(cancelled.backup?.verified).toBe(true);
    expect(await readFile(cancelledHarness.dataPath, "utf8")).toBe(dataBefore);
    expect(await pathExists(join(cancelledHarness.stateDirectory, "recovery-journal.bin"))).toBe(true);

    const failedInteraction = await arrangeDrainedVault(root);
    const thrown = await purgeManagedVaultState({
      target: { vaultPath: failedInteraction.vaultPath, obsidianVersion: OBSIDIAN_VERSION },
      pluginId: PLUGIN_ID,
      backupDirectory: failedInteraction.backupRoot,
      confirm: async () => {
        throw new Error("operator console closed");
      },
    });
    expect(thrown.outcome).toBe("refused");
    expect(thrown.failure?.code).toBe("purge_confirmation_declined");
    expect(thrown.failure?.detail).toContain("operator console closed");
    expect(await pathExists(join(failedInteraction.stateDirectory, "recovery-journal.bin"))).toBe(true);
  });

  it("blocks deletion when the written backup is corrupt or incomplete; retry purges deterministically", async () => {
    const root = await mkdtemp(join(tmpdir(), "lifecycle-purge-"));
    const harness = await arrangeDrainedVault(root);
    const dataBefore = await readFile(harness.dataPath, "utf8");

    // Fault injection: a backup copy is corrupted after the write, before
    // re-verification. The verification must catch it and change nothing.
    const corrupted = await purgeManagedVaultState({
      target: { vaultPath: harness.vaultPath, obsidianVersion: OBSIDIAN_VERSION },
      pluginId: PLUGIN_ID,
      backupDirectory: harness.backupRoot,
      confirm: affirmingConfirm,
      hooks: {
        afterBackupWritten: async ({ backupDirectory }) => {
          await writeFile(
            join(backupDirectory, "files/.obsidian/plugins/purge-bridge/data.json"),
            "tampered",
            "utf8",
          );
        },
      },
    });
    expect(corrupted.outcome).toBe("failed");
    expect(corrupted.failure?.code).toBe("purge_backup_verification_failed");
    expect(await readFile(harness.dataPath, "utf8")).toBe(dataBefore);
    expect(await pathExists(join(harness.stateDirectory, "recovery-journal.bin"))).toBe(true);

    // Fault injection: a backup copy is missing entirely (incomplete backup).
    const incomplete = await purgeManagedVaultState({
      target: { vaultPath: harness.vaultPath, obsidianVersion: OBSIDIAN_VERSION },
      pluginId: PLUGIN_ID,
      backupDirectory: harness.backupRoot,
      confirm: affirmingConfirm,
      hooks: {
        afterBackupWritten: async ({ backupDirectory }) => {
          const { rm } = await import("node:fs/promises");
          await rm(join(backupDirectory, "files/.llm-wiki/recovery-journal.bin"));
        },
      },
    });
    expect(incomplete.outcome).toBe("failed");
    expect(incomplete.failure?.code).toBe("purge_backup_verification_failed");
    expect(await readFile(harness.dataPath, "utf8")).toBe(dataBefore);

    // The honest retry purges.
    const retry = await purgeManagedVaultState({
      target: { vaultPath: harness.vaultPath, obsidianVersion: OBSIDIAN_VERSION },
      pluginId: PLUGIN_ID,
      backupDirectory: harness.backupRoot,
      confirm: affirmingConfirm,
    });
    expect(retry.outcome).toBe("purged");
    expect(await pathExists(harness.dataPath)).toBe(false);
  });

  it("reports a backup that cannot be written as failed, never as purged", async () => {
    const root = await mkdtemp(join(tmpdir(), "lifecycle-purge-"));
    const harness = await arrangeDrainedVault(root);
    const dataBefore = await readFile(harness.dataPath, "utf8");

    // The backup location is an existing file: no backup directory can be
    // created underneath it.
    const fileBackupRoot = join(root, "backup-file");
    await writeFile(fileBackupRoot, "not a directory\n", "utf8");
    const result = await purgeManagedVaultState({
      target: { vaultPath: harness.vaultPath, obsidianVersion: OBSIDIAN_VERSION },
      pluginId: PLUGIN_ID,
      backupDirectory: fileBackupRoot,
      confirm: affirmingConfirm,
    });
    expect(result.outcome).toBe("failed");
    expect(result.failure?.code).toBe("purge_backup_failed");
    expect(result.backup).toBeNull();
    expect(await readFile(harness.dataPath, "utf8")).toBe(dataBefore);

    // A backup-directory name collision (deterministic nonce seam) also fails.
    const collision = await arrangeDrainedVault(root);
    await mkdir(join(collision.backupRoot, "purge-backup-fixed"), { recursive: true });
    const collided = await purgeManagedVaultState({
      target: { vaultPath: collision.vaultPath, obsidianVersion: OBSIDIAN_VERSION },
      pluginId: PLUGIN_ID,
      backupDirectory: collision.backupRoot,
      confirm: affirmingConfirm,
      nonce: () => "fixed",
    });
    expect(collided.outcome).toBe("failed");
    expect(collided.failure?.code).toBe("purge_backup_failed");
  });

  it("refuses while a Change Set is executing — live or persisted — and writes no backup", async () => {
    const root = await mkdtemp(join(tmpdir(), "lifecycle-purge-"));
    const bundle = await verifiedBundle(root, "bundle", VERSION);
    const harness = await arrangeVaultHarness(root, "vault-a");
    await installReleaseToManagedVaults(bundle, [
      { vaultPath: harness.vaultPath, obsidianVersion: OBSIDIAN_VERSION },
    ]);
    await writeFile(
      harness.dataPath,
      persistedStateFixture(
        emptyRegistry({
          nextEnqueueSeq: 2,
          entries: [registryEntry("key-exec", "cs-exec", 1, "executing", "in_progress")],
        }),
      ),
      "utf8",
    );
    await writeJournal(harness.stateDirectory, "COMMITTED");

    const persistedRefusal = await purgeManagedVaultState({
      target: { vaultPath: harness.vaultPath, obsidianVersion: OBSIDIAN_VERSION },
      pluginId: PLUGIN_ID,
      backupDirectory: harness.backupRoot,
      confirm: affirmingConfirm,
    });
    expect(persistedRefusal.outcome).toBe("refused");
    expect(persistedRefusal.failure?.code).toBe("purge_change_set_executing");
    expect(persistedRefusal.backup).toBeNull();
    expect(await backupDirectories(harness.backupRoot)).toEqual([]);
    expect(await pathExists(harness.dataPath)).toBe(true);

    const liveRefusal = await purgeManagedVaultState({
      target: { vaultPath: harness.vaultPath, obsidianVersion: OBSIDIAN_VERSION },
      pluginId: PLUGIN_ID,
      backupDirectory: harness.backupRoot,
      confirm: affirmingConfirm,
      observeHealth: async () =>
        liveHealthFixture({
          queue: { currentExecutionId: "cs-exec", length: 1, headChangeSetId: "cs-exec" },
        }),
    });
    expect(liveRefusal.outcome).toBe("refused");
    expect(liveRefusal.failure?.code).toBe("purge_change_set_executing");
  });

  it("refuses while work is queued — through the real MCP surface and offline persisted evidence", async () => {
    const root = await mkdtemp(join(tmpdir(), "lifecycle-purge-"));
    const bundle = await verifiedBundle(root, "bundle", VERSION);
    const harness = await arrangeVaultHarness(root, "vault-a");
    await installReleaseToManagedVaults(bundle, [
      { vaultPath: harness.vaultPath, obsidianVersion: OBSIDIAN_VERSION },
    ]);
    const runtime = await harness.createRuntime();
    harness.currentRuntime = runtime;
    await runtime.load();
    const submitted = (await harness.submitChangeSet("queued-key", "QueuedDir")) as {
      isError?: boolean;
    };
    expect(submitted.isError).not.toBe(true);

    // Live refusal: the running Bridge reports a non-empty FIFO.
    const liveRefusal = await purgeManagedVaultState({
      target: { vaultPath: harness.vaultPath, obsidianVersion: OBSIDIAN_VERSION },
      pluginId: PLUGIN_ID,
      backupDirectory: harness.backupRoot,
      confirm: affirmingConfirm,
      observeHealth: harness.observeHealth,
    });
    expect(liveRefusal.outcome).toBe("refused");
    expect(liveRefusal.failure?.code).toBe("purge_work_queued");
    expect(liveRefusal.inventory?.queue.pendingChangeSets).toBe(1);

    // Offline refusal: the persisted registry alone proves the queue non-empty.
    await runtime.unload();
    harness.currentRuntime = undefined;
    harness.currentBridge = undefined;
    const offlineRefusal = await purgeManagedVaultState({
      target: { vaultPath: harness.vaultPath, obsidianVersion: OBSIDIAN_VERSION },
      pluginId: PLUGIN_ID,
      backupDirectory: harness.backupRoot,
      confirm: affirmingConfirm,
    });
    expect(offlineRefusal.outcome).toBe("refused");
    expect(offlineRefusal.failure?.code).toBe("purge_work_queued");
    expect(await backupDirectories(harness.backupRoot)).toEqual([]);
    expect(await pathExists(harness.dataPath)).toBe(true);
  });

  it("refuses when the Recovery Journal has a pending or failed frame", async () => {
    const root = await mkdtemp(join(tmpdir(), "lifecycle-purge-"));
    const bundle = await verifiedBundle(root, "bundle", VERSION);
    const harness = await arrangeVaultHarness(root, "vault-a");
    await installReleaseToManagedVaults(bundle, [
      { vaultPath: harness.vaultPath, obsidianVersion: OBSIDIAN_VERSION },
    ]);
    await writeFile(harness.dataPath, persistedStateFixture(emptyRegistry()), "utf8");

    await writeJournal(harness.stateDirectory, "PREPARED");
    const prepared = await purgeManagedVaultState({
      target: { vaultPath: harness.vaultPath, obsidianVersion: OBSIDIAN_VERSION },
      pluginId: PLUGIN_ID,
      backupDirectory: harness.backupRoot,
      confirm: affirmingConfirm,
    });
    expect(prepared.outcome).toBe("refused");
    expect(prepared.failure?.code).toBe("purge_recovery_untrusted");
    expect(prepared.failure?.detail).toContain("PREPARED");

    await writeJournal(harness.stateDirectory, "FAILED");
    const failed = await purgeManagedVaultState({
      target: { vaultPath: harness.vaultPath, obsidianVersion: OBSIDIAN_VERSION },
      pluginId: PLUGIN_ID,
      backupDirectory: harness.backupRoot,
      confirm: affirmingConfirm,
    });
    expect(failed.outcome).toBe("refused");
    expect(failed.failure?.code).toBe("purge_recovery_untrusted");

    // A terminal frame settles the journal: COMMITTED does not block a
    // confirmed purge.
    await writeJournal(harness.stateDirectory, "COMMITTED");
    const settled = await purgeManagedVaultState({
      target: { vaultPath: harness.vaultPath, obsidianVersion: OBSIDIAN_VERSION },
      pluginId: PLUGIN_ID,
      backupDirectory: harness.backupRoot,
      confirm: affirmingConfirm,
    });
    expect(settled.outcome).toBe("purged");
  });

  it("refuses on every untrusted persisted recovery state", async () => {
    const root = await mkdtemp(join(tmpdir(), "lifecycle-purge-"));
    const bundle = await verifiedBundle(root, "bundle", VERSION);
    const cases: { name: string; registry: Record<string, unknown> }[] = [
      {
        name: "result_unproven record",
        registry: emptyRegistry({
          nextEnqueueSeq: 2,
          entries: [registryEntry("key-unproven", "cs-unproven", 1, "terminal", "result_unproven")],
        }),
      },
      {
        name: "maintenance_pending write mode",
        registry: emptyRegistry({ writeMode: "maintenance_pending" }),
      },
      {
        name: "maintenance_failed write mode",
        registry: emptyRegistry({ writeMode: "maintenance_failed" }),
      },
      {
        name: "failed upgrade lifecycle",
        registry: emptyRegistry({ lifecycle: { upgrade: "failed", migration: "failed" } }),
      },
    ];
    for (const [index, entry] of cases.entries()) {
      const harness = await arrangeVaultHarness(root, `vault-${index}`);
      await installReleaseToManagedVaults(bundle, [
        { vaultPath: harness.vaultPath, obsidianVersion: OBSIDIAN_VERSION },
      ]);
      await writeFile(harness.dataPath, persistedStateFixture(entry.registry), "utf8");

      const result = await purgeManagedVaultState({
        target: { vaultPath: harness.vaultPath, obsidianVersion: OBSIDIAN_VERSION },
        pluginId: PLUGIN_ID,
        backupDirectory: harness.backupRoot,
        confirm: affirmingConfirm,
      });
      expect(result.outcome, entry.name).toBe("refused");
      expect(result.failure?.code, entry.name).toBe("purge_recovery_untrusted");
      expect(await backupDirectories(harness.backupRoot), entry.name).toEqual([]);
      expect(await pathExists(harness.dataPath), entry.name).toBe(true);
    }
  });

  it("refuses while upgrade evidence records an interrupted, failed, or rolled-back upgrade", async () => {
    const root = await mkdtemp(join(tmpdir(), "lifecycle-purge-"));
    const bundle = await verifiedBundle(root, "bundle", VERSION);
    const harness = await arrangeVaultHarness(root, "vault-a");
    await installReleaseToManagedVaults(bundle, [
      { vaultPath: harness.vaultPath, obsidianVersion: OBSIDIAN_VERSION },
    ]);
    await writeFile(harness.dataPath, persistedStateFixture(emptyRegistry()), "utf8");
    const evidencePath = join(harness.pluginDirectory, UPGRADE_EVIDENCE_FILENAME);

    for (const outcome of ["in_progress", "failed", "rolled_back"] as const) {
      await writeFile(evidencePath, upgradeEvidenceFixture(outcome), "utf8");
      const result = await purgeManagedVaultState({
        target: { vaultPath: harness.vaultPath, obsidianVersion: OBSIDIAN_VERSION },
        pluginId: PLUGIN_ID,
        backupDirectory: harness.backupRoot,
        confirm: affirmingConfirm,
      });
      expect(result.outcome, outcome).toBe("refused");
      expect(result.failure?.code, outcome).toBe("purge_recovery_untrusted");
    }

    // A succeeded upgrade is settled evidence and does not block a confirmed purge.
    await writeFile(evidencePath, upgradeEvidenceFixture("succeeded"), "utf8");
    const settled = await purgeManagedVaultState({
      target: { vaultPath: harness.vaultPath, obsidianVersion: OBSIDIAN_VERSION },
      pluginId: PLUGIN_ID,
      backupDirectory: harness.backupRoot,
      confirm: affirmingConfirm,
    });
    expect(settled.outcome).toBe("purged");
    // The purge removes only the enumerated state: upgrade evidence, managed
    // files, and other plugins' storage survive.
    expect(await pathExists(evidencePath)).toBe(true);
    expect(await managedFilesPresent(harness.pluginDirectory)).toHaveLength(3);
  });

  it("refuses on missing, malformed, or contradictory evidence — never a pass", async () => {
    const root = await mkdtemp(join(tmpdir(), "lifecycle-purge-"));
    const bundle = await verifiedBundle(root, "bundle", VERSION);

    // Malformed persisted settings.
    {
      const harness = await arrangeVaultHarness(root, "vault-bad-json");
      await installReleaseToManagedVaults(bundle, [
        { vaultPath: harness.vaultPath, obsidianVersion: OBSIDIAN_VERSION },
      ]);
      await writeFile(harness.dataPath, "{ not json", "utf8");
      const result = await purgeManagedVaultState({
        target: { vaultPath: harness.vaultPath, obsidianVersion: OBSIDIAN_VERSION },
        pluginId: PLUGIN_ID,
        backupDirectory: harness.backupRoot,
        confirm: affirmingConfirm,
      });
      expect(result.outcome).toBe("refused");
      expect(result.failure?.code).toBe("purge_evidence_contradictory");
    }

    // Persisted settings without a valid Vault identity.
    {
      const harness = await arrangeVaultHarness(root, "vault-bad-shape");
      await installReleaseToManagedVaults(bundle, [
        { vaultPath: harness.vaultPath, obsidianVersion: OBSIDIAN_VERSION },
      ]);
      await writeFile(harness.dataPath, JSON.stringify({ schemaVersion: 2 }), "utf8");
      const result = await purgeManagedVaultState({
        target: { vaultPath: harness.vaultPath, obsidianVersion: OBSIDIAN_VERSION },
        pluginId: PLUGIN_ID,
        backupDirectory: harness.backupRoot,
        confirm: affirmingConfirm,
      });
      expect(result.outcome).toBe("refused");
      expect(result.failure?.code).toBe("purge_evidence_contradictory");
    }

    // Malformed upgrade evidence: corrupted fail-closed evidence is never a clean slate.
    {
      const harness = await arrangeVaultHarness(root, "vault-bad-upgrade");
      await installReleaseToManagedVaults(bundle, [
        { vaultPath: harness.vaultPath, obsidianVersion: OBSIDIAN_VERSION },
      ]);
      await writeFile(harness.dataPath, persistedStateFixture(emptyRegistry()), "utf8");
      await writeFile(
        join(harness.pluginDirectory, UPGRADE_EVIDENCE_FILENAME),
        "{ torn",
        "utf8",
      );
      const result = await purgeManagedVaultState({
        target: { vaultPath: harness.vaultPath, obsidianVersion: OBSIDIAN_VERSION },
        pluginId: PLUGIN_ID,
        backupDirectory: harness.backupRoot,
        confirm: affirmingConfirm,
      });
      expect(result.outcome).toBe("refused");
      expect(result.failure?.code).toBe("purge_evidence_contradictory");
    }

    // Upgrade evidence contradicting the persisted Vault identity.
    {
      const harness = await arrangeVaultHarness(root, "vault-id-mismatch");
      await installReleaseToManagedVaults(bundle, [
        { vaultPath: harness.vaultPath, obsidianVersion: OBSIDIAN_VERSION },
      ]);
      await writeFile(harness.dataPath, persistedStateFixture(emptyRegistry()), "utf8");
      await writeFile(
        join(harness.pluginDirectory, UPGRADE_EVIDENCE_FILENAME),
        upgradeEvidenceFixture("succeeded", "vault-other"),
        "utf8",
      );
      const result = await purgeManagedVaultState({
        target: { vaultPath: harness.vaultPath, obsidianVersion: OBSIDIAN_VERSION },
        pluginId: PLUGIN_ID,
        backupDirectory: harness.backupRoot,
        confirm: affirmingConfirm,
      });
      expect(result.outcome).toBe("refused");
      expect(result.failure?.code).toBe("purge_evidence_contradictory");
    }

    // A live Bridge answering without any persisted identity.
    {
      const harness = await arrangeVaultHarness(root, "vault-ghost");
      await installReleaseToManagedVaults(bundle, [
        { vaultPath: harness.vaultPath, obsidianVersion: OBSIDIAN_VERSION },
      ]);
      // A journal exists so this Vault is not already_purged.
      await writeJournal(harness.stateDirectory, "COMMITTED");
      const result = await purgeManagedVaultState({
        target: { vaultPath: harness.vaultPath, obsidianVersion: OBSIDIAN_VERSION },
        pluginId: PLUGIN_ID,
        backupDirectory: harness.backupRoot,
        confirm: affirmingConfirm,
        observeHealth: async () => liveHealthFixture({}),
      });
      expect(result.outcome).toBe("refused");
      expect(result.failure?.code).toBe("purge_evidence_contradictory");
    }

    // Live identity contradicting the persisted identity.
    {
      const harness = await arrangeVaultHarness(root, "vault-live-mismatch");
      await installReleaseToManagedVaults(bundle, [
        { vaultPath: harness.vaultPath, obsidianVersion: OBSIDIAN_VERSION },
      ]);
      await writeFile(harness.dataPath, persistedStateFixture(emptyRegistry()), "utf8");
      const result = await purgeManagedVaultState({
        target: { vaultPath: harness.vaultPath, obsidianVersion: OBSIDIAN_VERSION },
        pluginId: PLUGIN_ID,
        backupDirectory: harness.backupRoot,
        confirm: affirmingConfirm,
        observeHealth: async () => liveHealthFixture({ vaultId: "vault-foreign" }),
      });
      expect(result.outcome).toBe("refused");
      expect(result.failure?.code).toBe("purge_evidence_contradictory");
    }

    // A failed live observation is unavailable evidence, never a pass.
    {
      const harness = await arrangeVaultHarness(root, "vault-unreachable");
      await installReleaseToManagedVaults(bundle, [
        { vaultPath: harness.vaultPath, obsidianVersion: OBSIDIAN_VERSION },
      ]);
      await writeFile(harness.dataPath, persistedStateFixture(emptyRegistry()), "utf8");
      const result = await purgeManagedVaultState({
        target: { vaultPath: harness.vaultPath, obsidianVersion: OBSIDIAN_VERSION },
        pluginId: PLUGIN_ID,
        backupDirectory: harness.backupRoot,
        confirm: affirmingConfirm,
        observeHealth: async () => {
          throw new Error("connection reset");
        },
      });
      expect(result.outcome).toBe("refused");
      expect(result.failure?.code).toBe("purge_evidence_unavailable");
    }

    // An unreadable Recovery Journal is unavailable evidence.
    {
      const harness = await arrangeVaultHarness(root, "vault-bad-journal");
      await installReleaseToManagedVaults(bundle, [
        { vaultPath: harness.vaultPath, obsidianVersion: OBSIDIAN_VERSION },
      ]);
      await writeFile(harness.dataPath, persistedStateFixture(emptyRegistry()), "utf8");
      await mkdir(harness.stateDirectory, { recursive: true });
      await writeFile(join(harness.stateDirectory, "recovery-journal.bin"), "not a journal", "utf8");
      const result = await purgeManagedVaultState({
        target: { vaultPath: harness.vaultPath, obsidianVersion: OBSIDIAN_VERSION },
        pluginId: PLUGIN_ID,
        backupDirectory: harness.backupRoot,
        confirm: affirmingConfirm,
      });
      expect(result.outcome).toBe("refused");
      expect(result.failure?.code).toBe("purge_evidence_unavailable");
    }
  });

  it("refuses on untrusted live recovery evidence", async () => {
    const root = await mkdtemp(join(tmpdir(), "lifecycle-purge-"));
    const bundle = await verifiedBundle(root, "bundle", VERSION);
    const harness = await arrangeVaultHarness(root, "vault-a");
    await installReleaseToManagedVaults(bundle, [
      { vaultPath: harness.vaultPath, obsidianVersion: OBSIDIAN_VERSION },
    ]);
    await writeFile(harness.dataPath, persistedStateFixture(emptyRegistry()), "utf8");

    for (const health of [
      liveHealthFixture({ recovery: "in_progress" }),
      liveHealthFixture({ recovery: "blocked" }),
      liveHealthFixture({ gate: { code: "recovery_blocked" } }),
      liveHealthFixture({ gate: { code: "upgrade_in_progress" } }),
    ]) {
      const result = await purgeManagedVaultState({
        target: { vaultPath: harness.vaultPath, obsidianVersion: OBSIDIAN_VERSION },
        pluginId: PLUGIN_ID,
        backupDirectory: harness.backupRoot,
        confirm: affirmingConfirm,
        observeHealth: async () => health,
      });
      expect(result.outcome).toBe("refused");
      expect(result.failure?.code).toBe("purge_recovery_untrusted");
    }
  });

  it("reports an interrupted pre-deletion hook as failed and completes on confirmed rerun", async () => {
    const root = await mkdtemp(join(tmpdir(), "lifecycle-purge-"));
    const harness = await arrangeDrainedVault(root);
    const dataBefore = await readFile(harness.dataPath, "utf8");

    const interrupted: ManagedVaultPurgeResult = await purgeManagedVaultState({
      target: { vaultPath: harness.vaultPath, obsidianVersion: OBSIDIAN_VERSION },
      pluginId: PLUGIN_ID,
      backupDirectory: harness.backupRoot,
      confirm: affirmingConfirm,
      hooks: {
        afterConfirmation: () => {
          throw new InstallInterruptionError("simulated process kill before deletion");
        },
      },
    });
    expect(interrupted.outcome).toBe("failed");
    expect(interrupted.failure?.code).toBe("purge_interrupted");
    // Nothing was deleted; the backup disposition is reported for the retry.
    expect(interrupted.remainingState).toEqual([
      ".obsidian/plugins/purge-bridge/data.json",
      ".llm-wiki/recovery-journal.bin",
    ]);
    expect(interrupted.backup?.verified).toBe(true);
    expect(await readFile(harness.dataPath, "utf8")).toBe(dataBefore);

    const rerun = await purgeManagedVaultState({
      target: { vaultPath: harness.vaultPath, obsidianVersion: OBSIDIAN_VERSION },
      pluginId: PLUGIN_ID,
      backupDirectory: harness.backupRoot,
      confirm: affirmingConfirm,
    });
    expect(rerun.outcome).toBe("purged");
    expect(await pathExists(harness.dataPath)).toBe(false);
  });

  it("surfaces a partial deletion failure with the remaining state, then reruns to completion", async () => {
    const root = await mkdtemp(join(tmpdir(), "lifecycle-purge-"));
    const harness = await arrangeDrainedVault(root);

    // Fault injection: the deletion seam removes one file, then faults.
    const partial = await purgeManagedVaultState({
      target: { vaultPath: harness.vaultPath, obsidianVersion: OBSIDIAN_VERSION },
      pluginId: PLUGIN_ID,
      backupDirectory: harness.backupRoot,
      confirm: affirmingConfirm,
      deleteStateFile: async (path) => {
        if (path.endsWith("data.json")) {
          const { rm } = await import("node:fs/promises");
          await rm(path, { force: true });
          return;
        }
        throw new Error("EACCES: permission denied");
      },
    });
    expect(partial.outcome).toBe("failed");
    expect(partial.failure?.code).toBe("purge_deletion_failed");
    expect(partial.deletedFiles).toEqual([".obsidian/plugins/purge-bridge/data.json"]);
    expect(partial.remainingState).toEqual([".llm-wiki/recovery-journal.bin"]);
    expect(partial.backup?.verified).toBe(true);
    expect(await pathExists(harness.dataPath)).toBe(false);
    expect(await pathExists(join(harness.stateDirectory, "recovery-journal.bin"))).toBe(true);

    // The retry enumerates the remaining state, backs it up, and purges it.
    const rerun = await purgeManagedVaultState({
      target: { vaultPath: harness.vaultPath, obsidianVersion: OBSIDIAN_VERSION },
      pluginId: PLUGIN_ID,
      backupDirectory: harness.backupRoot,
      confirm: affirmingConfirm,
    });
    expect(rerun.outcome).toBe("purged");
    expect(rerun.deletedFiles).toEqual([".llm-wiki/recovery-journal.bin"]);
    expect(await pathExists(join(harness.stateDirectory, "recovery-journal.bin"))).toBe(false);

    // A further rerun is deterministic.
    const third = await purgeManagedVaultState({
      target: { vaultPath: harness.vaultPath, obsidianVersion: OBSIDIAN_VERSION },
      pluginId: PLUGIN_ID,
      backupDirectory: harness.backupRoot,
      confirm: affirmingConfirm,
    });
    expect(third.outcome).toBe("already_purged");
  });

  it("fails when deletion claims success but enumerated state survives; the backup disposition is reported", async () => {
    const root = await mkdtemp(join(tmpdir(), "lifecycle-purge-"));
    const harness = await arrangeDrainedVault(root);
    const dataBefore = await readFile(harness.dataPath, "utf8");

    const result = await purgeManagedVaultState({
      target: { vaultPath: harness.vaultPath, obsidianVersion: OBSIDIAN_VERSION },
      pluginId: PLUGIN_ID,
      backupDirectory: harness.backupRoot,
      confirm: affirmingConfirm,
      deleteStateFile: async () => undefined,
    });
    expect(result.outcome).toBe("failed");
    expect(result.failure?.code).toBe("purge_deletion_failed");
    expect(result.failure?.detail).toContain("data.json");
    expect(result.remainingState).toEqual([
      ".obsidian/plugins/purge-bridge/data.json",
      ".llm-wiki/recovery-journal.bin",
    ]);
    expect(result.backup?.verified).toBe(true);
    // A failed purge never masquerades as complete: nothing was deleted.
    expect(await readFile(harness.dataPath, "utf8")).toBe(dataBefore);
    expect(await pathExists(join(harness.stateDirectory, "recovery-journal.bin"))).toBe(true);

    const rerun = await purgeManagedVaultState({
      target: { vaultPath: harness.vaultPath, obsidianVersion: OBSIDIAN_VERSION },
      pluginId: PLUGIN_ID,
      backupDirectory: harness.backupRoot,
      confirm: affirmingConfirm,
    });
    expect(rerun.outcome).toBe("purged");
  });

  it("reports already_purged for a Vault with no operational state without backup or confirmation", async () => {
    const root = await mkdtemp(join(tmpdir(), "lifecycle-purge-"));
    const bundle = await verifiedBundle(root, "bundle", VERSION);
    const harness = await arrangeVaultHarness(root, "vault-a");
    await installReleaseToManagedVaults(bundle, [
      { vaultPath: harness.vaultPath, obsidianVersion: OBSIDIAN_VERSION },
    ]);

    let confirmCalled = false;
    const result = await purgeManagedVaultState({
      target: { vaultPath: harness.vaultPath, obsidianVersion: OBSIDIAN_VERSION },
      pluginId: PLUGIN_ID,
      backupDirectory: harness.backupRoot,
      confirm: async () => {
        confirmCalled = true;
        return true;
      },
    });
    expect(result.outcome).toBe("already_purged");
    expect(result.failure).toBeNull();
    expect(result.vaultId).toBeNull();
    expect(result.inventory).toBeNull();
    expect(result.backup).toBeNull();
    expect(confirmCalled).toBe(false);
    expect(await backupDirectories(harness.backupRoot)).toEqual([]);
    // The managed files are untouched: purge is not uninstall.
    expect(await managedFilesPresent(harness.pluginDirectory)).toHaveLength(3);
  });

  it("purges journal-only state when no settings file exists", async () => {
    const root = await mkdtemp(join(tmpdir(), "lifecycle-purge-"));
    const bundle = await verifiedBundle(root, "bundle", VERSION);
    const harness = await arrangeVaultHarness(root, "vault-a");
    await installReleaseToManagedVaults(bundle, [
      { vaultPath: harness.vaultPath, obsidianVersion: OBSIDIAN_VERSION },
    ]);
    await writeJournal(harness.stateDirectory, "COMMITTED");

    const result = await purgeManagedVaultState({
      target: { vaultPath: harness.vaultPath, obsidianVersion: OBSIDIAN_VERSION },
      pluginId: PLUGIN_ID,
      backupDirectory: harness.backupRoot,
      confirm: affirmingConfirm,
    });
    expect(result.outcome).toBe("purged");
    expect(result.vaultId).toBeNull();
    expect(result.inventory?.vaultId).toBeNull();
    expect(result.inventory?.files.map((file) => file.kind)).toEqual(["recovery_journal"]);
    expect(result.deletedFiles).toEqual([".llm-wiki/recovery-journal.bin"]);
    expect(await pathExists(join(harness.stateDirectory, "recovery-journal.bin"))).toBe(false);
    const backedUp = await readFile(
      join(result.backup!.directory, "files/.llm-wiki/recovery-journal.bin"),
    );
    expect(backedUp.length).toBeGreaterThan(0);
  });

  it("rejects unsafe Vault and backup paths as contract violations", async () => {
    const root = await mkdtemp(join(tmpdir(), "lifecycle-purge-"));
    const harness = await arrangeDrainedVault(root);

    await expect(
      purgeManagedVaultState({
        target: { vaultPath: "relative/vault" },
        pluginId: PLUGIN_ID,
        backupDirectory: harness.backupRoot,
        confirm: affirmingConfirm,
      }),
    ).rejects.toMatchObject({ name: "ReleasePurgeError", code: "purge_path_unsafe" });

    // A backup inside the Vault would not survive as an external artifact.
    await expect(
      purgeManagedVaultState({
        target: { vaultPath: harness.vaultPath },
        pluginId: PLUGIN_ID,
        backupDirectory: join(harness.vaultPath, "backups"),
        confirm: affirmingConfirm,
      }),
    ).rejects.toMatchObject({ code: "purge_path_unsafe" });

    await expect(
      purgeManagedVaultState({
        target: { vaultPath: harness.vaultPath },
        pluginId: PLUGIN_ID,
        backupDirectory: "relative/backups",
        confirm: affirmingConfirm,
      }),
    ).rejects.toMatchObject({ code: "purge_path_unsafe" });

    // The Vault path equal to the backup root is unsafe as well.
    await expect(
      purgeManagedVaultState({
        target: { vaultPath: harness.vaultPath },
        pluginId: PLUGIN_ID,
        backupDirectory: harness.vaultPath,
        confirm: affirmingConfirm,
      }),
    ).rejects.toMatchObject({ code: "purge_path_unsafe" });
    expect(ReleasePurgeError).toBeDefined();
  });
});
