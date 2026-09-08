import { randomUUID } from "node:crypto";
import { open, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import {
  installReleaseToManagedVaults,
} from "../lifecycle/install-release.js";
import { verifyManagedVaultLifecycle } from "../lifecycle/lifecycle-status.js";
import {
  purgeManagedVaultState,
  type ManagedVaultPurgeConfirmation,
  type ManagedVaultPurgeResult,
  type ReleasePurgeFailureCode,
} from "../lifecycle/purge-release.js";
import {
  isReleaseManagedFile,
  managedVaultPluginDirectory,
} from "../lifecycle/release-managed-files.js";
import {
  uninstallManagedVaultRelease,
  type ManagedVaultUninstallResult,
} from "../lifecycle/uninstall-release.js";
import { BRIDGE_STATE_DIRECTORY_NAME } from "../change-set.js";
import { createRegistrationCommand } from "../registration-command.js";
import { openRecoveryJournal } from "../recovery-journal.js";
import { EXPECTED_VAULT_ID_HEADER } from "../request-policy.js";
import type { VerifiedReleaseBundle } from "../release/verify-release-bundle.js";
import { sha256Hex } from "./candidate-bundle.js";
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
 * Dedicated installed-runtime purge scenario (issue #201, spec §9.3):
 * composes the backup-backed interactive purge orchestration over the
 * harness's scenario seams (issue #197) so #44 can compose it into larger
 * corpora later. One run proves, in one dedicated generated test Vault:
 * install → explicit operator enablement → Bridge start → registration
 * command generation (never execution) → real work queued through the MCP
 * surface → purge refused while work is queued (live and offline persisted
 * evidence) → drained restart → purge refused on an unresolved Recovery
 * Journal frame → purge refused without a confirmation seam and refused on
 * operator cancellation (state byte-identical afterwards) → ordinary
 * uninstall → backup-backed confirmed purge → lifecycle verification
 * (`not_installed`, operational state gone, Vault content intact, backup
 * independently re-verifiable, rerun `already_purged`) → cleanup with no
 * residue.
 *
 * This is a scenario on top of the harness seams, not a replacement for the
 * harness's complete verification corpus.
 */

export type PurgeScenarioStage =
  | "provision"
  | "install_release"
  | "operator_enablement"
  | "obsidian_start"
  | "registration_command"
  | "queue_work"
  | "refusal_queued_work"
  | "obsidian_stop"
  | "refusal_queued_work_offline"
  | "obsidian_restart_drain"
  | "refusal_unresolved_recovery"
  | "refusal_non_interactive"
  | "refusal_operator_cancelled"
  | "uninstall"
  | "purge"
  | "post_purge_verification"
  | "cleanup";

export interface PurgeScenarioStageRecord {
  readonly stage: PurgeScenarioStage;
  readonly outcome: "passed" | "failed";
  readonly detail: string | null;
}

export interface PurgeScenarioOptions {
  /** The verified candidate under test — the release verifier's branded result. */
  readonly candidate: VerifiedReleaseBundle;
  /** Obsidian runtime version reported for the generated test Vault. */
  readonly obsidianVersion: string;
  readonly workingDirectory: string;
  readonly processControl: ObsidianProcessControl;
  readonly client?: LoopbackMcpClient;
  readonly runId?: string;
  readonly configDirectoryName?: string;
  readonly timeouts?: { readonly startupMs?: number; readonly stopMs?: number };
  /** Scenario seams, mirroring the harness for later composition by #44. */
  readonly provisionVault?: typeof provisionTestVault;
  readonly cleanupVault?: typeof cleanupTestVault;
}

export interface PurgeScenarioRefusal {
  readonly stage: PurgeScenarioStage;
  readonly code: ReleasePurgeFailureCode;
}

export interface PurgeScenarioResult {
  readonly verdict: "passed" | "failed";
  readonly stages: readonly PurgeScenarioStageRecord[];
  readonly failure: { readonly stage: PurgeScenarioStage; readonly detail: string } | null;
  /** Identity persisted by the first Bridge start and purged at the end. */
  readonly bridgeIdentity: PersistedBridgeIdentity | null;
  /** The registration command printed for the operator; never executed. */
  readonly registrationCommand: string | null;
  /** The Change Set drained through the real MCP surface before the purge. */
  readonly drainedChangeSetId: string | null;
  /** Every refusal the purge gate produced, in order, with its failure code. */
  readonly refusals: readonly PurgeScenarioRefusal[];
  readonly uninstall: ManagedVaultUninstallResult | null;
  readonly purge: ManagedVaultPurgeResult | null;
  /** The verified backup directory the confirmed purge produced. */
  readonly backupDirectory: string | null;
  readonly cleanup: CleanupReport | null;
}

interface StageRecorder {
  readonly records: PurgeScenarioStageRecord[];
  pass(stage: PurgeScenarioStage, detail?: string): void;
  fail(stage: PurgeScenarioStage, detail: string): Error;
}

function stageRecorder(): StageRecorder {
  const records: PurgeScenarioStageRecord[] = [];
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

/** Submits one Change Set through the real loopback MCP surface. */
async function submitChangeSet(
  endpoint: URL,
  vaultId: string,
  submissionKey: string,
  path: string,
): Promise<{ outcome: string; changeSetId: string | null }> {
  const client = new Client({ name: "installed-runtime-purge", version: "1.0.0" });
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
      | { outcome?: string; changeSet?: { changeSetId?: string } }
      | undefined;
    return {
      outcome:
        result.isError === true ? (content?.outcome ?? "error") : (content?.outcome ?? "unknown"),
      changeSetId:
        content?.changeSet !== undefined && typeof content.changeSet.changeSetId === "string"
          ? content.changeSet.changeSetId
          : null,
    };
  } finally {
    await client.close().catch(() => undefined);
  }
}

/** Appends one Recovery Journal frame to the Vault's real journal. */
async function appendJournalFrame(
  vaultPath: string,
  phase: "PREPARED" | "COMMITTED",
  changeSetId: string,
): Promise<void> {
  const handle = await open(
    join(vaultPath, BRIDGE_STATE_DIRECTORY_NAME, "recovery-journal.bin"),
    "r+",
  );
  try {
    const journal = await openRecoveryJournal(handle, {});
    await journal.write({ phase, payload: { schemaVersion: 3, changeSetId } });
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/** Independently re-verifies a purge backup: manifest coverage and hashes. */
async function verifyBackupDirectory(directory: string): Promise<string | null> {
  const manifestText = await readFile(join(directory, "checksums.sha256"), "utf8");
  const declared = new Map<string, string>();
  for (const line of manifestText.trimEnd().split("\n")) {
    const match = /^([a-f0-9]{64})  (.+)$/u.exec(line);
    if (match === null) return "The backup checksum manifest is malformed";
    declared.set(match[2]!, match[1]!);
  }
  for (const [path, expected] of declared) {
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await readFile(join(directory, path)));
    } catch {
      return `The backup is missing a declared file: ${path}`;
    }
    if (sha256Hex(bytes) !== expected) return `The backup copy failed verification: ${path}`;
  }
  return null;
}

export async function runManagedVaultPurgeScenario(
  options: PurgeScenarioOptions,
): Promise<PurgeScenarioResult> {
  const runId = options.runId ?? randomUUID();
  const configDirectoryName = options.configDirectoryName ?? ".obsidian";
  const startupMs = options.timeouts?.startupMs ?? 120_000;
  const client = options.client ?? createLoopbackMcpClient();
  const provision = options.provisionVault ?? provisionTestVault;
  const cleanupVault = options.cleanupVault ?? cleanupTestVault;
  const candidate = options.candidate;
  const pluginId = candidate.identity.pluginId;
  const backupRoot = join(options.workingDirectory, `purge-backups-${runId}`);

  const recorder = stageRecorder();
  let vault: {
    vaultPath: string;
    profileDirectory: string;
    seedNotes: readonly { path: string; content: string }[];
  } | null = null;
  let handle: ObsidianProcessHandle | null = null;
  let identity: PersistedBridgeIdentity | null = null;
  let registrationCommand: string | null = null;
  let drainedChangeSetId: string | null = null;
  let uninstallResult: ManagedVaultUninstallResult | null = null;
  let purgeResult: ManagedVaultPurgeResult | null = null;
  let backupDirectory: string | null = null;
  let cleanup: CleanupReport | null = null;
  const refusals: PurgeScenarioRefusal[] = [];

  const target = () => ({
    vaultPath: vault!.vaultPath,
    configDirectoryName,
    obsidianVersion: options.obsidianVersion,
  });

  const stopObsidian = async (stage: PurgeScenarioStage): Promise<Error | null> => {
    try {
      await handle!.stop();
      handle = null;
      recorder.pass(stage);
      return null;
    } catch (error) {
      return recorder.fail(stage, error instanceof Error ? error.message : String(error));
    }
  };

  /** Runs one purge attempt and records the expected refusal. */
  const expectRefusal = async (
    stage: PurgeScenarioStage,
    code: ReleasePurgeFailureCode,
    purgeOptions: Partial<Parameters<typeof purgeManagedVaultState>[0]>,
  ): Promise<Error | null> => {
    const attempt = await purgeManagedVaultState({
      target: target(),
      pluginId,
      backupDirectory: backupRoot,
      ...purgeOptions,
    });
    if (attempt.outcome !== "refused" || attempt.failure?.code !== code) {
      return recorder.fail(
        stage,
        `Expected refusal ${code}, observed ${attempt.outcome}/${attempt.failure?.code ?? "none"}`,
      );
    }
    refusals.push({ stage, code });
    recorder.pass(stage, code);
    return null;
  };

  let failure: PurgeScenarioResult["failure"] = null;
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
    const dataPath = join(pluginDirectory, "data.json");
    const journalPath = join(vault.vaultPath, BRIDGE_STATE_DIRECTORY_NAME, "recovery-journal.bin");

    // Install → explicit operator enablement → Bridge start.
    const installBatch = await installReleaseToManagedVaults(candidate, [target()]);
    if (installBatch.targets[0]?.outcome !== "success") {
      throw recorder.fail(
        "install_release",
        `Release did not install: ${installBatch.targets[0]?.failure?.detail ?? "no result"}`,
      );
    }
    recorder.pass("install_release");

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
          (await readPersistedBridgeIdentity(vault!.vaultPath, pluginId, configDirectoryName)) !==
          null,
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

    registrationCommand = createRegistrationCommand(vaultId, identity.port);
    recorder.pass("registration_command", registrationCommand);

    // Real work queued through the real MCP surface; with no executor wired
    // into the hosting runtime it stays queued.
    const queued = await submitChangeSet(endpoint, vaultId, "purge-scenario-1", "KeptDir");
    if (queued.outcome !== "registered" || queued.changeSetId === null) {
      throw recorder.fail("queue_work", `Change Set was not registered: ${queued.outcome}`);
    }
    const queuedHealth = await client.observeHealth(endpoint, vaultId);
    if (queuedHealth.health.queue.length !== 1) {
      throw recorder.fail(
        "queue_work",
        `Expected 1 queued Change Set, observed ${queuedHealth.health.queue.length}`,
      );
    }
    recorder.pass("queue_work", `queued: ${queued.changeSetId}`);

    // Refusal: queued work — proven against the live Bridge, then against the
    // persisted registry after the Vault stops.
    {
      const error = await expectRefusal("refusal_queued_work", "purge_work_queued", {
        observeHealth: async () => (await client.observeHealth(endpoint, vaultId)).health,
        confirm: async () => true,
      });
      if (error !== null) throw error;
    }
    {
      const error = await stopObsidian("obsidian_stop");
      if (error !== null) throw error;
    }
    {
      const error = await expectRefusal("refusal_queued_work_offline", "purge_work_queued", {
        confirm: async () => true,
      });
      if (error !== null) throw error;
    }

    // Restart: the hosting runtime drains the queued Change Set to terminal,
    // leaving a real COMMITTED Recovery Journal frame behind.
    try {
      handle = await options.processControl.start({
        vaultPath: vault.vaultPath,
        profileDirectory: vault.profileDirectory,
      });
      await waitForCondition(
        async () => (await client.observeHealth(endpoint, vaultId)).health.queue.length === 0,
        { timeoutMs: startupMs },
      );
      drainedChangeSetId = queued.changeSetId;
      recorder.pass("obsidian_restart_drain", `drained: ${drainedChangeSetId}`);
    } catch (error) {
      throw recorder.fail(
        "obsidian_restart_drain",
        error instanceof Error ? error.message : String(error),
      );
    }
    {
      const error = await stopObsidian("obsidian_stop");
      if (error !== null) throw error;
    }

    // Refusal: an unresolved Recovery Journal frame forbids the purge; the
    // settled frame (COMMITTED) clears the gate again.
    try {
      await appendJournalFrame(vault.vaultPath, "PREPARED", drainedChangeSetId);
    } catch (error) {
      throw recorder.fail(
        "refusal_unresolved_recovery",
        `Could not stage an unresolved journal frame: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    {
      const error = await expectRefusal(
        "refusal_unresolved_recovery",
        "purge_recovery_untrusted",
        { confirm: async () => true },
      );
      if (error !== null) throw error;
      await appendJournalFrame(vault.vaultPath, "COMMITTED", drainedChangeSetId);
    }

    // Refusal: non-interactive execution and operator cancellation change
    // none of the operational state (the verified backup is retained).
    const stateBeforeRefusals = sha256Hex(new Uint8Array(await readFile(dataPath)));
    {
      const error = await expectRefusal(
        "refusal_non_interactive",
        "purge_confirmation_required",
        {},
      );
      if (error !== null) throw error;
    }
    {
      const error = await expectRefusal(
        "refusal_operator_cancelled",
        "purge_confirmation_declined",
        { confirm: async () => false },
      );
      if (error !== null) throw error;
    }
    if (sha256Hex(new Uint8Array(await readFile(dataPath))) !== stateBeforeRefusals) {
      throw recorder.fail(
        "refusal_operator_cancelled",
        "A refused purge altered the persisted operational state",
      );
    }

    // Ordinary uninstall removes the release-managed files and retains all
    // operational state; the purge then removes the enumerated state itself.
    uninstallResult = await uninstallManagedVaultRelease({ target: target(), pluginId });
    if (uninstallResult.outcome !== "uninstalled") {
      throw recorder.fail(
        "uninstall",
        `Uninstall did not complete: ${uninstallResult.failure?.detail ?? uninstallResult.outcome}`,
      );
    }
    recorder.pass("uninstall");

    const confirmations: ManagedVaultPurgeConfirmation[] = [];
    purgeResult = await purgeManagedVaultState({
      target: target(),
      pluginId,
      backupDirectory: backupRoot,
      confirm: async (confirmation) => {
        confirmations.push(confirmation);
        // The affirmation is tied to this Managed Vault's identity and path.
        return confirmation.vaultId === vaultId && confirmation.vaultPath === vault!.vaultPath;
      },
    });
    if (purgeResult.outcome !== "purged") {
      throw recorder.fail(
        "purge",
        `Purge did not complete: ${purgeResult.failure?.detail ?? purgeResult.outcome}`,
      );
    }
    if (confirmations.length !== 1 || confirmations[0]?.backup.verified !== true) {
      throw recorder.fail("purge", "The purge did not request a verified per-Vault confirmation");
    }
    backupDirectory = purgeResult.backup?.directory ?? null;
    recorder.pass("purge", `backup: ${backupDirectory ?? "none"}`);

    // Post-purge verification: lifecycle projects not_installed with the
    // operational state gone and every byte of Vault content intact.
    const status = await verifyManagedVaultLifecycle(
      { vaultPath: vault.vaultPath, configDirectoryName, expectedPluginId: pluginId },
      { isMcpRegistered: async () => false },
    );
    if (status.state !== "not_installed") {
      throw recorder.fail(
        "post_purge_verification",
        `Expected lifecycle state not_installed after the purge, projected ${status.state}`,
      );
    }
    const stateSurvivors: string[] = [];
    if (await pathExists(dataPath)) stateSurvivors.push(dataPath);
    if (await pathExists(journalPath)) stateSurvivors.push(journalPath);
    const managedSurvivors = (await readdir(pluginDirectory)).filter(isReleaseManagedFile);
    if (stateSurvivors.length > 0 || managedSurvivors.length > 0) {
      throw recorder.fail(
        "post_purge_verification",
        `State survived the purge: ${[...stateSurvivors, ...managedSurvivors].join(", ")}`,
      );
    }
    for (const seed of vault.seedNotes) {
      const content = await readFile(join(vault.vaultPath, ...seed.path.split("/")), "utf8");
      if (content !== seed.content) {
        throw recorder.fail("post_purge_verification", `Vault content was altered: ${seed.path}`);
      }
    }
    if (!(await pathExists(join(vault.vaultPath, "KeptDir")))) {
      throw recorder.fail("post_purge_verification", "The drained Change Set's Vault content vanished");
    }
    if (backupDirectory === null || (await verifyBackupDirectory(backupDirectory)) !== null) {
      throw recorder.fail(
        "post_purge_verification",
        `The purge backup did not independently re-verify: ${backupDirectory ?? "none"}`,
      );
    }
    const backedUpSettings = JSON.parse(
      await readFile(
        join(backupDirectory, "files", configDirectoryName, "plugins", pluginId, "data.json"),
        "utf8",
      ),
    ) as { vaultId?: string; port?: number; changeSets?: { entries?: { submissionKey?: string }[] } };
    if (
      backedUpSettings.vaultId !== vaultId ||
      backedUpSettings.port !== identity.port ||
      backedUpSettings.changeSets?.entries?.[0]?.submissionKey !== "purge-scenario-1"
    ) {
      throw recorder.fail(
        "post_purge_verification",
        "The backup does not preserve the Vault identity, endpoint, and Submission Key records",
      );
    }
    // Deterministic rerun: already purged.
    const rerun = await purgeManagedVaultState({
      target: target(),
      pluginId,
      backupDirectory: backupRoot,
      confirm: async () => true,
    });
    if (rerun.outcome !== "already_purged") {
      throw recorder.fail(
        "post_purge_verification",
        `Rerun did not report already_purged: ${rerun.outcome}`,
      );
    }
    recorder.pass("post_purge_verification");
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
      // The scenario's backups are removed too: no residue from the run.
      await rm(backupRoot, { recursive: true, force: true });
      const residualPaths = [...cleanup.residualPaths];
      if (await pathExists(backupRoot)) residualPaths.push("purge-backups");
      if (residualPaths.length > 0) {
        cleanup = { ...cleanup, residualPaths };
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
    registrationCommand,
    drainedChangeSetId,
    refusals,
    uninstall: uninstallResult,
    purge: purgeResult,
    backupDirectory,
    cleanup,
  };
}
