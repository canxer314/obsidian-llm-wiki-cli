import { createLinuxObsidianProcessControl } from "../src/installed-runtime/obsidian-process.js";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { provisionTestVault } from "../src/installed-runtime/test-vault.js";
import { prepareInstalledDiagnosticPrivacyFixture, observeInstalledDiagnosticPrivacySources } from "../src/installed-runtime/installed-diagnostic-privacy.js";
import { diagnosticProcessEnvironment } from "../src/installed-runtime/installed-diagnostic-privacy.js";
import { validateInstalledDiagnosticPrivacyProof } from "../src/installed-runtime/installed-diagnostic-privacy.js";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createStandardDiagnosticBundle } from "../src/diagnostic-bundle.js";
import { verifyInstalledDiagnosticPrivacyBundle, DIAGNOSTIC_PRIVATE_MARKER_CATEGORIES } from "../src/installed-runtime/installed-diagnostic-privacy.js";

const evidence = {
  vaultId: "private-vault", versions: { bridge: "0.1.0", plugin: "0.1.0", protocol: "1.0", persistentStateSchema: 2, recoveryJournalSchema: 3 },
  health: { readiness: { searchSnapshot: "ready", cache: "ready", index: "ready" }, recovery: "blocked", write: { gate: "blocked", state: "paused", pauseSource: null }, effectiveGate: "recovery_blocked", overall: "blocked", reasonCodes: ["recovery_blocked"], operatorAction: "review_recovery" },
  listener: { address: "127.0.0.1", port: 32123 }, queue: { currentExecutionId: null, length: 0, headChangeSetId: null },
  lifecycle: { startup: "ready", upgrade: "not_run", migration: "not_run", recovery: "failed" },
  journal: { availability: "available", journalVersion: 1, headerChecksum: "valid", frames: [{ slot: 0, state: "valid", checksum: "valid", sequence: 1, phase: "FAILED", frameSchemaVersion: 3, changeSetId: "private-change-set" }, { slot: 1, state: "empty", checksum: "not_present" }] },
  changeSets: [{ changeSetId: "private-change-set", submissionKey: "private-key", enqueueSeq: 1, state: "result_unproven", executionPhase: "terminal" }], machineEvents: [],
};
const markers = DIAGNOSTIC_PRIVATE_MARKER_CATEGORIES.map(category => ({ category, value: `private_${category.replaceAll("-", "_")}_marker` }));
function resign(bundle: any) {
  const canonical = (v: any): any => Array.isArray(v) ? v.map(canonical) : v !== null && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canonical(v[k])])) : v;
  const { checksum: _, ...payload } = bundle;
  bundle.checksum.canonicalPayload = `sha256:${createHash("sha256").update(JSON.stringify(canonical(payload))).digest("hex")}`;
  return bundle;
}

describe("installed diagnostic privacy bundle seam", () => {
  it("delivers only the generated marker environment through the real process-control seam", async () => {
    const root = await mkdtemp(join(tmpdir(), "privacy-process-source-"));
    let processHandle: Awaited<ReturnType<ReturnType<typeof createLinuxObsidianProcessControl>["start"]>> | undefined;
    try {
      const vault = await provisionTestVault({ workingDirectory: root, runId: "sources" });
      const fixture = await prepareInstalledDiagnosticPrivacyFixture(vault, "sources", "vault-a");
      const observed = join(root, "observed.json");
      processHandle = await createLinuxObsidianProcessControl({ executablePath: process.execPath,
        launchArguments: ["-e", `require('node:fs').writeFileSync(${JSON.stringify(observed)},JSON.stringify({marker:process.env.LLM_WIKI_ACCEPTANCE_DIAGNOSTIC_MARKER,credential:process.env.LLM_WIKI_ACCEPTANCE_DIAGNOSTIC_CREDENTIAL}));setInterval(()=>{},1000)`, "--"], stopTimeoutMs: 2000,
      }).start({ vaultPath: vault.vaultPath, profileDirectory: vault.profileDirectory, diagnosticPrivacyEnvironment: fixture.environment });
      await expect.poll(async () => JSON.parse(await readFile(observed, "utf8"))).toEqual({ marker: fixture.environment.LLM_WIKI_ACCEPTANCE_DIAGNOSTIC_MARKER, credential: fixture.environment.LLM_WIKI_ACCEPTANCE_DIAGNOSTIC_CREDENTIAL });
    } finally { await processHandle?.stop(); await rm(root, { recursive: true, force: true }); }
  });
  it("refuses a fixed passed boolean without complete provenance, coverage and cleanup composition", () => {
    expect(() => validateInstalledDiagnosticPrivacyProof({ verdict: "passed", cleanup: { verified: true } }, { runId: "run", candidateBundleSha256: "a".repeat(64), profileName: "profile", installedMainSha256: "b".repeat(64) })).toThrow();
  });
  it("refuses diagnostic environment injection outside a generated Vault or with unknown keys", () => {
    const env = { LLM_WIKI_ACCEPTANCE_DIAGNOSTIC_MARKER: "privacy_environment_0123456789abcdef0123", LLM_WIKI_ACCEPTANCE_DIAGNOSTIC_CREDENTIAL: "privacy_credential_0123456789abcdef0123" };
    expect(() => diagnosticProcessEnvironment({ vaultPath: "/home/ThinkFlywheelVault", profileDirectory: "/tmp/profile", diagnosticPrivacyEnvironment: env })).toThrow("generated");
    expect(() => diagnosticProcessEnvironment({ vaultPath: "/tmp/installed-runtime-vault-test", profileDirectory: "/tmp/installed-runtime-profile-test", diagnosticPrivacyEnvironment: { ...env, PATH: "hijack" } })).toThrow("closed");
  });
  it("refuses to certify marker coverage without observed request and before-image sources", async () => {
    const root = await mkdtemp(join(tmpdir(), "privacy-source-"));
    try {
      const vault = await provisionTestVault({ workingDirectory: root, runId: "sources" });
      const fixture = await prepareInstalledDiagnosticPrivacyFixture(vault, "sources", "vault-a");
      await expect(observeInstalledDiagnosticPrivacySources({ fixture, vault, journalPayload: {}, vaultId: "id", capabilityToken: "token", environment: fixture.environment })).rejects.toThrow("journal");
      await expect(observeInstalledDiagnosticPrivacySources({ fixture, vault, journalPayload: { vaultId: "id", changeSetId: "change", input: { submissionKey: "key" }, footprint: [{ before: { bytesBase64: Buffer.from("unmarked before image").toString("base64") } }] }, vaultId: "id", capabilityToken: "token", environment: fixture.environment, username: "operator" })).rejects.toThrow("deterministic");
      await expect(prepareInstalledDiagnosticPrivacyFixture(vault, "sources", "vault-a")).rejects.toMatchObject({ code: "EEXIST" });
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it.each(["request", "operation-id"])("rejects a deterministic %s token leaked alone rather than the full private request", async category => {
    const root = await mkdtemp(join(tmpdir(), "privacy-request-token-"));
    try {
      const vault = await provisionTestVault({ workingDirectory: root, runId: "sources" });
      const fixture = await prepareInstalledDiagnosticPrivacyFixture(vault, "sources", "vault-a");
      const suffix = fixture.environment.LLM_WIKI_ACCEPTANCE_DIAGNOSTIC_MARKER.slice("privacy_environment_".length);
      const requestToken = `privacy_request_${suffix}`;
      const operationId = `privacy_operation_${suffix}`;
      const privateMarkers = await observeInstalledDiagnosticPrivacySources({ fixture, vault,
        journalPayload: { vaultId: "private_observed_vault", changeSetId: "private_observed_change", input: { submissionKey: `installed-semantic-${requestToken}`, operations: [{ operationId }] }, footprint: [{ before: { bytesBase64: Buffer.from(`privacy_before_image_${suffix}`).toString("base64") } }] },
        vaultId: "private_observed_vault", capabilityToken: "private_observed_capability", environment: fixture.environment, username: "private_observed_username" });
      const bundle = resign({ ...createStandardDiagnosticBundle(evidence), machineEvents: [{ sequence: 1, code: "recovery_blocked", stackSymbols: [category === "request" ? requestToken : operationId] }] });
      expect(() => verifyInstalledDiagnosticPrivacyBundle(bundle, privateMarkers)).toThrow("private marker");
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it("rejects a before-image token leaked without the rest of the private before-image bytes", async () => {
    const root = await mkdtemp(join(tmpdir(), "privacy-before-token-"));
    try {
      const vault = await provisionTestVault({ workingDirectory: root, runId: "sources" });
      const fixture = await prepareInstalledDiagnosticPrivacyFixture(vault, "sources", "vault-a");
      const suffix = fixture.environment.LLM_WIKI_ACCEPTANCE_DIAGNOSTIC_MARKER.slice("privacy_environment_".length);
      const token = `privacy_before_image_${suffix}`;
      const privateMarkers = await observeInstalledDiagnosticPrivacySources({ fixture, vault,
        journalPayload: { vaultId: "private_observed_vault", changeSetId: "private_observed_change", input: { submissionKey: `installed-semantic-privacy_request_${suffix}` }, footprint: [{ before: { bytesBase64: Buffer.from(`# before\n${token}\n`).toString("base64") } }] },
        vaultId: "private_observed_vault", capabilityToken: "private_observed_capability", environment: fixture.environment, username: "private_observed_username" });
      const bundle = resign({ ...createStandardDiagnosticBundle(evidence), machineEvents: [{ sequence: 1, code: "recovery_blocked", stackSymbols: [token] }] });
      expect(() => verifyInstalledDiagnosticPrivacyBundle(bundle, privateMarkers)).toThrow("private marker");
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it.each(["checksum", "unknown-field"])("rejects %s even when other diagnostic observations exist", corruption => {
    const bundle = createStandardDiagnosticBundle(evidence);
    const forged = corruption === "checksum" ? { ...bundle, checksum: { ...bundle.checksum, canonicalPayload: `sha256:${"0".repeat(64)}` } } : resign({ ...bundle, privateExtra: "secret" });
    expect(() => verifyInstalledDiagnosticPrivacyBundle(forged, markers)).toThrow("unknown fields or invalid checksum");
  });
  it("rejects a journal alias borrowed from another valid outcome in the same bundle", () => {
    const bundle = createStandardDiagnosticBundle({ ...evidence, changeSets: [...evidence.changeSets, { ...evidence.changeSets[0], changeSetId: "other", submissionKey: "other-key", enqueueSeq: 2 }] });
    const forged = structuredClone(bundle);
    (forged.journal.frames[0] as any).changeSetAlias = forged.changeSetOutcomes[1]!.changeSetAlias;
    expect(() => verifyInstalledDiagnosticPrivacyBundle(resign(forged), markers, { journalEnqueueSeq: 1, journalPhase: "FAILED" })).toThrow("alias correlation");
  });
  it("rejects a re-signed journal alias detached from its terminal outcome", () => {
    const bundle = createStandardDiagnosticBundle(evidence);
    const forged = structuredClone(bundle);
    if (forged.journal.availability !== "available" || forged.journal.frames[0]!.state !== "valid") throw new Error("Fixture needs a journal alias");
    (forged.journal.frames[0] as any).changeSetAlias = `change_set_${"0".repeat(32)}`;
    expect(() => verifyInstalledDiagnosticPrivacyBundle(resign(forged), markers)).toThrow("alias correlation");
  });

  it.each(DIAGNOSTIC_PRIVATE_MARKER_CATEGORIES)("rejects %s even in a checksum-valid allowed stack symbol", category => {
    const bundle = createStandardDiagnosticBundle(evidence);
    const marker = markers.find(m => m.category === category)!;
    const leaked = resign({ ...bundle, machineEvents: [{ sequence: 1, code: "recovery_blocked", stackSymbols: [marker.value] }] });
    expect(() => verifyInstalledDiagnosticPrivacyBundle(leaked, markers)).toThrow("private marker");
  });
});
