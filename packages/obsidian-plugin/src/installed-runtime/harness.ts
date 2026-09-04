import { randomUUID } from "node:crypto";
import { connect } from "node:net";

import {
  CandidateBundleError,
  inspectCandidateBundle,
  installCandidateBundle,
  sha256Hex,
  type CandidateBundleIdentity,
} from "./candidate-bundle.js";
import {
  writeEvidenceFile,
  type InstalledRuntimeEvidence,
  type InstalledRuntimeVerdict,
} from "./evidence.js";
import {
  createLoopbackMcpClient,
  HealthObservationError,
  type BridgeHealthObservation,
  type LoopbackMcpClient,
} from "./loopback-client.js";
import {
  BridgeIdentityError,
  ObsidianProcessError,
  ReadinessTimeoutError,
  readPersistedBridgeIdentity,
  waitForCondition,
  type ObsidianProcessControl,
  type ObsidianProcessHandle,
  type PersistedBridgeIdentity,
} from "./obsidian-process.js";
import {
  hostOsBuild,
  lookupRegisteredRuntimeProfile,
  preflightRuntimeProfile,
  type ObservedRuntimeEnvironment,
  type RegisteredRuntimeProfile,
  type RuntimeEnvironmentProbe,
  type RuntimePreflightMismatch,
} from "./runtime-profile.js";
import {
  cleanupTestVault,
  compareInventories,
  provisionTestVault,
  snapshotInventory,
  TestVaultError,
  type CleanupReport,
  type ProvisionedTestVault,
  type VaultInventoryEntry,
} from "./test-vault.js";

/**
 * Installed-runtime harness orchestrator (issue #197): preflights the
 * registered runtime profile, provisions one dedicated generated test Vault
 * and profile, installs and enables the candidate bundle, starts real
 * Obsidian, observes schema-valid `vault_health` over loopback Streamable
 * HTTP with the expected Vault ID, repeats the observation across a
 * controlled stop/restart, then cleans up and records evidence. Every failure
 * projects to failed or invalid evidence — never to a skipped green result.
 */

export type HarnessStage =
  | "preflight"
  | "provision"
  | "candidate"
  | "inventory_before"
  | "obsidian_start"
  | "bridge_readiness"
  | "health_initial"
  | "obsidian_stop"
  | "obsidian_restart"
  | "health_restart"
  | "inventory_after"
  | "cleanup";

export type HarnessFailureCode =
  | "unregistered_profile"
  | "profile_probe_failed"
  | "profile_mismatch"
  | "vault_root_exists"
  | "vault_provision_failed"
  | "candidate_file_missing"
  | "candidate_file_unexpected"
  | "candidate_checksum_mismatch"
  | "candidate_manifest_invalid"
  | "inventory_failed"
  | "obsidian_start_failed"
  | "obsidian_stop_failed"
  | "bridge_identity_invalid"
  | "bridge_readiness_timeout"
  | "bridge_still_reachable"
  | "restart_identity_mismatch"
  | "health_unreachable"
  | "health_schema_invalid"
  | "health_incompatible"
  | "endpoint_not_loopback"
  | "identity_mismatch"
  | "listener_mismatch"
  | "representation_mismatch"
  | "cleanup_failed"
  | "residual_test_content";

export interface HarnessFailure {
  readonly stage: HarnessStage;
  readonly code: HarnessFailureCode;
  readonly detail?: string;
}

export interface HarnessTimeouts {
  /** Readiness deadline per Obsidian launch (default 120 s). */
  readonly startupMs?: number;
  /** Stop/exit deadline per controlled stop (default 30 s). */
  readonly stopMs?: number;
  /** Post-stop loopback teardown deadline (default 10 s). */
  readonly portClosedMs?: number;
}

export interface InstalledRuntimeHarnessOptions {
  readonly profileName: string;
  readonly candidateBundleDirectory: string;
  /** Parent directory under which the generated Vault/profile roots are created. */
  readonly workingDirectory: string;
  /** Evidence destination; an existing file is never overwritten. */
  readonly evidencePath: string;
  readonly probe: RuntimeEnvironmentProbe;
  readonly processControl: ObsidianProcessControl;
  readonly client?: LoopbackMcpClient;
  readonly profiles?: ReadonlyMap<string, RegisteredRuntimeProfile>;
  readonly timeouts?: HarnessTimeouts;
  readonly runId?: string;
  readonly now?: () => string;
  readonly configDirectoryName?: string;
  /** Scenario seams for later lifecycle tickets and failure-injection tests. */
  readonly snapshotVaultInventory?: typeof snapshotInventory;
  readonly cleanupVault?: typeof cleanupTestVault;
}

export interface InstalledRuntimeHarnessResult {
  readonly verdict: InstalledRuntimeVerdict;
  readonly failure: HarnessFailure | null;
  readonly evidence: InstalledRuntimeEvidence;
  readonly evidencePath: string;
}

/** Failures that invalidate the run's environment rather than the candidate. */
const INVALID_VERDICT_CODES: ReadonlySet<HarnessFailureCode> = new Set([
  "unregistered_profile",
  "profile_probe_failed",
  "profile_mismatch",
  "vault_root_exists",
  "vault_provision_failed",
  "candidate_file_missing",
  "candidate_file_unexpected",
  "candidate_checksum_mismatch",
  "candidate_manifest_invalid",
  "inventory_failed",
  "cleanup_failed",
  "residual_test_content",
]);

function isLoopbackPortOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}

interface PhasedObservation {
  readonly phase: "initial" | "after_restart";
  readonly observation: BridgeHealthObservation;
}

interface RunState {
  observed: ObservedRuntimeEnvironment | null;
  mismatches: readonly RuntimePreflightMismatch[];
  candidate: CandidateBundleIdentity | null;
  vault: ProvisionedTestVault | null;
  beforeInventory: VaultInventoryEntry[] | null;
  afterInventory: VaultInventoryEntry[] | null;
  observations: PhasedObservation[];
  cleanup: CleanupReport | null;
  failure: HarnessFailure | null;
}

export async function runInstalledRuntimeHarness(
  options: InstalledRuntimeHarnessOptions,
): Promise<InstalledRuntimeHarnessResult> {
  const now = options.now ?? (() => new Date().toISOString());
  const runId = options.runId ?? randomUUID();
  const startedAt = now();
  const client = options.client ?? createLoopbackMcpClient();
  const configDirectoryName = options.configDirectoryName ?? ".obsidian";
  const timeouts = {
    startupMs: options.timeouts?.startupMs ?? 120_000,
    stopMs: options.timeouts?.stopMs ?? 30_000,
    portClosedMs: options.timeouts?.portClosedMs ?? 10_000,
  };
  const takeInventory = options.snapshotVaultInventory ?? snapshotInventory;
  const cleanupVault = options.cleanupVault ?? cleanupTestVault;

  const state: RunState = {
    observed: null,
    mismatches: [],
    candidate: null,
    vault: null,
    beforeInventory: null,
    afterInventory: null,
    observations: [],
    cleanup: null,
    failure: null,
  };

  const profiles = options.profiles;
  const profile =
    profiles === undefined
      ? lookupRegisteredRuntimeProfile(options.profileName)
      : (profiles.get(options.profileName) ?? null);

  const fail = (stage: HarnessStage, code: HarnessFailureCode, detail?: string): void => {
    state.failure ??= detail === undefined ? { stage, code } : { stage, code, detail };
  };

  const sanitize = (detail: string): string => {
    let sanitized = detail;
    const replacements: [string, string][] = [
      [state.vault?.vaultPath ?? "", "<test-vault>"],
      [state.vault?.profileDirectory ?? "", "<test-profile>"],
      [options.candidateBundleDirectory, "<candidate-bundle>"],
      [options.workingDirectory, "<workdir>"],
    ];
    for (const [needle, replacement] of replacements) {
      if (needle.length > 0) sanitized = sanitized.split(needle).join(replacement);
    }
    return sanitized;
  };

  const failFromError = (stage: HarnessStage, error: unknown): void => {
    if (error instanceof CandidateBundleError) {
      fail(stage, error.code, sanitize(error.message));
    } else if (error instanceof TestVaultError) {
      fail(stage, error.code, sanitize(error.message));
    } else if (error instanceof HealthObservationError) {
      fail(stage, error.code, sanitize(error.message));
    } else if (error instanceof BridgeIdentityError) {
      fail(stage, "bridge_identity_invalid", sanitize(error.message));
    } else if (error instanceof ReadinessTimeoutError) {
      fail(stage, "bridge_readiness_timeout", sanitize(error.message));
    } else if (error instanceof ObsidianProcessError) {
      fail(stage, error.code, sanitize(error.message));
    } else {
      fail(stage, "inventory_failed", sanitize(error instanceof Error ? error.message : String(error)));
    }
  };

  let handle: ObsidianProcessHandle | null = null;
  let firstIdentity = null as PersistedBridgeIdentity | null;

  class BridgeStillReachableError extends Error {}

  const stopObsidian = async (): Promise<void> => {
    const current = handle;
    handle = null;
    if (current === null) return;
    await current.stop();
    if (firstIdentity !== null) {
      const deadline = Date.now() + timeouts.portClosedMs;
      while (await isLoopbackPortOpen(firstIdentity.port)) {
        if (Date.now() >= deadline) {
          throw new BridgeStillReachableError(
            "Bridge listener survived the controlled Obsidian stop",
          );
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
  };

  const startAndObserve = async (
    startStage: "obsidian_start" | "obsidian_restart",
    healthStage: "health_initial" | "health_restart",
    phase: "initial" | "after_restart",
  ): Promise<void> => {
    const vault = state.vault;
    const candidate = state.candidate;
    if (vault === null || candidate === null) return;
    try {
      handle = await options.processControl.start({
        vaultPath: vault.vaultPath,
        profileDirectory: vault.profileDirectory,
      });
    } catch (error) {
      failFromError(startStage, error);
      return;
    }
    let identity: PersistedBridgeIdentity;
    try {
      let observedIdentity: PersistedBridgeIdentity | null = null;
      await waitForCondition(
        async () => {
          observedIdentity = await readPersistedBridgeIdentity(
            vault.vaultPath,
            candidate.pluginId,
            configDirectoryName,
          );
          return observedIdentity !== null;
        },
        { timeoutMs: timeouts.startupMs },
      );
      if (observedIdentity === null) throw new BridgeIdentityError("Bridge identity unavailable");
      identity = observedIdentity;
    } catch (error) {
      failFromError("bridge_readiness", error);
      return;
    }
    if (firstIdentity === null) {
      firstIdentity = identity;
    } else if (
      identity.vaultId !== firstIdentity.vaultId ||
      identity.port !== firstIdentity.port
    ) {
      fail(
        healthStage,
        "restart_identity_mismatch",
        "The Bridge identity changed across the controlled restart",
      );
      return;
    }
    try {
      const endpoint = new URL(`http://127.0.0.1:${identity.port}/mcp`);
      const observation = await client.observeHealth(endpoint, identity.vaultId);
      state.observations.push({ phase, observation });
    } catch (error) {
      failFromError(healthStage, error);
      return;
    }
    try {
      await stopObsidian();
    } catch (error) {
      if (error instanceof BridgeStillReachableError) {
        fail("obsidian_stop", "bridge_still_reachable", sanitize(error.message));
      } else {
        failFromError("obsidian_stop", error);
      }
    }
  };

  // Preflight: the registered profile must exist and match the probed host.
  if (profile === null) {
    fail("preflight", "unregistered_profile", `No registered runtime profile named ${options.profileName}`);
  } else {
    try {
      state.observed = await options.probe.probe();
    } catch (error) {
      fail("preflight", "profile_probe_failed", sanitize(error instanceof Error ? error.message : String(error)));
    }
    if (state.observed !== null) {
      state.mismatches = preflightRuntimeProfile(profile, state.observed);
      if (state.mismatches.length > 0) {
        fail("preflight", "profile_mismatch", "The probed runtime does not match the registered profile");
      }
    }
  }

  if (state.failure === null) {
    try {
      state.vault = await provisionTestVault({
        workingDirectory: options.workingDirectory,
        runId,
        configDirectoryName,
      });
    } catch (error) {
      failFromError("provision", error);
    }
  }

  if (state.failure === null) {
    try {
      state.candidate = await inspectCandidateBundle(options.candidateBundleDirectory);
      await installCandidateBundle(
        options.candidateBundleDirectory,
        state.candidate,
        state.vault!.vaultPath,
        configDirectoryName,
      );
    } catch (error) {
      failFromError("candidate", error);
    }
  }

  if (state.failure === null) {
    try {
      state.beforeInventory = await takeInventory(state.vault!.vaultPath);
    } catch (error) {
      fail("inventory_before", "inventory_failed", sanitize(error instanceof Error ? error.message : String(error)));
    }
  }

  if (state.failure === null) {
    await startAndObserve("obsidian_start", "health_initial", "initial");
  }
  if (state.failure === null) {
    await startAndObserve("obsidian_restart", "health_restart", "after_restart");
  }

  // Best-effort stop before cleanup so a failed run never leaves a live
  // Obsidian process holding the generated Vault open.
  if (handle !== null) {
    try {
      await stopObsidian();
    } catch {
      // The primary failure is already recorded; cleanup still proceeds.
    }
  }

  if (state.vault !== null) {
    try {
      state.afterInventory = await takeInventory(state.vault.vaultPath);
    } catch (error) {
      fail("inventory_after", "inventory_failed", sanitize(error instanceof Error ? error.message : String(error)));
    }
  }

  // Cleanup runs even after failures; residual generated content invalidates
  // the evidence rather than silently passing (spec §12.6). Cleanup never
  // touches roots the run did not itself provision.
  if (state.vault !== null) {
    try {
      state.cleanup = await cleanupVault(state.vault);
    } catch (error) {
      state.cleanup = { attempted: true, residualPaths: ["/"] };
      fail("cleanup", "cleanup_failed", sanitize(error instanceof Error ? error.message : String(error)));
    }
    if (state.cleanup.residualPaths.length > 0) {
      fail("cleanup", "residual_test_content", "Generated test content survived cleanup");
    }
  }

  const verdict: InstalledRuntimeVerdict =
    state.failure === null
      ? "passed"
      : INVALID_VERDICT_CODES.has(state.failure.code) || state.failure.stage === "cleanup"
        ? "invalid"
        : "failed";

  const firstHealth = state.observations[0]?.observation.health;
  const evidence: InstalledRuntimeEvidence = {
    schemaVersion: 1,
    runId,
    startedAt,
    endedAt: now(),
    profile: {
      name: options.profileName,
      registered:
        profile === null
          ? {
              os: { platform: "", build: "" },
              versions: { obsidian: "", electron: "", node: "" },
              capabilities: [],
              profileRequirement: "dedicated_candidate_only" as const,
            }
          : {
              os: { ...profile.os },
              versions: { ...profile.versions },
              capabilities: [...profile.capabilities],
              profileRequirement: profile.profileRequirement,
            },
      observed: state.observed === null
        ? null
        : {
            platform: state.observed.platform,
            osBuild: state.observed.osBuild ?? null,
            obsidianVersion: state.observed.obsidianVersion ?? null,
            electronVersion: state.observed.electronVersion ?? null,
            nodeVersion: state.observed.nodeVersion ?? null,
            capabilities: [...state.observed.capabilities],
          },
      mismatches: state.mismatches.map((mismatch) => ({ ...mismatch })),
    },
    candidate: state.candidate === null
      ? null
      : {
          pluginId: state.candidate.pluginId,
          pluginVersion: state.candidate.pluginVersion,
          minAppVersion: state.candidate.minAppVersion,
          bundleSha256: state.candidate.bundleSha256,
          files: state.candidate.files.map((file) => ({ ...file })),
        },
    bridgeIdentity:
      firstIdentity === null || firstHealth === undefined
        ? null
        : {
            vaultId: firstIdentity.vaultId,
            listener: {
              address: "127.0.0.1",
              port: firstIdentity.port,
            },
            versions: {
              bridge: firstHealth.versions.bridge,
              plugin: firstHealth.versions.plugin,
              protocol: firstHealth.versions.protocol,
              persistentStateSchema: firstHealth.versions.persistentStateSchema,
              recoveryJournalSchema: firstHealth.versions.recoveryJournalSchema,
            },
          },
    inputHashes: {
      candidateBundleSha256: state.candidate?.bundleSha256 ?? null,
      vaultSeedManifestSha256: state.vault?.seedManifestSha256 ?? null,
    },
    beforeInventory: state.beforeInventory,
    afterInventory: state.afterInventory,
    inventoryComparison:
      state.beforeInventory === null || state.afterInventory === null
        ? null
        : (() => {
            const comparison = compareInventories(state.beforeInventory, state.afterInventory);
            return {
              beforeDigest: comparison.beforeDigest,
              afterDigest: comparison.afterDigest,
              addedPaths: [...comparison.addedPaths],
              removedPaths: [...comparison.removedPaths],
              changedPaths: [...comparison.changedPaths],
            };
          })(),
    observations: state.observations.map((observation) => toObservationEvidence(observation)),
    verdict,
    failure:
      state.failure === null
        ? null
        : state.failure.detail === undefined
          ? { stage: state.failure.stage, code: state.failure.code }
          : { stage: state.failure.stage, code: state.failure.code, detail: state.failure.detail },
    cleanup:
      state.cleanup === null
        ? null
        : { attempted: true, residualPaths: [...state.cleanup.residualPaths] },
  };

  const privateMarkers = [
    ...(state.vault?.seedNotes.map((note) => note.content) ?? []),
    state.vault?.vaultPath ?? "",
    state.vault?.profileDirectory ?? "",
    options.workingDirectory,
  ];
  await writeEvidenceFile(options.evidencePath, evidence, privateMarkers);
  return { verdict, failure: state.failure, evidence, evidencePath: options.evidencePath };
}

// The phase and its observation are recorded together so the evidence
// projection cannot mix an initial observation with a post-restart one.
function toObservationEvidence({
  phase,
  observation,
}: PhasedObservation): InstalledRuntimeEvidence["observations"][number] {
  const { health } = observation;
  return {
    phase,
    overall: health.overall,
    readiness: { ...health.readiness },
    recoveryState: health.recovery.state,
    write: { ...health.write },
    effectiveGate: health.effectiveGate?.code ?? null,
    reasonCodes: [...health.reasonCodes],
    operatorAction: health.operatorAction,
    healthSha256: sha256Hex(new TextEncoder().encode(JSON.stringify(health))),
    vaultPathSha256: sha256Hex(new TextEncoder().encode(health.vault.path)),
  };
}

export { hostOsBuild };
