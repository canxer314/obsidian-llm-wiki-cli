import { createHash, randomUUID } from "node:crypto";
import { defaultContractPackageRoot, loadVersionContractPackage, runContractFixtureWireCorpus, completeContractPackageCorpus, contractDigest, type ContractFixtureWireEvidence, type VersionContractPackage } from "./contract-package-corpus.js";
import { runContractCrossCallScenario, type ContractCrossCallEvidence } from "./contract-cross-call.js";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { connect } from "node:net";
import { dirname, join } from "node:path";

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
  createAcceptanceMatrixReport,
  type AcceptanceMatrixReport,
} from "./acceptance-matrix.js";
import {
  writeEvidenceFile,
  type ChangeSetCorpusEvidence,
  type GateIsolationCorpusEvidence,
  type InstalledRuntimeEvidence,
  type InstalledRuntimeVerdict,
  privacyRecoveryAuthorityCorpusEvidenceSchema,
  type RegisteredReferenceRewriteCorpusEvidence,
  type PrivacyRecoveryAuthorityCorpusEvidence,
  type SemanticEvidenceCorpusEvidence,
  type ReleaseLifecycleCorpusEvidence,
  crashRestorationRetainedAuthorityCorpusEvidenceSchema,
  type CrashRestorationRetainedAuthorityCorpusEvidence,
  releaseLifecycleCorpusEvidenceSchema,
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
import type { InstalledGateIsolationRun } from "./gate-installed-runner.js";
import {
  composeRegisteredReferenceRewriteCorpusEvidence,
  RegisteredReferenceRewriteCorpusError,
  type RegisteredReferenceRewriteOutcome,
} from "./registered-reference-rewrite-corpus.js";
import {
  composePrivacyRecoveryAuthorityCorpusEvidence,
  PrivacyRecoveryAuthorityCorpusError,
  type PrivacyRecoveryAuthorityCorpusOutcome,
} from "./privacy-recovery-authority-corpus.js";
import {
  composeSemanticEvidenceSearchSnapshotCorpusEvidence,
  SemanticEvidenceSearchSnapshotCorpusError,
  runSemanticEvidenceSearchSnapshotCorpusAtEndpoint,
  type SemanticEvidenceSearchSnapshotOutcome,
} from "./semantic-evidence-corpus.js";
import {
  composeReleaseLifecycleCorpusEvidence,
  ReleaseLifecycleCorpusError,
  type ReleaseLifecycleCorpusOutcome,
} from "./release-lifecycle-corpus.js";
import type { InstalledPrivacyAuthorityBoundarySliceResult } from "./privacy-recovery-installed-runner.js";
import {
  composeCrashRestorationRetainedAuthorityCorpusEvidence,
  CrashRestorationRetainedAuthorityCorpusError,
  type CrashRestorationRetainedAuthorityCorpusOutcome,
} from "./crash-restoration-retained-authority-corpus.js";
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
  | "acceptance_driver"
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
  | "registered_reference_rewrite_corpus"
  | "semantic_evidence_search_snapshot_corpus"
  | "privacy_recovery_authority_corpus"
  | "release_lifecycle_corpus"
  | "crash_restoration_retained_authority_corpus"
  | "acceptance_matrix"
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
  | "acceptance_driver_unavailable"
  | "acceptance_driver_cleanup_failed"
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
  | "registered_reference_rewrite_corpus_failed"
  | "semantic_evidence_search_snapshot_corpus_failed"
  | "privacy_recovery_authority_corpus_failed"
  | "release_lifecycle_corpus_failed"
  | "crash_restoration_retained_authority_corpus_failed"
  | "acceptance_matrix_failed"
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
  /**
   * Arms private installed-only acceptance control after verified installation
   * and removes it before final inventory/cleanup. It is never part of MCP.
   */
  readonly prepareInstalledRuntimeAcceptanceDriver?: (options: {
    readonly vaultPath: string;
    readonly pluginId: string;
    readonly candidateBundleSha256: string;
    readonly configDirectoryName: string;
    readonly reportDirectory?: string;
  }) => Promise<{
    requestSemanticEvidenceScenario(options: {
      readonly scenario: import("./semantic-evidence-corpus.js").SemanticEvidenceSearchSnapshotScenarioName;
      readonly expectedVaultId: string;
      readonly endpoint: URL;
    }): Promise<void>;
    cleanup(): Promise<void>;
  }>;
  readonly client?: LoopbackMcpClient;
  readonly runPublicWireCorpus?: typeof runPublicWireCorpus;
  readonly contractPackageRoot?: string;
  readonly runContractPackageWire?: typeof runContractFixtureWireCorpus;
  readonly runContractCrossCall?: typeof runContractCrossCallScenario;
  readonly completeContractPackage?: typeof completeContractPackageCorpus;
  readonly contractContinuationTiming?: "full-real-time" | "binding-only";
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
   * restart. A missing runner or non-passing corpus outcome fails closed; it
   * never produces passing evidence by skipping the stage.
   */
  readonly runGateIsolationCorpus?: (options: {
    readonly runId: string;
    readonly workingDirectory: string;
    readonly candidate: VerifiedCandidateBundle;
    readonly processControl: ObsidianProcessControl;
    readonly client: LoopbackMcpClient;
    readonly configDirectoryName: string;
    readonly timeouts: { readonly startupMs: number; readonly stopMs: number; readonly portClosedMs: number };
    readonly profileName: string;
    readonly profile: RegisteredRuntimeProfile;
    readonly probe: RuntimeEnvironmentProbe;
    readonly provisionVault: typeof provisionTestVault;
    readonly cleanupVault: typeof cleanupTestVault;
    readonly record: (kind: "transport" | "tool" | "assertion" | "cleanup", name: string, detail: unknown) => void;
    readonly assertion: (name: string) => void;
  }) => Promise<GateIsolationOutcome | InstalledGateIsolationRun>;
  /**
   * Registered-reference rewrite corpus seam (issue #178): a self-contained
   * move-rewrite scenario that proves destination-only registered-reference
   * rewrites preserve exact bytes over the real transport. It runs between the
   * initial window and the controlled restart. A missing runner or non-passing
   * corpus outcome fails closed; required evidence cannot be omitted.
   */
  readonly runRegisteredReferenceRewriteCorpus?: (options: {
    readonly profile?: RegisteredRuntimeProfile;
    readonly probe?: RuntimeEnvironmentProbe;
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
  }) => Promise<RegisteredReferenceRewriteOutcome>;
  /**
   * Semantic Evidence/Search Snapshot corpus seam (issue #179). It runs over
   * the live installed Bridge's six-tool loopback transport and invokes the
   * shared real Change Set/evidence/snapshot corpus. A failed proof is a
   * release-blocking harness failure; the default is the production corpus and
   * this seam exists only for harness tests.
   */
  readonly runSemanticEvidenceSearchSnapshotCorpus?: (options: {
    readonly endpoint: URL;
    readonly expectedVaultId: string;
    readonly workingDirectory: string;
    readonly record: (kind: "transport" | "tool" | "assertion" | "cleanup", name: string, detail: unknown) => void;
    readonly assertion: (name: string) => void;
    readonly scenarioRunner: import("./semantic-evidence-corpus.js").InstalledSemanticEvidenceScenarioRunner;
  }) => Promise<SemanticEvidenceSearchSnapshotOutcome>;
  readonly semanticEvidenceScenarioRunner?: import("./semantic-evidence-corpus.js").InstalledSemanticEvidenceScenarioRunner;
  /**
   * Runs each Semantic Evidence scenario in its own generated Vault/runtime.
   * This is required for authoritative composition because a result_unproven
   * scenario intentionally leaves its runtime recovery-blocked; the harness
   * must never use trusted local recovery authority to continue the program.
   */
  readonly isolateSemanticEvidenceScenarios?: boolean;
  readonly runPrivacyRecoveryAuthorityCorpus?: (options: {
    readonly runId: string;
    readonly workingDirectory: string;
    readonly candidate: VerifiedCandidateBundle;
    readonly processControl: ObsidianProcessControl;
    readonly client: LoopbackMcpClient;
    readonly configDirectoryName: string;
    readonly timeouts: { readonly startupMs: number; readonly stopMs: number; readonly portClosedMs: number };
    readonly operatorReportTimeoutMs?: number;
    readonly provisionVault: typeof provisionTestVault;
    readonly cleanupVault: typeof cleanupTestVault;
    readonly record: (kind: "transport" | "tool" | "assertion" | "cleanup", name: string, detail: unknown) => void;
    readonly assertion: (name: string) => void;
    readonly profileName: string;
    readonly profile: RegisteredRuntimeProfile;
    readonly probe: RuntimeEnvironmentProbe;
    readonly prepareInstalledRuntimeAcceptanceDriver: import("./privacy-recovery-installed-runner.js").InstalledPrivacyBoundaryOptions["prepareInstalledRuntimeAcceptanceDriver"];
  }) => Promise<PrivacyRecoveryAuthorityCorpusOutcome | InstalledPrivacyAuthorityBoundarySliceResult>;
  /**
   * Verified release-lifecycle corpus (issue #181): composes the installed
   * install/repair, upgrade, uninstall, and purge scenarios. The caller supplies
   * the self-contained runner so each scenario can use its own verified release
   * identities and runtime-host seam; its result is release-blocking evidence.
   */
  readonly runReleaseLifecycleCorpus?: (options: {
    readonly profileName?: string;
    readonly profile?: RegisteredRuntimeProfile;
    readonly probe?: RuntimeEnvironmentProbe;
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
  }) => Promise<ReleaseLifecycleCorpusOutcome>;
  readonly runCrashRestorationRetainedAuthorityCorpus?: (options: {
    readonly installed?: import("./installed-crash-restoration-slice.js").InstalledCrashRestorationSliceOptions;
    readonly workingDirectory: string;
    readonly record: (kind: "transport" | "tool" | "assertion" | "cleanup", name: string, detail: unknown) => void;
    readonly assertion: (name: string) => void;
  }) => Promise<CrashRestorationRetainedAuthorityCorpusOutcome>;
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
  "acceptance_driver_unavailable",
  "acceptance_driver_cleanup_failed",
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
  registeredReferenceRewrite: RegisteredReferenceRewriteOutcome | null;
  semanticEvidenceSearchSnapshot: SemanticEvidenceSearchSnapshotOutcome | null;
  privacyRecoveryAuthority: PrivacyRecoveryAuthorityCorpusOutcome | null;
  releaseLifecycle: ReleaseLifecycleCorpusOutcome | null;
  crashRestorationRetainedAuthority: CrashRestorationRetainedAuthorityCorpusOutcome | null;
  acceptanceMatrix: AcceptanceMatrixReport | null;
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
    registeredReferenceRewrite: null,
    semanticEvidenceSearchSnapshot: null,
    privacyRecoveryAuthority: null,
    releaseLifecycle: null,
    crashRestorationRetainedAuthority: null,
    acceptanceMatrix: null,
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
    } else if (error instanceof RegisteredReferenceRewriteCorpusError) {
      fail(stage, "registered_reference_rewrite_corpus_failed", sanitize(error.message));
    } else if (error instanceof PrivacyRecoveryAuthorityCorpusError) {
      fail(stage, "privacy_recovery_authority_corpus_failed", sanitize(error.message));
    } else if (error instanceof ReleaseLifecycleCorpusError) {
      fail(stage, "release_lifecycle_corpus_failed", sanitize(error.message));
    } else if (error instanceof CrashRestorationRetainedAuthorityCorpusError) {
      fail(stage, "crash_restoration_retained_authority_corpus_failed", sanitize(error.message));
    } else if (error instanceof SemanticEvidenceSearchSnapshotCorpusError) {
      fail(stage, "semantic_evidence_search_snapshot_corpus_failed", sanitize(error.message));
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

  let contractAuthority: VersionContractPackage | null = null;
  let contractWire: ContractFixtureWireEvidence | null = null;
  const contractCrossCalls: ContractCrossCallEvidence[] = [];
  let handle: ObsidianProcessHandle | null = null;
  let startupShutdownUnconfirmed = false;
  let acceptanceDriver: {
    requestSemanticEvidenceScenario(options: {
      readonly scenario: import("./semantic-evidence-corpus.js").SemanticEvidenceSearchSnapshotScenarioName;
      readonly expectedVaultId: string;
      readonly endpoint: URL;
    }): Promise<void>;
    cleanup(): Promise<void>;
  } | null = null;
  let isolatedSemanticEvidenceSequence = 0;
  let isolatedRuntimeResidue = false;
  let firstIdentity = null as PersistedBridgeIdentity | null;

  class BridgeStillReachableError extends Error {}

  const stopObsidian = async (): Promise<void> => {
    const current = handle;
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
    handle = null;
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
      if (error instanceof ObsidianProcessError && error.code === "obsidian_stop_failed") {
        startupShutdownUnconfirmed = true;
      }
      failFromError(startStage, error);
      return;
    }
    if (options.probe.probeRunning !== undefined && profile !== null) {
      try {
        state.observed = await options.probe.probeRunning(vault);
        state.mismatches = preflightRuntimeProfile(profile, state.observed);
        if (state.mismatches.length > 0) {
          fail("preflight", "profile_mismatch", "The running runtime does not match the registered profile");
          return;
        }
      } catch (error) {
        fail("preflight", "profile_probe_failed", sanitize(error instanceof Error ? error.message : String(error)));
        return;
      }
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
      let observation!: BridgeHealthObservation;
      await waitForCondition(async () => {
        observation = await client.observeHealth(endpoint, identity.vaultId);
        return observation.health.readiness.searchSnapshot === "ready";
      }, { timeoutMs: timeouts.startupMs, intervalMs: 100 });
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
      state.mismatches = preflightRuntimeProfile(profile, state.observed).filter(mismatch =>
        options.probe.probeRunning === undefined || !mismatch.field.startsWith("versions."));
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
      // Generated acceptance Vault only. Exclusive writes cannot overwrite an
      // existing fixture or a Primary Operator note.
      const contractFiles: readonly [string, string | Uint8Array][] = [
        ["ContractFixtures/InvalidUtf8.md", Uint8Array.from([0xc3, 0x28])],
        ["ContractFixtures/QuotaMetadata.md", `---\nquota: ${"q".repeat(4_718_592)}\n---\n# Quota\n`],
        ["Projects/Bridge.md", "---\nstatus: active\ntags: [architecture]\n---\n# Design\n[[Target Note|target]] [[Missing Note]]\n"],
        ["Root.md", "# Root\n[[Projects/Bridge]]\n"],
        ["Target Note.md", "# Target Note\n"],
      ];
      for (const [path, bytes] of contractFiles) {
        const target = join(state.vault.vaultPath, path); await mkdir(dirname(target), { recursive: true });
        await writeFile(target, bytes, { flag: "wx" });
      }
      const fullSeed = [
        ...state.vault.seedNotes.map(note => ({ path: note.path, bytes: Buffer.from(note.content, "utf8") })),
        ...contractFiles.map(([path, content]) => ({ path, bytes: typeof content === "string" ? Buffer.from(content, "utf8") : content })),
      ];
      const seedManifest = fullSeed.map(({ path, bytes }) => `${createHash("sha256").update(bytes).digest("hex")}  ${path}`).sort().join("\n") + "\n";
      state.vault = { ...state.vault, seedManifestSha256: createHash("sha256").update(seedManifest).digest("hex") };
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
    const prepare = options.prepareInstalledRuntimeAcceptanceDriver;
    if (prepare === undefined) {
      fail(
        "acceptance_driver",
        "acceptance_driver_unavailable",
        "Installed acceptance driver is required for authoritative acceptance",
      );
    } else {
      try {
        acceptanceDriver = await prepare({
          vaultPath: state.vault!.vaultPath,
          pluginId: state.candidate!.identity.pluginId,
          candidateBundleSha256: state.candidate!.identity.bundleSha256,
          configDirectoryName,
        });
      } catch (error) {
        fail(
          "acceptance_driver",
          "acceptance_driver_unavailable",
          sanitize(error instanceof Error ? error.message : String(error)),
        );
      }
    }
  }

  const runIsolatedSemanticEvidenceScenario = async (
    request: Parameters<NonNullable<InstalledRuntimeHarnessOptions["semanticEvidenceScenarioRunner"]>["run"]>[0],
  ): Promise<Awaited<ReturnType<NonNullable<InstalledRuntimeHarnessOptions["semanticEvidenceScenarioRunner"]>["run"]>>> => {
    const candidate = state.candidate;
    const prepare = options.prepareInstalledRuntimeAcceptanceDriver;
    const runner = options.semanticEvidenceScenarioRunner;
    if (candidate === null || prepare === undefined || runner === undefined) {
      throw new SemanticEvidenceSearchSnapshotCorpusError(
        "Isolated installed Semantic Evidence runtime is unavailable",
      );
    }
    isolatedSemanticEvidenceSequence += 1;
    const isolated = await provisionTestVault({
      workingDirectory: options.workingDirectory,
      runId: `${runId}-semantic-${isolatedSemanticEvidenceSequence}`,
      configDirectoryName,
    });
    let isolatedHandle: ObsidianProcessHandle | null = null;
    let isolatedStartupShutdownUnconfirmed = false;
    let isolatedPort: number | undefined;
    let isolatedDriver: Awaited<ReturnType<typeof prepare>> | null = null;
    try {
      await installCandidateBundle(candidate, isolated.vaultPath, configDirectoryName);
      isolatedDriver = await prepare({
        vaultPath: isolated.vaultPath,
        pluginId: candidate.identity.pluginId,
        candidateBundleSha256: candidate.identity.bundleSha256,
        configDirectoryName,
      });
      isolatedHandle = await options.processControl.start({
        vaultPath: isolated.vaultPath,
        profileDirectory: isolated.profileDirectory,
      }).catch((error: unknown) => {
        if (error instanceof ObsidianProcessError && error.code === "obsidian_stop_failed") {
          isolatedStartupShutdownUnconfirmed = true;
        }
        throw error;
      });
      if (options.probe.probeRunning !== undefined && profile !== null) {
        const observed = await options.probe.probeRunning(isolated);
        if (preflightRuntimeProfile(profile, observed).length > 0) {
          throw new SemanticEvidenceSearchSnapshotCorpusError(
            "Isolated runtime does not match the registered profile",
          );
        }
      }
      let observedIdentity: PersistedBridgeIdentity | null = null;
      await waitForCondition(async () => {
        observedIdentity = await readPersistedBridgeIdentity(
          isolated.vaultPath,
          candidate.identity.pluginId,
          configDirectoryName,
        );
        return observedIdentity !== null;
      }, { timeoutMs: timeouts.startupMs });
      if (observedIdentity === null) {
        throw new BridgeIdentityError("Isolated Semantic Evidence Bridge identity unavailable");
      }
      const identity: PersistedBridgeIdentity = observedIdentity;
      isolatedPort = identity.port;
      await waitForCondition(() => isLoopbackPortOpen(identity.port), {
        timeoutMs: timeouts.startupMs,
      });
      const endpoint = new URL(`http://127.0.0.1:${identity.port}/mcp`);
      await waitForCondition(async () => {
        const observation = await client.observeHealth(endpoint, identity.vaultId);
        return observation.health.readiness.searchSnapshot === "ready";
      }, { timeoutMs: timeouts.startupMs, intervalMs: 100 });
      await isolatedDriver.requestSemanticEvidenceScenario({
        scenario: request.scenario,
        expectedVaultId: identity.vaultId,
        endpoint,
      });
      return await runner.run({
        ...request,
        endpoint,
        expectedVaultId: identity.vaultId,
      });
    } finally {
      let cleanupFailure: unknown;
      if (isolatedStartupShutdownUnconfirmed) {
        isolatedRuntimeResidue = true;
        throw new ObsidianProcessError("Isolated startup shutdown was not confirmed", "obsidian_stop_failed");
      }
      try {
        await isolatedHandle?.stop();
        if (isolatedPort !== undefined) {
          await waitForCondition(async () => !(await isLoopbackPortOpen(isolatedPort!)), {
            timeoutMs: timeouts.portClosedMs,
          });
        }
      } catch (error) {
        isolatedRuntimeResidue = true;
        throw error;
      }
      try {
        await isolatedDriver?.cleanup();
      } catch (error) {
        cleanupFailure ??= error;
      }
      const cleanup = await cleanupVault(isolated).catch((error: unknown) => {
        isolatedRuntimeResidue = true;
        throw error;
      });
      if (cleanup.residualPaths.length > 0) {
        isolatedRuntimeResidue = true;
        throw new SemanticEvidenceSearchSnapshotCorpusError(
          "Isolated Semantic Evidence runtime left generated content",
        );
      }
      if (cleanupFailure !== undefined) throw cleanupFailure;
    }
  };

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

  // Registered-reference rewrite corpus event/assertion collectors (issue #178),
  // spanning the stage that runs between the initial window and the restart.
  const registeredReferenceRewriteEvents: Array<{
    kind: "transport" | "tool" | "assertion" | "cleanup";
    name: string;
    detail: unknown;
  }> = [];
  const registeredReferenceRewriteAssertions: string[] = [];
  const recordRegisteredReferenceRewriteEvent = (
    kind: "transport" | "tool" | "assertion" | "cleanup",
    name: string,
    detail: unknown,
  ): void => {
    registeredReferenceRewriteEvents.push({ kind, name, detail });
  };
  const recordRegisteredReferenceRewriteAssertion = (name: string): void => {
    registeredReferenceRewriteAssertions.push(name);
  };

  const semanticEvidenceSearchSnapshotEvents: Array<{
    kind: "transport" | "tool" | "assertion" | "cleanup";
    name: string;
    detail: unknown;
  }> = [];
  const semanticEvidenceSearchSnapshotAssertions: string[] = [];
  const recordSemanticEvidenceSearchSnapshotEvent = (
    kind: "transport" | "tool" | "assertion" | "cleanup",
    name: string,
    detail: unknown,
  ): void => {
    semanticEvidenceSearchSnapshotEvents.push({ kind, name, detail });
  };
  const recordSemanticEvidenceSearchSnapshotAssertion = (name: string): void => {
    semanticEvidenceSearchSnapshotAssertions.push(name);
  };

  const privacyRecoveryAuthorityEvents: Array<{
    kind: "transport" | "tool" | "assertion" | "cleanup";
    name: string;
    detail: unknown;
  }> = [];
  const privacyRecoveryAuthorityAssertions: string[] = [];
  const recordPrivacyRecoveryAuthorityEvent = (
    kind: "transport" | "tool" | "assertion" | "cleanup",
    name: string,
    detail: unknown,
  ): void => {
    privacyRecoveryAuthorityEvents.push({ kind, name, detail });
  };
  const recordPrivacyRecoveryAuthorityAssertion = (name: string): void => {
    privacyRecoveryAuthorityAssertions.push(name);
  };

  const releaseLifecycleEvents: Array<{
    kind: "transport" | "tool" | "assertion" | "cleanup";
    name: string;
    detail: unknown;
  }> = [];
  const releaseLifecycleAssertions: string[] = [];
  const crashRestorationRetainedAuthorityEvents: Array<{
    kind: "transport" | "tool" | "assertion" | "cleanup";
    name: string;
    detail: unknown;
  }> = [];
  const crashRestorationRetainedAuthorityAssertions: string[] = [];
  const recordCrashRestorationRetainedAuthorityEvent = (
    kind: "transport" | "tool" | "assertion" | "cleanup",
    name: string,
    detail: unknown,
  ): void => {
    crashRestorationRetainedAuthorityEvents.push({ kind, name, detail });
  };
  const recordCrashRestorationRetainedAuthorityAssertion = (name: string): void => {
    crashRestorationRetainedAuthorityAssertions.push(name);
  };
  const recordReleaseLifecycleEvent = (
    kind: "transport" | "tool" | "assertion" | "cleanup",
    name: string,
    detail: unknown,
  ): void => {
    releaseLifecycleEvents.push({ kind, name, detail });
  };
  const recordReleaseLifecycleAssertion = (name: string): void => {
    releaseLifecycleAssertions.push(name);
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
            contractAuthority = await loadVersionContractPackage(options.contractPackageRoot ?? defaultContractPackageRoot());
            const endpoint = new URL(`http://127.0.0.1:${identity.port}/mcp`);
            contractWire = await (options.runContractPackageWire ?? runContractFixtureWireCorpus)({ authority: contractAuthority, endpoint, expectedVaultId: identity.vaultId });
            for (const scenario of contractAuthority.scenarios) {
              contractCrossCalls.push(await (options.runContractCrossCall ?? runContractCrossCallScenario)({ authority: contractAuthority, scenarioId: scenario.id, endpoint, expectedVaultId: identity.vaultId, binding: { runId, profileName: options.profileName, candidateBundleSha256: state.candidate!.identity.bundleSha256, vaultIdSha256: contractDigest(identity.vaultId), seedManifestSha256: vault.seedManifestSha256 }, quotaMetadataPath: "ContractFixtures/QuotaMetadata.md", seedNotes: vault.seedNotes, invalidUtf8Path: "ContractFixtures/InvalidUtf8.md", readFixtureBytes: async path => {
                if (!["Projects/Bridge.md", "ContractFixtures/InvalidUtf8.md"].includes(path)) throw new Error("Contract fixture byte observation escaped generated scope");
                return new Uint8Array(await readFile(join(vault.vaultPath, path)));
              }, continuationTiming: options.contractContinuationTiming, restart: async () => {
                await stopObsidian();
                handle = await options.processControl.start({ vaultPath: vault.vaultPath, profileDirectory: vault.profileDirectory });
                if (profile === null || options.probe.probeRunning === undefined) throw new Error("Contract restart requires a registered installed runtime probe");
                const observed = await options.probe.probeRunning(vault);
                if (preflightRuntimeProfile(profile, observed).length !== 0) throw new Error("Contract restart profile mismatch");
                let restartedIdentity: PersistedBridgeIdentity | null = null;
                await waitForCondition(async () => {
                  restartedIdentity = await readPersistedBridgeIdentity(vault.vaultPath, state.candidate!.identity.pluginId, configDirectoryName);
                  return restartedIdentity !== null && await isLoopbackPortOpen(restartedIdentity.port);
                }, { timeoutMs: timeouts.startupMs });
                const found = restartedIdentity as PersistedBridgeIdentity | null;
                if (found === null || found.vaultId !== identity.vaultId || found.port !== identity.port) throw new Error("Contract restart changed Bridge identity");
                await client.observeHealth(endpoint, found.vaultId);
                return { endpoint, expectedVaultId: found.vaultId };
              } }));
            }
          } catch (error) {
            fail("public_wire_corpus", "public_wire_corpus_failed", sanitize(error instanceof Error ? error.message : String(error)));
          }
        }
        if (state.failure === null && state.publicWireCorpus !== null) {
          try {
            state.changeSetAdmission = await (options.runChangeSetCorpus ??
              runChangeSetSubmissionCorpusAtEndpoint)({
              endpoint: new URL(`http://127.0.0.1:${identity.port}/mcp`),
              expectedVaultId: identity.vaultId,
              seedNotes: vault.seedNotes.map(({ path, content }) => ({ path, content })),
              inventoryContext: {
                vaultPath: vault.vaultPath,
                runId,
                runtimeProfileId: options.profileName,
                candidateBundleSha256: state.candidate!.identity.bundleSha256,
                configDirectoryName,
              },
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
        if (
          state.failure === null &&
          state.changeSetAdmission !== null
        ) {
          if (options.semanticEvidenceScenarioRunner === undefined) {
            fail(
              "semantic_evidence_search_snapshot_corpus",
              "semantic_evidence_search_snapshot_corpus_failed",
              "Installed Semantic Evidence scenario runner is required for authoritative acceptance",
            );
            return;
          }
          try {
            state.semanticEvidenceSearchSnapshot =
              await (options.runSemanticEvidenceSearchSnapshotCorpus ??
                runSemanticEvidenceSearchSnapshotCorpusAtEndpoint)({
                endpoint: new URL(`http://127.0.0.1:${identity.port}/mcp`),
                expectedVaultId: identity.vaultId,
                workingDirectory: options.workingDirectory,
                record: recordSemanticEvidenceSearchSnapshotEvent,
                assertion: recordSemanticEvidenceSearchSnapshotAssertion,
                scenarioRunner: {
                  run: async (request) => {
                    if (options.isolateSemanticEvidenceScenarios === true) {
                      return runIsolatedSemanticEvidenceScenario(request);
                    }
                    if (acceptanceDriver === null) {
                      throw new SemanticEvidenceSearchSnapshotCorpusError(
                        "Installed acceptance driver is unavailable",
                      );
                    }
                    await acceptanceDriver.requestSemanticEvidenceScenario({
                      scenario: request.scenario,
                      expectedVaultId: request.expectedVaultId,
                      endpoint: request.endpoint,
                    });
                    return options.semanticEvidenceScenarioRunner!.run(request);
                  },
                },
              });
          } catch (error) {
            fail(
              "semantic_evidence_search_snapshot_corpus",
              "semantic_evidence_search_snapshot_corpus_failed",
              sanitize(error instanceof Error ? error.message : String(error)),
            );
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
  if (state.failure === null) {
    const runner = options.runGateIsolationCorpus;
    if (runner === undefined) {
      fail("gate_isolation_corpus", "gate_isolation_corpus_failed", "Gate-isolation corpus runner is required");
    } else if (profile === null) {
      fail("gate_isolation_corpus", "gate_isolation_corpus_failed", "Registered profile is required for gate isolation");
    } else {
          const vault = state.vault;
          const candidate = state.candidate;
          if (vault === null || candidate === null) {
            fail("gate_isolation_corpus", "gate_isolation_corpus_failed", "Gate isolation requires a provisioned candidate");
          } else {
            try {
              const slice = await runner({
                runId,
                profileName: options.profileName,
                workingDirectory: options.workingDirectory,
                candidate,
                processControl: options.processControl,
                client,
                configDirectoryName,
                timeouts,
                profile,
                probe: options.probe,
                provisionVault: provisionTestVault,
                cleanupVault,
                record: recordGateIsolationEvent,
                assertion: recordGateIsolationAssertion,
              });
              if ("scope" in slice) {
                recordGateIsolationEvent("assertion", "installed_gate_isolation_partial_evidence", {
                  scope: slice.scope,
                  verdict: slice.verdict,
                  candidateBundleSha256: slice.candidateBundleSha256,
                  profileName: slice.profileName,
                  provenance: slice.provenance,
                });
                fail("gate_isolation_corpus", "gate_isolation_corpus_failed", "Installed registry-isolation slice is partial evidence, not the full gate corpus");
              } else {
                state.gateIsolation = slice;
              }
            } catch (error) {
              fail("gate_isolation_corpus", "gate_isolation_corpus_failed", sanitize(error instanceof Error ? error.message : String(error)));
            }
          }
        }
  }
  // The registered-reference rewrite corpus (issue #178) runs between the
  // initial window and the controlled restart, alongside the gate-isolation
  // corpus: when the caller does not wire the seam, the stage is skipped and the
  // closed evidence envelope records no registered-reference rewrite block (the
  // top-level passing verdict accepts its absence). A real-runtime seam must
  // stand up its own generated Vault through the harness seams and drive the
  // move-rewrite program over the real loopback Bridge.
  if (state.failure === null) {
    const runner = options.runRegisteredReferenceRewriteCorpus;
    if (runner === undefined) {
      fail("registered_reference_rewrite_corpus", "registered_reference_rewrite_corpus_failed", "Registered-reference rewrite corpus runner is required for authoritative acceptance");
    }
    const vault = state.vault;
    const candidate = state.candidate;
    if (state.failure === null && (vault === null || candidate === null)) {
      fail(
        "registered_reference_rewrite_corpus",
        "registered_reference_rewrite_corpus_failed",
        "Registered-reference rewrite corpus requires a provisioned candidate",
      );
    }
    if (state.failure === null && runner !== undefined && vault !== null && candidate !== null) {
      try {
        state.registeredReferenceRewrite = await runner!({
          runId,
          workingDirectory: options.workingDirectory,
          candidate,
          processControl: options.processControl,
          client,
          configDirectoryName,
          timeouts,
          provisionVault: provisionTestVault,
          cleanupVault,
          record: recordRegisteredReferenceRewriteEvent,
          assertion: recordRegisteredReferenceRewriteAssertion,
          profile: profile!,
          probe: options.probe,
        });
      } catch (error) {
        fail(
          "registered_reference_rewrite_corpus",
          "registered_reference_rewrite_corpus_failed",
          sanitize(error instanceof Error ? error.message : String(error)),
        );
      }
    }
  }
  if (state.failure === null) {
    const runner = options.runPrivacyRecoveryAuthorityCorpus;
    if (runner === undefined) {
      fail("privacy_recovery_authority_corpus", "privacy_recovery_authority_corpus_failed", "Privacy/recovery corpus runner is required for authoritative acceptance");
    }
    const vault = state.vault;
    const candidate = state.candidate;
    if (state.failure === null && (vault === null || candidate === null)) {
      fail(
        "privacy_recovery_authority_corpus",
        "privacy_recovery_authority_corpus_failed",
        "Privacy/recovery corpus requires a provisioned candidate",
      );
    }
    if (state.failure === null && runner !== undefined && vault !== null && candidate !== null) {
      try {
        const outcome = await runner!({
          runId,
          workingDirectory: options.workingDirectory,
          candidate,
          processControl: options.processControl,
          client,
          configDirectoryName,
          timeouts,
          provisionVault: provisionTestVault,
          cleanupVault,
          record: recordPrivacyRecoveryAuthorityEvent,
          assertion: recordPrivacyRecoveryAuthorityAssertion,
          profileName: options.profileName,
          profile: profile!,
          probe: options.probe,
          prepareInstalledRuntimeAcceptanceDriver: async request => {
            const prepared = await options.prepareInstalledRuntimeAcceptanceDriver!(request);
            if (!("path" in prepared) || !("descriptor" in prepared)) {
              throw new Error("Installed privacy descriptor binding is unavailable");
            }
            return prepared as Awaited<ReturnType<import("./privacy-recovery-installed-runner.js").InstalledPrivacyBoundaryOptions["prepareInstalledRuntimeAcceptanceDriver"]>>;
          },
        });
        if ("scope" in outcome) {
          recordPrivacyRecoveryAuthorityEvent("assertion", "installed-privacy-boundary-partial", outcome);
          fail("privacy_recovery_authority_corpus", "privacy_recovery_authority_corpus_failed", "Installed Agent authority boundary is partial; local diagnostics and recovery acceptance are still required");
        } else {
          state.privacyRecoveryAuthority = outcome;
        }
      } catch (error) {
        fail(
          "privacy_recovery_authority_corpus",
          "privacy_recovery_authority_corpus_failed",
          sanitize(error instanceof Error ? error.message : String(error)),
        );
      }
    }
  }
  if (state.failure === null) {
    const runner = options.runReleaseLifecycleCorpus;
    if (runner === undefined) {
      fail("release_lifecycle_corpus", "release_lifecycle_corpus_failed", "Release-lifecycle corpus runner is required for authoritative acceptance");
    }
    const candidate = state.candidate;
    if (state.failure === null && candidate === null) {
      fail(
        "release_lifecycle_corpus",
        "release_lifecycle_corpus_failed",
        "Release-lifecycle corpus requires a verified candidate",
      );
    }
    if (state.failure === null && runner !== undefined && candidate !== null) {
      try {
        state.releaseLifecycle = await runner!({
          profileName: options.profileName, profile: profile!, probe: options.probe,
          runId,
          workingDirectory: options.workingDirectory,
          candidate,
          processControl: options.processControl,
          client,
          configDirectoryName,
          timeouts,
          provisionVault: provisionTestVault,
          cleanupVault,
          record: recordReleaseLifecycleEvent,
          assertion: recordReleaseLifecycleAssertion,
        });
      } catch (error) {
        fail(
          "release_lifecycle_corpus",
          "release_lifecycle_corpus_failed",
          sanitize(error instanceof Error ? error.message : String(error)),
        );
      }
    }
  }
  if (state.failure === null) {
    try {
      const runner = options.runCrashRestorationRetainedAuthorityCorpus;
      if (runner === undefined) {
        throw new CrashRestorationRetainedAuthorityCorpusError("Installed crash runner is required; Node corpus evidence is not authoritative");
      }
      const candidate = state.candidate;
      state.crashRestorationRetainedAuthority = await runner({
          workingDirectory: options.workingDirectory,
          record: recordCrashRestorationRetainedAuthorityEvent,
          assertion: recordCrashRestorationRetainedAuthorityAssertion,
          ...(candidate === null || profile === null || options.probe.probeRunning === undefined || options.prepareInstalledRuntimeAcceptanceDriver === undefined ? {} : {
            installed: {
              runId, workingDirectory: options.workingDirectory,
              reportDirectory: dirname(options.evidencePath),
              candidate, profile, client, processControl: options.processControl,
              configDirectoryName, timeouts,
              probe: { ...options.probe, probeRunning: options.probe.probeRunning },
              prepareAcceptanceDriver: async request => {
                const prepared = await options.prepareInstalledRuntimeAcceptanceDriver!(request);
                if (!("path" in prepared) || !("descriptor" in prepared)) {
                  throw new Error("Installed crash descriptor binding is unavailable");
                }
                return prepared as Awaited<ReturnType<import("./installed-crash-restoration-slice.js").InstalledCrashRestorationSliceOptions["prepareAcceptanceDriver"]>>;
              },
              record: recordCrashRestorationRetainedAuthorityEvent,
              assertion: recordCrashRestorationRetainedAuthorityAssertion,
            },
          }),
        });
    } catch (error) {
      fail(
        "crash_restoration_retained_authority_corpus",
        "crash_restoration_retained_authority_corpus_failed",
        sanitize(error instanceof Error ? error.message : String(error)),
      );
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

  if (acceptanceDriver !== null && handle === null && !startupShutdownUnconfirmed) {
    try {
      await acceptanceDriver.cleanup();
    } catch (error) {
      fail(
        "acceptance_driver",
        "acceptance_driver_cleanup_failed",
        sanitize(error instanceof Error ? error.message : String(error)),
      );
    }
    acceptanceDriver = null;
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
  if (state.vault !== null && (handle !== null || startupShutdownUnconfirmed)) {
    // The process or listener may still own these files. Retain both roots.
    state.cleanup = { attempted: true, residualPaths: ["/"] };
    fail("cleanup", "residual_test_content", "Generated runtime shutdown was not confirmed");
  } else if (state.vault !== null) {
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

  if (isolatedRuntimeResidue) {
    state.cleanup = { attempted: true, residualPaths: [...(state.cleanup?.residualPaths ?? []), "isolated-runtime/"] };
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
    state.gateIsolation !== null
      ? composeGateIsolationCorpusEvidence({
          outcome: state.gateIsolation,
          events: gateIsolationEvents,
          assertions: gateIsolationAssertions,
        })
      : null;
  const registeredReferenceRewriteCorpus: RegisteredReferenceRewriteCorpusEvidence | null =
    state.registeredReferenceRewrite !== null
      ? composeRegisteredReferenceRewriteCorpusEvidence({
          outcome: state.registeredReferenceRewrite,
          events: registeredReferenceRewriteEvents,
          assertions: registeredReferenceRewriteAssertions,
        })
      : null;
  const semanticEvidenceSearchSnapshotCorpus: SemanticEvidenceCorpusEvidence | null =
    state.semanticEvidenceSearchSnapshot !== null
      ? composeSemanticEvidenceSearchSnapshotCorpusEvidence({
          outcome: state.semanticEvidenceSearchSnapshot,
          events: semanticEvidenceSearchSnapshotEvents,
          assertions: semanticEvidenceSearchSnapshotAssertions,
        })
      : null;
  const privacyRecoveryAuthorityCorpus: PrivacyRecoveryAuthorityCorpusEvidence | null =
    state.privacyRecoveryAuthority !== null
      ? privacyRecoveryAuthorityCorpusEvidenceSchema.parse(
          composePrivacyRecoveryAuthorityCorpusEvidence({
            outcome: state.privacyRecoveryAuthority,
            events: privacyRecoveryAuthorityEvents,
            assertions: privacyRecoveryAuthorityAssertions,
          }),
        )
      : null;
  const releaseLifecycleCorpus: ReleaseLifecycleCorpusEvidence | null =
    state.releaseLifecycle !== null
      ? releaseLifecycleCorpusEvidenceSchema.parse(
          composeReleaseLifecycleCorpusEvidence({
            outcome: state.releaseLifecycle,
            events: releaseLifecycleEvents,
            assertions: releaseLifecycleAssertions,
          }),
        )
      : null;
  const crashRestorationRetainedAuthorityCorpus: CrashRestorationRetainedAuthorityCorpusEvidence | null =
    state.crashRestorationRetainedAuthority !== null
      ? crashRestorationRetainedAuthorityCorpusEvidenceSchema.parse(
          composeCrashRestorationRetainedAuthorityCorpusEvidence({
            outcome: state.crashRestorationRetainedAuthority,
            events: crashRestorationRetainedAuthorityEvents,
            assertions: crashRestorationRetainedAuthorityAssertions,
          }),
        )
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
    contractPackageCorpus: null,
    publicWireCorpus: state.publicWireCorpus?.evidence ?? null,
    changeSetCorpus,
    gateIsolationCorpus,
    registeredReferenceRewriteCorpus,
    semanticEvidenceSearchSnapshotCorpus,
    privacyRecoveryAuthorityCorpus,
    releaseLifecycleCorpus,
    crashRestorationRetainedAuthorityCorpus,
    acceptanceMatrix: null,
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

  if (evidence.verdict === "passed") {
    try {
      if (contractAuthority === null || contractWire === null || state.vault === null || state.candidate === null || firstIdentity === null || state.beforeInventory === null || state.afterInventory === null || state.cleanup === null) throw new Error("Version contract package execution evidence is absent");
      const binding = { runId, profileName: options.profileName, candidateBundleSha256: state.candidate.identity.bundleSha256, vaultIdSha256: contractDigest(firstIdentity.vaultId), seedManifestSha256: state.vault.seedManifestSha256 };
      for (const [scenarioId, report] of [["registered-reference-byte-verification", registeredReferenceRewriteCorpus], ["successor-search-snapshot-graph-evidence", semanticEvidenceSearchSnapshotCorpus]] as const) {
        if (report === null) continue;
        const index = contractCrossCalls.findIndex(proof => proof.scenarioId === scenarioId);
        const proof = await (options.runContractCrossCall ?? runContractCrossCallScenario)({ authority: contractAuthority, scenarioId, endpoint: new URL(`http://127.0.0.1:${firstIdentity.port}/mcp`), expectedVaultId: firstIdentity.vaultId, binding, dependency: { binding, reportSha256: contractDigest(report), report } });
        if (index >= 0) contractCrossCalls[index] = proof; else contractCrossCalls.push(proof);
      }
      evidence.contractPackageCorpus = (options.completeContractPackage ?? completeContractPackageCorpus)({ authority: contractAuthority, wire: contractWire, crossCalls: contractCrossCalls, binding: { runId, profileName: options.profileName, candidateBundleSha256: state.candidate.identity.bundleSha256, vaultIdSha256: contractDigest(firstIdentity.vaultId), seedManifestSha256: state.vault.seedManifestSha256 }, beforeInventorySha256: contractDigest(state.beforeInventory), afterInventorySha256: contractDigest(state.afterInventory), cleanup: state.cleanup });
      state.acceptanceMatrix = createAcceptanceMatrixReport(evidence);
      (evidence as InstalledRuntimeEvidence & { acceptanceMatrix: AcceptanceMatrixReport }).acceptanceMatrix =
        state.acceptanceMatrix;
    } catch (error) {
      fail(
        "acceptance_matrix",
        "acceptance_matrix_failed",
        sanitize(error instanceof Error ? error.message : String(error)),
      );
      const failure = state.failure;
      if (failure === null) throw new Error("Acceptance matrix failure was not recorded");
      evidence.verdict = "failed";
      evidence.failure = {
        stage: failure.stage,
        code: failure.code,
        ...(failure.detail === undefined ? {} : { detail: failure.detail }),
      };
    }
  }

  const partialAuthority = contractAuthority as VersionContractPackage | null;
  if (partialAuthority !== null && state.candidate !== null && state.vault !== null && firstIdentity !== null) evidence.contractPackageExecution = { authoritySha256: partialAuthority.manifestSha256, binding: { runId, profileName: options.profileName, candidateBundleSha256: state.candidate.identity.bundleSha256, vaultIdSha256: contractDigest(firstIdentity.vaultId), seedManifestSha256: state.vault.seedManifestSha256 }, wire: contractWire, crossCalls: contractCrossCalls.map(proof => ({ ...proof, observations: [...proof.observations] })), complete: evidence.contractPackageCorpus !== null && evidence.contractPackageCorpus !== undefined, cleanup: state.cleanup === null ? null : { attempted: state.cleanup.attempted, residualPaths: [...state.cleanup.residualPaths] } };
  const privateMarkers = [
    "---\nstatus: active\ntags: [architecture]\n---\n# Design\n[[Target Note|target]] [[Missing Note]]\n",
    "q".repeat(4_718_592),
    ...(state.vault?.seedNotes.map((note) => note.content) ?? []),
    state.vault?.vaultPath ?? "",
    state.vault?.profileDirectory ?? "",
    options.workingDirectory,
  ];
  await writeEvidenceFile(options.evidencePath, evidence, privateMarkers);
  return { verdict: evidence.verdict, failure: state.failure, evidence, evidencePath: options.evidencePath };
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
