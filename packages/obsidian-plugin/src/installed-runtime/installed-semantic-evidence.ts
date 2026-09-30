import { createHash, randomUUID } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { relative, resolve, sep } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  parseChangeSetStatusResult,
  parseChangeSetSubmitResult,
  parseHealthResult,
  type ChangeSetSubmitInput,
} from "@llm-wiki/vault-contracts";

import {
  CREATE_NOTE_BYTES,
  CREATE_NOTE_CONTENT,
  CREATE_NOTE_PATH,
} from "../corpus/create-note-corpus.js";
import {
  EXACT_COMMITTED_BYTES,
  EXACT_FIXTURE,
  EXACT_ORIGINAL_BYTES,
  FRONTMATTER_COMMITTED_BYTES,
  FRONTMATTER_FIXTURE,
  FRONTMATTER_ORIGINAL_BYTES,
} from "../corpus/edit-fixtures.js";
import {
  TRASH_NOTE_BYTES,
  TRASH_NOTE_PATH,
} from "../corpus/managed-trash-corpus.js";
import {
  MOVE_DERIVED_FIXTURES,
  MOVE_DESTINATION_PATH,
  MOVE_SOURCE_BYTES,
  MOVE_SOURCE_PATH,
} from "../corpus/move-note-corpus.js";
import type { InstalledRuntimeAcceptanceDescriptor } from "./acceptance-driver-protocol.js";
import { EXPECTED_VAULT_ID_HEADER } from "../request-policy.js";

const CLEAN_CONVERGENCE_SCENARIO = "create_note/clean_convergence";
const QUIET_WINDOW_RESET_SCENARIO = "create_note/quiet_window_reset";
const STALE_OBSERVATIONS_THEN_FRESH_SCENARIO =
  "create_note/stale_observations_then_fresh";
const STALE_OBSERVATION_DEADLINE_SCENARIO =
  "create_note/stale_observation_deadline";
const EDIT_BODY_STALE_VERSION_SCENARIO =
  "edit_body/stale_version_callback_after_newer_bytes";
const EDIT_BODY_MISSING_OBSERVATION_DEADLINE_SCENARIO =
  "edit_body/missing_observation_deadline";
const EDIT_BODY_QUIET_WINDOW_CONTRADICTION_SCENARIO =
  "edit_body/quiet_window_contradiction";
const EDIT_BODY_CONTRARY_THIRD_PARTY_SCENARIO =
  "edit_body/contrary_third_party_blocks_writes";
const MULTI_FRONTMATTER_REORDERED_CALLBACKS_SCENARIO =
  "edit_multi_frontmatter/reordered_cache_callbacks";
const MOVE_DELAYED_RENAME_SCENARIO = "move_note/delayed_rename_callback";
const MOVE_STALE_AND_WRONG_PATH_SCENARIO =
  "move_note/stale_and_wrong_path_callbacks_ignored";
const MOVE_MISSING_RENAME_DEADLINE_SCENARIO =
  "move_note/missing_rename_event_deadline";
const MOVE_GRAPH_MISMATCH_THEN_CONVERGED_SCENARIO =
  "move_note/graph_mismatch_then_converged";
const MOVE_STALE_CLOSURE_OBSERVATION_SCENARIO =
  "move_note/stale_closure_observation";
const MOVE_GRAPH_MISMATCH_DEADLINE_SCENARIO =
  "move_note/graph_mismatch_deadline_rollback";
const TRASH_DELAYED_PROBES_SCENARIO =
  "trash_note/delayed_probes_converge";
const TRASH_PROBE_DEADLINE_RESTORED_SCENARIO =
  "trash_note/probe_deadline_then_restored";
const TRASH_RESTORE_EVIDENCE_DEADLINE_SCENARIO =
  "trash_note/restore_evidence_deadline_blocks_writes";
const TRASH_CONTRARY_THIRD_PARTY_SCENARIO =
  "trash_note/contrary_third_party_blocks_writes";
const MULTI_C_PATH = "Corpus/Multi/NoteC.md";
const MULTI_D_PATH = "Corpus/Multi/NoteD.md";
export const TRASH_REFERENCE_PATH = "Corpus/Trash/Reference.md";
const TRASH_REFERENCE_BYTES = new TextEncoder().encode(
  "# Trash reference\n\n[[Note]]\n",
);
const CREATE_NOTE_CONTENT_VERSION =
  `sha256:${createHash("sha256").update(CREATE_NOTE_BYTES).digest("hex")}`;
const EDIT_BODY_ORIGINAL_VERSION =
  `sha256:${createHash("sha256").update(EXACT_ORIGINAL_BYTES).digest("hex")}`;
const EDIT_BODY_COMMITTED_VERSION =
  `sha256:${createHash("sha256").update(EXACT_COMMITTED_BYTES).digest("hex")}`;
const FRONTMATTER_ORIGINAL_VERSION =
  `sha256:${createHash("sha256").update(FRONTMATTER_ORIGINAL_BYTES).digest("hex")}`;
const FRONTMATTER_COMMITTED_VERSION =
  `sha256:${createHash("sha256").update(FRONTMATTER_COMMITTED_BYTES).digest("hex")}`;
type InstalledSemanticScenario =
  | typeof CLEAN_CONVERGENCE_SCENARIO
  | typeof QUIET_WINDOW_RESET_SCENARIO
  | typeof STALE_OBSERVATIONS_THEN_FRESH_SCENARIO
  | typeof STALE_OBSERVATION_DEADLINE_SCENARIO
  | typeof EDIT_BODY_STALE_VERSION_SCENARIO
  | typeof EDIT_BODY_MISSING_OBSERVATION_DEADLINE_SCENARIO
  | typeof EDIT_BODY_QUIET_WINDOW_CONTRADICTION_SCENARIO
  | typeof EDIT_BODY_CONTRARY_THIRD_PARTY_SCENARIO
  | typeof MULTI_FRONTMATTER_REORDERED_CALLBACKS_SCENARIO
  | typeof MOVE_DELAYED_RENAME_SCENARIO
  | typeof MOVE_STALE_AND_WRONG_PATH_SCENARIO
  | typeof MOVE_MISSING_RENAME_DEADLINE_SCENARIO
  | typeof MOVE_GRAPH_MISMATCH_THEN_CONVERGED_SCENARIO
  | typeof MOVE_STALE_CLOSURE_OBSERVATION_SCENARIO
  | typeof MOVE_GRAPH_MISMATCH_DEADLINE_SCENARIO
  | typeof TRASH_DELAYED_PROBES_SCENARIO
  | typeof TRASH_PROBE_DEADLINE_RESTORED_SCENARIO
  | typeof TRASH_RESTORE_EVIDENCE_DEADLINE_SCENARIO
  | typeof TRASH_CONTRARY_THIRD_PARTY_SCENARIO;

export type InstalledSemanticEvidenceProofState =
  | "intent_applied"
  | "intent_not_applied"
  | "result_unproven";

export interface InstalledSemanticEvidenceWire {
  submit(options: {
    readonly endpoint: URL;
    readonly expectedVaultId: string;
    readonly input: ChangeSetSubmitInput;
  }): Promise<{ readonly proofState: InstalledSemanticEvidenceProofState }>;
  status(options: {
    readonly endpoint: URL;
    readonly expectedVaultId: string;
    readonly submissionKey: string;
  }): Promise<{ readonly proofState: InstalledSemanticEvidenceProofState }>;
  health(options: {
    readonly endpoint: URL;
    readonly expectedVaultId: string;
  }): Promise<InstalledSemanticEvidenceHealthObservation>;
}

export interface InstalledSemanticEvidenceSnapshotObservation {
  readonly version: number;
  readonly immutable: boolean;
}

export interface InstalledSemanticEvidenceRecoveryFrame {
  readonly phase: "PREPARED" | "COMMITTED" | "ROLLED_BACK" | "FAILED";
  readonly input: { readonly submissionKey: string };
}

export interface InstalledSemanticEvidenceBarrierRoundObservation {
  readonly targets: readonly {
    readonly path: string;
    readonly expectedContentVersion: string;
    readonly observedContentVersion: string | undefined;
    readonly matched: boolean;
  }[];
  readonly move?: {
    readonly absentPath: { readonly path: string; readonly absent: boolean };
    readonly presentPath: {
      readonly path: string;
      readonly expectedContentVersion: string;
      readonly observedContentVersion: string | undefined;
      readonly matched: boolean;
    };
    readonly closure: readonly {
      readonly path: string;
      readonly expectedContentVersion: string;
      readonly observedContentVersion: string | undefined;
      readonly expectedResolvedPath: string;
      readonly observedReferenceCount: number;
      readonly expectedReferenceCount: number;
      readonly matched: boolean;
    }[];
    readonly matched: boolean;
  };
  readonly matched: boolean;
}

export interface InstalledSemanticEvidenceHealthObservation {
  readonly recoveryBlocked: boolean;
  readonly writesBlocked: boolean;
  readonly effectiveGate: "recovery_blocked" | null;
}

export interface InstalledSemanticEvidenceScenarioControlOptions {
  readonly vaultPath: string;
  readonly wire: InstalledSemanticEvidenceWire;
  readonly currentSnapshot: () => InstalledSemanticEvidenceSnapshotObservation | null;
  readonly loadRecoveryFrame: () => Promise<InstalledSemanticEvidenceRecoveryFrame | null>;
  readonly observeHealth?: (options: {
    readonly endpoint: URL;
    readonly expectedVaultId: string;
  }) => Promise<InstalledSemanticEvidenceHealthObservation>;
  readonly cleanupPath: (path: string) => Promise<void>;
  readonly refreshAfterCleanup?: () => Promise<void>;
  readonly induceQuietWindowResets?: () => Promise<void>;
  readonly induceStaleObservationsThenFresh?: () => Promise<void>;
  readonly induceStaleObservationDeadline?: () => Promise<void>;
  readonly induceEditBodyStaleThenFresh?: (options: {
    readonly committedContentVersion: string;
    readonly waitForCommittedMetadataContentVersion: () => Promise<void>;
  }) => Promise<void>;
  readonly induceEditBodyMissingObservationDeadline?: () => Promise<void>;
  readonly induceEditBodyQuietWindowContradiction?: () => Promise<void>;
  readonly induceEditBodyContraryThirdParty?: () => Promise<void>;
  readonly induceMultiFrontmatterReorderedCallbacks?: () => Promise<void>;
  readonly induceMoveDelayedRename?: () => Promise<void>;
  readonly induceMoveStalePreBeginCallback?: () => Promise<void>;
  readonly induceMoveStaleAndWrongPathCallbacks?: () => Promise<void>;
  readonly induceMoveGraphMismatchThenConverged?: () => Promise<void>;
  readonly induceMoveStaleClosureObservation?: () => Promise<void>;
  readonly induceMoveGraphMismatchDeadline?: () => Promise<void>;
  readonly induceTrashDelayedProbes?: () => Promise<void>;
  readonly induceTrashProbeDeadlineThenRestored?: () => Promise<void>;
  readonly induceTrashRestoreEvidenceDeadline?: () => Promise<void>;
  readonly induceTrashContraryThirdParty?: () => Promise<void>;
  readonly observeTrashProbes?: (path: string) => Promise<{
    readonly cacheVisible: boolean;
    readonly referenced: boolean;
  }>;
  readonly seedPath?: (path: string, bytes: Uint8Array) => Promise<void>;
  readonly refreshSeedFixtures?: () =>
    Promise<InstalledSemanticEvidenceSnapshotObservation>;
  readonly createSubmissionKey?: () => string;
  readonly now?: () => number;
}

export interface InstalledSemanticEvidenceScenarioRequest {
  readonly descriptor: InstalledRuntimeAcceptanceDescriptor;
  readonly scenario: string;
  readonly expectedVaultId: string;
  readonly endpoint: URL;
}

export interface InstalledSemanticEvidenceScenarioSummary {
  readonly scenario: InstalledSemanticScenario;
  readonly source: "installed-obsidian";
  readonly mutationKind:
    | "create_note"
    | "edit_body"
    | "edit_multi_frontmatter"
    | "move_note"
    | "trash_note";
  readonly proofState: InstalledSemanticEvidenceProofState;
  readonly statusProofState: InstalledSemanticEvidenceProofState;
  readonly journalPhase: "COMMITTED" | "ROLLED_BACK" | "FAILED";
  readonly evidenceDeadlineMs: 5_000;
  readonly successBarrierDeadlineMs: 5_000;
  readonly evidenceSessions: readonly {
    readonly mode: "apply" | "restore";
    readonly outcome: "converged" | "timed_out";
    readonly virtualElapsedMs: number;
  }[];
  readonly quietWindowResets: number;
  readonly acceptedSnapshotRounds: number;
  readonly rejectedSnapshotRounds: number;
  readonly successorSnapshot: {
    readonly baselineVersion: number;
    readonly version: number | null;
    readonly immutable: boolean;
    readonly publishedBeforeIntentApplied: boolean;
  };
  readonly durableCommitBeforeIntentApplied: boolean;
  readonly writesBlocked: boolean;
  readonly residueSha256?: string;
  readonly beforeInventorySha256: string;
  readonly afterInventorySha256: string;
  readonly cleanupSucceeded: true;
}

interface InventoryEntry {
  readonly path: string;
  readonly kind: "file" | "directory";
  readonly sha256?: string;
  readonly bytes?: number;
}

function canonicalInventoryDigest(inventory: readonly InventoryEntry[]): string {
  const canonical = inventory
    .map(({ path, kind, sha256, bytes }) =>
      `${kind}\t${sha256 ?? ""}\t${bytes ?? ""}\t${path}`)
    .sort()
    .join("\n");
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

async function inventoryVault(root: string): Promise<InventoryEntry[]> {
  const entries: InventoryEntry[] = [];
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name === ".obsidian" || entry.name === ".llm-wiki") continue;
      const absolute = resolve(directory, entry.name);
      const path = relative(root, absolute).split(sep).join("/");
      if (entry.isDirectory()) {
        entries.push({ path, kind: "directory" });
        await walk(absolute);
      } else if (entry.isFile()) {
        const bytes = await readFile(absolute);
        entries.push({
          path,
          kind: "file",
          sha256: createHash("sha256").update(bytes).digest("hex"),
          bytes: bytes.byteLength,
        });
      }
    }
  };
  await walk(root);
  return entries.sort((left, right) => left.path.localeCompare(right.path));
}

async function waitForInstalledObservation(
  observed: () => boolean,
  description: string,
): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!observed()) {
    if (Date.now() >= deadline) {
      throw new Error(`Installed Semantic Evidence ${description} was not observed`);
    }
    await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 10));
  }
}

function requireTerminalProofState(
  state: "in_progress" | InstalledSemanticEvidenceProofState,
): InstalledSemanticEvidenceProofState {
  if (state === "in_progress") {
    throw new Error("Installed Semantic Evidence Change Set has not reached a proof state");
  }
  return state;
}

const installedLoopbackFetch: typeof fetch = async (input, init) => {
  const request = new Request(input, init);
  const url = new URL(request.url);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1") {
    throw new Error("Installed Semantic Evidence transport requires loopback HTTP");
  }
  const body = request.body === null ? undefined : Buffer.from(await request.arrayBuffer());
  const outgoingHeaders: Record<string, string> = {};
  request.headers.forEach((value, name) => { outgoingHeaders[name] = value; });
  return await new Promise<Response>((resolvePromise, reject) => {
    const outgoing = httpRequest(url, {
      method: request.method,
      headers: outgoingHeaders,
      signal: request.signal,
    }, (incoming) => {
      const headers = new Headers();
      for (const [name, value] of Object.entries(incoming.headers)) {
        if (value !== undefined) {
          for (const entry of Array.isArray(value) ? value : [value]) headers.append(name, entry);
        }
      }
      const status = incoming.statusCode ?? 500;
      const noBody = request.method === "HEAD" || [204, 205, 304].includes(status);
      if (noBody) {
        incoming.resume();
        resolvePromise(new Response(null, { status, headers }));
        return;
      }
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          incoming.on("data", (chunk: Buffer) => controller.enqueue(Uint8Array.from(chunk)));
          incoming.once("end", () => controller.close());
          incoming.once("error", (error) => controller.error(error));
        },
        cancel() { incoming.destroy(); },
      });
      resolvePromise(new Response(stream, { status, headers }));
    });
    outgoing.once("error", reject);
    outgoing.end(body);
  });
};

export function createInstalledSemanticEvidenceWire(): InstalledSemanticEvidenceWire {
  const call = async (
    endpoint: URL,
    expectedVaultId: string,
    tool: "vault_health" | "vault_change_set_submit" | "vault_change_set_status",
    arguments_: Record<string, unknown>,
  ): Promise<unknown> => {
    const client = new Client({
      name: "installed-obsidian-semantic-evidence",
      version: "1.0.0",
    });
    const transport = new StreamableHTTPClientTransport(endpoint, {
      fetch: installedLoopbackFetch,
      requestInit: {
        headers: { [EXPECTED_VAULT_ID_HEADER]: expectedVaultId },
      },
    });
    try {
      await client.connect(transport);
      const result = await client.callTool({ name: tool, arguments: arguments_ });
      if (result.structuredContent === undefined) {
        throw new Error(`${tool} did not return authoritative structured content`);
      }
      const expectedError = tool === "vault_change_set_submit"
        ? (() => {
            const submitted = parseChangeSetSubmitResult(result.structuredContent);
            return submitted.outcome !== "registered" ||
              submitted.changeSet.state === "intent_not_applied" ||
              submitted.changeSet.state === "result_unproven";
          })()
        : tool === "vault_change_set_status"
        ? parseChangeSetStatusResult(result.structuredContent).lookup === "operationally_blocked"
        : false;
      if ((result.isError === true) !== expectedError) {
        throw new Error(`${tool} returned an unexpected MCP error disposition`);
      }
      return result.structuredContent;
    } finally {
      await client.close().catch(() => undefined);
    }
  };
  return {
    async submit({ endpoint, expectedVaultId, input }) {
      const result = parseChangeSetSubmitResult(
        await call(endpoint, expectedVaultId, "vault_change_set_submit", input),
      );
      if (result.outcome !== "registered") {
        throw new Error("Installed Semantic Evidence Change Set was not registered");
      }
      return { proofState: requireTerminalProofState(result.changeSet.state) };
    },
    async status({ endpoint, expectedVaultId, submissionKey }) {
      const result = parseChangeSetStatusResult(
        await call(endpoint, expectedVaultId, "vault_change_set_status", {
          submissionKey,
        }),
      );
      if (result.lookup !== "found") {
        throw new Error("Installed Semantic Evidence Change Set status is unavailable");
      }
      return { proofState: requireTerminalProofState(result.changeSet.state) };
    },
    async health({ endpoint, expectedVaultId }) {
      const health = parseHealthResult(
        await call(endpoint, expectedVaultId, "vault_health", {}),
      );
      if (health.outcome !== "observed" || health.vault.id !== expectedVaultId) {
        throw new Error("Installed Semantic Evidence health belongs to the wrong Vault");
      }
      return {
        recoveryBlocked: health.recovery.state === "blocked",
        writesBlocked:
          health.write.gate === "blocked" && health.write.state === "paused",
        effectiveGate:
          health.effectiveGate?.code === "recovery_blocked"
            ? "recovery_blocked"
            : null,
      };
    },
  };
}

export function createInstalledSemanticEvidenceScenarioControl(
  options: InstalledSemanticEvidenceScenarioControlOptions,
): {
  recordVaultEvent(event:
    | { readonly kind: "create" | "delete"; readonly path: string }
    | { readonly kind: "rename"; readonly oldPath: string; readonly path: string }
  ): boolean;
  waitForRenameObservation(): Promise<void>;
  releaseDelayedRenameEvent():
    | { readonly kind: "rename"; readonly oldPath: string; readonly path: string }
    | null;
  acceptMetadataCacheObservation(observation: {
    readonly path: string;
    readonly contentVersion?: string;
    readonly bomPrefixedContentVersion?: string;
  }): boolean;
  acceptsMetadataCacheObservation(path: string): boolean;
  recordMetadataCacheObservation(observation: {
    readonly path: string;
    readonly contentVersion?: string;
    readonly bomPrefixedContentVersion?: string;
  }): void;
  recordSearchSnapshotRefresh(observation: { readonly reset: boolean }): void;
  recordSearchSnapshotBarrierRound(
    observation: InstalledSemanticEvidenceBarrierRoundObservation,
  ): void;
  recordSearchSnapshotPublication(
    observation: InstalledSemanticEvidenceSnapshotObservation,
  ): void;
  acceptsTrashProbeObservation(path: string, mode: "apply" | "restore"): boolean;
  recordTrashProbeObservation(observation: {
    readonly path: string;
    readonly cacheVisible: boolean;
    readonly referenced: boolean;
  }): void;
  recordRecoveryFrame(frame: InstalledSemanticEvidenceRecoveryFrame): void;
  releaseCommittedMetadataObservation(path?: string): void;
  waitForMetadataContentVersion(contentVersion: string): Promise<void>;
  markMetadataContentVersionMissing(): void;
  waitForRejectedSnapshotRounds(count: number): Promise<void>;
  execute(
    request: InstalledSemanticEvidenceScenarioRequest,
  ): Promise<InstalledSemanticEvidenceScenarioSummary>;
} {
  const now = options.now ?? Date.now;
  let active:
    | {
        readonly submissionKey: string;
        readonly scenario: string;
        baselineVersion: number;
        startedAt: number;
        readonly targets: Map<
          string,
          {
            readonly expectedContentVersion: string;
            metadataCacheObserved: boolean;
            metadataContentVersion: string | null;
            bomPrefixedContentVersion: string | null;
            committedMetadataReleased: boolean;
            vaultChangeObserved: boolean;
            vaultDeleteObserved: boolean;
          }
        >;
        snapshot: InstalledSemanticEvidenceSnapshotObservation | null;
        quietWindowResets: number;
        acceptedSnapshotRounds: number;
        rejectedSnapshotRounds: number;
        snapshotObservedAt: number | null;
        terminalFrameObservedAt: number | null;
        expectedRename: { readonly oldPath: string; readonly path: string } | null;
        renameObserved: boolean;
        delayedRename: { readonly oldPath: string; readonly path: string } | null;
        releaseDelayedRename: boolean;
        scenarioExecutionStarted: boolean;
        withholdCommittedMetadataUntilRejected: boolean;
        trashProbe: {
          readonly path: string;
          cacheVisible: boolean;
          referenced: boolean;
          convergedAt: number | null;
        } | null;
      }
    | undefined;

  return {
    recordVaultEvent(event) {
      if (active === undefined) return true;
      if (event.kind === "rename") {
        if (
          active.expectedRename?.oldPath === event.oldPath &&
          active.expectedRename.path === event.path
        ) {
          if (!active.scenarioExecutionStarted) return true;
          if (!active.releaseDelayedRename) {
            active.delayedRename = { oldPath: event.oldPath, path: event.path };
            return false;
          }
          active.renameObserved = true;
        }
        return true;
      }
      const target = active.targets.get(event.path);
      if (target === undefined) return true;
      if (event.kind === "create") target.vaultChangeObserved = true;
      else target.vaultDeleteObserved = true;
      return true;
    },
    async waitForRenameObservation() {
      await waitForInstalledObservation(
        () => active?.delayedRename !== null,
        "bound rename callback",
      );
    },
    releaseDelayedRenameEvent() {
      if (active === undefined) return null;
      active.releaseDelayedRename = true;
      const delayed = active.delayedRename;
      if (delayed === null) return null;
      active.renameObserved = true;
      active.delayedRename = null;
      return { kind: "rename", ...delayed };
    },
    acceptMetadataCacheObservation(observation) {
      const target = active?.targets.get(observation.path);
      return target === undefined ||
        (observation.contentVersion !== target.expectedContentVersion &&
          observation.bomPrefixedContentVersion !== target.expectedContentVersion) ||
        target.committedMetadataReleased ||
        (active!.rejectedSnapshotRounds > 0 &&
          active!.scenario !== STALE_OBSERVATION_DEADLINE_SCENARIO);
    },
    acceptsMetadataCacheObservation(path) {
      const target = active?.targets.get(path);
      return target === undefined ||
        !active!.scenarioExecutionStarted ||
        target.committedMetadataReleased ||
        (active!.scenario === STALE_OBSERVATION_DEADLINE_SCENARIO &&
          target.metadataContentVersion !== null &&
          target.metadataContentVersion !== target.expectedContentVersion) ||
        (active!.rejectedSnapshotRounds > 0 &&
          active!.scenario !== STALE_OBSERVATION_DEADLINE_SCENARIO);
    },
    recordMetadataCacheObservation(observation) {
      const target = active?.targets.get(observation.path);
      if (target !== undefined) {
        target.metadataCacheObserved = true;
        target.bomPrefixedContentVersion = observation.bomPrefixedContentVersion ?? null;
        target.metadataContentVersion = observation.bomPrefixedContentVersion === target.expectedContentVersion
          ? target.expectedContentVersion
          : observation.contentVersion ?? null;
      }
    },
    recordSearchSnapshotRefresh(observation) {
      if (active !== undefined && observation.reset) {
        active.quietWindowResets += 1;
      }
    },
    recordSearchSnapshotBarrierRound(observation) {
      if (active === undefined || !active.scenarioExecutionStarted) return;
      const observedTargets = [...active.targets].map(([path, target]) => ({
        target,
        observation: observation.targets.find(
          ({ path: observedPath, expectedContentVersion }) =>
            observedPath === path &&
            expectedContentVersion === target.expectedContentVersion,
        ),
      }));
      if (observedTargets.some(({ observation }) => observation === undefined)) return;
      if (observation.move?.absentPath.absent &&
          observation.move.presentPath.matched && active.renameObserved) {
        const destination = active.expectedRename?.path;
        const boundDestination = observedTargets.find(({ observation: observed }) =>
          observed!.path === destination && observed!.matched &&
          observed!.observedContentVersion === observed!.expectedContentVersion,
        );
        if (boundDestination !== undefined) {
          boundDestination.target.metadataContentVersion = boundDestination.target.expectedContentVersion;
        }
      }
      const matchesInstalledObservation =
        observation.matched &&
        observedTargets.every(({ target, observation: observed }) =>
          observed!.matched &&
          observed!.observedContentVersion === target.expectedContentVersion &&
          target.metadataContentVersion === target.expectedContentVersion,
        );
      if (matchesInstalledObservation) active.acceptedSnapshotRounds += 1;
      else if (
        !observation.matched &&
        observedTargets.every(({ target, observation: observed }) =>
          target.metadataContentVersion === (observed!.observedContentVersion ?? null) ||
          target.bomPrefixedContentVersion === observed!.observedContentVersion ||
          (active!.withholdCommittedMetadataUntilRejected &&
            target.metadataContentVersion !== null &&
            target.metadataContentVersion !== target.expectedContentVersion),
        )
      ) active.rejectedSnapshotRounds += 1;
    },
    recordSearchSnapshotPublication(observation) {
      if (active === undefined || observation.version <= active.baselineVersion) return;
      active.snapshot = { ...observation };
      active.snapshotObservedAt = now();
    },
    acceptsTrashProbeObservation(path, mode) {
      return active?.trashProbe?.path !== path ||
        !active.scenarioExecutionStarted ||
        (active.scenario !== TRASH_RESTORE_EVIDENCE_DEADLINE_SCENARIO &&
          active.scenario !== TRASH_CONTRARY_THIRD_PARTY_SCENARIO &&
          (active.scenario !== TRASH_PROBE_DEADLINE_RESTORED_SCENARIO ||
            mode === "restore"));
    },
    recordTrashProbeObservation(observation) {
      if (active?.trashProbe?.path !== observation.path) return;
      active.trashProbe.cacheVisible = observation.cacheVisible;
      active.trashProbe.referenced = observation.referenced;
      if (!observation.cacheVisible && !observation.referenced) {
        active.trashProbe.convergedAt = now();
      }
    },
    recordRecoveryFrame(frame) {
      if (
        active === undefined ||
        (frame.phase !== "COMMITTED" &&
          frame.phase !== "ROLLED_BACK" &&
          frame.phase !== "FAILED") ||
        frame.input.submissionKey !== active.submissionKey
      ) return;
      active.terminalFrameObservedAt = now();
    },
    releaseCommittedMetadataObservation(path) {
      if (active === undefined) return;
      if (path === undefined) {
        for (const target of active.targets.values()) {
          target.committedMetadataReleased = true;
        }
        active.withholdCommittedMetadataUntilRejected = false;
        return;
      }
      const target = active.targets.get(path);
      if (target !== undefined) target.committedMetadataReleased = true;
    },
    async waitForMetadataContentVersion(contentVersion) {
      await waitForInstalledObservation(
        () => active !== undefined && [...active.targets.values()].some(
          (target) => target.metadataContentVersion === contentVersion ||
            target.bomPrefixedContentVersion === contentVersion,
        ),
        "bound metadata Content Version",
      );
    },
    markMetadataContentVersionMissing() {
      if (active !== undefined) {
        for (const target of active.targets.values()) {
          target.metadataContentVersion = null;
          target.bomPrefixedContentVersion = null;
        }
      }
    },
    async waitForRejectedSnapshotRounds(count) {
      await waitForInstalledObservation(
        () => (active?.rejectedSnapshotRounds ?? 0) >= count,
        `${count} rejected Search Snapshot rounds`,
      );
    },
    async execute(request) {
      if (
        request.scenario !== CLEAN_CONVERGENCE_SCENARIO &&
        request.scenario !== QUIET_WINDOW_RESET_SCENARIO &&
        request.scenario !== STALE_OBSERVATIONS_THEN_FRESH_SCENARIO &&
        request.scenario !== STALE_OBSERVATION_DEADLINE_SCENARIO &&
        request.scenario !== EDIT_BODY_STALE_VERSION_SCENARIO &&
        request.scenario !== EDIT_BODY_MISSING_OBSERVATION_DEADLINE_SCENARIO &&
        request.scenario !== EDIT_BODY_QUIET_WINDOW_CONTRADICTION_SCENARIO &&
        request.scenario !== EDIT_BODY_CONTRARY_THIRD_PARTY_SCENARIO &&
        request.scenario !== MULTI_FRONTMATTER_REORDERED_CALLBACKS_SCENARIO &&
        request.scenario !== MOVE_DELAYED_RENAME_SCENARIO &&
        request.scenario !== MOVE_STALE_AND_WRONG_PATH_SCENARIO &&
        request.scenario !== MOVE_MISSING_RENAME_DEADLINE_SCENARIO &&
        request.scenario !== MOVE_GRAPH_MISMATCH_THEN_CONVERGED_SCENARIO &&
        request.scenario !== MOVE_STALE_CLOSURE_OBSERVATION_SCENARIO &&
        request.scenario !== MOVE_GRAPH_MISMATCH_DEADLINE_SCENARIO &&
        request.scenario !== TRASH_DELAYED_PROBES_SCENARIO &&
        request.scenario !== TRASH_PROBE_DEADLINE_RESTORED_SCENARIO &&
        request.scenario !== TRASH_RESTORE_EVIDENCE_DEADLINE_SCENARIO &&
        request.scenario !== TRASH_CONTRARY_THIRD_PARTY_SCENARIO
      ) {
        throw new Error(`Installed Semantic Evidence scenario is not implemented: ${request.scenario}`);
      }
      if (
        request.scenario === QUIET_WINDOW_RESET_SCENARIO &&
        options.induceQuietWindowResets === undefined
      ) {
        throw new Error("Installed quiet-window reset induction is unavailable");
      }
      if (
        request.scenario === STALE_OBSERVATIONS_THEN_FRESH_SCENARIO &&
        options.induceStaleObservationsThenFresh === undefined
      ) {
        throw new Error("Installed stale-observation induction is unavailable");
      }
      if (
        request.scenario === STALE_OBSERVATION_DEADLINE_SCENARIO &&
        options.induceStaleObservationDeadline === undefined
      ) {
        throw new Error("Installed stale-observation deadline induction is unavailable");
      }
      if (
        request.scenario === EDIT_BODY_STALE_VERSION_SCENARIO &&
        options.induceEditBodyStaleThenFresh === undefined
      ) {
        throw new Error("Installed edit-body stale-observation induction is unavailable");
      }
      if (
        request.scenario === EDIT_BODY_MISSING_OBSERVATION_DEADLINE_SCENARIO &&
        options.induceEditBodyMissingObservationDeadline === undefined
      ) {
        throw new Error("Installed edit-body missing-observation induction is unavailable");
      }
      if (
        request.scenario === EDIT_BODY_QUIET_WINDOW_CONTRADICTION_SCENARIO &&
        options.induceEditBodyQuietWindowContradiction === undefined
      ) {
        throw new Error("Installed edit-body quiet-window induction is unavailable");
      }
      if (
        request.scenario === EDIT_BODY_CONTRARY_THIRD_PARTY_SCENARIO &&
        (options.induceEditBodyContraryThirdParty === undefined ||
          options.observeHealth === undefined)
      ) {
        throw new Error("Installed edit-body contrary-state induction is unavailable");
      }
      if (
        request.scenario === MULTI_FRONTMATTER_REORDERED_CALLBACKS_SCENARIO &&
        options.induceMultiFrontmatterReorderedCallbacks === undefined
      ) {
        throw new Error("Installed multi-frontmatter callback induction is unavailable");
      }
      if (
        request.scenario === MOVE_DELAYED_RENAME_SCENARIO &&
        options.induceMoveDelayedRename === undefined
      ) {
        throw new Error("Installed delayed-rename induction is unavailable");
      }
      if (
        request.scenario === MOVE_STALE_AND_WRONG_PATH_SCENARIO &&
        (options.induceMoveStalePreBeginCallback === undefined ||
          options.induceMoveStaleAndWrongPathCallbacks === undefined)
      ) {
        throw new Error("Installed stale/wrong-path rename induction is unavailable");
      }
      if (
        request.scenario === MOVE_GRAPH_MISMATCH_THEN_CONVERGED_SCENARIO &&
        options.induceMoveGraphMismatchThenConverged === undefined
      ) {
        throw new Error("Installed move graph-mismatch induction is unavailable");
      }
      if (
        request.scenario === MOVE_STALE_CLOSURE_OBSERVATION_SCENARIO &&
        options.induceMoveStaleClosureObservation === undefined
      ) {
        throw new Error("Installed stale move-closure induction is unavailable");
      }
      if (
        request.scenario === MOVE_GRAPH_MISMATCH_DEADLINE_SCENARIO &&
        options.induceMoveGraphMismatchDeadline === undefined
      ) {
        throw new Error("Installed move graph-mismatch deadline induction is unavailable");
      }
      if (
        request.scenario === TRASH_DELAYED_PROBES_SCENARIO &&
        options.induceTrashDelayedProbes === undefined
      ) {
        throw new Error("Installed delayed hidden-trash probes are unavailable");
      }
      if (
        request.scenario === TRASH_PROBE_DEADLINE_RESTORED_SCENARIO &&
        options.induceTrashProbeDeadlineThenRestored === undefined
      ) {
        throw new Error("Installed hidden-trash deadline induction is unavailable");
      }
      if (
        request.scenario === TRASH_RESTORE_EVIDENCE_DEADLINE_SCENARIO &&
        (options.induceTrashRestoreEvidenceDeadline === undefined ||
          options.observeHealth === undefined)
      ) {
        throw new Error("Installed hidden-trash restore deadline induction is unavailable");
      }
      if (
        request.scenario === TRASH_CONTRARY_THIRD_PARTY_SCENARIO &&
        (options.induceTrashContraryThirdParty === undefined ||
          options.observeHealth === undefined)
      ) {
        throw new Error("Installed contrary hidden-trash induction is unavailable");
      }
      if (active !== undefined) {
        throw new Error("Installed Semantic Evidence scenario is already running");
      }
      const isEditBodyScenario =
        request.scenario === EDIT_BODY_STALE_VERSION_SCENARIO ||
        request.scenario === EDIT_BODY_MISSING_OBSERVATION_DEADLINE_SCENARIO ||
        request.scenario === EDIT_BODY_QUIET_WINDOW_CONTRADICTION_SCENARIO ||
        request.scenario === EDIT_BODY_CONTRARY_THIRD_PARTY_SCENARIO;
      const isMultiFrontmatterScenario =
        request.scenario === MULTI_FRONTMATTER_REORDERED_CALLBACKS_SCENARIO;
      const isMoveScenario =
        request.scenario === MOVE_DELAYED_RENAME_SCENARIO ||
        request.scenario === MOVE_STALE_AND_WRONG_PATH_SCENARIO ||
        request.scenario === MOVE_MISSING_RENAME_DEADLINE_SCENARIO ||
        request.scenario === MOVE_GRAPH_MISMATCH_THEN_CONVERGED_SCENARIO ||
        request.scenario === MOVE_STALE_CLOSURE_OBSERVATION_SCENARIO ||
        request.scenario === MOVE_GRAPH_MISMATCH_DEADLINE_SCENARIO;
      const isTrashScenario =
        request.scenario === TRASH_DELAYED_PROBES_SCENARIO ||
        request.scenario === TRASH_PROBE_DEADLINE_RESTORED_SCENARIO ||
        request.scenario === TRASH_RESTORE_EVIDENCE_DEADLINE_SCENARIO ||
        request.scenario === TRASH_CONTRARY_THIRD_PARTY_SCENARIO;
      if (isTrashScenario && options.refreshSeedFixtures === undefined) {
        throw new Error("Installed hidden-trash fixture refresh is unavailable");
      }
      const targetDefinitions = isTrashScenario
        ? []
        : isMoveScenario
        ? [
            { path: MOVE_DESTINATION_PATH, contentVersion: `sha256:${createHash("sha256").update(MOVE_SOURCE_BYTES).digest("hex")}` },
            ...MOVE_DERIVED_FIXTURES.map(({ path, committedBytes }) => ({
              path,
              contentVersion: `sha256:${createHash("sha256").update(committedBytes).digest("hex")}`,
            })),
          ]
        : isMultiFrontmatterScenario
        ? [
            { path: MULTI_C_PATH, contentVersion: EDIT_BODY_COMMITTED_VERSION },
            { path: MULTI_D_PATH, contentVersion: FRONTMATTER_COMMITTED_VERSION },
          ]
        : [{
            path: isEditBodyScenario ? EXACT_FIXTURE.path : CREATE_NOTE_PATH,
            contentVersion: isEditBodyScenario
              ? EDIT_BODY_COMMITTED_VERSION
              : CREATE_NOTE_CONTENT_VERSION,
          }];
      for (const path of [
        ...targetDefinitions.map(({ path }) => path),
        ...(isMoveScenario ? [MOVE_SOURCE_PATH] : []),
        ...(isTrashScenario ? [TRASH_NOTE_PATH, TRASH_REFERENCE_PATH] : []),
      ]) {
        const fixturePath = resolve(options.vaultPath, ...path.split("/"));
        if (await stat(fixturePath).then(
          () => true,
          (error: unknown) => {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
            throw error;
          },
        )) {
          throw new Error("Installed Semantic Evidence fixture path is not clean");
        }
      }
      const baseline = options.currentSnapshot();
      if (baseline === null) {
        throw new Error("Installed Semantic Evidence baseline Search Snapshot is unavailable");
      }
      let beforeInventorySha256 = canonicalInventoryDigest(
        await inventoryVault(options.vaultPath),
      );
      const submissionKey = `installed-semantic-${options.createSubmissionKey?.() ?? randomUUID()}`;
      active = {
        submissionKey,
        scenario: request.scenario,
        baselineVersion: baseline.version,
        startedAt: now(),
        targets: new Map(targetDefinitions.map(({ path, contentVersion }) => [
          path,
          {
            expectedContentVersion: contentVersion,
            metadataCacheObserved: false,
            metadataContentVersion: null,
            bomPrefixedContentVersion: null,
            committedMetadataReleased:
              request.scenario !== STALE_OBSERVATION_DEADLINE_SCENARIO &&
              request.scenario !== EDIT_BODY_STALE_VERSION_SCENARIO &&
              request.scenario !== EDIT_BODY_QUIET_WINDOW_CONTRADICTION_SCENARIO &&
              request.scenario !== MULTI_FRONTMATTER_REORDERED_CALLBACKS_SCENARIO &&
              !(
                request.scenario === MOVE_STALE_CLOSURE_OBSERVATION_SCENARIO &&
                path === MOVE_DERIVED_FIXTURES[1]?.path
              ),
            vaultChangeObserved: false,
            vaultDeleteObserved: false,
          },
        ])),
        snapshot: null,
        quietWindowResets: 0,
        acceptedSnapshotRounds: 0,
        rejectedSnapshotRounds: 0,
        snapshotObservedAt: null,
        terminalFrameObservedAt: null,
        expectedRename: isMoveScenario
          ? { oldPath: MOVE_SOURCE_PATH, path: MOVE_DESTINATION_PATH }
          : null,
        renameObserved: false,
        delayedRename: null,
        releaseDelayedRename: !isMoveScenario,
        scenarioExecutionStarted: false,
        withholdCommittedMetadataUntilRejected:
          request.scenario === STALE_OBSERVATION_DEADLINE_SCENARIO ||
          request.scenario === EDIT_BODY_STALE_VERSION_SCENARIO ||
          request.scenario === EDIT_BODY_QUIET_WINDOW_CONTRADICTION_SCENARIO ||
          request.scenario === MULTI_FRONTMATTER_REORDERED_CALLBACKS_SCENARIO ||
          request.scenario === MOVE_STALE_CLOSURE_OBSERVATION_SCENARIO,
        trashProbe: isTrashScenario
          ? {
              path: TRASH_NOTE_PATH,
              cacheVisible: true,
              referenced: true,
              convergedAt: null,
            }
          : null,
      };
      if (request.scenario === MOVE_STALE_AND_WRONG_PATH_SCENARIO) {
        await options.induceMoveStalePreBeginCallback!();
      }
      if (isEditBodyScenario || isMultiFrontmatterScenario || isMoveScenario || isTrashScenario) {
        if (options.seedPath === undefined) {
          throw new Error("Installed mutation fixture seeding is unavailable");
        }
        const seeds = isTrashScenario
          ? [
              {
                path: TRASH_NOTE_PATH,
                bytes: TRASH_NOTE_BYTES,
                version: `sha256:${createHash("sha256").update(TRASH_NOTE_BYTES).digest("hex")}`,
              },
              {
                path: TRASH_REFERENCE_PATH,
                bytes: TRASH_REFERENCE_BYTES,
                version: `sha256:${createHash("sha256").update(TRASH_REFERENCE_BYTES).digest("hex")}`,
              },
            ]
          : isMoveScenario
          ? [
              { path: MOVE_SOURCE_PATH, bytes: MOVE_SOURCE_BYTES, version: `sha256:${createHash("sha256").update(MOVE_SOURCE_BYTES).digest("hex")}` },
              ...MOVE_DERIVED_FIXTURES.map(({ path, originalBytes }) => ({
                path,
                bytes: originalBytes,
                version: `sha256:${createHash("sha256").update(originalBytes).digest("hex")}`,
              })),
            ]
          : isMultiFrontmatterScenario
          ? [
              { path: MULTI_C_PATH, bytes: EXACT_ORIGINAL_BYTES, version: EDIT_BODY_ORIGINAL_VERSION },
              {
                path: MULTI_D_PATH,
                bytes: FRONTMATTER_ORIGINAL_BYTES,
                version: FRONTMATTER_ORIGINAL_VERSION,
              },
            ]
          : [{
              path: EXACT_FIXTURE.path,
              bytes: EXACT_ORIGINAL_BYTES,
              version: EDIT_BODY_ORIGINAL_VERSION,
            }];
        for (const seed of seeds) {
          await options.seedPath(seed.path, seed.bytes);
          const activeTarget = active.targets.get(seed.path);
          if (activeTarget !== undefined) {
            await waitForInstalledObservation(
              () => active?.targets.get(seed.path)?.metadataContentVersion === seed.version ||
                active?.targets.get(seed.path)?.bomPrefixedContentVersion === seed.version,
              "mutation baseline metadata Content Version",
            );
          }
        }
        if (options.refreshSeedFixtures !== undefined) {
          const seedSnapshot = await options.refreshSeedFixtures();
          if (
            !seedSnapshot.immutable ||
            seedSnapshot.version <= active.baselineVersion
          ) {
            throw new Error(
              "Installed mutation fixtures lack an immutable successor Search Snapshot",
            );
          }
          active.baselineVersion = seedSnapshot.version;
          active.startedAt = now();
          active.snapshot = null;
          active.snapshotObservedAt = null;
        }
        beforeInventorySha256 = canonicalInventoryDigest(
          await inventoryVault(options.vaultPath),
        );
        for (const target of active.targets.values()) {
          target.vaultChangeObserved = false;
        }
      }
      let cleanupSucceeded = false;
      try {
        active.scenarioExecutionStarted = true;
        const submission = options.wire.submit({
          endpoint: request.endpoint,
          expectedVaultId: request.expectedVaultId,
          input: isTrashScenario
            ? {
                submissionKey,
                operations: [{
                  operationId: `trash-${submissionKey}`,
                  kind: "trash",
                  path: TRASH_NOTE_PATH,
                  targetVersion: `sha256:${createHash("sha256").update(TRASH_NOTE_BYTES).digest("hex")}`,
                }],
              }
            : isMoveScenario
            ? {
                submissionKey,
                operations: [{
                  operationId: `move-${submissionKey}`,
                  kind: "move",
                  sourcePath: MOVE_SOURCE_PATH,
                  destinationPath: MOVE_DESTINATION_PATH,
                  targetVersion: `sha256:${createHash("sha256").update(MOVE_SOURCE_BYTES).digest("hex")}`,
                  linkEffect: "update_resolved_references",
                }],
              }
            : isMultiFrontmatterScenario
            ? {
                submissionKey,
                operations: [
                  {
                    operationId: `multi-c-${submissionKey}`,
                    kind: "edit_body",
                    path: MULTI_C_PATH,
                    targetVersion: EDIT_BODY_ORIGINAL_VERSION,
                    edit: {
                      kind: "replace_exact",
                      old: EXACT_FIXTURE.oldText,
                      replacement: EXACT_FIXTURE.replacementText,
                      expectedOccurrences: 1,
                    },
                  },
                  {
                    operationId: `multi-d-${submissionKey}`,
                    kind: "edit_frontmatter",
                    path: MULTI_D_PATH,
                    targetVersion: FRONTMATTER_ORIGINAL_VERSION,
                    changes: [...FRONTMATTER_FIXTURE.changes],
                  },
                ],
              }
            : isEditBodyScenario
            ? {
                submissionKey,
                operations: [
                  {
                    operationId: `edit-${submissionKey}`,
                    kind: "edit_body",
                    path: EXACT_FIXTURE.path,
                    targetVersion: EDIT_BODY_ORIGINAL_VERSION,
                    edit: {
                      kind: "replace_exact",
                      old: EXACT_FIXTURE.oldText,
                      replacement: EXACT_FIXTURE.replacementText,
                      expectedOccurrences: 1,
                    },
                  },
                ],
              }
            : {
                submissionKey,
                operations: [
                  {
                    operationId: `create-${submissionKey}`,
                    kind: "create_note",
                    path: CREATE_NOTE_PATH,
                    content: CREATE_NOTE_CONTENT,
                    ifExists: "reject",
                  },
                ],
              },
        });
        if (request.scenario === QUIET_WINDOW_RESET_SCENARIO) {
          await waitForInstalledObservation(
            () => active !== undefined && [...active.targets.values()].every(
                ({ vaultChangeObserved }) => vaultChangeObserved,
              ),
            "Vault create event",
          );
          await options.induceQuietWindowResets!();
        } else if (request.scenario === STALE_OBSERVATIONS_THEN_FRESH_SCENARIO) {
          await waitForInstalledObservation(
            () => active !== undefined && [...active.targets.values()].every(
                ({ vaultChangeObserved }) => vaultChangeObserved,
              ),
            "Vault create event",
          );
          await options.induceStaleObservationsThenFresh!();
        } else if (request.scenario === STALE_OBSERVATION_DEADLINE_SCENARIO) {
          await waitForInstalledObservation(
            () => active !== undefined && [...active.targets.values()].every(
                ({ vaultChangeObserved }) => vaultChangeObserved,
              ),
            "Vault create event",
          );
          await options.induceStaleObservationDeadline!();
        } else if (request.scenario === EDIT_BODY_STALE_VERSION_SCENARIO) {
          await waitForInstalledObservation(
            () => active !== undefined && [...active.targets.values()].every(
                ({ vaultChangeObserved }) => vaultChangeObserved,
              ),
            "Vault change event",
          );
          await options.induceEditBodyStaleThenFresh!({
            committedContentVersion: EDIT_BODY_COMMITTED_VERSION,
            waitForCommittedMetadataContentVersion: () =>
              waitForInstalledObservation(
                () => active?.targets.get(EXACT_FIXTURE.path)?.metadataContentVersion ===
                  EDIT_BODY_COMMITTED_VERSION,
                "edit-body committed metadata Content Version",
              ),
          });
        } else if (
          request.scenario === EDIT_BODY_MISSING_OBSERVATION_DEADLINE_SCENARIO
        ) {
          await waitForInstalledObservation(
            () => active !== undefined && [...active.targets.values()].every(
                ({ vaultChangeObserved }) => vaultChangeObserved,
              ),
            "Vault change event",
          );
          await options.induceEditBodyMissingObservationDeadline!();
        } else if (
          request.scenario === EDIT_BODY_QUIET_WINDOW_CONTRADICTION_SCENARIO
        ) {
          await waitForInstalledObservation(
            () => active !== undefined && [...active.targets.values()].every(
                ({ vaultChangeObserved }) => vaultChangeObserved,
              ),
            "Vault change event",
          );
          await options.induceEditBodyQuietWindowContradiction!();
        } else if (
          request.scenario === EDIT_BODY_CONTRARY_THIRD_PARTY_SCENARIO
        ) {
          await waitForInstalledObservation(
            () => active !== undefined && [...active.targets.values()].every(
                ({ vaultChangeObserved }) => vaultChangeObserved,
              ),
            "Vault change event",
          );
          await options.induceEditBodyContraryThirdParty!();
        } else if (
          request.scenario === MULTI_FRONTMATTER_REORDERED_CALLBACKS_SCENARIO
        ) {
          await waitForInstalledObservation(
            () => active !== undefined && [...active.targets.values()].every(
              ({ vaultChangeObserved }) => vaultChangeObserved,
            ),
            "multi-file Vault change events",
          );
          await options.induceMultiFrontmatterReorderedCallbacks!();
        } else if (request.scenario === MOVE_DELAYED_RENAME_SCENARIO) {
          await options.induceMoveDelayedRename!();
        } else if (request.scenario === MOVE_STALE_AND_WRONG_PATH_SCENARIO) {
          await options.induceMoveStaleAndWrongPathCallbacks!();
        } else if (
          request.scenario === MOVE_GRAPH_MISMATCH_THEN_CONVERGED_SCENARIO
        ) {
          await options.induceMoveGraphMismatchThenConverged!();
        } else if (
          request.scenario === MOVE_STALE_CLOSURE_OBSERVATION_SCENARIO
        ) {
          await options.induceMoveStaleClosureObservation!();
        } else if (
          request.scenario === MOVE_GRAPH_MISMATCH_DEADLINE_SCENARIO
        ) {
          await options.induceMoveGraphMismatchDeadline!();
        } else if (request.scenario === TRASH_DELAYED_PROBES_SCENARIO) {
          await options.induceTrashDelayedProbes!();
        } else if (
          request.scenario === TRASH_PROBE_DEADLINE_RESTORED_SCENARIO
        ) {
          await options.induceTrashProbeDeadlineThenRestored!();
        } else if (
          request.scenario === TRASH_RESTORE_EVIDENCE_DEADLINE_SCENARIO
        ) {
          await options.induceTrashRestoreEvidenceDeadline!();
        } else if (
          request.scenario === TRASH_CONTRARY_THIRD_PARTY_SCENARIO
        ) {
          await options.induceTrashContraryThirdParty!();
        }
        const submitted = await submission;
        const status = await options.wire.status({
          endpoint: request.endpoint,
          expectedVaultId: request.expectedVaultId,
          submissionKey,
        });
        const frame = await options.loadRecoveryFrame();
        const isUnprovenScenario =
          request.scenario === EDIT_BODY_CONTRARY_THIRD_PARTY_SCENARIO ||
          request.scenario === TRASH_RESTORE_EVIDENCE_DEADLINE_SCENARIO ||
          request.scenario === TRASH_CONTRARY_THIRD_PARTY_SCENARIO;
        const snapshot = isUnprovenScenario
          ? active.snapshot
          : active.snapshot ?? options.currentSnapshot();
        const isMoveDeadlineScenario =
          request.scenario === MOVE_MISSING_RENAME_DEADLINE_SCENARIO;
        const isMoveGraphDeadlineScenario =
          request.scenario === MOVE_GRAPH_MISMATCH_DEADLINE_SCENARIO;
        const isTrashProbeDeadlineScenario =
          request.scenario === TRASH_PROBE_DEADLINE_RESTORED_SCENARIO;
        const isCreateNoteDeadlineScenario =
          request.scenario === STALE_OBSERVATION_DEADLINE_SCENARIO;
        const isDeadlineScenario =
          isCreateNoteDeadlineScenario ||
          isMoveDeadlineScenario ||
          isMoveGraphDeadlineScenario ||
          isTrashProbeDeadlineScenario ||
          request.scenario === EDIT_BODY_MISSING_OBSERVATION_DEADLINE_SCENARIO;
        const expectsBarrierAccounting =
          request.scenario === STALE_OBSERVATIONS_THEN_FRESH_SCENARIO ||
          request.scenario === EDIT_BODY_STALE_VERSION_SCENARIO ||
          request.scenario === EDIT_BODY_QUIET_WINDOW_CONTRADICTION_SCENARIO ||
          request.scenario === MULTI_FRONTMATTER_REORDERED_CALLBACKS_SCENARIO ||
          request.scenario === MOVE_GRAPH_MISMATCH_THEN_CONVERGED_SCENARIO ||
          request.scenario === MOVE_STALE_CLOSURE_OBSERVATION_SCENARIO ||
          isUnprovenScenario ||
          isDeadlineScenario;
        const minimumRejectedRounds =
          request.scenario === MOVE_GRAPH_MISMATCH_THEN_CONVERGED_SCENARIO ||
            request.scenario === MOVE_STALE_CLOSURE_OBSERVATION_SCENARIO ||
            request.scenario === MOVE_GRAPH_MISMATCH_DEADLINE_SCENARIO
            ? 1
            : isMoveScenario && !isMoveDeadlineScenario
            ? 0
            : request.scenario === STALE_OBSERVATIONS_THEN_FRESH_SCENARIO ||
              request.scenario === MULTI_FRONTMATTER_REORDERED_CALLBACKS_SCENARIO
            ? 2
            : 1;
        const expectedProofState = isUnprovenScenario
          ? "result_unproven"
          : isDeadlineScenario ? "intent_not_applied" : "intent_applied";
        const expectedJournalPhase = isUnprovenScenario
          ? "FAILED"
          : isDeadlineScenario ? "ROLLED_BACK" : "COMMITTED";
        const health = isUnprovenScenario
          ? await options.observeHealth!({
              endpoint: request.endpoint,
              expectedVaultId: request.expectedVaultId,
            })
          : null;
        const hasExpectedSnapshot = isUnprovenScenario
          ? snapshot === null &&
            active.acceptedSnapshotRounds === 0 &&
            active.snapshotObservedAt === null
          : snapshot !== null &&
            snapshot.version > active.baselineVersion &&
            snapshot.immutable &&
            active.snapshotObservedAt !== null &&
            active.snapshotObservedAt - active.startedAt >= 250;
        const allTargetsChanged = [...active.targets.values()].every(
          ({ vaultChangeObserved }) => vaultChangeObserved,
        );
        const allTargetsDeleted = [...active.targets.values()].every(
          ({ vaultDeleteObserved }) => vaultDeleteObserved,
        );
        const allMetadataObserved = [...active.targets.values()].every(
          ({ metadataCacheObserved }) => metadataCacheObserved,
        );
        const requiredMetadataObserved = isMoveScenario || allMetadataObserved;
        const allMetadataMatches = [...active.targets.values()].every(
          ({ expectedContentVersion, metadataContentVersion }) =>
            metadataContentVersion === expectedContentVersion,
        );
        if (request.scenario === TRASH_CONTRARY_THIRD_PARTY_SCENARIO &&
            options.observeTrashProbes !== undefined) {
          const deadline = Date.now() + 5_000;
          while (true) {
            const observation = await options.observeTrashProbes(TRASH_NOTE_PATH);
            active.trashProbe!.cacheVisible = observation.cacheVisible;
            active.trashProbe!.referenced = observation.referenced;
            if (observation.cacheVisible && !observation.referenced) break;
            if (Date.now() >= deadline) {
              throw new Error("Installed foreign trash residue lacks cache/reference observation");
            }
            await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
          }
        }
        const trashProbeConverged = !isTrashScenario ||
          (request.scenario === TRASH_RESTORE_EVIDENCE_DEADLINE_SCENARIO ||
              request.scenario === TRASH_CONTRARY_THIRD_PARTY_SCENARIO
            ? active.trashProbe?.cacheVisible === true &&
              active.trashProbe.referenced === false
            : isTrashProbeDeadlineScenario
            ? active.trashProbe?.cacheVisible === true &&
              active.trashProbe.referenced === true
            : active.trashProbe?.cacheVisible === false &&
              active.trashProbe.referenced === false &&
              active.trashProbe.convergedAt !== null);
        const hasExpectedMoveEvidence = !isMoveScenario || active.renameObserved;
        if (
          submitted.proofState !== expectedProofState ||
          status.proofState !== expectedProofState ||
          frame?.phase !== expectedJournalPhase ||
          frame.input.submissionKey !== submissionKey ||
          active.terminalFrameObservedAt === null ||
          (!isMoveDeadlineScenario && !hasExpectedMoveEvidence) ||
          (!isDeadlineScenario && !allTargetsChanged && !isMoveScenario && !isTrashScenario) ||
          (isCreateNoteDeadlineScenario && !allTargetsDeleted) ||
          !requiredMetadataObserved ||
          !trashProbeConverged ||
          (!isDeadlineScenario && !isUnprovenScenario &&
            (expectsBarrierAccounting || isMoveScenario) &&
            (!allMetadataMatches ||
              active.acceptedSnapshotRounds !== 1 ||
              active.rejectedSnapshotRounds < minimumRejectedRounds)) ||
          ((isDeadlineScenario || isUnprovenScenario) &&
            !isMoveDeadlineScenario &&
            !isTrashProbeDeadlineScenario &&
            request.scenario !== TRASH_RESTORE_EVIDENCE_DEADLINE_SCENARIO &&
            request.scenario !== TRASH_CONTRARY_THIRD_PARTY_SCENARIO &&
            active.rejectedSnapshotRounds < 1) ||
          (isUnprovenScenario &&
            (health?.recoveryBlocked !== true ||
              health.writesBlocked !== true ||
              health.effectiveGate !== "recovery_blocked")) ||
          !hasExpectedSnapshot
        ) {
          throw new Error(
            "Installed clean convergence lacks bound snapshot, journal, or status proof",
          );
        }
        const afterInventorySha256 = canonicalInventoryDigest(
          await inventoryVault(options.vaultPath),
        );
        const residueSha256 = request.scenario === TRASH_CONTRARY_THIRD_PARTY_SCENARIO
          ? createHash("sha256").update(
              await readFile(resolve(options.vaultPath, ...TRASH_NOTE_PATH.split("/"))),
            ).digest("hex")
          : isUnprovenScenario && !isTrashScenario
          ? createHash("sha256").update(
              await readFile(resolve(options.vaultPath, ...EXACT_FIXTURE.path.split("/"))),
            ).digest("hex")
          : undefined;
        const summary: InstalledSemanticEvidenceScenarioSummary = {
          scenario: request.scenario,
          source: "installed-obsidian",
          mutationKind: isTrashScenario
            ? "trash_note"
            : isMoveScenario
            ? "move_note"
            : isMultiFrontmatterScenario
            ? "edit_multi_frontmatter"
            : isEditBodyScenario ? "edit_body" : "create_note",
          proofState: submitted.proofState,
          statusProofState: status.proofState,
          journalPhase: frame.phase,
          evidenceDeadlineMs: 5_000,
          successBarrierDeadlineMs: 5_000,
          evidenceSessions: isUnprovenScenario
            ? request.scenario === TRASH_RESTORE_EVIDENCE_DEADLINE_SCENARIO
              ? [
                  {
                    mode: "apply",
                    outcome: "timed_out",
                    virtualElapsedMs: 5_000,
                  },
                  {
                    mode: "restore",
                    outcome: "timed_out",
                    virtualElapsedMs: 5_000,
                  },
                ]
              : [
                  {
                    mode: "apply",
                    outcome: "timed_out",
                    virtualElapsedMs: 5_000,
                  },
                ]
            : isMoveGraphDeadlineScenario
            ? [
                {
                  mode: "apply",
                  outcome: "converged",
                  virtualElapsedMs: 5_000,
                },
                {
                  mode: "restore",
                  outcome: "converged",
                  virtualElapsedMs: active.snapshotObservedAt! - active.startedAt,
                },
              ]
            : isDeadlineScenario
            ? [
                {
                  mode: "apply",
                  outcome: "timed_out",
                  virtualElapsedMs: 5_000,
                },
                {
                  mode: "restore",
                  outcome: "converged",
                  virtualElapsedMs: active.snapshotObservedAt! - active.startedAt,
                },
              ]
            : [
                {
                  mode: "apply",
                  outcome: "converged",
                  virtualElapsedMs: isTrashScenario
                    ? active.trashProbe!.convergedAt! - active.startedAt
                    : active.snapshotObservedAt! - active.startedAt,
                },
              ],
          quietWindowResets: active.quietWindowResets,
          acceptedSnapshotRounds:
            isUnprovenScenario ? 0 : isDeadlineScenario ? 1 : expectsBarrierAccounting
              ? active.acceptedSnapshotRounds
              : 1,
          rejectedSnapshotRounds: active.rejectedSnapshotRounds,
          successorSnapshot: {
            baselineVersion: active.baselineVersion,
            version: snapshot?.version ?? null,
            immutable: snapshot?.immutable ?? false,
            publishedBeforeIntentApplied: !isDeadlineScenario && !isUnprovenScenario,
          },
          durableCommitBeforeIntentApplied:
            !isDeadlineScenario && !isUnprovenScenario,
          writesBlocked: isUnprovenScenario,
          ...(residueSha256 === undefined ? {} : { residueSha256 }),
          beforeInventorySha256,
          afterInventorySha256,
          cleanupSucceeded: true,
        };
        return summary;
      } finally {
        try {
          for (const path of [
            ...targetDefinitions.map(({ path }) => path),
            ...(isTrashScenario ? [TRASH_NOTE_PATH, TRASH_REFERENCE_PATH] : []),
          ]) {
            await options.cleanupPath(path);
          }
          await options.refreshAfterCleanup?.();
          cleanupSucceeded = true;
        } finally {
          active = undefined;
        }
        if (!cleanupSucceeded) {
          throw new Error("Installed Semantic Evidence fixture cleanup failed");
        }
      }
    },
  };
}
