import { randomUUID } from "node:crypto";
import { connect } from "node:net";

import {
  CandidateBundleError,
  installCandidateBundle,
  sha256Hex,
  type VerifiedCandidateBundle,
} from "./candidate-bundle.js";
import {
  ReleaseBundleError,
  currentSourceTreeTag,
} from "../release/release-identity.js";
import { verifyReleaseBundle } from "../release/verify-release-bundle.js";
import {
  writeEvidenceFile,
  type ChangeSetCorpusEvidence,
  type GateIsolationCorpusEvidence,
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
  PublicWireCorpusError,
  runPublicWireCorpus,
  type PublicWireCorpusResult,
} from "./public-wire-corpus.js";
import {
  ChangeSetSubmissionCorpusError,
  composeChangeSetCorpusEvidence,
  runChangeSetReplayCorpusAtEndpoint,
  runChangeSetSubmissionCorpusAtEndpoint,
  type ChangeSetAdmissionOutcome,
  type ChangeSetReplayOutcome,
} from "./change-set-submission-corpus.js";
import {
  composeGateIsolationCorpusEvidence,
  GateIsolationCorpusError,
  type GateIsolationOutcome,
} from "./gate-isolation-corpus.js";
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
  | "public_wire_corpus"
  | "change_set_corpus"
  | "change_set_replay"
  | "gate_isolation_corpus"
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
  | "candidate_checksum_manifest_missing"
  | "candidate_manifest_invalid"
  | "candidate_unverified_bundle"
  | "release_tag_malformed"
  | "release_tag_mismatch"
  | "release_plugin_id_mismatch"
  | "release_build_output_missing"
  | "release_bundle_directory_not_empty"
  | "release_incompatible_runtime"
  | "release_attestation_absent"
  | "release_attestation_malformed"
  | "release_repository_mismatch"
  | "release_workflow_mismatch"
  | "release_attestation_subject_missing"
  | "release_attestation_subject_unexpected"
  | "release_attestation_digest_mismatch"
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
  | "public_wire_corpus_failed"
  | "change_set_corpus_failed"
  | "change_set_replay_failed"
  | "gate_isolation_corpus_failed"
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
  /**
   * Release-verification expectations for the candidate (issue #196). The
   * harness installs only the verifier's branded result; repository and
   * workflow identity stay pinned to the release constants and are never
   * caller-adjustable here.
   */
  readonly candidateVerification?: {
    /** Immutable tag the candidate must match; defaults to the built version. */
    readonly expectedTag?: string;
    readonly expectedPluginId?: string;
    readonly attestationPath?: string;
    readonly supportedObsidianVersion?: string;
  };
  /** Parent directory under which the generated Vault/profile roots are created. */
  readonly workingDirectory: string;
  /** Evidence destination; an existing file is never overwritten. */
  readonly evidencePath: string;
  readonly probe: RuntimeEnvironmentProbe;
  readonly processControl: ObsidianProcessControl;
  readonly client?: LoopbackMcpClient;
  readonly runPublicWireCorpus?: typeof runPublicWireCorpus;
  /**
   * Write-side corpus seams (issue #175). The admission phase runs in the
   * initial Obsidian window; the replay phase reconnects after the controlled
   * restart and replays every established Submission Key. Both default to the
   * real loopback implementations and are injectable for inner tests.
   */
  readonly runChangeSetCorpus?: typeof runChangeSetSubmissionCorpusAtEndpoint;
  readonly runChangeSetReplay?: typeof runChangeSetReplayCorpusAtEndpoint;
  /**
   * Gate-and-isolation corpus seam (issue #177): a self-contained two-Managed-Vault
   * scenario that provisions and starts two dedicated generated test Vaults
   * through the harness seams and drives the six-tool gate algebra over real
   * loopback Bridges. It runs between the initial window and the controlled
   * restart; when absent, the stage is skipped and no gate-isolation evidence
   * is recorded (the closed envelope accepts its absence). When present, a
   * non-passing corpus outcome projects failed evidence.
   */
  readonly runGateIsolationCorpus?: (options: {
    readonly runId: string;
    readonly workingDirectory: string;
    readonly candidate: VerifiedCandidateBundle;
    readonly processControl: ObsidianProcessControl;
    readonly client: LoopbackMcpClient;
    readonly configDirectoryName: string;
    readonly timeouts: { readonly startupMs: number; readonly stopMs: number; readonly portClosedMs: number };
    readonly provisionVault: typeof provisionTestVault;
    readonly cleanupVault: typeof cleanupTestVault;
    readonly record: (kind: "transport" | "tool" | "assertion" | "cleanup", name: string, detail: unknown) => void;
    readonly assertion: (name: string) => void;
  }) => Promise<GateIsolationOutcome>;
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
  "candidate_checksum_manifest_missing",
  "candidate_manifest_invalid",
  "candidate_unverified_bundle",
  "release_tag_malformed",
  "release_tag_mismatch",
  "release_plugin_id_mismatch",
  "release_build_output_missing",
  "release_bundle_directory_not_empty",
  "release_incompatible_runtime",
  "release_attestation_absent",
  "release_attestation_malformed",
  "release_repository_mismatch",
  "release_workflow_mismatch",
  "release_attestation_subject_missing",
  "release_attestation_subject_unexpected",
  "release_attestation_digest_mismatch",
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
  candidate: VerifiedCandidateBundle | null;
  vault: ProvisionedTestVault | null;
  beforeInventory: VaultInventoryEntry[] | null;
  afterInventory: VaultInventoryEntry[] | null;
  observations: PhasedObservation[];
  publicWireCorpus: PublicWireCorpusResult | null;
  changeSetAdmission: ChangeSetAdmissionOutcome | null;
  changeSetReplay: ChangeSetReplayOutcome | null;
  gateIsolation: GateIsolationOutcome | null;
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
    publicWireCorpus: null,
    changeSetAdmission: null,
    changeSetReplay: null,
    gateIsolation: null,
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
    } else if (error instanceof ReleaseBundleError) {
      fail(stage, error.code, sanitize(error.message));
    } else if (error instanceof TestVaultError) {
      fail(stage, error.code, sanitize(error.message));
    } else if (error instanceof PublicWireCorpusError) {
      fail(stage, "public_wire_corpus_failed", sanitize(error.message));
    } else if (error instanceof ChangeSetSubmissionCorpusError) {
      fail(stage, "change_set_corpus_failed", sanitize(error.message));
    } else if (error instanceof GateIsolationCorpusError) {
      fail(stage, "gate_isolation_corpus_failed", sanitize(error.message));
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
    during?: {
      stage: "public_wire_corpus" | "change_set_replay";
      run: (identity: PersistedBridgeIdentity) => Promise<void>;
    },
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
            candidate.identity.pluginId,
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
    // Readiness is the loopback listener answering, not merely the persisted
    // identity file: on restart the file already exists from the prior run
    // while the freshly started Obsidian may not have bound the port yet.
    try {
      await waitForCondition(() => isLoopbackPortOpen(identity.port), {
        timeoutMs: timeouts.startupMs,
      });
    } catch (error) {
      failFromError("bridge_readiness", error);
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
    // The during hook runs while Obsidian and its loopback Bridge are live —
    // the only window a real transport corpus can exercise. A corpus failure is
    // projected to failed evidence; the controlled stop still runs so cleanup
    // never leaves a live process holding the generated Vault.
    if (during !== undefined) {
      try {
        await during.run(identity);
      } catch (error) {
        if (error instanceof ChangeSetSubmissionCorpusError) {
          fail(
            during.stage,
            during.stage === "change_set_replay"
              ? "change_set_replay_failed"
              : "change_set_corpus_failed",
            sanitize(error.message),
          );
        } else {
          failFromError(during.stage, error);
        }
      }
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
      const verification = options.candidateVerification;
      state.candidate = await verifyReleaseBundle({
        bundleDirectory: options.candidateBundleDirectory,
        expectedTag: verification?.expectedTag ?? currentSourceTreeTag().tag,
        ...(verification?.expectedPluginId !== undefined
          ? { expectedPluginId: verification.expectedPluginId }
          : {}),
        ...(verification?.attestationPath !== undefined
          ? { attestationPath: verification.attestationPath }
          : {}),
        ...(verification?.supportedObsidianVersion !== undefined
          ? { supportedObsidianVersion: verification.supportedObsidianVersion }
          : {}),
      });
      await installCandidateBundle(
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

  // Shared event/assertion collectors for both change-set corpus phases so the
  // closed evidence block spans the initial admission and the post-restart
  // replay with monotonic event sequences.
  const changeSetEvents: Array<{
    kind: "transport" | "tool" | "assertion" | "cleanup";
    name: string;
    detail: unknown;
  }> = [];
  const changeSetAssertions: string[] = [];
  const recordChangeSetEvent = (
    kind: "transport" | "tool" | "assertion" | "cleanup",
    name: string,
    detail: unknown,
  ): void => {
    changeSetEvents.push({ kind, name, detail });
  };
  const recordChangeSetAssertion = (name: string): void => {
    changeSetAssertions.push(name);
  };

  // Gate-isolation corpus event/assertion collectors (issue #177), spanning the
  // stage that runs between the initial window and the controlled restart.
  const gateIsolationEvents: Array<{
    kind: "transport" | "tool" | "assertion" | "cleanup";
    name: string;
    detail: unknown;
  }> = [];
  const gateIsolationAssertions: string[] = [];
  const recordGateIsolationEvent = (
    kind: "transport" | "tool" | "assertion" | "cleanup",
    name: string,
    detail: unknown,
  ): void => {
    gateIsolationEvents.push({ kind, name, detail });
  };
  const recordGateIsolationAssertion = (name: string): void => {
    gateIsolationAssertions.push(name);
  };

  if (state.failure === null) {
    await startAndObserve("obsidian_start", "health_initial", "initial", {
      stage: "public_wire_corpus",
      run: async (identity) => {
        const vault = state.vault;
        if (vault === null) return;
        if (state.failure === null) {
          try {
            state.publicWireCorpus = await (options.runPublicWireCorpus ?? runPublicWireCorpus)({
              endpoint: new URL(`http://127.0.0.1:${identity.port}/mcp`),
              expectedVaultId: identity.vaultId,
              fixtureSeed: vault.seedManifestSha256,
              seedNotes: vault.seedNotes.map(({ path, content }) => ({ path, content })),
            });
          } catch (error) {
            failFromError("public_wire_corpus", error);
          }
        }
        if (state.failure === null && state.publicWireCorpus !== null) {
          try {
            state.changeSetAdmission = await (options.runChangeSetCorpus ??
              runChangeSetSubmissionCorpusAtEndpoint)({
              endpoint: new URL(`http://127.0.0.1:${identity.port}/mcp`),
              expectedVaultId: identity.vaultId,
              seedNotes: vault.seedNotes.map(({ path, content }) => ({ path, content })),
              record: recordChangeSetEvent,
              assertion: recordChangeSetAssertion,
            });
          } catch (error) {
            if (error instanceof ChangeSetSubmissionCorpusError) {
              fail("change_set_corpus", "change_set_corpus_failed", sanitize(error.message));
            } else {
              failFromError("change_set_corpus", error);
            }
          }
        }
      },
    });
  }
  // The gate-isolation corpus (issue #177) runs between the initial window and
  // the controlled restart: it provisions and starts its own two dedicated
  // generated test Vaults through the harness seams, so it runs while no other
  // Obsidian window is live. When the caller does not wire the seam, the stage
  // is skipped and the closed evidence envelope records no gate-isolation
  // block (the top-level passing verdict accepts its absence).
  if (state.failure === null && options.runGateIsolationCorpus !== undefined) {
    const vault = state.vault;
    const candidate = state.candidate;
    if (vault === null || candidate === null) {
      fail("gate_isolation_corpus", "gate_isolation_corpus_failed", "Gate-isolation corpus requires a provisioned candidate");
    } else {
      try {
        state.gateIsolation = await options.runGateIsolationCorpus({
          runId,
          workingDirectory: options.workingDirectory,
          candidate,
          processControl: options.processControl,
          client,
          configDirectoryName,
          timeouts,
          provisionVault: provisionTestVault,
          cleanupVault,
          record: recordGateIsolationEvent,
          assertion: recordGateIsolationAssertion,
        });
      } catch (error) {
        // The gate-isolation corpus seam is a self-contained scenario; any
        // failure it reports projects to failed gate-isolation evidence.
        fail(
          "gate_isolation_corpus",
          "gate_isolation_corpus_failed",
          sanitize(error instanceof Error ? error.message : String(error)),
        );
      }
    }
  }
  if (state.failure === null) {
    await startAndObserve("obsidian_restart", "health_restart", "after_restart", {
      stage: "change_set_replay",
      run: async (identity) => {
        if (state.changeSetAdmission === null) return;
        try {
          state.changeSetReplay = await (options.runChangeSetReplay ??
            runChangeSetReplayCorpusAtEndpoint)({
            endpoint: new URL(`http://127.0.0.1:${identity.port}/mcp`),
            expectedVaultId: identity.vaultId,
            establishedKeys: state.changeSetAdmission.replayKeys,
            record: recordChangeSetEvent,
            assertion: recordChangeSetAssertion,
          });
        } catch (error) {
          if (error instanceof ChangeSetSubmissionCorpusError) {
            fail("change_set_replay", "change_set_replay_failed", sanitize(error.message));
          } else {
            failFromError("change_set_replay", error);
          }
        }
      },
    });
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

  // Residual generated content invalidates the run's evidence even when a
  // candidate-class failure was recorded first: a run that leaves generated
  // content behind cannot be trusted as a clean pass or a clean failure.
  const residualContent = state.cleanup !== null && state.cleanup.residualPaths.length > 0;
  const verdict: InstalledRuntimeVerdict =
    state.failure === null
      ? "passed"
      : INVALID_VERDICT_CODES.has(state.failure.code) ||
          state.failure.stage === "cleanup" ||
          residualContent
        ? "invalid"
        : "failed";

  const firstHealth = state.observations[0]?.observation.health;
  const changeSetCorpus: ChangeSetCorpusEvidence | null =
    state.failure === null &&
    state.changeSetAdmission !== null &&
    state.changeSetReplay !== null
      ? composeChangeSetCorpusEvidence({
          admission: state.changeSetAdmission,
          replay: state.changeSetReplay,
          events: changeSetEvents,
          assertions: changeSetAssertions,
        })
      : null;
  const gateIsolationCorpus: GateIsolationCorpusEvidence | null =
    state.failure === null && state.gateIsolation !== null
      ? composeGateIsolationCorpusEvidence({
          outcome: state.gateIsolation,
          events: gateIsolationEvents,
          assertions: gateIsolationAssertions,
        })
      : null;
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
          pluginId: state.candidate.identity.pluginId,
          pluginVersion: state.candidate.identity.pluginVersion,
          minAppVersion: state.candidate.identity.minAppVersion,
          bundleSha256: state.candidate.identity.bundleSha256,
          files: state.candidate.identity.files.map((file) => ({ ...file })),
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
      candidateBundleSha256: state.candidate?.identity.bundleSha256 ?? null,
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
    publicWireCorpus: state.publicWireCorpus?.evidence ?? null,
    changeSetCorpus,
    gateIsolationCorpus,
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
