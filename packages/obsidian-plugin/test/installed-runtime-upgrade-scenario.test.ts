import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createBridgeInstance,
  ManagedVaultBridgeRuntime,
  RELEASE_MANAGED_CHECKSUM_FILE,
  RELEASE_REPOSITORY,
  RELEASE_WORKFLOW_PATH,
  runManagedVaultUpgradeScenario,
  TEST_VAULT_DIRECTORY_PREFIX,
  verifyReleaseBundle,
  type ObsidianProcessControl,
  type PersistedBridgeSettings,
  type SearchSnapshotDataSource,
  type UpgradeScenarioRuntimeHost,
} from "../src/index.js";

const PLUGIN_ID = "upgrade-scenario-bridge";
const OLD_VERSION = "0.6.0";
const NEW_VERSION = "0.7.0";
const OBSIDIAN_VERSION = "1.13.4";

const digest = (content: string): string =>
  createHash("sha256").update(content, "utf8").digest("hex");

async function writeVerifiedBundle(root: string, name: string, version: string) {
  const bundleDirectory = join(root, name);
  await mkdir(bundleDirectory, { recursive: true });
  const manifest = `${JSON.stringify(
    {
      id: PLUGIN_ID,
      name: "Upgrade Scenario Bridge",
      version,
      minAppVersion: "1.13.4",
      isDesktopOnly: true,
    },
    null,
    2,
  )}\n`;
  const main = `// upgrade scenario candidate main ${version}\n`;
  await writeFile(join(bundleDirectory, "manifest.json"), manifest, "utf8");
  await writeFile(join(bundleDirectory, "main.js"), main, "utf8");
  const lines = [`${digest(main)}  main.js`, `${digest(manifest)}  manifest.json`].sort();
  const checksums = `${lines.join("\n")}\n`;
  await writeFile(join(bundleDirectory, RELEASE_MANAGED_CHECKSUM_FILE), checksums, "utf8");
  const tag = `v${version}`;
  const claims = {
    source: "local-candidate",
    repository: RELEASE_REPOSITORY,
    workflowRef: `${RELEASE_REPOSITORY}/${RELEASE_WORKFLOW_PATH}@refs/tags/${tag}`,
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
  return verifyReleaseBundle({
    bundleDirectory,
    expectedTag: tag,
    expectedPluginId: PLUGIN_ID,
  });
}

/** Filesystem-backed Search Snapshot source over the generated test Vault. */
function vaultSearchDataSource(vaultPath: string): SearchSnapshotDataSource {
  const walk = async (directory: string, prefix: string): Promise<string[]> => {
    const paths: string[] = [];
    for (const child of await readdir(directory)) {
      if (prefix === "" && child === ".obsidian") continue;
      const absolute = join(directory, child);
      const relative = prefix === "" ? child : `${prefix}/${child}`;
      if ((await stat(absolute)).isDirectory()) {
        paths.push(...(await walk(absolute, relative)));
      } else if (child.endsWith(".md")) {
        paths.push(relative);
      }
    }
    return paths;
  };
  return {
    listMarkdownPaths: () => walk(vaultPath, ""),
    readBinary: async (path) => {
      try {
        return new Uint8Array(await readFile(join(vaultPath, path)));
      } catch {
        return null;
      }
    },
  };
}

/**
 * Fake Obsidian for the scenario: each start() loads the enabled candidate
 * plugin the way the real plugin host would and hosts a real per-Vault
 * Bridge Instance over loopback Streamable HTTP, with Change Set submissions
 * accepted into the durable queue.
 */
const liveRuntimes: ManagedVaultBridgeRuntime[] = [];

afterEach(async () => {
  await Promise.all(
    liveRuntimes.splice(0).map((runtime) => runtime.unload().catch(() => undefined)),
  );
});

function createFakeObsidian(): {
  processControl: ObsidianProcessControl;
  runtimeHost: UpgradeScenarioRuntimeHost;
  starts: () => number;
} {
  let starts = 0;
  let current: ManagedVaultBridgeRuntime | null = null;
  const processControl: ObsidianProcessControl = {
    async start({ vaultPath }) {
      starts += 1;
      const configDirectory = join(vaultPath, ".obsidian");
      const enabled = JSON.parse(
        await readFile(join(configDirectory, "community-plugins.json"), "utf8"),
      ) as string[];
      const pluginId = enabled[0];
      if (typeof pluginId !== "string") {
        throw new Error("No enabled candidate plugin");
      }
      const dataPath = join(configDirectory, "plugins", pluginId, "data.json");
      let stored: PersistedBridgeSettings | undefined;
      try {
        stored = JSON.parse(await readFile(dataPath, "utf8")) as PersistedBridgeSettings;
      } catch {
        stored = undefined;
      }
      const runtime = new ManagedVaultBridgeRuntime({
        vault: { name: basename(vaultPath), path: vaultPath },
        settings: {
          load: async () => stored,
          save: async (settings) => {
            stored = settings;
            await mkdir(join(dataPath, ".."), { recursive: true });
            await writeFile(dataPath, JSON.stringify(settings), "utf8");
          },
        },
        searchDataSource: vaultSearchDataSource(vaultPath),
        changeSetDataSource: {
          readBinary: async () => null,
          pathKind: async () => null,
          isContained: async () => true,
        },
        createBridge: (options) => createBridgeInstance(options),
      });
      liveRuntimes.push(runtime);
      await runtime.load();
      current = runtime;
      return {
        pid: 60_000 + starts,
        stop: async () => {
          await runtime.unload();
          if (current === runtime) current = null;
        },
      };
    },
  };
  return {
    processControl,
    runtimeHost: { currentRuntime: () => current },
    starts: () => starts,
  };
}

describe("installed-runtime upgrade scenario", () => {
  it(
    "proves a queued upgrade through a real reload, preserved state, maintenance pause, and explicit resume",
    { timeout: 60_000 },
    async () => {
      const root = await mkdtemp(join(tmpdir(), "upgrade-scenario-"));
      const previousRelease = await writeVerifiedBundle(root, "bundle-old", OLD_VERSION);
      const upgradeRelease = await writeVerifiedBundle(root, "bundle-new", NEW_VERSION);
      const fake = createFakeObsidian();

      const result = await runManagedVaultUpgradeScenario({
        previousRelease,
        upgradeRelease,
        obsidianVersion: OBSIDIAN_VERSION,
        workingDirectory: root,
        processControl: fake.processControl,
        runtimeHost: fake.runtimeHost,
        runId: "upgrade-scenario-pass",
        timeouts: { startupMs: 10_000, stopMs: 5_000 },
      });

      expect(result.failure).toBeNull();
      expect(result.stages.map((stage) => [stage.stage, stage.outcome])).toEqual([
        ["provision", "passed"],
        ["install_previous_release", "passed"],
        ["operator_enablement", "passed"],
        ["obsidian_start", "passed"],
        ["queue_work", "passed"],
        ["upgrade", "passed"],
        ["state_preservation", "passed"],
        ["post_upgrade_pause", "passed"],
        ["explicit_resume", "passed"],
        ["obsidian_stop", "passed"],
        ["cleanup", "passed"],
      ]);
      expect(result.verdict).toBe("passed");
      // The upgrade went through a real Obsidian restart: initial start plus
      // the reload inside the orchestration.
      expect(fake.starts()).toBe(2);
      expect(result.upgrade?.outcome).toBe("upgraded");
      expect(result.upgrade?.fromVersion).toBe(OLD_VERSION);
      expect(result.upgrade?.toVersion).toBe(NEW_VERSION);
      expect(result.upgrade?.awaitingOperatorResume).toBe(true);
      expect(result.queuedChangeSetIds).toHaveLength(3);
      expect(result.bridgeIdentity?.vaultId).toMatch(/^[0-9a-f-]{36}$/u);
      expect(result.cleanup).toEqual({ attempted: true, residualPaths: [] });
      await expect(
        stat(join(root, `${TEST_VAULT_DIRECTORY_PREFIX}upgrade-scenario-pass`)),
      ).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it("records a failed stage and still cleans up when the runtime host never exposes a runtime", async () => {
    const root = await mkdtemp(join(tmpdir(), "upgrade-scenario-"));
    const previousRelease = await writeVerifiedBundle(root, "bundle-old", OLD_VERSION);
    const upgradeRelease = await writeVerifiedBundle(root, "bundle-new", NEW_VERSION);
    const fake = createFakeObsidian();

    const result = await runManagedVaultUpgradeScenario({
      previousRelease,
      upgradeRelease,
      obsidianVersion: OBSIDIAN_VERSION,
      workingDirectory: root,
      processControl: fake.processControl,
      runtimeHost: { currentRuntime: () => null },
      runId: "upgrade-scenario-no-runtime",
      timeouts: { startupMs: 10_000, stopMs: 5_000 },
    });

    expect(result.verdict).toBe("failed");
    expect(result.failure?.stage).toBe("upgrade");
    expect(result.stages.at(-1)?.stage).toBe("cleanup");
    expect(result.stages.at(-1)?.outcome).toBe("passed");
  });
});
