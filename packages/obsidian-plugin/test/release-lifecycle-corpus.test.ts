import { describe, expect, it } from "vitest";

import {
  RELEASE_LIFECYCLE_CORPUS_ID,
  ReleaseLifecycleCorpusError,
  composeReleaseLifecycleCorpusEvidence,
  releaseLifecycleCorpusEvidenceSchema,
  runReleaseLifecycleCorpus,
  type LifecycleScenarioResult,
  type PurgeScenarioResult,
  type UninstallScenarioResult,
  type UpgradeScenarioResult,
  type VerifiedReleaseBundle,
} from "../src/index.js";

const SHA = "a".repeat(64);

function release(version: string): VerifiedReleaseBundle {
  return {
    identity: {
      pluginId: "release-lifecycle-bridge",
      pluginVersion: version,
      minAppVersion: "1.13.4",
      bundleSha256: SHA,
      files: [{ path: "main.js", sha256: SHA, sizeBytes: 1 }],
    },
  } as unknown as VerifiedReleaseBundle;
}

function stages(names: readonly string[]) {
  return [...names.map((stage) => ({ stage, outcome: "passed" as const, detail: null })), {
    stage: "cleanup",
    outcome: "passed" as const,
    detail: null,
  }];
}

function installResult(): LifecycleScenarioResult {
  return {
    verdict: "passed",
    failure: null,
    stages: stages([
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
    ]) as LifecycleScenarioResult["stages"],
    bridgeIdentity: { vaultId: "vault-install", port: 10_001 },
    registrationCommand: null,
    install: {
      vaultPath: "/generated/install",
      outcome: "success",
      action: "installed",
      repairedFiles: [],
      removedStaleFiles: [],
      failure: null,
      deployment: {
        state: "artifacts_installed",
        requiredNextSteps: ["plugin_enablement_required", "mcp_registration_required"],
      },
    },
    repair: {
      vaultPath: "/generated/install",
      outcome: "success",
      action: "repaired",
      repairedFiles: ["main.js"],
      removedStaleFiles: [],
      failure: null,
      deployment: null,
    },
    cleanup: { attempted: true, residualPaths: [] },
  };
}

function upgradeResult(): UpgradeScenarioResult {
  return {
    verdict: "passed",
    failure: null,
    stages: stages([
      "queue_work",
      "upgrade",
      "state_preservation",
      "post_upgrade_pause",
      "explicit_resume",
    ]) as UpgradeScenarioResult["stages"],
    bridgeIdentity: { vaultId: "vault-upgrade", port: 10_002 },
    queuedChangeSetIds: ["change-set-a", "change-set-b"],
    upgrade: {
      outcome: "upgraded",
      fromVersion: "1.0.0",
      toVersion: "2.0.0",
      completedPhases: ["replace", "reload", "migrate", "recovery", "health"],
      awaitingOperatorResume: true,
      failure: null,
    },
    cleanup: { attempted: true, residualPaths: [] },
  } as UpgradeScenarioResult;
}

function uninstallResult(): UninstallScenarioResult {
  return {
    verdict: "passed",
    failure: null,
    stages: stages([
      "work_through_mcp",
      "uninstall",
      "post_uninstall_verification",
      "reinstall",
      "restored_bridge_identity",
    ]) as UninstallScenarioResult["stages"],
    bridgeIdentity: { vaultId: "vault-uninstall", port: 10_003 },
    registrationCommand: null,
    registrationRemovalCommand: null,
    drainedChangeSetId: "change-set-c",
    uninstall: { outcome: "uninstalled", registrationRemovalCommand: "remove", failure: null },
    reinstall: {
      vaultPath: "/generated/uninstall",
      outcome: "success",
      action: "installed",
      repairedFiles: [],
      removedStaleFiles: [],
      failure: null,
      deployment: null,
    },
    cleanup: { attempted: true, residualPaths: [] },
  } as UninstallScenarioResult;
}

function purgeResult(): PurgeScenarioResult {
  return {
    verdict: "passed",
    failure: null,
    stages: stages([
      "refusal_queued_work",
      "refusal_queued_work_offline",
      "refusal_unresolved_recovery",
      "refusal_non_interactive",
      "refusal_operator_cancelled",
      "uninstall",
      "purge",
      "post_purge_verification",
    ]) as PurgeScenarioResult["stages"],
    bridgeIdentity: { vaultId: "vault-purge", port: 10_004 },
    registrationCommand: null,
    drainedChangeSetId: "change-set-d",
    refusals: [
      { stage: "refusal_queued_work", code: "purge_work_queued" },
      { stage: "refusal_unresolved_recovery", code: "purge_recovery_untrusted" },
      { stage: "refusal_non_interactive", code: "purge_confirmation_required" },
      { stage: "refusal_operator_cancelled", code: "purge_confirmation_declined" },
    ],
    uninstall: { outcome: "uninstalled", registrationRemovalCommand: "remove", failure: null },
    purge: { outcome: "purged", backup: { directory: "/generated/backup", verified: true }, failure: null },
    backupDirectory: "/generated/backup",
    cleanup: { attempted: true, residualPaths: [] },
  } as PurgeScenarioResult;
}

describe("verified release lifecycle corpus", () => {
  it("composes all installed-runtime lifecycle transitions into closed evidence", async () => {
    const events: Array<{ kind: "transport" | "tool" | "assertion" | "cleanup"; name: string; detail: unknown }> = [];
    const assertions: string[] = [];
    const outcome = await runReleaseLifecycleCorpus({
      installRelease: release("1.0.0"),
      previousRelease: release("1.0.0"),
      upgradeRelease: release("2.0.0"),
      scenarios: {
        install: async () => installResult(),
        upgrade: async () => upgradeResult(),
        uninstall: async () => uninstallResult(),
        purge: async () => purgeResult(),
      },
      record: (event) => events.push(event),
      assertion: (name) => assertions.push(name),
    });

    expect(outcome.releases.upgrade.pluginVersion).toBe("2.0.0");
    expect(outcome.migration.completedPhases).toEqual([
      "replace",
      "reload",
      "migrate",
      "recovery",
      "health",
    ]);
    expect(outcome.removal).toEqual({
      uninstallGuarded: true,
      purgeQueuedWorkRefused: true,
      purgeRecoveryRefused: true,
      purgeInteractive: true,
      backupVerified: true,
    });

    const evidence = composeReleaseLifecycleCorpusEvidence({ outcome, events, assertions });
    expect(evidence.corpusId).toBe(RELEASE_LIFECYCLE_CORPUS_ID);
    expect(releaseLifecycleCorpusEvidenceSchema.parse(evidence)).toEqual(evidence);
  });

  it("fails closed when a required lifecycle scenario stage is absent", async () => {
    await expect(
      runReleaseLifecycleCorpus({
        installRelease: release("1.0.0"),
        previousRelease: release("1.0.0"),
        upgradeRelease: release("2.0.0"),
        scenarios: {
          install: async () => ({ ...installResult(), stages: [] }),
          upgrade: async () => upgradeResult(),
          uninstall: async () => uninstallResult(),
          purge: async () => purgeResult(),
        },
        record: () => undefined,
        assertion: () => undefined,
      }),
    ).rejects.toBeInstanceOf(ReleaseLifecycleCorpusError);
  });
});
