import { createHash, createHmac } from "node:crypto";
import { EXACT_FIXTURE, EXACT_ORIGINAL_BYTES, EXACT_COMMITTED_BYTES } from "../../src/corpus/edit-fixtures.js";
import type { PluginEventObserverCorpusEvidence } from "../../src/installed-runtime/plugin-event-observer-evidence.js";
import { PLUGIN_EVENT_OBSERVER_ASSERTION, observerProjectionSha256 } from "../../src/installed-runtime/plugin-event-observer-evidence.js";
import { EVENT_OBSERVER_PLUGIN_SOURCE } from "../../src/installed-runtime/plugin-event-observer-plugin.js";
import { verifyPluginEventObserverWindow } from "../../src/installed-runtime/plugin-event-observer.js";
import type { PluginEventObserverConsumptionContext } from "../../src/installed-runtime/plugin-event-observer-corpus.js";
import type { ObservedRuntimeEnvironment } from "../../src/installed-runtime/runtime-profile.js";

type Options = { runId: string; candidateBundleSha256: string; installedMainSha256: string; profileName: string; pluginId: string; runtime: ObservedRuntimeEnvironment };
/** Synthetic authenticated report-boundary fixture only; never installed acceptance evidence. */
export function observerSourceFixture(options: Options) {
  const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
  const digest = "e".repeat(64);
  const context: PluginEventObserverConsumptionContext = { runId: options.runId, candidateBundleSha256: options.candidateBundleSha256,
    installedMainSha256: options.installedMainSha256, profileName: options.profileName, candidatePluginId: options.pluginId, observations: [] };
  const proof: PluginEventObserverCorpusEvidence = { sourceReports: [], runId: options.runId, candidateBundleSha256: options.candidateBundleSha256, profileName: options.profileName,
    purpose: "isolated-correctness-not-performance", scenarioManifestSha256: digest, assertions: [PLUGIN_EVENT_OBSERVER_ASSERTION], verdict: "passed",
    scenarios: (["success", "rollback", "startup-recovery"] as const).map(scenario => {
      const vaultPath = `/synthetic/installed-runtime-vault-${scenario}`; const vaultId = `synthetic-${scenario}`;
      const windows = (scenario === "startup-recovery" ? [1, 2] : [1]).map(generation => {
        const binding = { runId: options.runId, vaultPath, vaultId, candidateBundleSha256: options.candidateBundleSha256, installedMainSha256: options.installedMainSha256,
          profileName: options.profileName, generation, observerMainSha256: hash(EVENT_OBSERVER_PLUGIN_SOURCE), capabilityToken: "d".repeat(64) };
        const bytes = scenario === "startup-recovery" && generation === 2 ? EXACT_ORIGINAL_BYTES : EXACT_COMMITTED_BYTES;
        const capture = (kind: string, content: Uint8Array) => ({ kind, path: EXACT_FIXTURE.path, presence: "file", rawBytesBase64: Buffer.from(content).toString("base64") });
        const { capabilityToken: _token, ...identity } = binding;
        const events = [{ kind: "ready", listeners: ["create", "modify", "rename", "delete", "changed", "resolved"], enabledPlugins: ["llm-wiki-event-observer", options.pluginId] },
          { kind: "candidate-start" }, { kind: "window-begin" }, capture("modify", bytes), capture("changed", bytes),
          ...(scenario === "rollback" ? [capture("modify", EXACT_ORIGINAL_BYTES), capture("changed", EXACT_ORIGINAL_BYTES)] : [{ kind: "heartbeat" }, { kind: "heartbeat" }]),
          { kind: "window-end" }].map((event, index) => {
            const payload = { ...identity, pid: 4321 + generation, sequence: index + 1, at: 1000 + index * 10, ...event };
            return { payload, mac: createHmac("sha256", binding.capabilityToken).update(JSON.stringify(payload)).digest("hex") };
          });
        const verification = { binding, events, candidatePluginId: options.pluginId, expectedPid: 4321 + generation,
          files: [{ path: EXACT_FIXTURE.path, before: EXACT_ORIGINAL_BYTES, after: EXACT_COMMITTED_BYTES }], maxSilenceMs: 2000,
          requiredVisibleStates: [{ path: EXACT_FIXTURE.path, bytes }],
          ...(scenario === "rollback" ? { requiredTransition: { path: EXACT_FIXTURE.path, states: [EXACT_COMMITTED_BYTES, EXACT_ORIGINAL_BYTES] } } : {}) };
        const window = { ...verifyPluginEventObserverWindow(verification), supervisorPid: 4320, supervisedProcessTreeVerified: true as const };
        const source = { scenario, runId: options.runId, vaultIdSha256: hash(vaultId), vaultPathSha256: hash(vaultPath), candidateBundleSha256: options.candidateBundleSha256,
          installedMainSha256: options.installedMainSha256, profileName: options.profileName, generation, observerMainSha256: binding.observerMainSha256,
          rendererPid: verification.expectedPid, supervisorPid: 4320, transcriptSha256: window.transcriptSha256, projectionSha256: observerProjectionSha256(window) };
        context.observations.push({ verification, scenario, supervisorPid: 4320, source });
        return window as PluginEventObserverCorpusEvidence["scenarios"][number]["windows"][number];
      });
      return { scenario, runId: options.runId, candidateBundleSha256: options.candidateBundleSha256, installedMainSha256: options.installedMainSha256,
        vaultIdSha256: hash(vaultId), vaultPathSha256: hash(vaultPath), profileName: options.profileName, purpose: "isolated-correctness-not-performance" as const,
        runtime: { platform: options.runtime.platform, osBuild: options.runtime.osBuild!, obsidianVersion: options.runtime.obsidianVersion!, electronVersion: options.runtime.electronVersion!, nodeVersion: options.runtime.nodeVersion!, capabilities: [...options.runtime.capabilities] },
        seed: `fixture-${scenario}`, seedManifestSha256: digest, inventory: { beforeDigest: digest, afterDigest: digest, addedPaths: [], removedPaths: [], changedPaths: [] }, windows,
        cleanup: { attempted: true as const, residualPaths: [] }, verdict: "passed" as const };
    }),
  };
  proof.sourceReports = context.observations.map(item => structuredClone(item.source));
  return { proof, context };
}
export function observerReportFixture(options: Options): PluginEventObserverCorpusEvidence { return observerSourceFixture(options).proof; }
