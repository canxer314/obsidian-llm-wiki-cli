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

function gateIsolationEvidence(): NonNullable<InstalledRuntimeEvidence["gateIsolationCorpus"]> {
  return {
    corpusId: "per-vault-gate-isolation-proof",
    seedManifestSha256: DIGEST,
    scenarioManifestSha256: DIGEST,
    vaults: [
      {
        label: "vault-a",
        vaultIdSha256: DIGEST,
        beforeInventory: {
          scope: "Notes/*.md",
          entries: [{ path: "Notes/Welcome.md", sha256: DIGEST, sizeBytes: 42 }],
          digest: DIGEST,
        },
        afterInventory: {
          scope: "Notes/*.md",
          entries: [{ path: "Notes/Welcome.md", sha256: DIGEST, sizeBytes: 42 }],
          digest: DIGEST,
        },
      },
      {
        label: "vault-b",
        vaultIdSha256: DIGEST,
        beforeInventory: {
          scope: "Notes/*.md",
          entries: [{ path: "Notes/Welcome.md", sha256: DIGEST, sizeBytes: 42 }],
          digest: DIGEST,
        },
        afterInventory: {
          scope: "Notes/*.md",
          entries: [{ path: "Notes/Welcome.md", sha256: DIGEST, sizeBytes: 42 }],
          digest: DIGEST,
        },
      },
    ],
    submissions: [
      {
        vaultLabel: "vault-a",
        scenario: "isolation/shared-key-independent-registries",
        submissionKeySha256: DIGEST,
        changeSetId: "change-set-a",
        state: "in_progress",
        historicalGate: null,
      },
      {
        vaultLabel: "vault-b",
        scenario: "isolation/shared-key-independent-registries",
        submissionKeySha256: DIGEST,
        changeSetId: "change-set-b",
        state: "in_progress",
        historicalGate: null,
      },
    ],
    isolation: {
      sharedKeyIndependentRegistries: true,
      distinctChangeSetIds: true,
      crossVaultLookupRejected: true,
      queuesIndependent: true,
    },
    recoveryBlocked: {
      boundDispositions: 2,
      replayAfterRecovery: 1,
      conflictingReuseRejected: 1,
      freshKeyRenewed: 1,
      otherGatesLeftUnbound: 2,
    },
    manualPause: {
      drainedInFlightToTrustworthyEnd: true,
      fifoRetained: true,
      newUnboundRejected: 1,
      observationalContentAvailable: true,
    },
    incompatible: {
      registryInspected: 0,
      submissionKeysBound: 0,
      compatibleSessionUnaffected: true,
    },
    gateHistory: [
      {
        sequence: 1,
        vaultLabel: "vault-a",
        scenario: "gates/recovery-blocked-precedence",
        outcome: "observed",
        effectiveGate: "recovery_blocked",
        recoveryState: "blocked",
        writeState: "paused",
      },
      {
        sequence: 2,
        vaultLabel: "vault-a",
        scenario: "gates/writes-paused-row",
        outcome: "observed",
        effectiveGate: "writes_paused",
        recoveryState: "none",
        writeState: "paused",
      },
    ],
    residualCleanup: {
      "vault-a": { recoveryState: "none", writeGate: "open", writeState: "writable" },
      "vault-b": { recoveryState: "none", writeGate: "open", writeState: "writable" },
    },
    eventLog: [
      { sequence: 1, kind: "assertion", name: "gate-isolation-corpus-began", detailSha256: DIGEST },
    ],
    assertions: ["gate-isolation-corpus-began"],
    verdict: "passed",
  };
}

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
    publicWireCorpus: {
      fixtureSeed: DIGEST,
      canonicalManifestSha256: DIGEST,
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
        seedManifestSha256: DIGEST,
        scenarioManifestSha256: DIGEST,
      },
      beforeInventory: {
        scope: "Notes/*.md",
        entries: [{ path: "Notes/Welcome.md", sha256: DIGEST, sizeBytes: 42 }],
        digest: DIGEST,
      },
      afterInventory: {
        scope: "Notes/*.md",
        entries: [{ path: "Notes/Welcome.md", sha256: DIGEST, sizeBytes: 42 }],
        digest: DIGEST,
      },
      retainedByteCleanup: {
        chainsIssued: 1,
        chainsConsumed: 1,
        replayAfterConsumptionRejected: 1,
        bytesReconstructed: 42,
        residualChains: 0,
      },
      eventLog: [
        {
          sequence: 1,
          kind: "assertion",
          name: "public-tool-inventory",
          detailSha256: DIGEST,
        },
      ],
      assertions: ["public-tool-inventory"],
      verdict: "passed",
    },
    changeSetCorpus: {
      corpusId: "change-set-submission-proof",
      seedManifestSha256: DIGEST,
      scenarioManifestSha256: DIGEST,
      beforeInventory: {
        scope: "Notes/*.md",
        entries: [{ path: "Notes/Welcome.md", sha256: DIGEST, sizeBytes: 42 }],
        digest: DIGEST,
      },
      afterInventory: {
        scope: "Notes/*.md",
        entries: [{ path: "Notes/Welcome.md", sha256: DIGEST, sizeBytes: 42 }],
        digest: DIGEST,
      },
      admission: {
        submissions: [
          {
            submissionKeySha256: DIGEST,
            changeSetId: "change-set-1",
            state: "intent_applied",
            failureCode: null,
            executed: true,
          },
        ],
        rejectionClasses: [
          {
            name: "rejection/stale-direct-target",
            failureCode: "stale_observation",
            noMutationDigestUnchanged: true,
          },
        ],
        fifo: {
          concurrentSubmissions: 2,
          applied: 2,
          distinctChangeSetIds: 2,
          contendedTarget: {
            submissions: 2,
            winners: 1,
            rejected: 1,
            noPartialMutation: true,
          },
        },
        recovery: [
          {
            name: "recovery/missing-response",
            recoveredThroughOriginalKey: true,
            changedContentRejected: true,
            changedKeyCreatedNoChangeSet: true,
          },
        ],
        immutableRecords: [
          {
            submissionKeySha256: DIGEST,
            changeSetId: "change-set-1",
            state: "intent_applied",
            requestedEffectIds: ["op-1"],
            derivedEffectIds: [],
            pathCount: 2,
          },
        ],
      },
      replay: {
        keysReplayed: 1,
        identitiesPreserved: 1,
        recordsUnchanged: 1,
        conflictingReusesRejected: 1,
      },
      residualCleanup: {
        recoveryState: "none",
        queueLength: 0,
        currentExecutionId: null,
        writeGate: "open",
      },
      eventLog: [
        {
          sequence: 1,
          kind: "assertion",
          name: "change-set-corpus-began",
          detailSha256: DIGEST,
        },
      ],
      assertions: ["change-set-corpus-began"],
      verdict: "passed",
    },
    gateIsolationCorpus: gateIsolationEvidence(),
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

  it("refuses a passing verdict without a complete public-wire corpus", () => {
    const missingCorpus = { ...passingEvidence(), publicWireCorpus: null };
    expect(() => serializeEvidence(missingCorpus)).toThrow(/passing verdict/u);
  });

  it("refuses a passing verdict without a complete change-set corpus", () => {
    const missingWriteSide = { ...passingEvidence(), changeSetCorpus: null };
    expect(() => serializeEvidence(missingWriteSide)).toThrow(/passing verdict/u);
  });

  it("refuses passing change-set evidence whose seed inventory changed or proofs are missing", () => {
    const changedSeedInventory: InstalledRuntimeEvidence = {
      ...passingEvidence(),
      changeSetCorpus: {
        ...passingEvidence().changeSetCorpus!,
        beforeInventory: {
          scope: "Notes/*.md",
          entries: [
            { path: "Notes/Welcome.md", sha256: DIGEST, sizeBytes: 42 },
            { path: "Notes/Added.md", sha256: "f".repeat(64), sizeBytes: 7 },
          ],
          digest: "f".repeat(64),
        },
      },
    };
    expect(() => serializeEvidence(changedSeedInventory)).toThrow(/seed inventory unchanged/u);

    const noExecutedProofs: InstalledRuntimeEvidence = {
      ...passingEvidence(),
      changeSetCorpus: {
        ...passingEvidence().changeSetCorpus!,
        admission: {
          ...passingEvidence().changeSetCorpus!.admission,
          submissions: [
            {
              submissionKeySha256: DIGEST,
              changeSetId: "change-set-1",
              state: "intent_not_applied",
              failureCode: "path_conflict",
              executed: false,
            },
          ],
        },
      },
    };
    expect(() => serializeEvidence(noExecutedProofs)).toThrow(/executed proofs/u);
  });

  it("refuses passing evidence whose read-side corpus inventory changed or leaked chains", () => {
    const changedInventory: InstalledRuntimeEvidence = {
      ...passingEvidence(),
      publicWireCorpus: {
        ...passingEvidence().publicWireCorpus!,
        beforeInventory: {
          scope: "Notes/*.md",
          entries: [
            { path: "Notes/Welcome.md", sha256: DIGEST, sizeBytes: 42 },
            { path: "Notes/Added.md", sha256: DIGEST, sizeBytes: 7 },
          ],
          digest: "f".repeat(64),
        },
      },
    };
    expect(() => serializeEvidence(changedInventory)).toThrow(/inventory unchanged/u);

    const abandonedChain: InstalledRuntimeEvidence = {
      ...passingEvidence(),
      publicWireCorpus: {
        ...passingEvidence().publicWireCorpus!,
        retainedByteCleanup: {
          chainsIssued: 2,
          chainsConsumed: 1,
          replayAfterConsumptionRejected: 1,
          bytesReconstructed: 42,
          residualChains: 0,
        },
      },
    };
    expect(() => serializeEvidence(abandonedChain)).toThrow(/consume every continuation chain/u);

    const replayMismatch: InstalledRuntimeEvidence = {
      ...passingEvidence(),
      publicWireCorpus: {
        ...passingEvidence().publicWireCorpus!,
        retainedByteCleanup: {
          chainsIssued: 2,
          chainsConsumed: 2,
          replayAfterConsumptionRejected: 1,
          bytesReconstructed: 42,
          residualChains: 0,
        },
      },
    };
    expect(() => serializeEvidence(replayMismatch)).toThrow(/single-use replay rejection/u);
  });

  it("refuses a passing verdict when recorded gate-isolation evidence failed", () => {
    const failedGateIsolation: InstalledRuntimeEvidence = {
      ...passingEvidence(),
      gateIsolationCorpus: {
        ...passingEvidence().gateIsolationCorpus!,
        verdict: "failed",
      },
    };
    expect(() => serializeEvidence(failedGateIsolation)).toThrow(/passing verdict/u);
  });

  it("refuses passing gate-isolation evidence whose Vault inventory changed or proofs are missing", () => {
    const changedSeed: InstalledRuntimeEvidence = {
      ...passingEvidence(),
      gateIsolationCorpus: {
        ...passingEvidence().gateIsolationCorpus!,
        vaults: passingEvidence().gateIsolationCorpus!.vaults.map((vault, index) =>
          index === 0
            ? {
                ...vault,
                beforeInventory: {
                  scope: "Notes/*.md",
                  entries: [
                    { path: "Notes/Welcome.md", sha256: DIGEST, sizeBytes: 42 },
                    { path: "Notes/Added.md", sha256: "f".repeat(64), sizeBytes: 7 },
                  ],
                  digest: "f".repeat(64),
                },
              }
            : vault,
        ),
      },
    };
    expect(() => serializeEvidence(changedSeed)).toThrow(/vault-a seed inventory unchanged/u);

    const noBind: InstalledRuntimeEvidence = {
      ...passingEvidence(),
      gateIsolationCorpus: {
        ...passingEvidence().gateIsolationCorpus!,
        recoveryBlocked: {
          boundDispositions: 0,
          replayAfterRecovery: 1,
          conflictingReuseRejected: 1,
          freshKeyRenewed: 1,
          otherGatesLeftUnbound: 2,
        },
      },
    };
    expect(() => serializeEvidence(noBind)).toThrow(/recovery_blocked bind/u);

    const inspectedRegistry: InstalledRuntimeEvidence = {
      ...passingEvidence(),
      gateIsolationCorpus: {
        ...passingEvidence().gateIsolationCorpus!,
        incompatible: {
          registryInspected: 1,
          submissionKeysBound: 0,
          compatibleSessionUnaffected: true,
        },
      },
    };
    expect(() => serializeEvidence(inspectedRegistry)).toThrow(
      /expected 0|uninspected incompatible client/u,
    );
  });

  it("accepts a passing record with no gate-isolation corpus (the seam is optional)", () => {
    const withoutGateIsolation: InstalledRuntimeEvidence = {
      ...passingEvidence(),
      gateIsolationCorpus: null,
    };
    expect(parseEvidence(serializeEvidence(withoutGateIsolation))).toEqual(withoutGateIsolation);
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

  it("refuses serialization for JSON-escaped private markers (Windows paths and note bodies)", () => {
    // Windows absolute paths and multi-line note bodies contain characters
    // (backslashes, newlines) that JSON string serialization escapes; the
    // guard must match the escaped form, not just the raw substring.
    const windowsLeak = {
      ...passingEvidence(),
      verdict: "failed" as const,
      failure: {
        stage: "health_initial",
        code: "health_unreachable",
        detail: "connect failed for C:\\Obsidian\\ThinkFlywheelVault",
      },
    };
    expect(() => serializeEvidence(windowsLeak, ["C:\\Obsidian\\ThinkFlywheelVault"])).toThrow(
      EvidencePrivacyError,
    );
    const noteBodyLeak = {
      ...passingEvidence(),
      verdict: "failed" as const,
      failure: {
        stage: "cleanup",
        code: "residual_test_content",
        detail: "note body leaked:\n# Installed Runtime Harness",
      },
    };
    expect(() => serializeEvidence(noteBodyLeak, ["# Installed Runtime Harness"])).toThrow(
      EvidencePrivacyError,
    );
    expect(() => serializeEvidence(windowsLeak, ["C:/Obsidian/Other"])).not.toThrow();
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
