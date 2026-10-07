import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadVersionContractPackage, runContractFixtureWireCorpus, completeContractPackageCorpus } from "../src/installed-runtime/contract-package-corpus.js";
import { runContractCrossCallScenario } from "../src/installed-runtime/contract-cross-call.js";
import { createBridgeInstance, provisionTestVault, cleanupTestVault, SearchSnapshotManager, VaultDiscoverService, type BridgeInstance, type ChangeSetRegistryState } from "../src/index.js";

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
    let registry: ChangeSetRegistryState | undefined;
    const bridge = createBridgeInstance({ port: 0,
      health: { vault: { id: "frozen-vault", name: "Generated", path: vault.vaultPath }, readiness: { searchSnapshot: "ready", cache: "ready", index: "ready" }, recovery: { state: "none" }, write: { gate: "open", state: "writable", pauseSource: null }, queue: { currentExecutionId: null, length: 0, headChangeSetId: null }, lifecycle: { startup: "ready", upgrade: "not_run", migration: "not_run", recovery: "not_run" }, effectiveGate: null, overall: "healthy", reasonCodes: [], operatorAction: "none" },
      readDataSource: { readBinary: readBytes, parseFrontmatter: () => null, headings: () => null },
      changeSets: { vaultId: "frozen-vault", store: { load: async () => registry, save: async state => { registry = state; } }, dataSource: { readBinary: readBytes, pathKind: async path => await readBytes(path) === null ? null : "file", isContained: async () => true } },
    });
    bridges.push(bridge); await bridge.start();
    // Without an installed mutation executor the wire cannot fake this proof.
    const outcome = await runContractCrossCallScenario({ authority: await loadVersionContractPackage(packageRoot), scenarioId: "frozen-byte-exact-continuation", endpoint: bridge.endpoint, expectedVaultId: "frozen-vault", seedNotes: vault.seedNotes });
    expect(outcome.verdict).toBe("blocked");
    expect(outcome.requiredCorpus).toBe("mutation-executor");
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
    const quota = await runContractCrossCallScenario({ authority: await loadVersionContractPackage(packageRoot), scenarioId: "continuation-quota-and-lifecycle-cleanup", endpoint: bridge.endpoint, expectedVaultId: "frozen-vault", seedNotes: vault.seedNotes });
    expect(quota.verdict).toBe("blocked");
    expect(quota.requiredCorpus).toBe("continuation-full-lifecycle-cleanup");
    expect(quota.observations.some(row => row.name === "quota-preserved-and-session-capacity-released")).toBe(true);
    const invalidPath = "Notes/ContractInvalidUtf8.md";
    await writeFile(join(vault.vaultPath, invalidPath), Buffer.from([0xc3, 0x28]));
    const utf8 = await runContractCrossCallScenario({ authority: await loadVersionContractPackage(packageRoot), scenarioId: "invalid-utf8-no-trusted-result", endpoint: bridge.endpoint, expectedVaultId: "frozen-vault", invalidUtf8Path: invalidPath, readFixtureBytes: readBytes });
    expect(utf8.verdict).toBe("passed");
    expect(utf8.observations.some(row => row.name === "invalid-utf8-untrusted-rejection")).toBe(true);
    await cleanupTestVault(vault);
  });
  it("closes coverage over the actual package, refusing missing, duplicate and unknown entries", async () => {
    const authority = await loadVersionContractPackage(packageRoot);
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
