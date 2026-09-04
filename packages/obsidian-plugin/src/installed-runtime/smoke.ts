/**
 * Registered real-runtime smoke run (issue #197): wires the installed-runtime
 * harness to real seams — host probe, real Obsidian process control, and the
 * real loopback MCP client — against a specifically registered runtime
 * profile. The run always records evidence; the process exits zero only when
 * the evidence verdict is "passed". A preflight mismatch, candidate failure,
 * process failure, identity mismatch, invalid health result, cleanup failure,
 * or residual content exits non-zero with failed/invalid evidence on disk.
 *
 * Usage (from packages/obsidian-plugin):
 *   npm run smoke:installed-runtime -- \
 *     --registration <registration.json> --workdir <dir> [--candidate <dir>] \
 *     [--profile MVP-PERF-REF-1] [--evidence <path>]
 *
 * The registration JSON is created once per registered machine and pins the
 * observed installation facts the probe verifies against the registry:
 *   {
 *     "obsidianExecutable": "C:/.../Obsidian.exe",
 *     "obsidianVersion": "1.13.4",
 *     "electronVersion": "39.6.0",
 *     "nodeVersion": "24.14.0"
 *   }
 */

import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { platform } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  CANDIDATE_CHECKSUM_MANIFEST,
} from "./candidate-bundle.js";
import { runInstalledRuntimeHarness } from "./harness.js";
import { createWindowsObsidianProcessControl } from "./obsidian-process.js";
import {
  hostOsBuild,
  MVP_PERF_REF_1,
  type ObservedRuntimeEnvironment,
} from "./runtime-profile.js";

interface SmokeArguments {
  candidate?: string;
  registration?: string;
  workdir?: string;
  evidence?: string;
  profile: string;
}

function parseArguments(argv: readonly string[]): SmokeArguments {
  const parsed: SmokeArguments = { profile: MVP_PERF_REF_1.name };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    switch (flag) {
      case "--candidate":
        parsed.candidate = value;
        break;
      case "--registration":
        parsed.registration = value;
        break;
      case "--workdir":
        parsed.workdir = value;
        break;
      case "--evidence":
        parsed.evidence = value;
        break;
      case "--profile":
        parsed.profile = value ?? MVP_PERF_REF_1.name;
        break;
      default:
        throw new Error(`Unknown argument: ${flag ?? ""}`);
    }
    if (flag !== undefined && flag.startsWith("--")) index += 1;
  }
  return parsed;
}

interface SmokeRegistration {
  obsidianExecutable: string;
  obsidianVersion: string;
  electronVersion: string;
  nodeVersion: string;
}

async function readRegistration(path: string): Promise<SmokeRegistration> {
  const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Registration file is not a JSON object");
  }
  const record = parsed as Record<string, unknown>;
  for (const field of [
    "obsidianExecutable",
    "obsidianVersion",
    "electronVersion",
    "nodeVersion",
  ] as const) {
    if (typeof record[field] !== "string" || (record[field] as string).length === 0) {
      throw new Error(`Registration file lacks a valid ${field}`);
    }
  }
  return record as unknown as SmokeRegistration;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

async function provesLoopbackHttp(): Promise<boolean> {
  return new Promise((resolvePromise) => {
    const server = createServer();
    server.once("error", () => resolvePromise(false));
    server.listen(0, "127.0.0.1", () => {
      server.close(() => resolvePromise(true));
    });
  });
}

async function probeHost(registration: SmokeRegistration): Promise<ObservedRuntimeEnvironment> {
  const executablePresent = await fileExists(registration.obsidianExecutable);
  const capabilities: string[] = [];
  if (await provesLoopbackHttp()) capabilities.push("loopback_http");
  if (platform() === "win32") {
    capabilities.push("ntfs_fixtures", "process_control");
  }
  if (executablePresent) capabilities.push("obsidian_gui");
  return {
    platform: platform(),
    ...(hostOsBuild() === undefined ? {} : { osBuild: hostOsBuild() }),
    obsidianVersion: executablePresent ? registration.obsidianVersion : undefined,
    electronVersion: executablePresent ? registration.electronVersion : undefined,
    nodeVersion: executablePresent ? registration.nodeVersion : undefined,
    capabilities,
  };
}

/**
 * Assembles the locally built plugin (`manifest.json` + `dist/main.js`) as
 * the candidate bundle. Missing build output is deliberately left missing so
 * the harness records candidate-stage invalid evidence instead of silently
 * skipping.
 */
async function assembleLocalCandidate(destination: string): Promise<void> {
  const packageRoot = fileURLToPath(new URL("..", import.meta.url));
  const manifest = join(packageRoot, "manifest.json");
  const mainJs = join(packageRoot, "dist", "main.js");
  if (!(await fileExists(manifest)) || !(await fileExists(mainJs))) {
    return;
  }
  await mkdir(destination, { recursive: true });
  const lines: string[] = [];
  for (const file of ["manifest.json", "main.js"] as const) {
    const source = file === "manifest.json" ? manifest : mainJs;
    const target = join(destination, file);
    await copyFile(source, target);
    const digest = createHash("sha256")
      .update(new Uint8Array(await readFile(target)))
      .digest("hex");
    lines.push(`${digest}  ${file}`);
  }
  lines.sort();
  await writeFile(join(destination, CANDIDATE_CHECKSUM_MANIFEST), `${lines.join("\n")}\n`, "utf8");
}

async function main(): Promise<number> {
  const args = parseArguments(process.argv.slice(2));
  if (args.registration === undefined || args.workdir === undefined) {
    process.stderr.write(
      "Usage: run-installed-runtime-smoke --registration <file> --workdir <dir> [--candidate <dir>] [--profile <name>] [--evidence <path>]\n",
    );
    return 2;
  }
  const workdir = resolve(args.workdir);
  const registration = await readRegistration(resolve(args.registration));
  const candidate = resolve(args.candidate ?? join(workdir, "candidate-bundle"));
  if (args.candidate === undefined) {
    await assembleLocalCandidate(candidate);
  }
  const evidencePath = resolve(
    args.evidence ?? join(workdir, "evidence", `installed-runtime-smoke-${randomRunId()}.json`),
  );
  const result = await runInstalledRuntimeHarness({
    profileName: args.profile,
    candidateBundleDirectory: candidate,
    workingDirectory: workdir,
    evidencePath,
    probe: { probe: () => probeHost(registration) },
    processControl: createWindowsObsidianProcessControl({
      executablePath: registration.obsidianExecutable,
    }),
  });
  process.stdout.write(
    `installed-runtime smoke verdict: ${result.verdict}\nevidence: ${result.evidencePath}\n`,
  );
  if (result.failure !== null) {
    process.stdout.write(
      `failure: ${result.failure.stage}/${result.failure.code}${result.failure.detail === undefined ? "" : ` — ${result.failure.detail}`}\n`,
    );
  }
  return result.verdict === "passed" ? 0 : 1;
}

function randomRunId(): string {
  return createHash("sha256")
    .update(`${process.pid}:${Date.now()}:${Math.random()}`)
    .digest("hex")
    .slice(0, 16);
}

void main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(
      `installed-runtime smoke aborted: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  },
);
