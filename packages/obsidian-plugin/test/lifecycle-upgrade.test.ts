import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, describe, expect, it } from "vitest";

import {
  createBridgeInstance,
  createLoopbackMcpClient,
  InstallInterruptionError,
  installReleaseToManagedVaults,
  ManagedVaultBridgeRuntime,
  readManagedVaultUpgradeEvidence,
  recoverInterruptedInstall,
  RELEASE_MANAGED_CHECKSUM_FILE,
  RELEASE_REPOSITORY,
  RELEASE_WORKFLOW_PATH,
  ReleaseUpgradeError,
  upgradeManagedVaultRelease,
  UPGRADE_PHASE_ORDER,
  verifyReleaseBundle,
  type BridgeInstance,
  type ChangeSetExecutionAdapter,
  type ManagedVaultUpgradeResult,
  type ObservedHealth,
  type PersistedBridgeSettings,
  type UpgradeRuntimeAdapter,
  type VerifiedReleaseBundle,
} from "../src/index.js";

/**
 * Issue #199 orchestration tests: drained upgrade, interruption, migration
 * failure, health failure, safe rollback, and forbidden downgrade — composed
 * over the real per-Vault runtime, real loopback Bridges, and the real
 * installer. The Operational Gate algebra itself (submission rejection, gate
 * precedence, pause/resume machine) is issue #40's test corpus and is not
 * duplicated here.
 */

const PLUGIN_ID = "upgrade-bridge";
const OLD_VERSION = "0.4.0";
const NEW_VERSION = "0.5.0";
const OBSIDIAN_VERSION = "1.13.4";

const digest = (content: string | Uint8Array): string =>
  createHash("sha256").update(content).digest("hex");

function manifest(version: string): string {
  return `${JSON.stringify(
    {
      id: PLUGIN_ID,
      name: "Upgrade Bridge",
      version,
      minAppVersion: "1.13.4",
      isDesktopOnly: true,
    },
    null,
    2,
  )}\n`;
}

const mainJs = (version: string): string => `// upgrade candidate main ${version}\n`;

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

/** One ephemeral port reserved per test so parallel files never collide. */
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
  readonly port: number;
  failSaves: boolean;
  /** Supplies the executor a reloaded runtime should carry (default: none). */
  executionFactory?: () => ChangeSetExecutionAdapter | undefined;
  currentRuntime: ManagedVaultBridgeRuntime | undefined;
  currentBridge: BridgeInstance | undefined;
  createRuntime(execution?: ChangeSetExecutionAdapter): ManagedVaultBridgeRuntime;
  reloadRuntime(): Promise<UpgradeRuntimeAdapter>;
  observeHealth(runtime: UpgradeRuntimeAdapter): Promise<ObservedHealth>;
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
  const port = await reservePort();
  const healthClient = createLoopbackMcpClient({ clientName: "upgrade-test" });

  const harness: VaultHarness = {
    vaultPath,
    pluginDirectory,
    dataPath,
    port,
    failSaves: false,
    currentRuntime: undefined,
    currentBridge: undefined,
    createRuntime(execution) {
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
            if (harness.failSaves) throw new Error("disk full");
            await mkdir(pluginDirectory, { recursive: true });
            await writeFile(dataPath, JSON.stringify(settings), "utf8");
          },
        },
        searchDataSource: {
          listMarkdownPaths: async () => ["note.md"],
          readBinary: async () => new TextEncoder().encode("needle\n"),
        },
        changeSetDataSource: {
          readBinary: async () => null,
          pathKind: async () => null,
          isContained: async () => true,
        },
        ...(execution === undefined ? {} : { changeSetExecution: execution }),
        createBridge: (options) => {
          const bridge = createBridgeInstance(options);
          harness.currentBridge = bridge;
          return bridge;
        },
        createVaultId: () => "vault-a",
        selectInitialPort: () => port,
      });
      liveRuntimes.push(runtime);
      return runtime;
    },
    async reloadRuntime() {
      // The host's real reload: stop the running runtime entirely, then load
      // a fresh one from the bytes currently installed on disk.
      await harness.currentRuntime?.unload();
      const next = harness.createRuntime(harness.executionFactory?.());
      harness.currentRuntime = next;
      await next.load();
      return next;
    },
    async observeHealth() {
      const bridge = harness.currentBridge;
      if (bridge === undefined) throw new Error("No Bridge is running");
      return (await healthClient.observeHealth(bridge.endpoint, "vault-a")).health;
    },
    async submitChangeSet(submissionKey, path) {
      const bridge = harness.currentBridge;
      if (bridge === undefined) throw new Error("No Bridge is running");
      const client = new Client({ name: "upgrade-test", version: "1.0.0" });
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

async function startInstalledVault(
  harness: VaultHarness,
  oldBundle: VerifiedReleaseBundle,
): Promise<void> {
  const batch = await installReleaseToManagedVaults(oldBundle, [
    { vaultPath: harness.vaultPath, obsidianVersion: OBSIDIAN_VERSION },
  ]);
  expect(batch.targets[0]?.outcome).toBe("success");
  const runtime = harness.createRuntime();
  harness.currentRuntime = runtime;
  await runtime.load();
}

async function deployedManifestVersion(pluginDirectory: string): Promise<string> {
  const raw = JSON.parse(await readFile(join(pluginDirectory, "manifest.json"), "utf8"));
  return raw.version as string;
}

describe("Managed Vault release upgrade (issue #199)", () => {
  it("drains, upgrades, preserves queue and idempotency, and holds the pause until an explicit resume", async () => {
    const root = await mkdtemp(join(tmpdir(), "lifecycle-upgrade-"));
    const oldBundle = await verifiedBundle(root, "bundle-old", OLD_VERSION);
    const newBundle = await verifiedBundle(root, "bundle-new", NEW_VERSION);
    const harness = await arrangeVaultHarness(root, "vault-a");
    await startInstalledVault(harness, oldBundle);

    // Queue two Change Sets through the real MCP surface; with no executor
    // they remain queued in FIFO order.
    const first = (await harness.submitChangeSet("upgrade-key-1", "DrainA")) as {
      isError?: boolean;
      structuredContent?: { outcome?: string; changeSet?: { changeSetId?: string } };
    };
    const second = (await harness.submitChangeSet("upgrade-key-2", "DrainB")) as {
      isError?: boolean;
      structuredContent?: { outcome?: string; changeSet?: { changeSetId?: string } };
    };
    expect(first.isError).not.toBe(true);
    expect(second.isError).not.toBe(true);
    const headId = first.structuredContent?.changeSet?.changeSetId;
    expect(typeof headId).toBe("string");

    let reloads = 0;
    const result = await upgradeManagedVaultRelease({
      bundle: newBundle,
      target: { vaultPath: harness.vaultPath, obsidianVersion: OBSIDIAN_VERSION },
      runtime: harness.currentRuntime!,
      reloadRuntime: async () => {
        reloads += 1;
        return harness.reloadRuntime();
      },
      observeHealth: harness.observeHealth,
    });

    expect(result.outcome).toBe("upgraded");
    expect(result.awaitingOperatorResume).toBe(true);
    expect(result.completedPhases).toEqual(UPGRADE_PHASE_ORDER);
    expect(result.fromVersion).toBe(OLD_VERSION);
    expect(result.toVersion).toBe(NEW_VERSION);
    expect(result.vaultId).toBe("vault-a");
    expect(reloads).toBe(1);

    // The installed bundle is the verified target; state survived on disk.
    expect(await deployedManifestVersion(harness.pluginDirectory)).toBe(NEW_VERSION);
    expect(await readFile(join(harness.pluginDirectory, "main.js"), "utf8")).toBe(
      mainJs(NEW_VERSION),
    );
    const persisted = (await harness.readPersistedState()) as {
      changeSets: {
        writeMode?: string;
        lifecycle?: unknown;
        nextEnqueueSeq: number;
        entries: { submissionKey: string; enqueueSeq: number }[];
      };
    };
    expect(persisted.changeSets.writeMode).toBe("maintenance_paused");
    expect(persisted.changeSets.lifecycle).toEqual({
      upgrade: "succeeded",
      migration: "succeeded",
    });
    // FIFO order, Submission Keys, and the enqueue sequence are preserved.
    expect(
      persisted.changeSets.entries.map((entry) => [entry.submissionKey, entry.enqueueSeq]),
    ).toEqual([
      ["upgrade-key-1", 1],
      ["upgrade-key-2", 2],
    ]);
    expect(persisted.changeSets.nextEnqueueSeq).toBe(3);

    // The post-upgrade Vault is maintenance-paused with the queue intact.
    const pausedHealth = await harness.observeHealth(harness.currentRuntime!);
    expect(pausedHealth).toMatchObject({
      write: { gate: "open", state: "paused", pauseSource: "maintenance" },
      effectiveGate: { code: "writes_paused" },
      queue: { length: 2, headChangeSetId: headId },
      operatorAction: "resume_writes",
    });

    // Durable fail-closed evidence records the completed upgrade.
    const evidence = await readManagedVaultUpgradeEvidence(harness.pluginDirectory);
    expect(evidence).toMatchObject({
      outcome: "succeeded",
      fromVersion: OLD_VERSION,
      toVersion: NEW_VERSION,
      completedPhases: ["replace", "reload", "migrate", "recovery", "health"],
      preUpgradeQueue: { length: 2, headChangeSetId: headId },
      failure: null,
    });

    // Writes reopen only through the operator's explicit resume.
    await harness.currentRuntime!.resumeWrites();
    const resumedHealth = await harness.observeHealth(harness.currentRuntime!);
    expect(resumedHealth).toMatchObject({
      write: { state: "writable", pauseSource: null },
      effectiveGate: null,
    });
    const third = (await harness.submitChangeSet("upgrade-key-3", "DrainC")) as {
      isError?: boolean;
    };
    expect(third.isError).not.toBe(true);
  });

  it("stops dequeueing queued work during the upgrade and resumes FIFO afterwards", async () => {
    const root = await mkdtemp(join(tmpdir(), "lifecycle-upgrade-"));
    const oldBundle = await verifiedBundle(root, "bundle-old", OLD_VERSION);
    const newBundle = await verifiedBundle(root, "bundle-new", NEW_VERSION);
    const harness = await arrangeVaultHarness(root, "vault-a");
    await startInstalledVault(harness, oldBundle);
    await harness.submitChangeSet("fifo-key-1", "FifoA");
    await harness.submitChangeSet("fifo-key-2", "FifoB");

    // The reloaded runtime carries an executor: the upgrade must retain the
    // queue without dequeuing it until the operator resumes.
    const published: string[] = [];
    harness.executionFactory = () => {
      const adapter: ChangeSetExecutionAdapter = {
        loadRecoveryFrame: async () => null,
        persistRecoveryFrame: async () => undefined,
        pathKind: async () => null,
        directoryIdentity: async () => null,
        prepareDirectory: async () => "staged",
        publishDirectory: async (_stageId, path) => {
          published.push(path);
        },
        discardPreparedDirectory: async () => undefined,
        removeDirectory: async () => undefined,
        publishSearchSnapshot: async () => undefined,
      };
      return adapter;
    };

    const result = await upgradeManagedVaultRelease({
      bundle: newBundle,
      target: { vaultPath: harness.vaultPath, obsidianVersion: OBSIDIAN_VERSION },
      runtime: harness.currentRuntime!,
      reloadRuntime: harness.reloadRuntime,
      observeHealth: harness.observeHealth,
    });

    expect(result.outcome).toBe("upgraded");
    // The executor was present after the reload, yet nothing was dequeued
    // while the Vault was in maintenance.
    expect(published).toEqual([]);
    const pausedQueue = (await harness.observeHealth(harness.currentRuntime!)).queue;
    expect(pausedQueue.length).toBe(2);

    await harness.currentRuntime!.resumeWrites();
    expect(published).toEqual(["FifoA", "FifoB"]);
    const resumedQueue = (await harness.observeHealth(harness.currentRuntime!)).queue;
    expect(resumedQueue.length).toBe(0);
  });

  it("fails closed when the swap is interrupted, preserving state and leaving recoverable evidence", async () => {
    const root = await mkdtemp(join(tmpdir(), "lifecycle-upgrade-"));
    const oldBundle = await verifiedBundle(root, "bundle-old", OLD_VERSION);
    const newBundle = await verifiedBundle(root, "bundle-new", NEW_VERSION);
    const harness = await arrangeVaultHarness(root, "vault-a");
    await startInstalledVault(harness, oldBundle);
    await harness.submitChangeSet("interrupted-key", "Kept");

    const result = await upgradeManagedVaultRelease({
      bundle: newBundle,
      target: { vaultPath: harness.vaultPath, obsidianVersion: OBSIDIAN_VERSION },
      runtime: harness.currentRuntime!,
      reloadRuntime: harness.reloadRuntime,
      observeHealth: harness.observeHealth,
      // Simulated process death inside the only multi-step window of the swap;
      // in-process, the maintenance machine records the failure instead.
      hooks: {
        duringSwap: () => {
          throw new InstallInterruptionError("simulated process kill during the swap");
        },
      },
    });

    expect(result.outcome).toBe("failed");
    expect(result.failure?.code).toBe("upgrade_interrupted");
    expect(result.failure?.phase).toBe("replace");
    expect(result.rollback).toEqual({ attempted: false, restored: false, refused: null });

    // The failure is durable: blocked gate, failed lifecycle, queue retained.
    const persisted = (await harness.readPersistedState()) as {
      vaultId: string;
      changeSets: { writeMode?: string; lifecycle?: unknown; entries: unknown[] };
    };
    expect(persisted.vaultId).toBe("vault-a");
    expect(persisted.changeSets.writeMode).toBe("maintenance_failed");
    expect(persisted.changeSets.lifecycle).toEqual({
      upgrade: "failed",
      migration: "failed",
    });
    expect(persisted.changeSets.entries).toHaveLength(1);
    const health = await harness.observeHealth(harness.currentRuntime!);
    expect(health).toMatchObject({
      write: { gate: "blocked", state: "paused", pauseSource: "maintenance" },
      effectiveGate: { code: "upgrade_in_progress" },
      overall: "blocked",
      operatorAction: "finish_upgrade",
    });
    await expect(harness.currentRuntime!.resumeWrites()).rejects.toThrow();

    // The interrupted swap left deterministic leftovers; reconciling them
    // never resurrects a torn bundle — the Vault projects a repairable,
    // integrity-incomplete install with its operational state intact.
    const pluginsRoot = join(harness.vaultPath, ".obsidian", "plugins");
    const leftovers = (await readdir(pluginsRoot)).filter((entry) =>
      entry.startsWith(`.${PLUGIN_ID}.`),
    );
    expect(leftovers.length).toBeGreaterThan(0);
    const reconciliation = await recoverInterruptedInstall(pluginsRoot, PLUGIN_ID);
    expect(reconciliation.discardedPaths.length).toBeGreaterThan(0);
    expect((await readdir(pluginsRoot)).filter((entry) => entry.startsWith(`.${PLUGIN_ID}.`)))
      .toEqual([]);

    const evidence = await readManagedVaultUpgradeEvidence(harness.pluginDirectory);
    expect(evidence).toMatchObject({
      outcome: "failed",
      completedPhases: [],
      failure: { code: "upgrade_interrupted", phase: "replace" },
    });
  });

  it("fails closed when the migrated state cannot persist, without losing the queue", async () => {
    const root = await mkdtemp(join(tmpdir(), "lifecycle-upgrade-"));
    const oldBundle = await verifiedBundle(root, "bundle-old", OLD_VERSION);
    const newBundle = await verifiedBundle(root, "bundle-new", NEW_VERSION);
    const harness = await arrangeVaultHarness(root, "vault-a");
    await startInstalledVault(harness, oldBundle);
    await harness.submitChangeSet("migration-key", "Kept");

    const result = await upgradeManagedVaultRelease({
      bundle: newBundle,
      target: { vaultPath: harness.vaultPath, obsidianVersion: OBSIDIAN_VERSION },
      runtime: harness.currentRuntime!,
      reloadRuntime: async () => {
        const next = await harness.reloadRuntime();
        harness.failSaves = true;
        return next;
      },
      observeHealth: harness.observeHealth,
    });

    expect(result.outcome).toBe("failed");
    expect(result.failure?.code).toBe("upgrade_migration_failed");
    expect(result.failure?.phase).toBe("migrate");
    expect(result.rollback.attempted).toBe(false);
    expect(result.completedPhases).toEqual(["replace", "reload"]);

    // Writes were never reopened and the queued work survived.
    const persisted = (await harness.readPersistedState()) as {
      changeSets: { writeMode?: string; entries: { submissionKey: string }[] };
    };
    expect(persisted.changeSets.writeMode).toBeDefined();
    expect(persisted.changeSets.entries.map((entry) => entry.submissionKey)).toEqual([
      "migration-key",
    ]);
    await expect(harness.currentRuntime!.resumeWrites()).rejects.toThrow();
    expect(await deployedManifestVersion(harness.pluginDirectory)).toBe(NEW_VERSION);

    const evidence = await readManagedVaultUpgradeEvidence(harness.pluginDirectory);
    expect(evidence?.outcome).toBe("failed");
    expect(evidence?.failure?.code).toBe("upgrade_migration_failed");
  });

  it(
    "restores the previous bundle on post-upgrade health failure while the old runtime can still read the state",
    { timeout: 30_000 },
    async () => {
    const root = await mkdtemp(join(tmpdir(), "lifecycle-upgrade-"));
    const oldBundle = await verifiedBundle(root, "bundle-old", OLD_VERSION);
    const newBundle = await verifiedBundle(root, "bundle-new", NEW_VERSION);
    const harness = await arrangeVaultHarness(root, "vault-a");
    await startInstalledVault(harness, oldBundle);
    await harness.submitChangeSet("rollback-key", "Kept");

    // Post-upgrade observation reports a lost queue: the health evidence does
    // not confirm preservation, so the upgrade must not report success.
    let observations = 0;
    const result = await upgradeManagedVaultRelease({
      bundle: newBundle,
      target: { vaultPath: harness.vaultPath, obsidianVersion: OBSIDIAN_VERSION },
      runtime: harness.currentRuntime!,
      reloadRuntime: harness.reloadRuntime,
      observeHealth: async (runtime) => {
        observations += 1;
        const health = await harness.observeHealth(runtime);
        return observations === 1
          ? health
          : { ...health, queue: { ...health.queue, length: 0, headChangeSetId: null } };
      },
      rollbackBundle: oldBundle,
    });

    expect(result.outcome).toBe("rolled_back");
    expect(result.failure?.code).toBe("upgrade_health_failed");
    expect(result.failure?.phase).toBe("health");
    expect(result.rollback).toEqual({ attempted: true, restored: true, refused: null });
    expect(result.awaitingOperatorResume).toBe(false);
    expect(result.completedPhases).toEqual(["replace", "reload", "migrate", "recovery"]);

    // The previous bundle is back and the persisted state survived intact.
    expect(await deployedManifestVersion(harness.pluginDirectory)).toBe(OLD_VERSION);
    expect(await readFile(join(harness.pluginDirectory, "main.js"), "utf8")).toBe(
      mainJs(OLD_VERSION),
    );
    const persisted = (await harness.readPersistedState()) as {
      vaultId: string;
      changeSets: { writeMode?: string; entries: { submissionKey: string }[] };
    };
    expect(persisted.vaultId).toBe("vault-a");
    expect(persisted.changeSets.writeMode).toBe("maintenance_failed");
    expect(persisted.changeSets.entries.map((entry) => entry.submissionKey)).toEqual([
      "rollback-key",
    ]);

    // The rolled-back Vault remains blocked for the operator; writes never
    // reopened as a side effect of the rollback.
    const health = await harness.observeHealth(harness.currentRuntime!);
    expect(health).toMatchObject({
      write: { gate: "blocked", state: "paused" },
      effectiveGate: { code: "upgrade_in_progress" },
      overall: "blocked",
      operatorAction: "finish_upgrade",
    });
    await expect(harness.currentRuntime!.resumeWrites()).rejects.toThrow();

    const evidence = await readManagedVaultUpgradeEvidence(harness.pluginDirectory);
    expect(evidence).toMatchObject({
      outcome: "rolled_back",
      rollback: { attempted: true, restored: true, refused: null },
    });
  });

  it("forbids a blind downgrade after migration crossed the old runtime's readability boundary", async () => {
    const root = await mkdtemp(join(tmpdir(), "lifecycle-upgrade-"));
    const oldBundle = await verifiedBundle(root, "bundle-old", OLD_VERSION);
    const newBundle = await verifiedBundle(root, "bundle-new", NEW_VERSION);
    const harness = await arrangeVaultHarness(root, "vault-a");
    await startInstalledVault(harness, oldBundle);

    const result = await upgradeManagedVaultRelease({
      bundle: newBundle,
      target: { vaultPath: harness.vaultPath, obsidianVersion: OBSIDIAN_VERSION },
      runtime: harness.currentRuntime!,
      reloadRuntime: async () => {
        await harness.currentRuntime?.unload();
        // The new runtime migrated the persisted state beyond what the old
        // bundle can read (schema 3 against the old ceiling of 2).
        const raw = (await harness.readPersistedState()) as { schemaVersion: number };
        raw.schemaVersion = 3;
        await writeFile(harness.dataPath, JSON.stringify(raw), "utf8");
        const next = harness.createRuntime();
        harness.currentRuntime = next;
        await next.load();
        return next;
      },
      observeHealth: harness.observeHealth,
      rollbackBundle: oldBundle,
    });

    expect(result.outcome).toBe("failed");
    expect(result.failure?.code).toBe("upgrade_downgrade_forbidden");
    expect(result.rollback).toEqual({
      attempted: false,
      restored: false,
      refused: "downgrade_forbidden",
    });

    // The new bundle and the migrated state are retained, not destroyed.
    expect(await deployedManifestVersion(harness.pluginDirectory)).toBe(NEW_VERSION);
    expect(((await harness.readPersistedState()) as { schemaVersion: number }).schemaVersion)
      .toBe(3);

    const evidence = await readManagedVaultUpgradeEvidence(harness.pluginDirectory);
    expect(evidence?.outcome).toBe("failed");
    expect(evidence?.failure?.code).toBe("upgrade_downgrade_forbidden");
    expect(evidence?.rollback.refused).toBe("downgrade_forbidden");
  });

  it("refuses a rollback bundle that is not the installed release", async () => {
    const root = await mkdtemp(join(tmpdir(), "lifecycle-upgrade-"));
    const oldBundle = await verifiedBundle(root, "bundle-old", OLD_VERSION);
    const newBundle = await verifiedBundle(root, "bundle-new", NEW_VERSION);
    const unrelatedBundle = await verifiedBundle(root, "bundle-unrelated", "0.3.0");
    const harness = await arrangeVaultHarness(root, "vault-a");
    await startInstalledVault(harness, oldBundle);

    const result = await upgradeManagedVaultRelease({
      bundle: newBundle,
      target: { vaultPath: harness.vaultPath, obsidianVersion: OBSIDIAN_VERSION },
      runtime: harness.currentRuntime!,
      reloadRuntime: harness.reloadRuntime,
      observeHealth: harness.observeHealth,
      rollbackBundle: unrelatedBundle,
    });

    expect(result.outcome).toBe("failed");
    expect(result.failure?.code).toBe("upgrade_downgrade_forbidden");
    expect(result.rollback).toEqual({
      attempted: false,
      restored: false,
      refused: "downgrade_forbidden",
    });
  });

  it("rejects bundles that did not come from the release verifier", async () => {
    const root = await mkdtemp(join(tmpdir(), "lifecycle-upgrade-"));
    const oldBundle = await verifiedBundle(root, "bundle-old", OLD_VERSION);
    const harness = await arrangeVaultHarness(root, "vault-a");
    await startInstalledVault(harness, oldBundle);
    const forged = {
      bundleDirectory: join(root, "bundle-old"),
      identity: oldBundle.identity,
      tag: oldBundle.tag,
      repository: oldBundle.repository,
      workflowRef: oldBundle.workflowRef,
      attestationSource: "local-candidate" as const,
    };

    await expect(
      upgradeManagedVaultRelease({
        bundle: forged,
        target: { vaultPath: harness.vaultPath, obsidianVersion: OBSIDIAN_VERSION },
        runtime: harness.currentRuntime!,
        reloadRuntime: harness.reloadRuntime,
        observeHealth: harness.observeHealth,
      }),
    ).rejects.toMatchObject({
      name: "ReleaseUpgradeError",
      code: "upgrade_unverified_bundle",
    });
    await expect(
      upgradeManagedVaultRelease({
        bundle: oldBundle,
        target: { vaultPath: harness.vaultPath, obsidianVersion: OBSIDIAN_VERSION },
        runtime: harness.currentRuntime!,
        reloadRuntime: harness.reloadRuntime,
        observeHealth: harness.observeHealth,
        rollbackBundle: forged,
      }),
    ).rejects.toMatchObject({ code: "upgrade_unverified_bundle" });
    expect(ReleaseUpgradeError).toBeDefined();
  });

  it("refuses to upgrade a Vault without an integrity-complete installation", async () => {
    const root = await mkdtemp(join(tmpdir(), "lifecycle-upgrade-"));
    const newBundle = await verifiedBundle(root, "bundle-new", NEW_VERSION);
    const harness = await arrangeVaultHarness(root, "vault-a");
    const runtime = harness.createRuntime();
    harness.currentRuntime = runtime;
    await runtime.load();

    const result: ManagedVaultUpgradeResult = await upgradeManagedVaultRelease({
      bundle: newBundle,
      target: { vaultPath: harness.vaultPath, obsidianVersion: OBSIDIAN_VERSION },
      runtime,
      reloadRuntime: harness.reloadRuntime,
      observeHealth: harness.observeHealth,
    });

    expect(result.outcome).toBe("failed");
    expect(result.failure?.code).toBe("upgrade_not_installed");
    expect(result.failure?.phase).toBe("preflight");
    // Nothing was deployed and no lifecycle evidence was fabricated; the only
    // content is the runtime's own persisted settings from load().
    expect(await readManagedVaultUpgradeEvidence(harness.pluginDirectory)).toBeNull();
    expect(await readdir(harness.pluginDirectory)).toEqual(["data.json"]);
  });

  it("refuses to start an upgrade from a Vault that is not in a trustworthy writable state", async () => {
    const root = await mkdtemp(join(tmpdir(), "lifecycle-upgrade-"));
    const oldBundle = await verifiedBundle(root, "bundle-old", OLD_VERSION);
    const newBundle = await verifiedBundle(root, "bundle-new", NEW_VERSION);
    const harness = await arrangeVaultHarness(root, "vault-a");
    await startInstalledVault(harness, oldBundle);
    await harness.currentRuntime!.pauseWrites();

    const result = await upgradeManagedVaultRelease({
      bundle: newBundle,
      target: { vaultPath: harness.vaultPath, obsidianVersion: OBSIDIAN_VERSION },
      runtime: harness.currentRuntime!,
      reloadRuntime: harness.reloadRuntime,
      observeHealth: harness.observeHealth,
    });

    expect(result.outcome).toBe("failed");
    expect(result.failure?.code).toBe("upgrade_preflight_untrusted");
    expect(await deployedManifestVersion(harness.pluginDirectory)).toBe(OLD_VERSION);
    expect(await readManagedVaultUpgradeEvidence(harness.pluginDirectory)).toBeNull();
  });
});
