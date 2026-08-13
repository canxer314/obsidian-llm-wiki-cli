import { createHash } from "node:crypto";
import { TextDecoder } from "node:util";

import { isCanonicalVaultPath } from "./canonical-vault-path.js";

export const REGISTERED_REFERENCE_PROFILES = [
  "wikilink",
  "embed",
  "markdown_inline_link",
  "markdown_embed",
] as const;

export type RegisteredReferenceProfile =
  (typeof REGISTERED_REFERENCE_PROFILES)[number];

export interface HostLocation {
  line: number;
  col: number;
  offset: number;
}

export interface HostPosition {
  start: HostLocation;
  end: HostLocation;
}

export interface HostReferenceEvidence {
  profile: RegisteredReferenceProfile;
  target: string;
  resolvedPath: string | null;
  original: string;
  position: HostPosition;
}

export interface SearchSnapshotSemanticEvidence {
  contentVersion?: string;
  frontmatter: Record<string, unknown> | null;
  tags: string[];
  headings: Array<{ heading: string; level: number }>;
  references: HostReferenceEvidence[];
  resolvedLinks: Record<string, number>;
  unresolvedLinks: Record<string, number>;
}

export interface SearchSnapshotDataSource {
  listMarkdownPaths(): Promise<string[]>;
  readBinary(path: string): Promise<ArrayBuffer | Uint8Array | null>;
  semanticEvidence?(path: string): Promise<SearchSnapshotSemanticEvidence | null>;
}

export interface SearchSnapshotReference {
  readonly profile: RegisteredReferenceProfile;
  readonly target: string;
  readonly resolvedPath: string | null;
  readonly original: string;
  readonly startByte: number;
  readonly endByteExclusive: number;
}

export interface SearchSnapshotNote {
  readonly path: string;
  readonly filename: string;
  readonly bytes: Uint8Array;
  readonly content: string;
  readonly contentVersion: string;
  readonly semanticContentVersion?: string;
  readonly sizeBytes: number;
  readonly frontmatter: Readonly<Record<string, unknown>> | null;
  readonly tags: readonly string[];
  readonly headings: readonly Readonly<{ heading: string; level: number }>[];
  readonly references: readonly SearchSnapshotReference[];
  readonly resolvedLinks: Readonly<Record<string, number>>;
  readonly unresolvedLinks: Readonly<Record<string, number>>;
}

export interface SearchSnapshot {
  readonly version: number;
  readonly notes: readonly SearchSnapshotNote[];
}

export type SearchSnapshotReadiness = "ready" | "building" | "unavailable";

const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const encoder = new TextEncoder();
const registeredProfiles = new Set<string>(REGISTERED_REFERENCE_PROFILES);

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function compareCanonicalPaths(left: string, right: string): number {
  const folded = compareUtf8(
    left.toLocaleLowerCase("en"),
    right.toLocaleLowerCase("en"),
  );
  return folded || compareUtf8(left, right);
}

function isCanonicalMarkdownPath(path: string): boolean {
  return path.endsWith(".md") && isCanonicalVaultPath(path);
}

function isJsonValue(value: unknown): boolean {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (typeof value !== "object") return false;
  return Object.values(value as Record<string, unknown>).every(isJsonValue);
}

function cloneAndFreezeJsonObject(
  value: Record<string, unknown> | null,
): Readonly<Record<string, unknown>> | null {
  if (value === null) return null;
  if (!isJsonValue(value)) throw new Error("Search Snapshot Frontmatter is inconsistent");
  const clone = structuredClone(value);
  const freeze = (current: unknown): void => {
    if (typeof current !== "object" || current === null) return;
    for (const child of Object.values(current)) freeze(child);
    Object.freeze(current);
  };
  freeze(clone);
  return clone;
}

function lineColumnOffset(content: string, location: HostLocation): number | null {
  if (
    !Number.isInteger(location.line) ||
    !Number.isInteger(location.col) ||
    location.line < 0 ||
    location.col < 0
  ) return null;
  let line = 0;
  let start = 0;
  while (line < location.line) {
    const newline = content.indexOf("\n", start);
    if (newline < 0) return null;
    start = newline + 1;
    line += 1;
  }
  let end = content.indexOf("\n", start);
  if (end < 0) end = content.length;
  if (end > start && content[end - 1] === "\r") end -= 1;
  const offset = start + location.col;
  return offset <= end ? offset : null;
}

function locationCandidates(content: string, location: HostLocation): number[] {
  const candidates = new Set<number>();
  if (
    Number.isInteger(location.offset) &&
    location.offset >= 0 &&
    location.offset <= content.length
  ) candidates.add(location.offset);
  const lineColumn = lineColumnOffset(content, location);
  if (lineColumn !== null) candidates.add(lineColumn);
  return [...candidates];
}

function hasUtf16Boundary(content: string, offset: number): boolean {
  if (offset <= 0 || offset >= content.length) return true;
  const previous = content.charCodeAt(offset - 1);
  const current = content.charCodeAt(offset);
  return !(previous >= 0xd800 && previous <= 0xdbff && current >= 0xdc00 && current <= 0xdfff);
}

function locateReference(
  bytes: Uint8Array,
  decoded: string,
  reference: HostReferenceEvidence,
): SearchSnapshotReference {
  if (!registeredProfiles.has(reference.profile)) {
    throw new Error("Search Snapshot reference profile is not registered");
  }
  if (
    reference.target.length === 0 ||
    reference.original.length === 0 ||
    (reference.resolvedPath !== null && !isCanonicalVaultPath(reference.resolvedPath))
  ) throw new Error("Search Snapshot reference evidence is inconsistent");

  const hasBom = decoded.startsWith("﻿");
  const hostContent = hasBom ? decoded.slice(1) : decoded;
  const byteBase = hasBom ? 3 : 0;
  const spans = new Map<string, { startByte: number; endByteExclusive: number }>();
  for (const start of locationCandidates(hostContent, reference.position.start)) {
    for (const end of locationCandidates(hostContent, reference.position.end)) {
      if (
        start >= end ||
        !hasUtf16Boundary(hostContent, start) ||
        !hasUtf16Boundary(hostContent, end) ||
        hostContent.slice(start, end) !== reference.original
      ) continue;
      const startByte = byteBase + Buffer.byteLength(hostContent.slice(0, start), "utf8");
      const endByteExclusive = byteBase + Buffer.byteLength(hostContent.slice(0, end), "utf8");
      const rawSlice = bytes.slice(startByte, endByteExclusive);
      if (!Buffer.from(rawSlice).equals(Buffer.from(encoder.encode(reference.original)))) continue;
      spans.set(`${startByte}:${endByteExclusive}`, { startByte, endByteExclusive });
    }
  }
  if (spans.size !== 1) {
    throw new Error("Search Snapshot reference span is not uniquely verified");
  }
  const span = [...spans.values()][0]!;
  return Object.freeze({
    profile: reference.profile,
    target: reference.target,
    resolvedPath: reference.resolvedPath,
    original: reference.original,
    ...span,
  });
}

function freezeLinkCounts(
  links: Record<string, number>,
  resolved: boolean,
): Readonly<Record<string, number>> {
  const frozen: Record<string, number> = {};
  for (const [target, count] of Object.entries(links)) {
    if (
      target.length === 0 ||
      (resolved && !isCanonicalVaultPath(target)) ||
      !Number.isInteger(count) ||
      count < 1
    ) throw new Error("Search Snapshot link graph is inconsistent");
    frozen[target] = count;
  }
  return Object.freeze(frozen);
}

function freezeSemanticEvidence(
  bytes: Uint8Array,
  decoded: string,
  evidence: SearchSnapshotSemanticEvidence | null | undefined,
): Pick<
  SearchSnapshotNote,
  "frontmatter" | "tags" | "headings" | "references" | "resolvedLinks" | "unresolvedLinks"
> {
  if (evidence === null || evidence === undefined) {
    return {
      frontmatter: null,
      tags: Object.freeze([]),
      headings: Object.freeze([]),
      references: Object.freeze([]),
      resolvedLinks: Object.freeze({}),
      unresolvedLinks: Object.freeze({}),
    };
  }
  if (
    evidence.tags.some((tag) => !/^#[^\s#]+$/u.test(tag)) ||
    evidence.headings.some(({ heading, level }) =>
      typeof heading !== "string" || !Number.isInteger(level) || level < 1 || level > 6)
  ) throw new Error("Search Snapshot semantic evidence is inconsistent");
  return {
    frontmatter: cloneAndFreezeJsonObject(evidence.frontmatter),
    tags: Object.freeze([...new Set(evidence.tags)]),
    headings: Object.freeze(evidence.headings.map((heading) => Object.freeze({ ...heading }))),
    references: Object.freeze(
      evidence.references
        .map((reference) => locateReference(bytes, decoded, reference))
        .sort((left, right) => left.startByte - right.startByte),
    ),
    resolvedLinks: freezeLinkCounts(evidence.resolvedLinks, true),
    unresolvedLinks: freezeLinkCounts(evidence.unresolvedLinks, false),
  };
}

async function freezeNote(
  dataSource: SearchSnapshotDataSource,
  path: string,
  raw: ArrayBuffer | Uint8Array,
): Promise<SearchSnapshotNote> {
  const source = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
  const capturedBytes = Uint8Array.from(source);
  const content = decoder.decode(capturedBytes);
  const contentVersion = `sha256:${createHash("sha256").update(capturedBytes).digest("hex")}`;
  const rawSemantic = dataSource.semanticEvidence === undefined
    ? undefined
    : await dataSource.semanticEvidence(path);
  if (dataSource.semanticEvidence !== undefined && rawSemantic === null) {
    throw new Error("Search Snapshot semantic evidence is unavailable");
  }
  const semantic = freezeSemanticEvidence(
    capturedBytes,
    content,
    rawSemantic,
  );
  const semanticContentVersion = rawSemantic?.contentVersion;
  const note = {
    path,
    filename: path.slice(path.lastIndexOf("/") + 1),
    get bytes() {
      return Uint8Array.from(capturedBytes);
    },
    content,
    contentVersion,
    ...(semanticContentVersion === undefined
      ? {}
      : { semanticContentVersion }),
    sizeBytes: capturedBytes.byteLength,
    ...semantic,
  };
  return Object.freeze(note);
}

export const SEARCH_SNAPSHOT_QUIET_WINDOW_MS = 250;

export class SearchSnapshotManager {
  readonly #dataSource: SearchSnapshotDataSource;
  #current: SearchSnapshot | undefined;
  #version = 0;
  #generation = 0;
  #readiness: SearchSnapshotReadiness = "unavailable";
  #buildTail: Promise<void> = Promise.resolve();

  constructor(dataSource: SearchSnapshotDataSource) {
    this.#dataSource = dataSource;
  }

  get readiness(): SearchSnapshotReadiness {
    return this.#readiness;
  }

  current(): SearchSnapshot | undefined {
    return this.#current;
  }

  invalidate(): void {
    this.#generation += 1;
    this.#readiness = "building";
  }

  rebuild(dataSource: SearchSnapshotDataSource = this.#dataSource): Promise<void> {
    const generation = this.#generation;
    this.#readiness = "building";
    const build = this.#buildTail.then(() => this.#rebuild(dataSource, generation));
    this.#buildTail = build.catch(() => undefined);
    return build;
  }

  async #rebuild(
    dataSource: SearchSnapshotDataSource,
    generation: number,
  ): Promise<void> {
    this.#readiness = "building";

    try {
      const paths = await dataSource.listMarkdownPaths();
      const uniquePaths = new Set(paths);
      if (uniquePaths.size !== paths.length || paths.some((path) => !isCanonicalMarkdownPath(path))) {
        throw new Error("Search Snapshot source is inconsistent");
      }
      const notes = await Promise.all(
        [...uniquePaths].map(async (path) => {
          const bytes = await dataSource.readBinary(path);
          if (bytes === null) throw new Error("Search Snapshot source is inconsistent");
          return freezeNote(dataSource, path, bytes);
        }),
      );
      notes.sort((left, right) => compareCanonicalPaths(left.path, right.path));
      if (generation !== this.#generation) return;
      const publication = Object.freeze({
        version: this.#version + 1,
        notes: Object.freeze(notes),
      });
      this.#version = publication.version;
      this.#current = publication;
      this.#readiness = "ready";
    } catch (error) {
      if (generation === this.#generation) this.#readiness = "unavailable";
      throw error;
    }
  }
}

export class SearchSnapshotRefreshCoordinator {
  readonly #manager: SearchSnapshotManager;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #builds: Promise<void> = Promise.resolve();
  #waiters: Array<{ resolve(): void; reject(error: unknown): void }> = [];

  constructor(manager: SearchSnapshotManager) {
    this.#manager = manager;
  }

  schedule(): void {
    this.#manager.invalidate();
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      const waiters = this.#waiters.splice(0);
      const build = this.#builds.then(() => this.#manager.rebuild());
      this.#builds = build.catch(() => undefined);
      void build.then(
        () => waiters.forEach(({ resolve }) => resolve()),
        (error) => waiters.forEach(({ reject }) => reject(error)),
      );
    }, SEARCH_SNAPSHOT_QUIET_WINDOW_MS);
    this.#timer.unref?.();
  }

  async whenIdle(): Promise<void> {
    do {
      if (this.#timer === undefined) {
        await this.#builds;
      } else {
        await new Promise<void>((resolve, reject) => {
          this.#waiters.push({ resolve, reject });
        });
      }
    } while (this.#timer !== undefined);
    await this.#builds;
  }

  dispose(): void {
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = undefined;
  }
}

export { compareCanonicalPaths };
