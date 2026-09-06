import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { CHANGE_SET_SEMANTIC_EVIDENCE_DEADLINE_MS } from "../src/index.js";
import { SEARCH_SNAPSHOT_QUIET_WINDOW_MS } from "../src/search-snapshot.js";
import { createNoteCorpusProfile } from "../src/corpus/create-note-corpus.js";
import {
  SEMANTIC_SUCCESS_BARRIER_DEADLINE_MS,
  runSemanticEvidenceScenario,
  semanticEvidenceScenarios,
  type SemanticEvidenceScenario,
} from "../src/corpus/semantic-evidence-corpus.js";

const temporaryReportRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryReportRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function runScenario(scenario: SemanticEvidenceScenario) {
  const reportDir = await mkdtemp(join(tmpdir(), "sev-corpus-reports-"));
  temporaryReportRoots.push(reportDir);
  const report = await runSemanticEvidenceScenario({ scenario, reportDir });
  return report;
}

describe("Semantic Evidence corpus", () => {
  it("keeps the installed evidence deadline and quiet window unchanged", () => {
    // Issue #193 non-goal: the installed 5,000 ms deadline and 250 ms quiet
    // window are fixed surfaces the corpus exercises but never changes.
    expect(CHANGE_SET_SEMANTIC_EVIDENCE_DEADLINE_MS).toBe(5_000);
    expect(SEMANTIC_SUCCESS_BARRIER_DEADLINE_MS).toBe(5_000);
    expect(SEARCH_SNAPSHOT_QUIET_WINDOW_MS).toBe(250);
  });

  for (const scenario of semanticEvidenceScenarios()) {
    it(
      `fails closed on schedule: ${scenario.id}`,
      async () => {
        const report = await runScenario(scenario);

        expect(report.failures, JSON.stringify(report, null, 2)).toEqual([]);
        expect(report.verdict).toBe("pass");
        expect(report.corpus).toBe("semantic_evidence");
        expect(report.mutationKind).toBe(scenario.profile.kind);
        expect(report.proofState).toBe(scenario.expect.proof);
        expect(report.statusProofState).toBe(scenario.expect.proof);
        expect(report.journalPhase).toBe(scenario.expect.journal);
        expect(report.gate.sentinelApplied).toBe(scenario.expect.sentinelApplied);
        expect(report.cleanup.success).toBe(true);

        // The report was written to disk and stays free of note content.
        const onDisk = JSON.parse(await readFile(report.reportPath, "utf8")) as {
          verdict?: string;
        };
        expect(onDisk.verdict).toBe("pass");

        // Read-after observes an immutable successor snapshot (or, for
        // unproven runs, proves no barrier ever accepted failing evidence).
        expect(report.snapshot).not.toBeNull();
        expect(report.snapshot!.frozen).toBe(true);
        if (scenario.expect.snapshot === "successor_matches_terminal") {
          expect(report.snapshot!.version).toBeGreaterThan(report.snapshotBaselineVersion);
        }

        // Every rejected round records the rejected evidence identities.
        for (const round of report.observations.snapshotRounds) {
          if (!round.matched) expect(round.rejections.length).toBeGreaterThan(0);
        }
      },
      60_000,
    );
  }

  describe("schedule integrity", () => {
    it(
      "fails the scenario when a declared host event is never observed",
      async () => {
        const scenario: SemanticEvidenceScenario = {
          id: "integrity/unobserved_host_event",
          profile: createNoteCorpusProfile(),
          schedule: {
            hostEvents: [
              { event: { kind: "create", path: "Corpus/Notes/Alpha.md" } },
              { event: { kind: "create", path: "Corpus/Notes/Never-Emitted.md" } },
            ],
            applyRounds: [{}],
          },
          expect: {
            proof: "intent_applied",
            journal: "COMMITTED",
            sessions: [{ mode: "apply", outcome: "not_awaited" }],
            writesBlocked: false,
            sentinelApplied: true,
            residue: false,
            snapshot: "successor_matches_terminal",
          },
        };
        const report = await runScenario(scenario);

        expect(report.verdict).toBe("fail");
        expect(report.failures).toContain(
          "expected 2 host Vault events but observed 1",
        );
      },
      60_000,
    );

    it(
      "fails the scenario when a declared snapshot round is never observed",
      async () => {
        const scenario: SemanticEvidenceScenario = {
          id: "integrity/unobserved_snapshot_round",
          profile: createNoteCorpusProfile(),
          schedule: {
            hostEvents: [{ event: { kind: "create", path: "Corpus/Notes/Alpha.md" } }],
            // The barrier converges on the first round; the second declared
            // round is evidence the runtime never observed.
            applyRounds: [{}, {}],
          },
          expect: {
            proof: "intent_applied",
            journal: "COMMITTED",
            sessions: [{ mode: "apply", outcome: "not_awaited" }],
            writesBlocked: false,
            sentinelApplied: true,
            residue: false,
            snapshot: "successor_matches_terminal",
          },
        };
        const report = await runScenario(scenario);

        expect(report.verdict).toBe("fail");
        expect(
          report.failures.some((failure) =>
            failure.includes("declared snapshot rounds were never observed"),
          ),
        ).toBe(true);
      },
      60_000,
    );

    it(
      "fails the scenario when the schedule is not monotonically ordered",
      async () => {
        const scenario: SemanticEvidenceScenario = {
          id: "integrity/non_monotonic_schedule",
          profile: createNoteCorpusProfile(),
          schedule: {
            hostEvents: [{ event: { kind: "create", path: "Corpus/Notes/Alpha.md" } }],
            injections: [
              { atMs: 50, event: { kind: "create", path: "Corpus/Notes/A.md" } },
              { atMs: 10, event: { kind: "create", path: "Corpus/Notes/B.md" } },
            ],
            applyRounds: [{}],
          },
          expect: {
            proof: "intent_applied",
            journal: "COMMITTED",
            sessions: [{ mode: "apply", outcome: "not_awaited" }],
            writesBlocked: false,
            sentinelApplied: true,
            residue: false,
            snapshot: "successor_matches_terminal",
          },
        };
        const report = await runScenario(scenario);

        expect(report.verdict).toBe("fail");
        expect(
          report.failures.some((failure) =>
            failure.includes("schedule injections is not monotonically ordered"),
          ),
        ).toBe(true);
      },
      60_000,
    );
  });
});
