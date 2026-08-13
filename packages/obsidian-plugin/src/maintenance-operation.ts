import { PLUGIN_VERSION } from "./version.js";

/**
 * Production maintenance entry point (spec §9.2 "Pause and maintenance").
 *
 * The Primary Operator drains one Managed Vault into maintenance from the
 * Obsidian command palette. The plugin-side steps run inside the Bridge
 * maintenance lifecycle: the installed bundle is validated, persisted state
 * migrates fail-closed, and health is rechecked. Downloading release
 * artifacts and atomically replacing release-managed files belong to the
 * external installer (spec §9.1); the plugin validates the bundle it is
 * running from so a torn replacement fails closed instead of migrating
 * state onto partial files.
 */

export interface InstalledBundleProbe {
  readManifest(): Promise<unknown>;
  hasEntryPoint(): Promise<boolean>;
}

export async function assertValidatedInstalledBundle(
  probe: InstalledBundleProbe,
  expectedPluginId: string,
): Promise<void> {
  let manifest: unknown;
  try {
    manifest = await probe.readManifest();
  } catch {
    throw new Error("Validated bundle is not installed: manifest.json is unreadable");
  }
  if (typeof manifest !== "object" || manifest === null || Array.isArray(manifest)) {
    throw new Error("Validated bundle is not installed: manifest.json is not an object");
  }
  const { id, version } = manifest as Record<string, unknown>;
  if (id !== expectedPluginId) {
    throw new Error("Validated bundle identity does not match the running plugin");
  }
  if (version !== PLUGIN_VERSION) {
    throw new Error("Validated bundle version does not match the running plugin");
  }
  if (!(await probe.hasEntryPoint())) {
    throw new Error("Validated bundle is not installed: main.js is missing");
  }
}

export interface MaintenanceCommandRegistry {
  addCommand(command: { id: string; name: string; callback: () => unknown }): void;
}

export const RUN_MAINTENANCE_COMMAND_ID = "run-managed-vault-maintenance";

export function registerRunMaintenanceCommand(
  registry: MaintenanceCommandRegistry,
  run: () => Promise<void>,
): void {
  registry.addCommand({
    id: RUN_MAINTENANCE_COMMAND_ID,
    name: "Run Managed Vault maintenance",
    callback: run,
  });
}
