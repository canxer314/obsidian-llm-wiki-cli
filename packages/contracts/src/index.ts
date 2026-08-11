import { z } from "zod";

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
