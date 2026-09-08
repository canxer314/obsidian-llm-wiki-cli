import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, describe, expect, it } from "vitest";

import {
  cleanupTestVault,
  composeGateIsolationCorpusEvidence,
  createBridgeInstance,
  EXPECTED_VAULT_ID_HEADER,
  GATE_ISOLATION_CORPUS_ID,
  GATE_ISOLATION_SCENARIO_PLAN,
  provisionTestVault,
  runGateIsolationCorpus,
  SearchSnapshotManager,
  VaultDiscoverService,
  type ArrangedVaultHealth,
  type BridgeHealthState,
  type ChangeSetRegistryState,
  type ChangeSetRegistryStore,
  type ChangeSetPreflightDataSource,
  type GateIsolationOperatorControl,
  type GateIsolationVaultSession,
  type SearchSnapshotDataSource,
  type SearchSnapshotSemanticEvidence,
  type VaultReadDataSource,
  type WireClient,
  type WireToolName,
} from "../src/index.js";

const liveBridges: Array<ReturnType<typeof createBridgeInstance>> = [];
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(liveBridges.splice(0).map((bridge) => bridge.stop()));
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

function healthyState(vaultId: string): BridgeHealthState {
  return {
    vault: { id: vaultId, name: vaultId, path: `D:/Vaults/${vaultId}` },
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

interface ArrangedVault {
  root: string;
  vaultPath: string;
  seedNotes: readonly { path: string; content: string }[];
  readBinary: (path: string) => Promise<Uint8Array | null>;
}

interface VaultHost {
  vault: ArrangedVault;
  health: BridgeHealthState;
  bridge: ReturnType<typeof createBridgeInstance>;
  endpoint: URL;
  store: ReturnType<typeof persistentStore>;
}

async function arrangeVault(): Promise<ArrangedVault> {
  const root = await mkdtemp(join(tmpdir(), "gate-isolation-corpus-"));
  const vault = await provisionTestVault({ workingDirectory: root, runId: `g${Math.random().toString(36).slice(2, 10)}` });
  cleanups.push(() => cleanupTestVault(vault));
  cleanups.push(async () => rm(root, { recursive: true, force: true }));
  return {
    root,
    vaultPath: vault.vaultPath,
    seedNotes: vault.seedNotes,
    readBinary: fsRead(vault.vaultPath),
  };
}

async function createSearchSnapshot(arranged: ArrangedVault): Promise<SearchSnapshotManager> {
  const readBinary = arranged.readBinary;
  const searchSource: SearchSnapshotDataSource = {
    listMarkdownPaths: async () => listMarkdown(arranged.vaultPath),
    readBinary,
    semanticEvidence: async (path): Promise<SearchSnapshotSemanticEvidence | null> => {
      const bytes = await readBinary(path);
      if (bytes === null) return null;
      const content = Buffer.from(bytes).toString("utf8");
      const known = new Set(await listMarkdown(arranged.vaultPath));
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
    throw new Error("Gate-isolation corpus Search Snapshot did not become ready");
  }
  return snapshots;
}

async function createVaultHost(vaultId: string): Promise<VaultHost> {
  const vault = await arrangeVault();
  const health = healthyState(vaultId);
  const readBinary = vault.readBinary;
  const snapshots = await createSearchSnapshot(vault);
  const store = persistentStore(join(vault.root, `${vaultId}-registry.json`));
  const dataSource: ChangeSetPreflightDataSource = {
    readBinary,
    pathKind: (path) => fsKind(vault.vaultPath, path),
    isContained: async () => true,
  };
  const readDataSource: VaultReadDataSource = {
    readBinary,
    parseFrontmatter: () => null,
    headings: () => null,
  };
  const bridge = createBridgeInstance({
    port: 0,
    health,
    readDataSource,
    discoverService: new VaultDiscoverService(snapshots),
    searchSnapshotReadiness: () => snapshots.readiness,
    changeSets: { store, dataSource, vaultId },
  });
  liveBridges.push(bridge);
  await bridge.start();
  return { vault, health, bridge, endpoint: bridge.endpoint, store };
}

/**
 * An operator control bound to one real Bridge: manual pause/resume go through
 * the real Bridge Instance (and therefore the real Change Set engine control
 * lease), while recovery/maintenance projections are arranged on the real
 * health object the Bridge projects on every wire call.
 */
function operatorFor(host: VaultHost): GateIsolationOperatorControl {
  const { health, bridge } = host;
  const idleWrite = { gate: "open" as const, state: "writable" as const, pauseSource: null as const };
  return {
    async arrange(state) {
      if (state.recovery !== undefined) health.recovery.state = state.recovery;
      if (state.effectiveGate !== undefined) {
        health.effectiveGate =
          state.effectiveGate === null ? null : { code: state.effectiveGate };
      }
      if (state.write !== undefined) health.write = { ...state.write };
      if (state.overall !== undefined) health.overall = state.overall;
      if (state.operatorAction !== undefined) health.operatorAction = state.operatorAction as BridgeHealthState["operatorAction"];
      if (state.queue !== undefined) health.queue = { ...state.queue };
      // The arranged health must be self-consistent: reasonCodes always report
      // the projected gate so the wire health validates against the closed
      // schema.
      const codes: string[] = [];
      if (health.recovery.state !== "none") {
        codes.push(health.recovery.state === "blocked" ? "recovery_blocked" : "recovery_in_progress");
      } else if (health.effectiveGate !== null) {
        codes.push(health.effectiveGate.code);
      }
      health.reasonCodes = codes;
    },
    async pauseWrites() {
      await bridge.pauseWrites();
    },
    async resumeWrites() {
      await bridge.resumeWrites();
    },
    async restoreIdle() {
      health.recovery = { state: "none" };
      health.effectiveGate = null;
      health.write = { ...idleWrite };
      health.queue = { currentExecutionId: null, length: 0, headChangeSetId: null };
      health.overall = "healthy";
      health.reasonCodes = [];
      health.operatorAction = "none";
    },
  };
}

async function connect(endpoint: URL, vaultId: string): Promise<Client> {
  const client = new Client({ name: "gate-isolation-corpus", version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(endpoint, {
      requestInit: { headers: { [EXPECTED_VAULT_ID_HEADER]: vaultId } },
    }),
  );
  return client;
}

async function sessionFor(host: VaultHost, label: "vault-a" | "vault-b"): Promise<{
  session: GateIsolationVaultSession;
  close: () => Promise<void>;
}> {
  const client = await connect(host.endpoint, host.health.vault.id);
  const callTool = async (
    tool: string,
    arguments_: Record<string, unknown>,
  ): Promise<{ isError?: boolean; structuredContent?: unknown; content?: readonly unknown[] }> => {
    const result = await client.callTool({ name: tool, arguments: arguments_ });
    return {
      isError: result.isError === true,
      structuredContent: result.structuredContent,
      content: result.content,
    };
  };
  const operator = operatorFor(host);
  const session: GateIsolationVaultSession = {
    label,
    vaultIdSha256: createHash("sha256").update(host.health.vault.id, "utf8").digest("hex"),
    callTool: callTool as GateIsolationVaultSession["callTool"],
    operator,
    seedNotes: host.vault.seedNotes,
    registryUninspected: true,
  };
  return {
    session,
    close: async () => {
      await client.close().catch(() => undefined);
    },
  };
}

interface IncompatibleClientHandle extends WireClient {
  close(): Promise<void>;
}

/** A protocol-incompatible Bridge over the same Managed Vault (Vault A). */
async function createIncompatibleClient(host: VaultHost): Promise<IncompatibleClientHandle> {
  const health = healthyState(`${host.health.vault.id}-incompatible`);
  const bridge = createBridgeInstance({
    port: 0,
    health,
    peerProtocol: {
      protocol: "2.0",
      supported: { major: 2, minimumMinor: 0, maximumMinor: 0 },
    },
    changeSets: {
      store: {
        load: async () => {
          throw new Error("incompatible connection must never load the Change Set registry");
        },
        save: async () => {
          throw new Error("incompatible connection must never save the Change Set registry");
        },
      },
      dataSource: {
        readBinary: async () => {
          throw new Error("incompatible connection must never inspect content");
        },
        pathKind: async () => {
          throw new Error("incompatible connection must never inspect paths");
        },
        isContained: async () => {
          throw new Error("incompatible connection must never inspect containment");
        },
      },
    },
  });
  liveBridges.push(bridge);
  await bridge.start();
  const client = await connect(bridge.endpoint, health.vault.id);
  const callTool = async (
    tool: WireToolName,
    arguments_: Record<string, unknown>,
  ): Promise<{ isError?: boolean; structuredContent?: unknown; content?: readonly unknown[] }> => {
    const result = await client.callTool({ name: tool, arguments: arguments_ });
    return {
      isError: result.isError === true,
      structuredContent: result.structuredContent,
      content: result.content,
    };
  };
  return {
    callTool: callTool as WireClient["callTool"],
    close: async () => {
      await client.close().catch(() => undefined);
    },
  };
}

function scenarioManifestSha256(): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        corpusId: GATE_ISOLATION_CORPUS_ID,
        scenarios: [...GATE_ISOLATION_SCENARIO_PLAN],
      }),
      "utf8",
    )
    .digest("hex");
}

describe("per-Vault gate-and-isolation corpus over two real loopback Bridges", () => {
  it(
    "proves independent Vaults, gate precedence, recovery_blocked dispositions, manual pause, and incompatible isolation",
    async () => {
      const hostA = await createVaultHost("vault-a");
      const hostB = await createVaultHost("vault-b");
      const a = await sessionFor(hostA, "vault-a");
      const b = await sessionFor(hostB, "vault-b");
      const incompatibleClient = await createIncompatibleClient(hostA);

      const events: Array<{
        kind: "transport" | "tool" | "assertion" | "cleanup";
        name: string;
        detail: unknown;
      }> = [];
      const assertions: string[] = [];

      try {
        const outcome = await runGateIsolationCorpus({
          vaultA: a.session,
          vaultB: b.session,
          incompatibleClient,
          record: (kind, name, detail) => {
            events.push({ kind, name, detail });
          },
          assertion: (name) => assertions.push(name),
        });

        expect(outcome.scenarioManifestSha256).toBe(scenarioManifestSha256());
        expect(outcome.scenarioManifestSha256).toMatch(/^[a-f0-9]{64}$/u);
        expect(outcome.assertions.length).toBeGreaterThan(10);
        expect(outcome.isolation).toEqual({
          sharedKeyIndependentRegistries: true,
          distinctChangeSetIds: true,
          crossVaultLookupRejected: true,
          queuesIndependent: true,
        });
        expect(outcome.recoveryBlocked).toMatchObject({
          boundDispositions: outcome.recoveryBlocked.boundDispositions,
          replayAfterRecovery: 1,
          conflictingReuseRejected: 1,
          freshKeyRenewed: 1,
          otherGatesLeftUnbound: 2,
        });
        expect(outcome.recoveryBlocked.boundDispositions).toBeGreaterThanOrEqual(2);
        expect(outcome.manualPause).toEqual({
          drainedInFlightToTrustworthyEnd: true,
          fifoRetained: true,
          newUnboundRejected: 1,
          observationalContentAvailable: true,
        });
        expect(outcome.incompatible).toEqual({
          registryInspected: 0,
          submissionKeysBound: 0,
          compatibleSessionUnaffected: true,
        });
        // The deterministic seed Notes in both Vaults are byte-identical after
        // the whole corpus.
        for (const host of [hostA, hostB]) {
          for (const { path, content } of host.vault.seedNotes) {
            const bytes = await host.vault.readBinary(path);
            expect(Buffer.from(bytes ?? new Uint8Array()).toString("utf8")).toBe(content);
          }
        }

        const evidence = composeGateIsolationCorpusEvidence({
          outcome,
          events,
          assertions,
        });
        expect(evidence.corpusId).toBe(GATE_ISOLATION_CORPUS_ID);
        expect(evidence.verdict).toBe("passed");
        expect(evidence.vaults).toHaveLength(2);
        for (const vault of evidence.vaults) {
          expect(vault.beforeInventory.digest).toBe(vault.afterInventory.digest);
          expect(vault.beforeInventory.entries.length).toBeGreaterThan(0);
        }
        expect(evidence.isolation.distinctChangeSetIds).toBe(true);
        expect(evidence.recoveryBlocked.boundDispositions).toBeGreaterThanOrEqual(2);
        expect(evidence.manualPause.fifoRetained).toBe(true);
        expect(evidence.incompatible.registryInspected).toBe(0);
        expect(evidence.gateHistory.length).toBeGreaterThan(3);
        expect(evidence.gateHistory[0]?.sequence).toBe(1);
        expect(evidence.assertions.length).toBeGreaterThan(10);
        expect(events.length).toBeGreaterThan(1);
      } finally {
        await incompatibleClient.close();
        await a.close();
        await b.close();
      }
    },
    180_000,
  );

  it("derives the same deterministic corpus identity across fresh runs", async () => {
    const run = async (vaultIdA: string, vaultIdB: string) => {
      const hostA = await createVaultHost(vaultIdA);
      const hostB = await createVaultHost(vaultIdB);
      const a = await sessionFor(hostA, "vault-a");
      const b = await sessionFor(hostB, "vault-b");
      const incompatibleClient = await createIncompatibleClient(hostA);
      try {
        const outcome = await runGateIsolationCorpus({
          vaultA: a.session,
          vaultB: b.session,
          incompatibleClient,
          record: () => undefined,
          assertion: () => undefined,
        });
        await incompatibleClient.close();
        await a.close();
        await b.close();
        return outcome;
      } catch (error) {
        await a.close();
        await b.close();
        throw error;
      }
    };
    const first = await run("vault-a", "vault-b");
    const second = await run("vault-a2", "vault-b2");
    expect(first.scenarioManifestSha256).toBe(second.scenarioManifestSha256);
    expect(first.isolation).toEqual(second.isolation);
    expect(first.recoveryBlocked).toEqual(second.recoveryBlocked);
    expect(first.manualPause).toEqual(second.manualPause);
    expect(first.incompatible).toEqual(second.incompatible);
    expect(first.assertions).toEqual(second.assertions);
  }, 180_000);
});
