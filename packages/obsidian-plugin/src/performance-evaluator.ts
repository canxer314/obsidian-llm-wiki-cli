import { z } from "zod";

import {
  fixedPerformanceFixtureManifest,
  type FixedPerformanceFixtureName,
} from "./performance-fixture.js";
import {
  lookupRegisteredRuntimeProfile,
  preflightRuntimeProfile,
  type ObservedRuntimeEnvironment,
} from "./installed-runtime/runtime-profile.js";

/**
 * Deterministic benchmark-trace evaluator (issue #171). Consumes one versioned,
 * machine-readable benchmark trace and produces a canonical pass-or-block
 * verdict over the eleven fixed release gates of spec §13.
 *
 * The evaluator never trusts a recorded performance verdict: gates 9 and 10 are
 * recomputed from the recorded samples using the fixed nearest-rank procedure
 * (each batch's p95 is the 29th value after ordering that batch's 30 measured
 * samples ascending), batches are never pooled, outliers are never removed, and
 * a later sample can never replace an individual failed one. Gates 1–8 and 11
 * are reported from the authoritative evidence references recorded in the
 * trace; a missing, duplicate, stale, or contradictory reference fails that
 * gate closed rather than passing.
 *
 * Synthetic traces produced by this module's tests are never release evidence.
 */

export const BENCHMARK_TRACE_SCHEMA_VERSION = 1 as const;

/** Fixed timing constants from spec §10 and §13. */
export const DISCOVERY_P95_LIMIT_MS = 200 as const;
export const EXACT_READ_P95_LIMIT_MS = 200 as const;
export const WORK_CLOCK_P95_LIMIT_MS = 1_000 as const;
export const PROOF_CLOCK_P95_LIMIT_MS = 4_000 as const;
export const PROOF_CLOCK_SAMPLE_LIMIT_MS = 5_000 as const;
/** Each batch runs exactly 30 measured executions (spec §12.3). */
export const MEASURED_SAMPLES_PER_BATCH = 30 as const;

export const RELEASE_GATE_COUNT = 11 as const;

export type BenchmarkCaseName = "read-v1-discovery" | "read-v1-exact-read" | "change-v1";

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);

const failureSchema = z
  .object({
    code: z.string().min(1),
    detail: z.string().optional(),
  })
  .strict();

const ordinalSchema = z.number().int().positive();

const blockingReasonCodeSchema = z.enum([
  "correctness_failure",
  "result_unproven",
  "rollback_failure",
  "blocked_gate",
  "fixture_residual",
  "missing_evidence",
  "stale_evidence",
  "incompatible_profile",
  "performance_failure",
  "malformed_input",
  "contradictory_evidence",
  "privacy_failure",
  "migration_failure",
  "environment_precondition_failure",
]);

export type BlockingReasonCode = z.infer<typeof blockingReasonCodeSchema>;

export interface BlockingReason {
  readonly code: BlockingReasonCode;
  readonly detail: string;
}

const blockingReasonSchema = z
  .object({
    code: blockingReasonCodeSchema,
    detail: z.string().min(1),
  })
  .strict();

function reason(code: BlockingReasonCode, detail: string): BlockingReason {
  return { code, detail };
}

/* ------------------------------------------------------------------------- *
 * Trace schema
 * ------------------------------------------------------------------------- */

const observedEnvironmentSchema = z
  .object({
    platform: z.string().min(1),
    osBuild: z.string().nullable(),
    obsidianVersion: z.string().nullable(),
    electronVersion: z.string().nullable(),
    nodeVersion: z.string().nullable(),
    capabilities: z.array(z.string()),
  })
  .strict();

const preconditionCheckSchema = z
  .object({
    code: z.string().min(1),
    satisfied: z.boolean(),
  })
  .strict();

const gateArtifactSchema = z
  .object({
    artifactId: z.string().min(1),
    artifactSha256: sha256Schema,
  })
  .strict();

export type GateArtifact = z.infer<typeof gateArtifactSchema>;

/**
 * Evidence references for the evidence-owned release gates (1–8 and 11).
 * Performance gates 9 and 10 are never recorded as references; the evaluator
 * recomputes them from the recorded samples so a stale recorded verdict can
 * never mask a real threshold or deadline failure.
 */
const recordedGateNumberSchema = z.union([
  z.literal(1),
  z.literal(2),
  z.literal(3),
  z.literal(4),
  z.literal(5),
  z.literal(6),
  z.literal(7),
  z.literal(8),
  z.literal(11),
]);

const gateEvidenceSchema = z
  .object({
    schemaVersion: z.literal(BENCHMARK_TRACE_SCHEMA_VERSION),
    gate: recordedGateNumberSchema,
    outcome: z.enum(["passed", "blocked"]),
    artifacts: z.array(gateArtifactSchema),
    blockingReasons: z.array(blockingReasonSchema),
  })
  .strict()
  .superRefine((item, ctx) => {
    if (item.outcome === "passed") {
      if (item.artifacts.length === 0) {
        ctx.addIssue({
          code: "custom",
          message: "A passed gate must identify at least one evidence artifact",
        });
      }
      if (item.blockingReasons.length !== 0) {
        ctx.addIssue({
          code: "custom",
          message: "A passed gate cannot carry blocking reasons",
        });
      }
    } else if (item.blockingReasons.length === 0) {
      ctx.addIssue({
        code: "custom",
        message: "A blocked gate must explain at least one blocking reason",
      });
    }
  });

export type ReleaseGateEvidence = z.infer<typeof gateEvidenceSchema>;

const warmUpSampleSchema = z
  .object({
    ordinal: ordinalSchema,
    disposition: z.literal("warm_up"),
  })
  .strict();

const failedSampleSchema = z
  .object({
    ordinal: ordinalSchema,
    disposition: z.literal("failed"),
    failure: failureSchema,
  })
  .strict();

const selectivelyRerunSampleSchema = z
  .object({
    ordinal: ordinalSchema,
    disposition: z.literal("selectively_rerun"),
    failure: failureSchema.optional(),
  })
  .strict();

const measuredReadSampleSchema = z
  .object({
    ordinal: ordinalSchema,
    disposition: z.literal("measured"),
    clientClockMs: z.number().int().nonnegative(),
    serverSpanMs: z.number().int().nonnegative().optional(),
  })
  .strict();

const measuredChangeSampleSchema = z
  .object({
    ordinal: ordinalSchema,
    disposition: z.literal("measured"),
    clientClockMs: z.number().int().nonnegative().optional(),
    serverSpanMs: z.number().int().nonnegative().optional(),
    workClockMs: z.number().int().nonnegative(),
    proofClockMs: z.number().int().nonnegative(),
  })
  .strict();

const readSampleSchema = z.discriminatedUnion("disposition", [
  measuredReadSampleSchema,
  warmUpSampleSchema,
  failedSampleSchema,
  selectivelyRerunSampleSchema,
]);

const changeSampleSchema = z.discriminatedUnion("disposition", [
  measuredChangeSampleSchema,
  warmUpSampleSchema,
  failedSampleSchema,
  selectivelyRerunSampleSchema,
]);

const batchSchema = <T extends z.ZodType>(sampleSchema: T) =>
  z
    .object({
      batchId: z.string().min(1),
      samples: z.array(sampleSchema).min(1),
    })
    .strict();

const readBatchSchema = batchSchema(readSampleSchema);
const changeBatchSchema = batchSchema(changeSampleSchema);

const readV1DiscoveryCaseSchema = z
  .object({
    case: z.literal("read-v1-discovery"),
    fixture: z.literal("read-v1"),
    fixtureManifestSha256: sha256Schema,
    batches: z.array(readBatchSchema),
  })
  .strict();

const readV1ExactReadCaseSchema = z
  .object({
    case: z.literal("read-v1-exact-read"),
    fixture: z.literal("read-v1"),
    fixtureManifestSha256: sha256Schema,
    batches: z.array(readBatchSchema),
  })
  .strict();

const changeV1CaseSchema = z
  .object({
    case: z.literal("change-v1"),
    fixture: z.literal("change-v1"),
    fixtureManifestSha256: sha256Schema,
    batches: z.array(changeBatchSchema),
  })
  .strict();

const benchmarkCaseSchema = z.discriminatedUnion("case", [
  readV1DiscoveryCaseSchema,
  readV1ExactReadCaseSchema,
  changeV1CaseSchema,
]);

const benchmarkTraceSchema = z
  .object({
    schemaVersion: z.literal(BENCHMARK_TRACE_SCHEMA_VERSION),
    traceId: z.string().min(1),
    versions: z
      .object({
        bridge: z.string().min(1),
        plugin: z.string().min(1),
        protocol: z.string().min(1),
        mcpSdk: z.string().min(1),
      })
      .strict(),
    runtimeProfile: z
      .object({
        name: z.string().min(1),
        observed: observedEnvironmentSchema,
        preconditions: z.array(preconditionCheckSchema),
      })
      .strict(),
    compatibility: z
      .object({
        observation: z.string().min(1),
        version: z.string().min(1),
      })
      .strict(),
    cases: z.array(benchmarkCaseSchema),
    evidence: z.array(gateEvidenceSchema),
  })
  .strict();

export type BenchmarkTrace = z.infer<typeof benchmarkTraceSchema>;
export type BenchmarkCase = BenchmarkTrace["cases"][number];
export type BenchmarkCaseBatch = BenchmarkCase["batches"][number];
export type ReadBenchmarkCase = Extract<BenchmarkCase, { case: "read-v1-discovery" | "read-v1-exact-read" }>;
export type ChangeBenchmarkCase = Extract<BenchmarkCase, { case: "change-v1" }>;
export type ReadBatchSample = ReadBenchmarkCase["batches"][number]["samples"][number];
export type ChangeBatchSample = ChangeBenchmarkCase["batches"][number]["samples"][number];
export type MeasuredReadSample = Extract<ReadBatchSample, { disposition: "measured" }>;
export type MeasuredChangeSample = Extract<ChangeBatchSample, { disposition: "measured" }>;

export class BenchmarkTraceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BenchmarkTraceError";
  }
}

/**
 * Parses and structurally validates one benchmark trace. The schema is closed
 * and strict: unknown fields, malformed values, a repeated case identity, or a
 * repeated evidence-gate reference reject instead of passing.
 */
export function parseBenchmarkTrace(input: unknown): BenchmarkTrace {
  let parsed: BenchmarkTrace;
  try {
    parsed = benchmarkTraceSchema.parse(input);
  } catch (error) {
    if (error instanceof z.ZodError) {
      const detail = error.issues
        .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
        .join("; ");
      throw new BenchmarkTraceError(`Benchmark trace is invalid: ${detail}`);
    }
    throw error;
  }
  const caseNames = parsed.cases.map((benchmarkCase) => benchmarkCase.case);
  if (new Set(caseNames).size !== caseNames.length) {
    throw new BenchmarkTraceError(
      `Benchmark trace records a case more than once: ${caseNames.join(", ")}`,
    );
  }
  const gateNumbers = parsed.evidence.map((evidence) => evidence.gate);
  if (new Set(gateNumbers).size !== gateNumbers.length) {
    throw new BenchmarkTraceError(
      `Benchmark trace records evidence for a release gate more than once: ${gateNumbers.join(", ")}`,
    );
  }
  return parsed;
}

/* ------------------------------------------------------------------------- *
 * Fixed statistics
 * ------------------------------------------------------------------------- */

function compareNumbers(left: number, right: number): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Nearest-rank p95 of one batch: the 29th value after ordering that batch's 30
 * measured samples ascending (`ceil(0.95 × 30) − 1`). Batches are never pooled
 * and outliers are never removed, so the procedure is fixed to exactly 30
 * measured samples; a batch with any other count has no p95 by definition.
 */
export function nearestRankP95(measured: readonly number[]): number {
  if (measured.length !== MEASURED_SAMPLES_PER_BATCH) {
    throw new Error(
      `Nearest-rank p95 requires exactly ${MEASURED_SAMPLES_PER_BATCH} measured samples; received ${measured.length}`,
    );
  }
  const ordered = [...measured].sort(compareNumbers);
  const index = Math.ceil(0.95 * MEASURED_SAMPLES_PER_BATCH) - 1;
  const value = ordered[index];
  if (value === undefined) {
    throw new Error("Nearest-rank p95 could not be derived from the ordered samples");
  }
  return value;
}

/* ------------------------------------------------------------------------- *
 * Evaluation
 * ------------------------------------------------------------------------- */

export interface BatchEvaluation {
  readonly batchId: string;
  readonly sampleCount: number;
  readonly measuredCount: number;
  readonly p95ClientClockMs: number | null;
  readonly p95WorkClockMs: number | null;
  readonly p95ProofClockMs: number | null;
  readonly maxProofClockMs: number | null;
  readonly status: "passed" | "blocked";
  readonly blockingReasons: readonly BlockingReason[];
}

export interface CaseEvaluation {
  readonly case: BenchmarkCaseName;
  readonly fixture: FixedPerformanceFixtureName;
  readonly fixtureManifestSha256: string;
  readonly fixtureManifestCurrent: boolean;
  readonly batches: readonly BatchEvaluation[];
  readonly status: "passed" | "blocked";
  readonly blockingReasons: readonly BlockingReason[];
}

interface BatchAnalysis {
  readonly batchId: string;
  readonly sampleCount: number;
  readonly measuredCount: number;
  readonly structuralIssues: readonly BlockingReason[];
  readonly perfIssues: readonly BlockingReason[];
  readonly p95ClientClockMs: number | null;
  readonly p95WorkClockMs: number | null;
  readonly p95ProofClockMs: number | null;
  readonly maxProofClockMs: number | null;
}

const canonicalFixtureManifestCache = new Map<FixedPerformanceFixtureName, string>();

function canonicalFixtureManifestSha256(fixture: FixedPerformanceFixtureName): string {
  const cached = canonicalFixtureManifestCache.get(fixture);
  if (cached !== undefined) return cached;
  const digest = fixedPerformanceFixtureManifest(fixture).manifestSha256;
  canonicalFixtureManifestCache.set(fixture, digest);
  return digest;
}

function analyzeReadBatch(benchmarkCaseName: BenchmarkCaseName, batch: ReadBenchmarkCase["batches"][number]): BatchAnalysis {
  const samples: readonly ReadBatchSample[] = batch.samples;
  const structuralIssues: BlockingReason[] = [];
  const perfIssues: BlockingReason[] = [];

  for (let index = 0; index < samples.length; index += 1) {
    const sample = samples[index];
    if (sample === undefined) break;
    if (sample.ordinal !== index + 1) {
      structuralIssues.push(
        reason(
          "missing_evidence",
          `Batch ${batch.batchId} sample ordinal ${sample.ordinal} at execution position ${index + 1} breaks the required contiguous ordinal sequence`,
        ),
      );
    }
  }
  const measured = samples.filter((sample) => sample.disposition === "measured");
  if (measured.length !== MEASURED_SAMPLES_PER_BATCH) {
    structuralIssues.push(
      reason(
        "missing_evidence",
        `Batch ${batch.batchId} of ${benchmarkCaseName} must contain exactly ${MEASURED_SAMPLES_PER_BATCH} measured samples; found ${measured.length}`,
      ),
    );
  }
  for (const sample of samples) {
    if (sample.disposition === "failed") {
      structuralIssues.push(
        reason(
          "correctness_failure",
          `Batch ${batch.batchId} ${benchmarkCaseName} sample ordinal ${sample.ordinal} failed (${sample.failure?.code ?? "unknown"}) and cannot be replaced by a later sample`,
        ),
      );
    } else if (sample.disposition === "selectively_rerun") {
      structuralIssues.push(
        reason(
          "correctness_failure",
          `Batch ${batch.batchId} ${benchmarkCaseName} sample ordinal ${sample.ordinal} was selectively rerun; a rerun can never replace an individual failed sample`,
        ),
      );
    }
  }

  let p95ClientClockMs: number | null = null;
  if (measured.length === MEASURED_SAMPLES_PER_BATCH) {
    const clientClocks = measured.map((sample) => sample.clientClockMs);
    p95ClientClockMs = nearestRankP95(clientClocks);
    if (p95ClientClockMs >= DISCOVERY_P95_LIMIT_MS && benchmarkCaseName === "read-v1-discovery") {
      perfIssues.push(
        reason(
          "performance_failure",
          `Batch ${batch.batchId} ${benchmarkCaseName} client-clock p95 ${p95ClientClockMs} ms is not strictly below ${DISCOVERY_P95_LIMIT_MS} ms`,
        ),
      );
    }
    if (p95ClientClockMs >= EXACT_READ_P95_LIMIT_MS && benchmarkCaseName === "read-v1-exact-read") {
      perfIssues.push(
        reason(
          "performance_failure",
          `Batch ${batch.batchId} ${benchmarkCaseName} client-clock p95 ${p95ClientClockMs} ms is not strictly below ${EXACT_READ_P95_LIMIT_MS} ms`,
        ),
      );
    }
  }

  return {
    batchId: batch.batchId,
    sampleCount: samples.length,
    measuredCount: measured.length,
    structuralIssues,
    perfIssues,
    p95ClientClockMs,
    p95WorkClockMs: null,
    p95ProofClockMs: null,
    maxProofClockMs: null,
  };
}

function analyzeChangeBatch(batch: ChangeBenchmarkCase["batches"][number]): BatchAnalysis {
  const samples: readonly ChangeBatchSample[] = batch.samples;
  const structuralIssues: BlockingReason[] = [];
  const perfIssues: BlockingReason[] = [];

  for (let index = 0; index < samples.length; index += 1) {
    const sample = samples[index];
    if (sample === undefined) break;
    if (sample.ordinal !== index + 1) {
      structuralIssues.push(
        reason(
          "missing_evidence",
          `Batch ${batch.batchId} sample ordinal ${sample.ordinal} at execution position ${index + 1} breaks the required contiguous ordinal sequence`,
        ),
      );
    }
  }
  const measured = samples.filter((sample) => sample.disposition === "measured");
  if (measured.length !== MEASURED_SAMPLES_PER_BATCH) {
    structuralIssues.push(
      reason(
        "missing_evidence",
        `Batch ${batch.batchId} of change-v1 must contain exactly ${MEASURED_SAMPLES_PER_BATCH} measured samples; found ${measured.length}`,
      ),
    );
  }
  for (const sample of samples) {
    if (sample.disposition === "failed") {
      structuralIssues.push(
        reason(
          "correctness_failure",
          `Batch ${batch.batchId} change-v1 sample ordinal ${sample.ordinal} failed (${sample.failure?.code ?? "unknown"}) and cannot be replaced by a later sample`,
        ),
      );
    } else if (sample.disposition === "selectively_rerun") {
      structuralIssues.push(
        reason(
          "correctness_failure",
          `Batch ${batch.batchId} change-v1 sample ordinal ${sample.ordinal} was selectively rerun; a rerun can never replace an individual failed sample`,
        ),
      );
    }
  }

  let p95WorkClockMs: number | null = null;
  let p95ProofClockMs: number | null = null;
  let maxProofClockMs: number | null = null;
  if (measured.length === MEASURED_SAMPLES_PER_BATCH) {
    const workClocks = measured.map((sample) => sample.workClockMs);
    const proofClocks = measured.map((sample) => sample.proofClockMs);
    p95WorkClockMs = nearestRankP95(workClocks);
    p95ProofClockMs = nearestRankP95(proofClocks);
    maxProofClockMs = Math.max(...proofClocks);
    if (p95WorkClockMs >= WORK_CLOCK_P95_LIMIT_MS) {
      perfIssues.push(
        reason(
          "performance_failure",
          `Batch ${batch.batchId} change-v1 Work Clock p95 ${p95WorkClockMs} ms is not strictly below ${WORK_CLOCK_P95_LIMIT_MS} ms`,
        ),
      );
    }
    if (p95ProofClockMs >= PROOF_CLOCK_P95_LIMIT_MS) {
      perfIssues.push(
        reason(
          "performance_failure",
          `Batch ${batch.batchId} change-v1 Proof Clock p95 ${p95ProofClockMs} ms is not strictly below ${PROOF_CLOCK_P95_LIMIT_MS} ms`,
        ),
      );
    }
    for (const sample of measured) {
      if (sample.proofClockMs >= PROOF_CLOCK_SAMPLE_LIMIT_MS) {
        structuralIssues.push(
          reason(
            "correctness_failure",
            `Batch ${batch.batchId} change-v1 sample ordinal ${sample.ordinal} Proof Clock ${sample.proofClockMs} ms reached the ${PROOF_CLOCK_SAMPLE_LIMIT_MS} ms correctness deadline`,
          ),
        );
      }
    }
  }

  return {
    batchId: batch.batchId,
    sampleCount: samples.length,
    measuredCount: measured.length,
    structuralIssues,
    perfIssues,
    p95ClientClockMs: null,
    p95WorkClockMs,
    p95ProofClockMs,
    maxProofClockMs,
  };
}

function analysisToBatchEvaluation(analysis: BatchAnalysis): BatchEvaluation {
  const blockingReasons = [...analysis.structuralIssues, ...analysis.perfIssues];
  return {
    batchId: analysis.batchId,
    sampleCount: analysis.sampleCount,
    measuredCount: analysis.measuredCount,
    p95ClientClockMs: analysis.p95ClientClockMs,
    p95WorkClockMs: analysis.p95WorkClockMs,
    p95ProofClockMs: analysis.p95ProofClockMs,
    maxProofClockMs: analysis.maxProofClockMs,
    status: blockingReasons.length === 0 ? "passed" : "blocked",
    blockingReasons,
  };
}

interface RuntimeProfileAssessment {
  readonly compatible: boolean;
  readonly reasons: readonly BlockingReason[];
  readonly mismatches: readonly string[];
  readonly failedPreconditions: readonly string[];
}

function observedEnvironmentForPreflight(
  observed: BenchmarkTrace["runtimeProfile"]["observed"],
): ObservedRuntimeEnvironment {
  return {
    platform: observed.platform,
    osBuild: observed.osBuild ?? undefined,
    obsidianVersion: observed.obsidianVersion ?? undefined,
    electronVersion: observed.electronVersion ?? undefined,
    nodeVersion: observed.nodeVersion ?? undefined,
    capabilities: observed.capabilities,
  };
}

function assessRuntimeProfile(trace: BenchmarkTrace): RuntimeProfileAssessment {
  const reasons: BlockingReason[] = [];
  const mismatches: string[] = [];
  const failedPreconditions: string[] = [];
  const profile = lookupRegisteredRuntimeProfile(trace.runtimeProfile.name);
  if (profile === null) {
    reasons.push(
      reason(
        "incompatible_profile",
        `Runtime profile "${trace.runtimeProfile.name}" is not a registered profile`,
      ),
    );
  } else {
    for (const mismatch of preflightRuntimeProfile(profile, observedEnvironmentForPreflight(trace.runtimeProfile.observed))) {
      mismatches.push(
        `${mismatch.field}: expected ${mismatch.expected}, observed ${mismatch.actual ?? "unobserved"}`,
      );
      reasons.push(
        reason(
          "incompatible_profile",
          `Runtime profile field ${mismatch.field}: expected ${mismatch.expected}, observed ${mismatch.actual ?? "unobserved"}`,
        ),
      );
    }
  }
  for (const precondition of trace.runtimeProfile.preconditions) {
    if (!precondition.satisfied) {
      failedPreconditions.push(precondition.code);
      reasons.push(
        reason(
          "environment_precondition_failure",
          `Environment precondition "${precondition.code}" was not satisfied`,
        ),
      );
    }
  }
  return { compatible: reasons.length === 0, reasons, mismatches, failedPreconditions };
}

function evaluateReadCase(benchmarkCase: ReadBenchmarkCase): CaseEvaluation {
  const blockingReasons: BlockingReason[] = [];
  const expectedManifestSha256 = canonicalFixtureManifestSha256(benchmarkCase.fixture);
  const fixtureManifestCurrent = benchmarkCase.fixtureManifestSha256 === expectedManifestSha256;
  if (!fixtureManifestCurrent) {
    blockingReasons.push(
      reason(
        "stale_evidence",
        `${benchmarkCase.case} binds fixture manifest ${benchmarkCase.fixtureManifestSha256}, which is not the fixed ${benchmarkCase.fixture} manifest ${expectedManifestSha256}`,
      ),
    );
  }
  if (benchmarkCase.batches.length !== 3) {
    blockingReasons.push(
      reason(
        "missing_evidence",
        `${benchmarkCase.case} must record exactly three independent batches; found ${benchmarkCase.batches.length}`,
      ),
    );
  }
  const batchIds = benchmarkCase.batches.map((batch) => batch.batchId);
  if (new Set(batchIds).size !== batchIds.length) {
    blockingReasons.push(
      reason(
        "contradictory_evidence",
        `${benchmarkCase.case} records batch identity more than once (${batchIds.join(", ")}); three independent batches require three distinct identities`,
      ),
    );
  }
  const batches = benchmarkCase.batches.map((batch) =>
    analysisToBatchEvaluation(analyzeReadBatch(benchmarkCase.case, batch)),
  );
  for (const batch of batches) {
    blockingReasons.push(...batch.blockingReasons);
  }
  return {
    case: benchmarkCase.case,
    fixture: benchmarkCase.fixture,
    fixtureManifestSha256: benchmarkCase.fixtureManifestSha256,
    fixtureManifestCurrent,
    batches,
    status: blockingReasons.length === 0 ? "passed" : "blocked",
    blockingReasons,
  };
}

function evaluateChangeCase(benchmarkCase: ChangeBenchmarkCase): CaseEvaluation {
  const blockingReasons: BlockingReason[] = [];
  const expectedManifestSha256 = canonicalFixtureManifestSha256(benchmarkCase.fixture);
  const fixtureManifestCurrent = benchmarkCase.fixtureManifestSha256 === expectedManifestSha256;
  if (!fixtureManifestCurrent) {
    blockingReasons.push(
      reason(
        "stale_evidence",
        `${benchmarkCase.case} binds fixture manifest ${benchmarkCase.fixtureManifestSha256}, which is not the fixed ${benchmarkCase.fixture} manifest ${expectedManifestSha256}`,
      ),
    );
  }
  if (benchmarkCase.batches.length !== 3) {
    blockingReasons.push(
      reason(
        "missing_evidence",
        `${benchmarkCase.case} must record exactly three independent batches; found ${benchmarkCase.batches.length}`,
      ),
    );
  }
  const batchIds = benchmarkCase.batches.map((batch) => batch.batchId);
  if (new Set(batchIds).size !== batchIds.length) {
    blockingReasons.push(
      reason(
        "contradictory_evidence",
        `${benchmarkCase.case} records batch identity more than once (${batchIds.join(", ")}); three independent batches require three distinct identities`,
      ),
    );
  }
  const batches = benchmarkCase.batches.map((batch) =>
    analysisToBatchEvaluation(analyzeChangeBatch(batch)),
  );
  for (const batch of batches) {
    blockingReasons.push(...batch.blockingReasons);
  }
  return {
    case: benchmarkCase.case,
    fixture: benchmarkCase.fixture,
    fixtureManifestSha256: benchmarkCase.fixtureManifestSha256,
    fixtureManifestCurrent,
    batches,
    status: blockingReasons.length === 0 ? "passed" : "blocked",
    blockingReasons,
  };
}

export interface ReleaseGateVerdict {
  readonly gate: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11;
  readonly code: string;
  readonly status: "passed" | "blocked";
  readonly artifacts: readonly GateArtifact[];
  readonly blockingReasons: readonly BlockingReason[];
}

export interface FixtureBinding {
  readonly fixture: FixedPerformanceFixtureName;
  readonly manifestSha256: string;
  readonly current: boolean;
}

export interface BoundInputs {
  readonly versions: BenchmarkTrace["versions"];
  readonly compatibility: BenchmarkTrace["compatibility"];
  readonly runtimeProfile: {
    readonly name: string;
    readonly compatible: boolean;
    readonly mismatches: readonly string[];
    readonly failedPreconditions: readonly string[];
  };
  readonly fixtures: readonly FixtureBinding[];
}

export interface BenchmarkTraceEvaluation {
  readonly schemaVersion: typeof BENCHMARK_TRACE_SCHEMA_VERSION;
  readonly traceId: string;
  readonly verdict: "passed" | "blocked";
  readonly gates: readonly ReleaseGateVerdict[];
  readonly cases: readonly CaseEvaluation[];
  readonly blockingReasons: readonly BlockingReason[];
  readonly boundInputs: BoundInputs;
}

interface GateDefinition {
  readonly gate: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11;
  readonly code: string;
}

const EVIDENCE_OWNED_GATES: readonly GateDefinition[] = [
  { gate: 1, code: "contract_package_present" },
  { gate: 2, code: "contract_fixtures_and_scenarios_pass" },
  { gate: 3, code: "acceptance_matrix_pass" },
  { gate: 4, code: "corpora_pass_with_manifests" },
  { gate: 5, code: "no_fixture_residual_or_unreported_blocked_gate" },
  { gate: 6, code: "release_artifacts_lifecycle_pass" },
  { gate: 7, code: "privacy_evidence_pass" },
  { gate: 8, code: "operating_constants_published" },
  { gate: 11, code: "correctness_barriers_pass" },
];

const REQUIRED_CASES: readonly BenchmarkCaseName[] = [
  "read-v1-discovery",
  "read-v1-exact-read",
  "change-v1",
];

function caseBinding(benchmarkCase: BenchmarkCase): GateArtifact {
  return { artifactId: `benchmark-case:${benchmarkCase.case}`, artifactSha256: benchmarkCase.fixtureManifestSha256 };
}

function gateVerdict(
  definition: GateDefinition,
  artifacts: readonly GateArtifact[],
  blockingReasons: readonly BlockingReason[],
): ReleaseGateVerdict {
  return {
    gate: definition.gate,
    code: definition.code,
    status: blockingReasons.length === 0 ? "passed" : "blocked",
    artifacts,
    blockingReasons,
  };
}

function evidenceOwnedGateVerdict(
  definition: GateDefinition,
  evidence: readonly ReleaseGateEvidence[],
): ReleaseGateVerdict {
  const recorded = evidence.find((item) => item.gate === definition.gate);
  if (recorded === undefined) {
    return gateVerdict(definition, [], [
      reason("missing_evidence", `Release gate ${definition.gate} (${definition.code}) has no recorded evidence reference`),
    ]);
  }
  if (recorded.outcome === "passed") {
    return gateVerdict(definition, recorded.artifacts, []);
  }
  return gateVerdict(definition, recorded.artifacts, recorded.blockingReasons);
}

function performanceGateArtifacts(cases: readonly BenchmarkCase[], wanted: readonly BenchmarkCaseName[]): GateArtifact[] {
  return cases
    .filter((benchmarkCase) => wanted.includes(benchmarkCase.case))
    .map(caseBinding);
}

function computePerformanceGateVerdict(
  trace: BenchmarkTrace,
  cases: readonly CaseEvaluation[],
  profile: RuntimeProfileAssessment,
  definition: GateDefinition,
): ReleaseGateVerdict {
  const byCaseName = new Map(cases.map((benchmarkCase) => [benchmarkCase.case, benchmarkCase]));
  const blockingReasons: BlockingReason[] = [];

  if (definition.gate === 9) {
    for (const requiredCase of REQUIRED_CASES) {
      const benchmarkCase = byCaseName.get(requiredCase);
      if (benchmarkCase === undefined) {
        blockingReasons.push(
          reason(
            "missing_evidence",
            `Release gate 9 requires measured ${requiredCase} samples; the trace records no such case`,
          ),
        );
      } else if (benchmarkCase.status !== "passed") {
        blockingReasons.push(...benchmarkCase.blockingReasons);
      }
    }
    if (!profile.compatible) {
      blockingReasons.push(...profile.reasons);
    }
    return gateVerdict(
      definition,
      performanceGateArtifacts(trace.cases, REQUIRED_CASES),
      blockingReasons,
    );
  }

  // Gate 10: every Proof Clock sample is strictly below the installed 5,000 ms
  // correctness deadline. Passing p95 percentiles can never satisfy it, so the
  // gate is derived from the raw structural analysis, not from gate 9's status.
  const rawChangeCase = trace.cases.find((benchmarkCase) => benchmarkCase.case === "change-v1");
  if (rawChangeCase === undefined) {
    blockingReasons.push(
      reason(
        "missing_evidence",
        "Release gate 10 requires measured change-v1 Proof Clock samples; the trace records no such case",
      ),
    );
  } else {
    if (rawChangeCase.batches.length !== 3) {
      blockingReasons.push(
        reason(
          "missing_evidence",
          `change-v1 must record exactly three independent batches; found ${rawChangeCase.batches.length}`,
        ),
      );
    }
    if (rawChangeCase.fixtureManifestSha256 !== canonicalFixtureManifestSha256("change-v1")) {
      blockingReasons.push(
        reason(
          "stale_evidence",
          `change-v1 binds fixture manifest ${rawChangeCase.fixtureManifestSha256}, which is not the fixed change-v1 manifest ${canonicalFixtureManifestSha256("change-v1")}`,
        ),
      );
    }
    for (const batch of rawChangeCase.batches) {
      blockingReasons.push(...analyzeChangeBatch(batch).structuralIssues);
    }
  }
  if (!profile.compatible) {
    blockingReasons.push(...profile.reasons);
  }
  return gateVerdict(definition, performanceGateArtifacts(trace.cases, ["change-v1"]), blockingReasons);
}

function deduplicateReasons(reasons: readonly BlockingReason[]): BlockingReason[] {
  const seen = new Set<string>();
  const result: BlockingReason[] = [];
  for (const item of reasons) {
    const key = `${item.code}\n${item.detail}`;
    if (!seen.has(key)) {
      seen.add(key);
      result.push(item);
    }
  }
  return result;
}

/**
 * Evaluates a structurally valid benchmark trace into a canonical, auditable
 * verdict. The eleven release gates are each reported separately; the overall
 * verdict blocks on any correctness failure, `result_unproven`, rollback
 * failure, blocked gate, fixture residual, missing or stale evidence,
 * incompatible profile, or performance failure regardless of passing
 * percentiles.
 */
export function evaluateBenchmarkTrace(trace: BenchmarkTrace): BenchmarkTraceEvaluation {
  const profile = assessRuntimeProfile(trace);
  const caseEvaluations = trace.cases.map((benchmarkCase) =>
    benchmarkCase.case === "change-v1"
      ? evaluateChangeCase(benchmarkCase)
      : evaluateReadCase(benchmarkCase),
  );

  const gateDefinitions: GateDefinition[] = [
    ...EVIDENCE_OWNED_GATES,
    { gate: 9, code: "performance_p95_gates" } as const,
    { gate: 10, code: "proof_clock_deadline" } as const,
  ].sort((left, right) => left.gate - right.gate);

  const gates: ReleaseGateVerdict[] = gateDefinitions.map((definition) => {
    if (definition.gate === 9 || definition.gate === 10) {
      return computePerformanceGateVerdict(trace, caseEvaluations, profile, definition);
    }
    return evidenceOwnedGateVerdict(definition, trace.evidence);
  });

  const blockingReasons = deduplicateReasons(gates.flatMap((item) => item.blockingReasons));
  const verdict: "passed" | "blocked" = blockingReasons.length === 0 ? "passed" : "blocked";

  const fixtures: FixtureBinding[] = [];
  const seenFixtures = new Set<FixedPerformanceFixtureName>();
  for (const benchmarkCase of trace.cases) {
    if (seenFixtures.has(benchmarkCase.fixture)) continue;
    seenFixtures.add(benchmarkCase.fixture);
    fixtures.push({
      fixture: benchmarkCase.fixture,
      manifestSha256: benchmarkCase.fixtureManifestSha256,
      current: benchmarkCase.fixtureManifestSha256 === canonicalFixtureManifestSha256(benchmarkCase.fixture),
    });
  }
  const boundInputs: BoundInputs = {
    versions: trace.versions,
    compatibility: trace.compatibility,
    runtimeProfile: {
      name: trace.runtimeProfile.name,
      compatible: profile.compatible,
      mismatches: profile.mismatches,
      failedPreconditions: profile.failedPreconditions,
    },
    fixtures,
  };

  return {
    schemaVersion: BENCHMARK_TRACE_SCHEMA_VERSION,
    traceId: trace.traceId,
    verdict,
    gates,
    cases: caseEvaluations,
    blockingReasons,
    boundInputs,
  };
}
