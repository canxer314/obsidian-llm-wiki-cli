import { describe, expect, it, vi } from "vitest";

import {
  SearchSnapshotManager,
  VaultDiscoverService,
  type SearchSnapshotDataSource,
} from "../src/index.js";
import {
  SEARCH_SNAPSHOT_QUIET_WINDOW_MS,
  SearchSnapshotRefreshCoordinator,
} from "../src/search-snapshot.js";

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

  it("binds installed-runtime semantic evidence to the same immutable bytes", async () => {
    const content = [
      "---",
      "status: active",
      "aliases: [Bridge, Runtime]",
      "---",
      "# Design",
      "😀 [[Target Note|target]] and [guide](Guides/My%20Guide.md)",
    ].join("\n");
    const files = new Map([["Source.md", new TextEncoder().encode(content)]]);
    const manager = new SearchSnapshotManager({
      ...source(files),
      semanticEvidence: async () => ({
        frontmatter: { status: "active", aliases: ["Bridge", "Runtime"] },
        tags: ["#architecture"],
        headings: [{ heading: "Design", level: 1 }],
        references: [
          {
            profile: "wikilink",
            target: "Target Note",
            resolvedPath: "Target Note.md",
            original: "[[Target Note|target]]",
            position: {
              start: { line: 5, col: 3, offset: content.indexOf("[[Target") },
              end: { line: 5, col: 25, offset: content.indexOf("[[Target") + 22 },
            },
          },
          {
            profile: "markdown_inline_link",
            target: "Guides/My%20Guide.md",
            resolvedPath: "Guides/My Guide.md",
            original: "[guide](Guides/My%20Guide.md)",
            position: {
              start: { line: 5, col: 30, offset: content.indexOf("[guide]") },
              end: { line: 5, col: 59, offset: content.length },
            },
          },
        ],
        resolvedLinks: { "Target Note.md": 1, "Guides/My Guide.md": 1 },
        unresolvedLinks: { "Missing Note": 1 },
      }),
    });

    await manager.rebuild();

    expect(manager.current()?.notes[0]).toMatchObject({
      frontmatter: { status: "active", aliases: ["Bridge", "Runtime"] },
      tags: ["#architecture"],
      headings: [{ heading: "Design", level: 1 }],
      references: [
        {
          profile: "wikilink",
          target: "Target Note",
          resolvedPath: "Target Note.md",
          original: "[[Target Note|target]]",
        },
        {
          profile: "markdown_inline_link",
          target: "Guides/My%20Guide.md",
          resolvedPath: "Guides/My Guide.md",
          original: "[guide](Guides/My%20Guide.md)",
        },
      ],
      resolvedLinks: { "Target Note.md": 1, "Guides/My Guide.md": 1 },
      unresolvedLinks: { "Missing Note": 1 },
    });
    const references = manager.current()?.notes[0]?.references ?? [];
    expect(new TextDecoder().decode(
      manager.current()?.notes[0]?.bytes.slice(
        references[0]?.startByte,
        references[0]?.endByteExclusive,
      ),
    )).toBe("[[Target Note|target]]");
  });

  it("rejects unknown profiles and ambiguous UTF-16 locator candidates", async () => {
    const repeated = "[[Same]] middle [[Same]]";
    const manager = new SearchSnapshotManager({
      ...source(new Map([["Repeated.md", new TextEncoder().encode(repeated)]])),
      semanticEvidence: async () => ({
        frontmatter: null,
        tags: [],
        headings: [],
        references: [{
          profile: "wikilink",
          target: "Same",
          resolvedPath: "Same.md",
          original: "[[Same]]",
          position: {
            start: { line: 0, col: 0, offset: repeated.lastIndexOf("[[Same]]") },
            end: { line: 0, col: 8, offset: repeated.length },
          },
        }],
        resolvedLinks: { "Same.md": 2 },
        unresolvedLinks: {},
      }),
    });

    await expect(manager.rebuild()).rejects.toThrow("reference span");
    expect(manager.readiness).toBe("unavailable");

    const unknownProfile = new SearchSnapshotManager({
      ...source(new Map([["Unknown.md", new TextEncoder().encode("[[Same]]")]])),
      semanticEvidence: async () => ({
        frontmatter: null,
        tags: [],
        headings: [],
        references: [{
          profile: "frontmatter",
          target: "Same",
          resolvedPath: "Same.md",
          original: "[[Same]]",
          position: {
            start: { line: 0, col: 0, offset: 0 },
            end: { line: 0, col: 8, offset: 8 },
          },
        }],
        resolvedLinks: { "Same.md": 1 },
        unresolvedLinks: {},
      }),
    });
    await expect(unknownProfile.rebuild()).rejects.toThrow("reference profile");
  });

  it("rejects a pending barrier and cancels its scheduled rebuild when disposed", async () => {
    vi.useFakeTimers();
    try {
      const files = new Map([["source.md", new TextEncoder().encode("old")]]);
      const manager = new SearchSnapshotManager(source(files));
      await manager.rebuild();
      const rebuild = vi.spyOn(manager, "rebuild");
      const coordinator = new SearchSnapshotRefreshCoordinator(manager);

      coordinator.schedule();
      const barrier = coordinator.whenIdle();
      coordinator.dispose();

      await expect(barrier).rejects.toThrow("refresh coordinator is disposed");
      await vi.runAllTimersAsync();
      expect(rebuild).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects a barrier promptly when disposed during its rebuild", async () => {
    vi.useFakeTimers();
    try {
      const rebuildStarted = deferred<void>();
      const releaseRebuild = deferred<void>();
      const manager = new SearchSnapshotManager(source(new Map()));
      vi.spyOn(manager, "rebuild").mockImplementation(async () => {
        rebuildStarted.resolve();
        await releaseRebuild.promise;
      });
      const coordinator = new SearchSnapshotRefreshCoordinator(manager);

      coordinator.schedule();
      const barrier = coordinator.whenIdle();
      await vi.advanceTimersByTimeAsync(SEARCH_SNAPSHOT_QUIET_WINDOW_MS);
      await rebuildStarted.promise;
      coordinator.dispose();

      await expect(barrier).rejects.toThrow("refresh coordinator is disposed");
      releaseRebuild.resolve();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not start a queued rebuild after disposal", async () => {
    vi.useFakeTimers();
    try {
      const firstRebuildStarted = deferred<void>();
      const releaseFirstRebuild = deferred<void>();
      const manager = new SearchSnapshotManager(source(new Map()));
      const rebuild = vi.spyOn(manager, "rebuild")
        .mockImplementationOnce(async () => {
          firstRebuildStarted.resolve();
          await releaseFirstRebuild.promise;
        })
        .mockImplementation(async () => undefined);
      const coordinator = new SearchSnapshotRefreshCoordinator(manager);

      coordinator.schedule();
      await vi.advanceTimersByTimeAsync(SEARCH_SNAPSHOT_QUIET_WINDOW_MS);
      await firstRebuildStarted.promise;
      coordinator.schedule();
      await vi.advanceTimersByTimeAsync(SEARCH_SNAPSHOT_QUIET_WINDOW_MS);
      coordinator.dispose();
      releaseFirstRebuild.resolve();
      await vi.runAllTimersAsync();

      expect(rebuild).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("invalidates new discovery until semantic evidence stays quiet for 250 ms", async () => {
    vi.useFakeTimers();
    try {
      const files = new Map([["source.md", new TextEncoder().encode("old")]]);
      const manager = new SearchSnapshotManager(source(files));
      await manager.rebuild();
      const coordinator = new SearchSnapshotRefreshCoordinator(manager);
      const discover = new VaultDiscoverService(manager);
      const request = {
        query: { path: { exact: "source.md" } },
        projection: { matches: false },
        order: { by: "path" as const, direction: "asc" as const },
        page: { maxItems: 10, continuation: null },
      };

      files.set("source.md", new TextEncoder().encode("first change"));
      coordinator.schedule();
      const barrier = coordinator.whenIdle();
      let barrierComplete = false;
      void barrier.then(() => {
        barrierComplete = true;
      });
      expect(manager.readiness).toBe("building");
      await expect(discover.execute(request)).resolves.toEqual({
        outcome: "snapshot_unavailable",
        code: "search_snapshot_unavailable",
      });

      await vi.advanceTimersByTimeAsync(200);
      files.set("source.md", new TextEncoder().encode("settled change"));
      coordinator.schedule();
      await vi.advanceTimersByTimeAsync(249);
      expect(manager.current()?.notes[0]?.content).toBe("old");
      expect(barrierComplete).toBe(false);

      await vi.advanceTimersByTimeAsync(1);
      await barrier;
      expect(manager.readiness).toBe("ready");
      expect(manager.current()?.notes[0]?.content).toBe("settled change");
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a barrier pending when evidence changes during publication", async () => {
    vi.useFakeTimers();
    try {
      const files = new Map([["source.md", new TextEncoder().encode("old")]]);
      const pendingRead = deferred<Uint8Array | null>();
      let blockNextRead = false;
      const manager = new SearchSnapshotManager({
        listMarkdownPaths: async () => [...files.keys()],
        readBinary: async (path) =>
          blockNextRead ? pendingRead.promise : files.get(path) ?? null,
      });
      await manager.rebuild();
      const coordinator = new SearchSnapshotRefreshCoordinator(manager);
      files.set("source.md", new TextEncoder().encode("first"));
      blockNextRead = true;
      coordinator.schedule();
      const barrier = coordinator.whenIdle();
      await vi.advanceTimersByTimeAsync(250);
      files.set("source.md", new TextEncoder().encode("settled"));
      coordinator.schedule();
      blockNextRead = false;
      pendingRead.resolve(new TextEncoder().encode("stale"));
      await Promise.resolve();
      let complete = false;
      void barrier.then(() => {
        complete = true;
      });

      await vi.advanceTimersByTimeAsync(249);
      expect(complete).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await barrier;
      expect(manager.current()?.notes[0]?.content).toBe("settled");
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not publish a build superseded by semantic graph changes", async () => {
    const initial = new Map([["source.md", new TextEncoder().encode("old")]]);
    const manager = new SearchSnapshotManager(source(initial));
    await manager.rebuild();
    const pendingRead = deferred<Uint8Array | null>();
    const firstBuild = manager.rebuild({
      listMarkdownPaths: async () => ["source.md"],
      readBinary: () => pendingRead.promise,
    });
    manager.invalidate();
    pendingRead.resolve(new TextEncoder().encode("stale build"));

    await firstBuild;

    expect(manager.readiness).toBe("building");
    expect(manager.current()?.notes[0]?.content).toBe("old");
  });

  it("serializes a Change Set successor publication behind an active refresh", async () => {
    const initial = new Map([["source.md", new TextEncoder().encode("initial")]]);
    const manager = new SearchSnapshotManager(source(initial));
    await manager.rebuild();
    const pendingRead = deferred<Uint8Array | null>();
    const firstBuild = manager.rebuild({
      listMarkdownPaths: async () => ["source.md"],
      readBinary: () => pendingRead.promise,
    });
    initial.set("source.md", new TextEncoder().encode("successor"));
    const successorBuild = manager.rebuild();
    pendingRead.resolve(new TextEncoder().encode("refresh"));

    await Promise.all([firstBuild, successorBuild]);

    expect(manager.readiness).toBe("ready");
    expect(manager.current()?.notes[0]?.content).toBe("successor");
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
