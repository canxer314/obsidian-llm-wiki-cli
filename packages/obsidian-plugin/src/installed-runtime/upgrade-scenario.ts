import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import {
  installReleaseToManagedVaults,
} from "../lifecycle/install-release.js";
import { managedVaultPluginDirectory } from "../lifecycle/release-managed-files.js";
import {
  upgradeManagedVaultRelease,
  UPGRADE_PHASE_ORDER,
  type ManagedVaultUpgradeResult,
  type UpgradeRuntimeAdapter,
} from "../lifecycle/upgrade-release.js";
import { EXPECTED_VAULT_ID_HEADER } from "../request-policy.js";
import type { VerifiedReleaseBundle } from "../release/verify-release-bundle.js";
import {
  createLoopbackMcpClient,
  type LoopbackMcpClient,
} from "./loopback-client.js";
import {
  readPersistedBridgeIdentity,
  waitForCondition,
  type ObsidianProcessControl,
  type ObsidianProcessHandle,
  type PersistedBridgeIdentity,
} from "./obsidian-process.js";
import {
  cleanupTestVault,
  provisionTestVault,
  type CleanupReport,
} from "./test-vault.js";

/**
 * Dedicated installed-runtime upgrade scenario (issue #199): composes the
 * drained upgrade orchestration over the harness's scenario seams (issue
 * #197) so #44 can compose it into larger corpora later. One run proves, in
 * one dedicated generated test Vault: previous Release installed and enabled
 * → Bridge started with persisted identity → work queued through the real
 * MCP surface → drained upgrade through a real Obsidian stop/start (the
 * plugin reloads from the replaced bundle) → Vault identity, port, queue,
 * and Submission Keys preserved → post-upgrade maintenance pause held with
 * submissions rejected → the Primary Operator's explicit resume reopens
 * writes.
 *
 * This is a scenario on top of the harness seams, not a replacement for the
 * harness's complete verification corpus.
 */

export type UpgradeScenarioStage =
  | "provision"
  | "install_previous_release"
  | "operator_enablement"
  | "obsidian_start"
  | "queue_work"
  | "upgrade"
  | "state_preservation"
  | "post_upgrade_pause"
  | "explicit_resume"
  | "obsidian_stop"
  | "cleanup";

export interface UpgradeScenarioStageRecord {
  readonly stage: UpgradeScenarioStage;
  readonly outcome: "passed" | "failed";
  readonly detail: string | null;
}

/**
 * Host access to the plugin runtime loaded inside the running Obsidian
 * process. The process itself is driven only through the harness's
 * `ObsidianProcessControl` seam; this seam hands the scenario the runtime the
 * loaded plugin hosts, so the Primary Operator's maintenance entry point and
 * explicit resume can be invoked the way the plugin exposes them.
 */
export interface UpgradeScenarioRuntimeHost {
  /** The plugin runtime loaded by the most recent Obsidian start. */
  currentRuntime(): UpgradeRuntimeAdapter | null;
}

export interface UpgradeScenarioOptions {
  /** Verified Release currently installed and running (the old bundle). */
  readonly previousRelease: VerifiedReleaseBundle;
  /** Verified Release to upgrade to (the staged target bundle). */
  readonly upgradeRelease: VerifiedReleaseBundle;
  /** Obsidian runtime version reported for the generated test Vault. */
  readonly obsidianVersion: string;
  readonly workingDirectory: string;
  readonly processControl: ObsidianProcessControl;
  readonly runtimeHost: UpgradeScenarioRuntimeHost;
  readonly client?: LoopbackMcpClient;
  readonly runId?: string;
  readonly configDirectoryName?: string;
  readonly timeouts?: { readonly startupMs?: number; readonly stopMs?: number };
  /** Scenario seams, mirroring the harness for later composition by #44. */
  readonly provisionVault?: typeof provisionTestVault;
  readonly cleanupVault?: typeof cleanupTestVault;
}

export interface UpgradeScenarioResult {
  readonly verdict: "passed" | "failed";
  readonly stages: readonly UpgradeScenarioStageRecord[];
  readonly failure: { readonly stage: UpgradeScenarioStage; readonly detail: string } | null;
  /** Identity persisted before the upgrade and required stable across it. */
  readonly bridgeIdentity: PersistedBridgeIdentity | null;
  /** The Change Sets queued before the upgrade, in FIFO order. */
  readonly queuedChangeSetIds: readonly string[];
  readonly upgrade: ManagedVaultUpgradeResult | null;
  readonly cleanup: CleanupReport | null;
}

interface StageRecorder {
  readonly records: UpgradeScenarioStageRecord[];
  pass(stage: UpgradeScenarioStage, detail?: string): void;
  fail(stage: UpgradeScenarioStage, detail: string): Error;
}

function stageRecorder(): StageRecorder {
  const records: UpgradeScenarioStageRecord[] = [];
  return {
    records,
    pass(stage, detail) {
      records.push({ stage, outcome: "passed", detail: detail ?? null });
    },
    fail(stage, detail) {
      records.push({ stage, outcome: "failed", detail });
      return new Error(`${stage}: ${detail}`);
    },
  };
}

interface SubmittedChangeSet {
  readonly changeSetId: string;
}

/** Queues one Change Set through the real loopback MCP surface. */
async function submitChangeSet(
  endpoint: URL,
  vaultId: string,
  submissionKey: string,
  path: string,
): Promise<{ outcome: string; changeSet: SubmittedChangeSet | null }> {
  const client = new Client({ name: "installed-runtime-upgrade", version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(endpoint, {
      requestInit: { headers: { [EXPECTED_VAULT_ID_HEADER]: vaultId } },
    }),
  );
  try {
    const result = await client.callTool({
      name: "vault_change_set_submit",
      arguments: {
        submissionKey,
        operations: [
          { operationId: "mkdir-1", kind: "create_directory", path, ifExists: "reject" },
        ],
      },
    });
    const content = result.structuredContent as
      | { outcome?: string; changeSet?: { changeSetId?: string }; gate?: { code?: string } }
      | undefined;
    return {
      outcome: result.isError === true
        ? (content?.outcome ?? "error")
        : (content?.outcome ?? "unknown"),
      changeSet:
        content?.changeSet !== undefined && typeof content.changeSet.changeSetId === "string"
          ? { changeSetId: content.changeSet.changeSetId }
          : null,
    };
  } finally {
    await client.close().catch(() => undefined);
  }
}

export async function runManagedVaultUpgradeScenario(
  options: UpgradeScenarioOptions,
): Promise<UpgradeScenarioResult> {
  const runId = options.runId ?? randomUUID();
  const configDirectoryName = options.configDirectoryName ?? ".obsidian";
  const startupMs = options.timeouts?.startupMs ?? 120_000;
  const client = options.client ?? createLoopbackMcpClient();
  const provision = options.provisionVault ?? provisionTestVault;
  const cleanupVault = options.cleanupVault ?? cleanupTestVault;
  const pluginId = options.upgradeRelease.identity.pluginId;

  const recorder = stageRecorder();
  let vault: { vaultPath: string; profileDirectory: string } | null = null;
  let handle: ObsidianProcessHandle | null = null;
  let identity: PersistedBridgeIdentity | null = null;
  let upgrade: ManagedVaultUpgradeResult | null = null;
  let cleanup: CleanupReport | null = null;
  const queuedChangeSetIds: string[] = [];

  let failure: UpgradeScenarioResult["failure"] = null;
  try {
    try {
      vault = await provision({
        workingDirectory: options.workingDirectory,
        runId,
        configDirectoryName,
      });
      recorder.pass("provision");
    } catch (error) {
      throw recorder.fail("provision", error instanceof Error ? error.message : String(error));
    }
    const pluginDirectory = managedVaultPluginDirectory(
      vault.vaultPath,
      configDirectoryName,
      pluginId,
    );

    // The previous Release is installed and explicitly enabled by the
    // operator; the Bridge then starts with its persisted identity.
    const installBatch = await installReleaseToManagedVaults(options.previousRelease, [
      {
        vaultPath: vault.vaultPath,
        configDirectoryName,
        obsidianVersion: options.obsidianVersion,
      },
    ]);
    if (installBatch.targets[0]?.outcome !== "success") {
      throw recorder.fail(
        "install_previous_release",
        `Previous release did not install: ${installBatch.targets[0]?.failure?.detail ?? "no result"}`,
      );
    }
    recorder.pass("install_previous_release");

    await writeFile(
      join(vault.vaultPath, configDirectoryName, "community-plugins.json"),
      `${JSON.stringify([pluginId])}\n`,
      "utf8",
    );
    recorder.pass("operator_enablement");

    try {
      handle = await options.processControl.start({
        vaultPath: vault.vaultPath,
        profileDirectory: vault.profileDirectory,
      });
      await waitForCondition(
        async () =>
          (await readPersistedBridgeIdentity(
            vault!.vaultPath,
            pluginId,
            configDirectoryName,
          )) !== null,
        { timeoutMs: startupMs },
      );
      const startedIdentity = await readPersistedBridgeIdentity(
        vault.vaultPath,
        pluginId,
        configDirectoryName,
      );
      if (startedIdentity === null) throw new Error("The Bridge identity was not persisted");
      identity = startedIdentity;
      recorder.pass("obsidian_start");
    } catch (error) {
      throw recorder.fail(
        "obsidian_start",
        error instanceof Error ? error.message : String(error),
      );
    }
    const endpoint = new URL(`http://127.0.0.1:${identity.port}/mcp`);
    const vaultId = identity.vaultId;

    // Work queued through the real MCP surface drains/retains through the
    // upgrade; with no executor wired into this scenario it stays queued.
    for (const [index, path] of ["QueuedA", "QueuedB"].entries()) {
      const submitted = await submitChangeSet(endpoint, vaultId, `upgrade-scenario-${index + 1}`, path);
      if (submitted.outcome !== "registered" || submitted.changeSet === null) {
        throw recorder.fail(
          "queue_work",
          `Change Set ${index + 1} was not registered: ${submitted.outcome}`,
        );
      }
      queuedChangeSetIds.push(submitted.changeSet.changeSetId);
    }
    const queuedHealth = await client.observeHealth(endpoint, vaultId);
    if (queuedHealth.health.queue.length !== 2) {
      throw recorder.fail(
        "queue_work",
        `Expected 2 queued Change Sets, observed ${queuedHealth.health.queue.length}`,
      );
    }
    recorder.pass("queue_work", `queued: ${queuedChangeSetIds.join(", ")}`);

    // The drained upgrade: the orchestrator enters maintenance, drains, swaps
    // the verified bundle atomically, then reloads through a real Obsidian
    // stop/start so the plugin loads from the replaced bytes.
    const runtime = options.runtimeHost.currentRuntime();
    if (runtime === null) {
      throw recorder.fail("upgrade", "The host did not expose the loaded plugin runtime");
    }
    try {
      upgrade = await upgradeManagedVaultRelease({
        bundle: options.upgradeRelease,
        target: {
          vaultPath: vault.vaultPath,
          configDirectoryName,
          obsidianVersion: options.obsidianVersion,
        },
        runtime,
        reloadRuntime: async () => {
          await handle!.stop();
          handle = await options.processControl.start({
            vaultPath: vault!.vaultPath,
            profileDirectory: vault!.profileDirectory,
          });
          const reloaded = options.runtimeHost.currentRuntime();
          if (reloaded === null) {
            throw new Error("The reloaded Obsidian did not load the plugin runtime");
          }
          return reloaded;
        },
        observeHealth: async () => (await client.observeHealth(endpoint, vaultId)).health,
      });
    } catch (error) {
      throw recorder.fail("upgrade", error instanceof Error ? error.message : String(error));
    }
    if (upgrade.outcome !== "upgraded" || !upgrade.awaitingOperatorResume) {
      throw recorder.fail(
        "upgrade",
        `Upgrade did not complete: ${upgrade.failure?.detail ?? upgrade.outcome}`,
      );
    }
    if (upgrade.completedPhases.join(",") !== UPGRADE_PHASE_ORDER.join(",")) {
      throw recorder.fail(
        "upgrade",
        `Upgrade phases out of order: ${upgrade.completedPhases.join(",")}`,
      );
    }
    recorder.pass("upgrade", `${upgrade.fromVersion ?? "?"} → ${upgrade.toVersion}`);

    // Identity, port, the FIFO queue, and Submission Keys survived; the files
    // on disk are the upgrade bundle.
    const identityAfter = await readPersistedBridgeIdentity(
      vault.vaultPath,
      pluginId,
      configDirectoryName,
    );
    const persistedRaw = JSON.parse(
      await readFile(join(pluginDirectory, "data.json"), "utf8"),
    ) as { changeSets?: { entries?: { submissionKey?: string }[] } };
    const preservedKeys = (persistedRaw.changeSets?.entries ?? []).map(
      (entry) => entry.submissionKey,
    );
    const manifest = JSON.parse(
      await readFile(join(pluginDirectory, "manifest.json"), "utf8"),
    ) as { version?: string };
    if (
      identityAfter === null ||
      identityAfter.vaultId !== identity.vaultId ||
      identityAfter.port !== identity.port ||
      preservedKeys.join(",") !== "upgrade-scenario-1,upgrade-scenario-2" ||
      manifest.version !== options.upgradeRelease.identity.pluginVersion
    ) {
      throw recorder.fail(
        "state_preservation",
        "Vault identity, port, queue, Submission Keys, or bundle version did not survive the upgrade",
      );
    }
    recorder.pass("state_preservation");

    // The upgrade holds the Vault maintenance-paused: health stays available,
    // the queue is preserved, and new submissions are rejected without
    // binding their keys.
    const pausedHealth = (await client.observeHealth(endpoint, vaultId)).health;
    if (
      pausedHealth.write.state !== "paused" ||
      pausedHealth.write.pauseSource !== "maintenance" ||
      pausedHealth.effectiveGate?.code !== "writes_paused" ||
      pausedHealth.queue.length !== 2 ||
      pausedHealth.queue.headChangeSetId !== queuedChangeSetIds[0] ||
      pausedHealth.operatorAction !== "resume_writes"
    ) {
      throw recorder.fail(
        "post_upgrade_pause",
        `Post-upgrade health did not hold the maintenance pause: ${JSON.stringify({
          write: pausedHealth.write,
          effectiveGate: pausedHealth.effectiveGate,
          queue: pausedHealth.queue,
          operatorAction: pausedHealth.operatorAction,
        })}`,
      );
    }
    const blocked = await submitChangeSet(endpoint, vaultId, "upgrade-scenario-3", "QueuedC");
    if (blocked.outcome !== "operationally_blocked" || blocked.changeSet !== null) {
      throw recorder.fail(
        "post_upgrade_pause",
        `A submission during the maintenance pause was not rejected: ${blocked.outcome}`,
      );
    }
    recorder.pass("post_upgrade_pause");

    // Only the Primary Operator's explicit resume reopens writes; the key the
    // pause refused to bind may be retried unchanged afterwards.
    const reloadedRuntime = options.runtimeHost.currentRuntime();
    if (reloadedRuntime === null) {
      throw recorder.fail("explicit_resume", "The host lost the reloaded plugin runtime");
    }
    await reloadedRuntime.resumeWrites();
    const resumedHealth = (await client.observeHealth(endpoint, vaultId)).health;
    if (resumedHealth.write.state !== "writable" || resumedHealth.effectiveGate !== null) {
      throw recorder.fail(
        "explicit_resume",
        `Writes did not reopen after the explicit resume: ${JSON.stringify(resumedHealth.write)}`,
      );
    }
    const retried = await submitChangeSet(endpoint, vaultId, "upgrade-scenario-3", "QueuedC");
    if (retried.outcome !== "registered" || retried.changeSet === null) {
      throw recorder.fail(
        "explicit_resume",
        `The retried submission after resume was not registered: ${retried.outcome}`,
      );
    }
    queuedChangeSetIds.push(retried.changeSet.changeSetId);
    recorder.pass("explicit_resume");

    try {
      await handle!.stop();
      handle = null;
      recorder.pass("obsidian_stop");
    } catch (error) {
      throw recorder.fail(
        "obsidian_stop",
        error instanceof Error ? error.message : String(error),
      );
    }
  } catch (error) {
    failure = {
      stage: recorder.records.at(-1)?.stage ?? "provision",
      detail: error instanceof Error ? error.message : String(error),
    };
  }

  if (handle !== null) {
    try {
      await handle.stop();
    } catch {
      // The primary failure is already recorded; cleanup still proceeds.
    }
  }
  if (vault !== null) {
    try {
      cleanup = await cleanupVault(vault);
      if (cleanup.residualPaths.length > 0) {
        recorder.fail("cleanup", "Generated test content survived cleanup");
        failure ??= { stage: "cleanup", detail: "Generated test content survived cleanup" };
      } else {
        recorder.pass("cleanup");
      }
    } catch (error) {
      recorder.fail("cleanup", error instanceof Error ? error.message : String(error));
      failure ??= {
        stage: "cleanup",
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  }

  return {
    verdict: failure === null ? "passed" : "failed",
    stages: recorder.records,
    failure,
    bridgeIdentity: identity,
    queuedChangeSetIds,
    upgrade,
    cleanup,
  };
}
