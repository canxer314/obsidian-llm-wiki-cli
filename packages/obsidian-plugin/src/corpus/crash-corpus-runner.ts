/**
 * Supervised process-crash corpus runner (issue #187).
 *
 * The runner is the *supervising process*: it spawns a real owning-process
 * child (see `headless-owning-process.ts`), drives the production Bridge MCP
 * surface over loopback, parks and terminates the real process at a declared
 * crash point, restarts it, waits for startup recovery to demonstrably
 * complete, and only then attempts a sentinel write. It never lets the
 * terminated process perform its own inventory or cleanup.
 *
 * The runner is parameterized by a `MutationCorpusProfile` (mutation kind,
 * crash-point list, and final-state oracle) so the remaining #43
 * mutation/fault tracers reuse it without introducing a second runner.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { build } from "esbuild";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { BRIDGE_STATE_DIRECTORY_NAME } from "../change-set.js";
import { openRecoveryJournal } from "../recovery-journal.js";

const BRIDGE_STATE_DIRECTORY = BRIDGE_STATE_DIRECTORY_NAME;
const BRIDGE_JOURNAL_FILE = "recovery-journal.bin";

export type CrashPhase = "apply" | "rollback";

export interface MutationCorpusCrashPoint {
  readonly point: string;
  readonly phase: CrashPhase;
}

/** Expected on-disk boundary observed while the child is parked at a crash point. */
export interface MutationCorpusBoundary {
  readonly journalPhase: "PREPARED" | "COMMITTED" | "ROLLED_BACK" | "FAILED" | null;
  readonly notePresent: boolean;
}

export interface MutationCorpusProfile {
  /** Stable mutation kind identity, e.g. `create_note`. */
  readonly kind: string;
  /** Stable label used in generated names; must match `[A-Za-z0-9_-]`. */
  readonly label: string;
  /** Vault-relative path of the note the Change Set creates. */
  readonly notePath: string;
  /** Canonical Markdown content of the created note. */
  readonly content: string;
  submissionKey(seed: string): string;
  buildSubmitInput(seed: string): Record<string, unknown>;
  readonly crashPoints: readonly MutationCorpusCrashPoint[];
  /** Gen-1 crash point leaving a durable PREPARED + fully applied state for rollback-phase crashes. */
  readonly rollbackLeadInPoint: string;
  expectedBoundary(crashPoint: MutationCorpusCrashPoint): MutationCorpusBoundary;
  expectedProofState(crashPoint: MutationCorpusCrashPoint): "intent_applied" | "intent_not_applied";
  expectedNotePresence(crashPoint: MutationCorpusCrashPoint): boolean;
  readonly timeoutMs: number;
}

export interface CorpusInventoryEntry {
  readonly path: string;
  readonly kind: "file" | "directory";
  readonly bytes?: number;
  readonly sha256?: string;
}

export interface CorpusScenarioEvidence {
  readonly corpus: string;
  readonly fixture: {
    readonly seed: string;
    readonly root: string;
    readonly vaultId: string;
    readonly port: number;
    readonly notePath: string;
  };
  readonly crashPoint: string;
  readonly crashPhase: CrashPhase;
  readonly phases: readonly string[];
  readonly before: readonly CorpusInventoryEntry[];
  readonly boundary: {
    readonly journalPhase: string | null;
    readonly notePresent: boolean;
    readonly noteSha256: string | null;
    readonly observed: boolean;
  };
  readonly after: readonly CorpusInventoryEntry[];
  readonly proofState: "intent_applied" | "intent_not_applied" | "result_unproven" | null;
  readonly noteFinal: {
    readonly present: boolean;
    readonly sha256: string | null;
    readonly bytesMatchExpected: boolean | null;
  };
  readonly gate: {
    readonly effectiveGate: string | null;
    readonly writeGate: string | null;
    readonly writeState: string | null;
    readonly recoveryState: string | null;
    readonly overall: string | null;
  };
  readonly sentinel: { readonly submitted: boolean; readonly applied: boolean };
  readonly residualPaths: readonly string[];
  readonly cleanup: { readonly success: boolean; readonly message: string };
  readonly verdict: "pass" | "fail";
  readonly failures: readonly string[];
  readonly reportPath: string;
}

type Writable<T> = { -readonly [K in keyof T]: T[K] };

interface OwnedChild {
  readonly child: ChildProcess;
  readonly controlDir: string;
  readonly exit: Promise<number | null>;
  readonly stderr: string[];
}

type ControlKind = "ready" | "parked" | "failed";

interface ControlMarker {
  readonly kind: ControlKind;
  readonly value: Record<string, unknown>;
}

async function sha256(bytes: Uint8Array): Promise<string> {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

async function readOptionalJson<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    // A concurrent partial control-file write must not fail the scenario; the
    // supervisor polls again until the child finishes the atomic rename.
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
}

let cachedBundle: Promise<string> | undefined;

/**
 * Bundle the headless owning-process entrypoint into a standalone CJS file so a
 * real OS process (plain `node`, not the vitest transform) runs the production
 * stack against a dedicated scenario root.
 */
export function buildOwningProcessBundle(): Promise<string> {
  if (cachedBundle === undefined) {
    cachedBundle = (async () => {
      const directory = await mkdtemp(join(tmpdir(), "crash-corpus-bundle-"));
      const outfile = join(directory, "owning-process.cjs");
      const entry = new URL("./headless-owning-process.ts", import.meta.url).pathname;
      await build({
        entryPoints: [entry],
        outfile,
        bundle: true,
        platform: "node",
        format: "cjs",
        target: "node24",
        logLevel: "silent",
        external: ["obsidian"],
      });
      return outfile;
    })();
  }
  return cachedBundle;
}

async function pickAvailablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new Error("Could not allocate a loopback port for a corpus scenario");
  }
  const port = address.port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

function spawnOwningProcess(options: {
  bundle: string;
  root: string;
  vaultId: string;
  port: number;
  controlDir: string;
  crashPoint?: string;
}): OwnedChild {
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    CORPUS_ROOT: options.root,
    CORPUS_VAULT_ID: options.vaultId,
    CORPUS_PORT: String(options.port),
    CORPUS_CONTROL_DIR: options.controlDir,
  };
  if (options.crashPoint !== undefined) env.CORPUS_CRASH_POINT = options.crashPoint;
  const child = spawn(process.execPath, [options.bundle], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stderr: string[] = [];
  child.stderr?.on("data", (chunk: Buffer) => {
    const text = chunk.toString("utf8").trim();
    if (text.length > 0) stderr.push(text);
  });
  child.stdout?.on("data", () => undefined);
  const exit = new Promise<number | null>((resolve) => {
    child.once("exit", (code) => resolve(code));
    child.once("error", () => resolve(null));
  });
  return { child, controlDir: options.controlDir, exit, stderr };
}

async function waitForControlMarker(
  owned: OwnedChild,
  kinds: readonly ControlKind[],
  timeoutMs: number,
): Promise<ControlMarker | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const kind of kinds) {
      const value = await readOptionalJson<Record<string, unknown>>(
        join(owned.controlDir, `${kind}.json`),
      );
      if (value !== undefined) return { kind, value };
    }
    if (owned.child.exitCode !== null) {
      return { kind: "failed", value: { childExit: owned.child.exitCode } };
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
  return null;
}

async function terminateChild(owned: OwnedChild): Promise<void> {
  if (owned.child.exitCode === null) owned.child.kill("SIGKILL");
  await owned.exit;
}

async function listTree(root: string, base: string): Promise<string[]> {
  const result: string[] = [];
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return result;
    throw error;
  }
  for (const entry of entries) {
    const absolute = join(root, entry.name);
    if (entry.name === BRIDGE_STATE_DIRECTORY) continue;
    result.push(join(entry.name));
    if (entry.isDirectory()) {
      result.push(...(await listTree(absolute, base)).map((rel) => join(entry.name, rel)));
    }
  }
  return result;
}

async function inventoryCorpus(root: string): Promise<CorpusInventoryEntry[]> {
  const relativePaths = await listTree(root, root);
  const entries: CorpusInventoryEntry[] = [];
  for (const rel of relativePaths) {
    const absolute = join(root, rel);
    try {
      const value = await stat(absolute);
      const path = rel.split(/[\\/]/u).join("/");
      if (value.isDirectory()) {
        entries.push({ path, kind: "directory" });
      } else if (value.isFile()) {
        const bytes = await readFile(absolute);
        entries.push({
          path,
          kind: "file",
          bytes: bytes.byteLength,
          sha256: await sha256(bytes),
        });
      }
    } catch {
      // Tree was listed moments ago; skip transiently-unavailable entries.
    }
  }
  return entries.sort((left, right) => left.path.localeCompare(right.path));
}

async function listPrivateAreaFiles(root: string, area: "staging" | "trash"): Promise<string[]> {
  const directory = join(root, BRIDGE_STATE_DIRECTORY, area);
  const rels = await listTree(directory, directory);
  const files: string[] = [];
  for (const rel of rels) {
    try {
      const value = await stat(join(directory, rel));
      if (value.isFile()) files.push(rel.split(/[\\/]/u).join("/"));
    } catch {
      // Transiently unavailable; skip.
    }
  }
  return files.sort();
}

async function readJournalPhase(root: string): Promise<string | null> {
  const journalPath = join(root, BRIDGE_STATE_DIRECTORY, BRIDGE_JOURNAL_FILE);
  let handle;
  try {
    const { open } = await import("node:fs/promises");
    handle = await open(journalPath, "r");
    const journal = await openRecoveryJournal(handle);
    const record = await journal.recover();
    await handle.close();
    return record?.phase ?? null;
  } catch {
    await handle?.close().catch(() => undefined);
    return null;
  }
}

async function readNoteBytes(root: string, path: string): Promise<Uint8Array | null> {
  try {
    return new Uint8Array(await readFile(join(root, ...path.split("/"))));
  } catch {
    return null;
  }
}

async function connectClient(endpoint: URL, vaultId: string): Promise<Client> {
  const client = new Client({ name: "crash-corpus-supervisor", version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(endpoint, {
      requestInit: { headers: { "X-Expected-Vault-ID": vaultId } },
    }),
  );
  return client;
}

interface ToolInvocation {
  readonly isError?: boolean;
  readonly structuredContent?: unknown;
}

async function callTool(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolInvocation> {
  const result = (await client.callTool({
    name,
    arguments: args as never,
  })) as unknown as { isError?: boolean; structuredContent?: unknown };
  return { isError: result.isError, structuredContent: result.structuredContent };
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

async function healthSnapshot(
  client: Client,
): Promise<CorpusScenarioEvidence["gate"]> {
  const result = await callTool(client, "vault_health", {});
  const health = asRecord(result.structuredContent);
  const recovery = asRecord(health.recovery);
  const write = asRecord(health.write);
  const effective = health.effectiveGate === null ? null : asRecord(health.effectiveGate);
  return {
    effectiveGate: effective === null ? null : typeof effective.code === "string" ? effective.code : null,
    writeGate: typeof write.gate === "string" ? write.gate : null,
    writeState: typeof write.state === "string" ? write.state : null,
    recoveryState: typeof recovery.state === "string" ? recovery.state : null,
    overall: typeof health.overall === "string" ? health.overall : null,
  };
}

async function statusProofState(
  client: Client,
  submissionKey: string,
): Promise<CorpusScenarioEvidence["proofState"]> {
  const result = await callTool(client, "vault_change_set_status", { submissionKey });
  if (result.isError === true) return null;
  const status = asRecord(result.structuredContent);
  if (status.lookup !== "found") return null;
  const changeSet = asRecord(status.changeSet);
  const state = changeSet.state;
  return state === "intent_applied" ||
    state === "intent_not_applied" ||
    state === "result_unproven"
    ? state
    : null;
}

async function submitChangeSet(
  client: Client,
  input: Record<string, unknown>,
): Promise<{ submitted: boolean; applied: boolean }> {
  let result: ToolInvocation;
  try {
    result = await callTool(client, "vault_change_set_submit", input);
  } catch {
    return { submitted: true, applied: false };
  }
  const content = asRecord(result.structuredContent);
  const changeSet = asRecord(content.changeSet);
  return {
    submitted: !result.isError,
    applied: changeSet.state === "intent_applied",
  };
}

function ancestorDirectories(path: string): string[] {
  const parts = path.split("/");
  const directories: string[] = [];
  for (let index = 1; index < parts.length; index += 1) {
    directories.push(parts.slice(0, index).join("/"));
  }
  return directories;
}

function residualPaths(
  after: readonly CorpusInventoryEntry[],
  notePresent: boolean,
  notePath: string,
): string[] {
  const expected = new Set<string>();
  if (notePresent) {
    expected.add(notePath);
    for (const directory of ancestorDirectories(notePath)) expected.add(directory);
  }
  return after
    .filter((entry) => !expected.has(entry.path))
    .map((entry) => `${entry.kind === "directory" ? "dir:" : "file:"}${entry.path}`);
}

export interface RunScenarioOptions {
  readonly profile: MutationCorpusProfile;
  readonly crashPoint: MutationCorpusCrashPoint;
  readonly seed: string;
  readonly reportDir: string;
}

export async function runMutationCorpusScenario(
  options: RunScenarioOptions,
): Promise<CorpusScenarioEvidence> {
  const { profile, crashPoint, seed } = options;
  const phases: string[] = [];
  const failures: string[] = [];
  const logPhase = (message: string): void => {
    phases.push(message);
  };

  await mkdir(options.reportDir, { recursive: true });
  const reportPath = join(options.reportDir, `${seed}.json`);
  const vaultId = `corpus-${seed}`;
  const root = await mkdtemp(join(tmpdir(), `corpus-${profile.label}-`));
  const port = await pickAvailablePort();
  const controlBase = await mkdtemp(join(tmpdir(), "corpus-control-"));
  const expectedBoundary = profile.expectedBoundary(crashPoint);
  const expectedProof = profile.expectedProofState(crashPoint);
  const expectedPresent = profile.expectedNotePresence(crashPoint);

  const evidence: Writable<CorpusScenarioEvidence> = {
    corpus: profile.kind,
    fixture: { seed, root, vaultId, port, notePath: profile.notePath },
    crashPoint: crashPoint.point,
    crashPhase: crashPoint.phase,
    phases,
    before: [],
    boundary: { journalPhase: null, notePresent: false, noteSha256: null, observed: false },
    after: [],
    proofState: null,
    noteFinal: { present: false, sha256: null, bytesMatchExpected: null },
    gate: {
      effectiveGate: null,
      writeGate: null,
      writeState: null,
      recoveryState: null,
      overall: null,
    },
    sentinel: { submitted: false, applied: false },
    residualPaths: [],
    cleanup: { success: false, message: "not attempted" },
    verdict: "fail",
    failures,
    reportPath,
  };

  let bundle: string;
  try {
    bundle = await buildOwningProcessBundle();
  } catch (error) {
    failures.push(`could not bundle owning process: ${String(error)}`);
    await writeEvidence();
    return evidence as CorpusScenarioEvidence;
  }

  evidence.before = await inventoryCorpus(root);
  logPhase(`before inventory recorded (${evidence.before.length} public entries)`);

  const submitted = profile.buildSubmitInput(seed);
  const submissionKey = profile.submissionKey(seed);

  try {
    // ---- Generation 1: submit and park at the apply-phase crash point ------
    const leadIn =
      crashPoint.phase === "rollback" ? profile.rollbackLeadInPoint : crashPoint.point;
    logPhase(`generation 1: armed crash point ${leadIn}`);
    const gen1Control = join(controlBase, "gen1");
    const gen1 = spawnOwningProcess({
      bundle,
      root,
      vaultId,
      port,
      controlDir: gen1Control,
      crashPoint: leadIn,
    });
    const bootMarker = await waitForControlMarker(gen1, ["ready", "parked", "failed"], profile.timeoutMs);
    if (bootMarker === null || bootMarker.kind === "failed") {
      failures.push(
        `generation 1 did not boot: ${JSON.stringify(bootMarker)}; stderr: ${gen1.stderr.join("\n")}`,
      );
      await terminateChild(gen1);
      throw new Error("generation 1 failed to boot");
    }
    if (bootMarker.kind === "parked") {
      // A boot-time park is only expected for rollback lead-ins on later
      // generations; a generation-1 apply crash point parks after submit.
      if (crashPoint.phase !== "rollback") {
        failures.push("generation 1 parked before the Change Set was submitted");
      }
    }
    if (bootMarker.kind === "ready") {
      logPhase("generation 1 ready; submitting Change Set");
    }

    const submitClient = await connectClient(new URL(`http://127.0.0.1:${port}/mcp`), vaultId);
    const submitPromise = submitChangeSet(submitClient, submitted);
    const parkRace = await Promise.race([
      waitForControlMarker(gen1, ["parked", "failed"], profile.timeoutMs).then((marker) => ({
        kind: "parked-or-failed" as const,
        marker,
      })),
      submitPromise.then(() => ({ kind: "submit-settled" as const, marker: null })),
    ]);
    if (parkRace.kind !== "parked-or-failed" || parkRace.marker === null) {
      failures.push(`declared crash point ${leadIn} was never reached during submission`);
      await terminateChild(gen1);
      await submitClient.close().catch(() => undefined);
      throw new Error("declared crash point was never reached");
    }
    if (parkRace.marker.kind === "failed") {
      failures.push(`child failed during submission: ${JSON.stringify(parkRace.marker.value)}`);
      await terminateChild(gen1);
      await submitClient.close().catch(() => undefined);
      throw new Error("child failed during submission");
    }
    const gen1Boundary = await observeBoundary(root, profile.notePath);
    logPhase(`generation 1 parked at ${leadIn}; boundary ${describeBoundary(gen1Boundary)}`);
    // The gen-1 boundary is only the crash-point boundary for apply-phase
    // crashes. For rollback-phase crashes gen-1 is a lead-in that leaves a
    // durable PREPARED + applied state; its boundary is compared against the
    // lead-in crash point, and the crash-point boundary is observed on gen-2.
    if (crashPoint.phase === "rollback") {
      const leadInPoint = profile.crashPoints.find(
        (candidate) =>
          candidate.phase === "apply" && candidate.point === profile.rollbackLeadInPoint,
      );
      const leadInBoundary =
        leadInPoint === undefined
          ? expectedBoundary
          : profile.expectedBoundary(leadInPoint);
      if (gen1Boundary.journalPhase !== leadInBoundary.journalPhase ||
          gen1Boundary.notePresent !== leadInBoundary.notePresent) {
        failures.push(
          `lead-in boundary mismatch for ${crashPoint.point}: expected ${JSON.stringify(leadInBoundary)}, observed ${describeBoundary(gen1Boundary)}`,
        );
      }
    } else {
      evidence.boundary = gen1Boundary;
      if (gen1Boundary.journalPhase !== expectedBoundary.journalPhase ||
          gen1Boundary.notePresent !== expectedBoundary.notePresent) {
        failures.push(
          `on-disk boundary mismatch at ${crashPoint.point}: expected ${JSON.stringify(expectedBoundary)}, observed ${describeBoundary(gen1Boundary)}`,
        );
      }
    }
    await terminateChild(gen1);
    await submitClient.close().catch(() => undefined);
    logPhase("generation 1 terminated by supervisor");

    // ---- Generation 2 (rollback-phase crashes): park inside recovery -------
    let recoveryGeneration = 2;
    if (crashPoint.phase === "rollback") {
      logPhase(`generation 2: armed rollback crash point ${crashPoint.point}`);
      const gen2Control = join(controlBase, "gen2");
      const gen2 = spawnOwningProcess({
        bundle,
        root,
        vaultId,
        port,
        controlDir: gen2Control,
        crashPoint: crashPoint.point,
      });
      const gen2Marker = await waitForControlMarker(
        gen2,
        ["ready", "parked", "failed"],
        profile.timeoutMs,
      );
      if (gen2Marker === null) {
        failures.push(`rollback crash point ${crashPoint.point} was never reached in generation 2`);
        await terminateChild(gen2);
        throw new Error("rollback crash point was never reached");
      }
      if (gen2Marker.kind === "ready") {
        failures.push(`rollback crash point ${crashPoint.point} was never reached; recovery completed`);
        await terminateChild(gen2);
        throw new Error("rollback crash point was never reached");
      }
      if (gen2Marker.kind === "failed") {
        failures.push(`generation 2 failed during recovery: ${JSON.stringify(gen2Marker.value)}`);
        await terminateChild(gen2);
        throw new Error("generation 2 failed during recovery");
      }
      evidence.boundary = await observeBoundary(root, profile.notePath);
      logPhase(
        `generation 2 parked at rollback point ${crashPoint.point}; boundary ${describeBoundary(evidence.boundary)}`,
      );
      if (evidence.boundary.journalPhase !== expectedBoundary.journalPhase ||
          evidence.boundary.notePresent !== expectedBoundary.notePresent) {
        failures.push(
          `on-disk rollback boundary mismatch at ${crashPoint.point}: expected ${JSON.stringify(expectedBoundary)}, observed ${describeBoundary(evidence.boundary)}`,
        );
      }
      await terminateChild(gen2);
      logPhase("generation 2 terminated by supervisor");
      recoveryGeneration = 3;
    }

    // ---- Final generation: startup recovery must complete before sentinel ---
    logPhase(`generation ${recoveryGeneration}: startup recovery`);
    const finalControl = join(controlBase, `gen${recoveryGeneration}`);
    const finalChild = spawnOwningProcess({
      bundle,
      root,
      vaultId,
      port,
      controlDir: finalControl,
    });
    const finalMarker = await waitForControlMarker(
      finalChild,
      ["ready", "parked", "failed"],
      profile.timeoutMs,
    );
    if (finalMarker === null || finalMarker.kind !== "ready") {
      failures.push(
        `generation ${recoveryGeneration} did not become ready after recovery: ${JSON.stringify(finalMarker)}; stderr: ${finalChild.stderr.join("\n")}`,
      );
      await terminateChild(finalChild);
      throw new Error("startup recovery did not complete");
    }
    logPhase(`generation ${recoveryGeneration} ready after startup recovery`);

    const client = await connectClient(new URL(`http://127.0.0.1:${port}/mcp`), vaultId);
    evidence.gate = await healthSnapshot(client);
    evidence.proofState = await statusProofState(client, submissionKey);
    logPhase(
      `proof state ${String(evidence.proofState)}; effective gate ${String(evidence.gate.effectiveGate)}; recovery ${String(evidence.gate.recoveryState)}`,
    );
    if (evidence.proofState !== expectedProof) {
      failures.push(
        `expected proof state ${expectedProof} after recovery but observed ${String(evidence.proofState)}`,
      );
    }
    if (evidence.gate.recoveryState !== "none" && evidence.gate.recoveryState !== null) {
      failures.push(`unexpected recovery state ${String(evidence.gate.recoveryState)} after recovery`);
    }

    // Sentinel Change Set must be admissible only after recovery is demonstrably
    // complete (effective gate no longer blocks writes).
    logPhase("submitting sentinel Change Set");
    const sentinelNote = `CorpusSentinel-${seed.replace(/[^A-Za-z0-9_-]/gu, "_")}.md`;
    evidence.sentinel = await submitChangeSet(client, {
      submissionKey: profile.submissionKey(`${seed}-sentinel`),
      operations: [
        {
          operationId: `sentinel-${seed}`,
          kind: "create_note",
          path: sentinelNote,
          content: `# Sentinel ${seed}\n`,
          ifExists: "reject",
        },
      ],
    });
    if (!evidence.sentinel.submitted) {
      failures.push("sentinel Change Set was not admissible after startup recovery");
    } else if (!evidence.sentinel.applied) {
      failures.push("sentinel Change Set did not reach intent_applied");
    }
    await client.close().catch(() => undefined);

    // ---- Final disk evidence, supervisor-only cleanup -----------------------
    logPhase(`terminating generation ${recoveryGeneration}`);
    await terminateChild(finalChild);
    await rm(join(root, sentinelNote), { force: true });
    evidence.after = await inventoryCorpus(root);

    const noteBytes = await readNoteBytes(root, profile.notePath);
    const expectedBytes = new TextEncoder().encode(profile.content);
    evidence.noteFinal = {
      present: noteBytes !== null,
      sha256: noteBytes === null ? null : await sha256(noteBytes),
      bytesMatchExpected:
        noteBytes === null
          ? expectedPresent
            ? false
            : true
          : Buffer.from(noteBytes).equals(Buffer.from(expectedBytes)),
    };
    if (evidence.noteFinal.present !== expectedPresent) {
      failures.push(
        `expected note ${expectedPresent ? "present" : "absent"} after recovery but observed ${evidence.noteFinal.present ? "present" : "absent"}`,
      );
    }
    if (evidence.noteFinal.present && evidence.noteFinal.bytesMatchExpected !== true) {
      failures.push("note bytes do not match the expected final content");
    }

    // Residual paths are leftover content that recovery failed to clean — the
    // node-fs Change Set host may leave empty scaffolding directories under its
    // private staging root after a successful publish, so only *files* under
    // the private staging/trash areas count as residual content.
    const privateResiduals = [
      ...(await listPrivateAreaFiles(root, "staging")).map((path) => `staging:${path}`),
      ...(await listPrivateAreaFiles(root, "trash")).map((path) => `trash:${path}`),
    ];
    evidence.residualPaths = [
      ...residualPaths(evidence.after, expectedPresent, profile.notePath),
      ...privateResiduals,
    ].sort();
    if (evidence.residualPaths.length > 0) {
      failures.push(`residual paths remain: ${evidence.residualPaths.join(", ")}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!failures.includes(message)) failures.push(message);
  } finally {
    try {
      await rm(root, { recursive: true, force: true });
      evidence.cleanup = { success: true, message: "scenario root removed by supervisor" };
    } catch (error) {
      evidence.cleanup = { success: false, message: String(error) };
    }
    await rm(controlBase, { recursive: true, force: true }).catch(() => undefined);
    if (!evidence.cleanup.success) failures.push(`cleanup failed: ${evidence.cleanup.message}`);
    evidence.verdict = failures.length === 0 ? "pass" : "fail";
    await writeEvidence();
  }
  return evidence as CorpusScenarioEvidence;

  async function writeEvidence(): Promise<void> {
    await mkdir(dirname(reportPath), { recursive: true });
    await writeFile(reportPath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  }
}

async function observeBoundary(
  root: string,
  notePath: string,
): Promise<CorpusScenarioEvidence["boundary"]> {
  const journalPhase = await readJournalPhase(root);
  const noteBytes = await readNoteBytes(root, notePath);
  return {
    journalPhase,
    notePresent: noteBytes !== null,
    noteSha256: noteBytes === null ? null : await sha256(noteBytes),
    observed: true,
  };
}

function describeBoundary(boundary: CorpusScenarioEvidence["boundary"]): string {
  return JSON.stringify({
    journalPhase: boundary.journalPhase,
    notePresent: boundary.notePresent,
    noteSha256: boundary.noteSha256,
  });
}
