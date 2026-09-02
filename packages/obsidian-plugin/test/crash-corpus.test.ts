import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createNoteCorpusProfile,
  seedForCreateNote,
} from "../src/corpus/create-note-corpus.js";
import { runMutationCorpusScenario } from "../src/corpus/crash-corpus-runner.js";

const temporaryReportRoots: string[] = [];

describe("create_note process-crash corpus", () => {
  const profile = createNoteCorpusProfile();

  afterEach(async () => {
    await Promise.all(
      temporaryReportRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
    );
  });

  for (const crashPoint of profile.crashPoints) {
    it(
      `recovers create_note after a real process termination at ${crashPoint.phase}:${crashPoint.point}`,
      async () => {
        const reportDir = await mkdtemp(join(tmpdir(), "corpus-reports-"));
        temporaryReportRoots.push(reportDir);
        const seed = seedForCreateNote(crashPoint);
        const evidence = await runMutationCorpusScenario({
          profile,
          crashPoint,
          seed,
          reportDir,
        });

        expect(evidence.failures, JSON.stringify(evidence, null, 2)).toEqual([]);
        expect(evidence.verdict).toBe("pass");
        expect(evidence.proofState).toBe(profile.expectedProofState(crashPoint));
        expect(evidence.noteFinal.present).toBe(profile.expectedNotePresence(crashPoint));
        expect(evidence.gate.effectiveGate).toBeNull();
        expect(evidence.gate.recoveryState).toBe("none");
        expect(evidence.residualPaths).toEqual([]);
        expect(evidence.cleanup.success).toBe(true);
      },
      120_000,
    );
  }
});
