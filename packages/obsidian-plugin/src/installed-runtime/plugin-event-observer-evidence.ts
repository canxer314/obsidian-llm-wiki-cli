import { z } from "zod";
import { createHash } from "node:crypto";
import { EXACT_FIXTURE, EXACT_ORIGINAL_BYTES, EXACT_COMMITTED_BYTES } from "../corpus/edit-fixtures.js";
import { EVENT_OBSERVER_PLUGIN_SOURCE } from "./plugin-event-observer-plugin.js";
import { EVENT_OBSERVER_ID } from "./plugin-event-observer.js";
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
export const PLUGIN_EVENT_OBSERVER_ASSERTION = "observer:real-enabled-plugin-complete-before-after-success-rollback-startup-recovery";
const windowSchema = z.object({
  observerId: z.literal(EVENT_OBSERVER_ID), observerMainSha256: digest, generation: z.number().int().positive(), pid: z.number().int().positive(),
  supervisorPid: z.number().int().positive(), supervisedProcessTreeVerified: z.literal(true),
  readyBeforeCandidateStartup: z.literal(true), callbacksRegisteredInCandidateProcess: z.literal(true),
  eventCount: z.number().int().positive(), indexingCount: z.number().int().positive(), enabledPlugins: z.array(z.string()).length(2),
  observationWindow: z.object({ firstSequence: z.literal(1), lastSequence: z.number().int().positive(), startedAt: z.number(), endedAt: z.number() }).strict(),
  observations: z.array(z.object({ sequence: z.number().int().positive(), kind: z.enum(["snapshot", "create", "modify", "rename", "delete", "changed", "resolved"]), pathSha256: digest, bytesSha256: digest.nullable(), sizeBytes: z.number().int().nonnegative() }).strict()).nonempty(),
  protocolOrder: z.array(z.object({ kind: z.enum(["ready", "candidate-start", "window-begin", "window-end"]), sequence: z.number().int().positive(), at: z.number() }).strict()).length(4),
  transcriptSha256: digest, verdict: z.literal("passed"),
}).strict();
export function observerProjectionSha256(window: { observations: unknown; protocolOrder: unknown }): string {
  return createHash("sha256").update(JSON.stringify({ observations: window.observations, protocolOrder: window.protocolOrder })).digest("hex");
}
const sourceReportSchema = z.object({
  scenario: z.enum(["success", "rollback", "startup-recovery"]), runId: z.string(), vaultIdSha256: digest, vaultPathSha256: digest,
  candidateBundleSha256: digest, installedMainSha256: digest, profileName: z.string(), generation: z.number().int().positive(),
  observerMainSha256: digest, rendererPid: z.number().int().positive(), supervisorPid: z.number().int().positive(),
  transcriptSha256: digest, projectionSha256: digest,
}).strict();
export const pluginEventObserverCorpusEvidenceSchema = z.object({
  sourceReports: z.array(sourceReportSchema).length(4),
  runId: z.string().min(1), candidateBundleSha256: digest, profileName: z.string().min(1), purpose: z.literal("isolated-correctness-not-performance"),
  scenarioManifestSha256: digest, assertions: z.array(z.string()).refine(assertions => assertions.includes(PLUGIN_EVENT_OBSERVER_ASSERTION)),
  scenarios: z.array(z.object({
    scenario: z.enum(["success", "rollback", "startup-recovery"]), runId: z.string(), vaultIdSha256: digest, vaultPathSha256: digest,
    candidateBundleSha256: digest, installedMainSha256: digest, profileName: z.string(), purpose: z.literal("isolated-correctness-not-performance"),
    runtime: z.object({ platform: z.string(), osBuild: z.string(), obsidianVersion: z.string(), electronVersion: z.string(), nodeVersion: z.string(), capabilities: z.array(z.string()) }).strict(),
    seed: z.string(), seedManifestSha256: digest,
    inventory: z.object({ beforeDigest: digest, afterDigest: digest, addedPaths: z.array(z.string()), removedPaths: z.array(z.string()), changedPaths: z.array(z.string()) }).strict(),
    windows: z.array(windowSchema).nonempty(), cleanup: z.object({ attempted: z.literal(true), residualPaths: z.array(z.string()).length(0) }).strict(), verdict: z.literal("passed"),
  }).strict()).length(3), verdict: z.literal("passed"),
}).strict().superRefine((corpus, context) => {
  if (JSON.stringify(corpus.scenarios.map(s => s.scenario)) !== JSON.stringify(["success", "rollback", "startup-recovery"])) context.addIssue({ code: "custom", message: "Observer requires success, rollback and startup recovery scenarios" });
  for (const scenario of corpus.scenarios) {
    if (scenario.runId !== corpus.runId || scenario.candidateBundleSha256 !== corpus.candidateBundleSha256 || scenario.profileName !== corpus.profileName) context.addIssue({ code: "custom", message: "Observer scenario candidate/run/profile binding changed" });
    const generations = scenario.windows.map(w => w.generation);
    if (JSON.stringify(generations) !== JSON.stringify(scenario.scenario === "startup-recovery" ? [1, 2] : [1])) context.addIssue({ code: "custom", message: "Observer lacks complete process generation windows" });
    for (const window of scenario.windows) {
      if (JSON.stringify(window.protocolOrder.map(event => event.kind)) !== JSON.stringify(["ready", "candidate-start", "window-begin", "window-end"]) || window.protocolOrder.some((event, index, all) => index > 0 && (event.sequence <= all[index - 1]!.sequence || event.at < all[index - 1]!.at))) context.addIssue({ code: "custom", message: "Observer lacks ordered active-before-startup protocol facts" });
      const [ready, start, begin, end] = window.protocolOrder;
      if (ready!.sequence !== window.observationWindow.firstSequence || end!.sequence !== window.observationWindow.lastSequence ||
          ready!.at !== window.observationWindow.startedAt || end!.at !== window.observationWindow.endedAt ||
          window.observations.some(event => event.sequence <= ready!.sequence || event.sequence >= end!.sequence ||
            window.protocolOrder.some(protocol => protocol.sequence === event.sequence) ||
            event.kind === "snapshot" && event.sequence <= begin!.sequence ||
            scenario.scenario === "startup-recovery" && window.generation === 2 && event.sequence <= begin!.sequence) ||
          start!.sequence >= begin!.sequence) context.addIssue({ code: "custom", message: "Observer callbacks must fall within registered generation readiness/window bounds" });
      if (window.observations.some((event, index, all) => index > 0 && event.sequence <= all[index - 1]!.sequence)) context.addIssue({ code: "custom", message: "Observer callback sequence must follow actual generation order" });
      const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
      const sources = corpus.sourceReports.filter(source => source.scenario === scenario.scenario && source.generation === window.generation);
      const source = sources[0];
      if (sources.length !== 1 || source === undefined || source.runId !== corpus.runId || source.vaultIdSha256 !== scenario.vaultIdSha256 || source.vaultPathSha256 !== scenario.vaultPathSha256 || source.candidateBundleSha256 !== corpus.candidateBundleSha256 || source.installedMainSha256 !== scenario.installedMainSha256 || source.profileName !== corpus.profileName || source.rendererPid !== window.pid || source.supervisorPid !== window.supervisorPid || source.observerMainSha256 !== window.observerMainSha256 || source.observerMainSha256 !== hash(EVENT_OBSERVER_PLUGIN_SOURCE) || source.transcriptSha256 !== window.transcriptSha256 || source.projectionSha256 !== observerProjectionSha256(window)) context.addIssue({ code: "custom", message: "Observer summary differs from independently verified source identity/transcript" });
      const target = window.observations.filter(observation => observation.pathSha256 === hash(EXACT_FIXTURE.path));
      const complete = (observation: typeof target[number], bytes: Uint8Array) => observation.bytesSha256 === hash(bytes) && observation.sizeBytes === bytes.length;
      if (target.length === 0 || target.some(observation => observation.bytesSha256 !== null && ![EXACT_ORIGINAL_BYTES, EXACT_COMMITTED_BYTES].some(bytes => complete(observation, bytes)))) context.addIssue({ code: "custom", message: "Observer target bytes are not the complete fixed before/after fixture" });
      const callbacks = target.filter(observation => observation.kind !== "snapshot");
      const required = scenario.scenario === "startup-recovery" && window.generation === 2 ? EXACT_ORIGINAL_BYTES : EXACT_COMMITTED_BYTES;
      if (!callbacks.some(observation => complete(observation, required)) || !callbacks.some(observation => ["create", "modify", "rename", "delete"].includes(observation.kind)) || !callbacks.some(observation => ["changed", "resolved"].includes(observation.kind))) context.addIssue({ code: "custom", message: "Observer lacks target callback bytes for the required complete state" });
      if (scenario.scenario === "rollback") {
        const after = callbacks.findIndex(observation => complete(observation, EXACT_COMMITTED_BYTES));
        if (after < 0 || !callbacks.slice(after + 1).some(observation => complete(observation, EXACT_ORIGINAL_BYTES))) context.addIssue({ code: "custom", message: "Observer rollback lacks ordered complete after/before transition" });
      }
      const vaultCallbacks = window.observations.filter(observation => ["create", "modify", "rename", "delete"].includes(observation.kind));
      const indexingCallbacks = window.observations.filter(observation => ["changed", "resolved"].includes(observation.kind));
      if (vaultCallbacks.length === 0 || indexingCallbacks.length === 0 || window.eventCount !== window.observations.filter(observation => observation.kind !== "snapshot").length || window.indexingCount !== indexingCallbacks.length) context.addIssue({ code: "custom", message: "Observer callback coverage counters disagree with actual observations" });
      if (!window.enabledPlugins.includes(EVENT_OBSERVER_ID) || new Set(window.enabledPlugins).size !== 2 || window.observationWindow.endedAt < window.observationWindow.startedAt) context.addIssue({ code: "custom", message: "Observer enabled inventory or observation window invalid" });
    }
  }
});
export type PluginEventObserverCorpusEvidence = z.infer<typeof pluginEventObserverCorpusEvidenceSchema>;
