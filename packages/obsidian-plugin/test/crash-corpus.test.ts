import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  COPY_ATTACHMENT_DESTINATION_PATH,
  copyAttachmentCorpusProfile,
  MOVE_ATTACHMENT_DESTINATION_PATH,
  moveAttachmentCorpusProfile,
  multiAttachmentCorpusProfile,
  seedForCopyAttachment,
  seedForMoveAttachment,
  seedForMultiAttachment,
} from "../src/corpus/attachment-corpus.js";
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
  MOVE_DESTINATION_PATH,
  moveNoteCorpusProfile,
  seedForMoveNote,
} from "../src/corpus/move-note-corpus.js";
import {
  multiTrashCorpusProfile,
  seedForMultiTrash,
  seedForTrashAttachment,
  seedForTrashNote,
  trashAttachmentCorpusProfile,
  trashNoteCorpusProfile,
} from "../src/corpus/managed-trash-corpus.js";
import {
  runMutationCorpusCollisionScenario,
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
  { profile: moveNoteCorpusProfile(), seedFor: seedForMoveNote },
  { profile: copyAttachmentCorpusProfile(), seedFor: seedForCopyAttachment },
  { profile: moveAttachmentCorpusProfile(), seedFor: seedForMoveAttachment },
  { profile: multiAttachmentCorpusProfile(), seedFor: seedForMultiAttachment },
  { profile: trashNoteCorpusProfile(), seedFor: seedForTrashNote },
  { profile: trashAttachmentCorpusProfile(), seedFor: seedForTrashAttachment },
  { profile: multiTrashCorpusProfile(), seedFor: seedForMultiTrash },
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
      if (file.kind === "attachment") {
        expect(final!.sha256, `${file.path} must hold the original attachment SHA-256`).toBe(
          hashBytes(file.originalBytes!),
        );
        expect(final!.contentVersion, `${file.path} must not report Markdown Content Version`).toBeNull();
      } else {
        expect(
          final!.contentVersion,
          `${file.path} must hold the original Content Version`,
        ).toBe(hashBytes(file.originalBytes!));
      }
    } else if (expected === "committed") {
      expect(final!.present, `${file.path} should be present`).toBe(true);
      expect(final!.bytesMatchCommitted, `${file.path} must hold exact intended bytes`).toBe(true);
      if (file.kind === "attachment") {
        expect(final!.sha256, `${file.path} must hold the intended attachment SHA-256`).toBe(
          hashBytes(file.committedBytes!),
        );
        expect(final!.contentVersion, `${file.path} must not report Markdown Content Version`).toBeNull();
      } else {
        expect(
          final!.contentVersion,
          `${file.path} must hold the intended Content Version`,
        ).toBe(hashBytes(file.committedBytes!));
      }
    }
  }

  expect(evidence.gate.effectiveGate).toBeNull();
  expect(evidence.sentinel.applied).toBe(true);
  expect(evidence.residualPaths).toEqual([]);
  expect(evidence.cleanup.success).toBe(true);

  // Managed-Trash profiles must end at the exact redacted hidden state their
  // proof implies: committed runs retain exactly the Bridge-owned trash entries
  // they wrote; rolled-back runs eliminate every private trash/staging residue.
  const expectedHidden = profile.expectedHiddenState?.(expectedProof);
  if (expectedHidden !== undefined && expectedProof !== "result_unproven") {
    expect(evidence.hidden, "no hidden-state snapshot was recorded").not.toBeNull();
    expect(evidence.hidden!.trashCount).toBe(expectedHidden.trashCount);
    expect([...evidence.hidden!.trashSha256s].sort()).toEqual(
      [...expectedHidden.trashSha256s].sort(),
    );
    expect(evidence.hidden!.stagingCount).toBe(expectedHidden.stagingCount);
    expect(evidence.hidden!.stagingSha256s).toEqual([]);
    expect(
      evidence.residualPaths.some((entry) => entry.startsWith("trash:")),
      "reports must never leak a private Managed-Trash path",
    ).toBe(false);
  }
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

describe("move_note third-party residue", () => {
  const profile = moveNoteCorpusProfile();

  it(
    "fails closed with result_unproven, a blocked sentinel, and a surfaced residual path",
    async () => {
      const reportDir = await mkdtemp(join(tmpdir(), "corpus-reports-"));
      temporaryReportRoots.push(reportDir);
      const seed = "move-note-residue";
      const residueBytes = new TextEncoder().encode(
        "# Beta (third-party)\n\nContent no Change Set wrote.\n你好 🚀\n",
      );
      const evidence = await runMutationCorpusResidueScenario({
        profile,
        seed,
        reportDir,
        residuePath: MOVE_DESTINATION_PATH,
        residueBytes,
      });

      expect(evidence.failures, JSON.stringify(evidence, null, 2)).toEqual([]);
      expect(evidence.verdict).toBe("pass");
      expect(evidence.proofState).toBe("result_unproven");
      expect(evidence.gate.effectiveGate).not.toBeNull();
      expect(evidence.sentinel.applied).toBe(false);
      expect(evidence.residualPaths).toContain(`file:${MOVE_DESTINATION_PATH}`);
      expect(evidence.cleanup.success).toBe(true);
    },
    120_000,
  );
});

describe("attachment destination collisions", () => {
  for (const [label, profile, collisionPath] of [
    ["copy_attachment", copyAttachmentCorpusProfile(), COPY_ATTACHMENT_DESTINATION_PATH],
    ["move_attachment", moveAttachmentCorpusProfile(), MOVE_ATTACHMENT_DESTINATION_PATH],
  ] as const) {
    it(
      `${label} retains pre-existing destination bytes and rejects the Change Set`,
      async () => {
        const reportDir = await mkdtemp(join(tmpdir(), "corpus-reports-"));
        temporaryReportRoots.push(reportDir);
        const collisionBytes = Uint8Array.from([0x63, 0x6f, 0x6c, 0x6c, 0x69, 0x64, 0x65, 0x00, 0xff]);
        const evidence = await runMutationCorpusCollisionScenario({
          profile,
          seed: `${label}-collision`,
          reportDir,
          collisionPath,
          collisionBytes,
        });

        expect(evidence.failures, JSON.stringify(evidence, null, 2)).toEqual([]);
        expect(evidence.verdict).toBe("pass");
        expect(evidence.proofState).toBe("intent_not_applied");
        expect(evidence.gate.effectiveGate).toBeNull();
        expect(evidence.sentinel.applied).toBe(true);
        expect(evidence.residualPaths).toContain(`file:${collisionPath}`);
        const final = evidence.fileFinal.find((file) => file.path === collisionPath);
        expect(final?.sha256).toBe(hashBytes(collisionBytes));
        expect(final?.bytesMatchOriginal).toBe(false);
        expect(final?.bytesMatchCommitted).toBe(false);
        expect(evidence.cleanup.success).toBe(true);
      },
      120_000,
    );
  }
});
describe("attachment third-party residue", () => {
  for (const [label, profile, residuePath] of [
    ["copy_attachment", copyAttachmentCorpusProfile(), COPY_ATTACHMENT_DESTINATION_PATH],
    ["move_attachment", moveAttachmentCorpusProfile(), MOVE_ATTACHMENT_DESTINATION_PATH],
  ] as const) {
    it(
      `${label} preserves foreign destination bytes, fails closed, and surfaces the residue`,
      async () => {
        const reportDir = await mkdtemp(join(tmpdir(), "corpus-reports-"));
        temporaryReportRoots.push(reportDir);
        const residueBytes = Uint8Array.from([0xde, 0xad, 0x00, 0xff, 0x13, 0x37, 0x80]);
        const evidence = await runMutationCorpusResidueScenario({
          profile,
          seed: `${label}-residue`,
          reportDir,
          residuePath,
          residueBytes,
        });

        expect(evidence.failures, JSON.stringify(evidence, null, 2)).toEqual([]);
        expect(evidence.verdict).toBe("pass");
        expect(evidence.proofState).toBe("result_unproven");
        expect(evidence.gate.effectiveGate).not.toBeNull();
        expect(evidence.sentinel.applied).toBe(false);
        expect(evidence.residualPaths).toContain(`file:${residuePath}`);
        const final = evidence.fileFinal.find((file) => file.path === residuePath);
        expect(final?.sha256).toBe(hashBytes(residueBytes));
        expect(final?.bytesMatchOriginal).toBe(false);
        expect(final?.bytesMatchCommitted).toBe(false);
        expect(evidence.cleanup.success).toBe(true);
      },
      120_000,
    );
  }
});
describe("managed-trash third-party residue", () => {
  for (const [label, profile, residueBytes] of [
    [
      "trash_note",
      trashNoteCorpusProfile(),
      new TextEncoder().encode("# Third-party note\n\nForeign content 你好.\n"),
    ],
    [
      "trash_attachment",
      trashAttachmentCorpusProfile(),
      Uint8Array.from([0xde, 0xad, 0x00, 0xff, 0x13, 0x37, 0x80, 0x42]),
    ],
  ] as const) {
    it(
      `${label} fails closed, blocks the sentinel, surfaces the public residue, and never leaks a private trash path`,
      async () => {
        const reportDir = await mkdtemp(join(tmpdir(), "corpus-reports-"));
        temporaryReportRoots.push(reportDir);
        const fixture = profile.files[0]!;
        const evidence = await runMutationCorpusResidueScenario({
          profile,
          seed: `${label}-residue`,
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
        expect(
          evidence.residualPaths.some((entry) => entry.startsWith("trash:")),
          "a private Managed-Trash path must never be surfaced as a residual path",
        ).toBe(false);
        expect(evidence.hidden).not.toBeNull();
        expect(evidence.cleanup.success).toBe(true);
      },
      120_000,
    );
  }
});

describe("corpus fixture guarantees", () => {
  it("keeps every fixture byte-different between original and committed states", () => {
    for (const scenario of CORPUS_SCENARIOS) {
      for (const file of scenario.profile.files) {
        if (
          file.kind === "attachment" ||
          file.originalBytes === null ||
          file.committedBytes === null
        ) continue;
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
