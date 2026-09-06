import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  installReleaseToManagedVaults,
  InstallInterruptionError,
  isReleaseManagedFile,
  recoverInterruptedInstall,
  RELEASE_MANAGED_CHECKSUM_FILE,
  RELEASE_REPOSITORY,
  RELEASE_WORKFLOW_PATH,
  removeReleaseManagedFiles,
  verifyReleaseBundle,
  type VerifiedReleaseBundle,
} from "../src/index.js";

const PLUGIN_ID = "lifecycle-bridge";
const PLUGIN_VERSION = "0.3.0";
const TAG = `v${PLUGIN_VERSION}`;
const MANIFEST = `${JSON.stringify(
  {
    id: PLUGIN_ID,
    name: "Lifecycle Bridge",
    version: PLUGIN_VERSION,
    minAppVersion: "1.13.4",
    isDesktopOnly: true,
  },
  null,
  2,
)}\n`;
const MAIN_JS = "// lifecycle candidate main\n";
const STYLES_CSS = "/* lifecycle candidate styles */\n";
const OBSIDIAN_VERSION = "1.13.4";

const digest = (content: string | Uint8Array): string =>
  createHash("sha256").update(content).digest("hex");

async function writeBundle(
  directory: string,
  options: { withStyles?: boolean } = {},
): Promise<void> {
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "manifest.json"), MANIFEST, "utf8");
  await writeFile(join(directory, "main.js"), MAIN_JS, "utf8");
  if (options.withStyles === true) {
    await writeFile(join(directory, "styles.css"), STYLES_CSS, "utf8");
  }
  const lines = [
    `${digest(MAIN_JS)}  main.js`,
    `${digest(MANIFEST)}  manifest.json`,
    ...(options.withStyles === true ? [`${digest(STYLES_CSS)}  styles.css`] : []),
  ].sort();
  const checksums = `${lines.join("\n")}\n`;
  await writeFile(join(directory, RELEASE_MANAGED_CHECKSUM_FILE), checksums, "utf8");
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
  await writeFile(`${directory}.attestation.json`, `${JSON.stringify(claims, null, 2)}\n`, "utf8");
}

async function verifiedBundle(
  root: string,
  name: string,
  options: { withStyles?: boolean } = {},
): Promise<VerifiedReleaseBundle> {
  const directory = join(root, name);
  await writeBundle(directory, options);
  return verifyReleaseBundle({
    bundleDirectory: directory,
    expectedTag: TAG,
    expectedPluginId: PLUGIN_ID,
  });
}

interface VaultFixture {
  readonly vaultPath: string;
  readonly pluginDirectory: string;
}

async function arrangeVault(root: string, name: string): Promise<VaultFixture> {
  const vaultPath = join(root, name);
  await mkdir(join(vaultPath, ".obsidian"), { recursive: true });
  await writeFile(join(vaultPath, "Notes.md"), "# operator content\n", "utf8");
  return { vaultPath, pluginDirectory: join(vaultPath, ".obsidian", "plugins", PLUGIN_ID) };
}

async function readState(pluginDirectory: string, relative: string): Promise<string> {
  return readFile(join(pluginDirectory, relative), "utf8");
}

/** Operational state spanning identity/port, FIFO/Submission Keys, and a Recovery Journal. */
async function writeOperationalState(pluginDirectory: string): Promise<void> {
  await writeFile(
    join(pluginDirectory, "data.json"),
    `${JSON.stringify({
      schemaVersion: 2,
      vaultId: "vault-identity-1",
      port: 23_777,
      diagnosticPath: pluginDirectory,
      changeSets: {
        schemaVersion: 1,
        nextEnqueueSeq: 3,
        writeMode: "maintenance_paused",
        entries: [
          { changeSetId: "cs-1", submissionKey: "submission-key-1", enqueueSeq: 1 },
          { changeSetId: "cs-2", submissionKey: "submission-key-2", enqueueSeq: 2 },
        ],
        tombstones: [],
      },
    })}\n`,
    "utf8",
  );
  await mkdir(join(pluginDirectory, "state"), { recursive: true });
  await writeFile(join(pluginDirectory, "state", "recovery.journal"), "LRJNL001-state-bytes\n", "utf8");
}

async function managedFileDigests(pluginDirectory: string): Promise<Map<string, string>> {
  const digests = new Map<string, string>();
  for (const entry of await readdir(pluginDirectory)) {
    if (isReleaseManagedFile(entry)) {
      digests.set(entry, digest(await readFile(join(pluginDirectory, entry))));
    }
  }
  return digests;
}

describe("release lifecycle installation", () => {
  it("rejects a bundle that did not come from the release verifier", async () => {
    const root = await mkdtemp(join(tmpdir(), "lifecycle-install-"));
    const { vaultPath } = await arrangeVault(root, "vault-a");
    const forged = {
      bundleDirectory: join(root, "nowhere"),
      identity: {
        pluginId: PLUGIN_ID,
        pluginVersion: PLUGIN_VERSION,
        minAppVersion: "1.13.4",
        files: [],
        bundleSha256: "0".repeat(64),
      },
      tag: TAG,
      repository: RELEASE_REPOSITORY,
      workflowRef: "forged",
      attestationSource: "local-candidate",
    } as unknown as VerifiedReleaseBundle;
    await expect(
      installReleaseToManagedVaults(forged, [{ vaultPath, obsidianVersion: OBSIDIAN_VERSION }]),
    ).rejects.toMatchObject({ name: "ReleaseInstallError", code: "install_unverified_bundle" });
  });

  it("deploys files only on first install and leaves enablement and identity to the operator", async () => {
    const root = await mkdtemp(join(tmpdir(), "lifecycle-install-"));
    const bundle = await verifiedBundle(root, "bundle", { withStyles: true });
    const { vaultPath, pluginDirectory } = await arrangeVault(root, "vault-a");

    const result = await installReleaseToManagedVaults(bundle, [
      { vaultPath, obsidianVersion: OBSIDIAN_VERSION },
    ]);

    expect(result.preflightPassed).toBe(true);
    const [target] = result.targets;
    expect(target?.outcome).toBe("success");
    expect(target?.action).toBe("installed");
    expect(target?.deployment).toEqual({
      state: "artifacts_installed",
      requiredNextSteps: ["plugin_enablement_required", "mcp_registration_required"],
    });
    // The complete managed set is deployed, including the checksum manifest.
    const entries = (await readdir(pluginDirectory)).sort();
    expect(entries).toEqual([
      RELEASE_MANAGED_CHECKSUM_FILE,
      "main.js",
      "manifest.json",
      "styles.css",
    ]);
    expect(digest(await readFile(join(pluginDirectory, "main.js")))).toBe(digest(MAIN_JS));
    // No enablement, no Vault identity or port, no queue or journal state.
    await expect(
      stat(join(vaultPath, ".obsidian", "community-plugins.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(join(pluginDirectory, "data.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    // Vault content is untouched.
    expect(await readFile(join(vaultPath, "Notes.md"), "utf8")).toBe("# operator content\n");
  });

  it("changes no target when any target fails preflight", async () => {
    const root = await mkdtemp(join(tmpdir(), "lifecycle-install-"));
    const bundle = await verifiedBundle(root, "bundle");
    const good = await arrangeVault(root, "vault-good");
    const incompatible = await arrangeVault(root, "vault-old-runtime");

    const result = await installReleaseToManagedVaults(bundle, [
      { vaultPath: good.vaultPath, obsidianVersion: OBSIDIAN_VERSION },
      { vaultPath: incompatible.vaultPath, obsidianVersion: "1.12.0" },
    ]);

    expect(result.preflightPassed).toBe(false);
    expect(result.targets[0]?.outcome).toBe("failed");
    expect(result.targets[0]?.failure?.code).toBe("preflight_batch_failed");
    expect(result.targets[1]?.failure?.code).toBe("preflight_runtime_incompatible");
    // The passing target was not modified either.
    await expect(stat(good.pluginDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([
    ["../escape", "preflight_path_unsafe"],
    ["..", "preflight_path_unsafe"],
    ["not/abs", "preflight_path_unsafe"],
  ])("rejects an unsafe configuration directory %s", async (configDirectoryName, code) => {
    const root = await mkdtemp(join(tmpdir(), "lifecycle-install-"));
    const bundle = await verifiedBundle(root, "bundle");
    const { vaultPath } = await arrangeVault(root, "vault-a");
    const result = await installReleaseToManagedVaults(bundle, [
      { vaultPath, configDirectoryName, obsidianVersion: OBSIDIAN_VERSION },
    ]);
    expect(result.preflightPassed).toBe(false);
    expect(result.targets[0]?.failure?.code).toBe(code);
  });

  it("rejects a relative Vault path as unsafe", async () => {
    const root = await mkdtemp(join(tmpdir(), "lifecycle-install-"));
    const bundle = await verifiedBundle(root, "bundle");
    const result = await installReleaseToManagedVaults(bundle, [
      { vaultPath: "relative/vault", obsidianVersion: OBSIDIAN_VERSION },
    ]);
    expect(result.targets[0]?.failure?.code).toBe("preflight_path_unsafe");
  });

  it("fails the batch when capacity is insufficient", async () => {
    const root = await mkdtemp(join(tmpdir(), "lifecycle-install-"));
    const bundle = await verifiedBundle(root, "bundle");
    const { vaultPath, pluginDirectory } = await arrangeVault(root, "vault-a");
    const result = await installReleaseToManagedVaults(
      bundle,
      [{ vaultPath, obsidianVersion: OBSIDIAN_VERSION }],
      { availableSpaceBytes: async () => 1 },
    );
    expect(result.targets[0]?.failure?.code).toBe("preflight_capacity_insufficient");
    await expect(stat(pluginDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fails the batch when the plugin destination is occupied by a non-directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "lifecycle-install-"));
    const bundle = await verifiedBundle(root, "bundle");
    const { vaultPath, pluginDirectory } = await arrangeVault(root, "vault-a");
    await mkdir(join(pluginDirectory, ".."), { recursive: true });
    await writeFile(pluginDirectory, "squatter", "utf8");
    const result = await installReleaseToManagedVaults(bundle, [
      { vaultPath, obsidianVersion: OBSIDIAN_VERSION },
    ]);
    expect(result.targets[0]?.failure?.code).toBe("preflight_destination_invalid");
    expect(await readFile(pluginDirectory, "utf8")).toBe("squatter");
  });

  it("reports unchanged when the same version is reinstalled and every managed file verifies", async () => {
    const root = await mkdtemp(join(tmpdir(), "lifecycle-install-"));
    const bundle = await verifiedBundle(root, "bundle", { withStyles: true });
    const { vaultPath, pluginDirectory } = await arrangeVault(root, "vault-a");
    await installReleaseToManagedVaults(bundle, [{ vaultPath, obsidianVersion: OBSIDIAN_VERSION }]);
    const before = await managedFileDigests(pluginDirectory);

    const result = await installReleaseToManagedVaults(bundle, [
      { vaultPath, obsidianVersion: OBSIDIAN_VERSION },
    ]);

    expect(result.targets[0]?.outcome).toBe("unchanged");
    expect(result.targets[0]?.action).toBe("unchanged");
    expect(await managedFileDigests(pluginDirectory)).toEqual(before);
  });

  it("repairs only damaged release-managed files and preserves all operational state", async () => {
    const root = await mkdtemp(join(tmpdir(), "lifecycle-install-"));
    const bundle = await verifiedBundle(root, "bundle", { withStyles: true });
    const { vaultPath, pluginDirectory } = await arrangeVault(root, "vault-a");
    await installReleaseToManagedVaults(bundle, [{ vaultPath, obsidianVersion: OBSIDIAN_VERSION }]);
    await writeOperationalState(pluginDirectory);
    const dataBefore = await readState(pluginDirectory, "data.json");
    const journalBefore = await readState(pluginDirectory, join("state", "recovery.journal"));
    const stylesBefore = digest(await readFile(join(pluginDirectory, "styles.css")));

    // Damage one managed file and delete another.
    await writeFile(join(pluginDirectory, "main.js"), "// corrupted\n", "utf8");
    await rm(join(pluginDirectory, "styles.css"));

    const result = await installReleaseToManagedVaults(bundle, [
      { vaultPath, obsidianVersion: OBSIDIAN_VERSION },
    ]);

    const [target] = result.targets;
    expect(target?.outcome).toBe("success");
    expect(target?.action).toBe("repaired");
    expect(target?.repairedFiles).toEqual(["main.js", "styles.css"]);
    // Intact files were carried, not re-sourced: styles came back from the bundle…
    expect(digest(await readFile(join(pluginDirectory, "styles.css")))).toBe(stylesBefore);
    // …and every byte of operational state survived.
    expect(await readState(pluginDirectory, "data.json")).toBe(dataBefore);
    expect(await readState(pluginDirectory, join("state", "recovery.journal"))).toBe(journalBefore);
  });

  it("removes a stale managed file the bundle no longer carries", async () => {
    const root = await mkdtemp(join(tmpdir(), "lifecycle-install-"));
    const withStyles = await verifiedBundle(root, "bundle-styles", { withStyles: true });
    const withoutStyles = await verifiedBundle(root, "bundle-plain");
    const { vaultPath, pluginDirectory } = await arrangeVault(root, "vault-a");
    await installReleaseToManagedVaults(withStyles, [
      { vaultPath, obsidianVersion: OBSIDIAN_VERSION },
    ]);
    expect((await readdir(pluginDirectory)).sort()).toContain("styles.css");

    const result = await installReleaseToManagedVaults(withoutStyles, [
      { vaultPath, obsidianVersion: OBSIDIAN_VERSION },
    ]);

    expect(result.targets[0]?.outcome).toBe("success");
    expect(result.targets[0]?.action).toBe("repaired");
    expect(result.targets[0]?.removedStaleFiles).toEqual(["styles.css"]);
    expect((await readdir(pluginDirectory)).sort()).toEqual([
      RELEASE_MANAGED_CHECKSUM_FILE,
      "main.js",
      "manifest.json",
    ]);
  });

  it("fails closed when bundle bytes drift after verification and leaves the destination unchanged", async () => {
    const root = await mkdtemp(join(tmpdir(), "lifecycle-install-"));
    const bundle = await verifiedBundle(root, "bundle");
    const { vaultPath, pluginDirectory } = await arrangeVault(root, "vault-a");
    await writeFile(join(bundle.bundleDirectory, "main.js"), "// drifted after verify\n", "utf8");

    const result = await installReleaseToManagedVaults(bundle, [
      { vaultPath, obsidianVersion: OBSIDIAN_VERSION },
    ]);

    expect(result.targets[0]?.outcome).toBe("failed");
    expect(result.targets[0]?.failure?.code).toBe("install_bundle_drift");
    await expect(stat(pluginDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("restores the complete previous bundle when a filesystem fault hits the swap", async () => {
    const root = await mkdtemp(join(tmpdir(), "lifecycle-install-"));
    const bundle = await verifiedBundle(root, "bundle", { withStyles: true });
    const { vaultPath, pluginDirectory } = await arrangeVault(root, "vault-a");
    await installReleaseToManagedVaults(bundle, [{ vaultPath, obsidianVersion: OBSIDIAN_VERSION }]);
    await writeOperationalState(pluginDirectory);
    const dataBefore = await readState(pluginDirectory, "data.json");

    // Damage one file so the rerun takes the repair path, then fault the swap.
    await writeFile(join(pluginDirectory, "main.js"), "// corrupted\n", "utf8");
    const previousSet = await managedFileDigests(pluginDirectory);
    const result = await installReleaseToManagedVaults(
      bundle,
      [{ vaultPath, obsidianVersion: OBSIDIAN_VERSION }],
      {
        hooks: {
          duringSwap: () => {
            throw new Error("simulated filesystem fault");
          },
        },
      },
    );

    expect(result.targets[0]?.outcome).toBe("failed");
    expect(result.targets[0]?.failure?.code).toBe("install_swap_failed");
    // Old-or-new boundary: the Vault is back on its complete previous set.
    expect(await managedFileDigests(pluginDirectory)).toEqual(previousSet);
    expect(await readState(pluginDirectory, "data.json")).toBe(dataBefore);
    // No staging or backup residue remains.
    const pluginsRoot = join(pluginDirectory, "..");
    for (const entry of await readdir(pluginsRoot)) {
      expect(entry.startsWith(`.${PLUGIN_ID}.`)).toBe(false);
    }
  });

  it("keeps the old-or-new boundary across an interruption between the swap renames", async () => {
    const root = await mkdtemp(join(tmpdir(), "lifecycle-install-"));
    const bundle = await verifiedBundle(root, "bundle");
    const { vaultPath, pluginDirectory } = await arrangeVault(root, "vault-a");
    await installReleaseToManagedVaults(bundle, [{ vaultPath, obsidianVersion: OBSIDIAN_VERSION }]);
    await writeOperationalState(pluginDirectory);
    const dataBefore = await readState(pluginDirectory, "data.json");
    await writeFile(join(pluginDirectory, "main.js"), "// corrupted\n", "utf8");
    const previousSet = await managedFileDigests(pluginDirectory);

    // Process death between backup and staging renames: no rollback runs.
    await expect(
      installReleaseToManagedVaults(
        bundle,
        [{ vaultPath, obsidianVersion: OBSIDIAN_VERSION }],
        {
          nonce: () => "crash1",
          hooks: {
            duringSwap: () => {
              throw new InstallInterruptionError("simulated process kill");
            },
          },
        },
      ),
    ).rejects.toMatchObject({ name: "InstallInterruptionError" });

    // Mid-swap state: the plugin directory is absent, old set in backup,
    // complete new set in staging — recovery restores the previous bundle.
    await expect(stat(pluginDirectory)).rejects.toMatchObject({ code: "ENOENT" });
    const recovery = await recoverInterruptedInstall(join(pluginDirectory, ".."), PLUGIN_ID);
    expect(recovery.restoredPreviousBundle).toBe(true);
    expect(await managedFileDigests(pluginDirectory)).toEqual(previousSet);
    expect(await readState(pluginDirectory, "data.json")).toBe(dataBefore);

    // The next install auto-recovers and converges the Vault to the complete
    // verified replacement with state intact.
    const rerun = await installReleaseToManagedVaults(bundle, [
      { vaultPath, obsidianVersion: OBSIDIAN_VERSION },
    ]);
    expect(rerun.targets[0]?.outcome).toBe("success");
    expect(rerun.targets[0]?.action).toBe("repaired");
    expect(await readState(pluginDirectory, "data.json")).toBe(dataBefore);
    expect(digest(await readFile(join(pluginDirectory, "main.js")))).toBe(digest(MAIN_JS));
  });

  it("recovers a fresh-install interruption by discarding the never-live staging directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "lifecycle-install-"));
    const bundle = await verifiedBundle(root, "bundle");
    const { vaultPath, pluginDirectory } = await arrangeVault(root, "vault-a");

    await expect(
      installReleaseToManagedVaults(
        bundle,
        [{ vaultPath, obsidianVersion: OBSIDIAN_VERSION }],
        {
          nonce: () => "crash2",
          hooks: {
            afterStagingVerified: () => {
              throw new InstallInterruptionError("simulated process kill during staging");
            },
          },
        },
      ),
    ).rejects.toMatchObject({ name: "InstallInterruptionError" });

    // The staging directory survived; nothing was ever live.
    await expect(stat(pluginDirectory)).rejects.toMatchObject({ code: "ENOENT" });
    const rerun = await installReleaseToManagedVaults(bundle, [
      { vaultPath, obsidianVersion: OBSIDIAN_VERSION },
    ]);
    expect(rerun.targets[0]?.outcome).toBe("success");
    const pluginsRoot = join(pluginDirectory, "..");
    for (const entry of await readdir(pluginsRoot)) {
      expect(entry.startsWith(`.${PLUGIN_ID}.`)).toBe(false);
    }
  });

  it("never touches unrelated plugin storage or Vault content during replacement", async () => {
    const root = await mkdtemp(join(tmpdir(), "lifecycle-install-"));
    const bundleV1 = await verifiedBundle(root, "bundle");
    const { vaultPath, pluginDirectory } = await arrangeVault(root, "vault-a");
    await installReleaseToManagedVaults(bundleV1, [{ vaultPath, obsidianVersion: OBSIDIAN_VERSION }]);
    await writeOperationalState(pluginDirectory);
    const otherPlugin = join(vaultPath, ".obsidian", "plugins", "other-plugin");
    await mkdir(otherPlugin, { recursive: true });
    await writeFile(join(otherPlugin, "data.json"), "{\"their\":\"state\"}\n", "utf8");
    const dataBefore = await readState(pluginDirectory, "data.json");

    // Replace with a same-tag bundle whose bytes differ (rebuild) → repaired/replaced.
    await writeFile(join(pluginDirectory, "main.js"), "// corrupted\n", "utf8");
    const result = await installReleaseToManagedVaults(bundleV1, [
      { vaultPath, obsidianVersion: OBSIDIAN_VERSION },
    ]);

    expect(result.targets[0]?.outcome).toBe("success");
    expect(await readFile(join(otherPlugin, "data.json"), "utf8")).toBe("{\"their\":\"state\"}\n");
    expect(await readFile(join(vaultPath, "Notes.md"), "utf8")).toBe("# operator content\n");
    expect(await readState(pluginDirectory, "data.json")).toBe(dataBefore);
  });

  it("removes only release-managed files and retains operational state", async () => {
    const root = await mkdtemp(join(tmpdir(), "lifecycle-install-"));
    const bundle = await verifiedBundle(root, "bundle", { withStyles: true });
    const { vaultPath, pluginDirectory } = await arrangeVault(root, "vault-a");
    await installReleaseToManagedVaults(bundle, [{ vaultPath, obsidianVersion: OBSIDIAN_VERSION }]);
    await writeOperationalState(pluginDirectory);

    const removal = await removeReleaseManagedFiles(
      { vaultPath, obsidianVersion: OBSIDIAN_VERSION },
      PLUGIN_ID,
    );

    expect(removal.removedFiles).toEqual([
      RELEASE_MANAGED_CHECKSUM_FILE,
      "main.js",
      "manifest.json",
      "styles.css",
    ]);
    expect((await readdir(pluginDirectory)).sort()).toEqual(["data.json", "state"]);
    expect(await readState(pluginDirectory, join("state", "recovery.journal"))).toBe(
      "LRJNL001-state-bytes\n",
    );
  });
});
