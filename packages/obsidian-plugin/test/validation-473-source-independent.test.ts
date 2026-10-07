import { expect, it } from "vitest";
import { createStandardDiagnosticBundle } from "../src/diagnostic-bundle.js";
import {
  validateInstalledDiagnosticPrivacyProof, diagnosticCanonicalJson, diagnosticSha256,
  DIAGNOSTIC_PRIVATE_MARKER_CATEGORIES, INSTALLED_DIAGNOSTIC_PRIVACY_COVERAGE,
  type InstalledDiagnosticTrustedContext,
} from "../src/installed-runtime/installed-diagnostic-privacy.js";
import { MVP_PERF_REF_LINUX_1 as profile } from "../src/installed-runtime/runtime-profile.js";

// No runner, Vault, process, local report, clipboard write, cleanup, or retention callback is invoked.
function fabricatedEvidence() {
  const hash = "0".repeat(64);
  const binding = { runId: "never-executed-run", candidateBundleSha256: hash, installedMainSha256: hash, profileName: profile.name };
  const runtime = { platform: profile.os.platform, osBuild: profile.os.build, obsidianVersion: profile.versions.obsidian,
    electronVersion: profile.versions.electron, nodeVersion: profile.versions.node, capabilities: [...profile.capabilities] };
  const bundle = createStandardDiagnosticBundle({
    vaultId: "invented-vault", versions: { bridge: "0.1.0", plugin: "0.1.0", protocol: "1.0", persistentStateSchema: 2, recoveryJournalSchema: 1 },
    health: { readiness: { searchSnapshot: "ready", cache: "ready", index: "ready" }, recovery: "blocked",
      write: { gate: "blocked", state: "paused", pauseSource: null }, effectiveGate: "recovery_blocked", overall: "blocked",
      reasonCodes: ["recovery_blocked"], operatorAction: "review_recovery" },
    listener: { address: "127.0.0.1", port: 32123 }, queue: { currentExecutionId: null, length: 0, headChangeSetId: null },
    lifecycle: { startup: "ready", upgrade: "not_run", migration: "not_run", recovery: "failed" },
    journal: { availability: "available", journalVersion: 1, headerChecksum: "valid", frames: [
      { slot: 0, state: "valid", checksum: "valid", sequence: 1, phase: "FAILED", frameSchemaVersion: 1, changeSetId: "invented-change" },
      { slot: 1, state: "empty", checksum: "not_present" },
    ] },
    changeSets: [{ changeSetId: "invented-change", submissionKey: "invented-key", enqueueSeq: 1, state: "result_unproven", executionPhase: "terminal" }],
    machineEvents: [],
  });
  const markers = DIAGNOSTIC_PRIVATE_MARKER_CATEGORIES.map(category => ({ category,
    sha256: diagnosticSha256(`never-observed-private-${category}`), length: `never-observed-private-${category}`.length }));
  const observedVaults = (["vault-a", "vault-b"] as const).map((label, index) => ({ label,
    vaultIdSha256: String(index + 1).repeat(64), runtime, seed: "no-fixture-created", files: [], standardBundle: bundle,
    markers, journalEnqueueSeq: 1, beforeInventory: [], afterInventory: [], beforePrivateState: [], afterPrivateState: [],
  }));
  const emptyHash = diagnosticSha256(diagnosticCanonicalJson([]));
  const vaults = observedVaults.map(observed => ({ label: observed.label, vaultIdSha256: observed.vaultIdSha256,
    installedMainSha256: hash, runtime, seed: observed.seed, manifestSha256: emptyHash,
    beforeInventorySha256: emptyHash, afterInventorySha256: emptyHash, beforePrivateStateSha256: emptyHash, afterPrivateStateSha256: emptyHash,
    checksum: bundle.checksum.canonicalPayload, markerCount: markers.length, markerCategories: [...DIAGNOSTIC_PRIVATE_MARKER_CATEGORIES],
    markerManifestSha256: diagnosticSha256(diagnosticCanonicalJson(markers)), correlatedJournalAliases: 1 }));
  const confirmations = [{ outcome: "cancelled" as const, confirmationIdSha256: "3".repeat(64), selectionSha256: hash },
    { outcome: "copied" as const, confirmationIdSha256: "4".repeat(64), selectionSha256: hash,
      copiedTextSha256: "6".repeat(64), bundleChecksum: `sha256:${hash}` }];
  const names = ["vault-a-installed-runtime-ready", "vault-b-installed-runtime-ready", "vault-a-six-tool-inventory", "vault-b-six-tool-inventory",
    "vault-a-closed-health-input-modes-rejected", "vault-b-closed-health-input-modes-rejected", "agent-authority-attempts-observations-unchanged",
    "vault-a-standard-local-report-observed", "vault-b-standard-local-report-observed", "vault-a-cancelled-local-content-report-observed",
    "vault-a-copied-local-content-report-observed", "vault-a-generated-vault", "vault-b-generated-vault"];
  const eventLog = names.map((name, index) => ({ sequence: index + 1, name, detailSha256:
    name.endsWith("standard-local-report-observed") ? diagnosticSha256(diagnosticCanonicalJson(vaults[name.startsWith("vault-a") ? 0 : 1])) :
    name.endsWith("local-content-report-observed") ? diagnosticSha256(diagnosticCanonicalJson(confirmations[name.includes("cancelled") ? 0 : 1])) : hash }));
  const observation = { binding, vaults: observedVaults, confirmations, events: eventLog,
    removedRoots: (["vault-a", "vault-b"] as const).flatMap(label => (["vault", "profile", "reports"] as const)
      .map(kind => ({ label, kind, rootSha256: diagnosticSha256(`never-created-${label}-${kind}`) }))) };
  const context: InstalledDiagnosticTrustedContext = { observation, expectedObservationSha256: diagnosticSha256(diagnosticCanonicalJson(observation)) };
  const proof = { schemaVersion: 1, scope: "installed-diagnostic-privacy-A33", verdict: "passed", runId: binding.runId,
    candidateBundleSha256: binding.candidateBundleSha256, profileName: binding.profileName, coverage: [...INSTALLED_DIAGNOSTIC_PRIVACY_COVERAGE],
    vaults, confirmations, wireRejections: 16, secondVaultUnchanged: true, eventLog,
    cleanup: { verified: true, vaultCount: 2, residualCount: 0 } };
  return { binding, proof, context };
}

it("rejects an entirely fabricated proof when no source is provided", () => {
  const { binding, proof } = fabricatedEvidence();
  expect(() => validateInstalledDiagnosticPrivacyProof(proof, binding)).toThrow("trusted observation");
});

it("REPRO: must reject proof plus fabricated context and its self-selected hash without a real external runner pin", () => {
  const { binding, proof, context } = fabricatedEvidence();
  const transported = JSON.parse(JSON.stringify({ proof, context }));
  expect(() => validateInstalledDiagnosticPrivacyProof(transported.proof, binding, transported.context)).toThrow();
});
