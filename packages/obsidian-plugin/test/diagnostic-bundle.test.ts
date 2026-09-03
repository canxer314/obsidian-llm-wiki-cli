import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  STANDARD_DIAGNOSTIC_BUNDLE_SCHEMA_VERSION,
  STANDARD_DIAGNOSTIC_BUNDLE_VERSION,
  canonicalizeDiagnosticPayload,
  createStandardDiagnosticBundle,
  verifyStandardDiagnosticBundle,
  type StandardDiagnosticBundle,
  type StandardDiagnosticEvidence,
} from "../src/diagnostic-bundle.js";
import type { RecoveryJournalDiagnosticFacts } from "../src/recovery-journal.js";

const SENTINEL_VAULT_ID = "vault-secret-6f9f8e7d6c5b4a39281706";
const SENTINEL_CHANGE_SET_ID = "change-set-secret-note-body-c4a5";
const SENTINEL_SUBMISSION_KEY = "submission-key-super-secret-raw-value";
const SENTINEL_ABSOLUTE_PATH = "C:/Users/primary/Vault/Notes/Private.md";
const SENTINEL_USERNAME = "primary-operator";
const SENTINEL_ENV = "OBSIDIAN_VAULT_SECRET_TOKEN=do-not-leak";

function baseEvidence(overrides: Partial<StandardDiagnosticEvidence> = {}): StandardDiagnosticEvidence {
  return {
    vaultId: SENTINEL_VAULT_ID,
    versions: {
      bridge: "0.1.0",
      plugin: "0.1.0",
      protocol: "1.0",
      persistentStateSchema: 2,
      recoveryJournalSchema: 3,
    },
    health: {
      readiness: { searchSnapshot: "ready", cache: "ready", index: "ready" },
      recovery: "none",
      write: { gate: "open", state: "writable", pauseSource: null },
      effectiveGate: null,
      overall: "healthy",
      reasonCodes: [],
      operatorAction: "none",
    },
    listener: { address: "127.0.0.1", port: 27123 },
    queue: { currentExecutionId: null, length: 0, headChangeSetId: null },
    lifecycle: {
      startup: "ready",
      upgrade: "not_run",
      migration: "not_run",
      recovery: "not_run",
    },
    journal: { availability: "unavailable", frames: [] },
    changeSets: [],
    machineEvents: [],
    ...overrides,
  };
}

function availableJournalFacts(changeSetId: string): RecoveryJournalDiagnosticFacts {
  return {
    availability: "available",
    journalVersion: 1,
    headerChecksum: "valid",
    frames: [
      { slot: 0, state: "empty", checksum: "not_present" },
      {
        slot: 1,
        state: "valid",
        checksum: "valid",
        sequence: 1,
        phase: "COMMITTED",
        frameSchemaVersion: 3,
        changeSetId,
      },
    ],
  };
}

describe("standard diagnostic bundle", () => {
  it("emits a fixed versioned structure with a verifiable checksum", () => {
    const bundle = createStandardDiagnosticBundle(baseEvidence());
    expect(bundle.schemaVersion).toBe(STANDARD_DIAGNOSTIC_BUNDLE_SCHEMA_VERSION);
    expect(bundle.bundleVersion).toBe(STANDARD_DIAGNOSTIC_BUNDLE_VERSION);
    expect(bundle.checksum.algorithm).toBe("sha256");
    expect(bundle.checksum.canonicalPayload).toMatch(/^sha256:[0-9a-f]{64}$/u);
    const { checksum, ...content } = bundle;
    const expected = `sha256:${createHash("sha256")
      .update(canonicalizeDiagnosticPayload(content))
      .digest("hex")}`;
    expect(checksum.canonicalPayload).toBe(expected);
    expect(verifyStandardDiagnosticBundle(bundle)).toBe(true);
  });

  it("fails closed on unknown or content-bearing evidence fields", () => {
    const withNoteBodies = {
      ...baseEvidence(),
      noteBodies: ["# Private", "body text must never enter"],
    } as unknown;
    expect(() => createStandardDiagnosticBundle(withNoteBodies)).toThrow(TypeError);

    const withAbsolutePath = {
      ...baseEvidence(),
      vault: { path: SENTINEL_ABSOLUTE_PATH, name: "Alpha" },
    } as unknown;
    expect(() => createStandardDiagnosticBundle(withAbsolutePath)).toThrow(TypeError);

    const withCompleteRequest = {
      ...baseEvidence(),
      changeSets: [
        {
          changeSetId: SENTINEL_CHANGE_SET_ID,
          submissionKey: SENTINEL_SUBMISSION_KEY,
          enqueueSeq: 1,
          state: "intent_applied",
          executionPhase: "terminal",
          operations: [{ operationId: "op-1", kind: "create_note", path: "A.md" }],
        },
      ],
    } as unknown;
    expect(() => createStandardDiagnosticBundle(withCompleteRequest)).toThrow(TypeError);
  });

  it("fails closed when machine or health evidence is not closed machine data", () => {
    const unknownReasonCode = {
      ...baseEvidence(),
      health: {
        ...baseEvidence().health,
        reasonCodes: ["credential_snapshot_present"],
      },
    } as unknown;
    expect(() => createStandardDiagnosticBundle(unknownReasonCode)).toThrow(TypeError);

    const stackWithPath = {
      ...baseEvidence(),
      machineEvents: [
        {
          sequence: 1,
          code: "writes_paused",
          stackSymbols: ["Runtime.execute", SENTINEL_ABSOLUTE_PATH],
        },
      ],
    } as unknown;
    expect(() => createStandardDiagnosticBundle(stackWithPath)).toThrow(TypeError);

    const stackWithVaultRelativePath = {
      ...baseEvidence(),
      machineEvents: [
        {
          sequence: 1,
          code: "writes_paused",
          stackSymbols: ["Vault/Notes/Private.md"],
        },
      ],
    } as unknown;
    expect(() => createStandardDiagnosticBundle(stackWithVaultRelativePath)).toThrow(TypeError);
  });

  it("fails closed when versions are not recognized semantic versions", () => {
    const withContentBearingVersion = {
      ...baseEvidence(),
      versions: {
        ...baseEvidence().versions,
        plugin: "Private.md\nwhole note body must never enter diagnostics",
      },
    } as unknown;
    expect(() => createStandardDiagnosticBundle(withContentBearingVersion)).toThrow(TypeError);
  });

  it("never emits raw identifiers, keys, credentials, paths, usernames, or environment", () => {
    const evidence = baseEvidence({
      queue: {
        currentExecutionId: SENTINEL_CHANGE_SET_ID,
        length: 1,
        headChangeSetId: SENTINEL_CHANGE_SET_ID,
      },
      journal: availableJournalFacts(SENTINEL_CHANGE_SET_ID),
      changeSets: [
        {
          changeSetId: SENTINEL_CHANGE_SET_ID,
          submissionKey: SENTINEL_SUBMISSION_KEY,
          enqueueSeq: 1,
          state: "intent_applied",
          executionPhase: "terminal",
        },
      ],
    });
    const bundle = createStandardDiagnosticBundle(evidence);
    const text = JSON.stringify(bundle);

    for (const sentinel of [
      SENTINEL_VAULT_ID,
      SENTINEL_CHANGE_SET_ID,
      SENTINEL_SUBMISSION_KEY,
      SENTINEL_ABSOLUTE_PATH,
      SENTINEL_USERNAME,
      SENTINEL_ENV,
    ]) {
      expect(text).not.toContain(sentinel);
    }

    const aliases = [
      bundle.vault.alias,
      bundle.changeSetOutcomes[0]!.changeSetAlias,
      bundle.queueTimeline[0]!.currentExecutionAlias!,
    ];
    expect(new Set(aliases).size).toBe(2); // vault alias differs from the change-set alias
    expect(aliases[0]).toMatch(/^vault_[0-9a-f]{32}$/u);
    expect(aliases[1]).toMatch(/^change_set_[0-9a-f]{32}$/u);
    expect(bundle.changeSetOutcomes[0]!.submissionKeyDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(bundle.changeSetOutcomes[0]!.submissionKeyDigest).not.toContain(SENTINEL_SUBMISSION_KEY);
  });

  it("correlates equal identifiers within one bundle through stable aliases", () => {
    const evidence = baseEvidence({
      queue: {
        currentExecutionId: SENTINEL_CHANGE_SET_ID,
        length: 1,
        headChangeSetId: SENTINEL_CHANGE_SET_ID,
      },
      journal: availableJournalFacts(SENTINEL_CHANGE_SET_ID),
      changeSets: [
        {
          changeSetId: SENTINEL_CHANGE_SET_ID,
          submissionKey: SENTINEL_SUBMISSION_KEY,
          enqueueSeq: 1,
          state: "intent_applied",
          executionPhase: "terminal",
        },
      ],
    });
    const bundle = createStandardDiagnosticBundle(evidence);
    const expected = bundle.changeSetOutcomes[0]!.changeSetAlias;
    expect(expected).toMatch(/^change_set_[0-9a-f]{32}$/u);
    expect(bundle.journal.availability).toBe("available");
    if (bundle.journal.availability === "available") {
      const frame = bundle.journal.frames.find((candidate) => candidate.state === "valid");
      expect(frame).toBeDefined();
      if (frame !== undefined && frame.state === "valid") {
        expect(frame.changeSetAlias).toBe(expected);
      }
    }
    expect(bundle.queueTimeline[0]!.currentExecutionAlias).toBe(expected);
    expect(bundle.queueTimeline[0]!.headChangeSetAlias).toBe(expected);
  });

  it("digests Submission Keys irreversibly and never correlates across bundles", () => {
    const evidence = baseEvidence({
      changeSets: [
        {
          changeSetId: SENTINEL_CHANGE_SET_ID,
          submissionKey: SENTINEL_SUBMISSION_KEY,
          enqueueSeq: 1,
          state: "intent_applied",
          executionPhase: "terminal",
        },
      ],
    });
    const first = createStandardDiagnosticBundle(evidence);
    const second = createStandardDiagnosticBundle(evidence);
    expect(first.changeSetOutcomes[0]!.submissionKeyDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);
    // Per-bundle salt means the same raw value produces distinct aliases and
    // digests, so no cross-bundle correlation is introduced.
    expect(first.changeSetOutcomes[0]!.changeSetAlias).not.toBe(
      second.changeSetOutcomes[0]!.changeSetAlias,
    );
    expect(first.vault.alias).not.toBe(second.vault.alias);
    expect(first.changeSetOutcomes[0]!.submissionKeyDigest).not.toBe(
      second.changeSetOutcomes[0]!.submissionKeyDigest,
    );
    expect(verifyStandardDiagnosticBundle(first)).toBe(true);
    expect(verifyStandardDiagnosticBundle(second)).toBe(true);
  });

  it("rejects tampered or structurally invalid copied bundles", () => {
    const bundle = createStandardDiagnosticBundle(baseEvidence());
    const tamperedOverall: StandardDiagnosticBundle = structuredClone(bundle);
    tamperedOverall.health.overall = "blocked";
    expect(verifyStandardDiagnosticBundle(tamperedOverall)).toBe(false);

    const tamperedAlias: StandardDiagnosticBundle = structuredClone(bundle);
    tamperedAlias.vault.alias = "vault_00000000000000000000000000000000";
    expect(verifyStandardDiagnosticBundle(tamperedAlias)).toBe(false);

    const withExtraRawField = structuredClone(bundle) as StandardDiagnosticBundle & {
      noteBodies: string[];
    };
    withExtraRawField.noteBodies = [SENTINEL_ABSOLUTE_PATH];
    expect(verifyStandardDiagnosticBundle(withExtraRawField)).toBe(false);

    const { checksum: _checksum, ...withoutChecksum } = bundle;
    expect(verifyStandardDiagnosticBundle(withoutChecksum)).toBe(false);
  });

  it("accepts path-free machine stack symbols and rejects absent journal state when unavailable", () => {
    const evidence = baseEvidence({
      machineEvents: [
        { sequence: 1, code: "writes_paused", stackSymbols: ["MutationQueue#drain", "Runtime.execute"] },
        {
          sequence: 2,
          code: "content_tools_not_ready",
          stackSymbols: ["SearchSnapshotManager.rebuild", "Namespace.build"],
        },
      ],
    });
    const bundle = createStandardDiagnosticBundle(evidence);
    expect(bundle.machineEvents).toHaveLength(2);
    expect(bundle.journal).toEqual({ availability: "unavailable", frames: [] });
    expect(verifyStandardDiagnosticBundle(bundle)).toBe(true);
  });
});
