import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  BRIDGE_STATE_DIRECTORY_NAME,
  RECOVERY_JOURNAL_FRAME_SCHEMA_VERSION,
} from "../change-set.js";
import {
  isVerifiedCandidateBundle,
  sha256Hex,
} from "../installed-runtime/candidate-bundle.js";
import type { ObservedHealth } from "../installed-runtime/loopback-client.js";
import {
  InstallInterruptionError,
  installReleaseToManagedVaults,
  type InstallFailureInjectionHooks,
  type ManagedVaultInstallTarget,
  type ReleaseInstallBatchResult,
} from "./install-release.js";
import {
  expectedInstalledFiles,
  inspectDeployedManagedSet,
  inspectInstalledManagedSet,
  managedVaultPluginDirectory,
  RELEASE_MANAGED_CHECKSUM_FILE,
} from "./release-managed-files.js";
import {
  PERSISTENT_STATE_SCHEMA_VERSION,
  type PersistedBridgeSettings,
} from "../managed-vault-runtime.js";
import type { VerifiedReleaseBundle } from "../release/verify-release-bundle.js";
import { PLUGIN_VERSION, PROTOCOL_VERSION } from "../version.js";

/**
 * Drained Managed Vault upgrade orchestration (issue #199, spec §9.2).
 *
 * The Primary Operator upgrades one Managed Vault from a verified staged
 * Release. This module composes the established boundaries and adds none of
 * its own: the branded `VerifiedReleaseBundle` from the release verifier
 * (issue #196), the per-Vault staging boundary and atomic two-rename swap
 * from the lifecycle installer (issue #198), and the per-Vault maintenance
 * drain (`maintenance_pending` → drain → `maintenance_paused` /
 * `maintenance_failed`) from the Operational Gate state machine (issue #40)
 * through `ManagedVaultBridgeRuntime.runOperatorMaintenance`.
 *
 * Durable, detectable order:
 *
 * 1. **drain/replace** — the loaded runtime enters `maintenance_pending`,
 *    drains the current Change Set to a trustworthy terminal state, retains
 *    the FIFO queue, stops dequeueing, and rejects new submissions while
 *    reads and health stay available; only then does the maintenance
 *    operation atomically swap in the verified bundle (all operational state
 *    carried byte-for-byte) and revalidate persisted state. The state
 *    machine's own persisted `writeMode`/`lifecycle` record is the durable
 *    evidence for this phase.
 * 2. **reload** — the host seam performs the real plugin reload or Obsidian
 *    restart; the freshly loaded runtime migrates the versioned persistent
 *    state and replays Recovery Journals fail-closed during `load()`.
 * 3. **migrate** — a second maintenance pass on the reloaded runtime proves
 *    the running files hash-equal the verified bundle identity and
 *    revalidates/persists the versioned state.
 * 4. **recovery** — the post-upgrade health evidence must show a trusted
 *    recovery state; an unresolved or blocked recovery fails the upgrade.
 * 5. **health** — post-upgrade health evidence must confirm the expected
 *    plugin/protocol versions, Vault identity, state and journal schemas,
 *    queue preservation, recovery trust, and cache/index readiness, with the
 *    Vault held `maintenance_paused` for the operator's explicit resume.
 *
 * Every phase boundary is mirrored into a versioned evidence journal
 * (`upgrade-state.json`, preserved operational state — never release-managed)
 * so an interrupted or failed upgrade leaves machine-actionable fail-closed
 * evidence. Copying files alone never reports success: `upgraded` is
 * returned only after the health phase validates.
 *
 * Rollback: the previous bundle is restored only when the on-disk persistent
 * state is still readable by the old runtime (schema versions at or below the
 * ceilings the old runtime observed before the upgrade). The drain barrier
 * guarantees no Change Set executes inside the upgrade window, so no new
 * Recovery Journal frames can appear there; journal trust is enforced by the
 * recovery check instead. A migration that crossed the readability boundary
 * forbids blind downgrade: the new state and the diagnostic evidence are
 * retained and the Vault remains blocked.
 */

export const UPGRADE_EVIDENCE_FILENAME = "upgrade-state.json";
export const UPGRADE_EVIDENCE_SCHEMA_VERSION = 1;

export type UpgradePhase = "replace" | "reload" | "migrate" | "recovery" | "health";

export const UPGRADE_PHASE_ORDER: readonly UpgradePhase[] = [
  "replace",
  "reload",
  "migrate",
  "recovery",
  "health",
];

export type ReleaseUpgradeFailureCode =
  | "upgrade_unverified_bundle"
  | "upgrade_not_installed"
  | "upgrade_preflight_untrusted"
  | "upgrade_evidence_failed"
  | "upgrade_interrupted"
  | "upgrade_replace_failed"
  | "upgrade_reload_failed"
  | "upgrade_migration_failed"
  | "upgrade_recovery_untrusted"
  | "upgrade_health_failed"
  | "upgrade_downgrade_forbidden"
  | "upgrade_rollback_failed";

export class ReleaseUpgradeError extends Error {
  constructor(
    message: string,
    readonly code: ReleaseUpgradeFailureCode,
  ) {
    super(message);
    this.name = "ReleaseUpgradeError";
  }
}

/**
 * The loaded per-Vault plugin runtime the orchestrator drives. The production
 * implementation is `ManagedVaultBridgeRuntime`; the seam exists so the
 * installed-runtime harness can hand over the runtime hosted inside the
 * (re)started Obsidian process. `resumeWrites` is exposed for the Primary
 * Operator's explicit resume only — the orchestrator never calls it.
 */
export interface UpgradeRuntimeAdapter {
  readonly persistedSettings: PersistedBridgeSettings | undefined;
  runOperatorMaintenance(replaceValidatedBundle: () => void | Promise<void>): Promise<void>;
  resumeWrites(): Promise<void>;
}

export interface ManagedVaultUpgradeOptions {
  /** The verified target Release — the release verifier's branded result. */
  readonly bundle: VerifiedReleaseBundle;
  /** Per-Vault staging boundary: Vault path, config directory, runtime version. */
  readonly target: ManagedVaultInstallTarget;
  /** The currently loaded (old) runtime for this Vault. */
  readonly runtime: UpgradeRuntimeAdapter;
  /**
   * Host seam for the real plugin reload or Obsidian restart: stops the
   * current runtime and loads a fresh one from the bundle currently installed
   * on disk, resolving with the newly loaded runtime. A rejection means the
   * new runtime could not load or migrate the persisted state fail-closed.
   */
  readonly reloadRuntime: () => Promise<UpgradeRuntimeAdapter>;
  /** Live health observation of a loaded runtime (e.g. loopback `vault_health`). */
  readonly observeHealth: (runtime: UpgradeRuntimeAdapter) => Promise<ObservedHealth>;
  /**
   * The verified previous Release, when the operator permits a safe rollback.
   * Restored only while the old runtime can still read the persisted state.
   */
  readonly rollbackBundle?: VerifiedReleaseBundle;
  /** Installer seam; defaults to the lifecycle installer. */
  readonly install?: (
    bundle: VerifiedReleaseBundle,
    targets: readonly ManagedVaultInstallTarget[],
  ) => Promise<ReleaseInstallBatchResult>;
  /** Failure-injection hooks forwarded to the installer (interruption tests). */
  readonly hooks?: InstallFailureInjectionHooks;
  /**
   * Raw on-disk persistent-state snapshot seam for the rollback readability
   * boundary; defaults to reading `<pluginDirectory>/data.json`. Returns
   * `undefined` when no state file exists.
   */
  readonly readPersistedStateSnapshot?: () => Promise<unknown>;
}

export interface UpgradeFailureRecord {
  readonly code: ReleaseUpgradeFailureCode;
  readonly phase: UpgradePhase | "preflight";
  readonly detail: string;
}

/** Versioned fail-closed lifecycle evidence persisted as `upgrade-state.json`. */
export interface ManagedVaultUpgradeEvidence {
  readonly schemaVersion: typeof UPGRADE_EVIDENCE_SCHEMA_VERSION;
  readonly pluginId: string;
  readonly vaultId: string;
  readonly fromVersion: string;
  readonly toVersion: string;
  readonly bundleTag: string;
  readonly outcome: "in_progress" | "succeeded" | "failed" | "rolled_back";
  /** Completed phases in the fixed durable order. */
  readonly completedPhases: readonly UpgradePhase[];
  /** Queue facts observed before the drain; the health phase must reproduce them. */
  readonly preUpgradeQueue: { readonly length: number; readonly headChangeSetId: string | null };
  /** Schema ceilings the old runtime observed/wrote before the upgrade. */
  readonly rollbackCeiling: {
    readonly persistentStateSchema: number;
    readonly changeSetRegistrySchema: number;
  };
  readonly failure: UpgradeFailureRecord | null;
  readonly rollback: {
    readonly attempted: boolean;
    readonly restored: boolean;
    readonly refused: "downgrade_forbidden" | null;
  };
}

export interface ManagedVaultUpgradeResult {
  readonly outcome: "upgraded" | "failed" | "rolled_back";
  readonly pluginId: string;
  readonly vaultPath: string;
  readonly vaultId: string | null;
  readonly fromVersion: string | null;
  readonly toVersion: string;
  /**
   * True only after a validated upgrade: the Vault is held
   * `maintenance_paused` until the Primary Operator explicitly resumes writes.
   */
  readonly awaitingOperatorResume: boolean;
  readonly completedPhases: readonly UpgradePhase[];
  readonly failure: UpgradeFailureRecord | null;
  readonly rollback: {
    readonly attempted: boolean;
    readonly restored: boolean;
    readonly refused: "downgrade_forbidden" | null;
  };
  readonly evidence: ManagedVaultUpgradeEvidence;
}

interface RegistryPreservationSnapshot {
  readonly nextEnqueueSeq: number;
  readonly entries: readonly {
    readonly changeSetId: string;
    readonly submissionKey: string;
    readonly enqueueSeq: number;
    readonly state: string;
  }[];
  readonly tombstones: readonly {
    readonly submissionKey: string;
    readonly changeSetId: string;
  }[];
}

interface PreUpgradeFacts {
  readonly vaultId: string;
  readonly port: number;
  readonly queue: { readonly length: number; readonly headChangeSetId: string | null };
  readonly registry: RegistryPreservationSnapshot | null;
  readonly rollbackCeiling: {
    readonly persistentStateSchema: number;
    readonly changeSetRegistrySchema: number;
  };
}

function detailOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function registrySnapshot(
  settings: PersistedBridgeSettings | undefined,
): RegistryPreservationSnapshot | null {
  const changeSets = settings?.changeSets;
  if (changeSets === undefined) return null;
  return {
    nextEnqueueSeq: changeSets.nextEnqueueSeq,
    entries: changeSets.entries.map((entry) => ({
      changeSetId: entry.changeSetId,
      submissionKey: entry.submissionKey,
      enqueueSeq: entry.enqueueSeq,
      state: entry.changeSet.state,
    })),
    tombstones: changeSets.tombstones.map((tombstone) => ({ ...tombstone })),
  };
}

function registryPreserved(
  before: RegistryPreservationSnapshot | null,
  after: RegistryPreservationSnapshot | null,
): string | null {
  if (before === null || after === null) {
    return before === after ? null : "Change Set registry presence changed across the upgrade";
  }
  if (before.nextEnqueueSeq !== after.nextEnqueueSeq) {
    return "Change Set registry enqueue sequence changed across the upgrade";
  }
  if (before.entries.length !== after.entries.length) {
    return "Queued Change Sets were lost across the upgrade";
  }
  for (const [index, entry] of before.entries.entries()) {
    const current = after.entries[index]!;
    if (
      entry.changeSetId !== current.changeSetId ||
      entry.submissionKey !== current.submissionKey ||
      entry.enqueueSeq !== current.enqueueSeq ||
      entry.state !== current.state
    ) {
      return `Queued Change Set ${entry.changeSetId} did not survive the upgrade`;
    }
  }
  if (before.tombstones.length !== after.tombstones.length) {
    return "Submission Key tombstones were lost across the upgrade";
  }
  for (const [index, tombstone] of before.tombstones.entries()) {
    const current = after.tombstones[index]!;
    if (
      tombstone.changeSetId !== current.changeSetId ||
      tombstone.submissionKey !== current.submissionKey
    ) {
      return "Submission Key tombstones changed across the upgrade";
    }
  }
  return null;
}

/** Validates the evidence-journal shape; unknown or partial records reject. */
function parseUpgradeEvidence(value: unknown): ManagedVaultUpgradeEvidence | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const phases = record.completedPhases;
  const queue = record.preUpgradeQueue as Record<string, unknown> | undefined;
  const ceiling = record.rollbackCeiling as Record<string, unknown> | undefined;
  const rollback = record.rollback as Record<string, unknown> | undefined;
  const failure = record.failure as Record<string, unknown> | null | undefined;
  if (
    record.schemaVersion !== UPGRADE_EVIDENCE_SCHEMA_VERSION ||
    typeof record.pluginId !== "string" ||
    typeof record.vaultId !== "string" ||
    typeof record.fromVersion !== "string" ||
    typeof record.toVersion !== "string" ||
    typeof record.bundleTag !== "string" ||
    !["in_progress", "succeeded", "failed", "rolled_back"].includes(record.outcome as string) ||
    !Array.isArray(phases) ||
    // Completed phases must be exactly a prefix of the fixed durable order:
    // out-of-order, duplicated, or non-prefix journals are corrupt evidence.
    phases.length > UPGRADE_PHASE_ORDER.length ||
    phases.some((phase, index) => phase !== UPGRADE_PHASE_ORDER[index]) ||
    typeof queue !== "object" || queue === null ||
    typeof queue.length !== "number" ||
    !(typeof queue.headChangeSetId === "string" || queue.headChangeSetId === null) ||
    typeof ceiling !== "object" || ceiling === null ||
    typeof ceiling.persistentStateSchema !== "number" ||
    typeof ceiling.changeSetRegistrySchema !== "number" ||
    typeof rollback !== "object" || rollback === null ||
    typeof rollback.attempted !== "boolean" ||
    typeof rollback.restored !== "boolean" ||
    !(rollback.refused === null || rollback.refused === "downgrade_forbidden") ||
    !(failure === null || failure === undefined ||
      (typeof failure === "object" && !Array.isArray(failure) &&
        typeof failure.code === "string" && typeof failure.phase === "string" &&
        typeof failure.detail === "string"))
  ) {
    return null;
  }
  return value as ManagedVaultUpgradeEvidence;
}

/**
 * Reads one Managed Vault's persisted upgrade evidence. Absent file → null;
 * a present but malformed record throws — corrupted fail-closed evidence is a
 * defect, never a clean slate.
 */
export async function readManagedVaultUpgradeEvidence(
  pluginDirectory: string,
): Promise<ManagedVaultUpgradeEvidence | null> {
  let raw: string;
  try {
    raw = await readFile(join(pluginDirectory, UPGRADE_EVIDENCE_FILENAME), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ReleaseUpgradeError(
      "Persisted upgrade evidence is not valid JSON",
      "upgrade_evidence_failed",
    );
  }
  const evidence = parseUpgradeEvidence(parsed);
  if (evidence === null) {
    throw new ReleaseUpgradeError(
      "Persisted upgrade evidence failed schema validation",
      "upgrade_evidence_failed",
    );
  }
  return evidence;
}

/**
 * The on-disk persistent state is readable by the old runtime only while its
 * schema versions stay at or below the ceilings the old runtime observed and
 * wrote before the upgrade. Anything newer was written solely by the new
 * runtime after a schema migration, so restoring the old bundle would be a
 * blind downgrade.
 */
function isOldRuntimeReadable(
  snapshot: unknown,
  ceiling: ManagedVaultUpgradeEvidence["rollbackCeiling"],
): boolean {
  if (typeof snapshot !== "object" || snapshot === null || Array.isArray(snapshot)) return false;
  const state = snapshot as Record<string, unknown>;
  if (
    typeof state.schemaVersion !== "number" ||
    !Number.isInteger(state.schemaVersion) ||
    state.schemaVersion < 1 ||
    state.schemaVersion > ceiling.persistentStateSchema
  ) {
    return false;
  }
  if (state.changeSets !== undefined) {
    if (typeof state.changeSets !== "object" || state.changeSets === null) return false;
    const registry = (state.changeSets as Record<string, unknown>).schemaVersion;
    if (
      typeof registry !== "number" ||
      !Number.isInteger(registry) ||
      registry < 1 ||
      registry > ceiling.changeSetRegistrySchema
    ) {
      return false;
    }
  }
  return true;
}

/**
 * Upgrades one drained Managed Vault to a verified staged Release. Operational
 * failures return a `failed`/`rolled_back` result with fail-closed evidence;
 * only contract violations (an unverified bundle or rollback bundle) throw.
 * Success never resumes writes: `awaitingOperatorResume` marks the Vault held
 * `maintenance_paused` for the Primary Operator's explicit `resumeWrites()`.
 */
export async function upgradeManagedVaultRelease(
  options: ManagedVaultUpgradeOptions,
): Promise<ManagedVaultUpgradeResult> {
  const { bundle, target } = options;
  if (!isVerifiedCandidateBundle(bundle)) {
    throw new ReleaseUpgradeError(
      "Refusing to upgrade from an unverified bundle: upgrades require the release verifier's branded result",
      "upgrade_unverified_bundle",
    );
  }
  if (
    options.rollbackBundle !== undefined &&
    !isVerifiedCandidateBundle(options.rollbackBundle)
  ) {
    throw new ReleaseUpgradeError(
      "Refusing an unverified rollback bundle: rollback restores only a verifier-branded Release",
      "upgrade_unverified_bundle",
    );
  }
  const install = options.install ?? installReleaseToManagedVaults;
  const configDirectoryName = target.configDirectoryName ?? ".obsidian";
  const pluginDirectory = managedVaultPluginDirectory(
    target.vaultPath,
    configDirectoryName,
    bundle.identity.pluginId,
  );
  const evidencePath = join(pluginDirectory, UPGRADE_EVIDENCE_FILENAME);
  const readSnapshot =
    options.readPersistedStateSnapshot ??
    (async (): Promise<unknown> => {
      // The running plugin persists its settings to `.llm-wiki/bridge-state.json`
      // before `data.json` and loads that recovery-state copy in preference to
      // the plugin directory's `data.json` (main.ts). The rollback-readability
      // boundary must be judged on the same authoritative copy — otherwise a
      // crash between the two writes could let the old bundle be restored over
      // state it will actually load (from the recovery copy) and cannot read.
      const authoritativePath = join(
        target.vaultPath,
        BRIDGE_STATE_DIRECTORY_NAME,
        "bridge-state.json",
      );
      const readStateFile = async (path: string): Promise<string | null> => {
        try {
          return await readFile(path, "utf8");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
          throw error;
        }
      };
      const raw = (await readStateFile(authoritativePath)) ?? (await readStateFile(
        join(pluginDirectory, "data.json"),
      ));
      if (raw === null) return undefined;
      try {
        return JSON.parse(raw);
      } catch {
        return undefined;
      }
    });

  const evidence: {
    -readonly [K in keyof ManagedVaultUpgradeEvidence]: ManagedVaultUpgradeEvidence[K];
  } = {
    schemaVersion: UPGRADE_EVIDENCE_SCHEMA_VERSION,
    pluginId: bundle.identity.pluginId,
    vaultId: "",
    fromVersion: "",
    toVersion: bundle.identity.pluginVersion,
    bundleTag: bundle.tag,
    outcome: "in_progress",
    completedPhases: [],
    preUpgradeQueue: { length: 0, headChangeSetId: null },
    rollbackCeiling: { persistentStateSchema: 0, changeSetRegistrySchema: 0 },
    failure: null,
    rollback: { attempted: false, restored: false, refused: null },
  };
  let evidencePersisted = false;
  const persistEvidence = async (): Promise<void> => {
    // Atomic publish: the evidence file is preserved operational state and
    // must never be observed half-written across the bundle swap.
    const temporary = `${evidencePath}.tmp`;
    await writeFile(temporary, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
    await rename(temporary, evidencePath);
    evidencePersisted = true;
  };
  const appendPhase = async (phase: UpgradePhase): Promise<void> => {
    const expected = UPGRADE_PHASE_ORDER[evidence.completedPhases.length];
    if (phase !== expected) {
      throw new ReleaseUpgradeError(
        `Upgrade phase ${phase} is out of the durable order; expected ${expected ?? "completion"}`,
        "upgrade_evidence_failed",
      );
    }
    evidence.completedPhases = [...evidence.completedPhases, phase];
    await persistEvidence();
  };
  const result = (
    outcome: ManagedVaultUpgradeResult["outcome"],
    awaitingOperatorResume: boolean,
  ): ManagedVaultUpgradeResult => ({
    outcome,
    pluginId: bundle.identity.pluginId,
    vaultPath: target.vaultPath,
    vaultId: evidence.vaultId === "" ? null : evidence.vaultId,
    fromVersion: evidence.fromVersion === "" ? null : evidence.fromVersion,
    toVersion: bundle.identity.pluginVersion,
    awaitingOperatorResume,
    completedPhases: evidence.completedPhases,
    failure: evidence.failure,
    rollback: evidence.rollback,
    evidence: { ...evidence },
  });
  const failPreflight = async (
    code: ReleaseUpgradeFailureCode,
    detail: string,
  ): Promise<ManagedVaultUpgradeResult> => {
    evidence.failure = { code, phase: "preflight", detail };
    evidence.outcome = "failed";
    if (evidencePersisted) await persistEvidence().catch(() => undefined);
    return result("failed", false);
  };

  // Preflight: an upgrade continues an existing, integrity-complete
  // installation; anything else is repair/install territory (#198).
  const deployed = await inspectDeployedManagedSet(pluginDirectory);
  if (deployed.integrity !== "complete" || deployed.pluginVersion === null) {
    return failPreflight(
      "upgrade_not_installed",
      `No integrity-complete installation to upgrade from (integrity: ${deployed.integrity}` +
        `${deployed.defectiveFiles.length > 0 ? `, defective: ${deployed.defectiveFiles.join(", ")}` : ""})`,
    );
  }
  evidence.fromVersion = deployed.pluginVersion;

  // Rollback restores the verified previous Release — not an arbitrary older
  // one. An operator-supplied rollback bundle that is not the running version
  // could restore bytes whose schema ceiling is below the state the running
  // bundle already wrote, so it is refused up front.
  if (
    options.rollbackBundle !== undefined &&
    options.rollbackBundle.identity.pluginVersion !== evidence.fromVersion
  ) {
    evidence.rollback = { attempted: false, restored: false, refused: "downgrade_forbidden" };
    return failPreflight(
      "upgrade_downgrade_forbidden",
      `Rollback bundle ${options.rollbackBundle.identity.pluginVersion} is not the installed release ` +
        `${evidence.fromVersion}; only the verified previous Release may be restored`,
    );
  }

  // The pre-upgrade observation proves the old runtime's identity, queue,
  // and supported schema ceilings, and that the Vault is in a trustworthy
  // writable state to drain from.
  let preHealth: ObservedHealth;
  try {
    preHealth = await options.observeHealth(options.runtime);
  } catch (error) {
    return failPreflight(
      "upgrade_preflight_untrusted",
      `Pre-upgrade health observation failed: ${detailOf(error)}`,
    );
  }
  if (
    preHealth.write.state !== "writable" ||
    preHealth.effectiveGate !== null ||
    preHealth.recovery.state !== "none"
  ) {
    return failPreflight(
      "upgrade_preflight_untrusted",
      "The Vault is not in a trustworthy writable state to upgrade " +
        `(write: ${preHealth.write.state}, gate: ${preHealth.effectiveGate?.code ?? "none"}, ` +
        `recovery: ${preHealth.recovery.state})`,
    );
  }
  const runtimeSettings = options.runtime.persistedSettings;
  const pre: PreUpgradeFacts = {
    vaultId: preHealth.vault.id,
    port: preHealth.listener.port,
    queue: { length: preHealth.queue.length, headChangeSetId: preHealth.queue.headChangeSetId },
    registry: registrySnapshot(runtimeSettings),
    rollbackCeiling: {
      persistentStateSchema: preHealth.versions.persistentStateSchema,
      // The runtime-normalized registry schema is the version the old runtime
      // itself writes — the ceiling an old-bundle rollback must not exceed.
      changeSetRegistrySchema:
        runtimeSettings?.changeSets?.schemaVersion ?? preHealth.versions.persistentStateSchema,
    },
  };
  evidence.vaultId = pre.vaultId;
  evidence.preUpgradeQueue = pre.queue;
  evidence.rollbackCeiling = pre.rollbackCeiling;

  // The initial evidence record must be durable before any mutation; without
  // it an interruption would be undetectable, so the upgrade refuses to start.
  try {
    await persistEvidence();
  } catch (error) {
    return failPreflight(
      "upgrade_evidence_failed",
      `Upgrade evidence could not be persisted before the upgrade: ${detailOf(error)}`,
    );
  }

  // Failure handling shared by every phase after the evidence record exists.
  // Writes are never reopened here; when a runtime is loaded we drive the
  // maintenance machine into its persisted `maintenance_failed` state so the
  // blocked gate, `finish_upgrade` operator action, and rejected resume are
  // all machine-actionable.
  let currentRuntime: UpgradeRuntimeAdapter = options.runtime;
  let bundleReplacedOnDisk = false;
  const markFailed = async (cause: unknown): Promise<void> => {
    try {
      await currentRuntime.runOperatorMaintenance(() => {
        throw cause instanceof Error ? cause : new Error(String(cause));
      });
    } catch {
      // The maintenance machine rethrows the cause; the persisted
      // `maintenance_failed` marker is the point. A runtime without a Change
      // Set service (restricted load) cannot record it — noted in evidence.
    }
  };
  const fail = async (
    code: ReleaseUpgradeFailureCode,
    phase: UpgradePhase,
    error: unknown,
  ): Promise<ManagedVaultUpgradeResult> => {
    evidence.failure = { code, phase, detail: detailOf(error) };
    evidence.outcome = "failed";
    // Rollback is decided only once the bundle bytes were actually replaced;
    // before that the previous bundle is still in place (or the installer
    // already restored it), so there is nothing to roll back.
    if (bundleReplacedOnDisk) {
      let oldReadable = false;
      try {
        oldReadable = isOldRuntimeReadable(await readSnapshot(), pre.rollbackCeiling);
      } catch {
        oldReadable = false;
      }
      if (!oldReadable) {
        // The migration crossed the readability boundary: blind downgrade is
        // forbidden. The new state and this diagnostic evidence are retained.
        evidence.rollback = { attempted: false, restored: false, refused: "downgrade_forbidden" };
        evidence.failure = {
          code: "upgrade_downgrade_forbidden",
          phase,
          detail:
            `${detailOf(error)}; the persisted state is no longer readable by the previous ` +
            "runtime (schema ceiling " +
            `${pre.rollbackCeiling.persistentStateSchema}/${pre.rollbackCeiling.changeSetRegistrySchema}), ` +
            "so the previous bundle was not restored; the new state is retained and the Vault remains blocked",
        };
      } else if (options.rollbackBundle !== undefined) {
        evidence.rollback = { attempted: true, restored: false, refused: null };
        try {
          const rollbackBatch = await install(options.rollbackBundle, [target]);
          const rollbackTarget = rollbackBatch.targets[0];
          if (
            !rollbackBatch.preflightPassed ||
            rollbackTarget === undefined ||
            rollbackTarget.outcome === "failed"
          ) {
            throw new ReleaseUpgradeError(
              `Rollback install failed: ${rollbackTarget?.failure?.detail ?? "preflight failed"}`,
              "upgrade_rollback_failed",
            );
          }
          currentRuntime = await options.reloadRuntime();
          evidence.rollback = { attempted: true, restored: true, refused: null };
          evidence.outcome = "rolled_back";
        } catch (rollbackError) {
          evidence.failure = {
            code: "upgrade_rollback_failed",
            phase,
            detail: `${detailOf(error)}; rollback then failed: ${detailOf(rollbackError)}`,
          };
        }
      }
    }
    await markFailed(error);
    await persistEvidence().catch(() => undefined);
    return result(evidence.outcome === "rolled_back" ? "rolled_back" : "failed", false);
  };

  // Phase 1 — drain + atomic replace on the loaded (old) runtime. The
  // maintenance machine enters `maintenance_pending`, drains the current
  // Change Set, stops dequeueing, and rejects new submissions; only inside
  // that drained window does the installer swap in the verified bundle.
  try {
    await options.runtime.runOperatorMaintenance(async () => {
      const batch = await install(bundle, [target], { hooks: options.hooks });
      const installed = batch.targets[0];
      if (!batch.preflightPassed || installed === undefined || installed.outcome === "failed") {
        throw new ReleaseUpgradeError(
          `Bundle replacement failed: ${installed?.failure?.detail ?? "install preflight failed"}`,
          "upgrade_replace_failed",
        );
      }
      // The bundle bytes are replaced on disk as soon as the installer swap
      // inside the drained window completes. Record that before the
      // maintenance machine continues its own post-swap steps, so a failure
      // after the swap (migration/health recheck) still reaches the bounded
      // rollback decision instead of concluding "nothing to roll back".
      bundleReplacedOnDisk = true;
      // `unchanged` means the deployed files already hash-equal the target —
      // only possible when resuming an interrupted upgrade; a fresh same
      // version is repaired, never "upgraded", and still continues safely.
    });
  } catch (error) {
    return fail(
      error instanceof InstallInterruptionError
        ? "upgrade_interrupted"
        : error instanceof ReleaseUpgradeError
          ? error.code
          : "upgrade_replace_failed",
      "replace",
      error,
    );
  }
  try {
    await appendPhase("replace");
  } catch (error) {
    return fail("upgrade_evidence_failed", "replace", error);
  }

  // Phase 2 — real plugin reload or Obsidian restart through the host seam.
  // The new runtime's load() performs the versioned persistent-state and
  // Recovery Journal migration fail-closed.
  try {
    currentRuntime = await options.reloadRuntime();
  } catch (error) {
    return fail("upgrade_reload_failed", "reload", error);
  }
  try {
    await appendPhase("reload");
  } catch (error) {
    return fail("upgrade_evidence_failed", "reload", error);
  }

  // Phase 3 — a second drained maintenance pass on the reloaded runtime:
  // proves the running files hash-equal the verified bundle identity (the
  // reload ran from the bytes the verifier approved) and revalidates/persists
  // the migrated state through the machine's own fail-closed migration.
  try {
    await currentRuntime.runOperatorMaintenance(async () => {
      const checksumBytes = new Uint8Array(
        await readFile(join(bundle.bundleDirectory, RELEASE_MANAGED_CHECKSUM_FILE)),
      );
      const expected = expectedInstalledFiles(bundle.identity, sha256Hex(checksumBytes));
      const installedNow = await inspectInstalledManagedSet(pluginDirectory, expected);
      if (installedNow === null || !installedNow.complete) {
        throw new ReleaseUpgradeError(
          "The reloaded runtime is not running from the verified bundle bytes",
          "upgrade_migration_failed",
        );
      }
    });
  } catch (error) {
    return fail("upgrade_migration_failed", "migrate", error);
  }
  try {
    await appendPhase("migrate");
  } catch (error) {
    return fail("upgrade_evidence_failed", "migrate", error);
  }

  // Phases 4–5 — post-upgrade health evidence, observed while the Vault is
  // held `maintenance_paused`: trusted recovery first, then the full
  // validation of versions, identity, schemas, queue preservation, readiness,
  // and the explicit-resume pause.
  let postHealth: ObservedHealth;
  try {
    postHealth = await options.observeHealth(currentRuntime);
  } catch (error) {
    return fail("upgrade_health_failed", "health", error);
  }
  if (postHealth.recovery.state !== "none") {
    return fail(
      "upgrade_recovery_untrusted",
      "recovery",
      new Error(
        `Post-upgrade recovery state is ${postHealth.recovery.state}; the upgrade is not trusted`,
      ),
    );
  }
  try {
    await appendPhase("recovery");
  } catch (error) {
    return fail("upgrade_evidence_failed", "recovery", error);
  }

  const healthFailure = (detail: string): Error =>
    new ReleaseUpgradeError(detail, "upgrade_health_failed");
  const registryProblem = registryPreserved(
    pre.registry,
    registrySnapshot(currentRuntime.persistedSettings),
  );
  const validated =
    postHealth.vault.id === pre.vaultId &&
    postHealth.listener.port === pre.port &&
    postHealth.versions.plugin === PLUGIN_VERSION &&
    postHealth.versions.protocol === PROTOCOL_VERSION &&
    postHealth.versions.persistentStateSchema === PERSISTENT_STATE_SCHEMA_VERSION &&
    postHealth.versions.recoveryJournalSchema === RECOVERY_JOURNAL_FRAME_SCHEMA_VERSION &&
    postHealth.readiness.searchSnapshot === "ready" &&
    postHealth.readiness.index === "ready" &&
    postHealth.queue.length === pre.queue.length &&
    postHealth.queue.headChangeSetId === pre.queue.headChangeSetId &&
    registryProblem === null &&
    postHealth.write.state === "paused" &&
    postHealth.write.pauseSource === "maintenance" &&
    postHealth.effectiveGate?.code === "writes_paused" &&
    postHealth.lifecycle.upgrade === "succeeded" &&
    postHealth.lifecycle.migration === "succeeded" &&
    postHealth.operatorAction === "resume_writes" &&
    postHealth.overall !== "blocked";
  if (!validated) {
    return fail(
      "upgrade_health_failed",
      "health",
      healthFailure(
        registryProblem ??
          "Post-upgrade health evidence did not confirm the expected versions, Vault identity, " +
            "schemas, queue preservation, readiness, and the maintenance pause: " +
            JSON.stringify({
              vaultId: postHealth.vault.id,
              port: postHealth.listener.port,
              versions: postHealth.versions,
              readiness: postHealth.readiness,
              queue: postHealth.queue,
              write: postHealth.write,
              lifecycle: postHealth.lifecycle,
              effectiveGate: postHealth.effectiveGate,
              overall: postHealth.overall,
            }),
      ),
    );
  }
  try {
    await appendPhase("health");
  } catch (error) {
    return fail("upgrade_evidence_failed", "health", error);
  }

  evidence.outcome = "succeeded";
  await persistEvidence();
  // Writes stay paused: the Primary Operator resumes explicitly through
  // `resumeWrites()` — never as a side effect of the upgrade.
  return result("upgraded", true);
}
