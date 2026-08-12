import { Buffer } from "node:buffer";

import { describe, expect, it } from "vitest";

import {
  MAXIMUM_COMPACT_RESPONSE_BYTES,
  createVaultContinuationStore,
} from "../src/vault-continuation.js";

const version = `sha256:${"a".repeat(64)}`;

function frozenRead(contents: string[]) {
  return {
    outcome: "items" as const,
    items: contents.map((content, index) => ({
      outcome: "satisfied" as const,
      result: {
        kind: "exact" as const,
        index,
        path: `note-${index}.md`,
        contentVersion: version,
        sizeBytes: Buffer.byteLength(content, "utf8"),
        content,
      },
    })),
  };
}

describe("vault continuation store", () => {
  it("reconstructs frozen Exact Read bytes through bounded UTF-8 pages", () => {
    const source = [
      `﻿first\r\n${"甲😀".repeat(80_000)}`,
      `second\n${"乙𠮷".repeat(30_000)}`,
    ];
    const store = createVaultContinuationStore({ token: (() => {
      let next = 0;
      return () => `token-${++next}`;
    })() });

    const first = store.issue("client-a", frozenRead(source));
    expect(first.outcome).toBe("page");
    if (first.outcome !== "page") return;

    const pages = [first];
    let continuation = first.continuation;
    while (continuation !== null) {
      const next = store.continue("client-a", continuation);
      expect(next.outcome).toBe("page");
      if (next.outcome !== "page") return;
      pages.push(next);
      continuation = next.continuation;
    }

    for (const page of pages) {
      expect(Buffer.byteLength(JSON.stringify(page), "utf8")).toBeLessThanOrEqual(
        MAXIMUM_COMPACT_RESPONSE_BYTES,
      );
    }

    for (const [index, expected] of source.entries()) {
      const chunks = pages.flatMap((page) =>
        page.items.filter((item) => item.index === index),
      );
      expect(chunks[0]?.start).toBe(0);
      expect(
        chunks.every(
          (chunk, chunkIndex) =>
            chunkIndex === 0 || chunks[chunkIndex - 1]?.end === chunk.start,
        ),
      ).toBe(true);
      expect(Buffer.from(chunks.map((chunk) => chunk.content).join(""), "utf8")).toEqual(
        Buffer.from(expected, "utf8"),
      );
      expect(chunks.at(-1)?.complete).toBe(true);
    }
  });

  it("does not observe mutations after the frozen result is issued", () => {
    const result = frozenRead([`frozen-${"😀".repeat(80_000)}`]);
    let next = 0;
    const store = createVaultContinuationStore({ token: () => `replacement-${++next}` });

    const first = store.issue("client-a", result);
    result.items[0]!.result.content = "mutated";
    if (first.outcome !== "page" || first.continuation === null) {
      throw new Error("fixture must require continuation");
    }

    const second = store.continue("client-a", first.continuation);
    expect(second.outcome).toBe("page");
    if (second.outcome !== "page") return;
    expect(second.items.map((item) => item.content).join("")).not.toContain("mutated");
  });

  it("preserves complete non-content results in heterogeneous request order", () => {
    let next = 0;
    const store = createVaultContinuationStore({ token: () => `token-${++next}` });
    const exactContent = `正文-${"😀".repeat(80_000)}`;
    const result = {
      outcome: "items" as const,
      items: [
        {
          outcome: "satisfied" as const,
          result: {
            kind: "metadata" as const,
            index: 0,
            path: "mixed.md",
            contentVersion: version,
            sizeBytes: Buffer.byteLength(exactContent, "utf8"),
            frontmatter: { status: "ready" },
          },
        },
        { outcome: "not_satisfied" as const },
        frozenRead([exactContent]).items[0]!,
      ],
    };
    result.items[2]!.result.index = 2;
    result.items[2]!.result.path = "mixed.md";

    const pages = [];
    let page = store.issue("client-a", result);
    while (page.outcome === "page") {
      pages.push(page);
      if (page.continuation === null) break;
      page = store.continue("client-a", page.continuation);
    }

    expect(pages[0]?.items.slice(0, 2)).toEqual([
      { index: 0, item: result.items[0] },
      { index: 1, item: result.items[1] },
    ]);
    const exactChunks = pages.flatMap((candidate) =>
      candidate.items.filter((item) => "kind" in item && item.index === 2),
    );
    expect(exactChunks.map((item) => item.content).join("")).toBe(exactContent);
    expect(exactChunks[0]).toMatchObject({ kind: "exact", sizeBytes: 320_007 });
  });

  it("consumes each token exactly once and binds it to one client", () => {
    let next = 0;
    const store = createVaultContinuationStore({ token: () => `token-${++next}` });
    const first = store.issue("client-a", frozenRead(["😀".repeat(80_000)]));
    if (first.outcome !== "page" || first.continuation === null) {
      throw new Error("fixture must require continuation");
    }

    expect(store.continue("client-b", first.continuation)).toEqual({
      code: "continuation_unavailable",
    });
    expect(store.continue("client-a", first.continuation).outcome).toBe("page");
    expect(store.continue("client-a", first.continuation)).toEqual({
      code: "continuation_unavailable",
    });
  });

  it("expires tokens after fifteen minutes and slides from replacement", () => {
    let now = 0;
    let next = 0;
    const store = createVaultContinuationStore({
      now: () => now,
      token: () => `token-${++next}`,
    });
    const first = store.issue("client-a", frozenRead(["😀".repeat(180_000)]));
    if (first.outcome !== "page" || first.continuation === null) {
      throw new Error("fixture must require multiple continuation pages");
    }

    now = 15 * 60_000 - 1;
    const second = store.continue("client-a", first.continuation);
    if (second.outcome !== "page" || second.continuation === null) {
      throw new Error("fixture must require a replacement token");
    }

    now += 15 * 60_000 - 1;
    expect(store.continue("client-a", second.continuation).outcome).toBe("page");

    const expiring = store.issue("client-a", frozenRead(["x".repeat(300_000)]));
    if (expiring.outcome !== "page" || expiring.continuation === null) {
      throw new Error("fixture must require continuation");
    }
    now += 15 * 60_000;
    expect(store.continue("client-a", expiring.continuation)).toEqual({
      code: "continuation_unavailable",
    });
  });

  it("releases delivered prefixes from the retained-byte quota", () => {
    let next = 0;
    const store = createVaultContinuationStore({ token: () => `token-${++next}` });
    const sectionContent = "界".repeat(2_650_000);
    const sectionResult = {
      outcome: "items" as const,
      items: [
        {
          outcome: "satisfied" as const,
          result: {
            kind: "section" as const,
            index: 0,
            path: "section.md",
            contentVersion: version,
            sizeBytes: Buffer.byteLength(sectionContent, "utf8"),
            hierarchy: ["Large"],
            occurrence: 1,
            content: sectionContent,
          },
        },
      ],
    };
    let page = store.issue("client-a", sectionResult);
    expect(page.outcome).toBe("page");

    expect(store.issue("client-a", frozenRead(["x".repeat(1_000_000)]))).toEqual({
      code: "continuation_unavailable",
    });

    for (let index = 0; index < 5; index += 1) {
      if (page.outcome !== "page" || page.continuation === null) {
        throw new Error("fixture must retain enough section bytes");
      }
      page = store.continue("client-a", page.continuation);
    }

    expect(
      store.issue("client-a", frozenRead(["x".repeat(1_000_000)])).outcome,
    ).toBe("page");
  });

  it("rejects a ninth live chain without evicting the existing eight", () => {
    let next = 0;
    const store = createVaultContinuationStore({ token: () => `token-${++next}` });
    const live = Array.from({ length: 8 }, () =>
      store.issue("client-a", frozenRead(["😀".repeat(70_000)])),
    );
    const tokens = live.map((result) => {
      if (result.outcome !== "page" || result.continuation === null) {
        throw new Error("fixture must retain every chain");
      }
      return result.continuation;
    });

    expect(store.issue("client-a", frozenRead(["😀".repeat(70_000)]))).toEqual({
      code: "continuation_unavailable",
    });
    for (const token of tokens) {
      expect(store.continue("client-a", token).outcome).toBe("page");
    }
  });

  it("releases a chain slot immediately when its final page completes", () => {
    let next = 0;
    const store = createVaultContinuationStore({ token: () => `token-${++next}` });
    const live = Array.from({ length: 8 }, () =>
      store.issue("client-a", frozenRead(["x".repeat(300_000)])),
    );
    const first = live[0];
    if (first?.outcome !== "page" || first.continuation === null) {
      throw new Error("fixture must retain a continuation");
    }

    const final = store.continue("client-a", first.continuation);
    expect(final).toMatchObject({ outcome: "page", continuation: null, complete: true });
    expect(
      store.issue("client-a", frozenRead(["x".repeat(300_000)])).outcome,
    ).toBe("page");
  });

  it("releases client capacity immediately on teardown", () => {
    let next = 0;
    const store = createVaultContinuationStore({ token: () => `token-${++next}` });
    const tokens = Array.from({ length: 8 }, () => {
      const result = store.issue("client-a", frozenRead(["x".repeat(300_000)]));
      if (result.outcome !== "page" || result.continuation === null) {
        throw new Error("fixture must retain every chain");
      }
      return result.continuation;
    });

    store.releaseClient("client-a");

    for (const token of tokens) {
      expect(store.continue("client-a", token)).toEqual({
        code: "continuation_unavailable",
      });
    }
    expect(store.issue("client-a", frozenRead(["x".repeat(300_000)])).outcome).toBe(
      "page",
    );
  });
});
