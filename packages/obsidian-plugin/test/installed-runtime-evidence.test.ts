import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  EvidencePrivacyError,
  EvidenceWriteError,
  parseEvidence,
  serializeEvidence,
  writeEvidenceFile,
  type InstalledRuntimeEvidence,
} from "../src/index.js";

const DIGEST = "a".repeat(64);

function passingEvidence(): InstalledRuntimeEvidence {
  return {
    schemaVersion: 1,
    runId: "run-evidence",
    startedAt: "2026-09-04T00:00:00.000Z",
    endedAt: "2026-09-04T00:01:00.000Z",
    profile: {
      name: "MVP-PERF-REF-1",
      registered: {
        os: { platform: "win32", build: "26200" },
        versions: { obsidian: "1.13.4", electron: "39.6.0", node: "24.14.0" },
        capabilities: ["loopback_http"],
        profileRequirement: "dedicated_candidate_only",
      },
      observed: {
        platform: "win32",
        osBuild: "26200",
        obsidianVersion: "1.13.4",
        electronVersion: "39.6.0",
        nodeVersion: "24.14.0",
        capabilities: ["loopback_http"],
      },
      mismatches: [],
    },
    candidate: {
      pluginId: "candidate-bridge",
      pluginVersion: "0.2.0",
      minAppVersion: "1.13.4",
      bundleSha256: DIGEST,
      files: [{ path: "main.js", sha256: DIGEST, sizeBytes: 17 }],
    },
    bridgeIdentity: {
      vaultId: "vault-evidence",
      listener: { address: "127.0.0.1", port: 27123 },
      versions: {
        bridge: "0.1.0",
        plugin: "0.1.0",
        protocol: "1.0",
        persistentStateSchema: 2,
        recoveryJournalSchema: 1,
      },
    },
    inputHashes: { candidateBundleSha256: DIGEST, vaultSeedManifestSha256: DIGEST },
    beforeInventory: [{ path: "Notes/Welcome.md", sha256: DIGEST, sizeBytes: 42 }],
    afterInventory: [{ path: "Notes/Welcome.md", sha256: DIGEST, sizeBytes: 42 }],
    inventoryComparison: {
      beforeDigest: DIGEST,
      afterDigest: DIGEST,
      addedPaths: [],
      removedPaths: [],
      changedPaths: [],
    },
    observations: [
      {
        phase: "initial",
        overall: "healthy",
        readiness: { searchSnapshot: "ready", cache: "ready", index: "ready" },
        recoveryState: "none",
        write: { gate: "open", state: "writable", pauseSource: null },
        effectiveGate: null,
        reasonCodes: [],
        operatorAction: "none",
        healthSha256: DIGEST,
        vaultPathSha256: DIGEST,
      },
      {
        phase: "after_restart",
        overall: "healthy",
        readiness: { searchSnapshot: "ready", cache: "ready", index: "ready" },
        recoveryState: "none",
        write: { gate: "open", state: "writable", pauseSource: null },
        effectiveGate: null,
        reasonCodes: [],
        operatorAction: "none",
        healthSha256: DIGEST,
        vaultPathSha256: DIGEST,
      },
    ],
    verdict: "passed",
    failure: null,
    cleanup: { attempted: true, residualPaths: [] },
  };
}

describe("installed-runtime evidence record", () => {
  it("round-trips a passing record through serialization and parsing", () => {
    const evidence = passingEvidence();
    expect(parseEvidence(serializeEvidence(evidence))).toEqual(evidence);
  });

  it("rejects unknown fields and structural drift fail closed", () => {
    const evidence = passingEvidence();
    const tampered = { ...evidence, noteBodyPreview: "secret" };
    expect(() => serializeEvidence(tampered as InstalledRuntimeEvidence)).toThrow();
    const invalidInventory = {
      ...evidence,
      beforeInventory: [{ path: "Notes/Welcome.md", content: "# secret body" }],
    };
    expect(() =>
      serializeEvidence(invalidInventory as unknown as InstalledRuntimeEvidence),
    ).toThrow();
  });

  it("refuses a passing verdict without both lifecycle observations and clean cleanup", () => {
    const missingRestart = {
      ...passingEvidence(),
      observations: passingEvidence().observations.slice(0, 1),
    };
    expect(() => serializeEvidence(missingRestart)).toThrow(/passing verdict/u);

    const residual = {
      ...passingEvidence(),
      cleanup: { attempted: true as const, residualPaths: ["Notes/Welcome.md"] },
    };
    expect(() => serializeEvidence(residual)).toThrow(/passing verdict/u);

    const mismatched = {
      ...passingEvidence(),
      profile: {
        ...passingEvidence().profile,
        mismatches: [{ field: "os.build" as const, expected: "26200", actual: "26100" }],
      },
    };
    expect(() => serializeEvidence(mismatched)).toThrow(/passing verdict/u);
  });

  it("accepts failed and invalid evidence with null sections", () => {
    const failed: InstalledRuntimeEvidence = {
      ...passingEvidence(),
      candidate: null,
      bridgeIdentity: null,
      inputHashes: { candidateBundleSha256: null, vaultSeedManifestSha256: null },
      beforeInventory: null,
      afterInventory: null,
      inventoryComparison: null,
      observations: [],
      verdict: "failed",
      failure: { stage: "obsidian_start", code: "obsidian_start_failed" },
      cleanup: null,
      profile: { ...passingEvidence().profile, observed: null },
    };
    expect(parseEvidence(serializeEvidence(failed))).toEqual(failed);
  });

  it("refuses serialization when private markers leak into the record", () => {
    const leaked = {
      ...passingEvidence(),
      verdict: "failed" as const,
      failure: {
        stage: "health_initial",
        code: "health_unreachable",
        detail: "connect failed for D:/Secrets/PrivateVault",
      },
    };
    expect(() => serializeEvidence(leaked, ["D:/Secrets/PrivateVault"])).toThrow(
      EvidencePrivacyError,
    );
    expect(() => serializeEvidence(leaked, ["note body not present"])).not.toThrow();
  });

  it("writes atomically, reads back through the schema, and never overwrites", async () => {
    const directory = await mkdtemp(join(tmpdir(), "installed-runtime-evidence-"));
    const evidencePath = join(directory, "nested", "run.json");
    const evidence = passingEvidence();
    await writeEvidenceFile(evidencePath, evidence, ["private-marker"]);
    expect(parseEvidence(await readFile(evidencePath, "utf8"))).toEqual(evidence);
    await expect(writeEvidenceFile(evidencePath, evidence)).rejects.toBeInstanceOf(
      EvidenceWriteError,
    );
    // The original record survived the refused overwrite untouched.
    expect(parseEvidence(await readFile(evidencePath, "utf8"))).toEqual(evidence);
    await expect(writeFile(evidencePath, "tampered", "utf8")).resolves.toBeUndefined();
  });
});
