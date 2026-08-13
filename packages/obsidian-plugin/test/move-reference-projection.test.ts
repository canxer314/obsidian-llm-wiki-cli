import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  SearchSnapshotManager,
  createMoveReferenceProjector,
  type HostReferenceEvidence,
  type RegisteredReferenceProfile,
  type SearchSnapshot,
} from "../src/index.js";

const version = (value: string) =>
  `sha256:${createHash("sha256").update(value).digest("hex")}`;

function reference(
  content: string,
  original: string,
  target: string,
  resolvedPath: string,
  profile: RegisteredReferenceProfile,
): HostReferenceEvidence {
  const start = content.indexOf(original);
  return {
    profile,
    target,
    resolvedPath,
    original,
    position: {
      start: { line: 0, col: start, offset: start },
      end: {
        line: 0,
        col: start + original.length,
        offset: start + original.length,
      },
    },
  };
}

async function snapshots(backlinkCount = 4) {
  const target = "# Target\n## Heading\n";
  const originals = [
    "[[Target#Heading|alias]]",
    "![[Target#Heading|200]]",
    "[guide](Target.md#Heading 'title')",
    "![alt](<Target.md#Heading>)",
  ] as const;
  const backlink = originals.join(" ");
  const manager = new SearchSnapshotManager({
    listMarkdownPaths: async () => ["Notes/Target.md", "Notes/Backlink.md"],
    readBinary: async (path) => Buffer.from(
      path === "Notes/Target.md" ? target : backlink,
    ),
    semanticEvidence: async (path) => path === "Notes/Target.md"
      ? {
          frontmatter: null,
          tags: [],
          headings: [{ heading: "Heading", level: 2 }],
          references: [],
          resolvedLinks: {},
          unresolvedLinks: {},
        }
      : {
          frontmatter: null,
          tags: [],
          headings: [],
          references: [
            reference(backlink, originals[0], "Target#Heading", "Notes/Target.md", "wikilink"),
            reference(backlink, originals[1], "Target#Heading", "Notes/Target.md", "embed"),
            reference(
              backlink,
              originals[2],
              "Target.md#Heading",
              "Notes/Target.md",
              "markdown_inline_link",
            ),
            reference(
              backlink,
              originals[3],
              "Target.md#Heading",
              "Notes/Target.md",
              "markdown_embed",
            ),
          ],
          resolvedLinks: { "Notes/Target.md": backlinkCount },
          unresolvedLinks: {},
        },
  });
  await manager.rebuild();
  return { manager, target, backlink };
}

describe("note move reference projection", () => {
  it("derives one byte-preserving source-note rewrite for all registered profiles", async () => {
    const { manager, target, backlink } = await snapshots();
    const projectMove = createMoveReferenceProjector(manager);

    const projection = await projectMove({
      operationId: "move-1",
      kind: "move",
      sourcePath: "Notes/Target.md",
      destinationPath: "Archive/Renamed Note.md",
      targetVersion: version(target),
      linkEffect: "update_resolved_references",
    }, Buffer.from(target));

    expect(projection?.derivedEffects).toHaveLength(1);
    expect(projection?.derivedEffects[0]).toMatchObject({
      operationId: "derived/move-1/references/Notes/Backlink.md",
      path: "Notes/Backlink.md",
      targetVersion: version(backlink),
    });
    expect(Buffer.from(projection!.derivedEffects[0]!.projectedBytes).toString()).toBe([
      "[[Renamed Note#Heading|alias]]",
      "![[Renamed Note#Heading|200]]",
      "[guide](Renamed%20Note.md#Heading 'title')",
      "![alt](<Renamed Note.md#Heading>)",
    ].join(" "));
  });

  it("carries a source note self-reference rewrite into destination bytes", async () => {
    const target = "# Target\nSee [[Target]] and [[#Target]]\n";
    const first = "[[Target]]";
    const second = "[[#Target]]";
    const manager = new SearchSnapshotManager({
      listMarkdownPaths: async () => ["Notes/Target.md"],
      readBinary: async () => Buffer.from(target),
      semanticEvidence: async () => ({
        frontmatter: null,
        tags: [],
        headings: [{ heading: "Target", level: 1 }],
        references: [
          reference(target, first, "Target", "Notes/Target.md", "wikilink"),
          reference(target, second, "#Target", "Notes/Target.md", "wikilink"),
        ],
        resolvedLinks: { "Notes/Target.md": 2 },
        unresolvedLinks: {},
      }),
    });
    await manager.rebuild();

    const projection = await createMoveReferenceProjector(manager)({
      operationId: "move-1",
      kind: "move",
      sourcePath: "Notes/Target.md",
      destinationPath: "Archive/Renamed.md",
      targetVersion: version(target),
      linkEffect: "update_resolved_references",
    }, Buffer.from(target));

    expect(Buffer.from(projection!.derivedEffects[0]!.projectedBytes).toString())
      .toBe("# Target\nSee [[Renamed]] and [[#Target]]\n");
  });

  it("preserves an installed alias that still uniquely identifies the moved note", async () => {
    const target = "---\naliases: [Stable Name]\n---\n# Target\n";
    const backlink = "See [[Stable Name|label]]\n";
    const manager = new SearchSnapshotManager({
      listMarkdownPaths: async () => ["Notes/Target.md", "Notes/Backlink.md"],
      readBinary: async (path) => Buffer.from(
        path === "Notes/Target.md" ? target : backlink,
      ),
      semanticEvidence: async (path) => path === "Notes/Target.md"
        ? {
            frontmatter: { aliases: ["Stable Name"] },
            tags: [],
            headings: [{ heading: "Target", level: 1 }],
            references: [],
            resolvedLinks: {},
            unresolvedLinks: {},
          }
        : {
            frontmatter: null,
            tags: [],
            headings: [],
            references: [reference(
              backlink,
              "[[Stable Name|label]]",
              "Stable Name",
              "Notes/Target.md",
              "wikilink",
            )],
            resolvedLinks: { "Notes/Target.md": 1 },
            unresolvedLinks: {},
          },
    });
    await manager.rebuild();

    const projection = await createMoveReferenceProjector(manager)({
      operationId: "move-1",
      kind: "move",
      sourcePath: "Notes/Target.md",
      destinationPath: "Archive/Renamed.md",
      targetVersion: version(target),
      linkEffect: "update_resolved_references",
    }, Buffer.from(target));

    expect(Buffer.from(projection!.derivedEffects[0]!.projectedBytes).toString()).toBe(backlink);
  });

  it("rejects a frozen span whose raw source slice no longer equals cache original", async () => {
    const target = "# Target\n";
    const backlink = "See [[Other ]]\n";
    const original = "[[Target]]";
    const snapshot = {
      version: 1,
      notes: [{
        path: "Notes/Target.md",
        filename: "Target.md",
        bytes: Buffer.from(target),
        content: target,
        contentVersion: version(target),
        sizeBytes: Buffer.byteLength(target),
        frontmatter: null,
        tags: [],
        headings: [{ heading: "Target", level: 1 }],
        references: [],
        resolvedLinks: {},
        unresolvedLinks: {},
      }, {
        path: "Notes/Backlink.md",
        filename: "Backlink.md",
        bytes: Buffer.from(backlink),
        content: backlink,
        contentVersion: version(backlink),
        sizeBytes: Buffer.byteLength(backlink),
        frontmatter: null,
        tags: [],
        headings: [],
        references: [{
          profile: "wikilink",
          target: "Target",
          resolvedPath: "Notes/Target.md",
          original,
          startByte: 4,
          endByteExclusive: 4 + original.length,
        }],
        resolvedLinks: { "Notes/Target.md": 1 },
        unresolvedLinks: {},
      }],
    } as SearchSnapshot;

    await expect(createMoveReferenceProjector({ current: () => snapshot })({
      operationId: "move-1",
      kind: "move",
      sourcePath: "Notes/Target.md",
      destinationPath: "Notes/Renamed.md",
      targetVersion: version(target),
      linkEffect: "update_resolved_references",
    }, Buffer.from(target))).resolves.toBeNull();
  });

  it("keeps a markdown link whose moved target name contains a literal %20 sequence", async () => {
    const target = "# a%20b\n";
    const backlink = "See [guide](a%2520b.md) now\n";
    const manager = new SearchSnapshotManager({
      listMarkdownPaths: async () => ["Notes/a%20b.md", "Notes/Backlink.md"],
      readBinary: async (path) => Buffer.from(
        path === "Notes/a%20b.md" ? target : backlink,
      ),
      semanticEvidence: async (path) => path === "Notes/a%20b.md"
        ? {
            frontmatter: null,
            tags: [],
            headings: [{ heading: "a%20b", level: 1 }],
            references: [],
            resolvedLinks: {},
            unresolvedLinks: {},
          }
        : {
            frontmatter: null,
            tags: [],
            headings: [],
            references: [reference(
              backlink,
              "[guide](a%2520b.md)",
              "a%2520b.md",
              "Notes/a%20b.md",
              "markdown_inline_link",
            )],
            resolvedLinks: { "Notes/a%20b.md": 1 },
            unresolvedLinks: {},
          },
    });
    await manager.rebuild();

    const projection = await createMoveReferenceProjector(manager)({
      operationId: "move-1",
      kind: "move",
      sourcePath: "Notes/a%20b.md",
      destinationPath: "Archive/a%20b.md",
      targetVersion: version(target),
      linkEffect: "update_resolved_references",
    }, Buffer.from(target));

    expect(Buffer.from(projection!.derivedEffects[0]!.projectedBytes).toString()).toBe(backlink);
  });

  it("rewrites a markdown link whose moved target name contains a literal percent sign", async () => {
    const target = "# 100%\n";
    const backlink = "See [guide](100%25.md) now\n";
    const manager = new SearchSnapshotManager({
      listMarkdownPaths: async () => ["Notes/100%.md", "Notes/Backlink.md"],
      readBinary: async (path) => Buffer.from(
        path === "Notes/100%.md" ? target : backlink,
      ),
      semanticEvidence: async (path) => path === "Notes/100%.md"
        ? {
            frontmatter: null,
            tags: [],
            headings: [{ heading: "100%", level: 1 }],
            references: [],
            resolvedLinks: {},
            unresolvedLinks: {},
          }
        : {
            frontmatter: null,
            tags: [],
            headings: [],
            references: [reference(
              backlink,
              "[guide](100%25.md)",
              "100%25.md",
              "Notes/100%.md",
              "markdown_inline_link",
            )],
            resolvedLinks: { "Notes/100%.md": 1 },
            unresolvedLinks: {},
          },
    });
    await manager.rebuild();

    const projection = await createMoveReferenceProjector(manager)({
      operationId: "move-1",
      kind: "move",
      sourcePath: "Notes/100%.md",
      destinationPath: "Archive/renamed 100%.md",
      targetVersion: version(target),
      linkEffect: "update_resolved_references",
    }, Buffer.from(target));

    expect(Buffer.from(projection!.derivedEffects[0]!.projectedBytes).toString())
      .toBe("See [guide](renamed%20100%25.md) now\n");
  });

  it("rejects the projection when a moved markdown target name contains a literal #", async () => {
    const target = "# a#b\n";
    const backlink = "See [guide](a%23b.md) now\n";
    const manager = new SearchSnapshotManager({
      listMarkdownPaths: async () => ["Notes/a#b.md", "Notes/Backlink.md"],
      readBinary: async (path) => Buffer.from(
        path === "Notes/a#b.md" ? target : backlink,
      ),
      semanticEvidence: async (path) => path === "Notes/a#b.md"
        ? {
            frontmatter: null,
            tags: [],
            headings: [{ heading: "a#b", level: 1 }],
            references: [],
            resolvedLinks: {},
            unresolvedLinks: {},
          }
        : {
            frontmatter: null,
            tags: [],
            headings: [],
            references: [reference(
              backlink,
              "[guide](a%23b.md)",
              "a%23b.md",
              "Notes/a#b.md",
              "markdown_inline_link",
            )],
            resolvedLinks: { "Notes/a#b.md": 1 },
            unresolvedLinks: {},
          },
    });
    await manager.rebuild();

    const projection = await createMoveReferenceProjector(manager)({
      operationId: "move-1",
      kind: "move",
      sourcePath: "Notes/a#b.md",
      destinationPath: "Archive/a#b.md",
      targetVersion: version(target),
      linkEffect: "update_resolved_references",
    }, Buffer.from(target));

    // A bare # in the rendered destination would start a fragment, silently
    // corrupting the link, so the projection must reject instead (AC6).
    expect(projection).toBeNull();
  });

  it("rejects the projection when a moved markdown target fragment keeps a reserved escape", async () => {
    const target = "# C#-sharp\n";
    const backlink = "See [guide](Notes/Note.md#C%23-sharp) now\n";
    const manager = new SearchSnapshotManager({
      listMarkdownPaths: async () => ["Notes/Note.md", "Notes/Backlink.md"],
      readBinary: async (path) => Buffer.from(
        path === "Notes/Note.md" ? target : backlink,
      ),
      semanticEvidence: async (path) => path === "Notes/Note.md"
        ? {
            frontmatter: null,
            tags: [],
            headings: [{ heading: "C#-sharp", level: 1 }],
            references: [],
            resolvedLinks: {},
            unresolvedLinks: {},
          }
        : {
            frontmatter: null,
            tags: [],
            headings: [],
            references: [reference(
              backlink,
              "[guide](Notes/Note.md#C%23-sharp)",
              "Notes/Note.md#C%23-sharp",
              "Notes/Note.md",
              "markdown_inline_link",
            )],
            resolvedLinks: { "Notes/Note.md": 1 },
            unresolvedLinks: {},
          },
    });
    await manager.rebuild();

    const projection = await createMoveReferenceProjector(manager)({
      operationId: "move-1",
      kind: "move",
      sourcePath: "Notes/Note.md",
      destinationPath: "Archive/Note.md",
      targetVersion: version(target),
      linkEffect: "update_resolved_references",
    }, Buffer.from(target));

    // decodeURI leaves %23 intact but the renderer escapes % as %25, so the
    // rewritten anchor would double-encode into a dead link; reject (AC6).
    expect(projection).toBeNull();
  });

  it("preserves the original bytes of a wrapped target that still resolves after the move", async () => {
    const target = "# a b\n";
    const backlink = "See [guide](<a%20b.md>) now\n";
    const manager = new SearchSnapshotManager({
      listMarkdownPaths: async () => ["Notes/a b.md", "Notes/Backlink.md"],
      readBinary: async (path) => Buffer.from(
        path === "Notes/a b.md" ? target : backlink,
      ),
      semanticEvidence: async (path) => path === "Notes/a b.md"
        ? {
            frontmatter: null,
            tags: [],
            headings: [{ heading: "a b", level: 1 }],
            references: [],
            resolvedLinks: {},
            unresolvedLinks: {},
          }
        : {
            frontmatter: null,
            tags: [],
            headings: [],
            references: [reference(
              backlink,
              "[guide](<a%20b.md>)",
              "a%20b.md",
              "Notes/a b.md",
              "markdown_inline_link",
            )],
            resolvedLinks: { "Notes/a b.md": 1 },
            unresolvedLinks: {},
          },
    });
    await manager.rebuild();

    const projection = await createMoveReferenceProjector(manager)({
      operationId: "move-1",
      kind: "move",
      sourcePath: "Notes/a b.md",
      destinationPath: "Archive/a b.md",
      targetVersion: version(target),
      linkEffect: "update_resolved_references",
    }, Buffer.from(target));

    // The shortest-form target still uniquely resolves, so nothing is
    // rewritten and the original encoding style must survive untouched (AC3).
    expect(Buffer.from(projection!.derivedEffects[0]!.projectedBytes).toString())
      .toBe(backlink);
  });

  it("preserves a fragment-only markdown self-reference when the note moves", async () => {
    const target = "# C#-sharp\nSee [guide](#C%23-sharp) now\n";
    const manager = new SearchSnapshotManager({
      listMarkdownPaths: async () => ["Notes/Note.md"],
      readBinary: async () => Buffer.from(target),
      semanticEvidence: async () => ({
        frontmatter: null,
        tags: [],
        headings: [{ heading: "C#-sharp", level: 1 }],
        references: [reference(
          target,
          "[guide](#C%23-sharp)",
          "#C%23-sharp",
          "Notes/Note.md",
          "markdown_inline_link",
        )],
        resolvedLinks: { "Notes/Note.md": 1 },
        unresolvedLinks: {},
      }),
    });
    await manager.rebuild();

    const projection = await createMoveReferenceProjector(manager)({
      operationId: "move-1",
      kind: "move",
      sourcePath: "Notes/Note.md",
      destinationPath: "Archive/Note.md",
      targetVersion: version(target),
      linkEffect: "update_resolved_references",
    }, Buffer.from(target));

    // The anchor lives in the moved note itself, so the original bytes still
    // resolve and must be carried over untouched instead of being re-encoded.
    expect(Buffer.from(projection!.derivedEffects[0]!.projectedBytes).toString())
      .toBe(target);
  });

  it("rejects the projection instead of throwing when a target decodes outside the vault", async () => {
    const target = "# Target\n";
    const backlink = "See [g](../escape.md) now\n";
    const original = "[g](../escape.md)";
    const snapshot = {
      version: 1,
      notes: [{
        path: "Notes/Target.md",
        filename: "Target.md",
        bytes: Buffer.from(target),
        content: target,
        contentVersion: version(target),
        sizeBytes: Buffer.byteLength(target),
        frontmatter: null,
        tags: [],
        headings: [{ heading: "Target", level: 1 }],
        references: [],
        resolvedLinks: {},
        unresolvedLinks: {},
      }, {
        path: "Backlink.md",
        filename: "Backlink.md",
        bytes: Buffer.from(backlink),
        content: backlink,
        contentVersion: version(backlink),
        sizeBytes: Buffer.byteLength(backlink),
        frontmatter: null,
        tags: [],
        headings: [],
        references: [{
          profile: "markdown_inline_link",
          target: "../escape.md",
          resolvedPath: "Notes/Target.md",
          original,
          startByte: 4,
          endByteExclusive: 4 + original.length,
        }],
        resolvedLinks: { "Notes/Target.md": 1 },
        unresolvedLinks: {},
      }],
    } as SearchSnapshot;

    await expect(createMoveReferenceProjector({ current: () => snapshot })({
      operationId: "move-1",
      kind: "move",
      sourcePath: "Notes/Target.md",
      destinationPath: "Notes/Renamed.md",
      targetVersion: version(target),
      linkEffect: "update_resolved_references",
    }, Buffer.from(target))).resolves.toBeNull();
  });

  it("rejects the whole projection when immutable graph closure and spans disagree", async () => {
    const { manager, target } = await snapshots(5);
    const projectMove = createMoveReferenceProjector(manager);

    await expect(projectMove({
      operationId: "move-1",
      kind: "move",
      sourcePath: "Notes/Target.md",
      destinationPath: "Notes/Renamed.md",
      targetVersion: version(target),
      linkEffect: "update_resolved_references",
    }, Buffer.from(target))).resolves.toBeNull();
  });
});
