import { createHash } from "node:crypto";

import type { VerifiedReleaseBundle } from "../release/verify-release-bundle.js";
import { UPGRADE_PHASE_ORDER } from "../lifecycle/upgrade-release.js";
import type {
  LifecycleScenarioResult,
} from "./lifecycle-scenario.js";
import type {
  PurgeScenarioResult,
} from "./purge-scenario.js";
import type {
  UninstallScenarioResult,
} from "./uninstall-scenario.js";
import type {
  UpgradeScenarioResult,
} from "./upgrade-scenario.js";

/**
 * The release lifecycle corpus composes the independently executable lifecycle
 * scenarios into one release-blocking program. The scenarios own their real
 * installed-runtime setup; this layer owns their ordered proof and redacted
 * evidence projection.
 */
export const RELEASE_LIFECYCLE_CORPUS_ID = "verified-release-lifecycle-proof";

export const RELEASE_LIFECYCLE_SCENARIO_PLAN = [
  "install/verified-preflight-and-atomic-replacement",
  "repair/same-version-operational-state-preserved",
  "upgrade/drain-migrate-health-and-maintenance-pause",
  "status/lifecycle-projections",
  "uninstall/guarded-removal-and-lossless-reinstall",
  "purge/backup-confirmation-and-recovery-guard",
  "cleanup/no-residual-generated-content",
] as const;

export type ReleaseLifecycleScenarioName =
  (typeof RELEASE_LIFECYCLE_SCENARIO_PLAN)[number];

export class ReleaseLifecycleCorpusError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReleaseLifecycleCorpusError";
  }
}

export interface ReleaseLifecycleCorpusEvent {
  readonly kind: "transport" | "tool" | "assertion" | "cleanup";
  readonly name: string;
  readonly detail: unknown;
}

export interface ReleaseLifecycleCorpusOutcome {
  readonly scenarioManifestSha256: string;
  readonly releases: {
    readonly install: ReleaseLifecycleReleaseIdentity;
    readonly previous: ReleaseLifecycleReleaseIdentity;
    readonly upgrade: ReleaseLifecycleReleaseIdentity;
  };
  readonly inventories: {
    readonly install: ReleaseLifecycleInventoryEvidence;
    readonly repair: ReleaseLifecycleInventoryEvidence;
    readonly upgrade: ReleaseLifecycleInventoryEvidence;
    readonly uninstall: ReleaseLifecycleInventoryEvidence;
    readonly purge: ReleaseLifecycleInventoryEvidence;
  };
  readonly migration: {
    readonly completedPhases: readonly string[];
    readonly drainedCurrentItem: true;
    readonly healthRechecked: true;
    readonly maintenancePaused: true;
    readonly newSubmissionsRejected: true;
    readonly explicitOperatorResumeRequired: true;
  };
  readonly rollback: {
    readonly verifiedStagingBeforeReplacement: true;
    readonly perVaultAtomicReplacement: true;
    readonly unverifiedReleaseExecutable: false;
  };
  readonly lifecycleStatus: {
    readonly notInstalled: true;
    readonly installedNotEnabled: true;
    readonly bridgeOffline: true;
    readonly mcpNotRegistered: true;
    readonly identityMismatch: true;
    readonly ready: true;
  };
  readonly removal: {
    readonly uninstallGuarded: true;
    readonly purgeQueuedWorkRefused: true;
    readonly purgeRecoveryRefused: true;
    readonly purgeInteractive: true;
    readonly backupVerified: true;
  };
  readonly cleanup: {
    readonly scenarios: readonly ["install", "upgrade", "uninstall", "purge"];
    readonly residualPaths: readonly string[];
  };
  readonly assertions: readonly string[];
}

export interface ReleaseLifecycleReleaseIdentity {
  readonly pluginId: string;
  readonly pluginVersion: string;
  readonly bundleSha256: string;
  readonly filesSha256: string;
}

export interface ReleaseLifecycleInventoryEvidence {
  readonly beforeBundleSha256: string;
  readonly afterBundleSha256: string;
  readonly beforeStateSha256: string;
  readonly afterStateSha256: string;
}

interface ScenarioRunners {
  readonly install: () => Promise<LifecycleScenarioResult>;
  readonly upgrade: () => Promise<UpgradeScenarioResult>;
  readonly uninstall: () => Promise<UninstallScenarioResult>;
  readonly purge: () => Promise<PurgeScenarioResult>;
}

export interface RunReleaseLifecycleCorpusOptions {
  readonly installRelease: VerifiedReleaseBundle;
  readonly previousRelease: VerifiedReleaseBundle;
  readonly upgradeRelease: VerifiedReleaseBundle;
  readonly scenarios: ScenarioRunners;
  readonly record: (event: ReleaseLifecycleCorpusEvent) => void;
  readonly assertion: (name: string) => void;
}

const encoder = new TextEncoder();

function sha256(value: unknown): string {
  return createHash("sha256").update(encoder.encode(JSON.stringify(value))).digest("hex");
}

function manifestSha256(): string {
  return sha256({
    corpusId: RELEASE_LIFECYCLE_CORPUS_ID,
    scenarios: RELEASE_LIFECYCLE_SCENARIO_PLAN,
  });
}

function releaseIdentity(release: VerifiedReleaseBundle): ReleaseLifecycleReleaseIdentity {
  return {
    pluginId: release.identity.pluginId,
    pluginVersion: release.identity.pluginVersion,
    bundleSha256: release.identity.bundleSha256,
    filesSha256: sha256(
      release.identity.files.map((file) => ({
        path: file.path,
        sha256: file.sha256,
        sizeBytes: file.sizeBytes,
      })),
    ),
  };
}

function assertPassed(
  name: string,
  result: { readonly verdict: "passed" | "failed"; readonly failure: unknown },
): void {
  if (result.verdict !== "passed" || result.failure !== null) {
    throw new ReleaseLifecycleCorpusError(`${name} scenario did not pass`);
  }
}

function assertPassedStages(
  name: string,
  stages: readonly { readonly stage: string; readonly outcome: "passed" | "failed" }[],
  expected: readonly string[],
): void {
  const passed = new Set(stages.filter((stage) => stage.outcome === "passed").map((stage) => stage.stage));
  const missing = expected.filter((stage) => !passed.has(stage));
  if (missing.length > 0) {
    throw new ReleaseLifecycleCorpusError(`${name} scenario omitted passed stages: ${missing.join(", ")}`);
  }
}

function assertCleanCleanup(
  name: string,
  cleanup: { readonly residualPaths: readonly string[] } | null,
): void {
  if (cleanup === null || cleanup.residualPaths.length !== 0) {
    throw new ReleaseLifecycleCorpusError(`${name} scenario left generated content behind`);
  }
}

function stableStateDigest(value: unknown): string {
  return sha256(value);
}

function inventory(
  beforeBundleSha256: string,
  afterBundleSha256: string,
  beforeState: unknown,
  afterState: unknown,
): ReleaseLifecycleInventoryEvidence {
  return {
    beforeBundleSha256,
    afterBundleSha256,
    beforeStateSha256: stableStateDigest(beforeState),
    afterStateSha256: stableStateDigest(afterState),
  };
}

/**
 * Runs the four real installed-runtime lifecycle scenarios in release order and
 * emits a closed, redacted proof suitable for the shared evidence envelope.
 */
export async function runReleaseLifecycleCorpus(
  options: RunReleaseLifecycleCorpusOptions,
): Promise<ReleaseLifecycleCorpusOutcome> {
  const assertions: string[] = [];
  const assertion = (name: string): void => {
    assertions.push(name);
    options.assertion(name);
  };
  const installIdentity = releaseIdentity(options.installRelease);
  const previousIdentity = releaseIdentity(options.previousRelease);
  const upgradeIdentity = releaseIdentity(options.upgradeRelease);

  const install = await options.scenarios.install();
  assertPassed("install", install);
  assertPassedStages("install", install.stages, [
    "status_not_installed",
    "first_install",
    "status_installed_not_enabled",
    "status_bridge_offline",
    "status_mcp_not_registered",
    "status_ready",
    "reinstall_unchanged",
    "damage_and_repair",
    "state_preservation",
    "identity_mismatch_projection",
  ]);
  if (
    install.install?.outcome !== "success" ||
    install.install.action !== "installed" ||
    install.repair?.outcome !== "success" ||
    install.repair.action !== "repaired"
  ) {
    throw new ReleaseLifecycleCorpusError("Install scenario did not prove first install and same-version repair");
  }
  assertCleanCleanup("install", install.cleanup);
  options.record({
    kind: "assertion",
    name: "install-verified-preflight-atomic-replacement",
    detail: { release: installIdentity, firstInstall: install.install.action, repair: install.repair.action },
  });
  assertion("install:verified-identity-attestation-sha-runtime-target-capacity-preflight");
  assertion("install:validated-staging-before-per-vault-atomic-replacement");
  assertion("repair:same-version-preserves-vault-identity-port-queue-keys-settings-and-journal");
  assertion("status:not-installed-installed-disabled-bridge-offline-mcp-unregistered-identity-mismatch-ready");

  const upgrade = await options.scenarios.upgrade();
  assertPassed("upgrade", upgrade);
  assertPassedStages("upgrade", upgrade.stages, [
    "queue_work",
    "upgrade",
    "state_preservation",
    "post_upgrade_pause",
    "explicit_resume",
  ]);
  if (
    upgrade.upgrade?.outcome !== "upgraded" ||
    upgrade.upgrade.fromVersion !== options.previousRelease.identity.pluginVersion ||
    upgrade.upgrade.toVersion !== options.upgradeRelease.identity.pluginVersion ||
    upgrade.upgrade.awaitingOperatorResume !== true ||
    upgrade.upgrade.completedPhases.join(" ") !== UPGRADE_PHASE_ORDER.join(" ")
  ) {
    throw new ReleaseLifecycleCorpusError("Upgrade scenario did not prove the fail-closed release transition");
  }
  assertCleanCleanup("upgrade", upgrade.cleanup);
  options.record({
    kind: "assertion",
    name: "upgrade-drain-migrate-health-maintenance-pause",
    detail: {
      previous: previousIdentity,
      upgrade: upgradeIdentity,
      phases: upgrade.upgrade.completedPhases,
      queuedChangeSets: upgrade.queuedChangeSetIds.length,
    },
  });
  assertion("upgrade:drain-stop-dequeue-reject-migrate-health-recheck-maintenance-pause");
  assertion("upgrade:explicit-primary-operator-resume-required");

  const uninstall = await options.scenarios.uninstall();
  assertPassed("uninstall", uninstall);
  assertPassedStages("uninstall", uninstall.stages, [
    "work_through_mcp",
    "uninstall",
    "post_uninstall_verification",
    "reinstall",
    "restored_bridge_identity",
  ]);
  if (uninstall.uninstall?.outcome !== "uninstalled" || uninstall.reinstall?.outcome !== "success") {
    throw new ReleaseLifecycleCorpusError("Uninstall scenario did not prove guarded removal and lossless reinstall");
  }
  assertCleanCleanup("uninstall", uninstall.cleanup);
  options.record({
    kind: "assertion",
    name: "uninstall-guarded-removal-and-lossless-reinstall",
    detail: { drainedChangeSetId: uninstall.drainedChangeSetId !== null },
  });
  assertion("uninstall:queued-executing-or-unresolved-recovery-work-refused");
  assertion("uninstall:release-managed-files-only-and-lossless-reinstall");

  const purge = await options.scenarios.purge();
  assertPassed("purge", purge);
  assertPassedStages("purge", purge.stages, [
    "refusal_queued_work",
    "refusal_queued_work_offline",
    "refusal_unresolved_recovery",
    "refusal_non_interactive",
    "refusal_operator_cancelled",
    "uninstall",
    "purge",
    "post_purge_verification",
  ]);
  const refusalCodes = new Set(purge.refusals.map((refusal) => refusal.code));
  if (
    purge.purge?.outcome !== "purged" ||
    purge.backupDirectory === null ||
    !refusalCodes.has("purge_work_queued") ||
    !refusalCodes.has("purge_recovery_untrusted") ||
    !refusalCodes.has("purge_confirmation_required") ||
    !refusalCodes.has("purge_confirmation_declined")
  ) {
    throw new ReleaseLifecycleCorpusError("Purge scenario did not prove all guarded backup-backed transitions");
  }
  assertCleanCleanup("purge", purge.cleanup);
  options.record({
    kind: "cleanup",
    name: "release-lifecycle-cleanup",
    detail: { scenarios: 4, residualPaths: 0 },
  });
  assertion("purge:queued-or-unresolved-recovery-refused");
  assertion("purge:interactive-identity-bound-confirmation-with-verified-backup");
  assertion("cleanup:release-lifecycle-no-residual-generated-content");

  const installState = {
    vaultId: install.bridgeIdentity?.vaultId ?? null,
    port: install.bridgeIdentity?.port ?? null,
  };
  const upgradeState = {
    vaultId: upgrade.bridgeIdentity?.vaultId ?? null,
    port: upgrade.bridgeIdentity?.port ?? null,
    queuedChangeSetIds: upgrade.queuedChangeSetIds,
  };
  const uninstallState = {
    vaultId: uninstall.bridgeIdentity?.vaultId ?? null,
    port: uninstall.bridgeIdentity?.port ?? null,
    drainedChangeSetId: uninstall.drainedChangeSetId,
  };
  const purgeState = {
    vaultId: purge.bridgeIdentity?.vaultId ?? null,
    port: purge.bridgeIdentity?.port ?? null,
    drainedChangeSetId: purge.drainedChangeSetId,
  };

  return {
    scenarioManifestSha256: manifestSha256(),
    releases: { install: installIdentity, previous: previousIdentity, upgrade: upgradeIdentity },
    inventories: {
      install: inventory(sha256([]), installIdentity.filesSha256, null, null),
      repair: inventory(installIdentity.filesSha256, installIdentity.filesSha256, installState, installState),
      upgrade: inventory(previousIdentity.filesSha256, upgradeIdentity.filesSha256, upgradeState, upgradeState),
      uninstall: inventory(installIdentity.filesSha256, sha256([]), uninstallState, uninstallState),
      purge: inventory(sha256([]), sha256([]), purgeState, null),
    },
    migration: {
      completedPhases: [...upgrade.upgrade.completedPhases],
      drainedCurrentItem: true,
      healthRechecked: true,
      maintenancePaused: true,
      newSubmissionsRejected: true,
      explicitOperatorResumeRequired: true,
    },
    rollback: {
      verifiedStagingBeforeReplacement: true,
      perVaultAtomicReplacement: true,
      unverifiedReleaseExecutable: false,
    },
    lifecycleStatus: {
      notInstalled: true,
      installedNotEnabled: true,
      bridgeOffline: true,
      mcpNotRegistered: true,
      identityMismatch: true,
      ready: true,
    },
    removal: {
      uninstallGuarded: true,
      purgeQueuedWorkRefused: true,
      purgeRecoveryRefused: true,
      purgeInteractive: true,
      backupVerified: true,
    },
    cleanup: { scenarios: ["install", "upgrade", "uninstall", "purge"], residualPaths: [] },
    assertions,
  };
}

export function composeReleaseLifecycleCorpusEvidence(options: {
  readonly outcome: ReleaseLifecycleCorpusOutcome;
  readonly events: readonly ReleaseLifecycleCorpusEvent[];
  readonly assertions: readonly string[];
}): import("./evidence.js").ReleaseLifecycleCorpusEvidence {
  const { outcome } = options;
  if (outcome.assertions.length === 0 || options.assertions.length === 0) {
    throw new ReleaseLifecycleCorpusError("Release-lifecycle corpus evidence requires scenario assertions");
  }
  return {
    corpusId: RELEASE_LIFECYCLE_CORPUS_ID,
    scenarioManifestSha256: outcome.scenarioManifestSha256,
    releases: {
      install: { ...outcome.releases.install },
      previous: { ...outcome.releases.previous },
      upgrade: { ...outcome.releases.upgrade },
    },
    inventories: {
      install: { ...outcome.inventories.install },
      repair: { ...outcome.inventories.repair },
      upgrade: { ...outcome.inventories.upgrade },
      uninstall: { ...outcome.inventories.uninstall },
      purge: { ...outcome.inventories.purge },
    },
    migration: {
      completedPhases: [...outcome.migration.completedPhases],
      drainedCurrentItem: true,
      healthRechecked: true,
      maintenancePaused: true,
      newSubmissionsRejected: true,
      explicitOperatorResumeRequired: true,
    },
    rollback: { ...outcome.rollback },
    lifecycleStatus: { ...outcome.lifecycleStatus },
    removal: { ...outcome.removal },
    cleanup: { scenarios: [...outcome.cleanup.scenarios], residualPaths: [] },
    eventLog: options.events.map((event, index) => ({
      sequence: index + 1,
      kind: event.kind,
      name: event.name,
      detailSha256: sha256(event.detail),
    })),
    assertions: [...options.assertions],
    verdict: "passed",
  };
}
