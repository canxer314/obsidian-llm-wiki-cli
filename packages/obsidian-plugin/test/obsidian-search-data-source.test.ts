import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  SearchSnapshotManager,
  createObsidianSearchDataSource,
  renderRegisteredReference,
} from "../src/index.js";

import {
  ObsidianSemanticVersionTracker,
  enumerateCanonicalReferenceTargets,
  isRegisteredSubpathResult,
} from "../src/obsidian-search-data-source.js";

const position = (start: number, end: number) => ({
  start: { line: 0, col: start, offset: start },
  end: { line: 0, col: end, offset: end },
});

describe("Obsidian semantic Content Version evidence", () => {
  const byteVersion = (bytes: Uint8Array) =>
    createHash("sha256").update(bytes).digest("hex");
  const BOM = Buffer.from([0xef, 0xbb, 0xbf]);
  const utf8 = (text: string) => new TextEncoder().encode(text);

  it("matches parsed text to raw bytes with and without a BOM", () => {
    const tracker = new ObsidianSemanticVersionTracker();
    expect(tracker.matches("Note.md", utf8("body"))).toBe(false);

    tracker.observe("Note.md", "body");
    expect(tracker.matches("Note.md", utf8("body"))).toBe(true);
    expect(tracker.matches("Note.md", Buffer.concat([BOM, utf8("body")]))).toBe(true);
    expect(tracker.matches("Note.md", utf8("other"))).toBe(false);
  });

  it("rejects a late stale observation after a newer one", () => {
    const tracker = new ObsidianSemanticVersionTracker();
    tracker.observe("Note.md", "v2");
    expect(tracker.matches("Note.md", utf8("v2"))).toBe(true);
    tracker.observe("Note.md", "v1");
    expect(tracker.matches("Note.md", utf8("v2"))).toBe(false);
    expect(tracker.matches("Note.md", utf8("v1"))).toBe(true);
  });

  it("tracks rename and forgets delete", () => {
    const tracker = new ObsidianSemanticVersionTracker();
    tracker.observe("Old.md", "body");
    tracker.rename("Old.md", "New.md");
    expect(tracker.matches("Old.md", utf8("body"))).toBe(false);
    expect(tracker.matches("New.md", utf8("body"))).toBe(true);
    tracker.remove("New.md");
    expect(tracker.matches("New.md", utf8("body"))).toBe(false);
  });

  it("reports the byte Content Version through the search data source", async () => {
    const tracker = new ObsidianSemanticVersionTracker();
    tracker.observe("Bom.md", "with bom");
    const bytes = Buffer.concat([BOM, utf8("with bom")]);
    const dataSource = createObsidianSearchDataSource({
      markdownFiles: () => [{ path: "Bom.md" }],
      readBinary: async () => bytes,
      fileCache: () => ({}),
      semanticContentMatches: (path, current) =>
        tracker.matches(path, current instanceof Uint8Array ? current : new Uint8Array(current)),
      resolveLink: () => null,
      candidatePaths: () => [],
      validSubpath: () => false,
      resolvedLinks: () => ({}),
      unresolvedLinks: () => ({}),
      parseFrontmatter: () => null,
      allTags: () => [],
    });
    const snapshots = new SearchSnapshotManager(dataSource);
    await snapshots.rebuild();
    const note = snapshots.current()?.notes[0];
    expect(note?.contentVersion).toBe(`sha256:${byteVersion(bytes)}`);
    expect(note?.semanticContentVersion).toBe(`sha256:${byteVersion(bytes)}`);
  });
});

describe("installed Obsidian reference profiles", () => {
  it("maps only the four runtime-proven cache grammars and preserves raw syntax", async () => {
    const content = [
      "[[Wiki Note|wiki]]",
      "![[image.png|200]]",
      "[guide](Guides/My%20Guide.md \"title\")",
      "![alt](<Assets/my image.png>)",
    ].join("\n");
    const originals = [
      "[[Wiki Note|wiki]]",
      "![[image.png|200]]",
      "[guide](Guides/My%20Guide.md \"title\")",
      "![alt](<Assets/my image.png>)",
    ];
    let offset = 0;
    const references = originals.map((original) => {
      const start = offset;
      offset += original.length + 1;
      return { original, start, end: start + original.length };
    });
    const files = [{ path: "Source.md" }];
    const dataSource = createObsidianSearchDataSource({
      markdownFiles: () => files,
      readBinary: async () => new TextEncoder().encode(content),
      fileCache: () => ({
        frontmatter: { status: "active" },
        tags: [{ tag: "#runtime", position: position(0, 1) }],
        headings: [{ heading: "Profiles", level: 2, position: position(0, 1) }],
        links: [
          {
            link: "Wiki Note",
            original: originals[0]!,
            position: position(references[0]!.start, references[0]!.end),
          },
          {
            link: "Guides/My%20Guide.md",
            original: originals[2]!,
            position: position(references[2]!.start, references[2]!.end),
          },
        ],
        embeds: [
          {
            link: "image.png",
            original: originals[1]!,
            position: position(references[1]!.start, references[1]!.end),
          },
          {
            link: "Assets/my image.png",
            original: originals[3]!,
            position: position(references[3]!.start, references[3]!.end),
          },
        ],
      }),
      resolveLink: (target) => ({
        "Wiki Note": "Wiki Note.md",
        "Guides/My%20Guide.md": "Guides/My Guide.md",
        "image.png": "image.png",
        "Assets/my image.png": "Assets/my image.png",
      })[target] ?? null,
      candidatePaths: (target) => ({
        "Wiki Note": ["Wiki Note.md"],
        "Guides/My%20Guide.md": ["Guides/My Guide.md"],
        "image.png": ["image.png"],
        "Assets/my image.png": ["Assets/my image.png"],
      })[target] ?? [],
      validSubpath: () => true,
      resolvedLinks: () => ({ "Source.md": { "Wiki Note.md": 1 } }),
      unresolvedLinks: () => ({ "Source.md": { Missing: 1 } }),
      parseFrontmatter: () => ({ status: "active" }),
      allTags: () => ["#runtime"],
    });
    const snapshots = new SearchSnapshotManager(dataSource);

    await snapshots.rebuild();

    expect(snapshots.current()?.notes[0]).toMatchObject({
      frontmatter: { status: "active" },
      tags: ["#runtime"],
      headings: [{ heading: "Profiles", level: 2 }],
      references: [
        { profile: "wikilink", target: "Wiki Note", original: originals[0] },
        { profile: "embed", target: "image.png", original: originals[1] },
        {
          profile: "markdown_inline_link",
          target: "Guides/My%20Guide.md",
          original: originals[2],
        },
        {
          profile: "markdown_embed",
          target: "Assets/my image.png",
          original: originals[3],
        },
      ],
      resolvedLinks: { "Wiki Note.md": 1 },
      unresolvedLinks: { Missing: 1 },
    });
  });

  it("fails closed when installed cache evidence claims an unregistered grammar", async () => {
    const original = "Wiki Note";
    const dataSource = createObsidianSearchDataSource({
      markdownFiles: () => [{ path: "Source.md" }],
      readBinary: async () => new TextEncoder().encode(original),
      fileCache: () => ({
        links: [{
          link: "Wiki Note",
          original,
          position: position(0, original.length),
        }],
      }),
      resolveLink: () => "Wiki Note.md",
      candidatePaths: () => ["Wiki Note.md"],
      validSubpath: () => true,
      resolvedLinks: () => ({}),
      unresolvedLinks: () => ({}),
      parseFrontmatter: () => null,
      allTags: () => [],
    });

    await expect(new SearchSnapshotManager(dataSource).rebuild())
      .rejects.toThrow("registered reference grammar");
  });

  it("independently enumerates path, basename, and installed aliases", () => {
    const files = [
      { path: "Area/Alpha.md", basename: "Alpha", aliases: ["Team"] },
      { path: "Archive/Bravo.md", basename: "Bravo", aliases: ["Team"] },
      { path: "Area/Plan.md", basename: "Plan", aliases: [] },
    ];

    expect(enumerateCanonicalReferenceTargets("Team", files)).toEqual([
      "Archive/Bravo.md",
      "Area/Alpha.md",
    ]);
    expect(enumerateCanonicalReferenceTargets("Plan", files)).toEqual([
      "Area/Plan.md",
    ]);
    expect(enumerateCanonicalReferenceTargets("Area/Plan", files)).toEqual([
      "Area/Plan.md",
    ]);
    expect(enumerateCanonicalReferenceTargets("../Area/Plan", files, "Projects/Source.md"))
      .toEqual(["Area/Plan.md"]);
    expect(enumerateCanonicalReferenceTargets("", files, "Area/Plan.md")).toEqual([
      "Area/Plan.md",
    ]);
  });

  it("rejects duplicate headings and unregistered block IDs", () => {
    expect(isRegisteredSubpathResult(
      "#Design",
      { type: "heading", heading: "Design" },
      ["Design", "Design"],
    )).toBe(false);
    expect(isRegisteredSubpathResult(
      "#Design",
      { type: "heading", heading: "Design" },
      ["Design"],
    )).toBe(true);
    expect(isRegisteredSubpathResult(
      "#^block-1",
      { type: "block", id: "block-1" },
      [],
    )).toBe(true);
    expect(isRegisteredSubpathResult(
      "#^区块",
      { type: "block", id: "区块" },
      [],
    )).toBe(false);
    expect(isRegisteredSubpathResult(
      "#footnote",
      { type: "footnote" },
      [],
    )).toBe(false);
  });

  it("rejects ambiguous installed targets and invalid fragments", async () => {
    const build = (target: string, options: {
      candidates: string[];
      resolved: string | null;
      validSubpath: boolean;
    }) => {
      const original = `[[${target}]]`;
      return new SearchSnapshotManager(createObsidianSearchDataSource({
        markdownFiles: () => [{ path: "Source.md" }],
        readBinary: async () => new TextEncoder().encode(original),
        fileCache: () => ({
          links: [{
            link: target,
            original,
            position: position(0, original.length),
          }],
        }),
        resolveLink: () => options.resolved,
        candidatePaths: () => options.candidates,
        validSubpath: () => options.validSubpath,
        resolvedLinks: () => ({}),
        unresolvedLinks: () => ({}),
        parseFrontmatter: () => null,
        allTags: () => [],
      }));
    };

    await expect(build("Plan", {
      candidates: ["Area/Plan.md", "Archive/Plan.md"],
      resolved: "Area/Plan.md",
      validSubpath: true,
    }).rebuild()).rejects.toThrow("unique canonical target");
    await expect(build("Plan#Missing", {
      candidates: ["Area/Plan.md"],
      resolved: "Area/Plan.md",
      validSubpath: false,
    }).rebuild()).rejects.toThrow("invalid reference fragment");
  });

  it("keeps zero-candidate links as reference and unresolved graph evidence", async () => {
    const original = "[[Missing]]";
    const snapshots = new SearchSnapshotManager(createObsidianSearchDataSource({
      markdownFiles: () => [{ path: "Source.md" }],
      readBinary: async () => new TextEncoder().encode(original),
      fileCache: () => ({
        links: [{
          link: "Missing",
          original,
          position: position(0, original.length),
        }],
      }),
      resolveLink: () => null,
      candidatePaths: () => [],
      validSubpath: () => false,
      resolvedLinks: () => ({}),
      unresolvedLinks: () => ({ "Source.md": { Missing: 1 } }),
      parseFrontmatter: () => null,
      allTags: () => [],
    }));

    await snapshots.rebuild();

    expect(snapshots.current()?.notes[0]).toMatchObject({
      references: [{
        profile: "wikilink",
        target: "Missing",
        resolvedPath: null,
        original,
        startByte: 0,
        endByteExclusive: original.length,
      }],
      unresolvedLinks: { Missing: 1 },
    });
  });

  it("renders destination components without normalizing registered syntax", () => {
    expect(renderRegisteredReference(
      "wikilink",
      "[[Old Note#Heading|label]]",
      "New Note#Heading",
    )).toBe("[[New Note#Heading|label]]");
    expect(renderRegisteredReference(
      "embed",
      "![[old image.png|200]]",
      "new image.png",
    )).toBe("![[new image.png|200]]");
    expect(renderRegisteredReference(
      "markdown_inline_link",
      "[guide](old%20path.md \"title\")",
      "new path.md",
    )).toBe("[guide](new%20path.md \"title\")");
    expect(renderRegisteredReference(
      "markdown_inline_link",
      "[guide](old.md)",
      "renamed 100%.md",
    )).toBe("[guide](renamed%20100%25.md)");
    expect(renderRegisteredReference(
      "markdown_embed",
      "![alt](<old image.png>)",
      "new image.png",
    )).toBe("![alt](<new image.png>)");
    expect(() => renderRegisteredReference(
      "markdown_embed",
      "![alt](old.png)",
      "new.png#fragment",
    )).toThrow("literal #");
  });
});
