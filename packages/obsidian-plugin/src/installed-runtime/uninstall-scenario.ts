import { randomUUID } from "node:crypto";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import {
  installReleaseToManagedVaults,
  type ReleaseInstallTargetResult,
} from "../lifecycle/install-release.js";
import { verifyManagedVaultLifecycle } from "../lifecycle/lifecycle-status.js";
import {
  isReleaseManagedFile,
  managedVaultPluginDirectory,
} from "../lifecycle/release-managed-files.js";
import {
  uninstallManagedVaultRelease,
  type ManagedVaultUninstallResult,
} from "../lifecycle/uninstall-release.js";
import {
  createRegistrationCommand,
  createRegistrationRemovalCommand,
} from "../registration-command.js";
import { EXPECTED_VAULT_ID_HEADER } from "../request-policy.js";
import type { VerifiedReleaseBundle } from "../release/verify-release-bundle.js";
import { sha256Hex } from "./candidate-bundle.js";
import {
  createLoopbackMcpClient,
  HealthObservationError,
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
 * Dedicated installed-runtime uninstall scenario (issue #200, spec §9.3):
 * composes the fail-closed uninstall orchestration over the harness's
 * scenario seams (issue #197) so #44 can compose it into larger corpora
 * later. One run proves, in one dedicated generated test Vault: install →
 * explicit operator enablement → Bridge start → registration command
 * generation (never execution) → real work through the MCP surface drained to
 * terminal → offline uninstall removing only release-managed files →
 * lifecycle verification after removal (files gone, state retained
 * byte-for-byte) → lossless same-version reinstall restoring the same Vault
 * identity, endpoint/port, queue/idempotency records, settings, and recovery
 * state (no fresh Managed Vault) → cleanup with no residue.
 *
 * This is a scenario on top of the harness seams, not a replacement for the
 * harness's complete verification corpus.
 */

export type UninstallScenarioStage =
  | "provision"
  | "install_release"
  | "operator_enablement"
  | "obsidian_start"
  | "registration_command"
  | "work_through_mcp"
  | "obsidian_stop"
  | "uninstall"
  | "post_uninstall_verification"
  | "reinstall"
  | "obsidian_restart"
  | "restored_bridge_identity"
  | "cleanup";

export interface UninstallScenarioStageRecord {
  readonly stage: UninstallScenarioStage;
  readonly outcome: "passed" | "failed";
  readonly detail: string | null;
}

export interface UninstallScenarioOptions {
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

export interface UninstallScenarioResult {
  readonly verdict: "passed" | "failed";
  readonly stages: readonly UninstallScenarioStageRecord[];
  readonly failure: { readonly stage: UninstallScenarioStage; readonly detail: string } | null;
  /** Identity persisted by the first Bridge start and required stable across uninstall/reinstall. */
  readonly bridgeIdentity: PersistedBridgeIdentity | null;
  /** The registration command printed for the operator; never executed. */
  readonly registrationCommand: string | null;
  /** The registration-removal command printed by uninstall; never executed. */
  readonly registrationRemovalCommand: string | null;
  /** The Change Set drained through the real MCP surface before uninstall. */
  readonly drainedChangeSetId: string | null;
  readonly uninstall: ManagedVaultUninstallResult | null;
  readonly reinstall: ReleaseInstallTargetResult | null;
  readonly cleanup: CleanupReport | null;
}

interface StageRecorder {
  readonly records: UninstallScenarioStageRecord[];
  pass(stage: UninstallScenarioStage, detail?: string): void;
  fail(stage: UninstallScenarioStage, detail: string): Error;
}

function stageRecorder(): StageRecorder {
  const records: UninstallScenarioStageRecord[] = [];
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

/** Digest over every non-release-managed byte under the plugin directory. */
async function operationalStateDigest(pluginDirectory: string): Promise<string | null> {
  const lines: string[] = [];
  const walk = async (directory: string, prefix: string): Promise<void> => {
    let children: string[];
    try {
      children = await readdir(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    for (const child of children.sort()) {
      const absolute = join(directory, child);
      const relativePath = prefix === "" ? child : `${prefix}/${child}`;
      if (isReleaseManagedFile(child) && prefix === "") continue;
      if ((await stat(absolute)).isDirectory()) {
        await walk(absolute, relativePath);
      } else {
        lines.push(`${sha256Hex(new Uint8Array(await readFile(absolute)))}  ${relativePath}`);
      }
    }
  };
  await walk(pluginDirectory, "");
  if (lines.length === 0) return null;
  return sha256Hex(new TextEncoder().encode(`${lines.sort().join("\n")}\n`));
}

/** Submits one Change Set through the real loopback MCP surface. */
async function submitChangeSet(
  endpoint: URL,
  vaultId: string,
  submissionKey: string,
  path: string,
): Promise<{ outcome: string; changeSetId: string | null }> {
  const client = new Client({ name: "installed-runtime-uninstall", version: "1.0.0" });
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

export async function runManagedVaultUninstallScenario(
  options: UninstallScenarioOptions,
): Promise<UninstallScenarioResult> {
  const runId = options.runId ?? randomUUID();
  const configDirectoryName = options.configDirectoryName ?? ".obsidian";
  const startupMs = options.timeouts?.startupMs ?? 120_000;
  const client = options.client ?? createLoopbackMcpClient();
  const provision = options.provisionVault ?? provisionTestVault;
  const cleanupVault = options.cleanupVault ?? cleanupTestVault;
  const candidate = options.candidate;
  const pluginId = candidate.identity.pluginId;

  const recorder = stageRecorder();
  let vault: { vaultPath: string; profileDirectory: string } | null = null;
  let handle: ObsidianProcessHandle | null = null;
  let identity: PersistedBridgeIdentity | null = null;
  let registrationCommand: string | null = null;
  let registrationRemovalCommand: string | null = null;
  let drainedChangeSetId: string | null = null;
  let uninstallResult: ManagedVaultUninstallResult | null = null;
  let reinstallResult: ReleaseInstallTargetResult | null = null;
  let cleanup: CleanupReport | null = null;
  // The operator's registration action is simulated by flipping this flag
  // after the scenario generates (but never executes) the commands.
  let mcpRegistered = false;

  const target = () => ({
    vaultPath: vault!.vaultPath,
    configDirectoryName,
    obsidianVersion: options.obsidianVersion,
  });
  const scenarioObserveBridge = async (
    persisted: PersistedBridgeIdentity,
  ): Promise<{ vaultId: string; port: number } | null> => {
    try {
      await client.observeHealth(
        new URL(`http://127.0.0.1:${persisted.port}/mcp`),
        persisted.vaultId,
      );
      return { vaultId: persisted.vaultId, port: persisted.port };
    } catch (error) {
      if (error instanceof HealthObservationError) return null;
      return null;
    }
  };

  let failure: UninstallScenarioResult["failure"] = null;
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

    // The registration command is generated for the Primary Operator, printed
    // into the result, and never executed by the plugin.
    registrationCommand = createRegistrationCommand(vaultId, identity.port);
    mcpRegistered = true;
    recorder.pass("registration_command", registrationCommand);

    // Real work through the real MCP surface, drained to a trustworthy
    // terminal state; the terminal record is the retained idempotency
    // evidence the reinstall must restore.
    const submitted = await submitChangeSet(endpoint, vaultId, "uninstall-scenario-1", "KeptDir");
    if (submitted.outcome !== "registered" || submitted.changeSetId === null) {
      throw recorder.fail(
        "work_through_mcp",
        `Change Set was not registered: ${submitted.outcome}`,
      );
    }
    drainedChangeSetId = submitted.changeSetId;
    try {
      await waitForCondition(
        async () => (await client.observeHealth(endpoint, vaultId)).health.queue.length === 0,
        { timeoutMs: startupMs },
      );
    } catch {
      throw recorder.fail("work_through_mcp", "The submitted Change Set did not drain");
    }
    recorder.pass("work_through_mcp", `drained: ${drainedChangeSetId}`);

    // Offline: ordinary uninstall runs against a stopped Vault.
    try {
      await handle.stop();
      handle = null;
      recorder.pass("obsidian_stop");
    } catch (error) {
      throw recorder.fail(
        "obsidian_stop",
        error instanceof Error ? error.message : String(error),
      );
    }

    const stateBefore = await operationalStateDigest(pluginDirectory);
    uninstallResult = await uninstallManagedVaultRelease({
      target: target(),
      pluginId,
    });
    if (uninstallResult.outcome !== "uninstalled") {
      throw recorder.fail(
        "uninstall",
        `Uninstall did not complete: ${uninstallResult.failure?.detail ?? uninstallResult.outcome}`,
      );
    }
    // The exact operator command is printed and never executed; it is the
    // counterpart of the registration command for this Vault.
    registrationRemovalCommand = uninstallResult.registrationRemovalCommand;
    if (registrationRemovalCommand !== createRegistrationRemovalCommand(vaultId)) {
      throw recorder.fail(
        "uninstall",
        `Uninstall printed the wrong registration-removal command: ${registrationRemovalCommand ?? "none"}`,
      );
    }
    mcpRegistered = false;
    recorder.pass("uninstall", registrationRemovalCommand);

    // Lifecycle verification after removal: the managed set is gone (so the
    // projection is not_installed) while every operational byte survived.
    const status = await verifyManagedVaultLifecycle(
      { vaultPath: vault.vaultPath, configDirectoryName, expectedPluginId: pluginId },
      { observeBridge: scenarioObserveBridge, isMcpRegistered: async () => mcpRegistered },
    );
    if (status.state !== "not_installed") {
      throw recorder.fail(
        "post_uninstall_verification",
        `Expected lifecycle state not_installed after uninstall, projected ${status.state}`,
      );
    }
    const remainingManaged = (await readdir(pluginDirectory)).filter(isReleaseManagedFile);
    const stateAfter = await operationalStateDigest(pluginDirectory);
    if (remainingManaged.length > 0 || stateBefore === null || stateBefore !== stateAfter) {
      throw recorder.fail(
        "post_uninstall_verification",
        `Removal left managed files (${remainingManaged.join(", ") || "none"}) or altered retained state`,
      );
    }
    recorder.pass("post_uninstall_verification");

    // Lossless same-version reinstall: the installer redeploys the managed
    // files onto the retained state — never a fresh Managed Vault.
    const reinstallBatch = await installReleaseToManagedVaults(candidate, [target()]);
    reinstallResult = reinstallBatch.targets[0] ?? null;
    if (reinstallResult === null || reinstallResult.outcome !== "success") {
      throw recorder.fail(
        "reinstall",
        `Reinstall did not succeed: ${reinstallResult?.failure?.detail ?? "no target result"}`,
      );
    }
    if ((await operationalStateDigest(pluginDirectory)) !== stateBefore) {
      throw recorder.fail("reinstall", "Reinstall altered retained operational state");
    }
    recorder.pass("reinstall", `action: ${reinstallResult.action}`);

    // The restarted Bridge loads the retained state: same Vault identity,
    // same endpoint — not a fresh Managed Vault.
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
      recorder.pass("obsidian_restart");
    } catch (error) {
      throw recorder.fail(
        "obsidian_restart",
        error instanceof Error ? error.message : String(error),
      );
    }

    const restoredIdentity = await readPersistedBridgeIdentity(
      vault.vaultPath,
      pluginId,
      configDirectoryName,
    );
    const restoredHealth = (await client.observeHealth(endpoint, vaultId)).health;
    const persisted = JSON.parse(await readFile(join(pluginDirectory, "data.json"), "utf8")) as {
      vaultId?: string;
      port?: number;
      diagnosticPath?: string;
      changeSets?: {
        entries?: { submissionKey?: string; changeSetId?: string; state?: string }[];
      };
    };
    const retainedRecord = persisted.changeSets?.entries?.find(
      (entry) => entry.submissionKey === "uninstall-scenario-1",
    );
    if (
      restoredIdentity === null ||
      restoredIdentity.vaultId !== identity.vaultId ||
      restoredIdentity.port !== identity.port ||
      restoredHealth.vault.id !== identity.vaultId ||
      restoredHealth.listener.port !== identity.port ||
      restoredHealth.recovery.state !== "none" ||
      restoredHealth.queue.length !== 0 ||
      persisted.vaultId !== identity.vaultId ||
      persisted.port !== identity.port ||
      retainedRecord?.changeSetId !== drainedChangeSetId
    ) {
      throw recorder.fail(
        "restored_bridge_identity",
        "Reinstall did not restore the same Vault identity, endpoint, settings, and " +
          `idempotency records: ${JSON.stringify({
            restoredIdentity,
            health: { vault: restoredHealth.vault.id, port: restoredHealth.listener.port },
            retainedRecord: retainedRecord ?? null,
          })}`,
      );
    }
    // The retained idempotency record replays through the real MCP surface:
    // resubmitting the drained Submission Key returns the same Change Set
    // instead of registering fresh work.
    const replayed = await submitChangeSet(endpoint, vaultId, "uninstall-scenario-1", "KeptDir");
    if (replayed.outcome !== "registered" || replayed.changeSetId !== drainedChangeSetId) {
      throw recorder.fail(
        "restored_bridge_identity",
        `The retained Submission Key did not replay the drained Change Set: ${replayed.outcome}`,
      );
    }
    // Registration is the operator's explicit step again; with the simulated
    // re-registration the Vault projects fully ready.
    mcpRegistered = true;
    const restoredStatus = await verifyManagedVaultLifecycle(
      { vaultPath: vault.vaultPath, configDirectoryName, expectedPluginId: pluginId },
      { observeBridge: scenarioObserveBridge, isMcpRegistered: async () => mcpRegistered },
    );
    if (restoredStatus.state !== "ready") {
      throw recorder.fail(
        "restored_bridge_identity",
        `Expected lifecycle state ready after reinstall, projected ${restoredStatus.state}`,
      );
    }
    recorder.pass("restored_bridge_identity", `${restoredIdentity.vaultId} @ ${restoredIdentity.port}`);

    try {
      await handle.stop();
      handle = null;
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
    registrationCommand,
    registrationRemovalCommand,
    drainedChangeSetId,
    uninstall: uninstallResult,
    reinstall: reinstallResult,
    cleanup,
  };
}
