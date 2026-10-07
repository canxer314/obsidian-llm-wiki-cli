import { parseHealthResult, parseDiscoverInput, parseDiscoverResult, parseReadInput, parseReadToolResult, parseContinueInput, parseContinueResult, parseChangeSetSubmitInput, parseChangeSetSubmitResult, parseChangeSetStatusInput, parseChangeSetStatusResult } from "@llm-wiki/vault-contracts";
import { verifyStandardDiagnosticBundle } from "../diagnostic-bundle.js";
import { fifoDigest } from "./installed-fifo-observer.js";
import { manualPauseProofSchema, type ManualPauseProof } from "./manual-pause-observation.js";
import type { waitForNextInstalledLocalControlReport } from "./local-operator-report.js";

/** Private run-store data. Never put raw requests, tokens or Operator reports in public evidence. */
export interface ManualPauseWireObservation {
  sequence: number; phase: ManualPauseProof["toolRows"][number]["phase"];
  vaultId: string; endpoint: string; name: ManualPauseProof["toolRows"][number]["tool"];
  arguments: Record<string, unknown>; result: { structuredContent?: unknown; content: unknown; isError?: boolean };
}
export interface ManualPauseSource {
  runId: string; candidateBundleSha256: string; installedMainSha256: string; profile: string;
  wire: ManualPauseWireObservation[];
  localReports: Awaited<ReturnType<typeof waitForNextInstalledLocalControlReport>>[];
  // Collected directly from persistent/event/filesystem/process observations before projection.
  facts: Omit<ManualPauseProof, "toolRows" | "localActions" | "verdict" | "cleanupSucceeded">;
}
export interface ManualPauseConsumptionContext {
  runId: string; candidateBundleSha256: string; installedMainSha256: string; profile: string;
  source?: ManualPauseSource; sourceSha256?: string;
}
export const manualPauseSourceDigest = (source: ManualPauseSource) => fifoDigest(JSON.stringify(source));

export function projectManualPauseWire(source: ManualPauseWireObservation): ManualPauseProof["toolRows"][number] {
  const { name, arguments: input, result } = source;
  let value: any;
  switch (name) {
    case "vault_health":
      if (Object.keys(input).length) throw new Error("Manual pause health input invalid");
      value = parseHealthResult(result.structuredContent);
      if (value.outcome !== "observed" || value.vault.id !== source.vaultId || new URL(source.endpoint).hostname !== "127.0.0.1" || value.listener.address !== "127.0.0.1" || value.listener.port !== Number(new URL(source.endpoint).port)) throw new Error("Manual pause source health identity mismatch");
      break;
    case "vault_discover": parseDiscoverInput(input); value = parseDiscoverResult(result.structuredContent); break;
    case "vault_read": parseReadInput(input); value = parseReadToolResult(result.structuredContent); break;
    case "vault_continue": parseContinueInput(input); value = parseContinueResult(result.structuredContent); break;
    case "vault_change_set_submit": parseChangeSetSubmitInput(input); value = parseChangeSetSubmitResult(result.structuredContent); break;
    case "vault_change_set_status": parseChangeSetStatusInput(input); value = parseChangeSetStatusResult(result.structuredContent); break;
  }
  const text = result.content as { type: string; text: string }[];
  if (!Array.isArray(text) || text.length !== 1 || text[0]?.type !== "text" || text[0].text !== JSON.stringify(value)) throw new Error(`Manual pause source wire text/schema mismatch for ${name}`);
  const fragments = value.outcome === "page" ? value.items.filter((item: any) => "content" in item) : [];
  return { sequence: source.sequence, source: "loopback-mcp", phase: source.phase, tool: name, contract: `${name}:v1`,
    vaultIdSha256: fifoDigest(source.vaultId), requestSha256: fifoDigest(JSON.stringify({ name, arguments: input })), structuredSha256: fifoDigest(JSON.stringify(result.structuredContent)), textSha256: fifoDigest(text[0].text),
    schemaValid: true, textIdentical: true, isError: result.isError === true, branch: value.outcome ?? value.lookup,
    gate: value.gate?.code === "writes_paused" ? "writes_paused" : null,
    submissionKeySha256: typeof input.submissionKey === "string" ? fifoDigest(input.submissionKey) : null,
    changeSetIdSha256: value.changeSet ? fifoDigest(value.changeSet.changeSetId) : null, state: value.changeSet?.state ?? null,
    continuationInSha256: typeof input.continuation === "string" ? fifoDigest(input.continuation) : null,
    continuationOutSha256: typeof value.continuation === "string" ? fifoDigest(value.continuation) : null,
    contentVersion: fragments.length ? fragments[0].contentVersion.slice(7) : null, start: fragments.length ? fragments[0].start : null,
    end: fragments.length ? fragments.at(-1).end : null, pageBytes: fragments.length ? fragments.reduce((sum: number, item: any) => sum + Buffer.byteLength(item.content), 0) : null };
}

/** Re-consume actual private bytes, separately pinned by composition, after generated Vault cleanup. */
export function consumeManualPauseProof(proof: unknown, context?: ManualPauseConsumptionContext): ManualPauseProof {
  const parsed = manualPauseProofSchema.parse(proof);
  const source = context?.source;
  if (!context || !source || context.sourceSha256 !== manualPauseSourceDigest(source) ||
      ["runId", "candidateBundleSha256", "installedMainSha256", "profile"].some(key => (source as any)[key] !== (context as any)[key] || (parsed as any)[key] !== (context as any)[key])) throw new Error("Manual pause requires independently retained source context and pin");
  const toolRows = source.wire.map(projectManualPauseWire).sort((a, b) => a.sequence - b.sequence);
  const healthProjection = (value: any) => ({ write: value.write, recovery: value.recovery.state, effectiveGate: value.effectiveGate?.code ?? null,
    queue: { currentExecutionId: value.queue.currentExecutionId === null ? null : fifoDigest(value.queue.currentExecutionId), length: value.queue.length, headChangeSetId: value.queue.headChangeSetId === null ? null : fifoDigest(value.queue.headChangeSetId) } });
  for (const phase of ["pausing", "paused", "resumed"] as const) {
    const actual = source.wire.filter(row => row.name === "vault_health" && row.phase === phase && fifoDigest(row.vaultId) === source.facts.vaults[0]?.vaultIdSha256);
    if (!actual.some(row => JSON.stringify(healthProjection(parseHealthResult(row.result.structuredContent))) === JSON.stringify(source.facts.health[phase]))) throw new Error("Manual pause independent live health source differs from drain/resume");
  }
  const pages = source.wire.filter(row => row.name === "vault_read" || row.name === "vault_continue").sort((a, b) => a.sequence - b.sequence);
  const content = pages.flatMap(row => (row.result.structuredContent as any).items).map((item: any) => item.content).join("");
  if (fifoDigest(content) !== source.facts.contentSha256 || pages.some(row => row.name === "vault_read" && JSON.stringify(row.arguments) !== JSON.stringify({ items: [{ kind: "exact", path: "ManualPauseProof/Content.md" }] }))) throw new Error("Manual pause independent Exact Read source bytes mismatch");
  const localActions = source.localReports.map((report, index) => {
    if (report.action !== (index === 0 ? "pause-writes" : "resume-writes") || report.outcome !== "accepted" || report.runId !== context.runId || report.candidateBundleSha256 !== context.candidateBundleSha256 || report.installedMainSha256 !== context.installedMainSha256 ||
        fifoDigest(report.vaultId) !== source.facts.vaults[0]?.vaultIdSha256 || !verifyStandardDiagnosticBundle(report.before) || !verifyStandardDiagnosticBundle(report.after)) throw new Error("Manual pause independent local source invalid");
    return { action: report.action, invocationIdSha256: fifoDigest(report.invocationId), beforeSha256: fifoDigest(JSON.stringify(report.before)), afterSha256: fifoDigest(JSON.stringify(report.after)) };
  });
  const reports = source.localReports;
  if (reports.length !== 2 || reports[0]!.invocationId === reports[1]!.invocationId || reports[0]!.before.health.write.state !== "writable" || reports[0]!.before.queueTimeline[0]?.currentExecutionAlias === null ||
      reports[0]!.after.health.write.state !== "paused" || reports[0]!.after.health.write.pauseSource !== "manual" || reports[1]!.before.health.write.state !== "paused" || reports[1]!.before.health.write.pauseSource !== "manual" || reports[1]!.after.health.write.state !== "writable") throw new Error("Manual pause independent local action drain/resume source invalid");
  const matches = (bundle: typeof reports[number]["before"], phase: "paused" | "resumed") => {
    const value = source.facts.health[phase];
    return JSON.stringify(bundle.health.write) === JSON.stringify(value.write) && bundle.health.recovery === value.recovery && bundle.health.effectiveGate === value.effectiveGate &&
      bundle.queueTimeline.length === 1 && bundle.queueTimeline[0]!.length === value.queue.length && (bundle.queueTimeline[0]!.currentExecutionAlias === null) === (value.queue.currentExecutionId === null);
  };
  if (!matches(reports[0]!.after, "paused") || !matches(reports[1]!.before, "paused") || !matches(reports[1]!.after, "resumed")) throw new Error("Manual pause independent local reports contradict live source");
  const rebuilt = manualPauseProofSchema.parse({ ...source.facts, toolRows, localActions, cleanupSucceeded: true, verdict: "passed" });
  if (JSON.stringify(rebuilt) !== JSON.stringify(parsed)) throw new Error("Manual pause public proof differs from independent actual source");
  return parsed;
}
