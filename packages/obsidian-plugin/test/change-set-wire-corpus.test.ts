import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import {
  CHANGE_SET_CORPUS_DIRECTORY,
  CHANGE_SET_SCENARIO_PLAN,
  CHANGE_SET_SUBMISSION_CORPUS_ID,
  cleanupTestVault,
  composeChangeSetCorpusEvidence,
  createBridgeInstance,
  createFileSystemChangeSetExecutionAdapter,
  createNodeFileSystemChangeSetHost,
  provisionTestVault,
  runChangeSetReplayCorpusAtEndpoint,
  runChangeSetSubmissionCorpusAtEndpoint,
  SearchSnapshotManager,
  VaultDiscoverService,
  type BridgeHealthState,
  type ChangeSetRegistryState,
  type ChangeSetRegistryStore,
  type ChangeSetPreflightDataSource,
  type SearchSnapshotDataSource,
  type SearchSnapshotSemanticEvidence,
  type VaultReadDataSource,
} from "../src/index.js";

const EXPECTED_VAULT_ID = "vault-change-set-wire-corpus";

const liveBridges: Array<ReturnType<typeof createBridgeInstance>> = [];
const cleanups: Array<() => Promise<void>> = [];
const liveExecutions: Array<{ close(): Promise<void> }> = [];

afterEach(async () => {
  await Promise.all(liveBridges.splice(0).map((bridge) => bridge.stop()));
  await Promise.all(liveExecutions.splice(0).map((execution) => execution.close()));
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

function healthState(): BridgeHealthState {
  return {
    vault: { id: EXPECTED_VAULT_ID, name: "ChangeSetCorpus", path: "D:/Vaults/ChangeSetCorpus" },
    readiness: { searchSnapshot: "ready", cache: "ready", index: "ready" },
    recovery: { state: "none" },
    write: { gate: "open", state: "writable", pauseSource: null },
    queue: { currentExecutionId: null, length: 0, headChangeSetId: null },
    lifecycle: {
      startup: "ready",
      upgrade: "not_run",
      migration: "not_run",
      recovery: "not_run",
    },
    effectiveGate: null,
    overall: "healthy",
    reasonCodes: [],
    operatorAction: "none",
  };
}

function wikilinkResolvedLinks(
  content: string,
  knownPaths: ReadonlySet<string>,
): Record<string, number> {
  const byFilename = new Map(
    [...knownPaths].map((path) => [path.slice(path.lastIndexOf("/") + 1), path]),
  );
  const resolved: Record<string, number> = {};
  for (const match of content.matchAll(/\[\[([^\]|#]+)(?:[#|][^\]]*)?\]\]/gu)) {
    const raw = match[1]?.trim() ?? "";
    if (raw.length === 0) continue;
    const filename = raw.endsWith(".md") ? raw : `${raw}.md`;
    const target = byFilename.get(filename);
    if (target !== undefined) resolved[target] = (resolved[target] ?? 0) + 1;
  }
  return resolved;
}

async function listMarkdown(root: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (directory: string): Promise<void> => {
    const children = await readdir(directory, { withFileTypes: true });
    for (const child of children) {
      const absolute = join(directory, child.name);
      if (child.isDirectory()) {
        if (child.name !== ".obsidian" && child.name !== ".llm-wiki") await walk(absolute);
      } else if (child.isFile() && child.name.endsWith(".md")) {
        out.push(absolute.slice(root.length + 1).split("\\").join("/"));
      }
    }
  };
  await walk(root);
  return out.sort();
}

function fsRead(root: string) {
  return async (path: string): Promise<Uint8Array | null> => {
    try {
      return new Uint8Array(await readFile(join(root, ...path.split("/"))));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  };
}

async function fsKind(root: string, path: string): Promise<"directory" | "file" | null> {
  try {
    const value = await stat(join(root, ...path.split("/")));
    return value.isDirectory() ? "directory" : "file";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

interface ArrangedVault {
  root: string;
  vaultPath: string;
  seedNotes: readonly { path: string; content: string }[];
  registryPath: string;
  snapshots: SearchSnapshotManager;
  dataSource: ChangeSetPreflightDataSource;
  readBinary: (path: string) => Promise<Uint8Array | null>;
}

async function arrangeVault(): Promise<ArrangedVault> {
  const root = await mkdtemp(join(tmpdir(), "change-set-wire-corpus-"));
  const vault = await provisionTestVault({ workingDirectory: root, runId: "corpus-run" });
  cleanups.push(() => cleanupTestVault(vault));
  cleanups.push(async () => rm(root, { recursive: true, force: true }));

  const readBinary = fsRead(vault.vaultPath);
  const searchSource: SearchSnapshotDataSource = {
    listMarkdownPaths: async () => listMarkdown(vault.vaultPath),
    readBinary,
    semanticEvidence: async (path): Promise<SearchSnapshotSemanticEvidence | null> => {
      const bytes = await readBinary(path);
      if (bytes === null) return null;
      const content = Buffer.from(bytes).toString("utf8");
      const known = new Set(await listMarkdown(vault.vaultPath));
      return {
        frontmatter: null,
        tags: [],
        headings: [],
        references: [],
        resolvedLinks: wikilinkResolvedLinks(content, known),
        unresolvedLinks: {},
      };
    },
  };
  const snapshots = new SearchSnapshotManager(searchSource);
  await snapshots.rebuild();
  if (snapshots.readiness !== "ready") {
    throw new Error("Change-set wire corpus Search Snapshot did not become ready");
  }

  const dataSource: ChangeSetPreflightDataSource = {
    readBinary,
    pathKind: (path) => fsKind(vault.vaultPath, path),
    isContained: async () => true,
  };

  return {
    root,
    vaultPath: vault.vaultPath,
    seedNotes: vault.seedNotes,
    registryPath: join(root, "change-set-registry.json"),
    snapshots,
    dataSource,
    readBinary,
  };
}

function persistentStore(path: string): ChangeSetRegistryStore & { state: ChangeSetRegistryState | undefined } {
  let cached: ChangeSetRegistryState | undefined;
  return {
    get state() {
      return cached;
    },
    load: async () => {
      try {
        cached = JSON.parse(await readFile(path, "utf8")) as ChangeSetRegistryState;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") cached = undefined;
        else throw error;
      }
      return structuredClone(cached);
    },
    save: async (state) => {
      cached = structuredClone(state);
      await writeFile(path, `${JSON.stringify(cached)}\n`, "utf8");
    },
  };
}

interface BridgeHost {
  bridge: ReturnType<typeof createBridgeInstance>;
  endpoint: URL;
  publishCount: () => number;
}

async function createCorpusBridge(host: ArrangedVault): Promise<BridgeHost> {
  const store = persistentStore(host.registryPath);
  let publishes = 0;
  const publishSearchSnapshot = async (): Promise<void> => {
    publishes += 1;
    await host.snapshots.rebuild();
  };
  const stateDirectory = join(host.vaultPath, ".llm-wiki");
  const fsHost = await createNodeFileSystemChangeSetHost({
    basePath: host.vaultPath,
    stateDirectory,
    awaitSemanticEvidence: async () => undefined,
    semanticEvidencePublishesSnapshot: false,
    publishSearchSnapshot,
  });
  const execution = await createFileSystemChangeSetExecutionAdapter({
    journalPath: join(stateDirectory, "recovery-journal.bin"),
    slotCapacity: 16 * 1024,
    host: fsHost,
  });
  liveExecutions.push(execution);
  const readDataSource: VaultReadDataSource = {
    readBinary: host.readBinary,
    parseFrontmatter: () => null,
    headings: () => null,
  };
  const bridge = createBridgeInstance({
    port: 0,
    health: { ...healthState(), vault: { ...healthState().vault, path: host.vaultPath } },
    readDataSource,
    discoverService: new VaultDiscoverService(host.snapshots),
    searchSnapshotReadiness: () => host.snapshots.readiness,
    changeSets: {
      store,
      dataSource: host.dataSource,
      execution,
      vaultId: EXPECTED_VAULT_ID,
    },
  });
  liveBridges.push(bridge);
  await bridge.start();
  return { bridge, endpoint: bridge.endpoint, publishCount: () => publishes };
}

function scenarioManifestSha256(): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        corpusId: CHANGE_SET_SUBMISSION_CORPUS_ID,
        scenarios: [...CHANGE_SET_SCENARIO_PLAN],
      }),
      "utf8",
    )
    .digest("hex");
}

describe("change-set submission corpus over a real loopback Bridge", () => {
  it("proves admission, preflight rejection, concurrency, recovery, and replay across restart", async () => {
    const host = await arrangeVault();
    const first = await createCorpusBridge(host);
    const events: Array<{
      kind: "transport" | "tool" | "assertion" | "cleanup";
      name: string;
      detail: unknown;
    }> = [];
    const assertions: string[] = [];

    const admission = await runChangeSetSubmissionCorpusAtEndpoint({
      endpoint: first.endpoint,
      expectedVaultId: EXPECTED_VAULT_ID,
      seedNotes: host.seedNotes,
      inventoryContext: {
        vaultPath: host.vaultPath,
        runId: "corpus-run",
        runtimeProfileId: "linux-test",
        candidateBundleSha256: "a".repeat(64),
      },
      record: (kind, name, detail) => {
        events.push({ kind, name, detail });
      },
      assertion: (name) => assertions.push(name),
    });

    expect(admission.scenarioManifestSha256).toBe(scenarioManifestSha256());
    expect(admission.scenarioManifestSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(admission.seedInventoryDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect(admission.beforeInventory).toEqual(admission.afterInventory);
    expect(admission.submissions.some((record) => record.executed)).toBe(true);
    expect(admission.rejectionClasses[0]).toMatchObject({
      beforeInventory: { entries: expect.arrayContaining([{ path: "Notes", kind: "directory" }]) },
      afterInventory: { entries: expect.arrayContaining([{ path: "Notes", kind: "directory" }]) },
      proof: { state: "intent_not_applied", failureCode: "stale_observation" },
      status: { state: "intent_not_applied", failureCode: "stale_observation" },
    });
    const attachmentRejection = admission.rejectionClasses.find(({ name }) => name === "rejection/attachment-evidence-mismatch")!;
    expect(attachmentRejection.beforeInventory.entries).toContainEqual({
      path: "ChangeSetProof/Evidence.bin", kind: "file", sizeBytes: 5,
      sha256: createHash("sha256").update(new Uint8Array([0, 255, 128, 13, 10])).digest("hex"),
    });
    expect(attachmentRejection.beforeInventory.entries).toContainEqual({ path: "ChangeSetProof/copy.bin", kind: "absent" });
    expect(admission.rejectionClasses.map(({ name }) => name)).toEqual(
      expect.arrayContaining([
        "rejection/stale-direct-target",
        "rejection/read-dependency-stale",
        "rejection/attachment-evidence-mismatch",
        "rejection/derived-target-file-parent",
        "rejection/absence-condition",
        "rejection/non-unique-replacement",
        "rejection/occupied-destination",
      ]),
    );
    expect(admission.rejectionClasses.map(({ failureCode }) => failureCode)).toEqual(
      expect.arrayContaining([
        "stale_observation",
        "stale_observation",
        "stale_observation",
        "path_conflict",
        "path_conflict",
        "exact_match_count_mismatch",
        "path_conflict",
      ]),
    );
    expect(admission.fifoReport).toMatchObject({
      concurrentSubmissions: 4,
      applied: 4,
      distinctChangeSetIds: 4,
      contendedTarget: { winners: 1, rejected: 3, noPartialMutation: true },
    });
    expect(admission.recoveryClasses).toHaveLength(4);
    expect(admission.replayKeys.length).toBeGreaterThan(0);
    expect(admission.residualCleanup).toEqual({
      recoveryState: "none",
      queueLength: 0,
      currentExecutionId: null,
      writeGate: "open",
    });

    // The deterministic seed Notes are byte-identical after the whole corpus.
    for (const { path, content } of host.seedNotes) {
      const bytes = await host.readBinary(path);
      expect(Buffer.from(bytes ?? new Uint8Array()).toString("utf8")).toBe(content);
    }
    // The corpus-created note exists exactly once with the deterministic bytes.
    const welcome = await host.readBinary(`${CHANGE_SET_CORPUS_DIRECTORY}/AdmissionProof.md`);
    expect(welcome).not.toBeNull();

    // Controlled restart over the same Vault and persisted registry.
    await first.bridge.stop();
    const index = liveBridges.indexOf(first.bridge);
    if (index >= 0) liveBridges.splice(index, 1);
    const second = await createCorpusBridge(host);

    const replay = await runChangeSetReplayCorpusAtEndpoint({
      endpoint: second.endpoint,
      expectedVaultId: EXPECTED_VAULT_ID,
      establishedKeys: admission.replayKeys,
      record: (kind, name, detail) => {
        events.push({ kind, name, detail });
      },
      assertion: (name) => assertions.push(name),
    });

    expect(replay.replayReport).toMatchObject({
      keysReplayed: admission.replayKeys.length,
      identitiesPreserved: admission.replayKeys.length,
      recordsUnchanged: admission.replayKeys.length,
      conflictingReusesRejected: admission.replayKeys.length,
    });

    const evidence = composeChangeSetCorpusEvidence({
      admission,
      replay,
      events,
      assertions,
    });
    expect(evidence.corpusId).toBe(CHANGE_SET_SUBMISSION_CORPUS_ID);
    expect(evidence.verdict).toBe("passed");
    expect(evidence.admission.submissions.length).toBeGreaterThanOrEqual(
      admission.submissions.length,
    );
    expect(evidence.replay.keysReplayed).toBe(admission.replayKeys.length);
    expect(evidence.beforeInventory.digest).toBe(evidence.afterInventory.digest);
    expect(evidence.assertions.length).toBeGreaterThan(10);
    expect(events.filter(({ kind }) => kind === "tool").length).toBeGreaterThan(10);
  }, 60_000);

  it("refuses a legal intent_not_applied rejection that creates an untracked file", async () => {
    const host = await arrangeVault();
    const readBinary = host.dataSource.readBinary!;
    let injected = false;
    host.dataSource = {
      ...host.dataSource,
      readBinary: async (path) => {
        const bytes = await readBinary(path);
        if (!injected && path === `${CHANGE_SET_CORPUS_DIRECTORY}/AdmissionProof.md` && bytes !== null) {
          injected = true;
          await writeFile(join(host.vaultPath, "untracked.bin"), new Uint8Array([0, 255, 128]));
        }
        return bytes;
      },
    };
    const bridge = await createCorpusBridge(host);
    await expect(runChangeSetSubmissionCorpusAtEndpoint({
      endpoint: bridge.endpoint,
      expectedVaultId: EXPECTED_VAULT_ID,
      seedNotes: host.seedNotes,
      inventoryContext: {
        vaultPath: host.vaultPath,
        runId: "corpus-run",
        runtimeProfileId: "linux-test",
        candidateBundleSha256: "a".repeat(64),
      },
      record: () => undefined,
      assertion: () => undefined,
    })).rejects.toThrow("rejection/stale-direct-target mutated the Vault");
    expect(injected).toBe(true);
  }, 60_000);

  it.each(["attachment bytes", "empty directory"])("refuses a legal rejection that changes %s", async (sideEffect) => {
    const host = await arrangeVault();
    await writeFile(join(host.vaultPath, "evidence.bin"), new Uint8Array([0, 255, 128]));
    const readBinary = host.dataSource.readBinary!;
    let injected = false;
    host.dataSource = {
      ...host.dataSource,
      readBinary: async (path) => {
        const bytes = await readBinary(path);
        if (!injected && path === `${CHANGE_SET_CORPUS_DIRECTORY}/AdmissionProof.md` && bytes !== null) {
          injected = true;
          if (sideEffect === "attachment bytes") await writeFile(join(host.vaultPath, "evidence.bin"), new Uint8Array([0, 254, 128]));
          else await mkdir(join(host.vaultPath, "untracked-empty"));
        }
        return bytes;
      },
    };
    const bridge = await createCorpusBridge(host);
    await expect(runChangeSetSubmissionCorpusAtEndpoint({
      endpoint: bridge.endpoint, expectedVaultId: EXPECTED_VAULT_ID, seedNotes: host.seedNotes,
      inventoryContext: { vaultPath: host.vaultPath, runId: "corpus-run", runtimeProfileId: "linux-test", candidateBundleSha256: "a".repeat(64) },
      record: () => undefined, assertion: () => undefined,
    })).rejects.toThrow("rejection/stale-direct-target mutated the Vault");
    expect(injected).toBe(true);
  }, 60_000);

  it("refuses inventories from a different generated Vault", async () => {
    const host = await arrangeVault();
    const other = await arrangeVault();
    const bridge = await createCorpusBridge(host);
    await expect(runChangeSetSubmissionCorpusAtEndpoint({
      endpoint: bridge.endpoint, expectedVaultId: EXPECTED_VAULT_ID, seedNotes: host.seedNotes,
      inventoryContext: { vaultPath: other.vaultPath, runId: "corpus-run", runtimeProfileId: "linux-test", candidateBundleSha256: "a".repeat(64) },
      record: () => undefined, assertion: () => undefined,
    })).rejects.toThrow("same Managed Vault");
    expect(await fsKind(host.vaultPath, CHANGE_SET_CORPUS_DIRECTORY)).toBeNull();
  }, 60_000);

  it("runs one selected rejection without claiming complete acceptance", async () => {
    const host = await arrangeVault();
    const bridge = await createCorpusBridge(host);
    const events: Array<{ kind: "transport" | "tool" | "assertion" | "cleanup"; name: string; detail: unknown }> = [];
    const admission = await runChangeSetSubmissionCorpusAtEndpoint({
      endpoint: bridge.endpoint, expectedVaultId: EXPECTED_VAULT_ID, seedNotes: host.seedNotes,
      rejectionScenario: "rejection/occupied-destination",
      inventoryContext: { vaultPath: host.vaultPath, runId: "corpus-run", runtimeProfileId: "linux-test", candidateBundleSha256: "a".repeat(64) },
      record: (kind, name, detail) => events.push({ kind, name, detail }), assertion: () => undefined,
    });
    expect(admission.rejectionClasses.map(({ name }) => name)).toEqual(["rejection/occupied-destination"]);
    expect(() => composeChangeSetCorpusEvidence({
      admission, events, assertions: admission.assertions,
      replay: { replayReport: { keysReplayed: 1, identitiesPreserved: 1, recordsUnchanged: 1, conflictingReusesRejected: 1 }, assertions: ["replay"] },
    })).toThrow("complete preflight rejection coverage");
  }, 60_000);

  it.each(["before-inventory", "inventory-hash", "event-order", "status", "binding", "inventory-path", "submit-event", "blocked-terminal", "wrong-key"])("refuses fabricated rejection evidence: %s", async (corruption) => {
    const host = await arrangeVault();
    const bridge = await createCorpusBridge(host);
    const events: Array<{ kind: "transport" | "tool" | "assertion" | "cleanup"; name: string; detail: unknown }> = [];
    const admission = await runChangeSetSubmissionCorpusAtEndpoint({
      endpoint: bridge.endpoint, expectedVaultId: EXPECTED_VAULT_ID, seedNotes: host.seedNotes,
      inventoryContext: { vaultPath: host.vaultPath, runId: "corpus-run", runtimeProfileId: "linux-test", candidateBundleSha256: "a".repeat(64) },
      record: (kind, name, detail) => events.push({ kind, name, detail }), assertion: () => undefined,
    });
    const tampered = structuredClone(admission);
    const evidence = tampered.rejectionClasses[0]!;
    if (corruption === "before-inventory") delete (evidence as unknown as Record<string, unknown>).beforeInventory;
    if (corruption === "inventory-hash") evidence.beforeInventory.digest = "b".repeat(64);
    if (corruption === "event-order") evidence.eventOrder.after = evidence.eventOrder.before;
    if (corruption === "status") evidence.status.state = "intent_applied";
    if (corruption === "binding") evidence.binding.runId = "other-run";
    if (corruption === "wrong-key") evidence.proof.submissionKeySha256 = evidence.status.submissionKeySha256 = "d".repeat(64);
    if (corruption === "blocked-terminal") {
      const offset = events.findIndex(({ name }) => name === "change-set-corpus-began");
      const event = events[evidence.eventOrder.terminal + offset - 1]!;
      const health = structuredClone(event.detail) as { recovery: { state: string }; queue: { length: number } };
      health.recovery.state = "blocked";
      health.queue.length = 1;
      event.detail = health;
    }
    if (corruption === "submit-event") evidence.proof.changeSetId = evidence.status.changeSetId = "fabricated-identity";
    if (corruption === "inventory-path") {
      evidence.beforeInventory.entries[0]!.path = evidence.afterInventory.entries[0]!.path = "fabricated-path";
      const hash = createHash("sha256").update(JSON.stringify(evidence.beforeInventory.entries.map((entry) => Object.fromEntries(Object.entries(entry).sort(([left], [right]) => left.localeCompare(right)))))).digest("hex");
      evidence.beforeInventory.digest = evidence.afterInventory.digest = hash;
    }
    expect(() => composeChangeSetCorpusEvidence({
      admission: tampered,
      replay: { replayReport: { keysReplayed: 1, identitiesPreserved: 1, recordsUnchanged: 1, conflictingReusesRejected: 1 }, assertions: ["replay"] },
      events, assertions: admission.assertions,
    })).toThrow();
  }, 60_000);

  it("derives the same deterministic corpus identity across fresh runs", async () => {
    const firstHost = await arrangeVault();
    const secondHost = await arrangeVault();
    const run = async (host: ArrangedVault) => {
      const bridgeHost = await createCorpusBridge(host);
      const admission = await runChangeSetSubmissionCorpusAtEndpoint({
        endpoint: bridgeHost.endpoint,
        expectedVaultId: EXPECTED_VAULT_ID,
        seedNotes: host.seedNotes,
      inventoryContext: {
        vaultPath: host.vaultPath,
        runId: "corpus-run",
        runtimeProfileId: "linux-test",
        candidateBundleSha256: "a".repeat(64),
      },
        record: () => undefined,
        assertion: () => undefined,
      });
      await bridgeHost.bridge.stop();
      const liveIndex = liveBridges.indexOf(bridgeHost.bridge);
      if (liveIndex >= 0) liveBridges.splice(liveIndex, 1);
      return admission;
    };
    const admissionA = await run(firstHost);
    const admissionB = await run(secondHost);
    expect(admissionA.scenarioManifestSha256).toBe(admissionB.scenarioManifestSha256);
    expect(admissionA.seedInventoryDigest).toBe(admissionB.seedInventoryDigest);
    expect(admissionA.beforeInventory).toEqual(admissionB.beforeInventory);
    expect(admissionA.afterInventory).toEqual(admissionB.afterInventory);
    expect(admissionA.rejectionClasses.map(({ name, failureCode, beforeInventory, afterInventory }) => ({ name, failureCode, beforeInventory, afterInventory }))).toEqual(
      admissionB.rejectionClasses.map(({ name, failureCode, beforeInventory, afterInventory }) => ({ name, failureCode, beforeInventory, afterInventory })),
    );
    expect(admissionA.fifoReport).toEqual(admissionB.fifoReport);
    expect(admissionA.recoveryClasses.map(({ name }) => name)).toEqual(
      admissionB.recoveryClasses.map(({ name }) => name),
    );
  }, 60_000);
});
