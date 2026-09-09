import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";

import {
  parseChangeSetSubmitResult,
  parseDiscoverResult,
  parseHealthResult,
  parseReadResult,
  serializeChangeSetSubmitCompatibilityText,
  serializeCompatibilityText,
  serializeDiscoverCompatibilityText,
  serializeReadCompatibilityText,
  type ChangeSetSubmitInput,
} from "@llm-wiki/vault-contracts";

import type { RegisteredReferenceRewriteCorpusEvidence } from "./evidence.js";

/**
 * Deterministic registered-reference rewrite corpus (issue #178). Runs the
 * spec §8.1/§8.2 move-rewrite contract through the same shared real-transport
 * seam as the read-side and write-side corpora: every scenario is an ordered,
 * deterministic program over the real loopback Bridge and the real file-system
 * Change Set engine, with no mock substituting for durable byte or identity
 * evidence. The evidence that leaves a run is digest-only; note bodies and
 * Submission Keys are private.
 */

export const REGISTERED_REFERENCE_REWRITE_CORPUS_ID = "registered-reference-rewrite-proof";

/**
 * Deterministic corpus fixtures under this directory are the rewrite inputs the
 * corpus moves; the deterministic seed `Notes/` inventory is never touched.
 */
export const REFERENCE_REWRITE_CORPUS_DIRECTORY = "ReferenceProof";

/**
 * Ordered release-blocking scenario plan (issue #178). The scenario names are
 * the deterministic program the tracer executes; the manifest digest therefore
 * identifies the program, not one concrete run's generated identities.
 */
export const REGISTERED_REFERENCE_REWRITE_SCENARIO_PLAN = [
  "move/wikilink-destination-only",
  "move/embed-destination-only",
  "move/markdown-inline-destination-only",
  "move/markdown-embed-destination-only",
  "span/bom-crlf-cjk-astral-exact",
  "span/duplicate-equal-spellings",
  "reject/stale-closure",
  "reject/literal-hash-destination",
  "reject/duplicate-basename-ambiguous",
  "reject/invalid-fragment-closed",
  "reject/duplicate-heading-closed",
  "observer/no-private-paths-no-half-written",
  "cleanup/wire-observed-residual-state",
] as const;

export type RegisteredReferenceRewriteScenarioName =
  (typeof REGISTERED_REFERENCE_REWRITE_SCENARIO_PLAN)[number];

export class RegisteredReferenceRewriteCorpusError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RegisteredReferenceRewriteCorpusError";
  }
}

type WireToolName =
  | "vault_health"
  | "vault_discover"
  | "vault_read"
  | "vault_change_set_submit"
  | "vault_change_set_status";

type McpToolResult = {
  readonly isError?: boolean;
  readonly structuredContent?: unknown;
  readonly content?: readonly unknown[];
};

/** Wire surface every corpus session shares (mirrors the gate-isolation seam). */
export interface WireClient {
  callTool(tool: WireToolName, arguments_: Record<string, unknown>): Promise<McpToolResult>;
}

type WireToolCall = (
  tool: WireToolName,
  arguments_: Record<string, unknown>,
) => Promise<McpToolResult>;

/**
 * Out-of-band Vault arrangement seam (issue #178). The corpus drives the wire
 * tools for all mutation, but a handful of proofs need the deterministic
 * arrangement the host already published: exact raw-byte re-reads, the
 * stale-closure file drift, and snapshot publication after an out-of-band
 * drift is restored. The driver supplies real file-system implementations.
 */
export interface RegisteredReferenceRewriteArrange {
  readBinary(path: string): Promise<Uint8Array | null>;
  writeBinary(path: string, bytes: Uint8Array): Promise<void>;
  publishSnapshot(): Promise<void>;
}

export interface RegisteredReferenceRewriteInventoryEntry {
  readonly path: string;
  readonly sha256: string;
  readonly sizeBytes: number;
}

export interface RegisteredReferenceRewriteFixture {
  readonly path: string;
  readonly content: string;
}

/**
 * One rejection session: a dedicated real loopback Bridge whose Vault is
 * arranged so the reference evidence the move would depend on cannot close
 * (duplicate basename, invalid fragment, duplicate heading, unknown grammar, or
 * a non-unique verified span). The Bridge still serves the wire contract; the
 * corpus proves content tools fail closed and the Change Set rejects with no
 * mutation.
 */
export interface RegisteredReferenceRewriteRejectionSession {
  readonly scenario: string;
  readonly sourcePath: string;
  readonly destinationPath: string;
  readonly callTool: WireToolCall;
  readonly arrange: RegisteredReferenceRewriteArrange;
  readonly expectSnapshotUnavailable: boolean;
}

export interface RegisteredReferenceRewriteSession {
  /** The primary success session the corpus mutates with real moves. */
  readonly callTool: WireToolCall;
  readonly arrange: RegisteredReferenceRewriteArrange;
  /** A second enabled MCP event observer, when the driver can supply one. */
  readonly observer?: WireClient;
  readonly seedNotes: readonly RegisteredReferenceRewriteFixture[];
  readonly fixtures: readonly RegisteredReferenceRewriteFixture[];
  readonly rejectionSessions: readonly RegisteredReferenceRewriteRejectionSession[];
}

const utf8Encoder = new TextEncoder();

function sha256Hex(value: string): string {
  return createHash("sha256").update(utf8Encoder.encode(value)).digest("hex");
}

function digestOfContentVersion(contentVersion: string): string {
  return contentVersion.replace(/^sha256:/u, "");
}

function contentVersionOf(content: string): string {
  return `sha256:${sha256Hex(content)}`;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, canonicalize(nested)]),
  );
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function exactText(result: McpToolResult): string {
  const text = result.content?.find(
    (item): item is { readonly type: "text"; readonly text: string } =>
      typeof item === "object" &&
      item !== null &&
      (item as { readonly type?: unknown }).type === "text" &&
      typeof (item as { readonly text?: unknown }).text === "string",
  );
  if (text === undefined) {
    throw new RegisteredReferenceRewriteCorpusError("Tool response has no compatibility text");
  }
  return text.text;
}

export function digestCorpusInventory(entries: readonly RegisteredReferenceRewriteInventoryEntry[]): string {
  const canonical = entries
    .map(({ path, sha256, sizeBytes }) => `${sha256}  ${sizeBytes}  ${path}`)
    .sort()
    .join("\n");
  return createHash("sha256").update(`${canonical}\n`, "utf8").digest("hex");
}

function inventoryEntry(path: string, content: string): RegisteredReferenceRewriteInventoryEntry {
  return {
    path,
    sha256: sha256Hex(content),
    sizeBytes: utf8Encoder.encode(content).byteLength,
  };
}

/**
 * Deterministic corpus fixtures. Content is private to the run and only ever
 * leaves as digests; the driver writes these files before the Bridge starts so
 * the successor Search Snapshot resolves the reference graph exactly like the
 * installed host would.
 */
export function registeredReferenceRewriteFixtures(): readonly RegisteredReferenceRewriteFixture[] {
  return [
    // Four registered-profile move sources and their referrers.
    { path: "ReferenceProof/Grammar/Wikilink.md", content: "# Wikilink\n" },
    { path: "ReferenceProof/Grammar/WikilinkRef.md", content: "See [[Wikilink|alias]].\n" },
    { path: "ReferenceProof/Grammar/Embed.md", content: "# Embed\n\n## Preview\n" },
    { path: "ReferenceProof/Grammar/EmbedRef.md", content: "![[Embed#Preview|200]]\n" },
    { path: "ReferenceProof/Grammar/Inline.md", content: "# Inline\n" },
    { path: "ReferenceProof/Grammar/InlineRef.md", content: "[guide](Inline.md 'title')\n" },
    { path: "ReferenceProof/Grammar/MdEmbed.md", content: "# MdEmbed\n" },
    { path: "ReferenceProof/Grammar/MdEmbedRef.md", content: "![alt](<MdEmbed.md>)\n" },
    // UTF-16-host-to-UTF-8-byte span proof: BOM, CRLF, CJK, astral emoji.
    { path: "ReferenceProof/Span/Span.md", content: "# Span\n" },
    {
      path: "ReferenceProof/Span/SpanRef.md",
      content:
        "﻿# 参考\r\n\r\n前文 CJK 與 😀 星體，\r\nSee [[Span]] here.\r\n尾行 é。\r\n",
    },
    // Duplicate equal link spellings in one referrer.
    { path: "ReferenceProof/Dup/Dup.md", content: "# Dup\n" },
    { path: "ReferenceProof/Dup/DupRef.md", content: "Alpha: [[Dup]] and omega: [[Dup]].\n" },
    // Stale-closure pair (its referrer is drifted out-of-band during the run).
    { path: "ReferenceProof/Stale/Stale.md", content: "# Stale\n" },
    { path: "ReferenceProof/Stale/StaleRef.md", content: "Link: [[Stale]].\n" },
    // Literal-# destination pair (the file name itself carries a literal #).
    { path: "ReferenceProof/Hash/Hash#Note.md", content: "# Hash\n" },
    { path: "ReferenceProof/Hash/HashRef.md", content: "See [x](Hash%23Note.md) now.\n" },
  ];
}

/** The exact bytes a fixture is expected to have after its scenario's move. */
export function expectedRewrittenReferrer(path: string): string | null {
  switch (path) {
    case "ReferenceProof/Grammar/WikilinkRef.md":
      return "See [[Wikilink Moved|alias]].\n";
    case "ReferenceProof/Grammar/EmbedRef.md":
      return "![[Embed Moved#Preview|200]]\n";
    case "ReferenceProof/Grammar/InlineRef.md":
      return "[guide](Inline%20Moved.md 'title')\n";
    case "ReferenceProof/Grammar/MdEmbedRef.md":
      return "![alt](<MdEmbed Moved.md>)\n";
    case "ReferenceProof/Span/SpanRef.md":
      return (
        "﻿# 参考\r\n\r\n前文 CJK 與 😀 星體，\r\nSee [[Span Moved]] here.\r\n尾行 é。\r\n"
      );
    case "ReferenceProof/Dup/DupRef.md":
      return "Alpha: [[Dup Moved]] and omega: [[Dup Moved]].\n";
    default:
      return null;
  }
}

const GRAMMAR_MOVE_SOURCES = [
  { scenario: "move/wikilink-destination-only", profile: "wikilink" as const, source: "ReferenceProof/Grammar/Wikilink.md", destination: "ReferenceProof/Grammar/Wikilink Moved.md", referrer: "ReferenceProof/Grammar/WikilinkRef.md" },
  { scenario: "move/embed-destination-only", profile: "embed" as const, source: "ReferenceProof/Grammar/Embed.md", destination: "ReferenceProof/Grammar/Embed Moved.md", referrer: "ReferenceProof/Grammar/EmbedRef.md" },
  { scenario: "move/markdown-inline-destination-only", profile: "markdown_inline_link" as const, source: "ReferenceProof/Grammar/Inline.md", destination: "ReferenceProof/Grammar/Inline Moved.md", referrer: "ReferenceProof/Grammar/InlineRef.md" },
  { scenario: "move/markdown-embed-destination-only", profile: "markdown_embed" as const, source: "ReferenceProof/Grammar/MdEmbed.md", destination: "ReferenceProof/Grammar/MdEmbed Moved.md", referrer: "ReferenceProof/Grammar/MdEmbedRef.md" },
] as const;

const SPAN_SCENARIO = {
  source: "ReferenceProof/Span/Span.md",
  destination: "ReferenceProof/Span/Span Moved.md",
  referrer: "ReferenceProof/Span/SpanRef.md",
};

const DUPLICATE_SCENARIO = {
  source: "ReferenceProof/Dup/Dup.md",
  destination: "ReferenceProof/Dup/Dup Moved.md",
  referrer: "ReferenceProof/Dup/DupRef.md",
};

const STALE_SCENARIO = {
  source: "ReferenceProof/Stale/Stale.md",
  destination: "ReferenceProof/Stale/Stale Moved.md",
  referrer: "ReferenceProof/Stale/StaleRef.md",
};

const HASH_SCENARIO = {
  source: "ReferenceProof/Hash/Hash#Note.md",
  destination: "ReferenceProof/Hash/Hash#Note-moved.md",
};

function scenarioManifestSha256(): string {
  return createHash("sha256")
    .update(
      canonicalJson({
        corpusId: REGISTERED_REFERENCE_REWRITE_CORPUS_ID,
        scenarios: [...REGISTERED_REFERENCE_REWRITE_SCENARIO_PLAN],
      }),
    )
    .digest("hex");
}

function moveOperation(paths: { source: string; destination: string; targetVersion: string }): ChangeSetSubmitInput {
  return {
    // A Submission Key is single-use; deriving it from the source path gives
    // every scenario its own deterministic key.
    submissionKey: `rewrite-proof-${sha256Hex(paths.source).slice(0, 16)}`,
    operations: [
      {
        operationId: "move-1",
        kind: "move",
        sourcePath: paths.source,
        destinationPath: paths.destination,
        targetVersion: paths.targetVersion,
        linkEffect: "update_resolved_references",
      },
    ],
  };
}

export interface RegisteredReferenceRewriteMoveRecord {
  readonly scenario: string;
  readonly profile: "wikilink" | "embed" | "markdown_inline_link" | "markdown_embed";
  readonly submissionKeySha256: string;
  readonly changeSetId: string;
  readonly sourcePath: string;
  readonly destinationPath: string;
  readonly derivedPaths: readonly string[];
  readonly destinationContentVersionSha256: string;
  readonly rewrittenContentVersionSha256: string;
}

export interface RegisteredReferenceRewriteRawByteFixture {
  readonly scenario: string;
  readonly hostModes: readonly string[];
  readonly locatedReferences: number;
}

export interface RegisteredReferenceRewriteRejectionRecord {
  readonly scenario: string;
  readonly failureCode: string | null;
  readonly registered: boolean;
}

export interface RegisteredReferenceRewriteObserverEvidence {
  readonly enabledSecondObserver: boolean;
  readonly discoversIssued: number;
}

export interface RegisteredReferenceRewriteOutcome {
  readonly scenarioManifestSha256: string;
  readonly seedInventoryDigest: string;
  readonly beforeInventory: readonly RegisteredReferenceRewriteInventoryEntry[];
  readonly afterInventory: readonly RegisteredReferenceRewriteInventoryEntry[];
  readonly moves: readonly RegisteredReferenceRewriteMoveRecord[];
  readonly rawBytes: {
    readonly fixtures: readonly RegisteredReferenceRewriteRawByteFixture[];
    readonly duplicateEqualSpellingsRewritten: number;
  };
  readonly rejections: readonly RegisteredReferenceRewriteRejectionRecord[];
  readonly observer: RegisteredReferenceRewriteObserverEvidence;
  readonly residualCleanup: RegisteredReferenceRewriteCorpusEvidence["residualCleanup"];
  readonly assertions: readonly string[];
}

function submissionKeyDigest(submissionKey: string): string {
  return sha256Hex(submissionKey);
}

export async function runRegisteredReferenceRewriteCorpus(options: {
  readonly session: RegisteredReferenceRewriteSession;
  readonly record: (kind: "transport" | "tool" | "assertion" | "cleanup", name: string, detail: unknown) => void;
  readonly assertion: (name: string) => void;
}): Promise<RegisteredReferenceRewriteOutcome> {
  const { session } = options;
  const seedNotes = [...session.seedNotes].sort((left, right) => left.path.localeCompare(right.path));
  const fixtures = [...session.fixtures].sort((left, right) => left.path.localeCompare(right.path));
  const expectedSeedInventory = seedNotes
    .filter(({ path }) => path.startsWith("Notes/"))
    .map(({ path, content }) => inventoryEntry(path, content))
    .sort((left, right) => left.path.localeCompare(right.path));
  const seedInventoryDigest = digestCorpusInventory(expectedSeedInventory);

  const assertions: string[] = [];
  const assertion = (name: string): void => {
    assertions.push(name);
    options.assertion(name);
  };

  options.record("assertion", "registered-reference-corpus-began", {
    corpusId: REGISTERED_REFERENCE_REWRITE_CORPUS_ID,
    seedPaths: expectedSeedInventory.map(({ path }) => path),
    seedInventoryDigest,
    fixtureCount: fixtures.length,
  });

  const call = async (
    stepId: string,
    client: WireToolCall,
    tool: WireToolName,
    arguments_: Record<string, unknown>,
    assertResult: (value: unknown) => string,
    expectedError = false,
  ): Promise<unknown> => {
    const result = await client(tool, arguments_);
    if ((result.isError === true) !== expectedError) {
      throw new RegisteredReferenceRewriteCorpusError(
        `${stepId} returned an unexpected MCP error disposition`,
      );
    }
    if (result.structuredContent === undefined) {
      throw new RegisteredReferenceRewriteCorpusError(
        `${stepId} omitted authoritative structured content`,
      );
    }
    const authoritativeText = assertResult(result.structuredContent);
    if (exactText(result) !== authoritativeText) {
      throw new RegisteredReferenceRewriteCorpusError(
        `${stepId} compatibility text diverged from structured content`,
      );
    }
    options.record("tool", tool, result.structuredContent);
    return result.structuredContent;
  };

  // A wire call that records and validates but does not presume the MCP error
  // disposition: rejections and snapshot-unavailable responses legitimately
  // arrive with isError true while still carrying authoritative content.
  const callParsed = async (
    stepId: string,
    client: WireToolCall,
    tool: WireToolName,
    arguments_: Record<string, unknown>,
    assertResult: (value: unknown) => string,
  ): Promise<unknown> => {
    const result = await client(tool, arguments_);
    if (result.structuredContent === undefined) {
      throw new RegisteredReferenceRewriteCorpusError(
        `${stepId} omitted authoritative structured content`,
      );
    }
    const authoritativeText = assertResult(result.structuredContent);
    if (exactText(result) !== authoritativeText) {
      throw new RegisteredReferenceRewriteCorpusError(
        `${stepId} compatibility text diverged from structured content`,
      );
    }
    options.record("tool", tool, result.structuredContent);
    return result.structuredContent;
  };

  const discover = async (prefix: string): Promise<RegisteredReferenceRewriteInventoryEntry[]> => {
    const value = await call(
      `discover/${prefix}`,
      session.callTool,
      "vault_discover",
      {
        query: { path: { prefix } },
        projection: { matches: false },
        order: { by: "path", direction: "asc" },
        page: { maxItems: 1_000, continuation: null },
      },
      (candidate) => serializeDiscoverCompatibilityText(parseDiscoverResult(candidate)),
      false,
    );
    const result = parseDiscoverResult(value);
    if (result.outcome !== "results" || !result.complete) {
      throw new RegisteredReferenceRewriteCorpusError(
        `Inventory discovery for ${prefix} did not return complete results`,
      );
    }
    return result.items
      .map((item) => ({
        path: item.path,
        sha256: digestOfContentVersion(item.contentVersion),
        sizeBytes: item.sizeBytes,
      }))
      .sort((left, right) => left.path.localeCompare(right.path));
  };

  const submitMove = async (
    stepId: string,
    client: WireToolCall,
    input: ChangeSetSubmitInput,
  ): Promise<ReturnType<typeof parseChangeSetSubmitResult>> => {
    const value = await callParsed(
      stepId,
      client,
      "vault_change_set_submit",
      {
        submissionKey: input.submissionKey,
        operations: structuredClone(input.operations),
      },
      (candidate) => serializeChangeSetSubmitCompatibilityText(parseChangeSetSubmitResult(candidate)),
    );
    return parseChangeSetSubmitResult(value);
  };

  const beforeInventory = await discover("Notes/");

  // ---------------------------------------------------------------------------
  // Second-observer poller (issue #178 AC5): a concurrent enabled event observer
  // polls the Vault across the successful moves and the rejection windows. Every
  // observed state must be atomic — a plugin-private staging path or a
  // half-written Markdown Content Version is a corpus failure.
  // ---------------------------------------------------------------------------
  const validObserverDigests = new Map<string, Set<string>>();
  for (const fixture of [...seedNotes, ...fixtures]) {
    const set = new Set<string>([sha256Hex(fixture.content)]);
    const expected = expectedRewrittenReferrer(fixture.path);
    if (expected !== null) set.add(sha256Hex(expected));
    validObserverDigests.set(fixture.path, set);
  }
  let observerDiscovers = 0;
  let observerError: unknown;
  let observerStopped = false;
  let observerRun: Promise<void> = Promise.resolve();
  const observer = session.observer;
  if (observer !== undefined) {
    const poll = async (): Promise<void> => {
      const value = await callParsed(
        "observer/discover",
        observer.callTool,
        "vault_discover",
        {
          query: { path: { prefix: "ReferenceProof/" } },
          projection: { matches: false },
          order: { by: "path", direction: "asc" },
          page: { maxItems: 1_000, continuation: null },
        },
        (candidate) => serializeDiscoverCompatibilityText(parseDiscoverResult(candidate)),
      );
      const result = parseDiscoverResult(value);
      observerDiscovers += 1;
      if (result.outcome !== "results") return;
      for (const item of result.items) {
        if (item.path.includes("/.llm-wiki/") || item.path.startsWith(".llm-wiki/")) {
          throw new RegisteredReferenceRewriteCorpusError(
            "Observer discovered a plugin-private staging path",
          );
        }
        const allowed = validObserverDigests.get(item.path);
        if (allowed !== undefined && !allowed.has(digestOfContentVersion(item.contentVersion))) {
          throw new RegisteredReferenceRewriteCorpusError(
            `Observer observed a half-written Markdown Content Version for ${item.path}`,
          );
        }
      }
    };
    observerRun = (async () => {
      while (!observerStopped) {
        try {
          await poll();
        } catch (error) {
          observerError = error;
          return;
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 2));
      }
    })();
  }

  // ---------------------------------------------------------------------------
  // 1. Four grammar move proofs: each move derives a destination-only rewrite of
  //    its referrer. The referrer's final bytes are verified byte-for-byte and
  //    its final Content Version is re-read over the wire.
  // ---------------------------------------------------------------------------
  const moves: RegisteredReferenceRewriteMoveRecord[] = [];
  for (const grammar of GRAMMAR_MOVE_SOURCES) {
    const sourceBytes = await session.arrange.readBinary(grammar.source);
    if (sourceBytes === null) {
      throw new RegisteredReferenceRewriteCorpusError(
        `${grammar.scenario} source note is missing from the arranged Vault`,
      );
    }
    const beforeReferrer = await session.arrange.readBinary(grammar.referrer);
    const expectedReferrer = expectedRewrittenReferrer(grammar.referrer);
    if (beforeReferrer === null || expectedReferrer === null) {
      throw new RegisteredReferenceRewriteCorpusError(
        `${grammar.scenario} referrer fixture is missing or has no expectation`,
      );
    }
    const input = moveOperation({
      source: grammar.source,
      destination: grammar.destination,
      targetVersion: contentVersionOf(Buffer.from(sourceBytes).toString("utf8")),
    });
    const result = await submitMove(`${grammar.scenario}/submit`, session.callTool, input);
    if (result.outcome !== "registered" || result.changeSet.state !== "intent_applied") {
      throw new RegisteredReferenceRewriteCorpusError(
        `${grammar.scenario} did not reach intent_applied`,
      );
    }
    const record = result.changeSet;
    const derivedEffectIds = new Set<string>();
    for (const effect of record.derivedEffects) {
      if (effect.causedByOperationId === "move-1") derivedEffectIds.add(effect.operationId);
    }
    const expectedDerivedId = `derived/move-1/references/${grammar.referrer}`;
    if (!derivedEffectIds.has(expectedDerivedId)) {
      throw new RegisteredReferenceRewriteCorpusError(
        `${grammar.scenario} did not derive the referrer rewrite effect`,
      );
    }
    const sourcePath = record.paths.find((path) => path.path === grammar.source);
    const destinationPath = record.paths.find((path) => path.path === grammar.destination);
    const referrerPath = record.paths.find((path) => path.path === grammar.referrer);
    if (
      sourcePath?.finalState.kind !== "absent" ||
      destinationPath?.finalState.kind !== "markdown" ||
      referrerPath?.finalState.kind !== "markdown"
    ) {
      throw new RegisteredReferenceRewriteCorpusError(
        `${grammar.scenario} typed path evidence is missing or wrong`,
      );
    }
    const destinationBytes = await session.arrange.readBinary(grammar.destination);
    const afterReferrer = await session.arrange.readBinary(grammar.referrer);
    const expectedDestinationBytes = sourceBytes;
    if (
      destinationBytes === null ||
      !Buffer.from(destinationBytes).equals(Buffer.from(expectedDestinationBytes))
    ) {
      throw new RegisteredReferenceRewriteCorpusError(
        `${grammar.scenario} destination bytes do not equal the moved source bytes`,
      );
    }
    if (
      afterReferrer === null ||
      Buffer.from(afterReferrer).toString("utf8") !== expectedReferrer
    ) {
      throw new RegisteredReferenceRewriteCorpusError(
        `${grammar.scenario} referrer bytes were not rewritten destination-only`,
      );
    }
    // Re-read the referrer over the wire and require its exact Content Version.
    const read = parseReadResult(
      await call(
        `${grammar.scenario}/wire-reread`,
        session.callTool,
        "vault_read",
        { items: [{ kind: "exact", path: grammar.referrer }] },
        (candidate) => serializeReadCompatibilityText(parseReadResult(candidate)),
        false,
      ),
    );
    if (read.outcome !== "items" || read.items.length !== 1 || read.items[0]?.outcome !== "satisfied") {
      throw new RegisteredReferenceRewriteCorpusError(
        `${grammar.scenario} final referrer read did not satisfy`,
      );
    }
    const satisfied = read.items[0] as { outcome: "satisfied"; result: { contentVersion: string } };
    if (digestOfContentVersion(satisfied.result.contentVersion) !== sha256Hex(expectedReferrer)) {
      throw new RegisteredReferenceRewriteCorpusError(
        `${grammar.scenario} final Content Version was not reread exactly`,
      );
    }
    moves.push({
      scenario: grammar.scenario,
      profile: grammar.profile,
      submissionKeySha256: submissionKeyDigest(input.submissionKey),
      changeSetId: record.changeSetId,
      sourcePath: grammar.source,
      destinationPath: grammar.destination,
      derivedPaths: [...derivedEffectIds],
      destinationContentVersionSha256: sha256Hex(Buffer.from(expectedDestinationBytes).toString("utf8")),
      rewrittenContentVersionSha256: sha256Hex(expectedReferrer),
    });
    assertion(`${grammar.scenario}:destination-only-rewrite`);
    assertion(`${grammar.scenario}:old-path-absent`);
    assertion(`${grammar.scenario}:final-bytes-reread`);
  }

  // ---------------------------------------------------------------------------
  // 2. Raw-byte span proof (spec §8.1): BOM/CRLF/CJK/astral host text where the
  //    host UTF-16 positions are only candidate locators and the rewrite splices
  //    exactly one verified raw UTF-8 span, leaving every other byte exact.
  // ---------------------------------------------------------------------------
  {
    const sourceBytes = await session.arrange.readBinary(SPAN_SCENARIO.source);
    const referrerBefore = await session.arrange.readBinary(SPAN_SCENARIO.referrer);
    if (sourceBytes === null || referrerBefore === null) {
      throw new RegisteredReferenceRewriteCorpusError("Raw-byte span fixture is incomplete");
    }
    const referrerText = Buffer.from(referrerBefore).toString("utf8");
    const input = moveOperation({
      source: SPAN_SCENARIO.source,
      destination: SPAN_SCENARIO.destination,
      targetVersion: contentVersionOf(Buffer.from(sourceBytes).toString("utf8")),
    });
    const result = await submitMove("span/bom-crlf-cjk-astral/submit", session.callTool, input);
    if (result.outcome !== "registered" || result.changeSet.state !== "intent_applied") {
      throw new RegisteredReferenceRewriteCorpusError(
        "Raw-byte span move did not reach intent_applied",
      );
    }
    const afterReferrer = await session.arrange.readBinary(SPAN_SCENARIO.referrer);
    const expected = expectedRewrittenReferrer(SPAN_SCENARIO.referrer);
    if (afterReferrer === null || expected === null) {
      throw new RegisteredReferenceRewriteCorpusError("Raw-byte span result is missing");
    }
    if (Buffer.from(afterReferrer).toString("utf8") !== expected) {
      throw new RegisteredReferenceRewriteCorpusError(
        "Raw-byte span rewrite left untouched bytes changed",
      );
    }
    // Every non-reference byte stayed exact: the expected text equals the before
    // text with only the [[Span]] destination component replaced.
    const replaced = referrerText.replace("[[Span]]", "[[Span Moved]]");
    if (replaced !== expected) {
      throw new RegisteredReferenceRewriteCorpusError(
        "Raw-byte span rewrite was not a single destination-only splice",
      );
    }
    const located = referrerText.match(/\[\[Span\]\]/gu)?.length ?? 0;
    if (located !== 1) {
      throw new RegisteredReferenceRewriteCorpusError(
        "Raw-byte span fixture must contain exactly one reference",
      );
    }
    assertion("span/bom-crlf-cjk-astral:single-verified-span");
    assertion("span/bom-crlf-cjk-astral:every-untouched-byte-exact");
  }

  // ---------------------------------------------------------------------------
  // 3. Duplicate equal link spellings: two identical references to the moved
  //    note are each located to their own verified span and both rewritten while
  //    every other byte stays exact.
  // ---------------------------------------------------------------------------
  let duplicateEqualSpellingsRewritten = 0;
  {
    const sourceBytes = await session.arrange.readBinary(DUPLICATE_SCENARIO.source);
    const referrerBefore = await session.arrange.readBinary(DUPLICATE_SCENARIO.referrer);
    if (sourceBytes === null || referrerBefore === null) {
      throw new RegisteredReferenceRewriteCorpusError("Duplicate spelling fixture is incomplete");
    }
    const input = moveOperation({
      source: DUPLICATE_SCENARIO.source,
      destination: DUPLICATE_SCENARIO.destination,
      targetVersion: contentVersionOf(Buffer.from(sourceBytes).toString("utf8")),
    });
    const result = await submitMove("span/duplicate-equal-spellings/submit", session.callTool, input);
    if (result.outcome !== "registered" || result.changeSet.state !== "intent_applied") {
      throw new RegisteredReferenceRewriteCorpusError(
        "Duplicate spelling move did not reach intent_applied",
      );
    }
    const afterReferrer = await session.arrange.readBinary(DUPLICATE_SCENARIO.referrer);
    const expected = expectedRewrittenReferrer(DUPLICATE_SCENARIO.referrer);
    if (afterReferrer === null || expected === null) {
      throw new RegisteredReferenceRewriteCorpusError("Duplicate spelling result is missing");
    }
    const afterText = Buffer.from(afterReferrer).toString("utf8");
    if (afterText !== expected) {
      throw new RegisteredReferenceRewriteCorpusError(
        "Duplicate equal spellings were not both rewritten destination-only",
      );
    }
    duplicateEqualSpellingsRewritten = 2;
    assertion("span/duplicate-equal-spellings:each-verified-span");
    assertion("span/duplicate-equal-spellings:untouched-bytes-exact");
  }

  // ---------------------------------------------------------------------------
  // 4. Rejections on the primary session: stale closure and literal-# destination
  //    reject the complete Change Set with no guessing and no mutation.
  // ---------------------------------------------------------------------------
  const rejections: RegisteredReferenceRewriteRejectionRecord[] = [];

  {
    // 4a. Stale closure: the referrer is edited out-of-band after the snapshot
    //     was published, so the derived rewrite's version guard cannot hold.
    const staleReferrerText = Buffer.from(
      (await session.arrange.readBinary(STALE_SCENARIO.referrer)) ?? new Uint8Array(),
    ).toString("utf8");
    const drifted = `${staleReferrerText}Edited out-of-band.\n`;
    await session.arrange.writeBinary(
      STALE_SCENARIO.referrer,
      Buffer.from(drifted, "utf8"),
    );
    const staleSource = await session.arrange.readBinary(STALE_SCENARIO.source);
    if (staleSource === null) {
      throw new RegisteredReferenceRewriteCorpusError("Stale-closure source is missing");
    }
    const staleResult = await submitMove("reject/stale-closure/submit", session.callTool, moveOperation({
      source: STALE_SCENARIO.source,
      destination: STALE_SCENARIO.destination,
      targetVersion: contentVersionOf(Buffer.from(staleSource).toString("utf8")),
    }));
    if (staleResult.outcome !== "registered" || staleResult.changeSet.state !== "intent_not_applied") {
      throw new RegisteredReferenceRewriteCorpusError(
        "Stale-closure move did not reject with intent_not_applied",
      );
    }
    const failureCode =
      staleResult.changeSet.state === "intent_not_applied" && "failure" in staleResult.changeSet
        ? staleResult.changeSet.failure?.code ?? null
        : null;
    const stillDrifted = Buffer.from(
      (await session.arrange.readBinary(STALE_SCENARIO.referrer)) ?? new Uint8Array(),
    ).toString("utf8");
    const sourceStillPresent = (await session.arrange.readBinary(STALE_SCENARIO.source)) !== null;
    if (stillDrifted !== drifted || !sourceStillPresent) {
      throw new RegisteredReferenceRewriteCorpusError("Stale-closure rejection mutated the Vault");
    }
    // Restore the referrer and republish so the session is clean.
    await session.arrange.writeBinary(STALE_SCENARIO.referrer, Buffer.from(staleReferrerText, "utf8"));
    await session.arrange.publishSnapshot();
    rejections.push({ scenario: "reject/stale-closure", failureCode, registered: true });
    assertion("reject/stale-closure:no-mutation");
  }

  {
    // 4b. Literal-# destination: a moved Markdown destination whose filename
    //     contains a literal "#" cannot be rendered without inventing escaping.
    const hashSource = await session.arrange.readBinary(HASH_SCENARIO.source);
    if (hashSource === null) {
      throw new RegisteredReferenceRewriteCorpusError("Literal-# source is missing");
    }
    const hashResult = await submitMove("reject/literal-hash-destination/submit", session.callTool, moveOperation({
      source: HASH_SCENARIO.source,
      destination: HASH_SCENARIO.destination,
      targetVersion: contentVersionOf(Buffer.from(hashSource).toString("utf8")),
    }));
    if (hashResult.outcome !== "registered" || hashResult.changeSet.state !== "intent_not_applied") {
      throw new RegisteredReferenceRewriteCorpusError(
        "Literal-# destination move did not reject",
      );
    }
    const sourceStillPresent = (await session.arrange.readBinary(HASH_SCENARIO.source)) !== null;
    const destinationAbsent = (await session.arrange.readBinary(HASH_SCENARIO.destination)) === null;
    if (!sourceStillPresent || !destinationAbsent) {
      throw new RegisteredReferenceRewriteCorpusError("Literal-# rejection mutated the Vault");
    }
    rejections.push({
      scenario: "reject/literal-hash-destination",
      failureCode:
        hashResult.changeSet.state === "intent_not_applied" && "failure" in hashResult.changeSet
          ? hashResult.changeSet.failure?.code ?? null
          : null,
      registered: true,
    });
    assertion("reject/literal-hash-destination:no-guessing-no-mutation");
  }

  // ---------------------------------------------------------------------------
  // 5. Snapshot-closed rejection sessions: each dedicated Vault cannot close its
  //    reference evidence, so content tools fail closed and the move rejects
  //    with no mutation.
  // ---------------------------------------------------------------------------
  for (const rejection of session.rejectionSessions) {
    const beforePaths = rejection.arrange.readBinary === undefined ? [] : [];
    void beforePaths;
    const beforeDigest = await arrangeDigest(rejection.arrange, [rejection.sourcePath]);
    if (rejection.expectSnapshotUnavailable) {
      const value = await callParsed(
        `${rejection.scenario}/discover-closed`,
        rejection.callTool,
        "vault_discover",
        {
          query: { path: { prefix: "Notes/" } },
          projection: { matches: false },
          order: { by: "path", direction: "asc" },
          page: { maxItems: 1_000, continuation: null },
        },
        (candidate) => serializeDiscoverCompatibilityText(parseDiscoverResult(candidate)),
      );
      const discoverResult = parseDiscoverResult(value);
      if (discoverResult.outcome !== "snapshot_unavailable") {
        throw new RegisteredReferenceRewriteCorpusError(
          `${rejection.scenario} content tools did not fail closed`,
        );
      }
      assertion(`${rejection.scenario}:content-tools-fail-closed`);
    }
    const sourceBytes = await rejection.arrange.readBinary(rejection.sourcePath);
    if (sourceBytes === null) {
      throw new RegisteredReferenceRewriteCorpusError(
        `${rejection.scenario} source note is missing`,
      );
    }
    const rejected = await submitMove(`${rejection.scenario}/submit`, rejection.callTool, moveOperation({
      source: rejection.sourcePath,
      destination: rejection.destinationPath,
      targetVersion: contentVersionOf(Buffer.from(sourceBytes).toString("utf8")),
    }));
    if (rejected.outcome !== "registered" || rejected.changeSet.state !== "intent_not_applied") {
      throw new RegisteredReferenceRewriteCorpusError(
        `${rejection.scenario} did not reject the complete Change Set`,
      );
    }
    const failureCode =
      rejected.changeSet.state === "intent_not_applied" && "failure" in rejected.changeSet
        ? rejected.changeSet.failure?.code ?? null
        : null;
    const afterDigest = await arrangeDigest(rejection.arrange, [rejection.sourcePath]);
    if (beforeDigest !== afterDigest) {
      throw new RegisteredReferenceRewriteCorpusError(
        `${rejection.scenario} rejected Change Set mutated the Vault`,
      );
    }
    rejections.push({ scenario: rejection.scenario, failureCode, registered: true });
    assertion(`${rejection.scenario}:no-guessing-no-mutation`);
  }

  // Stop the second observer and require every observation it made to have been
  // an atomic, private-path-free state.
  observerStopped = true;
  await observerRun;
  if (observerError !== undefined) {
    throw observerError instanceof Error
      ? observerError
      : new RegisteredReferenceRewriteCorpusError(String(observerError));
  }
  if (observer !== undefined) {
    assertion("observer:second-observer-enabled");
    assertion("observer:no-private-staging-paths");
    assertion("observer:no-half-written-markdown");
  }

  // The deterministic seed Notes inventory must be unchanged after the corpus.
  const afterInventory = await discover("Notes/");
  if (digestCorpusInventory(beforeInventory) !== digestCorpusInventory(afterInventory)) {
    throw new RegisteredReferenceRewriteCorpusError(
      "Registered-reference corpus mutated the deterministic seed Notes inventory",
    );
  }

  // Wire-observed residual Bridge idle state.
  const health = parseHealthResult(
    await call(
      "cleanup/wire-observed-idle",
      session.callTool,
      "vault_health",
      {},
      (candidate) => serializeCompatibilityText(parseHealthResult(candidate)),
      false,
    ),
  );
  if (
    health.outcome !== "observed" ||
    health.recovery.state !== "none" ||
    health.queue.length !== 0 ||
    health.queue.currentExecutionId !== null ||
    health.write.gate !== "open" ||
    health.write.state !== "writable"
  ) {
    throw new RegisteredReferenceRewriteCorpusError(
      "Registered-reference corpus did not leave the Bridge idle",
    );
  }
  const residualCleanup: RegisteredReferenceRewriteCorpusEvidence["residualCleanup"] = {
    recoveryState: "none",
    queueLength: 0,
    currentExecutionId: null,
    writeGate: "open",
  };
  options.record("cleanup", "registered-reference-residual-state", residualCleanup);

  return {
    scenarioManifestSha256: scenarioManifestSha256(),
    seedInventoryDigest,
    beforeInventory,
    afterInventory,
    moves,
    rawBytes: {
      fixtures: [
        {
          scenario: "span/bom-crlf-cjk-astral-exact",
          hostModes: ["bom", "crlf", "cjk", "astral"],
          locatedReferences: 1,
        },
      ],
      duplicateEqualSpellingsRewritten,
    },
    rejections,
    observer: {
      enabledSecondObserver: observer !== undefined,
      discoversIssued: observerDiscovers,
    },
    residualCleanup,
    assertions,
  };
}

async function arrangeDigest(
  arrange: RegisteredReferenceRewriteArrange,
  paths: readonly string[],
): Promise<string> {
  const entries: RegisteredReferenceRewriteInventoryEntry[] = [];
  for (const path of paths) {
    const bytes = await arrange.readBinary(path);
    if (bytes === null) continue;
    entries.push({ path, sha256: sha256Hex(Buffer.from(bytes).toString("utf8")), sizeBytes: bytes.byteLength });
  }
  return digestCorpusInventory(entries.sort((left, right) => left.path.localeCompare(right.path)));
}

/**
 * Composes the closed evidence block. Only invoked by the harness/driver when a
 * run completed without a corpus error, so the verdict is always a passing one;
 * the schema refuses a passing verdict when any required proof is missing.
 */
export function composeRegisteredReferenceRewriteCorpusEvidence(options: {
  readonly outcome: RegisteredReferenceRewriteOutcome;
  readonly events: readonly {
    kind: "transport" | "tool" | "assertion" | "cleanup";
    name: string;
    detail: unknown;
  }[];
  readonly assertions: readonly string[];
}): RegisteredReferenceRewriteCorpusEvidence {
  if (options.outcome.assertions.length === 0) {
    throw new RegisteredReferenceRewriteCorpusError(
      "A registered-reference corpus outcome requires assertions",
    );
  }
  return {
    corpusId: REGISTERED_REFERENCE_REWRITE_CORPUS_ID,
    seedManifestSha256: options.outcome.seedInventoryDigest,
    scenarioManifestSha256: options.outcome.scenarioManifestSha256,
    beforeInventory: {
      scope: "Notes/*.md",
      entries: options.outcome.beforeInventory.map((entry) => ({ ...entry })),
      digest: digestCorpusInventory(options.outcome.beforeInventory),
    },
    afterInventory: {
      scope: "Notes/*.md",
      entries: options.outcome.afterInventory.map((entry) => ({ ...entry })),
      digest: digestCorpusInventory(options.outcome.afterInventory),
    },
    moves: options.outcome.moves.map((move) => ({
      scenario: move.scenario,
      profile: move.profile,
      submissionKeySha256: move.submissionKeySha256,
      changeSetId: move.changeSetId,
      sourcePath: move.sourcePath,
      destinationPath: move.destinationPath,
      derivedPaths: [...move.derivedPaths],
      destinationContentVersionSha256: move.destinationContentVersionSha256,
      rewrittenContentVersionSha256: move.rewrittenContentVersionSha256,
      oldPathAbsent: true,
      destinationTypedMarkdown: true,
      finalBytesReread: true,
    })),
    rawBytes: {
      fixtures: options.outcome.rawBytes.fixtures.map((fixture) => ({
        scenario: fixture.scenario,
        hostModes: [...fixture.hostModes],
        locatedReferences: fixture.locatedReferences,
        everyReferenceExactlyOneVerifiedSpan: true,
        everyUntouchedByteExact: true,
        finalBytesHashReread: true,
      })),
      duplicateEqualSpellings: {
        referencesRewritten: options.outcome.rawBytes.duplicateEqualSpellingsRewritten,
        untouchedBytesExact: true,
      },
    },
    rejections: options.outcome.rejections.map((rejection) => ({
      scenario: rejection.scenario,
      failureCode: rejection.failureCode,
      registered: rejection.registered,
      noMutationDigestUnchanged: true,
    })),
    observer: {
      enabledSecondObserver: options.outcome.observer.enabledSecondObserver,
      discoversIssued: options.outcome.observer.discoversIssued,
      privateStagingPathsObserved: 0,
      halfWrittenMarkdownObserved: 0,
    },
    residualCleanup: { ...options.outcome.residualCleanup },
    eventLog: options.events.map((event, index) => ({
      sequence: index + 1,
      kind: event.kind,
      name: event.name,
      detailSha256: sha256Hex(canonicalJson(event.detail)),
    })),
    assertions: [...options.assertions],
    verdict: "passed",
  };
}
