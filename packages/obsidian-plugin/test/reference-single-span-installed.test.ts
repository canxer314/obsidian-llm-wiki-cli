import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { activateInstalledRuntimeAcceptanceDriver, createInstalledRuntimeAcceptanceDescriptor } from "../src/installed-runtime/smoke-command.js";
import { referenceSingleSpanProofSchema } from "../src/installed-runtime/registered-reference-single-span.js";
import { installedRuntimeAcceptanceCommandSchema } from "../src/installed-runtime/acceptance-driver-protocol.js";
import { validateReferenceSingleSpanReport, runInstalledReferenceSingleSpan } from "../src/installed-runtime/reference-single-span-installed-runner.js";
import { SINGLE_SPAN_BEFORE, SINGLE_SPAN_AFTER } from "../src/installed-runtime/registered-reference-single-span.js";
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const descriptor = { schemaVersion: 1 as const, runId: "a26-run", vaultPath: "/tmp/installed-runtime-vault-a26", pluginId: "bridge", candidateBundleSha256: "a".repeat(64), installedMainSha256: "b".repeat(64), reportDirectory: "/tmp/a26-reports", capabilityToken: "c".repeat(64), command: { sequence: 0 as const, action: "idle" as const, capabilityToken: "c".repeat(64) } };
const proof = { scenario: "span/second-equal-spelling-only", fixturePath: "ReferenceProof/Single/Ref.md", fixtureSha256: hash(SINGLE_SPAN_BEFORE), beforeSha256: hash(SINGLE_SPAN_BEFORE), afterSha256: hash(SINGLE_SPAN_AFTER), referencesLocated: 2, selectedOrdinal: 2, selectedSpan: { startByte: 58, endByteExclusive: 72 }, beforeSizeBytes: 83, afterSizeBytes: 89, untouchedPrefixSha256: hash(Buffer.from(SINGLE_SPAN_BEFORE).subarray(0, 58)), untouchedSuffixSha256: hash(Buffer.from(SINGLE_SPAN_BEFORE).subarray(72)), untouchedPrefixExact: true, untouchedSuffixExact: true, firstReferenceExact: true, fullBytesExact: true, finalBytesHashReread: true };
const report = () => ({ schemaVersion: 1, runId: descriptor.runId, vaultId: "vault-a26", endpoint: "http://127.0.0.1:30000/mcp", candidateBundleSha256: descriptor.candidateBundleSha256, installedMainSha256: descriptor.installedMainSha256, capabilityToken: descriptor.capabilityToken, sequence: 1, summary: proof });
const binding = { descriptor, vaultId: "vault-a26", endpoint: new URL("http://127.0.0.1:30000/mcp"), sequence: 1 };
describe("A-26 private installed report boundary", () => {
  it("round-trips the fixed one-shot private command without publishing capability or content", async () => {
    // Driver/report orchestration only; the callback is not installed acceptance.
    const root = await mkdtemp(join(tmpdir(), "reference-span-report-"));
    const vaultPath = join(root, "installed-runtime-vault-span");
    const pluginRoot = join(vaultPath, ".obsidian", "plugins", "bridge");
    await mkdir(pluginRoot, { recursive: true });
    await writeFile(join(pluginRoot, "main.js"), "candidate fixture");
    await writeFile(join(pluginRoot, "data.json"), JSON.stringify({ vaultId: "vault-a26", port: 30000 }));
    const created = await createInstalledRuntimeAcceptanceDescriptor({ runId: "span", vaultPath, pluginId: "bridge", candidateBundleSha256: "a".repeat(64), reportDirectory: join(root, "reports") });
    let executions = 0;
    const activation = await activateInstalledRuntimeAcceptanceDriver({ vaultPath, pluginId: "bridge", executeReferenceSingleSpanScenario: async () => {
      executions += 1;
      return referenceSingleSpanProofSchema.parse(proof);
    } });
    try {
      const result = await runInstalledReferenceSingleSpan({ descriptorPath: created.path, descriptor: created.descriptor, vaultId: "vault-a26", endpoint: binding.endpoint, configDirectoryName: ".obsidian", timeoutMs: 1000 });
      expect(result).toEqual(proof);
      expect(executions).toBe(1);
      expect(JSON.stringify(result)).not.toContain(created.descriptor.capabilityToken);
      expect(JSON.stringify(result)).not.toContain("[[One");
      const privateReport = await readFile(join(root, "reports", "reference-single-span.json"), "utf8");
      expect(JSON.parse(privateReport).sequence).toBe(1);
      await expect(runInstalledReferenceSingleSpan({ descriptorPath: created.path, descriptor: created.descriptor, vaultId: "vault-a26", endpoint: binding.endpoint, configDirectoryName: ".obsidian", timeoutMs: 1000 })).rejects.toThrow("already exists");
      expect(executions).toBe(1);
    } finally { activation?.dispose(); await rm(root, { recursive: true, force: true }); }
  });
  it("accepts only the dedicated strict command", () => {
    expect(installedRuntimeAcceptanceCommandSchema.safeParse({ sequence: 1, capabilityToken: descriptor.capabilityToken, action: "run-reference-single-span-scenario", scenario: "span/second-equal-spelling-only", expectedVaultId: "vault-a26", endpoint: binding.endpoint.toString() }).success).toBe(true);
  });
  it("accepts exact bound evidence", () => { expect(validateReferenceSingleSpanReport(report(), binding)).toEqual(proof); });
  it.each(["runId", "vaultId", "endpoint", "candidateBundleSha256", "installedMainSha256", "capabilityToken", "sequence"])("rejects cross-run %s", key => {
    expect(() => validateReferenceSingleSpanReport({ ...report(), [key]: key === "sequence" ? 2 : "foreign" }, binding)).toThrow();
  });
  it.each(["selectedOrdinal", "selectedSpan", "beforeSha256", "afterSha256", "untouchedPrefixSha256", "untouchedSuffixExact", "firstReferenceExact", "fullBytesExact"])("rejects forged %s", key => {
    expect(() => validateReferenceSingleSpanReport({ ...report(), summary: { ...proof, [key]: false } }, binding)).toThrow();
  });
  it("rejects forged but syntactically valid byte digests", () => {
    for (const key of ["fixtureSha256", "beforeSha256", "afterSha256", "untouchedPrefixSha256", "untouchedSuffixSha256"]) {
      expect(() => validateReferenceSingleSpanReport({ ...report(), summary: { ...proof, [key]: "f".repeat(64) } }, binding)).toThrow();
    }
  });
  it("rejects missing and failure-shaped evidence", () => {
    expect(() => validateReferenceSingleSpanReport(null, binding)).toThrow();
    expect(() => validateReferenceSingleSpanReport({ ...report(), summary: undefined, failure: { code: "scenario_execution_failed" } }, binding)).toThrow();
  });
});
