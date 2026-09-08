import { randomUUID } from "node:crypto";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  installReleaseToManagedVaults,
  type ReleaseInstallTargetResult,
} from "../lifecycle/install-release.js";
import {
  verifyManagedVaultLifecycle,
  type ManagedVaultLifecycleState,
  type ObservedBridgeEndpoint,
} from "../lifecycle/lifecycle-status.js";
import {
  isReleaseManagedFile,
  managedVaultPluginDirectory,
} from "../lifecycle/release-managed-files.js";
import { createRegistrationCommand } from "../registration-command.js";
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
 * Dedicated installed-runtime lifecycle scenario (issue #198): composes the
 * lifecycle installer and status projection over the harness's scenario
 * seams (issue #197) so #44 can compose it into larger corpora later. One
 * run proves, in one dedicated generated test Vault: first install (files
 * only) → explicit operator enablement → Bridge start with persisted
 * identity → registration command generation (never execution) → `ready` →
 * same-version reinstall `unchanged` → damage-and-repair with byte-exact
 * state preservation → the identity-mismatch projection → cleanup with no
 * residue.
 *
 * This is a scenario on top of the harness seams, not a replacement for the
 * harness's complete verification corpus.
 */

export type LifecycleScenarioStage =
  | "provision"
  | "status_not_installed"
  | "first_install"
  | "status_installed_not_enabled"
  | "operator_enablement"
  | "status_bridge_offline"
  | "obsidian_start"
  | "status_mcp_not_registered"
  | "registration_command"
  | "status_ready"
  | "reinstall_unchanged"
  | "damage_and_repair"
  | "state_preservation"
  | "identity_mismatch_projection"
  | "obsidian_stop"
  | "cleanup";

export interface LifecycleScenarioStageRecord {
  readonly stage: LifecycleScenarioStage;
  readonly outcome: "passed" | "failed";
  readonly detail: string | null;
}

export interface LifecycleScenarioOptions {
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

export interface LifecycleScenarioResult {
  readonly verdict: "passed" | "failed";
  readonly stages: readonly LifecycleScenarioStageRecord[];
  readonly failure: { readonly stage: LifecycleScenarioStage; readonly detail: string } | null;
  /** Identity persisted by the first Bridge start and required stable across repair. */
  readonly bridgeIdentity: PersistedBridgeIdentity | null;
  /** The explicit registration command generated for the operator; never executed. */
  readonly registrationCommand: string | null;
  readonly install: ReleaseInstallTargetResult | null;
  readonly repair: ReleaseInstallTargetResult | null;
  readonly cleanup: CleanupReport | null;
}

interface StageRecorder {
  readonly records: LifecycleScenarioStageRecord[];
  pass(stage: LifecycleScenarioStage, detail?: string): void;
  fail(stage: LifecycleScenarioStage, detail: string): Error;
}

function stageRecorder(): StageRecorder {
  const records: LifecycleScenarioStageRecord[] = [];
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

export async function runLifecycleInstallScenario(
  options: LifecycleScenarioOptions,
): Promise<LifecycleScenarioResult> {
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
  let installResult: ReleaseInstallTargetResult | null = null;
  let repairResult: ReleaseInstallTargetResult | null = null;
  let cleanup: CleanupReport | null = null;
  // The operator's registration action is simulated by flipping this flag
  // after the scenario generates (but never executes) the command.
  let mcpRegistered = false;

  const target = () => ({
    vaultPath: vault!.vaultPath,
    configDirectoryName,
    obsidianVersion: options.obsidianVersion,
  });
  const statusTarget = () => ({
    vaultPath: vault!.vaultPath,
    configDirectoryName,
    expectedPluginId: pluginId,
  });
  const expectStatus = async (
    stage: LifecycleScenarioStage,
    expected: ManagedVaultLifecycleState,
  ): Promise<void> => {
    const status = await verifyManagedVaultLifecycle(statusTarget(), {
      observeBridge: scenarioObserveBridge,
      isMcpRegistered: async () => mcpRegistered,
    });
    if (status.state !== expected) {
      throw recorder.fail(
        stage,
        `Expected lifecycle state ${expected}, projected ${status.state} (${status.detail ?? "no detail"})`,
      );
    }
    recorder.pass(stage, status.detail ?? undefined);
  };
  const scenarioObserveBridge = async (
    persisted: PersistedBridgeIdentity,
  ): Promise<ObservedBridgeEndpoint | null> => {
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

  let failure: LifecycleScenarioResult["failure"] = null;
  try {
    // Provision one dedicated generated test Vault through the harness seam.
    try {
      vault = await provision({ workingDirectory: options.workingDirectory, runId, configDirectoryName });
      recorder.pass("provision");
    } catch (error) {
      throw recorder.fail("provision", error instanceof Error ? error.message : String(error));
    }
    const pluginDirectory = managedVaultPluginDirectory(
      vault.vaultPath,
      configDirectoryName,
      pluginId,
    );

    await expectStatus("status_not_installed", "not_installed");

    // First install: files only — no enablement, no identity, no registration.
    const batch = await installReleaseToManagedVaults(candidate, [target()]);
    installResult = batch.targets[0] ?? null;
    if (installResult === null || installResult.outcome !== "success" || installResult.action !== "installed") {
      throw recorder.fail(
        "first_install",
        `First install did not succeed: ${installResult?.failure?.detail ?? "no target result"}`,
      );
    }
    if (
      installResult.deployment?.state !== "artifacts_installed" ||
      installResult.deployment.requiredNextSteps.join(",") !==
        "plugin_enablement_required,mcp_registration_required"
    ) {
      throw recorder.fail(
        "first_install",
        "First install did not project artifacts_installed with both required operator steps",
      );
    }
    try {
      await readFile(join(vault.vaultPath, configDirectoryName, "community-plugins.json"), "utf8");
      throw recorder.fail(
        "first_install",
        "First install enabled the plugin; deployment must be files-only",
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if ((await operationalStateDigest(pluginDirectory)) !== null) {
      throw recorder.fail(
        "first_install",
        "First install created plugin operational state (identity/port/queue)",
      );
    }
    recorder.pass("first_install");

    await expectStatus("status_installed_not_enabled", "installed_not_enabled");

    // Explicit operator enablement: the scenario performs the Obsidian-UI
    // step; the installer itself never writes the enabled-plugin inventory.
    await writeFile(
      join(vault.vaultPath, configDirectoryName, "community-plugins.json"),
      `${JSON.stringify([pluginId])}\n`,
      "utf8",
    );
    recorder.pass("operator_enablement");

    await expectStatus("status_bridge_offline", "bridge_offline");

    // Bridge start through the process-control seam; the loaded plugin
    // persists its Vault identity.
    let startedIdentity: PersistedBridgeIdentity;
    try {
      handle = await options.processControl.start({
        vaultPath: vault.vaultPath,
        profileDirectory: vault.profileDirectory,
      });
      let observedIdentity: PersistedBridgeIdentity | null = null;
      await waitForCondition(
        async () => {
          observedIdentity = await readPersistedBridgeIdentity(
            vault!.vaultPath,
            pluginId,
            configDirectoryName,
          );
          return observedIdentity !== null;
        },
        { timeoutMs: startupMs },
      );
      if (observedIdentity === null) {
        throw new Error("The Bridge identity was not persisted");
      }
      startedIdentity = observedIdentity;
      identity = startedIdentity;
      recorder.pass("obsidian_start");
    } catch (error) {
      if (recorder.records.at(-1)?.stage !== "obsidian_start") {
        throw recorder.fail(
          "obsidian_start",
          error instanceof Error ? error.message : String(error),
        );
      }
      throw error;
    }

    await expectStatus("status_mcp_not_registered", "mcp_not_registered");

    // The Bridge's explicit registration command is generated for the Primary
    // Operator, printed into the result, and never executed by the plugin.
    registrationCommand = createRegistrationCommand(startedIdentity.vaultId, startedIdentity.port);
    mcpRegistered = true;
    recorder.pass("registration_command", registrationCommand);

    await expectStatus("status_ready", "ready");

    // Same-version reinstall with every managed file intact: unchanged.
    const unchanged = await installReleaseToManagedVaults(candidate, [target()]);
    const unchangedTarget = unchanged.targets[0];
    if (unchangedTarget?.outcome !== "unchanged") {
      throw recorder.fail(
        "reinstall_unchanged",
        `Same-version reinstall projected ${unchangedTarget?.outcome ?? "no result"} instead of unchanged`,
      );
    }
    recorder.pass("reinstall_unchanged");

    // Damage one managed file, then reinstall: only that file is repaired
    // while Vault identity, port, and all operational state survive.
    const stateBefore = await operationalStateDigest(pluginDirectory);
    const mainPath = join(pluginDirectory, "main.js");
    const originalMain = new Uint8Array(await readFile(mainPath));
    const damagedMain = new Uint8Array(originalMain);
    damagedMain[0] = damagedMain[0]! ^ 0xff;
    await writeFile(mainPath, damagedMain);
    const repairBatch = await installReleaseToManagedVaults(candidate, [target()]);
    repairResult = repairBatch.targets[0] ?? null;
    if (
      repairResult === null ||
      repairResult.outcome !== "success" ||
      repairResult.action !== "repaired" ||
      repairResult.repairedFiles.join(",") !== "main.js"
    ) {
      throw recorder.fail(
        "damage_and_repair",
        `Repair did not restore exactly main.js: ${repairResult?.failure?.detail ?? repairResult?.action ?? "no result"}`,
      );
    }
    recorder.pass("damage_and_repair", `repaired: ${repairResult.repairedFiles.join(", ")}`);

    const stateAfter = await operationalStateDigest(pluginDirectory);
    const identityAfter = await readPersistedBridgeIdentity(
      vault.vaultPath,
      pluginId,
      configDirectoryName,
    );
    if (
      stateBefore === null ||
      stateBefore !== stateAfter ||
      identityAfter === null ||
      identityAfter.vaultId !== startedIdentity.vaultId ||
      identityAfter.port !== startedIdentity.port
    ) {
      throw recorder.fail(
        "state_preservation",
        "Vault identity, persistent port, or operational state did not survive repair",
      );
    }
    recorder.pass("state_preservation");

    // The identity-mismatch projection: a Bridge answering with another
    // Vault ID must never project ready.
    const mismatch = await verifyManagedVaultLifecycle(statusTarget(), {
      observeBridge: async (persisted) => ({ vaultId: `not-${persisted.vaultId}`, port: persisted.port }),
      isMcpRegistered: async () => true,
    });
    if (mismatch.state !== "identity_mismatch") {
      throw recorder.fail(
        "identity_mismatch_projection",
        `A foreign Bridge projected ${mismatch.state} instead of identity_mismatch`,
      );
    }
    recorder.pass("identity_mismatch_projection");

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
    install: installResult,
    repair: repairResult,
    cleanup,
  };
}
