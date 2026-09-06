/**
 * Deterministic Semantic Evidence fault corpus (issue #193).
 *
 * This corpus is an *execution tracer*: it runs the real `ChangeSetService`
 * against a real node-filesystem Vault through the production test seams
 * (`NodeFileSystemChangeSetHostOptions.recordEvent`,
 * `beginSemanticEvidence`/`awaitSemanticEvidence`,
 * `ChangeSetSemanticProbes.cacheVisible`/`referenced`, and
 * `publishSearchSnapshot`), with the real
 * `createChangeSetSemanticEvidenceTracker`, the real `SearchSnapshotManager`,
 * and the real `SearchSnapshotRefreshCoordinator` (250 ms quiet window)
 * underneath. A deterministic, monotonically ordered *evidence schedule*
 * decides which host callbacks, cache observations, probe outcomes, and
 * quiet-window transitions the runtime observes and when.
 *
 * The proof obligation (PR #28 §7.3/§8.3/§12.4–§12.6, A-27–A-29, A-38, A-44):
 * delayed, reordered, stale, missing, contradictory, mismatched, or timed-out
 * Semantic Evidence can never turn raw filesystem mutation into reported
 * success. Stale or mismatched evidence is only ever diagnostically ignored;
 * only exact final bytes, the required events/postconditions, the closure
 * predicates, an uninterrupted quiet window, the successor Search Snapshot,
 * and a durable `COMMITTED` permit `intent_applied`. Every failed barrier
 * enters rollback: exact restoration with restored evidence yields
 * `intent_not_applied`; contrary third-party state or failed restoration
 * yields `result_unproven` and blocks writes.
 *
 * The semantic-evidence tracker runs on an injected monotonic virtual clock so
 * the installed 5,000 ms evidence deadline
 * (`CHANGE_SET_SEMANTIC_EVIDENCE_DEADLINE_MS`) is exercised exactly (a timed-out
 * session must elapse precisely 5,000 virtual ms) without wall-clock cost. The
 * Search Snapshot success barrier mirrors
 * `ManagedVaultBridgeRuntime.publishSuccessorSearchSnapshot` semantics (target
 * Content-Version binding, stale-semantic rejection, move closure predicates,
 * quiet-window waits over the real coordinator) with the same installed
 * 5,000 ms deadline (`SEMANTIC_SUCCESS_BARRIER_DEADLINE_MS`); the deterministic
 * schedule stands in for the wall-clock wait between host signals, so an
 * exhausted schedule means the installed deadline elapsed without convergence.
 *
 * The scheduler fails the scenario when an expected callback/event/probe is
 * not observed, is observed more often than declared, or reaches the wrong
 * Change Set. Reports follow the crash-corpus-runner shape (evidence schedule,
 * accepted/rejected evidence identities, quiet-window transitions,
 * inventory/checksums, proof state, gate state, cleanup, residual paths,
 * machine verdict) and never place note content in standard diagnostics —
 * only paths, SHA-256 digests, and Content Versions.
 */

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
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  BRIDGE_STATE_DIRECTORY_NAME,
  ChangeSetService,
  type ChangeSetRegistryState,
  type ChangeSetRuntimeStatePort,
  type ChangeSetSemanticEvent,
  type ChangeSetSemanticEvidenceRequest,
  type MoveSnapshotBarrier,
  type SearchSnapshotTargetEvidence,
} from "../change-set.js";
import { contentVersion } from "../content-version.js";
import { projectFrontmatter } from "../frontmatter-projector.js";
import {
  CHANGE_SET_SEMANTIC_EVIDENCE_DEADLINE_MS,
  createChangeSetSemanticEvidenceTracker,
  createFileSystemChangeSetExecutionAdapter,
  createNodeFileSystemChangeSetHost,
} from "../file-system-change-set-execution.js";
import { openRecoveryJournal } from "../recovery-journal.js";
import {
  SearchSnapshotManager,
  SearchSnapshotRefreshCoordinator,
  type SearchSnapshotDataSource,
} from "../search-snapshot.js";
import {
  seedCorpusRoot,
  terminalStateForFile,
  type MutationCorpusProfile,
  type MutationCorpusProofState,
} from "./crash-corpus-runner.js";
import {
  CREATE_NOTE_PATH,
  createNoteCorpusProfile,
} from "./create-note-corpus.js";
import { replaceExactCorpusProfile } from "./edit-body-corpus.js";
import {
  EXACT_COMMITTED_BYTES,
  EXACT_FIXTURE,
  EXACT_ORIGINAL_BYTES,
  FRONTMATTER_ORIGINAL_BYTES,
} from "./edit-fixtures.js";
import {
  TRASH_NOTE_PATH,
  trashNoteCorpusProfile,
} from "./managed-trash-corpus.js";
import {
  MOVE_DERIVED_A_PATH,
  MOVE_DERIVED_B_PATH,
  MOVE_DERIVED_FIXTURES,
  MOVE_DESTINATION_PATH,
  MOVE_SOURCE_PATH,
  moveNoteCorpusProfile,
} from "./move-note-corpus.js";
import { multiFrontmatterCorpusProfile } from "./multi-operation-corpus.js";

export const SEMANTIC_EVIDENCE_CORPUS = "semantic_evidence";

/**
 * The Search Snapshot success barrier shares the installed 5,000 ms evidence
 * deadline: production defaults `successBarrierTimeoutMs` to 5,000 in
 * `ManagedVaultBridgeRuntime`. The corpus barrier is schedule-driven, so the
 * deadline is modeled (and reported) rather than waited out in wall-clock
 * time; the tracker's identical installed deadline is exercised exactly on the
 * virtual clock.
 */
export const SEMANTIC_SUCCESS_BARRIER_DEADLINE_MS = 5_000;

const BRIDGE_JOURNAL_FILE = "recovery-journal.bin";

// ---------------------------------------------------------------------------
// Evidence schedule declaration.
// ---------------------------------------------------------------------------

/**
 * What the scheduler does with a host-emitted Vault event: deliver it to the
 * evidence tracker as soon as the host emits it, deliver it at a declared
 * virtual time (delayed/reordered cache callback), or drop it entirely
 * (missing required evidence).
 */
export type SemanticEventDisposition = "deliver" | "drop" | { readonly deliverAtMs: number };

export interface ExpectedHostEvent {
  readonly event: ChangeSetSemanticEvent;
  readonly disposition?: SemanticEventDisposition;
}

/** A synthetic callback injected at a virtual time (stale or wrong-path evidence). */
export interface InjectedSemanticEvent {
  readonly atMs: number;
  readonly event: ChangeSetSemanticEvent;
}

export interface ProbePoint {
  readonly probe: "cacheVisible" | "referenced";
  readonly path: string;
  readonly value: boolean;
}

export interface ProbeTransition extends ProbePoint {
  readonly atMs: number;
}

/**
 * Targeted-probe script for hidden trash and restore. Probes start at the
 * declared initial values (default `false`) and flip at monotonically
 * non-decreasing virtual times. Trash and restore never emit generic Vault
 * events (spec A-38), so these probes are their only Semantic Evidence.
 */
export interface ProbeScript {
  readonly initial?: readonly ProbePoint[];
  readonly transitions: readonly ProbeTransition[];
}

/**
 * One semantic observation of a Markdown path: the metadata-cache callback
 * either observes the exact current bytes ("fresh"), has no observation yet
 * ("none"), or reports a stale/foreign Content Version. `resolvedLinks` is the
 * reported reference-graph overlay for the path.
 */
export interface SemanticObservation {
  readonly path: string;
  readonly semantic: "fresh" | "none" | { readonly version: string };
  readonly resolvedLinks?: Readonly<Record<string, number>>;
}

/**
 * One scheduled round of the Search Snapshot success barrier: a host signal
 * after which republication may be attempted. `quietWindowResets` injects
 * mid-window contradictions (each one re-arms the 250 ms quiet window before
 * the build runs, so no publication may come from a window that was not
 * uninterrupted); `observations` replaces the metadata-cache overlay for the
 * build of this round.
 */
export interface EvidenceRound {
  readonly quietWindowResets?: number;
  readonly observations?: readonly SemanticObservation[];
}

/** Third-party bytes written over a public path when the apply evidence barrier fails. */
export interface ForeignWrite {
  readonly path: string;
  readonly bytes: Uint8Array;
}

export interface SemanticEvidenceSchedule {
  /**
   * Exact host Vault-event emissions the scenario expects, in emission order,
   * with the disposition of each. The runner fails when the host emits an
   * undeclared event, emits a declared event with a different identity, or
   * never emits a declared one.
   */
  readonly hostEvents: readonly ExpectedHostEvent[];
  /** Synthetic callbacks delivered to the tracker at virtual times. */
  readonly injections?: readonly InjectedSemanticEvent[];
  /** Stale callbacks delivered before any evidence session begins. */
  readonly preBeginEvents?: readonly ChangeSetSemanticEvent[];
  readonly probes?: ProbeScript;
  /**
   * Snapshot-barrier rounds for the apply/rollback phases (default: one clean
   * round). Rounds are consumed in order across the phase's targeted publish
   * calls; when the declared rounds are exhausted before the barrier matches,
   * the installed deadline is reported as reached. Declared rounds that are
   * never consumed fail the scenario (unobserved expected evidence).
   */
  readonly applyRounds?: readonly EvidenceRound[];
  readonly rollbackRounds?: readonly EvidenceRound[];
  /** Foreign bytes written over public paths as soon as the apply barrier fails. */
  readonly foreignWrites?: readonly ForeignWrite[];
}

export interface SemanticSessionExpectation {
  readonly mode: "apply" | "restore";
  readonly outcome: "converged" | "timed_out" | "not_awaited";
  /** When converged, the barrier must not have converged before this virtual time. */
  readonly convergedNotBeforeMs?: number;
}

export interface SemanticEvidenceExpectation {
  readonly proof: MutationCorpusProofState;
  readonly journal: "COMMITTED" | "ROLLED_BACK" | "FAILED";
  /** Evidence sessions of the scenario Change Set, in order. */
  readonly sessions: readonly SemanticSessionExpectation[];
  readonly writesBlocked: boolean;
  readonly sentinelApplied: boolean;
  /** A foreign residue must be surfaced as a residual path. */
  readonly residue: boolean;
  /**
   * `successor_matches_terminal`: the read-after snapshot is a newly published
   * successor whose every profile path sits at its terminal Content Version
   * (never stale, never partially mutated). `never_accepted`: no barrier round
   * was ever accepted, so success was never reported from failing evidence.
   */
  readonly snapshot: "successor_matches_terminal" | "never_accepted";
  /** Expected final-snapshot resolved-link graph per path. */
  readonly graph?: Readonly<Record<string, Readonly<Record<string, number>>>>;
  /** Total quiet-window resets that must have been injected. */
  readonly quietWindowResets?: number;
  /** Minimum number of diagnostically rejected barrier rounds. */
  readonly rejectionsMinimum?: number;
}

/** Derived-reference projection for `move` scenarios, declared from byte fixtures. */
export interface MoveDerivedEffectSpec {
  readonly operationId: string;
  readonly path: string;
  readonly originalBytes: Uint8Array;
  readonly committedBytes: Uint8Array;
  readonly referenceCount: number;
}

export interface SemanticEvidenceScenario {
  readonly id: string;
  readonly profile: MutationCorpusProfile;
  readonly schedule: SemanticEvidenceSchedule;
  readonly expect: SemanticEvidenceExpectation;
  /** Bound derived-reference closure for `move` profiles (issue #38 shape). */
  readonly moveDerivedEffects?: readonly MoveDerivedEffectSpec[];
}

// ---------------------------------------------------------------------------
// Report (never carries note content: paths, digests, and versions only).
// ---------------------------------------------------------------------------

export interface SemanticEvidenceInventoryEntry {
  readonly path: string;
  readonly kind: "file" | "directory";
  readonly bytes?: number;
  readonly sha256?: string;
}

export interface SemanticEventObservation {
  readonly seq: number;
  readonly event: ChangeSetSemanticEvent;
}

export interface SemanticDeliveryObservation {
  readonly seq: number;
  readonly atMs: number;
  readonly event: ChangeSetSemanticEvent;
  readonly disposition: "delivered" | "delayed" | "injected" | "dropped" | "ignored_no_session";
}

export interface SemanticProbeObservation {
  readonly seq: number;
  readonly atMs: number;
  readonly probe: "cacheVisible" | "referenced";
  readonly path: string;
  readonly result: boolean;
}

export interface SemanticSessionObservation {
  readonly mode: "apply" | "restore";
  readonly identity: string;
  readonly publicPaths: readonly string[];
  readonly hiddenTrash: boolean;
  readonly requiredEvents: readonly ChangeSetSemanticEvent[];
  readonly referenceBaselines: readonly { readonly path: string; readonly referenced: boolean }[];
  readonly awaited: boolean;
  readonly outcome: "converged" | "timed_out" | "failed" | "not_awaited";
  readonly beginAtMs: number;
  readonly virtualElapsedMs: number | null;
}

export interface QuietWindowObservation {
  readonly seq: number;
  readonly phase: "apply" | "rollback" | "sentinel";
  readonly targeted: boolean;
  readonly resets: number;
  readonly outcome: "matched" | "rejected" | "deadline" | "build_failed";
}

export interface SnapshotRejection {
  readonly path: string | null;
  readonly reason: string;
  readonly expected: string | null;
  readonly observed: string | null;
}

export interface SnapshotRoundObservation {
  readonly seq: number;
  readonly phase: "apply" | "rollback" | "sentinel";
  readonly matched: boolean;
  /** Evidence identities the barrier accepted (paths and Content Versions only). */
  readonly accepted: readonly { readonly path: string; readonly contentVersion: string }[];
  readonly rejections: readonly SnapshotRejection[];
}

export interface SemanticSnapshotEvidence {
  readonly version: number;
  readonly frozen: boolean;
  readonly notes: readonly {
    readonly path: string;
    readonly contentVersion: string;
    readonly semanticContentVersion: string | null;
    readonly resolvedLinks: Readonly<Record<string, number>>;
  }[];
}

export interface SemanticFileFinal {
  readonly path: string;
  readonly kind: "markdown" | "attachment";
  readonly present: boolean;
  readonly sha256: string | null;
  readonly contentVersion: string | null;
  readonly bytesMatchOriginal: boolean | null;
  readonly bytesMatchCommitted: boolean | null;
  readonly state: "original" | "committed" | "absent" | "other" | null;
}

/** Redacted Bridge-private hidden-state snapshot: counts and digests only (spec A-37). */
export interface SemanticHiddenSnapshot {
  readonly trashCount: number;
  readonly trashSha256s: readonly string[];
  readonly stagingCount: number;
  readonly stagingSha256s: readonly string[];
}

export interface SemanticEvidenceReport {
  readonly corpus: typeof SEMANTIC_EVIDENCE_CORPUS;
  readonly scenario: string;
  readonly mutationKind: string;
  readonly fixture: {
    readonly seed: string;
    readonly root: string;
    readonly vaultId: string;
    readonly primaryPath: string;
  };
  readonly deadlines: {
    readonly semanticEvidenceMs: number;
    readonly successBarrierMs: number;
  };
  readonly schedule: {
    readonly hostEvents: readonly ExpectedHostEvent[];
    readonly injections: readonly InjectedSemanticEvent[];
    readonly preBeginEvents: readonly ChangeSetSemanticEvent[];
    readonly probes: ProbeScript | null;
    readonly applyRounds: number;
    readonly rollbackRounds: number;
    readonly foreignWrites: readonly { readonly path: string; readonly sha256: string }[];
  };
  readonly observations: {
    readonly sessions: readonly SemanticSessionObservation[];
    readonly sentinelSessions: readonly { readonly mode: string; readonly identity: string }[];
    readonly sentinelEvents: readonly SemanticEventObservation[];
    readonly hostEvents: readonly SemanticEventObservation[];
    readonly deliveries: readonly SemanticDeliveryObservation[];
    readonly probePolls: readonly SemanticProbeObservation[];
    readonly quietWindows: readonly QuietWindowObservation[];
    readonly snapshotRounds: readonly SnapshotRoundObservation[];
  };
  readonly before: readonly SemanticEvidenceInventoryEntry[];
  readonly after: readonly SemanticEvidenceInventoryEntry[];
  readonly proofState: MutationCorpusProofState | null;
  readonly statusProofState: MutationCorpusProofState | null;
  readonly journalPhase: string | null;
  readonly fileFinal: readonly SemanticFileFinal[];
  readonly gate: {
    readonly writesBlockedFor: readonly string[];
    readonly sentinelSubmitted: boolean;
    readonly sentinelApplied: boolean;
  };
  readonly snapshot: SemanticSnapshotEvidence | null;
  readonly snapshotBaselineVersion: number;
  readonly hidden: SemanticHiddenSnapshot | null;
  readonly residualPaths: readonly string[];
  readonly cleanup: { readonly success: boolean; readonly message: string };
  readonly verdict: "pass" | "fail";
  readonly failures: readonly string[];
  readonly reportPath: string;
}

type Writable<T> = { -readonly [K in keyof T]: T[K] };

// ---------------------------------------------------------------------------
// Runner.
// ---------------------------------------------------------------------------

export interface RunSemanticEvidenceScenarioOptions {
  readonly scenario: SemanticEvidenceScenario;
  readonly reportDir: string;
}

async function sha256(bytes: Uint8Array): Promise<string> {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function bytesEqual(left: Uint8Array | null, right: Uint8Array | null): boolean {
  if (left === null || right === null) return left === right;
  return Buffer.from(left).equals(Buffer.from(right));
}

async function readPathBytes(root: string, path: string): Promise<Uint8Array | null> {
  try {
    return new Uint8Array(await readFile(join(root, ...path.split("/"))));
  } catch {
    return null;
  }
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
    if (entry.name === BRIDGE_STATE_DIRECTORY_NAME) continue;
    result.push(entry.name);
    if (entry.isDirectory()) {
      result.push(...(await listTree(absolute)).map((rel) => join(entry.name, rel)));
    }
  }
  return result;
}

function canonicalize(rel: string): string {
  return rel.split(/[\\/]/u).join("/");
}

async function inventoryVault(root: string): Promise<SemanticEvidenceInventoryEntry[]> {
  const relativePaths = await listTree(root);
  const entries: SemanticEvidenceInventoryEntry[] = [];
  for (const rel of relativePaths) {
    const absolute = join(root, rel);
    try {
      const value = await stat(absolute);
      const path = canonicalize(rel);
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
  const directory = join(root, BRIDGE_STATE_DIRECTORY_NAME, area);
  const rels = await listTree(directory);
  const files: string[] = [];
  for (const rel of rels) {
    try {
      const value = await stat(join(directory, rel));
      if (value.isFile()) files.push(canonicalize(rel));
    } catch {
      // Transiently unavailable; skip.
    }
  }
  return files.sort();
}

/** Redacted private-area snapshot: counts and digests only, never paths (spec A-37). */
async function observeHidden(root: string): Promise<SemanticHiddenSnapshot> {
  const digestArea = async (area: "staging" | "trash"): Promise<string[]> => {
    const directory = join(root, BRIDGE_STATE_DIRECTORY_NAME, area);
    const files = await listPrivateAreaFiles(root, area);
    const digests = await Promise.all(
      files.map(async (rel) =>
        sha256(new Uint8Array(await readFile(join(directory, ...rel.split("/")))))),
    );
    return digests.sort();
  };
  const trashSha256s = await digestArea("trash");
  const stagingSha256s = await digestArea("staging");
  return {
    trashCount: trashSha256s.length,
    trashSha256s,
    stagingCount: stagingSha256s.length,
    stagingSha256s,
  };
}

async function readJournalPhase(root: string): Promise<string | null> {
  const journalPath = join(root, BRIDGE_STATE_DIRECTORY_NAME, BRIDGE_JOURNAL_FILE);
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

class CorpusRegistryStore {
  state: ChangeSetRegistryState | undefined;

  async load(): Promise<unknown> {
    return structuredClone(this.state);
  }

  async save(state: ChangeSetRegistryState): Promise<void> {
    this.state = structuredClone(state);
  }
}

class CorpusRuntimeState implements ChangeSetRuntimeStatePort {
  readonly blocked: string[] = [];

  setQueue(): void {
    // Queue state is not part of this corpus's proof obligations.
  }

  blockWritesForUnproven(changeSetId: string): void {
    this.blocked.push(changeSetId);
  }
}

interface ScheduledDelivery {
  readonly atMs: number;
  readonly order: number;
  readonly event: ChangeSetSemanticEvent;
  readonly disposition: "delayed" | "injected";
}

interface MutableSession {
  readonly mode: "apply" | "restore";
  readonly identity: string;
  readonly publicPaths: readonly string[];
  readonly hiddenTrash: boolean;
  readonly requiredEvents: readonly ChangeSetSemanticEvent[];
  readonly referenceBaselines: readonly { readonly path: string; readonly referenced: boolean }[];
  awaited: boolean;
  outcome: "converged" | "timed_out" | "failed" | "not_awaited";
  readonly beginAtMs: number;
  virtualElapsedMs: number | null;
}

function sessionIdentity(request: ChangeSetSemanticEvidenceRequest): string {
  return request.operations
    .map((operation) => ("operationId" in operation ? String(operation.operationId) : "?"))
    .join(",");
}

function validateScheduleMonotonic(schedule: SemanticEvidenceSchedule, failures: string[]): void {
  const checkMonotonic = (label: string, times: readonly number[]): void => {
    for (let index = 1; index < times.length; index += 1) {
      if (times[index]! < times[index - 1]!) {
        failures.push(`schedule ${label} is not monotonically ordered at index ${index}`);
      }
    }
  };
  checkMonotonic(
    "injections",
    (schedule.injections ?? []).map(({ atMs }) => atMs),
  );
  checkMonotonic(
    "probe transitions",
    (schedule.probes?.transitions ?? []).map(({ atMs }) => atMs),
  );
}

/**
 * Run one deterministic Semantic Evidence scenario. The runner returns the
 * machine-readable report; `verdict` is `pass` only when every oracle check —
 * proof state, journal phase, evidence-session shape, strict schedule
 * accounting, quiet-window transitions, terminal bytes, snapshot read-after,
 * gate state, and residue policy — holds.
 */
export async function runSemanticEvidenceScenario(
  options: RunSemanticEvidenceScenarioOptions,
): Promise<SemanticEvidenceReport> {
  const { scenario } = options;
  const { profile, schedule } = scenario;
  const failures: string[] = [];
  const seed = `sev-${scenario.id.replace(/[^A-Za-z0-9_-]/gu, "_")}`;
  const vaultId = `corpus-${seed}`;
  await mkdir(options.reportDir, { recursive: true });
  const reportPath = join(options.reportDir, `${seed}.json`);
  const root = await mkdtemp(join(tmpdir(), `corpus-sev-${profile.label}-`));

  validateScheduleMonotonic(schedule, failures);

  // ---- scheduler state -----------------------------------------------------
  let virtualNow = 0;
  let seq = 0;
  const nextSeq = (): number => {
    seq += 1;
    return seq;
  };
  let phase: "apply" | "rollback" | "sentinel" = "apply";
  const sessions: MutableSession[] = [];
  const sentinelSessions: { mode: string; identity: string }[] = [];
  const sentinelEvents: SemanticEventObservation[] = [];
  const hostEvents: SemanticEventObservation[] = [];
  const deliveries: SemanticDeliveryObservation[] = [];
  const probePolls: SemanticProbeObservation[] = [];
  const quietWindows: QuietWindowObservation[] = [];
  const snapshotRounds: SnapshotRoundObservation[] = [];
  const pendingDeliveries: ScheduledDelivery[] = [];
  let trackerRecordCalls = 0;
  let currentSession: MutableSession | null = null;
  let foreignWritesRan = false;

  const probeScript = schedule.probes;
  const probeInitial = new Map<string, boolean>();
  for (const point of probeScript?.initial ?? []) {
    probeInitial.set(`${point.probe}:${point.path}`, point.value);
  }
  const probeValue = (probe: "cacheVisible" | "referenced", path: string): boolean => {
    let value = probeInitial.get(`${probe}:${path}`) ?? false;
    for (const transition of probeScript?.transitions ?? []) {
      if (transition.probe !== probe || transition.path !== path) continue;
      if (transition.atMs > virtualNow) break;
      value = transition.value;
    }
    return value;
  };
  const probe = async (
    which: "cacheVisible" | "referenced",
    path: string,
  ): Promise<boolean> => {
    const result = probeValue(which, path);
    probePolls.push({ seq: nextSeq(), atMs: virtualNow, probe: which, path, result });
    return result;
  };

  const tracker = createChangeSetSemanticEvidenceTracker({
    probes: {
      cacheVisible: (path) => probe("cacheVisible", path),
      referenced: (path) => probe("referenced", path),
    },
    now: () => virtualNow,
    delay: async (milliseconds: number) => {
      // The tracker's poll delay is the virtual-clock driver: every wait
      // advances the monotonic schedule and releases due callbacks.
      virtualNow += milliseconds;
      fireDueDeliveries();
    },
    publishSuccessorSearchSnapshot: () => barrier(undefined, undefined),
  });
  const trackerRecord = (event: ChangeSetSemanticEvent): void => {
    trackerRecordCalls += 1;
    tracker.record(event);
  };

  const fireDueDeliveries = (): void => {
    pendingDeliveries.sort((left, right) => left.atMs - right.atMs || left.order - right.order);
    while (pendingDeliveries.length > 0 && pendingDeliveries[0]!.atMs <= virtualNow) {
      const due = pendingDeliveries.shift()!;
      deliveries.push({
        seq: nextSeq(),
        atMs: virtualNow,
        event: due.event,
        disposition: due.disposition,
      });
      trackerRecord(due.event);
    }
  };

  // ---- snapshot data source with a scripted metadata-cache overlay ---------
  let overlays = new Map<string, SemanticObservation>();
  const dataSource: SearchSnapshotDataSource = {
    listMarkdownPaths: async () =>
      (await listTree(root)).map(canonicalize).filter((path) => path.endsWith(".md")).sort(),
    readBinary: (path) => readPathBytes(root, path),
    semanticEvidence: async (path) => {
      const bytes = await readPathBytes(root, path);
      if (bytes === null) return null;
      const overlay = overlays.get(path);
      const semantic = overlay?.semantic ?? "fresh";
      return {
        ...(semantic === "fresh"
          ? { contentVersion: contentVersion(bytes) }
          : semantic === "none"
            ? {}
            : { contentVersion: semantic.version }),
        frontmatter: null,
        tags: [],
        headings: [],
        references: [],
        resolvedLinks: { ...(overlay?.resolvedLinks ?? {}) },
        unresolvedLinks: {},
      };
    },
  };
  const snapshots = new SearchSnapshotManager(dataSource);
  const refresh = new SearchSnapshotRefreshCoordinator(snapshots);

  const runForeignWrites = async (): Promise<void> => {
    if (foreignWritesRan) return;
    foreignWritesRan = true;
    for (const write of schedule.foreignWrites ?? []) {
      const absolute = join(root, ...write.path.split("/"));
      await mkdir(dirname(absolute), { recursive: true });
      await writeFile(absolute, write.bytes);
    }
  };

  const matchBarrier = (
    targets: readonly SearchSnapshotTargetEvidence[] | undefined,
    moveBarrier: MoveSnapshotBarrier | undefined,
  ): { matched: boolean; rejections: SnapshotRejection[] } => {
    const rejections: SnapshotRejection[] = [];
    if (snapshots.readiness !== "ready") {
      return {
        matched: false,
        rejections: [
          { path: null, reason: "snapshot_not_ready", expected: null, observed: null },
        ],
      };
    }
    const currentNotes = snapshots.current()?.notes ?? [];
    const notes = new Map(currentNotes.map((note) => [note.path, note]));
    for (const target of targets ?? []) {
      const note = notes.get(target.path);
      if (note === undefined) {
        rejections.push({
          path: target.path,
          reason: "target_absent",
          expected: target.contentVersion,
          observed: null,
        });
        continue;
      }
      if (note.contentVersion !== target.contentVersion) {
        rejections.push({
          path: target.path,
          reason: "content_mismatch",
          expected: target.contentVersion,
          observed: note.contentVersion,
        });
        continue;
      }
      // A semantic observation for different bytes is stale/late and fails;
      // for a changed note, absence of any observation is not yet proof.
      if (target.requireSemanticMatch === true) {
        if (note.semanticContentVersion === undefined) {
          rejections.push({
            path: target.path,
            reason: "semantic_observation_missing",
            expected: target.contentVersion,
            observed: null,
          });
        } else if (note.semanticContentVersion !== target.contentVersion) {
          rejections.push({
            path: target.path,
            reason: "semantic_observation_stale",
            expected: target.contentVersion,
            observed: note.semanticContentVersion,
          });
        }
      } else if (
        note.semanticContentVersion !== undefined &&
        note.semanticContentVersion !== target.contentVersion
      ) {
        rejections.push({
          path: target.path,
          reason: "semantic_observation_stale",
          expected: target.contentVersion,
          observed: note.semanticContentVersion,
        });
      }
    }
    if (rejections.length > 0 || moveBarrier === undefined) {
      return { matched: rejections.length === 0, rejections };
    }
    if (notes.has(moveBarrier.absentPath)) {
      rejections.push({
        path: moveBarrier.absentPath,
        reason: "absent_path_present",
        expected: null,
        observed: notes.get(moveBarrier.absentPath)?.contentVersion ?? null,
      });
    }
    const present = notes.get(moveBarrier.presentPath);
    if (present?.contentVersion !== moveBarrier.presentVersion) {
      rejections.push({
        path: moveBarrier.presentPath,
        reason: "content_mismatch",
        expected: moveBarrier.presentVersion,
        observed: present?.contentVersion ?? null,
      });
    }
    for (const expected of moveBarrier.closure) {
      const note = notes.get(expected.path);
      if (note === undefined) {
        rejections.push({
          path: expected.path,
          reason: "closure_note_absent",
          expected: expected.contentVersion,
          observed: null,
        });
        continue;
      }
      if (note.contentVersion !== expected.contentVersion) {
        rejections.push({
          path: expected.path,
          reason: "closure_content_mismatch",
          expected: expected.contentVersion,
          observed: note.contentVersion,
        });
        continue;
      }
      const observedCount = note.resolvedLinks[expected.resolvedPath] ?? 0;
      if (observedCount !== expected.referenceCount) {
        rejections.push({
          path: expected.path,
          reason: "closure_reference_mismatch",
          expected: `${expected.resolvedPath}×${expected.referenceCount}`,
          observed: `${expected.resolvedPath}×${observedCount}`,
        });
        continue;
      }
      if (
        Object.keys(note.resolvedLinks).some(
          (path) =>
            (path === moveBarrier.presentPath || path === moveBarrier.absentPath) &&
            path !== expected.resolvedPath,
        )
      ) {
        rejections.push({
          path: expected.path,
          reason: "closure_foreign_reference",
          expected: expected.resolvedPath,
          observed: Object.keys(note.resolvedLinks).sort().join(","),
        });
      }
    }
    return { matched: rejections.length === 0, rejections };
  };

  // Round cursors are per phase: declared rounds are consumed in order by
  // every publish call of that phase (targeted and untargeted alike), and an
  // exhausted schedule means the installed barrier deadline elapsed without
  // convergent evidence. Targeted publishes in the apply/rollback phases must
  // always have declared rounds (implicit rounds could otherwise retry
  // forever); untargeted publishes and the sentinel phase get implicit clean
  // rounds when the phase is undeclared.
  let applyRoundCursor = 0;
  let rollbackRoundCursor = 0;
  const nextRound = (targeted: boolean): EvidenceRound | undefined => {
    if (phase === "sentinel") return {};
    const declared = phase === "apply" ? schedule.applyRounds : schedule.rollbackRounds;
    if (declared === undefined) return targeted ? undefined : {};
    if (phase === "apply") {
      if (applyRoundCursor >= declared.length) return undefined;
      const round = declared[applyRoundCursor];
      applyRoundCursor += 1;
      return round;
    }
    if (rollbackRoundCursor >= declared.length) return undefined;
    const round = declared[rollbackRoundCursor];
    rollbackRoundCursor += 1;
    return round;
  };

  /**
   * Successor-snapshot barrier with the exact accept/reject semantics of
   * `ManagedVaultBridgeRuntime.publishSuccessorSearchSnapshot`, over the real
   * quiet-window coordinator. Scheduled rounds stand in for the wall-clock
   * wait between host signals: each round is one host signal (a window plus a
   * build); when the declared rounds are exhausted the installed barrier
   * deadline is reported as reached.
   */
  const barrier = async (
    targets: readonly SearchSnapshotTargetEvidence[] | undefined,
    moveBarrier: MoveSnapshotBarrier | undefined,
  ): Promise<void> => {
    const targeted = targets !== undefined || moveBarrier !== undefined;
    while (true) {
      const round = nextRound(targeted);
      if (round === undefined) {
        quietWindows.push({ seq: nextSeq(), phase, targeted, resets: 0, outcome: "deadline" });
        // The installed deadline elapsed without convergent evidence. A
        // declared third-party write lands now so rollback must fail closed
        // over contrary state (spec A-22).
        if (phase === "apply") await runForeignWrites();
        throw new Error("Successor Search Snapshot target evidence did not match");
      }
      const resets = round.quietWindowResets ?? 0;
      refresh.schedule();
      for (let index = 0; index < resets; index += 1) {
        // A mid-window contradiction re-arms the quiet window before the
        // build; no publication may come from an interrupted window.
        refresh.schedule();
      }
      overlays = new Map(
        (round.observations ?? []).map((observation) => [observation.path, observation]),
      );
      try {
        await refresh.whenIdle();
      } catch {
        quietWindows.push({ seq: nextSeq(), phase, targeted, resets, outcome: "build_failed" });
        continue;
      }
      const verdict = matchBarrier(targets, moveBarrier);
      quietWindows.push({
        seq: nextSeq(),
        phase,
        targeted,
        resets,
        outcome: verdict.matched ? "matched" : "rejected",
      });
      const accepted: { path: string; contentVersion: string }[] = [];
      if (verdict.matched) {
        for (const target of targets ?? []) {
          accepted.push({ path: target.path, contentVersion: target.contentVersion });
        }
        if (moveBarrier !== undefined) {
          accepted.push({
            path: moveBarrier.presentPath,
            contentVersion: moveBarrier.presentVersion,
          });
          for (const closure of moveBarrier.closure) {
            accepted.push({ path: closure.path, contentVersion: closure.contentVersion });
          }
        }
      }
      snapshotRounds.push({
        seq: nextSeq(),
        phase,
        matched: verdict.matched,
        accepted,
        rejections: verdict.rejections,
      });
      if (verdict.matched) return;
    }
  };

  // ---- evidence-session seams ---------------------------------------------
  const beginSemanticEvidence = async (
    request: ChangeSetSemanticEvidenceRequest,
  ): Promise<void> => {
    const identity = sessionIdentity(request);
    if (identity.includes("sentinel")) {
      sentinelSessions.push({ mode: request.mode, identity });
      tracker.begin(request);
      return;
    }
    if (request.mode === "restore") phase = "rollback";
    const session: MutableSession = {
      mode: request.mode,
      identity,
      publicPaths: request.publicPaths,
      hiddenTrash: request.hiddenTrash,
      requiredEvents: request.requiredEvents,
      referenceBaselines: [...(request.referenceBaselines ?? [])],
      awaited: false,
      outcome: "not_awaited",
      beginAtMs: virtualNow,
      virtualElapsedMs: null,
    };
    sessions.push(session);
    currentSession = session;
    tracker.begin(request);
  };

  const awaitSemanticEvidence = async (
    request: ChangeSetSemanticEvidenceRequest,
  ): Promise<void> => {
    const session = currentSession;
    if (session !== null) session.awaited = true;
    try {
      await tracker.await(request);
      if (session !== null) {
        session.outcome = "converged";
        session.virtualElapsedMs = virtualNow - session.beginAtMs;
      }
    } catch (error) {
      if (session !== null) {
        const message = error instanceof Error ? error.message : String(error);
        session.outcome = message.includes("timed out") ? "timed_out" : "failed";
        session.virtualElapsedMs = virtualNow - session.beginAtMs;
      }
      if (phase === "apply") await runForeignWrites();
      throw error;
    }
  };

  // ---- host event intake -----------------------------------------------------
  const recordEvent = (event: ChangeSetSemanticEvent): void => {
    const observationSeq = nextSeq();
    // The sentinel Change Set runs the same host wiring; its emissions are
    // accounted separately from the scenario Change Set under proof.
    if (phase === "sentinel") {
      sentinelEvents.push({ seq: observationSeq, event });
      tracker.record(event);
      return;
    }
    hostEvents.push({ seq: observationSeq, event });
    const declared = schedule.hostEvents[hostEvents.length - 1];
    if (declared === undefined) {
      failures.push(`host emitted an undeclared Vault event ${JSON.stringify(event)}`);
      trackerRecord(event);
      return;
    }
    if (JSON.stringify(declared.event) !== JSON.stringify(event)) {
      failures.push(
        `host event ${hostEvents.length} identity mismatch: expected ${JSON.stringify(declared.event)}, observed ${JSON.stringify(event)}`,
      );
    }
    const disposition = declared.disposition ?? "deliver";
    if (disposition === "drop") {
      deliveries.push({ seq: nextSeq(), atMs: virtualNow, event, disposition: "dropped" });
      return;
    }
    if (disposition === "deliver") {
      deliveries.push({ seq: nextSeq(), atMs: virtualNow, event, disposition: "delivered" });
      trackerRecord(event);
      return;
    }
    pendingDeliveries.push({
      atMs: disposition.deliverAtMs,
      order: observationSeq,
      event,
      disposition: "delayed",
    });
  };

  // ---- report scaffolding ----------------------------------------------------
  const report: Writable<SemanticEvidenceReport> = {
    corpus: SEMANTIC_EVIDENCE_CORPUS,
    scenario: scenario.id,
    mutationKind: profile.kind,
    fixture: { seed, root, vaultId, primaryPath: profile.primaryPath },
    deadlines: {
      semanticEvidenceMs: CHANGE_SET_SEMANTIC_EVIDENCE_DEADLINE_MS,
      successBarrierMs: SEMANTIC_SUCCESS_BARRIER_DEADLINE_MS,
    },
    schedule: {
      hostEvents: schedule.hostEvents,
      injections: schedule.injections ?? [],
      preBeginEvents: schedule.preBeginEvents ?? [],
      probes: schedule.probes ?? null,
      applyRounds: schedule.applyRounds?.length ?? 0,
      rollbackRounds: schedule.rollbackRounds?.length ?? 0,
      foreignWrites: [],
    },
    observations: {
      sessions: sessions as readonly SemanticSessionObservation[],
      sentinelSessions,
      sentinelEvents,
      hostEvents,
      deliveries,
      probePolls,
      quietWindows,
      snapshotRounds,
    },
    before: [],
    after: [],
    proofState: null,
    statusProofState: null,
    journalPhase: null,
    fileFinal: [],
    gate: { writesBlockedFor: [], sentinelSubmitted: false, sentinelApplied: false },
    snapshot: null,
    snapshotBaselineVersion: 0,
    hidden: null,
    residualPaths: [],
    cleanup: { success: false, message: "not attempted" },
    verdict: "fail",
    failures,
    reportPath,
  };

  const writeReport = async (): Promise<void> => {
    await mkdir(dirname(reportPath), { recursive: true });
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  };

  const runtimeState = new CorpusRuntimeState();
  const sentinelPath = `CorpusSentinel-${seed.replace(/[^A-Za-z0-9_-]/gu, "_")}.md`;

  try {
    await seedCorpusRoot(root, profile);
    report.before = await inventoryVault(root);

    const stateDirectory = join(root, BRIDGE_STATE_DIRECTORY_NAME);
    const host = await createNodeFileSystemChangeSetHost({
      basePath: root,
      stateDirectory,
      recordEvent,
      referenced: (path) => probe("referenced", path),
      beginSemanticEvidence,
      awaitSemanticEvidence,
      semanticEvidencePublishesSnapshot: true,
      publishSearchSnapshot: (targets, moveBarrier) => barrier(targets, moveBarrier),
    });
    const execution = await createFileSystemChangeSetExecutionAdapter({
      journalPath: join(stateDirectory, BRIDGE_JOURNAL_FILE),
      slotCapacity: 64 * 1024,
      host,
    });

    // Baseline snapshot (version 1) at the original Vault state.
    await snapshots.rebuild();
    report.snapshotBaselineVersion = snapshots.current()?.version ?? 0;

    const moveDerivedEffects = scenario.moveDerivedEffects;
    const store = new CorpusRegistryStore();
    let submissionOrdinal = 0;
    let scenarioChangeSetId = "";
    const service = await ChangeSetService.open({
      store,
      dataSource: {
        readBinary: (path) => readPathBytes(root, path),
        pathKind: async (path) => {
          try {
            const value = await stat(join(root, ...path.split("/")));
            return value.isDirectory() ? "directory" : value.isFile() ? "file" : null;
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
            throw error;
          }
        },
        isContained: async () => true,
        projectFrontmatter: async (bytes, changes) => projectFrontmatter(bytes, changes),
        ...(moveDerivedEffects === undefined
          ? {}
          : {
              projectMove: async () => ({
                derivedEffects: moveDerivedEffects.map((effect) => ({
                  operationId: effect.operationId,
                  path: effect.path,
                  targetVersion: contentVersion(effect.originalBytes),
                  projectedBytes: Uint8Array.from(effect.committedBytes),
                  referenceCount: effect.referenceCount,
                })),
              }),
            }),
      },
      execution,
      runtimeState,
      vaultId,
      createChangeSetId: () => {
        submissionOrdinal += 1;
        const id = `change-set-${seed}-${submissionOrdinal}`;
        if (submissionOrdinal === 1) scenarioChangeSetId = id;
        return id;
      },
    });

    // Stale callbacks that arrived before any evidence session begins must
    // never leak into a later barrier (`begin` resets the observation set).
    for (const event of schedule.preBeginEvents ?? []) {
      deliveries.push({
        seq: nextSeq(),
        atMs: virtualNow,
        event,
        disposition: "ignored_no_session",
      });
      trackerRecord(event);
    }
    // Synthetic callbacks (stale/wrong-path evidence) are released by the
    // virtual clock while a barrier waits.
    for (const injection of schedule.injections ?? []) {
      pendingDeliveries.push({
        atMs: injection.atMs,
        order: nextSeq(),
        event: injection.event,
        disposition: "injected",
      });
    }

    const submitInput = profile.buildSubmitInput(seed);
    const openGate = {
      vault: { writeGate: "open", writeState: "writable" } as const,
      effectiveGate: null,
    };
    const submitted = await service.submit(
      submitInput as Parameters<ChangeSetService["submit"]>[0],
      openGate,
    );
    const submittedState = (submitted as { changeSet?: { state?: string } }).changeSet?.state;
    report.proofState =
      submittedState === "intent_applied" ||
      submittedState === "intent_not_applied" ||
      submittedState === "result_unproven"
        ? submittedState
        : null;

    const status = await service.status(
      { submissionKey: profile.submissionKey(seed) } as Parameters<ChangeSetService["status"]>[0],
      openGate,
    );
    const statusState = (status as { changeSet?: { state?: string } }).changeSet?.state;
    report.statusProofState =
      statusState === "intent_applied" ||
      statusState === "intent_not_applied" ||
      statusState === "result_unproven"
        ? statusState
        : null;

    // The scenario's durable journal phase must be captured before the
    // sentinel write persists its own frame over the newest slot.
    report.journalPhase = await readJournalPhase(root);

    // ---- immediate read-after: the observed snapshot must be the successor --
    const current = snapshots.current();
    report.snapshot =
      current === undefined
        ? null
        : {
            version: current.version,
            frozen:
              Object.isFrozen(current) &&
              Object.isFrozen(current.notes) &&
              current.notes.every(
                (note) => Object.isFrozen(note) && Object.isFrozen(note.resolvedLinks),
              ),
            notes: current.notes.map((note) => ({
              path: note.path,
              contentVersion: note.contentVersion,
              semanticContentVersion: note.semanticContentVersion ?? null,
              resolvedLinks: { ...note.resolvedLinks },
            })),
          };

    // ---- sentinel write against the post-scenario gate -----------------------
    phase = "sentinel";
    const blocked = scenario.expect.writesBlocked;
    const sentinelSubmit = await service.submit(
      {
        submissionKey: profile.submissionKey(`${seed}-sentinel`),
        operations: [
          {
            operationId: `sentinel-${seed}`,
            kind: "create_note",
            path: sentinelPath,
            content: `# Sentinel ${seed}\n`,
            ifExists: "reject",
          },
        ],
      } as Parameters<ChangeSetService["submit"]>[0],
      blocked
        ? {
            vault: { writeGate: "open", writeState: "writable" } as const,
            effectiveGate: { code: "recovery_blocked" } as const,
          }
        : openGate,
    );
    const sentinelState = (sentinelSubmit as { changeSet?: { state?: string } }).changeSet?.state;
    report.gate = {
      writesBlockedFor: [...runtimeState.blocked],
      sentinelSubmitted: true,
      sentinelApplied: sentinelState === "intent_applied",
    };

    await execution.close?.();
    refresh.dispose();

    await rm(join(root, sentinelPath), { force: true });
    report.after = await inventoryVault(root);
    report.hidden = await observeHidden(root);

    // ---- terminal file evidence ----------------------------------------------
    const finals: SemanticFileFinal[] = [];
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
      let fileState: SemanticFileFinal["state"] = null;
      if (bytes === null) fileState = "absent";
      else if (bytesMatchOriginal === true) fileState = "original";
      else if (bytesMatchCommitted === true) fileState = "committed";
      else fileState = "other";
      finals.push({
        path: file.path,
        kind: file.kind ?? "markdown",
        present: bytes !== null,
        sha256: bytes === null ? null : await sha256(bytes),
        contentVersion:
          file.kind !== "attachment" && bytes !== null ? contentVersion(bytes) : null,
        bytesMatchOriginal,
        bytesMatchCommitted,
        state: fileState,
      });
    }
    report.fileFinal = finals;

    // Residual paths: public content matching neither the exact original nor
    // the exact committed state, undeclared public paths, and private staging
    // residue. Private trash paths are redacted (counts/digests only, A-37).
    const declaredPaths = new Set(profile.files.map(({ path }) => path));
    const foreignResiduals: string[] = [];
    for (const final of finals) {
      if (!final.present) continue;
      if (final.bytesMatchOriginal !== true && final.bytesMatchCommitted !== true) {
        foreignResiduals.push(`file:${final.path}`);
      }
    }
    for (const entry of report.after) {
      if (entry.kind !== "file") continue;
      if (!declaredPaths.has(entry.path)) foreignResiduals.push(`file:${entry.path}`);
    }
    const stagingResiduals = (await listPrivateAreaFiles(root, "staging")).map(
      (rel) => `staging:${rel}`,
    );
    report.residualPaths = [...new Set([...foreignResiduals, ...stagingResiduals])].sort();

    report.schedule = {
      hostEvents: schedule.hostEvents,
      injections: schedule.injections ?? [],
      preBeginEvents: schedule.preBeginEvents ?? [],
      probes: schedule.probes ?? null,
      applyRounds: schedule.applyRounds?.length ?? 0,
      rollbackRounds: schedule.rollbackRounds?.length ?? 0,
      foreignWrites: await Promise.all(
        (schedule.foreignWrites ?? []).map(async (write) => ({
          path: write.path,
          sha256: await sha256(write.bytes),
        })),
      ),
    };

    // ---- oracle checks ---------------------------------------------------------
    const expect = scenario.expect;
    if (report.proofState !== expect.proof) {
      failures.push(
        `expected proof state ${expect.proof} but observed ${String(report.proofState)}`,
      );
    }
    if (report.statusProofState !== expect.proof) {
      failures.push(
        `status re-read expected ${expect.proof} but observed ${String(report.statusProofState)}`,
      );
    }
    if (report.journalPhase !== expect.journal) {
      failures.push(
        `expected durable journal phase ${expect.journal} but observed ${String(report.journalPhase)}`,
      );
    }

    // Evidence sessions: exact modes/outcomes, and every session identity
    // bound to this scenario's Change Set (a foreign Change Set's evidence
    // must never reach this barrier).
    if (sessions.length !== expect.sessions.length) {
      failures.push(
        `expected ${expect.sessions.length} evidence sessions but observed ${sessions.length}`,
      );
    }
    for (let index = 0; index < Math.min(sessions.length, expect.sessions.length); index += 1) {
      const observed = sessions[index]!;
      const expected = expect.sessions[index]!;
      if (observed.mode !== expected.mode || observed.outcome !== expected.outcome) {
        failures.push(
          `evidence session ${index}: expected ${expected.mode}/${expected.outcome} but observed ${observed.mode}/${observed.outcome}`,
        );
      }
      if (!observed.identity.includes(seed)) {
        failures.push(
          `evidence session ${index} reached the wrong Change Set: ${observed.identity}`,
        );
      }
      if (
        expected.outcome === "timed_out" &&
        observed.virtualElapsedMs !== CHANGE_SET_SEMANTIC_EVIDENCE_DEADLINE_MS
      ) {
        failures.push(
          `evidence session ${index} must expire at the installed ${CHANGE_SET_SEMANTIC_EVIDENCE_DEADLINE_MS} ms deadline but elapsed ${String(observed.virtualElapsedMs)} ms`,
        );
      }
      if (
        expected.outcome === "converged" &&
        expected.convergedNotBeforeMs !== undefined &&
        (observed.virtualElapsedMs ?? 0) < expected.convergedNotBeforeMs
      ) {
        failures.push(
          `evidence session ${index} converged at ${String(observed.virtualElapsedMs)} ms before the declared evidence arrived at ${expected.convergedNotBeforeMs} ms`,
        );
      }
    }

    // Strict schedule accounting: every declared host event observed exactly
    // once in order, no undeclared emissions, no declared delivery left
    // unfired, no unexpected callback reaching the tracker.
    if (hostEvents.length !== schedule.hostEvents.length) {
      failures.push(
        `expected ${schedule.hostEvents.length} host Vault events but observed ${hostEvents.length}`,
      );
    }
    if (pendingDeliveries.length > 0) {
      failures.push(`${pendingDeliveries.length} declared delayed callbacks were never delivered`);
    }
    const unconsumedApply =
      schedule.applyRounds === undefined ? 0 : schedule.applyRounds.length - applyRoundCursor;
    const unconsumedRollback =
      schedule.rollbackRounds === undefined
        ? 0
        : schedule.rollbackRounds.length - rollbackRoundCursor;
    if (unconsumedApply !== 0 || unconsumedRollback !== 0) {
      failures.push(
        `declared snapshot rounds were never observed (apply: ${unconsumedApply}, rollback: ${unconsumedRollback})`,
      );
    }
    const expectedDeliveries =
      (schedule.injections ?? []).length +
      (schedule.preBeginEvents ?? []).length +
      schedule.hostEvents.filter(({ disposition }) => disposition !== "drop").length;
    const actualDeliveries = deliveries.filter(({ disposition }) => disposition !== "dropped");
    if (actualDeliveries.length !== expectedDeliveries) {
      failures.push(
        `expected ${expectedDeliveries} tracker deliveries but observed ${actualDeliveries.length}`,
      );
    }
    if (trackerRecordCalls !== actualDeliveries.length) {
      failures.push(
        `tracker observed ${trackerRecordCalls} callbacks but the schedule delivered ${actualDeliveries.length}`,
      );
    }

    // Hidden trash and restore must use the targeted probes, never the generic
    // Vault events the runtime does not emit (spec A-38).
    const submitOperations = (submitInput as { operations?: readonly { kind?: string }[] })
      .operations;
    const expectsHidden = (submitOperations ?? []).some((operation) => operation.kind === "trash");
    if (expectsHidden) {
      const hiddenSession = sessions.find((session) => session.hiddenTrash);
      if (hiddenSession === undefined) {
        failures.push("a Managed-Trash Change Set did not declare hidden-trash evidence");
      } else {
        if (hiddenSession.requiredEvents.length > 0) {
          failures.push("hidden trash must not wait for generic Vault events");
        }
        if (
          hiddenSession.outcome !== "not_awaited" &&
          !probePolls.some((poll) => poll.atMs >= hiddenSession.beginAtMs)
        ) {
          failures.push("hidden-trash evidence converged without a targeted probe observation");
        }
      }
    }

    // Gate and sentinel.
    if (expect.writesBlocked) {
      if (!runtimeState.blocked.includes(scenarioChangeSetId)) {
        failures.push("writes were not blocked for the unproven Change Set");
      }
      if (report.gate.sentinelApplied) {
        failures.push("sentinel Change Set was admissible despite the blocked write gate");
      }
      if ((await readPathBytes(root, sentinelPath)) !== null) {
        failures.push("sentinel write mutated the Vault despite the blocked write gate");
      }
      if (sentinelSessions.length > 0) {
        failures.push("a blocked sentinel unexpectedly began an evidence session");
      }
    }
    // The sentinel's own host emissions are exactly its published create
    // event when it applied, and nothing when the gate blocked it.
    const expectedSentinelEvents =
      report.gate.sentinelApplied && !expect.writesBlocked
        ? [{ kind: "create", path: sentinelPath }]
        : [];
    if (
      JSON.stringify(sentinelEvents.map(({ event }) => event)) !==
      JSON.stringify(expectedSentinelEvents)
    ) {
      failures.push(
        `sentinel host events mismatch: expected ${JSON.stringify(expectedSentinelEvents)} but observed ${JSON.stringify(sentinelEvents.map(({ event }) => event))}`,
      );
    }
    if (expect.sentinelApplied !== report.gate.sentinelApplied) {
      failures.push(
        `expected sentinel applied=${expect.sentinelApplied} but observed ${report.gate.sentinelApplied}`,
      );
    }

    // Terminal bytes must be exact for proven outcomes.
    if (expect.proof !== "result_unproven") {
      for (const final of finals) {
        const fixture = profile.files.find(({ path }) => path === final.path)!;
        const terminal = terminalStateForFile(expect.proof, fixture);
        if (terminal === "absent") {
          if (final.present) failures.push(`public file ${final.path} should be absent`);
        } else if (terminal === "original" && final.bytesMatchOriginal !== true) {
          failures.push(`public file ${final.path} does not hold its exact original bytes`);
        } else if (terminal === "committed" && final.bytesMatchCommitted !== true) {
          failures.push(`public file ${final.path} does not hold its exact committed bytes`);
        }
      }
      // Managed-Trash profiles must end at the exact redacted hidden state
      // their proof implies (committed retains the Bridge-owned trash entries;
      // rolled back eliminates every private residue).
      const expectedHidden = profile.expectedHiddenState?.(expect.proof);
      if (expectedHidden !== undefined && report.hidden !== null) {
        if (
          report.hidden.trashCount !== expectedHidden.trashCount ||
          JSON.stringify(report.hidden.trashSha256s) !==
            JSON.stringify([...expectedHidden.trashSha256s].sort()) ||
          report.hidden.stagingCount !== expectedHidden.stagingCount ||
          report.hidden.stagingSha256s.length !== 0
        ) {
          failures.push("hidden Managed-Trash state does not match the expected terminal state");
        }
      }
    }

    // Residue policy.
    if (expect.residue && report.residualPaths.length === 0) {
      failures.push("expected a foreign residue to be surfaced but no residual path was reported");
    }
    if (!expect.residue && report.residualPaths.length > 0) {
      failures.push(`unexpected residual paths remain: ${report.residualPaths.join(", ")}`);
    }

    // Snapshot read-after: never stale, never partially mutated, immutable.
    if (report.snapshot === null) {
      failures.push("no Search Snapshot was observable at read-after");
    } else if (!report.snapshot.frozen) {
      failures.push("the observed Search Snapshot is not immutable");
    } else if (expect.snapshot === "successor_matches_terminal") {
      if (report.snapshot.version <= report.snapshotBaselineVersion) {
        failures.push(
          `read-after observed snapshot version ${report.snapshot.version}, not a successor of baseline ${report.snapshotBaselineVersion}`,
        );
      }
      const notesByPath = new Map(report.snapshot.notes.map((note) => [note.path, note]));
      for (const file of profile.files) {
        if (file.kind === "attachment") continue;
        const terminal = terminalStateForFile(expect.proof, file);
        const note = notesByPath.get(file.path);
        if (terminal === "absent") {
          if (note !== undefined) {
            failures.push(
              `snapshot still serves ${file.path} although its terminal state is absent`,
            );
          }
          continue;
        }
        const expectedVersion = contentVersion(
          (terminal === "committed" ? file.committedBytes : file.originalBytes)!,
        );
        if (note === undefined) {
          failures.push(`snapshot does not serve ${file.path} at its terminal state`);
        } else if (note.contentVersion !== expectedVersion) {
          failures.push(
            `snapshot serves ${file.path} at a non-terminal Content Version ${note.contentVersion}`,
          );
        }
      }
      for (const [path, links] of Object.entries(expect.graph ?? {})) {
        const note = notesByPath.get(path);
        if (note === undefined) {
          failures.push(`snapshot does not serve closure note ${path}`);
          continue;
        }
        if (JSON.stringify(note.resolvedLinks) !== JSON.stringify(links)) {
          failures.push(
            `snapshot closure for ${path}: expected ${JSON.stringify(links)} but observed ${JSON.stringify(note.resolvedLinks)}`,
          );
        }
      }
    } else if (quietWindows.some((window) => window.outcome === "matched")) {
      failures.push(
        "a Search Snapshot barrier accepted evidence even though no barrier was allowed to converge",
      );
    }

    if (
      expect.quietWindowResets !== undefined &&
      quietWindows.reduce((total, window) => total + window.resets, 0) !==
        expect.quietWindowResets
    ) {
      failures.push(
        `expected ${expect.quietWindowResets} quiet-window resets but observed ${quietWindows.reduce((total, window) => total + window.resets, 0)}`,
      );
    }
    if (
      expect.rejectionsMinimum !== undefined &&
      snapshotRounds.filter((round) => !round.matched).length < expect.rejectionsMinimum
    ) {
      failures.push(
        `expected at least ${expect.rejectionsMinimum} diagnostically rejected evidence rounds but observed ${snapshotRounds.filter((round) => !round.matched).length}`,
      );
    }

    // The report itself must never carry note content: paths, digests, and
    // Content Versions only.
    const serialized = JSON.stringify(report);
    for (const file of profile.files) {
      if (file.kind === "attachment") continue;
      for (const bytes of [file.originalBytes, file.committedBytes]) {
        if (bytes === null) continue;
        const text = Buffer.from(bytes).toString("utf8").replace(/^﻿/u, "");
        const probeText = text.slice(0, 24);
        if (probeText.length >= 16 && serialized.includes(probeText)) {
          failures.push(`report leaks note content from ${file.path}`);
        }
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!failures.includes(message)) failures.push(message);
  } finally {
    refresh.dispose();
    try {
      await rm(root, { recursive: true, force: true });
      report.cleanup = { success: true, message: "scenario root removed by supervisor" };
    } catch (error) {
      report.cleanup = { success: false, message: String(error) };
    }
    if (!report.cleanup.success) failures.push(`cleanup failed: ${report.cleanup.message}`);
    report.verdict = failures.length === 0 ? "pass" : "fail";
    await writeReport();
  }
  return report;
}

// ---------------------------------------------------------------------------
// Scenario declarations, grouped by mutation kind. Every scenario reuses the
// byte-exact profile fixtures of the process-crash corpus (issues #187–#191)
// and declares the deterministic evidence schedule the Primary Operator must
// see fail closed (or converge only on the exact convergence barrier).
// ---------------------------------------------------------------------------

const textEncoder = new TextEncoder();

const FOREIGN_OBSERVATION_BYTES = textEncoder.encode("# Foreign cache observation 你好 🚀\n");
const FOREIGN_OBSERVATION_VERSION = contentVersion(FOREIGN_OBSERVATION_BYTES);
const FOREIGN_NOTE_BYTES = textEncoder.encode("# Third-party interference\n\nForeign 你好 🚀\n");

const CLEAN_SESSION: readonly SemanticSessionExpectation[] = [
  { mode: "apply", outcome: "not_awaited" },
];

const APPLIED = "intent_applied";
const NOT_APPLIED = "intent_not_applied";
const UNPROVEN = "result_unproven";

// ---- create_note -----------------------------------------------------------

/** Control: exact final bytes + uninterrupted quiet window + successor snapshot + COMMITTED. */
export function createNoteCleanConvergence(): SemanticEvidenceScenario {
  return {
    id: "create_note/clean_convergence",
    profile: createNoteCorpusProfile(),
    schedule: {
      hostEvents: [{ event: { kind: "create", path: CREATE_NOTE_PATH } }],
      applyRounds: [{}],
    },
    expect: {
      proof: APPLIED,
      journal: "COMMITTED",
      sessions: CLEAN_SESSION,
      writesBlocked: false,
      sentinelApplied: true,
      residue: false,
      snapshot: "successor_matches_terminal",
    },
  };
}

/** A contradicted/reset quiet window must never publish from an interrupted window. */
export function createNoteQuietWindowReset(): SemanticEvidenceScenario {
  return {
    id: "create_note/quiet_window_reset",
    profile: createNoteCorpusProfile(),
    schedule: {
      hostEvents: [{ event: { kind: "create", path: CREATE_NOTE_PATH } }],
      applyRounds: [{ quietWindowResets: 2 }],
    },
    expect: {
      proof: APPLIED,
      journal: "COMMITTED",
      sessions: CLEAN_SESSION,
      writesBlocked: false,
      sentinelApplied: true,
      residue: false,
      snapshot: "successor_matches_terminal",
      quietWindowResets: 2,
    },
  };
}

/**
 * Stale-version cache callbacks after the newer raw bytes exist: a foreign
 * observation and a missing observation are diagnostically rejected; only the
 * exact final Content Version satisfies the barrier.
 */
export function createNoteStaleObservationsThenFresh(): SemanticEvidenceScenario {
  return {
    id: "create_note/stale_observations_then_fresh",
    profile: createNoteCorpusProfile(),
    schedule: {
      hostEvents: [{ event: { kind: "create", path: CREATE_NOTE_PATH } }],
      applyRounds: [
        {
          observations: [
            { path: CREATE_NOTE_PATH, semantic: { version: FOREIGN_OBSERVATION_VERSION } },
          ],
        },
        { observations: [{ path: CREATE_NOTE_PATH, semantic: "none" }] },
        {},
      ],
    },
    expect: {
      proof: APPLIED,
      journal: "COMMITTED",
      sessions: CLEAN_SESSION,
      writesBlocked: false,
      sentinelApplied: true,
      residue: false,
      snapshot: "successor_matches_terminal",
      rejectionsMinimum: 2,
    },
  };
}

/** A stale observation that never heals reaches the barrier deadline; rollback restores absence. */
export function createNoteStaleObservationDeadline(): SemanticEvidenceScenario {
  return {
    id: "create_note/stale_observation_deadline",
    profile: createNoteCorpusProfile(),
    schedule: {
      hostEvents: [{ event: { kind: "create", path: CREATE_NOTE_PATH } }],
      applyRounds: [
        {
          observations: [
            { path: CREATE_NOTE_PATH, semantic: { version: FOREIGN_OBSERVATION_VERSION } },
          ],
        },
      ],
      rollbackRounds: [{}],
    },
    expect: {
      proof: NOT_APPLIED,
      journal: "ROLLED_BACK",
      sessions: [...CLEAN_SESSION, { mode: "restore", outcome: "converged" }],
      writesBlocked: false,
      sentinelApplied: true,
      residue: false,
      snapshot: "successor_matches_terminal",
      rejectionsMinimum: 1,
    },
  };
}

// ---- edit_body (replace_exact) ----------------------------------------------

const EDIT_PATH = EXACT_FIXTURE.path;
const EDIT_ORIGINAL_VERSION = contentVersion(EXACT_ORIGINAL_BYTES);

/** A stale-version callback reporting the pre-edit Content Version is rejected; fresh converges. */
export function editBodyStaleVersionCallback(): SemanticEvidenceScenario {
  return {
    id: "edit_body/stale_version_callback_after_newer_bytes",
    profile: replaceExactCorpusProfile(),
    schedule: {
      hostEvents: [{ event: { kind: "create", path: EDIT_PATH } }],
      applyRounds: [
        { observations: [{ path: EDIT_PATH, semantic: { version: EDIT_ORIGINAL_VERSION } }] },
        {},
      ],
    },
    expect: {
      proof: APPLIED,
      journal: "COMMITTED",
      sessions: CLEAN_SESSION,
      writesBlocked: false,
      sentinelApplied: true,
      residue: false,
      snapshot: "successor_matches_terminal",
      rejectionsMinimum: 1,
    },
  };
}

/** A cache observation that never arrives fails closed at the barrier deadline and rolls back. */
export function editBodyMissingObservationDeadline(): SemanticEvidenceScenario {
  return {
    id: "edit_body/missing_observation_deadline",
    profile: replaceExactCorpusProfile(),
    schedule: {
      hostEvents: [
        { event: { kind: "create", path: EDIT_PATH } },
        { event: { kind: "create", path: EDIT_PATH } },
      ],
      applyRounds: [{ observations: [{ path: EDIT_PATH, semantic: "none" }] }],
      rollbackRounds: [{}],
    },
    expect: {
      proof: NOT_APPLIED,
      journal: "ROLLED_BACK",
      sessions: [...CLEAN_SESSION, { mode: "restore", outcome: "converged" }],
      writesBlocked: false,
      sentinelApplied: true,
      residue: false,
      snapshot: "successor_matches_terminal",
      rejectionsMinimum: 1,
    },
  };
}

/** A mid-window contradiction resets the quiet window and the round's stale observation is rejected. */
export function editBodyQuietWindowContradiction(): SemanticEvidenceScenario {
  return {
    id: "edit_body/quiet_window_contradiction",
    profile: replaceExactCorpusProfile(),
    schedule: {
      hostEvents: [{ event: { kind: "create", path: EDIT_PATH } }],
      applyRounds: [
        {
          quietWindowResets: 1,
          observations: [{ path: EDIT_PATH, semantic: { version: EDIT_ORIGINAL_VERSION } }],
        },
        {},
      ],
    },
    expect: {
      proof: APPLIED,
      journal: "COMMITTED",
      sessions: CLEAN_SESSION,
      writesBlocked: false,
      sentinelApplied: true,
      residue: false,
      snapshot: "successor_matches_terminal",
      quietWindowResets: 1,
      rejectionsMinimum: 1,
    },
  };
}

/**
 * Contrary third-party state after a failed barrier: rollback cannot prove
 * restoration over foreign bytes, so the Change Set fails closed as
 * `result_unproven`, writes are blocked, and the residue is surfaced.
 */
export function editBodyContraryThirdPartyBlocksWrites(): SemanticEvidenceScenario {
  return {
    id: "edit_body/contrary_third_party_blocks_writes",
    profile: replaceExactCorpusProfile(),
    schedule: {
      hostEvents: [{ event: { kind: "create", path: EDIT_PATH } }],
      applyRounds: [{ observations: [{ path: EDIT_PATH, semantic: "none" }] }],
      rollbackRounds: [],
      foreignWrites: [{ path: EDIT_PATH, bytes: FOREIGN_NOTE_BYTES }],
    },
    expect: {
      proof: UNPROVEN,
      journal: "FAILED",
      sessions: CLEAN_SESSION,
      writesBlocked: true,
      sentinelApplied: false,
      residue: true,
      snapshot: "never_accepted",
      rejectionsMinimum: 1,
    },
  };
}

// ---- edit_frontmatter (multi-operation) --------------------------------------

const MULTI_C_PATH = "Corpus/Multi/NoteC.md";
const MULTI_D_PATH = "Corpus/Multi/NoteD.md";
const MULTI_C_ORIGINAL_VERSION = contentVersion(EXACT_ORIGINAL_BYTES);
const MULTI_D_ORIGINAL_VERSION = contentVersion(FRONTMATTER_ORIGINAL_BYTES);

/**
 * Reordered cache callbacks across a two-file Change Set: the barrier rejects
 * every round where any path's observation is stale — including a flip-flop
 * where the earlier-fresh path regresses — and converges only when every
 * path's observation is exact simultaneously.
 */
export function multiFrontmatterReorderedCallbacks(): SemanticEvidenceScenario {
  return {
    id: "edit_multi_frontmatter/reordered_cache_callbacks",
    profile: multiFrontmatterCorpusProfile(),
    schedule: {
      hostEvents: [
        { event: { kind: "create", path: MULTI_C_PATH } },
        { event: { kind: "create", path: MULTI_D_PATH } },
      ],
      applyRounds: [
        {
          observations: [
            { path: MULTI_C_PATH, semantic: "fresh" },
            { path: MULTI_D_PATH, semantic: { version: MULTI_D_ORIGINAL_VERSION } },
          ],
        },
        {
          observations: [
            { path: MULTI_C_PATH, semantic: { version: MULTI_C_ORIGINAL_VERSION } },
            { path: MULTI_D_PATH, semantic: "fresh" },
          ],
        },
        {
          observations: [
            { path: MULTI_C_PATH, semantic: "fresh" },
            { path: MULTI_D_PATH, semantic: "fresh" },
          ],
        },
      ],
    },
    expect: {
      proof: APPLIED,
      journal: "COMMITTED",
      sessions: CLEAN_SESSION,
      writesBlocked: false,
      sentinelApplied: true,
      residue: false,
      snapshot: "successor_matches_terminal",
      rejectionsMinimum: 2,
    },
  };
}

// ---- move_note (derived-reference closure, issue #38 shape) -------------------

function moveDerivedEffects(): readonly MoveDerivedEffectSpec[] {
  return MOVE_DERIVED_FIXTURES.map(({ path, originalBytes, committedBytes }) => ({
    operationId: `derived/move/references/${path}`,
    path,
    originalBytes,
    committedBytes,
    referenceCount: 1,
  }));
}

const MOVE_RENAME_EVENT: ChangeSetSemanticEvent = {
  kind: "rename",
  oldPath: MOVE_SOURCE_PATH,
  path: MOVE_DESTINATION_PATH,
};

function moveApplyEvents(
  renameDisposition?: SemanticEventDisposition,
): readonly ExpectedHostEvent[] {
  return [
    { event: { kind: "create", path: MOVE_DERIVED_A_PATH } },
    { event: { kind: "create", path: MOVE_DERIVED_B_PATH } },
    { event: MOVE_RENAME_EVENT, ...(renameDisposition === undefined ? {} : { disposition: renameDisposition }) },
  ];
}

const MOVE_ROLLBACK_EVENTS: readonly ExpectedHostEvent[] = [
  { event: { kind: "rename", oldPath: MOVE_DESTINATION_PATH, path: MOVE_SOURCE_PATH } },
  { event: { kind: "create", path: MOVE_DERIVED_B_PATH } },
  { event: { kind: "create", path: MOVE_DERIVED_A_PATH } },
];

const MOVE_APPLIED_OBSERVATIONS: readonly SemanticObservation[] = [
  { path: MOVE_DESTINATION_PATH, semantic: "fresh" },
  {
    path: MOVE_DERIVED_A_PATH,
    semantic: "fresh",
    resolvedLinks: { [MOVE_DESTINATION_PATH]: 1 },
  },
  {
    path: MOVE_DERIVED_B_PATH,
    semantic: "fresh",
    resolvedLinks: { [MOVE_DESTINATION_PATH]: 1 },
  },
];

const MOVE_RESTORED_OBSERVATIONS: readonly SemanticObservation[] = [
  { path: MOVE_SOURCE_PATH, semantic: "fresh" },
  {
    path: MOVE_DERIVED_A_PATH,
    semantic: "fresh",
    resolvedLinks: { [MOVE_SOURCE_PATH]: 1 },
  },
  {
    path: MOVE_DERIVED_B_PATH,
    semantic: "fresh",
    resolvedLinks: { [MOVE_SOURCE_PATH]: 1 },
  },
];

/** Closure graph where Derived-A still resolves to the moved-away source path. */
const MOVE_STALE_GRAPH_OBSERVATIONS: readonly SemanticObservation[] = [
  { path: MOVE_DESTINATION_PATH, semantic: "fresh" },
  {
    path: MOVE_DERIVED_A_PATH,
    semantic: "fresh",
    resolvedLinks: { [MOVE_SOURCE_PATH]: 1 },
  },
  {
    path: MOVE_DERIVED_B_PATH,
    semantic: "fresh",
    resolvedLinks: { [MOVE_DESTINATION_PATH]: 1 },
  },
];

const MOVE_APPLIED_GRAPH: Readonly<Record<string, Readonly<Record<string, number>>>> = {
  [MOVE_DERIVED_A_PATH]: { [MOVE_DESTINATION_PATH]: 1 },
  [MOVE_DERIVED_B_PATH]: { [MOVE_DESTINATION_PATH]: 1 },
};

const MOVE_RESTORED_GRAPH: Readonly<Record<string, Readonly<Record<string, number>>>> = {
  [MOVE_DERIVED_A_PATH]: { [MOVE_SOURCE_PATH]: 1 },
  [MOVE_DERIVED_B_PATH]: { [MOVE_SOURCE_PATH]: 1 },
};

/** A delayed (but exact) rename callback still converges; the barrier waits for it. */
export function moveNoteDelayedRenameCallback(): SemanticEvidenceScenario {
  return {
    id: "move_note/delayed_rename_callback",
    profile: moveNoteCorpusProfile(),
    schedule: {
      hostEvents: moveApplyEvents({ deliverAtMs: 250 }),
      applyRounds: [
        { observations: MOVE_APPLIED_OBSERVATIONS },
        { observations: MOVE_APPLIED_OBSERVATIONS },
      ],
    },
    expect: {
      proof: APPLIED,
      journal: "COMMITTED",
      sessions: [{ mode: "apply", outcome: "converged", convergedNotBeforeMs: 250 }],
      writesBlocked: false,
      sentinelApplied: true,
      residue: false,
      snapshot: "successor_matches_terminal",
      graph: MOVE_APPLIED_GRAPH,
    },
    moveDerivedEffects: moveDerivedEffects(),
  };
}

/**
 * Stale and wrong-path callbacks are diagnostically ignored: a rename observed
 * before the barrier began and a rename for a different source path can never
 * satisfy the required event; convergence happens only when the exact rename
 * arrives.
 */
export function moveNoteStaleAndWrongPathCallbacksIgnored(): SemanticEvidenceScenario {
  return {
    id: "move_note/stale_and_wrong_path_callbacks_ignored",
    profile: moveNoteCorpusProfile(),
    schedule: {
      preBeginEvents: [MOVE_RENAME_EVENT],
      injections: [
        {
          atMs: 10,
          event: { kind: "rename", oldPath: "Corpus/Move/Wrong.md", path: MOVE_DESTINATION_PATH },
        },
      ],
      hostEvents: moveApplyEvents({ deliverAtMs: 20 }),
      applyRounds: [
        { observations: MOVE_APPLIED_OBSERVATIONS },
        { observations: MOVE_APPLIED_OBSERVATIONS },
      ],
    },
    expect: {
      proof: APPLIED,
      journal: "COMMITTED",
      sessions: [{ mode: "apply", outcome: "converged", convergedNotBeforeMs: 20 }],
      writesBlocked: false,
      sentinelApplied: true,
      residue: false,
      snapshot: "successor_matches_terminal",
      graph: MOVE_APPLIED_GRAPH,
    },
    moveDerivedEffects: moveDerivedEffects(),
  };
}

/**
 * A missing required Vault event fails closed at the installed 5,000 ms
 * evidence deadline; rollback restores the whole closure and the restored
 * evidence converges to `intent_not_applied`.
 */
export function moveNoteMissingRenameEventDeadline(): SemanticEvidenceScenario {
  return {
    id: "move_note/missing_rename_event_deadline",
    profile: moveNoteCorpusProfile(),
    schedule: {
      hostEvents: [...moveApplyEvents("drop"), ...MOVE_ROLLBACK_EVENTS],
      applyRounds: [],
      rollbackRounds: [
        { observations: MOVE_RESTORED_OBSERVATIONS },
        { observations: MOVE_RESTORED_OBSERVATIONS },
      ],
    },
    expect: {
      proof: NOT_APPLIED,
      journal: "ROLLED_BACK",
      sessions: [
        { mode: "apply", outcome: "timed_out" },
        { mode: "restore", outcome: "converged" },
      ],
      writesBlocked: false,
      sentinelApplied: true,
      residue: false,
      snapshot: "successor_matches_terminal",
      graph: MOVE_RESTORED_GRAPH,
    },
    moveDerivedEffects: moveDerivedEffects(),
  };
}

/** A closure graph mismatch is diagnostically rejected; the healed graph converges. */
export function moveNoteGraphMismatchThenConverged(): SemanticEvidenceScenario {
  return {
    id: "move_note/graph_mismatch_then_converged",
    profile: moveNoteCorpusProfile(),
    schedule: {
      hostEvents: moveApplyEvents(),
      applyRounds: [
        { observations: MOVE_APPLIED_OBSERVATIONS },
        { observations: MOVE_STALE_GRAPH_OBSERVATIONS },
        { observations: MOVE_APPLIED_OBSERVATIONS },
      ],
    },
    expect: {
      proof: APPLIED,
      journal: "COMMITTED",
      sessions: [{ mode: "apply", outcome: "converged" }],
      writesBlocked: false,
      sentinelApplied: true,
      residue: false,
      snapshot: "successor_matches_terminal",
      graph: MOVE_APPLIED_GRAPH,
      rejectionsMinimum: 1,
    },
    moveDerivedEffects: moveDerivedEffects(),
  };
}

/** A stale closure-note observation (pre-rewrite Content Version) is rejected; fresh converges. */
export function moveNoteStaleClosureObservation(): SemanticEvidenceScenario {
  return {
    id: "move_note/stale_closure_observation",
    profile: moveNoteCorpusProfile(),
    schedule: {
      hostEvents: moveApplyEvents(),
      applyRounds: [
        { observations: MOVE_APPLIED_OBSERVATIONS },
        {
          observations: [
            { path: MOVE_DESTINATION_PATH, semantic: "fresh" },
            {
              path: MOVE_DERIVED_A_PATH,
              semantic: "fresh",
              resolvedLinks: { [MOVE_DESTINATION_PATH]: 1 },
            },
            {
              path: MOVE_DERIVED_B_PATH,
              semantic: {
                version: contentVersion(MOVE_DERIVED_FIXTURES[1]!.originalBytes),
              },
              resolvedLinks: { [MOVE_DESTINATION_PATH]: 1 },
            },
          ],
        },
        { observations: MOVE_APPLIED_OBSERVATIONS },
      ],
    },
    expect: {
      proof: APPLIED,
      journal: "COMMITTED",
      sessions: [{ mode: "apply", outcome: "converged" }],
      writesBlocked: false,
      sentinelApplied: true,
      residue: false,
      snapshot: "successor_matches_terminal",
      graph: MOVE_APPLIED_GRAPH,
      rejectionsMinimum: 1,
    },
    moveDerivedEffects: moveDerivedEffects(),
  };
}

/**
 * A closure graph that never resolves to the destination reaches the barrier
 * deadline; rollback restores the whole closure (source path, original bytes,
 * original reference graph) and converges to `intent_not_applied`.
 */
export function moveNoteGraphMismatchDeadlineRollback(): SemanticEvidenceScenario {
  return {
    id: "move_note/graph_mismatch_deadline_rollback",
    profile: moveNoteCorpusProfile(),
    schedule: {
      hostEvents: [...moveApplyEvents(), ...MOVE_ROLLBACK_EVENTS],
      applyRounds: [
        { observations: MOVE_APPLIED_OBSERVATIONS },
        { observations: MOVE_STALE_GRAPH_OBSERVATIONS },
      ],
      rollbackRounds: [
        { observations: MOVE_RESTORED_OBSERVATIONS },
        { observations: MOVE_RESTORED_OBSERVATIONS },
      ],
    },
    expect: {
      proof: NOT_APPLIED,
      journal: "ROLLED_BACK",
      sessions: [
        { mode: "apply", outcome: "converged" },
        { mode: "restore", outcome: "converged" },
      ],
      writesBlocked: false,
      sentinelApplied: true,
      residue: false,
      snapshot: "successor_matches_terminal",
      graph: MOVE_RESTORED_GRAPH,
      rejectionsMinimum: 1,
    },
    moveDerivedEffects: moveDerivedEffects(),
  };
}

// ---- managed trash / restore (hidden; targeted probes only, spec A-38) -------

/**
 * Delayed targeted probes: the barrier waits while the metadata cache still
 * serves the trashed note and references still point at it, and converges only
 * once both probes report the hidden state.
 */
export function trashNoteDelayedProbesConverge(): SemanticEvidenceScenario {
  return {
    id: "trash_note/delayed_probes_converge",
    profile: trashNoteCorpusProfile(),
    schedule: {
      hostEvents: [],
      probes: {
        initial: [
          { probe: "cacheVisible", path: TRASH_NOTE_PATH, value: true },
          { probe: "referenced", path: TRASH_NOTE_PATH, value: true },
        ],
        transitions: [
          { atMs: 100, probe: "cacheVisible", path: TRASH_NOTE_PATH, value: false },
          { atMs: 300, probe: "referenced", path: TRASH_NOTE_PATH, value: false },
        ],
      },
      applyRounds: [{}],
    },
    expect: {
      proof: APPLIED,
      journal: "COMMITTED",
      sessions: [{ mode: "apply", outcome: "converged", convergedNotBeforeMs: 300 }],
      writesBlocked: false,
      sentinelApplied: true,
      residue: false,
      snapshot: "successor_matches_terminal",
    },
  };
}

/**
 * The cache never evicts the trashed note: the apply barrier fails closed at
 * the installed 5,000 ms deadline; rollback restores the exact bytes and the
 * restored probe evidence converges to `intent_not_applied`.
 */
export function trashNoteProbeDeadlineThenRestored(): SemanticEvidenceScenario {
  return {
    id: "trash_note/probe_deadline_then_restored",
    profile: trashNoteCorpusProfile(),
    schedule: {
      hostEvents: [],
      probes: {
        initial: [
          { probe: "cacheVisible", path: TRASH_NOTE_PATH, value: true },
          { probe: "referenced", path: TRASH_NOTE_PATH, value: true },
        ],
        transitions: [
          { atMs: 100, probe: "referenced", path: TRASH_NOTE_PATH, value: false },
          { atMs: 5_100, probe: "referenced", path: TRASH_NOTE_PATH, value: true },
        ],
      },
      applyRounds: [],
      rollbackRounds: [{}],
    },
    expect: {
      proof: NOT_APPLIED,
      journal: "ROLLED_BACK",
      sessions: [
        { mode: "apply", outcome: "timed_out" },
        { mode: "restore", outcome: "converged", convergedNotBeforeMs: 100 },
      ],
      writesBlocked: false,
      sentinelApplied: true,
      residue: false,
      snapshot: "successor_matches_terminal",
    },
  };
}

/**
 * The restored note is never re-observed by the reference graph: the restored
 * Semantic Evidence never converges, so even though the exact bytes were
 * restored the Change Set fails closed as `result_unproven` and blocks writes.
 */
export function trashNoteRestoreEvidenceDeadlineBlocksWrites(): SemanticEvidenceScenario {
  return {
    id: "trash_note/restore_evidence_deadline_blocks_writes",
    profile: trashNoteCorpusProfile(),
    schedule: {
      hostEvents: [],
      probes: {
        initial: [
          { probe: "cacheVisible", path: TRASH_NOTE_PATH, value: true },
          { probe: "referenced", path: TRASH_NOTE_PATH, value: true },
        ],
        transitions: [{ atMs: 100, probe: "referenced", path: TRASH_NOTE_PATH, value: false }],
      },
      applyRounds: [],
      rollbackRounds: [],
    },
    expect: {
      proof: UNPROVEN,
      journal: "FAILED",
      sessions: [
        { mode: "apply", outcome: "timed_out" },
        { mode: "restore", outcome: "timed_out" },
      ],
      writesBlocked: true,
      sentinelApplied: false,
      residue: false,
      snapshot: "never_accepted",
    },
  };
}

/**
 * Contrary third-party state over the trashed path after a failed apply
 * barrier: rollback cannot prove restoration, so the Change Set fails closed
 * as `result_unproven`, blocks writes, and surfaces the foreign residue while
 * the Bridge-owned trash copy is preserved.
 */
export function trashNoteContraryThirdPartyBlocksWrites(): SemanticEvidenceScenario {
  return {
    id: "trash_note/contrary_third_party_blocks_writes",
    profile: trashNoteCorpusProfile(),
    schedule: {
      hostEvents: [],
      probes: {
        initial: [
          { probe: "cacheVisible", path: TRASH_NOTE_PATH, value: true },
          { probe: "referenced", path: TRASH_NOTE_PATH, value: true },
        ],
        transitions: [{ atMs: 100, probe: "referenced", path: TRASH_NOTE_PATH, value: false }],
      },
      applyRounds: [],
      rollbackRounds: [],
      foreignWrites: [{ path: TRASH_NOTE_PATH, bytes: FOREIGN_NOTE_BYTES }],
    },
    expect: {
      proof: UNPROVEN,
      journal: "FAILED",
      sessions: [{ mode: "apply", outcome: "timed_out" }],
      writesBlocked: true,
      sentinelApplied: false,
      residue: true,
      snapshot: "never_accepted",
    },
  };
}

/** Every Semantic Evidence corpus scenario, grouped by mutation kind. */
export function semanticEvidenceScenarios(): readonly SemanticEvidenceScenario[] {
  return [
    createNoteCleanConvergence(),
    createNoteQuietWindowReset(),
    createNoteStaleObservationsThenFresh(),
    createNoteStaleObservationDeadline(),
    editBodyStaleVersionCallback(),
    editBodyMissingObservationDeadline(),
    editBodyQuietWindowContradiction(),
    editBodyContraryThirdPartyBlocksWrites(),
    multiFrontmatterReorderedCallbacks(),
    moveNoteDelayedRenameCallback(),
    moveNoteStaleAndWrongPathCallbacksIgnored(),
    moveNoteMissingRenameEventDeadline(),
    moveNoteGraphMismatchThenConverged(),
    moveNoteStaleClosureObservation(),
    moveNoteGraphMismatchDeadlineRollback(),
    trashNoteDelayedProbesConverge(),
    trashNoteProbeDeadlineThenRestored(),
    trashNoteRestoreEvidenceDeadlineBlocksWrites(),
    trashNoteContraryThirdPartyBlocksWrites(),
  ];
}
