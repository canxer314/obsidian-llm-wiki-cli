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
import {
  corruptJournalFile,
  observeJournalFile,
  rewriteJournalFrameVaultId,
  type JournalCorruption,
  type JournalObservation,
  type JournalWriteFault,
} from "./journal-faults.js";

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

/** Redacted Bridge-private hidden-state snapshot (no trash/staging paths or identifiers). */
export interface CorpusHiddenAreaSnapshot {
  /** Number of files currently under the private managed-trash area. */
  readonly trashCount: number;
  /** SHA-256 digests (`sha256:<hex>`) of the private managed-trash files. */
  readonly trashSha256s: readonly string[];
  /** Number of files currently under the private staging area. */
  readonly stagingCount: number;
  /** SHA-256 digests (`sha256:<hex>`) of the private staging files. */
  readonly stagingSha256s: readonly string[];
}

/** Expected Bridge-private hidden-state at a boundary or terminal proof state. */
export interface MutationCorpusHiddenStateExpectation {
  readonly trashCount: number;
  readonly trashSha256s: readonly string[];
  readonly stagingCount: number;
  readonly stagingSha256s: readonly string[];
}

/** Expected on-disk state observed while the child is parked at a crash point. */
export interface MutationCorpusBoundary {
  readonly journalPhase: "PREPARED" | "COMMITTED" | "ROLLED_BACK" | "FAILED" | null;
  readonly files: readonly MutationCorpusBoundaryFile[];
  /** Expected redacted private hidden-state at the crash point (Managed-Trash profiles). */
  readonly hidden?: MutationCorpusHiddenStateExpectation;
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
  /**
   * Expected redacted Bridge-private hidden-state after a fully recovered
   * terminal proof state. Declared by Managed-Trash profiles so committed runs
   * may retain exactly the Bridge-owned trash entries they wrote, and rolled
   * back runs must eliminate every trash/staging residue.
   */
  expectedHiddenState?(proofState: MutationCorpusProofState): MutationCorpusHiddenStateExpectation;
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
  readonly hidden?: CorpusHiddenAreaSnapshot;
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
  readonly hidden: CorpusHiddenAreaSnapshot | null;
  readonly cleanup: { readonly success: boolean; readonly message: string };
  readonly verdict: "pass" | "fail";
  readonly failures: readonly string[];
  readonly reportPath: string;
  /** Issue #192 fault evidence; present only on the dedicated fault scenarios. */
  readonly fault?: CorpusFaultEvidence;
  /** Issue #194 recovery-interference evidence; present only on the dedicated scenarios. */
  readonly interference?: CorpusRecoveryInterferenceEvidence;
}

/** Fault-corpus evidence added by the issue #192 scenario runners. */
export interface CorpusFaultEvidence {
  /** Fault family: `journal_state`, `journal_write`, `host_operation`, `capacity`. */
  readonly kind: string;
  /** Stable scenario identity, e.g. `corrupt_newest_frame_checksum`. */
  readonly identity: string;
  /** Redacted fault declaration (no payload/before-image content). */
  readonly declaration: Record<string, unknown>;
  /** Strict-ordering observation: exactly one firing at the declared operation. */
  readonly fired: { readonly fired: boolean; readonly at: Record<string, unknown> | null };
  /** Durable frame/sequence/checksum observations without payload content. */
  readonly journal: {
    readonly before: JournalObservation | null;
    readonly after: JournalObservation | null;
  };
  /** Public state preserved across the fault when recovery must not mutate. */
  readonly publicStatePreserved?: boolean;
}

/**
 * Third-party conflict record (issue #194, spec A-22): observed and expected
 * SHA-256 identities only — never any byte content. `path` is always the public
 * Vault-relative footprint; a private managed-trash conflict names its owning
 * public footprint and never leaks a private path or identifier (spec A-37).
 */
export interface CorpusConflictRecord {
  readonly area: "public" | "private_trash";
  readonly path: string;
  readonly observedSha256: string | null;
  readonly beforeSha256: string | null;
  readonly expectedAfterSha256: string | null;
  readonly matchesBefore: boolean;
  readonly matchesExpectedAfter: boolean;
}

/** One post-interference generation: proof, gate, and sentinel-write ordering. */
export interface CorpusRecoveryGenerationEvidence {
  readonly generation: number;
  readonly proofState: MutationCorpusProofState | null;
  readonly effectiveGate: string | null;
  readonly recoveryState: string | null;
  readonly writeGate: string | null;
  readonly sentinel: {
    readonly attempted: boolean;
    readonly admitted: boolean;
    readonly gate: string | null;
  };
}

/**
 * Recovery-interference evidence added by the issue #194 scenario runner: the
 * recovery park point, the mutation/recovery interleaving (supervisor actions +
 * the monotonic child event logs), the hash-only conflict record, the write
 * admission probe attempted while recovery was parked, and the proof/gate/
 * sentinel transitions of every post-interference generation (including the
 * restart that must keep the blocked gate).
 */
export interface CorpusRecoveryInterferenceEvidence {
  readonly recoveryParkPoint: string;
  readonly interleaving: readonly string[];
  readonly conflict: CorpusConflictRecord | null;
  readonly admissionDuringRecovery: {
    readonly attempted: boolean;
    readonly reachable: boolean;
    readonly admitted: boolean;
    readonly gate: string | null;
  };
  readonly generations: readonly CorpusRecoveryGenerationEvidence[];
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
  fault?: string;
  journalSlotCapacity?: number;
}): OwnedChild {
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    CORPUS_ROOT: options.root,
    CORPUS_VAULT_ID: options.vaultId,
    CORPUS_PORT: String(options.port),
    CORPUS_CONTROL_DIR: options.controlDir,
  };
  if (options.crashPoint !== undefined) env.CORPUS_CRASH_POINT = options.crashPoint;
  if (options.fault !== undefined) env.CORPUS_FAULT = options.fault;
  if (options.journalSlotCapacity !== undefined) {
    env.CORPUS_JOURNAL_SLOT_CAPACITY = String(options.journalSlotCapacity);
  }
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

/** Read a private-area file's digest without exposing its path/identifier. */
async function readPrivateFileDigest(
  root: string,
  area: "staging" | "trash",
  relativePath: string,
): Promise<string> {
  const directory = join(root, BRIDGE_STATE_DIRECTORY, area);
  const bytes = await readFile(join(directory, ...relativePath.split("/")));
  return sha256(new Uint8Array(bytes));
}

/**
 * Redacted snapshot of the Bridge-private staging/trash areas: counts and
 * digests only, never the private paths or trash identifiers. This is the only
 * way Managed-Trash hidden state is reported (spec A-37 / issue #191).
 */
async function observeHiddenSnapshot(root: string): Promise<CorpusHiddenAreaSnapshot> {
  const trashFiles = await listPrivateAreaFiles(root, "trash");
  const stagingFiles = await listPrivateAreaFiles(root, "staging");
  const trashSha256s = await Promise.all(
    trashFiles.map((relativePath) => readPrivateFileDigest(root, "trash", relativePath)),
  );
  const stagingSha256s = await Promise.all(
    stagingFiles.map((relativePath) => readPrivateFileDigest(root, "staging", relativePath)),
  );
  return {
    trashCount: trashFiles.length,
    trashSha256s: trashSha256s.sort(),
    stagingCount: stagingFiles.length,
    stagingSha256s: stagingSha256s.sort(),
  };
}

function digestSetMatches(
  observed: readonly string[],
  expected: readonly string[],
): boolean {
  if (observed.length !== expected.length) return false;
  const observedSorted = [...observed].sort();
  const expectedSorted = [...expected].sort();
  return observedSorted.every((digest, index) => digest === expectedSorted[index]);
}

/** Failures when a redacted hidden-state snapshot differs from its expectation. */
function hiddenStateFailures(
  label: string,
  expected: MutationCorpusHiddenStateExpectation,
  observed: CorpusHiddenAreaSnapshot,
): string[] {
  const failures: string[] = [];
  if (observed.trashCount !== expected.trashCount) {
    failures.push(
      `${label}: expected ${expected.trashCount} managed-trash entr${expected.trashCount === 1 ? "y" : "ies"} but observed ${observed.trashCount}`,
    );
  } else if (!digestSetMatches(observed.trashSha256s, expected.trashSha256s)) {
    failures.push(`${label}: managed-trash digests do not match the expected hidden state`);
  }
  if (observed.stagingCount !== expected.stagingCount) {
    failures.push(
      `${label}: expected ${expected.stagingCount} staging entr${expected.stagingCount === 1 ? "y" : "ies"} but observed ${observed.stagingCount}`,
    );
  } else if (!digestSetMatches(observed.stagingSha256s, expected.stagingSha256s)) {
    failures.push(`${label}: staging digests do not match the expected hidden state`);
  }
  return failures;
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
  return { journalPhase, files, hidden: await observeHiddenSnapshot(root), observed: true };
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
  if (expected.hidden !== undefined) {
    if (observed.hidden === undefined) {
      failures.push("hidden-state boundary evidence was not observed");
    } else {
      failures.push(
        ...hiddenStateFailures(
          `hidden-state boundary at the crash point`,
          expected.hidden,
          observed.hidden,
        ),
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
    hidden: null,
    cleanup: { success: false, message: "not attempted" },
    verdict: "fail",
    failures,
    reportPath: options.reportPath,
  };
}

/** Redacted trash-area residual policy: Managed-Trash profiles never leak private trash paths. */
function redactsManagedTrashResiduals(profile: MutationCorpusProfile): boolean {
  return profile.expectedHiddenState !== undefined;
}

async function privateAreaResidualPaths(
  root: string,
  redactTrash: boolean,
): Promise<string[]> {
  const residuals = (await listPrivateAreaFiles(root, "staging")).map(
    (relativePath) => `staging:${relativePath}`,
  );
  if (!redactTrash) {
    residuals.push(
      ...(await listPrivateAreaFiles(root, "trash")).map(
        (relativePath) => `trash:${relativePath}`,
      ),
    );
  }
  return residuals.sort();
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
    evidence.hidden = await observeHiddenSnapshot(root);

    const finalFailures = finalFileFailures(evidence.fileFinal, expectedProof, profile);
    if (finalFailures.length > 0) {
      failures.push(...finalFailures);
    }

    // Residual paths are leftover content that recovery failed to clean: files
    // under the public Vault that are not expected in the terminal state, plus
    // leftover files under the private staging/trash areas. Managed-Trash
    // profiles redact the private trash area (counts/checksums only) so the
    // report never leaks a private trash path or identifier (spec A-37).
    const expectedTerminal = new Map<string, MutationCorpusTerminalFileState>(
      profile.files.map((file) => [
        file.path,
        terminalStateForFile(expectedProof, file),
      ]),
    );
    const expectedPresent = expectedPaths(profile, expectedTerminal);
    const privateResiduals = await privateAreaResidualPaths(
      root,
      redactsManagedTrashResiduals(profile),
    );
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
    const expectedHidden = profile.expectedHiddenState?.(expectedProof);
    if (
      expectedHidden !== undefined &&
      expectedProof !== "result_unproven" &&
      evidence.hidden !== null
    ) {
      failures.push(
        ...hiddenStateFailures("hidden state after recovery", expectedHidden, evidence.hidden),
      );
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
    evidence.phases = phases;
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
  const phases: string[] = [];
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
    evidence.hidden = await observeHiddenSnapshot(root);
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
    evidence.phases = phases;
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
    evidence.hidden = await observeHiddenSnapshot(root);

    const expectedTerminal = new Map<string, MutationCorpusTerminalFileState>(
      profile.files.map((file) => [file.path, terminalStateForFile("result_unproven", file)]),
    );
    const expectedPresent = expectedPaths(profile, expectedTerminal);
    const privateResiduals = await privateAreaResidualPaths(
      root,
      redactsManagedTrashResiduals(profile),
    );
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
    evidence.phases = phases;
    evidence.verdict = failures.length === 0 ? "pass" : "fail";
    await writeEvidence();
  }
  return evidence as CorpusScenarioEvidence;
}

// ---------------------------------------------------------------------------
// Issue #192: Recovery-Journal and storage-fault corpus scenarios.
//
// These scenarios give the Primary Operator deterministic evidence that journal
// corruption and storage faults fail closed: the restart either selects the
// newest trustworthy frame, or it blocks writes behind the recovery gate; a
// failed PREPARED/COMMITTED/ROLLED_BACK/FAILED persistence step never advances
// public proof beyond durable evidence and never replaces the last recoverable
// frame with an unusable one; and wrong-Vault/incompatible journal data is never
// interpreted as a Change Set for the current Managed Vault.
// ---------------------------------------------------------------------------

export interface JournalFaultScenarioOptions {
  readonly profile: MutationCorpusProfile;
  readonly seed: string;
  readonly reportDir: string;
  /**
   * Apply crash point where generation 1 parks before the supervisor applies
   * the fault. Omit to only create a journal header (boot-and-terminate).
   */
  readonly parkPoint?: string;
  /** Supervisor-side journal-state corruption applied between generations. */
  readonly corruption?: JournalCorruption;
  /** Rewrite the newest trustworthy frame to a foreign Vault identity. */
  readonly wrongVault?: boolean;
  /** Boot generation 2 with this journal slot capacity (incompatible-capacity). */
  readonly gen2JournalSlotCapacity?: number;
  readonly expectedRecovery:
    | "applied"
    | "rolled_back"
    | "blocked_unproven"
    | "boot_refused";
}

export type MutationCorpusFaultRecovery = JournalFaultScenarioOptions["expectedRecovery"];

function expectedProofForRecovery(
  recovery: Exclude<MutationCorpusFaultRecovery, "boot_refused">,
): MutationCorpusProofState {
  switch (recovery) {
    case "applied":
      return "intent_applied";
    case "rolled_back":
      return "intent_not_applied";
    case "blocked_unproven":
      return "result_unproven";
  }
}

function journalFilePath(root: string): string {
  return join(root, BRIDGE_STATE_DIRECTORY, BRIDGE_JOURNAL_FILE);
}

async function observeJournal(root: string): Promise<JournalObservation | null> {
  try {
    return await observeJournalFile(journalFilePath(root));
  } catch {
    // A truncated or unparseable journal cannot be observed structurally; the
    // report records `null` and the fault evidence states the boot outcome.
    return null;
  }
}

function inventoriesMatch(
  left: readonly CorpusInventoryEntry[],
  right: readonly CorpusInventoryEntry[],
): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index];
    const b = right[index];
    if (a === undefined || b === undefined) return false;
    if (a.path !== b.path || a.kind !== b.kind || a.bytes !== b.bytes || a.sha256 !== b.sha256) {
      return false;
    }
  }
  return true;
}

async function terminateChildIfRunning(owned: OwnedChild): Promise<void> {
  if (owned.child.exitCode === null) {
    try {
      await terminateChild(owned);
    } catch {
      // The child may have already exited.
    }
  }
}

/**
 * Journal-state fault scenario (issue #192): generation 1 submits the profile's
 * Change Set and parks at a declared apply crash point leaving a durable
 * journal; the supervisor applies one deterministic journal corruption (or a
 * wrong-Vault rewrite / incompatible-capacity boot); generation 2 restarts and
 * must either select the newest trustworthy recoverable frame, fail closed with
 * a blocked gate, or refuse to boot -- never mutating from untrusted data.
 */
export async function runMutationCorpusJournalFaultScenario(
  options: JournalFaultScenarioOptions,
): Promise<CorpusScenarioEvidence> {
  const { profile, seed, expectedRecovery } = options;
  const failures: string[] = [];
  const phases: string[] = [];
  const logPhase = (message: string): void => {
    phases.push(message);
  };

  await mkdir(options.reportDir, { recursive: true });
  const reportPath = join(options.reportDir, `${seed}.json`);
  const vaultId = `corpus-${seed}`;
  const root = await mkdtemp(join(tmpdir(), `corpus-${profile.label}-fault-`));
  const port = await pickAvailablePort();
  const controlBase = await mkdtemp(join(tmpdir(), "corpus-fault-control-"));
  const evidence = createEvidence(
    {
      profile,
      crashPoint: {
        point: options.parkPoint ?? "journal_fault",
        phase: "apply",
      },
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

  const journalBefore: JournalObservation | null = null;
  const faultEvidence: Writable<CorpusFaultEvidence> = {
    kind: options.corruption !== undefined
      ? "journal_state"
      : options.wrongVault === true
        ? "journal_state"
        : "journal_incompatible",
    identity: options.corruption?.kind ??
      (options.wrongVault === true
        ? "wrong_vault"
        : options.gen2JournalSlotCapacity !== undefined
          ? "incompatible_capacity"
          : "journal_fault"),
    declaration: {
      ...(options.corruption === undefined ? {} : { corruption: options.corruption }),
      ...(options.wrongVault === true ? { wrongVault: true } : {}),
      ...(options.gen2JournalSlotCapacity === undefined
        ? {}
        : { gen2JournalSlotCapacity: options.gen2JournalSlotCapacity }),
      expectedRecovery,
    },
    fired: { fired: false, at: null },
    journal: { before: journalBefore, after: null },
  };
  let journalObservedBefore: JournalObservation | null = journalBefore;
  let journalObservedAfter: JournalObservation | null = null;

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

    const parkPoint = options.parkPoint;
    if (parkPoint !== undefined) {
      const crashPoint = profile.crashPoints.find(
        (candidate) => candidate.phase === "apply" && candidate.point === parkPoint,
      );
      if (crashPoint === undefined) {
        throw new Error(`profile ${profile.label} has no apply crash point ${parkPoint}`);
      }
      log(`generation 1: submit and park at ${parkPoint}`);
      const gen1 = spawnOwningProcess({
        bundle,
        root,
        vaultId,
        port,
        controlDir: join(controlBase, "gen1"),
        crashPoint: parkPoint,
      });
      const bootMarker = await waitForControlMarker(
        gen1,
        ["ready", "parked", "failed"],
        profile.timeoutMs,
      );
      if (bootMarker === null || bootMarker.kind === "failed") {
        failures.push(
          `generation 1 did not boot: ${JSON.stringify(bootMarker)}; stderr: ${gen1.stderr.join("\n")}`,
        );
        await terminateChildIfRunning(gen1);
        throw new Error("generation 1 failed to boot");
      }
      if (bootMarker.kind === "parked") {
        failures.push("generation 1 parked before the Change Set was submitted");
      }
      if (bootMarker.kind === "ready") {
        const client = await connectClient(new URL(`http://127.0.0.1:${port}/mcp`), vaultId);
        const submitPromise = submitChangeSet(client, profile.buildSubmitInput(seed));
        const parkRace = await Promise.race([
          waitForControlMarker(gen1, ["parked", "failed"], profile.timeoutMs).then((marker) => ({
            kind: "parked-or-failed" as const,
            marker,
          })),
          submitPromise.then(() => ({ kind: "submit-settled" as const, marker: null })),
        ]);
        if (parkRace.kind !== "parked-or-failed" || parkRace.marker === null) {
          failures.push(`crash point ${parkPoint} was never reached during submission`);
          await terminateChildIfRunning(gen1);
          await client.close().catch(() => undefined);
          throw new Error("declared crash point was never reached");
        }
        if (parkRace.marker.kind === "failed") {
          failures.push(`child failed during submission: ${JSON.stringify(parkRace.marker.value)}`);
          await terminateChildIfRunning(gen1);
          await client.close().catch(() => undefined);
          throw new Error("child failed during submission");
        }
        await client.close().catch(() => undefined);
      }
      evidence.boundary = await observeBoundary(root, profile);
      log(`generation 1 parked at ${parkPoint}; journal-phase ${evidence.boundary.journalPhase}`);
      await terminateChildIfRunning(gen1);
      log("generation 1 terminated by supervisor");
    } else {
      log("generation 1: boot to create a journal header, then terminate");
      const gen1 = spawnOwningProcess({
        bundle,
        root,
        vaultId,
        port,
        controlDir: join(controlBase, "gen1"),
      });
      const bootMarker = await waitForControlMarker(
        gen1,
        ["ready", "failed"],
        profile.timeoutMs,
      );
      if (bootMarker === null || bootMarker.kind !== "ready") {
        failures.push(
          `generation 1 did not boot: ${JSON.stringify(bootMarker)}; stderr: ${gen1.stderr.join("\n")}`,
        );
        await terminateChildIfRunning(gen1);
        throw new Error("generation 1 failed to boot");
      }
      await terminateChildIfRunning(gen1);
      log("generation 1 terminated by supervisor");
    }

    journalObservedBefore = await observeJournal(root);

    if (options.corruption !== undefined) {
      const applied = await corruptJournalFile(journalFilePath(root), options.corruption);
      faultEvidence.identity = applied.kind;
      journalObservedAfter = applied.after;
      log(`applied journal corruption ${applied.kind}`);
    } else if (options.wrongVault === true) {
      const newVaultId = `${vaultId.slice(0, -1)}${vaultId.endsWith("Z") ? "Y" : "Z"}`;
      faultEvidence.identity = "wrong_vault";
      journalObservedAfter = await rewriteJournalFrameVaultId(
        journalFilePath(root),
        vaultId,
        newVaultId,
        "newest",
      );
      log(`rewrote the newest journal frame to Vault identity ${newVaultId}`);
    } else {
      journalObservedAfter = await observeJournal(root);
    }
    faultEvidence.journal = { before: journalObservedBefore, after: journalObservedAfter };

    // ---- Generation 2: restart over the faulted journal ---------------------
    log("generation 2: startup recovery over the faulted journal");
    const gen2 = spawnOwningProcess({
      bundle,
      root,
      vaultId,
      port,
      controlDir: join(controlBase, "gen2"),
      ...(options.gen2JournalSlotCapacity === undefined
        ? {}
        : { journalSlotCapacity: options.gen2JournalSlotCapacity }),
    });
    const gen2Marker = await waitForControlMarker(
      gen2,
      ["ready", "failed"],
      profile.timeoutMs,
    );

    if (expectedRecovery === "boot_refused") {
      if (gen2Marker !== null && gen2Marker.kind === "ready") {
        failures.push("generation 2 became ready despite an incompatible journal");
        await terminateChildIfRunning(gen2);
      } else {
        log(
          `generation 2 refused to boot over the faulted journal (${JSON.stringify(gen2Marker)}); stderr: ${gen2.stderr.join("\n")}`,
        );
      }
      await terminateChildIfRunning(gen2);
      evidence.after = await inventoryCorpus(root);
      evidence.fileFinal = await observeFinalFiles(root, profile);
      evidence.hidden = await observeHiddenSnapshot(root);
      if (!inventoriesMatch(evidence.before, evidence.after)) {
        failures.push(
          "public inventory changed across a refused boot; no recovery mutation may begin",
        );
      }
      if (evidence.fileFinal.some((file) => !file.present && file.state !== "absent")) {
        failures.push("a refused boot left an unexpected public path state");
      }
      evidence.fault = faultEvidence;
      return evidence as CorpusScenarioEvidence;
    }

    if (gen2Marker === null || gen2Marker.kind !== "ready") {
      failures.push(
        `generation 2 did not become ready after the journal fault: ${JSON.stringify(gen2Marker)}; stderr: ${gen2.stderr.join("\n")}`,
      );
      await terminateChildIfRunning(gen2);
      throw new Error("generation 2 did not become ready");
    }
    log("generation 2 ready after startup recovery");

    const client = await connectClient(new URL(`http://127.0.0.1:${port}/mcp`), vaultId);
    evidence.gate = await healthSnapshot(client);
    evidence.proofState = await statusProofState(client, profile.submissionKey(seed));
    log(
      `proof state ${String(evidence.proofState)}; effective gate ${String(evidence.gate.effectiveGate)}; recovery ${String(evidence.gate.recoveryState)}`,
    );

    const expectedProof = expectedProofForRecovery(expectedRecovery);
    if (expectedRecovery === "blocked_unproven") {
      if (evidence.proofState !== "result_unproven") {
        failures.push(
          `expected result_unproven after an untrustworthy journal but observed ${String(evidence.proofState)}`,
        );
      }
      if (evidence.gate.effectiveGate === null && evidence.gate.recoveryState !== "blocked") {
        failures.push("expected writes to be blocked after an untrustworthy journal");
      }
    } else {
      if (evidence.proofState !== expectedProof) {
        failures.push(
          `expected proof ${expectedProof} after journal recovery but observed ${String(evidence.proofState)}`,
        );
      }
      if (
        evidence.gate.recoveryState !== "none" &&
        evidence.gate.recoveryState !== null
      ) {
        failures.push(`unexpected recovery state ${String(evidence.gate.recoveryState)} after journal recovery`);
      }
    }

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
    if (expectedRecovery === "blocked_unproven") {
      if (evidence.sentinel.applied) {
        failures.push("sentinel Change Set was admissible despite an untrustworthy journal");
      }
    } else if (!evidence.sentinel.applied) {
      failures.push("sentinel Change Set was not admissible after journal recovery");
    }
    await client.close().catch(() => undefined);

    await terminateChildIfRunning(gen2);
    await rm(join(root, sentinelNote), { force: true });
    evidence.after = await inventoryCorpus(root);
    evidence.fileFinal = await observeFinalFiles(root, profile);
    evidence.hidden = await observeHiddenSnapshot(root);

    if (expectedRecovery !== "blocked_unproven") {
      const finalFailures = finalFileFailures(evidence.fileFinal, expectedProof, profile);
      if (finalFailures.length > 0) failures.push(...finalFailures);
      const expectedTerminal = new Map<string, MutationCorpusTerminalFileState>(
        profile.files.map((file) => [file.path, terminalStateForFile(expectedProof, file)]),
      );
      const expectedPresent = expectedPaths(profile, expectedTerminal);
      const privateResiduals = await privateAreaResidualPaths(
        root,
        redactsManagedTrashResiduals(profile),
      );
      evidence.residualPaths = [
        ...residualPaths(evidence.after, expectedPresent),
        ...privateResiduals,
      ].sort();
      if (evidence.residualPaths.length > 0) {
        failures.push(`residual paths remain after journal recovery: ${evidence.residualPaths.join(", ")}`);
      }
    } else {
      const expectedTerminal = new Map<string, MutationCorpusTerminalFileState>(
        profile.files.map((file) => [file.path, terminalStateForFile("result_unproven", file)]),
      );
      const expectedPresent = expectedPaths(profile, expectedTerminal);
      const privateResiduals = await privateAreaResidualPaths(
        root,
        redactsManagedTrashResiduals(profile),
      );
      evidence.residualPaths = [
        ...residualPaths(evidence.after, expectedPresent),
        ...privateResiduals,
      ].sort();
      if (evidence.residualPaths.length === 0) {
        failures.push("expected an unproven residue to be surfaced but no residual path was reported");
      }
    }
    const expectedHidden = profile.expectedHiddenState?.(
      expectedRecovery === "blocked_unproven" ? "result_unproven" : expectedProof,
    );
    if (
      expectedHidden !== undefined &&
      expectedRecovery !== "blocked_unproven" &&
      evidence.hidden !== null
    ) {
      failures.push(
        ...hiddenStateFailures("hidden state after journal recovery", expectedHidden, evidence.hidden),
      );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!failures.includes(message)) failures.push(message);
  } finally {
    evidence.fault = faultEvidence;
    try {
      await rm(root, { recursive: true, force: true });
      evidence.cleanup = { success: true, message: "scenario root removed by supervisor" };
    } catch (error) {
      evidence.cleanup = { success: false, message: String(error) };
    }
    await rm(controlBase, { recursive: true, force: true }).catch(() => undefined);
    if (!evidence.cleanup.success) failures.push(`cleanup failed: ${evidence.cleanup.message}`);
    evidence.phases = phases;
    evidence.verdict = failures.length === 0 ? "pass" : "fail";
    await writeEvidence();
  }
  return evidence as CorpusScenarioEvidence;
}

async function readFaultFired(controlDir: string): Promise<{
  readonly fired: boolean;
  readonly at: Record<string, unknown> | null;
}> {
  const value = await readOptionalJson<Record<string, unknown>>(join(controlDir, "fault.json"));
  if (value === undefined || value.fired !== true) {
    return { fired: false, at: null };
  }
  const { fired: _fired, ...at } = value;
  return { fired: true, at };
}

/**
 * Storage-fault scenario over a declared journal-write step (issue #192). The
 * supervisor arms exactly one `CORPUS_FAULT` in a child generation; the fault
 * fires at the declared frame phase/occurrence. The scenario asserts strict
 * ordering (fired exactly once, at the declared operation) and that a failed
 * durable-persistence step never advances public proof beyond durable evidence.
 *
 * - `generation: "apply"` faults the live apply of generation 1 (the fault
 *   fires during the MCP submit while the COMMITTED/prepared frame is persisted).
 * - `generation: "recovery"` leaves a durable PREPARED in generation 1 and
 *   faults the durable ROLLED_BACK/FAILED persistence of generation 2 recovery.
 */
export interface JournalWriteFaultScenarioOptions {
  readonly profile: MutationCorpusProfile;
  readonly seed: string;
  readonly reportDir: string;
  readonly fault: JournalWriteFault;
  readonly generation: "apply" | "recovery";
  readonly expectedProof: MutationCorpusProofState;
  readonly expectedGate: "open" | "blocked";
  /**
   * Optional third-party bytes the supervisor writes over a public file between
   * generation 1 and a `recovery` generation. This makes compare-before-restore
   * fail closed (spec A-22) so the durable executor reaches the FAILED
   * persistence step deterministically without a second injected fault.
   */
  readonly residue?: { readonly path: string; readonly bytes: Uint8Array } | null;
}

export async function runMutationCorpusJournalWriteFaultScenario(
  options: JournalWriteFaultScenarioOptions,
): Promise<CorpusScenarioEvidence> {
  const { profile, seed } = options;
  const failures: string[] = [];
  const phases: string[] = [];
  const logPhase = (message: string): void => {
    phases.push(message);
  };

  await mkdir(options.reportDir, { recursive: true });
  const reportPath = join(options.reportDir, `${seed}.json`);
  const vaultId = `corpus-${seed}`;
  const root = await mkdtemp(join(tmpdir(), `corpus-${profile.label}-writefault-`));
  const port = await pickAvailablePort();
  const controlBase = await mkdtemp(join(tmpdir(), "corpus-writefault-control-"));
  const crashPoint: MutationCorpusCrashPoint = {
    point: options.generation === "apply"
      ? "journal_write_fault_apply"
      : profile.rollbackLeadInPoint,
    phase: options.generation === "apply" ? "apply" : "rollback",
  };
  const evidence = createEvidence(
    { profile, crashPoint, seed, root, vaultId, port, reportPath },
    failures,
  );
  const log = (message: string): void => {
    logPhase(message);
  };
  const writeEvidence = async (): Promise<void> => {
    await mkdir(dirname(reportPath), { recursive: true });
    await writeFile(reportPath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  };
  const faultJson = JSON.stringify({
    kind: "journal_write",
    fault: options.fault,
  });
  let journalObservedBefore: JournalObservation | null = null;
  let journalObservedAfter: JournalObservation | null = null;
  let faultControlDir: string | null = null;
  let liveChild: OwnedChild | null = null;

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

    if (options.generation === "recovery") {
      // Generation 1: submit and park at the rollback lead-in leaving a durable
      // PREPARED frame with the profile fully applied.
      log(`generation 1: park at rollback lead-in ${profile.rollbackLeadInPoint}`);
      const gen1 = spawnOwningProcess({
        bundle,
        root,
        vaultId,
        port,
        controlDir: join(controlBase, "gen1"),
        crashPoint: profile.rollbackLeadInPoint,
      });
      const bootMarker = await waitForControlMarker(
        gen1,
        ["ready", "parked", "failed"],
        profile.timeoutMs,
      );
      if (bootMarker === null || bootMarker.kind === "failed") {
        failures.push(
          `generation 1 did not boot: ${JSON.stringify(bootMarker)}; stderr: ${gen1.stderr.join("\n")}`,
        );
        await terminateChildIfRunning(gen1);
        throw new Error("generation 1 failed to boot");
      }
      const client = await connectClient(new URL(`http://127.0.0.1:${port}/mcp`), vaultId);
      const submitPromise = submitChangeSet(client, profile.buildSubmitInput(seed));
      const parkRace = await Promise.race([
        waitForControlMarker(gen1, ["parked", "failed"], profile.timeoutMs).then((marker) => ({
          kind: "parked-or-failed" as const,
          marker,
        })),
        submitPromise.then(() => ({ kind: "submit-settled" as const, marker: null })),
      ]);
      if (parkRace.kind !== "parked-or-failed" || parkRace.marker === null) {
        failures.push(`rollback lead-in ${profile.rollbackLeadInPoint} was never reached`);
        await terminateChildIfRunning(gen1);
        await client.close().catch(() => undefined);
        throw new Error("rollback lead-in was never reached");
      }
      if (parkRace.marker.kind === "failed") {
        failures.push(`child failed during submission: ${JSON.stringify(parkRace.marker.value)}`);
        await terminateChildIfRunning(gen1);
        await client.close().catch(() => undefined);
        throw new Error("child failed during submission");
      }
      evidence.boundary = await observeBoundary(root, profile);
      await client.close().catch(() => undefined);
      await terminateChildIfRunning(gen1);
      log("generation 1 terminated by supervisor");
      journalObservedBefore = await observeJournal(root);

      if (options.residue !== null && options.residue !== undefined) {
        const residueAbsolute = join(root, ...options.residue.path.split("/"));
        await mkdir(dirname(residueAbsolute), { recursive: true });
        await writeFile(residueAbsolute, options.residue.bytes);
        log(`supervisor wrote third-party bytes over ${options.residue.path}`);
      }

      // Generation 2: startup recovery armed with the declared storage fault.
      log(`generation 2: armed journal-write fault on ${options.fault.phase}`);
      const gen2Control = join(controlBase, "gen2");
      faultControlDir = gen2Control;
      const gen2 = spawnOwningProcess({
        bundle,
        root,
        vaultId,
        port,
        controlDir: gen2Control,
        fault: faultJson,
      });
      const gen2Marker = await waitForControlMarker(
        gen2,
        ["ready", "failed"],
        profile.timeoutMs,
      );
      if (gen2Marker === null || gen2Marker.kind !== "ready") {
        failures.push(
          `generation 2 did not become ready: ${JSON.stringify(gen2Marker)}; stderr: ${gen2.stderr.join("\n")}`,
        );
        await terminateChildIfRunning(gen2);
        throw new Error("generation 2 did not become ready");
      }
      log("generation 2 ready after faulted recovery");
      const gen2Client = await connectClient(new URL(`http://127.0.0.1:${port}/mcp`), vaultId);
      evidence.gate = await healthSnapshot(gen2Client);
      evidence.proofState = await statusProofState(gen2Client, profile.submissionKey(seed));
      await gen2Client.close().catch(() => undefined);
      liveChild = gen2;
    } else {
      // Generation 1 apply with the fault armed on a live durable-persistence
      // step (COMMITTED). The submit call executes the Change Set; the fault
      // fires mid-apply and the durable executor rolls back.
      log(`generation 1 apply: armed journal-write fault on ${options.fault.phase}`);
      const gen1Control = join(controlBase, "gen1");
      faultControlDir = gen1Control;
      const gen1 = spawnOwningProcess({
        bundle,
        root,
        vaultId,
        port,
        controlDir: gen1Control,
        fault: faultJson,
      });
      const bootMarker = await waitForControlMarker(
        gen1,
        ["ready", "failed"],
        profile.timeoutMs,
      );
      if (bootMarker === null || bootMarker.kind !== "ready") {
        failures.push(
          `generation 1 did not boot: ${JSON.stringify(bootMarker)}; stderr: ${gen1.stderr.join("\n")}`,
        );
        await terminateChildIfRunning(gen1);
        throw new Error("generation 1 failed to boot");
      }
      const client = await connectClient(new URL(`http://127.0.0.1:${port}/mcp`), vaultId);
      await submitChangeSet(client, profile.buildSubmitInput(seed));
      evidence.gate = await healthSnapshot(client);
      evidence.proofState = await statusProofState(client, profile.submissionKey(seed));
      log(
        `proof state after faulted apply ${String(evidence.proofState)}; gate ${String(evidence.gate.effectiveGate)}`,
      );
      await client.close().catch(() => undefined);
      liveChild = gen1;
    }

    // ---- Strict-ordering and fail-closed assertions -------------------------
    const fired = await readFaultFired(faultControlDir ?? "");
    if (!fired.fired) {
      failures.push(
        `requested storage fault (${options.fault.phase}@${options.fault.occurrence}) was bypassed`,
      );
    } else if (fired.at?.phase !== options.fault.phase) {
      failures.push(
        `requested storage fault fired at an unintended operation: ${JSON.stringify(fired.at)}`,
      );
    }

    if (evidence.proofState !== options.expectedProof) {
      failures.push(
        `expected proof ${options.expectedProof} after the storage fault but observed ${String(evidence.proofState)}`,
      );
    }
    const gateBlocked = evidence.gate.effectiveGate !== null || evidence.gate.recoveryState === "blocked";
    if (options.expectedGate === "open" && gateBlocked) {
      failures.push("expected the write gate to stay open after the storage fault");
    }
    if (options.expectedGate === "blocked" && !gateBlocked) {
      failures.push("expected writes to be blocked after the storage fault");
    }

    // ---- Sentinel write against the post-fault gate ------------------------
    const sentinelNote = `CorpusSentinel-${seed.replace(/[^A-Za-z0-9_-]/gu, "_")}.md`;
    const sentinelClient = await connectClient(new URL(`http://127.0.0.1:${port}/mcp`), vaultId);
    evidence.sentinel = await submitChangeSet(sentinelClient, {
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
    await sentinelClient.close().catch(() => undefined);
    if (options.expectedGate === "open" && !evidence.sentinel.applied) {
      failures.push("sentinel Change Set was not admissible after the storage fault");
    }
    if (options.expectedGate === "blocked" && evidence.sentinel.applied) {
      failures.push("sentinel Change Set was admissible despite a blocked gate after the storage fault");
    }
    await rm(join(root, sentinelNote), { force: true });

    if (liveChild !== null) {
      await terminateChildIfRunning(liveChild);
      liveChild = null;
    }

    evidence.after = await inventoryCorpus(root);
    evidence.fileFinal = await observeFinalFiles(root, profile);
    evidence.hidden = await observeHiddenSnapshot(root);

    if (options.expectedProof !== "result_unproven") {
      const finalFailures = finalFileFailures(evidence.fileFinal, options.expectedProof, profile);
      if (finalFailures.length > 0) failures.push(...finalFailures);
    }
    const expectedTerminal = new Map<string, MutationCorpusTerminalFileState>(
      profile.files.map((file) => [
        file.path,
        terminalStateForFile(options.expectedProof, file),
      ]),
    );
    const expectedPresent = expectedPaths(profile, expectedTerminal);
    const privateResiduals = await privateAreaResidualPaths(
      root,
      redactsManagedTrashResiduals(profile),
    );
    evidence.residualPaths = [
      ...residualPaths(evidence.after, expectedPresent),
      ...privateResiduals,
    ].sort();
    if (options.expectedProof !== "result_unproven" && evidence.residualPaths.length > 0) {
      failures.push(`residual paths remain after the storage fault: ${evidence.residualPaths.join(", ")}`);
    }

    // A failed persistence step must never leave an unusable journal: at least
    // one trustworthy frame must remain recoverable (spec §7.3 ordering).
    journalObservedAfter = await observeJournal(root);
    if (
      options.expectedGate === "open" &&
      journalObservedAfter !== null &&
      journalObservedAfter.recoverable === null
    ) {
      failures.push("no trustworthy journal frame remained recoverable after the storage fault");
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!failures.includes(message)) failures.push(message);
  } finally {
    const fired = await readFaultFired(faultControlDir ?? "").catch(() => ({ fired: false, at: null }));
    evidence.fault = {
      kind: "journal_write",
      identity: `${options.fault.phase.toLowerCase()}_${options.fault.step}`,
      declaration: {
        fault: options.fault,
        generation: options.generation,
        expectedProof: options.expectedProof,
        expectedGate: options.expectedGate,
        ...(options.residue === null || options.residue === undefined
          ? {}
          : { residuePath: options.residue.path }),
      },
      fired: { fired: fired.fired, at: fired.at },
      journal: { before: journalObservedBefore, after: journalObservedAfter },
    };
    if (liveChild !== null) {
      await terminateChildIfRunning(liveChild).catch(() => undefined);
      liveChild = null;
    }
    try {
      await rm(root, { recursive: true, force: true });
      evidence.cleanup = { success: true, message: "scenario root removed by supervisor" };
    } catch (error) {
      evidence.cleanup = { success: false, message: String(error) };
    }
    await rm(controlBase, { recursive: true, force: true }).catch(() => undefined);
    if (!evidence.cleanup.success) failures.push(`cleanup failed: ${evidence.cleanup.message}`);
    evidence.phases = phases;
    evidence.verdict = failures.length === 0 ? "pass" : "fail";
    await writeEvidence();
  }
  return evidence as CorpusScenarioEvidence;
}

/**
 * Slot-capacity-exhaustion scenario (issue #192). Generation 1 opens the
 * Recovery Journal with a slot capacity too small for the Change Set frame, so
 * the real `RecoveryJournalCapacityError` fires at the first durable `PREPARED`
 * persistence step -- before any public mutation and before any frame is
 * written. The scenario proves a failed PREPARED step never advances public
 * proof beyond durable evidence, never overwrites a recoverable frame (there is
 * none), and that a clean restart re-executes the unchanged intent from scratch
 * to a durable `COMMITTED`.
 */
export interface CapacityFaultScenarioOptions {
  readonly profile: MutationCorpusProfile;
  readonly seed: string;
  readonly reportDir: string;
  readonly slotCapacity: number;
}

export async function runMutationCorpusCapacityFaultScenario(
  options: CapacityFaultScenarioOptions,
): Promise<CorpusScenarioEvidence> {
  const { profile, seed } = options;
  const failures: string[] = [];
  const phases: string[] = [];
  const logPhase = (message: string): void => {
    phases.push(message);
  };

  await mkdir(options.reportDir, { recursive: true });
  const reportPath = join(options.reportDir, `${seed}.json`);
  const vaultId = `corpus-${seed}`;
  const root = await mkdtemp(join(tmpdir(), `corpus-${profile.label}-capacity-`));
  const port = await pickAvailablePort();
  const controlBase = await mkdtemp(join(tmpdir(), "corpus-capacity-control-"));
  const crashPoint: MutationCorpusCrashPoint = {
    point: "before_prepared",
    phase: "apply",
  };
  const evidence = createEvidence(
    { profile, crashPoint, seed, root, vaultId, port, reportPath },
    failures,
  );
  const log = (message: string): void => {
    logPhase(message);
  };
  const writeEvidence = async (): Promise<void> => {
    await mkdir(dirname(reportPath), { recursive: true });
    await writeFile(reportPath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  };
  let journalBefore: JournalObservation | null = null;

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
    log(`generation 1: boot with slot capacity ${options.slotCapacity}`);
    const gen1 = spawnOwningProcess({
      bundle,
      root,
      vaultId,
      port,
      controlDir: join(controlBase, "gen1"),
      journalSlotCapacity: options.slotCapacity,
    });
    const bootMarker = await waitForControlMarker(
      gen1,
      ["ready", "failed"],
      profile.timeoutMs,
    );
    if (bootMarker === null || bootMarker.kind !== "ready") {
      failures.push(
        `generation 1 did not boot: ${JSON.stringify(bootMarker)}; stderr: ${gen1.stderr.join("\n")}`,
      );
      await terminateChildIfRunning(gen1);
      throw new Error("generation 1 failed to boot");
    }
    const client = await connectClient(new URL(`http://127.0.0.1:${port}/mcp`), vaultId);
    const submitted = await submitChangeSet(client, profile.buildSubmitInput(seed));
    evidence.proofState = await statusProofState(client, profile.submissionKey(seed));
    evidence.gate = await healthSnapshot(client);
    log(
      `generation 1 submit applied=${submitted.applied} submitted=${submitted.submitted}; proof ${String(evidence.proofState)}`,
    );
    if (submitted.applied) {
      failures.push("generation 1 applied a Change Set whose PREPARED frame could not be persisted");
    }
    await client.close().catch(() => undefined);
    await terminateChildIfRunning(gen1);

    journalBefore = await observeJournal(root);
    log(`generation 1 journal capacity ${journalBefore?.capacity ?? "n/a"} recoverable ${JSON.stringify(journalBefore?.recoverable)}`);

    // No durable frame was ever written, so removing the empty journal file is
    // a safe operator action; a fresh restart re-executes the unchanged intent.
    await rm(journalFilePath(root), { force: true });

    log("generation 2: clean restart with the default journal capacity");
    const gen2 = spawnOwningProcess({
      bundle,
      root,
      vaultId,
      port,
      controlDir: join(controlBase, "gen2"),
    });
    const gen2Marker = await waitForControlMarker(
      gen2,
      ["ready", "failed"],
      profile.timeoutMs,
    );
    if (gen2Marker === null || gen2Marker.kind !== "ready") {
      failures.push(
        `generation 2 did not become ready: ${JSON.stringify(gen2Marker)}; stderr: ${gen2.stderr.join("\n")}`,
      );
      await terminateChildIfRunning(gen2);
      throw new Error("generation 2 did not become ready");
    }
    const gen2Client = await connectClient(new URL(`http://127.0.0.1:${port}/mcp`), vaultId);
    evidence.proofState = await statusProofState(gen2Client, profile.submissionKey(seed));
    evidence.gate = await healthSnapshot(gen2Client);
    log(`generation 2 proof ${String(evidence.proofState)}`);
    if (evidence.proofState !== "intent_applied") {
      failures.push(
        `expected the unchanged Change Set to reach intent_applied after a clean restart but observed ${String(evidence.proofState)}`,
      );
    }
    const sentinelNote = `CorpusSentinel-${seed.replace(/[^A-Za-z0-9_-]/gu, "_")}.md`;
    evidence.sentinel = await submitChangeSet(gen2Client, {
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
    if (!evidence.sentinel.applied) {
      failures.push("sentinel Change Set was not admissible after the capacity-fault restart");
    }
    await gen2Client.close().catch(() => undefined);
    await terminateChildIfRunning(gen2);
    await rm(join(root, sentinelNote), { force: true });

    evidence.after = await inventoryCorpus(root);
    evidence.fileFinal = await observeFinalFiles(root, profile);
    evidence.hidden = await observeHiddenSnapshot(root);
    const finalFailures = finalFileFailures(evidence.fileFinal, "intent_applied", profile);
    if (finalFailures.length > 0) failures.push(...finalFailures);
    const expectedTerminal = new Map<string, MutationCorpusTerminalFileState>(
      profile.files.map((file) => [file.path, terminalStateForFile("intent_applied", file)]),
    );
    evidence.residualPaths = residualPaths(
      evidence.after,
      expectedPaths(profile, expectedTerminal),
    );
    if (evidence.residualPaths.length > 0) {
      failures.push(`residual paths remain after the capacity-fault restart: ${evidence.residualPaths.join(", ")}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!failures.includes(message)) failures.push(message);
  } finally {
    evidence.fault = {
      kind: "capacity",
      identity: "slot_capacity_exhaustion",
      declaration: { slotCapacity: options.slotCapacity },
      fired: { fired: true, at: { phase: "PREPARED", occurrence: 1 } },
      journal: { before: journalBefore, after: null },
    };
    try {
      await rm(root, { recursive: true, force: true });
      evidence.cleanup = { success: true, message: "scenario root removed by supervisor" };
    } catch (error) {
      evidence.cleanup = { success: false, message: String(error) };
    }
    await rm(controlBase, { recursive: true, force: true }).catch(() => undefined);
    if (!evidence.cleanup.success) failures.push(`cleanup failed: ${evidence.cleanup.message}`);
    evidence.phases = phases;
    evidence.verdict = failures.length === 0 ? "pass" : "fail";
    await writeEvidence();
  }
  return evidence as CorpusScenarioEvidence;
}

/**
 * Host-operation fault scenario for Managed Trash (issue #192 AC5): generation
 * 1 fully trashes a public note/attachment and parks at the rollback lead-in
 * with a durable PREPARED frame; generation 2 recovery is armed with a
 * permission-denial fault on `restoreFromTrash`. The rollback cannot restore the
 * public path, so complete restoration cannot be proven: the Change Set reports
 * `result_unproven`, the write gate is blocked, the hidden trash copy is
 * preserved (never destroyed by the failed restore), and no private trash path
 * is surfaced.
 */
export interface HostOperationFaultScenarioOptions {
  readonly profile: MutationCorpusProfile;
  readonly seed: string;
  readonly reportDir: string;
  readonly operation: string;
  readonly code: string;
  readonly expectedHiddenTrashCount: number;
}

export async function runMutationCorpusHostOperationFaultScenario(
  options: HostOperationFaultScenarioOptions,
): Promise<CorpusScenarioEvidence> {
  const { profile, seed } = options;
  const failures: string[] = [];
  const phases: string[] = [];
  const logPhase = (message: string): void => {
    phases.push(message);
  };

  await mkdir(options.reportDir, { recursive: true });
  const reportPath = join(options.reportDir, `${seed}.json`);
  const vaultId = `corpus-${seed}`;
  const root = await mkdtemp(join(tmpdir(), `corpus-${profile.label}-hostfault-`));
  const port = await pickAvailablePort();
  const controlBase = await mkdtemp(join(tmpdir(), "corpus-hostfault-control-"));
  const crashPoint: MutationCorpusCrashPoint = {
    point: profile.rollbackLeadInPoint,
    phase: "rollback",
  };
  const evidence = createEvidence(
    { profile, crashPoint, seed, root, vaultId, port, reportPath },
    failures,
  );
  const log = (message: string): void => {
    logPhase(message);
  };
  const writeEvidence = async (): Promise<void> => {
    await mkdir(dirname(reportPath), { recursive: true });
    await writeFile(reportPath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  };
  const faultJson = JSON.stringify({
    kind: "host_operation",
    operation: options.operation,
    occurrence: 1,
    code: options.code,
    message: `${options.code} injected on ${options.operation}`,
  });
  let journalBefore: JournalObservation | null = null;
  let journalAfter: JournalObservation | null = null;
  let gen2Control: string | null = null;

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

    // Generation 1: trash the public note/attachment and park at the rollback
    // lead-in with a durable PREPARED frame.
    log(`generation 1: park at ${profile.rollbackLeadInPoint}`);
    const gen1 = spawnOwningProcess({
      bundle,
      root,
      vaultId,
      port,
      controlDir: join(controlBase, "gen1"),
      crashPoint: profile.rollbackLeadInPoint,
    });
    const bootMarker = await waitForControlMarker(
      gen1,
      ["ready", "parked", "failed"],
      profile.timeoutMs,
    );
    if (bootMarker === null || bootMarker.kind === "failed") {
      failures.push(
        `generation 1 did not boot: ${JSON.stringify(bootMarker)}; stderr: ${gen1.stderr.join("\n")}`,
      );
      await terminateChildIfRunning(gen1);
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
      failures.push(`rollback lead-in ${profile.rollbackLeadInPoint} was never reached`);
      await terminateChildIfRunning(gen1);
      await gen1Client.close().catch(() => undefined);
      throw new Error("rollback lead-in was never reached");
    }
    if (parkRace.marker.kind === "failed") {
      failures.push(`child failed during submission: ${JSON.stringify(parkRace.marker.value)}`);
      await terminateChildIfRunning(gen1);
      await gen1Client.close().catch(() => undefined);
      throw new Error("child failed during submission");
    }
    evidence.boundary = await observeBoundary(root, profile);
    await gen1Client.close().catch(() => undefined);
    await terminateChildIfRunning(gen1);
    log("generation 1 terminated by supervisor");
    journalBefore = await observeJournal(root);

    // Generation 2: recovery with the armed permission fault on restore.
    log(`generation 2: armed host-operation fault on ${options.operation}`);
    const gen2ControlDir = join(controlBase, "gen2");
    gen2Control = gen2ControlDir;
    const gen2 = spawnOwningProcess({
      bundle,
      root,
      vaultId,
      port,
      controlDir: gen2ControlDir,
      fault: faultJson,
    });
    const gen2Marker = await waitForControlMarker(
      gen2,
      ["ready", "failed"],
      profile.timeoutMs,
    );
    if (gen2Marker === null || gen2Marker.kind !== "ready") {
      failures.push(
        `generation 2 did not become ready: ${JSON.stringify(gen2Marker)}; stderr: ${gen2.stderr.join("\n")}`,
      );
      await terminateChildIfRunning(gen2);
      throw new Error("generation 2 did not become ready");
    }
    log("generation 2 ready after faulted recovery");
    const firedEvidence = await readFaultFired(gen2ControlDir);
    if (!firedEvidence.fired) {
      failures.push(
        `requested host-operation fault on ${options.operation} was bypassed during recovery`,
      );
    }
    const gen2Client = await connectClient(new URL(`http://127.0.0.1:${port}/mcp`), vaultId);
    evidence.gate = await healthSnapshot(gen2Client);
    evidence.proofState = await statusProofState(gen2Client, profile.submissionKey(seed));
    log(
      `proof state ${String(evidence.proofState)}; gate ${String(evidence.gate.effectiveGate)}; recovery ${String(evidence.gate.recoveryState)}`,
    );
    if (evidence.proofState !== "result_unproven") {
      failures.push(
        `expected result_unproven after a failed trash restore but observed ${String(evidence.proofState)}`,
      );
    }
    const gateBlocked = evidence.gate.effectiveGate !== null || evidence.gate.recoveryState === "blocked";
    if (!gateBlocked) {
      failures.push("expected writes to be blocked after a failed trash restore");
    }

    const sentinelNote = `CorpusSentinel-${seed.replace(/[^A-Za-z0-9_-]/gu, "_")}.md`;
    evidence.sentinel = await submitChangeSet(gen2Client, {
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
      failures.push("sentinel Change Set was admissible despite a failed trash restore");
    }
    await gen2Client.close().catch(() => undefined);
    await terminateChildIfRunning(gen2);
    await rm(join(root, sentinelNote), { force: true });

    evidence.after = await inventoryCorpus(root);
    evidence.fileFinal = await observeFinalFiles(root, profile);
    evidence.hidden = await observeHiddenSnapshot(root);
    journalAfter = await observeJournal(root);

    // The hidden trash copy must be preserved: a failed restore never destroys
    // the private copy, and current (public-absent) state is preserved.
    if (evidence.hidden === null || evidence.hidden.trashCount !== options.expectedHiddenTrashCount) {
      failures.push(
        `expected ${options.expectedHiddenTrashCount} preserved managed-trash entr${options.expectedHiddenTrashCount === 1 ? "y" : "ies"} but observed ${evidence.hidden?.trashCount ?? "none"}`,
      );
    }
    const expectedTerminal = new Map<string, MutationCorpusTerminalFileState>(
      profile.files.map((file) => [file.path, terminalStateForFile("result_unproven", file)]),
    );
    const expectedPresent = expectedPaths(profile, expectedTerminal);
    const privateResiduals = await privateAreaResidualPaths(root, true);
    evidence.residualPaths = [
      ...residualPaths(evidence.after, expectedPresent),
      ...privateResiduals,
    ].sort();
    if (evidence.residualPaths.some((entry) => entry.startsWith("trash:"))) {
      failures.push("a private Managed-Trash path was surfaced as a residual path");
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!failures.includes(message)) failures.push(message);
  } finally {
    const fired = gen2Control === null
      ? { fired: false, at: null }
      : await readFaultFired(gen2Control);
    evidence.fault = {
      kind: "host_operation",
      identity: `${options.operation}_${options.code.toLowerCase()}`,
      declaration: {
        operation: options.operation,
        code: options.code,
        occurrence: 1,
      },
      fired: { fired: fired.fired, at: fired.at },
      journal: { before: journalBefore, after: journalAfter },
    };
    try {
      await rm(root, { recursive: true, force: true });
      evidence.cleanup = { success: true, message: "scenario root removed by supervisor" };
    } catch (error) {
      evidence.cleanup = { success: false, message: String(error) };
    }
    await rm(controlBase, { recursive: true, force: true }).catch(() => undefined);
    if (!evidence.cleanup.success) failures.push(`cleanup failed: ${evidence.cleanup.message}`);
    evidence.phases = phases;
    evidence.verdict = failures.length === 0 ? "pass" : "fail";
    await writeEvidence();
  }
  return evidence as CorpusScenarioEvidence;
}


// ---------------------------------------------------------------------------
// Issue #194: startup-recovery / third-party interference corpus scenarios.
//
// These scenarios prove that startup recovery resolves an active durable
// PREPARED frame before any new write can begin, and that compare-before-
// restore never overwrites a third-party mutation — whether the interference
// lands after execution (residue shape) or while recovery itself is parked
// mid-restore. Generation 1 leaves a durable PREPARED frame via the profile's
// rollback lead-in; generation 2 is armed with a recovery-path crash point so
// the real owning process parks *inside* startup recovery (the Bridge binds its
// loopback listener only after recovery resolves, so no write surface exists
// while recovery is in progress); the supervisor probes write admission, then
// writes third-party bytes over a declared footprint and terminates the child.
// Generation 3 must fail closed (`result_unproven` + `recovery_blocked`) without
// touching any third-party byte, and generation 4 must keep the gate blocked
// across the restart.
// ---------------------------------------------------------------------------

/** Recovery-path crash seams a generation can park at inside startup recovery. */
function isRecoveryParkPoint(point: string): boolean {
  return (
    point === "before_rollback" ||
    point.startsWith("after_rollback_mutation:") ||
    point.startsWith("recovery_after_file_prepared:") ||
    point.startsWith("recovery_after_file_published:") ||
    point === "after_rollback_verification" ||
    point === "after_rollback_evidence" ||
    point === "before_rolled_back"
  );
}

async function readChildEventLog(controlDir: string, generation: number): Promise<string[]> {
  try {
    const text = await readFile(join(controlDir, "events.jsonl"), "utf8");
    return text
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => `gen${generation}: ${line}`);
  } catch {
    return [];
  }
}

interface SentinelObservation {
  readonly attempted: boolean;
  readonly admitted: boolean;
  readonly gate: string | null;
}

/** Sentinel submit that also captures the returned gate code for ordering evidence. */
async function submitSentinelDetailed(
  client: Client,
  profile: MutationCorpusProfile,
  seed: string,
  label: string,
): Promise<{ readonly note: string; readonly submitted: boolean; readonly observation: SentinelObservation }> {
  const sentinelNote = `CorpusSentinel-${label}-${seed.replace(/[^A-Za-z0-9_-]/gu, "_")}.md`;
  let result: ToolInvocation;
  try {
    result = await callTool(client, "vault_change_set_submit", {
      submissionKey: profile.submissionKey(`${seed}-sentinel-${label}`),
      operations: [
        {
          operationId: `sentinel-${label}-${seed}`,
          kind: "create_note",
          path: sentinelNote,
          content: `# Sentinel ${label} ${seed}\n`,
          ifExists: "reject",
        },
      ],
    });
  } catch {
    return {
      note: sentinelNote,
      submitted: false,
      observation: { attempted: true, admitted: false, gate: null },
    };
  }
  const content = asRecord(result.structuredContent);
  const changeSet = asRecord(content.changeSet);
  const gate = asRecord(content.gate);
  return {
    note: sentinelNote,
    submitted: result.isError !== true,
    observation: {
      attempted: true,
      admitted: changeSet.state === "intent_applied",
      gate: typeof gate.code === "string" ? gate.code : null,
    },
  };
}

/**
 * Probe write admission while a generation is parked inside startup recovery.
 * The Bridge binds its loopback listener only after `ChangeSetService.open`
 * resolves the durable frame, so a parked recovery exposes no write surface at
 * all (connection refused) — the strongest form of `recovery_in_progress`
 * admission denial. If a surface is reachable, the `recovery_in_progress` gate
 * must reject the probe instead.
 */
async function probeAdmissionDuringRecovery(
  port: number,
  vaultId: string,
  profile: MutationCorpusProfile,
  seed: string,
): Promise<{ readonly attempted: true; readonly reachable: boolean; readonly admitted: boolean; readonly gate: string | null }> {
  try {
    const client = await connectClient(new URL(`http://127.0.0.1:${port}/mcp`), vaultId);
    try {
      const probe = await submitSentinelDetailed(client, profile, seed, "during-recovery");
      return {
        attempted: true,
        reachable: true,
        admitted: probe.observation.admitted,
        gate: probe.observation.gate,
      };
    } finally {
      await client.close().catch(() => undefined);
    }
  } catch {
    return { attempted: true, reachable: false, admitted: false, gate: null };
  }
}

export type RecoveryInterference =
  | {
      readonly area: "public";
      /** Public footprint path (must be one of `profile.files[].path`). */
      readonly path: string;
      /** Third-party bytes matching neither the before nor the expected-after state. */
      readonly bytes: Uint8Array;
    }
  | {
      readonly area: "private_trash";
      /** Foreign bytes written over the single private managed-trash entry. */
      readonly bytes: Uint8Array;
    };

export interface RunRecoveryInterferenceScenarioOptions {
  readonly profile: MutationCorpusProfile;
  readonly seed: string;
  readonly reportDir: string;
  /** Recovery-path crash point armed on generation 2 (parks mid-startup-recovery). */
  readonly recoveryParkPoint: string;
  /** Third-party footprint mutation applied while generation 2 is parked. */
  readonly interference: RecoveryInterference;
}

/**
 * Recovery-interference scenario (issue #194). See the section header above for
 * the generation choreography. The machine oracle is byte-exact: after both
 * post-interference generations, the interfered footprint must still hold the
 * exact third-party bytes (compare-before-restore never overwrote them), every
 * other profile file must be byte-identical to its parked-mid-recovery state
 * (a failed-closed recovery writes nothing), the proof must be
 * `result_unproven`, the effective gate must be `recovery_blocked`, the
 * sentinel write must stay rejected, and all of that must survive the gen-4
 * restart unchanged.
 */
export async function runMutationCorpusRecoveryInterferenceScenario(
  options: RunRecoveryInterferenceScenarioOptions,
): Promise<CorpusScenarioEvidence> {
  const { profile, seed } = options;
  const failures: string[] = [];
  const phases: string[] = [];
  const log = (message: string): void => {
    phases.push(message);
  };

  if (!isRecoveryParkPoint(options.recoveryParkPoint)) {
    throw new Error(`${options.recoveryParkPoint} is not a recovery-path park point`);
  }

  await mkdir(options.reportDir, { recursive: true });
  const reportPath = join(options.reportDir, `${seed}.json`);
  const vaultId = `corpus-${seed}`;
  const root = await mkdtemp(join(tmpdir(), `corpus-${profile.label}-interference-`));
  const port = await pickAvailablePort();
  const controlBase = await mkdtemp(join(tmpdir(), "corpus-interference-control-"));
  const crashPoint: MutationCorpusCrashPoint = {
    point: options.recoveryParkPoint,
    phase: "rollback",
  };
  const evidence = createEvidence(
    { profile, crashPoint, seed, root, vaultId, port, reportPath },
    failures,
  );
  const writeEvidence = async (): Promise<void> => {
    await mkdir(dirname(reportPath), { recursive: true });
    await writeFile(reportPath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  };

  const interleaving: string[] = [];
  const generations: CorpusRecoveryGenerationEvidence[] = [];
  let conflict: CorpusConflictRecord | null = null;
  let admission: CorpusRecoveryInterferenceEvidence["admissionDuringRecovery"] = {
    attempted: false,
    reachable: false,
    admitted: false,
    gate: null,
  };
  const parkedBytes = new Map<string, Uint8Array | null>();
  const sentinelNotes: string[] = [];

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
    const submissionKey = profile.submissionKey(seed);

    // ---- Generation 1: durable PREPARED + fully applied state --------------
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
    interleaving.push(...(await readChildEventLog(gen1Control, 1)));
    interleaving.push("supervisor: terminated generation 1 at the rollback lead-in");
    log("generation 1 terminated by supervisor");

    // ---- Validate and declare the interference ------------------------------
    const interference = options.interference;
    let conflictFixture: MutationCorpusFileFixture | undefined;
    if (interference.area === "public") {
      conflictFixture = profile.files.find(({ path }) => path === interference.path);
      if (conflictFixture === undefined) {
        throw new Error(`interference path ${interference.path} is not a profile file`);
      }
      if (
        bytesEqual(interference.bytes, conflictFixture.originalBytes) ||
        (conflictFixture.committedBytes !== null &&
          bytesEqual(interference.bytes, conflictFixture.committedBytes))
      ) {
        throw new Error("interference bytes must differ from both original and committed bytes");
      }
    } else {
      conflictFixture = profile.files.find(({ path }) => path === profile.primaryPath);
      if (conflictFixture === undefined) {
        throw new Error(`profile ${profile.label} has no primary-path fixture`);
      }
    }

    // ---- Generation 2: park *inside* startup recovery -----------------------
    log(`generation 2: armed recovery park point ${options.recoveryParkPoint}`);
    const gen2Control = join(controlBase, "gen2");
    const gen2 = spawnOwningProcess({
      bundle,
      root,
      vaultId,
      port,
      controlDir: gen2Control,
      crashPoint: options.recoveryParkPoint,
    });
    const gen2Marker = await waitForControlMarker(
      gen2,
      ["ready", "parked", "failed"],
      profile.timeoutMs,
    );
    if (gen2Marker === null || gen2Marker.kind !== "parked") {
      failures.push(
        `recovery park point ${options.recoveryParkPoint} was never reached in generation 2: ${JSON.stringify(gen2Marker)}; stderr: ${gen2.stderr.join("\n")}`,
      );
      await terminateChild(gen2);
      throw new Error("recovery park point was never reached");
    }
    evidence.boundary = await observeBoundary(root, profile);
    log(
      `generation 2 parked inside recovery at ${options.recoveryParkPoint}; boundary ${describeBoundary(evidence.boundary)}`,
    );
    if (evidence.boundary.journalPhase !== "PREPARED") {
      failures.push(
        `expected the durable PREPARED frame to remain unresolved while recovery is parked but observed ${String(evidence.boundary.journalPhase)}`,
      );
    }
    const modeledParkPoint = profile.crashPoints.find(
      (candidate) => candidate.phase === "rollback" && candidate.point === options.recoveryParkPoint,
    );
    if (modeledParkPoint !== undefined) {
      const parkFailures = await boundaryFailures(
        root,
        evidence.boundary,
        profile.expectedBoundary(modeledParkPoint),
        profile,
      );
      if (parkFailures.length > 0) {
        failures.push(`parked recovery boundary mismatch at ${options.recoveryParkPoint}: ${parkFailures.join("; ")}`);
      }
    }
    for (const file of profile.files) {
      parkedBytes.set(file.path, await readPathBytes(root, file.path));
    }
    interleaving.push(...(await readChildEventLog(gen2Control, 2)));

    // While recovery is parked, no new Change Set mutation may begin: the
    // Bridge exposes no write surface until recovery resolves, and a reachable
    // surface must reject the probe with recovery_in_progress.
    admission = await probeAdmissionDuringRecovery(port, vaultId, profile, seed);
    interleaving.push(
      `supervisor: probed Change Set admission during recovery (reachable=${admission.reachable}, admitted=${admission.admitted}, gate=${String(admission.gate)})`,
    );
    if (admission.admitted) {
      failures.push("a new Change Set was admitted while startup recovery was in progress");
    }
    if (admission.reachable && admission.gate !== "recovery_in_progress") {
      failures.push(
        `expected recovery_in_progress to reject the admission probe but observed gate ${String(admission.gate)}`,
      );
    }

    // Apply the third-party interference while generation 2 is parked.
    if (interference.area === "public") {
      const absolute = join(root, ...interference.path.split("/"));
      await mkdir(dirname(absolute), { recursive: true });
      await writeFile(absolute, interference.bytes);
      interleaving.push(
        `supervisor: wrote third-party bytes over ${interference.path} while recovery was parked`,
      );
      conflict = {
        area: "public",
        path: interference.path,
        observedSha256: await sha256(interference.bytes),
        beforeSha256:
          conflictFixture.originalBytes === null ? null : await sha256(conflictFixture.originalBytes),
        expectedAfterSha256:
          conflictFixture.committedBytes === null ? null : await sha256(conflictFixture.committedBytes),
        matchesBefore: false,
        matchesExpectedAfter: false,
      };
    } else {
      const trashFiles = await listPrivateAreaFiles(root, "trash");
      if (trashFiles.length !== 1) {
        throw new Error(
          `private-trash interference requires exactly one managed-trash entry but found ${trashFiles.length}`,
        );
      }
      const trashDirectory = join(root, BRIDGE_STATE_DIRECTORY, "trash");
      await writeFile(join(trashDirectory, ...trashFiles[0]!.split("/")), interference.bytes);
      interleaving.push(
        "supervisor: replaced the private managed-trash bytes while recovery was parked",
      );
      conflict = {
        area: "private_trash",
        path: profile.primaryPath,
        observedSha256: await sha256(interference.bytes),
        beforeSha256:
          conflictFixture.originalBytes === null ? null : await sha256(conflictFixture.originalBytes),
        expectedAfterSha256:
          conflictFixture.committedBytes === null ? null : await sha256(conflictFixture.committedBytes),
        matchesBefore: false,
        matchesExpectedAfter: false,
      };
    }
    log("supervisor applied third-party interference; terminating generation 2");
    await terminateChild(gen2);
    interleaving.push("supervisor: terminated generation 2 mid-recovery");

    // ---- Generations 3 and 4: fail closed, and keep failing closed ----------
    for (const generation of [3, 4] as const) {
      log(`generation ${generation}: startup recovery over third-party state`);
      const genControl = join(controlBase, `gen${generation}`);
      const child = spawnOwningProcess({
        bundle,
        root,
        vaultId,
        port,
        controlDir: genControl,
      });
      const marker = await waitForControlMarker(child, ["ready", "parked", "failed"], profile.timeoutMs);
      if (marker === null || marker.kind !== "ready") {
        failures.push(
          `generation ${generation} did not become ready after unproven recovery: ${JSON.stringify(marker)}; stderr: ${child.stderr.join("\n")}`,
        );
        await terminateChild(child);
        throw new Error(`generation ${generation} did not become ready`);
      }
      interleaving.push(...(await readChildEventLog(genControl, generation)));
      log(`generation ${generation} ready after startup recovery`);

      const client = await connectClient(new URL(`http://127.0.0.1:${port}/mcp`), vaultId);
      const gate = await healthSnapshot(client);
      const proofState = await statusProofState(client, submissionKey);
      const sentinel = await submitSentinelDetailed(client, profile, seed, `gen${generation}`);
      sentinelNotes.push(sentinel.note);
      generations.push({
        generation,
        proofState,
        effectiveGate: gate.effectiveGate,
        recoveryState: gate.recoveryState,
        writeGate: gate.writeGate,
        sentinel: sentinel.observation,
      });
      log(
        `generation ${generation}: proof ${String(proofState)}; effective gate ${String(gate.effectiveGate)}; sentinel admitted=${sentinel.observation.admitted} gate=${String(sentinel.observation.gate)}`,
      );
      if (generation === 3) {
        evidence.gate = gate;
        evidence.proofState = proofState;
        evidence.sentinel = {
          submitted: sentinel.submitted,
          applied: sentinel.observation.admitted,
        };
      }
      if (proofState !== "result_unproven") {
        failures.push(
          `expected result_unproven in generation ${generation} after third-party interference but observed ${String(proofState)}`,
        );
      }
      if (gate.effectiveGate !== "recovery_blocked") {
        failures.push(
          `expected effective gate recovery_blocked in generation ${generation} but observed ${String(gate.effectiveGate)}`,
        );
      }
      if (gate.writeGate !== "blocked") {
        failures.push(
          `expected the Vault-wide write gate to be blocked in generation ${generation} but observed ${String(gate.writeGate)}`,
        );
      }
      if (sentinel.observation.admitted) {
        failures.push(
          `sentinel Change Set was admitted in generation ${generation} despite an unproven residue`,
        );
      }
      await client.close().catch(() => undefined);
      await terminateChild(child);
      await rm(join(root, sentinel.note), { force: true });
      interleaving.push(`supervisor: terminated generation ${generation}`);
    }

    // ---- Final disk evidence: not one third-party byte was overwritten ------
    evidence.after = await inventoryCorpus(root);
    evidence.fileFinal = await observeFinalFiles(root, profile);
    evidence.hidden = await observeHiddenSnapshot(root);

    if (conflict === null) {
      failures.push("no conflict record was produced");
    } else if (interference.area === "public") {
      const final = evidence.fileFinal.find(({ path }) => path === interference.path);
      if (final?.sha256 !== conflict.observedSha256) {
        failures.push(
          `third-party bytes at ${interference.path} were overwritten or removed by recovery`,
        );
      }
      if (final?.bytesMatchOriginal !== false || final?.bytesMatchCommitted !== false) {
        failures.push(
          `interfered footprint ${interference.path} was not reported as foreign state`,
        );
      }
    } else {
      // The tampered private copy must be preserved byte-for-byte: a failed
      // restore never destroys the private entry and never publishes it.
      if (
        evidence.hidden === null ||
        evidence.hidden.trashCount !== 1 ||
        !digestSetMatches(evidence.hidden.trashSha256s, [conflict.observedSha256 ?? ""])
      ) {
        failures.push(
          "the tampered private managed-trash entry was not preserved byte-for-byte",
        );
      }
      const publicFinal = evidence.fileFinal.find(({ path }) => path === profile.primaryPath);
      if (publicFinal === undefined || publicFinal.present) {
        failures.push("the tampered private trash bytes were published to the public footprint");
      }
    }
    for (const file of profile.files) {
      if (interference.area === "public" && file.path === interference.path) continue;
      const before = parkedBytes.get(file.path);
      const after = await readPathBytes(root, file.path);
      if (!bytesEqual(after ?? null, before ?? null)) {
        failures.push(
          `recovery mutated untouched footprint ${file.path} after a third-party conflict elsewhere`,
        );
      }
    }

    const expectedTerminal = new Map<string, MutationCorpusTerminalFileState>(
      profile.files.map((file) => [file.path, terminalStateForFile("result_unproven", file)]),
    );
    const expectedPresent = expectedPaths(profile, expectedTerminal);
    const privateResiduals = await privateAreaResidualPaths(
      root,
      redactsManagedTrashResiduals(profile),
    );
    evidence.residualPaths = [
      ...residualPaths(evidence.after, expectedPresent),
      ...privateResiduals,
    ].sort();
    if (interference.area === "public") {
      const residueReported = evidence.residualPaths.some(
        (entry) => entry === `file:${interference.path}`,
      );
      if (!residueReported) {
        failures.push(
          `third-party residue at ${interference.path} was not surfaced as a residual path`,
        );
      }
    }
    if (evidence.residualPaths.some((entry) => entry.startsWith("trash:"))) {
      failures.push("a private Managed-Trash path was surfaced as a residual path");
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!failures.includes(message)) failures.push(message);
  } finally {
    evidence.interference = {
      recoveryParkPoint: options.recoveryParkPoint,
      interleaving,
      conflict,
      admissionDuringRecovery: admission,
      generations,
    };
    try {
      await rm(root, { recursive: true, force: true });
      evidence.cleanup = { success: true, message: "scenario root removed by supervisor" };
    } catch (error) {
      evidence.cleanup = { success: false, message: String(error) };
    }
    await rm(controlBase, { recursive: true, force: true }).catch(() => undefined);
    if (!evidence.cleanup.success) failures.push(`cleanup failed: ${evidence.cleanup.message}`);
    evidence.phases = phases;
    evidence.verdict = failures.length === 0 ? "pass" : "fail";
    await writeEvidence();
  }
  return evidence as CorpusScenarioEvidence;
}

export interface RunAlreadyRestoredScenarioOptions {
  readonly profile: MutationCorpusProfile;
  readonly seed: string;
  readonly reportDir: string;
  /**
   * `crash_before_rolled_back` parks generation 2 after the rollback completed
   * but before the durable ROLLED_BACK write; `supervisor_restored` has the
   * supervisor itself return every public footprint to its exact before-state
   * while the Vault is down (a "helpful" third party).
   */
  readonly mode: "crash_before_rolled_back" | "supervisor_restored";
}

/**
 * Already-restored acceptance scenario (issue #194, spec A-22): when recovery
 * finds a footprint already at its before state it must accept it as already
 * restored, discard only the staged/hidden residue, persist ROLLED_BACK, and
 * converge to `intent_not_applied` without rewriting any public byte. The write
 * gate must be clean afterwards and the sentinel write must be admissible.
 */
export async function runMutationCorpusAlreadyRestoredScenario(
  options: RunAlreadyRestoredScenarioOptions,
): Promise<CorpusScenarioEvidence> {
  const { profile, seed } = options;
  const failures: string[] = [];
  const phases: string[] = [];
  const log = (message: string): void => {
    phases.push(message);
  };

  const crashPoint: MutationCorpusCrashPoint = {
    point: options.mode === "crash_before_rolled_back" ? "before_rolled_back" : "supervisor_restored",
    phase: "rollback",
  };
  await mkdir(options.reportDir, { recursive: true });
  const reportPath = join(options.reportDir, `${seed}.json`);
  const vaultId = `corpus-${seed}`;
  const root = await mkdtemp(join(tmpdir(), `corpus-${profile.label}-restored-`));
  const port = await pickAvailablePort();
  const controlBase = await mkdtemp(join(tmpdir(), "corpus-restored-control-"));
  const evidence = createEvidence(
    { profile, crashPoint, seed, root, vaultId, port, reportPath },
    failures,
  );
  const logAndPhase = log;
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
    logAndPhase(`before inventory recorded (${evidence.before.length} public entries)`);

    const leadInPoint = profile.crashPoints.find(
      (candidate) =>
        candidate.phase === "apply" && candidate.point === profile.rollbackLeadInPoint,
    );
    if (leadInPoint === undefined) {
      throw new Error(`profile ${profile.label} has no apply crash point ${profile.rollbackLeadInPoint}`);
    }
    const leadInBoundary = profile.expectedBoundary(leadInPoint);
    const submissionKey = profile.submissionKey(seed);

    // ---- Generation 1: durable PREPARED + fully applied state --------------
    logAndPhase(`generation 1: armed crash point ${profile.rollbackLeadInPoint}`);
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
    logAndPhase(`generation 1 parked; boundary ${describeBoundary(gen1Boundary)}`);
    const leadInFailures = await boundaryFailures(root, gen1Boundary, leadInBoundary, profile);
    if (leadInFailures.length > 0) {
      failures.push(`lead-in boundary mismatch: ${leadInFailures.join("; ")}`);
    }
    await terminateChild(gen1);
    logAndPhase("generation 1 terminated by supervisor");

    let recoveryGeneration = 2;
    if (options.mode === "crash_before_rolled_back") {
      const modeledPoint = profile.crashPoints.find(
        (candidate) => candidate.phase === "rollback" && candidate.point === "before_rolled_back",
      );
      if (modeledPoint === undefined) {
        throw new Error(`profile ${profile.label} does not model before_rolled_back`);
      }
      // Generation 2 runs the rollback to completion but parks before the
      // durable ROLLED_BACK write: every public footprint already sits at its
      // before state while the journal still says PREPARED.
      logAndPhase("generation 2: armed recovery park point before_rolled_back");
      const gen2Control = join(controlBase, "gen2");
      const gen2 = spawnOwningProcess({
        bundle,
        root,
        vaultId,
        port,
        controlDir: gen2Control,
        crashPoint: "before_rolled_back",
      });
      const gen2Marker = await waitForControlMarker(
        gen2,
        ["ready", "parked", "failed"],
        profile.timeoutMs,
      );
      if (gen2Marker === null || gen2Marker.kind !== "parked") {
        failures.push(
          `recovery park point before_rolled_back was never reached: ${JSON.stringify(gen2Marker)}; stderr: ${gen2.stderr.join("\n")}`,
        );
        await terminateChild(gen2);
        throw new Error("recovery park point was never reached");
      }
      evidence.boundary = await observeBoundary(root, profile);
      logAndPhase(
        `generation 2 parked at before_rolled_back; boundary ${describeBoundary(evidence.boundary)}`,
      );
      if (evidence.boundary.journalPhase !== "PREPARED") {
        failures.push(
          `expected the durable PREPARED frame to remain unresolved at before_rolled_back but observed ${String(evidence.boundary.journalPhase)}`,
        );
      }
      const parkFailures = await boundaryFailures(
        root,
        evidence.boundary,
        profile.expectedBoundary(modeledPoint),
        profile,
      );
      if (parkFailures.length > 0) {
        failures.push(`parked boundary mismatch at before_rolled_back: ${parkFailures.join("; ")}`);
      }
      await terminateChild(gen2);
      logAndPhase("generation 2 terminated by supervisor");
      recoveryGeneration = 3;
    } else {
      // A "helpful" third party returns every public footprint to its exact
      // before-state while the Vault is down.
      for (const file of profile.files) {
        const absolute = join(root, ...file.path.split("/"));
        if (file.originalBytes === null) {
          await rm(absolute, { force: true });
        } else {
          await mkdir(dirname(absolute), { recursive: true });
          await writeFile(absolute, file.originalBytes);
        }
      }
      logAndPhase("supervisor restored every public footprint to its exact before-state");
    }

    // ---- Final generation: already-restored acceptance ----------------------
    logAndPhase(`generation ${recoveryGeneration}: startup recovery over an already-restored state`);
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
    logAndPhase(`generation ${recoveryGeneration} ready after startup recovery`);

    // The durable ROLLED_BACK frame is the terminal proof the recovery journal
    // converged (spec §7.3: restored Semantic Evidence precedes ROLLED_BACK).
    // Read it before the sentinel write, which would otherwise append its own
    // COMMITTED frame as the newest one.
    const terminalJournalPhase = await readJournalPhase(root);
    if (terminalJournalPhase !== "ROLLED_BACK") {
      failures.push(
        `expected a durable ROLLED_BACK frame after already-restored recovery but observed ${String(terminalJournalPhase)}`,
      );
    }

    const client = await connectClient(new URL(`http://127.0.0.1:${port}/mcp`), vaultId);
    evidence.gate = await healthSnapshot(client);
    evidence.proofState = await statusProofState(client, submissionKey);
    logAndPhase(
      `proof state ${String(evidence.proofState)}; effective gate ${String(evidence.gate.effectiveGate)}; recovery ${String(evidence.gate.recoveryState)}`,
    );
    if (evidence.proofState !== "intent_not_applied") {
      failures.push(
        `expected intent_not_applied for an already-restored state but observed ${String(evidence.proofState)}`,
      );
    }
    if (evidence.gate.effectiveGate !== null) {
      failures.push(
        `expected a clean gate after already-restored recovery but observed ${String(evidence.gate.effectiveGate)}`,
      );
    }
    if (evidence.gate.recoveryState !== "none" && evidence.gate.recoveryState !== null) {
      failures.push(
        `unexpected recovery state ${String(evidence.gate.recoveryState)} after already-restored recovery`,
      );
    }

    // The sentinel write becomes admissible only now that recovery has reached
    // a trustworthy terminal outcome.
    logAndPhase("submitting sentinel Change Set");
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
    if (!evidence.sentinel.submitted || !evidence.sentinel.applied) {
      failures.push("sentinel Change Set was not admissible after already-restored recovery");
    }
    await client.close().catch(() => undefined);

    logAndPhase(`terminating generation ${recoveryGeneration}`);
    await terminateChild(finalChild);
    await rm(join(root, sentinelNote), { force: true });
    evidence.after = await inventoryCorpus(root);
    evidence.fileFinal = await observeFinalFiles(root, profile);
    evidence.hidden = await observeHiddenSnapshot(root);

    // Every public footprint must hold its exact before-state bytes (or stay
    // absent): recovery accepted the current state and rewrote nothing.
    const finalFailures = finalFileFailures(evidence.fileFinal, "intent_not_applied", profile);
    if (finalFailures.length > 0) failures.push(...finalFailures);

    // Staged residue must be discarded by the already-restored acceptance; a
    // Managed-Trash profile must also eliminate every private trash entry.
    if (evidence.hidden !== null && evidence.hidden.stagingCount !== 0) {
      failures.push(
        `expected the staging area to be empty after already-restored recovery but observed ${evidence.hidden.stagingCount} entr${evidence.hidden.stagingCount === 1 ? "y" : "ies"}`,
      );
    }
    const expectedHidden = profile.expectedHiddenState?.("intent_not_applied");
    if (expectedHidden !== undefined && evidence.hidden !== null) {
      failures.push(
        ...hiddenStateFailures("hidden state after already-restored recovery", expectedHidden, evidence.hidden),
      );
    }

    const expectedTerminal = new Map<string, MutationCorpusTerminalFileState>(
      profile.files.map((file) => [file.path, terminalStateForFile("intent_not_applied", file)]),
    );
    const expectedPresent = expectedPaths(profile, expectedTerminal);
    const privateResiduals = await privateAreaResidualPaths(
      root,
      redactsManagedTrashResiduals(profile),
    );
    evidence.residualPaths = [
      ...residualPaths(evidence.after, expectedPresent),
      ...privateResiduals,
    ].sort();
    if (evidence.residualPaths.length > 0) {
      failures.push(`residual paths remain after already-restored recovery: ${evidence.residualPaths.join(", ")}`);
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
    evidence.phases = phases;
    evidence.verdict = failures.length === 0 ? "pass" : "fail";
    await writeEvidence();
  }
  return evidence as CorpusScenarioEvidence;
}
