import { describe, expect, it } from "vitest";

import {
  SearchSnapshotManager,
  type SearchSnapshotDataSource,
} from "../src/index.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function source(files: Map<string, Uint8Array>): SearchSnapshotDataSource {
  return {
    listMarkdownPaths: async () => [...files.keys()],
    readBinary: async (path) => files.get(path) ?? null,
  };
}

describe("Search Snapshot publication", () => {
  it("atomically publishes a complete version and keeps published bytes immutable", async () => {
    const files = new Map([
      ["zeta.md", new TextEncoder().encode("old zeta")],
      ["Alpha.md", new TextEncoder().encode("old alpha")],
    ]);
    const manager = new SearchSnapshotManager(source(files));

    await manager.rebuild();
    const first = manager.current();
    expect(first?.version).toBe(1);
    expect(first?.notes.map(({ path }) => path)).toEqual(["Alpha.md", "zeta.md"]);

    const pendingRead = deferred<Uint8Array | null>();
    files.set("Alpha.md", new TextEncoder().encode("new alpha"));
    const rebuilding = manager.rebuild({
      listMarkdownPaths: async () => [...files.keys()],
      readBinary: async (path) =>
        path === "Alpha.md" ? pendingRead.promise : files.get(path) ?? null,
    });

    expect(manager.readiness).toBe("building");
    expect(manager.current()).toBe(first);
    pendingRead.resolve(files.get("Alpha.md")!);
    await rebuilding;

    expect(manager.readiness).toBe("ready");
    expect(manager.current()?.version).toBe(2);
    expect(new TextDecoder().decode(first?.notes[0]?.bytes)).toBe("old alpha");
  });

  it("fails closed and preserves the last publication when a build is inconsistent", async () => {
    const manager = new SearchSnapshotManager(
      source(new Map([["valid.md", new TextEncoder().encode("valid")]])),
    );
    await manager.rebuild();
    const first = manager.current();

    await expect(
      manager.rebuild({
        listMarkdownPaths: async () => ["valid.md", "missing.md"],
        readBinary: async (path) =>
          path === "valid.md" ? new TextEncoder().encode("changed") : null,
      }),
    ).rejects.toThrow("inconsistent");

    expect(manager.readiness).toBe("unavailable");
    expect(manager.current()).toBe(first);
  });
});
