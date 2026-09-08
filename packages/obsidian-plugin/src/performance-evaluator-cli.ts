/**
 * Benchmark-trace evaluator CLI (issue #171):
 *
 *   node dist/performance-evaluator.mjs <trace.json> [--verdict <out.json>]
 *
 * Parses and evaluates one versioned benchmark trace into a canonical
 * pass-or-block verdict. Exits zero only when every one of the eleven fixed
 * release gates passes; any fail-closed rejection (an invalid trace, a blocked
 * gate, a correctness failure, or an unmet performance gate) exits non-zero.
 * With `--verdict`, the canonical verdict is written to the given path.
 */

import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";

import {
  BenchmarkTraceError,
  evaluateBenchmarkTrace,
  parseBenchmarkTrace,
  RELEASE_GATE_COUNT,
  type BenchmarkTraceEvaluation,
} from "./performance-evaluator.js";

function usage(): string {
  return "Usage: performance-evaluate <trace.json> [--verdict <output.json>]";
}

function verdictToJson(evaluation: BenchmarkTraceEvaluation): string {
  return `${JSON.stringify(evaluation, null, 2)}\n`;
}

async function writeVerdict(path: string, evaluation: BenchmarkTraceEvaluation): Promise<void> {
  await writeFile(path, verdictToJson(evaluation), { encoding: "utf8" });
}

async function main(): Promise<number> {
  const { positionals, values } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    options: {
      verdict: { type: "string" },
    },
    strict: true,
  });
  const tracePath = positionals[0];
  if (tracePath === undefined || positionals.length !== 1) {
    process.stderr.write(`${usage()}\n`);
    return 2;
  }
  const verdictPath = values.verdict === undefined ? undefined : resolve(values.verdict);

  let raw: string;
  try {
    raw = await readFile(resolve(tracePath), "utf8");
  } catch (error) {
    process.stderr.write(`Benchmark trace could not be read: ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }

  let evaluation: BenchmarkTraceEvaluation;
  try {
    const trace = parseBenchmarkTrace(JSON.parse(raw));
    evaluation = evaluateBenchmarkTrace(trace);
  } catch (error) {
    if (error instanceof BenchmarkTraceError || error instanceof SyntaxError) {
      process.stderr.write(
        `Benchmark trace is invalid: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      return 2;
    }
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }

  if (verdictPath !== undefined) {
    try {
      await writeVerdict(verdictPath, evaluation);
    } catch (error) {
      process.stderr.write(
        `Benchmark trace verdict could not be written: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      return 2;
    }
  }

  const passedGates = evaluation.gates.filter((gate) => gate.status === "passed").length;
  process.stdout.write(
    `Benchmark trace ${evaluation.traceId} evaluated: ${evaluation.verdict}\ngates: ${passedGates}/${RELEASE_GATE_COUNT} passed\n`,
  );
  for (const blockingReason of evaluation.blockingReasons) {
    process.stdout.write(`blocked: ${blockingReason.code}: ${blockingReason.detail}\n`);
  }
  return evaluation.verdict === "passed" ? 0 : 1;
}

void main().then((code) => {
  process.exitCode = code;
});
