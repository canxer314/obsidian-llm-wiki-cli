import { describe, expect, it } from "vitest";

import {
  parseReadInput,
  parseReadResult,
  serializeReadCompatibilityText,
} from "../src/index.js";

const version = `sha256:${"a".repeat(64)}`;

describe("vault_read contract", () => {
  it("accepts ordered heterogeneous requests and preserves duplicate paths", () => {
    const input = {
      items: [
        { kind: "metadata", path: "重复.md" },
        { kind: "outline", path: "重复.md" },
        {
          kind: "section",
          path: "重复.md",
          hierarchy: ["父级", "子级"],
          occurrence: 2,
        },
        { kind: "exact", path: "重复.md" },
      ],
    };

    expect(parseReadInput(input)).toEqual(input);
  });

  it("rejects NUL characters in Markdown paths", () => {
    expect(() =>
      parseReadInput({
        items: [{ kind: "exact", path: "Notes/a\0.md" }],
      }),
    ).toThrow();
  });

  it("requires a complete non-empty hierarchy and one-based section occurrence", () => {
    expect(() =>
      parseReadInput({
        items: [{ kind: "section", path: "note.md", hierarchy: [], occurrence: 1 }],
      }),
    ).toThrow();
    expect(() =>
      parseReadInput({
        items: [
          { kind: "section", path: "note.md", hierarchy: ["Heading"], occurrence: 0 },
        ],
      }),
    ).toThrow();
  });

  it("accepts satisfied and closed unsatisfied item branches in request order", () => {
    const result = {
      outcome: "items",
      items: [
        {
          outcome: "satisfied",
          result: {
            kind: "metadata",
            index: 0,
            path: "note.md",
            contentVersion: version,
            sizeBytes: 12,
            frontmatter: { status: "ready", count: 2 },
          },
        },
        { outcome: "not_satisfied" },
        { outcome: "note_exceeds_exact_read_limit" },
        {
          outcome: "satisfied",
          result: {
            kind: "exact",
            index: 3,
            path: "note.md",
            contentVersion: version,
            sizeBytes: 12,
            content: "﻿正文\r\n😀",
          },
        },
      ],
    };

    expect(parseReadResult(result)).toEqual(result);
    expect(JSON.parse(serializeReadCompatibilityText(result))).toEqual(result);
  });

  it("accepts deterministic complete contiguous grouping suggestions", () => {
    const result = {
      outcome: "grouping_required",
      suggestedGroups: [
        { startIndex: 0, endIndexExclusive: 2, exactReadBytes: 900_000 },
        { startIndex: 2, endIndexExclusive: 4, exactReadBytes: 800_000 },
      ],
    };

    expect(parseReadResult(result)).toEqual(result);
  });

  it("accepts closed operational blocks without content evidence", () => {
    expect(
      parseReadResult({
        outcome: "operationally_blocked",
        gate: { code: "recovery_in_progress" },
      }),
    ).toEqual({
      outcome: "operationally_blocked",
      gate: { code: "recovery_in_progress" },
    });
  });

  it("rejects non-canonical Content Versions and unknown root fields", () => {
    const exact = (contentVersion: string) => ({
      outcome: "items",
      items: [
        {
          outcome: "satisfied",
          result: {
            kind: "exact",
            index: 0,
            path: "note.md",
            contentVersion,
            sizeBytes: 1,
            content: "x",
          },
        },
      ],
    });

    expect(() => parseReadResult(exact("a".repeat(64)))).toThrow();
    expect(() => parseReadResult(exact(`sha256:${"A".repeat(64)}`))).toThrow();
    expect(() => parseReadResult({ ...exact(version), extra: true })).toThrow();
  });
});
