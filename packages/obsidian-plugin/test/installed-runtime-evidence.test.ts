import { createHash } from "node:crypto";
import { syntheticFifoProof } from "./helpers/fifo-proof.js";
import { syntheticManualPauseSource } from "./helpers/manual-pause-proof.js";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  createInstalledRuntimeAcceptanceMatrix as composeMatrix,
  EvidencePrivacyError,
  EvidenceWriteError,
  parseEvidence as parsePublicEvidence,
  serializeEvidence as serializePublicEvidence,
  writeEvidenceFile as writePublicEvidence,
  type InstalledRuntimeEvidence,
} from "../src/index.js";

import { observerReportFixture, observerSourceFixture } from "./helpers/plugin-event-observer-fixture.js";
const independentObserverContext = () => observerSourceFixture({ runId: "run-evidence", candidateBundleSha256: DIGEST, installedMainSha256: DIGEST, profileName: "MVP-PERF-REF-1", pluginId: "candidate-bridge", runtime: { platform: "win32", osBuild: "26200", obsidianVersion: "1.13.4", electronVersion: "39.6.0", nodeVersion: "24.14.0", capabilities: ["loopback_http"] } }).context;
let pauseFixture: ReturnType<typeof syntheticManualPauseSource>;
const createInstalledRuntimeAcceptanceMatrix = (report: InstalledRuntimeEvidence) => composeMatrix(report, independentObserverContext(), pauseFixture.context);
const serializeEvidence = (report: InstalledRuntimeEvidence, markers: readonly string[] = []) => serializePublicEvidence(report, markers, independentObserverContext(), pauseFixture.context);
const parseEvidence = (text: string) => parsePublicEvidence(text, independentObserverContext(), pauseFixture.context);
const writeEvidenceFile = (path: string, report: InstalledRuntimeEvidence, markers: readonly string[] = []) => writePublicEvidence(path, report, markers, independentObserverContext(), pauseFixture.context);
import { registeredReferenceRewriteCorpusEvidenceSchema } from "../src/installed-runtime/evidence.js";
import { SINGLE_SPAN_BEFORE, SINGLE_SPAN_AFTER } from "../src/installed-runtime/registered-reference-single-span.js";
const a26Digest = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const DIGEST = "a".repeat(64);
const REJECTION_NAMES = ["rejection/stale-direct-target", "rejection/read-dependency-stale", "rejection/attachment-evidence-mismatch", "rejection/derived-target-file-parent", "rejection/absence-condition", "rejection/non-unique-replacement", "rejection/occupied-destination"];

function semanticEvidenceSearchSnapshotEvidence(): NonNullable<
  InstalledRuntimeEvidence["semanticEvidenceSearchSnapshotCorpus"]
> {
  return {
    corpusId: "semantic-evidence-search-snapshot-proof",
    scenarioManifestSha256: DIGEST,
    tools: [
      "vault_health",
      "vault_discover",
      "vault_read",
      "vault_continue",
      "vault_change_set_submit",
      "vault_change_set_status",
    ],
    scenarios: [
      {
        scenario: "create_note/clean_convergence",
        source: "installed-obsidian",
        mutationKind: "create_note",
        proofState: "intent_applied",
        statusProofState: "intent_applied",
        journalPhase: "COMMITTED",
        evidenceDeadlineMs: 5_000,
        successBarrierDeadlineMs: 5_000,
        evidenceSessions: [{ mode: "apply", outcome: "converged", virtualElapsedMs: 250 }],
        quietWindowResets: 1,
        acceptedSnapshotRounds: 1,
        rejectedSnapshotRounds: 1,
        successorSnapshot: {
          baselineVersion: 1,
          version: 2,
          immutable: true,
          publishedBeforeIntentApplied: true,
        },
        durableCommitBeforeIntentApplied: true,
        writesBlocked: false,
        beforeInventorySha256: DIGEST,
        afterInventorySha256: DIGEST,
        cleanupSucceeded: true,
      },
      {
        scenario: "edit_body/contrary_third_party_blocks_writes",
        source: "installed-obsidian",
        mutationKind: "edit_body",
        proofState: "result_unproven",
        statusProofState: "result_unproven",
        journalPhase: "FAILED",
        evidenceDeadlineMs: 5_000,
        successBarrierDeadlineMs: 5_000,
        evidenceSessions: [{ mode: "apply", outcome: "timed_out", virtualElapsedMs: 5_000 }],
        quietWindowResets: 0,
        acceptedSnapshotRounds: 0,
        rejectedSnapshotRounds: 1,
        successorSnapshot: {
          baselineVersion: 1,
          version: null,
          immutable: false,
          publishedBeforeIntentApplied: false,
        },
        durableCommitBeforeIntentApplied: false,
        writesBlocked: true,
        residueSha256: DIGEST,
        beforeInventorySha256: DIGEST,
        afterInventorySha256: DIGEST,
        cleanupSucceeded: true,
      },
    ],
    coverage: {
      delayedOlderContentVersionRejected: true,
      quietWindowStabilityProven: true,
      createModifyRenameDeleteAndClosureProven: true,
      hiddenTrashRestoreUsesTargetedProbes: true,
      deadlineRollbackOrUnprovenProven: true,
      contraryEvidenceResetsQuietWindow: true,
      noPublicSearchSnapshotCapability: true,
    },
    residualCleanup: { reportsRemoved: true, residualReportPaths: [] },
    eventLog: [
      {
        sequence: 1,
        kind: "assertion",
        name: "semantic-evidence-corpus-began",
        detailSha256: DIGEST,
      },
    ],
    assertions: [
      "scenario:edit_body/stale_version_callback_after_newer_bytes:closed",
      "scenario:create_note/clean_convergence:closed",
      "scenario:edit_body/missing_observation_deadline:closed",
      "scenario:trash_note/delayed_probes_converge:closed",
      "transport:six-tool-inventory-without-search-snapshot",
    ],
    verdict: "passed",
  };
}

function gateIsolationEvidence(): NonNullable<InstalledRuntimeEvidence["gateIsolationCorpus"]> {
  pauseFixture = syntheticManualPauseSource("run-evidence", "MVP-PERF-REF-1", DIGEST, DIGEST);
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
      installedObservation: pauseFixture.proof,
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
    assertions: [
      "isolation/shared-key-independent-registries:distinct-change-set-ids",
      "recovery-blocked/atomic-bind-and-history:bound-intent-not-applied",
      "manual-pause/drain-and-fifo-retention:queued-order-retained",
      "incompatible/registry-never-inspected:no-key-bound",
      "gates/recovery-blocked-precedence:single-effective-gate",
    ],
    verdict: "passed",
  };
}

function registeredReferenceRewriteEvidence(): NonNullable<
  InstalledRuntimeEvidence["registeredReferenceRewriteCorpus"]
> {
  return {
    corpusId: "registered-reference-rewrite-proof",
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
    moves: [
      {
        scenario: "move/wikilink-destination-only",
        profile: "wikilink",
        submissionKeySha256: DIGEST,
        changeSetId: "change-set-w",
        sourcePath: "ReferenceProof/Grammar/Wikilink.md",
        destinationPath: "ReferenceProof/Grammar/Wikilink Moved.md",
        derivedPaths: ["derived/move-1/references/ReferenceProof/Grammar/WikilinkRef.md"],
        destinationContentVersionSha256: DIGEST,
        rewrittenContentVersionSha256: DIGEST,
        oldPathAbsent: true,
        destinationTypedMarkdown: true,
        finalBytesReread: true,
      },
      {
        scenario: "move/embed-destination-only",
        profile: "embed",
        submissionKeySha256: DIGEST,
        changeSetId: "change-set-e",
        sourcePath: "ReferenceProof/Grammar/Embed.md",
        destinationPath: "ReferenceProof/Grammar/Embed Moved.md",
        derivedPaths: ["derived/move-1/references/ReferenceProof/Grammar/EmbedRef.md"],
        destinationContentVersionSha256: DIGEST,
        rewrittenContentVersionSha256: DIGEST,
        oldPathAbsent: true,
        destinationTypedMarkdown: true,
        finalBytesReread: true,
      },
      {
        scenario: "move/markdown-inline-destination-only",
        profile: "markdown_inline_link",
        submissionKeySha256: DIGEST,
        changeSetId: "change-set-i",
        sourcePath: "ReferenceProof/Grammar/Inline.md",
        destinationPath: "ReferenceProof/Grammar/Inline Moved.md",
        derivedPaths: ["derived/move-1/references/ReferenceProof/Grammar/InlineRef.md"],
        destinationContentVersionSha256: DIGEST,
        rewrittenContentVersionSha256: DIGEST,
        oldPathAbsent: true,
        destinationTypedMarkdown: true,
        finalBytesReread: true,
      },
      {
        scenario: "move/markdown-embed-destination-only",
        profile: "markdown_embed",
        submissionKeySha256: DIGEST,
        changeSetId: "change-set-m",
        sourcePath: "ReferenceProof/Grammar/MdEmbed.md",
        destinationPath: "ReferenceProof/Grammar/MdEmbed Moved.md",
        derivedPaths: ["derived/move-1/references/ReferenceProof/Grammar/MdEmbedRef.md"],
        destinationContentVersionSha256: DIGEST,
        rewrittenContentVersionSha256: DIGEST,
        oldPathAbsent: true,
        destinationTypedMarkdown: true,
        finalBytesReread: true,
      },
    ],
    rawBytes: {
      fixtures: [
        {
          scenario: "span/bom-crlf-cjk-astral-exact",
          hostModes: ["bom", "crlf", "cjk", "astral"],
          locatedReferences: 1,
          everyReferenceExactlyOneVerifiedSpan: true,
          everyUntouchedByteExact: true,
          finalBytesHashReread: true,
        },
      ],
      duplicateEqualSpellings: { referencesRewritten: 2, untouchedBytesExact: true },
      secondEqualSpellingOnly: {
        scenario: "span/second-equal-spelling-only", fixturePath: "ReferenceProof/Single/Ref.md",
        fixtureSha256: a26Digest(SINGLE_SPAN_BEFORE), beforeSha256: a26Digest(SINGLE_SPAN_BEFORE), afterSha256: a26Digest(SINGLE_SPAN_AFTER),
        referencesLocated: 2, selectedOrdinal: 2, selectedSpan: { startByte: 58, endByteExclusive: 72 },
        beforeSizeBytes: 83, afterSizeBytes: 89, untouchedPrefixSha256: a26Digest(Buffer.from(SINGLE_SPAN_BEFORE).subarray(0, 58)), untouchedSuffixSha256: a26Digest(Buffer.from(SINGLE_SPAN_BEFORE).subarray(72)),
        untouchedPrefixExact: true, untouchedSuffixExact: true, firstReferenceExact: true, fullBytesExact: true, finalBytesHashReread: true,
      },
    },
    rejections: [
      {
        scenario: "reject/stale-closure",
        failureCode: "stale_observation",
        registered: true,
        noMutationDigestUnchanged: true,
      },
      {
        scenario: "reject/literal-hash-destination",
        failureCode: null,
        registered: true,
        noMutationDigestUnchanged: true,
      },
    ],
    observer: {
      enabledSecondObserver: true,
      discoversIssued: 3,
      privateStagingPathsObserved: 0,
      halfWrittenMarkdownObserved: 0,
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
        name: "registered-reference-corpus-began",
        detailSha256: DIGEST,
      },
    ],
    assertions: [
      "span/bom-crlf-cjk-astral:single-verified-span",
      "reject/stale-closure:no-mutation",
      "span/duplicate-equal-spellings:untouched-bytes-exact",
      "span/second-equal-spelling-only:untouched-bytes-exact",
      "observer:no-half-written-markdown",
    ],
    verdict: "passed",
  };
}

describe("A-26 public evidence", () => {
  it("rejects syntactically valid forged A-26 byte evidence", () => {
    const value = registeredReferenceRewriteEvidence();
    expect(registeredReferenceRewriteCorpusEvidenceSchema.safeParse({ ...value, rawBytes: { ...value.rawBytes, secondEqualSpellingOnly: { ...value.rawBytes.secondEqualSpellingOnly, afterSha256: "f".repeat(64) } } }).success).toBe(false);
  });
  it("rejects rename-all evidence without the independent second-span block", () => {
    const value = registeredReferenceRewriteEvidence();
    const { secondEqualSpellingOnly: _removed, ...rawBytes } = value.rawBytes as typeof value.rawBytes & { secondEqualSpellingOnly?: unknown };
    expect(registeredReferenceRewriteCorpusEvidenceSchema.safeParse({ ...value, rawBytes }).success).toBe(false);
  });
});

function crashRestorationRetainedAuthorityEvidence(): NonNullable<
  InstalledRuntimeEvidence["crashRestorationRetainedAuthorityCorpus"]
> {
  return {
    corpusId: "crash-restoration-retained-authority-proof",
    scenarioManifestSha256: DIGEST,
    records: [
      {
        mutationKind: "move",
        injectionPoint: "rollback:before_rollback",
        fixtureSha256: DIGEST,
        beforeInventorySha256: DIGEST,
        afterInventorySha256: DIGEST,
        proofState: "result_unproven",
        gate: "recovery_blocked",
        cleanupSucceeded: true,
        verdict: "passed",
      },
    ],
    coverage: {
      everyMutationKindAtEveryDeclaredBoundary: true,
      preparedRestoresWholeChangeSet: true,
      committedSuppressesRestoration: true,
      conflictingBytesPreservedAndWritesBlocked: true,
      deterministicJournalStorageDestinationAndSemanticFaults: true,
      callbackReorderAndSemanticTimeoutProven: true,
      concurrentIdempotencyProven: true,
    },
    retainedAuthority: {
      retentionMs: 7 * 24 * 60 * 60 * 1_000,
      queryableAcrossCrashAndReconnect: true,
      completeRecordsRetained: true,
      requiredRecordsNeverBecomeOrdinaryUnknown: true,
    },
    cleanup: { residualPaths: [], vaultVisibleStaging: 0, managedTrashLeakage: 0, fixtureResidue: 0 },
    eventLog: [
      {
        sequence: 1,
        kind: "assertion",
        name: "crash-restoration-corpus-began",
        detailSha256: DIGEST,
      },
    ],
    assertions: [
      "recovery:durable-prepared-restores-whole-change-set-before-writes",
      "recovery:compare-before-restore-preserves-third-party-bytes-and-blocks-writes",
      "retention:seven-day-records-queryable-across-crash-and-reconnect",
    ],
    verdict: "passed",
  };
}


// Synthetic orchestration/schema fixture, never installed acceptance evidence.
function rejectionFixture() {
  const entries = [
    { kind: "directory" as const, path: "Notes" },
    { kind: "directory" as const, path: "ChangeSetProof" },
    { kind: "file" as const, path: "Notes/Welcome.md", sha256: DIGEST, sizeBytes: 42 },
    { kind: "file" as const, path: "ChangeSetProof/AdmissionProof.md", sha256: DIGEST, sizeBytes: 44 },
    { kind: "file" as const, path: "ChangeSetProof/Editable.md", sha256: DIGEST, sizeBytes: 26 },
    { kind: "file" as const, path: "ChangeSetProof/Evidence.bin", sha256: DIGEST, sizeBytes: 5 },
    { kind: "absent" as const, path: "ChangeSetProof/ReadDep.md" },
    { kind: "absent" as const, path: "ChangeSetProof/copy.bin" },
    { kind: "absent" as const, path: "ChangeSetProof/AdmissionProof.md/Child.md" },
  ].map((entry) => Object.fromEntries(Object.entries(entry).sort(([left], [right]) => left.localeCompare(right)))) as Array<{kind:"file";path:string;sha256:string;sizeBytes:number}|{kind:"directory"|"absent";path:string}>;
  const digest = createHash("sha256").update(JSON.stringify(entries)).digest("hex");
  const proof = { submissionKeySha256: DIGEST, changeSetId: "rejected-fixture", state: "intent_not_applied" as const, failureCode: "stale_observation" as const, executed: false };
  return {
    name: "rejection/stale-direct-target", failureCode: "stale_observation" as const, noMutationDigestUnchanged: true as const,
    binding: { runId: "run-evidence", runtimeProfileId: "MVP-PERF-REF-1", candidateBundleSha256: DIGEST, vaultIdSha256: createHash("sha256").update("vault-evidence").digest("hex") },
    beforeInventory: { scope: "all-public-vault-files-directories-and-affected-absence" as const, entries, digest }, afterInventory: { scope: "all-public-vault-files-directories-and-affected-absence" as const, entries, digest }, proof, status: proof,
    eventOrder: { before: 1, submit: 2, status: 3, terminal: 4, after: 5 },
    terminal: { recoveryState: "none" as const, queueLength: 0 as const, currentExecutionId: null, writeGate: "open" as const },
  };
}
function rejectionFixtureEvents() {
  const fixture = rejectionFixture();
  const detailSha256 = createHash("sha256").update(JSON.stringify({ digest: fixture.beforeInventory.digest, entries: fixture.beforeInventory.entries, scope: fixture.beforeInventory.scope })).digest("hex");
  return [
    { sequence: 1, kind: "assertion" as const, name: `${fixture.name}:inventory-before`, detailSha256 },
    { sequence: 2, kind: "tool" as const, name: "vault_change_set_submit", detailSha256: DIGEST },
    { sequence: 3, kind: "tool" as const, name: "vault_change_set_status", detailSha256: DIGEST },
    { sequence: 4, kind: "tool" as const, name: "vault_health", detailSha256: createHash("sha256").update(JSON.stringify({ currentExecutionId: null, queueLength: 0, recoveryState: "none", vaultIdSha256: fixture.binding.vaultIdSha256, writeGate: "open" })).digest("hex") },
    { sequence: 5, kind: "assertion" as const, name: `${fixture.name}:inventory-after`, detailSha256 },
  ];
}

function passingEvidence(): InstalledRuntimeEvidence {
  const evidence: InstalledRuntimeEvidence = {
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
      assertions: [
        "connection-boundaries",
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
        rejectionClasses: REJECTION_NAMES.map((name, index) => {
          const failureCode = name === "rejection/non-unique-replacement" ? "exact_match_count_mismatch" as const : index < 3 ? "stale_observation" as const : "path_conflict" as const;
          const proof = { ...rejectionFixture().proof, failureCode, changeSetId: `rejected-${index}`, submissionKeySha256: createHash("sha256").update(name).digest("hex") };
          return { ...rejectionFixture(), name, failureCode, proof, status: proof, eventOrder: { before: index * 5 + 1, submit: index * 5 + 2, status: index * 5 + 3, terminal: index * 5 + 4, after: index * 5 + 5 } };
        }),
        fifo: {
          persistentObservation: syntheticFifoProof("run-evidence", "MVP-PERF-REF-1", DIGEST),
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
      eventLog: REJECTION_NAMES.flatMap((name, index) => rejectionFixtureEvents().map((event) => {
        const failureCode = name === "rejection/non-unique-replacement" ? "exact_match_count_mismatch" : index < 3 ? "stale_observation" : "path_conflict";
        const proof = { ...rejectionFixture().proof, failureCode, changeSetId: `rejected-${index}`, submissionKeySha256: createHash("sha256").update(name).digest("hex") };
        const canonicalProof = Object.fromEntries(Object.entries(proof).sort(([left], [right]) => left.localeCompare(right)));
        return { ...event, sequence: event.sequence + index * 5, name: event.name.replace("rejection/stale-direct-target", name), detailSha256: [2, 3].includes(event.sequence) ? createHash("sha256").update(JSON.stringify(canonicalProof)).digest("hex") : event.detailSha256 };
      })),
      assertions: [
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
      verdict: "passed",
    },
    pluginEventObserverCorpus: observerReportFixture({ runId: "run-evidence", candidateBundleSha256: DIGEST, installedMainSha256: DIGEST, profileName: "MVP-PERF-REF-1", pluginId: "candidate-bridge", runtime: { platform: "win32", osBuild: "26200", obsidianVersion: "1.13.4", electronVersion: "39.6.0", nodeVersion: "24.14.0", capabilities: ["loopback_http"] } }),
    gateIsolationCorpus: gateIsolationEvidence(),
    registeredReferenceRewriteCorpus: registeredReferenceRewriteEvidence(),
    semanticEvidenceSearchSnapshotCorpus: semanticEvidenceSearchSnapshotEvidence(),
    privacyRecoveryAuthorityCorpus: {
      corpusId: "privacy-recovery-authority-proof",
      scenarioManifestSha256: DIGEST,
      tools: ["vault_health", "vault_discover", "vault_read", "vault_continue", "vault_change_set_submit", "vault_change_set_status"],
      vaults: [
        { label: "vault-a", vaultIdSha256: DIGEST, healthSummarySha256: DIGEST },
        { label: "vault-b", vaultIdSha256: DIGEST, healthSummarySha256: DIGEST },
      ],
      diagnostics: { standardBundles: 2, validChecksums: 2, privateMarkersRejected: 1, stableOpaqueAliases: true, contentInclusiveLocalOnly: true },
      authority: { rejectedAgentAttempts: 1, agentStateMutations: 0, baselineAcceptanceLocalOnly: true, journalPreconditionsProven: true, explicitResumeRequired: true },
      isolation: { secondVaultUnaffected: true },
      residualCleanup: { residualPaths: [] },
      eventLog: [{ sequence: 1, kind: "assertion", name: "privacy", detailSha256: DIGEST }],
      assertions: [
        "health:closed-observed-summary-only",
      ],
      verdict: "passed",
    },
    releaseLifecycleCorpus: {
      corpusId: "verified-release-lifecycle-proof",
      scenarioManifestSha256: DIGEST,
      releases: {
        install: { pluginId: "candidate-bridge", pluginVersion: "0.2.0", bundleSha256: DIGEST, filesSha256: DIGEST },
        previous: { pluginId: "candidate-bridge", pluginVersion: "0.1.0", bundleSha256: DIGEST, filesSha256: DIGEST },
        upgrade: { pluginId: "candidate-bridge", pluginVersion: "0.2.0", bundleSha256: DIGEST, filesSha256: DIGEST },
      },
      inventories: { install: { beforeBundleSha256: DIGEST, afterBundleSha256: DIGEST, beforeStateSha256: DIGEST, afterStateSha256: DIGEST }, repair: { beforeBundleSha256: DIGEST, afterBundleSha256: DIGEST, beforeStateSha256: DIGEST, afterStateSha256: DIGEST }, upgrade: { beforeBundleSha256: DIGEST, afterBundleSha256: DIGEST, beforeStateSha256: DIGEST, afterStateSha256: DIGEST }, uninstall: { beforeBundleSha256: DIGEST, afterBundleSha256: DIGEST, beforeStateSha256: DIGEST, afterStateSha256: DIGEST }, purge: { beforeBundleSha256: DIGEST, afterBundleSha256: DIGEST, beforeStateSha256: DIGEST, afterStateSha256: DIGEST } },
      migration: { completedPhases: ["replace", "reload", "migrate", "recovery", "health"], drainedCurrentItem: true, healthRechecked: true, maintenancePaused: true, newSubmissionsRejected: true, explicitOperatorResumeRequired: true },
      rollback: { verifiedStagingBeforeReplacement: true, perVaultAtomicReplacement: true, unverifiedReleaseExecutable: false },
      lifecycleStatus: { notInstalled: true, installedNotEnabled: true, bridgeOffline: true, mcpNotRegistered: true, identityMismatch: true, ready: true },
      removal: { uninstallGuarded: true, purgeQueuedWorkRefused: true, purgeRecoveryRefused: true, purgeInteractive: true, backupVerified: true },
      cleanup: { scenarios: ["install", "upgrade", "uninstall", "purge"], residualPaths: [] },
      eventLog: [{ sequence: 1, kind: "assertion", name: "lifecycle", detailSha256: DIGEST }],
      assertions: [
        "upgrade:drain-stop-dequeue-reject-migrate-health-recheck-maintenance-pause",
        "install:verified-identity-attestation-sha-runtime-target-capacity-preflight",
      ],
      verdict: "passed",
    },
    crashRestorationRetainedAuthorityCorpus: crashRestorationRetainedAuthorityEvidence(),
    acceptanceMatrix: null,
    verdict: "passed",
    failure: null,
    cleanup: { attempted: true, residualPaths: [] },
  };
  return evidence;
}

describe("installed-runtime evidence record", () => {
  it.each(["submit", "status"] as const)("refuses %s event hash detached from rejection proof and key", (phase) => {
    const evidence = acceptedEvidence();
    const rejection = evidence.changeSetCorpus!.admission.rejectionClasses[0]!;
    evidence.changeSetCorpus!.eventLog[rejection.eventOrder[phase] - 1]!.detailSha256 = "f".repeat(64);
    expect(() => createInstalledRuntimeAcceptanceMatrix(evidence)).toThrow();
  });

  it("refuses Notes-only inventories pretending to prove all rejected effects", () => {
    const evidence = acceptedEvidence();
    const rejection = evidence.changeSetCorpus!.admission.rejectionClasses[0]!;
    rejection.beforeInventory.entries = rejection.afterInventory.entries = [{ path: "Notes", kind: "directory" }];
    const digest = createHash("sha256").update('[{"kind":"directory","path":"Notes"}]').digest("hex");
    rejection.beforeInventory.digest = rejection.afterInventory.digest = digest;
    const eventHash = createHash("sha256").update(JSON.stringify({ digest, entries: [{ kind: "directory", path: "Notes" }], scope: rejection.beforeInventory.scope })).digest("hex");
    evidence.changeSetCorpus!.eventLog[rejection.eventOrder.before - 1]!.detailSha256 = eventHash;
    evidence.changeSetCorpus!.eventLog[rejection.eventOrder.after - 1]!.detailSha256 = eventHash;
    expect(() => createInstalledRuntimeAcceptanceMatrix(evidence)).toThrow();
  });

  it("refuses a blocked terminal event hash behind an idle summary", () => {
    const evidence = acceptedEvidence();
    const rejection = evidence.changeSetCorpus!.admission.rejectionClasses[0]!;
    evidence.changeSetCorpus!.eventLog[rejection.eventOrder.terminal - 1]!.detailSha256 = createHash("sha256")
      .update(JSON.stringify({ currentExecutionId: null, queueLength: 1, recoveryState: "blocked", vaultIdSha256: rejection.binding.vaultIdSha256, writeGate: "open" })).digest("hex");
    expect(() => createInstalledRuntimeAcceptanceMatrix(evidence)).toThrow();
  });

  it("refuses a rejection with a different legal failure branch", () => {
    const evidence = acceptedEvidence();
    const rejection = evidence.changeSetCorpus!.admission.rejectionClasses[0]!;
    rejection.failureCode = "path_conflict";
    rejection.proof.failureCode = rejection.status.failureCode = "path_conflict";
    expect(() => createInstalledRuntimeAcceptanceMatrix(evidence)).toThrow();
  });

  it.each(["changeSetId", "submissionKeySha256"] as const)("refuses cross-scenario reused rejection %s", (field) => {
    const evidence = acceptedEvidence();
    const rejections = evidence.changeSetCorpus!.admission.rejectionClasses;
    for (const rejection of rejections) {
      rejection.proof[field] = "shared-rejection-identity";
      rejection.status[field] = "shared-rejection-identity";
      if (field === "submissionKeySha256") rejection.proof[field] = rejection.status[field] = DIGEST;
    }
    expect(() => {
      evidence.acceptanceMatrix = createInstalledRuntimeAcceptanceMatrix(evidence);
      serializeEvidence(evidence);
    }).toThrow();
  });

  it("refuses A-15 from assertions without real rejection inventory proof", () => {
    const evidence = acceptedEvidence();
    evidence.changeSetCorpus!.admission.rejectionClasses = [];
    expect(() => createInstalledRuntimeAcceptanceMatrix(evidence)).toThrow();
  });

  it("round-trips a passing record through serialization and parsing", () => {
    const evidence = acceptedEvidence();
    evidence.acceptanceMatrix = createInstalledRuntimeAcceptanceMatrix(evidence);
    const serialized = serializeEvidence(evidence);
    expect(parseEvidence(serialized)).toEqual(evidence);
    expect(() => parsePublicEvidence(serialized)).toThrow(/independently retained source context/);
    expect(() => serializePublicEvidence(evidence)).toThrow(/independently retained source context/);
    expect(serialized).not.toContain("capabilityToken");
    expect(serialized).not.toContain("rawBytesBase64");
  });

  it("refuses a passing record without a canonical acceptance matrix", () => {
    expect(() => serializeEvidence(passingEvidence())).toThrow(/acceptance matrix/u);
  });

  function acceptedEvidence(): InstalledRuntimeEvidence {
    const evidence = passingEvidence();
    evidence.acceptanceMatrix = createInstalledRuntimeAcceptanceMatrix(evidence);
    return evidence;
  }

  it("refuses an acceptance matrix that does not bind its child evidence", () => {
    const evidence = acceptedEvidence();
    evidence.publicWireCorpus = {
      ...evidence.publicWireCorpus!,
      fixtureSeed: "f".repeat(64),
    };
    expect(() => serializeEvidence(evidence)).toThrow(/does not bind/u);
  });

  it("rejects unknown fields and structural drift fail closed", () => {
    const evidence = acceptedEvidence();
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
    const missingCorpus = { ...acceptedEvidence(), publicWireCorpus: null };
    expect(() => serializeEvidence(missingCorpus)).toThrow(/passing verdict/u);
  });

  it("refuses a passing verdict without a complete change-set corpus", () => {
    const missingWriteSide = { ...acceptedEvidence(), changeSetCorpus: null };
    expect(() => serializeEvidence(missingWriteSide)).toThrow(/passing verdict/u);
  });

  it("refuses passing change-set evidence whose seed inventory changed or proofs are missing", () => {
    const changedSeedInventory: InstalledRuntimeEvidence = {
      ...acceptedEvidence(),
      changeSetCorpus: {
        ...acceptedEvidence().changeSetCorpus!,
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
      ...acceptedEvidence(),
      changeSetCorpus: {
        ...acceptedEvidence().changeSetCorpus!,
        admission: {
          ...acceptedEvidence().changeSetCorpus!.admission,
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
      ...acceptedEvidence(),
      publicWireCorpus: {
        ...acceptedEvidence().publicWireCorpus!,
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
      ...acceptedEvidence(),
      publicWireCorpus: {
        ...acceptedEvidence().publicWireCorpus!,
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
      ...acceptedEvidence(),
      publicWireCorpus: {
        ...acceptedEvidence().publicWireCorpus!,
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
      ...acceptedEvidence(),
      gateIsolationCorpus: {
        ...acceptedEvidence().gateIsolationCorpus!,
        verdict: "failed",
      },
    };
    expect(() => serializeEvidence(failedGateIsolation)).toThrow(/passing verdict/u);
  });

  it("refuses passing gate-isolation evidence whose Vault inventory changed or proofs are missing", () => {
    const changedSeed: InstalledRuntimeEvidence = {
      ...acceptedEvidence(),
      gateIsolationCorpus: {
        ...acceptedEvidence().gateIsolationCorpus!,
        vaults: acceptedEvidence().gateIsolationCorpus!.vaults.map((vault, index) =>
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
      ...acceptedEvidence(),
      gateIsolationCorpus: {
        ...acceptedEvidence().gateIsolationCorpus!,
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
      ...acceptedEvidence(),
      gateIsolationCorpus: {
        ...acceptedEvidence().gateIsolationCorpus!,
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

  it("refuses a passing record with an absent gate-isolation corpus", () => {
    const withoutGateIsolation: InstalledRuntimeEvidence = {
      ...acceptedEvidence(),
      gateIsolationCorpus: null,
    };
    expect(() => serializeEvidence(withoutGateIsolation)).toThrow(/passing verdict/u);
  });

  it("refuses a passing record with an absent registered-reference rewrite corpus", () => {
    const withoutRewrite: InstalledRuntimeEvidence = {
      ...acceptedEvidence(),
      registeredReferenceRewriteCorpus: null,
    };
    expect(() => serializeEvidence(withoutRewrite)).toThrow(/passing verdict/u);
  });

  it("refuses a passing record without semantic-evidence corpus proof", () => {
    const missingSemanticEvidence = {
      ...acceptedEvidence(),
      semanticEvidenceSearchSnapshotCorpus: null,
    };
    expect(() => serializeEvidence(missingSemanticEvidence)).toThrow(/Semantic Evidence/u);
  });

  it("refuses a passing record with invalid semantic-evidence commit ordering", () => {
    const invalidOrdering: InstalledRuntimeEvidence = {
      ...acceptedEvidence(),
      semanticEvidenceSearchSnapshotCorpus: {
        ...acceptedEvidence().semanticEvidenceSearchSnapshotCorpus!,
        scenarios: [
          {
            ...acceptedEvidence().semanticEvidenceSearchSnapshotCorpus!.scenarios[0]!,
            durableCommitBeforeIntentApplied: false,
          },
        ],
      },
    };
    expect(() => serializeEvidence(invalidOrdering)).toThrow(/durable COMMITTED/u);
  });

  it("refuses a passing verdict when recorded registered-reference evidence failed", () => {
    const failedRewrite: InstalledRuntimeEvidence = {
      ...acceptedEvidence(),
      registeredReferenceRewriteCorpus: {
        ...acceptedEvidence().registeredReferenceRewriteCorpus!,
        verdict: "failed",
      },
    };
    expect(() => serializeEvidence(failedRewrite)).toThrow(/passing verdict/u);
  });

  it("refuses passing registered-reference evidence whose seed inventory changed", () => {
    const changedSeed: InstalledRuntimeEvidence = {
      ...acceptedEvidence(),
      registeredReferenceRewriteCorpus: {
        ...acceptedEvidence().registeredReferenceRewriteCorpus!,
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
    expect(() => serializeEvidence(changedSeed)).toThrow(/seed inventory unchanged/u);
  });

  it("refuses a passing verdict without both lifecycle observations and clean cleanup", () => {
    const missingRestart = {
      ...acceptedEvidence(),
      observations: acceptedEvidence().observations.slice(0, 1),
    };
    expect(() => serializeEvidence(missingRestart)).toThrow(/passing verdict/u);

    const residual = {
      ...acceptedEvidence(),
      cleanup: { attempted: true as const, residualPaths: ["Notes/Welcome.md"] },
    };
    expect(() => serializeEvidence(residual)).toThrow(/passing verdict/u);

    const mismatched = {
      ...acceptedEvidence(),
      profile: {
        ...acceptedEvidence().profile,
        mismatches: [{ field: "os.build" as const, expected: "26200", actual: "26100" }],
      },
    };
    expect(() => serializeEvidence(mismatched)).toThrow(/passing verdict/u);
  });

  it("accepts failed and invalid evidence with null sections", () => {
    const failed: InstalledRuntimeEvidence = {
      ...acceptedEvidence(),
      candidate: null,
      bridgeIdentity: null,
      gateIsolationCorpus: null,
      changeSetCorpus: null,
      inputHashes: { candidateBundleSha256: null, vaultSeedManifestSha256: null },
      beforeInventory: null,
      afterInventory: null,
      inventoryComparison: null,
      observations: [],
      verdict: "failed",
      failure: { stage: "obsidian_start", code: "obsidian_start_failed" },
      cleanup: null,
      profile: { ...acceptedEvidence().profile, observed: null },
    };
    expect(parseEvidence(serializeEvidence(failed))).toEqual(failed);
  });

  it("refuses serialization when private markers leak into the record", () => {
    const leaked = {
      ...acceptedEvidence(),
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
      ...acceptedEvidence(),
      verdict: "failed" as const,
      failure: {
        stage: "health_initial",
        code: "health_unreachable",
        detail: "connect failed for C:\\Obsidian\\ThinkFlywheelVault",
      },
    };
    const windowsContext = pauseFixture.context;
    expect(() => serializeEvidence(windowsLeak, ["C:\\Obsidian\\ThinkFlywheelVault"])).toThrow(
      EvidencePrivacyError,
    );
    const noteBodyLeak = {
      ...acceptedEvidence(),
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
    expect(() => serializePublicEvidence(windowsLeak, ["C:/Obsidian/Other"], independentObserverContext(), windowsContext)).not.toThrow();
  });

  it("requires private pause context for serialization and re-consumption and rejects substituted public hashes", () => {
    const report = acceptedEvidence();
    const serialized = serializeEvidence(report);
    expect(() => serializePublicEvidence(report, [], independentObserverContext())).toThrow(/pause.*source/iu);
    expect(() => parsePublicEvidence(serialized, independentObserverContext())).toThrow(/pause.*source/iu);
    const tampered = JSON.parse(serialized) as InstalledRuntimeEvidence;
    const pause = tampered.gateIsolationCorpus!.manualPause.installedObservation!;
    pause.localActions[0].beforeSha256 = "0".repeat(64);
    expect(() => parseEvidence(JSON.stringify(tampered))).toThrow(/independent actual source/u);
    expect(serialized).not.toContain("capabilityToken");
    expect(serialized).not.toContain('"continuation":');
  });
  it("independently rechecks the retained pause pin before matrix, serialize, parse and write", async () => {
    const report = acceptedEvidence();
    const observerContext = independentObserverContext();
    const retained = structuredClone(pauseFixture.context);
    const text = serializePublicEvidence(report, [], observerContext, retained);
    expect(parsePublicEvidence(text, observerContext, retained)).toEqual(report);
    const changed = structuredClone(retained);
    changed.source!.wire[0]!.arguments = { injected: true };
    expect(changed.sourceSha256).toBe(retained.sourceSha256);
    expect(() => composeMatrix(report, observerContext, changed)).toThrow(/pin/u);
    expect(() => serializePublicEvidence(report, [], observerContext, changed)).toThrow(/pin/u);
    expect(() => parsePublicEvidence(text, observerContext, changed)).toThrow(/pin/u);
    const directory = await mkdtemp(join(tmpdir(), "pause-pin-write-"));
    const path = join(directory, "proof.json");
    try {
      await expect(writePublicEvidence(path, report, [], observerContext, changed)).rejects.toThrow(/pin/u);
      await expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" });
      await writePublicEvidence(path, report, [], observerContext, retained);
      expect(parsePublicEvidence(await readFile(path, "utf8"), observerContext, retained)).toEqual(report);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
  it("writes atomically, reads back through the schema, and never overwrites", async () => {
    const directory = await mkdtemp(join(tmpdir(), "installed-runtime-evidence-"));
    const evidencePath = join(directory, "nested", "run.json");
    const evidence = acceptedEvidence();
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
