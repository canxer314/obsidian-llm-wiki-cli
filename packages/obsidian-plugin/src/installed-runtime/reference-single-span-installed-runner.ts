import { createHash, randomBytes } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { installedRuntimeAcceptanceDescriptorSchema, loadInstalledRuntimeAcceptanceDescriptor, type InstalledRuntimeAcceptanceDescriptor } from "./acceptance-driver-protocol.js";
import { waitForCondition } from "./obsidian-process.js";
import { referenceSingleSpanProofSchema, SINGLE_SPAN_BEFORE, SINGLE_SPAN_AFTER, SINGLE_SPAN_SCENARIO, type ReferenceSingleSpanProof } from "./registered-reference-single-span.js";
const digest = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const reportSchema = z.object({ schemaVersion: z.literal(1), runId: z.string(), vaultId: z.string(), endpoint: z.string(), candidateBundleSha256: z.string(), installedMainSha256: z.string(), capabilityToken: z.string(), sequence: z.number().int().positive(), summary: referenceSingleSpanProofSchema }).strict();
interface Binding { readonly descriptor: InstalledRuntimeAcceptanceDescriptor; readonly vaultId: string; readonly endpoint: URL; readonly sequence: number }
export function validateReferenceSingleSpanReport(value: unknown, binding: Binding): ReferenceSingleSpanProof {
  const report = reportSchema.parse(value);
  const expected = binding.descriptor;
  if (report.runId !== expected.runId || report.vaultId !== binding.vaultId || report.endpoint !== binding.endpoint.toString() || report.candidateBundleSha256 !== expected.candidateBundleSha256 || report.installedMainSha256 !== expected.installedMainSha256 || report.capabilityToken !== expected.capabilityToken || report.sequence !== binding.sequence) throw new Error("Installed A-26 report identity mismatch");
  const before = Buffer.from(SINGLE_SPAN_BEFORE);
  const after = Buffer.from(SINGLE_SPAN_AFTER);
  const proof = report.summary;
  if (proof.fixtureSha256 !== digest(before) || proof.beforeSha256 !== digest(before) || proof.afterSha256 !== digest(after) || proof.untouchedPrefixSha256 !== digest(before.subarray(0, 58)) || proof.untouchedSuffixSha256 !== digest(before.subarray(72))) throw new Error("Installed A-26 report byte digests mismatch");
  return proof;
}

/** Requests the fixed private corpus only; never grants a local recovery action. */
export async function runInstalledReferenceSingleSpan(options: {
  readonly descriptorPath: string;
  readonly descriptor: InstalledRuntimeAcceptanceDescriptor;
  readonly vaultId: string;
  readonly endpoint: URL;
  readonly configDirectoryName: string;
  readonly timeoutMs: number;
}): Promise<ReferenceSingleSpanProof> {
  const loaded = await loadInstalledRuntimeAcceptanceDescriptor({ vaultPath: options.descriptor.vaultPath, pluginId: options.descriptor.pluginId, configDirectoryName: options.configDirectoryName });
  if (loaded.path !== options.descriptorPath || JSON.stringify({ ...loaded.descriptor, command: options.descriptor.command }) !== JSON.stringify(options.descriptor)) throw new Error("Installed A-26 descriptor binding changed");
  const sequence = loaded.descriptor.command.sequence + 1;
  const updated = installedRuntimeAcceptanceDescriptorSchema.parse({ ...loaded.descriptor, command: { sequence, capabilityToken: loaded.descriptor.capabilityToken, action: "run-reference-single-span-scenario", scenario: SINGLE_SPAN_SCENARIO, expectedVaultId: options.vaultId, endpoint: options.endpoint.toString() } });
  const reportPath = join(updated.reportDirectory, "reference-single-span.json");
  try { await readFile(reportPath); throw new Error("Installed A-26 report already exists"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const temporaryPath = `${loaded.path}.${randomBytes(16).toString("hex")}.next`;
  await writeFile(temporaryPath, `${JSON.stringify(updated)}\n`, { flag: "wx", mode: 0o600 });
  try { await rename(temporaryPath, loaded.path); } finally { await rm(temporaryPath, { force: true }); }
  let proof: ReferenceSingleSpanProof | undefined;
  await waitForCondition(async () => {
    let bytes: string;
    try { bytes = await readFile(reportPath, "utf8"); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
    proof = validateReferenceSingleSpanReport(JSON.parse(bytes) as unknown, { ...options, sequence });
    return true;
  }, { timeoutMs: options.timeoutMs });
  if (proof === undefined) throw new Error("Installed A-26 proof is absent");
  return proof;
}
