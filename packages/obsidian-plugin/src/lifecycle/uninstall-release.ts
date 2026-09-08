import { open, readdir, readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

import {
  BRIDGE_STATE_DIRECTORY_NAME,
  parseChangeSetRegistryState,
  type ChangeSetRegistryState,
} from "../change-set.js";
import type { ObservedHealth } from "../installed-runtime/loopback-client.js";
import {
  InstallInterruptionError,
  removeReleaseManagedFiles,
  type ManagedVaultInstallTarget,
  type ReleaseRemovalResult,
} from "./install-release.js";
import {
  isReleaseManagedFile,
  managedVaultPluginDirectory,
} from "./release-managed-files.js";
import {
  readManagedVaultUpgradeEvidence,
  ReleaseUpgradeError,
  type ManagedVaultUpgradeEvidence,
} from "./upgrade-release.js";
import { RELEASE_PLUGIN_ID } from "../release/release-identity.js";
import { createRegistrationRemovalCommand } from "../registration-command.js";
import {
  openRecoveryJournal,
  type RecoveryJournalRecord,
} from "../recovery-journal.js";

/**
 * Managed Vault uninstall orchestration (issue #200, spec §9.3): removes the
 * Vault Operation Bridge Release from one Managed Vault by deleting only
 * release-managed files while retaining every byte of operational state for a
 * lossless same-version reinstall.
 *
 * This module composes the established seams and adds no second
 * file-ownership or maintenance implementation: the release-managed allowlist
 * and `removeReleaseManagedFiles` from the lifecycle installer (issue #198)
 * decide exactly which files may be deleted (`manifest.json`, `main.js`,
 * optional `styles.css`, `checksums.sha256` — never `data.json`, Recovery
 * Journals, other plugins' storage, or Vault content), and the persisted
 * upgrade evidence reader from the upgrade orchestration (issue #199) is the
 * single authority over `upgrade-state.json`.
 *
 * Fail-closed safety gate: uninstall refuses with a machine-actionable
 * failure code whenever
 *
 * - a Change Set is executing (live `queue.currentExecutionId` or a persisted
 *   registry entry in the `executing` phase),
 * - work is queued (a non-empty FIFO, live or persisted),
 * - recovery is in progress, unresolved, or blocked (live recovery state, a
 *   pending/failed Recovery Journal frame, a `result_unproven` Change Set
 *   record, a maintenance write mode or failed lifecycle in the persisted
 *   registry, or interrupted/failed upgrade evidence), or
 * - live and persisted evidence cannot positively prove the target safe for
 *   removal — unavailable or contradictory evidence is a refusal, never a
 *   pass.
 *
 * A Vault whose plugin never loaded (no `data.json`, no Recovery Journal, no
 * upgrade evidence, no answering Bridge) is provably free of queued work and
 * recovery state — the plugin's own load creates all three — so its managed
 * files may be removed. Claude Code configuration is never read or modified:
 * the result prints, but never executes, the `claude mcp remove` counterpart
 * of `createRegistrationCommand`. No purge, force-removal, recovery-bypass,
 * or state-deletion path exists here.
 *
 * Reruns are deterministic: a completed uninstall reports
 * `already_uninstalled`, a refused uninstall changes nothing and refuses
 * again identically, and a failed/interrupted removal is completed by the
 * next run because removal itself is idempotent.
 */

export type ReleaseUninstallFailureCode =
  | "uninstall_change_set_executing"
  | "uninstall_work_queued"
  | "uninstall_recovery_untrusted"
  | "uninstall_evidence_unavailable"
  | "uninstall_evidence_contradictory"
  | "uninstall_removal_failed"
  | "uninstall_interrupted";

export class ReleaseUninstallError extends Error {
  constructor(
    message: string,
    readonly code: ReleaseUninstallFailureCode | "uninstall_path_unsafe",
  ) {
    super(message);
    this.name = "ReleaseUninstallError";
  }
}

/** Failure-injection seam mirroring the installer's hooks (interruption tests). */
export interface UninstallFailureInjectionHooks {
  /** Runs after every safety check passed, before the first file is removed. */
  readonly beforeRemoval?: (context: { vaultPath: string }) => void | Promise<void>;
  /** Runs after removal, before the post-removal verification. */
  readonly afterRemoval?: (context: { vaultPath: string }) => void | Promise<void>;
}

export interface ManagedVaultUninstallOptions {
  /** Per-Vault boundary: Vault path and configuration directory name. */
  readonly target: ManagedVaultInstallTarget;
  /** Defaults to the pinned release plugin id. */
  readonly pluginId?: string;
  /**
   * Live health observation seam (e.g. the loopback `vault_health` client).
   * Resolves with the observed health when a Bridge answers, or null when the
   * Vault is offline (the drained-uninstall case). A rejection means the
   * observation itself failed — unavailable evidence, which refuses.
   */
  readonly observeHealth?: () => Promise<ObservedHealth | null>;
  /**
   * Persisted settings reader; defaults to the authoritative bridge
   * recovery-state copy (`.llm-wiki/bridge-state.json`) when present, falling
   * back to the plugin directory's `data.json`. Resolves undefined when no
   * state file exists.
   */
  readonly readPersistedState?: (
    pluginDirectory: string,
    vaultPath: string,
  ) => Promise<unknown>;
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
  /** Managed-file removal seam; defaults to the installer's `removeReleaseManagedFiles`. */
  readonly removeManagedFiles?: (
    target: ManagedVaultInstallTarget,
    pluginId: string,
  ) => Promise<ReleaseRemovalResult>;
  /** Failure-injection hooks for interruption and filesystem-fault tests. */
  readonly hooks?: UninstallFailureInjectionHooks;
}

export type ReleaseUninstallOutcome =
  | "uninstalled"
  | "already_uninstalled"
  | "refused"
  | "failed";

/** Printed-but-never-executed operator step after a successful uninstall. */
export const MCP_REGISTRATION_REMOVAL_REQUIRED = "mcp_registration_removal_required" as const;

export interface ManagedVaultUninstallResult {
  readonly outcome: ReleaseUninstallOutcome;
  readonly pluginId: string;
  readonly vaultPath: string;
  /** The retained Vault identity, when one was persisted. */
  readonly vaultId: string | null;
  readonly failure: {
    readonly code: ReleaseUninstallFailureCode;
    readonly detail: string;
  } | null;
  /** The installer's removal report; null unless removal ran. */
  readonly removal: ReleaseRemovalResult | null;
  /**
   * The exact operator command removing this Managed Vault's MCP
   * registration — printed, never executed. Present on `uninstalled` and
   * `already_uninstalled` when a Bridge identity was persisted.
   */
  readonly registrationRemovalCommand: string | null;
  readonly requiredNextSteps: readonly (typeof MCP_REGISTRATION_REMOVAL_REQUIRED)[];
}

function detailOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function readFileBytesOrNull(path: string): Promise<Uint8Array | null> {
  try {
    return new Uint8Array(await readFile(path));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

interface PersistedUninstallEvidence {
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
 * Reads and validates the persisted settings facts uninstall needs. A
 * malformed file or an out-of-shape record throws — corrupted fail-closed
 * evidence is a defect, never a clean slate.
 */
async function readPersistedUninstallEvidence(
  pluginDirectory: string,
  vaultPath: string,
  read: (pluginDirectory: string, vaultPath: string) => Promise<unknown>,
): Promise<PersistedUninstallEvidence | null> {
  const raw = await read(pluginDirectory, vaultPath);
  if (raw === undefined) return null;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new ReleaseUninstallError(
      "Persisted Bridge settings are not an object",
      "uninstall_evidence_contradictory",
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
    throw new ReleaseUninstallError(
      "Persisted Bridge settings do not carry a valid Vault identity",
      "uninstall_evidence_contradictory",
    );
  }
  let registry: ChangeSetRegistryState | null = null;
  if (changeSets !== undefined) {
    try {
      registry = parseChangeSetRegistryState(changeSets);
    } catch (error) {
      throw new ReleaseUninstallError(
        `Persisted Change Set registry failed validation: ${detailOf(error)}`,
        "uninstall_evidence_contradictory",
      );
    }
  }
  return { vaultId, port, registry };
}

async function defaultReadPersistedState(
  pluginDirectory: string,
  vaultPath: string,
): Promise<unknown> {
  // The running plugin persists its settings to `.llm-wiki/bridge-state.json`
  // before `data.json` and loads that recovery-state copy in preference to the
  // plugin directory's `data.json` (main.ts). The safety gate must read the
  // same authoritative copy — otherwise a crash between the two writes would
  // let the gate pass on a stale `data.json` while the authoritative state
  // still carries executing or queued work.
  const authoritativePath = join(
    vaultPath,
    BRIDGE_STATE_DIRECTORY_NAME,
    "bridge-state.json",
  );
  let bytes = await readFileBytesOrNull(authoritativePath);
  const statePath = bytes === null ? join(pluginDirectory, "data.json") : authoritativePath;
  if (bytes === null) {
    bytes = await readFileBytesOrNull(join(pluginDirectory, "data.json"));
  }
  if (bytes === null) return undefined;
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new ReleaseUninstallError(
      `Persisted Bridge settings are not valid UTF-8: ${statePath}`,
      "uninstall_evidence_contradictory",
    );
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new ReleaseUninstallError(
      `Persisted Bridge settings are not valid JSON: ${statePath}`,
      "uninstall_evidence_contradictory",
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

/**
 * Uninstalls the Vault Operation Bridge Release from one Managed Vault.
 * Safety refusals and operational failures return typed results; only
 * contract violations (an unsafe Vault/configuration path) throw.
 */
export async function uninstallManagedVaultRelease(
  options: ManagedVaultUninstallOptions,
): Promise<ManagedVaultUninstallResult> {
  const { target } = options;
  const pluginId = options.pluginId ?? RELEASE_PLUGIN_ID;
  const configDirectoryName = target.configDirectoryName ?? ".obsidian";
  if (!isAbsolute(target.vaultPath)) {
    throw new ReleaseUninstallError(
      `Unsafe Vault or configuration path: ${target.vaultPath} / ${configDirectoryName}`,
      "uninstall_path_unsafe",
    );
  }
  const pluginDirectory = managedVaultPluginDirectory(
    target.vaultPath,
    configDirectoryName,
    pluginId,
  );
  const readPersistedState = options.readPersistedState ?? defaultReadPersistedState;
  const readRecoveryJournal = options.readRecoveryJournal ?? defaultReadRecoveryJournal;
  const readUpgradeEvidence = options.readUpgradeEvidence ?? readManagedVaultUpgradeEvidence;
  const removeManagedFiles = options.removeManagedFiles ?? removeReleaseManagedFiles;

  let vaultId: string | null = null;
  const result = (
    outcome: ReleaseUninstallOutcome,
    failure: ManagedVaultUninstallResult["failure"],
    removal: ReleaseRemovalResult | null,
  ): ManagedVaultUninstallResult => {
    let registrationRemovalCommand: string | null = null;
    if ((outcome === "uninstalled" || outcome === "already_uninstalled") && vaultId !== null) {
      try {
        registrationRemovalCommand = createRegistrationRemovalCommand(vaultId);
      } catch {
        // A persisted Vault identity that survives the safety gate but cannot
        // name a Claude Code MCP server has no registration to remove; the
        // typed outcome must still be returned rather than throwing after the
        // removal already ran.
        registrationRemovalCommand = null;
      }
    }
    return {
      outcome,
      pluginId,
      vaultPath: target.vaultPath,
      vaultId,
      failure,
      removal,
      registrationRemovalCommand,
      requiredNextSteps:
        registrationRemovalCommand === null ? [] : [MCP_REGISTRATION_REMOVAL_REQUIRED],
    };
  };
  const refuse = (code: ReleaseUninstallFailureCode, detail: string): ManagedVaultUninstallResult =>
    result("refused", { code, detail }, null);

  // Which release-managed files, if any, are still deployed. A Vault with no
  // managed files left needs no safety proof: nothing would be removed, and
  // the retained state is exactly what a lossless reinstall continues from.
  let entries: string[];
  try {
    entries = await readdir(pluginDirectory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      entries = [];
    } else {
      return refuse(
        "uninstall_evidence_unavailable",
        `The plugin directory could not be inspected: ${detailOf(error)}`,
      );
    }
  }
  if (!entries.some(isReleaseManagedFile)) {
    // Best-effort identity for the printed registration-removal command; the
    // retained state itself is never inspected for safety here because no
    // removal is needed.
    try {
      vaultId = (
        await readPersistedUninstallEvidence(pluginDirectory, target.vaultPath, readPersistedState)
      )?.vaultId ?? null;
    } catch {
      vaultId = null;
    }
    return result("already_uninstalled", null, null);
  }

  // --- Safety evidence: persisted state, Recovery Journal, upgrade evidence,
  // and (when a Bridge answers) the live observation must all agree that no
  // work is executing or queued and no recovery is unresolved.

  let persisted: PersistedUninstallEvidence | null = null;
  try {
    persisted = await readPersistedUninstallEvidence(
      pluginDirectory,
      target.vaultPath,
      readPersistedState,
    );
  } catch (error) {
    if (error instanceof ReleaseUninstallError) {
      return refuse("uninstall_evidence_contradictory", error.message);
    }
    return refuse(
      "uninstall_evidence_unavailable",
      `Persisted Bridge settings could not be read: ${detailOf(error)}`,
    );
  }
  vaultId = persisted?.vaultId ?? null;

  if (persisted?.registry !== null && persisted?.registry !== undefined) {
    const registry = persisted.registry;
    const pending = pendingEntries(registry);
    const executing = pending.find((entry) => entry.execution?.phase === "executing");
    if (executing !== undefined) {
      return refuse(
        "uninstall_change_set_executing",
        `Change Set ${executing.changeSetId} is executing; drain or finish it before uninstalling`,
      );
    }
    if (pending.length > 0) {
      return refuse(
        "uninstall_work_queued",
        `${pending.length} Change Set(s) remain in the FIFO queue ` +
          `(head: ${pending[0]?.changeSetId ?? "unknown"}); drain the queue before uninstalling`,
      );
    }
    const unfinished = registry.entries.find(
      (entry) => entry.execution === undefined && entry.changeSet.state === "in_progress",
    );
    if (unfinished !== undefined) {
      return refuse(
        "uninstall_evidence_contradictory",
        `Change Set ${unfinished.changeSetId} is in_progress without an execution record; ` +
          "the persisted registry does not match what the runtime writes",
      );
    }
    if (registry.entries.some((entry) => entry.changeSet.state === "result_unproven")) {
      return refuse(
        "uninstall_recovery_untrusted",
        "A Change Set result is unproven; resolve the blocked recovery before uninstalling",
      );
    }
    if (
      registry.writeMode === "maintenance_pending" ||
      registry.writeMode === "maintenance_failed"
    ) {
      return refuse(
        "uninstall_recovery_untrusted",
        `The Vault is in ${registry.writeMode}; finish the interrupted maintenance first`,
      );
    }
    if (registry.lifecycle?.upgrade === "failed" || registry.lifecycle?.migration === "failed") {
      return refuse(
        "uninstall_recovery_untrusted",
        "A failed upgrade/migration is recorded; finish the upgrade recovery before uninstalling",
      );
    }
  }

  let journalRecord: RecoveryJournalRecord | null = null;
  try {
    journalRecord = await readRecoveryJournal(target.vaultPath);
  } catch (error) {
    return refuse(
      "uninstall_evidence_unavailable",
      `The Recovery Journal could not be read: ${detailOf(error)}`,
    );
  }
  if (journalRecord !== null && journalRecord.phase !== "COMMITTED" && journalRecord.phase !== "ROLLED_BACK") {
    return refuse(
      "uninstall_recovery_untrusted",
      `The Recovery Journal's latest frame is ${journalRecord.phase}; ` +
        "start the Bridge once so recovery settles before uninstalling",
    );
  }

  let upgradeEvidence: ManagedVaultUpgradeEvidence | null = null;
  try {
    upgradeEvidence = await readUpgradeEvidence(pluginDirectory);
  } catch (error) {
    if (error instanceof ReleaseUpgradeError) {
      return refuse(
        "uninstall_evidence_contradictory",
        `Persisted upgrade evidence failed validation: ${detailOf(error)}`,
      );
    }
    return refuse(
      "uninstall_evidence_unavailable",
      `Persisted upgrade evidence could not be read: ${detailOf(error)}`,
    );
  }
  if (upgradeEvidence !== null && upgradeEvidence.outcome !== "succeeded") {
    return refuse(
      "uninstall_recovery_untrusted",
      `Upgrade evidence records outcome ${upgradeEvidence.outcome}; ` +
        "the interrupted or failed upgrade must be resolved before uninstalling",
    );
  }
  if (
    upgradeEvidence !== null &&
    persisted !== null &&
    upgradeEvidence.vaultId !== persisted.vaultId
  ) {
    return refuse(
      "uninstall_evidence_contradictory",
      "Upgrade evidence and persisted settings disagree about the Vault identity",
    );
  }

  let live: ObservedHealth | null = null;
  if (options.observeHealth !== undefined) {
    try {
      live = await options.observeHealth();
    } catch (error) {
      return refuse(
        "uninstall_evidence_unavailable",
        `Live health observation failed: ${detailOf(error)}`,
      );
    }
  }
  if (live !== null) {
    if (live.queue.currentExecutionId !== null) {
      return refuse(
        "uninstall_change_set_executing",
        `Change Set ${live.queue.currentExecutionId} is executing; drain it before uninstalling`,
      );
    }
    if (live.queue.length > 0) {
      return refuse(
        "uninstall_work_queued",
        `The live Bridge reports ${live.queue.length} queued Change Set(s); drain the queue first`,
      );
    }
    if (live.recovery.state !== "none") {
      return refuse(
        "uninstall_recovery_untrusted",
        `The live Bridge reports recovery ${live.recovery.state}; resolve it before uninstalling`,
      );
    }
    if (
      live.effectiveGate?.code === "recovery_in_progress" ||
      live.effectiveGate?.code === "recovery_blocked" ||
      live.effectiveGate?.code === "upgrade_in_progress"
    ) {
      return refuse(
        "uninstall_recovery_untrusted",
        `The live Bridge is gated ${live.effectiveGate.code}; resolve it before uninstalling`,
      );
    }
    if (persisted === null) {
      return refuse(
        "uninstall_evidence_contradictory",
        "A Bridge answers health but no persisted Bridge settings exist; " +
          "the evidence cannot positively prove this Vault safe for removal",
      );
    }
    if (live.vault.id !== persisted.vaultId || live.listener.port !== persisted.port) {
      return refuse(
        "uninstall_evidence_contradictory",
        "The live Bridge identity does not match the persisted Vault identity",
      );
    }
  }

  // Every refusal above returns; reaching here means the evidence positively
  // proved the target safe. Removal is delegated to the installer's
  // allowlisted primitive — partial filesystem failures surface as a failed
  // uninstall, never as success.
  try {
    await options.hooks?.beforeRemoval?.({ vaultPath: target.vaultPath });
  } catch (error) {
    return result(
      "failed",
      {
        code:
          error instanceof InstallInterruptionError
            ? "uninstall_interrupted"
            : "uninstall_removal_failed",
        detail: detailOf(error),
      },
      null,
    );
  }

  let removal: ReleaseRemovalResult;
  try {
    removal = await removeManagedFiles(target, pluginId);
  } catch (error) {
    return result(
      "failed",
      {
        code:
          error instanceof InstallInterruptionError
            ? "uninstall_interrupted"
            : "uninstall_removal_failed",
        detail: detailOf(error),
      },
      null,
    );
  }

  try {
    await options.hooks?.afterRemoval?.({ vaultPath: target.vaultPath });
  } catch (error) {
    return result(
      "failed",
      {
        code:
          error instanceof InstallInterruptionError
            ? "uninstall_interrupted"
            : "uninstall_removal_failed",
        detail: `${detailOf(error)} (after removal)`,
      },
      removal,
    );
  }

  // Post-removal verification: no allowlisted file may survive. Removal is
  // idempotent, so a rerun after this failure simply completes it.
  let remaining: string[];
  try {
    remaining = await readdir(pluginDirectory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      remaining = [];
    } else {
      return result(
        "failed",
        {
          code: "uninstall_removal_failed",
          detail: `Post-removal verification could not inspect the plugin directory: ${detailOf(error)}`,
        },
        removal,
      );
    }
  }
  const survivors = remaining.filter(isReleaseManagedFile);
  if (survivors.length > 0) {
    return result(
      "failed",
      {
        code: "uninstall_removal_failed",
        detail: `Release-managed files survived removal: ${survivors.sort().join(", ")}`,
      },
      removal,
    );
  }

  return result("uninstalled", null, removal);
}
