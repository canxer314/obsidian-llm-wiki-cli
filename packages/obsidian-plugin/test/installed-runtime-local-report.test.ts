import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { activateInstalledRuntimeAcceptanceDriver, createInstalledRuntimeAcceptanceDescriptor } from "../src/installed-runtime/smoke-command.js";
import { loadInstalledLocalOperatorReport, waitForInstalledLocalOperatorReport, waitForNextInstalledLocalControlReport, waitForNextInstalledLocalContentReport } from "../src/installed-runtime/local-operator-report.js";
import { createStandardDiagnosticBundle } from "../src/diagnostic-bundle.js";

async function controlDiscoveryFixture() {
  const root = await mkdtemp(join(tmpdir(), "local-control-discovery-"));
  const vaultPath = join(root, "installed-runtime-vault-discovery");
  const pluginDirectory = join(vaultPath, ".obsidian", "plugins", "report-plugin");
  const reportDirectory = join(root, "reports");
  await mkdir(pluginDirectory, { recursive: true });
  await mkdir(reportDirectory);
  await writeFile(join(pluginDirectory, "main.js"), "candidate");
  const { descriptor } = await createInstalledRuntimeAcceptanceDescriptor({ runId: "discovery", vaultPath,
    pluginId: "report-plugin", reportDirectory, candidateBundleSha256: "a".repeat(64) });
  const bundle = createStandardDiagnosticBundle({ vaultId: "report-vault",
    versions: { bridge: "0.1.0", plugin: "0.1.0", protocol: "1.0", persistentStateSchema: 2, recoveryJournalSchema: 1 },
    health: { readiness: { searchSnapshot: "ready", cache: "ready", index: "ready" }, recovery: "none",
      write: { gate: "open", state: "writable", pauseSource: null }, effectiveGate: null, overall: "healthy", reasonCodes: [], operatorAction: "none" },
    listener: { address: "127.0.0.1", port: 32123 }, queue: { currentExecutionId: null, length: 0, headChangeSetId: null },
    lifecycle: { startup: "ready", upgrade: "not_run", migration: "not_run", recovery: "not_run" },
    journal: { availability: "unavailable", frames: [] }, changeSets: [], machineEvents: [] });
  const report = (invocationId: string, action = "accept-recovery-baseline") => ({ schemaVersion: 1,
    runId: descriptor.runId, candidateBundleSha256: descriptor.candidateBundleSha256, installedMainSha256: descriptor.installedMainSha256,
    capabilityToken: descriptor.capabilityToken, vaultId: "report-vault", endpoint: "http://127.0.0.1:32123/mcp",
    action, invocationId, outcome: "rejected", before: bundle, after: bundle });
  const write = async (value: ReturnType<typeof report>) => writeFile(join(reportDirectory,
    `local-write-control-${createHash("sha256").update(value.invocationId).digest("hex")}.json`), JSON.stringify(value), { mode: 0o600 });
  const options = { descriptor, vaultId: "report-vault", endpoint: new URL("http://127.0.0.1:32123/mcp"),
    action: "accept-recovery-baseline" as const, consumedInvocationIds: [] as string[], timeoutMs: 100 };
  await writeFile(join(pluginDirectory, "data.json"), JSON.stringify({ vaultId: "report-vault", port: 32123 }));
  const activation = await activateInstalledRuntimeAcceptanceDriver({ vaultPath, pluginId: "report-plugin" });
  const writeThroughProtocol = async (invocationId: string, action: "accept-recovery-baseline" | "pause-writes" | "resume-writes" = "accept-recovery-baseline") => {
    await activation!.recordLocalWriteControl({ vaultId: "report-vault", endpoint: options.endpoint, invocationId,
      action, outcome: "rejected", before: bundle, after: bundle });
  };
  return { root, reportDirectory, options, report, write, writeThroughProtocol,
    cleanup: async () => { activation?.dispose(); await rm(root, { recursive: true, force: true }); } };
}

it("rejects an accepted baseline whose FAILED Journal belongs to another terminal Change Set", async () => {
  const fixture = await controlDiscoveryFixture();
  try {
    const invocationId = randomUUID();
    const evidence = {
      vaultId: "report-vault",
      versions: { bridge: "0.1.0", plugin: "0.1.0", protocol: "1.0", persistentStateSchema: 2, recoveryJournalSchema: 3 },
      health: { readiness: { searchSnapshot: "ready", cache: "ready", index: "ready" }, recovery: "blocked",
        write: { gate: "blocked", state: "paused", pauseSource: null }, effectiveGate: "recovery_blocked", overall: "blocked", reasonCodes: [], operatorAction: "review_recovery" },
      listener: { address: "127.0.0.1", port: 32123 }, queue: { currentExecutionId: null, length: 0, headChangeSetId: null },
      lifecycle: { startup: "ready", upgrade: "not_run", migration: "not_run", recovery: "not_run" },
      journal: { availability: "available", journalVersion: 1, headerChecksum: "valid", frames: [
        { slot: 0, state: "valid", checksum: "valid", sequence: 1, phase: "FAILED", frameSchemaVersion: 3, changeSetId: "wrong-change-set" },
        { slot: 1, state: "empty", checksum: "not_present" },
      ] },
      changeSets: [{ changeSetId: "terminal-unproven", submissionKey: "original", enqueueSeq: 1, state: "result_unproven", executionPhase: "terminal" }], machineEvents: [],
    };
    const before = createStandardDiagnosticBundle(evidence);
    const after = createStandardDiagnosticBundle({ ...evidence, health: { ...evidence.health, recovery: "none",
      write: { gate: "open", state: "paused", pauseSource: "manual" }, effectiveGate: "writes_paused", operatorAction: "resume_writes" },
      journal: { ...evidence.journal, frames: [{ slot: 0, state: "empty", checksum: "not_present" }, { slot: 1, state: "empty", checksum: "not_present" }] } });
    await fixture.write({ ...fixture.report(invocationId), outcome: "accepted", before, after });
    await expect(waitForNextInstalledLocalControlReport(fixture.options)).rejects.toThrow("unique associated terminal");
  } finally { await fixture.cleanup(); }
});

async function acceptedBaselineFixture() {
  const fixture = await controlDiscoveryFixture();
  const evidence = {
    vaultId: "report-vault", versions: { bridge: "0.1.0", plugin: "0.1.0", protocol: "1.0", persistentStateSchema: 2, recoveryJournalSchema: 3 },
    health: { readiness: { searchSnapshot: "ready", cache: "ready", index: "ready" }, recovery: "blocked",
      write: { gate: "blocked", state: "paused", pauseSource: null }, effectiveGate: "recovery_blocked", overall: "blocked", reasonCodes: [], operatorAction: "review_recovery" },
    listener: { address: "127.0.0.1", port: 32123 }, queue: { currentExecutionId: null, length: 0, headChangeSetId: null },
    lifecycle: { startup: "ready", upgrade: "not_run", migration: "not_run", recovery: "not_run" },
    journal: { availability: "available", journalVersion: 1, headerChecksum: "valid", frames: [
      { slot: 0, state: "valid", checksum: "valid", sequence: 1, phase: "FAILED", frameSchemaVersion: 3, changeSetId: "terminal-unproven" },
      { slot: 1, state: "empty", checksum: "not_present" },
    ] },
    changeSets: [{ changeSetId: "terminal-unproven", submissionKey: "original", enqueueSeq: 1, state: "result_unproven", executionPhase: "terminal" }], machineEvents: [],
  };
  const write = async (beforeEvidence: unknown = evidence, afterEvidence: unknown = { ...evidence,
    health: { ...evidence.health, recovery: "none", write: { gate: "open", state: "paused", pauseSource: "manual" }, effectiveGate: "writes_paused", operatorAction: "resume_writes" },
    journal: { ...evidence.journal, frames: [{ slot: 0, state: "empty", checksum: "not_present" }, { slot: 1, state: "empty", checksum: "not_present" }] },
  }) => fixture.write({ ...fixture.report(randomUUID()), outcome: "accepted",
    before: createStandardDiagnosticBundle(beforeEvidence), after: createStandardDiagnosticBundle(afterEvidence) });
  return { ...fixture, evidence, writeBaseline: write };
}

it("rejects accepted baseline evidence with execution still in flight", async () => {
  const fixture = await acceptedBaselineFixture();
  try {
    await fixture.writeBaseline({ ...fixture.evidence, queue: { currentExecutionId: "active", length: 1, headChangeSetId: "active" } });
    await expect(waitForNextInstalledLocalControlReport(fixture.options)).rejects.toThrow("in-flight");
  } finally { await fixture.cleanup(); }
});

it("rejects a rejected resume report that quietly opens writes", async () => {
  const fixture = await controlDiscoveryFixture();
  try {
    const value = fixture.report(randomUUID(), "resume-writes");
    const { checksum: _, ...beforeContent } = value.before;
    const before = { ...beforeContent, health: { ...beforeContent.health,
      write: { gate: "open", state: "paused", pauseSource: "manual" }, effectiveGate: "writes_paused" } };
    const canonical = (input: unknown): unknown => Array.isArray(input) ? input.map(canonical) : typeof input === "object" && input !== null ?
      Object.fromEntries(Object.entries(input).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, canonical(child)])) : input;
    await fixture.write({ ...value, before: { ...before, checksum: { algorithm: "sha256", canonicalPayload:
      `sha256:${createHash("sha256").update(JSON.stringify(canonical(before))).digest("hex")}` } } } as unknown as typeof value);
    await expect(waitForNextInstalledLocalControlReport({ ...fixture.options, action: "resume-writes" })).rejects.toThrow("rejected resume changed");
  } finally { await fixture.cleanup(); }
});

it("rejects a failed baseline that clears its FAILED Journal", async () => {
  const fixture = await acceptedBaselineFixture();
  try {
    const invocationId = randomUUID();
    await fixture.write({ ...fixture.report(invocationId), before: createStandardDiagnosticBundle(fixture.evidence),
      after: createStandardDiagnosticBundle({ ...fixture.evidence, journal: { ...fixture.evidence.journal,
        frames: [{ slot: 0, state: "empty", checksum: "not_present" }, { slot: 1, state: "empty", checksum: "not_present" }] } }) });
    await expect(waitForNextInstalledLocalControlReport(fixture.options)).rejects.toThrow("rejected baseline changed journal");
  } finally { await fixture.cleanup(); }
});

it.each(["missing", "corrupt", "duplicate", "nonterminal", "auto-resume", "historical-rewrite"])("fails closed on %s baseline evidence", async mode => {
  const fixture = await acceptedBaselineFixture();
  try {
    const before = mode === "missing" ? { ...fixture.evidence, journal: { availability: "unavailable", frames: [] } } :
      mode === "corrupt" ? { ...fixture.evidence, journal: { ...fixture.evidence.journal, frames: [{ slot: 0, state: "invalid", checksum: "invalid" }, { slot: 1, state: "empty", checksum: "not_present" }] } } :
      mode === "duplicate" ? { ...fixture.evidence, changeSets: [...fixture.evidence.changeSets, { ...fixture.evidence.changeSets[0], changeSetId: "duplicate", submissionKey: "duplicate-key", enqueueSeq: 2 }] } :
      mode === "nonterminal" ? { ...fixture.evidence, changeSets: [{ ...fixture.evidence.changeSets[0], executionPhase: null }] } : fixture.evidence;
    const after = { ...fixture.evidence, health: { ...fixture.evidence.health, recovery: "none",
      write: { gate: "open", state: mode === "auto-resume" ? "writable" : "paused", pauseSource: mode === "auto-resume" ? null : "manual" },
      effectiveGate: mode === "auto-resume" ? null : "writes_paused" },
      journal: { ...fixture.evidence.journal, frames: [{ slot: 0, state: "empty", checksum: "not_present" }, { slot: 1, state: "empty", checksum: "not_present" }] },
      changeSets: mode === "historical-rewrite" ? [{ ...fixture.evidence.changeSets[0], state: "intent_not_applied" }] : fixture.evidence.changeSets };
    await fixture.writeBaseline(before, after);
    await expect(waitForNextInstalledLocalControlReport(fixture.options)).rejects.toThrow();
  } finally { await fixture.cleanup(); }
});

it("consumes a unique associated FAILED Journal acceptance that remains manually paused", async () => {
  const fixture = await acceptedBaselineFixture();
  try {
    await fixture.writeBaseline();
    expect(await waitForNextInstalledLocalControlReport(fixture.options)).toMatchObject({ outcome: "accepted", after: { health: { recovery: "none", write: { state: "paused" } } } });
  } finally { await fixture.cleanup(); }
});

it("rejects a rejected resume that clears Journal evidence or rewrites terminal history", async () => {
  const fixture = await acceptedBaselineFixture();
  try {
    await fixture.write({ ...fixture.report(randomUUID(), "resume-writes"), before: createStandardDiagnosticBundle(fixture.evidence),
      after: createStandardDiagnosticBundle({ ...fixture.evidence, journal: { ...fixture.evidence.journal,
        frames: [{ slot: 0, state: "empty", checksum: "not_present" }, { slot: 1, state: "empty", checksum: "not_present" }] } }) });
    await expect(waitForNextInstalledLocalControlReport({ ...fixture.options, action: "resume-writes" })).rejects.toThrow("rejected resume changed journal");
  } finally { await fixture.cleanup(); }
});

it("rejects accepted baseline with a readable FAILED frame alongside a corrupt Journal slot", async () => {
  const fixture = await acceptedBaselineFixture();
  try {
    await fixture.writeBaseline({ ...fixture.evidence, journal: { ...fixture.evidence.journal,
      frames: [fixture.evidence.journal.frames[0], { slot: 1, state: "invalid", checksum: "invalid" }] } });
    await expect(waitForNextInstalledLocalControlReport(fixture.options)).rejects.toThrow("corrupt Journal");
  } finally { await fixture.cleanup(); }
});

it("discovers the operator-generated invocation without requiring a caller-invented baseline ID", async () => {
  const fixture = await controlDiscoveryFixture();
  const invocationId = randomUUID();
  try {
    const pending = waitForNextInstalledLocalControlReport(fixture.options);
    await fixture.writeThroughProtocol(invocationId);
    const observed = await pending;
    expect(observed.invocationId).toBe(invocationId);
    expect(observed.action).toBe("accept-recovery-baseline");
    expect(observed.outcome).toBe("rejected");
  } finally { await fixture.cleanup(); }
});

it("excludes consumed IDs and unrelated actions without inventing a report order", async () => {
  const fixture = await controlDiscoveryFixture();
  try {
    const first = randomUUID();
    await fixture.writeThroughProtocol(first);
    await fixture.writeThroughProtocol(randomUUID(), "pause-writes");
    expect((await waitForNextInstalledLocalControlReport(fixture.options)).invocationId).toBe(first);
    const second = randomUUID();
    await fixture.writeThroughProtocol(second);
    await expect(waitForNextInstalledLocalControlReport(fixture.options)).rejects.toThrow("order is ambiguous");
    expect((await waitForNextInstalledLocalControlReport({ ...fixture.options, consumedInvocationIds: [first] })).invocationId).toBe(second);
    await expect(waitForNextInstalledLocalControlReport({ ...fixture.options, consumedInvocationIds: [first, second], timeoutMs: 10 })).rejects.toThrow("report is required");
  } finally { await fixture.cleanup(); }
});

it("fails closed on foreign or malformed reports even when their invocation was consumed or action differs", async () => {
  const fixture = await controlDiscoveryFixture();
  try {
    const invocationId = randomUUID();
    const valid = fixture.report(invocationId, "pause-writes");
    await fixture.write({ ...valid, vaultId: "foreign-vault" });
    await expect(waitForNextInstalledLocalControlReport({ ...fixture.options, consumedInvocationIds: [invocationId] })).rejects.toThrow("identity does not match");
    await fixture.write({ ...valid, after: { ...valid.after, bundleVersion: "forged" } } as unknown as typeof valid);
    await expect(waitForNextInstalledLocalControlReport({ ...fixture.options, consumedInvocationIds: [invocationId] })).rejects.toThrow("diagnostic checksum");
    await fixture.write(valid);
    await writeFile(join(fixture.reportDirectory, "local-write-control-malformed.json"), "{", { mode: 0o600 });
    await expect(waitForNextInstalledLocalControlReport(fixture.options)).rejects.toThrow();
  } finally { await fixture.cleanup(); }
});

it("rejects invalid loopback URLs and stale installed bindings before waiting on an empty directory", async () => {
  const fixture = await controlDiscoveryFixture();
  try {
    await expect(waitForNextInstalledLocalControlReport({ ...fixture.options, endpoint: new URL("https://example.com/mcp") })).rejects.toThrow("loopback endpoint");
    await expect(waitForNextInstalledLocalControlReport({ ...fixture.options, descriptor: { ...fixture.options.descriptor, capabilityToken: "f".repeat(64) } })).rejects.toThrow("descriptor identity changed");
  } finally { await fixture.cleanup(); }
});

it("rejects a local report whose claimed checksum verification covers an invalid diagnostic bundle", async () => {
  const root = await mkdtemp(join(tmpdir(), "local-operator-report-"));
  try {
    const vaultPath = join(root, "installed-runtime-vault-report");
    const pluginDirectory = join(vaultPath, ".obsidian", "plugins", "report-plugin");
    const reportDirectory = join(root, "reports");
    await mkdir(pluginDirectory, { recursive: true });
    await mkdir(reportDirectory);
    await writeFile(join(pluginDirectory, "main.js"), "candidate");
    const { descriptor } = await createInstalledRuntimeAcceptanceDescriptor({
      runId: "report", vaultPath, pluginId: "report-plugin", reportDirectory,
      candidateBundleSha256: "a".repeat(64),
    });
    await writeFile(join(reportDirectory, "local-standard-diagnostic-copy.json"), JSON.stringify({
      schemaVersion: 1, runId: descriptor.runId, candidateBundleSha256: descriptor.candidateBundleSha256,
      installedMainSha256: descriptor.installedMainSha256, capabilityToken: descriptor.capabilityToken,
      vaultId: "report-vault", endpoint: "http://127.0.0.1:32123/mcp",
      action: "standard-diagnostic-copy", checksumVerified: true, bundle: { checksum: "forged" },
    }), { mode: 0o600 });
    await expect(loadInstalledLocalOperatorReport({
      descriptor, vaultId: "report-vault", endpoint: new URL("http://127.0.0.1:32123/mcp"),
      action: "standard-diagnostic-copy",
    })).rejects.toThrow("diagnostic checksum");
    await expect(waitForInstalledLocalOperatorReport({
      descriptor, vaultId: "report-vault", endpoint: new URL("http://127.0.0.1:32123/mcp"),
      action: "standard-diagnostic-copy", timeoutMs: 100,
    })).rejects.toThrow("diagnostic checksum");
  } finally { await rm(root, { recursive: true, force: true }); }
});
it("rejects content diagnostic reports outside the exact private loopback MCP endpoint", async () => {
  const root = await mkdtemp(join(tmpdir(), "local-content-report-"));
  try {
    const vaultPath = join(root, "installed-runtime-vault-report");
    const pluginDirectory = join(vaultPath, ".obsidian", "plugins", "report-plugin");
    const reportDirectory = join(root, "reports");
    await mkdir(pluginDirectory, { recursive: true });
    await mkdir(reportDirectory);
    await writeFile(join(pluginDirectory, "main.js"), "candidate");
    const { descriptor } = await createInstalledRuntimeAcceptanceDescriptor({
      runId: "report", vaultPath, pluginId: "report-plugin", reportDirectory,
      candidateBundleSha256: "a".repeat(64),
    });
    const confirmationId = "cancelled-local-confirmation";
    const path = join(reportDirectory, `local-content-inclusive-diagnostic-copy-${createHash("sha256").update(confirmationId).digest("hex")}.json`);
    for (const endpoint of [
      "https://example.com/mcp", "http://127.0.0.1:32123/other",
      "http://127.0.0.1:32123/mcp?token=unexpected", "http://127.0.0.1:32123/mcp#unexpected",
      "http://user:password@127.0.0.1:32123/mcp", "http://127.0.0.1/mcp",
    ]) {
      await writeFile(path, JSON.stringify({
        schemaVersion: 1, runId: descriptor.runId, candidateBundleSha256: descriptor.candidateBundleSha256,
        installedMainSha256: descriptor.installedMainSha256, capabilityToken: descriptor.capabilityToken,
        vaultId: "report-vault", endpoint, action: "content-inclusive-diagnostic-copy",
        confirmationId, selectionSha256: "b".repeat(64), outcome: "cancelled", generated: false, copied: false,
      }), { mode: 0o600 });
      await expect(loadInstalledLocalOperatorReport({
        descriptor, vaultId: "report-vault", endpoint: new URL(endpoint),
        action: "content-inclusive-diagnostic-copy", confirmationId, expectedSelectionSha256: "b".repeat(64),
      })).rejects.toThrow("loopback endpoint");
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("times out waiting for a real local operator report instead of dispatching the operator action", async () => {
  const root = await mkdtemp(join(tmpdir(), "local-operator-wait-"));
  try {
    const vaultPath = join(root, "installed-runtime-vault-wait");
    const pluginDirectory = join(vaultPath, ".obsidian", "plugins", "report-plugin");
    const reportDirectory = join(root, "reports");
    await mkdir(pluginDirectory, { recursive: true });
    await mkdir(reportDirectory);
    await writeFile(join(pluginDirectory, "main.js"), "candidate");
    const { descriptor } = await createInstalledRuntimeAcceptanceDescriptor({
      runId: "wait", vaultPath, pluginId: "report-plugin", reportDirectory,
      candidateBundleSha256: "a".repeat(64),
    });
    await expect(waitForInstalledLocalOperatorReport({
      descriptor, vaultId: "report-vault", endpoint: new URL("http://127.0.0.1:32123/mcp"),
      action: "accept-recovery-baseline", invocationId: "human-only", timeoutMs: 20,
    })).rejects.toThrow("Local Primary Operator report is required");
    await rm(join(pluginDirectory, "installed-runtime-acceptance.json"));
    await expect(waitForInstalledLocalOperatorReport({
      descriptor, vaultId: "report-vault", endpoint: new URL("http://127.0.0.1:32123/mcp"),
      action: "accept-recovery-baseline", invocationId: "human-only", timeoutMs: 20,
    })).rejects.toMatchObject({ code: "ENOENT", path: join(pluginDirectory, "installed-runtime-acceptance.json") });
  } finally { await rm(root, { recursive: true, force: true }); }
});


it("discovers random content confirmations and consumes cancel then copy without inferring order", async () => {
  const fixture = await controlDiscoveryFixture();
  const selectionSha256 = "b".repeat(64);
  const writeContent = async (confirmationId: string, outcome: "cancelled" | "copied") => {
    const { invocationId: _, before: __, after: ___, ...binding } = fixture.report("unused");
    await writeFile(join(fixture.reportDirectory, `local-content-inclusive-diagnostic-copy-${createHash("sha256").update(confirmationId).digest("hex")}.json`), JSON.stringify({ ...binding,
      action: "content-inclusive-diagnostic-copy", confirmationId, selectionSha256, outcome,
      generated: outcome === "copied", copied: outcome === "copied", ...(outcome === "copied" ? {
        checksumVerified: true, bundleChecksum: `sha256:${"c".repeat(64)}`, bundleVersion: "1.0",
        versions: { bridge: "0.1.0", plugin: "0.1.0", protocol: "1.0", persistentStateSchema: 2, recoveryJournalSchema: 3 },
      } : {}),
    }), { mode: 0o600 });
  };
  const options = { ...fixture.options, consumedConfirmationIds: [] as string[], expectedSelectionSha256: selectionSha256 };
  try {
    const cancelId = randomUUID();
    const pending = waitForNextInstalledLocalContentReport(options);
    await writeContent(cancelId, "cancelled");
    expect(await pending).toMatchObject({ confirmationId: cancelId, outcome: "cancelled", generated: false, copied: false });
    const copyId = randomUUID();
    await writeContent(copyId, "copied");
    await expect(waitForNextInstalledLocalContentReport(options)).rejects.toThrow("order is ambiguous");
    expect(await waitForNextInstalledLocalContentReport({ ...options, consumedConfirmationIds: [cancelId] })).toMatchObject({ confirmationId: copyId, outcome: "copied" });
    await expect(waitForNextInstalledLocalContentReport({ ...options, consumedConfirmationIds: [cancelId, copyId], timeoutMs: 10 })).rejects.toThrow("report is required");
  } finally { await fixture.cleanup(); }
});


it("validates every discovered content report even when consumed, selection-mismatched, or alongside a valid pending report", async () => {
  const fixture = await controlDiscoveryFixture();
  const id = randomUUID();
  const { invocationId: _, before: __, after: ___, ...binding } = fixture.report("unused");
  const valid = { ...binding, action: "content-inclusive-diagnostic-copy", confirmationId: id,
    selectionSha256: "b".repeat(64), outcome: "copied", generated: true, copied: true,
    checksumVerified: true, bundleChecksum: `sha256:${"c".repeat(64)}`, bundleVersion: "1.0",
    versions: { bridge: "0.1.0", plugin: "0.1.0", protocol: "1.0", persistentStateSchema: 2, recoveryJournalSchema: 3 } };
  const path = join(fixture.reportDirectory, `local-content-inclusive-diagnostic-copy-${createHash("sha256").update(id).digest("hex")}.json`);
  const options = { ...fixture.options, consumedConfirmationIds: [id], expectedSelectionSha256: "b".repeat(64) };
  const write = (value: unknown) => writeFile(path, JSON.stringify(value), { mode: 0o600 });
  try {
    for (const field of ["bridge", "plugin", "protocol", "persistentStateSchema", "recoveryJournalSchema"] as const) {
      await write({ ...valid, versions: { ...valid.versions, [field]: typeof valid.versions[field] === "string" ? "forged" : 999 } });
      await expect(waitForNextInstalledLocalContentReport(options)).rejects.toThrow("versions do not match");
    }
    await write({ ...valid, selectionSha256: "d".repeat(64) });
    await expect(waitForNextInstalledLocalContentReport(options)).rejects.toThrow("selection binding");
    await write({ ...valid, vaultId: "foreign" });
    await expect(waitForNextInstalledLocalContentReport(options)).rejects.toThrow("identity does not match");
    await write({ ...valid, confirmationId: randomUUID() });
    await expect(waitForNextInstalledLocalContentReport(options)).rejects.toThrow("filename does not match");
    await write({ ...valid, generated: false });
    await expect(waitForNextInstalledLocalContentReport(options)).rejects.toThrow("contradict the outcome");
    await write({ ...valid, outcome: "cancelled", generated: false, copied: false });
    await expect(waitForNextInstalledLocalContentReport(options)).rejects.toThrow("contradict the outcome");
    await write(valid);
    await writeFile(join(fixture.reportDirectory, "local-content-inclusive-diagnostic-copy-malformed.json"), "{", { mode: 0o600 });
    await expect(waitForNextInstalledLocalContentReport({ ...options, consumedConfirmationIds: [] })).rejects.toThrow();
  } finally { await fixture.cleanup(); }
});
