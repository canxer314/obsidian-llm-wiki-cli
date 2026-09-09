import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  parseChangeSetStatusResult,
  parseChangeSetSubmitResult,
  parseContinueResult,
  parseDiscoverResult,
  parseHealthResult,
  parseReadToolResult,
  serializeChangeSetStatusCompatibilityText,
  serializeChangeSetSubmitCompatibilityText,
  serializeCompatibilityText,
  serializeContinueCompatibilityText,
  serializeDiscoverCompatibilityText,
  serializeReadToolCompatibilityText,
  type ContinuePageResult,
  type ReadToolResult,
} from "@llm-wiki/vault-contracts";

import { EXPECTED_VAULT_ID_HEADER } from "../request-policy.js";

import type { PublicWireCorpusEvidence } from "./evidence.js";

export const PUBLIC_WIRE_TOOL_NAMES = [
  "vault_health",
  "vault_discover",
  "vault_read",
  "vault_continue",
  "vault_change_set_submit",
  "vault_change_set_status",
] as const;

export type PublicWireToolName = (typeof PUBLIC_WIRE_TOOL_NAMES)[number];

type McpToolResult = {
  readonly isError?: boolean;
  readonly structuredContent?: unknown;
  readonly content?: readonly unknown[];
};

export interface PublicWireScenarioFragment {
  readonly id: string;
  readonly tool: PublicWireToolName;
  readonly arguments: Record<string, unknown>;
  readonly expectedError: boolean;
  readonly assertResult: (value: unknown) => string;
}

export interface PublicWireCorpusManifest {
  readonly schemaVersion: 1;
  readonly fragments: readonly PublicWireScenarioFragment[];
}

export class PublicWireCorpusError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PublicWireCorpusError";
  }
}

export interface PublicWireCorpusResult {
  readonly evidence: PublicWireCorpusEvidence;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
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
  if (text === undefined) throw new PublicWireCorpusError("Tool response has no compatibility text");
  return text.text;
}

function assertHealth(value: unknown): string {
  return serializeCompatibilityText(parseHealthResult(value));
}

function assertDiscover(value: unknown): string {
  return serializeDiscoverCompatibilityText(parseDiscoverResult(value));
}

function assertRead(value: unknown): string {
  return serializeReadToolCompatibilityText(parseReadToolResult(value));
}

function assertContinue(value: unknown): string {
  return serializeContinueCompatibilityText(parseContinueResult(value));
}

function assertSubmit(value: unknown): string {
  return serializeChangeSetSubmitCompatibilityText(parseChangeSetSubmitResult(value));
}

function assertStatus(value: unknown): string {
  return serializeChangeSetStatusCompatibilityText(parseChangeSetStatusResult(value));
}

function fragment(
  id: string,
  tool: PublicWireToolName,
  arguments_: Record<string, unknown>,
  expectedError: boolean,
  assertResult: (value: unknown) => string,
): PublicWireScenarioFragment {
  return { id, tool, arguments: arguments_, expectedError, assertResult };
}

export function registerHealthPublicWireFragment(register: (fragment: PublicWireScenarioFragment) => void): void {
  register(fragment("health/observed", "vault_health", {}, false, assertHealth));
}

export function registerDiscoverPublicWireFragment(register: (fragment: PublicWireScenarioFragment) => void): void {
  register(
    fragment(
      "discover/seeded-note",
      "vault_discover",
      {
        query: { path: { exact: "Notes/Welcome.md" } },
        projection: { matches: false },
        order: { by: "path", direction: "asc" },
        page: { maxItems: 10, continuation: null },
      },
      false,
      assertDiscover,
    ),
  );
}

export function registerReadPublicWireFragment(register: (fragment: PublicWireScenarioFragment) => void): void {
  register(
    fragment(
      "read/seeded-note",
      "vault_read",
      { items: [{ kind: "metadata", path: "Notes/Welcome.md" }] },
      false,
      assertRead,
    ),
  );
}

export function registerContinuePublicWireFragment(register: (fragment: PublicWireScenarioFragment) => void): void {
  register(
    fragment(
      "continue/unavailable-token",
      "vault_continue",
      { continuation: "public-wire-corpus-unavailable" },
      true,
      assertContinue,
    ),
  );
}

export function registerSubmitPublicWireFragment(register: (fragment: PublicWireScenarioFragment) => void): void {
  register(
    fragment(
      "change-set/submit-directory",
      "vault_change_set_submit",
      {
        submissionKey: "public-wire-corpus-submission",
        operations: [
          {
            operationId: "public-wire-create-directory",
            kind: "create_directory",
            path: "PublicWireCorpus",
            ifExists: "reject",
          },
        ],
      },
      false,
      assertSubmit,
    ),
  );
}

export function registerStatusPublicWireFragment(register: (fragment: PublicWireScenarioFragment) => void): void {
  register(
    fragment(
      "change-set/status-directory",
      "vault_change_set_status",
      { submissionKey: "public-wire-corpus-submission" },
      false,
      assertStatus,
    ),
  );
}

/**
 * Builds the first authority manifest by independent fragment registration.
 * Additional tracers extend it through the registrar rather than changing a
 * shared hand-maintained scenario array.
 */
export function createPublicWireCorpusManifest(
  registerFragments: (
    register: (fragment: PublicWireScenarioFragment) => void,
  ) => void = registerAuthoritativePublicWireFragments,
): PublicWireCorpusManifest {
  const fragments: PublicWireScenarioFragment[] = [];
  registerFragments((candidate) => {
    if (fragments.some(({ id }) => id === candidate.id)) {
      throw new PublicWireCorpusError(`Duplicate public-wire fragment: ${candidate.id}`);
    }
    fragments.push(candidate);
  });
  if (new Set(fragments.map(({ tool }) => tool)).size !== PUBLIC_WIRE_TOOL_NAMES.length) {
    throw new PublicWireCorpusError("The authoritative public-wire manifest must contain exactly six tools");
  }
  return {
    schemaVersion: 1,
    fragments: fragments.map((candidate) => ({
      ...candidate,
      arguments: structuredClone(candidate.arguments),
    })),
  };
}

export function canonicalPublicWireCorpusManifest(manifest: PublicWireCorpusManifest): {
  readonly schemaVersion: 1;
  readonly fragments: readonly {
    readonly id: string;
    readonly tool: PublicWireToolName;
    readonly arguments: Record<string, unknown>;
    readonly expectedError: boolean;
  }[];
} {
  return {
    schemaVersion: manifest.schemaVersion,
    fragments: manifest.fragments
      .map(({ id, tool, arguments: arguments_, expectedError }) => ({
        id,
        tool,
        arguments: structuredClone(arguments_),
        expectedError,
      }))
      .sort((left, right) => left.id.localeCompare(right.id)),
  };
}

export function registerAuthoritativePublicWireFragments(
  register: (fragment: PublicWireScenarioFragment) => void,
): void {
  registerHealthPublicWireFragment(register);
  registerDiscoverPublicWireFragment(register);
  registerReadPublicWireFragment(register);
  registerContinuePublicWireFragment(register);
  registerSubmitPublicWireFragment(register);
  registerStatusPublicWireFragment(register);
}

export const READ_SIDE_CORPUS_ID = "discovery-reads-continuation";

/**
 * Deterministic read-side corpus plan (issue #174). The ordered scenario names
 * are the release-blocking program the tracer executes over the real loopback
 * transport; the run-dependent continuation tokens never appear here — they
 * are captured only as digest-only event details. The scenario-manifest digest
 * therefore identifies the program, not one concrete run's token values.
 */
export const READ_SIDE_SCENARIO_PLAN = [
  "discovery/empty-result",
  "discovery/combined-graph",
  "discovery/inventory-before",
  "read/ordered-byte-exact-and-no-section-fallback",
  "read/single-note-over-limit-refusal",
  "read/multi-note-logical-grouping",
  "continuation/framing-reconstructs-frozen-result",
  "continuation/single-use-replay-rejected",
  "continuation/never-issued-token-unavailable",
  "discovery/inventory-after",
] as const;

export type ReadSideScenarioName = (typeof READ_SIDE_SCENARIO_PLAN)[number];

export interface CorpusInventoryEntry {
  readonly path: string;
  readonly sha256: string;
  readonly sizeBytes: number;
}

export interface RetainedByteCleanupReport {
  readonly chainsIssued: number;
  readonly chainsConsumed: number;
  readonly replayAfterConsumptionRejected: number;
  readonly bytesReconstructed: number;
  readonly residualChains: 0;
}

export interface ReadSideCorpusOutcome {
  readonly scenarioManifestSha256: string;
  readonly seedInventoryDigest: string;
  readonly beforeInventory: readonly CorpusInventoryEntry[];
  readonly afterInventory: readonly CorpusInventoryEntry[];
  readonly retainedByteCleanup: RetainedByteCleanupReport;
}

const utf8Encoder = new TextEncoder();

function contentVersionOf(content: string): string {
  return `sha256:${createHash("sha256").update(utf8Encoder.encode(content)).digest("hex")}`;
}

function inventoryEntry(path: string, content: string): CorpusInventoryEntry {
  return {
    path,
    sha256: createHash("sha256").update(utf8Encoder.encode(content)).digest("hex"),
    sizeBytes: utf8Encoder.encode(content).byteLength,
  };
}

function digestCorpusInventory(entries: readonly CorpusInventoryEntry[]): string {
  const canonical = entries
    .map(({ path, sha256, sizeBytes }) => `${sha256}  ${sizeBytes}  ${path}`)
    .sort()
    .join("\n");
  return createHash("sha256").update(`${canonical}\n`, "utf8").digest("hex");
}

function compactSerializedBytes<T>(
  value: T,
  isError: boolean,
  serialize: (value: T) => string,
): number {
  const text = serialize(value);
  return Buffer.byteLength(
    JSON.stringify({
      content: [{ type: "text", text }],
      structuredContent: value,
      isError,
    }),
    "utf8",
  );
}

/**
 * Executes the deterministic discovery/read/Exact Read/grouping/framing/
 * continuation corpus (issue #174) against one connected public-wire client.
 * Every scenario throws `PublicWireCorpusError` on the first mismatch, which
 * the harness projects to failed/invalid evidence — never to a skipped green
 * result. Note bodies are used only to derive deterministic expectations; the
 * caller records only digests into evidence.
 */
export async function runReadSideCorpus(options: {
  readonly callTool: (tool: PublicWireToolName, arguments_: Record<string, unknown>) => Promise<McpToolResult>;
  readonly seedNotes: readonly { path: string; content: string }[];
  readonly record: (
    kind: "transport" | "tool" | "assertion" | "cleanup",
    name: string,
    detail: unknown,
  ) => void;
  readonly assertion: (name: string) => void;
}): Promise<ReadSideCorpusOutcome> {
  const seedNotes = [...options.seedNotes].sort((left, right) =>
    left.path.localeCompare(right.path),
  );
  const expectedContent = new Map(seedNotes.map(({ path, content }) => [path, content]));
  const expectedInventory = seedNotes
    .map(({ path, content }) => inventoryEntry(path, content))
    .sort((left, right) => left.path.localeCompare(right.path));
  const seedInventoryDigest = digestCorpusInventory(expectedInventory);

  options.record("assertion", "read-side-corpus-began", {
    corpusId: READ_SIDE_CORPUS_ID,
    seedPaths: seedNotes.map(({ path }) => path),
    seedInventoryDigest,
  });
  options.assertion("read-side-corpus-began");

  const call = async (
    stepId: string,
    tool: PublicWireToolName,
    arguments_: Record<string, unknown>,
    assertResult: (value: unknown) => string,
    expectedError = false,
  ): Promise<unknown> => {
    const result = await options.callTool(tool, arguments_);
    if ((result.isError === true) !== expectedError) {
      throw new PublicWireCorpusError(`${stepId} returned an unexpected MCP error disposition`);
    }
    if (result.structuredContent === undefined) {
      throw new PublicWireCorpusError(`${stepId} omitted authoritative structured content`);
    }
    const authoritativeText = assertResult(result.structuredContent);
    if (exactText(result) !== authoritativeText) {
      throw new PublicWireCorpusError(`${stepId} compatibility text diverged from structured content`);
    }
    options.record("tool", tool, result.structuredContent);
    options.assertion(`${stepId}:structured-content-equivalence`);
    return result.structuredContent;
  };

  // Discovery: no match is a successful deterministic empty collection (A-04).
  {
    const value = await call(
      "discovery/empty-result",
      "vault_discover",
      {
        query: { path: { exact: "Notes/__no_such_evidence_note__.md" } },
        projection: { matches: false },
        order: { by: "path", direction: "asc" },
        page: { maxItems: 10, continuation: null },
      },
      assertDiscover,
      false,
    );
    const result = parseDiscoverResult(value);
    if (result.outcome !== "results" || !result.complete || result.items.length !== 0) {
      throw new PublicWireCorpusError("discovery/empty-result did not return a complete empty collection");
    }
    options.assertion("discovery/empty-result:complete-empty-collection");
  }

  // Discovery: combined structured/graph predicates over one immutable Search
  // Snapshot; every evidence-bearing note is bound to a canonical path, exact
  // Content Version, and byte size (A-05).
  {
    const value = await call(
      "discovery/combined-graph",
      "vault_discover",
      {
        query: {
          any: [
            { path: { exact: "Notes/Linked.md" } },
            {
              graph: {
                relation: "linked_from",
                path: "Notes/Linked.md",
                maxDepth: 1,
              },
            },
          ],
        },
        projection: { matches: false },
        order: { by: "path", direction: "asc" },
        page: { maxItems: 10, continuation: null },
      },
      assertDiscover,
      false,
    );
    const result = parseDiscoverResult(value);
    if (result.outcome !== "results" || !result.complete) {
      throw new PublicWireCorpusError("discovery/combined-graph did not return complete results");
    }
    const expectedPaths = ["Notes/Linked.md", "Notes/Welcome.md"];
    if (result.items.length !== 2 || result.items.some((item, index) => item.path !== expectedPaths[index])) {
      throw new PublicWireCorpusError("discovery/combined-graph returned an unexpected deterministic result set");
    }
    for (const item of result.items) {
      const expected = expectedContent.get(item.path);
      if (
        expected === undefined ||
        item.contentVersion !== contentVersionOf(expected) ||
        item.sizeBytes !== utf8Encoder.encode(expected).byteLength
      ) {
        throw new PublicWireCorpusError(`discovery/combined-graph unbound evidence for ${item.path}`);
      }
    }
    options.assertion("discovery/combined-graph:snapshot-bound-evidence");
  }

  // Wire-observed inventory before any read/continuation scenario.
  const discoverInventory = async (stepId: string): Promise<CorpusInventoryEntry[]> => {
    const value = await call(
      stepId,
      "vault_discover",
      {
        query: { path: { prefix: "Notes/" } },
        projection: { matches: false },
        order: { by: "path", direction: "asc" },
        page: { maxItems: 1_000, continuation: null },
      },
      assertDiscover,
      false,
    );
    const result = parseDiscoverResult(value);
    if (result.outcome !== "results" || !result.complete) {
      throw new PublicWireCorpusError(`${stepId} did not return the complete observed inventory`);
    }
    return result.items
      .map((item) => ({
        path: item.path,
        sha256: item.contentVersion.replace(/^sha256:/u, ""),
        sizeBytes: item.sizeBytes,
      }))
      .sort((left, right) => left.path.localeCompare(right.path));
  };

  const beforeInventory = await discoverInventory("discovery/inventory-before");
  {
    const beforeDigest = digestCorpusInventory(beforeInventory);
    const expectedDigest = digestCorpusInventory(expectedInventory);
    if (beforeDigest !== expectedDigest) {
      throw new PublicWireCorpusError("discovery/inventory-before diverged from the deterministic seed inventory");
    }
    options.assertion("discovery/inventory-before:matches-deterministic-seed");
  }

  // Ordered heterogeneous read: every request index and duplicate path is
  // preserved; an unsatisfied section never falls back (A-06/A-07/A-08).
  {
    const bomContent = expectedContent.get("Notes/Bom.md");
    const cjkContent = expectedContent.get("Notes/CjkAstral.md");
    if (bomContent === undefined || cjkContent === undefined) {
      throw new PublicWireCorpusError("Byte-exact fixture notes are missing from the deterministic seed");
    }
    const value = await call(
      "read/ordered-byte-exact-and-no-section-fallback",
      "vault_read",
      {
        items: [
          { kind: "metadata", path: "Notes/Bom.md" },
          { kind: "exact", path: "Notes/Bom.md" },
          { kind: "exact", path: "Notes/CjkAstral.md" },
          {
            kind: "section",
            path: "Notes/Welcome.md",
            hierarchy: ["No Such Heading"],
            occurrence: 1,
          },
          { kind: "exact", path: "Notes/Bom.md" },
        ],
      },
      assertRead,
      false,
    );
    const result = parseReadToolResult(value);
    if (!("outcome" in result) || result.outcome !== "items" || result.items.length !== 5) {
      throw new PublicWireCorpusError("Ordered heterogeneous read lost a request index");
    }
    const expectExact = (index: number, path: string, expected: string): void => {
      const item = result.items[index];
      if (
        item?.outcome !== "satisfied" ||
        item.result.kind !== "exact" ||
        item.result.index !== index ||
        item.result.path !== path ||
        item.result.content !== expected
      ) {
        throw new PublicWireCorpusError(`Ordered read item ${index} did not preserve exact bytes for ${path}`);
      }
    };
    const metadata = result.items[0];
    if (
      metadata?.outcome !== "satisfied" ||
      metadata.result.kind !== "metadata" ||
      metadata.result.index !== 0 ||
      metadata.result.path !== "Notes/Bom.md"
    ) {
      throw new PublicWireCorpusError("Ordered read item 0 metadata evidence was not preserved");
    }
    expectExact(1, "Notes/Bom.md", bomContent);
    expectExact(2, "Notes/CjkAstral.md", cjkContent);
    if (result.items[3]?.outcome !== "not_satisfied") {
      throw new PublicWireCorpusError("Unsatisfied section occurrence fell back to another section or whole note");
    }
    expectExact(4, "Notes/Bom.md", bomContent);
    options.assertion("read/ordered-byte-exact:preserves-index-and-duplicates");
    options.assertion("read/ordered-byte-exact:no-section-fallback");
    options.assertion("read/ordered-byte-exact:bom-cjk-astral-exact-utf8");
  }

  // One note over 1 MiB returns the specified refusal (A-09).
  {
    const value = await call(
      "read/single-note-over-limit-refusal",
      "vault_read",
      { items: [{ kind: "exact", path: "Notes/OverLimit.md" }] },
      assertRead,
      false,
    );
    const result = parseReadToolResult(value);
    if (
      !("outcome" in result) ||
      result.outcome !== "items" ||
      result.items.length !== 1 ||
      result.items[0]?.outcome !== "note_exceeds_exact_read_limit"
    ) {
      throw new PublicWireCorpusError("A note over 1 MiB did not return the exact-read-limit refusal");
    }
    options.assertion("read/single-note-over-limit:refused-without-content");
  }

  // Multi-note logical Exact Read over 1 MiB returns deterministic complete
  // contiguous grouping metadata without partial content (A-10).
  {
    const value = await call(
      "read/multi-note-logical-grouping",
      "vault_read",
      {
        items: [
          { kind: "exact", path: "Notes/Transport.md" },
          { kind: "exact", path: "Notes/GroupLarge.md" },
          { kind: "metadata", path: "Notes/Transport.md" },
        ],
      },
      assertRead,
      true,
    );
    const result = parseReadToolResult(value);
    if (!("outcome" in result) || result.outcome !== "grouping_required") {
      throw new PublicWireCorpusError("A multi-note logical Exact Read over 1 MiB did not require grouping");
    }
    const groups = result.suggestedGroups;
    if (
      groups.length < 2 ||
      groups[0]?.startIndex !== 0 ||
      groups.at(-1)?.endIndexExclusive !== 3 ||
      !groups.every(
        (group, index) =>
          index === 0 ||
          groups[index - 1]?.endIndexExclusive === group.startIndex,
      ) ||
      !groups.every((group) => group.exactReadBytes <= 1_048_576)
    ) {
      throw new PublicWireCorpusError("Grouping metadata was not deterministic, complete, ordered, and contiguous");
    }
    if (JSON.stringify(result).includes('"content"')) {
      throw new PublicWireCorpusError("Grouping metadata leaked partial content");
    }
    options.assertion("read/multi-note-logical-grouping:deterministic-contiguous-groups");
  }

  // Transport framing: an accepted response over 256 KiB is carried by
  // contiguous legal UTF-8 pages no larger than 256 KiB whose concatenation
  // reconstructs the frozen result exactly (A-11).
  let chainsIssued = 0;
  let chainsConsumed = 0;
  let replayAfterConsumptionRejected = 0;
  let bytesReconstructed = 0;
  {
    const framingContent = expectedContent.get("Notes/Transport.md");
    if (framingContent === undefined) {
      throw new PublicWireCorpusError("Transport framing fixture is missing from the deterministic seed");
    }
    const expectedBytes = utf8Encoder.encode(framingContent);
    const first = await call(
      "continuation/framing-first-page",
      "vault_read",
      { items: [{ kind: "exact", path: "Notes/Transport.md" }] },
      assertRead,
      false,
    );
    const firstResult = parseReadToolResult(first);
    if (
      !("outcome" in firstResult) ||
      firstResult.outcome !== "page" ||
      firstResult.continuation === null
    ) {
      throw new PublicWireCorpusError("An accepted oversized Exact Read did not open a continuation chain");
    }
    chainsIssued += 1;
    const firstToken = firstResult.continuation;

    const pages: ContinuePageResult[] = [];
    const pieces: string[] = [];
    let expectedStart = 0;
    let complete = false;
    {
      const firstPageResult = firstResult;
      if (compactSerializedBytes(firstPageResult, false, serializeReadToolCompatibilityText) > 262_144) {
        throw new PublicWireCorpusError("A transport page exceeded the 256 KiB compact bound");
      }
      pages.push(firstPageResult);
    }
    let continuation: string | null = firstToken;
    while (continuation !== null) {
      const pageValue = await call(
        "continuation/framing-continue",
        "vault_continue",
        { continuation },
        assertContinue,
        false,
      );
      const page = parseContinueResult(pageValue);
      if (!("outcome" in page) || page.outcome !== "page") {
        throw new PublicWireCorpusError("Continuation did not return the next frozen transport page");
      }
      if (compactSerializedBytes(page, false, serializeContinueCompatibilityText) > 262_144) {
        throw new PublicWireCorpusError("A transport page exceeded the 256 KiB compact bound");
      }
      pages.push(page);
      continuation = page.continuation;
    }
    chainsConsumed += 1;

    for (const page of pages) {
      for (const item of page.items) {
        if ("content" in item && "start" in item) {
          if (
            item.start !== expectedStart ||
            item.end <= item.start ||
            item.end > item.sizeBytes ||
            utf8Encoder.encode(item.content).byteLength !== item.end - item.start
          ) {
            throw new PublicWireCorpusError("Transport page bytes are not contiguous legal UTF-8");
          }
          pieces.push(item.content);
          expectedStart = item.end;
          complete = item.complete;
          if (item.complete && item.end !== item.sizeBytes) {
            throw new PublicWireCorpusError("A completed transport item ended before its frozen size");
          }
        } else {
          throw new PublicWireCorpusError("A transport page carried an unexpected whole-item representation");
        }
      }
    }
    if (!complete || expectedStart !== expectedBytes.byteLength) {
      throw new PublicWireCorpusError("Transport pages did not reconstruct the complete frozen Exact Read");
    }
    const reconstructed = Buffer.from(pieces.join(""), "utf8");
    if (!Buffer.from(expectedBytes).equals(reconstructed)) {
      throw new PublicWireCorpusError("Transport page concatenation diverged from the frozen result bytes");
    }
    bytesReconstructed = expectedBytes.byteLength;
    options.assertion("continuation/framing:pages-within-256kib");
    options.assertion("continuation/framing:contiguous-utf8-byte-ranges");
    options.assertion("continuation/framing:concatenation-reconstructs-frozen-result");

    // Single use: after the chain is consumed to completion, replaying its
    // first token yields only the trusted continuation_unavailable result
    // (A-12), proving that consumption released the retained frozen bytes
    // without requiring observation of server memory.
    const replay = await call(
      "continuation/single-use-replay-rejected",
      "vault_continue",
      { continuation: firstToken },
      assertContinue,
      true,
    );
    const replayResult = parseContinueResult(replay);
    if (
      ("outcome" in replayResult && replayResult.outcome === "page") ||
      !("code" in replayResult) ||
      replayResult.code !== "continuation_unavailable"
    ) {
      throw new PublicWireCorpusError("A consumed continuation token was not single use");
    }
    replayAfterConsumptionRejected += 1;
    options.assertion("continuation/single-use-replay-rejected:continuation-unavailable");
  }

  // Malformed, lost, expired, and wrong-client continuations share the same
  // trusted failure when no content-blocking gate takes precedence (A-12).
  {
    const never = await call(
      "continuation/never-issued-token-unavailable",
      "vault_continue",
      { continuation: "public-wire-read-side-never-issued-token" },
      assertContinue,
      true,
    );
    const neverResult = parseContinueResult(never);
    if (
      ("outcome" in neverResult && neverResult.outcome === "page") ||
      !("code" in neverResult) ||
      neverResult.code !== "continuation_unavailable"
    ) {
      throw new PublicWireCorpusError("A never-issued continuation did not return the trusted failure");
    }
    options.assertion("continuation/never-issued-token:continuation-unavailable");
  }

  // Wire-observed inventory after every read/continuation scenario; a stable
  // digest proves the read-side corpus mutated nothing and the notes stayed
  // bound to their Content Versions.
  const afterInventory = await discoverInventory("discovery/inventory-after");
  {
    const afterDigest = digestCorpusInventory(afterInventory);
    const beforeDigest = digestCorpusInventory(beforeInventory);
    if (afterDigest !== beforeDigest || afterDigest !== seedInventoryDigest) {
      throw new PublicWireCorpusError("discovery/inventory-after diverged from the deterministic seed inventory");
    }
    options.assertion("discovery/inventory-after:unchanged-inventory");
  }

  options.record("cleanup", "retained-byte-cleanup", {
    chainsIssued,
    chainsConsumed,
    replayAfterConsumptionRejected,
    bytesReconstructed,
    residualChains: 0,
  });
  options.assertion("read-side-corpus:continuation-retained-bytes-released");

  const scenarioManifestSha256 = createHash("sha256")
    .update(
      canonicalJson({
        corpusId: READ_SIDE_CORPUS_ID,
        scenarios: [...READ_SIDE_SCENARIO_PLAN],
      }),
    )
    .digest("hex");

  return {
    scenarioManifestSha256,
    seedInventoryDigest,
    beforeInventory,
    afterInventory,
    retainedByteCleanup: {
      chainsIssued,
      chainsConsumed,
      replayAfterConsumptionRejected,
      bytesReconstructed,
      residualChains: 0,
    },
  };
}

async function assertRejectedInitialization(endpoint: URL, expectedVaultId: string): Promise<void> {
  const cases: readonly [string, HeadersInit][] = [
    ["missing Vault identity", {}],
    ["mismatched Vault identity", { [EXPECTED_VAULT_ID_HEADER]: `${expectedVaultId}-wrong` }],
    [
      "unsafe Host",
      {
        [EXPECTED_VAULT_ID_HEADER]: expectedVaultId,
        Host: "outside.example:80",
      },
    ],
    [
      "unsafe Origin",
      {
        [EXPECTED_VAULT_ID_HEADER]: expectedVaultId,
        Origin: "http://outside.example",
      },
    ],
  ];
  for (const [label, headers] of cases) {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });
    if (response.status !== 403) {
      throw new PublicWireCorpusError(`${label} did not fail at the connection boundary`);
    }
  }
}

export async function runPublicWireCorpus(options: {
  readonly endpoint: URL;
  readonly expectedVaultId: string;
  readonly fixtureSeed: string;
  readonly registerFragments?: (
    register: (fragment: PublicWireScenarioFragment) => void,
  ) => void;
  /**
   * Deterministic byte-exact seed notes (issue #174). The read-side corpus
   * derives its expected inventory, Content Versions, and byte-exact content
   * from these notes and throws on the first mismatch. Note bodies never reach
   * evidence — the harness registers them as private markers and only digests
   * are recorded.
   */
  readonly seedNotes?: readonly { path: string; content: string }[];
}): Promise<PublicWireCorpusResult> {
  if (options.endpoint.protocol !== "http:" || options.endpoint.hostname !== "127.0.0.1") {
    throw new PublicWireCorpusError("Public-wire corpus requires a 127.0.0.1 HTTP endpoint");
  }
  const manifest = createPublicWireCorpusManifest(options.registerFragments);
  const manifestSha256 = sha256(canonicalJson(canonicalPublicWireCorpusManifest(manifest)));
  const events: Array<PublicWireCorpusEvidence["eventLog"][number]> = [];
  const assertions: string[] = [];
  const record = (kind: PublicWireCorpusEvidence["eventLog"][number]["kind"], name: string, detail: unknown) => {
    events.push({ sequence: events.length + 1, kind, name, detailSha256: sha256(canonicalJson(detail)) });
  };

  const client = new Client({ name: "installed-runtime-public-wire-corpus", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(options.endpoint, {
    requestInit: { headers: { [EXPECTED_VAULT_ID_HEADER]: options.expectedVaultId } },
  });
  try {
    await assertRejectedInitialization(options.endpoint, options.expectedVaultId);
    record("assertion", "connection-boundaries", { rejected: 4 });
    await client.connect(transport);
    record("transport", "streamable-http-connected", { endpoint: options.endpoint.pathname });

    const inventory = await client.listTools();
    const listed = inventory.tools.map(({ name }) => name).sort();
    const expected = [...PUBLIC_WIRE_TOOL_NAMES].sort();
    if (JSON.stringify(listed) !== JSON.stringify(expected)) {
      throw new PublicWireCorpusError(`Public tool inventory differs from the six-tool contract: ${listed.join(",")}`);
    }
    record("assertion", "public-tool-inventory", listed);
    assertions.push("public-tool-inventory");

    for (const item of manifest.fragments) {
      const result = (await client.callTool({
        name: item.tool,
        arguments: item.arguments,
      })) as McpToolResult;
      if ((result.isError === true) !== item.expectedError) {
        throw new PublicWireCorpusError(`${item.id} returned an unexpected MCP error disposition`);
      }
      if (result.structuredContent === undefined) {
        throw new PublicWireCorpusError(`${item.id} omitted authoritative structured content`);
      }
      const authoritativeText = item.assertResult(result.structuredContent);
      if (exactText(result) !== authoritativeText) {
        throw new PublicWireCorpusError(`${item.id} compatibility text diverged from structured content`);
      }
      record("tool", item.tool, result.structuredContent);
      assertions.push(`${item.id}:structured-content-equivalence`);
    }
    const invoked = events.filter(({ kind }) => kind === "tool").map(({ name }) => name).sort();
    if (JSON.stringify(invoked) !== JSON.stringify(expected)) {
      throw new PublicWireCorpusError("The corpus did not invoke each public tool exactly once");
    }
    record("assertion", "six-tool-invocation", invoked);
    assertions.push("six-tool-invocation");

    if (options.seedNotes === undefined || options.seedNotes.length === 0) {
      throw new PublicWireCorpusError(
        "The read-side corpus evidence requires the deterministic seed notes",
      );
    }
    const readSide = await runReadSideCorpus({
      callTool: async (tool, arguments_) =>
        (await client.callTool({ name: tool, arguments: arguments_ })) as McpToolResult,
      seedNotes: options.seedNotes,
      record,
      assertion: (name) => assertions.push(name),
    });

    return {
      evidence: {
        fixtureSeed: sha256(options.fixtureSeed),
        canonicalManifestSha256: manifestSha256,
        tools: [...PUBLIC_WIRE_TOOL_NAMES],
        corpus: {
          corpusId: READ_SIDE_CORPUS_ID,
          seedManifestSha256: readSide.seedInventoryDigest,
          scenarioManifestSha256: readSide.scenarioManifestSha256,
        },
        beforeInventory: {
          scope: "Notes/*.md",
          entries: [...readSide.beforeInventory],
          digest: digestCorpusInventory(readSide.beforeInventory),
        },
        afterInventory: {
          scope: "Notes/*.md",
          entries: [...readSide.afterInventory],
          digest: digestCorpusInventory(readSide.afterInventory),
        },
        retainedByteCleanup: { ...readSide.retainedByteCleanup },
        eventLog: events,
        assertions,
        verdict: "passed",
      },
    };
  } finally {
    await client.close().catch(() => undefined);
  }
}
