import { describe, expect, it } from "vitest";

import {
  createChangeSetStatusInputJsonSchema,
  parseChangeSetStatusInput,
  parseChangeSetStatusResult,
  parseChangeSetSubmitInput,
  parseChangeSetSubmitResult,
} from "../src/index.js";

const VERSION = `sha256:${"a".repeat(64)}`;

function validSubmit() {
  return {
    submissionKey: "session-1-change-1",
    operations: [
      {
        operationId: "edit-1",
        kind: "edit_body",
        path: "Notes/A.md",
        targetVersion: VERSION,
        edit: {
          kind: "replace_exact",
          old: "old",
          replacement: "new",
          expectedOccurrences: 1,
        },
      },
    ],
    readDependencies: [{ path: "Notes/Context.md", contentVersion: VERSION }],
  };
}

describe("vault_change_set_submit v1 contract", () => {
  it("accepts a strict canonical intent and rejects ambiguous identity or dependency overlap", () => {
    expect(parseChangeSetSubmitInput(validSubmit())).toEqual(validSubmit());
    expect(() =>
      parseChangeSetSubmitInput({ ...validSubmit(), unexpected: true }),
    ).toThrow();
    expect(() =>
      parseChangeSetSubmitInput({
        ...validSubmit(),
        operations: [validSubmit().operations[0], validSubmit().operations[0]],
      }),
    ).toThrow();
    expect(() =>
      parseChangeSetSubmitInput({
        ...validSubmit(),
        readDependencies: [{ path: "Notes/A.md", contentVersion: VERSION }],
      }),
    ).toThrow();
  });

  it("keeps Markdown and attachment trash evidence distinct", () => {
    const attachmentTrash = {
      submissionKey: "trash-attachment-key",
      operations: [{
        operationId: "trash-attachment",
        kind: "trash",
        path: "assets/image.bin",
        expectedSha256: "b".repeat(64),
      }],
    };

    expect(parseChangeSetSubmitInput(attachmentTrash)).toEqual(attachmentTrash);
    expect(() => parseChangeSetSubmitInput({
      ...attachmentTrash,
      operations: [{
        ...attachmentTrash.operations[0],
        targetVersion: VERSION,
      }],
    })).toThrow();
  });

  it("accepts registered, conflict, and preflight rejection results without generic errors", () => {
    expect(
      parseChangeSetSubmitResult({
        outcome: "registered",
        changeSet: {
          changeSetId: "change-set-1",
          state: "intent_not_applied",
          failure: {
            code: "exact_match_count_mismatch",
            operationId: "edit-1",
            actualOccurrences: 2,
          },
        },
        vault: { writeGate: "open", writeState: "writable" },
      }),
    ).toMatchObject({ outcome: "registered" });
    expect(
      parseChangeSetSubmitResult({ outcome: "submission_key_conflict" }),
    ).toEqual({ outcome: "submission_key_conflict" });
    expect(() =>
      parseChangeSetSubmitResult({
        outcome: "submission_key_conflict",
        message: "different request",
      }),
    ).toThrow();
  });
});

describe("vault_change_set_status v1 contract", () => {
  it("requires exactly one lookup identity and trusts found, unknown, and expired", () => {
    expect(parseChangeSetStatusInput({ submissionKey: "submission-1" })).toEqual({
      submissionKey: "submission-1",
    });
    expect(parseChangeSetStatusInput({ changeSetId: "change-set-1" })).toEqual({
      changeSetId: "change-set-1",
    });
    expect(() => parseChangeSetStatusInput({})).toThrow();
    expect(() =>
      parseChangeSetStatusInput({
        submissionKey: "submission-1",
        changeSetId: "change-set-1",
      }),
    ).toThrow();

    expect(createChangeSetStatusInputJsonSchema()).toMatchObject({
      oneOf: [
        { required: ["submissionKey"], additionalProperties: false },
        { required: ["changeSetId"], additionalProperties: false },
      ],
    });

    for (const lookup of ["unknown", "expired"] as const) {
      expect(
        parseChangeSetStatusResult({
          lookup,
          vault: { writeGate: "open", writeState: "writable" },
        }),
      ).toMatchObject({ lookup });
    }
  });
});
