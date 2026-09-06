import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createBridgeInstance,
  ManagedVaultBridgeRuntime,
  RELEASE_MANAGED_CHECKSUM_FILE,
  RELEASE_REPOSITORY,
  RELEASE_WORKFLOW_PATH,
  runLifecycleInstallScenario,
  TEST_VAULT_DIRECTORY_PREFIX,
  verifyReleaseBundle,
  type ObsidianProcessControl,
  type PersistedBridgeSettings,
} from "../src/index.js";

const PLUGIN_ID = "scenario-bridge";
const PLUGIN_VERSION = "0.5.0";
const TAG = `v${PLUGIN_VERSION}`;
const MANIFEST = `${JSON.stringify(
  {
    id: PLUGIN_ID,
    name: "Scenario Bridge",
    version: PLUGIN_VERSION,
    minAppVersion: "1.13.4",
    isDesktopOnly: true,
  },
  null,
  2,
)}\n`;
const MAIN_JS = "// scenario candidate main\n";
const OBSIDIAN_VERSION = "1.13.4";

const digest = (content: string): string =>
  createHash("sha256").update(content, "utf8").digest("hex");

async function writeVerifiedBundle(root: string) {
  const bundleDirectory = join(root, "bundle");
  await mkdir(bundleDirectory, { recursive: true });
  await writeFile(join(bundleDirectory, "manifest.json"), MANIFEST, "utf8");
  await writeFile(join(bundleDirectory, "main.js"), MAIN_JS, "utf8");
  const lines = [`${digest(MAIN_JS)}  main.js`, `${digest(MANIFEST)}  manifest.json`].sort();
  const checksums = `${lines.join("\n")}\n`;
  await writeFile(join(bundleDirectory, RELEASE_MANAGED_CHECKSUM_FILE), checksums, "utf8");
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
  await writeFile(
    `${bundleDirectory}.attestation.json`,
    `${JSON.stringify(claims, null, 2)}\n`,
    "utf8",
  );
  return verifyReleaseBundle({
    bundleDirectory,
    expectedTag: TAG,
    expectedPluginId: PLUGIN_ID,
  });
}

/**
 * Fake Obsidian for the scenario: each start() loads the enabled candidate
 * plugin the way the real plugin host would and hosts a real per-Vault
 * Bridge Instance over loopback Streamable HTTP.
 */
const liveRuntimes: ManagedVaultBridgeRuntime[] = [];

afterEach(async () => {
  await Promise.all(liveRuntimes.splice(0).map((runtime) => runtime.unload().catch(() => undefined)));
});

function createFakeObsidianProcessControl(): ObsidianProcessControl {
  let starts = 0;
  return {
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
        createBridge: (options) => createBridgeInstance(options),
      });
      liveRuntimes.push(runtime);
      await runtime.load();
      return {
        pid: 50_000 + starts,
        stop: async () => {
          await runtime.unload();
        },
      };
    },
  };
}

describe("installed-runtime lifecycle scenario", () => {
  it("proves first install, enablement, registration, repair, and cleanup", async () => {
    const root = await mkdtemp(join(tmpdir(), "lifecycle-scenario-"));
    const candidate = await writeVerifiedBundle(root);

    const result = await runLifecycleInstallScenario({
      candidate,
      obsidianVersion: OBSIDIAN_VERSION,
      workingDirectory: root,
      processControl: createFakeObsidianProcessControl(),
      runId: "lifecycle-scenario-pass",
      timeouts: { startupMs: 5_000, stopMs: 5_000 },
    });

    expect(result.verdict).toBe("passed");
    expect(result.failure).toBeNull();
    expect(result.stages.map((stage) => [stage.stage, stage.outcome])).toEqual([
      ["provision", "passed"],
      ["status_not_installed", "passed"],
      ["first_install", "passed"],
      ["status_installed_not_enabled", "passed"],
      ["operator_enablement", "passed"],
      ["status_bridge_offline", "passed"],
      ["obsidian_start", "passed"],
      ["status_mcp_not_registered", "passed"],
      ["registration_command", "passed"],
      ["status_ready", "passed"],
      ["reinstall_unchanged", "passed"],
      ["damage_and_repair", "passed"],
      ["state_preservation", "passed"],
      ["identity_mismatch_projection", "passed"],
      ["obsidian_stop", "passed"],
      ["cleanup", "passed"],
    ]);
    // First install deployed artifacts only; the remaining steps are the operator's.
    expect(result.install?.deployment?.state).toBe("artifacts_installed");
    // The registration command was generated for the operator, never executed.
    expect(result.registrationCommand).toContain("claude mcp add");
    expect(result.registrationCommand).toContain(`vault-${result.bridgeIdentity?.vaultId ?? ""}`);
    // Repair restored exactly the damaged managed file; identity survived.
    expect(result.repair?.action).toBe("repaired");
    expect(result.repair?.repairedFiles).toEqual(["main.js"]);
    expect(result.bridgeIdentity?.vaultId).toMatch(/^[0-9a-f-]{36}$/u);
    expect(result.cleanup).toEqual({ attempted: true, residualPaths: [] });
    await expect(
      stat(join(root, `${TEST_VAULT_DIRECTORY_PREFIX}lifecycle-scenario-pass`)),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("records a failed stage and still cleans up when the Bridge never starts", async () => {
    const root = await mkdtemp(join(tmpdir(), "lifecycle-scenario-"));
    const candidate = await writeVerifiedBundle(root);
    const silentObsidian: ObsidianProcessControl = {
      start: async () => ({ pid: 59_000, stop: async () => undefined }),
    };

    const result = await runLifecycleInstallScenario({
      candidate,
      obsidianVersion: OBSIDIAN_VERSION,
      workingDirectory: root,
      processControl: silentObsidian,
      runId: "lifecycle-scenario-silent",
      timeouts: { startupMs: 500, stopMs: 500 },
    });

    expect(result.verdict).toBe("failed");
    expect(result.failure?.stage).toBe("obsidian_start");
    expect(result.stages.at(-1)?.stage).toBe("cleanup");
    expect(result.stages.at(-1)?.outcome).toBe("passed");
  });
});
