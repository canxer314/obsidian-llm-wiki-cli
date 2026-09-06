import { readFile } from "node:fs/promises";
import { connect } from "node:net";
import { join } from "node:path";

import { RELEASE_PLUGIN_ID } from "../release/release-identity.js";
import {
  BridgeIdentityError,
  readPersistedBridgeIdentity,
  type PersistedBridgeIdentity,
} from "../installed-runtime/obsidian-process.js";
import {
  inspectDeployedManagedSet,
  managedVaultPluginDirectory,
  type InstalledSetIntegrity,
} from "./release-managed-files.js";

/**
 * Lifecycle verification (issue #198, spec §9.1): projects one Managed
 * Vault's release lifecycle from on-disk and live evidence. The projection
 * distinguishes file deployment from plugin enablement, Bridge availability,
 * and Claude Code registration — installed files are never treated as proof
 * that the Bridge or registration is ready. This module never reads Claude
 * Code configuration: registration evidence must arrive through the
 * operator-supplied probe, and without positive evidence the projection is
 * `mcp_not_registered`, never `ready`.
 */

export type ManagedVaultLifecycleState =
  | "not_installed"
  | "installed_not_enabled"
  | "bridge_offline"
  | "mcp_not_registered"
  | "identity_mismatch"
  | "ready";

export interface ManagedVaultLifecycleTarget {
  readonly vaultPath: string;
  /** Obsidian configuration directory name; defaults to `.obsidian`. */
  readonly configDirectoryName?: string;
  /** Defaults to the pinned release plugin id. */
  readonly expectedPluginId?: string;
}

export interface ObservedBridgeEndpoint {
  readonly vaultId: string;
  readonly port: number;
}

export interface LifecycleStatusProbes {
  /**
   * Live Bridge observation for the persisted identity (e.g. a loopback MCP
   * health observation). Returns null when no Bridge answers. The default
   * probe only proves a loopback listener exists on the persisted port; it
   * cannot confirm the Vault ID, so full `ready` projections should supply a
   * real observation.
   */
  readonly observeBridge?: (
    persistedIdentity: PersistedBridgeIdentity,
  ) => Promise<ObservedBridgeEndpoint | null>;
  /**
   * Positive evidence that the operator registered this Bridge with Claude
   * Code (`claude mcp add --scope local ...`). Defaults to no evidence, which
   * projects `mcp_not_registered` — this module never opens Claude Code
   * configuration on its own.
   */
  readonly isMcpRegistered?: (identity: PersistedBridgeIdentity) => Promise<boolean>;
}

export interface ManagedVaultLifecycleStatus {
  readonly state: ManagedVaultLifecycleState;
  readonly pluginId: string;
  readonly installedVersion: string | null;
  /** Integrity of the release-managed set against its deployed checksums. */
  readonly managedFiles: InstalledSetIntegrity;
  /** True when the plugin id is listed in `community-plugins.json`. */
  readonly enabled: boolean;
  /** Persisted Bridge identity (Vault ID and port), when present. */
  readonly bridgeIdentity: PersistedBridgeIdentity | null;
  readonly detail: string | null;
}

async function defaultObserveBridge(
  persistedIdentity: PersistedBridgeIdentity,
): Promise<ObservedBridgeEndpoint | null> {
  const open = await new Promise<boolean>((resolve) => {
    const socket = connect({ host: "127.0.0.1", port: persistedIdentity.port });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
  return open
    ? { vaultId: persistedIdentity.vaultId, port: persistedIdentity.port }
    : null;
}

async function readEnabledPluginIds(
  vaultPath: string,
  configDirectoryName: string,
): Promise<readonly string[]> {
  let raw: string;
  try {
    raw = await readFile(join(vaultPath, configDirectoryName, "community-plugins.json"), "utf8");
  } catch {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is string => typeof entry === "string");
  } catch {
    return [];
  }
}

/**
 * Projects the lifecycle state of one Managed Vault. The chain is strictly
 * ordered — installation integrity → enablement → Bridge liveness → identity
 * agreement → registration evidence — and every stage requires positive
 * evidence from the previous one. An installed set that fails integrity
 * verification projects `not_installed` with the defective files listed: a
 * damaged deployment is not a valid installation and must be repaired first.
 */
export async function verifyManagedVaultLifecycle(
  target: ManagedVaultLifecycleTarget,
  probes: LifecycleStatusProbes = {},
): Promise<ManagedVaultLifecycleStatus> {
  const configDirectoryName = target.configDirectoryName ?? ".obsidian";
  const pluginId = target.expectedPluginId ?? RELEASE_PLUGIN_ID;
  const pluginDirectory = managedVaultPluginDirectory(
    target.vaultPath,
    configDirectoryName,
    pluginId,
  );
  const observeBridge = probes.observeBridge ?? defaultObserveBridge;
  const isMcpRegistered = probes.isMcpRegistered ?? (async () => false);

  const base = {
    pluginId,
    installedVersion: null as string | null,
    enabled: false,
    bridgeIdentity: null as PersistedBridgeIdentity | null,
  };
  const status = (
    state: ManagedVaultLifecycleState,
    managedFiles: InstalledSetIntegrity,
    detail: string | null,
    extra: Partial<typeof base> = {},
  ): ManagedVaultLifecycleStatus => ({
    state,
    ...base,
    ...extra,
    managedFiles,
    detail,
  });

  const inspection = await inspectDeployedManagedSet(pluginDirectory);
  if (inspection.integrity === "absent") {
    return status("not_installed", "absent", "No release-managed files are installed");
  }
  if (inspection.integrity !== "complete") {
    return status(
      "not_installed",
      inspection.integrity,
      `Release-managed files failed integrity verification; repair the installation: ${inspection.defectiveFiles.join(", ")}`,
      { installedVersion: inspection.pluginVersion },
    );
  }

  const enabled = (await readEnabledPluginIds(target.vaultPath, configDirectoryName)).includes(
    pluginId,
  );
  if (!enabled) {
    return status("installed_not_enabled", "complete", null, {
      installedVersion: inspection.pluginVersion,
    });
  }

  let identity: PersistedBridgeIdentity | null = null;
  let identityDetail: string | null = null;
  try {
    identity = await readPersistedBridgeIdentity(target.vaultPath, pluginId, configDirectoryName);
  } catch (error) {
    if (error instanceof BridgeIdentityError) {
      identityDetail = error.message;
    } else {
      throw error;
    }
  }
  if (identity === null) {
    return status(
      "bridge_offline",
      "complete",
      identityDetail ?? "The plugin is enabled but no Bridge identity has been persisted",
      { installedVersion: inspection.pluginVersion, enabled },
    );
  }

  const observed = await observeBridge(identity);
  const enabledBase: Partial<typeof base> = {
    installedVersion: inspection.pluginVersion,
    enabled,
    bridgeIdentity: identity,
  };
  if (observed === null) {
    return status(
      "bridge_offline",
      "complete",
      "No Bridge answers on the persisted loopback port",
      enabledBase,
    );
  }
  if (observed.vaultId !== identity.vaultId || observed.port !== identity.port) {
    return status(
      "identity_mismatch",
      "complete",
      "The answering Bridge does not match the persisted Vault identity",
      enabledBase,
    );
  }
  if (!(await isMcpRegistered(identity))) {
    return status(
      "mcp_not_registered",
      "complete",
      "The Bridge is live; Claude Code registration has not been positively evidenced",
      enabledBase,
    );
  }
  return status("ready", "complete", null, enabledBase);
}
