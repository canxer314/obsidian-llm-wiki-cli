import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { confirmGeneratedVaultTrust } from "../src/installed-runtime/local-gui-supervision.js";

it("refuses local GUI supervision for a non-generated Vault", async () => {
  await expect(confirmGeneratedVaultTrust({
    vaultPath: "/home/operator/real-vault", profileDirectory: "/tmp/profile", timeoutMs: 1,
  })).rejects.toThrow("generated acceptance Vault");
});

it("refuses a profile already registered to a different Vault", async () => {
  const root = await mkdtemp(join(tmpdir(), "local-gui-binding-"));
  try {
    const profileDirectory = join(root, "profile");
    await mkdir(profileDirectory);
    await writeFile(join(profileDirectory, "obsidian.json"), JSON.stringify({
      vaults: { personal: { path: "/home/operator/real-vault", open: true } },
    }));
    await expect(confirmGeneratedVaultTrust({
      vaultPath: join(root, "installed-runtime-vault-proof"), profileDirectory, timeoutMs: 1,
    })).rejects.toThrow("profile does not exclusively bind");
  } finally { await rm(root, { recursive: true, force: true }); }
});
