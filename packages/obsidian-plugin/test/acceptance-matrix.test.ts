import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  createAcceptanceMatrixReport,
  validateAcceptanceMatrixReport,
  type InstalledRuntimeEvidence,
} from "../src/index.js";

const DIGEST = "a".repeat(64);

function corpus(
  assertions = ["proof"],
): { scenarioManifestSha256: string; assertions: readonly string[] } {
  return { scenarioManifestSha256: DIGEST, assertions };
}

const ASSERTIONS = {
  publicWire: [
    "connection-boundaries",
    "public-tool-inventory",
    "discovery/empty-result:complete-empty-collection",
    "discovery/combined-graph:snapshot-bound-evidence",
    "read/ordered-byte-exact:preserves-index-and-duplicates",
    "read/ordered-byte-exact:no-section-fallback",
    "read/ordered-byte-exact:bom-cjk-astral-exact-utf8",
    "read/single-note-over-limit:refused-without-content",
    "read/multi-note-logical-grouping:deterministic-contiguous-groups",
    "continuation/framing:pages-within-256kib",
    "continuation/single-use-replay-rejected:continuation-unavailable",
    "continuation/quota-exhaustion:rejects-without-evicting-live-state",
    "six-tool-invocation",
    "content-version:canonical-markdown-sha256-and-attachment-distinction",
  ],
  changeSet: [
    "submission/valid-create:no-validate-apply-handshake",
    "rejection/stale-direct-target:no-mutation-inventory",
    "rejection/non-unique-replacement:exact_match_count_mismatch",
    "rejection/occupied-destination:path_conflict",
    "submission/replay-identical-key:no-re-execution",
    "submission/conflicting-key-reuse:no-new-change-set",
    "concurrency/independent-batch:applied-exactly-once",
    "recovery/missing-response:recovered-through-original-key",
    "preview/final-status-replay:immutable-effect-evidence",
  ],
  gate: [
    "isolation/shared-key-independent-registries:distinct-change-set-ids",
    "recovery-blocked/atomic-bind-and-history:bound-intent-not-applied",
    "manual-pause/drain-and-fifo-retention:queued-order-retained",
    "incompatible/registry-never-inspected:no-key-bound",
    "gates/recovery-blocked-precedence:single-effective-gate",
  ],
  rewrite: [
    "span/bom-crlf-cjk-astral:single-verified-span",
    "reject/stale-closure:no-mutation",
    "span/duplicate-equal-spellings:untouched-bytes-exact",
    "observer:no-half-written-markdown",
  ],
  semantic: [
    "scenario:edit_body/stale_version_callback_after_newer_bytes:closed",
    "scenario:create_note/clean_convergence:closed",
    "scenario:edit_body/missing_observation_deadline:closed",
    "scenario:trash_note/delayed_probes_converge:closed",
    "transport:six-tool-inventory-without-search-snapshot",
  ],
  privacy: [
    "health:closed-observed-summary-only",
  ],
  lifecycle: [
    "upgrade:drain-stop-dequeue-reject-migrate-health-recheck-maintenance-pause",
    "install:verified-identity-attestation-sha-runtime-target-capacity-preflight",
  ],
  crash: [
    "recovery:durable-prepared-restores-whole-change-set-before-writes",
    "recovery:compare-before-restore-preserves-third-party-bytes-and-blocks-writes",
    "retention:seven-day-records-queryable-across-crash-and-reconnect",
  ],
} as const;

function evidence(): InstalledRuntimeEvidence {
  const publicWire = {
    ...corpus(ASSERTIONS.publicWire),
    canonicalManifestSha256: DIGEST,
    tools: ["vault_health", "vault_discover", "vault_read", "vault_continue", "vault_change_set_submit", "vault_change_set_status"],
  };
  const rejectionNames = ["rejection/stale-direct-target", "rejection/read-dependency-stale", "rejection/attachment-evidence-mismatch", "rejection/derived-target-file-parent", "rejection/absence-condition", "rejection/non-unique-replacement", "rejection/occupied-destination"];
  const inventoryEntries = [{ kind: "directory" as const, path: "Notes" }];
  const inventory = { entries: inventoryEntries, digest: createHash("sha256").update(JSON.stringify(inventoryEntries)).digest("hex") };
  const inventoryEventDigest = createHash("sha256").update(JSON.stringify({ digest: inventory.digest, entries: inventory.entries })).digest("hex");
  const rejectionProof = { submissionKeySha256: DIGEST, changeSetId: "rejected", state: "intent_not_applied" as const, failureCode: "stale_observation" as const, executed: false };
  const idle = { recoveryState: "none" as const, queueLength: 0 as const, currentExecutionId: null, writeGate: "open" as const };
  const seedInventory = { scope: "Notes/", entries: [], digest: DIGEST };
  const changeSet = {
    ...corpus(ASSERTIONS.changeSet),
    corpusId: "change-set-submission-proof", seedManifestSha256: DIGEST,
    beforeInventory: seedInventory, afterInventory: seedInventory,
    admission: {
      submissions: [{ submissionKeySha256: DIGEST, changeSetId: "applied", state: "intent_applied", failureCode: null, executed: true }],
      rejectionClasses: rejectionNames.map((name, index) => ({
        name, failureCode: "stale_observation", noMutationDigestUnchanged: true,
        binding: { runId: "acceptance-run", runtimeProfileId: "MVP-PERF-REF-1", candidateBundleSha256: DIGEST, vaultIdSha256: createHash("sha256").update("vault").digest("hex") },
        beforeInventory: inventory, afterInventory: inventory, proof: rejectionProof, status: rejectionProof, terminal: idle,
        eventOrder: { before: index * 5 + 1, submit: index * 5 + 2, status: index * 5 + 3, terminal: index * 5 + 4, after: index * 5 + 5 },
      })),
      fifo: { concurrentSubmissions: 1, applied: 1, distinctChangeSetIds: 1, contendedTarget: { submissions: 2, winners: 1, rejected: 1, noPartialMutation: true } },
      recovery: [{ name: "recovery", recoveredThroughOriginalKey: true, changedContentRejected: true, changedKeyCreatedNoChangeSet: true }],
      immutableRecords: [{ submissionKeySha256: DIGEST, changeSetId: "applied", state: "intent_applied", requestedEffectIds: ["operation"], derivedEffectIds: [], pathCount: 1 }],
    },
    replay: { keysReplayed: 1, identitiesPreserved: 1, recordsUnchanged: 1, conflictingReusesRejected: 1 },
    residualCleanup: idle,
    eventLog: rejectionNames.flatMap((name, index) => [
      { sequence: index * 5 + 1, kind: "assertion", name: `${name}:inventory-before`, detailSha256: inventoryEventDigest },
      { sequence: index * 5 + 2, kind: "tool", name: "vault_change_set_submit", detailSha256: DIGEST },
      { sequence: index * 5 + 3, kind: "tool", name: "vault_change_set_status", detailSha256: DIGEST },
      { sequence: index * 5 + 4, kind: "tool", name: "vault_health", detailSha256: DIGEST },
      { sequence: index * 5 + 5, kind: "assertion", name: `${name}:inventory-after`, detailSha256: inventoryEventDigest },
    ]), verdict: "passed",
  };
  const gate = {
    ...corpus(ASSERTIONS.gate),
    residualCleanup: {
      "vault-a": { writeGate: "open" },
      "vault-b": { writeGate: "open" },
    },
  };
  const semantic = {
    ...corpus(ASSERTIONS.semantic),
    coverage: { noPublicSearchSnapshotCapability: true },
  };
  const privacy = {
    ...corpus(ASSERTIONS.privacy),
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
    registeredReferenceRewriteCorpus: corpus(ASSERTIONS.rewrite) as NonNullable<InstalledRuntimeEvidence["registeredReferenceRewriteCorpus"]>,
    semanticEvidenceSearchSnapshotCorpus: semantic as NonNullable<InstalledRuntimeEvidence["semanticEvidenceSearchSnapshotCorpus"]>,
    privacyRecoveryAuthorityCorpus: privacy as NonNullable<InstalledRuntimeEvidence["privacyRecoveryAuthorityCorpus"]>,
    releaseLifecycleCorpus: { ...corpus(ASSERTIONS.lifecycle), cleanup: { residualPaths: [] } } as NonNullable<InstalledRuntimeEvidence["releaseLifecycleCorpus"]>,
    crashRestorationRetainedAuthorityCorpus: { ...corpus(ASSERTIONS.crash), cleanup: { fixtureResidue: 0 } } as NonNullable<InstalledRuntimeEvidence["crashRestorationRetainedAuthorityCorpus"]>,
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

  it("binds every acceptance ID to a concrete child assertion", () => {
    const report = createAcceptanceMatrixReport(evidence());
    for (const scenario of report.scenarios) {
      const child = report.childManifests.find(
        ({ corpusId }) => corpusId === scenario.corpusId,
      );
      expect(child).toBeDefined();
      expect(scenario.evidencePointer).toMatch(
        new RegExp(`^childManifests/${scenario.corpusId}/assertions/`),
      );
      const index = Number(
        scenario.evidencePointer.split("/").at(-1)?.split("#")[0],
      );
      expect(child!.assertions[index]).toBe(scenario.assertion);
    }
    expect(new Set(report.scenarios.map(({ evidencePointer }) => evidencePointer))).toHaveLength(44);
  });

  it("binds quota, observer, and Content Version criteria to their direct proofs", () => {
    const report = createAcceptanceMatrixReport(evidence());
    expect(report.scenarios.find(({ id }) => id === "A-13")).toMatchObject({
      corpusId: "public-wire",
      assertion: "continuation/quota-exhaustion:rejects-without-evicting-live-state",
    });
    expect(report.scenarios.find(({ id }) => id === "A-37")).toMatchObject({
      corpusId: "registered-reference-rewrite",
      assertion: "observer:no-half-written-markdown",
    });
    expect(report.scenarios.find(({ id }) => id === "A-42")).toMatchObject({
      corpusId: "public-wire",
      assertion: "content-version:canonical-markdown-sha256-and-attachment-distinction",
    });
  });

  it("rejects a mismatched observed runtime even when the supplied mismatch list is empty", () => {
    const mismatched = evidence();
    mismatched.profile.observed = { ...mismatched.profile.observed!, obsidianVersion: "1.0.0" };
    expect(() => createAcceptanceMatrixReport(mismatched)).toThrow(/matched profile/u);
  });

  it("rejects aggregation whose verified input digest belongs to another candidate", () => {
    const foreign = evidence();
    foreign.inputHashes.candidateBundleSha256 = "b".repeat(64);
    expect(() => createAcceptanceMatrixReport(foreign)).toThrow(/candidate.*binding/u);
  });

  it("fails closed when a mapped scenario assertion is absent", () => {
    const missingScenarioEvidence = evidence();
    missingScenarioEvidence.publicWireCorpus = {
      ...missingScenarioEvidence.publicWireCorpus!,
      assertions: ["unrelated-proof"],
    };
    expect(() => createAcceptanceMatrixReport(missingScenarioEvidence)).toThrow(
      /A-02.*assertion/u,
    );
  });

  it("is content-addressed independently of child-manifest input order", () => {
    const report = createAcceptanceMatrixReport(evidence());
    const reordered = { ...report, childManifests: [...report.childManifests].reverse() };
    expect(validateAcceptanceMatrixReport(reordered)).toEqual(reordered);
  });

  it("rejects a rehashed report that substitutes another valid child assertion for a criterion", () => {
    const report = createAcceptanceMatrixReport(evidence());
    const wrong = report.scenarios.find(({ id }) => id === "A-04")!;
    const substituted = {
      ...report,
      scenarios: report.scenarios.map(scenario => scenario.id === "A-21" ? {
        ...wrong, id: "A-21", evidencePointer: wrong.evidencePointer.replace("#A-04", "#A-21"),
      } : scenario),
    };
    const canonical = (value: unknown): string => {
      if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
      if (typeof value === "object" && value !== null) {
        const record = value as Record<string, unknown>;
        return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
      }
      return JSON.stringify(value);
    };
    const { canonicalManifestSha256: _checksum, ...draft } = substituted;
    substituted.canonicalManifestSha256 = createHash("sha256").update(canonical(draft)).digest("hex");
    expect(() => validateAcceptanceMatrixReport(substituted)).toThrow(/A-21.*required proof/u);
  });

  it("rejects a rehashed final inspection that replaces a public tool with recovery authority", () => {
    const report = createAcceptanceMatrixReport(evidence());
    report.finalInspection.publicTools = ["vault_health", "vault_discover", "vault_read", "vault_continue", "vault_change_set_submit", "vault_resume_writes"].sort();
    const canonical = (value: unknown): string => {
      if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
      if (typeof value === "object" && value !== null) {
        const record = value as Record<string, unknown>;
        return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
      }
      return JSON.stringify(value);
    };
    const { canonicalManifestSha256: _checksum, ...draft } = report;
    report.canonicalManifestSha256 = createHash("sha256").update(canonical(draft)).digest("hex");
    expect(() => validateAcceptanceMatrixReport(report)).toThrow(/six public MCP tools/u);
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
