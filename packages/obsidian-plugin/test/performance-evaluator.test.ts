import { describe, expect, it } from "vitest";

import {
  BENCHMARK_TRACE_SCHEMA_VERSION,
  BenchmarkTraceError,
  evaluateBenchmarkTrace,
  nearestRankP95,
  parseBenchmarkTrace,
  type BenchmarkTraceEvaluation,
  type ReleaseGateVerdict,
} from "../src/performance-evaluator.js";
import { fixedPerformanceFixtureManifest } from "../src/performance-fixture.js";

/**
 * Deterministic evaluator tests (issue #171). Every trace in this file is a
 * synthetic trace constructed for testing and is never release evidence.
 */

const READ_FIXTURE_SHA256 = fixedPerformanceFixtureManifest("read-v1").manifestSha256;
const CHANGE_FIXTURE_SHA256 = fixedPerformanceFixtureManifest("change-v1").manifestSha256;
const VALID_SHA256 = "ab12".repeat(16);

const OBSERVED_ENVIRONMENT = {
  platform: "win32",
  osBuild: "26200",
  obsidianVersion: "1.13.4",
  electronVersion: "39.6.0",
  nodeVersion: "24.14.0",
  capabilities: ["loopback_http", "ntfs_fixtures", "obsidian_gui", "process_control"],
};

const PASSED_EVIDENCE = [1, 2, 3, 4, 5, 6, 7, 8, 11].map((gate) => ({
  schemaVersion: BENCHMARK_TRACE_SCHEMA_VERSION,
  gate,
  outcome: "passed",
  artifacts: [{ artifactId: `gate-${gate}-artifact`, artifactSha256: VALID_SHA256 }],
  blockingReasons: [],
}));

interface TraceOptions {
  readonly cases?: readonly unknown[];
  readonly evidence?: readonly unknown[];
  readonly profileName?: string;
  readonly observed?: typeof OBSERVED_ENVIRONMENT;
  readonly preconditions?: readonly { code: string; satisfied: boolean }[];
}

function measuredRead(clientClockMs: number): object {
  return { disposition: "measured", clientClockMs };
}

function measuredChange(workClockMs: number, proofClockMs: number): object {
  return { disposition: "measured", workClockMs, proofClockMs };
}

function renumber(records: readonly object[]): object[] {
  return records.map((record, index) => ({ ...record, ordinal: index + 1 }));
}

function readBatch(batchId: string, clientClocks: readonly number[], extra: readonly object[] = []): object {
  return { batchId, samples: renumber([...clientClocks.map(measuredRead), ...extra]) };
}

function changeBatch(batchId: string, workClocks: readonly number[], proofClocks: readonly number[], extra: readonly object[] = []): object {
  return {
    batchId,
    samples: renumber([
      ...workClocks.map((workClockMs, index) => measuredChange(workClockMs, proofClocks[index] ?? 0)),
      ...extra,
    ]),
  };
}

function readCase(caseName: "read-v1-discovery" | "read-v1-exact-read", batches: readonly object[]): object {
  return { case: caseName, fixture: "read-v1", fixtureManifestSha256: READ_FIXTURE_SHA256, batches };
}

function changeCase(batches: readonly object[]): object {
  return { case: "change-v1", fixture: "change-v1", fixtureManifestSha256: CHANGE_FIXTURE_SHA256, batches };
}

const PASSING_READ_CLOCKS = Array.from({ length: 30 }, () => 120);
const PASSING_WORK_CLOCKS = Array.from({ length: 30 }, () => 500);
const PASSING_PROOF_CLOCKS = Array.from({ length: 30 }, () => 2_000);

function threeReadBatches(): object[] {
  return [
    readBatch("read-batch-1", PASSING_READ_CLOCKS),
    readBatch("read-batch-2", PASSING_READ_CLOCKS),
    readBatch("read-batch-3", PASSING_READ_CLOCKS),
  ];
}

function threeChangeBatches(): object[] {
  return [
    changeBatch("change-batch-1", PASSING_WORK_CLOCKS, PASSING_PROOF_CLOCKS),
    changeBatch("change-batch-2", PASSING_WORK_CLOCKS, PASSING_PROOF_CLOCKS),
    changeBatch("change-batch-3", PASSING_WORK_CLOCKS, PASSING_PROOF_CLOCKS),
  ];
}

function makeTrace(options: TraceOptions = {}): object {
  return {
    schemaVersion: BENCHMARK_TRACE_SCHEMA_VERSION,
    traceId: "synthetic-trace",
    versions: { bridge: "0.1.0", plugin: "0.1.0", protocol: "1.0", mcpSdk: "1.30.0" },
    runtimeProfile: {
      name: options.profileName ?? "MVP-PERF-REF-1",
      observed: options.observed ?? OBSERVED_ENVIRONMENT,
      preconditions: options.preconditions ?? [{ code: "idle_cpu_below_10_percent", satisfied: true }],
    },
    compatibility: { observation: "compatible", version: "2.1.0" },
    cases:
      options.cases ??
      [
        readCase("read-v1-discovery", threeReadBatches()),
        readCase("read-v1-exact-read", threeReadBatches()),
        changeCase(threeChangeBatches()),
      ],
    evidence: options.evidence ?? PASSED_EVIDENCE,
  };
}

function evaluate(raw: unknown): BenchmarkTraceEvaluation {
  return evaluateBenchmarkTrace(parseBenchmarkTrace(raw));
}

function gate(evaluation: BenchmarkTraceEvaluation, number: number): ReleaseGateVerdict {
  const found = evaluation.gates.find((item) => item.gate === number);
  if (found === undefined) throw new Error(`Gate ${number} missing from verdict`);
  return found;
}

function withP95At(values: readonly number[], index: number, value: number): number[] {
  const copy = [...values];
  copy[index] = value;
  return copy;
}

describe("parseBenchmarkTrace structural validation", () => {
  it("accepts a fully valid trace", () => {
    const trace = parseBenchmarkTrace(makeTrace());
    expect(trace.schemaVersion).toBe(BENCHMARK_TRACE_SCHEMA_VERSION);
    expect(trace.cases).toHaveLength(3);
    expect(trace.evidence).toHaveLength(9);
  });

  it("rejects unknown fields instead of stripping them", () => {
    const raw = makeTrace() as Record<string, unknown>;
    raw.unexpected = true;
    expect(() => parseBenchmarkTrace(raw)).toThrow(BenchmarkTraceError);
  });

  it("rejects a repeated case identity", () => {
    const cases = [
      ...(makeTrace().cases as object[]),
      readCase("read-v1-discovery", threeReadBatches()),
    ];
    expect(() => parseBenchmarkTrace(makeTrace({ cases }))).toThrow(BenchmarkTraceError);
  });

  it("rejects a repeated evidence gate reference", () => {
    const evidence = [...PASSED_EVIDENCE, PASSED_EVIDENCE[0] as object];
    expect(() => parseBenchmarkTrace(makeTrace({ evidence }))).toThrow(BenchmarkTraceError);
  });

  it("rejects unknown blocking-reason codes and passed gates without an artifact", () => {
    const blockedEvidence = [
      {
        schemaVersion: BENCHMARK_TRACE_SCHEMA_VERSION,
        gate: 1,
        outcome: "blocked",
        artifacts: [],
        blockingReasons: [{ code: "not_a_real_code", detail: "made up" }],
      },
    ];
    expect(() => parseBenchmarkTrace(makeTrace({ evidence: blockedEvidence }))).toThrow(BenchmarkTraceError);

    const noArtifactEvidence = [
      {
        schemaVersion: BENCHMARK_TRACE_SCHEMA_VERSION,
        gate: 1,
        outcome: "passed",
        artifacts: [],
        blockingReasons: [],
      },
    ];
    expect(() => parseBenchmarkTrace(makeTrace({ evidence: noArtifactEvidence }))).toThrow(BenchmarkTraceError);
  });
});

describe("nearest-rank p95", () => {
  it("returns the 29th ordered sample of exactly 30 measured samples", () => {
    const ascending = Array.from({ length: 30 }, (_, index) => index + 1);
    const descending = [...ascending].reverse();
    expect(nearestRankP95(ascending)).toBe(29);
    expect(nearestRankP95(descending)).toBe(29);
  });

  it("never depends on pooling and rejects a sample count other than 30", () => {
    expect(() => nearestRankP95(Array.from({ length: 29 }, () => 1))).toThrow(/exactly 30/);
    expect(() => nearestRankP95(Array.from({ length: 31 }, () => 1))).toThrow(/exactly 30/);
  });
});

describe("read-v1 threshold boundaries", () => {
  it("passes discovery when every batch p95 is strictly below 200 ms and fails at exactly 200 ms", () => {
    // 28 low values then the 29th ordered sample at the boundary.
    const boundary = (value: number): number[] => {
      const clocks = Array.from({ length: 30 }, () => 1);
      clocks[28] = value;
      clocks[29] = 300;
      return clocks;
    };
    const passingTrace = evaluate(
      makeTrace({
        cases: [
          readCase("read-v1-discovery", [
            readBatch("b1", boundary(199)),
            readBatch("b2", boundary(199)),
            readBatch("b3", boundary(199)),
          ]),
          readCase("read-v1-exact-read", threeReadBatches()),
          changeCase(threeChangeBatches()),
        ],
      }),
    );
    expect(passingTrace.verdict).toBe("passed");
    expect(passingTrace.cases[0]?.status).toBe("passed");
    expect(passingTrace.cases[0]?.batches[0]?.p95ClientClockMs).toBe(199);

    const failingTrace = evaluate(
      makeTrace({
        cases: [
          readCase("read-v1-discovery", [
            readBatch("b1", boundary(200)),
            readBatch("b2", boundary(200)),
            readBatch("b3", boundary(200)),
          ]),
          readCase("read-v1-exact-read", threeReadBatches()),
          changeCase(threeChangeBatches()),
        ],
      }),
    );
    expect(failingTrace.verdict).toBe("blocked");
    expect(failingTrace.cases[0]?.status).toBe("blocked");
    expect(gate(failingTrace, 9).status).toBe("blocked");
    expect(failingTrace.blockingReasons.some((item) => item.code === "performance_failure")).toBe(true);
  });

  it("enforces the exact-read 200 ms gate independently of discovery", () => {
    const boundary = Array.from({ length: 30 }, () => 1);
    boundary[28] = 250;
    boundary[29] = 300;
    const evaluation = evaluate(
      makeTrace({
        cases: [
          readCase("read-v1-discovery", threeReadBatches()),
          readCase("read-v1-exact-read", [
            readBatch("b1", boundary),
            readBatch("b2", boundary),
            readBatch("b3", boundary),
          ]),
          changeCase(threeChangeBatches()),
        ],
      }),
    );
    expect(evaluation.cases[0]?.status).toBe("passed");
    expect(evaluation.cases[1]?.status).toBe("blocked");
    expect(evaluation.cases[1]?.batches[0]?.p95ClientClockMs).toBe(250);
  });
});

describe("change-v1 p95 and Proof Clock deadline gates", () => {
  function boundaryChangeBatches(proofValue: number): object[] {
    const work = PASSING_WORK_CLOCKS;
    const makeProof = (): number[] => {
      const proof = Array.from({ length: 30 }, () => 1_000);
      proof[28] = proofValue;
      proof[29] = proofValue;
      return proof;
    };
    return [
      changeBatch("b1", work, makeProof()),
      changeBatch("b2", work, makeProof()),
      changeBatch("b3", work, makeProof()),
    ];
  }

  it("passes Proof Clock p95 at 3999 and fails at 4000", () => {
    const passing = evaluate(makeTrace({ cases: [readCase("read-v1-discovery", threeReadBatches()), readCase("read-v1-exact-read", threeReadBatches()), changeCase(boundaryChangeBatches(3_999))] }));
    expect(passing.verdict).toBe("passed");
    expect(gate(passing, 9).status).toBe("passed");

    const failing = evaluate(makeTrace({ cases: [readCase("read-v1-discovery", threeReadBatches()), readCase("read-v1-exact-read", threeReadBatches()), changeCase(boundaryChangeBatches(4_000))] }));
    expect(failing.verdict).toBe("blocked");
    expect(failing.cases[2]?.status).toBe("blocked");
    expect(failing.cases[2]?.batches[0]?.p95ProofClockMs).toBe(4_000);
    expect(failing.blockingReasons.some((item) => item.code === "performance_failure")).toBe(true);
  });

  it("keeps gate 10 (every Proof sample below 5000) independent of the p95 threshold", () => {
    const work = PASSING_WORK_CLOCKS;
    // 29 low proof samples then one 4999 ms sample: p95 stays low but the
    // deadline check is separate.
    const proof = Array.from({ length: 29 }, () => 1_000);
    proof.push(4_999);
    const evaluation = evaluate(
      makeTrace({
        cases: [
          readCase("read-v1-discovery", threeReadBatches()),
          readCase("read-v1-exact-read", threeReadBatches()),
          changeCase([
            changeBatch("b1", work, proof),
            changeBatch("b2", work, proof),
            changeBatch("b3", work, proof),
          ]),
        ],
      }),
    );
    expect(gate(evaluation, 10).status).toBe("passed");
    expect(gate(evaluation, 9).status).toBe("passed");
    expect(evaluation.cases[2]?.batches[0]?.p95ProofClockMs).toBe(1_000);
    expect(evaluation.cases[2]?.batches[0]?.maxProofClockMs).toBe(4_999);
  });

  it("blocks on any Proof Clock sample at the 5000 ms correctness deadline", () => {
    const work = PASSING_WORK_CLOCKS;
    const proof = Array.from({ length: 29 }, () => 1_000);
    proof.push(5_000);
    const evaluation = evaluate(
      makeTrace({
        cases: [
          readCase("read-v1-discovery", threeReadBatches()),
          readCase("read-v1-exact-read", threeReadBatches()),
          changeCase([
            changeBatch("b1", work, proof),
            changeBatch("b2", work, proof),
            changeBatch("b3", work, proof),
          ]),
        ],
      }),
    );
    expect(evaluation.verdict).toBe("blocked");
    expect(gate(evaluation, 10).status).toBe("blocked");
    expect(evaluation.blockingReasons.some((item) => item.code === "correctness_failure")).toBe(true);
  });
});

describe("no pooling and no outlier removal", () => {
  it("fails one slow batch without pooling across the other two passing batches", () => {
    const fast = PASSING_READ_CLOCKS;
    const slow = Array.from({ length: 30 }, () => 1);
    slow[28] = 250;
    slow[29] = 4_000;
    const evaluation = evaluate(
      makeTrace({
        cases: [
          readCase("read-v1-discovery", [readBatch("slow", slow), readBatch("fast-1", fast), readBatch("fast-2", fast)]),
          readCase("read-v1-exact-read", threeReadBatches()),
          changeCase(threeChangeBatches()),
        ],
      }),
    );
    expect(evaluation.cases[0]?.status).toBe("blocked");
    // The failing batch's p95 is its own 29th ordered sample (250), never a
    // pooled percentile of all three batches.
    expect(evaluation.cases[0]?.batches[0]?.p95ClientClockMs).toBe(250);
    expect(evaluation.cases[0]?.batches[1]?.status).toBe("passed");
    expect(gate(evaluation, 9).status).toBe("blocked");
  });

  it("computes p95 from the 29th ordered value and never discards high samples as outliers", () => {
    const work = PASSING_WORK_CLOCKS;
    const proof = Array.from({ length: 30 }, () => 1_000);
    proof[28] = 4_900;
    proof[29] = 4_999;
    const evaluation = evaluate(
      makeTrace({
        cases: [
          readCase("read-v1-discovery", threeReadBatches()),
          readCase("read-v1-exact-read", threeReadBatches()),
          changeCase([changeBatch("b1", work, proof), changeBatch("b2", work, proof), changeBatch("b3", work, proof)]),
        ],
      }),
    );
    // p95 is the 29th ordered sample (4900), not an average, and the single
    // largest sample is excluded only by nearest rank, not by removing it.
    expect(evaluation.cases[2]?.batches[0]?.p95ProofClockMs).toBe(4_900);
    expect(evaluation.cases[2]?.batches[0]?.maxProofClockMs).toBe(4_999);
    expect(evaluation.cases[2]?.status).toBe("blocked");
    expect(gate(evaluation, 10).status).toBe("passed");
  });
});

describe("sample integrity is fail closed", () => {
  it("rejects a failed sample even when exactly 30 measured samples remain", () => {
    const clientClocks = PASSING_READ_CLOCKS;
    const extra = [{ disposition: "failed", failure: { code: "content_mismatch", detail: "wrong bytes" } }];
    const batches = [readBatch("b1", clientClocks, extra), readBatch("b2", PASSING_READ_CLOCKS), readBatch("b3", PASSING_READ_CLOCKS)];
    const evaluation = evaluate(
      makeTrace({
        cases: [
          readCase("read-v1-discovery", batches),
          readCase("read-v1-exact-read", threeReadBatches()),
          changeCase(threeChangeBatches()),
        ],
      }),
    );
    expect(evaluation.cases[0]?.status).toBe("blocked");
    expect(evaluation.blockingReasons.some((item) => item.code === "correctness_failure")).toBe(true);
  });

  it("rejects a selectively rerun sample", () => {
    const extra = [{ disposition: "selectively_rerun", failure: { code: "timeout" } }];
    const batches = [readBatch("b1", PASSING_READ_CLOCKS, extra), readBatch("b2", PASSING_READ_CLOCKS), readBatch("b3", PASSING_READ_CLOCKS)];
    const evaluation = evaluate(
      makeTrace({
        cases: [
          readCase("read-v1-discovery", batches),
          readCase("read-v1-exact-read", threeReadBatches()),
          changeCase(threeChangeBatches()),
        ],
      }),
    );
    expect(evaluation.cases[0]?.status).toBe("blocked");
    expect(evaluation.blockingReasons.some((item) => item.code === "correctness_failure")).toBe(true);
  });

  it("rejects a batch with fewer than 30 measured samples", () => {
    const short = PASSING_READ_CLOCKS.slice(0, 29);
    const batches = [readBatch("b1", short), readBatch("b2", PASSING_READ_CLOCKS), readBatch("b3", PASSING_READ_CLOCKS)];
    const evaluation = evaluate(
      makeTrace({
        cases: [
          readCase("read-v1-discovery", batches),
          readCase("read-v1-exact-read", threeReadBatches()),
          changeCase(threeChangeBatches()),
        ],
      }),
    );
    expect(evaluation.cases[0]?.status).toBe("blocked");
    expect(evaluation.blockingReasons.some((item) => item.code === "missing_evidence")).toBe(true);
  });

  it("rejects a dropped sample whose ordinal gap cannot hide a missing execution", () => {
    // 31 recorded measured values, then drop the record at index 14 without
    // renumbering, leaving a gap at ordinal 15.
    const records = PASSING_READ_CLOCKS.concat(120).map((clientClockMs, index) => ({
      ordinal: index + 1,
      disposition: "measured",
      clientClockMs,
    }));
    records.splice(14, 1);
    const batches = [
      { batchId: "b1", samples: records },
      readBatch("b2", PASSING_READ_CLOCKS),
      readBatch("b3", PASSING_READ_CLOCKS),
    ];
    const evaluation = evaluate(
      makeTrace({
        cases: [
          readCase("read-v1-discovery", batches),
          readCase("read-v1-exact-read", threeReadBatches()),
          changeCase(threeChangeBatches()),
        ],
      }),
    );
    expect(evaluation.cases[0]?.status).toBe("blocked");
    expect(evaluation.blockingReasons.some((item) => item.code === "missing_evidence")).toBe(true);
  });

  it("rejects a duplicate sample ordinal", () => {
    const records = PASSING_READ_CLOCKS.map((clientClockMs, index) => ({
      ordinal: index + 1,
      disposition: "measured",
      clientClockMs,
    }));
    // Duplicate ordinal 2 at execution positions 1 and 2.
    records[2] = { ...(records[2] as { ordinal: number; disposition: "measured"; clientClockMs: number }), ordinal: 2 };
    const batches = [
      { batchId: "b1", samples: records },
      readBatch("b2", PASSING_READ_CLOCKS),
      readBatch("b3", PASSING_READ_CLOCKS),
    ];
    const evaluation = evaluate(
      makeTrace({
        cases: [
          readCase("read-v1-discovery", batches),
          readCase("read-v1-exact-read", threeReadBatches()),
          changeCase(threeChangeBatches()),
        ],
      }),
    );
    expect(evaluation.cases[0]?.status).toBe("blocked");
    expect(evaluation.blockingReasons.some((item) => item.code === "missing_evidence")).toBe(true);
  });

  it("requires exactly three independent batches per case", () => {
    const batches = [readBatch("b1", PASSING_READ_CLOCKS), readBatch("b2", PASSING_READ_CLOCKS)];
    const evaluation = evaluate(
      makeTrace({
        cases: [
          readCase("read-v1-discovery", batches),
          readCase("read-v1-exact-read", threeReadBatches()),
          changeCase(threeChangeBatches()),
        ],
      }),
    );
    expect(evaluation.cases[0]?.status).toBe("blocked");
    expect(evaluation.blockingReasons.some((item) => item.detail.includes("three independent batches"))).toBe(true);
  });

  it("requires three distinct independent batch identities", () => {
    const duplicated = [readBatch("b1", PASSING_READ_CLOCKS), readBatch("b1", PASSING_READ_CLOCKS), readBatch("b3", PASSING_READ_CLOCKS)];
    const evaluation = evaluate(
      makeTrace({
        cases: [
          readCase("read-v1-discovery", duplicated),
          readCase("read-v1-exact-read", threeReadBatches()),
          changeCase(threeChangeBatches()),
        ],
      }),
    );
    expect(evaluation.cases[0]?.status).toBe("blocked");
    expect(evaluation.blockingReasons.some((item) => item.code === "contradictory_evidence")).toBe(true);
  });
});

describe("evidence references fail closed", () => {
  it("blocks every evidence-owned gate when its reference is missing", () => {
    const evaluation = evaluate(makeTrace({ evidence: [] }));
    expect(evaluation.verdict).toBe("blocked");
    for (const number of [1, 2, 3, 4, 5, 6, 7, 8, 11]) {
      expect(gate(evaluation, number).status).toBe("blocked");
    }
    expect(evaluation.blockingReasons.filter((item) => item.code === "missing_evidence").length).toBeGreaterThanOrEqual(9);
  });

  it("relays a blocked evidence gate with its blocking reason", () => {
    const evidence = [
      ...PASSED_EVIDENCE.filter((item) => item.gate !== 6),
      {
        schemaVersion: BENCHMARK_TRACE_SCHEMA_VERSION,
        gate: 6,
        outcome: "blocked",
        artifacts: [{ artifactId: "gate-6-artifact", artifactSha256: VALID_SHA256 }],
        blockingReasons: [{ code: "rollback_failure", detail: "upgrade rollback did not restore the prior bundle" }],
      },
    ];
    const evaluation = evaluate(makeTrace({ evidence }));
    expect(gate(evaluation, 6).status).toBe("blocked");
    expect(evaluation.blockingReasons.some((item) => item.code === "rollback_failure")).toBe(true);
    expect(evaluation.verdict).toBe("blocked");
  });

  it("blocks on a fixture-residual gate and on a correctness/unproven gate despite passing percentiles", () => {
    const evidence = [
      ...PASSED_EVIDENCE.filter((item) => item.gate !== 5 && item.gate !== 11),
      {
        schemaVersion: BENCHMARK_TRACE_SCHEMA_VERSION,
        gate: 5,
        outcome: "blocked",
        artifacts: [{ artifactId: "gate-5-artifact", artifactSha256: VALID_SHA256 }],
        blockingReasons: [{ code: "fixture_residual", detail: "cleanup left residual fixture paths" }],
      },
      {
        schemaVersion: BENCHMARK_TRACE_SCHEMA_VERSION,
        gate: 11,
        outcome: "blocked",
        artifacts: [{ artifactId: "gate-11-artifact", artifactSha256: VALID_SHA256 }],
        blockingReasons: [{ code: "result_unproven", detail: "a Change Set could not prove application or absence" }],
      },
    ];
    const evaluation = evaluate(makeTrace({ evidence }));
    expect(gate(evaluation, 5).status).toBe("blocked");
    expect(gate(evaluation, 11).status).toBe("blocked");
    expect(evaluation.blockingReasons.some((item) => item.code === "fixture_residual")).toBe(true);
    expect(evaluation.blockingReasons.some((item) => item.code === "result_unproven")).toBe(true);
  });

  it("rejects a stale fixture manifest binding as stale evidence", () => {
    const cases = [
      readCase("read-v1-discovery", threeReadBatches()),
      readCase("read-v1-exact-read", threeReadBatches()),
      {
        case: "change-v1",
        fixture: "change-v1",
        fixtureManifestSha256: "0".repeat(64),
        batches: threeChangeBatches(),
      },
    ];
    const evaluation = evaluate(makeTrace({ cases }));
    expect(evaluation.cases[2]?.fixtureManifestCurrent).toBe(false);
    expect(gate(evaluation, 9).status).toBe("blocked");
    expect(evaluation.blockingReasons.some((item) => item.code === "stale_evidence")).toBe(true);
  });
});

describe("runtime profile incompatibility fails closed", () => {
  it("blocks an unregistered profile name", () => {
    const evaluation = evaluate(makeTrace({ profileName: "NOT-A-REGISTERED-PROFILE" }));
    expect(evaluation.verdict).toBe("blocked");
    expect(evaluation.boundInputs.runtimeProfile.compatible).toBe(false);
    expect(evaluation.blockingReasons.some((item) => item.code === "incompatible_profile")).toBe(true);
  });

  it("blocks when the observed environment contradicts the registered profile", () => {
    const evaluation = evaluate(
      makeTrace({ observed: { ...OBSERVED_ENVIRONMENT, obsidianVersion: "9.99.0" } }),
    );
    expect(evaluation.verdict).toBe("blocked");
    expect(evaluation.blockingReasons.some((item) => item.code === "incompatible_profile")).toBe(true);
  });

  it("blocks on an unsatisfied environment precondition", () => {
    const evaluation = evaluate(
      makeTrace({ preconditions: [{ code: "ac_power", satisfied: false }] }),
    );
    expect(evaluation.verdict).toBe("blocked");
    expect(evaluation.blockingReasons.some((item) => item.code === "environment_precondition_failure")).toBe(true);
  });
});

describe("verdict composition", () => {
  it("composes an auditable passed verdict across all eleven fixed release gates", () => {
    const evaluation = evaluate(makeTrace());
    expect(evaluation.verdict).toBe("passed");
    expect(evaluation.gates).toHaveLength(11);
    expect(evaluation.gates.map((item) => item.gate)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    expect(evaluation.gates.every((item) => item.status === "passed")).toBe(true);
    expect(evaluation.blockingReasons).toEqual([]);
    for (const number of [1, 2, 3, 4, 5, 6, 7, 8, 11]) {
      expect(gate(evaluation, number).artifacts.length).toBeGreaterThan(0);
    }
    expect(evaluation.boundInputs.fixtures).toEqual([
      { fixture: "read-v1", manifestSha256: READ_FIXTURE_SHA256, current: true },
      { fixture: "change-v1", manifestSha256: CHANGE_FIXTURE_SHA256, current: true },
    ]);
  });

  it("blocks a partial trace that is missing a required performance case or evidence", () => {
    const evaluation = evaluate(
      makeTrace({
        cases: [
          readCase("read-v1-discovery", threeReadBatches()),
          readCase("read-v1-exact-read", threeReadBatches()),
        ],
        evidence: [],
      }),
    );
    expect(evaluation.cases).toHaveLength(2);
    expect(evaluation.cases.every((item) => item.status === "passed")).toBe(true);
    expect(gate(evaluation, 9).status).toBe("blocked");
    expect(gate(evaluation, 10).status).toBe("blocked");
    expect(evaluation.verdict).toBe("blocked");
    expect(evaluation.blockingReasons.some((item) => item.detail.includes("change-v1"))).toBe(true);
  });

  it("never turns malformed input into a pass through the CLI-facing parse boundary", () => {
    expect(() => parseBenchmarkTrace(null)).toThrow(BenchmarkTraceError);
    expect(() => parseBenchmarkTrace("not json")).toThrow(BenchmarkTraceError);
    expect(() => parseBenchmarkTrace({ schemaVersion: 99 })).toThrow(BenchmarkTraceError);
  });
});

describe("verdict bound inputs identify every recorded artifact", () => {
  it("records versions, compatibility, fixture hashes, and evidence gate artifacts", () => {
    const evaluation = evaluate(makeTrace());
    expect(evaluation.boundInputs.versions).toEqual({
      bridge: "0.1.0",
      plugin: "0.1.0",
      protocol: "1.0",
      mcpSdk: "1.30.0",
    });
    expect(evaluation.boundInputs.compatibility).toEqual({ observation: "compatible", version: "2.1.0" });
    expect(evaluation.boundInputs.runtimeProfile.name).toBe("MVP-PERF-REF-1");
    const gateOneArtifacts = gate(evaluation, 1).artifacts;
    expect(gateOneArtifacts).toEqual([{ artifactId: "gate-1-artifact", artifactSha256: VALID_SHA256 }]);
    // Performance gate 9 identifies the recorded fixture-backed case artifacts.
    const gateNineArtifacts = gate(evaluation, 9).artifacts;
    expect(gateNineArtifacts).toHaveLength(3);
    expect(gateNineArtifacts.some((item) => item.artifactId === "benchmark-case:change-v1")).toBe(true);
  });
});

describe("regression: p95 helper honors the fixed 29th-sample rule across value shapes", () => {
  it("handles ties at the 29th boundary", () => {
    const values = [...Array.from({ length: 28 }, () => 7), 199, 199];
    expect(nearestRankP95(values)).toBe(199);
  });

  it("produces the same p95 independent of input order", () => {
    const values = withP95At(Array.from({ length: 30 }, (_, index) => index + 1), 28, 29);
    const shuffled = [...values].reverse();
    expect(nearestRankP95(values)).toBe(nearestRankP95(shuffled));
  });
});
