import { z } from "zod";
import { EVENT_OBSERVER_ID } from "./plugin-event-observer.js";
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
export const PLUGIN_EVENT_OBSERVER_ASSERTION = "observer:real-enabled-plugin-complete-before-after-success-rollback-startup-recovery";
const windowSchema = z.object({
  observerId: z.literal(EVENT_OBSERVER_ID), observerMainSha256: digest, generation: z.number().int().positive(), pid: z.number().int().positive(),
  supervisorPid: z.number().int().positive(), supervisedProcessTreeVerified: z.literal(true),
  readyBeforeCandidateStartup: z.literal(true), callbacksRegisteredInCandidateProcess: z.literal(true),
  eventCount: z.number().int().positive(), indexingCount: z.number().int().positive(), enabledPlugins: z.array(z.string()).length(2),
  observationWindow: z.object({ firstSequence: z.literal(1), lastSequence: z.number().int().positive(), startedAt: z.number(), endedAt: z.number() }).strict(),
  observations: z.array(z.object({ sequence: z.number().int().positive(), kind: z.string(), pathSha256: digest, bytesSha256: digest.nullable(), sizeBytes: z.number().int().nonnegative() }).strict()).nonempty(),
  transcriptSha256: digest, verdict: z.literal("passed"),
}).strict();
export const pluginEventObserverCorpusEvidenceSchema = z.object({
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
      if (!window.enabledPlugins.includes(EVENT_OBSERVER_ID) || new Set(window.enabledPlugins).size !== 2 || window.observationWindow.endedAt < window.observationWindow.startedAt) context.addIssue({ code: "custom", message: "Observer enabled inventory or observation window invalid" });
    }
  }
});
export type PluginEventObserverCorpusEvidence = z.infer<typeof pluginEventObserverCorpusEvidenceSchema>;
