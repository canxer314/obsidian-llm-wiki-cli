import { describe, expect, it } from "vitest";

import {
  createAcceptanceMatrixReport,
  validateAcceptanceMatrixReport,
  type InstalledRuntimeEvidence,
} from "../src/index.js";

const DIGEST = "a".repeat(64);

function corpus(assertions = ["proof"]): { scenarioManifestSha256: string; assertions: readonly string[] } {
  return { scenarioManifestSha256: DIGEST, assertions };
}

function evidence(): InstalledRuntimeEvidence {
  const publicWire = {
    ...corpus(),
    canonicalManifestSha256: DIGEST,
    tools: ["vault_health", "vault_discover", "vault_read", "vault_continue", "vault_change_set_submit", "vault_change_set_status"],
  };
  const changeSet = {
    ...corpus(),
    admission: { submissions: [{ executed: true, state: "intent_applied" }] },
  };
  const gate = {
    ...corpus(),
    residualCleanup: {
      "vault-a": { writeGate: "open" },
      "vault-b": { writeGate: "open" },
    },
  };
  const semantic = {
    ...corpus(),
    coverage: { noPublicSearchSnapshotCapability: true },
  };
  const privacy = {
    ...corpus(),
    authority: { baselineAcceptanceLocalOnly: true },
  };
  return {
    schemaVersion: 1,
    runId: "acceptance-run",
    startedAt: "2026-09-29T00:00:00.000Z",
    endedAt: "2026-09-29T00:01:00.000Z",
    profile: {
      name: "MVP-PERF-REF-1",
      registered: {
        os: { platform: "win32", build: "26200" },
        versions: { obsidian: "1.13.4", electron: "39.6.0", node: "24.14.0" },
        capabilities: ["loopback_http"],
        profileRequirement: "dedicated_candidate_only",
      },
      observed: { platform: "win32", osBuild: "26200", obsidianVersion: "1.13.4", electronVersion: "39.6.0", nodeVersion: "24.14.0", capabilities: ["loopback_http"] },
      mismatches: [],
    },
    candidate: { pluginId: "bridge", pluginVersion: "1.0.0", minAppVersion: "1.13.4", bundleSha256: DIGEST, files: [] },
    bridgeIdentity: { vaultId: "vault", listener: { address: "127.0.0.1", port: 32123 }, versions: { bridge: "1", plugin: "1", protocol: "1", persistentStateSchema: 1, recoveryJournalSchema: 1 } },
    inputHashes: { candidateBundleSha256: DIGEST, vaultSeedManifestSha256: DIGEST },
    beforeInventory: [],
    afterInventory: [],
    inventoryComparison: { beforeDigest: DIGEST, afterDigest: DIGEST, addedPaths: [], removedPaths: [], changedPaths: [] },
    observations: [
      { phase: "initial", overall: "healthy", readiness: { searchSnapshot: "ready", cache: "ready", index: "ready" }, recoveryState: "none", write: { gate: "open", state: "writable", pauseSource: null }, effectiveGate: null, reasonCodes: [], operatorAction: "none", healthSha256: DIGEST, vaultPathSha256: DIGEST },
      { phase: "after_restart", overall: "healthy", readiness: { searchSnapshot: "ready", cache: "ready", index: "ready" }, recoveryState: "none", write: { gate: "open", state: "writable", pauseSource: null }, effectiveGate: null, reasonCodes: [], operatorAction: "none", healthSha256: DIGEST, vaultPathSha256: DIGEST },
    ],
    publicWireCorpus: publicWire as NonNullable<InstalledRuntimeEvidence["publicWireCorpus"]>,
    changeSetCorpus: changeSet as NonNullable<InstalledRuntimeEvidence["changeSetCorpus"]>,
    gateIsolationCorpus: gate as NonNullable<InstalledRuntimeEvidence["gateIsolationCorpus"]>,
    registeredReferenceRewriteCorpus: corpus() as NonNullable<InstalledRuntimeEvidence["registeredReferenceRewriteCorpus"]>,
    semanticEvidenceSearchSnapshotCorpus: semantic as NonNullable<InstalledRuntimeEvidence["semanticEvidenceSearchSnapshotCorpus"]>,
    privacyRecoveryAuthorityCorpus: privacy as NonNullable<InstalledRuntimeEvidence["privacyRecoveryAuthorityCorpus"]>,
    releaseLifecycleCorpus: { ...corpus(), cleanup: { residualPaths: [] } } as NonNullable<InstalledRuntimeEvidence["releaseLifecycleCorpus"]>,
    crashRestorationRetainedAuthorityCorpus: { ...corpus(), cleanup: { fixtureResidue: 0 } } as NonNullable<InstalledRuntimeEvidence["crashRestorationRetainedAuthorityCorpus"]>,
    acceptanceMatrix: null,
    verdict: "passed",
    failure: null,
    cleanup: { attempted: true, residualPaths: [] },
  };
}

describe("authoritative A-01 through A-44 acceptance matrix", () => {
  it("covers every acceptance ID and every child corpus exactly once", () => {
    const report = createAcceptanceMatrixReport(evidence());
    expect(report.scenarios).toHaveLength(44);
    expect(new Set(report.scenarios.map((scenario) => scenario.id))).toHaveLength(44);
    expect(report.childManifests).toHaveLength(8);
    expect(new Set(report.childManifests.map((child) => child.corpusId))).toHaveLength(8);
    expect(validateAcceptanceMatrixReport(report)).toEqual(report);
  });

  it("is content-addressed independently of child-manifest input order", () => {
    const report = createAcceptanceMatrixReport(evidence());
    const reordered = { ...report, childManifests: [...report.childManifests].reverse() };
    expect(validateAcceptanceMatrixReport(reordered)).toEqual(reordered);
  });

  it("fails closed for an absent child, duplicate ID, invalid checksum, and residue", () => {
    const missingChild = evidence();
    missingChild.releaseLifecycleCorpus = null;
    expect(() => createAcceptanceMatrixReport(missingChild)).toThrow(/absent/u);

    const report = createAcceptanceMatrixReport(evidence());
    expect(() => validateAcceptanceMatrixReport({ ...report, scenarios: [...report.scenarios.slice(0, 43), report.scenarios[0]!] })).toThrow(/exactly once/u);
    expect(() => validateAcceptanceMatrixReport({ ...report, childManifests: report.childManifests.map((child, index) => index === 0 ? { ...child, manifestSha256: "x" } : child) })).toThrow();

    const residual = evidence();
    residual.cleanup = { attempted: true, residualPaths: ["residue"] };
    expect(() => createAcceptanceMatrixReport(residual)).toThrow(/residual/u);
  });
});
