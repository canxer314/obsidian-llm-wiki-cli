import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { afterEach, expect, it } from "vitest";
import { verifyReleaseBundle } from "../src/release/verify-release-bundle.js";
import { RELEASE_REPOSITORY, RELEASE_WORKFLOW_PATH } from "../src/release/release-identity.js";
import { MVP_PERF_REF_LINUX_1 } from "../src/installed-runtime/runtime-profile.js";
import { runInstalledReleaseLifecycleSlice, runInstalledReleaseUninstallSlice } from "../src/installed-runtime/installed-release-lifecycle-runner.js";
import { createBridgeInstance, ManagedVaultBridgeRuntime, createFileSystemChangeSetExecutionAdapter, createNodeFileSystemChangeSetHost, type PersistedBridgeSettings } from "../src/index.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
async function arrange() {
  const root = await mkdtemp(join(tmpdir(), "installed-lifecycle-slice-"));
  roots.push(root);
  const bundleDirectory = join(root, "bundle");
  await mkdir(bundleDirectory);
  const files = { "main.js": "// verified install slice\n", "manifest.json": JSON.stringify({ id: "slice-bridge", name: "Slice", version: "0.5.0", minAppVersion: "1.13.4", isDesktopOnly: true }) };
  const checksums = Object.entries(files).map(([path, text]) => `${sha(text)}  ${path}`).sort().join("\n") + "\n";
  for (const [path, text] of Object.entries({ ...files, "checksums.sha256": checksums })) await writeFile(join(bundleDirectory, path), text);
  const candidate = await verifyReleaseBundle({ bundleDirectory, expectedTag: "v0.5.0", expectedPluginId: "slice-bridge", attestation: {
    source: "local-candidate", repository: RELEASE_REPOSITORY,
    workflowRef: `${RELEASE_REPOSITORY}/${RELEASE_WORKFLOW_PATH}@refs/tags/v0.5.0`,
    subjects: Object.entries({ ...files, "checksums.sha256": checksums }).map(([name, text]) => ({ name, sha256: sha(text) })),
  } });
  return { root, candidate, files };
}

it("runs the built-in install/repair adapter against installed bytes but returns only a partial lifecycle proof", async () => {
  const { root, candidate, files } = await arrange();
  let starts = 0;
  let stops = 0;
  let runningProbes = 0;
  const records: unknown[] = [];
  const result = await runInstalledReleaseLifecycleSlice({
    candidate, workingDirectory: root, runId: "slice", profile: MVP_PERF_REF_LINUX_1,
    profileName: MVP_PERF_REF_LINUX_1.name,
    probe: { probe: async () => { throw new Error("running probe required"); }, probeRunning: async () => {
      runningProbes++;
      return { platform: "linux", osBuild: "7.0.0-31-generic", obsidianVersion: "1.13.7", electronVersion: "43.3.0", nodeVersion: "24.18.1", capabilities: MVP_PERF_REF_LINUX_1.capabilities };
    } },
    processControl: { start: async ({ vaultPath }) => {
      starts++;
      const plugin = join(vaultPath, ".obsidian/plugins/slice-bridge");
      expect(await readFile(join(plugin, "main.js"), "utf8")).toBe(files["main.js"]);
      await writeFile(join(plugin, "data.json"), JSON.stringify({ vaultId: "11111111-1111-4111-8111-111111111111", port: 27123 }));
      return { pid: 42, stop: async () => { stops++; } };
    } },
    client: { observeHealth: async () => ({}) } as never,
    record: (_kind, _name, detail) => records.push(detail), assertion: () => {},
    timeouts: { startupMs: 1000, stopMs: 1000 },
  });
  expect(starts).toBe(1);
  expect(stops).toBe(1);
  expect(runningProbes).toBe(1);
  expect(result).toMatchObject({ scope: "installed-install-repair", verdict: "partial", candidateBundleSha256: candidate.identity.bundleSha256,
    installedMainSha256: sha(files["main.js"]), install: { action: "installed" }, repair: { action: "repaired" }, cleanup: { attempted: true, residualPaths: [] } });
  expect(result.humanRequired).toEqual(["mcp-registration", "identity-mismatch-live-observation", "upgrade-and-explicit-resume", "uninstall", "purge"]);
  expect(JSON.stringify(records)).not.toContain("11111111-1111-4111-8111-111111111111");
  expect(result).not.toHaveProperty("migration");
});


it("runs built-in offline uninstall and lossless reinstall after real MCP work without promoting full lifecycle", async () => {
  const { root, candidate, files } = await arrange();
  let starts = 0;
  let stops = 0;
  const runtimes: ManagedVaultBridgeRuntime[] = [];
  try {
    const result = await runInstalledReleaseUninstallSlice({
      candidate, workingDirectory: root, runId: "uninstall-slice", profile: MVP_PERF_REF_LINUX_1,
      profileName: MVP_PERF_REF_LINUX_1.name,
      probe: { probe: async () => { throw new Error("running probe required"); }, probeRunning: async () => ({
        platform: "linux", osBuild: "7.0.0-31-generic", obsidianVersion: "1.13.7", electronVersion: "43.3.0", nodeVersion: "24.18.1", capabilities: MVP_PERF_REF_LINUX_1.capabilities,
      }) },
      processControl: { start: async ({ vaultPath }) => {
        starts++;
        const dataPath = join(vaultPath, ".obsidian/plugins/slice-bridge/data.json");
        expect(await readFile(join(dataPath, "../main.js"), "utf8")).toBe(files["main.js"]);
        let stored: PersistedBridgeSettings | undefined;
        try { stored = JSON.parse(await readFile(dataPath, "utf8")); } catch {}
        const stateDirectory = join(vaultPath, ".llm-wiki");
        const execution = await createFileSystemChangeSetExecutionAdapter({ journalPath: join(stateDirectory, "recovery-journal.bin"), slotCapacity: 16 * 1024,
          host: await createNodeFileSystemChangeSetHost({ basePath: vaultPath, stateDirectory, referenced: async () => false,
            awaitSemanticEvidence: async () => {}, publishSearchSnapshot: async () => {} }),
        });
        const runtime = new ManagedVaultBridgeRuntime({ vault: { name: "Slice", path: vaultPath },
          settings: { load: async () => stored, save: async settings => { stored = settings; await writeFile(dataPath, JSON.stringify(settings)); } },
          searchDataSource: { listMarkdownPaths: async () => ["Notes/Welcome.md"], readBinary: async path => new Uint8Array(await readFile(join(vaultPath, path))) },
          changeSetDataSource: { readBinary: execution.readBinary!, pathKind: execution.pathKind, isContained: async () => true },
          changeSetExecution: execution, createBridge: options => createBridgeInstance(options),
        });
        runtimes.push(runtime);
        await runtime.load();
        return { pid: 43, stop: async () => { stops++; await runtime.unload(); } };
      } },
      record: () => {}, assertion: () => {}, timeouts: { startupMs: 2000, stopMs: 2000 },
    });
    expect(result).toMatchObject({ scope: "installed-uninstall-reinstall", verdict: "partial", candidateBundleSha256: candidate.identity.bundleSha256,
      uninstall: { outcome: "uninstalled" }, reinstall: { outcome: "success" }, drainedMcpWork: true, cleanup: { attempted: true, residualPaths: [] } });
    expect(starts).toBe(2);
    expect(stops).toBe(2);
    expect(result.humanRequired).toEqual(["mcp-registration-and-removal", "queued-executing-recovery-refusal", "upgrade-and-explicit-resume", "purge"]);
    expect(result).not.toHaveProperty("removal");
  } finally { await Promise.all(runtimes.map(runtime => runtime.unload())); }
});


it("fails partial proof and retains generated roots when a rejected runtime cannot stop", async () => {
  const { root, candidate } = await arrange();
  let cleaned = false;
  const result = await runInstalledReleaseLifecycleSlice({
    candidate, workingDirectory: root, runId: "bad-runtime", profile: MVP_PERF_REF_LINUX_1, profileName: MVP_PERF_REF_LINUX_1.name,
    probe: { probe: async () => { throw new Error("unused"); }, probeRunning: async () => ({ platform: "linux", capabilities: [] }) },
    processControl: { start: async () => ({ pid: 44, stop: async () => { throw new Error("still running"); } }) },
    cleanupVault: async () => { cleaned = true; return { attempted: true, residualPaths: [] }; },
    record: () => {}, assertion: () => { throw new Error("Failed slice must not assert success"); },
  });
  expect(result.verdict).toBe("failed");
  expect(result.cleanup?.residualPaths).toEqual(["generated_runtime_residue"]);
  expect(cleaned).toBe(false);
});


// These in-process hosts exercise orchestration seams, not installed authority.
for (const runner of [runInstalledReleaseLifecycleSlice, runInstalledReleaseUninstallSlice]) {
  it(`${runner.name} retains roots when a rejected runtime listener survives successful stop`, async () => {
    const { root, candidate } = await arrange();
    const server = createServer(socket => socket.end());
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("No test listener");
    let cleaned = false;
    try {
      const result = await runner({ candidate, workingDirectory: root, runId: "surviving-listener", profile: MVP_PERF_REF_LINUX_1, profileName: MVP_PERF_REF_LINUX_1.name,
        probe: { probe: async () => { throw new Error("unused"); }, probeRunning: async () => ({ platform: "linux", capabilities: [] }) },
        processControl: { start: async ({ vaultPath }) => {
          await writeFile(join(vaultPath, ".obsidian/plugins/slice-bridge/data.json"), JSON.stringify({ vaultId: "11111111-1111-4111-8111-111111111111", port: address.port }));
          return { pid: 45, stop: async () => {} };
        } },
        cleanupVault: async () => { cleaned = true; return { attempted: true, residualPaths: [] }; },
        timeouts: { stopMs: 50 }, record: () => {}, assertion: () => {},
      });
      expect(result.verdict).toBe("failed");
      expect(cleaned).toBe(false);
      expect(result.cleanup?.residualPaths).toEqual(["generated_runtime_residue"]);
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  });
  it(`${runner.name} does not publish raw cleanup paths`, async () => {
    const { root, candidate } = await arrange();
    const records: unknown[] = [];
    await runner({ candidate, workingDirectory: root, runId: "private-cleanup", profile: MVP_PERF_REF_LINUX_1, profileName: MVP_PERF_REF_LINUX_1.name,
      probe: { probe: async () => { throw new Error("unused"); }, probeRunning: async () => ({ platform: "linux", capabilities: [] }) },
      processControl: { start: async () => ({ pid: 46, stop: async () => {} }) },
      cleanupVault: async () => ({ attempted: true, residualPaths: ["/private/operator/secret-vault"] }),
      record: (_kind, _name, detail) => records.push(detail), assertion: () => {},
    });
    expect(JSON.stringify(records)).not.toContain("/private/operator/secret-vault");
  });
}
