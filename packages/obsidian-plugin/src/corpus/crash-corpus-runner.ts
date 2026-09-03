/**
 * Supervised process-crash corpus runner (issues #187 / #188).
 *
 * The runner is the *supervising process*: it spawns a real owning-process
 * child (see `headless-owning-process.ts`), drives the production Bridge MCP
 * surface over loopback, parks and terminates the real process at a declared
 * crash point, restarts it, waits for startup recovery to demonstrably
 * complete, and only then attempts a sentinel write. It never lets the
 * terminated process perform its own inventory or cleanup.
 *
 * The runner is parameterized by a `MutationCorpusProfile` that declares the
 * public files of a Change Set as byte-exact fixtures (original bytes present
 * before generation 1 and committed bytes after a successful run), the
 * crash-point list, and per-crash-point on-disk boundary + proof oracles. The
 * final-state oracle is derived from the expected proof state: an
 * `intent_applied` run must leave every file at its committed bytes, an
 * `intent_not_applied` run must restore every file to its original bytes
 * (whole-Change-Set restoration), and a `result_unproven` run must leave the
 * sentinel write blocked with any residue surfaced as a residual path.
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

export type MutationCorpusProofState =
  | "intent_applied"
  | "intent_not_applied"
  | "result_unproven";

/** One public file of a Change Set, declared as byte-exact fixtures. */
export interface MutationCorpusFileFixture {
  /** Vault-relative canonical path. */
  readonly path: string;
  /** Files are Markdown unless an attachment profile explicitly identifies binary bytes. */
  readonly kind?: "markdown" | "attachment";
  /** Exact bytes on disk before generation 1, or null when the Change Set creates the file. */
  readonly originalBytes: Uint8Array | null;
  /** Exact bytes a committed Change Set leaves on disk, or null when the Change Set removes the file. */
  readonly committedBytes: Uint8Array | null;
}

export type MutationCorpusBoundaryFileState = "original" | "committed" | "absent";

/** Expected terminal on-disk state of a public file after recovery. */
export type MutationCorpusTerminalFileState =
  | MutationCorpusBoundaryFileState
  | "unproven";

export interface MutationCorpusBoundaryFile {
  readonly path: string;
  readonly state: MutationCorpusBoundaryFileState;
}

/** Expected on-disk state observed while the child is parked at a crash point. */
export interface MutationCorpusBoundary {
  readonly journalPhase: "PREPARED" | "COMMITTED" | "ROLLED_BACK" | "FAILED" | null;
  readonly files: readonly MutationCorpusBoundaryFile[];
}

export interface MutationCorpusProfile {
  /** Stable mutation-kind identity, e.g. `create_note`, `edit_body`, `edit_frontmatter`. */
  readonly kind: string;
  /** Stable label used in generated names; must match `[A-Za-z0-9_-]`. */
  readonly label: string;
  /** Public files the Change Set touches, in operation order, as byte fixtures. */
  readonly files: readonly MutationCorpusFileFixture[];
  /** Primary path used as the report fixture identity; must be one of `files[].path`. */
  readonly primaryPath: string;
  submissionKey(seed: string): string;
  buildSubmitInput(seed: string): Record<string, unknown>;
  readonly crashPoints: readonly MutationCorpusCrashPoint[];
  /** Gen-1 crash point leaving a durable PREPARED + fully applied state for rollback-phase crashes. */
  readonly rollbackLeadInPoint: string;
  /** On-disk boundary while parked at a crash point (before the supervisor terminates the child). */
  expectedBoundary(crashPoint: MutationCorpusCrashPoint): MutationCorpusBoundary;
  expectedProofState(crashPoint: MutationCorpusCrashPoint): MutationCorpusProofState;
  readonly timeoutMs: number;
}

export interface CorpusInventoryEntry {
  readonly path: string;
  readonly kind: "file" | "directory";
  readonly bytes?: number;
  readonly sha256?: string;
}

export interface CorpusBoundaryFileObservation {
  readonly path: string;
  readonly kind: "markdown" | "attachment";
  readonly present: boolean;
  readonly sha256: string | null;
  readonly contentVersion: string | null;
}

export interface CorpusBoundaryObservation {
  readonly journalPhase: string | null;
  readonly files: readonly CorpusBoundaryFileObservation[];
  readonly observed: boolean;
}

export interface CorpusFileFinal {
  readonly path: string;
  readonly kind: "markdown" | "attachment";
  readonly present: boolean;
  readonly sha256: string | null;
  readonly contentVersion: string | null;
  readonly bytesMatchOriginal: boolean | null;
  readonly bytesMatchCommitted: boolean | null;
  /** Best-effort classification used by the machine verdict. */
  readonly state: "original" | "committed" | "absent" | "other" | "unproven" | null;
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
  readonly boundary: CorpusBoundaryObservation;
  readonly after: readonly CorpusInventoryEntry[];
  readonly proofState: MutationCorpusProofState | null;
  readonly fileFinal: readonly CorpusFileFinal[];
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

async function listTree(root: string): Promise<string[]> {
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
    result.push(entry.name);
    if (entry.isDirectory()) {
      result.push(...(await listTree(absolute)).map((rel) => join(entry.name, rel)));
    }
  }
  return result;
}

async function inventoryCorpus(root: string): Promise<CorpusInventoryEntry[]> {
  const relativePaths = await listTree(root);
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
          sha256: await sha256(new Uint8Array(bytes)),
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
  const rels = await listTree(directory);
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

async function readPathBytes(root: string, path: string): Promise<Uint8Array | null> {
  try {
    return new Uint8Array(await readFile(join(root, ...path.split("/"))));
  } catch {
    return null;
  }
}

function bytesEqual(left: Uint8Array | null, right: Uint8Array | null): boolean {
  if (left === null || right === null) return left === right;
  return Buffer.from(left).equals(Buffer.from(right));
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

function expectedPaths(
  profile: MutationCorpusProfile,
  terminalStates: ReadonlyMap<string, MutationCorpusTerminalFileState>,
): Set<string> {
  const expected = new Set<string>();
  for (const file of profile.files) {
    // Directories that pre-existed as seed scaffolding remain after every
    // terminal state.
    if (file.originalBytes !== null) {
      for (const directory of ancestorDirectories(file.path)) expected.add(directory);
    }
    const terminal = terminalStates.get(file.path);
    if (terminal === "original" || terminal === "committed") {
      expected.add(file.path);
      for (const directory of ancestorDirectories(file.path)) expected.add(directory);
    }
  }
  return expected;
}

/** Expected terminal file state label for each fixture, derived from the proof state. */
export function terminalStateForFile(
  proofState: MutationCorpusProofState | null,
  fixture: MutationCorpusFileFixture,
): MutationCorpusTerminalFileState {
  if (proofState === "intent_applied") {
    return fixture.committedBytes === null ? "absent" : "committed";
  }
  if (proofState === "intent_not_applied") {
    return fixture.originalBytes === null ? "absent" : "original";
  }
  return "unproven";
}

/** Seed the pre-existing public files of a profile before generation 1. */
export async function seedCorpusRoot(
  root: string,
  profile: MutationCorpusProfile,
): Promise<void> {
  for (const file of profile.files) {
    if (file.originalBytes === null) continue;
    const absolute = join(root, ...file.path.split("/"));
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, file.originalBytes);
  }
}

async function observeBoundary(
  root: string,
  profile: MutationCorpusProfile,
): Promise<CorpusBoundaryObservation> {
  const journalPhase = await readJournalPhase(root);
  const files: CorpusBoundaryFileObservation[] = [];
  for (const file of profile.files) {
    const bytes = await readPathBytes(root, file.path);
    const kind = file.kind ?? "markdown";
    files.push({
      path: file.path,
      kind,
      present: bytes !== null,
      sha256: bytes === null ? null : await sha256(bytes),
      contentVersion: kind === "markdown" && bytes !== null ? await sha256(bytes) : null,
    });
  }
  return { journalPhase, files, observed: true };
}

function describeBoundary(boundary: CorpusBoundaryObservation): string {
  return JSON.stringify({
    journalPhase: boundary.journalPhase,
    files: boundary.files.map(({ path, present, sha256 }) => ({ path, present, sha256 })),
  });
}

async function boundaryFailures(
  root: string,
  observed: CorpusBoundaryObservation,
  expected: MutationCorpusBoundary,
  profile: MutationCorpusProfile,
): Promise<string[]> {
  const failures: string[] = [];
  if (observed.journalPhase !== expected.journalPhase) {
    failures.push(
      `on-disk journal phase mismatch: expected ${String(expected.journalPhase)}, observed ${String(observed.journalPhase)}`,
    );
  }
  const observedByPath = new Map(observed.files.map((file) => [file.path, file]));
  const fixtureByPath = new Map(profile.files.map((file) => [file.path, file]));
  for (const expectedFile of expected.files) {
    const observedFile = observedByPath.get(expectedFile.path);
    const fixture = fixtureByPath.get(expectedFile.path);
    const present = observedFile?.present ?? false;
    if (expectedFile.state === "absent") {
      if (present) {
        failures.push(`boundary file ${expectedFile.path} should be absent but is present`);
      }
      continue;
    }
    if (!present) {
      failures.push(`boundary file ${expectedFile.path} should be present but is absent`);
      continue;
    }
    const expectedBytes =
      expectedFile.state === "original"
        ? fixture?.originalBytes ?? null
        : fixture?.committedBytes ?? null;
    const bytes = await readPathBytes(root, expectedFile.path);
    if (expectedBytes !== null && bytes !== null && !bytesEqual(bytes, expectedBytes)) {
      failures.push(
        `boundary file ${expectedFile.path} bytes do not match the expected ${expectedFile.state} state at the crash point`,
      );
    }
  }
  return failures;
}

async function observeFinalFiles(
  root: string,
  profile: MutationCorpusProfile,
): Promise<CorpusFileFinal[]> {
  const finals: CorpusFileFinal[] = [];
  for (const file of profile.files) {
    const bytes = await readPathBytes(root, file.path);
    const bytesMatchOriginal =
      bytes === null || file.originalBytes === null
        ? bytes === null && file.originalBytes === null
        : bytesEqual(bytes, file.originalBytes);
    const bytesMatchCommitted =
      bytes === null || file.committedBytes === null
        ? bytes === null && file.committedBytes === null
        : bytesEqual(bytes, file.committedBytes);
    let state: CorpusFileFinal["state"] = null;
    if (bytes === null) state = "absent";
    else if (bytesMatchOriginal === true && bytesMatchCommitted === true) state = "original";
    else if (bytesMatchOriginal === true) state = "original";
    else if (bytesMatchCommitted === true) state = "committed";
    else state = "other";
    finals.push({
      path: file.path,
      kind: file.kind ?? "markdown",
      present: bytes !== null,
      sha256: bytes === null ? null : await sha256(bytes),
      contentVersion:
        file.kind !== "attachment" && bytes !== null ? await sha256(bytes) : null,
      bytesMatchOriginal,
      bytesMatchCommitted,
      state,
    });
  }
  return finals;
}

function finalFileFailures(
  observed: readonly CorpusFileFinal[],
  expectedProof: MutationCorpusProofState,
  profile: MutationCorpusProfile,
): string[] {
  const failures: string[] = [];
  const expectedByPath = new Map(
    profile.files.map((fixture) => [
      fixture.path,
      terminalStateForFile(expectedProof, fixture),
    ]),
  );
  for (const final of observed) {
    const expected = expectedByPath.get(final.path);
    if (expected === "unproven") continue; // residue is judged separately
    if (expected === undefined) {
      failures.push(`no terminal oracle for public file ${final.path}`);
      continue;
    }
    const observedState: CorpusFileFinal["state"] = final.present
      ? final.state
      : "absent";
    if (expected === "absent") {
      if (observedState !== "absent") {
        failures.push(`public file ${final.path} should be absent after recovery`);
      }
      continue;
    }
    if (observedState === "absent") {
      failures.push(`public file ${final.path} should be present (${expected}) after recovery`);
      continue;
    }
    if (expected === "original" && final.bytesMatchOriginal !== true) {
      failures.push(`public file ${final.path} does not hold its exact original bytes after recovery`);
    }
    if (expected === "committed" && final.bytesMatchCommitted !== true) {
      failures.push(`public file ${final.path} does not hold its exact intended (committed) bytes after recovery`);
    }
  }
  return failures;
}

function residualPaths(
  after: readonly CorpusInventoryEntry[],
  expectedPresent: Set<string>,
): string[] {
  return after
    .filter((entry) => !expectedPresent.has(entry.path))
    .map((entry) => `${entry.kind === "directory" ? "dir:" : "file:"}${entry.path}`);
}

export interface RunScenarioOptions {
  readonly profile: MutationCorpusProfile;
  readonly crashPoint: MutationCorpusCrashPoint;
  readonly seed: string;
  readonly reportDir: string;
}

function createEvidence(
  options: {
    readonly profile: MutationCorpusProfile;
    readonly crashPoint: MutationCorpusCrashPoint;
    readonly seed: string;
    readonly root: string;
    readonly vaultId: string;
    readonly port: number;
    readonly reportPath: string;
  },
  failures: string[],
): Writable<CorpusScenarioEvidence> {
  const { profile } = options;
  return {
    corpus: profile.kind,
    fixture: {
      seed: options.seed,
      root: options.root,
      vaultId: options.vaultId,
      port: options.port,
      notePath: profile.primaryPath,
    },
    crashPoint: options.crashPoint.point,
    crashPhase: options.crashPoint.phase,
    phases: [],
    before: [],
    boundary: { journalPhase: null, files: [], observed: false },
    after: [],
    proofState: null,
    fileFinal: [],
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
    reportPath: options.reportPath,
  };
}

export async function runMutationCorpusScenario(
  options: RunScenarioOptions,
): Promise<CorpusScenarioEvidence> {
  const { profile, crashPoint, seed } = options;
  const failures: string[] = [];
  const phases: string[] = [];
  const logPhase = (message: string): void => {
    phases.push(message);
  };

  await mkdir(options.reportDir, { recursive: true });
  const reportPath = join(options.reportDir, `${seed}.json`);
  const vaultId = `corpus-${seed}`;
  const root = await mkdtemp(join(tmpdir(), `corpus-${profile.label}-`));
  const port = await pickAvailablePort();
  const controlBase = await mkdtemp(join(tmpdir(), "corpus-control-"));
  const evidence = createEvidence(
    {
      profile,
      crashPoint,
      seed,
      root,
      vaultId,
      port,
      reportPath,
    },
    failures,
  );
  const log = (message: string): void => {
    logPhase(message);
  };

  const expectedBoundary = profile.expectedBoundary(crashPoint);
  const expectedProof = profile.expectedProofState(crashPoint);

  const writeEvidence = async (): Promise<void> => {
    await mkdir(dirname(reportPath), { recursive: true });
    await writeFile(reportPath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  };

  let bundle: string;
  try {
    bundle = await buildOwningProcessBundle();
  } catch (error) {
    failures.push(`could not bundle owning process: ${String(error)}`);
    await writeEvidence();
    return evidence as CorpusScenarioEvidence;
  }

  try {
    await seedCorpusRoot(root, profile);
    evidence.before = await inventoryCorpus(root);
    log(`before inventory recorded (${evidence.before.length} public entries)`);

    const submitted = profile.buildSubmitInput(seed);
    const submissionKey = profile.submissionKey(seed);

    // ---- Generation 1: submit and park at the apply-phase crash point ------
    const leadIn =
      crashPoint.phase === "rollback" ? profile.rollbackLeadInPoint : crashPoint.point;
    log(`generation 1: armed crash point ${leadIn}`);
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
    if (bootMarker.kind === "parked" && crashPoint.phase !== "rollback") {
      failures.push("generation 1 parked before the Change Set was submitted");
    }
    if (bootMarker.kind === "ready") {
      log("generation 1 ready; submitting Change Set");
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
    const gen1Boundary = await observeBoundary(root, profile);
    log(`generation 1 parked at ${leadIn}; boundary ${describeBoundary(gen1Boundary)}`);
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
        leadInPoint === undefined ? expectedBoundary : profile.expectedBoundary(leadInPoint);
      const leadInFailures = await boundaryFailures(root, gen1Boundary, leadInBoundary, profile);
      if (leadInFailures.length > 0) {
        failures.push(`lead-in boundary mismatch for ${crashPoint.point}: ${leadInFailures.join("; ")}`);
      }
    } else {
      evidence.boundary = gen1Boundary;
      const observedFailures = await boundaryFailures(root, gen1Boundary, expectedBoundary, profile);
      if (observedFailures.length > 0) {
        failures.push(`on-disk boundary mismatch at ${crashPoint.point}: ${observedFailures.join("; ")}`);
      }
    }
    await terminateChild(gen1);
    await submitClient.close().catch(() => undefined);
    log("generation 1 terminated by supervisor");

    // ---- Generation 2 (rollback-phase crashes): park inside recovery -------
    let recoveryGeneration = 2;
    if (crashPoint.phase === "rollback") {
      log(`generation 2: armed rollback crash point ${crashPoint.point}`);
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
      evidence.boundary = await observeBoundary(root, profile);
      log(
        `generation 2 parked at rollback point ${crashPoint.point}; boundary ${describeBoundary(evidence.boundary)}`,
      );
      const rollbackFailures = await boundaryFailures(root, evidence.boundary, expectedBoundary, profile);
      if (rollbackFailures.length > 0) {
        failures.push(`on-disk rollback boundary mismatch at ${crashPoint.point}: ${rollbackFailures.join("; ")}`);
      }
      await terminateChild(gen2);
      log("generation 2 terminated by supervisor");
      recoveryGeneration = 3;
    }

    // ---- Final generation: startup recovery must complete before sentinel ---
    log(`generation ${recoveryGeneration}: startup recovery`);
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
    log(`generation ${recoveryGeneration} ready after startup recovery`);

    const client = await connectClient(new URL(`http://127.0.0.1:${port}/mcp`), vaultId);
    evidence.gate = await healthSnapshot(client);
    evidence.proofState = await statusProofState(client, submissionKey);
    log(
      `proof state ${String(evidence.proofState)}; effective gate ${String(evidence.gate.effectiveGate)}; recovery ${String(evidence.gate.recoveryState)}`,
    );
    if (evidence.proofState !== expectedProof) {
      failures.push(
        `expected proof state ${expectedProof} after recovery but observed ${String(evidence.proofState)}`,
      );
    }
    const sentinelExpected = expectedProof !== "result_unproven";
    if (sentinelExpected && evidence.gate.recoveryState !== "none" && evidence.gate.recoveryState !== null) {
      failures.push(`unexpected recovery state ${String(evidence.gate.recoveryState)} after recovery`);
    }

    // Sentinel Change Set must be admissible only after recovery is demonstrably
    // complete (effective gate no longer blocks writes).
    log("submitting sentinel Change Set");
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
    if (sentinelExpected) {
      if (!evidence.sentinel.submitted) {
        failures.push("sentinel Change Set was not admissible after startup recovery");
      } else if (!evidence.sentinel.applied) {
        failures.push("sentinel Change Set did not reach intent_applied");
      }
    } else if (evidence.sentinel.applied) {
      failures.push("sentinel Change Set was admissible despite an unproven residue");
    }
    await client.close().catch(() => undefined);

    // ---- Final disk evidence, supervisor-only cleanup -----------------------
    log(`terminating generation ${recoveryGeneration}`);
    await terminateChild(finalChild);
    await rm(join(root, sentinelNote), { force: true });
    evidence.after = await inventoryCorpus(root);
    evidence.fileFinal = await observeFinalFiles(root, profile);

    const finalFailures = finalFileFailures(evidence.fileFinal, expectedProof, profile);
    if (finalFailures.length > 0) {
      failures.push(...finalFailures);
    }

    // Residual paths are leftover content that recovery failed to clean: files
    // under the public Vault that are not expected in the terminal state, plus
    // leftover files under the private staging/trash areas.
    const expectedTerminal = new Map<string, MutationCorpusTerminalFileState>(
      profile.files.map((file) => [
        file.path,
        terminalStateForFile(expectedProof, file),
      ]),
    );
    const expectedPresent = expectedPaths(profile, expectedTerminal);
    const privateResiduals = [
      ...(await listPrivateAreaFiles(root, "staging")).map((path) => `staging:${path}`),
      ...(await listPrivateAreaFiles(root, "trash")).map((path) => `trash:${path}`),
    ];
    evidence.residualPaths = [
      ...residualPaths(evidence.after, expectedPresent),
      ...privateResiduals,
    ].sort();
    if (expectedProof !== "result_unproven" && evidence.residualPaths.length > 0) {
      failures.push(`residual paths remain: ${evidence.residualPaths.join(", ")}`);
    }
    if (expectedProof === "result_unproven" && evidence.residualPaths.length === 0) {
      failures.push("expected an unproven residue to be surfaced but no residual path was reported");
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
}

export interface RunCollisionScenarioOptions {
  readonly profile: MutationCorpusProfile;
  readonly seed: string;
  readonly reportDir: string;
  /** Public destination path (must be a profile fixture that starts absent). */
  readonly collisionPath: string;
  /** Pre-existing third-party bytes that the rejected Change Set must not overwrite. */
  readonly collisionBytes: Uint8Array;
}

/**
 * Destination-collision scenario: the supervisor seeds a pre-existing public
 * file at a would-be attachment destination before the owning process starts.
 * The real MCP submission must reject before any mutation, retain those exact
 * foreign bytes, and leave the write gate open for a subsequent sentinel.
 */
export async function runMutationCorpusCollisionScenario(
  options: RunCollisionScenarioOptions,
): Promise<CorpusScenarioEvidence> {
  const { profile, seed } = options;
  const failures: string[] = [];
  const crashPoint: MutationCorpusCrashPoint = { point: "destination_collision", phase: "apply" };
  await mkdir(options.reportDir, { recursive: true });
  const reportPath = join(options.reportDir, `${seed}.json`);
  const vaultId = `corpus-${seed}`;
  const root = await mkdtemp(join(tmpdir(), `corpus-${profile.label}-`));
  const port = await pickAvailablePort();
  const controlBase = await mkdtemp(join(tmpdir(), "corpus-control-"));
  const evidence = createEvidence(
    { profile, crashPoint, seed, root, vaultId, port, reportPath },
    failures,
  );
  const writeEvidence = async (): Promise<void> => {
    await mkdir(dirname(reportPath), { recursive: true });
    await writeFile(reportPath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  };

  try {
    const fixture = profile.files.find(({ path }) => path === options.collisionPath);
    if (fixture === undefined || fixture.originalBytes !== null) {
      throw new Error(`collision path ${options.collisionPath} must be an initially absent profile file`);
    }
    if (fixture.committedBytes !== null && bytesEqual(options.collisionBytes, fixture.committedBytes)) {
      throw new Error("collision bytes must differ from the intended attachment bytes");
    }
    await seedCorpusRoot(root, profile);
    const collisionAbsolute = join(root, ...options.collisionPath.split("/"));
    await mkdir(dirname(collisionAbsolute), { recursive: true });
    await writeFile(collisionAbsolute, options.collisionBytes);
    evidence.before = await inventoryCorpus(root);

    const bundle = await buildOwningProcessBundle();
    const child = spawnOwningProcess({
      bundle,
      root,
      vaultId,
      port,
      controlDir: join(controlBase, "gen1"),
    });
    const marker = await waitForControlMarker(child, ["ready", "parked", "failed"], profile.timeoutMs);
    if (marker === null || marker.kind !== "ready") {
      failures.push(
        `collision scenario did not boot: ${JSON.stringify(marker)}; stderr: ${child.stderr.join("\n")}`,
      );
      await terminateChild(child);
      throw new Error("collision scenario did not boot");
    }

    const client = await connectClient(new URL(`http://127.0.0.1:${port}/mcp`), vaultId);
    const submitted = await submitChangeSet(client, profile.buildSubmitInput(seed));
    if (submitted.applied) failures.push("collision Change Set reported intent_applied");
    evidence.gate = await healthSnapshot(client);
    evidence.proofState = await statusProofState(client, profile.submissionKey(seed));
    if (evidence.proofState !== "intent_not_applied") {
      failures.push(
        `expected intent_not_applied for destination collision but observed ${String(evidence.proofState)}`,
      );
    }
    if (evidence.gate.effectiveGate !== null) {
      failures.push("destination collision unexpectedly blocked the write gate");
    }

    const sentinelNote = `CorpusSentinel-${seed.replace(/[^A-Za-z0-9_-]/gu, "_")}.md`;
    evidence.sentinel = await submitChangeSet(client, {
      submissionKey: profile.submissionKey(`${seed}-sentinel`),
      operations: [{
        operationId: `sentinel-${seed}`,
        kind: "create_note",
        path: sentinelNote,
        content: `# Sentinel ${seed}\n`,
        ifExists: "reject",
      }],
    });
    if (!evidence.sentinel.applied) {
      failures.push("sentinel Change Set was not admissible after a rejected destination collision");
    }
    await client.close().catch(() => undefined);
    await terminateChild(child);
    await rm(join(root, sentinelNote), { force: true });
    evidence.after = await inventoryCorpus(root);
    evidence.fileFinal = await observeFinalFiles(root, profile);
    const collision = evidence.fileFinal.find(({ path }) => path === options.collisionPath);
    if (collision?.sha256 !== (await sha256(options.collisionBytes))) {
      failures.push(`destination collision bytes were overwritten at ${options.collisionPath}`);
    }
    if (collision?.bytesMatchOriginal !== false || collision?.bytesMatchCommitted !== false) {
      failures.push(`destination collision was not reported as foreign state at ${options.collisionPath}`);
    }
    const expectedTerminal = new Map<string, MutationCorpusTerminalFileState>(
      profile.files.map((file) => [file.path, terminalStateForFile("intent_not_applied", file)]),
    );
    evidence.residualPaths = residualPaths(evidence.after, expectedPaths(profile, expectedTerminal));
    if (!evidence.residualPaths.includes(`file:${options.collisionPath}`)) {
      failures.push(`destination collision was not surfaced at ${options.collisionPath}`);
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
}
export interface RunResidueScenarioOptions {
  readonly profile: MutationCorpusProfile;
  readonly seed: string;
  readonly reportDir: string;
  /** Public path (must be one of `profile.files[].path`) overwritten after gen-1 parks. */
  readonly residuePath: string;
  /** Third-party bytes that match neither original nor committed state. */
  readonly residueBytes: Uint8Array;
}

/**
 * Third-party-residue scenario: a durable PREPARED frame is left by a rollback
 * lead-in, then the supervisor overwrites a public file with foreign bytes so
 * startup recovery cannot prove any restoration. Recovery fails closed as
 * `result_unproven`, the sentinel write is blocked by the write gate, and the
 * foreign file is surfaced as a residual path.
 */
export async function runMutationCorpusResidueScenario(
  options: RunResidueScenarioOptions,
): Promise<CorpusScenarioEvidence> {
  const { profile, seed } = options;
  const failures: string[] = [];
  const phases: string[] = [];
  const logPhase = (message: string): void => {
    phases.push(message);
  };
  const crashPoint: MutationCorpusCrashPoint = {
    point: profile.rollbackLeadInPoint,
    phase: "rollback",
  };

  await mkdir(options.reportDir, { recursive: true });
  const reportPath = join(options.reportDir, `${seed}.json`);
  const vaultId = `corpus-${seed}`;
  const root = await mkdtemp(join(tmpdir(), `corpus-${profile.label}-`));
  const port = await pickAvailablePort();
  const controlBase = await mkdtemp(join(tmpdir(), "corpus-control-"));
  const evidence = createEvidence(
    {
      profile,
      crashPoint,
      seed,
      root,
      vaultId,
      port,
      reportPath,
    },
    failures,
  );
  const log = (message: string): void => {
    logPhase(message);
  };
  const writeEvidence = async (): Promise<void> => {
    await mkdir(dirname(reportPath), { recursive: true });
    await writeFile(reportPath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  };

  let bundle: string;
  try {
    bundle = await buildOwningProcessBundle();
  } catch (error) {
    failures.push(`could not bundle owning process: ${String(error)}`);
    await writeEvidence();
    return evidence as CorpusScenarioEvidence;
  }

  try {
    await seedCorpusRoot(root, profile);
    evidence.before = await inventoryCorpus(root);
    log(`before inventory recorded (${evidence.before.length} public entries)`);

    const leadInPoint = profile.crashPoints.find(
      (candidate) =>
        candidate.phase === "apply" && candidate.point === profile.rollbackLeadInPoint,
    );
    if (leadInPoint === undefined) {
      throw new Error(`profile ${profile.label} has no apply crash point ${profile.rollbackLeadInPoint}`);
    }
    const leadInBoundary = profile.expectedBoundary(leadInPoint);

    // Generation 1 parks at the rollback lead-in, leaving a durable PREPARED
    // frame with the file fully applied.
    log(`generation 1: armed crash point ${profile.rollbackLeadInPoint}`);
    const gen1Control = join(controlBase, "gen1");
    const gen1 = spawnOwningProcess({
      bundle,
      root,
      vaultId,
      port,
      controlDir: gen1Control,
      crashPoint: profile.rollbackLeadInPoint,
    });
    const bootMarker = await waitForControlMarker(gen1, ["ready", "parked", "failed"], profile.timeoutMs);
    if (bootMarker === null || bootMarker.kind === "failed") {
      failures.push(
        `generation 1 did not boot: ${JSON.stringify(bootMarker)}; stderr: ${gen1.stderr.join("\n")}`,
      );
      await terminateChild(gen1);
      throw new Error("generation 1 failed to boot");
    }
    const gen1Client = await connectClient(new URL(`http://127.0.0.1:${port}/mcp`), vaultId);
    const submitPromise = submitChangeSet(gen1Client, profile.buildSubmitInput(seed));
    const parkRace = await Promise.race([
      waitForControlMarker(gen1, ["parked", "failed"], profile.timeoutMs).then((marker) => ({
        kind: "parked-or-failed" as const,
        marker,
      })),
      submitPromise.then(() => ({ kind: "submit-settled" as const, marker: null })),
    ]);
    if (parkRace.kind !== "parked-or-failed" || parkRace.marker === null) {
      failures.push(`rollback lead-in ${profile.rollbackLeadInPoint} was never reached during submission`);
      await terminateChild(gen1);
      await gen1Client.close().catch(() => undefined);
      throw new Error("rollback lead-in was never reached");
    }
    if (parkRace.marker.kind === "failed") {
      failures.push(`child failed during submission: ${JSON.stringify(parkRace.marker.value)}`);
      await terminateChild(gen1);
      await gen1Client.close().catch(() => undefined);
      throw new Error("child failed during submission");
    }
    await gen1Client.close().catch(() => undefined);
    const gen1Boundary = await observeBoundary(root, profile);
    log(`generation 1 parked; boundary ${describeBoundary(gen1Boundary)}`);
    const leadInFailures = await boundaryFailures(root, gen1Boundary, leadInBoundary, profile);
    if (leadInFailures.length > 0) {
      failures.push(`lead-in boundary mismatch: ${leadInFailures.join("; ")}`);
    }
    await terminateChild(gen1);
    log("generation 1 terminated by supervisor");

    // The supervisor overwrites a public file with third-party bytes, so the
    // durable PREPARED frame can no longer be proven restored.
    const fixture = profile.files.find(({ path }) => path === options.residuePath);
    if (fixture === undefined) {
      throw new Error(`residue path ${options.residuePath} is not a profile file`);
    }
    if (
      bytesEqual(options.residueBytes, fixture.originalBytes) ||
      (fixture.committedBytes !== null && bytesEqual(options.residueBytes, fixture.committedBytes))
    ) {
      throw new Error("residue bytes must differ from both original and committed bytes");
    }
    const residueAbsolute = join(root, ...options.residuePath.split("/"));
    await mkdir(dirname(residueAbsolute), { recursive: true });
    await writeFile(residueAbsolute, options.residueBytes);
    log(`supervisor wrote third-party bytes over ${options.residuePath}`);

    // Generation 2: recovery must fail closed (result_unproven) and block the
    // sentinel write rather than report success.
    log("generation 2: startup recovery over unproven residue");
    const finalChild = spawnOwningProcess({ bundle, root, vaultId, port, controlDir: join(controlBase, "gen2") });
    const finalMarker = await waitForControlMarker(
      finalChild,
      ["ready", "parked", "failed"],
      profile.timeoutMs,
    );
    if (finalMarker === null || finalMarker.kind !== "ready") {
      failures.push(
        `generation 2 did not become ready after unproven recovery: ${JSON.stringify(finalMarker)}; stderr: ${finalChild.stderr.join("\n")}`,
      );
      await terminateChild(finalChild);
      throw new Error("unproven recovery did not complete");
    }
    log("generation 2 ready after unproven recovery");

    const client = await connectClient(new URL(`http://127.0.0.1:${port}/mcp`), vaultId);
    evidence.gate = await healthSnapshot(client);
    evidence.proofState = await statusProofState(client, profile.submissionKey(seed));
    log(
      `proof state ${String(evidence.proofState)}; effective gate ${String(evidence.gate.effectiveGate)}; recovery ${String(evidence.gate.recoveryState)}`,
    );
    if (evidence.proofState !== "result_unproven") {
      failures.push(
        `expected result_unproven after third-party residue but observed ${String(evidence.proofState)}`,
      );
    }
    if (evidence.gate.effectiveGate === null && evidence.gate.recoveryState !== "blocked") {
      failures.push("expected writes to be blocked after an unproven residue");
    }

    log("submitting sentinel Change Set against the blocked gate");
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
    if (evidence.sentinel.applied) {
      failures.push("sentinel Change Set was admissible despite an unproven residue");
    }
    await client.close().catch(() => undefined);

    log("terminating generation 2");
    await terminateChild(finalChild);
    await rm(join(root, sentinelNote), { force: true });
    evidence.after = await inventoryCorpus(root);
    evidence.fileFinal = await observeFinalFiles(root, profile);

    const expectedTerminal = new Map<string, MutationCorpusTerminalFileState>(
      profile.files.map((file) => [file.path, terminalStateForFile("result_unproven", file)]),
    );
    const expectedPresent = expectedPaths(profile, expectedTerminal);
    const privateResiduals = [
      ...(await listPrivateAreaFiles(root, "staging")).map((path) => `staging:${path}`),
      ...(await listPrivateAreaFiles(root, "trash")).map((path) => `trash:${path}`),
    ];
    evidence.residualPaths = [
      ...residualPaths(evidence.after, expectedPresent),
      ...privateResiduals,
    ].sort();
    const residueReported = evidence.residualPaths.some(
      (entry) => entry === `file:${options.residuePath}`,
    );
    if (!residueReported) {
      failures.push(`third-party residue at ${options.residuePath} was not surfaced as a residual path`);
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
}

