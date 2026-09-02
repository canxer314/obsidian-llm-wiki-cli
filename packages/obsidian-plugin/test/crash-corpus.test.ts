import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createNoteCorpusProfile,
  seedForCreateNote,
} from "../src/corpus/create-note-corpus.js";
import {
  replaceExactCorpusProfile,
  replaceWholeCorpusProfile,
  seedForReplaceExact,
  seedForReplaceWhole,
} from "../src/corpus/edit-body-corpus.js";
import {
  editFrontmatterCorpusProfile,
  seedForEditFrontmatter,
} from "../src/corpus/frontmatter-corpus.js";
import {
  multiFrontmatterCorpusProfile,
  multiMarkdownCorpusProfile,
  seedForMultiFrontmatter,
  seedForMultiMarkdown,
} from "../src/corpus/multi-operation-corpus.js";
import {
  runMutationCorpusResidueScenario,
  runMutationCorpusScenario,
  terminalStateForFile,
  type CorpusScenarioEvidence,
  type MutationCorpusCrashPoint,
  type MutationCorpusProfile,
} from "../src/corpus/crash-corpus-runner.js";

const temporaryReportRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryReportRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

interface CorpusScenarioCase {
  readonly profile: MutationCorpusProfile;
  readonly seedFor: (crashPoint: MutationCorpusCrashPoint) => string;
}

const CORPUS_SCENARIOS: readonly CorpusScenarioCase[] = [
  { profile: createNoteCorpusProfile(), seedFor: seedForCreateNote },
  { profile: replaceExactCorpusProfile(), seedFor: seedForReplaceExact },
  { profile: replaceWholeCorpusProfile(), seedFor: seedForReplaceWhole },
  { profile: editFrontmatterCorpusProfile(), seedFor: seedForEditFrontmatter },
  { profile: multiMarkdownCorpusProfile(), seedFor: seedForMultiMarkdown },
  { profile: multiFrontmatterCorpusProfile(), seedFor: seedForMultiFrontmatter },
];

function assertCleanRecoveryOutcome(
  evidence: CorpusScenarioEvidence,
  profile: MutationCorpusProfile,
  expectedProof: "intent_applied" | "intent_not_applied" | "result_unproven",
): void {
  expect(evidence.failures, JSON.stringify(evidence, null, 2)).toEqual([]);
  expect(evidence.verdict).toBe("pass");
  expect(evidence.proofState).toBe(expectedProof);
  if (expectedProof === "result_unproven") return;

  // Every public file of the Change Set must sit at the byte-exact terminal
  // state implied by the proof: committed bytes on intent_applied, original
  // bytes on intent_not_applied (whole-Change-Set restoration).
  for (const file of profile.files) {
    const final = evidence.fileFinal.find((candidate) => candidate.path === file.path);
    expect(final, `no final observation for ${file.path}`).toBeDefined();
    const expected = terminalStateForFile(expectedProof, file);
    if (expected === "absent") {
      expect(final!.present, `${file.path} should be absent`).toBe(false);
    } else if (expected === "original") {
      expect(final!.present, `${file.path} should be present`).toBe(true);
      expect(final!.bytesMatchOriginal, `${file.path} must hold exact original bytes`).toBe(true);
      expect(
        final!.contentVersion,
        `${file.path} must hold the original Content Version`,
      ).toBe(hashBytes(file.originalBytes!));
    } else if (expected === "committed") {
      expect(final!.present, `${file.path} should be present`).toBe(true);
      expect(final!.bytesMatchCommitted, `${file.path} must hold exact intended bytes`).toBe(true);
      expect(
        final!.contentVersion,
        `${file.path} must hold the intended Content Version`,
      ).toBe(hashBytes(file.committedBytes!));
    }
  }

  expect(evidence.gate.effectiveGate).toBeNull();
  expect(evidence.sentinel.applied).toBe(true);
  expect(evidence.residualPaths).toEqual([]);
  expect(evidence.cleanup.success).toBe(true);
}

describe("process-crash corpus", () => {
  for (const scenario of CORPUS_SCENARIOS) {
    describe(`${scenario.profile.kind} process-crash corpus`, () => {
      for (const crashPoint of scenario.profile.crashPoints) {
        it(
          `recovers after a real process termination at ${crashPoint.phase}:${crashPoint.point}`,
          async () => {
            const reportDir = await mkdtemp(join(tmpdir(), "corpus-reports-"));
            temporaryReportRoots.push(reportDir);
            const seed = scenario.seedFor(crashPoint);
            const evidence = await runMutationCorpusScenario({
              profile: scenario.profile,
              crashPoint,
              seed,
              reportDir,
            });

            expect(evidence.corpus).toBe(scenario.profile.kind);
            const expectedProof = scenario.profile.expectedProofState(crashPoint);
            assertCleanRecoveryOutcome(evidence, scenario.profile, expectedProof);
          },
          120_000,
        );
      }
    });
  }
});

describe("edit_frontmatter third-party residue", () => {
  const profile = editFrontmatterCorpusProfile();
  const fixture = profile.files[0]!;

  it(
    "fails closed with result_unproven, a blocked sentinel, and a surfaced residual path",
    async () => {
      const reportDir = await mkdtemp(join(tmpdir(), "corpus-reports-"));
      temporaryReportRoots.push(reportDir);
      const seed = "edit-frontmatter-residue";
      const residueBytes = new TextEncoder().encode(
        "---\r\nstate: third-party\r\n---\r\n\r\n# Interferencia externa 你好\r\n",
      );
      expect(
        Buffer.from(residueBytes).equals(Buffer.from(fixture.originalBytes!)) ||
          Buffer.from(residueBytes).equals(Buffer.from(fixture.committedBytes!)),
      ).toBe(false);
      const evidence = await runMutationCorpusResidueScenario({
        profile,
        seed,
        reportDir,
        residuePath: fixture.path,
        residueBytes,
      });

      expect(evidence.failures, JSON.stringify(evidence, null, 2)).toEqual([]);
      expect(evidence.verdict).toBe("pass");
      expect(evidence.proofState).toBe("result_unproven");
      expect(evidence.gate.effectiveGate).not.toBeNull();
      expect(evidence.sentinel.applied).toBe(false);
      expect(evidence.residualPaths).toContain(`file:${fixture.path}`);
      expect(evidence.cleanup.success).toBe(true);
    },
    120_000,
  );
});

describe("corpus fixture guarantees", () => {
  it("keeps every fixture byte-different between original and committed states", () => {
    for (const scenario of CORPUS_SCENARIOS) {
      for (const file of scenario.profile.files) {
        if (file.originalBytes === null || file.committedBytes === null) continue;
        expect(
          Buffer.from(file.originalBytes).equals(Buffer.from(file.committedBytes)),
          `${scenario.profile.kind} fixture ${file.path} must actually change bytes`,
        ).toBe(false);
      }
    }
  });
});

function hashBytes(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}
