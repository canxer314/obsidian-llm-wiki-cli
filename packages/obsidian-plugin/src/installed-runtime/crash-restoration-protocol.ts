import { randomBytes } from "node:crypto";
import { readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { z } from "zod";

import {
  installedRuntimeAcceptanceDescriptorSchema,
  isPathInside,
  type InstalledRuntimeAcceptanceDescriptor,
} from "./acceptance-driver-protocol.js";

const digestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
export const crashRestorationCommandSchema = z.object({
  sequence: z.number().int().positive(),
  capabilityToken: digestSchema,
  action: z.literal("run-crash-restoration-scenario"),
  scenario: z.literal("create_note/after_prepared"),
  expectedVaultId: z.string().min(1),
  endpoint: z.string().url(),
  submissionKey: z.string().min(1),
  input: z.unknown(),
}).strict();
const crashRestorationBoundarySchema = z.object({
  schemaVersion: z.literal(1),
  runId: z.string().min(1),
  vaultId: z.string().min(1),
  endpoint: z.string().url(),
  scenario: z.literal("create_note/after_prepared"),
  candidateBundleSha256: digestSchema,
  installedMainSha256: digestSchema,
  capabilityToken: digestSchema,
  submissionKey: z.string().min(1),
  point: z.literal("after_prepared"),
  journalPhase: z.literal("PREPARED"),
}).strict();

export type CrashRestorationCommand = z.infer<typeof crashRestorationCommandSchema>;
export type CrashRestorationBoundaryReport = z.infer<typeof crashRestorationBoundarySchema>;

export function crashRestorationBoundaryPath(reportDirectory: string): string {
  return join(reportDirectory, "crash-restoration-after-prepared-boundary.json");
}

export async function requestInstalledCrashRestorationScenario(options: {
  readonly descriptorPath: string;
  readonly descriptor: InstalledRuntimeAcceptanceDescriptor;
  readonly expectedVaultId: string;
  readonly endpoint: URL;
  readonly input: unknown;
  readonly crashPoint: "after_prepared";
}): Promise<void> {
  if (options.endpoint.protocol !== "http:" || options.endpoint.hostname !== "127.0.0.1") {
    throw new Error("Installed acceptance commands require the loopback endpoint");
  }
  const current = installedRuntimeAcceptanceDescriptorSchema.parse(
    JSON.parse(await readFile(options.descriptorPath, "utf8")) as unknown,
  );
  assertDescriptorSame(current, options.descriptor);
  const parsedInput = options.input as { submissionKey?: unknown };
  if (typeof parsedInput.submissionKey !== "string" || parsedInput.submissionKey.length === 0) {
    throw new Error("Crash restoration command requires a Submission Key");
  }
  const command = crashRestorationCommandSchema.parse({
    sequence: current.command.sequence + 1,
    capabilityToken: current.capabilityToken,
    action: "run-crash-restoration-scenario",
    scenario: "create_note/after_prepared",
    expectedVaultId: options.expectedVaultId,
    endpoint: options.endpoint.toString(),
    submissionKey: parsedInput.submissionKey,
    input: options.input,
  });
  const updated = { ...current, command };
  const temp = `${options.descriptorPath}.${randomBytes(16).toString("hex")}.next`;
  await writeFile(temp, `${JSON.stringify(updated)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
  try { await rename(temp, options.descriptorPath); }
  finally { await rm(temp, { force: true }); }
}

export async function writeCrashRestorationBoundaryReport(options: {
  readonly descriptor: InstalledRuntimeAcceptanceDescriptor;
  readonly command: CrashRestorationCommand;
  readonly journalPhase: "PREPARED";
}): Promise<void> {
  const report = crashRestorationBoundarySchema.parse({
    schemaVersion: 1,
    runId: options.descriptor.runId,
    vaultId: options.command.expectedVaultId,
    endpoint: options.command.endpoint,
    scenario: options.command.scenario,
    candidateBundleSha256: options.descriptor.candidateBundleSha256,
    installedMainSha256: options.descriptor.installedMainSha256,
    capabilityToken: options.descriptor.capabilityToken,
    submissionKey: options.command.submissionKey,
    point: "after_prepared",
    journalPhase: options.journalPhase,
  });
  const workspaceRealPath = await realpath(dirname(options.descriptor.vaultPath));
  const reportRealPath = await realpath(options.descriptor.reportDirectory);
  if (!isPathInside(workspaceRealPath, reportRealPath)) {
    throw new Error("Installed crash report root escaped the real run workspace");
  }
  const path = crashRestorationBoundaryPath(reportRealPath);
  const temp = `${path}.${randomBytes(16).toString("hex")}.next`;
  await writeFile(temp, `${JSON.stringify(report)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
  try { await rename(temp, path); }
  finally { await rm(temp, { force: true }); }
}

export async function loadCrashBoundaryReport(options: {
  readonly reportDirectory: string;
  readonly runId: string;
  readonly vaultId: string;
  readonly candidateBundleSha256: string;
  readonly installedMainSha256: string;
  readonly capabilityToken: string;
  readonly endpoint: string;
  readonly submissionKey: string;
}): Promise<CrashRestorationBoundaryReport> {
  const report = crashRestorationBoundarySchema.parse(
    JSON.parse(await readFile(crashRestorationBoundaryPath(options.reportDirectory), "utf8")) as unknown,
  );
  if (report.runId !== options.runId || report.vaultId !== options.vaultId ||
      report.candidateBundleSha256 !== options.candidateBundleSha256 ||
      report.installedMainSha256 !== options.installedMainSha256 ||
      report.capabilityToken !== options.capabilityToken ||
      report.endpoint !== options.endpoint || report.submissionKey !== options.submissionKey) {
    throw new Error("Installed crash boundary report is not bound to this run and candidate");
  }
  return report;
}

export function parseCrashRestorationCommand(value: unknown): CrashRestorationCommand | null {
  const parsed = crashRestorationCommandSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function assertDescriptorSame(
  actual: InstalledRuntimeAcceptanceDescriptor,
  expected: InstalledRuntimeAcceptanceDescriptor,
): void {
  if (actual.runId !== expected.runId || actual.vaultPath !== expected.vaultPath ||
      actual.pluginId !== expected.pluginId ||
      actual.candidateBundleSha256 !== expected.candidateBundleSha256 ||
      actual.installedMainSha256 !== expected.installedMainSha256 ||
      actual.reportDirectory !== expected.reportDirectory ||
      actual.capabilityToken !== expected.capabilityToken) {
    throw new Error("Installed acceptance descriptor identity changed before command publication");
  }
}
