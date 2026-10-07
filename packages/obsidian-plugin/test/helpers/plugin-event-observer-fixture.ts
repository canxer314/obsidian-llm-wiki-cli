import { createHash } from "node:crypto";
import { EXACT_FIXTURE, EXACT_ORIGINAL_BYTES, EXACT_COMMITTED_BYTES } from "../../src/corpus/edit-fixtures.js";
import type { PluginEventObserverCorpusEvidence } from "../../src/installed-runtime/plugin-event-observer-evidence.js";
import { PLUGIN_EVENT_OBSERVER_ASSERTION, observerProjectionSha256 } from "../../src/installed-runtime/plugin-event-observer-evidence.js";
import { EVENT_OBSERVER_PLUGIN_SOURCE } from "../../src/installed-runtime/plugin-event-observer-plugin.js";
import type { ObservedRuntimeEnvironment } from "../../src/installed-runtime/runtime-profile.js";

/** Synthetic report-boundary fixture only. Never installed acceptance evidence. */
export function observerReportFixture(options: { runId: string; candidateBundleSha256: string; installedMainSha256: string; profileName: string; pluginId: string; runtime: ObservedRuntimeEnvironment }): PluginEventObserverCorpusEvidence {
  const digest = "e".repeat(64);
  const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
  const observation = (sequence: number, kind: "modify" | "changed", bytes: Uint8Array) => ({ sequence, kind, pathSha256: hash(EXACT_FIXTURE.path), bytesSha256: hash(bytes), sizeBytes: bytes.length });
  const proof: PluginEventObserverCorpusEvidence = { sourceReports: [], runId: options.runId, candidateBundleSha256: options.candidateBundleSha256, profileName: options.profileName,
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
        observerId: "llm-wiki-event-observer", observerMainSha256: hash(EVENT_OBSERVER_PLUGIN_SOURCE), generation, pid: 4321 + generation, eventCount: scenario === "rollback" ? 4 : 2, indexingCount: scenario === "rollback" ? 2 : 1,
        enabledPlugins: ["llm-wiki-event-observer", options.pluginId], observationWindow: { firstSequence: 1, lastSequence: 8, startedAt: 1000, endedAt: 1070 },
        protocolOrder: [{ kind: "ready", sequence: 1, at: 1000 }, { kind: "candidate-start", sequence: 2, at: 1010 }, { kind: "window-begin", sequence: 3, at: 1020 }, { kind: "window-end", sequence: 8, at: 1070 }],
        observations: scenario === "rollback" ? [observation(4, "modify", EXACT_COMMITTED_BYTES), observation(5, "changed", EXACT_COMMITTED_BYTES), observation(6, "modify", EXACT_ORIGINAL_BYTES), observation(7, "changed", EXACT_ORIGINAL_BYTES)] : [observation(4, "modify", scenario === "startup-recovery" && generation === 2 ? EXACT_ORIGINAL_BYTES : EXACT_COMMITTED_BYTES), observation(5, "changed", scenario === "startup-recovery" && generation === 2 ? EXACT_ORIGINAL_BYTES : EXACT_COMMITTED_BYTES)], transcriptSha256: digest, verdict: "passed",
      })), cleanup: { attempted: true, residualPaths: [] }, verdict: "passed",
    })),
  };
  proof.sourceReports = proof.scenarios.flatMap(scenario => scenario.windows.map(window => ({
    scenario: scenario.scenario, runId: proof.runId, vaultIdSha256: scenario.vaultIdSha256, vaultPathSha256: scenario.vaultPathSha256,
    candidateBundleSha256: proof.candidateBundleSha256, installedMainSha256: scenario.installedMainSha256, profileName: proof.profileName,
    generation: window.generation, observerMainSha256: window.observerMainSha256, rendererPid: window.pid, supervisorPid: window.supervisorPid,
    transcriptSha256: window.transcriptSha256, projectionSha256: observerProjectionSha256(window),
  })));
  return proof;
}
