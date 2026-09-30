import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  CREATE_NOTE_CONTENT,
  CREATE_NOTE_PATH,
} from "../src/corpus/create-note-corpus.js";
import {
  EXACT_COMMITTED_BYTES,
  EXACT_FIXTURE,
  EXACT_ORIGINAL_BYTES,
  FRONTMATTER_COMMITTED_BYTES,
  FRONTMATTER_ORIGINAL_BYTES,
} from "../src/corpus/edit-fixtures.js";
import {
  TRASH_NOTE_BYTES,
  TRASH_NOTE_PATH,
} from "../src/corpus/managed-trash-corpus.js";
import {
  MOVE_DERIVED_FIXTURES,
  MOVE_DESTINATION_PATH,
  MOVE_SOURCE_BYTES,
  MOVE_SOURCE_PATH,
} from "../src/corpus/move-note-corpus.js";
import { contentVersion } from "../src/content-version.js";
import { createInstalledSemanticEvidenceScenarioControl } from "../src/installed-runtime/installed-semantic-evidence.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe("installed Semantic Evidence executor", () => {
  it("waits for hidden-trash cache and reference probes before committing", async () => {
    const vaultPath = await mkdtemp(join(tmpdir(), "installed-semantic-evidence-"));
    cleanups.push(() => rm(vaultPath, { recursive: true, force: true }));
    let now = 0;
    let snapshotVersion = 1;
    let submissionKey = "";
    let resolveSubmit!: (value: { proofState: "intent_applied" }) => void;
    const submitted = new Promise<{ proofState: "intent_applied" }>((resolve) => {
      resolveSubmit = resolve;
    });
    let latestFrame: {
      readonly phase: "COMMITTED";
      readonly input: { readonly submissionKey: string };
    } | null = null;
    let control!: ReturnType<typeof createInstalledSemanticEvidenceScenarioControl>;
    control = createInstalledSemanticEvidenceScenarioControl({
      vaultPath,
      now: () => now,
      currentSnapshot: () => ({ version: snapshotVersion, immutable: true }),
      loadRecoveryFrame: async () => latestFrame,
      cleanupPath: async (path) => {
        await rm(join(vaultPath, ...path.split("/")), { force: true });
      },
      seedPath: async (path, bytes) => {
        const absolute = join(vaultPath, ...path.split("/"));
        await mkdir(join(absolute, ".."), { recursive: true });
        await writeFile(absolute, bytes);
      },
      refreshSeedFixtures: async () => {
        snapshotVersion = 2;
        return { version: snapshotVersion, immutable: true };
      },
      induceTrashDelayedProbes: async () => {
        control.recordTrashProbeObservation({
          path: TRASH_NOTE_PATH,
          cacheVisible: true,
          referenced: true,
        });
        now = 100;
        control.recordTrashProbeObservation({
          path: TRASH_NOTE_PATH,
          cacheVisible: false,
          referenced: true,
        });
        now = 300;
        control.recordTrashProbeObservation({
          path: TRASH_NOTE_PATH,
          cacheVisible: false,
          referenced: false,
        });
        snapshotVersion = 3;
        control.recordSearchSnapshotPublication({ version: 3, immutable: true });
        latestFrame = { phase: "COMMITTED", input: { submissionKey } };
        control.recordRecoveryFrame(latestFrame);
        resolveSubmit({ proofState: "intent_applied" });
      },
      wire: {
        async submit({ input }) {
          submissionKey = input.submissionKey;
          await rm(join(vaultPath, ...TRASH_NOTE_PATH.split("/")), { force: true });
          return submitted;
        },
        async status() {
          return { proofState: "intent_applied" };
        },
      },
    });

    const summary = await control.execute({
      descriptor: {} as never,
      scenario: "trash_note/delayed_probes_converge",
      expectedVaultId: "vault-123",
      endpoint: new URL("http://127.0.0.1:32123/mcp"),
    });

    expect(summary).toMatchObject({
      scenario: "trash_note/delayed_probes_converge",
      mutationKind: "trash_note",
      proofState: "intent_applied",
      journalPhase: "COMMITTED",
      evidenceSessions: [
        { mode: "apply", outcome: "converged", virtualElapsedMs: 300 },
      ],
      acceptedSnapshotRounds: 1,
      rejectedSnapshotRounds: 0,
      successorSnapshot: {
        baselineVersion: 2,
        version: 3,
      },
    });
  });

  it("restores the trashed note when the hidden probes miss their deadline", async () => {
    const vaultPath = await mkdtemp(join(tmpdir(), "installed-semantic-evidence-"));
    cleanups.push(() => rm(vaultPath, { recursive: true, force: true }));
    const trashVersion = contentVersion(TRASH_NOTE_BYTES);
    let now = 0;
    let snapshotVersion = 1;
    let submissionKey = "";
    let latestFrame: {
      readonly phase: "ROLLED_BACK";
      readonly input: { readonly submissionKey: string };
    } | null = null;
    let control!: ReturnType<typeof createInstalledSemanticEvidenceScenarioControl>;
    control = createInstalledSemanticEvidenceScenarioControl({
      vaultPath,
      now: () => now,
      currentSnapshot: () => ({ version: snapshotVersion, immutable: true }),
      loadRecoveryFrame: async () => latestFrame,
      cleanupPath: async (path) => {
        await rm(join(vaultPath, ...path.split("/")), { force: true });
      },
      seedPath: async (path, bytes) => {
        const absolute = join(vaultPath, ...path.split("/"));
        await mkdir(join(absolute, ".."), { recursive: true });
        await writeFile(absolute, bytes);
        control.recordMetadataCacheObservation({
          path,
          contentVersion: contentVersion(bytes),
        });
      },
      refreshSeedFixtures: async () => {
        snapshotVersion = 2;
        return { version: snapshotVersion, immutable: true };
      },
      induceTrashProbeDeadlineThenRestored: async () => {
        control.recordTrashProbeObservation({
          path: TRASH_NOTE_PATH,
          cacheVisible: true,
          referenced: false,
        });
        now = 5_000;
      },
      wire: {
        async submit({ input }) {
          submissionKey = input.submissionKey;
          const path = join(vaultPath, ...TRASH_NOTE_PATH.split("/"));
          await rm(path, { force: true });
          await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 0));
          await writeFile(path, TRASH_NOTE_BYTES);
          control.recordMetadataCacheObservation({
            path: TRASH_NOTE_PATH,
            contentVersion: trashVersion,
          });
          control.recordTrashProbeObservation({
            path: TRASH_NOTE_PATH,
            cacheVisible: true,
            referenced: true,
          });
          snapshotVersion = 3;
          control.recordSearchSnapshotPublication({ version: 3, immutable: true });
          latestFrame = { phase: "ROLLED_BACK", input: { submissionKey } };
          control.recordRecoveryFrame(latestFrame);
          return { proofState: "intent_not_applied" };
        },
        async status() {
          return { proofState: "intent_not_applied" };
        },
      },
    });

    const summary = await control.execute({
      descriptor: {} as never,
      scenario: "trash_note/probe_deadline_then_restored",
      expectedVaultId: "vault-123",
      endpoint: new URL("http://127.0.0.1:32123/mcp"),
    });

    expect(summary).toMatchObject({
      scenario: "trash_note/probe_deadline_then_restored",
      mutationKind: "trash_note",
      proofState: "intent_not_applied",
      journalPhase: "ROLLED_BACK",
      evidenceSessions: [
        { mode: "apply", outcome: "timed_out", virtualElapsedMs: 5_000 },
        { mode: "restore", outcome: "converged" },
      ],
      acceptedSnapshotRounds: 1,
    });
  });

  it("blocks writes when restored hidden-trash evidence never converges", async () => {
    const vaultPath = await mkdtemp(join(tmpdir(), "installed-semantic-evidence-"));
    cleanups.push(() => rm(vaultPath, { recursive: true, force: true }));
    const trashVersion = contentVersion(TRASH_NOTE_BYTES);
    let now = 0;
    let submissionKey = "";
    let latestFrame: {
      readonly phase: "FAILED";
      readonly input: { readonly submissionKey: string };
    } | null = null;
    let control!: ReturnType<typeof createInstalledSemanticEvidenceScenarioControl>;
    control = createInstalledSemanticEvidenceScenarioControl({
      vaultPath,
      now: () => now,
      currentSnapshot: () => ({ version: 1, immutable: true }),
      loadRecoveryFrame: async () => latestFrame,
      observeHealth: async () => ({
        recoveryBlocked: true,
        writesBlocked: true,
        effectiveGate: "recovery_blocked",
      }),
      cleanupPath: async (path) => {
        await rm(join(vaultPath, ...path.split("/")), { force: true });
      },
      seedPath: async (path, bytes) => {
        const absolute = join(vaultPath, ...path.split("/"));
        await mkdir(join(absolute, ".."), { recursive: true });
        await writeFile(absolute, bytes);
        control.recordMetadataCacheObservation({
          path,
          contentVersion: contentVersion(bytes),
        });
      },
      refreshSeedFixtures: async () => ({ version: 2, immutable: true }),
      induceTrashRestoreEvidenceDeadline: async () => {
        control.recordTrashProbeObservation({
          path: TRASH_NOTE_PATH,
          cacheVisible: true,
          referenced: false,
        });
        now = 10_000;
      },
      wire: {
        async submit({ input }) {
          submissionKey = input.submissionKey;
          const path = join(vaultPath, ...TRASH_NOTE_PATH.split("/"));
          await rm(path, { force: true });
          await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 0));
          await writeFile(path, TRASH_NOTE_BYTES);
          control.recordMetadataCacheObservation({
            path: TRASH_NOTE_PATH,
            contentVersion: trashVersion,
          });
          latestFrame = { phase: "FAILED", input: { submissionKey } };
          control.recordRecoveryFrame(latestFrame);
          return { proofState: "result_unproven" };
        },
        async status() {
          return { proofState: "result_unproven" };
        },
      },
    });

    const summary = await control.execute({
      descriptor: {} as never,
      scenario: "trash_note/restore_evidence_deadline_blocks_writes",
      expectedVaultId: "vault-123",
      endpoint: new URL("http://127.0.0.1:32123/mcp"),
    });

    expect(summary).toMatchObject({
      scenario: "trash_note/restore_evidence_deadline_blocks_writes",
      mutationKind: "trash_note",
      proofState: "result_unproven",
      journalPhase: "FAILED",
      evidenceSessions: [
        { mode: "apply", outcome: "timed_out", virtualElapsedMs: 5_000 },
        { mode: "restore", outcome: "timed_out", virtualElapsedMs: 5_000 },
      ],
      acceptedSnapshotRounds: 0,
      writesBlocked: true,
    });
  });

  it("blocks writes on contrary third-party state over a trashed path", async () => {
    const vaultPath = await mkdtemp(join(tmpdir(), "installed-semantic-evidence-"));
    cleanups.push(() => rm(vaultPath, { recursive: true, force: true }));
    const foreignBytes = new TextEncoder().encode(
      "# Third-party interference\n\nForeign 你好 🚀\n",
    );
    let now = 0;
    let submissionKey = "";
    let latestFrame: {
      readonly phase: "FAILED";
      readonly input: { readonly submissionKey: string };
    } | null = null;
    let trashed!: () => void;
    const trashObserved = new Promise<void>((resolve) => { trashed = resolve; });
    let control!: ReturnType<typeof createInstalledSemanticEvidenceScenarioControl>;
    control = createInstalledSemanticEvidenceScenarioControl({
      vaultPath,
      now: () => now,
      currentSnapshot: () => ({ version: 1, immutable: true }),
      loadRecoveryFrame: async () => latestFrame,
      observeHealth: async () => ({
        recoveryBlocked: true,
        writesBlocked: true,
        effectiveGate: "recovery_blocked",
      }),
      cleanupPath: async (path) => {
        await rm(join(vaultPath, ...path.split("/")), { force: true });
      },
      seedPath: async (path, bytes) => {
        const absolute = join(vaultPath, ...path.split("/"));
        await mkdir(join(absolute, ".."), { recursive: true });
        await writeFile(absolute, bytes);
        control.recordMetadataCacheObservation({
          path,
          contentVersion: contentVersion(bytes),
        });
      },
      refreshSeedFixtures: async () => ({ version: 2, immutable: true }),
      induceTrashContraryThirdParty: async () => {
        const path = join(vaultPath, ...TRASH_NOTE_PATH.split("/"));
        await trashObserved;
        await writeFile(path, foreignBytes);
        control.recordTrashProbeObservation({
          path: TRASH_NOTE_PATH,
          cacheVisible: true,
          referenced: false,
        });
        now = 5_000;
      },
      wire: {
        async submit({ input }) {
          submissionKey = input.submissionKey;
          const path = join(vaultPath, ...TRASH_NOTE_PATH.split("/"));
          await rm(path, { force: true });
          trashed();
          await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 0));
          latestFrame = { phase: "FAILED", input: { submissionKey } };
          control.recordRecoveryFrame(latestFrame);
          return { proofState: "result_unproven" };
        },
        async status() {
          return { proofState: "result_unproven" };
        },
      },
    });

    const summary = await control.execute({
      descriptor: {} as never,
      scenario: "trash_note/contrary_third_party_blocks_writes",
      expectedVaultId: "vault-123",
      endpoint: new URL("http://127.0.0.1:32123/mcp"),
    });

    expect(summary).toMatchObject({
      scenario: "trash_note/contrary_third_party_blocks_writes",
      mutationKind: "trash_note",
      proofState: "result_unproven",
      journalPhase: "FAILED",
      evidenceSessions: [
        { mode: "apply", outcome: "timed_out", virtualElapsedMs: 5_000 },
      ],
      acceptedSnapshotRounds: 0,
      writesBlocked: true,
      residueSha256: createHash("sha256").update(foreignBytes).digest("hex"),
    });
  });

  it("rejects a stale move closure graph before the installed graph converges", async () => {
    const vaultPath = await mkdtemp(join(tmpdir(), "installed-semantic-evidence-"));
    cleanups.push(() => rm(vaultPath, { recursive: true, force: true }));
    const sourceVersion = contentVersion(MOVE_SOURCE_BYTES);
    const closureVersions = MOVE_DERIVED_FIXTURES.map(({ committedBytes }) =>
      contentVersion(committedBytes));
    let now = 0;
    let snapshotVersion = 1;
    let submissionKey = "";
    let resolveSubmit!: (value: { proofState: "intent_applied" }) => void;
    const submitted = new Promise<{ proofState: "intent_applied" }>((resolve) => {
      resolveSubmit = resolve;
    });
    let latestFrame: {
      readonly phase: "COMMITTED";
      readonly input: { readonly submissionKey: string };
    } | null = null;
    let control!: ReturnType<typeof createInstalledSemanticEvidenceScenarioControl>;
    control = createInstalledSemanticEvidenceScenarioControl({
      vaultPath,
      now: () => now,
      currentSnapshot: () => ({ version: snapshotVersion, immutable: true }),
      loadRecoveryFrame: async () => latestFrame,
      cleanupPath: async (path) => {
        await rm(join(vaultPath, ...path.split("/")), { force: true });
      },
      seedPath: async (path, bytes) => {
        const absolute = join(vaultPath, ...path.split("/"));
        await mkdir(join(absolute, ".."), { recursive: true });
        await writeFile(absolute, bytes);
        control.recordVaultEvent({ kind: "create", path });
        control.recordMetadataCacheObservation({ path, contentVersion: contentVersion(bytes) });
      },
      induceMoveGraphMismatchThenConverged: async () => {
        expect(control.recordVaultEvent({
          kind: "rename",
          oldPath: MOVE_SOURCE_PATH,
          path: MOVE_DESTINATION_PATH,
        })).toBe(false);
        expect(control.releaseDelayedRenameEvent()).toEqual({
          kind: "rename",
          oldPath: MOVE_SOURCE_PATH,
          path: MOVE_DESTINATION_PATH,
        });
        for (const [index, fixture] of MOVE_DERIVED_FIXTURES.entries()) {
          control.recordMetadataCacheObservation({
            path: fixture.path,
            contentVersion: closureVersions[index],
          });
        }
        control.recordMetadataCacheObservation({
          path: MOVE_DESTINATION_PATH,
          contentVersion: sourceVersion,
        });
        const targets = [
          {
            path: MOVE_DESTINATION_PATH,
            expectedContentVersion: sourceVersion,
            observedContentVersion: sourceVersion,
            matched: true,
          },
          ...MOVE_DERIVED_FIXTURES.map((fixture, index) => ({
            path: fixture.path,
            expectedContentVersion: closureVersions[index]!,
            observedContentVersion: closureVersions[index]!,
            matched: true,
          })),
        ];
        const closure = (converged: boolean) =>
          MOVE_DERIVED_FIXTURES.map((fixture, index) => ({
            path: fixture.path,
            expectedContentVersion: closureVersions[index]!,
            observedContentVersion: closureVersions[index]!,
            expectedResolvedPath: MOVE_DESTINATION_PATH,
            observedReferenceCount: converged || index > 0 ? 1 : 0,
            expectedReferenceCount: 1,
            matched: converged || index > 0,
          }));
        control.recordSearchSnapshotBarrierRound({
          targets,
          move: {
            absentPath: { path: MOVE_SOURCE_PATH, absent: true },
            presentPath: {
              path: MOVE_DESTINATION_PATH,
              expectedContentVersion: sourceVersion,
              observedContentVersion: sourceVersion,
              matched: true,
            },
            closure: closure(false),
            matched: false,
          },
          matched: false,
        });
        control.recordSearchSnapshotBarrierRound({
          targets,
          move: {
            absentPath: { path: MOVE_SOURCE_PATH, absent: true },
            presentPath: {
              path: MOVE_DESTINATION_PATH,
              expectedContentVersion: sourceVersion,
              observedContentVersion: sourceVersion,
              matched: true,
            },
            closure: closure(true),
            matched: true,
          },
          matched: true,
        });
        now = 250;
        snapshotVersion = 2;
        control.recordSearchSnapshotPublication({ version: 2, immutable: true });
        latestFrame = { phase: "COMMITTED", input: { submissionKey } };
        control.recordRecoveryFrame(latestFrame);
        resolveSubmit({ proofState: "intent_applied" });
      },
      wire: {
        async submit({ input }) {
          submissionKey = input.submissionKey;
          await rm(join(vaultPath, ...MOVE_SOURCE_PATH.split("/")), { force: true });
          const destination = join(vaultPath, ...MOVE_DESTINATION_PATH.split("/"));
          await mkdir(join(destination, ".."), { recursive: true });
          await writeFile(destination, MOVE_SOURCE_BYTES);
          for (const fixture of MOVE_DERIVED_FIXTURES) {
            await writeFile(
              join(vaultPath, ...fixture.path.split("/")),
              fixture.committedBytes,
            );
            control.recordVaultEvent({ kind: "create", path: fixture.path });
          }
          return submitted;
        },
        async status() {
          return { proofState: "intent_applied" };
        },
      },
    });

    const summary = await control.execute({
      descriptor: {} as never,
      scenario: "move_note/graph_mismatch_then_converged",
      expectedVaultId: "vault-123",
      endpoint: new URL("http://127.0.0.1:32123/mcp"),
    });

    expect(summary).toMatchObject({
      scenario: "move_note/graph_mismatch_then_converged",
      mutationKind: "move_note",
      proofState: "intent_applied",
      journalPhase: "COMMITTED",
      acceptedSnapshotRounds: 1,
      rejectedSnapshotRounds: 1,
    });
  });

  it("rejects a stale move closure Content Version before fresh convergence", async () => {
    const vaultPath = await mkdtemp(join(tmpdir(), "installed-semantic-evidence-"));
    cleanups.push(() => rm(vaultPath, { recursive: true, force: true }));
    const sourceVersion = contentVersion(MOVE_SOURCE_BYTES);
    const originalClosureVersions = MOVE_DERIVED_FIXTURES.map(({ originalBytes }) =>
      contentVersion(originalBytes));
    const closureVersions = MOVE_DERIVED_FIXTURES.map(({ committedBytes }) =>
      contentVersion(committedBytes));
    const staleFixture = MOVE_DERIVED_FIXTURES[1]!;
    let now = 0;
    let snapshotVersion = 1;
    let submissionKey = "";
    let resolveSubmit!: (value: { proofState: "intent_applied" }) => void;
    const submitted = new Promise<{ proofState: "intent_applied" }>((resolve) => {
      resolveSubmit = resolve;
    });
    let latestFrame: {
      readonly phase: "COMMITTED";
      readonly input: { readonly submissionKey: string };
    } | null = null;
    let control!: ReturnType<typeof createInstalledSemanticEvidenceScenarioControl>;
    control = createInstalledSemanticEvidenceScenarioControl({
      vaultPath,
      now: () => now,
      currentSnapshot: () => ({ version: snapshotVersion, immutable: true }),
      loadRecoveryFrame: async () => latestFrame,
      cleanupPath: async (path) => {
        await rm(join(vaultPath, ...path.split("/")), { force: true });
      },
      seedPath: async (path, bytes) => {
        const absolute = join(vaultPath, ...path.split("/"));
        await mkdir(join(absolute, ".."), { recursive: true });
        await writeFile(absolute, bytes);
        control.recordVaultEvent({ kind: "create", path });
        control.recordMetadataCacheObservation({ path, contentVersion: contentVersion(bytes) });
      },
      induceMoveStaleClosureObservation: async () => {
        expect(control.recordVaultEvent({
          kind: "rename",
          oldPath: MOVE_SOURCE_PATH,
          path: MOVE_DESTINATION_PATH,
        })).toBe(false);
        control.releaseDelayedRenameEvent();
        expect(control.acceptMetadataCacheObservation({
          path: staleFixture.path,
          contentVersion: closureVersions[1],
        })).toBe(false);
        for (const [index, fixture] of MOVE_DERIVED_FIXTURES.entries()) {
          if (fixture.path !== staleFixture.path) {
            control.recordMetadataCacheObservation({
              path: fixture.path,
              contentVersion: closureVersions[index],
            });
          }
        }
        control.recordMetadataCacheObservation({
          path: MOVE_DESTINATION_PATH,
          contentVersion: sourceVersion,
        });
        const round = (stale: boolean) => ({
          targets: [
            {
              path: MOVE_DESTINATION_PATH,
              expectedContentVersion: sourceVersion,
              observedContentVersion: sourceVersion,
              matched: true,
            },
            ...MOVE_DERIVED_FIXTURES.map((fixture, index) => ({
              path: fixture.path,
              expectedContentVersion: closureVersions[index]!,
              observedContentVersion: stale && fixture.path === staleFixture.path
                ? originalClosureVersions[index]!
                : closureVersions[index]!,
              matched: !stale || fixture.path !== staleFixture.path,
            })),
          ],
          move: {
            absentPath: { path: MOVE_SOURCE_PATH, absent: true },
            presentPath: {
              path: MOVE_DESTINATION_PATH,
              expectedContentVersion: sourceVersion,
              observedContentVersion: sourceVersion,
              matched: true,
            },
            closure: MOVE_DERIVED_FIXTURES.map((fixture, index) => ({
              path: fixture.path,
              expectedContentVersion: closureVersions[index]!,
              observedContentVersion: stale && fixture.path === staleFixture.path
                ? originalClosureVersions[index]!
                : closureVersions[index]!,
              expectedResolvedPath: MOVE_DESTINATION_PATH,
              observedReferenceCount: 1,
              expectedReferenceCount: 1,
              matched: !stale || fixture.path !== staleFixture.path,
            })),
            matched: !stale,
          },
          matched: !stale,
        });
        control.recordSearchSnapshotBarrierRound(round(true));
        control.releaseCommittedMetadataObservation(staleFixture.path);
        control.recordMetadataCacheObservation({
          path: staleFixture.path,
          contentVersion: closureVersions[1],
        });
        control.recordSearchSnapshotBarrierRound(round(false));
        now = 250;
        snapshotVersion = 2;
        control.recordSearchSnapshotPublication({ version: 2, immutable: true });
        latestFrame = { phase: "COMMITTED", input: { submissionKey } };
        control.recordRecoveryFrame(latestFrame);
        resolveSubmit({ proofState: "intent_applied" });
      },
      wire: {
        async submit({ input }) {
          submissionKey = input.submissionKey;
          await rm(join(vaultPath, ...MOVE_SOURCE_PATH.split("/")), { force: true });
          const destination = join(vaultPath, ...MOVE_DESTINATION_PATH.split("/"));
          await mkdir(join(destination, ".."), { recursive: true });
          await writeFile(destination, MOVE_SOURCE_BYTES);
          for (const fixture of MOVE_DERIVED_FIXTURES) {
            await writeFile(
              join(vaultPath, ...fixture.path.split("/")),
              fixture.committedBytes,
            );
            control.recordVaultEvent({ kind: "create", path: fixture.path });
          }
          return submitted;
        },
        async status() {
          return { proofState: "intent_applied" };
        },
      },
    });

    const summary = await control.execute({
      descriptor: {} as never,
      scenario: "move_note/stale_closure_observation",
      expectedVaultId: "vault-123",
      endpoint: new URL("http://127.0.0.1:32123/mcp"),
    });

    expect(summary).toMatchObject({
      scenario: "move_note/stale_closure_observation",
      mutationKind: "move_note",
      proofState: "intent_applied",
      journalPhase: "COMMITTED",
      acceptedSnapshotRounds: 1,
      rejectedSnapshotRounds: 1,
    });
  });

  it("rolls back when the move closure graph never converges", async () => {
    const vaultPath = await mkdtemp(join(tmpdir(), "installed-semantic-evidence-"));
    cleanups.push(() => rm(vaultPath, { recursive: true, force: true }));
    const sourceVersion = contentVersion(MOVE_SOURCE_BYTES);
    const committedVersions = MOVE_DERIVED_FIXTURES.map(({ committedBytes }) =>
      contentVersion(committedBytes));
    const originalVersions = MOVE_DERIVED_FIXTURES.map(({ originalBytes }) =>
      contentVersion(originalBytes));
    let now = 0;
    let snapshotVersion = 1;
    let submissionKey = "";
    let latestFrame: {
      readonly phase: "ROLLED_BACK";
      readonly input: { readonly submissionKey: string };
    } | null = null;
    let control!: ReturnType<typeof createInstalledSemanticEvidenceScenarioControl>;
    control = createInstalledSemanticEvidenceScenarioControl({
      vaultPath,
      now: () => now,
      currentSnapshot: () => ({ version: snapshotVersion, immutable: true }),
      loadRecoveryFrame: async () => latestFrame,
      cleanupPath: async (path) => {
        await rm(join(vaultPath, ...path.split("/")), { force: true });
      },
      seedPath: async (path, bytes) => {
        const absolute = join(vaultPath, ...path.split("/"));
        await mkdir(join(absolute, ".."), { recursive: true });
        await writeFile(absolute, bytes);
        control.recordVaultEvent({ kind: "create", path });
        control.recordMetadataCacheObservation({ path, contentVersion: contentVersion(bytes) });
      },
      induceMoveGraphMismatchDeadline: async () => {
        expect(control.recordVaultEvent({
          kind: "rename",
          oldPath: MOVE_SOURCE_PATH,
          path: MOVE_DESTINATION_PATH,
        })).toBe(false);
        control.releaseDelayedRenameEvent();
        control.recordMetadataCacheObservation({
          path: MOVE_DESTINATION_PATH,
          contentVersion: sourceVersion,
        });
        for (const [index, fixture] of MOVE_DERIVED_FIXTURES.entries()) {
          control.recordMetadataCacheObservation({
            path: fixture.path,
            contentVersion: committedVersions[index],
          });
        }
        control.recordSearchSnapshotBarrierRound({
          targets: [
            {
              path: MOVE_DESTINATION_PATH,
              expectedContentVersion: sourceVersion,
              observedContentVersion: sourceVersion,
              matched: true,
            },
            ...MOVE_DERIVED_FIXTURES.map((fixture, index) => ({
              path: fixture.path,
              expectedContentVersion: committedVersions[index]!,
              observedContentVersion: committedVersions[index]!,
              matched: true,
            })),
          ],
          move: {
            absentPath: { path: MOVE_SOURCE_PATH, absent: true },
            presentPath: {
              path: MOVE_DESTINATION_PATH,
              expectedContentVersion: sourceVersion,
              observedContentVersion: sourceVersion,
              matched: true,
            },
            closure: MOVE_DERIVED_FIXTURES.map((fixture, index) => ({
              path: fixture.path,
              expectedContentVersion: committedVersions[index]!,
              observedContentVersion: committedVersions[index]!,
              expectedResolvedPath: MOVE_DESTINATION_PATH,
              observedReferenceCount: index === 0 ? 0 : 1,
              expectedReferenceCount: 1,
              matched: index !== 0,
            })),
            matched: false,
          },
          matched: false,
        });
        now = 5_000;
      },
      wire: {
        async submit({ input }) {
          submissionKey = input.submissionKey;
          await rm(join(vaultPath, ...MOVE_SOURCE_PATH.split("/")), { force: true });
          const destination = join(vaultPath, ...MOVE_DESTINATION_PATH.split("/"));
          await mkdir(join(destination, ".."), { recursive: true });
          await writeFile(destination, MOVE_SOURCE_BYTES);
          for (const fixture of MOVE_DERIVED_FIXTURES) {
            await writeFile(
              join(vaultPath, ...fixture.path.split("/")),
              fixture.committedBytes,
            );
            control.recordVaultEvent({ kind: "create", path: fixture.path });
          }
          await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 0));
          await rm(destination, { force: true });
          await writeFile(
            join(vaultPath, ...MOVE_SOURCE_PATH.split("/")),
            MOVE_SOURCE_BYTES,
          );
          control.recordVaultEvent({
            kind: "rename",
            oldPath: MOVE_DESTINATION_PATH,
            path: MOVE_SOURCE_PATH,
          });
          for (const [index, fixture] of MOVE_DERIVED_FIXTURES.entries()) {
            await writeFile(
              join(vaultPath, ...fixture.path.split("/")),
              fixture.originalBytes,
            );
            control.recordMetadataCacheObservation({
              path: fixture.path,
              contentVersion: originalVersions[index],
            });
          }
          control.recordMetadataCacheObservation({
            path: MOVE_SOURCE_PATH,
            contentVersion: sourceVersion,
          });
          control.recordSearchSnapshotBarrierRound({
            targets: [
              {
                path: MOVE_DESTINATION_PATH,
                expectedContentVersion: sourceVersion,
                observedContentVersion: undefined,
                matched: false,
              },
              ...MOVE_DERIVED_FIXTURES.map((fixture, index) => ({
                path: fixture.path,
                expectedContentVersion: committedVersions[index]!,
                observedContentVersion: originalVersions[index]!,
                matched: false,
              })),
            ],
            matched: false,
          });
          snapshotVersion = 2;
          control.recordSearchSnapshotPublication({ version: 2, immutable: true });
          latestFrame = { phase: "ROLLED_BACK", input: { submissionKey } };
          control.recordRecoveryFrame(latestFrame);
          return { proofState: "intent_not_applied" };
        },
        async status() {
          return { proofState: "intent_not_applied" };
        },
      },
    });

    const summary = await control.execute({
      descriptor: {} as never,
      scenario: "move_note/graph_mismatch_deadline_rollback",
      expectedVaultId: "vault-123",
      endpoint: new URL("http://127.0.0.1:32123/mcp"),
    });

    expect(summary).toMatchObject({
      scenario: "move_note/graph_mismatch_deadline_rollback",
      mutationKind: "move_note",
      proofState: "intent_not_applied",
      journalPhase: "ROLLED_BACK",
      evidenceSessions: [
        { mode: "apply", outcome: "converged" },
        { mode: "restore", outcome: "converged" },
      ],
      acceptedSnapshotRounds: 1,
      rejectedSnapshotRounds: 1,
    });
  });

  it("ignores stale and wrong-path rename callbacks until the exact rename arrives", async () => {
    const vaultPath = await mkdtemp(join(tmpdir(), "installed-semantic-evidence-"));
    cleanups.push(() => rm(vaultPath, { recursive: true, force: true }));
    const sourceVersion = contentVersion(MOVE_SOURCE_BYTES);
    const closureVersions = MOVE_DERIVED_FIXTURES.map(({ committedBytes }) =>
      contentVersion(committedBytes));
    let now = 0;
    let snapshotVersion = 1;
    let submissionKey = "";
    let resolveSubmit!: (value: { proofState: "intent_applied" }) => void;
    const submitted = new Promise<{ proofState: "intent_applied" }>((resolve) => {
      resolveSubmit = resolve;
    });
    let latestFrame: {
      readonly phase: "COMMITTED";
      readonly input: { readonly submissionKey: string };
    } | null = null;
    let control!: ReturnType<typeof createInstalledSemanticEvidenceScenarioControl>;
    control = createInstalledSemanticEvidenceScenarioControl({
      vaultPath,
      now: () => now,
      currentSnapshot: () => ({ version: snapshotVersion, immutable: true }),
      loadRecoveryFrame: async () => latestFrame,
      cleanupPath: async (path) => {
        await rm(join(vaultPath, ...path.split("/")), { force: true });
      },
      seedPath: async (path, bytes) => {
        const absolute = join(vaultPath, ...path.split("/"));
        await mkdir(join(absolute, ".."), { recursive: true });
        await writeFile(absolute, bytes);
        control.recordVaultEvent({ kind: "create", path });
        control.recordMetadataCacheObservation({ path, contentVersion: contentVersion(bytes) });
      },
      induceMoveStalePreBeginCallback: async () => {
        expect(control.recordVaultEvent({
          kind: "rename",
          oldPath: MOVE_SOURCE_PATH,
          path: MOVE_DESTINATION_PATH,
        })).toBe(true);
      },
      induceMoveStaleAndWrongPathCallbacks: async () => {
        expect(control.recordVaultEvent({
          kind: "rename",
          oldPath: "Corpus/Move/Wrong.md",
          path: MOVE_DESTINATION_PATH,
        })).toBe(true);
        expect(control.recordVaultEvent({
          kind: "rename",
          oldPath: MOVE_SOURCE_PATH,
          path: MOVE_DESTINATION_PATH,
        })).toBe(false);
        await control.waitForRenameObservation();
        now = 250;
        expect(control.releaseDelayedRenameEvent()).toEqual({
          kind: "rename",
          oldPath: MOVE_SOURCE_PATH,
          path: MOVE_DESTINATION_PATH,
        });
        for (const [index, fixture] of MOVE_DERIVED_FIXTURES.entries()) {
          control.recordMetadataCacheObservation({
            path: fixture.path,
            contentVersion: closureVersions[index],
          });
        }
        control.recordMetadataCacheObservation({
          path: MOVE_DESTINATION_PATH,
          contentVersion: sourceVersion,
        });
        control.recordSearchSnapshotBarrierRound({
          targets: [
            {
              path: MOVE_DESTINATION_PATH,
              expectedContentVersion: sourceVersion,
              observedContentVersion: sourceVersion,
              matched: true,
            },
            ...MOVE_DERIVED_FIXTURES.map((fixture, index) => ({
              path: fixture.path,
              expectedContentVersion: closureVersions[index]!,
              observedContentVersion: closureVersions[index]!,
              matched: true,
            })),
          ],
          move: {
            absentPath: { path: MOVE_SOURCE_PATH, absent: true },
            presentPath: {
              path: MOVE_DESTINATION_PATH,
              expectedContentVersion: sourceVersion,
              observedContentVersion: sourceVersion,
              matched: true,
            },
            closure: MOVE_DERIVED_FIXTURES.map((fixture, index) => ({
              path: fixture.path,
              expectedContentVersion: closureVersions[index]!,
              observedContentVersion: closureVersions[index]!,
              expectedResolvedPath: MOVE_DESTINATION_PATH,
              observedReferenceCount: 1,
              expectedReferenceCount: 1,
              matched: true,
            })),
            matched: true,
          },
          matched: true,
        });
        snapshotVersion = 2;
        control.recordSearchSnapshotPublication({ version: 2, immutable: true });
        latestFrame = { phase: "COMMITTED", input: { submissionKey } };
        control.recordRecoveryFrame(latestFrame);
        resolveSubmit({ proofState: "intent_applied" });
      },
      wire: {
        async submit({ input }) {
          submissionKey = input.submissionKey;
          await rm(join(vaultPath, ...MOVE_SOURCE_PATH.split("/")), { force: true });
          const destination = join(vaultPath, ...MOVE_DESTINATION_PATH.split("/"));
          await mkdir(join(destination, ".."), { recursive: true });
          await writeFile(destination, MOVE_SOURCE_BYTES);
          for (const fixture of MOVE_DERIVED_FIXTURES) {
            await writeFile(
              join(vaultPath, ...fixture.path.split("/")),
              fixture.committedBytes,
            );
            control.recordVaultEvent({ kind: "create", path: fixture.path });
          }
          return submitted;
        },
        async status() {
          return { proofState: "intent_applied" };
        },
        async health() {
          return {
            recoveryBlocked: false,
            writesBlocked: false,
            effectiveGate: null,
          };
        },
      },
    });

    const summary = await control.execute({
      descriptor: {} as never,
      scenario: "move_note/stale_and_wrong_path_callbacks_ignored",
      expectedVaultId: "vault-123",
      endpoint: new URL("http://127.0.0.1:32123/mcp"),
    });

    expect(summary).toMatchObject({
      scenario: "move_note/stale_and_wrong_path_callbacks_ignored",
      mutationKind: "move_note",
      proofState: "intent_applied",
      journalPhase: "COMMITTED",
      acceptedSnapshotRounds: 1,
    });
  });

  it("rolls back when the exact rename callback never arrives", async () => {
    const vaultPath = await mkdtemp(join(tmpdir(), "installed-semantic-evidence-"));
    cleanups.push(() => rm(vaultPath, { recursive: true, force: true }));
    let now = 0;
    let snapshotVersion = 1;
    let submissionKey = "";
    let latestFrame: {
      readonly phase: "ROLLED_BACK";
      readonly input: { readonly submissionKey: string };
    } | null = null;
    let control!: ReturnType<typeof createInstalledSemanticEvidenceScenarioControl>;
    control = createInstalledSemanticEvidenceScenarioControl({
      vaultPath,
      now: () => now,
      currentSnapshot: () => ({ version: snapshotVersion, immutable: true }),
      loadRecoveryFrame: async () => latestFrame,
      cleanupPath: async (path) => {
        await rm(join(vaultPath, ...path.split("/")), { force: true });
      },
      seedPath: async (path, bytes) => {
        const absolute = join(vaultPath, ...path.split("/"));
        await mkdir(join(absolute, ".."), { recursive: true });
        await writeFile(absolute, bytes);
        control.recordVaultEvent({ kind: "create", path });
        control.recordMetadataCacheObservation({ path, contentVersion: contentVersion(bytes) });
      },
      wire: {
        async submit({ input }) {
          submissionKey = input.submissionKey;
          expect(control.recordVaultEvent({
            kind: "rename",
            oldPath: MOVE_SOURCE_PATH,
            path: MOVE_DESTINATION_PATH,
          })).toBe(false);
          await rm(join(vaultPath, ...MOVE_SOURCE_PATH.split("/")), { force: true });
          const destination = join(vaultPath, ...MOVE_DESTINATION_PATH.split("/"));
          await mkdir(join(destination, ".."), { recursive: true });
          await writeFile(destination, MOVE_SOURCE_BYTES);
          for (const fixture of MOVE_DERIVED_FIXTURES) {
            await writeFile(
              join(vaultPath, ...fixture.path.split("/")),
              fixture.committedBytes,
            );
          }

          await rm(destination, { force: true });
          const source = join(vaultPath, ...MOVE_SOURCE_PATH.split("/"));
          await writeFile(source, MOVE_SOURCE_BYTES);
          control.recordVaultEvent({
            kind: "rename",
            oldPath: MOVE_DESTINATION_PATH,
            path: MOVE_SOURCE_PATH,
          });
          for (const fixture of MOVE_DERIVED_FIXTURES) {
            await writeFile(
              join(vaultPath, ...fixture.path.split("/")),
              fixture.originalBytes,
            );
          }
          now = 5_000;
          snapshotVersion = 2;
          control.recordSearchSnapshotPublication({ version: 2, immutable: true });
          latestFrame = { phase: "ROLLED_BACK", input: { submissionKey } };
          control.recordRecoveryFrame(latestFrame);
          return { proofState: "intent_not_applied" };
        },
        async status() {
          return { proofState: "intent_not_applied" };
        },
        async health() {
          return {
            recoveryBlocked: false,
            writesBlocked: false,
            effectiveGate: null,
          };
        },
      },
    });

    const summary = await control.execute({
      descriptor: {} as never,
      scenario: "move_note/missing_rename_event_deadline",
      expectedVaultId: "vault-123",
      endpoint: new URL("http://127.0.0.1:32123/mcp"),
    });

    expect(summary).toMatchObject({
      scenario: "move_note/missing_rename_event_deadline",
      mutationKind: "move_note",
      proofState: "intent_not_applied",
      journalPhase: "ROLLED_BACK",
      evidenceSessions: [
        { mode: "apply", outcome: "timed_out", virtualElapsedMs: 5_000 },
        { mode: "restore", outcome: "converged" },
      ],
    });
  });

  it("proves a delayed exact rename and its reference closure", async () => {
    const vaultPath = await mkdtemp(join(tmpdir(), "installed-semantic-evidence-"));
    cleanups.push(() => rm(vaultPath, { recursive: true, force: true }));
    const sourceVersion = contentVersion(MOVE_SOURCE_BYTES);
    const closureVersions = MOVE_DERIVED_FIXTURES.map(({ committedBytes }) =>
      contentVersion(committedBytes));
    let now = 0;
    let snapshotVersion = 1;
    let submissionKey = "";
    let resolveSubmit!: (value: { proofState: "intent_applied" }) => void;
    const submitted = new Promise<{ proofState: "intent_applied" }>((resolve) => {
      resolveSubmit = resolve;
    });
    let latestFrame: {
      readonly phase: "COMMITTED";
      readonly input: { readonly submissionKey: string };
    } | null = null;
    let control!: ReturnType<typeof createInstalledSemanticEvidenceScenarioControl>;
    control = createInstalledSemanticEvidenceScenarioControl({
      vaultPath,
      now: () => now,
      currentSnapshot: () => ({ version: snapshotVersion, immutable: true }),
      loadRecoveryFrame: async () => latestFrame,
      cleanupPath: async (path) => {
        await rm(join(vaultPath, ...path.split("/")), { force: true });
      },
      seedPath: async (path, bytes) => {
        const absolute = join(vaultPath, ...path.split("/"));
        await mkdir(join(absolute, ".."), { recursive: true });
        await writeFile(absolute, bytes);
        control.recordVaultEvent({ kind: "create", path });
        control.recordMetadataCacheObservation({ path, contentVersion: contentVersion(bytes) });
      },
      induceMoveDelayedRename: async () => {
        expect(control.recordVaultEvent({
          kind: "rename",
          oldPath: MOVE_SOURCE_PATH,
          path: MOVE_DESTINATION_PATH,
        })).toBe(false);
        await control.waitForRenameObservation();
        now = 250;
        expect(control.releaseDelayedRenameEvent()).toEqual({
          kind: "rename",
          oldPath: MOVE_SOURCE_PATH,
          path: MOVE_DESTINATION_PATH,
        });
        for (const [index, fixture] of MOVE_DERIVED_FIXTURES.entries()) {
          control.recordMetadataCacheObservation({
            path: fixture.path,
            contentVersion: closureVersions[index],
          });
        }
        control.recordSearchSnapshotBarrierRound({
          targets: [
            {
              path: MOVE_DESTINATION_PATH,
              expectedContentVersion: sourceVersion,
              observedContentVersion: sourceVersion,
              matched: true,
            },
            ...MOVE_DERIVED_FIXTURES.map((fixture, index) => ({
              path: fixture.path,
              expectedContentVersion: closureVersions[index]!,
              observedContentVersion: closureVersions[index]!,
              matched: true,
            })),
          ],
          move: {
            absentPath: { path: MOVE_SOURCE_PATH, absent: true },
            presentPath: {
              path: MOVE_DESTINATION_PATH,
              expectedContentVersion: sourceVersion,
              observedContentVersion: sourceVersion,
              matched: true,
            },
            closure: MOVE_DERIVED_FIXTURES.map((fixture, index) => ({
              path: fixture.path,
              expectedContentVersion: closureVersions[index]!,
              observedContentVersion: closureVersions[index]!,
              expectedResolvedPath: MOVE_DESTINATION_PATH,
              observedReferenceCount: 1,
              expectedReferenceCount: 1,
              matched: true,
            })),
            matched: true,
          },
          matched: true,
        });
        snapshotVersion = 2;
        control.recordSearchSnapshotPublication({ version: 2, immutable: true });
        latestFrame = { phase: "COMMITTED", input: { submissionKey } };
        control.recordRecoveryFrame(latestFrame);
        resolveSubmit({ proofState: "intent_applied" });
      },
      wire: {
        async submit({ input }) {
          submissionKey = input.submissionKey;
          await rm(join(vaultPath, ...MOVE_SOURCE_PATH.split("/")), { force: true });
          const destination = join(vaultPath, ...MOVE_DESTINATION_PATH.split("/"));
          await mkdir(join(destination, ".."), { recursive: true });
          await writeFile(destination, MOVE_SOURCE_BYTES);
          for (const fixture of MOVE_DERIVED_FIXTURES) {
            await writeFile(
              join(vaultPath, ...fixture.path.split("/")),
              fixture.committedBytes,
            );
            control.recordVaultEvent({ kind: "create", path: fixture.path });
          }
          return submitted;
        },
        async status() {
          return { proofState: "intent_applied" };
        },
      },
    });

    const summary = await control.execute({
      descriptor: {} as never,
      scenario: "move_note/delayed_rename_callback",
      expectedVaultId: "vault-123",
      endpoint: new URL("http://127.0.0.1:32123/mcp"),
    });

    expect(summary).toMatchObject({
      scenario: "move_note/delayed_rename_callback",
      mutationKind: "move_note",
      proofState: "intent_applied",
      journalPhase: "COMMITTED",
      acceptedSnapshotRounds: 1,
      rejectedSnapshotRounds: 0,
    });
  });

  it("accepts reordered multi-file callbacks only after simultaneous convergence", async () => {
    const vaultPath = await mkdtemp(join(tmpdir(), "installed-semantic-evidence-"));
    cleanups.push(() => rm(vaultPath, { recursive: true, force: true }));
    const paths = ["Corpus/Multi/NoteC.md", "Corpus/Multi/NoteD.md"] as const;
    const originalBytes = [EXACT_ORIGINAL_BYTES, FRONTMATTER_ORIGINAL_BYTES] as const;
    const committedBytes = [EXACT_COMMITTED_BYTES, FRONTMATTER_COMMITTED_BYTES] as const;
    const originalVersions = originalBytes.map(contentVersion);
    const committedVersions = committedBytes.map(contentVersion);
    let now = 0;
    let snapshotVersion = 1;
    let submissionKey = "";
    let resolveSubmit!: (value: { proofState: "intent_applied" }) => void;
    const submitted = new Promise<{ proofState: "intent_applied" }>((resolve) => {
      resolveSubmit = resolve;
    });
    let latestFrame: {
      readonly phase: "COMMITTED";
      readonly input: { readonly submissionKey: string };
    } | null = null;
    let control!: ReturnType<typeof createInstalledSemanticEvidenceScenarioControl>;
    control = createInstalledSemanticEvidenceScenarioControl({
      vaultPath,
      now: () => now,
      currentSnapshot: () => ({ version: snapshotVersion, immutable: true }),
      loadRecoveryFrame: async () => latestFrame,
      cleanupPath: async (path) => {
        await rm(join(vaultPath, ...path.split("/")), { force: true });
      },
      seedPath: async (path, bytes) => {
        const absolute = join(vaultPath, ...path.split("/"));
        await mkdir(join(absolute, ".."), { recursive: true });
        await writeFile(absolute, bytes);
        control.recordVaultEvent({ kind: "create", path });
        control.recordMetadataCacheObservation({ path, contentVersion: contentVersion(bytes) });
      },
      induceMultiFrontmatterReorderedCallbacks: async () => {
        expect(control.acceptMetadataCacheObservation({
          path: paths[0],
          contentVersion: committedVersions[0],
        })).toBe(false);
        expect(control.acceptMetadataCacheObservation({
          path: paths[1],
          contentVersion: committedVersions[1],
        })).toBe(false);
        control.releaseCommittedMetadataObservation(paths[0]);
        expect(control.acceptMetadataCacheObservation({
          path: paths[0],
          contentVersion: committedVersions[0],
        })).toBe(true);
        expect(control.acceptMetadataCacheObservation({
          path: paths[1],
          contentVersion: committedVersions[1],
        })).toBe(false);
        control.releaseCommittedMetadataObservation(paths[1]);
        expect(control.acceptMetadataCacheObservation({
          path: paths[1],
          contentVersion: committedVersions[1],
        })).toBe(true);
        const recordRound = (
          observed: readonly [string, string],
          matched: readonly [boolean, boolean],
        ): void => {
          for (const [index, path] of paths.entries()) {
            control.recordMetadataCacheObservation({
              path,
              contentVersion: observed[index],
            });
          }
          control.recordSearchSnapshotBarrierRound({
            targets: paths.map((path, index) => ({
              path,
              expectedContentVersion: committedVersions[index]!,
              observedContentVersion: observed[index],
              matched: matched[index]!,
            })),
            matched: matched.every(Boolean),
          });
        };
        recordRound(
          [committedVersions[0]!, originalVersions[1]!],
          [true, false],
        );
        recordRound(
          [originalVersions[0]!, committedVersions[1]!],
          [false, true],
        );
        recordRound(
          [committedVersions[0]!, committedVersions[1]!],
          [true, true],
        );
        now = 250;
        snapshotVersion = 2;
        control.recordSearchSnapshotPublication({ version: 2, immutable: true });
        latestFrame = { phase: "COMMITTED", input: { submissionKey } };
        control.recordRecoveryFrame(latestFrame);
        resolveSubmit({ proofState: "intent_applied" });
      },
      wire: {
        async submit({ input }) {
          submissionKey = input.submissionKey;
          for (const [index, path] of paths.entries()) {
            await writeFile(join(vaultPath, ...path.split("/")), committedBytes[index]!);
            control.recordVaultEvent({ kind: "create", path });
          }
          return submitted;
        },
        async status() {
          return { proofState: "intent_applied" };
        },
      },
    });

    const summary = await control.execute({
      descriptor: {} as never,
      scenario: "edit_multi_frontmatter/reordered_cache_callbacks",
      expectedVaultId: "vault-123",
      endpoint: new URL("http://127.0.0.1:32123/mcp"),
    });

    expect(summary).toMatchObject({
      scenario: "edit_multi_frontmatter/reordered_cache_callbacks",
      mutationKind: "edit_multi_frontmatter",
      proofState: "intent_applied",
      journalPhase: "COMMITTED",
      acceptedSnapshotRounds: 1,
      rejectedSnapshotRounds: 2,
    });
    for (const path of paths) {
      await expect(readFile(join(vaultPath, ...path.split("/")))).rejects.toMatchObject({
        code: "ENOENT",
      });
    }
  });

  it("requires every target in a multi-file barrier round to match together", async () => {
    const vaultPath = await mkdtemp(join(tmpdir(), "installed-semantic-evidence-"));
    cleanups.push(() => rm(vaultPath, { recursive: true, force: true }));
    const committedVersion = contentVersion(EXACT_COMMITTED_BYTES);
    let now = 0;
    let snapshotVersion = 1;
    let submissionKey = "";
    let resolveSubmit!: (value: { proofState: "intent_applied" }) => void;
    const submitted = new Promise<{ proofState: "intent_applied" }>((resolve) => {
      resolveSubmit = resolve;
    });
    let latestFrame: {
      readonly phase: "COMMITTED";
      readonly input: { readonly submissionKey: string };
    } | null = null;
    let control!: ReturnType<typeof createInstalledSemanticEvidenceScenarioControl>;
    control = createInstalledSemanticEvidenceScenarioControl({
      vaultPath,
      now: () => now,
      currentSnapshot: () => ({ version: snapshotVersion, immutable: true }),
      loadRecoveryFrame: async () => latestFrame,
      cleanupPath: async (path) => {
        await rm(join(vaultPath, ...path.split("/")), { force: true });
      },
      seedPath: async (path, bytes) => {
        const absolute = join(vaultPath, ...path.split("/"));
        await mkdir(join(absolute, ".."), { recursive: true });
        await writeFile(absolute, bytes);
        control.recordVaultEvent({ kind: "create", path });
        control.recordMetadataCacheObservation({
          path,
          contentVersion: contentVersion(bytes),
        });
      },
      induceEditBodyStaleThenFresh: async () => {
        control.recordMetadataCacheObservation({
          path: EXACT_FIXTURE.path,
          contentVersion: committedVersion,
        });
        control.recordSearchSnapshotBarrierRound({
          targets: [
            {
              path: EXACT_FIXTURE.path,
              expectedContentVersion: committedVersion,
              observedContentVersion: committedVersion,
              matched: true,
            },
            {
              path: "Corpus/Multi/Other.md",
              expectedContentVersion: `sha256:${"b".repeat(64)}`,
              observedContentVersion: `sha256:${"a".repeat(64)}`,
              matched: false,
            },
          ],
          matched: false,
        });
        control.recordSearchSnapshotBarrierRound({
          targets: [{
            path: EXACT_FIXTURE.path,
            expectedContentVersion: committedVersion,
            observedContentVersion: committedVersion,
            matched: true,
          }],
          matched: true,
        });
        now = 250;
        snapshotVersion = 2;
        control.recordSearchSnapshotPublication({ version: 2, immutable: true });
        latestFrame = { phase: "COMMITTED", input: { submissionKey } };
        control.recordRecoveryFrame(latestFrame);
        resolveSubmit({ proofState: "intent_applied" });
      },
      wire: {
        async submit({ input }) {
          submissionKey = input.submissionKey;
          await writeFile(
            join(vaultPath, ...EXACT_FIXTURE.path.split("/")),
            EXACT_COMMITTED_BYTES,
          );
          control.recordVaultEvent({ kind: "create", path: EXACT_FIXTURE.path });
          return submitted;
        },
        async status() {
          return { proofState: "intent_applied" };
        },
      },
    });

    const summary = await control.execute({
      descriptor: {} as never,
      scenario: "edit_body/stale_version_callback_after_newer_bytes",
      expectedVaultId: "vault-123",
      endpoint: new URL("http://127.0.0.1:32123/mcp"),
    });

    expect(summary).toMatchObject({
      acceptedSnapshotRounds: 1,
      rejectedSnapshotRounds: 1,
    });
  });

  it("surfaces contrary edit-body residue and proves writes are recovery-blocked", async () => {
    const vaultPath = await mkdtemp(join(tmpdir(), "installed-semantic-evidence-"));
    cleanups.push(() => rm(vaultPath, { recursive: true, force: true }));
    const fixturePath = join(vaultPath, ...EXACT_FIXTURE.path.split("/"));
    const foreignBytes = new TextEncoder().encode(
      "# Third-party interference\n\nForeign 你好 🚀\n",
    );
    let now = 0;
    let submissionKey = "";
    let resolveSubmit!: (value: { proofState: "result_unproven" }) => void;
    const submitted = new Promise<{ proofState: "result_unproven" }>((resolve) => {
      resolveSubmit = resolve;
    });
    let latestFrame: {
      readonly phase: "FAILED";
      readonly input: { readonly submissionKey: string };
    } | null = null;
    let control!: ReturnType<typeof createInstalledSemanticEvidenceScenarioControl>;
    control = createInstalledSemanticEvidenceScenarioControl({
      vaultPath,
      now: () => now,
      currentSnapshot: () => ({ version: 1, immutable: true }),
      loadRecoveryFrame: async () => latestFrame,
      observeHealth: async () => ({
        recoveryBlocked: true,
        writesBlocked: true,
        effectiveGate: "recovery_blocked",
      }),
      cleanupPath: async (path) => {
        await rm(join(vaultPath, ...path.split("/")), { force: true });
      },
      seedPath: async (path, bytes) => {
        const absolute = join(vaultPath, ...path.split("/"));
        await mkdir(join(absolute, ".."), { recursive: true });
        await writeFile(absolute, bytes);
        control.recordVaultEvent({ kind: "create", path });
        control.recordMetadataCacheObservation({
          path,
          contentVersion: contentVersion(bytes),
        });
      },
      induceEditBodyContraryThirdParty: async () => {
        const committedVersion = contentVersion(EXACT_COMMITTED_BYTES);
        control.markMetadataContentVersionMissing();
        control.recordSearchSnapshotBarrierRound({
          targets: [{
            path: EXACT_FIXTURE.path,
            expectedContentVersion: committedVersion,
            observedContentVersion: null,
            matched: false,
          }],
          matched: false,
        });
        now = 5_000;
        await writeFile(fixturePath, foreignBytes);
        latestFrame = { phase: "FAILED", input: { submissionKey } };
        control.recordRecoveryFrame(latestFrame);
        resolveSubmit({ proofState: "result_unproven" });
      },
      wire: {
        async submit({ input }) {
          submissionKey = input.submissionKey;
          await writeFile(fixturePath, EXACT_COMMITTED_BYTES);
          control.recordVaultEvent({ kind: "create", path: EXACT_FIXTURE.path });
          return submitted;
        },
        async status() {
          return { proofState: "result_unproven" };
        },
      },
    });

    const summary = await control.execute({
      descriptor: {} as never,
      scenario: "edit_body/contrary_third_party_blocks_writes",
      expectedVaultId: "vault-123",
      endpoint: new URL("http://127.0.0.1:32123/mcp"),
    });

    expect(summary).toMatchObject({
      scenario: "edit_body/contrary_third_party_blocks_writes",
      mutationKind: "edit_body",
      proofState: "result_unproven",
      statusProofState: "result_unproven",
      journalPhase: "FAILED",
      evidenceSessions: [{ mode: "apply", outcome: "timed_out", virtualElapsedMs: 5_000 }],
      acceptedSnapshotRounds: 0,
      rejectedSnapshotRounds: 1,
      successorSnapshot: {
        baselineVersion: 1,
        version: null,
        immutable: false,
        publishedBeforeIntentApplied: false,
      },
      durableCommitBeforeIntentApplied: false,
      writesBlocked: true,
      residueSha256: createHash("sha256").update(foreignBytes).digest("hex"),
    });
    await expect(readFile(fixturePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("resets a contradicted edit-body quiet window before fresh convergence", async () => {
    const vaultPath = await mkdtemp(join(tmpdir(), "installed-semantic-evidence-"));
    cleanups.push(() => rm(vaultPath, { recursive: true, force: true }));
    const fixturePath = join(vaultPath, ...EXACT_FIXTURE.path.split("/"));
    let now = 0;
    let snapshotVersion = 1;
    let submissionKey = "";
    let resolveSubmit!: (value: { proofState: "intent_applied" }) => void;
    const submitted = new Promise<{ proofState: "intent_applied" }>((resolve) => {
      resolveSubmit = resolve;
    });
    let latestFrame: {
      readonly phase: "COMMITTED";
      readonly input: { readonly submissionKey: string };
    } | null = null;
    let control!: ReturnType<typeof createInstalledSemanticEvidenceScenarioControl>;
    control = createInstalledSemanticEvidenceScenarioControl({
      vaultPath,
      now: () => now,
      currentSnapshot: () => ({ version: snapshotVersion, immutable: true }),
      loadRecoveryFrame: async () => latestFrame,
      cleanupPath: async (path) => {
        await rm(join(vaultPath, ...path.split("/")), { force: true });
      },
      seedPath: async (path, bytes) => {
        const absolute = join(vaultPath, ...path.split("/"));
        await mkdir(join(absolute, ".."), { recursive: true });
        await writeFile(absolute, bytes);
        control.recordVaultEvent({ kind: "create", path });
        control.recordMetadataCacheObservation({
          path,
          contentVersion: contentVersion(bytes),
        });
      },
      induceEditBodyQuietWindowContradiction: async () => {
        const originalVersion = contentVersion(EXACT_ORIGINAL_BYTES);
        const committedVersion = contentVersion(EXACT_COMMITTED_BYTES);
        control.recordSearchSnapshotRefresh({ reset: true });
        control.recordSearchSnapshotBarrierRound({
          targets: [{
            path: EXACT_FIXTURE.path,
            expectedContentVersion: committedVersion,
            observedContentVersion: originalVersion,
            matched: false,
          }],
          matched: false,
        });
        control.recordMetadataCacheObservation({
          path: EXACT_FIXTURE.path,
          contentVersion: committedVersion,
        });
        control.recordSearchSnapshotBarrierRound({
          targets: [{
            path: EXACT_FIXTURE.path,
            expectedContentVersion: committedVersion,
            observedContentVersion: committedVersion,
            matched: true,
          }],
          matched: true,
        });
        now = 250;
        snapshotVersion = 2;
        control.recordSearchSnapshotPublication({ version: 2, immutable: true });
        latestFrame = { phase: "COMMITTED", input: { submissionKey } };
        control.recordRecoveryFrame(latestFrame);
        resolveSubmit({ proofState: "intent_applied" });
      },
      wire: {
        async submit({ input }) {
          submissionKey = input.submissionKey;
          await writeFile(fixturePath, EXACT_COMMITTED_BYTES);
          control.recordVaultEvent({ kind: "create", path: EXACT_FIXTURE.path });
          return submitted;
        },
        async status() {
          return { proofState: "intent_applied" };
        },
      },
    });

    const summary = await control.execute({
      descriptor: {} as never,
      scenario: "edit_body/quiet_window_contradiction",
      expectedVaultId: "vault-123",
      endpoint: new URL("http://127.0.0.1:32123/mcp"),
    });

    expect(summary).toMatchObject({
      scenario: "edit_body/quiet_window_contradiction",
      mutationKind: "edit_body",
      proofState: "intent_applied",
      quietWindowResets: 1,
      acceptedSnapshotRounds: 1,
      rejectedSnapshotRounds: 1,
    });
    await expect(readFile(fixturePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("times out when the edit-body metadata observation never arrives", async () => {
    const vaultPath = await mkdtemp(join(tmpdir(), "installed-semantic-evidence-"));
    cleanups.push(() => rm(vaultPath, { recursive: true, force: true }));
    const fixturePath = join(vaultPath, ...EXACT_FIXTURE.path.split("/"));
    let now = 0;
    let snapshotVersion = 1;
    let submissionKey = "";
    let resolveSubmit!: (value: { proofState: "intent_not_applied" }) => void;
    const submitted = new Promise<{ proofState: "intent_not_applied" }>((resolve) => {
      resolveSubmit = resolve;
    });
    let latestFrame: {
      readonly phase: "ROLLED_BACK";
      readonly input: { readonly submissionKey: string };
    } | null = null;
    let control!: ReturnType<typeof createInstalledSemanticEvidenceScenarioControl>;
    control = createInstalledSemanticEvidenceScenarioControl({
      vaultPath,
      now: () => now,
      currentSnapshot: () => ({ version: snapshotVersion, immutable: true }),
      loadRecoveryFrame: async () => latestFrame,
      cleanupPath: async (path) => {
        await rm(join(vaultPath, ...path.split("/")), { force: true });
      },
      seedPath: async (path, bytes) => {
        const absolute = join(vaultPath, ...path.split("/"));
        await mkdir(join(absolute, ".."), { recursive: true });
        await writeFile(absolute, bytes);
        control.recordVaultEvent({ kind: "create", path });
        control.recordMetadataCacheObservation({
          path,
          contentVersion: contentVersion(bytes),
        });
      },
      induceEditBodyMissingObservationDeadline: async () => {
        const committedVersion = contentVersion(EXACT_COMMITTED_BYTES);
        control.markMetadataContentVersionMissing();
        control.recordSearchSnapshotBarrierRound({
          targets: [{
            path: EXACT_FIXTURE.path,
            expectedContentVersion: committedVersion,
            observedContentVersion: null,
            matched: false,
          }],
          matched: false,
        });
        now = 5_000;
        await writeFile(fixturePath, EXACT_ORIGINAL_BYTES);
        control.recordMetadataCacheObservation({
          path: EXACT_FIXTURE.path,
          contentVersion: contentVersion(EXACT_ORIGINAL_BYTES),
        });
        control.recordSearchSnapshotBarrierRound({
          targets: [{
            path: EXACT_FIXTURE.path,
            expectedContentVersion: contentVersion(EXACT_ORIGINAL_BYTES),
            observedContentVersion: contentVersion(EXACT_ORIGINAL_BYTES),
            matched: true,
          }],
          matched: true,
        });
        snapshotVersion = 2;
        control.recordSearchSnapshotPublication({ version: 2, immutable: true });
        latestFrame = { phase: "ROLLED_BACK", input: { submissionKey } };
        control.recordRecoveryFrame(latestFrame);
        resolveSubmit({ proofState: "intent_not_applied" });
      },
      wire: {
        async submit({ input }) {
          submissionKey = input.submissionKey;
          await writeFile(fixturePath, EXACT_COMMITTED_BYTES);
          control.recordVaultEvent({ kind: "create", path: EXACT_FIXTURE.path });
          return submitted;
        },
        async status() {
          return { proofState: "intent_not_applied" };
        },
      },
    });

    const summary = await control.execute({
      descriptor: {} as never,
      scenario: "edit_body/missing_observation_deadline",
      expectedVaultId: "vault-123",
      endpoint: new URL("http://127.0.0.1:32123/mcp"),
    });

    expect(summary).toMatchObject({
      scenario: "edit_body/missing_observation_deadline",
      mutationKind: "edit_body",
      proofState: "intent_not_applied",
      statusProofState: "intent_not_applied",
      journalPhase: "ROLLED_BACK",
      evidenceSessions: [
        { mode: "apply", outcome: "timed_out", virtualElapsedMs: 5_000 },
        { mode: "restore", outcome: "converged" },
      ],
      acceptedSnapshotRounds: 1,
      rejectedSnapshotRounds: 1,
      durableCommitBeforeIntentApplied: false,
    });
    await expect(readFile(fixturePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects an edit-body callback for the pre-edit Content Version", async () => {
    const vaultPath = await mkdtemp(join(tmpdir(), "installed-semantic-evidence-"));
    cleanups.push(() => rm(vaultPath, { recursive: true, force: true }));
    const fixturePath = join(vaultPath, ...EXACT_FIXTURE.path.split("/"));
    let now = 0;
    let snapshotVersion = 1;
    let submissionKey = "";
    let resolveSubmit!: (value: { proofState: "intent_applied" }) => void;
    const submitted = new Promise<{ proofState: "intent_applied" }>((resolve) => {
      resolveSubmit = resolve;
    });
    let latestFrame: {
      readonly phase: "COMMITTED";
      readonly input: { readonly submissionKey: string };
    } | null = null;
    let editInductionStarted = false;
    let resolveCommittedHostMutation!: () => void;
    const committedHostMutation = new Promise<void>((resolve) => {
      resolveCommittedHostMutation = resolve;
    });
    let control!: ReturnType<typeof createInstalledSemanticEvidenceScenarioControl>;
    control = createInstalledSemanticEvidenceScenarioControl({
      vaultPath,
      now: () => now,
      currentSnapshot: () => ({ version: snapshotVersion, immutable: true }),
      loadRecoveryFrame: async () => latestFrame,
      cleanupPath: async (path) => {
        await rm(join(vaultPath, ...path.split("/")), { force: true });
      },
      seedPath: async (path, bytes) => {
        const absolute = join(vaultPath, ...path.split("/"));
        await mkdir(join(absolute, ".."), { recursive: true });
        await writeFile(absolute, bytes);
        control.recordVaultEvent({ kind: "create", path });
        control.recordMetadataCacheObservation({
          path,
          contentVersion: contentVersion(bytes.slice(3)),
          bomPrefixedContentVersion: contentVersion(bytes),
        });
      },
      induceEditBodyStaleThenFresh: async ({
        committedContentVersion,
        waitForCommittedMetadataContentVersion,
      }) => {
        editInductionStarted = true;
        const originalVersion = contentVersion(EXACT_ORIGINAL_BYTES);
        const committedVersion = contentVersion(EXACT_COMMITTED_BYTES);
        expect(committedContentVersion).toBe(committedVersion);
        control.recordSearchSnapshotBarrierRound({
          targets: [{
            path: EXACT_FIXTURE.path,
            expectedContentVersion: committedVersion,
            observedContentVersion: null,
            matched: false,
          }],
          matched: false,
        });
        control.releaseCommittedMetadataObservation();
        resolveCommittedHostMutation();
        await waitForCommittedMetadataContentVersion();
        control.recordSearchSnapshotBarrierRound({
          targets: [{
            path: EXACT_FIXTURE.path,
            expectedContentVersion: committedVersion,
            observedContentVersion: committedVersion,
            matched: true,
          }],
          matched: true,
        });
        now = 250;
        snapshotVersion = 2;
        control.recordSearchSnapshotPublication({ version: 2, immutable: true });
        latestFrame = { phase: "COMMITTED", input: { submissionKey } };
        control.recordRecoveryFrame(latestFrame);
        resolveSubmit({ proofState: "intent_applied" });
      },
      wire: {
        async submit({ input }) {
          submissionKey = input.submissionKey;
          await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 0));
          await writeFile(fixturePath, EXACT_COMMITTED_BYTES);
          const committedObservation = {
            path: EXACT_FIXTURE.path,
            contentVersion: contentVersion(EXACT_COMMITTED_BYTES.slice(3)),
            bomPrefixedContentVersion: contentVersion(EXACT_COMMITTED_BYTES),
          };
          expect(control.acceptMetadataCacheObservation(committedObservation)).toBe(false);
          expect(control.acceptsMetadataCacheObservation(EXACT_FIXTURE.path)).toBe(false);
          control.recordVaultEvent({ kind: "create", path: EXACT_FIXTURE.path });
          await committedHostMutation;
          expect(editInductionStarted).toBe(true);
          expect(control.acceptMetadataCacheObservation(committedObservation)).toBe(true);
          expect(control.acceptsMetadataCacheObservation(EXACT_FIXTURE.path)).toBe(true);
          control.recordMetadataCacheObservation(committedObservation);
          return submitted;
        },
        async status() {
          return { proofState: "intent_applied" };
        },
      },
    });

    const summary = await control.execute({
      descriptor: {} as never,
      scenario: "edit_body/stale_version_callback_after_newer_bytes",
      expectedVaultId: "vault-123",
      endpoint: new URL("http://127.0.0.1:32123/mcp"),
    });

    expect(summary).toMatchObject({
      scenario: "edit_body/stale_version_callback_after_newer_bytes",
      mutationKind: "edit_body",
      proofState: "intent_applied",
      acceptedSnapshotRounds: 1,
      rejectedSnapshotRounds: 1,
    });
    await expect(readFile(fixturePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("times out on a stale cache observation and proves rollback", async () => {
    const vaultPath = await mkdtemp(join(tmpdir(), "installed-semantic-evidence-"));
    cleanups.push(() => rm(vaultPath, { recursive: true, force: true }));
    let now = 0;
    let snapshotVersion = 1;
    let submissionKey = "";
    let resolveSubmit!: (value: { proofState: "intent_not_applied" }) => void;
    const submitted = new Promise<{ proofState: "intent_not_applied" }>((resolve) => {
      resolveSubmit = resolve;
    });
    let latestFrame: {
      readonly phase: "ROLLED_BACK";
      readonly input: { readonly submissionKey: string };
    } | null = null;
    let control!: ReturnType<typeof createInstalledSemanticEvidenceScenarioControl>;
    control = createInstalledSemanticEvidenceScenarioControl({
      vaultPath,
      now: () => now,
      currentSnapshot: () => ({ version: snapshotVersion, immutable: true }),
      loadRecoveryFrame: async () => latestFrame,
      cleanupPath: async (path) => {
        await rm(join(vaultPath, ...path.split("/")), { force: true });
      },
      induceStaleObservationDeadline: async () => {
        expect(control.acceptMetadataCacheObservation({
          path: CREATE_NOTE_PATH,
          contentVersion: contentVersion(new TextEncoder().encode(CREATE_NOTE_CONTENT)),
        })).toBe(false);
        control.recordMetadataCacheObservation({
          path: CREATE_NOTE_PATH,
          contentVersion:
            "sha256:7a30e1be393dd458c316cf18312475986671d3d89199480f7f00143d5a385b4f",
        });
        expect(control.acceptsMetadataCacheObservation(CREATE_NOTE_PATH)).toBe(true);
        control.recordSearchSnapshotBarrierRound({
          targets: [{
            path: CREATE_NOTE_PATH,
            expectedContentVersion: contentVersion(new TextEncoder().encode(CREATE_NOTE_CONTENT)),
            matched: false,
          }],
          matched: false,
        });
        await control.waitForRejectedSnapshotRounds(1);
        expect(control.acceptMetadataCacheObservation({
          path: CREATE_NOTE_PATH,
          contentVersion: contentVersion(new TextEncoder().encode(CREATE_NOTE_CONTENT)),
        })).toBe(false);
        control.recordSearchSnapshotBarrierRound({
          targets: [{
            path: CREATE_NOTE_PATH,
            expectedContentVersion:
              "sha256:a36f88ca2067ed0fd114674d7d142a15a4575b837b1bdd0155daa26e7a5ea3df",
            observedContentVersion:
              "sha256:7a30e1be393dd458c316cf18312475986671d3d89199480f7f00143d5a385b4f",
            matched: false,
          }],
          matched: false,
        });
        expect(control.acceptMetadataCacheObservation({
          path: CREATE_NOTE_PATH,
          contentVersion: contentVersion(new TextEncoder().encode(CREATE_NOTE_CONTENT)),
        })).toBe(false);
        now = 5_000;
        await rm(join(vaultPath, ...CREATE_NOTE_PATH.split("/")), { force: true });
        control.recordVaultEvent({ kind: "delete", path: CREATE_NOTE_PATH });
        snapshotVersion = 2;
        control.recordSearchSnapshotPublication({ version: 2, immutable: true });
        latestFrame = {
          phase: "ROLLED_BACK",
          input: { submissionKey },
        };
        control.recordRecoveryFrame(latestFrame);
        resolveSubmit({ proofState: "intent_not_applied" });
      },
      wire: {
        async submit({ input }) {
          submissionKey = input.submissionKey;
          const path = join(vaultPath, ...CREATE_NOTE_PATH.split("/"));
          await mkdir(join(path, ".."), { recursive: true });
          await writeFile(path, CREATE_NOTE_CONTENT, "utf8");
          control.recordVaultEvent({ kind: "create", path: CREATE_NOTE_PATH });
          return submitted;
        },
        async status() {
          return { proofState: "intent_not_applied" };
        },
      },
    });

    const summary = await control.execute({
      descriptor: {} as never,
      scenario: "create_note/stale_observation_deadline",
      expectedVaultId: "vault-123",
      endpoint: new URL("http://127.0.0.1:32123/mcp"),
    });

    expect(summary).toMatchObject({
      scenario: "create_note/stale_observation_deadline",
      proofState: "intent_not_applied",
      statusProofState: "intent_not_applied",
      journalPhase: "ROLLED_BACK",
      evidenceSessions: [
        { mode: "apply", outcome: "timed_out", virtualElapsedMs: 5_000 },
        { mode: "restore", outcome: "converged" },
      ],
      acceptedSnapshotRounds: 1,
      rejectedSnapshotRounds: 2,
      durableCommitBeforeIntentApplied: false,
    });
  });

  it("rejects stale and missing cache observations before fresh convergence", async () => {
    const vaultPath = await mkdtemp(join(tmpdir(), "installed-semantic-evidence-"));
    cleanups.push(() => rm(vaultPath, { recursive: true, force: true }));
    let now = 0;
    let snapshotVersion = 1;
    let submissionKey = "";
    let resolveSubmit!: (value: { proofState: "intent_applied" }) => void;
    const submitted = new Promise<{ proofState: "intent_applied" }>((resolve) => {
      resolveSubmit = resolve;
    });
    let latestFrame: {
      readonly phase: "COMMITTED";
      readonly input: { readonly submissionKey: string };
    } | null = null;
    let control!: ReturnType<typeof createInstalledSemanticEvidenceScenarioControl>;
    control = createInstalledSemanticEvidenceScenarioControl({
      vaultPath,
      now: () => now,
      currentSnapshot: () => ({ version: snapshotVersion, immutable: true }),
      loadRecoveryFrame: async () => latestFrame,
      cleanupPath: async (path) => {
        await rm(join(vaultPath, ...path.split("/")), { force: true });
      },
      induceStaleObservationsThenFresh: async () => {
        const path = join(vaultPath, ...CREATE_NOTE_PATH.split("/"));
        await writeFile(path, "# Foreign cache observation 你好 🚀\n", "utf8");
        expect(await readFile(path, "utf8")).toBe("# Foreign cache observation 你好 🚀\n");
        control.recordMetadataCacheObservation({
          path: CREATE_NOTE_PATH,
          contentVersion: "sha256:7a30e1be393dd458c316cf18312475986671d3d89199480f7f00143d5a385b4f",
        });
        control.recordSearchSnapshotBarrierRound({
          targets: [{
            path: CREATE_NOTE_PATH,
            expectedContentVersion:
              "sha256:a36f88ca2067ed0fd114674d7d142a15a4575b837b1bdd0155daa26e7a5ea3df",
            observedContentVersion:
              "sha256:7a30e1be393dd458c316cf18312475986671d3d89199480f7f00143d5a385b4f",
            matched: false,
          }],
          matched: false,
        });
        control.recordMetadataCacheObservation({
          path: CREATE_NOTE_PATH,
        });
        control.recordSearchSnapshotBarrierRound({
          targets: [{
            path: CREATE_NOTE_PATH,
            expectedContentVersion:
              "sha256:a36f88ca2067ed0fd114674d7d142a15a4575b837b1bdd0155daa26e7a5ea3df",
            matched: false,
          }],
          matched: false,
        });
        await writeFile(path, CREATE_NOTE_CONTENT, "utf8");
        control.recordMetadataCacheObservation({
          path: CREATE_NOTE_PATH,
          contentVersion:
            "sha256:a36f88ca2067ed0fd114674d7d142a15a4575b837b1bdd0155daa26e7a5ea3df",
        });
        control.recordSearchSnapshotBarrierRound({
          targets: [{
            path: CREATE_NOTE_PATH,
            expectedContentVersion:
              "sha256:a36f88ca2067ed0fd114674d7d142a15a4575b837b1bdd0155daa26e7a5ea3df",
            observedContentVersion:
              "sha256:a36f88ca2067ed0fd114674d7d142a15a4575b837b1bdd0155daa26e7a5ea3df",
            matched: true,
          }],
          matched: true,
        });
        now = 250;
        snapshotVersion = 2;
        control.recordSearchSnapshotPublication({ version: 2, immutable: true });
        latestFrame = {
          phase: "COMMITTED",
          input: { submissionKey },
        };
        control.recordRecoveryFrame(latestFrame);
        resolveSubmit({ proofState: "intent_applied" });
      },
      wire: {
        async submit({ input }) {
          submissionKey = input.submissionKey;
          const path = join(vaultPath, ...CREATE_NOTE_PATH.split("/"));
          await mkdir(join(path, ".."), { recursive: true });
          await writeFile(path, CREATE_NOTE_CONTENT, "utf8");
          control.recordVaultEvent({ kind: "create", path: CREATE_NOTE_PATH });
          return submitted;
        },
        async status() {
          return { proofState: "intent_applied" };
        },
      },
    });

    const summary = await control.execute({
      descriptor: {} as never,
      scenario: "create_note/stale_observations_then_fresh",
      expectedVaultId: "vault-123",
      endpoint: new URL("http://127.0.0.1:32123/mcp"),
    });

    expect(summary).toMatchObject({
      scenario: "create_note/stale_observations_then_fresh",
      proofState: "intent_applied",
      acceptedSnapshotRounds: 1,
      rejectedSnapshotRounds: 2,
    });
    expect(
      await readFile(join(vaultPath, ...CREATE_NOTE_PATH.split("/")), "utf8").catch(
        (error: NodeJS.ErrnoException) => error.code,
      ),
    ).toBe("ENOENT");
  });

  it("records real quiet-window resets before installed convergence", async () => {
    const vaultPath = await mkdtemp(join(tmpdir(), "installed-semantic-evidence-"));
    cleanups.push(() => rm(vaultPath, { recursive: true, force: true }));
    let now = 0;
    let snapshotVersion = 1;
    let submissionKey = "";
    let resolveSubmit!: (value: { proofState: "intent_applied" }) => void;
    const submitted = new Promise<{ proofState: "intent_applied" }>((resolve) => {
      resolveSubmit = resolve;
    });
    let latestFrame: {
      readonly phase: "COMMITTED";
      readonly input: { readonly submissionKey: string };
    } | null = null;
    let control!: ReturnType<typeof createInstalledSemanticEvidenceScenarioControl>;
    control = createInstalledSemanticEvidenceScenarioControl({
      vaultPath,
      now: () => now,
      currentSnapshot: () => ({ version: snapshotVersion, immutable: true }),
      loadRecoveryFrame: async () => latestFrame,
      cleanupPath: async (path) => {
        await rm(join(vaultPath, ...path.split("/")), { force: true });
      },
      induceQuietWindowResets: async () => {
        control.recordSearchSnapshotRefresh({ reset: true });
        control.recordSearchSnapshotRefresh({ reset: true });
        now = 250;
        snapshotVersion = 2;
        control.recordSearchSnapshotPublication({ version: 2, immutable: true });
        latestFrame = {
          phase: "COMMITTED",
          input: { submissionKey },
        };
        control.recordRecoveryFrame(latestFrame);
        resolveSubmit({ proofState: "intent_applied" });
      },
      wire: {
        async submit({ input }) {
          submissionKey = input.submissionKey;
          const path = join(vaultPath, ...CREATE_NOTE_PATH.split("/"));
          await mkdir(join(path, ".."), { recursive: true });
          await writeFile(path, CREATE_NOTE_CONTENT, "utf8");
          control.recordVaultEvent({ kind: "create", path: CREATE_NOTE_PATH });
          control.recordMetadataCacheObservation({ path: CREATE_NOTE_PATH });
          return submitted;
        },
        async status() {
          return { proofState: "intent_applied" };
        },
      },
    });

    const summary = await control.execute({
      descriptor: {} as never,
      scenario: "create_note/quiet_window_reset",
      expectedVaultId: "vault-123",
      endpoint: new URL("http://127.0.0.1:32123/mcp"),
    });

    expect(summary).toMatchObject({
      scenario: "create_note/quiet_window_reset",
      quietWindowResets: 2,
      acceptedSnapshotRounds: 1,
      rejectedSnapshotRounds: 0,
      proofState: "intent_applied",
    });
  });

  it("derives clean convergence from installed chronology and cleans its fixture", async () => {
    const vaultPath = await mkdtemp(join(tmpdir(), "installed-semantic-evidence-"));
    cleanups.push(() => rm(vaultPath, { recursive: true, force: true }));
    await writeFile(join(vaultPath, "Seed.md"), "# Seed\n", "utf8");
    let snapshotVersion = 1;
    let now = 0;
    let latestFrame: {
      readonly phase: "COMMITTED";
      readonly input: { readonly submissionKey: string };
    } | null = null;
    let submittedBeforeSnapshot = false;
    let statusBeforeCommitted = false;
    let submissionKey = "";
    let resolvedSubmit = false;
    let resolveSubmit!: (value: { proofState: "intent_applied" }) => void;
    const submitted = new Promise<{ proofState: "intent_applied" }>((resolve) => {
      resolveSubmit = resolve;
    });
    let control!: ReturnType<typeof createInstalledSemanticEvidenceScenarioControl>;
    control = createInstalledSemanticEvidenceScenarioControl({
      vaultPath,
      now: () => now,
      currentSnapshot: () => ({ version: snapshotVersion, immutable: true }),
      loadRecoveryFrame: async () => latestFrame,
      cleanupPath: async (path) => {
        await rm(join(vaultPath, ...path.split("/")), { force: true });
      },
      wire: {
        async submit({ input }) {
          const path = join(vaultPath, ...CREATE_NOTE_PATH.split("/"));
          await mkdir(join(path, ".."), { recursive: true });
          await writeFile(path, CREATE_NOTE_CONTENT, "utf8");
          control.recordVaultEvent({ kind: "create", path: CREATE_NOTE_PATH });
          control.recordMetadataCacheObservation({ path: CREATE_NOTE_PATH });
          submissionKey = input.submissionKey;
          submittedBeforeSnapshot = true;
          return submitted;
        },
        async status() {
          statusBeforeCommitted = !resolvedSubmit;
          return { proofState: "intent_applied" };
        },
      },
    });

    const execution = control.execute({
      descriptor: {} as never,
      scenario: "create_note/clean_convergence",
      expectedVaultId: "vault-123",
      endpoint: new URL("http://127.0.0.1:32123/mcp"),
    });
    await expect.poll(() => submittedBeforeSnapshot).toBe(true);
    now = 250;
    snapshotVersion = 2;
    control.recordSearchSnapshotPublication({ version: 2, immutable: true });
    latestFrame = {
      phase: "COMMITTED",
      input: { submissionKey },
    };
    control.recordRecoveryFrame(latestFrame);
    resolvedSubmit = true;
    resolveSubmit({ proofState: "intent_applied" });
    const summary = await execution;

    expect(statusBeforeCommitted).toBe(false);
    expect(summary).toMatchObject({
      scenario: "create_note/clean_convergence",
      source: "installed-obsidian",
      mutationKind: "create_note",
      proofState: "intent_applied",
      statusProofState: "intent_applied",
      journalPhase: "COMMITTED",
      evidenceDeadlineMs: 5_000,
      successBarrierDeadlineMs: 5_000,
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
      cleanupSucceeded: true,
    });
    expect(summary.beforeInventorySha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(summary.afterInventorySha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(summary.afterInventorySha256).not.toBe(summary.beforeInventorySha256);
    await expect(
      readFile(join(vaultPath, ...CREATE_NOTE_PATH.split("/")), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("installed Semantic Evidence wire transport", () => {
  it("uses Node loopback HTTP rather than the renderer fetch boundary", async () => {
    const { createBridgeInstance } = await import("../src/index.js");
    const { createInstalledSemanticEvidenceWire } = await import("../src/installed-runtime/installed-semantic-evidence.js");
    const bridge = createBridgeInstance({ port: 0, health: {
      vault: { id: "wire-proof", name: "Generated", path: "/tmp/generated" },
      readiness: { searchSnapshot: "ready", cache: "ready", index: "ready" },
      recovery: { state: "none" },
      write: { gate: "open", state: "writable", pauseSource: null },
      queue: { currentExecutionId: null, length: 0, headChangeSetId: null },
      lifecycle: { startup: "ready", upgrade: "not_run", migration: "not_run", recovery: "not_run" },
      effectiveGate: null, overall: "healthy", reasonCodes: [], operatorAction: "none",
    }, changeSets: {
      store: { load: async () => undefined, save: async () => undefined },
      dataSource: { readBinary: async () => null, pathKind: async () => null, isContained: async () => false },
      vaultId: "wire-proof",
    } });
    await bridge.start();
    const original = globalThis.fetch;
    globalThis.fetch = async () => { throw new Error("Renderer fetch is unavailable"); };
    try {
      await expect(createInstalledSemanticEvidenceWire().health({
        endpoint: bridge.endpoint, expectedVaultId: "wire-proof",
      })).resolves.toMatchObject({ recoveryBlocked: false, writesBlocked: false });
      await expect(createInstalledSemanticEvidenceWire().submit({
        endpoint: bridge.endpoint, expectedVaultId: "wire-proof",
        input: { submissionKey: "rejected-proof", operations: [{
          operationId: "create", kind: "create_note", path: "Proof.md", content: "# Proof\n", ifExists: "reject",
        }] },
      })).resolves.toEqual({ proofState: "intent_not_applied" });
    } finally { globalThis.fetch = original; await bridge.stop(); }
  });
});
