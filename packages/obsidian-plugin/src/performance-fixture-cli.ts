import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import {
  FixtureLifecycleError,
  cleanupFixedPerformanceFixture,
  fixedPerformanceFixtureManifest,
  prepareFixedPerformanceFixture,
  restoreFixedPerformanceFixture,
  verifyFixedPerformanceFixture,
  writeFixedPerformanceFixtureEvidence,
  type FixedPerformanceFixtureEvidence,
  type FixedPerformanceFixtureName,
} from "./performance-fixture.js";

interface Arguments {
  readonly operation: "prepare" | "verify" | "restore" | "cleanup";
  readonly fixture: FixedPerformanceFixtureName;
  readonly workingDirectory: string;
  readonly evidencePath: string;
}

function usage(): string {
  return "Usage: performance-fixture <prepare|verify|restore|cleanup> <read-v1|change-v1> --workdir <dir> --evidence <path>";
}

function parseArguments(argv: readonly string[]): Arguments {
  const [operation, fixture, ...rest] = argv;
  if (
    (operation !== "prepare" && operation !== "verify" && operation !== "restore" && operation !== "cleanup") ||
    (fixture !== "read-v1" && fixture !== "change-v1")
  ) {
    throw new Error(usage());
  }
  let workingDirectory: string | undefined;
  let evidencePath: string | undefined;
  for (let index = 0; index < rest.length; index += 1) {
    const flag = rest[index];
    const value = rest[index + 1];
    if ((flag !== "--workdir" && flag !== "--evidence") || value === undefined) {
      throw new Error(usage());
    }
    if (flag === "--workdir") workingDirectory = resolve(value);
    if (flag === "--evidence") evidencePath = resolve(value);
    index += 1;
  }
  if (workingDirectory === undefined || evidencePath === undefined) throw new Error(usage());
  return { operation, fixture, workingDirectory, evidencePath };
}

async function writeFailureEvidence(
  path: string,
  error: unknown,
): Promise<FixedPerformanceFixtureEvidence | undefined> {
  if (!(error instanceof FixtureLifecycleError)) return undefined;
  await mkdir(dirname(path), { recursive: true });
  await writeFixedPerformanceFixtureEvidence(path, error.evidence);
  return error.evidence;
}

async function main(): Promise<number> {
  let arguments_: Arguments;
  try {
    arguments_ = parseArguments(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }

  const options = { workingDirectory: arguments_.workingDirectory, fixture: arguments_.fixture };
  try {
    const result = arguments_.operation === "prepare"
      ? await prepareFixedPerformanceFixture(options)
      : arguments_.operation === "verify"
        ? await verifyFixedPerformanceFixture(options)
        : arguments_.operation === "restore"
          ? await restoreFixedPerformanceFixture(options)
          : await cleanupFixedPerformanceFixture(options);
    await writeFixedPerformanceFixtureEvidence(arguments_.evidencePath, result.evidence);
    process.stdout.write(
      `Fixed performance fixture ${arguments_.fixture} ${arguments_.operation}: ${result.evidence.verdict}\nmanifest: ${fixedPerformanceFixtureManifest(arguments_.fixture).manifestSha256}\nevidence: ${arguments_.evidencePath}\n`,
    );
    return 0;
  } catch (error) {
    try {
      const evidence = await writeFailureEvidence(arguments_.evidencePath, error);
      process.stderr.write(
        `Fixed performance fixture ${arguments_.fixture} ${arguments_.operation}: failed${evidence === undefined ? "" : ` (${evidence.failure?.code ?? "unknown"})`}\nevidence: ${arguments_.evidencePath}\n`,
      );
    } catch (evidenceError) {
      process.stderr.write(
        `Fixed performance fixture evidence could not be written: ${evidenceError instanceof Error ? evidenceError.message : String(evidenceError)}\n`,
      );
    }
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

void main().then((code) => {
  process.exitCode = code;
});
