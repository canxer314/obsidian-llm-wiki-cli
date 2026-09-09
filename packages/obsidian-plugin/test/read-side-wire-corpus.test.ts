import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, describe, expect, it } from "vitest";

import {
  cleanupTestVault,
  createBridgeInstance,
  provisionTestVault,
  runReadSideCorpus,
  SearchSnapshotManager,
  VaultDiscoverService,
  type BridgeHealthState,
  type SearchSnapshotDataSource,
  type SearchSnapshotSemanticEvidence,
  type VaultReadDataSource,
} from "../src/index.js";

const EXPECTED_VAULT_ID = "vault-read-side-corpus";

function healthState(vaultId: string, name: string): BridgeHealthState {
  return {
    vault: { id: vaultId, name, path: `D:/Vaults/${name}` },
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

const liveBridges: Array<ReturnType<typeof createBridgeInstance>> = [];
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(liveBridges.splice(0).map((bridge) => bridge.stop()));
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

async function connect(endpoint: URL): Promise<Client> {
  const client = new Client({ name: "read-side-corpus-test", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(endpoint, {
    requestInit: { headers: { "X-Expected-Vault-ID": EXPECTED_VAULT_ID } },
  });
  await client.connect(transport);
  return client;
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

async function arrangeReadSideBridge(): Promise<{
  client: Client;
  seedNotes: readonly { path: string; content: string }[];
}> {
  const root = await mkdtemp(join(tmpdir(), "read-side-wire-corpus-"));
  const runId = "corpus-run";
  const vault = await provisionTestVault({ workingDirectory: root, runId });
  cleanups.push(() => cleanupTestVault(vault));
  cleanups.push(async () => rm(root, { recursive: true, force: true }));

  const seedNotes = vault.seedNotes;
  const knownPaths = new Set(seedNotes.map(({ path }) => path));
  const contentByPath = new Map(seedNotes.map(({ path, content }) => [path, content]));
  const readBytes = async (path: string): Promise<Uint8Array | null> => {
    try {
      return new Uint8Array(await readFile(join(vault.vaultPath, ...path.split("/"))));
    } catch {
      return null;
    }
  };

  const searchSource: SearchSnapshotDataSource = {
    listMarkdownPaths: async () => [...knownPaths],
    readBinary: readBytes,
    semanticEvidence: async (path): Promise<SearchSnapshotSemanticEvidence | null> => {
      const content = contentByPath.get(path);
      if (content === undefined) return null;
      return {
        frontmatter: null,
        tags: [],
        headings: [],
        references: [],
        resolvedLinks: wikilinkResolvedLinks(content, knownPaths),
        unresolvedLinks: {},
      };
    },
  };
  const snapshots = new SearchSnapshotManager(searchSource);
  await snapshots.rebuild();
  if (snapshots.readiness !== "ready") {
    throw new Error("Read-side corpus test Search Snapshot did not become ready");
  }

  const readDataSource: VaultReadDataSource = {
    readBinary: readBytes,
    parseFrontmatter: () => null,
    headings: () => null,
  };

  const bridge = createBridgeInstance({
    port: 0,
    health: healthState(EXPECTED_VAULT_ID, "ReadSideCorpus"),
    readDataSource,
    discoverService: new VaultDiscoverService(snapshots),
    searchSnapshotReadiness: () => snapshots.readiness,
  });
  liveBridges.push(bridge);
  await bridge.start();

  const client = await connect(bridge.endpoint);
  return { client, seedNotes };
}

function scenarioManifestSha256(): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        corpusId: "discovery-reads-continuation",
        scenarios: [
          "discovery/empty-result",
          "discovery/combined-graph",
          "discovery/inventory-before",
          "read/ordered-byte-exact-and-no-section-fallback",
          "read/single-note-over-limit-refusal",
          "read/multi-note-logical-grouping",
          "continuation/framing-reconstructs-frozen-result",
          "continuation/single-use-replay-rejected",
          "continuation/never-issued-token-unavailable",
          "discovery/inventory-after",
        ],
      }),
      "utf8",
    )
    .digest("hex");
}

describe("read-side public-wire corpus over a real loopback Bridge", () => {
  it("proves deterministic discovery, byte-exact reads, framing, and single-use continuation", async () => {
    const { client, seedNotes } = await arrangeReadSideBridge();
    const events: Array<{ kind: string; name: string }> = [];
    const assertions: string[] = [];

    const outcome = await runReadSideCorpus({
      callTool: async (tool, arguments_) =>
        (await client.callTool({ name: tool, arguments: arguments_ })) as unknown as {
          isError?: boolean;
          structuredContent?: unknown;
          content?: readonly unknown[];
        },
      seedNotes,
      record: (kind, name) => {
        events.push({ kind, name });
      },
      assertion: (name) => assertions.push(name),
    });

    expect(outcome.scenarioManifestSha256).toBe(scenarioManifestSha256());
    expect(outcome.scenarioManifestSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(outcome.seedInventoryDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect(outcome.beforeInventory).toEqual(outcome.afterInventory);
    expect(outcome.retainedByteCleanup).toEqual({
      chainsIssued: 1,
      chainsConsumed: 1,
      replayAfterConsumptionRejected: 1,
      bytesReconstructed: expect.any(Number),
      residualChains: 0,
    });
    expect(outcome.retainedByteCleanup.bytesReconstructed).toBeGreaterThan(262_144);
    expect(assertions.length).toBeGreaterThan(15);
    expect(events.filter(({ kind }) => kind === "tool").length).toBeGreaterThan(10);
    expect(events.some(({ kind, name }) => kind === "cleanup" && name === "retained-byte-cleanup"))
      .toBe(true);
    await client.close();
  });

  it("derives the same deterministic corpus identity and inventory across fresh runs", async () => {
    const first = await arrangeReadSideBridge();
    const second = await arrangeReadSideBridge();
    try {
      const outcomeA = await runReadSideCorpus({
        callTool: async (tool, arguments_) =>
          (await first.client.callTool({ name: tool, arguments: arguments_ })) as unknown as {
            isError?: boolean;
            structuredContent?: unknown;
            content?: readonly unknown[];
          },
        seedNotes: first.seedNotes,
        record: () => undefined,
        assertion: () => undefined,
      });
      const outcomeB = await runReadSideCorpus({
        callTool: async (tool, arguments_) =>
          (await second.client.callTool({ name: tool, arguments: arguments_ })) as unknown as {
            isError?: boolean;
            structuredContent?: unknown;
            content?: readonly unknown[];
          },
        seedNotes: second.seedNotes,
        record: () => undefined,
        assertion: () => undefined,
      });
      expect(outcomeA.scenarioManifestSha256).toBe(outcomeB.scenarioManifestSha256);
      expect(outcomeA.seedInventoryDigest).toBe(outcomeB.seedInventoryDigest);
      expect(outcomeA.beforeInventory).toEqual(outcomeB.beforeInventory);
      expect(outcomeA.afterInventory).toEqual(outcomeB.afterInventory);
    } finally {
      await first.client.close();
      await second.client.close();
    }
  });
});
