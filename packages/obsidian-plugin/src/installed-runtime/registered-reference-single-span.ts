import { createHash, randomUUID } from "node:crypto";
import { parseChangeSetSubmitResult, parseDiscoverResult, parseReadResult, serializeChangeSetSubmitCompatibilityText, serializeDiscoverCompatibilityText, serializeReadCompatibilityText } from "@llm-wiki/vault-contracts";
import { z } from "zod";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { EXPECTED_VAULT_ID_HEADER } from "../request-policy.js";
import { installedLoopbackFetch } from "./installed-semantic-evidence.js";
import { spliceVerifiedReference } from "../move-reference-projection.js";
import type { RegisteredReferenceRewriteFixture, WireClient } from "./registered-reference-rewrite-corpus.js";

export const SINGLE_SPAN_SCENARIO = "span/second-equal-spelling-only";
export const SINGLE_SPAN_PATH = "ReferenceProof/Single/Ref.md";
export const SINGLE_SPAN_BEFORE = "﻿# 参考\r\n第一 [[One|别名]]  \t\r\n中文 😀 第二 [[One|别名]]  \t尾行\r\n";
export const SINGLE_SPAN_AFTER = "﻿# 参考\r\n第一 [[One|别名]]  \t\r\n中文 😀 第二 [[One Moved|别名]]  \t尾行\r\n";
export function singleSpanFixtures(): readonly RegisteredReferenceRewriteFixture[] {
  return [
    { path: "ReferenceProof/Single/One.md", content: "# One\r\n" },
    { path: "ReferenceProof/Single/One Moved.md", content: "# One Moved\r\n" },
    { path: SINGLE_SPAN_PATH, content: SINGLE_SPAN_BEFORE },
  ];
}
const digest = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
export function validateReferenceSingleSpanBytes(proof: ReferenceSingleSpanProof, before: Uint8Array | null, after: Uint8Array | null): void {
  if (before === null || after === null || !Buffer.from(before).equals(Buffer.from(SINGLE_SPAN_BEFORE)) || !Buffer.from(after).equals(Buffer.from(SINGLE_SPAN_AFTER)) ||
      proof.beforeSha256 !== digest(before) || proof.afterSha256 !== digest(after) ||
      !Buffer.from(before.slice(0, 58)).equals(Buffer.from(after.slice(0, 58))) ||
      !Buffer.from(before.slice(72)).equals(Buffer.from(after.slice(78)))) throw new Error("A-26 second verified span changed untouched bytes");
}
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
export const referenceSingleSpanProofSchema = z.object({
  scenario: z.literal(SINGLE_SPAN_SCENARIO),
  fixturePath: z.literal(SINGLE_SPAN_PATH),
  fixtureSha256: sha256Schema,
  beforeSha256: sha256Schema,
  afterSha256: sha256Schema,
  referencesLocated: z.literal(2),
  selectedOrdinal: z.literal(2),
  selectedSpan: z.object({ startByte: z.literal(58), endByteExclusive: z.literal(72) }).strict(),
  beforeSizeBytes: z.literal(83),
  afterSizeBytes: z.literal(89),
  untouchedPrefixSha256: sha256Schema,
  untouchedSuffixSha256: sha256Schema,
  untouchedPrefixExact: z.literal(true),
  untouchedSuffixExact: z.literal(true),
  firstReferenceExact: z.literal(true),
  fullBytesExact: z.literal(true),
  finalBytesHashReread: z.literal(true),
}).strict().superRefine((proof, context) => {
  const before = Buffer.from(SINGLE_SPAN_BEFORE);
  if (proof.fixtureSha256 !== digest(before) || proof.beforeSha256 !== digest(before) ||
      proof.afterSha256 !== digest(Buffer.from(SINGLE_SPAN_AFTER)) ||
      proof.untouchedPrefixSha256 !== digest(before.subarray(0, 58)) ||
      proof.untouchedSuffixSha256 !== digest(before.subarray(72))) {
    context.addIssue({ code: "custom", message: "A-26 byte proof digests do not match the fixed fixture" });
  }
});
export type ReferenceSingleSpanProof = z.infer<typeof referenceSingleSpanProofSchema>;

export async function executeInstalledReferenceSingleSpan(options: {
  readonly endpoint: URL;
  readonly expectedVaultId: string;
  readonly readBinary: (path: string) => Promise<Uint8Array | null>;
}): Promise<ReferenceSingleSpanProof> {
  const client = new Client({ name: "installed-a26-single-span", version: "1.0.0" });
  try {
    await client.connect(new StreamableHTTPClientTransport(options.endpoint, {
      fetch: installedLoopbackFetch, requestInit: { headers: { [EXPECTED_VAULT_ID_HEADER]: options.expectedVaultId } },
    }));
    return await executeReferenceSingleSpanScenario({ readBinary: options.readBinary, callTool: async (tool, args) =>
      await client.callTool({ name: tool, arguments: args }) as Awaited<ReturnType<WireClient["callTool"]>> });
  } finally { await client.close(); }
}

/** Runs inside the candidate for installed acceptance; no private/direct mutation route. */
export async function executeReferenceSingleSpanScenario(options: {
  readonly callTool: WireClient["callTool"];
  readonly readBinary: (path: string) => Promise<Uint8Array | null>;
}): Promise<ReferenceSingleSpanProof> {
  const before = await options.readBinary(SINGLE_SPAN_PATH);
  if (before === null || !Buffer.from(before).equals(Buffer.from(SINGLE_SPAN_BEFORE))) throw new Error("A-26 second verified span fixture bytes changed");
  const wire = async (tool: Parameters<WireClient["callTool"]>[0], input: Record<string, unknown>, serialize: (value: unknown) => string): Promise<unknown> => {
    const result = await options.callTool(tool, input);
    if (result.isError === true || result.structuredContent === undefined ||
        !result.content?.some(item => typeof item === "object" && item !== null && (item as { type?: unknown }).type === "text" && (item as { text?: unknown }).text === serialize(result.structuredContent))) throw new Error("A-26 wire response diverged");
    return result.structuredContent;
  };
  const discovered = parseDiscoverResult(await wire("vault_discover", {
    query: { path: { exact: SINGLE_SPAN_PATH } }, projection: { matches: false, references: true },
    order: { by: "path", direction: "asc" }, page: { maxItems: 1, continuation: null },
  }, value => serializeDiscoverCompatibilityText(parseDiscoverResult(value))));
  if (discovered.outcome !== "results" || !discovered.complete || discovered.items.length !== 1) throw new Error("A-26 registered reference evidence is absent");
  const item = discovered.items[0]!;
  const references = item.references;
  if (item.contentVersion !== `sha256:${digest(before)}` || item.sizeBytes !== before.byteLength || references?.length !== 2 || references.some(ref => ref.profile !== "wikilink" || ref.original !== "[[One|别名]]" || ref.target !== "One" || ref.resolvedPath !== "ReferenceProof/Single/One.md" || !Buffer.from(before.slice(ref.startByte, ref.endByteExclusive)).equals(Buffer.from(ref.original)))) throw new Error("A-26 second verified span references are inconsistent");
  const selected = references[1]!;
  // Independently known offsets from the fixture, not UTF-16 character indexes.
  if (references[0]!.startByte !== 20 || selected.startByte !== 58 || selected.endByteExclusive !== 72) throw new Error("A-26 second verified span offset mismatch");
  const projected = spliceVerifiedReference(before, selected, "One Moved");
  const expected = Buffer.from(SINGLE_SPAN_AFTER);
  if (projected === null || !Buffer.from(projected).equals(expected)) throw new Error("A-26 second verified span projection changed untouched bytes");
  // The splice output is persisted via an ordinary version-guarded Change Set.
  // replace_whole preserves the original BOM and does not normalize line endings.
  const submitted = parseChangeSetSubmitResult(await wire("vault_change_set_submit", {
    submissionKey: `a26-${randomUUID()}`, operations: [{ operationId: "a26-second-span", kind: "edit_body", path: SINGLE_SPAN_PATH,
      targetVersion: item.contentVersion, edit: { kind: "replace_whole", replacement: Buffer.from(projected).toString("utf8").slice(1) } }],
  }, value => serializeChangeSetSubmitCompatibilityText(parseChangeSetSubmitResult(value))));
  if (submitted.outcome !== "registered" || submitted.changeSet.state !== "intent_applied") throw new Error("A-26 second verified span did not apply");
  const after = await options.readBinary(SINGLE_SPAN_PATH);
  if (after === null || !Buffer.from(after).equals(expected) ||
      !Buffer.from(before.slice(0, selected.startByte)).equals(Buffer.from(after.slice(0, selected.startByte))) ||
      !Buffer.from(before.slice(selected.endByteExclusive)).equals(Buffer.from(after.slice(selected.endByteExclusive + 6)))) throw new Error("A-26 second verified span changed untouched bytes");
  const reread = parseReadResult(await wire("vault_read", { items: [{ kind: "exact", path: SINGLE_SPAN_PATH }] }, value => serializeReadCompatibilityText(parseReadResult(value))));
  const read = reread.outcome === "items" && reread.items.length === 1 ? reread.items[0] : null;
  if (read?.outcome !== "satisfied" || read.result.kind !== "exact" || read.result.contentVersion !== `sha256:${digest(after)}` || !Buffer.from(read.result.content).equals(expected)) throw new Error("A-26 second verified span final bytes were not reread");
  return referenceSingleSpanProofSchema.parse({
    scenario: SINGLE_SPAN_SCENARIO, fixturePath: SINGLE_SPAN_PATH, fixtureSha256: digest(Buffer.from(SINGLE_SPAN_BEFORE)),
    beforeSha256: digest(before), afterSha256: digest(after), referencesLocated: 2, selectedOrdinal: 2,
    selectedSpan: { startByte: selected.startByte, endByteExclusive: selected.endByteExclusive },
    beforeSizeBytes: before.byteLength, afterSizeBytes: after.byteLength,
    untouchedPrefixSha256: digest(before.slice(0, selected.startByte)), untouchedSuffixSha256: digest(before.slice(selected.endByteExclusive)),
    untouchedPrefixExact: true, untouchedSuffixExact: true, firstReferenceExact: true, fullBytesExact: true, finalBytesHashReread: true,
  });
}
