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
  MCP_REGISTRATION_REMOVAL_REQUIRED,
  RELEASE_MANAGED_CHECKSUM_FILE,
  RELEASE_REPOSITORY,
  RELEASE_WORKFLOW_PATH,
  ReleaseUninstallError,
  uninstallManagedVaultRelease,
  UPGRADE_EVIDENCE_FILENAME,
  UPGRADE_EVIDENCE_SCHEMA_VERSION,
  verifyReleaseBundle,
  waitForCondition,
  type BridgeInstance,
  type ManagedVaultUninstallResult,
  type ManagedVaultUpgradeEvidence,
  type ObservedHealth,
  type PersistedBridgeSettings,
} from "../src/index.js";
import { openRecoveryJournal } from "../src/recovery-journal.js";

/**
 * Issue #200 orchestration tests (spec §9.3): the fail-closed uninstall
 * safety gate (every refusal condition, missing/contradictory evidence),
 * managed-file-only deletion with byte-exact state preservation,
 * interruption and filesystem-fault injection, registration-removal command
 * generation without execution, and deterministic idempotent reruns —
 * composed over the real per-Vault runtime, real loopback Bridges, the real
 * installer, and the real Recovery Journal.
 */

const PLUGIN_ID = "uninstall-bridge";
const VERSION = "0.8.0";
const OBSIDIAN_VERSION = "1.13.4";

const digest = (content: string | Uint8Array): string =>
  createHash("sha256").update(content).digest("hex");

function manifest(version: string): string {
  return `${JSON.stringify(
    {
      id: PLUGIN_ID,
      name: "Uninstall Bridge",
      version,
      minAppVersion: "1.13.4",
      isDesktopOnly: true,
    },
    null,
    2,
  )}\n`;
}

const mainJs = (version: string): string => `// uninstall candidate main ${version}\n`;

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
  const port = await reservePort();
  const healthClient = createLoopbackMcpClient({ clientName: "uninstall-test" });

  const harness: VaultHarness = {
    vaultPath,
    pluginDirectory,
    dataPath,
    stateDirectory,
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
      const client = new Client({ name: "uninstall-test", version: "1.0.0" });
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

describe("Managed Vault release uninstall (issue #200)", () => {
  it("uninstalls a drained offline Vault: managed files only, state byte-preserved, command printed, rerun idempotent", async () => {
    const root = await mkdtemp(join(tmpdir(), "lifecycle-uninstall-"));
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
    const submitted = (await harness.submitChangeSet("uninstall-key-1", "KeptDir")) as {
      isError?: boolean;
    };
    expect(submitted.isError).not.toBe(true);
    await waitForCondition(async () => (await harness.observeHealth()).queue.length === 0, {
      timeoutMs: 10_000,
    });
    const dataBefore = await readFile(harness.dataPath, "utf8");
    const drained = (await harness.readPersistedState()) as {
      changeSets: { entries: { submissionKey: string; execution?: { phase: string } }[] };
    };
    expect(drained.changeSets.entries[0]?.execution?.phase).toBe("terminal");

    // Offline: the Vault is stopped before ordinary uninstall.
    await runtime.unload();
    harness.currentRuntime = undefined;
    harness.currentBridge = undefined;

    const result = await uninstallManagedVaultRelease({
      target: { vaultPath: harness.vaultPath, obsidianVersion: OBSIDIAN_VERSION },
      pluginId: PLUGIN_ID,
    });

    expect(result.outcome).toBe("uninstalled");
    expect(result.failure).toBeNull();
    expect(result.vaultId).toBe("vault-a");
    expect(result.removal?.removedFiles).toEqual([
      RELEASE_MANAGED_CHECKSUM_FILE,
      "main.js",
      "manifest.json",
    ]);
    // The exact operator command is printed, never executed.
    expect(result.registrationRemovalCommand).toBe("claude mcp remove --scope local vault-vault-a");
    expect(result.requiredNextSteps).toEqual([MCP_REGISTRATION_REMOVAL_REQUIRED]);

    // Only release-managed files were deleted; every state byte survived.
    expect(await managedFilesPresent(harness.pluginDirectory)).toEqual([]);
    expect(await readFile(harness.dataPath, "utf8")).toBe(dataBefore);
    const retained = (await harness.readPersistedState()) as {
      vaultId: string;
      port: number;
      changeSets: { entries: { submissionKey: string }[] };
    };
    expect(retained.vaultId).toBe("vault-a");
    expect(retained.port).toBe(harness.port);
    expect(retained.changeSets.entries.map((entry) => entry.submissionKey)).toEqual([
      "uninstall-key-1",
    ]);
    expect(await readFile(join(harness.stateDirectory, "recovery-journal.bin"))).toBeDefined();
    expect(
      await readFile(join(harness.vaultPath, ".obsidian", "community-plugins.json"), "utf8"),
    ).toBe(`${JSON.stringify([PLUGIN_ID])}\n`);

    // Rerunning is deterministic: already uninstalled, same printed command.
    const rerun = await uninstallManagedVaultRelease({
      target: { vaultPath: harness.vaultPath, obsidianVersion: OBSIDIAN_VERSION },
      pluginId: PLUGIN_ID,
    });
    expect(rerun.outcome).toBe("already_uninstalled");
    expect(rerun.failure).toBeNull();
    expect(rerun.registrationRemovalCommand).toBe("claude mcp remove --scope local vault-vault-a");
  });

  it("refuses while a Change Set is executing — live or persisted", async () => {
    const root = await mkdtemp(join(tmpdir(), "lifecycle-uninstall-"));
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

    const persistedRefusal = await uninstallManagedVaultRelease({
      target: { vaultPath: harness.vaultPath, obsidianVersion: OBSIDIAN_VERSION },
      pluginId: PLUGIN_ID,
    });
    expect(persistedRefusal.outcome).toBe("refused");
    expect(persistedRefusal.failure?.code).toBe("uninstall_change_set_executing");
    expect(persistedRefusal.registrationRemovalCommand).toBeNull();
    expect(await managedFilesPresent(harness.pluginDirectory)).toEqual([
      RELEASE_MANAGED_CHECKSUM_FILE,
      "main.js",
      "manifest.json",
    ]);

    const liveRefusal = await uninstallManagedVaultRelease({
      target: { vaultPath: harness.vaultPath, obsidianVersion: OBSIDIAN_VERSION },
      pluginId: PLUGIN_ID,
      observeHealth: async () =>
        liveHealthFixture({
          queue: { currentExecutionId: "cs-exec", length: 1, headChangeSetId: "cs-exec" },
        }),
    });
    expect(liveRefusal.outcome).toBe("refused");
    expect(liveRefusal.failure?.code).toBe("uninstall_change_set_executing");
  });

  it("refuses while work is queued — through the real MCP surface and offline persisted evidence", async () => {
    const root = await mkdtemp(join(tmpdir(), "lifecycle-uninstall-"));
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
    const liveRefusal = await uninstallManagedVaultRelease({
      target: { vaultPath: harness.vaultPath, obsidianVersion: OBSIDIAN_VERSION },
      pluginId: PLUGIN_ID,
      observeHealth: harness.observeHealth,
    });
    expect(liveRefusal.outcome).toBe("refused");
    expect(liveRefusal.failure?.code).toBe("uninstall_work_queued");

    // Offline refusal: the persisted registry alone proves the queue non-empty.
    await runtime.unload();
    harness.currentRuntime = undefined;
    harness.currentBridge = undefined;
    const offlineRefusal = await uninstallManagedVaultRelease({
      target: { vaultPath: harness.vaultPath, obsidianVersion: OBSIDIAN_VERSION },
      pluginId: PLUGIN_ID,
    });
    expect(offlineRefusal.outcome).toBe("refused");
    expect(offlineRefusal.failure?.code).toBe("uninstall_work_queued");
    expect(await managedFilesPresent(harness.pluginDirectory)).toHaveLength(3);
  });

  it("refuses when the Recovery Journal has a pending or failed frame", async () => {
    const root = await mkdtemp(join(tmpdir(), "lifecycle-uninstall-"));
    const bundle = await verifiedBundle(root, "bundle", VERSION);
    const harness = await arrangeVaultHarness(root, "vault-a");
    await installReleaseToManagedVaults(bundle, [
      { vaultPath: harness.vaultPath, obsidianVersion: OBSIDIAN_VERSION },
    ]);
    await writeFile(harness.dataPath, persistedStateFixture(emptyRegistry()), "utf8");

    await writeJournal(harness.stateDirectory, "PREPARED");
    const prepared = await uninstallManagedVaultRelease({
      target: { vaultPath: harness.vaultPath, obsidianVersion: OBSIDIAN_VERSION },
      pluginId: PLUGIN_ID,
    });
    expect(prepared.outcome).toBe("refused");
    expect(prepared.failure?.code).toBe("uninstall_recovery_untrusted");
    expect(prepared.failure?.detail).toContain("PREPARED");

    await writeJournal(harness.stateDirectory, "FAILED");
    const failed = await uninstallManagedVaultRelease({
      target: { vaultPath: harness.vaultPath, obsidianVersion: OBSIDIAN_VERSION },
      pluginId: PLUGIN_ID,
    });
    expect(failed.outcome).toBe("refused");
    expect(failed.failure?.code).toBe("uninstall_recovery_untrusted");

    // A terminal frame settles the journal: COMMITTED does not block removal.
    await writeJournal(harness.stateDirectory, "COMMITTED");
    const settled = await uninstallManagedVaultRelease({
      target: { vaultPath: harness.vaultPath, obsidianVersion: OBSIDIAN_VERSION },
      pluginId: PLUGIN_ID,
    });
    expect(settled.outcome).toBe("uninstalled");
  });

  it("refuses on every untrusted persisted recovery state", async () => {
    const root = await mkdtemp(join(tmpdir(), "lifecycle-uninstall-"));
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

      const result = await uninstallManagedVaultRelease({
        target: { vaultPath: harness.vaultPath, obsidianVersion: OBSIDIAN_VERSION },
        pluginId: PLUGIN_ID,
      });
      expect(result.outcome, entry.name).toBe("refused");
      expect(result.failure?.code, entry.name).toBe("uninstall_recovery_untrusted");
      expect(await managedFilesPresent(harness.pluginDirectory), entry.name).toHaveLength(3);
    }
  });

  it("refuses while upgrade evidence records an interrupted, failed, or rolled-back upgrade", async () => {
    const root = await mkdtemp(join(tmpdir(), "lifecycle-uninstall-"));
    const bundle = await verifiedBundle(root, "bundle", VERSION);
    const harness = await arrangeVaultHarness(root, "vault-a");
    await installReleaseToManagedVaults(bundle, [
      { vaultPath: harness.vaultPath, obsidianVersion: OBSIDIAN_VERSION },
    ]);
    await writeFile(harness.dataPath, persistedStateFixture(emptyRegistry()), "utf8");
    const evidencePath = join(harness.pluginDirectory, UPGRADE_EVIDENCE_FILENAME);

    for (const outcome of ["in_progress", "failed", "rolled_back"] as const) {
      await writeFile(evidencePath, upgradeEvidenceFixture(outcome), "utf8");
      const result = await uninstallManagedVaultRelease({
        target: { vaultPath: harness.vaultPath, obsidianVersion: OBSIDIAN_VERSION },
        pluginId: PLUGIN_ID,
      });
      expect(result.outcome, outcome).toBe("refused");
      expect(result.failure?.code, outcome).toBe("uninstall_recovery_untrusted");
    }

    // A succeeded upgrade is settled evidence and does not block removal.
    await writeFile(evidencePath, upgradeEvidenceFixture("succeeded"), "utf8");
    const settled = await uninstallManagedVaultRelease({
      target: { vaultPath: harness.vaultPath, obsidianVersion: OBSIDIAN_VERSION },
      pluginId: PLUGIN_ID,
    });
    expect(settled.outcome).toBe("uninstalled");
  });

  it("refuses on missing, malformed, or contradictory evidence — never a pass", async () => {
    const root = await mkdtemp(join(tmpdir(), "lifecycle-uninstall-"));
    const bundle = await verifiedBundle(root, "bundle", VERSION);

    // Malformed persisted settings.
    {
      const harness = await arrangeVaultHarness(root, "vault-bad-json");
      await installReleaseToManagedVaults(bundle, [
        { vaultPath: harness.vaultPath, obsidianVersion: OBSIDIAN_VERSION },
      ]);
      await writeFile(harness.dataPath, "{ not json", "utf8");
      const result = await uninstallManagedVaultRelease({
        target: { vaultPath: harness.vaultPath, obsidianVersion: OBSIDIAN_VERSION },
        pluginId: PLUGIN_ID,
      });
      expect(result.outcome).toBe("refused");
      expect(result.failure?.code).toBe("uninstall_evidence_contradictory");
    }

    // Persisted settings without a valid Vault identity.
    {
      const harness = await arrangeVaultHarness(root, "vault-bad-shape");
      await installReleaseToManagedVaults(bundle, [
        { vaultPath: harness.vaultPath, obsidianVersion: OBSIDIAN_VERSION },
      ]);
      await writeFile(harness.dataPath, JSON.stringify({ schemaVersion: 2 }), "utf8");
      const result = await uninstallManagedVaultRelease({
        target: { vaultPath: harness.vaultPath, obsidianVersion: OBSIDIAN_VERSION },
        pluginId: PLUGIN_ID,
      });
      expect(result.outcome).toBe("refused");
      expect(result.failure?.code).toBe("uninstall_evidence_contradictory");
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
      const result = await uninstallManagedVaultRelease({
        target: { vaultPath: harness.vaultPath, obsidianVersion: OBSIDIAN_VERSION },
        pluginId: PLUGIN_ID,
      });
      expect(result.outcome).toBe("refused");
      expect(result.failure?.code).toBe("uninstall_evidence_contradictory");
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
      const result = await uninstallManagedVaultRelease({
        target: { vaultPath: harness.vaultPath, obsidianVersion: OBSIDIAN_VERSION },
        pluginId: PLUGIN_ID,
      });
      expect(result.outcome).toBe("refused");
      expect(result.failure?.code).toBe("uninstall_evidence_contradictory");
    }

    // A live Bridge answering without any persisted identity.
    {
      const harness = await arrangeVaultHarness(root, "vault-ghost");
      await installReleaseToManagedVaults(bundle, [
        { vaultPath: harness.vaultPath, obsidianVersion: OBSIDIAN_VERSION },
      ]);
      const result = await uninstallManagedVaultRelease({
        target: { vaultPath: harness.vaultPath, obsidianVersion: OBSIDIAN_VERSION },
        pluginId: PLUGIN_ID,
        observeHealth: async () => liveHealthFixture({}),
      });
      expect(result.outcome).toBe("refused");
      expect(result.failure?.code).toBe("uninstall_evidence_contradictory");
    }

    // Live identity contradicting the persisted identity.
    {
      const harness = await arrangeVaultHarness(root, "vault-live-mismatch");
      await installReleaseToManagedVaults(bundle, [
        { vaultPath: harness.vaultPath, obsidianVersion: OBSIDIAN_VERSION },
      ]);
      await writeFile(harness.dataPath, persistedStateFixture(emptyRegistry()), "utf8");
      const result = await uninstallManagedVaultRelease({
        target: { vaultPath: harness.vaultPath, obsidianVersion: OBSIDIAN_VERSION },
        pluginId: PLUGIN_ID,
        observeHealth: async () => liveHealthFixture({ vaultId: "vault-foreign" }),
      });
      expect(result.outcome).toBe("refused");
      expect(result.failure?.code).toBe("uninstall_evidence_contradictory");
    }

    // A failed live observation is unavailable evidence, never a pass.
    {
      const harness = await arrangeVaultHarness(root, "vault-unreachable");
      await installReleaseToManagedVaults(bundle, [
        { vaultPath: harness.vaultPath, obsidianVersion: OBSIDIAN_VERSION },
      ]);
      await writeFile(harness.dataPath, persistedStateFixture(emptyRegistry()), "utf8");
      const result = await uninstallManagedVaultRelease({
        target: { vaultPath: harness.vaultPath, obsidianVersion: OBSIDIAN_VERSION },
        pluginId: PLUGIN_ID,
        observeHealth: async () => {
          throw new Error("connection reset");
        },
      });
      expect(result.outcome).toBe("refused");
      expect(result.failure?.code).toBe("uninstall_evidence_unavailable");
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
      const result = await uninstallManagedVaultRelease({
        target: { vaultPath: harness.vaultPath, obsidianVersion: OBSIDIAN_VERSION },
        pluginId: PLUGIN_ID,
      });
      expect(result.outcome).toBe("refused");
      expect(result.failure?.code).toBe("uninstall_evidence_unavailable");
    }
  });

  it("refuses on untrusted live recovery evidence", async () => {
    const root = await mkdtemp(join(tmpdir(), "lifecycle-uninstall-"));
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
      const result = await uninstallManagedVaultRelease({
        target: { vaultPath: harness.vaultPath, obsidianVersion: OBSIDIAN_VERSION },
        pluginId: PLUGIN_ID,
        observeHealth: async () => health,
      });
      expect(result.outcome).toBe("refused");
      expect(result.failure?.code).toBe("uninstall_recovery_untrusted");
    }
  });

  it("uninstalls a never-loaded Vault: no state exists to preserve and no registration was possible", async () => {
    const root = await mkdtemp(join(tmpdir(), "lifecycle-uninstall-"));
    const bundle = await verifiedBundle(root, "bundle", VERSION);
    const harness = await arrangeVaultHarness(root, "vault-a");
    await installReleaseToManagedVaults(bundle, [
      { vaultPath: harness.vaultPath, obsidianVersion: OBSIDIAN_VERSION },
    ]);

    const result = await uninstallManagedVaultRelease({
      target: { vaultPath: harness.vaultPath, obsidianVersion: OBSIDIAN_VERSION },
      pluginId: PLUGIN_ID,
    });

    expect(result.outcome).toBe("uninstalled");
    expect(result.vaultId).toBeNull();
    expect(result.registrationRemovalCommand).toBeNull();
    expect(result.requiredNextSteps).toEqual([]);
    expect(await managedFilesPresent(harness.pluginDirectory)).toEqual([]);
  });

  it("reports an interrupted pre-removal hook as failed and completes on rerun", async () => {
    const root = await mkdtemp(join(tmpdir(), "lifecycle-uninstall-"));
    const bundle = await verifiedBundle(root, "bundle", VERSION);
    const harness = await arrangeVaultHarness(root, "vault-a");
    await installReleaseToManagedVaults(bundle, [
      { vaultPath: harness.vaultPath, obsidianVersion: OBSIDIAN_VERSION },
    ]);
    await writeFile(harness.dataPath, persistedStateFixture(emptyRegistry()), "utf8");
    const dataBefore = await readFile(harness.dataPath, "utf8");

    const interrupted: ManagedVaultUninstallResult = await uninstallManagedVaultRelease({
      target: { vaultPath: harness.vaultPath, obsidianVersion: OBSIDIAN_VERSION },
      pluginId: PLUGIN_ID,
      hooks: {
        beforeRemoval: () => {
          throw new InstallInterruptionError("simulated process kill before removal");
        },
      },
    });
    expect(interrupted.outcome).toBe("failed");
    expect(interrupted.failure?.code).toBe("uninstall_interrupted");
    // Nothing was removed; the rerun completes the uninstall deterministically.
    expect(await managedFilesPresent(harness.pluginDirectory)).toHaveLength(3);

    const rerun = await uninstallManagedVaultRelease({
      target: { vaultPath: harness.vaultPath, obsidianVersion: OBSIDIAN_VERSION },
      pluginId: PLUGIN_ID,
    });
    expect(rerun.outcome).toBe("uninstalled");
    expect(await managedFilesPresent(harness.pluginDirectory)).toEqual([]);
    expect(await readFile(harness.dataPath, "utf8")).toBe(dataBefore);
  });

  it("surfaces partial filesystem failure as failed — never success — and reruns to completion", async () => {
    const root = await mkdtemp(join(tmpdir(), "lifecycle-uninstall-"));
    const bundle = await verifiedBundle(root, "bundle", VERSION);
    const harness = await arrangeVaultHarness(root, "vault-a");
    await installReleaseToManagedVaults(bundle, [
      { vaultPath: harness.vaultPath, obsidianVersion: OBSIDIAN_VERSION },
    ]);
    await writeFile(harness.dataPath, persistedStateFixture(emptyRegistry()), "utf8");
    const dataBefore = await readFile(harness.dataPath, "utf8");

    // Fault injection: the removal seam deletes one managed file, then the
    // filesystem faults. The partial state must not be reported as success.
    const { rm } = await import("node:fs/promises");
    const partial = await uninstallManagedVaultRelease({
      target: { vaultPath: harness.vaultPath, obsidianVersion: OBSIDIAN_VERSION },
      pluginId: PLUGIN_ID,
      removeManagedFiles: async () => {
        await rm(join(harness.pluginDirectory, "main.js"), { force: true });
        throw new Error("EACCES: permission denied");
      },
    });
    expect(partial.outcome).toBe("failed");
    expect(partial.failure?.code).toBe("uninstall_removal_failed");
    expect(await managedFilesPresent(harness.pluginDirectory)).toEqual([
      RELEASE_MANAGED_CHECKSUM_FILE,
      "manifest.json",
    ]);

    const rerun = await uninstallManagedVaultRelease({
      target: { vaultPath: harness.vaultPath, obsidianVersion: OBSIDIAN_VERSION },
      pluginId: PLUGIN_ID,
    });
    expect(rerun.outcome).toBe("uninstalled");
    expect(rerun.removal?.removedFiles).toEqual([RELEASE_MANAGED_CHECKSUM_FILE, "manifest.json"]);
    expect(rerun.removal?.missingFiles).toEqual(["main.js", "styles.css"]);
    expect(await readFile(harness.dataPath, "utf8")).toBe(dataBefore);
  });

  it("fails when removal claims success but release-managed files survive", async () => {
    const root = await mkdtemp(join(tmpdir(), "lifecycle-uninstall-"));
    const bundle = await verifiedBundle(root, "bundle", VERSION);
    const harness = await arrangeVaultHarness(root, "vault-a");
    await installReleaseToManagedVaults(bundle, [
      { vaultPath: harness.vaultPath, obsidianVersion: OBSIDIAN_VERSION },
    ]);
    await writeFile(harness.dataPath, persistedStateFixture(emptyRegistry()), "utf8");

    const result = await uninstallManagedVaultRelease({
      target: { vaultPath: harness.vaultPath, obsidianVersion: OBSIDIAN_VERSION },
      pluginId: PLUGIN_ID,
      removeManagedFiles: async () => ({
        vaultPath: harness.vaultPath,
        removedFiles: ["manifest.json"],
        missingFiles: ["main.js", "styles.css", RELEASE_MANAGED_CHECKSUM_FILE],
      }),
    });
    expect(result.outcome).toBe("failed");
    expect(result.failure?.code).toBe("uninstall_removal_failed");
    expect(result.failure?.detail).toContain("checksums.sha256");

    // The honest rerun removes everything.
    const rerun = await uninstallManagedVaultRelease({
      target: { vaultPath: harness.vaultPath, obsidianVersion: OBSIDIAN_VERSION },
      pluginId: PLUGIN_ID,
    });
    expect(rerun.outcome).toBe("uninstalled");
  });

  it("rejects an unsafe Vault path as a contract violation", async () => {
    await expect(
      uninstallManagedVaultRelease({
        target: { vaultPath: "relative/vault" },
        pluginId: PLUGIN_ID,
      }),
    ).rejects.toMatchObject({
      name: "ReleaseUninstallError",
      code: "uninstall_path_unsafe",
    });
    expect(ReleaseUninstallError).toBeDefined();
  });
});
