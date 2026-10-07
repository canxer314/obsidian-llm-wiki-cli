import type { PluginEventObserverCorpusEvidence } from "../../src/installed-runtime/plugin-event-observer-evidence.js";
import { PLUGIN_EVENT_OBSERVER_ASSERTION } from "../../src/installed-runtime/plugin-event-observer-evidence.js";
import type { ObservedRuntimeEnvironment } from "../../src/installed-runtime/runtime-profile.js";

/** Synthetic report-boundary fixture only. Never installed acceptance evidence. */
export function observerReportFixture(options: { runId: string; candidateBundleSha256: string; installedMainSha256: string; profileName: string; pluginId: string; runtime: ObservedRuntimeEnvironment }): PluginEventObserverCorpusEvidence {
  const digest = "e".repeat(64);
  return { runId: options.runId, candidateBundleSha256: options.candidateBundleSha256, profileName: options.profileName,
    purpose: "isolated-correctness-not-performance", scenarioManifestSha256: digest, assertions: [PLUGIN_EVENT_OBSERVER_ASSERTION], verdict: "passed",
    scenarios: (["success", "rollback", "startup-recovery"] as const).map(scenario => ({
      scenario, runId: options.runId, candidateBundleSha256: options.candidateBundleSha256, installedMainSha256: options.installedMainSha256,
      vaultIdSha256: digest, vaultPathSha256: digest, profileName: options.profileName, purpose: "isolated-correctness-not-performance",
      runtime: { platform: options.runtime.platform, osBuild: options.runtime.osBuild!, obsidianVersion: options.runtime.obsidianVersion!, electronVersion: options.runtime.electronVersion!, nodeVersion: options.runtime.nodeVersion!, capabilities: [...options.runtime.capabilities] },
      seed: `fixture-${scenario}`, seedManifestSha256: digest,
      inventory: { beforeDigest: digest, afterDigest: digest, addedPaths: [], removedPaths: [], changedPaths: [] },
      windows: (scenario === "startup-recovery" ? [1, 2] : [1]).map(generation => ({
        supervisorPid: 4320, supervisedProcessTreeVerified: true,
        readyBeforeCandidateStartup: true, callbacksRegisteredInCandidateProcess: true,
        observerId: "llm-wiki-event-observer", observerMainSha256: digest, generation, pid: 4321 + generation, eventCount: 2, indexingCount: 1,
        enabledPlugins: ["llm-wiki-event-observer", options.pluginId], observationWindow: { firstSequence: 1, lastSequence: 6, startedAt: 1000, endedAt: 1050 },
        observations: [{ sequence: 4, kind: "modify", pathSha256: digest, bytesSha256: digest, sizeBytes: 100 }, { sequence: 5, kind: "changed", pathSha256: digest, bytesSha256: digest, sizeBytes: 100 }], transcriptSha256: digest, verdict: "passed",
      })), cleanup: { attempted: true, residualPaths: [] }, verdict: "passed",
    })),
  };
}
