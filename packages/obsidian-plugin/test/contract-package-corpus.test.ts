import { cp, mkdtemp, readFile, rm, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadVersionContractPackage, runContractFixtureWireCorpus, completeContractPackageCorpus } from "../src/installed-runtime/contract-package-corpus.js";
import { runContractCrossCallScenario } from "../src/installed-runtime/contract-cross-call.js";
import { createNodeFileSystemChangeSetHost, createFileSystemChangeSetExecutionAdapter, createBridgeInstance, provisionTestVault, cleanupTestVault, SearchSnapshotManager, VaultDiscoverService, type BridgeInstance, type ChangeSetRegistryState } from "../src/index.js";

const packageRoot = resolve("packages/contracts");
const directories: string[] = [];
const bridges: BridgeInstance[] = [];
afterEach(async () => { await Promise.all(bridges.splice(0).map(bridge => bridge.stop())); });
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

async function copyPackage(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "contract-authority-"));
  directories.push(directory);
  await cp(join(packageRoot, "schema"), join(directory, "schema"), { recursive: true });
  await cp(join(packageRoot, "fixtures"), join(directory, "fixtures"), { recursive: true });
  return directory;
}

describe("version contract package authority", () => {
  it("executes input fixtures on loopback, rejects unknown fields and never sends output fixtures", async () => {
    const snapshots = new SearchSnapshotManager({ listMarkdownPaths: async () => [], readBinary: async () => null, semanticEvidence: async () => null });
    await snapshots.rebuild();
    let registry: ChangeSetRegistryState | undefined;
    const bridge = createBridgeInstance({ port: 0,
      readDataSource: { readBinary: async () => null, parseFrontmatter: () => null, headings: () => null },
      discoverService: new VaultDiscoverService(snapshots),
      changeSets: { vaultId: "contract-vault", store: { load: async () => registry, save: async state => { registry = state; } }, dataSource: { readBinary: async () => null, pathKind: async () => null, isContained: async () => true } },
      health: {
      vault: { id: "contract-vault", name: "Generated", path: "/generated/contract-vault" },
      readiness: { searchSnapshot: "ready", cache: "ready", index: "ready" },
      recovery: { state: "none" }, write: { gate: "open", state: "writable", pauseSource: null },
      queue: { currentExecutionId: null, length: 0, headChangeSetId: null },
      lifecycle: { startup: "ready", upgrade: "not_run", migration: "not_run", recovery: "not_run" },
      effectiveGate: null, overall: "healthy", reasonCodes: [], operatorAction: "none",
    } });
    bridges.push(bridge); await bridge.start();
    const authority = await loadVersionContractPackage(packageRoot);
    const result = await runContractFixtureWireCorpus({ authority, endpoint: bridge.endpoint, expectedVaultId: "contract-vault" });
    expect(result.verdict).toBe("passed");
    expect(result.inputs.filter(row => row.id.startsWith("fixtures/")).map(row => row.id)).toEqual(authority.fixtures.flatMap(f => f.fields.filter(field => field.direction === "input").map(field => f.path + "#" + field.pointer)));
    expect(result.outputs).toHaveLength(6);
    expect(result.outputs.every(row => row.structuredTextIdentical)).toBe(true);
    expect(result.unknownFieldRejections.map(row => row.tool).sort()).toEqual(["vault_health", "vault_discover", "vault_read", "vault_continue", "vault_change_set_submit", "vault_change_set_status"].sort());
    const identity = await runContractCrossCallScenario({ authority, scenarioId: "matching-identity-observed-health", endpoint: bridge.endpoint, expectedVaultId: "contract-vault" });
    expect(identity.verdict).toBe("passed");
    expect(identity.observations.length).toBeGreaterThan(0);
    const wrong = await runContractCrossCallScenario({ authority, scenarioId: "mismatched-identity-rejected", endpoint: bridge.endpoint, expectedVaultId: "contract-vault" });
    expect(wrong.verdict).toBe("passed");
    expect(wrong.observations).toHaveLength(7);
    const missing = await runContractCrossCallScenario({ authority, scenarioId: "missing-identity-rejected", endpoint: bridge.endpoint, expectedVaultId: "contract-vault" });
    expect(missing.observations).toHaveLength(7);
    const noFallback = await runContractCrossCallScenario({ authority, scenarioId: "section-occurrence-no-fallback", endpoint: bridge.endpoint, expectedVaultId: "contract-vault" });
    expect(noFallback.verdict).toBe("passed");
    const blocked = await runContractCrossCallScenario({ authority, scenarioId: "change-set-seven-day-retention", endpoint: bridge.endpoint, expectedVaultId: "contract-vault" });
    expect(blocked.verdict).toBe("blocked");
    expect(blocked.observations).toEqual([]);
    expect(blocked.requiredCorpus).toBe("installed-retention");
    expect(() => completeContractPackageCorpus({ authority, wire: result, crossCalls: [identity], binding: { runId: "run", profileName: "profile", candidateBundleSha256: "a".repeat(64), vaultIdSha256: "b".repeat(64), seedManifestSha256: "c".repeat(64) }, beforeInventorySha256: "d".repeat(64), afterInventorySha256: "d".repeat(64), cleanup: { attempted: true, residualPaths: [] } })).toThrow(/cross-call.*coverage/i);
    const omitted = { ...result, inputs: result.inputs.slice(1) };
    expect(() => completeContractPackageCorpus({ authority, wire: omitted, crossCalls: [], binding: { runId: "run", profileName: "profile", candidateBundleSha256: "a".repeat(64), vaultIdSha256: "b".repeat(64), seedManifestSha256: "c".repeat(64) }, beforeInventorySha256: "d".repeat(64), afterInventorySha256: "d".repeat(64), cleanup: { attempted: true, residualPaths: [] } })).toThrow(/input.*coverage/i);
    expect(result.outputFixtures.every(row => row.mode === "validator-only")).toBe(true);
  });
  it("reconstructs the accepted frozen Exact Read after a real public Change Set changes source bytes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "contract-frozen-")); directories.push(directory);
    const vault = await provisionTestVault({ workingDirectory: directory, runId: "frozen" });
    const readBytes = async (path: string) => { try { return new Uint8Array(await readFile(join(vault.vaultPath, path))); } catch { return null; } };
    const execution = await createFileSystemChangeSetExecutionAdapter({ journalPath: join(vault.vaultPath, ".obsidian/contract-state/recovery-journal.bin"), slotCapacity: 8 * 1024 * 1024, host: await createNodeFileSystemChangeSetHost({ basePath: vault.vaultPath, stateDirectory: join(vault.vaultPath, ".obsidian/contract-state"), referenced: async () => false, awaitSemanticEvidence: async () => undefined, publishSearchSnapshot: async () => undefined }) });
    let registry: ChangeSetRegistryState | undefined;
    const bridge = createBridgeInstance({ port: 0,
      health: { vault: { id: "frozen-vault", name: "Generated", path: vault.vaultPath }, readiness: { searchSnapshot: "ready", cache: "ready", index: "ready" }, recovery: { state: "none" }, write: { gate: "open", state: "writable", pauseSource: null }, queue: { currentExecutionId: null, length: 0, headChangeSetId: null }, lifecycle: { startup: "ready", upgrade: "not_run", migration: "not_run", recovery: "not_run" }, effectiveGate: null, overall: "healthy", reasonCodes: [], operatorAction: "none" },
      readDataSource: { readBinary: readBytes, parseFrontmatter: content => content.startsWith("---\nquota: ") ? { quota: content.slice(11, content.indexOf("\n---", 11)) } : null, headings: () => null },
      changeSets: { execution, vaultId: "frozen-vault", store: { load: async () => registry, save: async state => { registry = state; } }, dataSource: { readBinary: readBytes, pathKind: async path => { try { return (await stat(join(vault.vaultPath, path))).isDirectory() ? "directory" : "file"; } catch { return null; } }, isContained: async () => true } },
    });
    bridges.push(bridge); await bridge.start();
    // Without an installed mutation executor the wire cannot fake this proof.
    const outcome = await runContractCrossCallScenario({ authority: await loadVersionContractPackage(packageRoot), scenarioId: "frozen-byte-exact-continuation", endpoint: bridge.endpoint, expectedVaultId: "frozen-vault", seedNotes: vault.seedNotes });
    expect(outcome.verdict).toBe("passed");
    expect(outcome.observations.some(row => row.name === "frozen-after-source-change")).toBe(true);
    expect(await readFile(join(vault.vaultPath, "Notes/Transport.md"), "utf8")).toBe(vault.seedNotes.find(note => note.path === "Notes/Transport.md")!.content);
    const clientBound = await runContractCrossCallScenario({ authority: await loadVersionContractPackage(packageRoot), scenarioId: "single-use-client-bound-sliding-continuation", endpoint: bridge.endpoint, expectedVaultId: "frozen-vault", seedNotes: vault.seedNotes, continuationTiming: "binding-only" });
    expect(clientBound.verdict).toBe("blocked");
    expect(clientBound.requiredCorpus).toBe("continuation-expiry-sliding-time");
    expect(clientBound.observations.some(row => row.name === "wrong-client-token-rejected")).toBe(true);
    expect(clientBound.observations.some(row => row.name === "original-client-token-preserved")).toBe(true);
    const mixed = await runContractCrossCallScenario({ authority: await loadVersionContractPackage(packageRoot), scenarioId: "byte-exact-ordered-mixed-read", endpoint: bridge.endpoint, expectedVaultId: "frozen-vault", seedNotes: vault.seedNotes });
    expect(mixed.verdict).toBe("passed");
    expect(mixed.observations.some(row => row.name === "ordered-duplicate-exact-bytes")).toBe(true);
    const limits = await runContractCrossCallScenario({ authority: await loadVersionContractPackage(packageRoot), scenarioId: "exact-read-limit-and-grouping", endpoint: bridge.endpoint, expectedVaultId: "frozen-vault", seedNotes: vault.seedNotes });
    expect(limits.verdict).toBe("passed");
    for (const scenarioId of ["change-set-same-key-replay", "change-set-key-conflict", "change-set-preflight-rejection"]) {
      const program = await runContractCrossCallScenario({ authority: await loadVersionContractPackage(packageRoot), scenarioId, endpoint: bridge.endpoint, expectedVaultId: "frozen-vault" });
      expect(program.verdict).toBe("passed");
    }
    const quotaMetadataPath = "Notes/QuotaMetadata.md";
    const quotaValue = "q".repeat(4_718_592);
    await writeFile(join(vault.vaultPath, quotaMetadataPath), `---\nquota: ${quotaValue}\n---\n# Quota\n`);
    const quota = await runContractCrossCallScenario({ authority: await loadVersionContractPackage(packageRoot), scenarioId: "continuation-quota-and-lifecycle-cleanup", endpoint: bridge.endpoint, expectedVaultId: "frozen-vault", seedNotes: vault.seedNotes, quotaMetadataPath, continuationTiming: "binding-only" });
    expect(quota.verdict).toBe("blocked");
    expect(quota.requiredCorpus).toBe("continuation-full-lifecycle-cleanup");
    expect(quota.observations.some(row => row.name === "quota-preserved-and-session-capacity-released")).toBe(true);
    expect(quota.observations.some(row => row.name === "retained-byte-quota-no-eviction" && row.facts.retainedBytesBeforeRefusal > 0)).toBe(true);
    const invalidPath = "Notes/ContractInvalidUtf8.md";
    await writeFile(join(vault.vaultPath, invalidPath), Buffer.from([0xc3, 0x28]));
    const utf8 = await runContractCrossCallScenario({ authority: await loadVersionContractPackage(packageRoot), scenarioId: "invalid-utf8-no-trusted-result", endpoint: bridge.endpoint, expectedVaultId: "frozen-vault", invalidUtf8Path: invalidPath, readFixtureBytes: readBytes });
    expect(utf8.verdict).toBe("passed");
    expect(utf8.observations.some(row => row.name === "invalid-utf8-untrusted-rejection")).toBe(true);
    const uncertain = await runContractCrossCallScenario({ authority: await loadVersionContractPackage(packageRoot), scenarioId: "change-set-uncertain-response-recovery", endpoint: bridge.endpoint, expectedVaultId: "frozen-vault" });
    expect(uncertain.verdict).toBe("blocked");
    expect(uncertain.requiredCorpus).toBe("controlled-installed-restart");
    expect(uncertain.observations.some(row => row.name === "submit-wire-response-discarded")).toBe(true);
    const recovered = await runContractCrossCallScenario({ authority: await loadVersionContractPackage(packageRoot), scenarioId: "change-set-uncertain-response-recovery", endpoint: bridge.endpoint, expectedVaultId: "frozen-vault", restart: async () => { await bridge.stop(); await bridge.start(); return { endpoint: bridge.endpoint, expectedVaultId: "frozen-vault" }; } });
    expect(recovered.verdict).toBe("passed");
    expect(recovered.observations.some(row => row.name === "original-key-recovered-after-restart")).toBe(true);
    const graphBytes = Buffer.from("---\nstatus: active\ntags: [architecture]\n---\n# Design\n[[Target Note|target]] [[Missing Note]]\n");
    const rootBytes = Buffer.from("# Root\n[[Projects/Bridge]]\n");
    const targetBytes = Buffer.from("# Target Note\n");
    const allBytes = { "Projects/Bridge.md": graphBytes, "Root.md": rootBytes, "Target Note.md": targetBytes, "Notes/Transport.md": await readFile(join(vault.vaultPath, "Notes/Transport.md")) };
    const snapshot = new SearchSnapshotManager({ listMarkdownPaths: async () => Object.keys(allBytes), readBinary: async path => (allBytes as Record<string, Uint8Array>)[path] ?? null, semanticEvidence: async path => {
      if (path === "Notes/Transport.md") {
        const content = allBytes[path].toString(); const original = "[[Target Note]]"; const offset = content.indexOf(original);
        return { frontmatter: null, tags: [], headings: [], references: offset < 0 ? [] : [{ profile: "wikilink", target: "Target Note", resolvedPath: "Target Note.md", original, position: { start: { line: -1, col: -1, offset: offset - 1 }, end: { line: -1, col: -1, offset: offset - 1 + original.length } } }], resolvedLinks: offset < 0 ? {} : { "Target Note.md": 1 }, unresolvedLinks: {} };
      }
      const content = path === "Projects/Bridge.md" ? graphBytes.toString() : rootBytes.toString();
      const original = path === "Projects/Bridge.md" ? "[[Target Note|target]]" : "[[Projects/Bridge]]";
      const offset = content.indexOf(original);
      return { frontmatter: path === "Projects/Bridge.md" ? { status: "active" } : null, tags: path === "Projects/Bridge.md" ? ["#architecture"] : [], headings: path === "Projects/Bridge.md" ? [{ heading: "Design", level: 1 }] : [], references: path === "Target Note.md" ? [] : [{ profile: "wikilink", target: path === "Projects/Bridge.md" ? "Target Note" : "Projects/Bridge", resolvedPath: path === "Projects/Bridge.md" ? "Target Note.md" : "Projects/Bridge.md", original, position: { start: { line: -1, col: -1, offset }, end: { line: -1, col: -1, offset: offset + original.length } } }], resolvedLinks: path === "Projects/Bridge.md" ? { "Target Note.md": 1 } : path === "Root.md" ? { "Projects/Bridge.md": 1 } : {}, unresolvedLinks: path === "Projects/Bridge.md" ? { "Missing Note": 1 } : {} };
    } });
    await snapshot.rebuild();
    const graphExecution = await createFileSystemChangeSetExecutionAdapter({ journalPath: join(vault.vaultPath, ".obsidian/contract-state/graph-journal.bin"), slotCapacity: 8 * 1024 * 1024, host: await createNodeFileSystemChangeSetHost({ basePath: vault.vaultPath, stateDirectory: join(vault.vaultPath, ".obsidian/contract-state"), referenced: async () => false, awaitSemanticEvidence: async () => undefined, publishSearchSnapshot: async () => { allBytes["Notes/Transport.md"] = await readFile(join(vault.vaultPath, "Notes/Transport.md")); await snapshot.rebuild(); } }) });
    let graphRegistry: ChangeSetRegistryState | undefined;
    const graphBridge = createBridgeInstance({ port: 0, health: { vault: { id: "graph-vault", name: "Generated", path: vault.vaultPath }, readiness: { searchSnapshot: "ready", cache: "ready", index: "ready" }, recovery: { state: "none" }, write: { gate: "open", state: "writable", pauseSource: null }, queue: { currentExecutionId: null, length: 0, headChangeSetId: null }, lifecycle: { startup: "ready", upgrade: "not_run", migration: "not_run", recovery: "not_run" }, effectiveGate: null, overall: "healthy", reasonCodes: [], operatorAction: "none" }, discoverService: new VaultDiscoverService(snapshot), readDataSource: { readBinary: readBytes, parseFrontmatter: () => null, headings: () => null }, changeSets: { execution: graphExecution, vaultId: "graph-vault", store: { load: async () => graphRegistry, save: async state => { graphRegistry = state; } }, dataSource: { readBinary: readBytes, isContained: async () => true, pathKind: async path => { try { return (await stat(join(vault.vaultPath, path))).isDirectory() ? "directory" : "file"; } catch { return null; } } } } });
    bridges.push(graphBridge); await graphBridge.start();
    const graph = await runContractCrossCallScenario({ authority: await loadVersionContractPackage(packageRoot), scenarioId: "structured-graph-discovery-composition", endpoint: graphBridge.endpoint, expectedVaultId: "graph-vault", readFixtureBytes: async () => graphBytes });
    expect(graph.verdict).toBe("passed");
    await expect(runContractCrossCallScenario({ authority: await loadVersionContractPackage(packageRoot), scenarioId: "structured-graph-discovery-composition", endpoint: graphBridge.endpoint, expectedVaultId: "graph-vault", readFixtureBytes: async () => Buffer.from("wrong bytes") })).rejects.toThrow(/raw bytes/);
    const predecessor = await runContractCrossCallScenario({ authority: await loadVersionContractPackage(packageRoot), scenarioId: "successor-search-snapshot-graph-evidence", endpoint: graphBridge.endpoint, expectedVaultId: "graph-vault", seedNotes: vault.seedNotes });
    expect(predecessor.verdict).toBe("blocked");
    expect(predecessor.requiredCorpus).toBe("semantic-evidence-search-snapshot");
    expect(predecessor.observations.some(row => row.name === "successor-graph-frozen-predecessor")).toBe(true);
    await graphBridge.stop(); await bridge.stop(); await execution.close?.(); await graphExecution.close?.();
    await cleanupTestVault(vault);
  }, 60_000);
  it("closes coverage over the actual package, refusing missing, duplicate and unknown entries", async () => {
    const authority = await loadVersionContractPackage(packageRoot);
    const faulty = await copyPackage();
    const fixturePath = join(faulty, "fixtures/v1/invalid/unknown-root-field.json");
    await writeFile(fixturePath, JSON.stringify({ outcome: "incompatible", gate: { code: "incompatible_protocol" }, compatibility: { local: { protocol: "1.0", supported: { major: 1, minimumMinor: 0, maximumMinor: 0 } }, peer: { protocol: "1.0", supported: { major: 1, minimumMinor: 0, maximumMinor: 0 } } } }));
    const faultyManifestPath = join(faulty, "fixtures/v1/acceptance-manifest.json");
    const faultyManifest = JSON.parse(await readFile(faultyManifestPath, "utf8"));
    faultyManifest.fixtures.find((f: { path: string }) => f.path.endsWith("invalid/unknown-root-field.json")).sha256 = (await import("node:crypto")).createHash("sha256").update(await readFile(fixturePath)).digest("hex");
    await writeFile(faultyManifestPath, JSON.stringify(faultyManifest));
    await expect(loadVersionContractPackage(faulty)).rejects.toThrow(/validator accepted invalid/i);
    expect(authority.roots).toHaveLength(12);
    expect(authority.sharedDefinitions.length).toBeGreaterThan(0);
    expect(authority.fixtures.length).toBeGreaterThan(30);
    expect(authority.scenarios).toHaveLength(23);
    for (const mutation of ["missing", "duplicate", "unknown"] as const) {
      const directory = await copyPackage();
      const path = join(directory, "fixtures/v1/acceptance-manifest.json");
      const manifest = JSON.parse(await readFile(path, "utf8"));
      if (mutation === "missing") manifest.fixtures.pop();
      if (mutation === "duplicate") manifest.fixtures.push(manifest.fixtures[0]);
      if (mutation === "unknown") await writeFile(join(directory, "fixtures/v1/valid/unlisted.json"), "{}");
      await writeFile(path, JSON.stringify(manifest));
      await expect(loadVersionContractPackage(directory)).rejects.toThrow(/coverage|duplicate|unknown/i);
    }
  });
});
