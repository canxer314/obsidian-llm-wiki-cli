import { describe, expect, it } from "vitest";

import {
  parseDiscoverInput,
  parseDiscoverResult,
  serializeDiscoverCompatibilityText,
} from "../src/index.js";

const version = `sha256:${"a".repeat(64)}`;

describe("vault_discover contract", () => {
  it("accepts the closed path, filename, literal, and regex query grammar", () => {
    const input = {
      query: {
        all: [
          { path: { prefix: "Projects/" } },
          { filename: { substring: "Bridge", caseSensitive: false } },
          {
            any: [
              { text: { literal: "Search Snapshot", caseSensitive: true } },
              { text: { regex: "Recovery\\s+Journal", caseSensitive: false } },
            ],
          },
          { not: { path: { exact: "Projects/Archive.md" } } },
        ],
      },
      projection: { matches: true },
      order: { by: "path", direction: "asc" },
      page: { maxItems: 100, continuation: null },
    };

    expect(parseDiscoverInput(input)).toEqual(input);
  });

  it("rejects mixed leaf operators, invalid regex, and unknown fields", () => {
    expect(() =>
      parseDiscoverInput({
        query: { path: { exact: "note.md", prefix: "note" } },
        projection: { matches: false },
        order: { by: "path", direction: "asc" },
        page: { maxItems: 10, continuation: null },
      }),
    ).toThrow();
    expect(() =>
      parseDiscoverInput({
        query: { text: { regex: "[", caseSensitive: true } },
        projection: { matches: true },
        order: { by: "path", direction: "asc" },
        page: { maxItems: 10, continuation: null },
      }),
    ).toThrow();
    expect(() =>
      parseDiscoverInput({
        query: { path: { exact: "note.md" } },
        projection: { matches: true },
        order: { by: "path", direction: "asc" },
        page: { maxItems: 10, continuation: null },
      }),
    ).toThrow();
    expect(() =>
      parseDiscoverInput({
        query: { filename: { exact: "note.md", caseSensitive: true } },
        projection: { matches: false },
        order: { by: "path", direction: "asc" },
        page: { maxItems: 10, continuation: null },
        snapshot: "public-handle",
      }),
    ).toThrow();
  });

  it("accepts deterministic identity and byte-offset match evidence", () => {
    const result = {
      outcome: "results",
      ordering: {
        by: "path",
        direction: "asc",
        tieBreaker: "path_utf8_bytes",
      },
      items: [
        {
          path: "Projects/Bridge.md",
          contentVersion: version,
          sizeBytes: 42,
          matches: [
            {
              line: 2,
              startByte: 10,
              endByteExclusive: 25,
              text: "Search Snapshot",
            },
          ],
        },
      ],
      complete: false,
      continuation: "opaque-result-token",
    };

    expect(parseDiscoverResult(result)).toEqual(result);
    expect(JSON.parse(serializeDiscoverCompatibilityText(result))).toEqual(result);
  });

  it("accepts an ordered empty successful result without a public Snapshot handle", () => {
    const result = {
      outcome: "results",
      ordering: {
        by: "path",
        direction: "asc",
        tieBreaker: "path_utf8_bytes",
      },
      items: [],
      complete: true,
      continuation: null,
    };

    expect(parseDiscoverResult(result)).toEqual(result);
    expect(result).not.toHaveProperty("snapshot");
  });
});
