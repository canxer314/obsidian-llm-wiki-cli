import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createBridgeInstance,
  createFileSystemChangeSetExecutionAdapter,
  createNodeFileSystemChangeSetHost,
  ManagedVaultBridgeRuntime,
  RELEASE_MANAGED_CHECKSUM_FILE,
  RELEASE_REPOSITORY,
  RELEASE_WORKFLOW_PATH,
  runManagedVaultUninstallScenario,
  TEST_VAULT_DIRECTORY_PREFIX,
  verifyReleaseBundle,
  type ObsidianProcessControl,
  type PersistedBridgeSettings,
  type SearchSnapshotDataSource,
} from "../src/index.js";

const PLUGIN_ID = "uninstall-scenario-bridge";
const VERSION = "0.9.0";
const OBSIDIAN_VERSION = "1.13.4";

const digest = (content: string): string =>
  createHash("sha256").update(content, "utf8").digest("hex");

async function writeVerifiedBundle(root: string, name: string, version: string) {
  const bundleDirectory = join(root, name);
  await mkdir(bundleDirectory, { recursive: true });
  const manifest = `${JSON.stringify(
    {
      id: PLUGIN_ID,
      name: "Uninstall Scenario Bridge",
      version,
      minAppVersion: "1.13.4",
      isDesktopOnly: true,
    },
    null,
    2,
  )}\n`;
  const main = `// uninstall scenario candidate main ${version}\n`;
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
      if (prefix === "" && (child === ".obsidian" || child === ".llm-wiki")) continue;
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
 * plugin the way the real plugin host would, hosting a real per-Vault Bridge
 * Instance over loopback Streamable HTTP with the real filesystem Change Set
 * executor — so submitted work drains to terminal and leaves a real Recovery
 * Journal on disk.
 */
const liveRuntimes: ManagedVaultBridgeRuntime[] = [];

afterEach(async () => {
  await Promise.all(
    liveRuntimes.splice(0).map((runtime) => runtime.unload().catch(() => undefined)),
  );
});

function createFakeObsidian(): {
  processControl: ObsidianProcessControl;
  starts: () => number;
} {
  let starts = 0;
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
      const stateDirectory = join(vaultPath, ".llm-wiki");
      const execution = await createFileSystemChangeSetExecutionAdapter({
        journalPath: join(stateDirectory, "recovery-journal.bin"),
        slotCapacity: 16 * 1024,
        host: await createNodeFileSystemChangeSetHost({
          basePath: vaultPath,
          stateDirectory,
          referenced: async () => false,
          awaitSemanticEvidence: async () => undefined,
          publishSearchSnapshot: async () => undefined,
        }),
      });
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
          readBinary: execution.readBinary!,
          pathKind: execution.pathKind,
          isContained: async () => true,
        },
        changeSetExecution: execution,
        createBridge: (options) => createBridgeInstance(options),
      });
      liveRuntimes.push(runtime);
      await runtime.load();
      return {
        pid: 61_000 + starts,
        stop: async () => {
          await runtime.unload();
        },
      };
    },
  };
  return { processControl, starts: () => starts };
}

describe("installed-runtime uninstall scenario", () => {
  it(
    "proves offline uninstall, managed-file-only removal, lossless reinstall, and restored Bridge identity",
    { timeout: 60_000 },
    async () => {
      const root = await mkdtemp(join(tmpdir(), "uninstall-scenario-"));
      const candidate = await writeVerifiedBundle(root, "bundle", VERSION);
      const fake = createFakeObsidian();

      const result = await runManagedVaultUninstallScenario({
        candidate,
        obsidianVersion: OBSIDIAN_VERSION,
        workingDirectory: root,
        processControl: fake.processControl,
        runId: "uninstall-scenario-pass",
        timeouts: { startupMs: 10_000, stopMs: 5_000 },
      });

      expect(result.failure).toBeNull();
      expect(result.stages.map((stage) => [stage.stage, stage.outcome])).toEqual([
        ["provision", "passed"],
        ["install_release", "passed"],
        ["operator_enablement", "passed"],
        ["obsidian_start", "passed"],
        ["registration_command", "passed"],
        ["work_through_mcp", "passed"],
        ["obsidian_stop", "passed"],
        ["uninstall", "passed"],
        ["post_uninstall_verification", "passed"],
        ["reinstall", "passed"],
        ["obsidian_restart", "passed"],
        ["restored_bridge_identity", "passed"],
        ["cleanup", "passed"],
      ]);
      expect(result.verdict).toBe("passed");
      // Two real Obsidian starts: the initial Bridge and the post-reinstall one.
      expect(fake.starts()).toBe(2);
      expect(result.uninstall?.outcome).toBe("uninstalled");
      expect(result.reinstall?.outcome).toBe("success");
      expect(result.drainedChangeSetId).toMatch(/^./u);
      expect(result.bridgeIdentity?.vaultId).toMatch(/^[0-9a-f-]{36}$/u);
      expect(result.registrationCommand).toContain("claude mcp add");
      expect(result.registrationRemovalCommand).toBe(
        `claude mcp remove --scope local vault-${result.bridgeIdentity!.vaultId}`,
      );
      expect(result.cleanup).toEqual({ attempted: true, residualPaths: [] });
      await expect(
        stat(join(root, `${TEST_VAULT_DIRECTORY_PREFIX}uninstall-scenario-pass`)),
      ).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it("records a failed stage and still cleans up when the Bridge never persists its identity", async () => {
    const root = await mkdtemp(join(tmpdir(), "uninstall-scenario-"));
    const candidate = await writeVerifiedBundle(root, "bundle", VERSION);
    // A host whose runtime never starts: obsidian_start times out fast and
    // the scenario records the failure yet still cleans up.
    const processControl: ObsidianProcessControl = {
      async start() {
        return { pid: 61_999, stop: async () => undefined };
      },
    };

    const result = await runManagedVaultUninstallScenario({
      candidate,
      obsidianVersion: OBSIDIAN_VERSION,
      workingDirectory: root,
      processControl,
      runId: "uninstall-scenario-no-bridge",
      timeouts: { startupMs: 500, stopMs: 500 },
    });

    expect(result.verdict).toBe("failed");
    expect(result.failure?.stage).toBe("obsidian_start");
    expect(result.stages.at(-1)?.stage).toBe("cleanup");
    expect(result.stages.at(-1)?.outcome).toBe("passed");
  });
});
