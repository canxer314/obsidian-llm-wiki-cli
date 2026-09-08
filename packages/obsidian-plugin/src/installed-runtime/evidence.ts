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
          evidence.cleanup !== null &&
          evidence.cleanup.residualPaths.length === 0 &&
          evidence.profile.mismatches.length === 0
        : true,
    {
      message:
        "A passing verdict requires a matched profile, candidate and Bridge identity, both health observations, and a clean cleanup report",
    },
  );

export type PublicWireCorpusEvidence = z.infer<typeof publicWireCorpusEvidenceSchema>;
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
