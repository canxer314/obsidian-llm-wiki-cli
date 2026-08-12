import { describe, expect, it } from "vitest";

import {
  parseContinueInput,
  parseContinueResult,
  parseReadToolResult,
  serializeContinueCompatibilityText,
} from "../src/index.js";

const version = `sha256:${"a".repeat(64)}`;

describe("vault_continue contract", () => {
  it("accepts only one opaque continuation token", () => {
    const input = { continuation: "opaque-token" };

    expect(parseContinueInput(input)).toEqual(input);
    expect(() => parseContinueInput({ continuation: "" })).toThrow();
    expect(() => parseContinueInput({ ...input, path: "note.md" })).toThrow();
  });

  it("accepts continuation pages as vault_read transport output", () => {
    const firstPage = {
      outcome: "page",
      items: [
        {
          index: 0,
          item: {
            outcome: "satisfied",
            result: {
              kind: "metadata",
              index: 0,
              path: "note.md",
              contentVersion: version,
              sizeBytes: 13,
              frontmatter: { status: "ready" },
            },
          },
        },
        {
          index: 1,
          kind: "exact",
          path: "note.md",
          contentVersion: version,
          sizeBytes: 13,
          start: 0,
          end: 4,
          content: "😀",
          complete: false,
        },
      ],
      continuation: "replacement-token",
      complete: false,
    };

    expect(parseReadToolResult(firstPage)).toEqual(firstPage);
    expect(parseReadToolResult({ code: "continuation_unavailable" })).toEqual({
      code: "continuation_unavailable",
    });
  });

  it("carries oversized non-content items as contiguous canonical JSON bytes", () => {
    const item = {
      outcome: "satisfied",
      result: {
        kind: "metadata",
        index: 0,
        path: "note.md",
        contentVersion: version,
        sizeBytes: 1,
        frontmatter: { large: "界" },
      },
    };
    const content = JSON.stringify(item);
    const sizeBytes = new TextEncoder().encode(content).byteLength;
    const result = {
      outcome: "page",
      items: [
        {
          kind: "item",
          index: 0,
          sizeBytes,
          start: 0,
          end: sizeBytes,
          content,
          complete: true,
        },
      ],
      continuation: null,
      complete: true,
    };

    expect(parseContinueResult(result)).toEqual(result);
    expect(JSON.parse(result.items[0].content)).toEqual(item);
  });

  it("carries exact contiguous UTF-8 byte ranges with replacement state", () => {
    const result = {
      outcome: "page",
      items: [
        {
          index: 0,
          kind: "exact",
          path: "重复.md",
          contentVersion: version,
          sizeBytes: 13,
          start: 0,
          end: 13,
          content: "﻿正文😀",
          complete: false,
        },
      ],
      continuation: "replacement-token",
      complete: false,
    };

    expect(parseContinueResult(result)).toEqual(result);
    expect(JSON.parse(serializeContinueCompatibilityText(result))).toEqual(result);
  });

  it("requires final pages to omit a replacement token", () => {
    const finalPage = {
      outcome: "page",
      items: [
        {
          index: 2,
          kind: "exact",
          path: "note.md",
          contentVersion: version,
          sizeBytes: 5,
          start: 4,
          end: 5,
          content: "x",
          complete: true,
        },
      ],
      continuation: null,
      complete: true,
    };

    expect(parseContinueResult(finalPage)).toEqual(finalPage);
    expect(() =>
      parseContinueResult({ ...finalPage, continuation: "impossible" }),
    ).toThrow();
    expect(() =>
      parseContinueResult({ ...finalPage, complete: false }),
    ).toThrow();
  });

  it("normalizes every token failure to the trusted unavailable result", () => {
    const unavailable = { code: "continuation_unavailable" };

    expect(parseContinueResult(unavailable)).toEqual(unavailable);
    expect(() =>
      parseContinueResult({ code: "continuation_expired" }),
    ).toThrow();
    expect(() =>
      parseContinueResult({ ...unavailable, reason: "wrong_client" }),
    ).toThrow();
  });

  it("accepts content-blocking operational gates without frozen evidence", () => {
    expect(
      parseContinueResult({
        outcome: "operationally_blocked",
        gate: { code: "recovery_blocked" },
      }),
    ).toEqual({
      outcome: "operationally_blocked",
      gate: { code: "recovery_blocked" },
    });
  });
});
