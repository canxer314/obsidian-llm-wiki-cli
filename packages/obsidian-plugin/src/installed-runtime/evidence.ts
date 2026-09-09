import { link, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { z } from "zod";

/**
 * Lifecycle-evidence seam (issue #197): one closed, machine-checkable record
 * per harness run. Evidence carries the registered runtime profile, candidate
 * /plugin/protocol identities, input hashes, before/after inventory, verdict,
 * and the residual-cleanup report — and never Vault note bodies, absolute
 * host paths, or other excluded private content (spec §9.4/§12.6). The
 * privacy guard is fail closed: serializing evidence that contains any
 * registered private marker throws instead of writing.
 */

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);

const inventoryEntrySchema = z
  .object({
    path: z.string().min(1),
    sha256: sha256Schema,
    sizeBytes: z.number().int().nonnegative(),
  })
  .strict();

const mismatchSchema = z
  .object({
    field: z.enum([
      "os.platform",
      "os.build",
      "versions.obsidian",
      "versions.electron",
      "versions.node",
      "capabilities",
    ]),
    expected: z.string(),
    actual: z.string().nullable(),
  })
  .strict();

const profileEvidenceSchema = z
  .object({
    name: z.string().min(1),
    registered: z
      .object({
        os: z.object({ platform: z.string(), build: z.string() }).strict(),
        versions: z
          .object({
            obsidian: z.string(),
            electron: z.string(),
            node: z.string(),
          })
          .strict(),
        capabilities: z.array(z.string()),
        profileRequirement: z.literal("dedicated_candidate_only"),
      })
      .strict(),
    observed: z
      .object({
        platform: z.string(),
        osBuild: z.string().nullable(),
        obsidianVersion: z.string().nullable(),
        electronVersion: z.string().nullable(),
        nodeVersion: z.string().nullable(),
        capabilities: z.array(z.string()),
      })
      .strict()
      .nullable(),
    mismatches: z.array(mismatchSchema),
  })
  .strict();

const candidateEvidenceSchema = z
  .object({
    pluginId: z.string().min(1),
    pluginVersion: z.string().min(1),
    minAppVersion: z.string().min(1),
    bundleSha256: sha256Schema,
    files: z.array(inventoryEntrySchema),
  })
  .strict();

const bridgeIdentityEvidenceSchema = z
  .object({
    vaultId: z.string().min(1),
    listener: z.object({ address: z.literal("127.0.0.1"), port: z.number().int() }).strict(),
    versions: z
      .object({
        bridge: z.string(),
        plugin: z.string(),
        protocol: z.string(),
        persistentStateSchema: z.number().int(),
        recoveryJournalSchema: z.number().int(),
      })
      .strict(),
  })
  .strict();

const healthObservationEvidenceSchema = z
  .object({
    phase: z.enum(["initial", "after_restart"]),
    overall: z.enum(["healthy", "degraded", "blocked"]),
    readiness: z
      .object({
        searchSnapshot: z.enum(["ready", "building", "unavailable"]),
        cache: z.enum(["ready", "building", "unavailable"]),
        index: z.enum(["ready", "building", "unavailable"]),
      })
      .strict(),
    recoveryState: z.enum(["none", "in_progress", "blocked"]),
    write: z
      .object({
        gate: z.enum(["open", "blocked"]),
        state: z.enum(["writable", "pausing", "paused"]),
        pauseSource: z.enum(["manual", "maintenance"]).nullable(),
      })
      .strict(),
    effectiveGate: z.string().nullable(),
    reasonCodes: z.array(z.string()),
    operatorAction: z.string(),
    /** Digest of the complete validated health payload (raw payload excluded). */
    healthSha256: sha256Schema,
    /** Digest of the absolute Vault path; the path itself is never recorded. */
    vaultPathSha256: sha256Schema,
  })
  .strict();

const inventoryComparisonSchema = z
  .object({
    beforeDigest: sha256Schema,
    afterDigest: sha256Schema,
    addedPaths: z.array(z.string()),
    removedPaths: z.array(z.string()),
    changedPaths: z.array(z.string()),
  })
  .strict();

const cleanupEvidenceSchema = z
  .object({
    attempted: z.literal(true),
    residualPaths: z.array(z.string()),
  })
  .strict();

const publicWireEventSchema = z
  .object({
    sequence: z.number().int().positive(),
    kind: z.enum(["transport", "tool", "assertion", "cleanup"]),
    name: z.string().min(1),
    detailSha256: sha256Schema,
  })
  .strict();

/**
 * Deterministic corpus identity (issue #174): one closed, machine-checkable
 * name for the read-side corpus plus the immutable seed-inventory and
 * scenario-program digests that make a run reproducible. The seed manifest is
 * the same canonical fixture digest the harness provisions; the scenario
 * manifest hashes the deterministic discovery/read/continuation program (not
 * the run-dependent continuation tokens, which appear only as event digests).
 */
const corpusIdentitySchema = z
  .object({
    corpusId: z.literal("discovery-reads-continuation"),
    seedManifestSha256: sha256Schema,
    scenarioManifestSha256: sha256Schema,
  })
  .strict();

/**
 * A wire-observed inventory: canonical path, exact Content Version, and byte
 * size only — never note bodies — plus a digest over the sorted entries. The
 * read-side corpus records this from deterministic discovery before and after
 * every read/continuation scenario so any mutation would flip the digest.
 */
const corpusInventorySchema = z
  .object({
    scope: z.string().min(1),
    entries: z.array(inventoryEntrySchema),
    digest: sha256Schema,
  })
  .strict();

/**
 * Retained-byte cleanup report (spec §6.4): every continuation chain the
 * corpus issues is consumed to completion and the consumed token is rejected
 * on replay, which is the protocol-visible proof that single use released the
 * retained frozen bytes. `residualChains` is a literal zero because the corpus
 * never abandons a chain.
 */
const retainedByteCleanupReportSchema = z
  .object({
    chainsIssued: z.number().int().nonnegative(),
    chainsConsumed: z.number().int().nonnegative(),
    replayAfterConsumptionRejected: z.number().int().nonnegative(),
    bytesReconstructed: z.number().int().nonnegative(),
    residualChains: z.literal(0),
  })
  .strict();

/**
 * One per-submission-key proof record (issue #175): the Submission Key is
 * recorded only as a digest, never raw; the Change Set identity, terminal
 * proof state, and whether execution advanced are the durable identity
 * evidence a replay across disconnect/restart must reproduce unchanged.
 */
const changeSetSubmissionProofSchema = z
  .object({
    submissionKeySha256: sha256Schema,
    changeSetId: z.string().min(1),
    state: z.enum(["intent_applied", "intent_not_applied", "in_progress", "result_unproven"]),
    failureCode: z.string().min(1).nullable(),
    executed: z.boolean(),
  })
  .strict();

/** One preflight rejection class: the stable failure code and no-mutation proof. */
const changeSetRejectionClassSchema = z
  .object({
    name: z.string().min(1),
    failureCode: z.enum(["stale_observation", "path_conflict", "exact_match_count_mismatch"]),
    noMutationDigestUnchanged: z.literal(true),
  })
  .strict();

/** FIFO/concurrency report: exactly-once admission plus contended-target exclusion. */
const changeSetFifoReportSchema = z
  .object({
    concurrentSubmissions: z.number().int().positive(),
    applied: z.number().int().nonnegative(),
    distinctChangeSetIds: z.number().int().nonnegative(),
    contendedTarget: z
      .object({
        submissions: z.number().int().positive(),
        winners: z.literal(1),
        rejected: z.number().int().nonnegative(),
        noPartialMutation: z.literal(true),
      })
      .strict(),
  })
  .strict();

/** Replay report across a transport restart: identical identity, no re-execution. */
const changeSetReplayReportSchema = z
  .object({
    keysReplayed: z.number().int().positive(),
    identitiesPreserved: z.number().int().positive(),
    recordsUnchanged: z.number().int().positive(),
    conflictingReusesRejected: z.number().int().positive(),
  })
  .strict();

/** One response-corruption recovery class. */
const changeSetRecoveryClassSchema = z
  .object({
    name: z.string().min(1),
    recoveredThroughOriginalKey: z.literal(true),
    changedContentRejected: z.literal(true),
    changedKeyCreatedNoChangeSet: z.literal(true),
  })
  .strict();

/** An immutable record compared across preview, final result, status, and replay. */
const immutableChangeSetRecordSchema = z
  .object({
    submissionKeySha256: sha256Schema,
    changeSetId: z.string().min(1),
    state: z.literal("intent_applied"),
    requestedEffectIds: z.array(z.string().min(1)).min(1),
    derivedEffectIds: z.array(z.string().min(1)),
    pathCount: z.number().int().positive(),
  })
  .strict();

const changeSetIdleStateSchema = z
  .object({
    recoveryState: z.literal("none"),
    queueLength: z.literal(0),
    currentExecutionId: z.null(),
    writeGate: z.literal("open"),
  })
  .strict();

/**
 * Deterministic Change Set submission corpus identity (issue #175): one closed
 * name for the write-side corpus plus the seed-inventory and scenario-program
 * digests that make a run reproducible. The admission section records
 * per-Submission-Key proof records, every lease-time preflight rejection class
 * with a no-mutation digest check, the FIFO/concurrency report, the
 * response-corruption recovery report, and immutable records proven stable
 * across preview/final/status/replay. Replay across the controlled restart
 * records the durable identity evidence. `beforeInventory`/`afterInventory`
 * scope the deterministic seed notes the corpus never mutates; a passing run
 * requires the observed digest unchanged. The residual-cleanup report is
 * wire-observed Bridge idle state (no recovery frame, drained queue, open
 * write gate), never a skipped green.
 */
const changeSetCorpusEvidenceSchema = z
  .object({
    corpusId: z.literal("change-set-submission-proof"),
    seedManifestSha256: sha256Schema,
    scenarioManifestSha256: sha256Schema,
    beforeInventory: corpusInventorySchema,
    afterInventory: corpusInventorySchema,
    admission: z
      .object({
        submissions: z.array(changeSetSubmissionProofSchema).min(1),
        rejectionClasses: z.array(changeSetRejectionClassSchema).min(1),
        fifo: changeSetFifoReportSchema,
        recovery: z.array(changeSetRecoveryClassSchema).min(1),
        immutableRecords: z.array(immutableChangeSetRecordSchema).min(1),
      })
      .strict(),
    replay: changeSetReplayReportSchema,
    residualCleanup: changeSetIdleStateSchema,
    eventLog: z.array(publicWireEventSchema).min(1),
    assertions: z.array(z.string().min(1)),
    verdict: z.enum(["passed", "failed"]),
  })
  .strict()
  .superRefine((corpus, context) => {
    if (!corpus.eventLog.every((event, index) => event.sequence === index + 1)) {
      context.addIssue({ code: "custom", message: "Change-set event sequences must be monotonic" });
    }
    if (corpus.verdict === "passed" && corpus.assertions.length === 0) {
      context.addIssue({ code: "custom", message: "Passing change-set evidence requires assertions" });
    }
    if (
      corpus.verdict === "passed" &&
      corpus.beforeInventory.digest !== corpus.afterInventory.digest
    ) {
      context.addIssue({
        code: "custom",
        message: "A passing change-set corpus must leave the deterministic seed inventory unchanged",
      });
    }
    if (corpus.verdict === "passed") {
      const executed = corpus.admission.submissions.filter((record) => record.executed);
      if (executed.length === 0) {
        context.addIssue({ code: "custom", message: "A passing change-set corpus requires executed proofs" });
      }
      if (corpus.admission.rejectionClasses.some((entry) => !entry.noMutationDigestUnchanged)) {
        context.addIssue({ code: "custom", message: "Every rejection class must prove no mutation" });
      }
    }
  });

const gateIsolationVaultEvidenceSchema = z
  .object({
    label: z.enum(["vault-a", "vault-b"]),
    /** Digest of the Vault identity; the raw identity is never recorded. */
    vaultIdSha256: sha256Schema,
    beforeInventory: corpusInventorySchema,
    afterInventory: corpusInventorySchema,
  })
  .strict();

/** One wire-observed effective-gate transition (issue #177). */
const gateHistoryEntrySchema = z
  .object({
    sequence: z.number().int().positive(),
    vaultLabel: z.enum(["vault-a", "vault-b", "incompatible-a"]),
    scenario: z.string().min(1),
    outcome: z.enum(["observed", "incompatible"]),
    effectiveGate: z.string().min(1).nullable(),
    recoveryState: z.enum(["none", "in_progress", "blocked"]).nullable(),
    writeState: z.enum(["writable", "pausing", "paused"]).nullable(),
  })
  .strict();

/** One digest-only per-key proof record bound by the corpus. */
const gateIsolationSubmissionProofSchema = z
  .object({
    vaultLabel: z.enum(["vault-a", "vault-b"]),
    scenario: z.string().min(1),
    submissionKeySha256: sha256Schema,
    changeSetId: z.string().min(1),
    state: z.enum(["intent_applied", "intent_not_applied", "in_progress", "result_unproven"]),
    historicalGate: z.literal("recovery_blocked").nullable(),
  })
  .strict();

/**
 * Deterministic per-Vault gate-and-isolation corpus identity (issue #177): one
 * closed name for the two-Vault gate corpus plus the digest-only per-Vault
 * inventories, the ordered wire-observed gate-history digest, the wire-observed
 * residual-cleanup report, and a release-blocking verdict. A passing run
 * requires both Vault seed inventories unchanged and every required proof
 * present.
 */
export const gateIsolationCorpusEvidenceSchema = z
  .object({
    corpusId: z.literal("per-vault-gate-isolation-proof"),
    seedManifestSha256: sha256Schema,
    scenarioManifestSha256: sha256Schema,
    vaults: z.array(gateIsolationVaultEvidenceSchema).length(2),
    submissions: z.array(gateIsolationSubmissionProofSchema),
    isolation: z
      .object({
        sharedKeyIndependentRegistries: z.literal(true),
        distinctChangeSetIds: z.literal(true),
        crossVaultLookupRejected: z.literal(true),
        queuesIndependent: z.literal(true),
      })
      .strict(),
    recoveryBlocked: z
      .object({
        boundDispositions: z.number().int().positive(),
        replayAfterRecovery: z.number().int().positive(),
        conflictingReuseRejected: z.number().int().positive(),
        freshKeyRenewed: z.number().int().positive(),
        otherGatesLeftUnbound: z.number().int().positive(),
      })
      .strict(),
    manualPause: z
      .object({
        drainedInFlightToTrustworthyEnd: z.literal(true),
        fifoRetained: z.literal(true),
        newUnboundRejected: z.number().int().positive(),
        observationalContentAvailable: z.literal(true),
      })
      .strict(),
    incompatible: z
      .object({
        registryInspected: z.literal(0),
        submissionKeysBound: z.literal(0),
        compatibleSessionUnaffected: z.literal(true),
      })
      .strict(),
    gateHistory: z.array(gateHistoryEntrySchema).min(1),
    residualCleanup: z
      .object({
        "vault-a": z
          .object({
            recoveryState: z.literal("none"),
            writeGate: z.literal("open"),
            writeState: z.literal("writable"),
          })
          .strict(),
        "vault-b": z
          .object({
            recoveryState: z.literal("none"),
            writeGate: z.literal("open"),
            writeState: z.literal("writable"),
          })
          .strict(),
      })
      .strict(),
    eventLog: z.array(publicWireEventSchema).min(1),
    assertions: z.array(z.string().min(1)),
    verdict: z.enum(["passed", "failed"]),
  })
  .strict()
  .superRefine((corpus, context) => {
    if (!corpus.eventLog.every((event, index) => event.sequence === index + 1)) {
      context.addIssue({ code: "custom", message: "Gate-isolation event sequences must be monotonic" });
    }
    if (!corpus.gateHistory.every((entry, index) => entry.sequence === index + 1)) {
      context.addIssue({ code: "custom", message: "Gate-history sequences must be monotonic" });
    }
    if (corpus.verdict === "passed" && corpus.assertions.length === 0) {
      context.addIssue({ code: "custom", message: "Passing gate-isolation evidence requires assertions" });
    }
    for (const vault of corpus.vaults) {
      if (
        corpus.verdict === "passed" &&
        vault.beforeInventory.digest !== vault.afterInventory.digest
      ) {
        context.addIssue({
          code: "custom",
          message: `A passing gate-isolation corpus must leave the ${vault.label} seed inventory unchanged`,
        });
      }
    }
    if (corpus.verdict === "passed") {
      if (
        corpus.isolation.sharedKeyIndependentRegistries !== true ||
        corpus.isolation.distinctChangeSetIds !== true ||
        corpus.isolation.crossVaultLookupRejected !== true ||
        corpus.isolation.queuesIndependent !== true
      ) {
        context.addIssue({ code: "custom", message: "A passing gate-isolation corpus requires all isolation proofs" });
      }
      if (corpus.recoveryBlocked.boundDispositions < 1) {
        context.addIssue({ code: "custom", message: "A passing gate-isolation corpus requires a recovery_blocked bind" });
      }
      if (corpus.manualPause.fifoRetained !== true) {
        context.addIssue({ code: "custom", message: "A passing gate-isolation corpus requires FIFO retention" });
      }
      if (
        corpus.incompatible.registryInspected !== 0 ||
        corpus.incompatible.submissionKeysBound !== 0 ||
        corpus.incompatible.compatibleSessionUnaffected !== true
      ) {
        context.addIssue({ code: "custom", message: "A passing gate-isolation corpus requires an uninspected incompatible client" });
      }
    }
  });

/**
 * One destination-only rewrite proof record (issue #178): a successful note
 * move whose derived registered-reference rewrites are explicit, causally
 * ordered, version-guarded Change Set effects. The record exposes the
 * requested move, the derived rewrite identities (referrer paths), old-path
 * absence, destination typed state, and exact final Content Versions — and
 * never note bodies or absolute host paths.
 */
const rewriteMoveProofSchema = z
  .object({
    scenario: z.string().min(1),
    profile: z.enum(["wikilink", "embed", "markdown_inline_link", "markdown_embed"]),
    submissionKeySha256: sha256Schema,
    changeSetId: z.string().min(1),
    sourcePath: z.string().min(1),
    destinationPath: z.string().min(1),
    derivedPaths: z.array(z.string().min(1)).min(1),
    /** Bare sha256 digest of the destination note's exact final bytes. */
    destinationContentVersionSha256: sha256Schema,
    /** Bare sha256 digest of the first derived referrer's exact final bytes. */
    rewrittenContentVersionSha256: sha256Schema,
    oldPathAbsent: z.literal(true),
    destinationTypedMarkdown: z.literal(true),
    finalBytesReread: z.literal(true),
  })
  .strict();

/**
 * One raw-byte span proof (issue #178 AC2/AC3): a referrer whose host UTF-16
 * positions (BOM/CRLF/CJK/astral modes) acted only as candidate locators. Every
 * located reference resolved to exactly one raw UTF-8 span matching both the
 * cached original and the raw source slice, every untouched byte stayed exact,
 * and the final bytes/hash were reread after the rewrite.
 */
const rawByteFixtureProofSchema = z
  .object({
    scenario: z.string().min(1),
    hostModes: z.array(z.string().min(1)).min(1),
    locatedReferences: z.number().int().positive(),
    everyReferenceExactlyOneVerifiedSpan: z.literal(true),
    everyUntouchedByteExact: z.literal(true),
    finalBytesHashReread: z.literal(true),
  })
  .strict();

const duplicateSpellingProofSchema = z
  .object({
    referencesRewritten: z.number().int().positive(),
    untouchedBytesExact: z.literal(true),
  })
  .strict();

/**
 * One no-guessing rejection class (issue #178 AC3/AC4): the complete Change
 * Set rejected without mutation. `registered` records whether the wire submit
 * registered an `intent_not_applied` disposition (true) or failed earlier
 * (false, e.g. the reference graph refused to close); either way the digest
 * invariant proves no byte was mutated.
 */
const rewriteRejectionProofSchema = z
  .object({
    scenario: z.string().min(1),
    failureCode: z.string().min(1).nullable(),
    registered: z.boolean(),
    noMutationDigestUnchanged: z.literal(true),
  })
  .strict();

/**
 * Observer evidence (issue #178 AC5): a second enabled MCP event observer that
 * polled the Vault across successful work and rejection saw neither
 * plugin-private staging paths nor half-written Markdown.
 */
const rewriteObserverEvidenceSchema = z
  .object({
    enabledSecondObserver: z.boolean(),
    discoversIssued: z.number().int().positive(),
    privateStagingPathsObserved: z.literal(0),
    halfWrittenMarkdownObserved: z.literal(0),
  })
  .strict();

/**
 * Deterministic registered-reference rewrite corpus identity (issue #178): one
 * closed name for the move-rewrite corpus plus the seed-inventory and
 * scenario-program digests that make a run reproducible. The moves section
 * records the destination-only rewrite proofs; rawBytes records the
 * UTF-16-to-UTF-8 span proofs; rejections records the no-guessing classes;
 * observer records the second-observer privacy evidence; and residualCleanup is
 * wire-observed Bridge idle state. `beforeInventory`/`afterInventory` scope the
 * deterministic seed notes the corpus never mutates.
 */
export const registeredReferenceRewriteCorpusEvidenceSchema = z
  .object({
    corpusId: z.literal("registered-reference-rewrite-proof"),
    seedManifestSha256: sha256Schema,
    scenarioManifestSha256: sha256Schema,
    beforeInventory: corpusInventorySchema,
    afterInventory: corpusInventorySchema,
    moves: z.array(rewriteMoveProofSchema).min(4),
    rawBytes: z
      .object({
        fixtures: z.array(rawByteFixtureProofSchema).min(1),
        duplicateEqualSpellings: duplicateSpellingProofSchema,
      })
      .strict(),
    rejections: z.array(rewriteRejectionProofSchema).min(1),
    observer: rewriteObserverEvidenceSchema,
    residualCleanup: changeSetIdleStateSchema,
    eventLog: z.array(publicWireEventSchema).min(1),
    assertions: z.array(z.string().min(1)),
    verdict: z.enum(["passed", "failed"]),
  })
  .strict()
  .superRefine((corpus, context) => {
    if (!corpus.eventLog.every((event, index) => event.sequence === index + 1)) {
      context.addIssue({ code: "custom", message: "Registered-reference event sequences must be monotonic" });
    }
    if (corpus.verdict === "passed" && corpus.assertions.length === 0) {
      context.addIssue({ code: "custom", message: "Passing registered-reference evidence requires assertions" });
    }
    if (
      corpus.verdict === "passed" &&
      corpus.beforeInventory.digest !== corpus.afterInventory.digest
    ) {
      context.addIssue({
        code: "custom",
        message: "A passing registered-reference corpus must leave the deterministic seed inventory unchanged",
      });
    }
    if (corpus.verdict === "passed") {
      if (corpus.moves.length < 4) {
        context.addIssue({ code: "custom", message: "A passing registered-reference corpus requires all four grammar move proofs" });
      }
      if (corpus.rejections.some((entry) => !entry.noMutationDigestUnchanged)) {
        context.addIssue({ code: "custom", message: "Every registered-reference rejection must prove no mutation" });
      }
      if (corpus.observer.enabledSecondObserver !== true) {
        context.addIssue({ code: "custom", message: "A passing registered-reference corpus requires a second observer" });
      }
    }
  });

export const publicWireCorpusEvidenceSchema = z
  .object({
    fixtureSeed: sha256Schema,
    canonicalManifestSha256: sha256Schema,
    tools: z.array(z.string().min(1)).length(6),
    corpus: corpusIdentitySchema,
    beforeInventory: corpusInventorySchema,
    afterInventory: corpusInventorySchema,
    retainedByteCleanup: retainedByteCleanupReportSchema,
    eventLog: z.array(publicWireEventSchema).min(1),
    assertions: z.array(z.string().min(1)),
    verdict: z.enum(["passed", "failed"]),
  })
  .strict()
  .superRefine((corpus, context) => {
    if (new Set(corpus.tools).size !== 6) {
      context.addIssue({ code: "custom", message: "Public-wire evidence must name six distinct tools" });
    }
    if (!corpus.eventLog.every((event, index) => event.sequence === index + 1)) {
      context.addIssue({ code: "custom", message: "Public-wire event sequences must be monotonic" });
    }
    if (corpus.verdict === "passed" && corpus.assertions.length === 0) {
      context.addIssue({ code: "custom", message: "Passing public-wire evidence requires assertions" });
    }
    if (
      corpus.verdict === "passed" &&
      corpus.beforeInventory.digest !== corpus.afterInventory.digest
    ) {
      context.addIssue({
        code: "custom",
        message: "A passing read-side corpus must leave the observed inventory unchanged",
      });
    }
    if (corpus.retainedByteCleanup.chainsConsumed !== corpus.retainedByteCleanup.chainsIssued) {
      context.addIssue({
        code: "custom",
        message: "A passing corpus must consume every continuation chain it issues",
      });
    }
    if (
      corpus.retainedByteCleanup.chainsIssued > 0 &&
      corpus.retainedByteCleanup.replayAfterConsumptionRejected !==
        corpus.retainedByteCleanup.chainsIssued
    ) {
      context.addIssue({
        code: "custom",
        message: "Every consumed chain must prove single-use replay rejection",
      });
    }
  });

export const installedRuntimeEvidenceSchema = z
  .object({
    schemaVersion: z.literal(1),
    runId: z.string().min(1),
    startedAt: z.string().min(1),
    endedAt: z.string().min(1),
    profile: profileEvidenceSchema,
    candidate: candidateEvidenceSchema.nullable(),
    bridgeIdentity: bridgeIdentityEvidenceSchema.nullable(),
    inputHashes: z
      .object({
        candidateBundleSha256: sha256Schema.nullable(),
        vaultSeedManifestSha256: sha256Schema.nullable(),
      })
      .strict(),
    beforeInventory: z.array(inventoryEntrySchema).nullable(),
    afterInventory: z.array(inventoryEntrySchema).nullable(),
    inventoryComparison: inventoryComparisonSchema.nullable(),
    observations: z.array(healthObservationEvidenceSchema),
    publicWireCorpus: publicWireCorpusEvidenceSchema.nullable(),
    changeSetCorpus: changeSetCorpusEvidenceSchema.nullable(),
    gateIsolationCorpus: gateIsolationCorpusEvidenceSchema.nullable(),
    registeredReferenceRewriteCorpus:
      registeredReferenceRewriteCorpusEvidenceSchema.nullable(),
    verdict: z.enum(["passed", "failed", "invalid"]),
    failure: z
      .object({
        stage: z.string().min(1),
        code: z.string().min(1),
        detail: z.string().optional(),
      })
      .strict()
      .nullable(),
    cleanup: cleanupEvidenceSchema.nullable(),
  })
  .strict()
  .refine(
    (evidence) =>
      evidence.verdict === "passed"
        ? evidence.failure === null &&
          evidence.candidate !== null &&
          evidence.bridgeIdentity !== null &&
          evidence.observations.some((observation) => observation.phase === "initial") &&
          evidence.observations.some((observation) => observation.phase === "after_restart") &&
          evidence.publicWireCorpus !== null &&
          evidence.publicWireCorpus.verdict === "passed" &&
          evidence.changeSetCorpus !== null &&
          evidence.changeSetCorpus.verdict === "passed" &&
          (evidence.gateIsolationCorpus === null ||
            evidence.gateIsolationCorpus.verdict === "passed") &&
          (evidence.registeredReferenceRewriteCorpus === null ||
            evidence.registeredReferenceRewriteCorpus.verdict === "passed") &&
          evidence.cleanup !== null &&
          evidence.cleanup.residualPaths.length === 0 &&
          evidence.profile.mismatches.length === 0
        : true,
    {
      message:
        "A passing verdict requires a matched profile, candidate and Bridge identity, both health observations, clean read- and write-side corpus evidence, and any recorded gate-isolation evidence to pass",
    },
  );

export type PublicWireCorpusEvidence = z.infer<typeof publicWireCorpusEvidenceSchema>;
export type ChangeSetCorpusEvidence = z.infer<typeof changeSetCorpusEvidenceSchema>;
export type GateIsolationCorpusEvidence = z.infer<typeof gateIsolationCorpusEvidenceSchema>;
export type RegisteredReferenceRewriteCorpusEvidence = z.infer<
  typeof registeredReferenceRewriteCorpusEvidenceSchema
>;
export type InstalledRuntimeEvidence = z.infer<typeof installedRuntimeEvidenceSchema>;
export type InstalledRuntimeVerdict = InstalledRuntimeEvidence["verdict"];

export class EvidencePrivacyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EvidencePrivacyError";
  }
}

export class EvidenceWriteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EvidenceWriteError";
  }
}

/**
 * Serializes evidence canonically, then proves no registered private marker —
 * seeded note bodies, absolute Vault/profile roots, and anything else the
 * orchestrator marks — leaked into the record. A leak refuses serialization.
 */
export function serializeEvidence(
  evidence: InstalledRuntimeEvidence,
  privateMarkers: readonly string[] = [],
): string {
  const validated = installedRuntimeEvidenceSchema.parse(evidence);
  const serialized = `${JSON.stringify(validated, null, 2)}\n`;
  for (const marker of privateMarkers) {
    if (marker.length === 0) continue;
    // A marker inside a JSON string value is escaped (backslashes, newlines,
    // quotes, control characters), so a raw substring search would miss the
    // exact markers the harness registers — Windows paths and multi-line note
    // bodies. Search for the JSON-escaped form the serialization actually
    // contains; for markers without special characters the escaped form is
    // identical to the marker itself.
    const escapedMarker = JSON.stringify(marker).slice(1, -1);
    if (serialized.includes(marker) || serialized.includes(escapedMarker)) {
      throw new EvidencePrivacyError(
        "Evidence contains excluded private content and was not written",
      );
    }
  }
  return serialized;
}

export function parseEvidence(serialized: string): InstalledRuntimeEvidence {
  return installedRuntimeEvidenceSchema.parse(JSON.parse(serialized));
}

/**
 * Atomically writes one evidence record and reads it back through the closed
 * schema so a partially written or corrupted record can never pass as
 * registered evidence. An existing evidence file is never overwritten.
 */
export async function writeEvidenceFile(
  evidencePath: string,
  evidence: InstalledRuntimeEvidence,
  privateMarkers: readonly string[] = [],
): Promise<void> {
  const serialized = serializeEvidence(evidence, privateMarkers);
  await mkdir(dirname(evidencePath), { recursive: true });
  const temporaryPath = join(
    dirname(evidencePath),
    `.${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}.tmp`,
  );
  await writeFile(temporaryPath, serialized, { encoding: "utf8", flag: "wx" });
  try {
    // Hard-link fails with EEXIST when the target exists, so an earlier
    // evidence record is never silently overwritten (POSIX rename would).
    await link(temporaryPath, evidencePath);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new EvidenceWriteError(
        `Refusing to overwrite existing evidence: ${evidencePath}`,
      );
    }
    throw error;
  }
  await rm(temporaryPath, { force: true });
  const written = await readFile(evidencePath, "utf8");
  parseEvidence(written);
}
