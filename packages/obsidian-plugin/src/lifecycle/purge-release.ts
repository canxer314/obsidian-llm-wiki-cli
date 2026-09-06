import { randomUUID } from "node:crypto";
import { mkdir, open, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";

import {
  BRIDGE_STATE_DIRECTORY_NAME,
  parseChangeSetRegistryState,
  type ChangeSetRegistryState,
} from "../change-set.js";
import { sha256Hex } from "../installed-runtime/candidate-bundle.js";
import type { ObservedHealth } from "../installed-runtime/loopback-client.js";
import {
  InstallInterruptionError,
  type ManagedVaultInstallTarget,
} from "./install-release.js";
import { managedVaultPluginDirectory } from "./release-managed-files.js";
import {
  readManagedVaultUpgradeEvidence,
  type ManagedVaultUpgradeEvidence,
} from "./upgrade-release.js";
import { RELEASE_PLUGIN_ID } from "../release/release-identity.js";
import {
  openRecoveryJournal,
  type RecoveryJournalRecord,
} from "../recovery-journal.js";

/**
 * Managed Vault purge orchestration (issue #201, spec §9.3): the separate
 * local interactive operation that intentionally removes one Managed Vault's
 * operational state — Vault identity and persistent endpoint/port, FIFO queue
 * and Change Set records, Submission Key records, settings (`data.json`), and
 * every Recovery Journal — only after a verifiable backup exists outside the
 * state being removed and the Primary Operator explicitly confirms the loss.
 *
 * Purge is NOT an uninstall flag or a variant of
 * `uninstallManagedVaultRelease`: uninstall removes only release-managed
 * files and retains all operational state; purge removes only the enumerated
 * operational state and never touches release-managed files, Vault content,
 * or Claude Code local configuration (which is never read or modified here).
 *
 * This module composes the established boundaries and adds no second
 * file-ownership or evidence implementation: the plugin-directory and
 * state-directory layout from the installer's ownership module, the persisted
 * `data.json` / Recovery Journal / live-health evidence readers mirrored from
 * the uninstall safety gate, and `readManagedVaultUpgradeEvidence` from the
 * upgrade orchestration as the single authority over `upgrade-state.json`.
 *
 * Fail-closed recovery gate: purge refuses with a machine-actionable failure
 * code whenever
 *
 * - a Change Set is executing (live `queue.currentExecutionId` or a persisted
 *   registry entry in the `executing` phase),
 * - work is queued (a non-empty FIFO, live or persisted),
 * - recovery is in progress, unresolved, blocked, corrupt, or otherwise
 *   untrusted (live recovery state, a pending/failed Recovery Journal frame,
 *   a `result_unproven` Change Set record, a maintenance write mode or failed
 *   lifecycle in the persisted registry, or interrupted/failed
 *   `upgrade-state.json` evidence), or
 * - live and persisted evidence cannot positively prove the target safe —
 *   unavailable or contradictory evidence is a refusal, never a pass.
 *
 * No force, skip-recovery, or skip-backup flag exists anywhere in this API
 * surface.
 *
 * Phase order is strict: enumerate (nothing written) → safety gate → backup →
 * backup re-verification against the source state → interactive confirmation
 * → deletion → post-deletion verification. Absent confirmation and
 * non-interactive execution change none of the enumerated state and return a
 * typed refusal. Backup creation, verification, confirmation, or deletion
 * failure is reported precisely with the remaining state and the backup
 * disposition, so a rerun is deterministic: a completed purge reports
 * `already_purged`, a refused purge changes no state and refuses again
 * identically, and a failed/interrupted deletion is completed by the next
 * confirmed run because deletion itself is idempotent.
 */

export type ReleasePurgeFailureCode =
  | "purge_change_set_executing"
  | "purge_work_queued"
  | "purge_recovery_untrusted"
  | "purge_evidence_unavailable"
  | "purge_evidence_contradictory"
  | "purge_backup_failed"
  | "purge_backup_verification_failed"
  | "purge_confirmation_required"
  | "purge_confirmation_declined"
  | "purge_deletion_failed"
  | "purge_interrupted";

export class ReleasePurgeError extends Error {
  constructor(
    message: string,
    readonly code: ReleasePurgeFailureCode | "purge_path_unsafe",
  ) {
    super(message);
    this.name = "ReleasePurgeError";
  }
}

/** The operational-state file kinds purge enumerates, backs up, and deletes. */
export type PurgeInventoryFileKind = "settings" | "recovery_journal";

export interface PurgeInventoryFile {
  readonly kind: PurgeInventoryFileKind;
  /** Vault-relative source path (`/` separators). */
  readonly sourcePath: string;
  /** Backup-relative copy path (`/` separators). */
  readonly backupPath: string;
  readonly bytes: number;
  readonly sha256: string;
}

/** The capabilities a confirmed purge permanently destroys, in the report. */
export const PURGE_LOST_CAPABILITIES = [
  "vault_identity",
  "idempotency_replay",
  "queued_work",
  "recovery_baselines",
] as const;

export type PurgeLostCapability = (typeof PURGE_LOST_CAPABILITIES)[number];

export const PURGE_LOST_CAPABILITY_DETAILS: Readonly<Record<PurgeLostCapability, string>> = {
  vault_identity:
    "The Vault identity and its persistent loopback endpoint/port are deleted; " +
    "a future install generates a fresh identity and endpoint and requires a fresh Claude Code registration",
  idempotency_replay:
    "Every Submission Key record is deleted; resubmitting a previously accepted Submission Key " +
    "no longer replays its Change Set and binds fresh work instead",
  queued_work:
    "The FIFO queue and every retained Change Set record are deleted; " +
    "queued work history and terminal idempotency evidence are gone",
  recovery_baselines:
    "Every Recovery Journal is deleted; the recovery baselines needed to finish or audit " +
    "interrupted work are gone",
};

/** The full enumeration of operational state a purge would remove. */
export interface ManagedVaultPurgeInventory {
  readonly pluginId: string;
  readonly vaultPath: string;
  /** The Vault identity slated for removal, when one was persisted. */
  readonly vaultId: string | null;
  /** The persistent loopback port slated for removal, when one was persisted. */
  readonly port: number | null;
  readonly queue: {
    readonly pendingChangeSets: number;
    readonly headChangeSetId: string | null;
    readonly changeSetRecords: number;
    /** Submission Key records: registry entries plus accepted-key tombstones. */
    readonly submissionKeyRecords: number;
  };
  /** Every file slated for removal, with its integrity digest. */
  readonly files: readonly PurgeInventoryFile[];
  readonly lostCapabilities: readonly PurgeLostCapability[];
}

export interface ManagedVaultPurgeBackup {
  /** The created backup directory; survives the deletion by construction. */
  readonly directory: string;
  readonly inventoryPath: string;
  readonly checksumManifestPath: string;
  readonly files: readonly PurgeInventoryFile[];
  /** True only after re-verification against the source state passed. */
  readonly verified: boolean;
}

/**
 * The confirmation request handed to the operator's interactive seam. The
 * seam must positively affirm this specific Vault identity/path before any
 * state byte is deleted.
 */
export interface ManagedVaultPurgeConfirmation {
  readonly vaultPath: string;
  readonly pluginId: string;
  readonly vaultId: string | null;
  readonly inventory: ManagedVaultPurgeInventory;
  readonly backup: ManagedVaultPurgeBackup;
}

/** Failure-injection seam mirroring the installer's hooks (interruption tests). */
export interface PurgeFailureInjectionHooks {
  /** Runs after the backup is fully written, before it is re-verified. */
  readonly afterBackupWritten?: (context: {
    vaultPath: string;
    backupDirectory: string;
  }) => void | Promise<void>;
  /** Runs after an affirmative confirmation, before the first byte is deleted. */
  readonly afterConfirmation?: (context: { vaultPath: string }) => void | Promise<void>;
  /** Runs after deletion, before the post-deletion verification. */
  readonly afterDeletion?: (context: { vaultPath: string }) => void | Promise<void>;
}

export interface ManagedVaultPurgeOptions {
  /** Per-Vault boundary: Vault path and configuration directory name. */
  readonly target: ManagedVaultInstallTarget;
  /** Defaults to the pinned release plugin id. */
  readonly pluginId?: string;
  /**
   * Operator-chosen directory the verifiable backup is written into. Must be
   * absolute and outside the Vault so the backup survives the deletion.
   */
  readonly backupDirectory: string;
  /**
   * The local interactive confirmation seam. Without it the purge refuses
   * (`purge_confirmation_required`) and changes nothing; the callback must
   * resolve true — positively affirming the specific Vault identity/path in
   * the confirmation request — before any state byte is deleted.
   */
  readonly confirm?: (confirmation: ManagedVaultPurgeConfirmation) => Promise<boolean>;
  /**
   * Live health observation seam (e.g. the loopback `vault_health` client).
   * Resolves with the observed health when a Bridge answers, or null when the
   * Vault is offline. A rejection means the observation itself failed —
   * unavailable evidence, which refuses.
   */
  readonly observeHealth?: () => Promise<ObservedHealth | null>;
  /**
   * Persisted `data.json` reader; defaults to reading the plugin directory's
   * state file. Resolves undefined when no state file exists.
   */
  readonly readPersistedState?: (pluginDirectory: string) => Promise<unknown>;
  /**
   * Recovery Journal reader; defaults to opening the Vault's
   * `.llm-wiki/recovery-journal.bin`. Resolves null when no journal exists or
   * the journal holds no record.
   */
  readonly readRecoveryJournal?: (vaultPath: string) => Promise<RecoveryJournalRecord | null>;
  /** Persisted upgrade-evidence reader; defaults to `readManagedVaultUpgradeEvidence`. */
  readonly readUpgradeEvidence?: (
    pluginDirectory: string,
  ) => Promise<ManagedVaultUpgradeEvidence | null>;
  /** Per-file deletion seam; defaults to removing the file (idempotent). */
  readonly deleteStateFile?: (path: string) => Promise<void>;
  /** Failure-injection hooks for interruption and filesystem-fault tests. */
  readonly hooks?: PurgeFailureInjectionHooks;
  /** Backup-directory uniqueness seam for deterministic tests. */
  readonly nonce?: () => string;
}

export type ReleasePurgeOutcome = "purged" | "already_purged" | "refused" | "failed";

export interface ManagedVaultPurgeResult {
  readonly outcome: ReleasePurgeOutcome;
  readonly pluginId: string;
  readonly vaultPath: string;
  /** The Vault identity that was (or would be) purged, when one was persisted. */
  readonly vaultId: string | null;
  readonly failure: {
    readonly code: ReleasePurgeFailureCode;
    readonly detail: string;
  } | null;
  /** The full enumeration; null only when there was nothing to purge. */
  readonly inventory: ManagedVaultPurgeInventory | null;
  /** Backup disposition for safe retry; null when no backup was written. */
  readonly backup: ManagedVaultPurgeBackup | null;
  /** Vault-relative paths of the enumerated state this run deleted. */
  readonly deletedFiles: readonly string[];
  /** Enumerated state still on disk; non-empty only after a failed deletion. */
  readonly remainingState: readonly string[];
}

const PURGE_BACKUP_INVENTORY_FILE = "inventory.json";
const PURGE_BACKUP_CHECKSUM_MANIFEST = "checksums.sha256";
const RECOVERY_JOURNAL_FILE_NAME = /^recovery-journal.*\.bin$/u;

function detailOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface PersistedPurgeEvidence {
  readonly vaultId: string;
  readonly port: number;
  readonly registry: ChangeSetRegistryState | null;
}

/** Pending exactly the way the running service projects its FIFO queue. */
function pendingEntries(registry: ChangeSetRegistryState): ChangeSetRegistryState["entries"] {
  return registry.entries.filter(
    ({ execution }) => execution !== undefined && execution.phase !== "terminal",
  );
}

/**
 * Reads and validates the persisted `data.json` facts purge needs. A
 * malformed file or an out-of-shape record throws — corrupted fail-closed
 * evidence is a defect, never a clean slate.
 */
async function readPersistedPurgeEvidence(
  pluginDirectory: string,
  read: (pluginDirectory: string) => Promise<unknown>,
): Promise<PersistedPurgeEvidence | null> {
  const raw = await read(pluginDirectory);
  if (raw === undefined) return null;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new ReleasePurgeError(
      "Persisted Bridge settings are not an object",
      "purge_evidence_contradictory",
    );
  }
  const { vaultId, port, changeSets } = raw as Record<string, unknown>;
  if (
    typeof vaultId !== "string" ||
    vaultId.length === 0 ||
    typeof port !== "number" ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65_535
  ) {
    throw new ReleasePurgeError(
      "Persisted Bridge settings do not carry a valid Vault identity",
      "purge_evidence_contradictory",
    );
  }
  let registry: ChangeSetRegistryState | null = null;
  if (changeSets !== undefined) {
    try {
      registry = parseChangeSetRegistryState(changeSets);
    } catch (error) {
      throw new ReleasePurgeError(
        `Persisted Change Set registry failed validation: ${detailOf(error)}`,
        "purge_evidence_contradictory",
      );
    }
  }
  return { vaultId, port, registry };
}

async function defaultReadPersistedState(pluginDirectory: string): Promise<unknown> {
  let raw: string;
  try {
    raw = await readFile(join(pluginDirectory, "data.json"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new ReleasePurgeError(
      "Persisted Bridge settings are not valid JSON",
      "purge_evidence_contradictory",
    );
  }
}

async function defaultReadRecoveryJournal(
  vaultPath: string,
): Promise<RecoveryJournalRecord | null> {
  let handle;
  try {
    handle = await open(join(vaultPath, BRIDGE_STATE_DIRECTORY_NAME, "recovery-journal.bin"), "r");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  try {
    const journal = await openRecoveryJournal(handle, {});
    return (await journal.recover()) ?? null;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function readFileBytesOrNull(path: string): Promise<Uint8Array | null> {
  try {
    return new Uint8Array(await readFile(path));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/** Parses the backup's own checksum manifest (`sha256  path` LF lines). */
function parseBackupChecksumManifest(bytes: Uint8Array): ReadonlyMap<string, string> | null {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
  if (!text.endsWith("\n") || text.includes("\r")) return null;
  const entries = new Map<string, string>();
  for (const line of text.slice(0, -1).split("\n")) {
    const match = /^([a-f0-9]{64})  (.+)$/u.exec(line);
    if (match === null || match[1] === undefined || match[2] === undefined) return null;
    if (entries.has(match[2])) return null;
    entries.set(match[2], match[1]);
  }
  return entries;
}

/** Lists every regular file under a backup subtree as backup-relative paths. */
async function listBackupFiles(directory: string, prefix: string): Promise<string[]> {
  const found: string[] = [];
  const children = await readdir(directory, { withFileTypes: true });
  for (const child of children) {
    const relativePath = prefix === "" ? child.name : `${prefix}/${child.name}`;
    if (child.isDirectory()) {
      found.push(...(await listBackupFiles(join(directory, child.name), relativePath)));
    } else if (child.isFile()) {
      found.push(relativePath);
    }
  }
  return found.sort();
}

/**
 * Purges one Managed Vault's enumerated operational state after backup and
 * explicit interactive confirmation. Safety refusals and operational failures
 * return typed results; only contract violations (an unsafe Vault path or a
 * backup location that would not survive the deletion) throw.
 */
export async function purgeManagedVaultState(
  options: ManagedVaultPurgeOptions,
): Promise<ManagedVaultPurgeResult> {
  const { target } = options;
  const pluginId = options.pluginId ?? RELEASE_PLUGIN_ID;
  const configDirectoryName = target.configDirectoryName ?? ".obsidian";
  if (!isAbsolute(target.vaultPath)) {
    throw new ReleasePurgeError(
      `Unsafe Vault or configuration path: ${target.vaultPath} / ${configDirectoryName}`,
      "purge_path_unsafe",
    );
  }
  const vaultRoot = resolve(target.vaultPath);
  const backupRoot = resolve(options.backupDirectory);
  if (
    !isAbsolute(options.backupDirectory) ||
    backupRoot === vaultRoot ||
    backupRoot.startsWith(`${vaultRoot}${sep}`)
  ) {
    throw new ReleasePurgeError(
      `Unsafe backup location: ${options.backupDirectory} must be absolute and outside the Vault ` +
        "so the backup survives the deletion",
      "purge_path_unsafe",
    );
  }
  const pluginDirectory = managedVaultPluginDirectory(
    target.vaultPath,
    configDirectoryName,
    pluginId,
  );
  const stateDirectory = join(target.vaultPath, BRIDGE_STATE_DIRECTORY_NAME);
  const readPersistedState = options.readPersistedState ?? defaultReadPersistedState;
  const readRecoveryJournal = options.readRecoveryJournal ?? defaultReadRecoveryJournal;
  const readUpgradeEvidence = options.readUpgradeEvidence ?? readManagedVaultUpgradeEvidence;
  const deleteStateFile =
    options.deleteStateFile ?? (async (path: string) => rm(path, { force: true }));

  let vaultId: string | null = null;
  const result = (
    outcome: ReleasePurgeOutcome,
    failure: ManagedVaultPurgeResult["failure"],
    inventory: ManagedVaultPurgeInventory | null,
    backup: ManagedVaultPurgeBackup | null,
    deletedFiles: readonly string[],
    remainingState: readonly string[],
  ): ManagedVaultPurgeResult => ({
    outcome,
    pluginId,
    vaultPath: target.vaultPath,
    vaultId,
    failure,
    inventory,
    backup,
    deletedFiles,
    remainingState,
  });
  const refuse = (
    code: ReleasePurgeFailureCode,
    detail: string,
    inventory: ManagedVaultPurgeInventory | null = null,
    backup: ManagedVaultPurgeBackup | null = null,
  ): ManagedVaultPurgeResult => result("refused", { code, detail }, inventory, backup, [], []);

  // --- Enumeration phase (nothing is written or deleted yet): exactly which
  // operational state exists and would be removed.

  const settingsPath = join(pluginDirectory, "data.json");
  let settingsBytes: Uint8Array | null;
  try {
    settingsBytes = await readFileBytesOrNull(settingsPath);
  } catch (error) {
    return refuse(
      "purge_evidence_unavailable",
      `The persisted Bridge settings could not be inspected: ${detailOf(error)}`,
    );
  }
  let journalNames: string[];
  try {
    journalNames = (await readdir(stateDirectory))
      .filter((entry) => RECOVERY_JOURNAL_FILE_NAME.test(entry))
      .sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      journalNames = [];
    } else {
      return refuse(
        "purge_evidence_unavailable",
        `The Recovery Journal directory could not be inspected: ${detailOf(error)}`,
      );
    }
  }

  if (settingsBytes === null && journalNames.length === 0) {
    // No operational state exists: nothing would be removed, nothing needs a
    // backup, and no confirmation is required. Reruns are deterministic.
    return result("already_purged", null, null, null, [], []);
  }

  let persisted: PersistedPurgeEvidence | null = null;
  try {
    persisted = await readPersistedPurgeEvidence(pluginDirectory, readPersistedState);
  } catch (error) {
    if (error instanceof ReleasePurgeError) {
      return refuse("purge_evidence_contradictory", error.message);
    }
    return refuse(
      "purge_evidence_unavailable",
      `Persisted Bridge settings could not be read: ${detailOf(error)}`,
    );
  }
  vaultId = persisted?.vaultId ?? null;

  const inventoryFiles: PurgeInventoryFile[] = [];
  if (settingsBytes !== null) {
    const sourcePath = `${configDirectoryName}/plugins/${pluginId}/data.json`;
    inventoryFiles.push({
      kind: "settings",
      sourcePath,
      backupPath: `files/${sourcePath}`,
      bytes: settingsBytes.length,
      sha256: sha256Hex(settingsBytes),
    });
  }
  for (const name of journalNames) {
    const sourcePath = `${BRIDGE_STATE_DIRECTORY_NAME}/${name}`;
    let bytes: Uint8Array | null;
    try {
      bytes = await readFileBytesOrNull(join(stateDirectory, name));
    } catch (error) {
      return refuse(
        "purge_evidence_unavailable",
        `Recovery Journal ${name} could not be read: ${detailOf(error)}`,
      );
    }
    if (bytes === null) {
      return refuse(
        "purge_evidence_unavailable",
        `Recovery Journal ${name} disappeared during enumeration; the evidence changed under the purge`,
      );
    }
    inventoryFiles.push({
      kind: "recovery_journal",
      sourcePath,
      backupPath: `files/${sourcePath}`,
      bytes: bytes.length,
      sha256: sha256Hex(bytes),
    });
  }
  const registry = persisted?.registry ?? null;
  const inventory: ManagedVaultPurgeInventory = {
    pluginId,
    vaultPath: target.vaultPath,
    vaultId,
    port: persisted?.port ?? null,
    queue: {
      pendingChangeSets: registry === null ? 0 : pendingEntries(registry).length,
      headChangeSetId: registry === null ? null : (pendingEntries(registry)[0]?.changeSetId ?? null),
      changeSetRecords: registry?.entries.length ?? 0,
      submissionKeyRecords: (registry?.entries.length ?? 0) + (registry?.tombstones.length ?? 0),
    },
    files: inventoryFiles,
    lostCapabilities: PURGE_LOST_CAPABILITIES,
  };

  // --- Fail-closed recovery gate: the same evidence standards as the
  // uninstall safety gate (spec §9.3). Every refusal changes nothing.

  if (registry !== null) {
    const pending = pendingEntries(registry);
    const executing = pending.find((entry) => entry.execution?.phase === "executing");
    if (executing !== undefined) {
      return refuse(
        "purge_change_set_executing",
        `Change Set ${executing.changeSetId} is executing; drain or finish it before purging`,
        inventory,
      );
    }
    if (pending.length > 0) {
      return refuse(
        "purge_work_queued",
        `${pending.length} Change Set(s) remain in the FIFO queue ` +
          `(head: ${pending[0]?.changeSetId ?? "unknown"}); drain the queue before purging`,
        inventory,
      );
    }
    const unfinished = registry.entries.find(
      (entry) => entry.execution === undefined && entry.changeSet.state === "in_progress",
    );
    if (unfinished !== undefined) {
      return refuse(
        "purge_evidence_contradictory",
        `Change Set ${unfinished.changeSetId} is in_progress without an execution record; ` +
          "the persisted registry does not match what the runtime writes",
        inventory,
      );
    }
    if (registry.entries.some((entry) => entry.changeSet.state === "result_unproven")) {
      return refuse(
        "purge_recovery_untrusted",
        "A Change Set result is unproven; resolve the blocked recovery before purging",
        inventory,
      );
    }
    if (
      registry.writeMode === "maintenance_pending" ||
      registry.writeMode === "maintenance_failed"
    ) {
      return refuse(
        "purge_recovery_untrusted",
        `The Vault is in ${registry.writeMode}; finish the interrupted maintenance first`,
        inventory,
      );
    }
    if (registry.lifecycle?.upgrade === "failed" || registry.lifecycle?.migration === "failed") {
      return refuse(
        "purge_recovery_untrusted",
        "A failed upgrade/migration is recorded; finish the upgrade recovery before purging",
        inventory,
      );
    }
  }

  let journalRecord: RecoveryJournalRecord | null = null;
  try {
    journalRecord = await readRecoveryJournal(target.vaultPath);
  } catch (error) {
    return refuse(
      "purge_evidence_unavailable",
      `The Recovery Journal could not be read: ${detailOf(error)}`,
      inventory,
    );
  }
  if (
    journalRecord !== null &&
    journalRecord.phase !== "COMMITTED" &&
    journalRecord.phase !== "ROLLED_BACK"
  ) {
    return refuse(
      "purge_recovery_untrusted",
      `The Recovery Journal's latest frame is ${journalRecord.phase}; ` +
        "start the Bridge once so recovery settles before purging",
      inventory,
    );
  }

  let upgradeEvidence: ManagedVaultUpgradeEvidence | null = null;
  try {
    upgradeEvidence = await readUpgradeEvidence(pluginDirectory);
  } catch (error) {
    return refuse(
      "purge_evidence_contradictory",
      `Persisted upgrade evidence failed validation: ${detailOf(error)}`,
      inventory,
    );
  }
  if (upgradeEvidence !== null && upgradeEvidence.outcome !== "succeeded") {
    return refuse(
      "purge_recovery_untrusted",
      `Upgrade evidence records outcome ${upgradeEvidence.outcome}; ` +
        "the interrupted or failed upgrade must be resolved before purging",
      inventory,
    );
  }
  if (
    upgradeEvidence !== null &&
    persisted !== null &&
    upgradeEvidence.vaultId !== persisted.vaultId
  ) {
    return refuse(
      "purge_evidence_contradictory",
      "Upgrade evidence and persisted settings disagree about the Vault identity",
      inventory,
    );
  }

  let live: ObservedHealth | null = null;
  if (options.observeHealth !== undefined) {
    try {
      live = await options.observeHealth();
    } catch (error) {
      return refuse(
        "purge_evidence_unavailable",
        `Live health observation failed: ${detailOf(error)}`,
        inventory,
      );
    }
  }
  if (live !== null) {
    if (live.queue.currentExecutionId !== null) {
      return refuse(
        "purge_change_set_executing",
        `Change Set ${live.queue.currentExecutionId} is executing; drain it before purging`,
        inventory,
      );
    }
    if (live.queue.length > 0) {
      return refuse(
        "purge_work_queued",
        `The live Bridge reports ${live.queue.length} queued Change Set(s); drain the queue first`,
        inventory,
      );
    }
    if (live.recovery.state !== "none") {
      return refuse(
        "purge_recovery_untrusted",
        `The live Bridge reports recovery ${live.recovery.state}; resolve it before purging`,
        inventory,
      );
    }
    if (
      live.effectiveGate?.code === "recovery_in_progress" ||
      live.effectiveGate?.code === "recovery_blocked" ||
      live.effectiveGate?.code === "upgrade_in_progress"
    ) {
      return refuse(
        "purge_recovery_untrusted",
        `The live Bridge is gated ${live.effectiveGate.code}; resolve it before purging`,
        inventory,
      );
    }
    if (persisted === null) {
      return refuse(
        "purge_evidence_contradictory",
        "A Bridge answers health but no persisted Bridge settings exist; " +
          "the evidence cannot positively prove this Vault safe to purge",
        inventory,
      );
    }
    if (live.vault.id !== persisted.vaultId || live.listener.port !== persisted.port) {
      return refuse(
        "purge_evidence_contradictory",
        "The live Bridge identity does not match the persisted Vault identity",
        inventory,
      );
    }
  }

  // --- Backup phase: a verifiable copy OUTSIDE the state being removed,
  // written before confirmation, recording the inventory and the integrity
  // evidence (SHA-256 checksum manifest) of every byte slated for removal.

  const nonce = (options.nonce ?? randomUUID)();
  const backupDirectory = join(backupRoot, `purge-backup-${nonce}`);
  const inventoryBytes = new TextEncoder().encode(
    `${JSON.stringify(
      {
        schemaVersion: 1,
        purpose: "managed-vault-purge-backup",
        pluginId: inventory.pluginId,
        vaultPath: inventory.vaultPath,
        vaultId: inventory.vaultId,
        port: inventory.port,
        queue: inventory.queue,
        lostCapabilities: inventory.lostCapabilities.map((capability) => ({
          capability,
          detail: PURGE_LOST_CAPABILITY_DETAILS[capability],
        })),
        files: inventory.files,
      },
      null,
      2,
    )}\n`,
  );
  try {
    await mkdir(backupRoot, { recursive: true });
    await mkdir(backupDirectory);
    for (const file of inventory.files) {
      const destination = join(backupDirectory, file.backupPath);
      await mkdir(dirname(destination), { recursive: true });
      const source = join(target.vaultPath, ...file.sourcePath.split("/"));
      const bytes = await readFileBytesOrNull(source);
      if (bytes === null || sha256Hex(bytes) !== file.sha256) {
        throw new ReleasePurgeError(
          `Source state changed while the backup was being written: ${file.sourcePath}`,
          "purge_backup_failed",
        );
      }
      await writeFile(destination, bytes, { flag: "wx" });
    }
    await writeFile(join(backupDirectory, PURGE_BACKUP_INVENTORY_FILE), inventoryBytes, {
      flag: "wx",
    });
    const manifestLines = [
      ...inventory.files.map((file) => `${file.sha256}  ${file.backupPath}`),
      `${sha256Hex(inventoryBytes)}  ${PURGE_BACKUP_INVENTORY_FILE}`,
    ].sort();
    await writeFile(
      join(backupDirectory, PURGE_BACKUP_CHECKSUM_MANIFEST),
      `${manifestLines.join("\n")}\n`,
      { flag: "wx" },
    );
  } catch (error) {
    return result(
      "failed",
      {
        code:
          error instanceof InstallInterruptionError ? "purge_interrupted" : "purge_backup_failed",
        detail: `The backup could not be written: ${detailOf(error)}`,
      },
      inventory,
      null,
      [],
      [],
    );
  }

  try {
    await options.hooks?.afterBackupWritten?.({ vaultPath: target.vaultPath, backupDirectory });
  } catch (error) {
    return result(
      "failed",
      {
        code:
          error instanceof InstallInterruptionError ? "purge_interrupted" : "purge_backup_failed",
        detail: detailOf(error),
      },
      inventory,
      null,
      [],
      [],
    );
  }

  // Re-verify the backup against the source state before anything is
  // deleted: the manifest parses and covers exactly the backup files, every
  // copy hash-matches, the inventory is intact, and every source file still
  // matches the digest the backup recorded.
  const backup: ManagedVaultPurgeBackup = {
    directory: backupDirectory,
    inventoryPath: join(backupDirectory, PURGE_BACKUP_INVENTORY_FILE),
    checksumManifestPath: join(backupDirectory, PURGE_BACKUP_CHECKSUM_MANIFEST),
    files: inventory.files,
    verified: false,
  };
  try {
    const manifestBytes = await readFileBytesOrNull(backup.checksumManifestPath);
    const declared = manifestBytes === null ? null : parseBackupChecksumManifest(manifestBytes);
    if (declared === null) {
      throw new Error("The backup checksum manifest is missing or malformed");
    }
    const expectedPaths = [
      ...inventory.files.map((file) => file.backupPath),
      PURGE_BACKUP_INVENTORY_FILE,
    ].sort();
    const presentPaths = (await listBackupFiles(backupDirectory, ""))
      .filter((path) => path !== PURGE_BACKUP_CHECKSUM_MANIFEST)
      .sort();
    if (presentPaths.join("\n") !== expectedPaths.join("\n")) {
      throw new Error(
        `The backup contents do not match the declared inventory: ${presentPaths.join(", ")}`,
      );
    }
    for (const [path, digest] of declared) {
      const bytes = await readFileBytesOrNull(join(backupDirectory, path));
      if (bytes === null || sha256Hex(bytes) !== digest) {
        throw new Error(`Backup copy failed integrity verification: ${path}`);
      }
    }
    for (const file of inventory.files) {
      if (declared.get(file.backupPath) !== file.sha256) {
        throw new Error(`Backup copy digest disagrees with the inventory: ${file.sourcePath}`);
      }
      const source = await readFileBytesOrNull(join(target.vaultPath, ...file.sourcePath.split("/")));
      if (source === null || sha256Hex(source) !== file.sha256) {
        throw new Error(`Source state changed after the backup was written: ${file.sourcePath}`);
      }
    }
  } catch (error) {
    return result(
      "failed",
      {
        code:
          error instanceof InstallInterruptionError
            ? "purge_interrupted"
            : "purge_backup_verification_failed",
        detail: `The backup failed verification: ${detailOf(error)}`,
      },
      inventory,
      backup,
      [],
      [],
    );
  }
  const verifiedBackup: ManagedVaultPurgeBackup = { ...backup, verified: true };

  // --- Confirmation phase: an explicit local interactive affirmation tied to
  // this Managed Vault's identity/path. Without it nothing is deleted.

  if (options.confirm === undefined) {
    return refuse(
      "purge_confirmation_required",
      "Purge is a local interactive operation; no confirmation seam was supplied, " +
        "so no state was deleted. The verified backup is retained for a later confirmed run.",
      inventory,
      verifiedBackup,
    );
  }
  const confirmation: ManagedVaultPurgeConfirmation = {
    vaultPath: target.vaultPath,
    pluginId,
    vaultId,
    inventory,
    backup: verifiedBackup,
  };
  let affirmed: boolean;
  try {
    affirmed = await options.confirm(confirmation);
  } catch (error) {
    return refuse(
      "purge_confirmation_declined",
      `The confirmation interaction failed: ${detailOf(error)}; no state was deleted`,
      inventory,
      verifiedBackup,
    );
  }
  if (!affirmed) {
    return refuse(
      "purge_confirmation_declined",
      "The Primary Operator did not affirm the purge of this Managed Vault; no state was deleted",
      inventory,
      verifiedBackup,
    );
  }

  try {
    await options.hooks?.afterConfirmation?.({ vaultPath: target.vaultPath });
  } catch (error) {
    return result(
      "failed",
      {
        code:
          error instanceof InstallInterruptionError
            ? "purge_interrupted"
            : "purge_deletion_failed",
        detail: detailOf(error),
      },
      inventory,
      verifiedBackup,
      [],
      inventory.files.map((file) => file.sourcePath),
    );
  }

  // --- Deletion phase: only the enumerated operational state is removed.
  // Release-managed files, Vault content, and Claude Code local configuration
  // are never touched.

  const deletedFiles: string[] = [];
  try {
    for (const file of inventory.files) {
      await deleteStateFile(join(target.vaultPath, ...file.sourcePath.split("/")));
      deletedFiles.push(file.sourcePath);
    }
  } catch (error) {
    return result(
      "failed",
      {
        code:
          error instanceof InstallInterruptionError
            ? "purge_interrupted"
            : "purge_deletion_failed",
        detail: `State deletion failed: ${detailOf(error)}`,
      },
      inventory,
      verifiedBackup,
      deletedFiles,
      inventory.files
        .map((file) => file.sourcePath)
        .filter((path) => !deletedFiles.includes(path)),
    );
  }

  try {
    await options.hooks?.afterDeletion?.({ vaultPath: target.vaultPath });
  } catch (error) {
    return result(
      "failed",
      {
        code:
          error instanceof InstallInterruptionError
            ? "purge_interrupted"
            : "purge_deletion_failed",
        detail: `${detailOf(error)} (after deletion)`,
      },
      inventory,
      verifiedBackup,
      deletedFiles,
      [],
    );
  }

  // Post-deletion verification: re-inspect the target. Any surviving
  // enumerated state fails the purge with the precise remainder; deletion is
  // idempotent, so a confirmed rerun simply completes it.
  const survivors: string[] = [];
  try {
    if ((await readFileBytesOrNull(settingsPath)) !== null) {
      survivors.push(`${configDirectoryName}/plugins/${pluginId}/data.json`);
    }
    let remainingJournals: string[];
    try {
      remainingJournals = (await readdir(stateDirectory)).filter((entry) =>
        RECOVERY_JOURNAL_FILE_NAME.test(entry),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        remainingJournals = [];
      } else {
        throw error;
      }
    }
    for (const name of remainingJournals.sort()) {
      survivors.push(`${BRIDGE_STATE_DIRECTORY_NAME}/${name}`);
    }
  } catch (error) {
    return result(
      "failed",
      {
        code: "purge_deletion_failed",
        detail: `Post-deletion verification could not re-inspect the target: ${detailOf(error)}`,
      },
      inventory,
      verifiedBackup,
      deletedFiles,
      [],
    );
  }
  if (survivors.length > 0) {
    return result(
      "failed",
      {
        code: "purge_deletion_failed",
        detail: `Enumerated operational state survived the purge: ${survivors.join(", ")}`,
      },
      inventory,
      verifiedBackup,
      deletedFiles,
      survivors,
    );
  }

  return result("purged", null, inventory, verifiedBackup, deletedFiles, []);
}
