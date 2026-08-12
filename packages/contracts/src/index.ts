import { z } from "zod";

const contentVersionSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/u);
const canonicalMarkdownPathSchema = z.string().regex(
  /^(?!\/)(?!.*\\)(?!.*(?:^|\/)(?:\.{1,2})(?:\/|$))(?!.*\/\/).+\.md$/u,
  "path must be a canonical Vault-relative Markdown path",
);

const metadataReadRequestSchema = z
  .object({ kind: z.literal("metadata"), path: canonicalMarkdownPathSchema })
  .strict();
const outlineReadRequestSchema = z
  .object({ kind: z.literal("outline"), path: canonicalMarkdownPathSchema })
  .strict();
const sectionReadRequestSchema = z
  .object({
    kind: z.literal("section"),
    path: canonicalMarkdownPathSchema,
    hierarchy: z.array(z.string().min(1)).min(1),
    occurrence: z.number().int().positive(),
  })
  .strict();
const exactReadRequestSchema = z
  .object({ kind: z.literal("exact"), path: canonicalMarkdownPathSchema })
  .strict();

const readRequestSchema = z.discriminatedUnion("kind", [
  metadataReadRequestSchema,
  outlineReadRequestSchema,
  sectionReadRequestSchema,
  exactReadRequestSchema,
]);

export const readInputSchema = z
  .object({ items: z.array(readRequestSchema).min(1) })
  .strict();

const jsonValueSchema: z.ZodType<unknown> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
);

const discoverPathSchema = z.string().regex(
  /^(?!\/)(?!.*\\)(?!.*(?:^|\/)(?:\.{1,2})(?:\/|$))(?!.*\/\/).+$/u,
  "path must be canonical and Vault-relative",
);

function hasValidRegularExpression(pattern: string): boolean {
  try {
    return !new RegExp(pattern, "u").test("");
  } catch {
    return false;
  }
}

const pathDiscoverQuerySchema = z
  .object({
    path: z.union([
      z.object({ exact: canonicalMarkdownPathSchema }).strict(),
      z.object({ prefix: discoverPathSchema }).strict(),
      z.object({ glob: discoverPathSchema }).strict(),
    ]),
  })
  .strict();
const filenameDiscoverQuerySchema = z
  .object({
    filename: z.union([
      z.object({ exact: z.string().min(1), caseSensitive: z.boolean() }).strict(),
      z.object({ substring: z.string().min(1), caseSensitive: z.boolean() }).strict(),
    ]),
  })
  .strict();
const textDiscoverQuerySchema = z
  .object({
    text: z.union([
      z.object({ literal: z.string().min(1), caseSensitive: z.boolean() }).strict(),
      z
        .object({ regex: z.string().min(1), caseSensitive: z.boolean() })
        .strict()
        .refine(({ regex }) => hasValidRegularExpression(regex), {
          message: "regex must be valid and must not match empty text",
        }),
    ]),
  })
  .strict();

type DiscoverQueryNode =
  | z.infer<typeof pathDiscoverQuerySchema>
  | z.infer<typeof filenameDiscoverQuerySchema>
  | z.infer<typeof textDiscoverQuerySchema>
  | { all: DiscoverQueryNode[] }
  | { any: DiscoverQueryNode[] }
  | { not: DiscoverQueryNode };

const discoverQuerySchema: z.ZodType<DiscoverQueryNode> = z.lazy(() =>
  z.union([
    pathDiscoverQuerySchema,
    filenameDiscoverQuerySchema,
    textDiscoverQuerySchema,
    z.object({ all: z.array(discoverQuerySchema).min(1) }).strict(),
    z.object({ any: z.array(discoverQuerySchema).min(1) }).strict(),
    z.object({ not: discoverQuerySchema }).strict(),
  ]),
);

function containsPositiveTextQuery(query: DiscoverQueryNode): boolean {
  if ("all" in query) return query.all.some(containsPositiveTextQuery);
  if ("any" in query) return query.any.some(containsPositiveTextQuery);
  if ("not" in query) return false;
  return "text" in query;
}

const discoverOrderingSchema = z
  .object({ by: z.literal("path"), direction: z.enum(["asc", "desc"]) })
  .strict();

export const discoverInputSchema = z
  .object({
    query: discoverQuerySchema,
    projection: z.object({ matches: z.boolean() }).strict(),
    order: discoverOrderingSchema,
    page: z
      .object({
        maxItems: z.number().int().min(1).max(1_000),
        continuation: z.string().min(1).nullable(),
      })
      .strict(),
  })
  .strict()
  .refine(
    ({ query, projection }) =>
      !projection.matches || containsPositiveTextQuery(query),
    { message: "matches projection requires a positive text query" },
  );

const discoverMatchSchema = z
  .object({
    line: z.number().int().positive(),
    startByte: z.number().int().nonnegative(),
    endByteExclusive: z.number().int().positive(),
    text: z.string().min(1),
  })
  .strict()
  .refine(({ startByte, endByteExclusive }) => startByte < endByteExclusive, {
    message: "match byte range must be non-empty",
  });
const discoverItemSchema = z
  .object({
    path: canonicalMarkdownPathSchema,
    contentVersion: contentVersionSchema,
    sizeBytes: z.number().int().nonnegative(),
    matches: z.array(discoverMatchSchema).optional(),
  })
  .strict();
const discoverResultsSchema = z
  .object({
    outcome: z.literal("results"),
    ordering: discoverOrderingSchema.extend({ tieBreaker: z.literal("path_utf8_bytes") }).strict(),
    items: z.array(discoverItemSchema),
    complete: z.boolean(),
    continuation: z.string().min(1).nullable(),
  })
  .strict()
  .refine(({ complete, continuation }) => complete === (continuation === null), {
    message: "complete results must not expose a continuation",
  });
const discoverSnapshotUnavailableSchema = z
  .object({
    outcome: z.literal("snapshot_unavailable"),
    code: z.literal("search_snapshot_unavailable"),
  })
  .strict();

export const discoverResultSchema = z.union([
  discoverResultsSchema,
  discoverSnapshotUnavailableSchema,
  z
    .object({
      outcome: z.literal("operationally_blocked"),
      gate: z
        .object({
          code: z.enum([
            "recovery_in_progress",
            "recovery_blocked",
            "incompatible_protocol",
          ]),
        })
        .strict(),
    })
    .strict(),
]);

export type DiscoverInput = z.infer<typeof discoverInputSchema>;
export type DiscoverQuery = z.infer<typeof discoverQuerySchema>;
export type DiscoverResult = z.infer<typeof discoverResultSchema>;
export type DiscoverItem = z.infer<typeof discoverItemSchema>;

export function parseDiscoverInput(value: unknown): DiscoverInput {
  return discoverInputSchema.parse(value);
}

export function parseDiscoverResult(value: unknown): DiscoverResult {
  return discoverResultSchema.parse(value);
}

export function serializeDiscoverCompatibilityText(value: DiscoverResult): string {
  return JSON.stringify(parseDiscoverResult(value));
}

export function createDiscoverInputJsonSchema(): Record<string, unknown> {
  return {
    $id: "https://canxer314.github.io/obsidian-llm-wiki-cli/contracts/v1/vault-discover.input.schema.json",
    title: "vault_discover v1 input",
    ...z.toJSONSchema(discoverInputSchema, { target: "draft-2020-12", reused: "ref" }),
  };
}

export function createDiscoverResultJsonSchema(): Record<string, unknown> {
  return {
    $id: "https://canxer314.github.io/obsidian-llm-wiki-cli/contracts/v1/vault-discover.output.schema.json",
    title: "vault_discover v1 output",
    ...z.toJSONSchema(discoverResultSchema, { target: "draft-2020-12", reused: "ref" }),
  };
}

const readEvidenceSchema = z.object({
  index: z.number().int().nonnegative(),
  path: canonicalMarkdownPathSchema,
  contentVersion: contentVersionSchema,
  sizeBytes: z.number().int().nonnegative(),
});

const metadataReadResultSchema = readEvidenceSchema
  .extend({
    kind: z.literal("metadata"),
    frontmatter: z.record(z.string(), jsonValueSchema).nullable(),
  })
  .strict();
const outlineReadResultSchema = readEvidenceSchema
  .extend({
    kind: z.literal("outline"),
    headings: z.array(
      z
        .object({
          heading: z.string(),
          level: z.number().int().min(1).max(6),
        })
        .strict(),
    ),
  })
  .strict();
const sectionReadResultSchema = readEvidenceSchema
  .extend({
    kind: z.literal("section"),
    hierarchy: z.array(z.string().min(1)).min(1),
    occurrence: z.number().int().positive(),
    content: z.string(),
  })
  .strict();
const exactReadResultSchema = readEvidenceSchema
  .extend({ kind: z.literal("exact"), content: z.string() })
  .strict();

const typedReadResultSchema = z.discriminatedUnion("kind", [
  metadataReadResultSchema,
  outlineReadResultSchema,
  sectionReadResultSchema,
  exactReadResultSchema,
]);

const readItemResultSchema = z.union([
  z.object({ outcome: z.literal("satisfied"), result: typedReadResultSchema }).strict(),
  z.object({ outcome: z.literal("not_satisfied") }).strict(),
  z.object({ outcome: z.literal("note_exceeds_exact_read_limit") }).strict(),
]);

const groupingRequiredSchema = z
  .object({
    outcome: z.literal("grouping_required"),
    suggestedGroups: z
      .array(
        z
          .object({
            startIndex: z.number().int().nonnegative(),
            endIndexExclusive: z.number().int().positive(),
            exactReadBytes: z.number().int().nonnegative(),
          })
          .strict()
          .refine((group) => group.startIndex < group.endIndexExclusive, {
            message: "group must contain at least one request index",
          }),
      )
      .min(2),
  })
  .strict()
  .refine(
    ({ suggestedGroups }) =>
      suggestedGroups[0]?.startIndex === 0 &&
      suggestedGroups.every(
        (group, index) =>
          index === 0 ||
          suggestedGroups[index - 1]?.endIndexExclusive === group.startIndex,
      ),
    { message: "suggested groups must be ordered and contiguous" },
  );

const contentOperationalGateSchema = z
  .object({
    code: z.enum([
      "recovery_in_progress",
      "recovery_blocked",
      "incompatible_protocol",
    ]),
  })
  .strict();

const operationallyBlockedReadResultSchema = z
  .object({
    outcome: z.literal("operationally_blocked"),
    gate: contentOperationalGateSchema,
  })
  .strict();

export const readResultSchema = z.union([
  z.object({ outcome: z.literal("items"), items: z.array(readItemResultSchema) }).strict(),
  groupingRequiredSchema,
  operationallyBlockedReadResultSchema,
]);

export type ReadInput = z.infer<typeof readInputSchema>;
export type ReadRequest = z.infer<typeof readRequestSchema>;
export type ReadResult = z.infer<typeof readResultSchema>;
export type TypedReadResult = z.infer<typeof typedReadResultSchema>;

export function parseReadInput(value: unknown): ReadInput {
  return readInputSchema.parse(value);
}

export function parseReadResult(value: unknown): ReadResult {
  return readResultSchema.parse(value);
}

export function serializeReadCompatibilityText(value: ReadResult): string {
  return JSON.stringify(parseReadResult(value));
}

export function createReadInputJsonSchema(): Record<string, unknown> {
  return {
    $id: "https://canxer314.github.io/obsidian-llm-wiki-cli/contracts/v1/vault-read.input.schema.json",
    title: "vault_read v1 input",
    ...z.toJSONSchema(readInputSchema, { target: "draft-2020-12", reused: "ref" }),
  };
}

export function createReadResultJsonSchema(): Record<string, unknown> {
  return {
    $id: "https://canxer314.github.io/obsidian-llm-wiki-cli/contracts/v1/vault-read.output.schema.json",
    title: "vault_read v1 output",
    ...z.toJSONSchema(readResultSchema, { target: "draft-2020-12", reused: "ref" }),
  };
}

export const CONTRACT_VERSION = "1.0.0";

const supportedProtocolRangeSchema = z
  .object({
    major: z.number().int().nonnegative(),
    minimumMinor: z.number().int().nonnegative(),
    maximumMinor: z.number().int().nonnegative(),
  })
  .strict()
  .refine((range) => range.minimumMinor <= range.maximumMinor, {
    message: "minimumMinor must not exceed maximumMinor",
  });

const protocolParticipantSchema = z
  .object({
    protocol: z.string().regex(/^\d+\.\d+$/u),
    supported: supportedProtocolRangeSchema,
  })
  .strict();

const operationalGateWithoutIncompatibleSchema = z
  .object({
    code: z.enum([
      "writes_paused",
      "upgrade_in_progress",
      "recovery_in_progress",
      "recovery_blocked",
    ]),
  })
  .strict();

const observedHealthResultSchema = z
  .object({
    outcome: z.literal("observed"),
    vault: z
      .object({
        id: z.string().min(1),
        name: z.string(),
        path: z.string().min(1),
      })
      .strict(),
    versions: z
      .object({
        bridge: z.string().min(1),
        plugin: z.string().min(1),
        protocol: z.string().regex(/^\d+\.\d+$/u),
        persistentStateSchema: z.number().int().positive(),
        recoveryJournalSchema: z.number().int().positive(),
      })
      .strict(),
    listener: z
      .object({
        address: z.literal("127.0.0.1"),
        port: z.number().int().min(1).max(65_535),
      })
      .strict(),
    readiness: z
      .object({
        searchSnapshot: z.enum(["ready", "building", "unavailable"]),
        cache: z.enum(["ready", "building", "unavailable"]),
        index: z.enum(["ready", "building", "unavailable"]),
      })
      .strict(),
    recovery: z
      .object({
        state: z.enum(["none", "in_progress", "blocked"]),
      })
      .strict(),
    write: z
      .object({
        gate: z.enum(["open", "blocked"]),
        state: z.enum(["writable", "pausing", "paused"]),
        pauseSource: z.enum(["manual", "maintenance"]).nullable(),
      })
      .strict(),
    queue: z
      .object({
        currentExecutionId: z.string().min(1).nullable(),
        length: z.number().int().nonnegative(),
        headChangeSetId: z.string().min(1).nullable(),
      })
      .strict(),
    lifecycle: z
      .object({
        startup: z.enum(["ready", "failed"]),
        upgrade: z.enum(["not_run", "succeeded", "failed"]),
        migration: z.enum(["not_run", "succeeded", "failed"]),
        recovery: z.enum(["not_run", "succeeded", "failed"]),
      })
      .strict(),
    effectiveGate: operationalGateWithoutIncompatibleSchema.nullable(),
    overall: z.enum(["healthy", "degraded", "blocked"]),
    reasonCodes: z.array(z.string().min(1)),
    operatorAction: z.enum([
      "none",
      "finish_initialization",
      "wait_for_readiness",
      "wait_for_recovery",
      "review_recovery",
      "resume_writes",
      "finish_upgrade",
    ]),
  })
  .strict();

const incompatibleHealthResultSchema = z
  .object({
    outcome: z.literal("incompatible"),
    gate: z.object({ code: z.literal("incompatible_protocol") }).strict(),
    compatibility: z
      .object({
        local: protocolParticipantSchema,
        peer: protocolParticipantSchema,
      })
      .strict(),
  })
  .strict();

export const healthResultSchema = z.discriminatedUnion("outcome", [
  observedHealthResultSchema,
  incompatibleHealthResultSchema,
]);

export type HealthResult = z.infer<typeof healthResultSchema>;

export function createHealthResultJsonSchema(): Record<string, unknown> {
  return {
    $id: "https://canxer314.github.io/obsidian-llm-wiki-cli/contracts/v1/vault-health.output.schema.json",
    title: "vault_health v1 output",
    ...z.toJSONSchema(healthResultSchema, {
      target: "draft-2020-12",
      reused: "ref",
    }),
  };
}

export function createHealthInputJsonSchema(): Record<string, unknown> {
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: "https://canxer314.github.io/obsidian-llm-wiki-cli/contracts/v1/vault-health.input.schema.json",
    title: "vault_health v1 input",
    type: "object",
    properties: {},
    additionalProperties: false,
  };
}

export function parseHealthResult(value: unknown): HealthResult {
  return healthResultSchema.parse(value);
}

export function serializeCompatibilityText(value: HealthResult): string {
  return JSON.stringify(parseHealthResult(value));
}
