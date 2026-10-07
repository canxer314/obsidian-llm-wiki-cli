import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { verifyReleaseBundle } from "../src/release/verify-release-bundle.js";
import { RELEASE_REPOSITORY, RELEASE_WORKFLOW_PATH } from "../src/release/release-identity.js";
import { MVP_PERF_REF_LINUX_1 } from "../src/installed-runtime/runtime-profile.js";
import { runInstalledLifecycleSixStateSlice } from "../src/installed-runtime/installed-lifecycle-six-state-runner.js";
import { createBridgeInstance, ManagedVaultBridgeRuntime, createFileSystemChangeSetExecutionAdapter, createNodeFileSystemChangeSetHost, type PersistedBridgeSettings } from "../src/index.js";
import { PLUGIN_VERSION } from "../src/version.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
async function arrange(source: "local-candidate" | "github-artifact-attestation" = "local-candidate") {
  const root = await mkdtemp(join(tmpdir(), "475-six-states-")); roots.push(root);
  const bundleDirectory = join(root, "bundle"); await mkdir(bundleDirectory);
  const files = { "main.js": "// regression fixture, not installed authority\n", "manifest.json": JSON.stringify({ id: "slice-bridge", name: "Slice", version: PLUGIN_VERSION, minAppVersion: "1.13.4", isDesktopOnly: true }) };
  const checksums = Object.entries(files).map(([path, text]) => `${sha(text)}  ${path}`).sort().join("\n") + "\n";
  for (const [path, text] of Object.entries({ ...files, "checksums.sha256": checksums })) await writeFile(join(bundleDirectory, path), text);
  const candidate = await verifyReleaseBundle({ bundleDirectory, expectedTag: `v${PLUGIN_VERSION}`, expectedPluginId: "slice-bridge", attestation: {
    source, repository: RELEASE_REPOSITORY, workflowRef: `${RELEASE_REPOSITORY}/${RELEASE_WORKFLOW_PATH}@refs/tags/v${PLUGIN_VERSION}`,
    subjects: Object.entries({ ...files, "checksums.sha256": checksums }).map(([name, text]) => ({ name, sha256: sha(text) })),
  } });
  return { root, candidate };
}

it("refuses to promote a local candidate to verified-release installed six-state acceptance before provisioning", async () => {
  const { root, candidate } = await arrange();
  let started = false;
  await expect(runInstalledLifecycleSixStateSlice({ candidate, workingDirectory: root, runId: "candidate",
    profile: MVP_PERF_REF_LINUX_1, profileName: MVP_PERF_REF_LINUX_1.name,
    probe: { probe: async () => { throw new Error("unused"); }, probeRunning: async () => { throw new Error("unused"); } },
    processControl: { start: async () => { started = true; throw new Error("must not start"); } },
    record: () => {}, assertion: () => {},
  })).rejects.toThrow("verified release");
  expect(started).toBe(false);
});

it("does not enable the plugin or treat an unexecuted registration command as an operator action", async () => {
  const { root, candidate } = await arrange("github-artifact-attestation");
  let stopCalls = 0;
  const result = await runInstalledLifecycleSixStateSlice({ candidate, workingDirectory: root, runId: "no-operator",
    profile: MVP_PERF_REF_LINUX_1, profileName: MVP_PERF_REF_LINUX_1.name,
    probe: { probe: async () => ({ platform: "linux", osBuild: "7.0.0-31-generic", capabilities: MVP_PERF_REF_LINUX_1.capabilities }),
      probeRunning: async () => ({ platform: "linux", osBuild: "7.0.0-31-generic", obsidianVersion: "1.13.7", electronVersion: "43.3.0", nodeVersion: "24.18.1", capabilities: MVP_PERF_REF_LINUX_1.capabilities }) },
    processControl: { start: async request => {
      expect(await readFile(join(request.vaultPath, ".obsidian/community-plugins.json"), "utf8").catch(() => "missing")).toBe("missing");
      expect(JSON.parse(await readFile(join(request.profileDirectory, "agent/.claude.json"), "utf8"))).toEqual({ projects: {} });
      return { pid: 44, stop: async () => { stopCalls++; } };
    } },
    operatorObservation: async () => {}, operatorTimeoutMs: 30,
    record: () => {}, assertion: () => { throw new Error("Must not publish success"); }, timeouts: { startupMs: 100, stopMs: 100 },
  });
  expect(result).toMatchObject({ verdict: "failed", failedStage: "operator-enable", states: ["not_installed", "installed_not_enabled"], cleanup: { attempted: true, residualPaths: [] } });
  expect(stopCalls).toBe(1);
});

it("retains generated roots if a started runtime cannot confirm process exit", async () => {
  const { root, candidate } = await arrange("github-artifact-attestation");
  const result = await runInstalledLifecycleSixStateSlice({ candidate, workingDirectory: root, runId: "stop-uncertain",
    profile: MVP_PERF_REF_LINUX_1, profileName: MVP_PERF_REF_LINUX_1.name,
    probe: { probe: async () => ({ platform: "linux", osBuild: "7.0.0-31-generic", capabilities: MVP_PERF_REF_LINUX_1.capabilities }),
      probeRunning: async () => ({ platform: "linux", capabilities: [] }) },
    processControl: { start: async () => ({ pid: 44, stop: async () => { throw new Error("live"); } }) },
    record: () => {}, assertion: () => { throw new Error("Must not publish success"); }, timeouts: { startupMs: 50, stopMs: 50 },
  });
  expect(result).toMatchObject({ verdict: "failed", cleanup: { attempted: false, residualPaths: ["shutdown_unconfirmed"] } });
  expect(await readFile(join(root, "installed-runtime-vault-stop-uncertain/.obsidian/plugins/slice-bridge/main.js"), "utf8")).toContain("regression fixture");
});

it("retains roots when a listener survives successful process stop, including identity persisted during stop", async () => {
  const { createServer } = await import("node:net");
  const { root, candidate } = await arrange("github-artifact-attestation");
  const server = createServer(socket => socket.end());
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (address === null || typeof address === "string") throw new Error("No listener");
  try {
    const result = await runInstalledLifecycleSixStateSlice({ candidate, workingDirectory: root, runId: "late-listener",
      profile: MVP_PERF_REF_LINUX_1, profileName: MVP_PERF_REF_LINUX_1.name,
      probe: { probe: async () => ({ platform: "linux", osBuild: "7.0.0-31-generic", capabilities: MVP_PERF_REF_LINUX_1.capabilities }), probeRunning: async () => ({ platform: "linux", capabilities: [] }) },
      processControl: { start: async request => ({ pid: 45, stop: async () => {
        await writeFile(join(request.vaultPath, ".obsidian/plugins/slice-bridge/data.json"), JSON.stringify({ vaultId: "11111111-1111-4111-8111-111111111111", port: address.port }));
      } }) }, record: () => {}, assertion: () => {}, timeouts: { startupMs: 50, stopMs: 50 },
    });
    expect(result).toMatchObject({ verdict: "failed", cleanup: { attempted: false, residualPaths: ["shutdown_unconfirmed"] } });
    expect(await readFile(join(root, "installed-runtime-vault-late-listener/.obsidian/plugins/slice-bridge/main.js"), "utf8")).toContain("regression fixture");
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});

// A Node test host and synthetic claims exercise agreed observation seams only.
// They are regression inputs, never evidence of real installed acceptance.
for (const corrupt of ["none", "state-loss", "empty-directory-loss", "public-prefix-loss", "release-changed", "profile-mismatch", "config-cross-run"] as const) {
it(`observes six lifecycle facts and fails closed on ${corrupt}`, async () => {
  const { root, candidate } = await arrange("github-artifact-attestation");
  const runtimes: ManagedVaultBridgeRuntime[] = [];
  const requests: unknown[] = [];
  const records: unknown[] = [];
  const stopDurationsMs: number[] = [];
  let runningProbes = 0;
  let activeVaultPath = "";
  const result = await runInstalledLifecycleSixStateSlice({ candidate, workingDirectory: root, runId: "six",
    profile: MVP_PERF_REF_LINUX_1, profileName: MVP_PERF_REF_LINUX_1.name,
    probe: { probe: async () => ({ platform: "linux", osBuild: "7.0.0-31-generic", capabilities: MVP_PERF_REF_LINUX_1.capabilities }),
      probeRunning: async () => {
        runningProbes++;
        if (runningProbes === 3) {
          if (corrupt === "state-loss") await rm(join(activeVaultPath, ".llm-wiki/recovery-journal.bin"));
          if (corrupt === "empty-directory-loss") await rm(join(activeVaultPath, ".obsidian-public/empty"), { recursive: true });
          if (corrupt === "public-prefix-loss") await rm(join(activeVaultPath, ".obsidian-public/retain.bin"));
        }
        return { platform: "linux", osBuild: corrupt === "profile-mismatch" ? "wrong" : "7.0.0-31-generic", obsidianVersion: "1.13.7", electronVersion: "43.3.0", nodeVersion: "24.18.1", capabilities: MVP_PERF_REF_LINUX_1.capabilities };
      } },
    processControl: { start: async ({ vaultPath }) => {
      activeVaultPath = vaultPath;
      const enabled = JSON.parse(await readFile(join(vaultPath, ".obsidian/community-plugins.json"), "utf8").catch(() => "[]"));
      if (!enabled.includes("slice-bridge")) return { pid: 1, stop: async () => {} };
      const dataPath = join(vaultPath, ".obsidian/plugins/slice-bridge/data.json");
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
      runtimes.push(runtime); await runtime.load();
      return { pid: 2, stop: async () => { const began = performance.now(); await runtime.unload(); stopDurationsMs.push(performance.now() - began); } };
    } },
    operatorObservation: async request => {
      requests.push(request.action);
      if (request.action === "enable-plugin") {
        await writeFile(join(request.vaultPath, ".obsidian/community-plugins.json"), '["slice-bridge"]\n');
        await mkdir(join(request.vaultPath, ".obsidian-public/empty/nested"), { recursive: true });
        await writeFile(join(request.vaultPath, ".obsidian-public/retain.bin"), "public-root-bytes");
        if (corrupt === "release-changed") await writeFile(join(candidate.bundleDirectory, "main.js"), "changed release");
      }
      else await writeFile(join(request.configDirectory, ".claude.json"), JSON.stringify({ projects: { [corrupt === "config-cross-run" ? `${request.vaultPath}-other-run` : request.vaultPath]: { mcpServers: {
        [request.serverName]: { type: "http", url: request.endpoint, headers: { "X-Expected-Vault-ID": request.vaultId } },
      } } } }));
    },
    runAgentCommand: async request => {
      const config = JSON.parse(await readFile(join(request.configDirectory, ".claude.json"), "utf8"));
      const server = config.projects[request.cwd].mcpServers[request.args[2]!];
      return { exitCode: 0, stdout: `${request.args[2]}:\n  Scope: Local config (private to you in this project)\n  Status: ✓ Connected\n  Type: http\n  URL: ${server.url}\n  Headers:\n    X-Expected-Vault-ID: ${server.headers["X-Expected-Vault-ID"]}\n` };
    },
    record: (_kind, _name, detail) => records.push(detail), assertion: () => {}, operatorTimeoutMs: 50, timeouts: { startupMs: 2000, stopMs: 2000 },
  });
  if (corrupt !== "none") {
    expect(result.verdict).toBe("failed");
    expect(result.failedStage).not.toBeNull();
    expect(JSON.stringify(records)).not.toContain(root);
    await Promise.all(runtimes.map(runtime => runtime.unload()));
    return;
  }
  expect(Math.max(...stopDurationsMs), JSON.stringify(stopDurationsMs)).toBeLessThan(1000);
  expect(result).toMatchObject({ scope: "installed-six-state-install-repair", verdict: "partial", states: ["not_installed", "installed_not_enabled", "bridge_offline", "mcp_not_registered", "ready", "identity_mismatch"],
    repair: { action: "repaired" }, cleanup: { attempted: true, residualPaths: [] }, statePreserved: true });
  expect(result.before?.directoryCount).toBeGreaterThanOrEqual(9);
  expect(result.inventoryBeforeRepairSha256).toBe(result.inventoryAfterRepairSha256);
  expect(requests).toEqual(["enable-plugin", "register-mcp"]);
  expect(JSON.stringify(records)).not.toContain(root);
  expect(JSON.stringify(records)).not.toContain("X-Expected-Vault-ID");
  expect(result.events.at(-1)).toMatchObject({ name: "cleanup", sequence: result.events.length });
  await Promise.all(runtimes.map(runtime => runtime.unload()));
});
}
