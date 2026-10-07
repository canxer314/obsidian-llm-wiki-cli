import { unitContractReport, bindUnitContractSiblings } from "./helpers/contract-report.js";
import { CONTRACT_PACKAGE_ASSERTION, contractDigest } from "../src/installed-runtime/contract-package-corpus.js";
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
    "concurrency/persistent-fifo:repreflight-and-restart-proven",
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
    "span/second-equal-spelling-only:untouched-bytes-exact",
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

// Synthetic verifier fixture only; this never claims an installed acceptance run.
function syntheticFifoProof() {
  const entries = [1, 2, 3, 4].map(i => ({ submissionKey: String(i).repeat(64), changeSetId: String(i + 4).repeat(64), enqueueSeq: i }));
  const event = (kind: string, i: number, extra = {}) => ({ kind, ...entries[i], ...extra });
  return {
    scope: "persistent-fifo-and-pre-mutation-repreflight", source: "installed-obsidian", runId: "acceptance-run", profile: "MVP-PERF-REF-1",
    candidateBundleSha256: DIGEST, installedMainSha256: DIGEST, vaultIdSha256: DIGEST, seed: DIGEST, canonicalManifestSha256: DIGEST,
    beforeInventorySha256: DIGEST, afterInventorySha256: DIGEST, targetAfterSha256: "2".repeat(64), dependencyAfterSha256: "4".repeat(64), derivedAfterSha256: DIGEST,
    replay: { keysReplayed: 4, identitiesPreserved: 4, recordsUnchanged: 4, noAdditionalExecutionEvents: true },
    enqueue: entries, staleKeys: [entries[1]!.submissionKey, entries[2]!.submissionKey], cleanupSucceeded: true, verdict: "passed",
    events: [event("enqueued", 0), event("started", 0, { writeLease: true }), event("preflight", 0, { accepted: true, writeLease: true }), event("first-mutation", 0), event("committed", 0),
      ...[1, 2, 3].map(i => event("enqueued", i)),
      { kind: "fixtures-changed", targetBefore: "1".repeat(64), targetAfter: "2".repeat(64), dependencyBefore: "3".repeat(64), dependencyAfter: "4".repeat(64) },
      { kind: "restart", stopped: true }, event("recovered", 0, { state: "intent_applied" }),
      ...[1, 2].flatMap(i => [event("started", i, { writeLease: true }), event("preflight", i, { accepted: false, writeLease: true }), event("terminal", i, { state: "intent_not_applied" })]),
      event("started", 3, { writeLease: true }), event("preflight", 3, { accepted: true, writeLease: true }), event("first-mutation", 3), event("committed", 3), event("terminal", 3, { state: "intent_applied" })],
  };
}

function evidence(): InstalledRuntimeEvidence {
  const publicWire = {
    ...corpus(ASSERTIONS.publicWire),
    canonicalManifestSha256: DIGEST,
    tools: ["vault_health", "vault_discover", "vault_read", "vault_continue", "vault_change_set_submit", "vault_change_set_status"],
  };
  const rejectionNames = ["rejection/stale-direct-target", "rejection/read-dependency-stale", "rejection/attachment-evidence-mismatch", "rejection/derived-target-file-parent", "rejection/absence-condition", "rejection/non-unique-replacement", "rejection/occupied-destination"];
  const inventoryEntries = [
        { kind: "directory" as const, path: "Notes" }, { kind: "directory" as const, path: "ChangeSetProof" },
        { kind: "file" as const, path: "Notes/Welcome.md", sha256: DIGEST, sizeBytes: 42 },
        { kind: "file" as const, path: "ChangeSetProof/AdmissionProof.md", sha256: DIGEST, sizeBytes: 44 },
        { kind: "file" as const, path: "ChangeSetProof/Editable.md", sha256: DIGEST, sizeBytes: 26 },
        { kind: "file" as const, path: "ChangeSetProof/Evidence.bin", sha256: DIGEST, sizeBytes: 5 },
        { kind: "absent" as const, path: "ChangeSetProof/ReadDep.md" },
        { kind: "absent" as const, path: "ChangeSetProof/copy.bin" },
        { kind: "absent" as const, path: "ChangeSetProof/AdmissionProof.md/Child.md" },
      ].map((entry) => Object.fromEntries(Object.entries(entry).sort(([left], [right]) => left.localeCompare(right)))) as Array<{kind:"file";path:string;sha256:string;sizeBytes:number}|{kind:"directory"|"absent";path:string}>;
      const inventoryDigest = createHash("sha256").update(JSON.stringify(inventoryEntries)).digest("hex");
      const inventory = { scope: "all-public-vault-files-directories-and-affected-absence" as const, entries: inventoryEntries, digest: inventoryDigest };
  const inventoryEventDigest = createHash("sha256").update(JSON.stringify({ digest: inventory.digest, entries: inventory.entries, scope: inventory.scope })).digest("hex");
  const rejectionProof = { submissionKeySha256: DIGEST, changeSetId: "rejected", state: "intent_not_applied" as const, failureCode: "stale_observation" as const, executed: false };
  const idle = { recoveryState: "none" as const, queueLength: 0 as const, currentExecutionId: null, writeGate: "open" as const };
  const proofs = rejectionNames.map((name, index) => ({ ...rejectionProof, changeSetId: `rejected-${index}`, submissionKeySha256: createHash("sha256").update(name).digest("hex"), failureCode: name === "rejection/non-unique-replacement" ? "exact_match_count_mismatch" : index < 3 ? "stale_observation" : "path_conflict" }));
  const canonicalHash = (value: Record<string, unknown>) => createHash("sha256").update(JSON.stringify(Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right))))).digest("hex");
  const seedInventory = { scope: "Notes/", entries: [], digest: DIGEST };
  const changeSet = {
    ...corpus(ASSERTIONS.changeSet),
    corpusId: "change-set-submission-proof", seedManifestSha256: DIGEST,
    beforeInventory: seedInventory, afterInventory: seedInventory,
    admission: {
      submissions: [{ submissionKeySha256: DIGEST, changeSetId: "applied", state: "intent_applied", failureCode: null, executed: true }],
      rejectionClasses: rejectionNames.map((name, index) => ({
        name, failureCode: proofs[index]!.failureCode, noMutationDigestUnchanged: true,
        binding: { runId: "acceptance-run", runtimeProfileId: "MVP-PERF-REF-1", candidateBundleSha256: DIGEST, vaultIdSha256: createHash("sha256").update("vault").digest("hex") },
        beforeInventory: inventory, afterInventory: inventory, proof: proofs[index], status: proofs[index], terminal: idle,
        eventOrder: { before: index * 5 + 1, submit: index * 5 + 2, status: index * 5 + 3, terminal: index * 5 + 4, after: index * 5 + 5 },
      })),
      fifo: { persistentObservation: syntheticFifoProof(), concurrentSubmissions: 1, applied: 1, distinctChangeSetIds: 1, contendedTarget: { submissions: 2, winners: 1, rejected: 1, noPartialMutation: true } },
      recovery: [{ name: "recovery", recoveredThroughOriginalKey: true, changedContentRejected: true, changedKeyCreatedNoChangeSet: true }],
      immutableRecords: [{ submissionKeySha256: DIGEST, changeSetId: "applied", state: "intent_applied", requestedEffectIds: ["operation"], derivedEffectIds: [], pathCount: 1 }],
    },
    replay: { keysReplayed: 1, identitiesPreserved: 1, recordsUnchanged: 1, conflictingReusesRejected: 1 },
    residualCleanup: idle,
    eventLog: rejectionNames.flatMap((name, index) => [
      { sequence: index * 5 + 1, kind: "assertion", name: `${name}:inventory-before`, detailSha256: inventoryEventDigest },
      { sequence: index * 5 + 2, kind: "tool", name: "vault_change_set_submit", detailSha256: canonicalHash(proofs[index]!) },
      { sequence: index * 5 + 3, kind: "tool", name: "vault_change_set_status", detailSha256: canonicalHash(proofs[index]!) },
      { sequence: index * 5 + 4, kind: "tool", name: "vault_health", detailSha256: canonicalHash({ ...idle, vaultIdSha256: createHash("sha256").update("vault").digest("hex") }) },
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
  const result: InstalledRuntimeEvidence = {
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
    contractPackageCorpus: unitContractReport({ runId: "acceptance-run", profileName: "MVP-PERF-REF-1", candidateBundleSha256: DIGEST, vaultIdSha256: contractDigest("vault"), seedManifestSha256: DIGEST }),
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
  bindUnitContractSiblings(result);
  return result;
}

describe("authoritative A-01 through A-44 acceptance matrix", () => {
  it("does not treat six handwritten tool calls as the A-39 version contract proof", () => {
    const missing = evidence(); missing.contractPackageCorpus = null;
    expect(() => createAcceptanceMatrixReport(missing)).toThrow(/version-contract-package.*absent/i);
  });
  it("rejects a foreign source Vault behind a matching parent report", () => {
    const forged = evidence();
    const row = forged.contractPackageCorpus!.crossCalls.find(row => row.id === "registered-reference-byte-verification")!;
    row.proof.dependency!.sourceVaults[0]!.sourceRunId = "foreign-run-child";
    row.evidenceSha256 = contractDigest(row.proof);
    expect(() => createAcceptanceMatrixReport(forged)).toThrow(/source Vault.*parent run/i);
  });
  it("rejects source Vault digests detached from their recorded identity", () => {
    const forged = evidence();
    const row = forged.contractPackageCorpus!.crossCalls.find(row => row.id === "registered-reference-byte-verification")!;
    row.proof.dependency!.sourceVaults[0]!.identityEventSha256 = "b".repeat(64);
    row.evidenceSha256 = contractDigest(row.proof);
    expect(() => createAcceptanceMatrixReport(forged)).toThrow(/identity.*digest|provenance/i);
  });
  it("rejects a semantic source Vault substituted behind the same sibling report", () => {
    const forged = evidence();
    const row = forged.contractPackageCorpus!.crossCalls.find(row => row.id === "successor-search-snapshot-graph-evidence")!;
    const vault = row.proof.dependency!.sourceVaults[0]!;
    vault.seedManifestSha256 = "b".repeat(64);
    const { identityEventSha256: _identity, cleanupEventSha256: _cleanup, ...details } = vault;
    vault.identityEventSha256 = contractDigest(details);
    row.evidenceSha256 = contractDigest(row.proof);
    expect(() => createAcceptanceMatrixReport(forged)).toThrow(/source Vault.*(record|provenance)/i);
  });
  it("rejects replay observation strings without durable registry and raw inventory proof", () => {
    const forged = evidence();
    const row = forged.contractPackageCorpus!.crossCalls.find(row => row.id === "change-set-same-key-replay")!;
    row.proof.programProof = null; row.evidenceSha256 = contractDigest(row.proof);
    expect(() => createAcceptanceMatrixReport(forged)).toThrow(/durable.*(proof|registry)/i);
  });
  it("rejects a durable replay entry borrowed from a different canonical request", () => {
    const forged = evidence();
    const row = forged.contractPackageCorpus!.crossCalls.find(row => row.id === "change-set-same-key-replay")!;
    for (const state of [row.proof.programProof!.beforeRepeat, row.proof.programProof!.afterRepeat]) state.entries[0]!.fingerprint = "sha256:" + "b".repeat(64);
    row.evidenceSha256 = contractDigest(row.proof);
    expect(() => createAcceptanceMatrixReport(forged)).toThrow(/durable.*request|fingerprint/i);
  });
  it("rejects an empty public inventory claiming replay executed once", () => {
    const forged = evidence();
    const row = forged.contractPackageCorpus!.crossCalls.find(row => row.id === "change-set-same-key-replay")!;
    row.proof.programProof!.beforeRepeat.inventory = []; row.proof.programProof!.afterRepeat.inventory = [];
    row.evidenceSha256 = contractDigest(row.proof);
    expect(() => createAcceptanceMatrixReport(forged)).toThrow(/public.*inventory|first.*effect/i);
  });
  it("rejects replay record digests detached from actual status wire output", () => {
    const forged = evidence();
    const row = forged.contractPackageCorpus!.crossCalls.find(row => row.id === "change-set-same-key-replay")!;
    row.proof.programProof!.responseRecordSha256 = "b".repeat(64);
    for (const state of [row.proof.programProof!.beforeRepeat, row.proof.programProof!.afterRepeat]) state.entries[0]!.recordSha256 = "b".repeat(64);
    row.evidenceSha256 = contractDigest(row.proof);
    expect(() => createAcceptanceMatrixReport(forged)).toThrow(/wire.*record|record.*wire/i);
  });
  it("rejects quota lifecycle reports without rejected-issuance capacity evidence", () => {
    const forged = evidence();
    const row = forged.contractPackageCorpus!.crossCalls.find(row => row.id === "continuation-quota-and-lifecycle-cleanup")!;
    row.observations = row.observations.filter(entry => entry.name !== "rejected-issuance-has-no-retained-authority"); row.proof.observations = row.observations; row.evidenceSha256 = contractDigest(row.proof);
    expect(() => createAcceptanceMatrixReport(forged)).toThrow(/cross.call behavior.*quota/i);
  });
  it("rejects graph transition declarations without their actual discover request and output", () => {
    const forged = evidence();
    const row = forged.contractPackageCorpus!.crossCalls.find(row => row.id === "successor-search-snapshot-graph-evidence")!;
    row.proof.graphTransitions = []; row.evidenceSha256 = contractDigest(row.proof);
    expect(() => createAcceptanceMatrixReport(forged)).toThrow(/graph.*(wire|transition).*proof/i);
  });
  it("rejects raw continuation authority inside persisted graph output", () => {
    const forged = evidence();
    const row = forged.contractPackageCorpus!.crossCalls.find(row => row.id === "successor-search-snapshot-graph-evidence")!;
    const output = row.proof.graphTransitions![0]!.after;
    if (output.outcome !== "results") throw new Error("fixture must be results");
    const oldHash = contractDigest(output);
    output.complete = false; output.continuation = "private-token-must-not-be-persisted";
    for (const entry of row.observations) if (entry.name === "vault_discover" && entry.responseSha256 === oldHash) entry.responseSha256 = contractDigest(output);
    const old = row.observations.find(entry => entry.facts.transition === "unresolved-link")!;
    old.facts.afterGraphSha256 = contractDigest(output);
    row.evidenceSha256 = contractDigest(row.proof);
    expect(() => createAcceptanceMatrixReport(forged)).toThrow(/continuation authority/i);
  });
  it("rejects Semantic successor summaries missing one actual graph transition", () => {
    const forged = evidence();
    const row = forged.contractPackageCorpus!.crossCalls.find(row => row.id === "successor-search-snapshot-graph-evidence")!;
    row.observations = row.observations.filter(entry => entry.facts.transition !== "rename"); row.proof.observations = row.observations;
    row.evidenceSha256 = contractDigest(row.proof);
    expect(() => createAcceptanceMatrixReport(forged)).toThrow(/(?:successor|graph).*transition/i);
  });
  it("does not replace successor graph cross-call behavior with native snapshot summary", () => {
    const forged = evidence();
    const row = forged.contractPackageCorpus!.crossCalls.find(row => row.id === "successor-search-snapshot-graph-evidence")!;
    row.observations = row.observations.filter(entry => entry.name !== "successor-graph-frozen-predecessor"); row.proof.observations = row.observations;
    row.evidenceSha256 = contractDigest(row.proof);
    expect(() => createAcceptanceMatrixReport(forged)).toThrow(/frozen.*predecessor/i);
  });
  it("rejects a contract source borrowed from a different sibling corpus", () => {
    const forged = evidence();
    const row = forged.contractPackageCorpus!.crossCalls.find(row => row.id === "registered-reference-byte-verification")!;
    (row.proof.dependency!.report as { scenarioManifestSha256: string }).scenarioManifestSha256 = "b".repeat(64);
    row.proof.dependency!.reportSha256 = contractDigest(row.proof.dependency!.report);
    row.evidenceSha256 = contractDigest(row.proof);
    expect(() => createAcceptanceMatrixReport(forged)).toThrow(/source.*sibling/i);
  });
  it("rejects raw continuation authority in publicly persisted dependency reports", () => {
    const forged = evidence();
    const row = forged.contractPackageCorpus!.crossCalls.find(row => row.id === "continuation-operational-gate-precedence")!;
    const calls = (row.proof.dependency!.report as { calls: { arguments: unknown; compatibilityText: string; structuredContent: unknown }[] }).calls;
    for (const call of calls) { call.arguments = { continuation: "private-token-must-not-be-published" }; call.compatibilityText = JSON.stringify(call.structuredContent); }
    row.proof.dependency!.reportSha256 = contractDigest(row.proof.dependency!.report);
    row.evidenceSha256 = contractDigest(row.proof);
    expect(() => createAcceptanceMatrixReport(forged)).toThrow();
  });
  it("rejects dependent sources reduced to assertion strings even after rehashing", () => {
    const forged = evidence();
    const row = forged.contractPackageCorpus!.crossCalls.find(row => row.id === "registered-reference-byte-verification")!;
    row.proof.dependency!.report = { assertions: ["span/bom-crlf-cjk-astral:single-verified-span"], verdict: "passed" };
    row.proof.dependency!.reportSha256 = contractDigest(row.proof.dependency!.report);
    row.evidenceSha256 = contractDigest(row.proof);
    expect(() => createAcceptanceMatrixReport(forged)).toThrow();
  });
  it("rejects a changed package authority digest even when coverage is complete", () => {
    const forged = evidence();
    forged.contractPackageCorpus!.authoritySha256 = "b".repeat(64);
    expect(() => createAcceptanceMatrixReport(forged)).toThrow(/authority.*digest/i);
  });
  it("rejects a static cross-call assertion presented as behavior proof", () => {
    const forged = evidence();
    forged.contractPackageCorpus!.crossCalls[0]!.observations = [{ sequence: 1, name: "fixture-loaded", requestSha256: DIGEST, responseSha256: DIGEST, facts: { fixtureLoaded: true } }];
    expect(() => createAcceptanceMatrixReport(forged)).toThrow(/cross-call.*(behavior|digest)/i);
  });
  it("rejects an executed fixture request digest not derived from the version authority", () => {
    const forged = evidence();
    const input = forged.contractPackageCorpus!.wire.inputs.find(row => row.id.startsWith("fixtures/"))!;
    input.requestSha256 = "b".repeat(64);
    expect(() => createAcceptanceMatrixReport(forged)).toThrow(/fixture.*request.*(digest|authority)/i);
  });
  it("rejects unknown-field rejection evidence detached from its rejected wire request", () => {
    const forged = evidence();
    forged.contractPackageCorpus!.wire.unknownFieldRejections[0]!.requestSha256 = "b".repeat(64);
    expect(() => createAcceptanceMatrixReport(forged)).toThrow(/unknown.field.*(request|evidence)/i);
  });
  it("requires consumed and malformed continuation rejection in addition to client binding", () => {
    const forged = evidence();
    const row = forged.contractPackageCorpus!.crossCalls.find(row => row.id === "single-use-client-bound-sliding-continuation")!;
    row.observations = row.observations.filter(entry => entry.name !== "consumed-token-replay-rejected" && entry.name !== "malformed-token-rejected");
    row.proof.observations = row.observations; row.evidenceSha256 = contractDigest(row.proof);
    expect(() => createAcceptanceMatrixReport(forged)).toThrow(/cross.call behavior.*continuation/i);
  });
  it("rejects contract fixture pointers detached from their executed request", () => {
    const forged = evidence();
    forged.contractPackageCorpus!.fixtures[0]!.evidencePointer = "wire/inputs/999";
    expect(() => createAcceptanceMatrixReport(forged)).toThrow(/fixture.*pointer/i);
  });
  it("maps A-26 to the independent second verified span, not rename-all", () => {
    expect(createAcceptanceMatrixReport(evidence()).scenarios.find(({ id }) => id === "A-26")?.assertion)
      .toBe("span/second-equal-spelling-only:untouched-bytes-exact");
  });

  it("refuses response-only FIFO claims without actual persistent observations", () => {
    const missing = evidence();
    delete missing.changeSetCorpus!.admission.fifo.persistentObservation;
    expect(() => createAcceptanceMatrixReport(missing)).toThrow(/FIFO/u);
  });
  it("covers every acceptance ID and every child corpus exactly once", () => {
    const report = createAcceptanceMatrixReport(evidence());
    expect(report.scenarios).toHaveLength(44);
    expect(new Set(report.scenarios.map((scenario) => scenario.id))).toHaveLength(44);
    expect(report.childManifests).toHaveLength(9);
    expect(new Set(report.childManifests.map((child) => child.corpusId))).toHaveLength(9);
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
