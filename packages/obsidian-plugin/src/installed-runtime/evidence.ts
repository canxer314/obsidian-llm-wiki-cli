import { createHash } from "node:crypto";
import { consumeManualPauseProof } from "./manual-pause-source.js";
import { manualPauseProofSchema } from "./manual-pause-observation.js";
import { persistentFifoProofSchema } from "./fifo-observation.js";
import { link, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { z } from "zod";
import { consumeContractChildSources, contractPackageCorpusEvidenceSchema, contractCorpusBindingSchema, contractCrossCallProofSchema, contractSourceVaultSchema } from "./contract-package-corpus.js";
import { pluginEventObserverCorpusEvidenceSchema } from "./plugin-event-observer-evidence.js";
import { referenceSingleSpanProofSchema } from "./registered-reference-single-span.js";

import {
  createAcceptanceMatrixReport,
  validateAcceptanceMatrixReport,
  type AcceptanceMatrixReport,
} from "./acceptance-matrix.js";

/**
 * Lifecycle-evidence seam (issue #197): one closed, machine-checkable record
 * per harness run. Evidence carries the registered runtime profile, candidate
 * /plugin/protocol identities, input hashes, before/after inventory, verdict,
 * and the residual-cleanup report — and never Vault note bodies, absolute
 * host paths, or other excluded private content (spec §9.4/§12.6). The
 * privacy guard is fail closed: serializing evidence that contains any
 * registered private marker throws instead of writing.
 */

function canonicalEvidenceValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalEvidenceValue);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, nested]) => [key, canonicalEvidenceValue(nested)]));
}
function digestEvidenceValue(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonicalEvidenceValue(value))).digest("hex");
}

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);

function requireAcceptanceMatrix(value: AcceptanceMatrixReport | null | undefined): AcceptanceMatrixReport {
  if (value === null || value === undefined) {
    throw new Error("Passing installed-runtime evidence requires an acceptance matrix");
  }
  return validateAcceptanceMatrixReport(value);
}

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

const releaseLifecycleReleaseIdentitySchema = z
  .object({
    pluginId: z.string().min(1),
    pluginVersion: z.string().min(1),
    bundleSha256: sha256Schema,
    filesSha256: sha256Schema,
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

const changeSetIdleRejectionSchema = z.object({
  recoveryState: z.literal("none"), queueLength: z.literal(0),
  currentExecutionId: z.null(), writeGate: z.literal("open"),
}).strict();

const rejectionInventoryEntrySchema = z.discriminatedUnion("kind", [
  z.object({ path: z.string().min(1), kind: z.literal("file"), sha256: sha256Schema, sizeBytes: z.number().int().nonnegative() }).strict(),
  z.object({ path: z.string().min(1), kind: z.literal("directory") }).strict(),
  z.object({ path: z.string().min(1), kind: z.literal("absent") }).strict(),
]);
const rejectionInventorySchema = z.object({
  scope: z.literal("all-public-vault-files-directories-and-affected-absence"),
  entries: z.array(rejectionInventoryEntrySchema).min(1), digest: sha256Schema,
}).strict();

/** Actual raw-byte observations bracket each rejected submit and terminal status. */
const changeSetRejectionClassSchema = z
  .object({
    name: z.string().min(1),
    failureCode: z.enum(["stale_observation", "path_conflict", "exact_match_count_mismatch"]),
    noMutationDigestUnchanged: z.literal(true),
    binding: z.object({
      runId: z.string().min(1), runtimeProfileId: z.string().min(1),
      candidateBundleSha256: sha256Schema, vaultIdSha256: sha256Schema,
    }).strict(),
    beforeInventory: rejectionInventorySchema,
    afterInventory: rejectionInventorySchema,
    proof: changeSetSubmissionProofSchema,
    status: changeSetSubmissionProofSchema,
    eventOrder: z.object({
      before: z.number().int().positive(), submit: z.number().int().positive(),
      status: z.number().int().positive(), terminal: z.number().int().positive(),
      after: z.number().int().positive(),
    }).strict(),
    terminal: changeSetIdleRejectionSchema,
  })
  .strict();

/** FIFO/concurrency report: exactly-once admission plus contended-target exclusion. */
const changeSetFifoReportSchema = z
  .object({
    persistentObservation: persistentFifoProofSchema.optional(),
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
export const REQUIRED_PREFLIGHT_REJECTIONS = [
  "rejection/stale-direct-target", "rejection/read-dependency-stale",
  "rejection/attachment-evidence-mismatch", "rejection/derived-target-file-parent",
  "rejection/absence-condition", "rejection/non-unique-replacement", "rejection/occupied-destination",
] as const;

export const PREFLIGHT_REJECTION_FOOTPRINTS: Readonly<Record<string, readonly { path: string; kind: "file" | "directory" | "absent" }[]>> = {
  "rejection/stale-direct-target": [{ path: "ChangeSetProof/AdmissionProof.md", kind: "file" }],
  "rejection/read-dependency-stale": [{ path: "Notes/Welcome.md", kind: "file" }, { path: "ChangeSetProof/ReadDep.md", kind: "absent" }],
  "rejection/attachment-evidence-mismatch": [{ path: "ChangeSetProof/Evidence.bin", kind: "file" }, { path: "ChangeSetProof/copy.bin", kind: "absent" }],
  "rejection/derived-target-file-parent": [{ path: "ChangeSetProof/AdmissionProof.md", kind: "file" }, { path: "ChangeSetProof/AdmissionProof.md/Child.md", kind: "absent" }],
  "rejection/absence-condition": [{ path: "ChangeSetProof/AdmissionProof.md", kind: "file" }],
  "rejection/non-unique-replacement": [{ path: "ChangeSetProof/Editable.md", kind: "file" }],
  "rejection/occupied-destination": [{ path: "ChangeSetProof/AdmissionProof.md", kind: "file" }, { path: "ChangeSetProof/Editable.md", kind: "file" }],
};

export const changeSetCorpusEvidenceSchema = z
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
      if (corpus.admission.rejectionClasses.length !== REQUIRED_PREFLIGHT_REJECTIONS.length ||
          REQUIRED_PREFLIGHT_REJECTIONS.some((name) => corpus.admission.rejectionClasses.filter((entry) => entry.name === name).length !== 1)) {
        context.addIssue({ code: "custom", message: "Passing evidence requires complete preflight rejection coverage" });
      }
      for (const field of ["changeSetId", "submissionKeySha256"] as const) {
        if (new Set(corpus.admission.rejectionClasses.map(({ proof }) => proof[field])).size !== corpus.admission.rejectionClasses.length) {
          context.addIssue({ code: "custom", message: "Each preflight rejection must have its own Submission Key and Change Set identity" });
        }
      }
      for (const rejection of corpus.admission.rejectionClasses) {
        const expectedFailure = rejection.name === "rejection/non-unique-replacement" ? "exact_match_count_mismatch"
          : ["rejection/stale-direct-target", "rejection/read-dependency-stale", "rejection/attachment-evidence-mismatch"].includes(rejection.name) ? "stale_observation" : "path_conflict";
        if (rejection.failureCode !== expectedFailure) {
          context.addIssue({ code: "custom", message: "Rejection scenario requires its prescribed failure branch" });
        }
        const { beforeInventory: before, afterInventory: after, eventOrder: order } = rejection;
        for (const inventory of [before, after]) {
          const required = [{ path: "Notes", kind: "directory" }, { path: "ChangeSetProof", kind: "directory" },
            ...(PREFLIGHT_REJECTION_FOOTPRINTS[rejection.name] ?? [])];
          if (new Set(inventory.entries.map(({ path }) => path)).size !== inventory.entries.length ||
              required.some(({ path, kind }) => !inventory.entries.some((entry) => entry.path === path && entry.kind === kind)) ||
              corpus.beforeInventory.entries.some(({ path, sha256, sizeBytes }) =>
                !inventory.entries.some((entry) => entry.path === path && entry.kind === "file" && entry.sha256 === sha256 && entry.sizeBytes === sizeBytes))) {
            context.addIssue({ code: "custom", message: "Rejection inventory must cover the complete public footprint, seed bytes and derived directories" });
          }
        }
        const digest = (entries: typeof before.entries): string => createHash("sha256")
          .update(JSON.stringify(canonicalEvidenceValue(entries))).digest("hex");
        if (before.digest !== digest(before.entries) || after.digest !== digest(after.entries) ||
            before.digest !== after.digest ||
            rejection.proof.state !== "intent_not_applied" || rejection.proof.executed ||
            rejection.proof.failureCode !== rejection.failureCode ||
            JSON.stringify(rejection.proof) !== JSON.stringify(rejection.status) ||
            !(order.before < order.submit && order.submit < order.status && order.status < order.terminal && order.terminal < order.after)) {
          context.addIssue({ code: "custom", message: "Rejected submit requires unchanged raw-byte inventories around matching terminal proof and status" });
        }
        const eventChecks = [
          [order.before, "assertion", `${rejection.name}:inventory-before`, before],
          [order.submit, "tool", "vault_change_set_submit", rejection.proof],
          [order.status, "tool", "vault_change_set_status", rejection.status],
          [order.terminal, "tool", "vault_health", { ...rejection.terminal, vaultIdSha256: rejection.binding.vaultIdSha256 }],
          [order.after, "assertion", `${rejection.name}:inventory-after`, after],
        ] as const;
        for (const [sequence, kind, name, detail] of eventChecks) {
          const event = corpus.eventLog[sequence - 1];
          if (event?.kind !== kind || event.name !== name ||
              (detail !== null && event.detailSha256 !== digestEvidenceValue(detail))) {
            context.addIssue({ code: "custom", message: "Rejection inventory must bind actual ordered corpus events" });
          }
        }
        if (JSON.stringify(rejection.binding) !== JSON.stringify(corpus.admission.rejectionClasses[0]!.binding)) {
          context.addIssue({ code: "custom", message: "Rejection evidence cannot mix run, Vault, candidate or profile identities" });
        }
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
        installedObservation: manualPauseProofSchema.optional(),
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
        secondEqualSpellingOnly: referenceSingleSpanProofSchema,
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

export const privacyRecoveryAuthorityCorpusEvidenceSchema = z
  .object({
    corpusId: z.literal("privacy-recovery-authority-proof"),
    scenarioManifestSha256: sha256Schema,
    tools: z.array(z.string().min(1)).length(6),
    vaults: z
      .array(
        z
          .object({
            label: z.enum(["vault-a", "vault-b"]),
            vaultIdSha256: sha256Schema,
            healthSummarySha256: sha256Schema,
          })
          .strict(),
      )
      .length(2),
    diagnostics: z
      .object({
        standardBundles: z.literal(2),
        validChecksums: z.literal(2),
        privateMarkersRejected: z.number().int().positive(),
        stableOpaqueAliases: z.literal(true),
        contentInclusiveLocalOnly: z.literal(true),
      })
      .strict(),
    authority: z
      .object({
        rejectedAgentAttempts: z.number().int().positive(),
        agentStateMutations: z.literal(0),
        baselineAcceptanceLocalOnly: z.literal(true),
        journalPreconditionsProven: z.literal(true),
        explicitResumeRequired: z.literal(true),
      })
      .strict(),
    isolation: z.object({ secondVaultUnaffected: z.literal(true) }).strict(),
    residualCleanup: z.object({ residualPaths: z.array(z.string()).length(0) }).strict(),
    eventLog: z.array(publicWireEventSchema).min(1),
    assertions: z.array(z.string().min(1)).min(1),
    verdict: z.literal("passed"),
  })
  .strict()
  .superRefine((corpus, context) => {
    if (
      corpus.tools.length !== 6 ||
      [...corpus.tools].sort().join(" ") !==
        [
          "vault_change_set_status",
          "vault_change_set_submit",
          "vault_continue",
          "vault_discover",
          "vault_health",
          "vault_read",
        ].join(" ")
    ) {
      context.addIssue({
        code: "custom",
        message: "Privacy/recovery evidence must name exactly the six public tools",
      });
    }
    if (!corpus.eventLog.every((event, index) => event.sequence === index + 1)) {
      context.addIssue({
        code: "custom",
        message: "Privacy/recovery event sequences must be monotonic",
      });
    }
    if (new Set(corpus.vaults.map((vault) => vault.label)).size !== 2) {
      context.addIssue({
        code: "custom",
        message: "Privacy/recovery evidence requires two distinct Managed Vaults",
      });
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

export const semanticEvidenceSearchSnapshotCorpusEvidenceSchema = z
  .object({
    corpusId: z.literal("semantic-evidence-search-snapshot-proof"),
    scenarioManifestSha256: sha256Schema,
    tools: z.array(z.string().min(1)).length(6),
    scenarios: z
      .array(
        z
          .object({
            scenario: z.string().min(1),
            source: z.literal("installed-obsidian"),
            mutationKind: z.string().min(1),
            proofState: z
              .enum(["intent_applied", "intent_not_applied", "result_unproven"])
              .nullable(),
            statusProofState: z
              .enum(["intent_applied", "intent_not_applied", "result_unproven"])
              .nullable(),
            journalPhase: z.enum(["COMMITTED", "ROLLED_BACK", "FAILED"]).nullable(),
            evidenceDeadlineMs: z.literal(5_000),
            successBarrierDeadlineMs: z.literal(5_000),
            evidenceSessions: z
              .array(
                z
                  .object({
                    mode: z.enum(["apply", "restore"]),
                    outcome: z.enum(["converged", "timed_out", "failed", "not_awaited"]),
                    virtualElapsedMs: z.number().int().nonnegative().nullable(),
                  })
                  .strict(),
              )
              .min(1),
            quietWindowResets: z.number().int().nonnegative(),
            acceptedSnapshotRounds: z.number().int().nonnegative(),
            rejectedSnapshotRounds: z.number().int().nonnegative(),
            successorSnapshot: z
              .object({
                baselineVersion: z.number().int().nonnegative(),
                version: z.number().int().nonnegative().nullable(),
                immutable: z.boolean(),
                publishedBeforeIntentApplied: z.boolean(),
              })
              .strict(),
            durableCommitBeforeIntentApplied: z.boolean(),
            writesBlocked: z.boolean(),
            residueSha256: sha256Schema.optional(),
            beforeInventorySha256: sha256Schema,
            afterInventorySha256: sha256Schema,
            cleanupSucceeded: z.literal(true),
          })
          .strict(),
      )
      .min(1),
    coverage: z
      .object({
        delayedOlderContentVersionRejected: z.literal(true),
        quietWindowStabilityProven: z.literal(true),
        createModifyRenameDeleteAndClosureProven: z.literal(true),
        hiddenTrashRestoreUsesTargetedProbes: z.literal(true),
        deadlineRollbackOrUnprovenProven: z.literal(true),
        contraryEvidenceResetsQuietWindow: z.literal(true),
        noPublicSearchSnapshotCapability: z.literal(true),
      })
      .strict(),
    residualCleanup: z
      .object({
        reportsRemoved: z.literal(true),
        residualReportPaths: z.array(z.string()).length(0),
      })
      .strict(),
    eventLog: z.array(publicWireEventSchema).min(1),
    assertions: z.array(z.string().min(1)).min(1),
    verdict: z.literal("passed"),
  })
  .strict()
  .superRefine((corpus, context) => {
    if (!corpus.eventLog.every((event, index) => event.sequence === index + 1)) {
      context.addIssue({
        code: "custom",
        message: "Semantic Evidence event sequences must be monotonic",
      });
    }
    if (new Set(corpus.tools).size !== 6) {
      context.addIssue({
        code: "custom",
        message: "Semantic Evidence evidence must name six distinct public tools",
      });
    }
    for (const scenario of corpus.scenarios) {
      if (scenario.proofState !== scenario.statusProofState) {
        context.addIssue({
          code: "custom",
          message: "Semantic Evidence status must match its submission proof state",
        });
      }
      if (scenario.proofState === "intent_applied") {
        if (
          !scenario.successorSnapshot.publishedBeforeIntentApplied ||
          !scenario.successorSnapshot.immutable ||
          !scenario.durableCommitBeforeIntentApplied ||
          scenario.journalPhase !== "COMMITTED"
        ) {
          context.addIssue({
            code: "custom",
            message: "Applied Semantic Evidence requires immutable successor snapshot and durable COMMITTED",
          });
        }
      }
      if (scenario.proofState === "result_unproven") {
        if (
          scenario.journalPhase !== "FAILED" ||
          !scenario.writesBlocked ||
          scenario.acceptedSnapshotRounds !== 0 ||
          scenario.successorSnapshot.version !== null ||
          scenario.successorSnapshot.immutable ||
          scenario.successorSnapshot.publishedBeforeIntentApplied ||
          scenario.durableCommitBeforeIntentApplied
        ) {
          context.addIssue({
            code: "custom",
            message: "Unproven Semantic Evidence requires FAILED, blocked writes, and no accepted successor snapshot",
          });
        }
      }
    }
  });

const releaseLifecycleInventorySchema = z
  .object({
    beforeBundleSha256: sha256Schema,
    afterBundleSha256: sha256Schema,
    beforeStateSha256: sha256Schema,
    afterStateSha256: sha256Schema,
  })
  .strict();

export const releaseLifecycleCorpusEvidenceSchema = z
  .object({
    corpusId: z.literal("verified-release-lifecycle-proof"),
    scenarioManifestSha256: sha256Schema,
    releases: z
      .object({
        install: releaseLifecycleReleaseIdentitySchema,
        previous: releaseLifecycleReleaseIdentitySchema,
        upgrade: releaseLifecycleReleaseIdentitySchema,
      })
      .strict(),
    inventories: z
      .object({
        install: releaseLifecycleInventorySchema,
        repair: releaseLifecycleInventorySchema,
        upgrade: releaseLifecycleInventorySchema,
        uninstall: releaseLifecycleInventorySchema,
        purge: releaseLifecycleInventorySchema,
      })
      .strict(),
    migration: z
      .object({
        completedPhases: z.array(z.string().min(1)).min(1),
        drainedCurrentItem: z.literal(true),
        healthRechecked: z.literal(true),
        maintenancePaused: z.literal(true),
        newSubmissionsRejected: z.literal(true),
        explicitOperatorResumeRequired: z.literal(true),
      })
      .strict(),
    rollback: z
      .object({
        verifiedStagingBeforeReplacement: z.literal(true),
        perVaultAtomicReplacement: z.literal(true),
        unverifiedReleaseExecutable: z.literal(false),
      })
      .strict(),
    lifecycleStatus: z
      .object({
        notInstalled: z.literal(true),
        installedNotEnabled: z.literal(true),
        bridgeOffline: z.literal(true),
        mcpNotRegistered: z.literal(true),
        identityMismatch: z.literal(true),
        ready: z.literal(true),
      })
      .strict(),
    removal: z
      .object({
        uninstallGuarded: z.literal(true),
        purgeQueuedWorkRefused: z.literal(true),
        purgeRecoveryRefused: z.literal(true),
        purgeInteractive: z.literal(true),
        backupVerified: z.literal(true),
      })
      .strict(),
    cleanup: z
      .object({
        scenarios: z.array(z.enum(["install", "upgrade", "uninstall", "purge"])).length(4),
        residualPaths: z.array(z.string()).length(0),
      })
      .strict(),
    eventLog: z.array(publicWireEventSchema).min(1),
    assertions: z.array(z.string().min(1)).min(1),
    verdict: z.literal("passed"),
  })
  .strict()
  .superRefine((corpus, context) => {
    if (!corpus.eventLog.every((event, index) => event.sequence === index + 1)) {
      context.addIssue({ code: "custom", message: "Release-lifecycle event sequences must be monotonic" });
    }
    if (new Set(corpus.cleanup.scenarios).size !== 4) {
      context.addIssue({ code: "custom", message: "Release-lifecycle cleanup requires every scenario" });
    }
    if (corpus.migration.completedPhases.join(" ") !== [
      "replace",
      "reload",
      "migrate",
      "recovery",
      "health",
    ].join(" ")) {
      context.addIssue({ code: "custom", message: "Release-lifecycle migration phases must remain fail-closed and ordered" });
    }
  });

const crashRestorationRecordSchema = z
  .object({
    mutationKind: z.string().min(1),
    injectionPoint: z.string().min(1),
    fixtureSha256: sha256Schema,
    beforeInventorySha256: sha256Schema,
    afterInventorySha256: sha256Schema,
    proofState: z.enum(["intent_applied", "intent_not_applied", "result_unproven"]).nullable(),
    gate: z.string().nullable(),
    cleanupSucceeded: z.literal(true),
    verdict: z.literal("passed"),
  })
  .strict();

export const crashRestorationRetainedAuthorityCorpusEvidenceSchema = z
  .object({
    corpusId: z.literal("crash-restoration-retained-authority-proof"),
    scenarioManifestSha256: sha256Schema,
    records: z.array(crashRestorationRecordSchema).min(1),
    coverage: z
      .object({
        everyMutationKindAtEveryDeclaredBoundary: z.literal(true),
        preparedRestoresWholeChangeSet: z.literal(true),
        committedSuppressesRestoration: z.literal(true),
        conflictingBytesPreservedAndWritesBlocked: z.literal(true),
        deterministicJournalStorageDestinationAndSemanticFaults: z.literal(true),
        callbackReorderAndSemanticTimeoutProven: z.literal(true),
        concurrentIdempotencyProven: z.literal(true),
      })
      .strict(),
    retainedAuthority: z
      .object({
        retentionMs: z.literal(7 * 24 * 60 * 60 * 1_000),
        queryableAcrossCrashAndReconnect: z.literal(true),
        completeRecordsRetained: z.literal(true),
        requiredRecordsNeverBecomeOrdinaryUnknown: z.literal(true),
      })
      .strict(),
    cleanup: z
      .object({
        residualPaths: z.array(z.string()).length(0),
        vaultVisibleStaging: z.literal(0),
        managedTrashLeakage: z.literal(0),
        fixtureResidue: z.literal(0),
      })
      .strict(),
    eventLog: z.array(publicWireEventSchema).min(1),
    assertions: z.array(z.string().min(1)).min(1),
    verdict: z.literal("passed"),
  })
  .strict()
  .superRefine((corpus, context) => {
    if (!corpus.eventLog.every((event, index) => event.sequence === index + 1)) {
      context.addIssue({
        code: "custom",
        message: "Crash-restoration event sequences must be monotonic",
      });
    }
    if (corpus.records.some((record) => !record.cleanupSucceeded)) {
      context.addIssue({
        code: "custom",
        message: "Crash-restoration records require successful cleanup",
      });
    }
  });

function evidenceSchemaWithContext(observerContext?: import("./plugin-event-observer-corpus.js").PluginEventObserverConsumptionContext, pauseContext?: import("./manual-pause-source.js").ManualPauseConsumptionContext, contractContext?: import("./contract-package-corpus.js").ContractChildConsumptionContext) { return z
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
    contractPackageExecution: z.object({ authoritySha256: sha256Schema, binding: z.lazy(() => contractCorpusBindingSchema), wire: z.unknown(), crossCalls: z.array(z.lazy(() => contractCrossCallProofSchema)), complete: z.boolean(), cleanup: z.object({ attempted: z.boolean(), residualPaths: z.array(z.string()) }).strict().nullable() }).strict().nullable().optional(),
    contractSourceVaults: z.array(z.lazy(() => contractSourceVaultSchema)).optional(),
    contractPackageCorpus: z.lazy(() => contractPackageCorpusEvidenceSchema).nullable().optional(),
    publicWireCorpus: publicWireCorpusEvidenceSchema.nullable(),
    changeSetCorpus: changeSetCorpusEvidenceSchema.nullable(),
    gateIsolationCorpus: gateIsolationCorpusEvidenceSchema.nullable(),
    manualPauseObservation: manualPauseProofSchema.nullable().optional(),
    registeredReferenceRewriteCorpus:
      registeredReferenceRewriteCorpusEvidenceSchema.nullable(),
    semanticEvidenceSearchSnapshotCorpus:
      semanticEvidenceSearchSnapshotCorpusEvidenceSchema.nullable(),
    privacyRecoveryAuthorityCorpus: privacyRecoveryAuthorityCorpusEvidenceSchema.nullable().optional(),
    releaseLifecycleCorpus: releaseLifecycleCorpusEvidenceSchema.nullable().optional(),
    crashRestorationRetainedAuthorityCorpus:
      crashRestorationRetainedAuthorityCorpusEvidenceSchema.nullable().optional(),
    pluginEventObserverCorpus: pluginEventObserverCorpusEvidenceSchema.nullable().optional(),
    acceptanceMatrix: z.custom<AcceptanceMatrixReport>().nullable().optional(),
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
  .superRefine((evidence, context) => {
    if (evidence.contractPackageCorpus) try { consumeContractChildSources(evidence.contractPackageCorpus, contractContext, evidence); } catch (error) { context.addIssue({ code: "custom", message: error instanceof Error ? error.message : "Version contract independent child source invalid" }); }
    for (const pause of [evidence.manualPauseObservation, evidence.gateIsolationCorpus?.manualPause.installedObservation]) {
      if (pause) try { consumeManualPauseProof(pause, pauseContext); } catch (error) { context.addIssue({ code: "custom", message: error instanceof Error ? error.message : "Manual pause independent source invalid" }); }
      if (pause && (pause.runId !== evidence.runId || pause.profile !== evidence.profile.name || pause.candidateBundleSha256 !== evidence.candidate?.bundleSha256 ||
          pause.installedMainSha256 !== evidence.candidate?.files.find(file => file.path === "main.js")?.sha256)) context.addIssue({ code: "custom", message: "Manual pause proof must bind this verified candidate, run and registered profile" });
    }
    for (const rejection of evidence.changeSetCorpus?.admission.rejectionClasses ?? []) {
      if (rejection.binding.runId !== evidence.runId ||
          rejection.binding.runtimeProfileId !== evidence.profile.name ||
          rejection.binding.candidateBundleSha256 !== evidence.candidate?.bundleSha256 ||
          rejection.binding.vaultIdSha256 !== createHash("sha256").update(evidence.bridgeIdentity?.vaultId ?? "").digest("hex")) {
        context.addIssue({ code: "custom", message: "Rejection evidence must bind this verified candidate, run, Managed Vault and runtime profile" });
      }
    }
    if (evidence.verdict === "passed") {
      try {
        const matrix = requireAcceptanceMatrix(evidence.acceptanceMatrix);
        const expected = createAcceptanceMatrixReport({
          ...evidence,
          acceptanceMatrix: null,
        }, observerContext, pauseContext, contractContext);
        if (matrix.canonicalManifestSha256 !== expected.canonicalManifestSha256) {
          context.addIssue({ code: "custom", message: "Acceptance matrix does not bind this installed-runtime evidence" });
        }
      } catch (error) {
        context.addIssue({
          code: "custom",
          message: error instanceof Error ? error.message : "Acceptance matrix is invalid",
        });
      }
    }
  })
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
          evidence.gateIsolationCorpus !== null &&
          evidence.gateIsolationCorpus.verdict === "passed" &&
          evidence.registeredReferenceRewriteCorpus !== null &&
          evidence.registeredReferenceRewriteCorpus.verdict === "passed" &&
          evidence.semanticEvidenceSearchSnapshotCorpus !== null &&
          evidence.semanticEvidenceSearchSnapshotCorpus.verdict === "passed" &&
          evidence.crashRestorationRetainedAuthorityCorpus !== undefined &&
          evidence.crashRestorationRetainedAuthorityCorpus !== null &&
          evidence.crashRestorationRetainedAuthorityCorpus.verdict === "passed" &&
          evidence.privacyRecoveryAuthorityCorpus !== undefined &&
          evidence.privacyRecoveryAuthorityCorpus !== null &&
          evidence.privacyRecoveryAuthorityCorpus.verdict === "passed" &&
          evidence.releaseLifecycleCorpus !== undefined &&
          evidence.releaseLifecycleCorpus !== null &&
          evidence.releaseLifecycleCorpus.verdict === "passed" &&
          evidence.cleanup !== null &&
          evidence.cleanup.residualPaths.length === 0 &&
          evidence.profile.mismatches.length === 0 &&
          evidence.acceptanceMatrix !== undefined &&
          evidence.acceptanceMatrix !== null
        : true,
    {
      message:
        "A passing verdict requires a matched profile, candidate and Bridge identity, both health observations, clean read- and write-side corpus evidence, and passing Semantic Evidence/Search Snapshot proof",
    },
  );

}
export const installedRuntimeEvidenceSchema = evidenceSchemaWithContext();
export type PublicWireCorpusEvidence = z.infer<typeof publicWireCorpusEvidenceSchema>;
export type ChangeSetCorpusEvidence = z.infer<typeof changeSetCorpusEvidenceSchema>;
export type GateIsolationCorpusEvidence = z.infer<typeof gateIsolationCorpusEvidenceSchema>;
export type RegisteredReferenceRewriteCorpusEvidence = z.infer<
  typeof registeredReferenceRewriteCorpusEvidenceSchema
>;
export type PrivacyRecoveryAuthorityCorpusEvidence = z.infer<
  typeof privacyRecoveryAuthorityCorpusEvidenceSchema
>;
export type SemanticEvidenceCorpusEvidence = z.infer<
  typeof semanticEvidenceSearchSnapshotCorpusEvidenceSchema
>;
export type ReleaseLifecycleCorpusEvidence = z.infer<typeof releaseLifecycleCorpusEvidenceSchema>;
export type CrashRestorationRetainedAuthorityCorpusEvidence = z.infer<
  typeof crashRestorationRetainedAuthorityCorpusEvidenceSchema
>;
export type AcceptanceMatrixEvidence = AcceptanceMatrixReport;
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
export function createInstalledRuntimeAcceptanceMatrix(
  evidence: InstalledRuntimeEvidence,
  observerContext?: import("./plugin-event-observer-corpus.js").PluginEventObserverConsumptionContext,
  pauseContext?: import("./manual-pause-source.js").ManualPauseConsumptionContext,
  contractContext?: import("./contract-package-corpus.js").ContractChildConsumptionContext,
): AcceptanceMatrixReport {
  return createAcceptanceMatrixReport({ ...evidence, acceptanceMatrix: null }, observerContext, pauseContext, contractContext);
}

export function serializeEvidence(
  evidence: InstalledRuntimeEvidence,
  privateMarkers: readonly string[] = [],
  observerContext?: import("./plugin-event-observer-corpus.js").PluginEventObserverConsumptionContext,
  pauseContext?: import("./manual-pause-source.js").ManualPauseConsumptionContext,
  contractContext?: import("./contract-package-corpus.js").ContractChildConsumptionContext,
): string {
  const validated = evidenceSchemaWithContext(observerContext, pauseContext, contractContext).parse(evidence);
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

export function parseEvidence(serialized: string, observerContext?: import("./plugin-event-observer-corpus.js").PluginEventObserverConsumptionContext, pauseContext?: import("./manual-pause-source.js").ManualPauseConsumptionContext, contractContext?: import("./contract-package-corpus.js").ContractChildConsumptionContext): InstalledRuntimeEvidence {
  return evidenceSchemaWithContext(observerContext, pauseContext, contractContext).parse(JSON.parse(serialized));
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
  observerContext?: import("./plugin-event-observer-corpus.js").PluginEventObserverConsumptionContext,
  pauseContext?: import("./manual-pause-source.js").ManualPauseConsumptionContext,
  contractContext?: import("./contract-package-corpus.js").ContractChildConsumptionContext,
): Promise<void> {
  const serialized = serializeEvidence(evidence, privateMarkers, observerContext, pauseContext, contractContext);
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
  parseEvidence(written, observerContext, pauseContext, contractContext);
}
