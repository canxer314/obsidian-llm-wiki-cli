import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve } from "node:path";

import { z } from "zod";

export const INSTALLED_RUNTIME_ACCEPTANCE_DESCRIPTOR =
  "installed-runtime-acceptance.json";

export const INSTALLED_RUNTIME_VAULT_DIRECTORY_PREFIX =
  "installed-runtime-vault-";

const digestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
export const installedCrashKinds = ["create_note", "edit_body", "edit_body_whole"] as const;
export type InstalledCrashKind = typeof installedCrashKinds[number];
export const installedCrashPoints = [
  "before_prepared", "after_prepared", "after_mutation:0", "after_mutation:1",
  "after_file_mutation:0", "after_raw_verification", "during_success_barrier",
  "after_snapshot", "before_committed", "after_committed", "before_rollback",
  "after_rollback_mutation:0", "after_rollback_mutation:1", "after_rollback_mutation:2",
  "after_rollback_verification", "after_rollback_evidence", "before_rolled_back", "after_rolled_back",
] as const;
export type InstalledCrashPoint = typeof installedCrashPoints[number];
export const installedCrashScenarios = installedCrashKinds.flatMap(kind => installedCrashPoints
  .filter(point => kind === "create_note" || !["after_mutation:0", "after_mutation:1", "after_rollback_mutation:1", "after_rollback_mutation:2"].includes(point))
  .map(point => `${kind}/${point}` as const));
export const installedCrashScenarioSchema = z.enum([installedCrashScenarios[0]!, ...installedCrashScenarios.slice(1)]);
export const crashRestorationCommandSchema = z.object({
  sequence: z.number().int().positive(),
  capabilityToken: digestSchema,
  action: z.literal("run-crash-restoration-scenario"),
  scenario: installedCrashScenarioSchema,
  expectedVaultId: z.string().min(1),
  endpoint: z.string().url(),
  submissionKey: z.string().min(1),
  input: z.unknown(),
  recovery: z.object({ changeSetId: z.string().min(1), frameSha256: digestSchema }).strict().optional(),
}).strict();

export const installedRuntimeAcceptanceCommandSchema = z.discriminatedUnion(
  "action",
  [
    z
      .object({
        sequence: z.literal(0),
        capabilityToken: digestSchema,
        action: z.literal("idle"),
      })
      .strict(),
    z
      .object({
        sequence: z.number().int().positive(),
        capabilityToken: digestSchema,
        action: z.literal("run-semantic-evidence-scenario"),
        scenario: z.string().min(1),
        expectedVaultId: z.string().min(1),
        endpoint: z.string().url(),
      })
      .strict(),
    crashRestorationCommandSchema,
    z.object({
      sequence: z.number().int().positive(), capabilityToken: digestSchema,
      action: z.literal("run-reference-single-span-scenario"),
      scenario: z.literal("span/second-equal-spelling-only"),
      expectedVaultId: z.string().min(1), endpoint: z.string().url(),
    }).strict(),
  ],
);

export const installedRuntimeAcceptanceDescriptorSchema = z
  .object({
    schemaVersion: z.literal(1),
    runId: z.string().regex(/^[A-Za-z0-9_-]+$/u),
    vaultPath: z.string().min(1),
    pluginId: z.string().regex(/^[a-z0-9][a-z0-9-]*$/u),
    candidateBundleSha256: digestSchema,
    installedMainSha256: digestSchema,
    reportDirectory: z.string().min(1),
    capabilityToken: digestSchema,
    command: installedRuntimeAcceptanceCommandSchema,
  })
  .strict();

export type InstalledRuntimeAcceptanceDescriptor = z.infer<
  typeof installedRuntimeAcceptanceDescriptorSchema
>;

export function semanticEvidenceScenarioReportPath(
  reportDirectory: string,
  scenario: string,
): string {
  return join(
    reportDirectory,
    `semantic-evidence-${scenario.replace(/[^A-Za-z0-9_-]/gu, "_")}.json`,
  );
}

export function isPathInside(parent: string, child: string): boolean {
  const nested = relative(resolve(parent), resolve(child));
  return nested !== "" && !nested.startsWith("..") && !isAbsolute(nested);
}

export async function loadInstalledRuntimeAcceptanceDescriptor(options: {
  readonly vaultPath: string;
  readonly pluginId: string;
  readonly configDirectoryName?: string;
}): Promise<{
  readonly path: string;
  readonly descriptor: InstalledRuntimeAcceptanceDescriptor;
}> {
  const vaultPath = resolve(options.vaultPath);
  if (!basename(vaultPath).startsWith(INSTALLED_RUNTIME_VAULT_DIRECTORY_PREFIX)) {
    throw new Error(
      "Installed acceptance descriptor does not belong to a generated installed-runtime Vault",
    );
  }
  const pluginDirectory = join(
    vaultPath,
    options.configDirectoryName ?? ".obsidian",
    "plugins",
    options.pluginId,
  );
  const path = join(pluginDirectory, INSTALLED_RUNTIME_ACCEPTANCE_DESCRIPTOR);
  const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
  const descriptor = installedRuntimeAcceptanceDescriptorSchema.parse(parsed);
  if (descriptor.vaultPath !== vaultPath || descriptor.pluginId !== options.pluginId) {
    throw new Error(
      "Installed acceptance descriptor has the wrong Vault or plugin identity",
    );
  }
  const reportDirectory = resolve(descriptor.reportDirectory);
  if (!isPathInside(resolve(vaultPath, ".."), reportDirectory)) {
    throw new Error(
      "Installed acceptance report root must stay inside the run workspace",
    );
  }
  const reportFacts = await stat(reportDirectory).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  });
  if (reportFacts !== null && !reportFacts.isDirectory()) {
    throw new Error("Installed acceptance report root is not a directory");
  }
  const mainBytes = await readFile(join(pluginDirectory, "main.js"));
  if (
    createHash("sha256").update(mainBytes).digest("hex") !==
    descriptor.installedMainSha256
  ) {
    throw new Error(
      "Installed acceptance descriptor does not match the installed entry point",
    );
  }
  if (descriptor.command.capabilityToken !== descriptor.capabilityToken) {
    throw new Error("Installed acceptance command has the wrong capability");
  }
  return { path, descriptor };
}
