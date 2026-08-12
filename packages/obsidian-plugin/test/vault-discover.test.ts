import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";

import { describe, expect, it } from "vitest";

import {
  SearchSnapshotManager,
  VaultDiscoverService,
  type SearchSnapshotDataSource,
} from "../src/index.js";

async function markdownPaths(root: string, directory = root): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const paths = await Promise.all(
    entries.map(async (entry) => {
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) return markdownPaths(root, absolute);
      return entry.isFile() && entry.name.endsWith(".md")
        ? [relative(root, absolute).split(sep).join("/")]
        : [];
    }),
  );
  return paths.flat();
}

async function withDiskVault(
  files: Record<string, string>,
  run: (source: SearchSnapshotDataSource) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "llm-wiki-discover-"));
  try {
    for (const [path, content] of Object.entries(files)) {
      const absolute = join(root, ...path.split("/"));
      await mkdir(join(absolute, ".."), { recursive: true });
      await writeFile(absolute, content, "utf8");
    }
    await run({
      listMarkdownPaths: () => markdownPaths(root),
      readBinary: async (path) => {
        try {
          return await readFile(join(root, ...path.split("/")));
        } catch {
          return null;
        }
      },
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function mutableVault(initial: Record<string, string>): {
  files: Map<string, Uint8Array>;
  source: SearchSnapshotDataSource;
} {
  const files = new Map(
    Object.entries(initial).map(([path, content]) => [path, new TextEncoder().encode(content)]),
  );
  return {
    files,
    source: {
      listMarkdownPaths: async () => [...files.keys()],
      readBinary: async (path) => files.get(path) ?? null,
    },
  };
}

const input = (query: unknown, maxItems = 100, matches = true) => ({
  query,
  projection: { matches },
  order: { by: "path" as const, direction: "asc" as const },
  page: { maxItems, continuation: null },
});

describe("vault_discover over a real Vault source", () => {
  it("covers path, filename, literal, regex, ordering, and no-match against disk bytes", async () => {
    await withDiskVault(
      {
        "zeta/Bridge.md": "Recovery   Journal",
        "Alpha/bridge.md": "Search Snapshot",
        "Alpha/Other.md": "unrelated",
      },
      async (source) => {
        const snapshots = new SearchSnapshotManager(source);
        await snapshots.rebuild();
        const discover = new VaultDiscoverService(snapshots);

        const paths = await discover.execute(
          input({ path: { prefix: "Alpha/" } }, 100, false),
        );
        expect(paths).toMatchObject({
          items: [{ path: "Alpha/bridge.md" }, { path: "Alpha/Other.md" }],
        });
        const filename = await discover.execute(
          input({ filename: { substring: "bridge", caseSensitive: false } }, 100, false),
        );
        expect(filename).toMatchObject({
          items: [{ path: "Alpha/bridge.md" }, { path: "zeta/Bridge.md" }],
        });
        const literal = await discover.execute(
          input({ text: { literal: "Search Snapshot", caseSensitive: true } }),
        );
        expect(literal).toMatchObject({ items: [{ path: "Alpha/bridge.md" }] });
        const regex = await discover.execute(
          input({ text: { regex: "recovery\\s+journal", caseSensitive: false } }),
        );
        expect(regex).toMatchObject({ items: [{ path: "zeta/Bridge.md" }] });
        const noMatch = await discover.execute(
          input({ filename: { exact: "missing.md", caseSensitive: true } }, 100, false),
        );
        expect(noMatch).toMatchObject({ items: [], complete: true, continuation: null });
      },
    );
  });

  it("discovers canonical path and filename matches in deterministic order", async () => {
    const vault = mutableVault({
      "zeta/Bridge Notes.md": "one",
      "Alpha/bridge design.md": "two",
      "Alpha/Other.md": "three",
    });
    const snapshots = new SearchSnapshotManager(vault.source);
    await snapshots.rebuild();
    const discover = new VaultDiscoverService(snapshots);

    const result = await discover.execute(
      input({
        all: [
          { path: { prefix: "Alpha/" } },
          { filename: { substring: "bridge", caseSensitive: false } },
        ],
      }, 100, false),
    );

    expect(result).toMatchObject({
      outcome: "results",
      complete: true,
      continuation: null,
      items: [{ path: "Alpha/bridge design.md", sizeBytes: 3 }],
    });
  });

  it("returns literal and regex evidence with UTF-8 byte offsets and line numbers", async () => {
    const vault = mutableVault({
      "中文.md": "标题\r\nSearch 快照\r\nRecovery   Journal",
    });
    const snapshots = new SearchSnapshotManager(vault.source);
    await snapshots.rebuild();
    const discover = new VaultDiscoverService(snapshots);

    const literal = await discover.execute(
      input({ text: { literal: "Search 快照", caseSensitive: true } }),
    );
    expect(literal).toMatchObject({
      outcome: "results",
      items: [
        {
          path: "中文.md",
          matches: [
            {
              line: 2,
              startByte: 8,
              endByteExclusive: 21,
              text: "Search 快照",
            },
          ],
        },
      ],
    });

    const regex = await discover.execute(
      input({ text: { regex: "recovery\\s+journal", caseSensitive: false } }),
    );
    expect(regex).toMatchObject({
      outcome: "results",
      items: [{ matches: [{ line: 3, text: "Recovery   Journal" }] }],
    });
  });

  it("returns a successful ordered empty collection when nothing matches", async () => {
    const vault = mutableVault({ "note.md": "content" });
    const snapshots = new SearchSnapshotManager(vault.source);
    await snapshots.rebuild();
    const result = await new VaultDiscoverService(snapshots).execute(
      input({ filename: { exact: "missing.md", caseSensitive: true } }, 100, false),
    );

    expect(result).toEqual({
      outcome: "results",
      ordering: { by: "path", direction: "asc", tieBreaker: "path_utf8_bytes" },
      items: [],
      complete: true,
      continuation: null,
    });
  });

  it("paginates one frozen result despite later Snapshot publication", async () => {
    const vault = mutableVault({
      "a.md": "needle old-a",
      "b.md": "needle old-b",
      "c.md": "needle old-c",
    });
    const snapshots = new SearchSnapshotManager(vault.source);
    await snapshots.rebuild();
    let tokenIndex = 0;
    const discover = new VaultDiscoverService(snapshots, {
      createToken: () => `frozen-${++tokenIndex}`,
    });

    const first = await discover.execute(
      input({ text: { literal: "needle", caseSensitive: true } }, 1),
    );
    expect(first).toMatchObject({
      outcome: "results",
      items: [{ path: "a.md" }],
      complete: false,
      continuation: "frozen-1:1",
    });

    vault.files.delete("b.md");
    vault.files.set("a.md", new TextEncoder().encode("changed"));
    await snapshots.rebuild();

    const secondRequest = {
      ...input({ filename: { exact: "ignored.md", caseSensitive: true } }, 1, false),
      page: { maxItems: 1, continuation: "frozen-1:1" },
    };
    const second = await discover.execute(secondRequest);
    expect(second).toMatchObject({
      outcome: "results",
      items: [{ path: "b.md", matches: [{ text: "needle" }] }],
      complete: false,
    });
    await expect(discover.execute(secondRequest)).resolves.toEqual({
      outcome: "snapshot_unavailable",
      code: "search_snapshot_unavailable",
    });
    const token = second.outcome === "results" ? second.continuation : null;
    expect(token).not.toBeNull();

    const third = await discover.execute({
      ...input({ path: { exact: "ignored.md" } }, 100, false),
      page: { maxItems: 100, continuation: token },
    });
    expect(third).toMatchObject({
      outcome: "results",
      items: [{ path: "c.md", matches: [{ text: "needle" }] }],
      complete: true,
      continuation: null,
    });
  });

  it("binds each continuation to the client that created it", async () => {
    const vault = mutableVault({ "a.md": "needle", "b.md": "needle" });
    const snapshots = new SearchSnapshotManager(vault.source);
    await snapshots.rebuild();
    const discover = new VaultDiscoverService(snapshots, {
      createToken: () => "client-bound",
    });
    const first = await discover.execute(
      input({ text: { literal: "needle", caseSensitive: true } }, 1),
      "client-a",
    );
    expect(first).toMatchObject({ continuation: "client-bound:1" });
    const continuationRequest = {
      ...input({ path: { exact: "ignored.md" } }, 1, false),
      page: { maxItems: 1, continuation: "client-bound:1" },
    };

    await expect(discover.execute(continuationRequest, "client-b")).resolves.toEqual({
      outcome: "snapshot_unavailable",
      code: "search_snapshot_unavailable",
    });
    await expect(discover.execute(continuationRequest, "client-a")).resolves.toMatchObject({
      outcome: "results",
      items: [{ path: "b.md" }],
      complete: true,
    });
  });

  it("releases every continuation owned by a disconnected client", async () => {
    const vault = mutableVault({ "a.md": "needle", "b.md": "needle" });
    const snapshots = new SearchSnapshotManager(vault.source);
    await snapshots.rebuild();
    const discover = new VaultDiscoverService(snapshots, {
      createToken: () => "released",
    });
    const first = await discover.execute(
      input({ text: { literal: "needle", caseSensitive: true } }, 1),
      "client-a",
    );
    expect(first).toMatchObject({ continuation: "released:1" });

    discover.releaseClient("client-a");

    await expect(discover.execute({
      ...input({ path: { exact: "ignored.md" } }, 1, false),
      page: { maxItems: 1, continuation: "released:1" },
    }, "client-a")).resolves.toEqual({
      outcome: "snapshot_unavailable",
      code: "search_snapshot_unavailable",
    });
  });

  it("limits each client to eight active continuation chains without eviction", async () => {
    const vault = mutableVault({ "a.md": "needle", "b.md": "needle" });
    const snapshots = new SearchSnapshotManager(vault.source);
    await snapshots.rebuild();
    let tokenIndex = 0;
    const discover = new VaultDiscoverService(snapshots, {
      createToken: () => `quota-${++tokenIndex}`,
    });
    const query = input({ text: { literal: "needle", caseSensitive: true } }, 1);
    const continuations: string[] = [];
    for (let index = 0; index < 8; index += 1) {
      const result = await discover.execute(query, "client-a");
      expect(result).toMatchObject({ outcome: "results", complete: false });
      if (result.outcome === "results" && result.continuation !== null) {
        continuations.push(result.continuation);
      }
    }

    await expect(discover.execute(query, "client-a")).resolves.toEqual({
      outcome: "snapshot_unavailable",
      code: "search_snapshot_unavailable",
    });
    await expect(discover.execute({
      ...query,
      page: { maxItems: 1, continuation: continuations[0] },
    }, "client-a")).resolves.toMatchObject({
      outcome: "results",
      items: [{ path: "b.md" }],
      complete: true,
    });
  });

  it("limits each client to eight MiB of retained frozen discovery evidence", async () => {
    const largeContent = "x".repeat(1_000_000);
    const vault = mutableVault(Object.fromEntries(
      Array.from({ length: 9 }, (_, index) => [`${index}.md`, largeContent]),
    ));
    const snapshots = new SearchSnapshotManager(vault.source);
    await snapshots.rebuild();
    const discover = new VaultDiscoverService(snapshots);

    await expect(discover.execute(
      input({ text: { regex: "x+", caseSensitive: true } }, 1),
      "client-a",
    )).resolves.toEqual({
      outcome: "snapshot_unavailable",
      code: "search_snapshot_unavailable",
    });
  });

  it("releases abandoned frozen results after the continuation lifetime", async () => {
    const vault = mutableVault({ "a.md": "needle", "b.md": "needle" });
    const snapshots = new SearchSnapshotManager(vault.source);
    await snapshots.rebuild();
    let now = 0;
    const discover = new VaultDiscoverService(snapshots, {
      createToken: () => "expiring",
      now: () => now,
    });
    const first = await discover.execute(
      input({ text: { literal: "needle", caseSensitive: true } }, 1),
    );
    expect(first).toMatchObject({ continuation: "expiring:1" });

    now = 15 * 60 * 1_000;
    const expired = await discover.execute({
      ...input({ path: { exact: "ignored.md" } }, 100, false),
      page: { maxItems: 1, continuation: "expiring:1" },
    });

    expect(expired).toEqual({
      outcome: "snapshot_unavailable",
      code: "search_snapshot_unavailable",
    });
  });

  it("fails closed while no trustworthy Snapshot is ready", async () => {
    const snapshots = new SearchSnapshotManager({
      listMarkdownPaths: async () => ["missing.md"],
      readBinary: async () => null,
    });
    await expect(snapshots.rebuild()).rejects.toThrow();

    const result = await new VaultDiscoverService(snapshots).execute(
      input({ path: { exact: "missing.md" } }, 100, false),
    );
    expect(result).toEqual({
      outcome: "snapshot_unavailable",
      code: "search_snapshot_unavailable",
    });
  });
});
