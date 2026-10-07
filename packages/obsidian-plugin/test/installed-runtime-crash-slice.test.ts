import { parseChangeSetStatusResult, parseChangeSetSubmitResult, serializeChangeSetStatusCompatibilityText, serializeChangeSetSubmitCompatibilityText } from "@llm-wiki/vault-contracts";
import { activateInstalledRuntimeAcceptanceDriver, createInstalledRuntimeAcceptanceDescriptor } from "../src/installed-runtime/smoke-command.js";
import { requestInstalledCrashRestorationScenario, parseCrashRestorationCommand } from "../src/installed-runtime/crash-restoration-protocol.js";
import { mkdtemp, mkdir, readdir, open, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { crashRestorationBoundaryPath, loadCrashBoundaryReport, writeCrashRestorationBoundaryReport } from "../src/installed-runtime/crash-restoration-protocol.js";
import { openRecoveryJournal } from "../src/recovery-journal.js";
import { readInstalledCrashJournal, runInstalledCrashRestorationSlice } from "../src/installed-runtime/installed-crash-restoration-slice.js";
import { brandVerifiedCandidateBundle, inspectCandidateBundle } from "../src/installed-runtime/candidate-bundle.js";
import { ObsidianProcessError } from "../src/installed-runtime/obsidian-process.js";
import type { InstalledCrashRestorationSliceOptions } from "../src/installed-runtime/installed-crash-restoration-slice.js";

it("admits every distinct installed create/exact/whole crash boundary but rejects unregistered execution programs", async () => {
  const { installedCrashScenarios } = await import("../src/installed-runtime/crash-restoration-protocol.js");
  const points = ["before_prepared", "after_prepared", "after_file_mutation:0", "after_raw_verification", "during_success_barrier", "after_snapshot", "before_committed", "after_committed", "before_rollback", "after_rollback_mutation:0", "after_rollback_verification", "after_rollback_evidence", "before_rolled_back", "after_rolled_back"];
  for (const kind of ["create_note", "edit_body", "edit_body_whole"]) {
    const expected = [...points, ...(kind === "create_note" ? ["after_mutation:0", "after_mutation:1", "after_rollback_mutation:1", "after_rollback_mutation:2"] : [])];
    expect(installedCrashScenarios.filter(scenario => scenario.startsWith(`${kind}/`)).map(scenario => scenario.slice(kind.length + 1)).sort()).toEqual(expected.sort());
    for (const point of expected) {
      expect(parseCrashRestorationCommand({ sequence: 1, capabilityToken: "a".repeat(64), action: "run-crash-restoration-scenario", scenario: `${kind}/${point}`, expectedVaultId: "v", endpoint: "http://127.0.0.1:32123/mcp", submissionKey: "submission-test", input: {} })).not.toBeNull();
    }
  }
  for (const scenario of ["create_note/after_mutation:2", "edit_body/after_mutation:0", "edit_body_whole/eval", "eval/after_prepared", "create_note/../baseline"]) {
    expect(parseCrashRestorationCommand({ sequence: 1, capabilityToken: "a".repeat(64), action: "run-crash-restoration-scenario", scenario, expectedVaultId: "v", endpoint: "http://127.0.0.1:32123/mcp", submissionKey: "submission-test", input: {} })).toBeNull();
  }
});

it("requires the actual absent/PREPARED/COMMITTED/ROLLED_BACK phase and binds marker sequence and frame", async () => {
  const { crashBoundaryPhase, crashRestorationBoundarySchema } = await import("../src/installed-runtime/crash-restoration-protocol.js");
  expect(crashBoundaryPhase("before_prepared")).toBeNull();
  expect(crashBoundaryPhase("before_committed")).toBe("PREPARED");
  expect(crashBoundaryPhase("after_committed")).toBe("COMMITTED");
  expect(crashBoundaryPhase("before_rolled_back")).toBe("PREPARED");
  expect(crashBoundaryPhase("after_rolled_back")).toBe("ROLLED_BACK");
  const report = { schemaVersion: 1, runId: "r", vaultId: "v", endpoint: "http://127.0.0.1:1234/mcp", scenario: "edit_body_whole/before_committed", candidateBundleSha256: "a".repeat(64), installedMainSha256: "b".repeat(64), capabilityToken: "c".repeat(64), submissionKey: "s", sequence: 2, point: "before_committed", journalPhase: "PREPARED", frameSha256: "d".repeat(64), inventorySha256: "e".repeat(64) };
  expect(crashRestorationBoundarySchema.safeParse(report).success).toBe(true);
  for (const changed of [{ journalPhase: "COMMITTED" }, { frameSha256: null }, { sequence: 0 }, { point: "after_committed" }]) expect(crashRestorationBoundarySchema.safeParse({ ...report, ...changed }).success).toBe(false);
  expect(crashRestorationBoundarySchema.safeParse({ ...report, scenario: "edit_body_whole/before_prepared", point: "before_prepared", journalPhase: null, frameSha256: null }).success).toBe(true);
  expect(crashRestorationBoundarySchema.safeParse({ ...report, scenario: "edit_body_whole/before_prepared", point: "before_prepared", journalPhase: "PREPARED" }).success).toBe(false);
});

it("rejects partial whole-state restoration and invented or truncated public proof", async () => {
  const { verifyCrashPublicProof, verifyCrashInventory } = await import("../src/installed-runtime/crash-restoration-protocol.js");
  const before = [{ path: "Notes", kind: "directory" }, { path: "Notes/Welcome.md", kind: "file", bytes: 4, sha256: "a".repeat(64) }];
  expect(() => verifyCrashInventory(before, [...before, { path: "Corpus", kind: "directory" }], "create_note", "original")).toThrow("whole-state");
  expect(() => verifyCrashInventory(before, before, "create_note", "original")).not.toThrow();
  expect(() => verifyCrashPublicProof({ changeSetId: "id", state: "intent_not_applied" }, { changeSetId: "id", state: "in_progress", preview: { requestedEffects: [], derivedEffects: [], paths: [] } }, "create_note", "intent_not_applied")).toThrow("proof");
  expect(() => verifyCrashPublicProof({ changeSetId: "id", state: "intent_applied", preview: { requestedEffects: [], derivedEffects: [], paths: [] }, requestedEffects: [], derivedEffects: [], paths: [] }, { changeSetId: "id", state: "in_progress", preview: { requestedEffects: [], derivedEffects: [], paths: [] } }, "create_note", "intent_applied")).toThrow("proof");
});

it("arms restart-only rollback parking only for the exact fixed fixture and bound PREPARED frame", async () => {
  const { validateInstalledCrashRecovery } = await import("../src/installed-runtime/crash-restoration-protocol.js");
  const { createNoteCorpusProfile } = await import("../src/corpus/create-note-corpus.js");
  const input = createNoteCorpusProfile().buildSubmitInput("recovery-test");
  const frame = { phase: "PREPARED", vaultId: "v", changeSetId: "id", input };
  const { crashDigest } = await import("../src/installed-runtime/crash-restoration-protocol.js");
  const command = { sequence: 2, capabilityToken: "a".repeat(64), action: "run-crash-restoration-scenario", scenario: "create_note/before_rolled_back", expectedVaultId: "v", endpoint: "http://127.0.0.1:1234/mcp", submissionKey: "submission-recovery-test", input, recovery: { changeSetId: "id", frameSha256: crashDigest(frame) } };
  expect(validateInstalledCrashRecovery(command, frame, { vaultId: "v", port: 1234 })).toMatchObject({ recovery: { changeSetId: "id" } });
  for (const changed of [{ phase: "COMMITTED" }, { vaultId: "foreign" }, { input: { ...input, operations: [] } }, { changeSetId: "foreign" }]) expect(() => validateInstalledCrashRecovery(command, { ...frame, ...changed }, { vaultId: "v", port: 1234 })).toThrow();
  expect(() => validateInstalledCrashRecovery({ ...command, scenario: "create_note/after_prepared" }, frame, { vaultId: "v", port: 1234 })).toThrow();
  expect(() => validateInstalledCrashRecovery(command, frame, { vaultId: "v", port: 1235 })).toThrow();
});

it("reaches before_committed as a separate real executor boundary and preserves PREPARED bytes", async () => {
  const { runMutationCorpusScenario } = await import("../src/corpus/crash-corpus-runner.js");
  const { replaceWholeCorpusProfile } = await import("../src/corpus/edit-body-corpus.js");
  const base = replaceWholeCorpusProfile();
  const point = { point: "before_committed", phase: "apply" as const };
  const root = await mkdtemp(join(tmpdir(), "installed-before-committed-hook-"));
  try {
    const result = await runMutationCorpusScenario({ profile: { ...base, crashPoints: [point], expectedBoundary: () => ({ journalPhase: "PREPARED", files: [{ path: base.primaryPath, state: "committed" }] }) }, crashPoint: point, seed: "before-committed-hook", reportDir: root });
    expect(result.verdict).toBe("pass");
    expect(result.boundary.journalPhase).toBe("PREPARED");
    expect(result.proofState).toBe("intent_not_applied");
  } finally { await rm(root, { recursive: true, force: true }); }
}, 120_000);

it("emits no installed marker when the hook phase, frame or whole footprint is false", async () => {
  const { parkInstalledCrashBoundary, crashProfile, crashDigest, crashInventory } = await import("../src/installed-runtime/crash-restoration-protocol.js");
  const root = await mkdtemp(join(tmpdir(), "installed-crash-hook-"));
  const vaultPath = join(root, "installed-runtime-vault-hook");
  const pluginDirectory = join(vaultPath, ".obsidian", "plugins", "crash-plugin");
  await mkdir(pluginDirectory, { recursive: true });
  await writeFile(join(pluginDirectory, "main.js"), "candidate");
  const created = await createInstalledRuntimeAcceptanceDescriptor({ runId: "hook", vaultPath, pluginId: "crash-plugin", reportDirectory: join(root, "reports"), candidateBundleSha256: "a".repeat(64) });
  await mkdir(created.descriptor.reportDirectory);
  const input = crashProfile("edit_body_whole").buildSubmitInput("hook");
  const command = { sequence: 1, capabilityToken: created.descriptor.capabilityToken, action: "run-crash-restoration-scenario" as const, scenario: "edit_body_whole/after_prepared" as const, expectedVaultId: "v", endpoint: "http://127.0.0.1:1234/mcp", submissionKey: "submission-hook", input };
  try {
    for (const frame of [null, { phase: "COMMITTED", vaultId: "v", input }, { phase: "PREPARED", vaultId: "foreign", input }, { phase: "PREPARED", vaultId: "v", input: {} }]) {
      await expect(parkInstalledCrashBoundary({ descriptor: created.descriptor, command, frame, before: [], park: async () => undefined })).rejects.toThrow();
      expect(await readdir(created.descriptor.reportDirectory)).toEqual([]);
    }
    const profile = crashProfile("edit_body_whole");
    await mkdir(join(vaultPath, "Corpus", "Edits"), { recursive: true });
    await writeFile(join(vaultPath, profile.primaryPath), profile.files[0]!.originalBytes!);
    const before = await crashInventory(vaultPath);
    const frame = { phase: "PREPARED", vaultId: "v", input };
    let parked = false;
    await parkInstalledCrashBoundary({ descriptor: created.descriptor, command, frame, before, park: async () => { parked = true; } });
    expect(parked).toBe(true);
    expect(await loadCrashBoundaryReport({ ...created.descriptor, vaultId: "v", endpoint: command.endpoint, submissionKey: command.submissionKey, crashPoint: "after_prepared", mutationKind: "edit_body_whole" })).toMatchObject({ frameSha256: crashDigest(frame), inventorySha256: crashDigest(before) });
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("binds candidate boundary inventory to the actual config directory without hiding public lookalikes", async () => {
  const { parkInstalledCrashBoundary, crashProfile, crashDigest, crashInventory } = await import("../src/installed-runtime/crash-restoration-protocol.js");
  const root = await mkdtemp(join(tmpdir(), "installed-crash-hook-config-"));
  const vaultPath = join(root, "installed-runtime-vault-hook-config");
  const configDirectoryName = ".candidate-config";
  const pluginDirectory = join(vaultPath, configDirectoryName, "plugins", "crash-plugin");
  await mkdir(pluginDirectory, { recursive: true });
  await writeFile(join(pluginDirectory, "main.js"), "candidate");
  await mkdir(join(vaultPath, ".obsidian-backup"));
  await writeFile(join(vaultPath, ".obsidian-backup", "Public.md"), "hello");
  await mkdir(join(root, "reports"));
  const created = await createInstalledRuntimeAcceptanceDescriptor({ runId: "hook-config", vaultPath, configDirectoryName, pluginId: "crash-plugin", reportDirectory: join(root, "reports"), candidateBundleSha256: "a".repeat(64) });
  const input = crashProfile("create_note").buildSubmitInput("hook-config");
  const command = { sequence: 1, capabilityToken: created.descriptor.capabilityToken, action: "run-crash-restoration-scenario" as const, scenario: "create_note/after_prepared" as const, expectedVaultId: "v", endpoint: "http://127.0.0.1:1234/mcp", submissionKey: "submission-hook-config", input };
  try {
    const before = await crashInventory(vaultPath, configDirectoryName);
    await parkInstalledCrashBoundary({ descriptor: created.descriptor, command, frame: { phase: "PREPARED", vaultId: "v", input }, before, configDirectoryName, park: async () => undefined });
    expect(await loadCrashBoundaryReport({ ...created.descriptor, vaultId: "v", endpoint: command.endpoint, submissionKey: command.submissionKey })).toMatchObject({ inventorySha256: crashDigest(before) });
    expect(before.map(entry => entry.path)).toEqual([".obsidian-backup", ".obsidian-backup/Public.md"]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("rejects private staging/trash byte residue after a terminal restart", async () => {
  const { crashPrivateResidue } = await import("../src/installed-runtime/crash-restoration-protocol.js");
  const root = await mkdtemp(join(tmpdir(), "installed-crash-residue-"));
  try {
    expect(await crashPrivateResidue(root)).toEqual({ stagingFiles: 0, trashFiles: 0 });
    await mkdir(join(root, ".llm-wiki", "staging", "private-id"), { recursive: true });
    await writeFile(join(root, ".llm-wiki", "staging", "private-id", "leftover"), "private bytes");
    await expect(crashPrivateResidue(root)).rejects.toThrow("residue");
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("cannot park an unprepared hook for a different operation even though the Vault bytes are unchanged", async () => {
  const { parkInstalledCrashBoundary, crashProfile } = await import("../src/installed-runtime/crash-restoration-protocol.js");
  const root = await mkdtemp(join(tmpdir(), "installed-crash-unprepared-binding-"));
  const vaultPath = join(root, "installed-runtime-vault-unprepared-binding");
  const pluginDirectory = join(vaultPath, ".obsidian", "plugins", "crash-plugin");
  await mkdir(pluginDirectory, { recursive: true }); await writeFile(join(pluginDirectory, "main.js"), "candidate");
  const created = await createInstalledRuntimeAcceptanceDescriptor({ runId: "unprepared", vaultPath, pluginId: "crash-plugin", reportDirectory: join(root, "reports"), candidateBundleSha256: "a".repeat(64) });
  await mkdir(created.descriptor.reportDirectory);
  const input = crashProfile("create_note").buildSubmitInput("unprepared");
  const command = { sequence: 1, capabilityToken: created.descriptor.capabilityToken, action: "run-crash-restoration-scenario" as const, scenario: "create_note/before_prepared" as const, expectedVaultId: "v", endpoint: "http://127.0.0.1:1234/mcp", submissionKey: "submission-unprepared", input };
  try {
    await expect(parkInstalledCrashBoundary({ descriptor: created.descriptor, command, frame: null, before: [], execution: { vaultId: "v", changeSetId: "foreign", input: crashProfile("create_note").buildSubmitInput("foreign") }, park: async () => undefined })).rejects.toThrow("operation");
    expect(await readdir(created.descriptor.reportDirectory)).toEqual([]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("re-enters every create rollback action and already-restored terminal seam in the real executor corpus", async () => {
  const { runMutationCorpusScenario } = await import("../src/corpus/crash-corpus-runner.js");
  const { createNoteCorpusProfile } = await import("../src/corpus/create-note-corpus.js");
  const profile = createNoteCorpusProfile();
  const root = await mkdtemp(join(tmpdir(), "installed-crash-rollback-executor-"));
  try {
    for (const name of ["after_rollback_mutation:0", "after_rollback_mutation:1", "after_rollback_mutation:2", "before_rolled_back", "after_rolled_back"]) {
      const point = { point: name, phase: "rollback" as const };
      const outcome = await runMutationCorpusScenario({ profile: { ...profile, expectedBoundary: (boundary) => boundary.point === "after_snapshot" ? profile.expectedBoundary(boundary) : ({ journalPhase: name === "after_rolled_back" ? "ROLLED_BACK" : "PREPARED", files: [{ path: profile.primaryPath, state: "absent" }] }) }, crashPoint: point, seed: `rollback-${name.replace(/[^a-z0-9]/gu, "-")}`, reportDir: root });
      expect(outcome.verdict, outcome.failures.join("; ")).toBe("pass");
      expect(outcome.proofState).toBe("intent_not_applied");
    }
  } finally { await rm(root, { recursive: true, force: true }); }
}, 120_000);

it("checks a persisted crash listener before deleting roots after a preflight failure", async () => {
  const root = await mkdtemp(join(tmpdir(), "installed-crash-preflight-stop-"));
  const candidateDirectory = join(root, "candidate");
  await mkdir(candidateDirectory);
  await writeFile(join(candidateDirectory, "manifest.json"), JSON.stringify({ id: "crash-plugin", version: "0.1.0", minAppVersion: "1.0.0" }));
  await writeFile(join(candidateDirectory, "main.js"), "candidate");
  const candidate = brandVerifiedCandidateBundle({
    bundleDirectory: candidateDirectory, identity: await inspectCandidateBundle(candidateDirectory),
    tag: "v0.1.0", repository: "test/crash", workflowRef: "test", attestationSource: "local-candidate",
  });
  const { createServer } = await import("node:net");
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  let vaultPath = "";
  let cleanedDescriptor = false;
  try {
    await expect(runInstalledCrashRestorationSlice({
      runId: "preflight-stop", workingDirectory: root, reportDirectory: join(root, "reports"), candidate,
      processControl: { start: async request => {
        vaultPath = request.vaultPath;
        await writeFile(join(vaultPath, ".obsidian", "plugins", "crash-plugin", "data.json"), JSON.stringify({ vaultId: "preflight-vault", port }));
        return { stop: async () => undefined };
      } },
      client: {}, profile: {}, probe: { probeRunning: async () => { throw new Error("Runtime preflight refused"); } },
      timeouts: { startupMs: 10, stopMs: 10, portClosedMs: 30 },
      prepareAcceptanceDriver: async request => {
        const created = await createInstalledRuntimeAcceptanceDescriptor({ ...request, runId: "preflight-stop", reportDirectory: join(root, "reports") });
        return { ...created, cleanup: async () => { cleanedDescriptor = true; } };
      }, record: () => undefined, assertion: () => undefined,
    } as InstalledCrashRestorationSliceOptions)).rejects.toBeInstanceOf(ObsidianProcessError);
    expect(cleanedDescriptor).toBe(false);
    expect(await readdir(vaultPath)).toContain(".obsidian");
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

it("rejects a crash descriptor for a foreign Vault, plugin, or installed entry point before startup", async () => {
  const root = await mkdtemp(join(tmpdir(), "installed-crash-binding-"));
  const candidateDirectory = join(root, "candidate");
  await mkdir(candidateDirectory);
  await writeFile(join(candidateDirectory, "manifest.json"), JSON.stringify({ id: "crash-plugin", version: "0.1.0", minAppVersion: "1.0.0" }));
  await writeFile(join(candidateDirectory, "main.js"), "candidate");
  const candidate = brandVerifiedCandidateBundle({
    bundleDirectory: candidateDirectory, identity: await inspectCandidateBundle(candidateDirectory),
    tag: "v0.1.0", repository: "test/crash", workflowRef: "test", attestationSource: "local-candidate",
  });
  let starts = 0;
  try {
    for (const changed of [
      { vaultPath: join(root, "foreign-vault") },
      { pluginId: "foreign-plugin" },
      { installedMainSha256: "f".repeat(64) },
    ]) {
      await expect(runInstalledCrashRestorationSlice({
        runId: "binding", workingDirectory: root, reportDirectory: join(root, "reports"), candidate,
        processControl: { start: async () => { starts += 1; throw new Error("Unexpected runtime startup"); } },
        client: {}, profile: {}, probe: {}, timeouts: { startupMs: 10, stopMs: 10, portClosedMs: 10 },
        prepareAcceptanceDriver: async (request) => {
          const created = await createInstalledRuntimeAcceptanceDescriptor({ ...request, runId: "binding", reportDirectory: join(root, "reports") });
          return { ...created, descriptor: { ...created.descriptor, ...changed }, cleanup: async () => undefined };
        },
        record: () => undefined, assertion: () => undefined,
      } as InstalledCrashRestorationSliceOptions)).rejects.toThrow("descriptor is not candidate/run bound");
    }
    expect(starts).toBe(0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("rejects an installed crash command targeting a remote endpoint even with the correct capability", async () => {
  const root = await mkdtemp(join(tmpdir(), "installed-crash-remote-"));
  const vaultPath = join(root, "installed-runtime-vault-remote");
  const pluginDirectory = join(vaultPath, ".obsidian", "plugins", "crash-plugin");
  await mkdir(pluginDirectory, { recursive: true });
  await writeFile(join(pluginDirectory, "main.js"), "candidate");
  const created = await createInstalledRuntimeAcceptanceDescriptor({
    runId: "remote", vaultPath, pluginId: "crash-plugin", reportDirectory: join(root, "reports"),
    candidateBundleSha256: "a".repeat(64),
  });
  let dispatched = 0;
  const activation = await activateInstalledRuntimeAcceptanceDriver({
    vaultPath, pluginId: "crash-plugin",
    executeCrashRestorationScenario: async () => { dispatched += 1; return { boundary: "after_prepared", journalPhase: "PREPARED" }; },
  });
  try {
    await writeFile(created.path, JSON.stringify({ ...created.descriptor, command: {
      sequence: 1, capabilityToken: created.descriptor.capabilityToken,
      action: "run-crash-restoration-scenario", scenario: "create_note/after_prepared",
      expectedVaultId: "remote-vault", endpoint: "https://example.com/mcp", submissionKey: "remote-key", input: {},
    } }));
    await new Promise(resolve => setTimeout(resolve, 150));
    expect(dispatched).toBe(0);
    await writeFile(created.path, JSON.stringify(created.descriptor));
    await requestInstalledCrashRestorationScenario({
      descriptorPath: created.path, descriptor: created.descriptor,
      expectedVaultId: "remote-vault", endpoint: new URL("http://127.0.0.1:32123/mcp"),
      input: { submissionKey: "local-key" }, crashPoint: "after_prepared",
    });
    await expect.poll(() => dispatched, { timeout: 1000 }).toBe(1);
  } finally { activation?.dispose(); await rm(root, { recursive: true, force: true }); }
});

it("continues inspecting an authenticated command after rejecting a malformed descriptor update", async () => {
  const root = await mkdtemp(join(tmpdir(), "installed-crash-invalid-update-"));
  const vaultPath = join(root, "installed-runtime-vault-invalid-update");
  const pluginDirectory = join(vaultPath, ".obsidian", "plugins", "crash-plugin");
  await mkdir(pluginDirectory, { recursive: true });
  await writeFile(join(pluginDirectory, "main.js"), "candidate");
  const created = await createInstalledRuntimeAcceptanceDescriptor({
    runId: "invalid-update", vaultPath, pluginId: "crash-plugin", reportDirectory: join(root, "reports"),
    candidateBundleSha256: "a".repeat(64),
  });
  let dispatched = 0;
  const activation = await activateInstalledRuntimeAcceptanceDriver({
    vaultPath, pluginId: "crash-plugin",
    executeCrashRestorationScenario: async () => { dispatched += 1; return { boundary: "after_prepared", journalPhase: "PREPARED" }; },
  });
  try {
    await writeFile(created.path, "{not-json");
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(dispatched).toBe(0);
    await writeFile(created.path, JSON.stringify(created.descriptor));
    await requestInstalledCrashRestorationScenario({
      descriptorPath: created.path, descriptor: created.descriptor,
      expectedVaultId: "update-vault", endpoint: new URL("http://127.0.0.1:32123/mcp"),
      input: { submissionKey: "update-key" }, crashPoint: "after_prepared",
    });
    await expect.poll(() => dispatched, { timeout: 1000 }).toBe(1);
  } finally { activation?.dispose(); await rm(root, { recursive: true, force: true }); }
});

it("does not publish a PREPARED marker merely because a private crash command was dispatched", async () => {
  const root = await mkdtemp(join(tmpdir(), "installed-crash-dispatch-"));
  const vaultPath = join(root, "installed-runtime-vault-crash-dispatch");
  const pluginDirectory = join(vaultPath, ".obsidian", "plugins", "crash-plugin");
  await mkdir(pluginDirectory, { recursive: true });
  await writeFile(join(pluginDirectory, "main.js"), "candidate");
  const reportDirectory = join(root, "reports");
  const created = await createInstalledRuntimeAcceptanceDescriptor({
    runId: "dispatch", vaultPath, pluginId: "crash-plugin", reportDirectory,
    candidateBundleSha256: "a".repeat(64),
  });
  let dispatched = false;
  const activation = await activateInstalledRuntimeAcceptanceDriver({
    vaultPath, pluginId: "crash-plugin",
    executeCrashRestorationScenario: async () => {
      dispatched = true;
      return { boundary: "after_prepared", journalPhase: "PREPARED" };
    },
  });
  try {
    await requestInstalledCrashRestorationScenario({
      descriptorPath: created.path, descriptor: created.descriptor,
      expectedVaultId: "dispatch-vault", endpoint: new URL("http://127.0.0.1:32123/mcp"),
      input: { submissionKey: "dispatch-key" }, crashPoint: "after_prepared",
    });
    await expect.poll(() => dispatched).toBe(true);
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(await readdir(reportDirectory)).toEqual([]);
  } finally { activation?.dispose(); await rm(root, { recursive: true, force: true }); }
});

it("does not leak a crash capability marker through a report-root symlink outside the generated workspace", async () => {
  const root = await mkdtemp(join(tmpdir(), "installed-crash-root-"));
  const outside = await mkdtemp(join(tmpdir(), "installed-crash-outside-"));
  const vaultPath = join(root, "installed-runtime-vault-root");
  const pluginDirectory = join(vaultPath, ".obsidian", "plugins", "crash-plugin");
  await mkdir(pluginDirectory, { recursive: true });
  await writeFile(join(pluginDirectory, "main.js"), "candidate");
  const reportDirectory = join(root, "reports");
  const created = await createInstalledRuntimeAcceptanceDescriptor({
    runId: "report-root", vaultPath, pluginId: "crash-plugin", reportDirectory,
    candidateBundleSha256: "a".repeat(64),
  });
  try {
    await rm(reportDirectory, { recursive: true, force: true });
    await symlink(outside, reportDirectory, "dir");
    await expect(writeCrashRestorationBoundaryReport({
      descriptor: created.descriptor, journalPhase: "PREPARED", frameSha256: "d".repeat(64), inventorySha256: "e".repeat(64),
      command: { sequence: 1, capabilityToken: created.descriptor.capabilityToken,
        action: "run-crash-restoration-scenario", scenario: "create_note/after_prepared",
        expectedVaultId: "root-vault", endpoint: "http://127.0.0.1:32123/mcp",
        submissionKey: "root-key", input: {} },
    })).rejects.toThrow("report root");
    expect(await readdir(outside)).toEqual([]);
  } finally { await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); }
});

it("preserves the first durable crash marker when publication is repeated", async () => {
  const root = await mkdtemp(join(tmpdir(), "installed-crash-one-shot-"));
  const vaultPath = join(root, "installed-runtime-vault-one-shot");
  const pluginDirectory = join(vaultPath, ".obsidian", "plugins", "crash-plugin");
  await mkdir(pluginDirectory, { recursive: true });
  await writeFile(join(pluginDirectory, "main.js"), "candidate");
  const created = await createInstalledRuntimeAcceptanceDescriptor({
    runId: "one-shot", vaultPath, pluginId: "crash-plugin", reportDirectory: join(root, "reports"),
    candidateBundleSha256: "a".repeat(64),
  });
  const command = { sequence: 1, capabilityToken: created.descriptor.capabilityToken,
    action: "run-crash-restoration-scenario" as const, scenario: "create_note/after_prepared" as const,
    expectedVaultId: "one-shot-vault", endpoint: "http://127.0.0.1:32123/mcp", submissionKey: "first-key", input: {} };
  try {
    await mkdir(created.descriptor.reportDirectory);
    await expect(writeCrashRestorationBoundaryReport({
      descriptor: created.descriptor, command: { ...command, capabilityToken: "f".repeat(64) }, journalPhase: "PREPARED", frameSha256: "d".repeat(64), inventorySha256: "e".repeat(64),
    })).rejects.toThrow("capability");
    expect(await readdir(created.descriptor.reportDirectory)).toEqual([]);
    await writeCrashRestorationBoundaryReport({ descriptor: created.descriptor, command, journalPhase: "PREPARED", frameSha256: "d".repeat(64), inventorySha256: "e".repeat(64) });
    await expect(writeCrashRestorationBoundaryReport({
      descriptor: created.descriptor, command: { ...command, sequence: 2 }, journalPhase: "PREPARED", frameSha256: "d".repeat(64), inventorySha256: "e".repeat(64),
    })).rejects.toMatchObject({ code: "EEXIST" });
    const retained = await loadCrashBoundaryReport({ ...created.descriptor,
      vaultId: command.expectedVaultId, endpoint: command.endpoint, submissionKey: command.submissionKey });
    expect(retained.submissionKey).toBe("first-key");
    expect(await readdir(created.descriptor.reportDirectory)).toEqual([crashRestorationBoundaryPath("", "after_prepared", "create_note", "first-key")]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("rejects a crash marker bound to a foreign endpoint or submission", async () => {
  const root = await mkdtemp(join(tmpdir(), "installed-crash-marker-"));
  const binding = {
    reportDirectory: root, runId: "marker-run", vaultId: "marker-vault",
    candidateBundleSha256: "a".repeat(64), installedMainSha256: "b".repeat(64),
    capabilityToken: "c".repeat(64), endpoint: "http://127.0.0.1:32123/mcp", submissionKey: "expected-key",
  };
  try {
    const report = {
      schemaVersion: 1, runId: binding.runId, vaultId: binding.vaultId,
      candidateBundleSha256: binding.candidateBundleSha256, installedMainSha256: binding.installedMainSha256,
      capabilityToken: binding.capabilityToken, scenario: "create_note/after_prepared",
      endpoint: binding.endpoint, submissionKey: binding.submissionKey,
      point: "after_prepared", journalPhase: "PREPARED", sequence: 1, frameSha256: "d".repeat(64), inventorySha256: "e".repeat(64),
    };
    for (const changed of [{ endpoint: "http://127.0.0.1:32124/mcp" }, { submissionKey: "foreign-key" }]) {
      await writeFile(crashRestorationBoundaryPath(root, "after_prepared", "create_note", binding.submissionKey), JSON.stringify({ ...report, ...changed }));
      await expect(loadCrashBoundaryReport(binding)).rejects.toThrow("not bound");
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("observes the latest checksummed binary crash journal without modifying its bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "installed-crash-journal-"));
  const path = join(root, "recovery-journal.bin");
  const handle = await open(path, "wx+");
  try {
    const journal = await openRecoveryJournal(handle, { slotCapacity: 4096 });
    await journal.write({ phase: "PREPARED", payload: { submissionKey: "prepared-key" } });
    await journal.write({ phase: "ROLLED_BACK", payload: { submissionKey: "prepared-key" } });
    const before = await handle.readFile();
    const observed = await readInstalledCrashJournal(path);
    expect(observed).toEqual({ sequence: 2, phase: "ROLLED_BACK", payload: { submissionKey: "prepared-key" } });
    const bytes = Buffer.alloc(before.length);
    await handle.read(bytes, 0, bytes.length, 0);
    expect(bytes).toEqual(before);
  } finally {
    await handle.close();
    await rm(root, { recursive: true, force: true });
  }
});

it("publishes a separate authenticated COMMITTED command and boundary without accepting it as PREPARED", async () => {
  const root = await mkdtemp(join(tmpdir(), "installed-crash-committed-"));
  const vaultPath = join(root, "installed-runtime-vault-committed");
  const pluginDirectory = join(vaultPath, ".obsidian", "plugins", "crash-plugin");
  await mkdir(pluginDirectory, { recursive: true });
  await writeFile(join(pluginDirectory, "main.js"), "candidate");
  const created = await createInstalledRuntimeAcceptanceDescriptor({
    runId: "committed", vaultPath, pluginId: "crash-plugin", reportDirectory: join(root, "reports"),
    candidateBundleSha256: "a".repeat(64),
  });
  try {
    await requestInstalledCrashRestorationScenario({ descriptorPath: created.path, descriptor: created.descriptor,
      expectedVaultId: "committed-vault", endpoint: new URL("http://127.0.0.1:32123/mcp"),
      input: { submissionKey: "committed-key" }, crashPoint: "after_committed" });
    const { readFile } = await import("node:fs/promises");
    const updated = JSON.parse(await readFile(created.path, "utf8"));
    expect(updated.command.scenario).toBe("create_note/after_committed");
    await mkdir(created.descriptor.reportDirectory);
    await writeCrashRestorationBoundaryReport({ descriptor: created.descriptor, command: updated.command, journalPhase: "COMMITTED", frameSha256: "d".repeat(64), inventorySha256: "e".repeat(64) });
    const binding = { ...created.descriptor, vaultId: "committed-vault", endpoint: updated.command.endpoint, submissionKey: "committed-key" };
    expect(await loadCrashBoundaryReport({ ...binding, crashPoint: "after_committed" })).toMatchObject({ point: "after_committed", journalPhase: "COMMITTED" });
    await expect(loadCrashBoundaryReport(binding)).rejects.toMatchObject({ code: "ENOENT" });
  } finally { await rm(root, { recursive: true, force: true }); }
});


it("rejects a private crash command against a dirty durable journal without arming execution", async () => {
  const root = await mkdtemp(join(tmpdir(), "installed-crash-dirty-command-"));
  const vaultPath = join(root, "installed-runtime-vault-dirty-command");
  const pluginDirectory = join(vaultPath, ".obsidian", "plugins", "crash-plugin");
  await mkdir(pluginDirectory, { recursive: true });
  await writeFile(join(pluginDirectory, "main.js"), "candidate");
  const created = await createInstalledRuntimeAcceptanceDescriptor({
    runId: "dirty-command", vaultPath, pluginId: "crash-plugin", reportDirectory: join(root, "reports"),
    candidateBundleSha256: "a".repeat(64),
  });
  await mkdir(join(vaultPath, ".llm-wiki"));
  const handle = await open(join(vaultPath, ".llm-wiki", "recovery-journal.bin"), "wx+");
  const journal = await openRecoveryJournal(handle, { slotCapacity: 4096 });
  await journal.write({ phase: "PREPARED", payload: { submissionKey: "another-submission" } });
  await handle.close();
  let armed = 0;
  const activation = await activateInstalledRuntimeAcceptanceDriver({
    vaultPath, pluginId: "crash-plugin",
    executeCrashRestorationScenario: async () => { armed += 1; return { boundary: "after_prepared", journalPhase: "PREPARED" }; },
  });
  try {
    await requestInstalledCrashRestorationScenario({ descriptorPath: created.path, descriptor: created.descriptor,
      expectedVaultId: "dirty-vault", endpoint: new URL("http://127.0.0.1:32123/mcp"),
      input: { submissionKey: "dirty-key" }, crashPoint: "after_prepared" });
    await new Promise(resolve => setTimeout(resolve, 150));
    expect(armed).toBe(0);
    expect(await readdir(created.descriptor.reportDirectory)).toEqual([]);
  } finally { activation?.dispose(); await rm(root, { recursive: true, force: true }); }
});


// Orchestration-only fixture. This is deliberately not installed-Obsidian evidence.
async function arrangeCrashOrchestration(root: string, replayId: string, crashPoint: import("../src/installed-runtime/crash-restoration-protocol.js").InstalledCrashPoint = "after_prepared", mutationKind: import("../src/installed-runtime/crash-restoration-protocol.js").InstalledCrashKind = "create_note", fault?: "missing_marker" | "wrong_marker" | "phase_disguise" | "partial_restore" | "early_listener" | "replay_mutation" | "dirty_stop", configDirectoryName = ".obsidian") {
  const { createServer } = await import("node:http");
  const { readFile } = await import("node:fs/promises");
  const { createHash } = await import("node:crypto");
  const { crashProfile, crashBoundaryPhase, crashInventory, crashDigest } = await import("../src/installed-runtime/crash-restoration-protocol.js");
  const candidateDirectory = join(root, "candidate");
  await mkdir(candidateDirectory);
  await writeFile(join(candidateDirectory, "manifest.json"), JSON.stringify({ id: "crash-plugin", version: "0.1.0", minAppVersion: "1.0.0" }));
  await writeFile(join(candidateDirectory, "main.js"), "orchestration-only candidate");
  const candidate = brandVerifiedCandidateBundle({ bundleDirectory: candidateDirectory, identity: await inspectCandidateBundle(candidateDirectory), tag: "v0.1.0", repository: "test/crash", workflowRef: "test", attestationSource: "local-candidate" });
  await mkdir(join(root, "reports"));
  let descriptorPath = "";
  let vaultPath = "";
  let input: any;
  let publishedSequence = 0;
  let terminal = false;
  let publish: Promise<void> = Promise.resolve();
  let stopped = true;
  const vault = { writeGate: "open", writeState: "writable" };
  const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
  const preview = (request = input) => {
    const kind = request.operations[0].kind;
    const operationId = request.operations[0].operationId;
    const fixture = crashProfile(mutationKind).files[0]!;
    const dirs = kind === "create_note" ? ["Corpus", "Corpus/Notes"] : [];
    return { requestedEffects: [{ operationId, kind, projectedOutcome: "changed" }], derivedEffects: dirs.map(path => ({ operationId: `derived/${operationId}/directory/${path}`, causedByOperationId: operationId, kind: "create_directory", projectedOutcome: "changed" })), paths: [...dirs.map(path => ({ path, preState: { kind: "absent" }, projectedFinalState: { kind: "directory" }, projectedOutcome: "changed" })), { path: fixture.path, preState: fixture.originalBytes === null ? { kind: "absent" } : { kind: "markdown", contentVersion: `sha256:${sha(fixture.originalBytes)}` }, projectedFinalState: { kind: "markdown", contentVersion: `sha256:${sha(fixture.committedBytes!)}` }, projectedOutcome: "changed" }] };
  };
  const terminalRecord = () => {
    const p = preview();
    const applied = crashPoint === "after_committed" || crashPoint === "before_prepared";
    return applied ? { state: "intent_applied", preview: p, requestedEffects: p.requestedEffects.map(({ projectedOutcome, ...rest }) => ({ ...rest, outcome: projectedOutcome })), derivedEffects: p.derivedEffects.map(({ projectedOutcome, ...rest }) => ({ ...rest, outcome: projectedOutcome })), paths: p.paths.map(({ path, projectedOutcome, projectedFinalState }) => ({ path, outcome: projectedOutcome, finalState: projectedFinalState })) } : { state: "intent_not_applied", preview: p };
  };
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", chunk => chunks.push(chunk));
    request.on("end", () => { void (async () => {
      if (chunks.length === 0) { response.writeHead(200).end(); return; }
      const message = JSON.parse(Buffer.concat(chunks).toString());
      if (message.method === "notifications/initialized") { response.writeHead(202).end(); return; }
      let result: unknown;
      if (message.method === "initialize") result = { protocolVersion: message.params.protocolVersion, capabilities: {}, serverInfo: { name: "orchestration-only", version: "0" } };
      else {
        const submitting = message.params.name === "vault_change_set_submit";
        const sentinel = submitting && message.params.arguments.submissionKey.startsWith("sentinel-");
        if (submitting && !sentinel && fault === "replay_mutation") await writeFile(join(vaultPath, "Notes", "Welcome.md"), "repeated execution damaged bytes");
        let changeSet: unknown;
        if (sentinel) {
          await writeFile(join(vaultPath, "Notes", "CrashSentinel.md"), "# Restore completed\n");
          changeSet = { changeSetId: "sentinel", state: "intent_applied", preview: { requestedEffects: [], derivedEffects: [], paths: [] }, requestedEffects: [], derivedEffects: [], paths: [] };
        } else changeSet = { changeSetId: submitting ? replayId : "bound-change-set", ...(terminal ? terminalRecord() : { state: "in_progress", preview: preview() }) };
        const structuredContent = submitting ? { outcome: "registered", changeSet, vault } : { lookup: "found", changeSet, vault };
        result = { isError: submitting && !sentinel && terminalRecord().state === "intent_not_applied", structuredContent, content: [{ type: "text", text: submitting ? serializeChangeSetSubmitCompatibilityText(parseChangeSetSubmitResult(structuredContent)) : serializeChangeSetStatusCompatibilityText(parseChangeSetStatusResult(structuredContent)) }] };
      }
      response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
    })().catch(error => { response.writeHead(500).end(String(error)); }); });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  const writeFrame = async (phase: "PREPARED" | "ROLLED_BACK" | "COMMITTED") => {
    await mkdir(join(vaultPath, ".llm-wiki"), { recursive: true });
    const path = join(vaultPath, ".llm-wiki", "recovery-journal.bin");
    const handle = await open(path, "r+").catch(() => open(path, "wx+"));
    const payload = { phase, vaultId: "orchestration-vault", changeSetId: "bound-change-set", input };
    try { await (await openRecoveryJournal(handle, { slotCapacity: 4096 })).write({ phase, payload }); }
    finally { await handle.close(); }
    return payload;
  };
  const setBytes = async (point: string) => {
    const fixture = crashProfile(mutationKind).files[0]!;
    if (mutationKind === "create_note") {
      await rm(join(vaultPath, "Corpus"), { recursive: true, force: true });
      const present = !["before_prepared", "after_prepared", "after_mutation:0", "after_mutation:1", "after_rollback_mutation:0", "after_rollback_mutation:1", "after_rollback_mutation:2", "after_rollback_verification", "after_rollback_evidence", "before_rolled_back", "after_rolled_back"].includes(point);
      if (present || ["after_mutation:1", "after_rollback_mutation:0"].includes(point)) await mkdir(join(vaultPath, "Corpus", "Notes"), { recursive: true });
      else if (["after_mutation:0", "after_rollback_mutation:1"].includes(point)) await mkdir(join(vaultPath, "Corpus"));
      if (present) await writeFile(join(vaultPath, fixture.path), fixture.committedBytes!);
    } else {
      const original = ["before_prepared", "after_prepared", "after_rollback_mutation:0", "after_rollback_verification", "after_rollback_evidence", "before_rolled_back", "after_rolled_back"].includes(point);
      await writeFile(join(vaultPath, fixture.path), original ? fixture.originalBytes! : fixture.committedBytes!);
    }
  };
  const publishBoundary = async (descriptor: any) => {
    const point = descriptor.command.scenario.split("/")[1];
    input = descriptor.command.input;
    mutationKind = descriptor.command.scenario.split("/")[0];
    if (descriptor.command.recovery !== undefined) crashPoint = point;
    await setBytes(point);
    const phase = crashBoundaryPhase(point);
    const frame = phase === null ? null : await writeFrame(phase);
    if (fault === "missing_marker") return;
    await writeCrashRestorationBoundaryReport({ descriptor, command: descriptor.command, journalPhase: phase, frameSha256: frame === null ? null : crashDigest(frame), inventorySha256: crashDigest(await crashInventory(vaultPath, configDirectoryName)) });
    const markerPath = crashRestorationBoundaryPath(descriptor.reportDirectory, point, mutationKind, descriptor.command.submissionKey);
    if (fault === "wrong_marker") { const marker = JSON.parse(await readFile(markerPath, "utf8")); await writeFile(markerPath, JSON.stringify({ ...marker, sequence: marker.sequence + 1 })); }
    if (fault === "phase_disguise") await writeFrame("COMMITTED");
  };
  const profile = { name: "orchestration", os: { platform: "linux", build: "test" }, versions: { obsidian: "test", electron: "test", node: "test" }, capabilities: [], profileRequirement: "dedicated_candidate_only" };
  const options = {
    runId: "orchestration", crashPoint, mutationKind, configDirectoryName, workingDirectory: root, reportDirectory: join(root, "reports"), candidate, profile,
    probe: { probeRunning: async () => ({ platform: "linux", osBuild: "test", obsidianVersion: "test", electronVersion: "test", nodeVersion: "test", capabilities: [] }) },
    processControl: { start: async (request: any) => {
      vaultPath = request.vaultPath; stopped = false;
      const descriptor = JSON.parse(await readFile(descriptorPath, "utf8"));
      await writeFile(join(vaultPath, configDirectoryName, "plugins", "crash-plugin", "data.json"), JSON.stringify({ vaultId: "orchestration-vault", port }));
      if (descriptor.command.recovery !== undefined) { publishedSequence = descriptor.command.sequence; await publishBoundary(descriptor); if (fault === "early_listener") await new Promise<void>(resolve => server.listen(port, "127.0.0.1", resolve)); }
      else {
        if (descriptor.command.action !== "idle") {
          terminal = true;
          await setBytes(crashPoint === "before_prepared" || crashPoint === "after_committed" ? "after_committed" : "after_rolled_back");
          await writeFrame(crashPoint === "before_prepared" || crashPoint === "after_committed" ? "COMMITTED" : "ROLLED_BACK");
          if (fault === "partial_restore") await writeFile(join(vaultPath, "Notes", "Welcome.md"), "only primary fixture restored");
        }
        await new Promise<void>(resolve => server.listen(port, "127.0.0.1", resolve));
      }
      return { pid: 123, stop: async () => { await publish; stopped = true; if (fault === "dirty_stop") throw new ObsidianProcessError("process still alive", "obsidian_stop_failed"); if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); } };
    } },
    client: { observeHealth: async () => ({ health: { readiness: { searchSnapshot: "ready" }, recovery: { state: "none" }, write: { gate: "open", state: "writable" } } }) },
    timeouts: { startupMs: 5_000, stopMs: 5_000, portClosedMs: 5_000 },
    prepareAcceptanceDriver: async (request: any) => { terminal = false; publishedSequence = 0; mutationKind = request.vaultPath.includes("edit_body_whole-") ? "edit_body_whole" : request.vaultPath.includes("edit_body-") ? "edit_body" : "create_note"; crashPoint = request.vaultPath.split(`-crash-${mutationKind}-`)[1].replaceAll("-", "_").replace(/after_(file_mutation|rollback_mutation|mutation)_(\d)/u, "after_$1:$2"); const created = await createInstalledRuntimeAcceptanceDescriptor({ ...request, runId: "orchestration", reportDirectory: join(root, "reports") }); descriptorPath = created.path; return { ...created, cleanup: async () => undefined }; }, record: () => undefined, assertion: () => undefined,
  } as InstalledCrashRestorationSliceOptions;
  const timer = setInterval(() => {
    if (stopped || terminal || descriptorPath === "") return;
    const inspectedPath = descriptorPath;
    void readFile(inspectedPath, "utf8").then(JSON.parse).then(descriptor => {
      if (inspectedPath !== descriptorPath || stopped || terminal) return;
      if (descriptor.command.action === "idle" || descriptor.command.recovery !== undefined || descriptor.command.sequence <= publishedSequence) return;
      publishedSequence = descriptor.command.sequence;
      publish = publishBoundary(descriptor);
    }).catch(() => undefined);
  }, 10);
  return { options, cleanup: async () => { clearInterval(timer); await publish.catch(() => undefined); if (server.listening) await new Promise<void>(resolve => server.close(() => resolve())); } };
}

it("inventories public config-like files and empty directories while excluding only the actual config directory", async () => {
  const { crashInventory } = await import("../src/installed-runtime/crash-restoration-protocol.js");
  const root = await mkdtemp(join(tmpdir(), "installed-crash-inventory-config-"));
  try {
    for (const directory of [".obsidian", ".candidate-config", ".llm-wiki", ".obsidian-backup", ".obsidian-empty", ".candidate-config-backup"]) {
      await mkdir(join(root, directory));
    }
    for (const directory of [".obsidian", ".candidate-config", ".llm-wiki", ".obsidian-backup"]) {
      await writeFile(join(root, directory, "Public.md"), "hello");
    }
    await writeFile(join(root, ".obsidian-file"), "hello");
    const defaultInventory = await crashInventory(root);
    expect(defaultInventory.map(entry => entry.path).sort()).toEqual([
      ".candidate-config", ".candidate-config-backup", ".candidate-config/Public.md",
      ".obsidian-backup", ".obsidian-backup/Public.md", ".obsidian-empty", ".obsidian-file",
    ].sort());
    const customInventory = await crashInventory(root, ".candidate-config");
    expect(customInventory.map(entry => entry.path).sort()).toEqual([
      ".candidate-config-backup", ".obsidian", ".obsidian/Public.md",
      ".obsidian-backup", ".obsidian-backup/Public.md", ".obsidian-empty", ".obsidian-file",
    ].sort());
    expect(customInventory).toContainEqual({ path: ".obsidian-file", kind: "file", bytes: 5, sha256: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824" });
    expect(customInventory).toContainEqual({ path: ".obsidian-empty", kind: "directory" });
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("uses the actual config directory at every runner inventory observation", async () => {
  const root = await mkdtemp(join(tmpdir(), "installed-crash-custom-config-"));
  const fixture = await arrangeCrashOrchestration(root, "bound-change-set", "after_rolled_back", "create_note", undefined, ".candidate-config");
  const processStart = fixture.options.processControl.start;
  let generation = 0;
  try {
    const outcome = await runInstalledCrashRestorationSlice({ ...fixture.options,
      processControl: { start: async request => {
        const handle = await processStart(request);
        await writeFile(join(request.vaultPath, ".candidate-config", "runtime-settings.json"), String(++generation));
        return handle;
      } },
    });
    const record = outcome.records[0];
    for (const inventory of [record.before, record.boundary, record.after]) {
      expect(inventory.some(entry => entry.path.startsWith(".candidate-config"))).toBe(false);
      expect(inventory.some(entry => entry.path === "Notes/Welcome.md")).toBe(true);
    }
    expect(record.processGenerations).toHaveLength(3);
    expect(record.wholeStateVerified).toBe(true);
  } finally { await fixture.cleanup(); await rm(root, { recursive: true, force: true }); }
});

it("rejects recovery damage to a public .obsidian-backup note at the runner boundary", async () => {
  const root = await mkdtemp(join(tmpdir(), "installed-crash-public-backup-"));
  const fixture = await arrangeCrashOrchestration(root, "bound-change-set");
  let generation = 0;
  const originalStart = fixture.options.processControl.start;
  const processControl = { start: async (request: Parameters<typeof originalStart>[0]) => {
    generation += 1;
    const note = join(request.vaultPath, ".obsidian-backup", "Public.md");
    if (generation === 1) {
      await mkdir(join(request.vaultPath, ".obsidian-backup"));
      await writeFile(note, "public original bytes");
    }
    const handle = await originalStart(request);
    if (generation === 2) await writeFile(note, "WRONG: public bytes lost during recovery");
    return handle;
  } };
  try {
    await expect(runInstalledCrashRestorationSlice({ ...fixture.options, processControl })).rejects.toThrow("whole-state inventory mismatch");
  } finally { await fixture.cleanup(); await rm(root, { recursive: true, force: true }); }
});

it("fails closed on missing trigger, wrong marker, disguised phase, early listener, partial restore or replay mutation", async () => {
  for (const fault of ["missing_marker", "wrong_marker", "phase_disguise", "early_listener", "partial_restore", "replay_mutation", "dirty_stop"] as const) {
    const root = await mkdtemp(join(tmpdir(), "installed-crash-adversarial-"));
    const fixture = await arrangeCrashOrchestration(root, "bound-change-set", fault === "early_listener" ? "before_rolled_back" : "after_prepared", "create_note", fault);
    try { await expect(runInstalledCrashRestorationSlice({ ...fixture.options, timeouts: { startupMs: 100, stopMs: 100, portClosedMs: 100 }, boundaryTimeoutMs: 100 })).rejects.toThrow(); }
    finally { await fixture.cleanup(); await rm(root, { recursive: true, force: true }); }
  }
}, 30_000);

it("reports missing local recovery authority as blocked before submitting a sentinel", async () => {
  const root = await mkdtemp(join(tmpdir(), "installed-crash-local-authority-"));
  const fixture = await arrangeCrashOrchestration(root, "bound-change-set");
  try {
    await expect(runInstalledCrashRestorationSlice({ ...fixture.options, client: { observeHealth: async () => ({ health: { readiness: { searchSnapshot: "ready" }, recovery: { state: "none" }, write: { gate: "open", state: "paused" } } }) } as never })).rejects.toThrow("requires local authority");
  } finally { await fixture.cleanup(); await rm(root, { recursive: true, force: true }); }
});

it("orchestrates all independently bound apply/rollback points including whole-body and repeated recovery crashes", async () => {
  const { installedCrashScenarios, crashScenarioParts } = await import("../src/installed-runtime/crash-restoration-protocol.js");
  for (const scenario of installedCrashScenarios) {
    const root = await mkdtemp(join(tmpdir(), "installed-crash-complete-orchestration-"));
    const { kind, point } = crashScenarioParts(scenario);
    const fixture = await arrangeCrashOrchestration(root, "bound-change-set", point, kind);
    try {
      const outcome = await runInstalledCrashRestorationSlice(fixture.options);
      expect(outcome.records).toMatchObject([{ mutationKind: kind, crashPoint: point, cleanupSucceeded: true, wholeStateVerified: true, sentinelAppliedAfterRestore: true }]);
      expect(outcome.records[0]!.processGenerations).toHaveLength(point.includes("rollback") || point.includes("rolled_back") ? 3 : 2);
    } finally { await fixture.cleanup(); await rm(root, { recursive: true, force: true }); }
  }
}, 120_000);

it("rejects a terminal replay with a foreign Change Set identity at the public run boundary", async () => {
  const root = await mkdtemp(join(tmpdir(), "installed-crash-replay-identity-"));
  const fixture = await arrangeCrashOrchestration(root, "foreign-change-set");
  try {
    await expect(runInstalledCrashRestorationSlice(fixture.options)).rejects.toThrow("replay the retained terminal record");
  } finally { await fixture.cleanup(); await rm(root, { recursive: true, force: true }); }
});


it("orchestrates COMMITTED process stop, restart and retained replay without promoting full crash acceptance", async () => {
  const root = await mkdtemp(join(tmpdir(), "installed-crash-committed-orchestration-"));
  const fixture = await arrangeCrashOrchestration(root, "bound-change-set", "after_committed");
  try {
    const outcome = await runInstalledCrashRestorationSlice(fixture.options);
    expect(outcome.scope).toBe("single-after-committed-installed-replay-slice");
    expect(outcome.records).toMatchObject([{ crashPoint: "after_committed", preparedJournalPhase: "COMMITTED",
      journalPhase: "COMMITTED", proofState: "intent_applied", originalFileAbsentAfterRecovery: false,
      committedFileBytesPreservedAfterRecovery: true, processStoppedBeforeRestart: true, cleanupSucceeded: true }]);
  } finally { await fixture.cleanup(); await rm(root, { recursive: true, force: true }); }
});


it("keeps all wired create/exact/whole installed crash boundaries partial at the authoritative corpus run boundary", async () => {
  const root = await mkdtemp(join(tmpdir(), "installed-crash-partial-orchestration-"));
  const fixture = await arrangeCrashOrchestration(root, "bound-change-set");
  const { createAuthoritativeInstalledRuntimeRunners } = await import("../src/installed-runtime/smoke-command.js");
  const records: unknown[] = [];
  try {
    await expect(createAuthoritativeInstalledRuntimeRunners().runCrashRestorationRetainedAuthorityCorpus({
      installed: fixture.options, workingDirectory: root,
      record: (_kind, name, detail) => { if (name.startsWith("installed-crash-")) records.push(detail); },
      assertion: () => undefined,
    })).rejects.toThrow("partial");
    expect(records).toHaveLength(46);
    expect(records).toEqual(expect.arrayContaining([
      expect.objectContaining({ scope: "single-after-prepared-installed-rollback-slice" }),
      expect.objectContaining({ scope: "single-after-committed-installed-replay-slice" }),
      expect.objectContaining({ records: [expect.objectContaining({ mutationKind: "edit_body_whole", crashPoint: "before_rolled_back" })] }),
    ]));
  } finally { await fixture.cleanup(); await rm(root, { recursive: true, force: true }); }
});


it("orchestrates edit_body PREPARED with exact original bytes and full retained status replay", async () => {
  const root = await mkdtemp(join(tmpdir(), "installed-crash-edit-prepared-"));
  const fixture = await arrangeCrashOrchestration(root, "bound-change-set", "after_prepared", "edit_body");
  try {
    const outcome = await runInstalledCrashRestorationSlice(fixture.options);
    expect(outcome.records).toMatchObject([{ mutationKind: "edit_body", crashPoint: "after_prepared",
      proofState: "intent_not_applied", originalFileAbsentAfterRecovery: false, originalFileBytesPreservedAfterRecovery: true }]);
  } finally { await fixture.cleanup(); await rm(root, { recursive: true, force: true }); }
});


it("orchestrates edit_body COMMITTED with exact intended bytes and full retained status replay", async () => {
  const root = await mkdtemp(join(tmpdir(), "installed-crash-edit-committed-"));
  const fixture = await arrangeCrashOrchestration(root, "bound-change-set", "after_committed", "edit_body");
  try {
    const outcome = await runInstalledCrashRestorationSlice(fixture.options);
    expect(outcome.records).toMatchObject([{ mutationKind: "edit_body", crashPoint: "after_committed",
      proofState: "intent_applied", journalPhase: "COMMITTED", originalFileAbsentAfterRecovery: false,
      committedFileBytesPreservedAfterRecovery: true }]);
  } finally { await fixture.cleanup(); await rm(root, { recursive: true, force: true }); }
});
