import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createInstalledRuntimeAcceptanceDescriptor } from "../src/installed-runtime/smoke-command.js";
import { loadInstalledLocalOperatorReport, waitForInstalledLocalOperatorReport } from "../src/installed-runtime/local-operator-report.js";

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
    await expect(waitForInstalledLocalOperatorReport({
      descriptor, vaultId: "report-vault", endpoint: new URL("http://127.0.0.1:32123/mcp"),
      action: "standard-diagnostic-copy", timeoutMs: 100,
    })).rejects.toThrow("diagnostic checksum");
  } finally { await rm(root, { recursive: true, force: true }); }
});
it("rejects content diagnostic reports outside the exact private loopback MCP endpoint", async () => {
  const root = await mkdtemp(join(tmpdir(), "local-content-report-"));
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
    const confirmationId = "cancelled-local-confirmation";
    const path = join(reportDirectory, `local-content-inclusive-diagnostic-copy-${createHash("sha256").update(confirmationId).digest("hex")}.json`);
    for (const endpoint of [
      "https://example.com/mcp", "http://127.0.0.1:32123/other",
      "http://127.0.0.1:32123/mcp?token=unexpected", "http://127.0.0.1:32123/mcp#unexpected",
      "http://user:password@127.0.0.1:32123/mcp", "http://127.0.0.1/mcp",
    ]) {
      await writeFile(path, JSON.stringify({
        schemaVersion: 1, runId: descriptor.runId, candidateBundleSha256: descriptor.candidateBundleSha256,
        installedMainSha256: descriptor.installedMainSha256, capabilityToken: descriptor.capabilityToken,
        vaultId: "report-vault", endpoint, action: "content-inclusive-diagnostic-copy",
        confirmationId, selectionSha256: "b".repeat(64), outcome: "cancelled", generated: false, copied: false,
      }), { mode: 0o600 });
      await expect(loadInstalledLocalOperatorReport({
        descriptor, vaultId: "report-vault", endpoint: new URL(endpoint),
        action: "content-inclusive-diagnostic-copy", confirmationId, expectedSelectionSha256: "b".repeat(64),
      })).rejects.toThrow("loopback endpoint");
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("times out waiting for a real local operator report instead of dispatching the operator action", async () => {
  const root = await mkdtemp(join(tmpdir(), "local-operator-wait-"));
  try {
    const vaultPath = join(root, "installed-runtime-vault-wait");
    const pluginDirectory = join(vaultPath, ".obsidian", "plugins", "report-plugin");
    const reportDirectory = join(root, "reports");
    await mkdir(pluginDirectory, { recursive: true });
    await mkdir(reportDirectory);
    await writeFile(join(pluginDirectory, "main.js"), "candidate");
    const { descriptor } = await createInstalledRuntimeAcceptanceDescriptor({
      runId: "wait", vaultPath, pluginId: "report-plugin", reportDirectory,
      candidateBundleSha256: "a".repeat(64),
    });
    await expect(waitForInstalledLocalOperatorReport({
      descriptor, vaultId: "report-vault", endpoint: new URL("http://127.0.0.1:32123/mcp"),
      action: "accept-recovery-baseline", invocationId: "human-only", timeoutMs: 20,
    })).rejects.toThrow("Local Primary Operator report is required");
    await rm(join(pluginDirectory, "installed-runtime-acceptance.json"));
    await expect(waitForInstalledLocalOperatorReport({
      descriptor, vaultId: "report-vault", endpoint: new URL("http://127.0.0.1:32123/mcp"),
      action: "accept-recovery-baseline", invocationId: "human-only", timeoutMs: 20,
    })).rejects.toMatchObject({ code: "ENOENT", path: join(pluginDirectory, "installed-runtime-acceptance.json") });
  } finally { await rm(root, { recursive: true, force: true }); }
});
