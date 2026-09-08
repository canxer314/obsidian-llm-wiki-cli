import { createHash } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  installReleaseToManagedVaults,
  RELEASE_MANAGED_CHECKSUM_FILE,
  RELEASE_REPOSITORY,
  RELEASE_WORKFLOW_PATH,
  verifyManagedVaultLifecycle,
  verifyReleaseBundle,
  type LifecycleStatusProbes,
  type PersistedBridgeIdentity,
} from "../src/index.js";

const PLUGIN_ID = "status-bridge";
const PLUGIN_VERSION = "0.4.0";
const TAG = `v${PLUGIN_VERSION}`;
const MANIFEST = `${JSON.stringify(
  {
    id: PLUGIN_ID,
    name: "Status Bridge",
    version: PLUGIN_VERSION,
    minAppVersion: "1.13.4",
    isDesktopOnly: true,
  },
  null,
  2,
)}\n`;
const MAIN_JS = "// status candidate main\n";
const OBSIDIAN_VERSION = "1.13.4";
const IDENTITY: PersistedBridgeIdentity = { vaultId: "vault-identity-9", port: 24_444 };

const digest = (content: string): string =>
  createHash("sha256").update(content, "utf8").digest("hex");

async function arrangeInstalledVault(root: string): Promise<string> {
  const vaultPath = join(root, "vault");
  await mkdir(join(vaultPath, ".obsidian"), { recursive: true });
  const bundleDirectory = join(root, "bundle");
  await mkdir(bundleDirectory, { recursive: true });
  await writeFile(join(bundleDirectory, "manifest.json"), MANIFEST, "utf8");
  await writeFile(join(bundleDirectory, "main.js"), MAIN_JS, "utf8");
  const lines = [`${digest(MAIN_JS)}  main.js`, `${digest(MANIFEST)}  manifest.json`].sort();
  const checksums = `${lines.join("\n")}\n`;
  await writeFile(join(bundleDirectory, RELEASE_MANAGED_CHECKSUM_FILE), checksums, "utf8");
  const claims = {
    source: "local-candidate",
    repository: RELEASE_REPOSITORY,
    workflowRef: `${RELEASE_REPOSITORY}/${RELEASE_WORKFLOW_PATH}@refs/tags/${TAG}`,
    subjects: [
      ...lines.map((line) => {
        const [subjectDigest, path] = line.split("  ");
        return { name: path, sha256: subjectDigest };
      }),
      { name: RELEASE_MANAGED_CHECKSUM_FILE, sha256: digest(checksums) },
    ].sort((left, right) => left.name!.localeCompare(right.name!)),
  };
  await writeFile(
    `${bundleDirectory}.attestation.json`,
    `${JSON.stringify(claims, null, 2)}\n`,
    "utf8",
  );
  const bundle = await verifyReleaseBundle({
    bundleDirectory,
    expectedTag: TAG,
    expectedPluginId: PLUGIN_ID,
  });
  const result = await installReleaseToManagedVaults(bundle, [
    { vaultPath, obsidianVersion: OBSIDIAN_VERSION },
  ]);
  expect(result.targets[0]?.outcome).toBe("success");
  return vaultPath;
}

async function enablePlugin(vaultPath: string): Promise<void> {
  await writeFile(
    join(vaultPath, ".obsidian", "community-plugins.json"),
    `${JSON.stringify([PLUGIN_ID])}\n`,
    "utf8",
  );
}

async function persistIdentity(vaultPath: string): Promise<void> {
  await writeFile(
    join(vaultPath, ".obsidian", "plugins", PLUGIN_ID, "data.json"),
    `${JSON.stringify({ schemaVersion: 2, ...IDENTITY, diagnosticPath: vaultPath })}\n`,
    "utf8",
  );
}

const matchingBridge: LifecycleStatusProbes["observeBridge"] = async (persisted) => ({
  vaultId: persisted.vaultId,
  port: persisted.port,
});

function statusTarget(vaultPath: string) {
  return { vaultPath, expectedPluginId: PLUGIN_ID };
}

describe("managed Vault lifecycle projection", () => {
  it("projects not_installed when no release-managed files exist", async () => {
    const root = await mkdtemp(join(tmpdir(), "lifecycle-status-"));
    const vaultPath = join(root, "vault");
    await mkdir(join(vaultPath, ".obsidian"), { recursive: true });
    const status = await verifyManagedVaultLifecycle(statusTarget(vaultPath));
    expect(status.state).toBe("not_installed");
    expect(status.managedFiles).toBe("absent");
  });

  it("projects not_installed with defective files when the managed set is damaged", async () => {
    const root = await mkdtemp(join(tmpdir(), "lifecycle-status-"));
    const vaultPath = await arrangeInstalledVault(root);
    await writeFile(
      join(vaultPath, ".obsidian", "plugins", PLUGIN_ID, "main.js"),
      "// tampered\n",
      "utf8",
    );
    const status = await verifyManagedVaultLifecycle(statusTarget(vaultPath));
    expect(status.state).toBe("not_installed");
    expect(status.managedFiles).toBe("damaged");
    expect(status.detail).toContain("main.js");
    expect(status.installedVersion).toBe(PLUGIN_VERSION);
  });

  it("projects installed_not_enabled before the operator enables the plugin", async () => {
    const root = await mkdtemp(join(tmpdir(), "lifecycle-status-"));
    const vaultPath = await arrangeInstalledVault(root);
    const status = await verifyManagedVaultLifecycle(statusTarget(vaultPath));
    expect(status.state).toBe("installed_not_enabled");
    expect(status.enabled).toBe(false);
    expect(status.installedVersion).toBe(PLUGIN_VERSION);
  });

  it("projects bridge_offline when the enabled plugin has no persisted identity", async () => {
    const root = await mkdtemp(join(tmpdir(), "lifecycle-status-"));
    const vaultPath = await arrangeInstalledVault(root);
    await enablePlugin(vaultPath);
    const status = await verifyManagedVaultLifecycle(statusTarget(vaultPath));
    expect(status.state).toBe("bridge_offline");
    expect(status.enabled).toBe(true);
  });

  it("projects bridge_offline when no Bridge answers on the persisted port", async () => {
    const root = await mkdtemp(join(tmpdir(), "lifecycle-status-"));
    const vaultPath = await arrangeInstalledVault(root);
    await enablePlugin(vaultPath);
    await persistIdentity(vaultPath);
    const status = await verifyManagedVaultLifecycle(statusTarget(vaultPath), {
      observeBridge: async () => null,
    });
    expect(status.state).toBe("bridge_offline");
    expect(status.bridgeIdentity).toEqual(IDENTITY);
  });

  it("projects identity_mismatch when the answering Bridge belongs to another Vault", async () => {
    const root = await mkdtemp(join(tmpdir(), "lifecycle-status-"));
    const vaultPath = await arrangeInstalledVault(root);
    await enablePlugin(vaultPath);
    await persistIdentity(vaultPath);
    const status = await verifyManagedVaultLifecycle(statusTarget(vaultPath), {
      observeBridge: async (persisted) => ({ vaultId: `other-${persisted.vaultId}`, port: persisted.port }),
      isMcpRegistered: async () => true,
    });
    expect(status.state).toBe("identity_mismatch");
  });

  it("projects mcp_not_registered while registration lacks positive evidence — even with a live Bridge", async () => {
    const root = await mkdtemp(join(tmpdir(), "lifecycle-status-"));
    const vaultPath = await arrangeInstalledVault(root);
    await enablePlugin(vaultPath);
    await persistIdentity(vaultPath);
    // No probes at all: installed files plus a live bridge are never proof of registration.
    const withoutRegistrationProbe = await verifyManagedVaultLifecycle(statusTarget(vaultPath), {
      observeBridge: matchingBridge,
    });
    expect(withoutRegistrationProbe.state).toBe("mcp_not_registered");
  });

  it("projects ready only with a live identity-matching Bridge and positive registration evidence", async () => {
    const root = await mkdtemp(join(tmpdir(), "lifecycle-status-"));
    const vaultPath = await arrangeInstalledVault(root);
    await enablePlugin(vaultPath);
    await persistIdentity(vaultPath);
    const status = await verifyManagedVaultLifecycle(statusTarget(vaultPath), {
      observeBridge: matchingBridge,
      isMcpRegistered: async () => true,
    });
    expect(status.state).toBe("ready");
    expect(status.bridgeIdentity).toEqual(IDENTITY);
  });
});
