import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createInstalledRuntimeAcceptanceDescriptor } from "../src/installed-runtime/smoke-command.js";
import { loadInstalledLocalOperatorReport } from "../src/installed-runtime/local-operator-report.js";

it("rejects a local report whose claimed checksum verification covers an invalid diagnostic bundle", async () => {
  const root = await mkdtemp(join(tmpdir(), "local-operator-report-"));
  try {
    const vaultPath = join(root, "installed-runtime-vault-report");
    const pluginDirectory = join(vaultPath, ".obsidian", "plugins", "report-plugin");
    const reportDirectory = join(root, "reports");
    await mkdir(pluginDirectory, { recursive: true });
    await mkdir(reportDirectory);
    await writeFile(join(pluginDirectory, "main.js"), "candidate");
    const { descriptor } = await createInstalledRuntimeAcceptanceDescriptor({
      runId: "report", vaultPath, pluginId: "report-plugin", reportDirectory,
      candidateBundleSha256: "a".repeat(64),
    });
    await writeFile(join(reportDirectory, "local-standard-diagnostic-copy.json"), JSON.stringify({
      schemaVersion: 1, runId: descriptor.runId, candidateBundleSha256: descriptor.candidateBundleSha256,
      installedMainSha256: descriptor.installedMainSha256, capabilityToken: descriptor.capabilityToken,
      vaultId: "report-vault", endpoint: "http://127.0.0.1:32123/mcp",
      action: "standard-diagnostic-copy", checksumVerified: true, bundle: { checksum: "forged" },
    }), { mode: 0o600 });
    await expect(loadInstalledLocalOperatorReport({
      descriptor, vaultId: "report-vault", endpoint: new URL("http://127.0.0.1:32123/mcp"),
      action: "standard-diagnostic-copy",
    })).rejects.toThrow("diagnostic checksum");
  } finally { await rm(root, { recursive: true, force: true }); }
});
