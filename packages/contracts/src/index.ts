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

const registeredReferenceProfileSchema = z.enum([
  "wikilink",
  "embed",
  "markdown_inline_link",
  "markdown_embed",
]);
const frontmatterScalarSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);
const frontmatterDiscoverQuerySchema = z
  .object({
    frontmatter: z.union([
      z.object({ key: z.string().min(1), equals: jsonValueSchema }).strict(),
      z.object({ key: z.string().min(1), contains: frontmatterScalarSchema }).strict(),
      z.object({ key: z.string().min(1), exists: z.boolean() }).strict(),
    ]),
  })
  .strict();
const tagDiscoverQuerySchema = z
  .object({ tag: z.object({ exact: z.string().regex(/^#[^\s#]+$/u) }).strict() })
  .strict();
const referenceDiscoverQuerySchema = z
  .object({
    reference: z
      .object({
        profile: registeredReferenceProfileSchema,
        target: z.string().min(1),
      })
      .strict(),
  })
  .strict();
const backlinkDiscoverQuerySchema = z
  .object({ backlink: z.object({ from: canonicalMarkdownPathSchema }).strict() })
  .strict();
const unresolvedLinkDiscoverQuerySchema = z
  .object({ unresolvedLink: z.object({ target: z.string().min(1) }).strict() })
  .strict();
const graphDiscoverQuerySchema = z
  .object({
    graph: z
      .object({
        relation: z.enum(["links_to", "linked_from"]),
        path: canonicalMarkdownPathSchema,
        maxDepth: z.number().int().min(1).max(32),
      })
      .strict(),
  })
  .strict();

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
  | z.infer<typeof frontmatterDiscoverQuerySchema>
  | z.infer<typeof tagDiscoverQuerySchema>
  | z.infer<typeof referenceDiscoverQuerySchema>
  | z.infer<typeof backlinkDiscoverQuerySchema>
  | z.infer<typeof unresolvedLinkDiscoverQuerySchema>
  | z.infer<typeof graphDiscoverQuerySchema>
  | { all: DiscoverQueryNode[] }
  | { any: DiscoverQueryNode[] }
  | { not: DiscoverQueryNode };

const discoverQuerySchema: z.ZodType<DiscoverQueryNode> = z.lazy(() =>
  z.union([
    pathDiscoverQuerySchema,
    filenameDiscoverQuerySchema,
    textDiscoverQuerySchema,
    frontmatterDiscoverQuerySchema,
    tagDiscoverQuerySchema,
    referenceDiscoverQuerySchema,
    backlinkDiscoverQuerySchema,
    unresolvedLinkDiscoverQuerySchema,
    graphDiscoverQuerySchema,
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
    projection: z
      .object({
        matches: z.boolean(),
        outline: z.boolean().optional(),
        frontmatter: z.boolean().optional(),
        references: z.boolean().optional(),
      })
      .strict(),
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
const discoverReferenceEvidenceSchema = z
  .object({
    profile: registeredReferenceProfileSchema,
    target: z.string().min(1),
    resolvedPath: discoverPathSchema.nullable(),
    original: z.string().min(1),
    startByte: z.number().int().nonnegative(),
    endByteExclusive: z.number().int().positive(),
  })
  .strict()
  .refine(({ startByte, endByteExclusive }) => startByte < endByteExclusive, {
    message: "reference byte range must be non-empty",
  });
const discoverOutlineHeadingSchema = z
  .object({
    heading: z.string(),
    level: z.number().int().min(1).max(6),
  })
  .strict();
const discoverItemSchema = z
  .object({
    path: canonicalMarkdownPathSchema,
    contentVersion: contentVersionSchema,
    sizeBytes: z.number().int().nonnegative(),
    matches: z.array(discoverMatchSchema).optional(),
    outline: z.array(discoverOutlineHeadingSchema).optional(),
    frontmatter: z.record(z.string(), jsonValueSchema).nullable().optional(),
    references: z.array(discoverReferenceEvidenceSchema).optional(),
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
    ...z.toJSONSchema(readToolResultSchema, { target: "draft-2020-12", reused: "ref" }),
  };
}

const nonContentReadItemResultSchema = z.union([
  z
    .object({
      outcome: z.literal("satisfied"),
      result: z.union([metadataReadResultSchema, outlineReadResultSchema]),
    })
    .strict(),
  z.object({ outcome: z.literal("not_satisfied") }).strict(),
  z.object({ outcome: z.literal("note_exceeds_exact_read_limit") }).strict(),
]);

const continuedExactItemSchema = readEvidenceSchema
  .extend({
    kind: z.literal("exact"),
    start: z.number().int().nonnegative(),
    end: z.number().int().positive(),
    content: z.string(),
    complete: z.boolean(),
  })
  .strict();

const continuedSectionItemSchema = readEvidenceSchema
  .extend({
    kind: z.literal("section"),
    hierarchy: z.array(z.string().min(1)).min(1),
    occurrence: z.number().int().positive(),
    start: z.number().int().nonnegative(),
    end: z.number().int().positive(),
    content: z.string(),
    complete: z.boolean(),
  })
  .strict();

const continuedContentItemSchema = z
  .union([continuedExactItemSchema, continuedSectionItemSchema])
  .refine((item) => item.start < item.end, {
    message: "continued byte range must be non-empty",
  })
  .refine(
    (item) => new TextEncoder().encode(item.content).byteLength === item.end - item.start,
    { message: "content must exactly match the declared UTF-8 byte range" },
  );

const continuedWholeItemSchema = z
  .object({
    index: z.number().int().nonnegative(),
    item: nonContentReadItemResultSchema,
  })
  .strict();

const continuedItemChunkSchema = z
  .object({
    kind: z.literal("item"),
    index: z.number().int().nonnegative(),
    sizeBytes: z.number().int().positive(),
    start: z.number().int().nonnegative(),
    end: z.number().int().positive(),
    content: z.string(),
    complete: z.boolean(),
  })
  .strict()
  .refine((item) => item.start < item.end && item.end <= item.sizeBytes, {
    message: "continued item byte range must be non-empty and within its frozen size",
  })
  .refine(
    (item) => new TextEncoder().encode(item.content).byteLength === item.end - item.start,
    { message: "item content must exactly match the declared UTF-8 byte range" },
  )
  .refine((item) => item.complete === (item.end === item.sizeBytes), {
    message: "only the final item chunk is complete",
  });

const continuePageItemSchema = z.union([
  continuedContentItemSchema,
  continuedWholeItemSchema,
  continuedItemChunkSchema,
]);

const continuePageResultSchema = z
  .object({
    outcome: z.literal("page"),
    items: z.array(continuePageItemSchema).min(1),
    continuation: z.string().min(1).nullable(),
    complete: z.boolean(),
  })
  .strict()
  .refine(
    (page) =>
      (page.complete && page.continuation === null) ||
      (!page.complete && page.continuation !== null),
    { message: "only incomplete pages carry a replacement continuation" },
  );

const continuationUnavailableSchema = z
  .object({ code: z.literal("continuation_unavailable") })
  .strict();

export const readToolResultSchema = z.union([
  readResultSchema,
  continuePageResultSchema,
  continuationUnavailableSchema,
]);

export type ReadToolResult = z.infer<typeof readToolResultSchema>;

export function parseReadToolResult(value: unknown): ReadToolResult {
  return readToolResultSchema.parse(value);
}

export function serializeReadToolCompatibilityText(value: ReadToolResult): string {
  return JSON.stringify(parseReadToolResult(value));
}

export const continueInputSchema = z
  .object({ continuation: z.string().min(1) })
  .strict();

export const continueResultSchema = z.union([
  continuePageResultSchema,
  continuationUnavailableSchema,
  operationallyBlockedReadResultSchema,
]);

export type ContinueInput = z.infer<typeof continueInputSchema>;
export type ContinuePageResult = z.infer<typeof continuePageResultSchema>;
export type ContinueResult = z.infer<typeof continueResultSchema>;

export function parseContinueInput(value: unknown): ContinueInput {
  return continueInputSchema.parse(value);
}

export function parseContinueResult(value: unknown): ContinueResult {
  return continueResultSchema.parse(value);
}

export function serializeContinueCompatibilityText(value: ContinueResult): string {
  return JSON.stringify(parseContinueResult(value));
}

export function createContinueInputJsonSchema(): Record<string, unknown> {
  return {
    $id: "https://canxer314.github.io/obsidian-llm-wiki-cli/contracts/v1/vault-continue.input.schema.json",
    title: "vault_continue v1 input",
    ...z.toJSONSchema(continueInputSchema, { target: "draft-2020-12", reused: "ref" }),
  };
}

export function createContinueResultJsonSchema(): Record<string, unknown> {
  return {
    $id: "https://canxer314.github.io/obsidian-llm-wiki-cli/contracts/v1/vault-continue.output.schema.json",
    title: "vault_continue v1 output",
    ...z.toJSONSchema(continueResultSchema, { target: "draft-2020-12", reused: "ref" }),
  };
}

const canonicalVaultPathSchema = z.string().min(1).regex(
  /^(?!\/)(?!.*\\)(?!.*(?:^|\/)(?:\.{1,2})(?:\/|$))(?!.*\/\/)(?!.*\/$).+$/u,
  "path must be canonical and Vault-relative",
);
const attachmentSha256Schema = z.string().regex(/^[0-9a-f]{64}$/u);
const operationIdSchema = z.string().min(1);
const operationKinds = [
  "create_directory",
  "create_note",
  "edit_body",
  "edit_frontmatter",
  "move",
  "copy_attachment",
  "move_attachment",
  "trash",
] as const;
const operationKindSchema = z.enum(operationKinds);
const operationIdentitySchema = {
  operationId: operationIdSchema,
  afterOperationId: operationIdSchema.optional(),
};

const createDirectoryOperationSchema = z
  .object({
    ...operationIdentitySchema,
    kind: z.literal("create_directory"),
    path: canonicalVaultPathSchema,
    ifExists: z.literal("reject"),
  })
  .strict();
const createNoteOperationSchema = z
  .object({
    ...operationIdentitySchema,
    kind: z.literal("create_note"),
    path: canonicalMarkdownPathSchema,
    content: z.string(),
    ifExists: z.literal("reject"),
  })
  .strict();
const bodyEditSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("replace_exact"),
      old: z.string(),
      replacement: z.string(),
      expectedOccurrences: z.literal(1),
    })
    .strict(),
  z.object({ kind: z.literal("replace_whole"), replacement: z.string() }).strict(),
]);
const editBodyOperationSchema = z
  .object({
    ...operationIdentitySchema,
    kind: z.literal("edit_body"),
    path: canonicalMarkdownPathSchema,
    targetVersion: contentVersionSchema,
    edit: bodyEditSchema,
  })
  .strict();
const frontmatterChangeSchema = z.discriminatedUnion("kind", [
  z
    .object({ kind: z.literal("set"), key: z.string().min(1), value: jsonValueSchema })
    .strict(),
  z.object({ kind: z.literal("remove"), key: z.string().min(1) }).strict(),
]);
const editFrontmatterOperationSchema = z
  .object({
    ...operationIdentitySchema,
    kind: z.literal("edit_frontmatter"),
    path: canonicalMarkdownPathSchema,
    targetVersion: contentVersionSchema,
    changes: z.array(frontmatterChangeSchema).min(1),
  })
  .strict();
const moveOperationSchema = z
  .object({
    ...operationIdentitySchema,
    kind: z.literal("move"),
    sourcePath: canonicalMarkdownPathSchema,
    destinationPath: canonicalMarkdownPathSchema,
    targetVersion: contentVersionSchema,
    linkEffect: z.literal("update_resolved_references"),
  })
  .strict();
const copyAttachmentOperationSchema = z
  .object({
    ...operationIdentitySchema,
    kind: z.literal("copy_attachment"),
    sourcePath: canonicalVaultPathSchema,
    destinationPath: canonicalVaultPathSchema,
    expectedSha256: attachmentSha256Schema,
  })
  .strict();
const moveAttachmentOperationSchema = z
  .object({
    ...operationIdentitySchema,
    kind: z.literal("move_attachment"),
    sourcePath: canonicalVaultPathSchema,
    destinationPath: canonicalVaultPathSchema,
    expectedSha256: attachmentSha256Schema,
  })
  .strict();
const markdownTrashOperationSchema = z
  .object({
    ...operationIdentitySchema,
    kind: z.literal("trash"),
    path: canonicalMarkdownPathSchema,
    targetVersion: contentVersionSchema,
  })
  .strict();
const attachmentTrashOperationSchema = z
  .object({
    ...operationIdentitySchema,
    kind: z.literal("trash"),
    path: canonicalVaultPathSchema,
    expectedSha256: attachmentSha256Schema,
  })
  .strict();
const trashOperationSchema = z.union([
  markdownTrashOperationSchema,
  attachmentTrashOperationSchema,
]);

const changeSetOperationSchema = z.union([
  createDirectoryOperationSchema,
  createNoteOperationSchema,
  editBodyOperationSchema,
  editFrontmatterOperationSchema,
  moveOperationSchema,
  copyAttachmentOperationSchema,
  moveAttachmentOperationSchema,
  trashOperationSchema,
]);
const readDependencySchema = z
  .object({ path: canonicalMarkdownPathSchema, contentVersion: contentVersionSchema })
  .strict();

function directPaths(operation: z.infer<typeof changeSetOperationSchema>): string[] {
  if ("sourcePath" in operation) return [operation.sourcePath, operation.destinationPath];
  return [operation.path];
}

export const changeSetSubmitInputSchema = z
  .object({
    submissionKey: z.string().min(1),
    operations: z.array(changeSetOperationSchema).min(1),
    readDependencies: z.array(readDependencySchema).optional(),
  })
  .strict()
  .superRefine(({ operations, readDependencies = [] }, context) => {
    const operationIndexes = new Map<string, number>();
    const lastOperationByPath = new Map<string, string>();
    operations.forEach((operation, index) => {
      if (operationIndexes.has(operation.operationId)) {
        context.addIssue({
          code: "custom",
          path: ["operations", index, "operationId"],
          message: "operationId must be unique within the request",
        });
      }
      operationIndexes.set(operation.operationId, index);
      if (operation.afterOperationId !== undefined) {
        const priorIndex = operationIndexes.get(operation.afterOperationId);
        if (priorIndex === undefined || priorIndex >= index) {
          context.addIssue({
            code: "custom",
            path: ["operations", index, "afterOperationId"],
            message: "afterOperationId must reference an earlier operation",
          });
        }
      }
      for (const path of directPaths(operation)) {
        const priorOperationId = lastOperationByPath.get(path);
        if (
          priorOperationId !== undefined &&
          operation.afterOperationId !== priorOperationId
        ) {
          context.addIssue({
            code: "custom",
            path: ["operations", index, "afterOperationId"],
            message: "a repeated path must reference its immediately prior operation",
          });
        }
        lastOperationByPath.set(path, operation.operationId);
      }
    });
    const touched = new Set(operations.flatMap(directPaths));
    const dependencies = new Set<string>();
    readDependencies.forEach((dependency, index) => {
      if (dependencies.has(dependency.path)) {
        context.addIssue({
          code: "custom",
          path: ["readDependencies", index, "path"],
          message: "readDependencies must be deduplicated by path",
        });
      }
      if (touched.has(dependency.path)) {
        context.addIssue({
          code: "custom",
          path: ["readDependencies", index, "path"],
          message: "a direct target cannot also be a Read Dependency",
        });
      }
      dependencies.add(dependency.path);
    });
  });

const vaultStateSchema = z
  .object({
    writeGate: z.enum(["open", "blocked"]),
    writeState: z.enum(["writable", "pausing", "paused"]),
  })
  .strict();
const effectOutcomeSchema = z.enum(["changed", "already_satisfied"]);
const requestedPreviewEffectSchema = z
  .object({
    operationId: operationIdSchema,
    kind: operationKindSchema,
    projectedOutcome: effectOutcomeSchema,
  })
  .strict();
const derivedPreviewEffectSchema = requestedPreviewEffectSchema
  .extend({ causedByOperationId: operationIdSchema })
  .strict();
const publicPathStateSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("markdown"), contentVersion: contentVersionSchema }).strict(),
  z.object({ kind: z.literal("attachment"), sha256: attachmentSha256Schema }).strict(),
  z.object({ kind: z.literal("directory") }).strict(),
  z.object({ kind: z.literal("absent") }).strict(),
]);
const previewPathSchema = z
  .object({
    path: canonicalVaultPathSchema,
    preState: publicPathStateSchema,
    projectedFinalState: publicPathStateSchema,
    projectedOutcome: z.enum(["changed", "unchanged"]),
  })
  .strict();
const immutablePreviewSchema = z
  .object({
    requestedEffects: z.array(requestedPreviewEffectSchema),
    derivedEffects: z.array(derivedPreviewEffectSchema),
    paths: z.array(previewPathSchema),
  })
  .strict();
const changeSetFailureSchema = z.discriminatedUnion("code", [
  z.object({ code: z.literal("stale_observation") }).strict(),
  z
    .object({
      code: z.literal("exact_match_count_mismatch"),
      operationId: operationIdSchema,
      actualOccurrences: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      code: z.literal("path_conflict"),
      operationId: operationIdSchema,
      path: canonicalVaultPathSchema,
    })
    .strict(),
]);
const inProgressChangeSetSchema = z
  .object({
    changeSetId: z.string().min(1),
    state: z.literal("in_progress"),
    preview: immutablePreviewSchema.optional(),
  })
  .strict();
const finalEffectSchema = z
  .object({
    operationId: operationIdSchema,
    kind: operationKindSchema,
    outcome: effectOutcomeSchema,
  })
  .strict();
const finalDerivedEffectSchema = finalEffectSchema
  .extend({ causedByOperationId: operationIdSchema })
  .strict();
const finalPathSchema = z
  .object({
    path: canonicalVaultPathSchema,
    outcome: z.enum(["changed", "unchanged"]),
    finalState: publicPathStateSchema,
  })
  .strict();
const intentAppliedChangeSetSchema = z
  .object({
    changeSetId: z.string().min(1),
    state: z.literal("intent_applied"),
    preview: immutablePreviewSchema,
    requestedEffects: z.array(finalEffectSchema),
    derivedEffects: z.array(finalDerivedEffectSchema),
    paths: z.array(finalPathSchema),
  })
  .strict();
const intentNotAppliedChangeSetSchema = z
  .object({
    changeSetId: z.string().min(1),
    state: z.literal("intent_not_applied"),
    preview: immutablePreviewSchema.optional(),
    failure: changeSetFailureSchema.optional(),
  })
  .strict();
const resultUnprovenChangeSetSchema = z
  .object({
    changeSetId: z.string().min(1),
    state: z.literal("result_unproven"),
    preview: immutablePreviewSchema.optional(),
  })
  .strict();
export const changeSetRecordSchema = z.discriminatedUnion("state", [
  inProgressChangeSetSchema,
  intentAppliedChangeSetSchema,
  intentNotAppliedChangeSetSchema,
  resultUnprovenChangeSetSchema,
]);
const anyOperationalGateSchema = z
  .object({
    code: z.enum([
      "writes_paused",
      "upgrade_in_progress",
      "recovery_in_progress",
      "recovery_blocked",
      "incompatible_protocol",
    ]),
  })
  .strict();

export const changeSetSubmitResultSchema = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("request_invalid") }).strict(),
  z.object({ outcome: z.literal("submission_key_conflict") }).strict(),
  z
    .object({ outcome: z.literal("operationally_blocked"), gate: anyOperationalGateSchema })
    .strict(),
  z
    .object({
      outcome: z.literal("registered"),
      changeSet: changeSetRecordSchema,
      vault: vaultStateSchema,
      gate: anyOperationalGateSchema.optional(),
    })
    .strict(),
]);

export const changeSetStatusInputSchema = z
  .object({
    submissionKey: z.string().min(1).optional(),
    changeSetId: z.string().min(1).optional(),
  })
  .strict()
  .refine(
    ({ submissionKey, changeSetId }) =>
      (submissionKey === undefined) !== (changeSetId === undefined),
    { message: "exactly one lookup identity is required" },
  );
export const changeSetStatusResultSchema = z.discriminatedUnion("lookup", [
  z
    .object({
      lookup: z.literal("found"),
      changeSet: changeSetRecordSchema,
      vault: vaultStateSchema,
    })
    .strict(),
  z.object({ lookup: z.literal("unknown"), vault: vaultStateSchema }).strict(),
  z.object({ lookup: z.literal("expired"), vault: vaultStateSchema }).strict(),
  z
    .object({ lookup: z.literal("operationally_blocked"), gate: anyOperationalGateSchema })
    .strict(),
]);

export type ChangeSetSubmitInput = z.infer<typeof changeSetSubmitInputSchema>;
export type ChangeSetOperation = z.infer<typeof changeSetOperationSchema>;
export type ChangeSetRecord = z.infer<typeof changeSetRecordSchema>;
export type ChangeSetSubmitResult = z.infer<typeof changeSetSubmitResultSchema>;
export type ChangeSetStatusInput =
  | { submissionKey: string; changeSetId?: never }
  | { submissionKey?: never; changeSetId: string };
export type ChangeSetStatusResult = z.infer<typeof changeSetStatusResultSchema>;
export type VaultState = z.infer<typeof vaultStateSchema>;

export function parseChangeSetSubmitInput(value: unknown): ChangeSetSubmitInput {
  return changeSetSubmitInputSchema.parse(value);
}

export function parseChangeSetSubmitResult(value: unknown): ChangeSetSubmitResult {
  return changeSetSubmitResultSchema.parse(value);
}

export function parseChangeSetStatusInput(value: unknown): ChangeSetStatusInput {
  return changeSetStatusInputSchema.parse(value) as ChangeSetStatusInput;
}

export function parseChangeSetStatusResult(value: unknown): ChangeSetStatusResult {
  return changeSetStatusResultSchema.parse(value);
}

export function serializeChangeSetSubmitCompatibilityText(
  value: ChangeSetSubmitResult,
): string {
  return JSON.stringify(parseChangeSetSubmitResult(value));
}

export function serializeChangeSetStatusCompatibilityText(
  value: ChangeSetStatusResult,
): string {
  return JSON.stringify(parseChangeSetStatusResult(value));
}

function contractJsonSchema(
  name: string,
  direction: "input" | "output",
  schema: z.ZodType,
): Record<string, unknown> {
  return {
    $id: `https://canxer314.github.io/obsidian-llm-wiki-cli/contracts/v1/${name}.${direction}.schema.json`,
    title: `${name.replaceAll("-", "_")} v1 ${direction}`,
    ...z.toJSONSchema(schema, { target: "draft-2020-12", reused: "ref" }),
  };
}

export function createChangeSetSubmitInputJsonSchema(): Record<string, unknown> {
  return contractJsonSchema("vault-change-set-submit", "input", changeSetSubmitInputSchema);
}

export function createChangeSetSubmitResultJsonSchema(): Record<string, unknown> {
  return contractJsonSchema("vault-change-set-submit", "output", changeSetSubmitResultSchema);
}

export function createChangeSetStatusInputJsonSchema(): Record<string, unknown> {
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: "https://canxer314.github.io/obsidian-llm-wiki-cli/contracts/v1/vault-change-set-status.input.schema.json",
    title: "vault_change_set_status v1 input",
    type: "object",
    properties: {
      submissionKey: { type: "string", minLength: 1 },
      changeSetId: { type: "string", minLength: 1 },
    },
    additionalProperties: false,
    oneOf: [
      {
        type: "object",
        properties: { submissionKey: { type: "string", minLength: 1 } },
        required: ["submissionKey"],
        additionalProperties: false,
      },
      {
        type: "object",
        properties: { changeSetId: { type: "string", minLength: 1 } },
        required: ["changeSetId"],
        additionalProperties: false,
      },
    ],
  };
}

export function createChangeSetStatusResultJsonSchema(): Record<string, unknown> {
  return contractJsonSchema("vault-change-set-status", "output", changeSetStatusResultSchema);
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
