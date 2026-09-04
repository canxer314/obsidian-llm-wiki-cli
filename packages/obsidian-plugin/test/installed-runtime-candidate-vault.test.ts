import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  CandidateBundleError,
  TestVaultError,
  cleanupTestVault,
  compareInventories,
  inspectCandidateBundle,
  installCandidateBundle,
  provisionTestVault,
  snapshotInventory,
} from "../src/index.js";

function sha256(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

const CANDIDATE_MANIFEST = `${JSON.stringify(
  {
    id: "candidate-bridge",
    name: "Candidate Bridge",
    version: "0.2.0",
    minAppVersion: "1.13.4",
    isDesktopOnly: true,
  },
  null,
  2,
)}\n`;
const CANDIDATE_MAIN = "// candidate main\n";
const CANDIDATE_STYLES = "/* candidate styles */\n";

async function writeCandidateBundle(
  directory: string,
  options: { corruptChecksum?: boolean; withStyles?: boolean } = {},
): Promise<void> {
  await mkdir(directory, { recursive: true });
  const files: [string, string][] = [
    ["manifest.json", CANDIDATE_MANIFEST],
    ["main.js", CANDIDATE_MAIN],
    ...(options.withStyles === true ? [["styles.css", CANDIDATE_STYLES] as [string, string]] : []),
  ];
  for (const [path, content] of files) {
    await writeFile(join(directory, path), content, "utf8");
  }
  const lines = files
    .map(([path, content]) => `${sha256(content)}  ${path}`)
    .sort();
  if (options.corruptChecksum === true) {
    lines[lines.findIndex((line) => line.endsWith("  main.js"))] = `${"0".repeat(64)}  main.js`;
  }
  await writeFile(join(directory, "checksums.sha256"), `${lines.join("\n")}\n`, "utf8");
}

async function workspace(): Promise<string> {
  return mkdtemp(join(tmpdir(), "installed-runtime-candidate-"));
}

describe("candidate bundle inspection", () => {
  it("hashes managed files, parses the manifest, and verifies checksums", async () => {
    const directory = join(await workspace(), "candidate");
    await writeCandidateBundle(directory, { withStyles: true });
    const identity = await inspectCandidateBundle(directory);
    expect(identity.pluginId).toBe("candidate-bridge");
    expect(identity.pluginVersion).toBe("0.2.0");
    expect(identity.minAppVersion).toBe("1.13.4");
    expect(identity.files).toEqual([
      { path: "main.js", sha256: sha256(CANDIDATE_MAIN), sizeBytes: CANDIDATE_MAIN.length },
      {
        path: "manifest.json",
        sha256: sha256(CANDIDATE_MANIFEST),
        sizeBytes: CANDIDATE_MANIFEST.length,
      },
      {
        path: "styles.css",
        sha256: sha256(CANDIDATE_STYLES),
        sizeBytes: CANDIDATE_STYLES.length,
      },
    ]);
    expect(identity.bundleSha256).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("rejects checksum mismatches, missing files, unmanaged files, and invalid manifests", async () => {
    const root = await workspace();

    const corrupted = join(root, "corrupted");
    await writeCandidateBundle(corrupted, { corruptChecksum: true });
    await expect(inspectCandidateBundle(corrupted)).rejects.toMatchObject({
      name: "CandidateBundleError",
      code: "candidate_checksum_mismatch",
    });

    const missing = join(root, "missing");
    await mkdir(missing, { recursive: true });
    await writeFile(join(missing, "manifest.json"), CANDIDATE_MANIFEST, "utf8");
    await expect(inspectCandidateBundle(missing)).rejects.toMatchObject({
      code: "candidate_file_missing",
    });

    const unmanaged = join(root, "unmanaged");
    await writeCandidateBundle(unmanaged);
    await writeFile(join(unmanaged, "data.json"), "{}", "utf8");
    await expect(inspectCandidateBundle(unmanaged)).rejects.toMatchObject({
      code: "candidate_file_unexpected",
    });

    const invalid = join(root, "invalid");
    await mkdir(invalid, { recursive: true });
    await writeFile(join(invalid, "manifest.json"), "{\"id\": \"Upper Case\"}", "utf8");
    await writeFile(join(invalid, "main.js"), CANDIDATE_MAIN, "utf8");
    await expect(inspectCandidateBundle(invalid)).rejects.toMatchObject({
      code: "candidate_manifest_invalid",
    });

    await expect(inspectCandidateBundle(join(root, "absent"))).rejects.toBeInstanceOf(
      CandidateBundleError,
    );
  });
});

describe("test Vault lifecycle", () => {
  it("provisions a dedicated generated Vault and profile without overwriting existing roots", async () => {
    const root = await workspace();
    const vault = await provisionTestVault({ workingDirectory: root, runId: "run-a" });
    expect(vault.vaultPath).toBe(join(root, "installed-runtime-vault-run-a"));
    expect(vault.profileDirectory).toBe(join(root, "installed-runtime-profile-run-a"));
    expect(vault.seedNotes.length).toBeGreaterThan(0);
    expect(vault.seedManifestSha256).toMatch(/^[a-f0-9]{64}$/u);
    await stat(join(vault.vaultPath, ".obsidian", "app.json"));

    await expect(
      provisionTestVault({ workingDirectory: root, runId: "run-a" }),
    ).rejects.toMatchObject({ name: "TestVaultError", code: "vault_root_exists" });

    await expect(
      provisionTestVault({ workingDirectory: root, runId: "bad/run" }),
    ).rejects.toMatchObject({ code: "vault_provision_failed" });
  });

  it("installs the verified candidate as the only enabled plugin and verifies written bytes", async () => {
    const root = await workspace();
    const bundle = join(root, "candidate");
    await writeCandidateBundle(bundle, { withStyles: true });
    const identity = await inspectCandidateBundle(bundle);
    const vault = await provisionTestVault({ workingDirectory: root, runId: "run-b" });

    const installed = await installCandidateBundle(bundle, identity, vault.vaultPath);
    expect(installed.pluginDirectory).toBe(
      join(vault.vaultPath, ".obsidian", "plugins", "candidate-bridge"),
    );
    for (const file of identity.files) {
      const written = await readFile(join(installed.pluginDirectory, file.path));
      expect(sha256(written.toString("utf8"))).toBe(file.sha256);
    }
    expect(
      JSON.parse(
        await readFile(join(vault.vaultPath, ".obsidian", "community-plugins.json"), "utf8"),
      ),
    ).toEqual(["candidate-bridge"]);

    await expect(
      installCandidateBundle(bundle, identity, vault.vaultPath),
    ).rejects.toMatchObject({ code: "candidate_file_unexpected" });
  });

  it("records path/hash inventories without note bodies and diffs before/after", async () => {
    const root = await workspace();
    const vault = await provisionTestVault({ workingDirectory: root, runId: "run-c" });
    const before = await snapshotInventory(vault.vaultPath);
    expect(before.map((entry) => entry.path)).toEqual([
      ".obsidian/app.json",
      "Notes/Linked.md",
      "Notes/Welcome.md",
    ]);
    for (const entry of before) {
      expect(entry.sha256).toMatch(/^[a-f0-9]{64}$/u);
      expect(entry.sizeBytes).toBeGreaterThan(0);
    }
    await writeFile(join(vault.vaultPath, "Notes", "Added.md"), "added\n", "utf8");
    const after = await snapshotInventory(vault.vaultPath);
    const comparison = compareInventories(before, after);
    expect(comparison.addedPaths).toEqual(["Notes/Added.md"]);
    expect(comparison.removedPaths).toEqual([]);
    expect(comparison.changedPaths).toEqual([]);
    expect(comparison.beforeDigest).not.toBe(comparison.afterDigest);
  });

  it("removes generated roots and reports an empty residual inventory", async () => {
    const root = await workspace();
    const vault = await provisionTestVault({ workingDirectory: root, runId: "run-d" });
    const report = await cleanupTestVault(vault);
    expect(report).toEqual({ attempted: true, residualPaths: [] });
    await expect(stat(vault.vaultPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(vault.profileDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
