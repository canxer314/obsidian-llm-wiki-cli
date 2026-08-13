import { posix } from "node:path";

import { isCanonicalVaultPath } from "./canonical-vault-path.js";
import type {
  HostReferenceEvidence,
  RegisteredReferenceProfile,
  SearchSnapshotDataSource,
} from "./search-snapshot.js";

interface CacheLocation {
  line: number;
  col: number;
  offset: number;
}

interface CacheReference {
  link: string;
  original: string;
  position: { start: CacheLocation; end: CacheLocation };
}

interface CacheTag {
  tag: string;
}

interface CacheHeading {
  heading: string;
  level: number;
}

interface InstalledFileCache {
  frontmatter?: Record<string, unknown>;
  tags?: CacheTag[];
  headings?: CacheHeading[];
  links?: CacheReference[];
  embeds?: CacheReference[];
}

export interface ObsidianSearchAdapter {
  markdownFiles(): Array<{ path: string }>;
  readBinary(path: string): Promise<ArrayBuffer | Uint8Array>;
  fileCache(path: string): InstalledFileCache | null;
  resolveLink(target: string, sourcePath: string): string | null;
  candidatePaths(target: string, sourcePath: string): string[];
  validSubpath(target: string, resolvedPath: string): boolean;
  resolvedLinks(): Record<string, Record<string, number>>;
  unresolvedLinks(): Record<string, Record<string, number>>;
  parseFrontmatter(frontmatter: Record<string, unknown>): Record<string, unknown> | null;
  allTags(path: string): string[] | null;
}

function parseWikilink(
  original: string,
  embedded: boolean,
): { profile: RegisteredReferenceProfile; destination: string } | null {
  const prefix = embedded ? "![[" : "[[";
  if (!original.startsWith(prefix) || !original.endsWith("]]")) return null;
  const inner = original.slice(prefix.length, -2);
  const separator = inner.indexOf("|");
  const destination = separator < 0 ? inner : inner.slice(0, separator);
  if (destination.length === 0) return null;
  return { profile: embedded ? "embed" : "wikilink", destination };
}

interface ParsedMarkdownReference {
  profile: "markdown_inline_link" | "markdown_embed";
  destination: string;
  wrapped: boolean;
  destinationStart: number;
  destinationEnd: number;
}

function parseMarkdownReference(
  original: string,
  embedded: boolean,
): ParsedMarkdownReference | null {
  const prefix = embedded ? "![" : "[";
  if (!original.startsWith(prefix)) return null;
  const labelEnd = original.indexOf("](", prefix.length);
  if (labelEnd < 0 || !original.endsWith(")")) return null;
  const destinationStart = labelEnd + 2;
  if (original[destinationStart] === "<") {
    const wrapperEnd = original.indexOf(">", destinationStart + 1);
    if (wrapperEnd < 0) return null;
    const tail = original.slice(wrapperEnd + 1, -1);
    if (tail !== "" && !/^\s+(?:"[^"]*"|'[^']*'|\([^)]*\))$/u.test(tail)) return null;
    const destination = original.slice(destinationStart + 1, wrapperEnd);
    if (destination.length === 0) return null;
    return {
      profile: embedded ? "markdown_embed" : "markdown_inline_link",
      destination,
      wrapped: true,
      destinationStart: destinationStart + 1,
      destinationEnd: wrapperEnd,
    };
  }
  const body = original.slice(destinationStart, -1);
  const titleMatch = /\s+(?:"[^"]*"|'[^']*'|\([^)]*\))$/u.exec(body);
  const destination = titleMatch === null ? body : body.slice(0, titleMatch.index);
  if (destination.length === 0 || destination.includes(" ")) return null;
  return {
    profile: embedded ? "markdown_embed" : "markdown_inline_link",
    destination,
    wrapped: false,
    destinationStart,
    destinationEnd: destinationStart + destination.length,
  };
}

function classifyReference(reference: CacheReference): {
  profile: RegisteredReferenceProfile;
  target: string;
} {
  const original = reference.original;
  const parsed = original.startsWith("![[")
    ? parseWikilink(original, true)
    : original.startsWith("[[")
      ? parseWikilink(original, false)
      : original.startsWith("![")
        ? parseMarkdownReference(original, true)
        : original.startsWith("[")
          ? parseMarkdownReference(original, false)
          : null;
  if (parsed === null || parsed.destination !== reference.link) {
    throw new Error("Installed cache uses an unregistered reference grammar");
  }
  return { profile: parsed.profile, target: reference.link };
}

export interface CanonicalReferenceCandidate {
  path: string;
  basename: string;
  aliases: readonly string[];
}

export function enumerateCanonicalReferenceTargets(
  rawPath: string,
  files: readonly CanonicalReferenceCandidate[],
  sourcePath?: string,
): string[] {
  if (rawPath === "") {
    return sourcePath !== undefined &&
      isCanonicalVaultPath(sourcePath) &&
      files.some((file) => file.path === sourcePath)
      ? [sourcePath]
      : [];
  }
  let path: string;
  try {
    path = decodeURIComponent(rawPath);
  } catch {
    throw new Error("Registered reference has an invalid encoded target");
  }
  const sourceRelative = path.startsWith("./") || path.startsWith("../");
  if (sourceRelative) {
    if (sourcePath === undefined || !isCanonicalVaultPath(sourcePath)) return [];
    const resolved = posix.normalize(posix.join(posix.dirname(sourcePath), path));
    if (!isCanonicalVaultPath(resolved)) {
      throw new Error("Registered reference target is not canonical");
    }
    path = resolved;
  }
  if (!isCanonicalVaultPath(path)) {
    throw new Error("Registered reference target is not canonical");
  }
  const explicitPath = sourceRelative || path.includes("/");
  const candidates = files.filter((file) => {
    if (!isCanonicalVaultPath(file.path)) return false;
    if (explicitPath) {
      return file.path === path ||
        (file.path.endsWith(".md") && file.path.slice(0, -3) === path);
    }
    const name = file.path.slice(file.path.lastIndexOf("/") + 1);
    return name === path || file.basename === path || file.aliases.includes(path);
  }).map(({ path: candidate }) => candidate);
  return [...new Set(candidates)].sort((left, right) =>
    Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8")));
}

export type InstalledSubpathResult =
  | { type: "heading"; heading: string }
  | { type: "block"; id: string }
  | { type: "footnote" };

export function isRegisteredSubpathResult(
  subpath: string,
  resolved: InstalledSubpathResult,
  headings: readonly string[],
): boolean {
  if (resolved.type === "heading") {
    return subpath.startsWith("#") &&
      headings.filter((heading) => heading === resolved.heading).length === 1;
  }
  if (resolved.type === "block") {
    return subpath === `#^${resolved.id}` && /^[A-Za-z0-9-]+$/u.test(resolved.id);
  }
  return false;
}

function verifyResolvedTarget(
  target: string,
  sourcePath: string,
  adapter: ObsidianSearchAdapter,
): string | null {
  const installed = adapter.resolveLink(target, sourcePath);
  const candidates = [...new Set(adapter.candidatePaths(target, sourcePath))];
  if (installed === null && candidates.length === 0) return null;
  if (
    candidates.length !== 1 ||
    !isCanonicalVaultPath(candidates[0]!) ||
    installed !== candidates[0]
  ) {
    throw new Error("Registered reference must have one unique canonical target");
  }
  if (target.includes("#") && !adapter.validSubpath(target, candidates[0]!)) {
    throw new Error("Registered reference has an invalid reference fragment");
  }
  return installed;
}

function referenceEvidence(
  reference: CacheReference,
  sourcePath: string,
  adapter: ObsidianSearchAdapter,
): HostReferenceEvidence {
  const classified = classifyReference(reference);
  const resolvedPath = verifyResolvedTarget(reference.link, sourcePath, adapter);
  return {
    ...classified,
    resolvedPath,
    original: reference.original,
    position: {
      start: { ...reference.position.start },
      end: { ...reference.position.end },
    },
  };
}

export function createObsidianSearchDataSource(
  adapter: ObsidianSearchAdapter,
): SearchSnapshotDataSource {
  return {
    listMarkdownPaths: async () => adapter.markdownFiles().map(({ path }) => path),
    readBinary: (path) => adapter.readBinary(path),
    semanticEvidence: async (path) => {
      const cache = adapter.fileCache(path);
      if (cache === null) return null;
      const references = [
        ...(cache.links ?? []),
        ...(cache.embeds ?? []),
      ].map((reference) => referenceEvidence(reference, path, adapter));
      return {
        frontmatter: cache.frontmatter === undefined
          ? null
          : adapter.parseFrontmatter(cache.frontmatter),
        tags: adapter.allTags(path) ?? [],
        headings: (cache.headings ?? []).map(({ heading, level }) => ({ heading, level })),
        references,
        resolvedLinks: { ...(adapter.resolvedLinks()[path] ?? {}) },
        unresolvedLinks: { ...(adapter.unresolvedLinks()[path] ?? {}) },
      };
    },
  };
}

export function renderRegisteredReference(
  profile: RegisteredReferenceProfile,
  original: string,
  target: string,
  targetKind: "note" | "attachment" = "attachment",
): string {
  if (target.length === 0) throw new Error("Reference target must not be empty");
  if (
    targetKind === "attachment" &&
    (profile === "embed" || profile === "markdown_embed") &&
    target.includes("#")
  ) {
    throw new Error("Registered attachment profiles reject literal # targets");
  }
  if (profile === "wikilink" || profile === "embed") {
    const parsed = parseWikilink(original, profile === "embed");
    if (parsed === null || parsed.profile !== profile) {
      throw new Error("Original reference does not match its registered profile");
    }
    const prefixLength = profile === "embed" ? 3 : 2;
    const inner = original.slice(prefixLength, -2);
    const separator = inner.indexOf("|");
    const suffix = separator < 0 ? "" : inner.slice(separator);
    return `${profile === "embed" ? "![[" : "[["}${target}${suffix}]]`;
  }

  const parsed = parseMarkdownReference(original, profile === "markdown_embed");
  if (parsed === null || parsed.profile !== profile) {
    throw new Error("Original reference does not match its registered profile");
  }
  const renderedTarget = parsed.wrapped ? target : target.replaceAll(" ", "%20");
  return original.slice(0, parsed.destinationStart) +
    renderedTarget + original.slice(parsed.destinationEnd);
}
