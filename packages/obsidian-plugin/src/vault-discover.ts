import { randomUUID } from "node:crypto";

import {
  parseDiscoverInput,
  parseDiscoverResult,
  type DiscoverInput,
  type DiscoverItem,
  type DiscoverQuery,
  type DiscoverResult,
} from "@llm-wiki/vault-contracts";

import {
  compareCanonicalPaths,
  SearchSnapshotManager,
  type SearchSnapshotNote,
} from "./search-snapshot.js";

interface FrozenDiscovery {
  readonly clientId: string;
  readonly items: readonly DiscoverItem[];
  readonly direction: "asc" | "desc";
  readonly retainedBytes: number;
  offset: number;
  expiresAt: number;
}

export interface VaultDiscoverServiceOptions {
  createToken?: () => string;
  now?: () => number;
}

const DISCOVERY_CONTINUATION_LIFETIME_MS = 15 * 60 * 1_000;
const MAX_ACTIVE_CONTINUATIONS_PER_CLIENT = 8;
const MAX_RETAINED_BYTES_PER_CLIENT = 8 * 1024 * 1024;

function compareText(left: string, right: string, caseSensitive: boolean): boolean {
  return caseSensitive
    ? left === right
    : left.localeCompare(right, "en", { sensitivity: "base" }) === 0;
}

function containsText(content: string, search: string, caseSensitive: boolean): boolean {
  if (caseSensitive) return content.includes(search);
  return content.toLocaleLowerCase("en").includes(search.toLocaleLowerCase("en"));
}

function pathGlobMatches(path: string, glob: string): boolean {
  let expression = "";
  for (let index = 0; index < glob.length; index += 1) {
    const character = glob[index]!;
    if (character === "*" && glob[index + 1] === "*") {
      const startsDirectorySegment = index === 0 || glob[index - 1] === "/";
      if (startsDirectorySegment && glob[index + 2] === "/") {
        expression += "(?:[^/]+/)*";
        index += 2;
      } else {
        expression += ".*";
        index += 1;
      }
    } else if (character === "*") {
      expression += "[^/]*";
    } else if (character === "?") {
      expression += "[^/]";
    } else {
      expression += character.replace(/[.+^${}()|[\]\\]/gu, "\\$&");
    }
  }
  return new RegExp(`^${expression}$`, "u").test(path);
}

function jsonValuesEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((value, index) =>
      jsonValuesEqual(value, right[index]));
  }
  if (
    typeof left !== "object" || left === null ||
    typeof right !== "object" || right === null ||
    Array.isArray(left) || Array.isArray(right)
  ) return false;
  const leftEntries = Object.entries(left as Record<string, unknown>);
  const rightObject = right as Record<string, unknown>;
  return leftEntries.length === Object.keys(rightObject).length &&
    leftEntries.every(([key, value]) =>
      Object.hasOwn(rightObject, key) && jsonValuesEqual(value, rightObject[key]));
}

function graphReaches(
  notesByPath: ReadonlyMap<string, SearchSnapshotNote>,
  from: string,
  to: string,
  maxDepth: number,
): boolean {
  let frontier = [from];
  const visited = new Set(frontier);
  for (let depth = 1; depth <= maxDepth; depth += 1) {
    const next: string[] = [];
    for (const path of frontier) {
      const note = notesByPath.get(path);
      if (note === undefined) continue;
      for (const target of Object.keys(note.resolvedLinks)) {
        if (target === to) return true;
        if (!visited.has(target)) {
          visited.add(target);
          next.push(target);
        }
      }
    }
    frontier = next;
    if (frontier.length === 0) return false;
  }
  return false;
}

function queryMatches(
  note: SearchSnapshotNote,
  query: DiscoverQuery,
  notesByPath: ReadonlyMap<string, SearchSnapshotNote>,
): boolean {
  if ("all" in query) return query.all.every((child) =>
    queryMatches(note, child, notesByPath));
  if ("any" in query) return query.any.some((child) =>
    queryMatches(note, child, notesByPath));
  if ("not" in query) return !queryMatches(note, query.not, notesByPath);
  if ("path" in query) {
    if ("exact" in query.path) return note.path === query.path.exact;
    if ("prefix" in query.path) return note.path.startsWith(query.path.prefix);
    return pathGlobMatches(note.path, query.path.glob);
  }
  if ("filename" in query) {
    if ("exact" in query.filename) {
      return compareText(note.filename, query.filename.exact, query.filename.caseSensitive);
    }
    return containsText(
      note.filename,
      query.filename.substring,
      query.filename.caseSensitive,
    );
  }
  if ("text" in query) {
    if ("literal" in query.text) {
      return containsText(note.content, query.text.literal, query.text.caseSensitive);
    }
    return new RegExp(query.text.regex, query.text.caseSensitive ? "gu" : "giu").test(
      note.content,
    );
  }
  if ("frontmatter" in query) {
    const frontmatter = note.frontmatter;
    const hasKey = frontmatter !== null && Object.hasOwn(frontmatter, query.frontmatter.key);
    if ("exists" in query.frontmatter) return hasKey === query.frontmatter.exists;
    if (!hasKey) return false;
    const value = frontmatter[query.frontmatter.key];
    if ("equals" in query.frontmatter) {
      return jsonValuesEqual(value, query.frontmatter.equals);
    }
    if ("contains" in query.frontmatter) {
      const containedValue = query.frontmatter.contains;
      return Array.isArray(value) && value.some((item) =>
        jsonValuesEqual(item, containedValue));
    }
    return false;
  }
  if ("tag" in query) return note.tags.includes(query.tag.exact);
  if ("reference" in query) {
    return note.references.some(({ profile, target }) =>
      profile === query.reference.profile && target === query.reference.target);
  }
  if ("backlink" in query) {
    return Object.hasOwn(notesByPath.get(query.backlink.from)?.resolvedLinks ?? {}, note.path);
  }
  if ("unresolvedLink" in query) {
    return Object.hasOwn(note.unresolvedLinks, query.unresolvedLink.target);
  }
  const from = query.graph.relation === "links_to" ? note.path : query.graph.path;
  const to = query.graph.relation === "links_to" ? query.graph.path : note.path;
  return graphReaches(notesByPath, from, to, query.graph.maxDepth);
}

function textQueries(query: DiscoverQuery): DiscoverQuery[] {
  if ("all" in query) return query.all.flatMap(textQueries);
  if ("any" in query) return query.any.flatMap(textQueries);
  if ("not" in query) return [];
  return "text" in query ? [query] : [];
}

function utf8ByteOffset(content: string, utf16Offset: number): number {
  return Buffer.byteLength(content.slice(0, utf16Offset), "utf8");
}

function lineAt(content: string, utf16Offset: number): number {
  const preceding = content.slice(0, utf16Offset);
  return preceding.split(/\r\n|\r|\n/u).length;
}

function collectMatches(note: SearchSnapshotNote, query: DiscoverQuery): NonNullable<DiscoverItem["matches"]> {
  const matches: NonNullable<DiscoverItem["matches"]> = [];
  for (const textQuery of textQueries(query)) {
    if (!("text" in textQuery)) continue;
    const pattern =
      "literal" in textQuery.text
        ? textQuery.text.literal.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")
        : textQuery.text.regex;
    const expression = new RegExp(
      pattern,
      textQuery.text.caseSensitive ? "gu" : "giu",
    );
    for (const match of note.content.matchAll(expression)) {
      if (match.index === undefined || match[0].length === 0) continue;
      const startByte = utf8ByteOffset(note.content, match.index);
      matches.push({
        line: lineAt(note.content, match.index),
        startByte,
        endByteExclusive: startByte + Buffer.byteLength(match[0], "utf8"),
        text: match[0],
      });
    }
  }
  matches.sort((left, right) => left.startByte - right.startByte);
  return matches.filter(
    (match, index) =>
      index === 0 ||
      match.startByte !== matches[index - 1]?.startByte ||
      match.endByteExclusive !== matches[index - 1]?.endByteExclusive,
  );
}

function freezeItem(note: SearchSnapshotNote, input: DiscoverInput): DiscoverItem {
  const item: DiscoverItem = {
    path: note.path,
    contentVersion: note.contentVersion,
    sizeBytes: note.sizeBytes,
  };
  if (input.projection.matches) item.matches = collectMatches(note, input.query);
  if (input.projection.outline) item.outline = note.headings.map((heading) => ({ ...heading }));
  if (input.projection.frontmatter) {
    item.frontmatter = note.frontmatter === null
      ? null
      : structuredClone(note.frontmatter);
  }
  if (input.projection.references) {
    item.references = note.references.map((reference) => ({ ...reference }));
  }
  return Object.freeze(item);
}

export class VaultDiscoverService {
  readonly #snapshots: SearchSnapshotManager;
  readonly #createToken: () => string;
  readonly #now: () => number;
  readonly #continuations = new Map<string, FrozenDiscovery>();
  readonly #expiryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  #tokenSequence = 0;

  constructor(
    snapshots: SearchSnapshotManager,
    options: VaultDiscoverServiceOptions = {},
  ) {
    this.#snapshots = snapshots;
    this.#createToken = options.createToken ?? randomUUID;
    this.#now = options.now ?? Date.now;
  }

  releaseClient(clientId: string): void {
    for (const [token, frozen] of this.#continuations) {
      if (frozen.clientId === clientId) this.#releaseContinuation(token);
    }
  }

  async execute(rawInput: unknown, clientId: string): Promise<DiscoverResult> {
    const input = parseDiscoverInput(rawInput);
    const now = this.#now();
    this.#releaseExpired(now);
    const token = input.page.continuation;
    if (token !== null) {
      const frozen = this.#continuations.get(token);
      if (
        frozen === undefined ||
        frozen.clientId !== clientId ||
        frozen.expiresAt <= now
      ) {
        return parseDiscoverResult({
          outcome: "snapshot_unavailable",
          code: "search_snapshot_unavailable",
        });
      }
      this.#releaseContinuation(token);
      frozen.expiresAt = now + DISCOVERY_CONTINUATION_LIFETIME_MS;
      return this.#consumePage(frozen, input.page.maxItems);
    }

    if (this.#snapshots.readiness !== "ready") {
      return parseDiscoverResult({
        outcome: "snapshot_unavailable",
        code: "search_snapshot_unavailable",
      });
    }
    const snapshot = this.#snapshots.current();
    if (snapshot === undefined) {
      return parseDiscoverResult({
        outcome: "snapshot_unavailable",
        code: "search_snapshot_unavailable",
      });
    }
    const notesByPath = new Map(snapshot.notes.map((note) => [note.path, note]));
    const items = snapshot.notes
      .filter((note) => queryMatches(note, input.query, notesByPath))
      .map((note) => freezeItem(note, input));
    items.sort((left, right) => {
      const compared = compareCanonicalPaths(left.path, right.path);
      return input.order.direction === "asc" ? compared : -compared;
    });
    return this.#consumePage(
      {
        clientId,
        items: Object.freeze(items),
        direction: input.order.direction,
        retainedBytes: Buffer.byteLength(JSON.stringify(items), "utf8"),
        offset: 0,
        expiresAt: now + DISCOVERY_CONTINUATION_LIFETIME_MS,
      },
      input.page.maxItems,
    );
  }

  #consumePage(frozen: FrozenDiscovery, maxItems: number): DiscoverResult {
    const end = Math.min(frozen.offset + maxItems, frozen.items.length);
    const complete = end === frozen.items.length;
    const quota = this.#clientQuota(frozen.clientId);
    if (
      !complete &&
      (
        quota.activeContinuations >= MAX_ACTIVE_CONTINUATIONS_PER_CLIENT ||
        quota.retainedBytes + frozen.retainedBytes > MAX_RETAINED_BYTES_PER_CLIENT
      )
    ) {
      return parseDiscoverResult({
        outcome: "snapshot_unavailable",
        code: "search_snapshot_unavailable",
      });
    }
    const items = frozen.items.slice(frozen.offset, end);
    frozen.offset = end;
    const continuation = complete ? null : this.#uniqueToken();
    if (continuation !== null) {
      this.#continuations.set(continuation, frozen);
      const expiryTimer = setTimeout(() => {
        this.#continuations.delete(continuation);
        this.#expiryTimers.delete(continuation);
      }, DISCOVERY_CONTINUATION_LIFETIME_MS);
      expiryTimer.unref?.();
      this.#expiryTimers.set(continuation, expiryTimer);
    }
    return parseDiscoverResult({
      outcome: "results",
      ordering: {
        by: "path",
        direction: frozen.direction,
        tieBreaker: "path_utf8_bytes",
      },
      items,
      complete,
      continuation,
    });
  }

  #clientQuota(clientId: string): {
    activeContinuations: number;
    retainedBytes: number;
  } {
    let activeContinuations = 0;
    let retainedBytes = 0;
    for (const frozen of this.#continuations.values()) {
      if (frozen.clientId !== clientId) continue;
      activeContinuations += 1;
      retainedBytes += frozen.retainedBytes;
    }
    return { activeContinuations, retainedBytes };
  }

  #releaseContinuation(token: string): void {
    this.#continuations.delete(token);
    const expiryTimer = this.#expiryTimers.get(token);
    if (expiryTimer !== undefined) clearTimeout(expiryTimer);
    this.#expiryTimers.delete(token);
  }

  #uniqueToken(): string {
    this.#tokenSequence += 1;
    return `${this.#createToken()}:${this.#tokenSequence.toString(36)}`;
  }

  #releaseExpired(now: number): void {
    for (const [token, frozen] of this.#continuations) {
      if (frozen.expiresAt <= now) this.#releaseContinuation(token);
    }
  }
}
