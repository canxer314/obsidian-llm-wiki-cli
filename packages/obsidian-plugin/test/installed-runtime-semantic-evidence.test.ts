import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  SEMANTIC_EVIDENCE_SEARCH_SNAPSHOT_SCENARIO_PLAN,
  runSemanticEvidenceSearchSnapshotCorpusAtEndpoint,
  type InstalledSemanticEvidenceScenarioRunner,
} from "../src/index.js";

let workingDirectory: string;

beforeEach(async () => {
  workingDirectory = await mkdtemp(join(tmpdir(), "installed-semantic-evidence-test-"));
});

afterEach(async () => {
  await rm(workingDirectory, { recursive: true, force: true });
});

describe("installed-runtime Semantic Evidence corpus", () => {
  it("requires every scenario report to come from the installed Obsidian runtime", async () => {
    const runner: InstalledSemanticEvidenceScenarioRunner = {
      run: vi.fn(async ({ scenario }) => {
        const timedOut =
          scenario === "edit_body/missing_observation_deadline" ||
          scenario === "trash_note/probe_deadline_then_restored";
        return {
        scenario,
        source: "installed-obsidian" as const,
        mutationKind: scenario.split("/")[0]!,
        proofState: timedOut ? "intent_not_applied" as const : "intent_applied" as const,
        statusProofState: timedOut ? "intent_not_applied" as const : "intent_applied" as const,
        journalPhase: timedOut ? "ROLLED_BACK" as const : "COMMITTED" as const,
        evidenceDeadlineMs: 5_000 as const,
        successBarrierDeadlineMs: 5_000 as const,
        evidenceSessions: [
          {
            mode: "apply" as const,
            outcome: timedOut ? "timed_out" as const : "converged" as const,
            virtualElapsedMs: 250,
          },
        ],
        quietWindowResets:
          scenario === "create_note/quiet_window_reset" ||
          scenario === "edit_body/quiet_window_contradiction"
            ? 1
            : 0,
        acceptedSnapshotRounds: 1,
        rejectedSnapshotRounds: 1,
        successorSnapshot: {
          baselineVersion: 1,
          version: 2,
          immutable: true,
          publishedBeforeIntentApplied: true,
        },
        durableCommitBeforeIntentApplied: true,
        writesBlocked: false,
        beforeInventorySha256: "a".repeat(64),
        afterInventorySha256: "b".repeat(64),
        cleanupSucceeded: true as const,
      };
      }),
    };

    await expect(
      runSemanticEvidenceSearchSnapshotCorpusAtEndpoint({
        endpoint: new URL("http://127.0.0.1:32123/mcp"),
        expectedVaultId: "vault-id",
        workingDirectory,
        record: () => undefined,
        assertion: () => undefined,
        scenarioRunner: runner,
        observeInstalledRuntime: async () => ({
          tools: [
            "vault_health",
            "vault_discover",
            "vault_read",
            "vault_continue",
            "vault_change_set_submit",
            "vault_change_set_status",
          ],
          vaultId: "vault-id",
        }),
      }),
    ).resolves.toMatchObject({
      scenarios: SEMANTIC_EVIDENCE_SEARCH_SNAPSHOT_SCENARIO_PLAN.map((scenario) => ({
        scenario,
        source: "installed-obsidian",
      })),
    });
    expect(runner.run).toHaveBeenCalledTimes(
      SEMANTIC_EVIDENCE_SEARCH_SNAPSHOT_SCENARIO_PLAN.length,
    );
  });

  it("rejects simulated scenario evidence", async () => {
    const runner: InstalledSemanticEvidenceScenarioRunner = {
      run: async ({ scenario }) => ({
        scenario,
        source: "simulated" as never,
        mutationKind: "create_note",
        proofState: "intent_applied" as const,
        statusProofState: "intent_applied" as const,
        journalPhase: "COMMITTED" as const,
        evidenceDeadlineMs: 5_000 as const,
        successBarrierDeadlineMs: 5_000 as const,
        evidenceSessions: [
          { mode: "apply" as const, outcome: "converged" as const, virtualElapsedMs: 250 },
        ],
        quietWindowResets: 0,
        acceptedSnapshotRounds: 1,
        rejectedSnapshotRounds: 0,
        successorSnapshot: {
          baselineVersion: 1,
          version: 2,
          immutable: true,
          publishedBeforeIntentApplied: true,
        },
        durableCommitBeforeIntentApplied: true,
        writesBlocked: false,
        beforeInventorySha256: "a".repeat(64),
        afterInventorySha256: "b".repeat(64),
        cleanupSucceeded: true as const,
      }),
    };

    await expect(
      runSemanticEvidenceSearchSnapshotCorpusAtEndpoint({
        endpoint: new URL("http://127.0.0.1:32123/mcp"),
        expectedVaultId: "vault-id",
        workingDirectory,
        record: () => undefined,
        assertion: () => undefined,
        scenarioRunner: runner,
        observeInstalledRuntime: async () => ({
          tools: [
            "vault_health",
            "vault_discover",
            "vault_read",
            "vault_continue",
            "vault_change_set_submit",
            "vault_change_set_status",
          ],
          vaultId: "vault-id",
        }),
      }),
    ).rejects.toThrow(/installed Obsidian runtime/u);
  });
});
