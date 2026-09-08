import { randomUUID } from "node:crypto";
import {
  cp,
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  statfs,
  writeFile,
} from "node:fs/promises";
import { isAbsolute, join, sep } from "node:path";

import {
  isVerifiedCandidateBundle,
  sha256Hex,
} from "../installed-runtime/candidate-bundle.js";
import {
  compareSemanticVersions,
  ReleaseBundleError,
} from "../release/release-identity.js";
import type { VerifiedReleaseBundle } from "../release/verify-release-bundle.js";
import { SUPPORTED_OBSIDIAN_VERSION } from "../version.js";
import {
  expectedInstalledFiles,
  inspectInstalledManagedSet,
  isReleaseManagedFile,
  managedVaultPluginDirectory,
  RELEASE_MANAGED_CHECKSUM_FILE,
  type ExpectedManagedFile,
} from "./release-managed-files.js";

/**
 * Lifecycle installer (issue #198, spec §9.1): installs an explicitly
 * verified Release into one or more Managed Vaults, reinstalls the same
 * version as verify-or-repair, and removes release-managed files — all driven
 * by the strict release-managed allowlist in `release-managed-files.ts`.
 *
 * Guarantees:
 *
 * - Only the release verifier's branded `VerifiedReleaseBundle` is accepted;
 *   the brand symbol is module-private to the release/installed-runtime
 *   seam, so there is no verification bypass.
 * - Preflight covers every requested target — Vault/config destination,
 *   supported Obsidian runtime, path safety, and required capacity — before
 *   any target is modified. A batch whose preflight fails changes no target.
 * - Replacement is atomic per Managed Vault through a staged directory swap:
 *   the complete verified staging directory (new managed files plus carried
 *   operational state) is verified before the swap, so at every on-disk
 *   point the Vault holds either its complete previous bundle or its
 *   complete verified replacement. No cross-Vault atomicity is claimed.
 * - First installation deploys files only: it never enables the plugin,
 *   never creates a Vault ID or port, never initializes queue or Recovery
 *   Journal state, and never reads or modifies Claude Code configuration.
 * - Same-version reinstall reports `unchanged` when every managed file
 *   verifies and otherwise repairs only damaged release-managed files,
 *   preserving all per-Vault operational state byte-for-byte.
 * - An interrupted swap leaves deterministic leftovers that the next install
 *   (or `recoverInterruptedInstall`) reconciles back to the old-or-new
 *   boundary.
 */

export type ReleaseInstallFailureCode =
  | "install_unverified_bundle"
  | "preflight_batch_failed"
  | "preflight_vault_missing"
  | "preflight_path_unsafe"
  | "preflight_runtime_incompatible"
  | "preflight_capacity_insufficient"
  | "preflight_destination_invalid"
  | "install_bundle_drift"
  | "install_staging_failed"
  | "install_swap_failed"
  | "install_verify_failed"
  | "install_rollback_failed"
  | "install_cleanup_failed"
  | "install_recovery_failed";

export class ReleaseInstallError extends Error {
  constructor(
    message: string,
    readonly code: ReleaseInstallFailureCode,
  ) {
    super(message);
    this.name = "ReleaseInstallError";
  }
}

/**
 * Failure-injection seam signal: when an install hook throws this error, the
 * installer propagates it without rollback, leaving exactly the on-disk state
 * a process kill would leave. Any other hook error triggers full rollback.
 */
export class InstallInterruptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InstallInterruptionError";
  }
}

export interface ManagedVaultInstallTarget {
  readonly name?: string;
  readonly vaultPath: string;
  /** Obsidian configuration directory name; defaults to `.obsidian`. */
  readonly configDirectoryName?: string;
  /**
   * Obsidian runtime version hosting this Vault. The bundle's
   * `minAppVersion` must not exceed it; defaults to the supported runtime
   * floor when omitted.
   */
  readonly obsidianVersion?: string;
}

export interface InstallFailureInjectionHooks {
  /** Runs after the staging directory is fully written and hash-verified. */
  readonly afterStagingVerified?: (context: { vaultPath: string }) => void | Promise<void>;
  /** Runs between the backup rename and the staging rename — the only swap window. */
  readonly duringSwap?: (context: { vaultPath: string }) => void | Promise<void>;
}

export interface InstallReleaseOptions {
  /** Capacity seam; defaults to `statfs` available bytes. */
  readonly availableSpaceBytes?: (path: string) => Promise<number>;
  /** Failure-injection hooks for interruption and filesystem-fault tests. */
  readonly hooks?: InstallFailureInjectionHooks;
  /** Staging-directory uniqueness seam for deterministic tests. */
  readonly nonce?: () => string;
}

export type InstallTargetOutcome = "success" | "unchanged" | "failed";
export type InstallTargetAction = "installed" | "replaced" | "repaired" | "unchanged" | "none";

/** First-install deployment marker: files only, never enablement or registration. */
export const ARTIFACTS_INSTALLED = "artifacts_installed" as const;
export const PLUGIN_ENABLEMENT_REQUIRED = "plugin_enablement_required" as const;
export const MCP_REGISTRATION_REQUIRED = "mcp_registration_required" as const;

export interface ReleaseInstallTargetResult {
  readonly vaultPath: string;
  readonly outcome: InstallTargetOutcome;
  readonly action: InstallTargetAction;
  /** Managed files restored from the bundle during a repair (empty otherwise). */
  readonly repairedFiles: readonly string[];
  /** Stale allowlisted files removed because the bundle no longer carries them. */
  readonly removedStaleFiles: readonly string[];
  readonly failure: { readonly code: ReleaseInstallFailureCode; readonly detail: string } | null;
  /**
   * Present only after a successful first install: files are deployed and the
   * remaining steps belong to the Primary Operator, not the installer.
   */
  readonly deployment: {
    readonly state: typeof ARTIFACTS_INSTALLED;
    readonly requiredNextSteps: readonly [
      typeof PLUGIN_ENABLEMENT_REQUIRED,
      typeof MCP_REGISTRATION_REQUIRED,
    ];
  } | null;
}

export interface ReleaseInstallBatchResult {
  readonly pluginId: string;
  readonly bundleTag: string;
  readonly preflightPassed: boolean;
  readonly targets: readonly ReleaseInstallTargetResult[];
}

interface ResolvedTarget {
  readonly target: ManagedVaultInstallTarget;
  readonly vaultPath: string;
  readonly configDirectoryName: string;
  readonly pluginsRoot: string;
  readonly pluginDirectory: string;
  readonly obsidianVersion: string;
}

// A plain directory name — no separators, never "." or ".." (leading dots
// are normal: `.obsidian`).
const CONFIG_DIRECTORY_NAME = /^[A-Za-z0-9._-]+$/u;

function isSafeConfigDirectoryName(name: string): boolean {
  return CONFIG_DIRECTORY_NAME.test(name) && name !== "." && name !== "..";
}
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/u;

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function defaultAvailableSpaceBytes(path: string): Promise<number> {
  const stats = await statfs(path);
  return Number(stats.bavail) * Number(stats.bsize);
}

async function directoryByteSize(directory: string): Promise<number> {
  let total = 0;
  const walk = async (current: string): Promise<void> => {
    const children = await readdir(current, { withFileTypes: true });
    for (const child of children) {
      const absolute = join(current, child.name);
      if (child.isDirectory()) {
        await walk(absolute);
      } else if (child.isFile()) {
        total += (await lstat(absolute)).size;
      }
    }
  };
  await walk(directory);
  return total;
}

function failedTarget(
  vaultPath: string,
  code: ReleaseInstallFailureCode,
  detail: string,
): ReleaseInstallTargetResult {
  return {
    vaultPath,
    outcome: "failed",
    action: "none",
    repairedFiles: [],
    removedStaleFiles: [],
    failure: { code, detail },
    deployment: null,
  };
}

/**
 * Reconciles interrupted-swap leftovers back to the old-or-new boundary.
 * Staging directories are always complete-and-verified before the swap
 * starts, so the reconciliation is deterministic:
 *
 * - backup present, plugin directory absent (crash between the two swap
 *   renames) → the previous bundle is restored by renaming the backup back;
 * - backup present, plugin directory present (crash after the swap or during
 *   rollback cleanup) → the plugin directory already holds a complete set,
 *   the backup is discarded;
 * - staging/failed leftovers → discarded; they were never live.
 */
export async function recoverInterruptedInstall(
  pluginsRoot: string,
  pluginId: string,
): Promise<{ restoredPreviousBundle: boolean; discardedPaths: readonly string[] }> {
  let entries: string[];
  try {
    entries = await readdir(pluginsRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { restoredPreviousBundle: false, discardedPaths: [] };
    }
    throw error;
  }
  const prefix = `.${pluginId}.`;
  const backups = entries.filter((entry) => entry.startsWith(`${prefix}backup-`)).sort();
  const discarded: string[] = [];
  let restored = false;
  const pluginDirectory = join(pluginsRoot, pluginId);
  for (const backup of backups) {
    const backupPath = join(pluginsRoot, backup);
    if (!(await pathExists(pluginDirectory))) {
      await rename(backupPath, pluginDirectory);
      restored = true;
    } else {
      await rm(backupPath, { recursive: true, force: true });
      discarded.push(backup);
    }
  }
  for (const entry of entries) {
    if (entry.startsWith(`${prefix}staging-`) || entry.startsWith(`${prefix}failed-`)) {
      await rm(join(pluginsRoot, entry), { recursive: true, force: true });
      discarded.push(entry);
    }
  }
  return { restoredPreviousBundle: restored, discardedPaths: discarded };
}

async function preflightTarget(
  target: ManagedVaultInstallTarget,
  bundle: VerifiedReleaseBundle,
  availableSpaceBytes: (path: string) => Promise<number>,
): Promise<ResolvedTarget> {
  const vaultPath = target.vaultPath;
  const configDirectoryName = target.configDirectoryName ?? ".obsidian";
  if (!isAbsolute(vaultPath) || !isSafeConfigDirectoryName(configDirectoryName)) {
    throw new ReleaseInstallError(
      `Unsafe Vault or configuration path: ${vaultPath} / ${configDirectoryName}`,
      "preflight_path_unsafe",
    );
  }
  const vaultStats = await lstat(vaultPath).catch(() => null);
  if (vaultStats === null || !vaultStats.isDirectory() || vaultStats.isSymbolicLink()) {
    throw new ReleaseInstallError(
      `Managed Vault is missing or not a real directory: ${vaultPath}`,
      "preflight_vault_missing",
    );
  }
  // Containment: the resolved plugin destination must stay inside the Vault.
  const realVault = await realpath(vaultPath);
  const pluginDirectory = managedVaultPluginDirectory(
    realVault,
    configDirectoryName,
    bundle.identity.pluginId,
  );
  if (!pluginDirectory.startsWith(`${realVault}${sep}`)) {
    throw new ReleaseInstallError(
      "Plugin destination escapes the Managed Vault",
      "preflight_path_unsafe",
    );
  }
  const destinationStats = await lstat(pluginDirectory).catch(() => null);
  if (
    destinationStats !== null &&
    (!destinationStats.isDirectory() || destinationStats.isSymbolicLink())
  ) {
    throw new ReleaseInstallError(
      "Plugin destination exists and is not a real directory",
      "preflight_destination_invalid",
    );
  }
  const obsidianVersion = target.obsidianVersion ?? SUPPORTED_OBSIDIAN_VERSION;
  if (
    !SEMVER.test(obsidianVersion) ||
    compareSemanticVersions(bundle.identity.minAppVersion, obsidianVersion) > 0
  ) {
    throw new ReleaseInstallError(
      `Bundle requires Obsidian ${bundle.identity.minAppVersion}, above this Vault's runtime ${obsidianVersion}`,
      "preflight_runtime_incompatible",
    );
  }
  // Capacity: staging carries the full managed set plus a byte copy of the
  // preserved operational state; the swap itself is renames only.
  const managedBytes =
    bundle.identity.files.reduce((total, file) => total + file.sizeBytes, 0) +
    bundle.identity.files.length; // checksum manifest line slack
  let preservedBytes = 0;
  if (destinationStats !== null) {
    preservedBytes = await directoryByteSize(pluginDirectory);
    for (const entry of await readdir(pluginDirectory)) {
      if (isReleaseManagedFile(entry)) {
        const stats = await lstat(join(pluginDirectory, entry));
        if (stats.isFile()) preservedBytes -= stats.size;
      }
    }
  }
  const available = await availableSpaceBytes(realVault);
  if (available < managedBytes + preservedBytes) {
    throw new ReleaseInstallError(
      `Insufficient capacity: need ${managedBytes + preservedBytes} bytes, have ${available}`,
      "preflight_capacity_insufficient",
    );
  }
  return {
    target,
    vaultPath: realVault,
    configDirectoryName,
    pluginsRoot: join(realVault, configDirectoryName, "plugins"),
    pluginDirectory,
    obsidianVersion,
  };
}

interface StagedContent {
  readonly expectedFiles: readonly ExpectedManagedFile[];
  readonly bundleBytes: ReadonlyMap<string, Uint8Array>;
  readonly checksumBytes: Uint8Array;
}

/** Reads the bundle once per target, re-hashing every byte against the verified identity. */
async function readBundleBytes(
  bundle: VerifiedReleaseBundle,
): Promise<StagedContent> {
  const bundleBytes = new Map<string, Uint8Array>();
  for (const file of bundle.identity.files) {
    const bytes = new Uint8Array(await readFile(join(bundle.bundleDirectory, file.path)));
    if (sha256Hex(bytes) !== file.sha256) {
      throw new ReleaseInstallError(
        `Bundle file changed after verification: ${file.path}`,
        "install_bundle_drift",
      );
    }
    bundleBytes.set(file.path, bytes);
  }
  const checksumBytes = new Uint8Array(
    await readFile(join(bundle.bundleDirectory, RELEASE_MANAGED_CHECKSUM_FILE)),
  );
  return {
    expectedFiles: expectedInstalledFiles(bundle.identity, sha256Hex(checksumBytes)),
    bundleBytes,
    checksumBytes,
  };
}

interface SwapContext {
  readonly resolved: ResolvedTarget;
  readonly stagingDirectory: string;
  readonly backupDirectory: string;
  readonly failedDirectory: string;
  readonly hadExisting: boolean;
  readonly hooks?: InstallFailureInjectionHooks;
}

/**
 * The per-Vault atomic swap. Staging is complete and verified before this
 * runs; the only multi-step window is backup-rename → staging-rename, and
 * `recoverInterruptedInstall` reconciles a crash inside it. Ordinary faults
 * roll back to the complete previous bundle; `InstallInterruptionError`
 * propagates untouched to simulate process death.
 */
async function swapIntoPlace(context: SwapContext): Promise<void> {
  const { resolved, stagingDirectory, backupDirectory, failedDirectory, hadExisting, hooks } =
    context;
  const pluginDirectory = resolved.pluginDirectory;
  if (hadExisting) {
    await rename(pluginDirectory, backupDirectory);
  }
  try {
    await hooks?.duringSwap?.({ vaultPath: resolved.vaultPath });
    await rename(stagingDirectory, pluginDirectory);
  } catch (error) {
    if (error instanceof InstallInterruptionError) throw error;
    if (hadExisting) {
      try {
        await rename(backupDirectory, pluginDirectory);
      } catch (rollbackError) {
        throw new ReleaseInstallError(
          `Swap failed and rollback failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
          "install_rollback_failed",
        );
      }
    }
    throw new ReleaseInstallError(
      `Atomic swap failed; the previous bundle was restored: ${error instanceof Error ? error.message : String(error)}`,
      "install_swap_failed",
    );
  }
  return;
}

async function rollbackVerifiedSwap(context: SwapContext): Promise<ReleaseInstallError> {
  const { resolved, backupDirectory, failedDirectory, hadExisting } = context;
  const pluginDirectory = resolved.pluginDirectory;
  try {
    await rename(pluginDirectory, failedDirectory);
    if (hadExisting) await rename(backupDirectory, pluginDirectory);
    await rm(failedDirectory, { recursive: true, force: true });
  } catch (error) {
    return new ReleaseInstallError(
      `Installed verification failed and rollback failed: ${error instanceof Error ? error.message : String(error)}`,
      "install_rollback_failed",
    );
  }
  return new ReleaseInstallError(
    "Installed files failed post-swap verification; the previous bundle was restored",
    "install_verify_failed",
  );
}

async function installOneTarget(
  bundle: VerifiedReleaseBundle,
  resolved: ResolvedTarget,
  options: InstallReleaseOptions,
): Promise<ReleaseInstallTargetResult> {
  const { pluginDirectory, pluginsRoot } = resolved;
  const pluginId = bundle.identity.pluginId;
  const nonce = (options.nonce ?? (() => randomUUID()))();
  const stagingDirectory = join(pluginsRoot, `.${pluginId}.staging-${nonce}`);
  const backupDirectory = join(pluginsRoot, `.${pluginId}.backup-${nonce}`);
  const failedDirectory = join(pluginsRoot, `.${pluginId}.failed-${nonce}`);

  // Reconcile any interrupted prior attempt before touching this target.
  try {
    await recoverInterruptedInstall(pluginsRoot, pluginId);
  } catch (error) {
    return failedTarget(
      resolved.vaultPath,
      "install_recovery_failed",
      error instanceof Error ? error.message : String(error),
    );
  }

  let staged: StagedContent;
  try {
    staged = await readBundleBytes(bundle);
  } catch (error) {
    if (error instanceof ReleaseInstallError) {
      return failedTarget(resolved.vaultPath, error.code, error.message);
    }
    throw error;
  }

  const installed = await inspectInstalledManagedSet(pluginDirectory, staged.expectedFiles);
  const hadExisting = installed !== null;
  if (installed !== null && installed.complete) {
    // Every managed file verifies against the bundle: nothing to rewrite.
    return {
      vaultPath: resolved.vaultPath,
      outcome: "unchanged",
      action: "unchanged",
      repairedFiles: [],
      removedStaleFiles: [],
      failure: null,
      deployment: null,
    };
  }

  const sameVersion =
    installed !== null && installed.pluginVersion === bundle.identity.pluginVersion;
  const action: InstallTargetAction =
    installed === null ? "installed" : sameVersion ? "repaired" : "replaced";
  const verifiedPaths = new Map(
    (installed?.files ?? [])
      .filter((report) => report.condition === "verified")
      .map((report) => [report.path, true] as const),
  );
  const repairedFiles: string[] = [];
  const removedStaleFiles: string[] = (installed?.files ?? [])
    .filter((report) => report.condition === "unexpected")
    .map((report) => report.path);

  // Build the complete staging directory: managed files plus a byte copy of
  // every preserved (non-managed) entry — Vault identity, persistent port,
  // FIFO/Submission Key state, settings, Recovery Journals, and any other
  // plugin storage are carried, never cleared or replaced.
  try {
    await mkdir(stagingDirectory, { recursive: true });
    for (const file of staged.expectedFiles) {
      if (sameVersion && verifiedPaths.has(file.path)) {
        await cp(join(pluginDirectory, file.path), join(stagingDirectory, file.path));
      } else {
        if (sameVersion) repairedFiles.push(file.path);
        const bytes =
          file.path === RELEASE_MANAGED_CHECKSUM_FILE
            ? staged.checksumBytes
            : staged.bundleBytes.get(file.path);
        if (bytes === undefined) {
          throw new ReleaseInstallError(
            `Bundle carries no bytes for managed file ${file.path}`,
            "install_bundle_drift",
          );
        }
        await writeFile(join(stagingDirectory, file.path), bytes);
      }
    }
    if (hadExisting) {
      for (const entry of await readdir(pluginDirectory)) {
        if (isReleaseManagedFile(entry)) continue;
        await cp(join(pluginDirectory, entry), join(stagingDirectory, entry), {
          recursive: true,
          verbatimSymlinks: true,
        });
      }
    }
    // The staged set must hash-equal the verified identity before the swap.
    const stagedInspection = await inspectInstalledManagedSet(stagingDirectory, staged.expectedFiles);
    if (stagedInspection === null || !stagedInspection.complete) {
      throw new ReleaseInstallError(
        "Staged bundle failed verification before the swap",
        "install_staging_failed",
      );
    }
    await options.hooks?.afterStagingVerified?.({ vaultPath: resolved.vaultPath });
  } catch (error) {
    if (error instanceof InstallInterruptionError) throw error;
    await rm(stagingDirectory, { recursive: true, force: true }).catch(() => undefined);
    if (error instanceof ReleaseInstallError) {
      return failedTarget(resolved.vaultPath, error.code, error.message);
    }
    return failedTarget(
      resolved.vaultPath,
      "install_staging_failed",
      error instanceof Error ? error.message : String(error),
    );
  }

  const swapContext: SwapContext = {
    resolved,
    stagingDirectory,
    backupDirectory,
    failedDirectory,
    hadExisting,
    ...(options.hooks !== undefined ? { hooks: options.hooks } : {}),
  };
  try {
    await swapIntoPlace(swapContext);
  } catch (error) {
    if (error instanceof InstallInterruptionError) throw error;
    // The swap failed before or during the renames and the previous bundle
    // was restored; the never-live staging directory is discarded. An
    // interruption would leave it for recoverInterruptedInstall instead.
    await rm(stagingDirectory, { recursive: true, force: true }).catch(() => undefined);
    if (error instanceof ReleaseInstallError) {
      return failedTarget(resolved.vaultPath, error.code, error.message);
    }
    return failedTarget(
      resolved.vaultPath,
      "install_swap_failed",
      error instanceof Error ? error.message : String(error),
    );
  }

  // Post-swap: the installed set must hash-equal the verified identity.
  const installedNow = await inspectInstalledManagedSet(pluginDirectory, staged.expectedFiles);
  if (installedNow === null || !installedNow.complete) {
    const rollbackError = await rollbackVerifiedSwap(swapContext);
    return failedTarget(resolved.vaultPath, rollbackError.code, rollbackError.message);
  }
  try {
    await rm(backupDirectory, { recursive: true, force: true });
  } catch (error) {
    return failedTarget(
      resolved.vaultPath,
      "install_cleanup_failed",
      `Verified bundle is installed but backup residue remains: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  return {
    vaultPath: resolved.vaultPath,
    outcome: "success",
    action,
    repairedFiles: action === "repaired" ? repairedFiles.sort() : [],
    removedStaleFiles: removedStaleFiles.sort(),
    failure: null,
    deployment:
      action === "installed"
        ? {
            state: ARTIFACTS_INSTALLED,
            requiredNextSteps: [PLUGIN_ENABLEMENT_REQUIRED, MCP_REGISTRATION_REQUIRED],
          }
        : null,
  };
}

/**
 * Installs the verified Release into every requested Managed Vault. Preflight
 * runs for all targets before any target is modified; afterwards each target
 * is installed independently and reported `success`, `unchanged`, or
 * `failed` — per-Vault atomic, never claimed cross-Vault atomic.
 */
export async function installReleaseToManagedVaults(
  bundle: VerifiedReleaseBundle,
  targets: readonly ManagedVaultInstallTarget[],
  options: InstallReleaseOptions = {},
): Promise<ReleaseInstallBatchResult> {
  if (!isVerifiedCandidateBundle(bundle)) {
    throw new ReleaseInstallError(
      "Refusing to install an unverified bundle: deployment requires the release verifier's branded result",
      "install_unverified_bundle",
    );
  }
  const availableSpaceBytes = options.availableSpaceBytes ?? defaultAvailableSpaceBytes;

  const resolvedTargets: ResolvedTarget[] = [];
  const preflightFailures = new Map<number, ReleaseInstallError>();
  for (const [index, target] of targets.entries()) {
    try {
      resolvedTargets[index] = await preflightTarget(target, bundle, availableSpaceBytes);
    } catch (error) {
      if (error instanceof ReleaseInstallError) {
        preflightFailures.set(index, error);
      } else if (error instanceof ReleaseBundleError) {
        preflightFailures.set(
          index,
          new ReleaseInstallError(error.message, "preflight_runtime_incompatible"),
        );
      } else {
        preflightFailures.set(
          index,
          new ReleaseInstallError(
            error instanceof Error ? error.message : String(error),
            "preflight_vault_missing",
          ),
        );
      }
    }
  }

  if (preflightFailures.size > 0) {
    const blocking = [...preflightFailures.values()]
      .map((failure) => `${failure.code}: ${failure.message}`)
      .join("; ");
    return {
      pluginId: bundle.identity.pluginId,
      bundleTag: bundle.tag,
      preflightPassed: false,
      targets: targets.map((target, index) => {
        const failure = preflightFailures.get(index);
        return failure !== undefined
          ? failedTarget(target.vaultPath, failure.code, failure.message)
          : failedTarget(
              target.vaultPath,
              "preflight_batch_failed",
              `Another target failed preflight; no target was modified: ${blocking}`,
            );
      }),
    };
  }

  const results: ReleaseInstallTargetResult[] = [];
  for (const resolved of resolvedTargets) {
    results.push(await installOneTarget(bundle, resolved, options));
  }
  return {
    pluginId: bundle.identity.pluginId,
    bundleTag: bundle.tag,
    preflightPassed: true,
    targets: results,
  };
}

export interface ReleaseRemovalResult {
  readonly vaultPath: string;
  /** Allowlisted files that were present and removed. */
  readonly removedFiles: readonly string[];
  /** Allowlisted files that were already absent. */
  readonly missingFiles: readonly string[];
}

/**
 * Removes only release-managed files from one Managed Vault, retaining all
 * operational state (Vault identity, port, queue, Submission Keys, settings,
 * Recovery Journals) and every other byte of Vault content. The plugin
 * directory itself is left in place. Refusal conditions from spec §9.3
 * (executing/queued work, unresolved recovery) belong to the uninstall
 * orchestration ticket that composes this primitive.
 */
export async function removeReleaseManagedFiles(
  target: ManagedVaultInstallTarget,
  pluginId: string,
): Promise<ReleaseRemovalResult> {
  const configDirectoryName = target.configDirectoryName ?? ".obsidian";
  if (!isAbsolute(target.vaultPath) || !isSafeConfigDirectoryName(configDirectoryName)) {
    throw new ReleaseInstallError(
      `Unsafe Vault or configuration path: ${target.vaultPath} / ${configDirectoryName}`,
      "preflight_path_unsafe",
    );
  }
  const pluginDirectory = managedVaultPluginDirectory(
    target.vaultPath,
    configDirectoryName,
    pluginId,
  );
  const removed: string[] = [];
  const missing: string[] = [];
  let entries: string[] = [];
  try {
    entries = await readdir(pluginDirectory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  for (const file of entries) {
    if (!isReleaseManagedFile(file)) continue;
    await rm(join(pluginDirectory, file), { force: true });
    removed.push(file);
  }
  for (const file of [
    "manifest.json",
    "main.js",
    "styles.css",
    RELEASE_MANAGED_CHECKSUM_FILE,
  ]) {
    if (!removed.includes(file)) missing.push(file);
  }
  return {
    vaultPath: target.vaultPath,
    removedFiles: removed.sort(),
    missingFiles: missing.sort(),
  };
}
