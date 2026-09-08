import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createBridgeInstance,
  HealthObservationError,
  ManagedVaultBridgeRuntime,
  ObsidianProcessError,
  parseEvidence,
  provisionTestVault,
  RELEASE_REPOSITORY,
  RELEASE_WORKFLOW_PATH,
  runInstalledRuntimeHarness,
  TEST_VAULT_DIRECTORY_PREFIX,
  type BridgeHealthState,
  type InstalledRuntimeHarnessOptions,
  type LoopbackMcpClient,
  type ObsidianProcessControl,
  type ObservedRuntimeEnvironment,
  type PersistedBridgeSettings,
  type RegisteredRuntimeProfile,
  type RuntimeEnvironmentProbe,
} from "../src/index.js";

const INNER_PROFILE: RegisteredRuntimeProfile = {
  name: "INNER-TEST",
  os: { platform: "linux", build: "inner-build" },
  versions: { obsidian: "0.0.0-inner", electron: "0.0.0-inner", node: "0.0.0-inner" },
  capabilities: ["loopback_http"],
  profileRequirement: "dedicated_candidate_only",
};

const PROFILES = new Map([[INNER_PROFILE.name, INNER_PROFILE]]);

const MATCHING_OBSERVED: ObservedRuntimeEnvironment = {
  platform: "linux",
  osBuild: "inner-build",
  obsidianVersion: "0.0.0-inner",
  electronVersion: "0.0.0-inner",
  nodeVersion: "0.0.0-inner",
  capabilities: ["loopback_http"],
};

function probe(observed: Partial<ObservedRuntimeEnvironment> = {}): RuntimeEnvironmentProbe {
  return { probe: async () => ({ ...MATCHING_OBSERVED, ...observed }) };
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
const CANDIDATE_TAG = "v0.2.0";

async function writeCandidateBundle(
  directory: string,
  options: { corruptChecksum?: boolean; withAttestation?: boolean } = {},
): Promise<void> {
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "manifest.json"), CANDIDATE_MANIFEST, "utf8");
  await writeFile(join(directory, "main.js"), CANDIDATE_MAIN, "utf8");
  const digest = (content: string) => createHash("sha256").update(content, "utf8").digest("hex");
  const lines = [
    `${digest(CANDIDATE_MAIN)}  main.js`,
    `${digest(CANDIDATE_MANIFEST)}  manifest.json`,
  ].sort();
  if (options.corruptChecksum === true) {
    lines[lines.findIndex((line) => line.endsWith("  main.js"))] = `${"0".repeat(64)}  main.js`;
  }
  const checksums = `${lines.join("\n")}\n`;
  await writeFile(join(directory, "checksums.sha256"), checksums, "utf8");
  if (options.withAttestation === false) {
    await rm(`${directory}.attestation.json`, { force: true });
    return;
  }
  {
    // Claims live outside the closed bundle file set, mirroring the GitHub
    // attestation store (issue #196).
    const claims = {
      source: "local-candidate",
      repository: RELEASE_REPOSITORY,
      workflowRef: `${RELEASE_REPOSITORY}/${RELEASE_WORKFLOW_PATH}@refs/tags/${CANDIDATE_TAG}`,
      subjects: [
        ...lines.map((line) => {
          const [subjectDigest, path] = line.split("  ");
          return { name: path, sha256: subjectDigest };
        }),
        { name: "checksums.sha256", sha256: digest(checksums) },
      ].sort((left, right) => left.name!.localeCompare(right.name!)),
    };
    await writeFile(
      `${directory}.attestation.json`,
      `${JSON.stringify(claims, null, 2)}\n`,
      "utf8",
    );
  }
}

/**
 * Fake Obsidian for inner tests: each start() loads the enabled candidate
 * plugin exactly the way the real plugin host would — identity persisted at
 * `.obsidian/plugins/<id>/data.json` — and hosts a real per-Vault Bridge
 * Instance over real loopback Streamable HTTP.
 */
interface FakeObsidianKnobs {
  startError?: ObsidianProcessError;
  stopError?: ObsidianProcessError;
  skipPersist?: boolean;
  forgetOnSecondStart?: boolean;
  leavePortOpenOnStop?: boolean;
}

const liveRuntimes: ManagedVaultBridgeRuntime[] = [];

afterEach(async () => {
  await Promise.all(liveRuntimes.splice(0).map((runtime) => runtime.unload().catch(() => undefined)));
});

function createFakeObsidianProcessControl(
  knobs: FakeObsidianKnobs = {},
): ObsidianProcessControl & { starts: number } {
  let starts = 0;
  return {
    get starts() {
      return starts;
    },
    async start({ vaultPath }) {
      starts += 1;
      if (knobs.startError !== undefined) throw knobs.startError;
      const configDirectory = join(vaultPath, ".obsidian");
      const enabled = JSON.parse(
        await readFile(join(configDirectory, "community-plugins.json"), "utf8"),
      ) as string[];
      const pluginId = enabled[0];
      if (typeof pluginId !== "string") {
        throw new ObsidianProcessError("No enabled candidate plugin", "obsidian_start_failed");
      }
      const dataPath = join(configDirectory, "plugins", pluginId, "data.json");
      let stored: PersistedBridgeSettings | undefined;
      if (knobs.skipPersist !== true && !(knobs.forgetOnSecondStart === true && starts > 1)) {
        try {
          stored = JSON.parse(await readFile(dataPath, "utf8")) as PersistedBridgeSettings;
        } catch {
          stored = undefined;
        }
      }
      const runtime = new ManagedVaultBridgeRuntime({
        vault: { name: basename(vaultPath), path: vaultPath },
        settings: {
          load: async () => stored,
          save: async (settings) => {
            if (knobs.skipPersist === true) return;
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
        pid: 40_000 + starts,
        stop: async () => {
          if (knobs.stopError !== undefined) throw knobs.stopError;
          if (knobs.leavePortOpenOnStop === true) return;
          await runtime.unload();
        },
      };
    },
  };
}

interface RunContext {
  root: string;
  candidate: string;
  options: InstalledRuntimeHarnessOptions;
}

async function arrangeRun(
  runId: string,
  overrides: Partial<InstalledRuntimeHarnessOptions> = {},
): Promise<RunContext> {
  const root = await mkdtemp(join(tmpdir(), "installed-runtime-harness-"));
  const candidate = join(root, "candidate");
  await writeCandidateBundle(candidate);
  const options: InstalledRuntimeHarnessOptions = {
    profileName: INNER_PROFILE.name,
    candidateBundleDirectory: candidate,
    candidateVerification: { expectedTag: CANDIDATE_TAG, expectedPluginId: "candidate-bridge" },
    workingDirectory: root,
    evidencePath: join(root, "evidence", `${runId}.json`),
    probe: probe(),
    processControl: createFakeObsidianProcessControl(),
    profiles: PROFILES,
    runId,
    runPublicWireCorpus: async ({ fixtureSeed }) => ({
      evidence: {
        fixtureSeed: createHash("sha256").update(fixtureSeed, "utf8").digest("hex"),
        canonicalManifestSha256: "a".repeat(64),
        tools: [
          "vault_health",
          "vault_discover",
          "vault_read",
          "vault_continue",
          "vault_change_set_submit",
          "vault_change_set_status",
        ],
        corpus: {
          corpusId: "discovery-reads-continuation",
          seedManifestSha256: "c".repeat(64),
          scenarioManifestSha256: "d".repeat(64),
        },
        beforeInventory: {
          scope: "Notes/*.md",
          entries: [{ path: "Notes/Welcome.md", sha256: "c".repeat(64), sizeBytes: 0 }],
          digest: "e".repeat(64),
        },
        afterInventory: {
          scope: "Notes/*.md",
          entries: [{ path: "Notes/Welcome.md", sha256: "c".repeat(64), sizeBytes: 0 }],
          digest: "e".repeat(64),
        },
        retainedByteCleanup: {
          chainsIssued: 1,
          chainsConsumed: 1,
          replayAfterConsumptionRejected: 1,
          bytesReconstructed: 0,
          residualChains: 0,
        },
        eventLog: [
          {
            sequence: 1,
            kind: "assertion",
            name: "stubbed-public-wire-corpus",
            detailSha256: "b".repeat(64),
          },
        ],
        assertions: ["stubbed-public-wire-corpus"],
        verdict: "passed",
      },
    }),
    runChangeSetCorpus: async ({ seedNotes, record, assertion }) => {
      const seeded =
        seedNotes.find(({ path }) => path === "Notes/Welcome.md")?.content ?? "";
      const digest = createHash("sha256").update(seeded, "utf8").digest("hex");
      const entries = [{ path: "Notes/Welcome.md", sha256: digest, sizeBytes: 0 }];
      record("assertion", "stubbed-change-set-corpus-began", {
        corpusId: "change-set-submission-proof",
      });
      record("cleanup", "change-set-idle-state", {
        recoveryState: "none",
        queueLength: 0,
        currentExecutionId: null,
        writeGate: "open",
      });
      assertion("stubbed-change-set-corpus");
      return {
        scenarioManifestSha256: "d".repeat(64),
        seedInventoryDigest: digest,
        beforeInventory: entries,
        afterInventory: entries,
        replayKeys: [
          {
            submissionKey: "cs-proof-valid-create",
            input: {
              submissionKey: "cs-proof-valid-create",
              operations: [
                {
                  operationId: "valid-create",
                  kind: "create_note",
                  path: "ChangeSetProof/Welcome.md",
                  content: "# stub\n",
                  ifExists: "reject",
                },
              ],
            },
          },
        ],
        submissions: [
          {
            submissionKeySha256: "b".repeat(64),
            changeSetId: "change-set-1",
            state: "intent_applied",
            failureCode: null,
            executed: true,
          },
        ],
        rejectionClasses: [
          { name: "rejection/stale-direct-target", failureCode: "stale_observation" },
        ],
        fifoReport: {
          concurrentSubmissions: 1,
          applied: 1,
          distinctChangeSetIds: 1,
          contendedTarget: {
            submissions: 2,
            winners: 1,
            rejected: 1,
            noPartialMutation: true,
          },
        },
        recoveryClasses: [{ name: "recovery/missing-response" }],
        immutableRecords: [
          {
            submissionKeySha256: "b".repeat(64),
            changeSetId: "change-set-1",
            state: "intent_applied",
            requestedEffectIds: ["valid-create"],
            derivedEffectIds: [],
            pathCount: 2,
          },
        ],
        residualCleanup: {
          recoveryState: "none",
          queueLength: 0,
          currentExecutionId: null,
          writeGate: "open",
        },
        assertions: ["stubbed-change-set-corpus"],
      };
    },
    runChangeSetReplay: async ({ record, assertion }) => {
      record("assertion", "stubbed-change-set-replay-began", {
        keys: 1,
      });
      assertion("stubbed-change-set-replay");
      return {
        replayReport: {
          keysReplayed: 1,
          identitiesPreserved: 1,
          recordsUnchanged: 1,
          conflictingReusesRejected: 1,
        },
        assertions: ["stubbed-change-set-replay"],
      };
    },
    timeouts: { startupMs: 5_000, stopMs: 5_000, portClosedMs: 2_000 },
    ...overrides,
  };
  return { root, candidate, options };
}

describe("installed-runtime harness orchestration", () => {
  it("proves candidate load, health, restart, and cleanup with passing evidence", async () => {
    const { root, options } = await arrangeRun("run-pass");
    const processControl = options.processControl as ReturnType<
      typeof createFakeObsidianProcessControl
    >;

    const result = await runInstalledRuntimeHarness(options);

    expect(result.verdict).toBe("passed");
    expect(result.failure).toBeNull();
    expect(processControl.starts).toBe(2);

    const evidence = parseEvidence(await readFile(result.evidencePath, "utf8"));
    expect(evidence).toEqual(result.evidence);
    expect(evidence.profile.name).toBe(INNER_PROFILE.name);
    expect(evidence.profile.mismatches).toEqual([]);
    expect(evidence.candidate?.pluginId).toBe("candidate-bridge");
    expect(evidence.bridgeIdentity?.vaultId).toMatch(/^[0-9a-f-]{36}$/u);
    expect(evidence.observations.map((observation) => observation.phase)).toEqual([
      "initial",
      "after_restart",
    ]);
    expect(evidence.beforeInventory?.map((entry) => entry.path)).toContain(
      ".obsidian/plugins/candidate-bridge/main.js",
    );
    expect(evidence.inventoryComparison).not.toBeNull();
    expect(evidence.publicWireCorpus?.verdict).toBe("passed");
    expect(evidence.changeSetCorpus?.verdict).toBe("passed");
    expect(evidence.changeSetCorpus?.corpusId).toBe("change-set-submission-proof");
    expect(evidence.changeSetCorpus?.replay.keysReplayed).toBeGreaterThan(0);
    expect(evidence.cleanup).toEqual({ attempted: true, residualPaths: [] });

    // The generated roots are gone and nothing private leaked into evidence.
    await expect(
      stat(join(root, `${TEST_VAULT_DIRECTORY_PREFIX}run-pass`)),
    ).rejects.toMatchObject({ code: "ENOENT" });
    const serialized = await readFile(result.evidencePath, "utf8");
    expect(serialized).not.toContain(root);
    expect(serialized).not.toContain("This generated note seeds the dedicated test Vault");
  });

  it("keeps the Bridge identity stable across the controlled restart", async () => {
    const { options } = await arrangeRun("run-stable");
    const result = await runInstalledRuntimeHarness(options);
    expect(result.verdict).toBe("passed");
    const [initial, restarted] = result.evidence.observations;
    expect(initial).toBeDefined();
    expect(restarted).toBeDefined();
    expect(result.evidence.bridgeIdentity?.vaultId).toMatch(/^.+$/u);
    expect(initial?.healthSha256).toMatch(/^[a-f0-9]{64}$/u);
  });
});

describe("installed-runtime harness failure projection", () => {
  it("records invalid evidence for an unregistered profile", async () => {
    const { root, options } = await arrangeRun("run-unregistered", {
      profileName: "NOT-REGISTERED",
    });
    const result = await runInstalledRuntimeHarness(options);
    expect(result.verdict).toBe("invalid");
    expect(result.failure).toMatchObject({
      stage: "preflight",
      code: "unregistered_profile",
    });
    const evidence = parseEvidence(await readFile(result.evidencePath, "utf8"));
    expect(evidence.verdict).toBe("invalid");
    expect(evidence.observations).toEqual([]);
    expect(await readFile(result.evidencePath, "utf8")).not.toContain(root);
  });

  it("records invalid evidence when the probed host mismatches the registered profile", async () => {
    const { options } = await arrangeRun("run-mismatch", {
      probe: probe({ nodeVersion: "22.0.0", capabilities: [] }),
    });
    const result = await runInstalledRuntimeHarness(options);
    expect(result.verdict).toBe("invalid");
    expect(result.failure).toMatchObject({ stage: "preflight", code: "profile_mismatch" });
    expect(result.evidence.profile.mismatches).toEqual([
      { field: "versions.node", expected: "0.0.0-inner", actual: "22.0.0" },
      { field: "capabilities", expected: "loopback_http", actual: "" },
    ]);
  });

  it("records invalid evidence when the profile probe itself fails", async () => {
    const { options } = await arrangeRun("run-probe-fails", {
      probe: {
        probe: async () => {
          throw new Error("probe transport down");
        },
      },
    });
    const result = await runInstalledRuntimeHarness(options);
    expect(result.verdict).toBe("invalid");
    expect(result.failure).toMatchObject({ stage: "preflight", code: "profile_probe_failed" });
    expect(result.evidence.profile.observed).toBeNull();
  });

  it("refuses to overwrite an existing Vault root", async () => {
    const { root, options } = await arrangeRun("run-existing");
    await provisionTestVault({ workingDirectory: root, runId: "run-existing" });
    const result = await runInstalledRuntimeHarness(options);
    expect(result.verdict).toBe("invalid");
    expect(result.failure).toMatchObject({ stage: "provision", code: "vault_root_exists" });
    // The pre-existing root was left untouched: no cleanup deletion, no evidence of removal.
    expect(result.evidence.cleanup).toBeNull();
    await stat(join(root, `${TEST_VAULT_DIRECTORY_PREFIX}run-existing`));
  });

  it("records invalid evidence for a candidate that fails integrity verification", async () => {
    const { root, candidate, options } = await arrangeRun("run-corrupt-candidate");
    await writeCandidateBundle(candidate, { corruptChecksum: true });
    const result = await runInstalledRuntimeHarness(options);
    expect(result.verdict).toBe("invalid");
    expect(result.failure).toMatchObject({
      stage: "candidate",
      code: "candidate_checksum_mismatch",
    });
    expect(result.evidence.candidate).toBeNull();
    await expect(stat(join(root, `${TEST_VAULT_DIRECTORY_PREFIX}run-corrupt-candidate`))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("records invalid evidence for a candidate without attestation claims", async () => {
    const { root, candidate, options } = await arrangeRun("run-unattested-candidate");
    await writeCandidateBundle(candidate, { withAttestation: false });
    const result = await runInstalledRuntimeHarness(options);
    expect(result.verdict).toBe("invalid");
    expect(result.failure).toMatchObject({
      stage: "candidate",
      code: "release_attestation_absent",
    });
    expect(result.evidence.candidate).toBeNull();
    await expect(stat(join(root, `${TEST_VAULT_DIRECTORY_PREFIX}run-unattested-candidate`))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("records failed evidence when Obsidian cannot start", async () => {
    const { options } = await arrangeRun("run-start-fails", {
      processControl: createFakeObsidianProcessControl({
        startError: new ObsidianProcessError("spawn ENOENT", "obsidian_start_failed"),
      }),
    });
    const result = await runInstalledRuntimeHarness(options);
    expect(result.verdict).toBe("failed");
    expect(result.failure).toMatchObject({
      stage: "obsidian_start",
      code: "obsidian_start_failed",
    });
    expect(result.evidence.cleanup).toEqual({ attempted: true, residualPaths: [] });
  });

  it("records invalid evidence when residual content survives after an earlier failure", async () => {
    const { options } = await arrangeRun("run-residual-after-failure", {
      processControl: createFakeObsidianProcessControl({
        startError: new ObsidianProcessError("spawn ENOENT", "obsidian_start_failed"),
      }),
      cleanupVault: async () => ({ attempted: true, residualPaths: ["Notes/Welcome.md"] }),
    });
    const result = await runInstalledRuntimeHarness(options);
    // The residual content invalidates the run even though a candidate-class
    // failure was recorded first; a failed verdict would hide the residue.
    expect(result.verdict).toBe("invalid");
    expect(result.evidence.cleanup).toEqual({
      attempted: true,
      residualPaths: ["Notes/Welcome.md"],
    });
  });

  it("records failed evidence when the Bridge never becomes ready", async () => {
    const { options } = await arrangeRun("run-no-readiness", {
      processControl: createFakeObsidianProcessControl({ skipPersist: true }),
      timeouts: { startupMs: 600, stopMs: 2_000, portClosedMs: 1_000 },
    });
    const result = await runInstalledRuntimeHarness(options);
    expect(result.verdict).toBe("failed");
    expect(result.failure).toMatchObject({
      stage: "bridge_readiness",
      code: "bridge_readiness_timeout",
    });
  });

  it("records failed evidence when the health result is schema-invalid", async () => {
    const client: LoopbackMcpClient = {
      observeHealth: async () => {
        throw new HealthObservationError("schema rejected", "health_schema_invalid");
      },
    };
    const { options } = await arrangeRun("run-bad-health", { client });
    const result = await runInstalledRuntimeHarness(options);
    expect(result.verdict).toBe("failed");
    expect(result.failure).toMatchObject({
      stage: "health_initial",
      code: "health_schema_invalid",
    });
  });

  it("records failed evidence when the connected Bridge belongs to another Vault", async () => {
    const client: LoopbackMcpClient = {
      observeHealth: async () => {
        throw new HealthObservationError("wrong vault", "identity_mismatch");
      },
    };
    const { options } = await arrangeRun("run-wrong-vault", { client });
    const result = await runInstalledRuntimeHarness(options);
    expect(result.verdict).toBe("failed");
    expect(result.failure).toMatchObject({
      stage: "health_initial",
      code: "identity_mismatch",
    });
  });

  it("records failed evidence when the Bridge identity changes across restart", async () => {
    const { options } = await arrangeRun("run-identity-flip", {
      processControl: createFakeObsidianProcessControl({ forgetOnSecondStart: true }),
    });
    const result = await runInstalledRuntimeHarness(options);
    expect(result.verdict).toBe("failed");
    expect(result.failure).toMatchObject({
      stage: "health_restart",
      code: "restart_identity_mismatch",
    });
    expect(result.evidence.observations.map((observation) => observation.phase)).toEqual([
      "initial",
    ]);
  });

  it("records failed evidence when the Bridge listener survives the controlled stop", async () => {
    const { options } = await arrangeRun("run-port-survives", {
      processControl: createFakeObsidianProcessControl({ leavePortOpenOnStop: true }),
      timeouts: { startupMs: 5_000, stopMs: 2_000, portClosedMs: 400 },
    });
    const result = await runInstalledRuntimeHarness(options);
    expect(result.verdict).toBe("failed");
    expect(result.failure).toMatchObject({
      stage: "obsidian_stop",
      code: "bridge_still_reachable",
    });
  });

  it("records failed evidence when the controlled stop itself fails", async () => {
    const { options } = await arrangeRun("run-stop-fails", {
      processControl: createFakeObsidianProcessControl({
        stopError: new ObsidianProcessError("taskkill refused", "obsidian_stop_failed"),
      }),
      timeouts: { startupMs: 5_000, stopMs: 500, portClosedMs: 300 },
    });
    const result = await runInstalledRuntimeHarness(options);
    expect(result.verdict).toBe("failed");
    expect(result.failure).toMatchObject({
      stage: "obsidian_stop",
      code: "obsidian_stop_failed",
    });
  });

  it("records invalid evidence, not a green skip, when residual test content survives cleanup", async () => {
    const { options } = await arrangeRun("run-residual", {
      cleanupVault: async () => ({ attempted: true, residualPaths: ["Notes/Welcome.md"] }),
    });
    const result = await runInstalledRuntimeHarness(options);
    expect(result.verdict).toBe("invalid");
    expect(result.failure).toMatchObject({
      stage: "cleanup",
      code: "residual_test_content",
    });
    expect(result.evidence.observations).toHaveLength(2);
  });

  it("records invalid evidence when cleanup itself fails", async () => {
    const { options } = await arrangeRun("run-cleanup-fails", {
      cleanupVault: async () => {
        throw new Error("permission denied");
      },
    });
    const result = await runInstalledRuntimeHarness(options);
    expect(result.verdict).toBe("invalid");
    expect(result.failure).toMatchObject({ stage: "cleanup", code: "cleanup_failed" });
  });

  it("records invalid evidence when the inventory snapshot fails", async () => {
    const { options } = await arrangeRun("run-inventory-fails", {
      snapshotVaultInventory: async () => {
        throw new Error("inventory unreadable");
      },
    });
    const result = await runInstalledRuntimeHarness(options);
    expect(result.verdict).toBe("invalid");
    expect(result.failure).toMatchObject({ stage: "inventory_before", code: "inventory_failed" });
  });

  it("never overwrites an existing evidence record", async () => {
    const { options } = await arrangeRun("run-evidence-exists");
    await mkdir(join(options.evidencePath, ".."), { recursive: true });
    await writeFile(options.evidencePath, "previous evidence", "utf8");
    await expect(runInstalledRuntimeHarness(options)).rejects.toMatchObject({
      name: "EvidenceWriteError",
    });
    expect(await readFile(options.evidencePath, "utf8")).toBe("previous evidence");
  });
});
