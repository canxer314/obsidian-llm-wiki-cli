import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  parseHealthResult,
  serializeCompatibilityText,
} from "@llm-wiki/vault-contracts";

import { EXPECTED_VAULT_ID_HEADER } from "../request-policy.js";
import { SEARCH_SNAPSHOT_QUIET_WINDOW_MS } from "../search-snapshot.js";
import {
  CHANGE_SET_SEMANTIC_EVIDENCE_DEADLINE_MS,
} from "../file-system-change-set-execution.js";
import {
  SEMANTIC_SUCCESS_BARRIER_DEADLINE_MS,
} from "../corpus/semantic-evidence-corpus.js";
import { PUBLIC_WIRE_TOOL_NAMES } from "./public-wire-corpus.js";
import type { SemanticEvidenceCorpusEvidence } from "./evidence.js";

/**
 * Installed-runtime Semantic Evidence/Search Snapshot tracer (issue #179).
 *
 * The active candidate Bridge is reached through the same authenticated
 * loopback transport as the six-tool corpus. Each scenario command is bound to
 * an installed candidate descriptor and runs through the plugin-side Obsidian
 * Vault, metadata-cache, graph, Search Snapshot, journal, and rollback paths.
 * This keeps the installed transport proof and byte/cache/graph proof in one
 * closed envelope while never exposing Search Snapshot as a public capability.
 */

export const SEMANTIC_EVIDENCE_SEARCH_SNAPSHOT_CORPUS_ID =
  "semantic-evidence-search-snapshot-proof";

export const SEMANTIC_EVIDENCE_SEARCH_SNAPSHOT_SCENARIO_PLAN = [
  "create_note/clean_convergence",
  "create_note/quiet_window_reset",
  "create_note/stale_observations_then_fresh",
  "create_note/stale_observation_deadline",
  "edit_body/stale_version_callback_after_newer_bytes",
  "edit_body/missing_observation_deadline",
  "edit_body/quiet_window_contradiction",
  "edit_body/contrary_third_party_blocks_writes",
  "edit_multi_frontmatter/reordered_cache_callbacks",
  "move_note/delayed_rename_callback",
  "move_note/stale_and_wrong_path_callbacks_ignored",
  "move_note/missing_rename_event_deadline",
  "move_note/graph_mismatch_then_converged",
  "move_note/stale_closure_observation",
  "move_note/graph_mismatch_deadline_rollback",
  "trash_note/delayed_probes_converge",
  "trash_note/probe_deadline_then_restored",
  "trash_note/restore_evidence_deadline_blocks_writes",
  "trash_note/contrary_third_party_blocks_writes",
] as const;

export type SemanticEvidenceSearchSnapshotScenarioName =
  (typeof SEMANTIC_EVIDENCE_SEARCH_SNAPSHOT_SCENARIO_PLAN)[number];

export class SemanticEvidenceSearchSnapshotCorpusError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SemanticEvidenceSearchSnapshotCorpusError";
  }
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, canonicalize(nested)]),
  );
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function manifestSha256(): string {
  return sha256(
    JSON.stringify(
      canonicalize({
        corpusId: SEMANTIC_EVIDENCE_SEARCH_SNAPSHOT_CORPUS_ID,
        scenarios: [...SEMANTIC_EVIDENCE_SEARCH_SNAPSHOT_SCENARIO_PLAN],
      }),
    ),
  );
}

function inventorySha256(
  inventory: readonly { readonly path: string; readonly kind: string; readonly sha256?: string; readonly bytes?: number }[],
): string {
  return sha256(
    inventory
      .map(({ path, kind, sha256: digest, bytes }) => `${kind}\t${digest ?? ""}\t${bytes ?? ""}\t${path}`)
      .sort()
      .join("\n"),
  );
}

function exactText(result: { readonly content?: readonly unknown[] }): string {
  const text = result.content?.find(
    (item): item is { readonly type: "text"; readonly text: string } =>
      typeof item === "object" &&
      item !== null &&
      (item as { readonly type?: unknown }).type === "text" &&
      typeof (item as { readonly text?: unknown }).text === "string",
  );
  if (text === undefined) {
    throw new SemanticEvidenceSearchSnapshotCorpusError(
      "Semantic-evidence transport response has no compatibility text",
    );
  }
  return text.text;
}

function assertScenarioPlan(scenarios: readonly string[]): void {
  const actual = [...scenarios];
  const expected = [...SEMANTIC_EVIDENCE_SEARCH_SNAPSHOT_SCENARIO_PLAN];
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new SemanticEvidenceSearchSnapshotCorpusError(
      "Semantic Evidence scenario program diverged from its installed-runtime manifest",
    );
  }
}

type InstalledSemanticEvidenceScenario = SemanticEvidenceCorpusEvidence["scenarios"][number];

export interface InstalledSemanticEvidenceScenarioRunner {
  run(options: {
    readonly scenario: SemanticEvidenceSearchSnapshotScenarioName;
    readonly endpoint: URL;
    readonly expectedVaultId: string;
    readonly workingDirectory: string;
  }): Promise<InstalledSemanticEvidenceScenario>;
}

interface InstalledRuntimeObservation {
  readonly tools: readonly string[];
  readonly vaultId: string;
}

export interface SemanticEvidenceSearchSnapshotOutcome {
  readonly scenarioManifestSha256: string;
  readonly tools: readonly string[];
  readonly scenarios: readonly SemanticEvidenceCorpusEvidence["scenarios"][number][];
  readonly coverage: SemanticEvidenceCorpusEvidence["coverage"];
  readonly residualCleanup: SemanticEvidenceCorpusEvidence["residualCleanup"];
  readonly assertions: readonly string[];
}

/**
 * Runs the installed-runtime transport proof and every shared Semantic Evidence
 * scenario. Scenario report files are temporary supervision artifacts and are
 * removed before the outcome returns; only digest-only summaries enter evidence.
 */
export async function runSemanticEvidenceSearchSnapshotCorpusAtEndpoint(options: {
  readonly endpoint: URL;
  readonly expectedVaultId: string;
  readonly workingDirectory: string;
  readonly record: (kind: "transport" | "tool" | "assertion" | "cleanup", name: string, detail: unknown) => void;
  readonly assertion: (name: string) => void;
  readonly scenarioRunner: InstalledSemanticEvidenceScenarioRunner;
  readonly scenarios?: readonly SemanticEvidenceSearchSnapshotScenarioName[];
  readonly observeInstalledRuntime?: () => Promise<InstalledRuntimeObservation>;
}): Promise<SemanticEvidenceSearchSnapshotOutcome> {
  if (options.endpoint.protocol !== "http:" || options.endpoint.hostname !== "127.0.0.1") {
    throw new SemanticEvidenceSearchSnapshotCorpusError(
      "Semantic-evidence corpus requires a 127.0.0.1 HTTP endpoint",
    );
  }
  const scenarios = options.scenarios ?? SEMANTIC_EVIDENCE_SEARCH_SNAPSHOT_SCENARIO_PLAN;
  assertScenarioPlan(scenarios);
  const assertions: string[] = [];
  const assertion = (name: string): void => {
    assertions.push(name);
    options.assertion(name);
  };
  const client = new Client({
    name: "installed-runtime-semantic-evidence-corpus",
    version: "1.0.0",
  });
  const transport = new StreamableHTTPClientTransport(options.endpoint, {
    requestInit: { headers: { [EXPECTED_VAULT_ID_HEADER]: options.expectedVaultId } },
  });
  const reportDirectory = await mkdtemp(join(options.workingDirectory, "semantic-evidence-proof-"));
  let reportDirectoryRemoved = false;
  let tools: readonly string[];
  try {
    if (options.observeInstalledRuntime !== undefined) {
      const observation = await options.observeInstalledRuntime();
      tools = [...observation.tools].sort();
      if (observation.vaultId !== options.expectedVaultId) {
        throw new SemanticEvidenceSearchSnapshotCorpusError(
          "Semantic-evidence corpus connected to the wrong Managed Vault",
        );
      }
    } else {
      await client.connect(transport);
      options.record("transport", "streamable-http-connected", { endpoint: options.endpoint.pathname });
      const inventory = await client.listTools();
      tools = inventory.tools.map(({ name }) => name).sort();

      const healthResult = (await client.callTool({
        name: "vault_health",
        arguments: {},
      })) as { readonly isError?: boolean; readonly structuredContent?: unknown; readonly content?: readonly unknown[] };
      if (healthResult.isError === true || healthResult.structuredContent === undefined) {
        throw new SemanticEvidenceSearchSnapshotCorpusError(
          "Semantic-evidence corpus could not observe installed runtime health",
        );
      }
      const health = parseHealthResult(healthResult.structuredContent);
      if (exactText(healthResult) !== serializeCompatibilityText(health)) {
        throw new SemanticEvidenceSearchSnapshotCorpusError(
          "Installed runtime health compatibility text diverged from structured content",
        );
      }
      if (health.outcome !== "observed" || health.vault.id !== options.expectedVaultId) {
        throw new SemanticEvidenceSearchSnapshotCorpusError(
          "Semantic-evidence corpus connected to the wrong or incompatible Managed Vault",
        );
      }
      options.record("tool", "vault_health", healthResult.structuredContent);
    }
    const expectedTools = [...PUBLIC_WIRE_TOOL_NAMES].sort();
    if (JSON.stringify(tools) !== JSON.stringify(expectedTools)) {
      throw new SemanticEvidenceSearchSnapshotCorpusError(
        "The installed runtime exposed a public capability outside the six-tool contract",
      );
    }
    options.record("assertion", "six-tool-inventory-without-search-snapshot", tools);
    assertion("transport:six-tool-inventory-without-search-snapshot");
    assertion("transport:installed-vault-health-observed");

    const summaries: InstalledSemanticEvidenceScenario[] = [];
    for (const scenario of scenarios) {
      const summary = await options.scenarioRunner.run({
        scenario,
        endpoint: options.endpoint,
        expectedVaultId: options.expectedVaultId,
        workingDirectory: reportDirectory,
      });
      if (summary.source !== "installed-obsidian") {
        throw new SemanticEvidenceSearchSnapshotCorpusError(
          `Semantic Evidence scenario ${scenario} did not come from the installed Obsidian runtime`,
        );
      }
      if (summary.scenario !== scenario) {
        throw new SemanticEvidenceSearchSnapshotCorpusError(
          `Semantic Evidence scenario runner returned ${summary.scenario} for ${scenario}`,
        );
      }
      if (
        summary.evidenceDeadlineMs !== CHANGE_SET_SEMANTIC_EVIDENCE_DEADLINE_MS ||
        summary.successBarrierDeadlineMs !== SEMANTIC_SUCCESS_BARRIER_DEADLINE_MS
      ) {
        throw new SemanticEvidenceSearchSnapshotCorpusError(
          `Semantic Evidence scenario ${scenario} changed an installed deadline`,
        );
      }
      if (summary.proofState === "intent_applied") {
        if (!summary.successorSnapshot.publishedBeforeIntentApplied) {
          throw new SemanticEvidenceSearchSnapshotCorpusError(
            `Semantic Evidence scenario ${scenario} reported success without an immutable successor Search Snapshot`,
          );
        }
        if (!summary.durableCommitBeforeIntentApplied) {
          throw new SemanticEvidenceSearchSnapshotCorpusError(
            `Semantic Evidence scenario ${scenario} reported success before durable COMMITTED`,
          );
        }
      }
      summaries.push(summary);
      options.record("assertion", "semantic-evidence-scenario", {
        scenario: summary.scenario,
        proofState: summary.proofState,
        journalPhase: summary.journalPhase,
        acceptedSnapshotRounds: summary.acceptedSnapshotRounds,
        rejectedSnapshotRounds: summary.rejectedSnapshotRounds,
      });
      assertion(`scenario:${summary.scenario}:closed`);
    }

    const coverage = {
      delayedOlderContentVersionRejected: summaries.some(
        ({ scenario }) => scenario === "edit_body/stale_version_callback_after_newer_bytes",
      ),
      quietWindowStabilityProven: summaries.some(
        ({ scenario, quietWindowResets }) =>
          scenario === "create_note/quiet_window_reset" && quietWindowResets > 0,
      ),
      createModifyRenameDeleteAndClosureProven:
        summaries.some(({ scenario }) => scenario.startsWith("create_note/")) &&
        summaries.some(({ scenario }) => scenario.startsWith("edit_body/")) &&
        summaries.some(({ scenario }) => scenario.startsWith("move_note/")) &&
        summaries.some(({ scenario }) => scenario.startsWith("trash_note/")) &&
        summaries.some(({ scenario }) => scenario === "move_note/graph_mismatch_then_converged"),
      hiddenTrashRestoreUsesTargetedProbes: summaries.some(
        ({ scenario, evidenceSessions }) =>
          scenario === "trash_note/delayed_probes_converge" &&
          evidenceSessions.some(({ mode, outcome }) => mode === "apply" && outcome === "converged"),
      ),
      deadlineRollbackOrUnprovenProven: summaries.some(
        ({ evidenceSessions, proofState }) =>
          evidenceSessions.some(({ outcome }) => outcome === "timed_out") &&
          (proofState === "intent_not_applied" || proofState === "result_unproven"),
      ),
      contraryEvidenceResetsQuietWindow: summaries.some(
        ({ scenario, quietWindowResets }) =>
          scenario === "edit_body/quiet_window_contradiction" && quietWindowResets > 0,
      ),
      noPublicSearchSnapshotCapability: true,
    } as const;
    if (!Object.values(coverage).every(Boolean)) {
      throw new SemanticEvidenceSearchSnapshotCorpusError(
        "Semantic Evidence scenario plan did not cover every required failure-closed branch",
      );
    }
    const provenCoverage: SemanticEvidenceCorpusEvidence["coverage"] = {
      delayedOlderContentVersionRejected: true,
      quietWindowStabilityProven: true,
      createModifyRenameDeleteAndClosureProven: true,
      hiddenTrashRestoreUsesTargetedProbes: true,
      deadlineRollbackOrUnprovenProven: true,
      contraryEvidenceResetsQuietWindow: true,
      noPublicSearchSnapshotCapability: true,
    };
    if (SEARCH_SNAPSHOT_QUIET_WINDOW_MS !== 250) {
      throw new SemanticEvidenceSearchSnapshotCorpusError(
        "Semantic Evidence corpus requires the installed 250 ms quiet window",
      );
    }
    assertion("coverage:all-semantic-evidence-and-search-snapshot-obligations");

    return {
      scenarioManifestSha256: manifestSha256(),
      tools,
      scenarios: summaries,
      coverage: provenCoverage,
      residualCleanup: {
        reportsRemoved: true,
        residualReportPaths: [],
      },
      assertions,
    };
  } finally {
    await client.close().catch(() => undefined);
    try {
      await rm(reportDirectory, { recursive: true, force: true });
      reportDirectoryRemoved = true;
    } finally {
      options.record("cleanup", "semantic-evidence-temporary-reports", {
        reportsRemoved: reportDirectoryRemoved,
      });
    }
  }
}

function eventSha256(detail: unknown): string {
  return sha256(JSON.stringify(canonicalize(detail)));
}

export function composeSemanticEvidenceSearchSnapshotCorpusEvidence(options: {
  readonly outcome: SemanticEvidenceSearchSnapshotOutcome;
  readonly events: readonly {
    kind: "transport" | "tool" | "assertion" | "cleanup";
    name: string;
    detail: unknown;
  }[];
  readonly assertions: readonly string[];
}): SemanticEvidenceCorpusEvidence {
  if (options.outcome.assertions.length === 0 || options.assertions.length === 0) {
    throw new SemanticEvidenceSearchSnapshotCorpusError(
      "Semantic Evidence corpus evidence requires scenario assertions",
    );
  }
  return {
    corpusId: SEMANTIC_EVIDENCE_SEARCH_SNAPSHOT_CORPUS_ID,
    scenarioManifestSha256: options.outcome.scenarioManifestSha256,
    tools: [...options.outcome.tools],
    scenarios: options.outcome.scenarios.map((scenario) => ({
      ...scenario,
      evidenceSessions: scenario.evidenceSessions.map((session) => ({ ...session })),
      successorSnapshot: { ...scenario.successorSnapshot },
    })),
    coverage: { ...options.outcome.coverage },
    residualCleanup: { ...options.outcome.residualCleanup },
    eventLog: options.events.map((event, index) => ({
      sequence: index + 1,
      kind: event.kind,
      name: event.name,
      detailSha256: eventSha256(event.detail),
    })),
    assertions: [...options.assertions],
    verdict: "passed",
  };
}
