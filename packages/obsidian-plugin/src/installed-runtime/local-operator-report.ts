import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import { verifyStandardDiagnosticBundle, type StandardDiagnosticBundle } from "../diagnostic-bundle.js";
import { isPathInside, type InstalledRuntimeAcceptanceDescriptor } from "./acceptance-driver-protocol.js";

const standardReportSchema = z.object({
  schemaVersion: z.literal(1), runId: z.string().min(1),
  candidateBundleSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  installedMainSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  capabilityToken: z.string().regex(/^[a-f0-9]{64}$/u),
  vaultId: z.string().min(1), endpoint: z.string().url(),
  action: z.literal("standard-diagnostic-copy"), checksumVerified: z.literal(true), bundle: z.unknown(),
}).strict();

const contentReportSchema = standardReportSchema.omit({ action: true, checksumVerified: true, bundle: true }).extend({
  action: z.literal("content-inclusive-diagnostic-copy"), confirmationId: z.string().min(1),
  selectionSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  outcome: z.enum(["cancelled", "copied"]), generated: z.boolean(), copied: z.boolean(),
  checksumVerified: z.literal(true).optional(), bundleChecksum: z.string().regex(/^sha256:[a-f0-9]{64}$/u).optional(),
  bundleVersion: z.literal("1.0").optional(),
  versions: z.object({ bridge: z.string(), plugin: z.string(), protocol: z.string(),
    persistentStateSchema: z.number().int(), recoveryJournalSchema: z.number().int() }).strict().optional(),
}).strict();

const controlReportSchema = standardReportSchema.omit({ action: true, checksumVerified: true, bundle: true }).extend({
  action: z.enum(["pause-writes", "accept-recovery-baseline", "resume-writes"]),
  invocationId: z.string().min(1), outcome: z.enum(["accepted", "rejected"]),
  before: z.unknown(), after: z.unknown(),
}).strict();

export async function loadInstalledLocalOperatorReport(options: {
  readonly descriptor: InstalledRuntimeAcceptanceDescriptor;
  readonly vaultId: string;
  readonly endpoint: URL;
} & ({ readonly action: "standard-diagnostic-copy" } | {
  readonly action: "pause-writes" | "accept-recovery-baseline" | "resume-writes";
  readonly invocationId: string;
} | {
  readonly action: "content-inclusive-diagnostic-copy";
  readonly confirmationId: string;
  readonly expectedSelectionSha256: string;
})): Promise<
  z.infer<typeof contentReportSchema> |
  (z.infer<typeof standardReportSchema> & { readonly bundle: StandardDiagnosticBundle }) |
  (z.infer<typeof controlReportSchema> & { readonly before: StandardDiagnosticBundle; readonly after: StandardDiagnosticBundle })
> {
  const binding = options.descriptor;
  const root = await realpath(binding.reportDirectory);
  if (!isPathInside(await realpath(dirname(binding.vaultPath)), root)) {
    throw new Error("Local operator report root escaped the run workspace");
  }
  const filename = options.action === "standard-diagnostic-copy" ? "local-standard-diagnostic-copy.json" :
    options.action === "content-inclusive-diagnostic-copy" ?
      `local-content-inclusive-diagnostic-copy-${createHash("sha256").update(options.confirmationId).digest("hex")}.json` :
      `local-write-control-${createHash("sha256").update(options.invocationId).digest("hex")}.json`;
  const path = join(root, filename);
  if (await realpath(path) !== path) throw new Error("Local operator report cannot be a symbolic link");
  const facts = await stat(path);
  if (!facts.isFile() || (process.platform !== "win32" && (facts.mode & 0o077) !== 0)) {
    throw new Error("Local operator report is not a private regular file");
  }
  const raw = JSON.parse(await readFile(path, "utf8")) as unknown;
  const report = options.action === "standard-diagnostic-copy" ? standardReportSchema.parse(raw) :
    options.action === "content-inclusive-diagnostic-copy" ? contentReportSchema.parse(raw) : controlReportSchema.parse(raw);
  if (report.runId !== binding.runId || report.candidateBundleSha256 !== binding.candidateBundleSha256 ||
      report.installedMainSha256 !== binding.installedMainSha256 || report.capabilityToken !== binding.capabilityToken ||
      report.vaultId !== options.vaultId || report.endpoint !== options.endpoint.toString()) {
    throw new Error("Local operator report identity does not match the installed run");
  }
  if (report.action === "content-inclusive-diagnostic-copy") {
    if (options.action !== report.action || report.confirmationId !== options.confirmationId ||
        report.selectionSha256 !== options.expectedSelectionSha256) {
      throw new Error("Local operator content diagnostic selection binding does not match");
    }
    if (report.outcome === "copied" ? (!report.generated || !report.copied || report.checksumVerified !== true ||
        report.bundleChecksum === undefined || report.bundleVersion === undefined || report.versions === undefined) :
        (report.generated || report.copied || report.checksumVerified !== undefined || report.bundleChecksum !== undefined ||
         report.bundleVersion !== undefined || report.versions !== undefined)) {
      throw new Error("Local operator content diagnostic generation and copy facts contradict the outcome");
    }
    return report;
  }
  const diagnostics = report.action === "standard-diagnostic-copy" ? [report.bundle] : [report.before, report.after];
  if (!diagnostics.every(verifyStandardDiagnosticBundle)) throw new Error("Local operator diagnostic checksum is invalid");
  const bundles = diagnostics as StandardDiagnosticBundle[];
  if (options.endpoint.protocol !== "http:" || options.endpoint.hostname !== "127.0.0.1" ||
      options.endpoint.username !== "" || options.endpoint.password !== "" ||
      bundles.some(bundle => bundle.listenerTimeline.some(entry => entry.port !== Number(options.endpoint.port)))) {
    throw new Error("Local operator diagnostic listener does not match the loopback endpoint");
  }
  if (report.action === "standard-diagnostic-copy") return { ...report, bundle: bundles[0]! };
  if (options.action === "standard-diagnostic-copy" || options.action === "content-inclusive-diagnostic-copy" || report.action !== options.action || report.invocationId !== options.invocationId) {
    throw new Error("Local operator report does not match the requested invocation");
  }
  const before = bundles[0]!;
  const after = bundles[1]!;
  if (report.action === "accept-recovery-baseline" && report.outcome === "accepted" &&
      (before.health.recovery !== "blocked" || before.health.effectiveGate !== "recovery_blocked" ||
       before.journal.availability !== "available" ||
       !before.journal.frames.some(frame => frame.state === "valid" && frame.phase === "FAILED") ||
       after.health.recovery !== "none" || after.health.write.state !== "paused" ||
       after.health.effectiveGate !== "writes_paused" || after.journal.availability !== "available" ||
       after.journal.frames.some(frame => frame.state !== "empty"))) {
    throw new Error("Local operator baseline transition is not proven by health and journal facts");
  }
  if (report.action === "pause-writes" && report.outcome === "accepted" &&
      (after.health.write.state !== "paused" || after.health.write.pauseSource !== "manual" ||
       after.queueTimeline.some(queue => queue.currentExecutionAlias !== null))) {
    throw new Error("Local operator pause transition did not prove a drained manual pause");
  }
  if (report.action === "resume-writes" && report.outcome === "accepted" &&
      (before.health.recovery !== "none" || before.health.effectiveGate === "upgrade_in_progress" ||
       after.health.recovery !== "none" || after.health.write.state !== "writable" ||
       after.health.write.gate !== "open" || after.health.write.pauseSource !== null ||
       after.health.effectiveGate !== null)) {
    throw new Error("Local operator resume transition did not prove recovery-safe writable state");
  }
  return { ...report, before, after };
}
