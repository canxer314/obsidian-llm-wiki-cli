import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile, rename, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createStandardDiagnosticBundle } from "../src/diagnostic-bundle.js";
import { createContentInclusiveDiagnosticBundle } from "../src/content-inclusive-diagnostic-bundle.js";
import { loadInstalledLocalOperatorReport } from "../src/installed-runtime/local-operator-report.js";
import { activateInstalledRuntimeAcceptanceDriver, createInstalledRuntimeAcceptanceDescriptor } from "../src/installed-runtime/smoke-command.js";

it("publishes only a valid Vault-bound standard diagnostic copy and preserves its first evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "installed-local-diagnostic-"));
  const vaultPath = join(root, "installed-runtime-vault-local");
  const pluginDirectory = join(vaultPath, ".obsidian", "plugins", "local-plugin");
  await mkdir(pluginDirectory, { recursive: true });
  await writeFile(join(pluginDirectory, "main.js"), "candidate");
  const reports = join(root, "reports");
  const created = await createInstalledRuntimeAcceptanceDescriptor({
    runId: "local", vaultPath, pluginId: "local-plugin", reportDirectory: reports,
    candidateBundleSha256: "a".repeat(64),
  });
  const activation = await activateInstalledRuntimeAcceptanceDriver({ vaultPath, pluginId: "local-plugin" });
  try {
    await expect(activation!.recordStandardDiagnosticCopy({
      vaultId: "local-vault", endpoint: new URL("http://127.0.0.1:32123/mcp"),
      bundle: { checksum: { algorithm: "sha256", canonicalPayload: "forged" } },
    })).rejects.toThrow("valid standard diagnostic bundle");
    await expect(readFile(join(reports, "local-standard-diagnostic-copy.json"))).rejects.toMatchObject({ code: "ENOENT" });
    const evidence = {
      vaultId: "local-vault",
      versions: { bridge: "0.1.0", plugin: "0.1.0", protocol: "1.0", persistentStateSchema: 2, recoveryJournalSchema: 3 },
      health: {
        readiness: { searchSnapshot: "ready", cache: "ready", index: "ready" }, recovery: "none",
        write: { gate: "open", state: "writable", pauseSource: null }, effectiveGate: null,
        overall: "healthy", reasonCodes: [], operatorAction: "none",
      },
      listener: { address: "127.0.0.1", port: 32123 },
      queue: { currentExecutionId: null, length: 0, headChangeSetId: null },
      lifecycle: { startup: "ready", upgrade: "not_run", migration: "not_run", recovery: "not_run" },
      journal: { availability: "unavailable", frames: [] }, changeSets: [], machineEvents: [],
    };
    const bundle = createStandardDiagnosticBundle(evidence);
    await writeFile(join(pluginDirectory, "data.json"), JSON.stringify({ vaultId: "local-vault", port: 32123 }));
    await expect(activation!.recordStandardDiagnosticCopy({ vaultId: "foreign-vault", endpoint: new URL("http://127.0.0.1:32123/mcp"), bundle })).rejects.toThrow("running Vault identity");
    const wrongListenerBundle = createStandardDiagnosticBundle({ ...evidence, listener: { address: "127.0.0.1", port: 32124 } });
    await expect(activation!.recordStandardDiagnosticCopy({ vaultId: "local-vault", endpoint: new URL("http://127.0.0.1:32123/mcp"), bundle: wrongListenerBundle })).rejects.toThrow("diagnostic listener");
    await writeFile(created.path, JSON.stringify({ ...created.descriptor, runId: "foreign-run" }));
    await expect(activation!.recordStandardDiagnosticCopy({ vaultId: "local-vault", endpoint: new URL("http://127.0.0.1:32123/mcp"), bundle })).rejects.toThrow("descriptor identity changed");
    await writeFile(created.path, JSON.stringify(created.descriptor));
    await activation!.recordStandardDiagnosticCopy({ vaultId: "local-vault", endpoint: new URL("http://127.0.0.1:32123/mcp"), bundle });
    const report = JSON.parse(await readFile(join(reports, "local-standard-diagnostic-copy.json"), "utf8"));
    expect(report).toMatchObject({
      schemaVersion: 1, runId: "local", candidateBundleSha256: "a".repeat(64),
      vaultId: "local-vault", endpoint: "http://127.0.0.1:32123/mcp",
      action: "standard-diagnostic-copy", checksumVerified: true, bundle,
    });
    const loadedReport = await loadInstalledLocalOperatorReport({ descriptor: created.descriptor,
      vaultId: "local-vault", endpoint: new URL("http://127.0.0.1:32123/mcp"), action: "standard-diagnostic-copy" });
    expect(loadedReport.action).toBe("standard-diagnostic-copy");
    if (loadedReport.action !== "standard-diagnostic-copy") throw new Error("Wrong local report action");
    expect(loadedReport.bundle).toEqual(bundle);
    await expect(loadInstalledLocalOperatorReport({ descriptor: { ...created.descriptor, runId: "foreign" },
      vaultId: "local-vault", endpoint: new URL("http://127.0.0.1:32123/mcp"), action: "standard-diagnostic-copy" })).rejects.toThrow("identity does not match");
    await expect(activation!.recordStandardDiagnosticCopy({ vaultId: "local-vault", endpoint: new URL("http://127.0.0.1:32123/mcp"), bundle })).rejects.toMatchObject({ code: "EEXIST" });
    expect(JSON.parse(await readFile(join(reports, "local-standard-diagnostic-copy.json"), "utf8"))).toEqual(report);
    await activation!.recordContentInclusiveDiagnosticCopy({
      vaultId: "local-vault", endpoint: new URL("http://127.0.0.1:32123/mcp"),
      confirmationId: "fresh-local-confirmation", outcome: "cancelled", selection: "private selected text",
    });
    const cancelled = await readFile(join(reports, `local-content-inclusive-diagnostic-copy-${createHash("sha256").update("fresh-local-confirmation").digest("hex")}.json`), "utf8");
    expect(JSON.parse(cancelled)).toMatchObject({
      action: "content-inclusive-diagnostic-copy", outcome: "cancelled",
      confirmationId: "fresh-local-confirmation", generated: false, copied: false,
    });
    expect(cancelled).not.toContain("private selected text");
    const selectedBundle = createContentInclusiveDiagnosticBundle(evidence, "private selected text");
    await expect(activation!.recordContentInclusiveDiagnosticCopy({
      vaultId: "local-vault", endpoint: new URL("http://127.0.0.1:32123/mcp"),
      confirmationId: "forged-copy", outcome: "copied", selection: "private selected text",
      bundle: selectedBundle, copiedTextSha256: "0".repeat(64),
    })).rejects.toThrow("copied bytes");
    await activation!.recordContentInclusiveDiagnosticCopy({
      vaultId: "local-vault", endpoint: new URL("http://127.0.0.1:32123/mcp"),
      confirmationId: "another-fresh-confirmation", outcome: "copied", selection: "private selected text",
      bundle: selectedBundle, copiedTextSha256: createHash("sha256").update(JSON.stringify(selectedBundle)).digest("hex"),
    });
    const copied = await readFile(join(reports, `local-content-inclusive-diagnostic-copy-${createHash("sha256").update("another-fresh-confirmation").digest("hex")}.json`), "utf8");
    expect(JSON.parse(copied)).toMatchObject({ outcome: "copied", generated: true, copied: true,
      checksumVerified: true, bundleChecksum: selectedBundle.checksum.canonicalPayload });
    expect(JSON.parse(copied).bundle.selection.content).toBe("private selected text");
    const loadedContent = await loadInstalledLocalOperatorReport({ descriptor: created.descriptor,
      vaultId: "local-vault", endpoint: new URL("http://127.0.0.1:32123/mcp"),
      action: "content-inclusive-diagnostic-copy", confirmationId: "another-fresh-confirmation",
      expectedSelectionSha256: createHash("sha256").update("private selected text").digest("hex") });
    expect(loadedContent).toMatchObject({ action: "content-inclusive-diagnostic-copy", outcome: "copied", copied: true });
    const copiedPath = join(reports, `local-content-inclusive-diagnostic-copy-${createHash("sha256").update("another-fresh-confirmation").digest("hex")}.json`);
    await writeFile(copiedPath, JSON.stringify({ ...JSON.parse(copied), copiedTextSha256: "0".repeat(64) }), { mode: 0o600 });
    await expect(loadInstalledLocalOperatorReport({ descriptor: created.descriptor, vaultId: "local-vault", endpoint: new URL("http://127.0.0.1:32123/mcp"), action: "content-inclusive-diagnostic-copy", confirmationId: "another-fresh-confirmation", expectedSelectionSha256: createHash("sha256").update("private selected text").digest("hex") })).rejects.toThrow("copied bytes");
    await writeFile(copiedPath, copied, { mode: 0o600 });
    await expect(loadInstalledLocalOperatorReport({ descriptor: created.descriptor,
      vaultId: "local-vault", endpoint: new URL("http://127.0.0.1:32123/mcp"),
      action: "content-inclusive-diagnostic-copy", confirmationId: "another-fresh-confirmation",
      expectedSelectionSha256: "f".repeat(64) })).rejects.toThrow("selection binding");
    await expect(activation!.recordLocalWriteControl({
      vaultId: "local-vault", endpoint: new URL("http://127.0.0.1:32123/mcp"),
      invocationId: "foreign-listener-control", action: "resume-writes", outcome: "accepted",
      before: wrongListenerBundle, after: bundle,
    })).rejects.toThrow("diagnostic listener");
    await activation!.recordLocalWriteControl({
      vaultId: "local-vault", endpoint: new URL("http://127.0.0.1:32123/mcp"),
      invocationId: "local-baseline-rejected", action: "accept-recovery-baseline", outcome: "rejected",
      before: bundle, after: bundle,
    });
    const control = JSON.parse(await readFile(join(reports, `local-write-control-${createHash("sha256").update("local-baseline-rejected").digest("hex")}.json`), "utf8"));
    expect(control).toMatchObject({
      action: "accept-recovery-baseline", outcome: "rejected", invocationId: "local-baseline-rejected",
      before: { health: { recovery: "none" }, journal: { availability: "unavailable" } },
      after: { health: { recovery: "none" }, journal: { availability: "unavailable" } },
    });
    const loadedControl = await loadInstalledLocalOperatorReport({ descriptor: created.descriptor,
      vaultId: "local-vault", endpoint: new URL("http://127.0.0.1:32123/mcp"),
      action: "accept-recovery-baseline", invocationId: "local-baseline-rejected" });
    expect(loadedControl).toMatchObject({ action: "accept-recovery-baseline", outcome: "rejected", before: bundle, after: bundle });
    await activation!.recordLocalWriteControl({
      vaultId: "local-vault", endpoint: new URL("http://127.0.0.1:32123/mcp"),
      invocationId: "false-baseline-accepted", action: "accept-recovery-baseline", outcome: "accepted",
      before: bundle, after: bundle,
    });
    await expect(loadInstalledLocalOperatorReport({ descriptor: created.descriptor,
      vaultId: "local-vault", endpoint: new URL("http://127.0.0.1:32123/mcp"),
      action: "accept-recovery-baseline", invocationId: "false-baseline-accepted" })).rejects.toThrow("baseline transition");
    await activation!.recordLocalWriteControl({
      vaultId: "local-vault", endpoint: new URL("http://127.0.0.1:32123/mcp"),
      invocationId: "false-pause-accepted", action: "pause-writes", outcome: "accepted",
      before: bundle, after: bundle,
    });
    await expect(loadInstalledLocalOperatorReport({ descriptor: created.descriptor,
      vaultId: "local-vault", endpoint: new URL("http://127.0.0.1:32123/mcp"),
      action: "pause-writes", invocationId: "false-pause-accepted" })).rejects.toThrow("pause transition");
    const blocked = createStandardDiagnosticBundle({ ...evidence, health: {
      ...evidence.health, recovery: "blocked", effectiveGate: "recovery_blocked",
      write: { gate: "blocked", state: "paused", pauseSource: null },
      overall: "blocked", reasonCodes: ["recovery_blocked"], operatorAction: "review_recovery",
    } });
    await activation!.recordLocalWriteControl({
      vaultId: "local-vault", endpoint: new URL("http://127.0.0.1:32123/mcp"),
      invocationId: "unsafe-resume", action: "resume-writes", outcome: "accepted", before: blocked, after: bundle,
    });
    await expect(loadInstalledLocalOperatorReport({ descriptor: created.descriptor,
      vaultId: "local-vault", endpoint: new URL("http://127.0.0.1:32123/mcp"),
      action: "resume-writes", invocationId: "unsafe-resume" })).rejects.toThrow("resume transition");
    await activation!.recordLocalWriteControl({
      vaultId: "local-vault", endpoint: new URL("http://127.0.0.1:32123/mcp"),
      invocationId: "mutating-rejected-baseline", action: "accept-recovery-baseline", outcome: "rejected",
      before: blocked, after: bundle,
    });
    await expect(loadInstalledLocalOperatorReport({ descriptor: created.descriptor,
      vaultId: "local-vault", endpoint: new URL("http://127.0.0.1:32123/mcp"),
      action: "accept-recovery-baseline", invocationId: "mutating-rejected-baseline" })).rejects.toThrow("rejected baseline changed recovery state");
    const paused = createStandardDiagnosticBundle({ ...evidence, health: {
      ...evidence.health, effectiveGate: "writes_paused",
      write: { gate: "blocked", state: "paused", pauseSource: "manual" },
      overall: "blocked", reasonCodes: ["writes_paused"], operatorAction: "resume_writes",
    }, journal: { availability: "available", journalVersion: 1, headerChecksum: "valid", frames: [
      { slot: 0, state: "empty", checksum: "not_present" },
      { slot: 1, state: "empty", checksum: "not_present" },
    ] } });
    const staleFailed = createStandardDiagnosticBundle({ ...evidence, health: blocked.health,
      journal: { availability: "available", journalVersion: 1, headerChecksum: "valid", frames: [
        { slot: 0, state: "valid", checksum: "valid", sequence: 1, phase: "FAILED", frameSchemaVersion: 1, changeSetId: "old-failure" },
        { slot: 1, state: "valid", checksum: "valid", sequence: 2, phase: "COMMITTED", frameSchemaVersion: 1, changeSetId: "latest-commit" },
      ] } });
    await activation!.recordLocalWriteControl({
      vaultId: "local-vault", endpoint: new URL("http://127.0.0.1:32123/mcp"),
      invocationId: "stale-failed-baseline", action: "accept-recovery-baseline", outcome: "accepted",
      before: staleFailed, after: paused,
    });
    await expect(loadInstalledLocalOperatorReport({ descriptor: created.descriptor,
      vaultId: "local-vault", endpoint: new URL("http://127.0.0.1:32123/mcp"),
      action: "accept-recovery-baseline", invocationId: "stale-failed-baseline" })).rejects.toThrow("baseline transition");
    const failedEntry = { changeSetId: "failed-change", submissionKey: "failed-key", enqueueSeq: 1,
      state: "result_unproven", executionPhase: "terminal" };
    const currentFailed = createStandardDiagnosticBundle({ ...evidence, health: blocked.health, changeSets: [failedEntry],
      journal: { availability: "available", journalVersion: 1, headerChecksum: "valid", frames: [
        { slot: 0, state: "valid", checksum: "valid", sequence: 1, phase: "PREPARED", frameSchemaVersion: 1, changeSetId: "failed-change" },
        { slot: 1, state: "valid", checksum: "valid", sequence: 2, phase: "FAILED", frameSchemaVersion: 1, changeSetId: "failed-change" },
      ] } });
    const acceptedPaused = createStandardDiagnosticBundle({ ...evidence, health: paused.health, journal: paused.journal, changeSets: [failedEntry] });
    await activation!.recordLocalWriteControl({
      vaultId: "local-vault", endpoint: new URL("http://127.0.0.1:32123/mcp"),
      invocationId: "valid-baseline", action: "accept-recovery-baseline", outcome: "accepted",
      before: currentFailed, after: acceptedPaused,
    });
    expect(await loadInstalledLocalOperatorReport({ descriptor: created.descriptor,
      vaultId: "local-vault", endpoint: new URL("http://127.0.0.1:32123/mcp"),
      action: "accept-recovery-baseline", invocationId: "valid-baseline" })).toMatchObject({ outcome: "accepted" });
    const clearedBlocked = createStandardDiagnosticBundle({ ...evidence, health: blocked.health, changeSets: [failedEntry],
      journal: { availability: "available", journalVersion: 1, headerChecksum: "valid", frames: [
        { slot: 0, state: "empty", checksum: "not_present" },
        { slot: 1, state: "empty", checksum: "not_present" },
      ] } });
    await activation!.recordLocalWriteControl({
      vaultId: "local-vault", endpoint: new URL("http://127.0.0.1:32123/mcp"),
      invocationId: "rejected-cleared-journal", action: "accept-recovery-baseline", outcome: "rejected",
      before: currentFailed, after: clearedBlocked,
    });
    await expect(loadInstalledLocalOperatorReport({ descriptor: created.descriptor,
      vaultId: "local-vault", endpoint: new URL("http://127.0.0.1:32123/mcp"),
      action: "accept-recovery-baseline", invocationId: "rejected-cleared-journal" })).rejects.toThrow("rejected baseline changed journal facts");
    const historical = createStandardDiagnosticBundle({ ...evidence, changeSets: [{
      changeSetId: "historical-change", submissionKey: "historical-key", enqueueSeq: 1,
      state: "intent_not_applied", executionPhase: "terminal",
    }] });
    await activation!.recordLocalWriteControl({
      vaultId: "local-vault", endpoint: new URL("http://127.0.0.1:32123/mcp"),
      invocationId: "rejected-lost-history", action: "accept-recovery-baseline", outcome: "rejected",
      before: historical, after: bundle,
    });
    await expect(loadInstalledLocalOperatorReport({ descriptor: created.descriptor,
      vaultId: "local-vault", endpoint: new URL("http://127.0.0.1:32123/mcp"),
      action: "accept-recovery-baseline", invocationId: "rejected-lost-history" })).rejects.toThrow("baseline changed historical outcomes");
    const failedWithHistory = createStandardDiagnosticBundle({ ...evidence, health: blocked.health,
      journal: { availability: "available", journalVersion: 1, headerChecksum: "valid", frames: [
        { slot: 0, state: "empty", checksum: "not_present" },
        { slot: 1, state: "valid", checksum: "valid", sequence: 2, phase: "FAILED", frameSchemaVersion: 1, changeSetId: "current-failure" },
      ] }, changeSets: [{ changeSetId: "current-failure", submissionKey: "current-key", enqueueSeq: 2,
        state: "result_unproven", executionPhase: "terminal" }] });
    await activation!.recordLocalWriteControl({
      vaultId: "local-vault", endpoint: new URL("http://127.0.0.1:32123/mcp"),
      invocationId: "accepted-lost-history", action: "accept-recovery-baseline", outcome: "accepted",
      before: failedWithHistory, after: paused,
    });
    await expect(loadInstalledLocalOperatorReport({ descriptor: created.descriptor,
      vaultId: "local-vault", endpoint: new URL("http://127.0.0.1:32123/mcp"),
      action: "accept-recovery-baseline", invocationId: "accepted-lost-history" })).rejects.toThrow("baseline changed historical outcomes");
    const historicalAgain = createStandardDiagnosticBundle({ ...evidence, changeSets: [{
      changeSetId: "historical-change", submissionKey: "historical-key", enqueueSeq: 1,
      state: "intent_not_applied", executionPhase: "terminal",
    }] });
    await activation!.recordLocalWriteControl({
      vaultId: "local-vault", endpoint: new URL("http://127.0.0.1:32123/mcp"),
      invocationId: "rejected-preserved-history", action: "accept-recovery-baseline", outcome: "rejected",
      before: historical, after: historicalAgain,
    });
    expect(await loadInstalledLocalOperatorReport({ descriptor: created.descriptor,
      vaultId: "local-vault", endpoint: new URL("http://127.0.0.1:32123/mcp"),
      action: "accept-recovery-baseline", invocationId: "rejected-preserved-history" })).toMatchObject({ outcome: "rejected" });
    await writeFile(join(pluginDirectory, "main.js"), "replaced candidate");
    await expect(loadInstalledLocalOperatorReport({ descriptor: created.descriptor,
      vaultId: "local-vault", endpoint: new URL("http://127.0.0.1:32123/mcp"),
      action: "standard-diagnostic-copy" })).rejects.toThrow("installed entry point");
    await writeFile(join(pluginDirectory, "main.js"), "candidate");
    await writeFile(created.path, JSON.stringify({ ...created.descriptor, runId: "superseding-run" }));
    await expect(loadInstalledLocalOperatorReport({ descriptor: created.descriptor,
      vaultId: "local-vault", endpoint: new URL("http://127.0.0.1:32123/mcp"),
      action: "standard-diagnostic-copy" })).rejects.toThrow("descriptor identity changed");
    await writeFile(created.path, JSON.stringify(created.descriptor));
    const replacement = join(root, "replacement-reports");
    await mkdir(replacement);
    await rename(reports, `${reports}-original`);
    await symlink(replacement, reports);
    await writeFile(join(replacement, "local-standard-diagnostic-copy.json"), JSON.stringify(report), { mode: 0o600 });
    await expect(loadInstalledLocalOperatorReport({ descriptor: created.descriptor,
      vaultId: "local-vault", endpoint: new URL("http://127.0.0.1:32123/mcp"),
      action: "standard-diagnostic-copy" })).rejects.toThrow("report root changed");
    await rm(join(replacement, "local-standard-diagnostic-copy.json"));
    await expect(activation!.recordStandardDiagnosticCopy({ vaultId: "local-vault", endpoint: new URL("http://127.0.0.1:32123/mcp"), bundle })).rejects.toThrow("report root changed");
    await expect(readFile(join(replacement, "local-standard-diagnostic-copy.json"))).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    activation?.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
