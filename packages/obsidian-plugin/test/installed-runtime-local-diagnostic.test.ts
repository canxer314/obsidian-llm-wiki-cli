import { mkdtemp, mkdir, readFile, rm, writeFile, rename, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createStandardDiagnosticBundle } from "../src/diagnostic-bundle.js";
import { activateInstalledRuntimeAcceptanceDriver, createInstalledRuntimeAcceptanceDescriptor } from "../src/installed-runtime/smoke-command.js";

it("publishes only a valid Vault-bound standard diagnostic copy and preserves its first evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "installed-local-diagnostic-"));
  const vaultPath = join(root, "installed-runtime-vault-local");
  const pluginDirectory = join(vaultPath, ".obsidian", "plugins", "local-plugin");
  await mkdir(pluginDirectory, { recursive: true });
  await writeFile(join(pluginDirectory, "main.js"), "candidate");
  const reports = join(root, "reports");
  const created = await createInstalledRuntimeAcceptanceDescriptor({
    runId: "local", vaultPath, pluginId: "local-plugin", reportDirectory: reports,
    candidateBundleSha256: "a".repeat(64),
  });
  const activation = await activateInstalledRuntimeAcceptanceDriver({ vaultPath, pluginId: "local-plugin" });
  try {
    await expect(activation!.recordStandardDiagnosticCopy({
      vaultId: "local-vault", endpoint: new URL("http://127.0.0.1:32123/mcp"),
      bundle: { checksum: { algorithm: "sha256", canonicalPayload: "forged" } },
    })).rejects.toThrow("valid standard diagnostic bundle");
    await expect(readFile(join(reports, "local-standard-diagnostic-copy.json"))).rejects.toMatchObject({ code: "ENOENT" });
    const bundle = createStandardDiagnosticBundle({
      vaultId: "local-vault",
      versions: { bridge: "0.1.0", plugin: "0.1.0", protocol: "1.0", persistentStateSchema: 2, recoveryJournalSchema: 3 },
      health: {
        readiness: { searchSnapshot: "ready", cache: "ready", index: "ready" }, recovery: "none",
        write: { gate: "open", state: "writable", pauseSource: null }, effectiveGate: null,
        overall: "healthy", reasonCodes: [], operatorAction: "none",
      },
      listener: { address: "127.0.0.1", port: 32123 },
      queue: { currentExecutionId: null, length: 0, headChangeSetId: null },
      lifecycle: { startup: "ready", upgrade: "not_run", migration: "not_run", recovery: "not_run" },
      journal: { availability: "unavailable", frames: [] }, changeSets: [], machineEvents: [],
    });
    await writeFile(join(pluginDirectory, "data.json"), JSON.stringify({ vaultId: "local-vault", port: 32123 }));
    await expect(activation!.recordStandardDiagnosticCopy({ vaultId: "foreign-vault", endpoint: new URL("http://127.0.0.1:32123/mcp"), bundle })).rejects.toThrow("running Vault identity");
    await writeFile(created.path, JSON.stringify({ ...created.descriptor, runId: "foreign-run" }));
    await expect(activation!.recordStandardDiagnosticCopy({ vaultId: "local-vault", endpoint: new URL("http://127.0.0.1:32123/mcp"), bundle })).rejects.toThrow("descriptor identity changed");
    await writeFile(created.path, JSON.stringify(created.descriptor));
    await activation!.recordStandardDiagnosticCopy({ vaultId: "local-vault", endpoint: new URL("http://127.0.0.1:32123/mcp"), bundle });
    const report = JSON.parse(await readFile(join(reports, "local-standard-diagnostic-copy.json"), "utf8"));
    expect(report).toMatchObject({
      schemaVersion: 1, runId: "local", candidateBundleSha256: "a".repeat(64),
      vaultId: "local-vault", endpoint: "http://127.0.0.1:32123/mcp",
      action: "standard-diagnostic-copy", checksumVerified: true, bundle,
    });
    await expect(activation!.recordStandardDiagnosticCopy({ vaultId: "local-vault", endpoint: new URL("http://127.0.0.1:32123/mcp"), bundle })).rejects.toMatchObject({ code: "EEXIST" });
    expect(JSON.parse(await readFile(join(reports, "local-standard-diagnostic-copy.json"), "utf8"))).toEqual(report);
    const replacement = join(root, "replacement-reports");
    await mkdir(replacement);
    await rename(reports, `${reports}-original`);
    await symlink(replacement, reports);
    await expect(activation!.recordStandardDiagnosticCopy({ vaultId: "local-vault", endpoint: new URL("http://127.0.0.1:32123/mcp"), bundle })).rejects.toThrow("report root changed");
    await expect(readFile(join(replacement, "local-standard-diagnostic-copy.json"))).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    activation?.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
