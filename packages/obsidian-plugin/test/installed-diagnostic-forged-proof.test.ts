import { expect, it } from "vitest";
import { validateInstalledDiagnosticPrivacyProof, diagnosticCanonicalJson, diagnosticSha256, DIAGNOSTIC_PRIVATE_MARKER_CATEGORIES, INSTALLED_DIAGNOSTIC_PRIVACY_COVERAGE } from "../src/installed-runtime/installed-diagnostic-privacy.js";
import { MVP_PERF_REF_LINUX_1 as profile } from "../src/installed-runtime/runtime-profile.js";

it("rejects fabricated coverage and copied-byte proof even after public summary rehash", () => {
  const hash = "0".repeat(64);
  const binding = { runId: "never-executed-run", candidateBundleSha256: hash, installedMainSha256: hash, profileName: profile.name };
  const runtime = { platform: profile.os.platform, osBuild: profile.os.build, obsidianVersion: profile.versions.obsidian, electronVersion: profile.versions.electron, nodeVersion: profile.versions.node, capabilities: [...profile.capabilities] };
  const vaults = ["vault-a", "vault-b"].map((label, index) => ({ label, vaultIdSha256: String(index + 1).repeat(64), installedMainSha256: hash, runtime,
    seed: "no-fixture-or-source-created", manifestSha256: hash, beforeInventorySha256: hash, afterInventorySha256: hash,
    beforePrivateStateSha256: hash, afterPrivateStateSha256: hash, checksum: `sha256:${hash}`, markerCount: 12,
    markerCategories: [...DIAGNOSTIC_PRIVATE_MARKER_CATEGORIES], markerManifestSha256: hash, correlatedJournalAliases: 1 }));
  const confirmations = [{ outcome: "cancelled", confirmationIdSha256: "3".repeat(64), selectionSha256: hash },
    { outcome: "copied", confirmationIdSha256: "4".repeat(64), selectionSha256: hash, copiedTextSha256: hash, bundleChecksum: `sha256:${hash}` }];
  const names = ["vault-a-installed-runtime-ready", "vault-b-installed-runtime-ready", "vault-a-six-tool-inventory", "vault-b-six-tool-inventory",
    "vault-a-closed-health-input-modes-rejected", "vault-b-closed-health-input-modes-rejected", "agent-authority-attempts-observations-unchanged",
    "vault-a-standard-local-report-observed", "vault-b-standard-local-report-observed", "vault-a-cancelled-local-content-report-observed", "vault-a-copied-local-content-report-observed",
    "vault-a-generated-vault", "vault-b-generated-vault"];
  const eventLog = names.map((name, index) => ({ sequence: index + 1, name, detailSha256:
    name.endsWith("standard-local-report-observed") ? diagnosticSha256(diagnosticCanonicalJson(vaults[name.startsWith("vault-a") ? 0 : 1])) :
    name.endsWith("local-content-report-observed") ? diagnosticSha256(diagnosticCanonicalJson(confirmations[name.includes("cancelled") ? 0 : 1])) : hash }));
  const proof = { schemaVersion: 1, scope: "installed-diagnostic-privacy-A33", verdict: "passed", ...binding, coverage: [...INSTALLED_DIAGNOSTIC_PRIVACY_COVERAGE],
    vaults, confirmations, wireRejections: 16, secondVaultUnchanged: true, eventLog, cleanup: { verified: true, vaultCount: 2, residualCount: 0 } };
  // installedMainSha256 belongs only to binding, not the public top-level proof schema.
  delete (proof as any).installedMainSha256;
  expect(() => validateInstalledDiagnosticPrivacyProof(proof, binding)).toThrow("trusted observation");
  // Rehashing invented marker counts/manifests and copied-byte hashes still cannot supply actual observations.
  vaults[0]!.markerCount = 12000;
  vaults[0]!.markerManifestSha256 = "5".repeat(64);
  confirmations[1]!.copiedTextSha256 = "6".repeat(64);
  eventLog.find(event => event.name === "vault-a-standard-local-report-observed")!.detailSha256 = diagnosticSha256(diagnosticCanonicalJson(vaults[0]));
  eventLog.find(event => event.name === "vault-a-copied-local-content-report-observed")!.detailSha256 = diagnosticSha256(diagnosticCanonicalJson(confirmations[1]));
  expect(() => validateInstalledDiagnosticPrivacyProof(proof, binding)).toThrow("trusted observation");
});
