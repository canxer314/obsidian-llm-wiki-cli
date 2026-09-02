import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  CONTENT_INCLUSIVE_DIAGNOSTIC_BUNDLE_SCHEMA_VERSION,
  CONTENT_INCLUSIVE_DIAGNOSTIC_BUNDLE_VERSION,
  CONTENT_INCLUSIVE_DIAGNOSTIC_PURPOSE,
  canonicalizeContentInclusivePayload,
  createContentInclusiveDiagnosticBundle,
  verifyContentInclusiveDiagnosticBundle,
  type ContentInclusiveDiagnosticBundle,
} from "../src/content-inclusive-diagnostic-bundle.js";
import {
  createStandardDiagnosticBundle,
  verifyStandardDiagnosticBundle,
  type StandardDiagnosticEvidence,
} from "../src/diagnostic-bundle.js";

const SENTINEL_VAULT_ID = "vault-secret-6f9f8e7d6c5b4a39281706";
const SENTINEL_CHANGE_SET_ID = "change-set-secret-note-body-c4a5";
const SENTINEL_SUBMISSION_KEY = "submission-key-super-secret-raw-value";
const SENTINEL_ABSOLUTE_PATH = "C:/Users/primary/Vault/Notes/Private.md";

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

describe("content-inclusive diagnostic bundle", () => {
  it("emits a fixed separate versioned structure with a verifiable checksum", () => {
    const selected = "# Selected heading\nbody line";
    const bundle = createContentInclusiveDiagnosticBundle(baseEvidence(), selected);
    expect(bundle.schemaVersion).toBe(CONTENT_INCLUSIVE_DIAGNOSTIC_BUNDLE_SCHEMA_VERSION);
    expect(bundle.bundleVersion).toBe(CONTENT_INCLUSIVE_DIAGNOSTIC_BUNDLE_VERSION);
    expect(bundle.purpose).toBe(CONTENT_INCLUSIVE_DIAGNOSTIC_PURPOSE);
    expect(bundle.trace.source).toBe("managed_vault_bridge");
    expect(bundle.selection.tracer).toBe("active_editor_selection");
    expect(bundle.selection.content).toBe(selected);
    expect(bundle.checksum.algorithm).toBe("sha256");
    expect(bundle.checksum.canonicalPayload).toMatch(/^sha256:[0-9a-f]{64}$/u);

    const { checksum, ...content } = bundle;
    const expected = `sha256:${createHash("sha256")
      .update(canonicalizeContentInclusivePayload(content))
      .digest("hex")}`;
    expect(checksum.canonicalPayload).toBe(expected);
    expect(verifyContentInclusiveDiagnosticBundle(bundle)).toBe(true);
  });

  it("carries only the selected content plus the minimal version trace", () => {
    const selected = "# Selected heading\nsecond line\n";
    const bundle = createContentInclusiveDiagnosticBundle(
      baseEvidence({
        queue: { currentExecutionId: SENTINEL_CHANGE_SET_ID, length: 1, headChangeSetId: SENTINEL_CHANGE_SET_ID },
        changeSets: [
          {
            changeSetId: SENTINEL_CHANGE_SET_ID,
            submissionKey: SENTINEL_SUBMISSION_KEY,
            enqueueSeq: 1,
            state: "intent_applied",
            executionPhase: "terminal",
          },
        ],
      }),
      selected,
    );
    const text = JSON.stringify(bundle);
    expect(text).toContain("# Selected heading");
    expect(text).toContain("second line");
    expect(text).toContain('"versions"');
    expect(text).not.toContain(SENTINEL_VAULT_ID);
    expect(text).not.toContain(SENTINEL_CHANGE_SET_ID);
    expect(text).not.toContain(SENTINEL_SUBMISSION_KEY);
    expect(text).not.toContain(SENTINEL_ABSOLUTE_PATH);
    for (const absent of [
      "vault",
      "health",
      "listenerTimeline",
      "queueTimeline",
      "lifecycleOutcomes",
      "journal",
      "changeSetOutcomes",
      "machineEvents",
    ]) {
      expect(asRecord(bundle)).not.toHaveProperty(absent);
    }
  });

  it("defensively copies the exact selected bytes with no surrounding note content", () => {
    const wholeNote =
      "unselected first line\n# Selected heading\nchosen body\nunselected last line with secret";
    const selected = "# Selected heading\nchosen body";
    const bundle = createContentInclusiveDiagnosticBundle(baseEvidence(), selected);
    expect(bundle.selection.content).toBe(selected);
    const text = JSON.stringify(bundle);
    expect(text).toContain("# Selected heading");
    expect(text).toContain("chosen body");
    expect(text).not.toContain("unselected first line");
    expect(text).not.toContain("unselected last line with secret");
    expect(verifyContentInclusiveDiagnosticBundle(bundle)).toBe(true);
  });

  it("fails closed on empty or non-string selected content", () => {
    expect(() => createContentInclusiveDiagnosticBundle(baseEvidence(), "")).toThrow(TypeError);
    expect(() =>
      createContentInclusiveDiagnosticBundle(baseEvidence(), "   "),
    ).not.toThrow();
    expect(() =>
      createContentInclusiveDiagnosticBundle(baseEvidence(), 42 as unknown),
    ).toThrow(TypeError);
  });

  it("fails closed on content-bearing or unknown evidence fields via the standard seam", () => {
    const withNoteBodies = {
      ...baseEvidence(),
      noteBodies: ["# Private", "body text must never enter"],
    } as unknown;
    expect(() => createContentInclusiveDiagnosticBundle(withNoteBodies, "selected")).toThrow(
      TypeError,
    );
    const withPath = {
      ...baseEvidence(),
      vault: { path: SENTINEL_ABSOLUTE_PATH },
    } as unknown;
    expect(() => createContentInclusiveDiagnosticBundle(withPath, "selected")).toThrow(TypeError);
  });

  it("is visibly and structurally separate from the standard diagnostic bundle", () => {
    const evidence = baseEvidence();
    const standard = createStandardDiagnosticBundle(evidence);
    const contentInclusive = createContentInclusiveDiagnosticBundle(evidence, "selected");

    // The standard bundle never gains an optional content field.
    expect(verifyStandardDiagnosticBundle(standard)).toBe(true);
    for (const absent of ["purpose", "selection", "content", "trace"]) {
      expect(asRecord(standard)).not.toHaveProperty(absent);
    }

    // Neither format verifies as the other.
    expect(verifyContentInclusiveDiagnosticBundle(standard)).toBe(false);
    expect(verifyStandardDiagnosticBundle(contentInclusive)).toBe(false);
  });

  it("rejects tampered or structurally invalid copied content-inclusive bundles", () => {
    const bundle = createContentInclusiveDiagnosticBundle(baseEvidence(), "selected");
    const tamperedContent: ContentInclusiveDiagnosticBundle = structuredClone(bundle);
    tamperedContent.selection.content = "tampered";
    expect(verifyContentInclusiveDiagnosticBundle(tamperedContent)).toBe(false);

    const tamperedPurpose: ContentInclusiveDiagnosticBundle = structuredClone(bundle);
    tamperedPurpose.purpose = "standard_diagnostic";
    expect(verifyContentInclusiveDiagnosticBundle(tamperedPurpose)).toBe(false);

    const withExtraField = structuredClone(bundle) as ContentInclusiveDiagnosticBundle & {
      content: string;
    };
    withExtraField.content = "extra";
    expect(verifyContentInclusiveDiagnosticBundle(withExtraField)).toBe(false);

    const { checksum: _checksum, ...withoutChecksum } = bundle;
    expect(verifyContentInclusiveDiagnosticBundle(withoutChecksum)).toBe(false);
  });

  it("preserves exact selection bytes including newlines and unicode", () => {
    const selected = "αβγ\n- bullet\n\n\tindented\n日本語\n";
    const bundle = createContentInclusiveDiagnosticBundle(baseEvidence(), selected);
    expect(bundle.selection.content).toBe(selected);
    const parsed = JSON.parse(JSON.stringify(bundle)) as {
      selection: { content: string };
    };
    expect(parsed.selection.content).toBe(selected);
    const text = JSON.stringify(bundle);
    expect(text).toContain("αβγ");
    expect(text).toContain("日本語");
    expect(verifyContentInclusiveDiagnosticBundle(bundle)).toBe(true);
  });
});

function asRecord(bundle: object): Record<string, unknown> {
  return bundle as unknown as Record<string, unknown>;
}
