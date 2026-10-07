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

it("admits every distinct installed create/exact/whole/frontmatter/multi crash boundary but rejects unregistered execution programs", async () => {
  const { installedCrashScenarios } = await import("../src/installed-runtime/crash-restoration-protocol.js");
  const points = ["before_prepared", "after_prepared", "after_file_mutation:0", "after_raw_verification", "during_success_barrier", "after_snapshot", "before_committed", "after_committed", "before_rollback", "after_rollback_mutation:0", "after_rollback_verification", "after_rollback_evidence", "before_rolled_back", "after_rolled_back"];
  for (const kind of ["create_note", "edit_body", "edit_body_whole", "edit_frontmatter", "edit_multi_markdown", "edit_multi_frontmatter"]) {
    const expected = [...points, ...(kind === "create_note" ? ["after_mutation:0", "after_mutation:1", "after_rollback_mutation:1", "after_rollback_mutation:2"] : kind.startsWith("edit_multi_") ? ["after_file_mutation:1", "after_rollback_mutation:1"] : [])];
    expect(installedCrashScenarios.filter(scenario => scenario.startsWith(`${kind}/`)).map(scenario => scenario.slice(kind.length + 1)).sort()).toEqual(expected.sort());
    for (const point of expected) {
      expect(parseCrashRestorationCommand({ sequence: 1, capabilityToken: "a".repeat(64), action: "run-crash-restoration-scenario", scenario: `${kind}/${point}`, expectedVaultId: "v", endpoint: "http://127.0.0.1:32123/mcp", submissionKey: "submission-test", input: {} })).not.toBeNull();
    }
  }
  for (const scenario of ["create_note/after_file_mutation:1", "edit_frontmatter/after_rollback_mutation:1", "edit_multi_markdown/after_rollback_mutation:2", "edit_multi_frontmatter/after_file_mutation:2", "create_note/after_mutation:2", "edit_body/after_mutation:0", "edit_body_whole/eval", "eval/after_prepared", "create_note/../baseline"]) {
    expect(parseCrashRestorationCommand({ sequence: 1, capabilityToken: "a".repeat(64), action: "run-crash-restoration-scenario", scenario, expectedVaultId: "v", endpoint: "http://127.0.0.1:32123/mcp", submissionKey: "submission-test", input: {} })).toBeNull();
  }
});

it("admits only reachable copy/move binary and derived-directory crash boundaries", async () => {
  const { installedCrashScenarios } = await import("../src/installed-runtime/crash-restoration-protocol.js");
  const common = ["before_prepared", "after_prepared", "after_mutation:0", "after_mutation:1", "after_mutation:2", "after_raw_verification", "during_semantic_evidence", "after_semantic_evidence", "after_snapshot", "before_committed", "after_committed", "before_rollback", "after_rollback_mutation:0", "after_rollback_mutation:1", "after_rollback_mutation:2", "after_rollback_verification", "after_rollback_evidence", "before_rolled_back", "after_rolled_back"];
  for (const kind of ["copy_attachment", "move_attachment"]) {
    const points = [...common, ...(kind === "copy_attachment" ? ["after_rollback_mutation:3"] : [])];
    expect(installedCrashScenarios.filter(scenario => scenario.startsWith(`${kind}/`)).map(scenario => scenario.slice(kind.length + 1)).sort()).toEqual(points.sort());
    for (const point of ["after_file_mutation:0", "during_success_barrier", "after_mutation:3", ...(kind === "move_attachment" ? ["after_rollback_mutation:3"] : [])]) {
      expect(parseCrashRestorationCommand({ sequence: 1, capabilityToken: "a".repeat(64), action: "run-crash-restoration-scenario", scenario: `${kind}/${point}`, expectedVaultId: "v", endpoint: "http://127.0.0.1:32123/mcp", submissionKey: "submission-test", input: {} })).toBeNull();
    }
  }
});

it("describes fixed binary source/destination fixtures without Markdown Content Versions", async () => {
  const { crashProfile, validateInstalledCrashFixture } = await import("../src/installed-runtime/crash-restoration-protocol.js");
  const cases = [
    ["copy_attachment", "Copy", "0328c64313d6d6f362d5ed1c3217c3c1d17472b1f63619351cf0a1061cb1597a"],
    ["move_attachment", "Move", "bc787415a301ccb4a41bca4e691c49599ce98bc5cce743ee975845e15821626e"],
  ] as const;
  for (const [kind, name, hash] of cases) {
    const profile = crashProfile(kind);
    expect(profile.files.map(file => ({ path: file.path, kind: file.kind, before: file.originalBytes?.length ?? null, after: file.committedBytes?.length ?? null }))).toEqual([
      { path: `Corpus/Attachments/${name}-source.bin`, kind: "attachment", before: 11, after: kind === "copy_attachment" ? 11 : null },
      { path: `Corpus/Attachments/${name}-target/Nested/${name}-destination.bin`, kind: "attachment", before: null, after: 11 },
    ]);
    const input = profile.buildSubmitInput("binary-seed") as any;
    const command = { sequence: 1, capabilityToken: "a".repeat(64), action: "run-crash-restoration-scenario" as const, scenario: `${kind}/after_prepared` as const, expectedVaultId: "v", endpoint: "http://127.0.0.1:1234/mcp", submissionKey: "submission-binary-seed", input };
    expect(() => validateInstalledCrashFixture(command)).not.toThrow();
    expect(input.operations[0].expectedSha256).toBe(hash);
    for (const change of [{ expectedSha256: `sha256:${input.operations[0].expectedSha256}` }, { destinationPath: "anywhere.bin" }]) {
      expect(() => validateInstalledCrashFixture({ ...command, input: { ...input, operations: [{ ...input.operations[0], ...change }] } })).toThrow("fixed mutation");
    }
  }
});

it("uses two typed Frontmatter operations with independent literal byte expectations, including BOM and untouched representation", async () => {
  const { crashProfile } = await import("../src/installed-runtime/crash-restoration-protocol.js");
  const profile = crashProfile("edit_multi_frontmatter");
  expect(profile.buildSubmitInput("two-frontmatters").operations.map(operation => operation.kind)).toEqual(["edit_frontmatter", "edit_frontmatter"]);
  const expected = "---\r\ntitle: \"Mi Nota\"\r\nstatus: \"published\"\r\n\"reviewer\": \"你好\"\r\n---\r\n\r\n# Cuerpo\r\n\r\nTexto intacto con 你好 y 🚀\r\n";
  expect(Buffer.from(crashProfile("edit_frontmatter").files[0]!.committedBytes!)).toEqual(Buffer.from(expected));
  expect(Buffer.from(profile.files[0]!.committedBytes!)).toEqual(Buffer.from(expected));
  expect(Buffer.from(profile.files[1]!.committedBytes!)).toEqual(Buffer.from(`﻿${expected}`));
  expect(Buffer.from(profile.files[1]!.originalBytes!)).toEqual(Buffer.from("﻿---\r\ntitle: \"Mi Nota\"\r\nstatus: draft\r\ncount: 1\r\n---\r\n\r\n# Cuerpo\r\n\r\nTexto intacto con 你好 y 🚀\r\n"));
});

it("rejects new-family boundary evidence reused across candidate, run, Vault, kind, installed bytes, capability or seed", async () => {
  const root = await mkdtemp(join(tmpdir(), "installed-multi-marker-binding-"));
  const binding = { reportDirectory: root, runId: "multi-run", vaultId: "multi-vault", candidateBundleSha256: "a".repeat(64), installedMainSha256: "b".repeat(64), capabilityToken: "c".repeat(64), endpoint: "http://127.0.0.1:32123/mcp", submissionKey: "submission-multi-seed", mutationKind: "edit_multi_frontmatter" as const, crashPoint: "after_file_mutation:1" as const };
  const path = crashRestorationBoundaryPath(root, binding.crashPoint, binding.mutationKind, binding.submissionKey);
  const report = { ...binding, schemaVersion: 1, scenario: "edit_multi_frontmatter/after_file_mutation:1", sequence: 1, point: binding.crashPoint, journalPhase: "PREPARED", frameSha256: "d".repeat(64), inventorySha256: "e".repeat(64) };
  const { reportDirectory, mutationKind, crashPoint, ...privateReport } = report;
  try {
    for (const changed of [{ runId: "other-run" }, { vaultId: "other-vault" }, { candidateBundleSha256: "f".repeat(64) }, { installedMainSha256: "f".repeat(64) }, { capabilityToken: "f".repeat(64) }, { submissionKey: "submission-other-seed" }, { scenario: "edit_multi_markdown/after_file_mutation:1" }]) {
      await writeFile(path, JSON.stringify({ ...privateReport, ...changed }));
      await expect(loadCrashBoundaryReport(binding)).rejects.toThrow("not bound");
    }
    await rm(path);
    await expect(loadCrashBoundaryReport(binding)).rejects.toMatchObject({ code: "ENOENT" });
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("never arms arbitrary multi-operation input, even with the generated capability and a matching journal hash", async () => {
  const { crashProfile, crashDigest, validateInstalledCrashRecovery, validateInstalledCrashFixture } = await import("../src/installed-runtime/crash-restoration-protocol.js");
  for (const kind of ["edit_frontmatter", "edit_multi_markdown", "edit_multi_frontmatter"] as const) {
    const input = crashProfile(kind).buildSubmitInput("fixed");
    const command = { sequence: 1, capabilityToken: "a".repeat(64), action: "run-crash-restoration-scenario" as const, scenario: `${kind}/after_prepared` as const, expectedVaultId: "v", endpoint: "http://127.0.0.1:1234/mcp", submissionKey: "submission-fixed", input };
    expect(() => validateInstalledCrashFixture(command)).not.toThrow();
    const operations = input.operations as Record<string, unknown>[];
    for (const changed of [{ ...input, operations: operations.slice(0, 0) }, { ...input, operations: operations.map((operation, index) => index === operations.length - 1 ? { ...operation, path: "Notes/Arbitrary.md" } : operation) }, crashProfile(kind).buildSubmitInput("other-seed")]) {
      const frame = { phase: "PREPARED", vaultId: "v", changeSetId: "id", input: changed };
      await expect(async () => validateInstalledCrashRecovery({ ...command, scenario: `${kind}/after_rollback_mutation:0`, input: changed, recovery: { changeSetId: "id", frameSha256: crashDigest(frame) } }, frame, { vaultId: "v", port: 1234 })).rejects.toThrow("fixed mutation program");
    }
  }
});

it("rejects truncated/corrupt binaries, source loss, leftover targets and extra copies in complete attachment inventories", async () => {
  const { verifyCrashInventory } = await import("../src/installed-runtime/crash-restoration-protocol.js");
  const source = { path: "Corpus/Attachments/Copy-source.bin", kind: "file" as const, bytes: 11, sha256: "0328c64313d6d6f362d5ed1c3217c3c1d17472b1f63619351cf0a1061cb1597a" };
  const before = [{ path: "Corpus", kind: "directory" as const }, { path: "Corpus/Attachments", kind: "directory" as const }, source];
  const target = { ...source, path: "Corpus/Attachments/Copy-target/Nested/Copy-destination.bin" };
  const dirs = [{ path: "Corpus/Attachments/Copy-target", kind: "directory" as const }, { path: "Corpus/Attachments/Copy-target/Nested", kind: "directory" as const }];
  const after = [...before, ...dirs, target];
  expect(() => verifyCrashInventory(before, after, "copy_attachment", "committed")).not.toThrow();
  for (const broken of [
    [...before, ...dirs, { ...target, bytes: 10 }],
    [...before, ...dirs, { ...target, sha256: "a".repeat(64) }],
    [...before.filter(entry => entry !== source), ...dirs, target],
    [...after, { ...target, path: "Extra-copy.bin" }],
    [...before, ...dirs, { ...target, sha256: `sha256:${target.sha256}` }],
  ]) expect(() => verifyCrashInventory(before, broken, "copy_attachment", "committed")).toThrow("whole-state");
  for (const partial of [[...before, target], [...before, dirs[0]!], [...before, { ...source, path: "Extra-copy.bin" }]]) {
    expect(() => verifyCrashInventory(before, partial, "copy_attachment", "original")).toThrow("whole-state");
  }
  const moveSource = { ...source, path: "Corpus/Attachments/Move-source.bin", sha256: "bc787415a301ccb4a41bca4e691c49599ce98bc5cce743ee975845e15821626e" };
  const moveBefore = [...before.filter(entry => entry !== source), moveSource];
  const moveAfter = [...moveBefore.filter(entry => entry !== moveSource), ...dirs.map(entry => ({ ...entry, path: entry.path.replaceAll("Copy", "Move") })), { ...moveSource, path: target.path.replaceAll("Copy", "Move") }];
  expect(() => verifyCrashInventory(moveBefore, moveAfter, "move_attachment", "committed")).not.toThrow();
  expect(() => verifyCrashInventory(moveBefore, [...moveAfter, moveSource], "move_attachment", "committed")).toThrow("whole-state");
  expect(() => verifyCrashInventory(moveBefore, moveAfter, "move_attachment", "original")).toThrow("whole-state");
});

it("requires bare attachment SHA-256 and both source/destination states in full public status and replay proof", async () => {
  const { verifyCrashPublicProof } = await import("../src/installed-runtime/crash-restoration-protocol.js");
  const hash = "0328c64313d6d6f362d5ed1c3217c3c1d17472b1f63619351cf0a1061cb1597a";
  const operationId = "copy-attachment-0-proof";
  const directories = ["Corpus/Attachments/Copy-target", "Corpus/Attachments/Copy-target/Nested"];
  const preview = {
    requestedEffects: [{ operationId, kind: "copy_attachment", projectedOutcome: "changed" }],
    derivedEffects: directories.map(path => ({ operationId: `derived/${operationId}/directory/${path}`, causedByOperationId: operationId, kind: "create_directory", projectedOutcome: "changed" })),
    paths: [
      { path: "Corpus/Attachments/Copy-source.bin", preState: { kind: "attachment", sha256: hash }, projectedFinalState: { kind: "attachment", sha256: hash }, projectedOutcome: "unchanged" },
      ...directories.map(path => ({ path, preState: { kind: "absent" }, projectedFinalState: { kind: "directory" }, projectedOutcome: "changed" })),
      { path: "Corpus/Attachments/Copy-target/Nested/Copy-destination.bin", preState: { kind: "absent" }, projectedFinalState: { kind: "attachment", sha256: hash }, projectedOutcome: "changed" },
    ],
  };
  const before = { changeSetId: "id", state: "in_progress", preview };
  const terminal = { changeSetId: "id", state: "intent_applied", preview,
    requestedEffects: [{ operationId, kind: "copy_attachment", outcome: "changed" }],
    derivedEffects: preview.derivedEffects.map(({ projectedOutcome, ...effect }) => ({ ...effect, outcome: projectedOutcome })),
    paths: preview.paths.map(({ path, projectedFinalState, projectedOutcome }) => ({ path, finalState: projectedFinalState, outcome: projectedOutcome })),
  };
  expect(() => verifyCrashPublicProof(terminal, before, "copy_attachment", "intent_applied", { operations: [{ operationId }] })).not.toThrow();
  const wrongHash = structuredClone(preview);
  (wrongHash.paths[0]!.preState as any).sha256 = `sha256:${hash}`;
  for (const invalid of [wrongHash, { ...preview, paths: preview.paths.slice(1) }, { ...preview, derivedEffects: [] }]) {
    expect(() => verifyCrashPublicProof({ ...terminal, preview: invalid }, { ...before, preview: invalid }, "copy_attachment", "intent_applied")).toThrow("proof");
  }
  expect(() => verifyCrashPublicProof({ ...terminal, paths: terminal.paths.slice(1) }, before, "copy_attachment", "intent_applied")).toThrow("proof");
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

it("observes both files at partial apply and reverse rollback, and refuses a missing restore, partial commit or untouched-byte damage before publishing", async () => {
  const { parkInstalledCrashBoundary, crashProfile, crashInventory, crashDigest } = await import("../src/installed-runtime/crash-restoration-protocol.js");
  for (const kind of ["edit_multi_markdown", "edit_multi_frontmatter"] as const) {
    const root = await mkdtemp(join(tmpdir(), "installed-multi-producer-"));
    const vaultPath = join(root, "installed-runtime-vault-multi-producer");
    const pluginDirectory = join(vaultPath, ".obsidian", "plugins", "crash-plugin");
    await mkdir(pluginDirectory, { recursive: true }); await writeFile(join(pluginDirectory, "main.js"), "candidate");
    const created = await createInstalledRuntimeAcceptanceDescriptor({ runId: "multi-producer", vaultPath, pluginId: "crash-plugin", reportDirectory: join(root, "reports"), candidateBundleSha256: "a".repeat(64) });
    await mkdir(created.descriptor.reportDirectory);
    const profile = crashProfile(kind);
    const input = profile.buildSubmitInput("multi-producer");
    for (const file of profile.files) { await mkdir(join(vaultPath, file.path, ".."), { recursive: true }); await writeFile(join(vaultPath, file.path), file.originalBytes!); }
    await mkdir(join(vaultPath, ".obsidian-empty"));
    const before = await crashInventory(vaultPath);
    const [first, second] = profile.files;
    const set = async (a: Uint8Array, b: Uint8Array) => { await writeFile(join(vaultPath, first!.path), a); await writeFile(join(vaultPath, second!.path), b); };
    try {
      for (const point of ["after_file_mutation:0", "after_rollback_mutation:0"] as const) {
        const command = { sequence: 1, capabilityToken: created.descriptor.capabilityToken, action: "run-crash-restoration-scenario" as const, scenario: `${kind}/${point}` as const, expectedVaultId: "v", endpoint: "http://127.0.0.1:1234/mcp", submissionKey: "submission-multi-producer", input };
        const frame = { phase: "PREPARED", vaultId: "v", input };
        await set(first!.committedBytes!, second!.originalBytes!);
        await parkInstalledCrashBoundary({ descriptor: created.descriptor, command, frame, before, park: async () => undefined });
        expect(await loadCrashBoundaryReport({ ...created.descriptor, vaultId: "v", endpoint: command.endpoint, submissionKey: command.submissionKey, mutationKind: kind, crashPoint: point })).toMatchObject({ inventorySha256: crashDigest(await crashInventory(vaultPath)) });
      }
      for (const [point, phase, a, b] of [
        ["after_rolled_back", "ROLLED_BACK", first!.originalBytes!, second!.committedBytes!],
        ["after_committed", "COMMITTED", first!.committedBytes!, second!.originalBytes!],
        ["after_committed", "COMMITTED", first!.committedBytes!, Buffer.concat([Buffer.from(second!.committedBytes!), Buffer.from("WRONG BODY")])],
      ] as const) {
        const command = { sequence: 1, capabilityToken: created.descriptor.capabilityToken, action: "run-crash-restoration-scenario" as const, scenario: `${kind}/${point}` as const, expectedVaultId: "v", endpoint: "http://127.0.0.1:1234/mcp", submissionKey: "submission-multi-producer", input };
        await set(a, b);
        await expect(parkInstalledCrashBoundary({ descriptor: created.descriptor, command, frame: { phase, vaultId: "v", input }, before, park: async () => undefined })).rejects.toThrow("whole-state");
        await expect(loadCrashBoundaryReport({ ...created.descriptor, vaultId: "v", endpoint: command.endpoint, submissionKey: command.submissionKey, mutationKind: kind, crashPoint: point })).rejects.toMatchObject({ code: "ENOENT" });
      }
    } finally { await rm(root, { recursive: true, force: true }); }
  }
});

it("reconstructs every interrupted preimage and gives each fixed family a distinct marker path", async () => {
  const { crashOriginalInventory, crashProfile, crashInventory, installedCrashScenarios, crashScenarioParts } = await import("../src/installed-runtime/crash-restoration-protocol.js");
  const root = await mkdtemp(join(tmpdir(), "installed-multi-original-"));
  try {
    const profile = crashProfile("edit_multi_frontmatter");
    for (const file of profile.files) { await mkdir(join(root, file.path, ".."), { recursive: true }); await writeFile(join(root, file.path), file.originalBytes!); }
    const before = await crashInventory(root);
    for (const file of profile.files) await writeFile(join(root, file.path), file.committedBytes!);
    expect(crashOriginalInventory(await crashInventory(root), "edit_multi_frontmatter")).toEqual(before);
    const paths = installedCrashScenarios.map(scenario => { const { kind, point } = crashScenarioParts(scenario); return crashRestorationBoundaryPath(root, point, kind, "same-submission"); });
    expect(new Set(paths).size).toBe(131);
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


// Test adapter only: a real Node process + production Bridge, never Obsidian evidence.
async function arrangeNodeCrashWire(root: string, mutationKind: import("../src/installed-runtime/crash-restoration-protocol.js").InstalledCrashKind, crashPoint: import("../src/installed-runtime/crash-restoration-protocol.js").InstalledCrashPoint, observerFault?: "halfwrite-event" | "replay-second-rewrite") {
  const { spawn } = await import("node:child_process");
  const { readFile } = await import("node:fs/promises");
  const { createServer } = await import("node:net");
  const { buildOwningProcessBundle } = await import("../src/corpus/crash-corpus-runner.js");
  const { createLoopbackMcpClient } = await import("../src/installed-runtime/loopback-client.js");
  const { waitForCondition } = await import("../src/installed-runtime/obsidian-process.js");
  const bundle = await buildOwningProcessBundle();
  const candidateDirectory = join(root, "candidate");
  await mkdir(candidateDirectory);
  await writeFile(join(candidateDirectory, "manifest.json"), JSON.stringify({ id: "crash-plugin", version: "0.1.0", minAppVersion: "1.0.0" }));
  await writeFile(join(candidateDirectory, "main.js"), "Node wire test candidate; NOT Obsidian");
  const candidate = brandVerifiedCandidateBundle({ bundleDirectory: candidateDirectory, identity: await inspectCandidateBundle(candidateDirectory), tag: "v0.1.0", repository: "test/crash", workflowRef: "test", attestationSource: "local-candidate" });
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>(resolve => server.close(() => resolve()));
  let generation = 0;
  const eventLogs: string[] = [];
  const processes: import("node:child_process").ChildProcess[] = [];
  const profile = { name: "node-wire-test-only", os: { platform: "linux", build: "test" }, versions: { obsidian: "NOT-INSTALLED", electron: "NOT-INSTALLED", node: process.versions.node }, capabilities: [], profileRequirement: "dedicated_candidate_only" };
  const options = {
    runId: "node-wire", mutationKind, crashPoint, workingDirectory: root, reportDirectory: join(root, "reports"), candidate, profile,
    probe: { probeRunning: async () => ({ platform: "linux", osBuild: "test", obsidianVersion: "NOT-INSTALLED", electronVersion: "NOT-INSTALLED", nodeVersion: process.versions.node, capabilities: [] }) },
    processControl: { start: async (request: { vaultPath: string }) => {
      const control = join(root, `control-${++generation}`);
      const child = spawn(process.execPath, [bundle], { env: { ...process.env, CORPUS_ROOT: request.vaultPath, CORPUS_VAULT_ID: "node-wire-vault", CORPUS_PORT: String(port), CORPUS_CONTROL_DIR: control, CORPUS_INSTALLED_CRASH_TEST: "1", ...(observerFault === undefined ? {} : { CORPUS_INSTALLED_MOVE_OBSERVER_FAULT: observerFault }) }, stdio: ["ignore", "ignore", "pipe"] });
      processes.push(child);
      let stderr = ""; child.stderr?.on("data", chunk => { stderr += String(chunk); });
      const exited = new Promise<void>(resolve => child.once("exit", () => resolve()));
      const descriptor = JSON.parse(await readFile(join(request.vaultPath, ".obsidian", "plugins", "crash-plugin", "installed-runtime-acceptance.json"), "utf8"));
      await waitForCondition(async () => {
        const failure = await readFile(join(control, "failed.json"), "utf8").catch(() => null);
        if (failure !== null || child.exitCode !== null) throw new Error(`Node wire startup failed ${failure ?? stderr}`);
        return await readFile(join(control, descriptor.command.recovery === undefined ? "ready.json" : "events.jsonl"), "utf8").then(() => true).catch(() => false);
      }, { timeoutMs: 5_000, intervalMs: 10 });
      return { pid: child.pid, stop: async () => { child.kill("SIGKILL"); await exited; eventLogs.push(await readFile(join(control, "events.jsonl"), "utf8")); } };
    } },
    client: createLoopbackMcpClient(), timeouts: { startupMs: 5_000, stopMs: 5_000, portClosedMs: 5_000 }, boundaryTimeoutMs: 5_000,
    prepareAcceptanceDriver: async (request: any) => { const created = await createInstalledRuntimeAcceptanceDescriptor({ ...request, runId: "node-wire", reportDirectory: join(root, "reports") }); return { ...created, cleanup: async () => rm(created.path, { force: true }) }; },
    record: () => undefined, assertion: () => undefined,
  } as InstalledCrashRestorationSliceOptions;
  return { options, eventLogs, cleanup: async () => {
    for (const child of processes) {
      if (child.exitCode !== null || child.signalCode !== null) continue;
      const exited = new Promise<void>(resolve => child.once("exit", () => resolve()));
      child.kill("SIGKILL");
      await exited;
    }
  } };
}

it("drives the fixed multi-Frontmatter producer and whole-state consumer through real Node MCP wire and actual termination", async () => {
  const root = await mkdtemp(join(tmpdir(), "installed-node-wire-tracer-"));
  const fixture = await arrangeNodeCrashWire(root, "edit_multi_frontmatter", "after_rollback_mutation:0");
  try {
    const result = await runInstalledCrashRestorationSlice(fixture.options);
    expect(result.records[0]).toMatchObject({ mutationKind: "edit_multi_frontmatter", crashPoint: "after_rollback_mutation:0", proofState: "intent_not_applied", cleanupSucceeded: true });
    expect(fixture.eventLogs).toHaveLength(3);
    expect(fixture.eventLogs[0]).toContain('"point":"after_snapshot"');
    expect(fixture.eventLogs[1]).toContain('"point":"after_rollback_mutation:0"');
  } catch (error) { throw new Error(`${String(error)}\n${fixture.eventLogs.join("\n")}`); }
  finally { await fixture.cleanup(); await rm(root, { recursive: true, force: true }); }
}, 30_000);

it.each(["edit_frontmatter", "edit_multi_markdown", "edit_multi_frontmatter"] as const)("actually reaches every %s apply/rollback boundary in the production Node wire stack", async kind => {
  // Independent closed list: enumerating the producer's registry cannot prove
  // omitted or unreachable boundaries. This is Node evidence, not installed GUI.
  const points = ["before_prepared", "after_prepared", "after_file_mutation:0", "after_raw_verification", "during_success_barrier", "after_snapshot", "before_committed", "after_committed", "before_rollback", "after_rollback_mutation:0", "after_rollback_verification", "after_rollback_evidence", "before_rolled_back", "after_rolled_back", ...(kind === "edit_frontmatter" ? [] : ["after_file_mutation:1", "after_rollback_mutation:1"])] as import("../src/installed-runtime/crash-restoration-protocol.js").InstalledCrashPoint[];
  for (const point of points) {
    const root = await mkdtemp(join(tmpdir(), "installed-node-wire-boundary-"));
    const fixture = await arrangeNodeCrashWire(root, kind, point);
    try {
      const result = await runInstalledCrashRestorationSlice(fixture.options);
      const record = result.records[0];
      expect(record).toMatchObject({ mutationKind: kind, crashPoint: point, cleanupSucceeded: true, proofState: point === "before_prepared" || point === "after_committed" ? "intent_applied" : "intent_not_applied" });
      const rollback = point.includes("rollback") || point.includes("rolled_back");
      expect(fixture.eventLogs).toHaveLength(rollback ? 3 : 2);
      expect(fixture.eventLogs[rollback ? 1 : 0]).toContain(`"point":"${point}"`);
      // Replaying the retained result did not enter execution again; the only
      // new execution in the final process is the independently submitted sentinel.
      const finalLog = fixture.eventLogs.at(-1)!;
      expect(finalLog.split('"point":"before_prepared"').length - 1).toBe(point === "before_prepared" ? 2 : 1);
      expect(record.processGenerations.every(generation => generation.pid !== null && generation.stopped && generation.listenerClosed)).toBe(true);
    } catch (error) { throw new Error(`${kind}/${point}: ${String(error)}\n${fixture.eventLogs.join("\n")}`); }
    finally { await fixture.cleanup(); await rm(root, { recursive: true, force: true }); }
  }
}, 120_000);

it.each([
  { kind: "edit_multi_markdown", point: "after_file_mutation:0" },
  { kind: "edit_multi_markdown", point: "after_rollback_mutation:0" },
  { kind: "edit_multi_frontmatter", point: "after_file_mutation:0" },
  { kind: "edit_multi_frontmatter", point: "after_rollback_mutation:0" },
] as const)("independently reads A-after/B-before bytes from the parked owning process at $kind/$point", async ({ kind, point }) => {
  const { readFile } = await import("node:fs/promises");
  // Independent literals, not profile/projector output or marker inventories.
  const markdownBefore = [
    "﻿# Título del corpus\r\n\r\nEste cuerpo mezcla LF y CRLF.\nUna línea con 你好 y 🚀 emoji astral.\r\n\r\n- ítem uno\n- ítem dos\r\n\r\nfin sin salto",
    "﻿# Nota completa\r\n\r\nEste contenido será reemplazado entero.\nConserva 你好 与 🎉.\r\n",
  ];
  const markdownAfterA = "﻿# Título del corpus\r\n\r\nEste cuerpo mezcla LF y CRLF.\nUna línea con 你好 y 【reemplazo astral】🚀.\r\n\r\n- ítem uno\n- ítem dos\r\n\r\nfin sin salto";
  const frontmatterBeforeA = "---\r\ntitle: \"Mi Nota\"\r\nstatus: draft\r\ncount: 1\r\n---\r\n\r\n# Cuerpo\r\n\r\nTexto intacto con 你好 y 🚀\r\n";
  const frontmatterAfterA = "---\r\ntitle: \"Mi Nota\"\r\nstatus: \"published\"\r\n\"reviewer\": \"你好\"\r\n---\r\n\r\n# Cuerpo\r\n\r\nTexto intacto con 你好 y 🚀\r\n";
  const paths = kind === "edit_multi_markdown" ? ["Corpus/Multi/EditA.md", "Corpus/Multi/EditB.md"] : ["Corpus/Multi/FrontmatterA.md", "Corpus/Multi/FrontmatterB.md"];
  const before = kind === "edit_multi_markdown" ? markdownBefore : [frontmatterBeforeA, `﻿${frontmatterBeforeA}`];
  const afterA = kind === "edit_multi_markdown" ? markdownAfterA : frontmatterAfterA;
  const root = await mkdtemp(join(tmpdir(), "independent-479-partial-bytes-"));
  const fixture = await arrangeNodeCrashWire(root, kind, point);
  const originalStart = fixture.options.processControl.start;
  let generation = 0;
  let observed = false;
  const rollback = point === "after_rollback_mutation:0";
  try {
    const outcome = await runInstalledCrashRestorationSlice({ ...fixture.options, processControl: { start: async request => {
      const handle = await originalStart(request);
      const currentGeneration = ++generation;
      return { ...handle, stop: async () => {
        try {
          if (currentGeneration === (rollback ? 2 : 1)) {
            expect(await readFile(join(request.vaultPath, paths[0]!))).toEqual(Buffer.from(afterA));
            expect(await readFile(join(request.vaultPath, paths[1]!))).toEqual(Buffer.from(before[1]!));
            expect((await readInstalledCrashJournal(join(request.vaultPath, ".llm-wiki", "recovery-journal.bin"))).phase).toBe("PREPARED");
            observed = true;
          }
          if (currentGeneration === (rollback ? 3 : 2)) {
            for (const [index, path] of paths.entries()) expect(await readFile(join(request.vaultPath, path))).toEqual(Buffer.from(before[index]!));
          }
        } finally { await handle.stop(); }
      } };
    } } });
    expect(observed).toBe(true);
    expect(outcome.records[0]).toMatchObject({ proofState: "intent_not_applied", cleanupSucceeded: true });
    const recoveryLog = fixture.eventLogs[rollback ? 1 : 0]!;
    expect(recoveryLog).toContain(`"point":"${point}"`);
    if (rollback) {
      const restoredB = `"point":"recovery_after_file_published:${paths[1]}"`;
      expect(recoveryLog).toContain(restoredB);
      expect(recoveryLog).not.toContain(`"point":"recovery_after_file_published:${paths[0]}"`);
      expect(recoveryLog.indexOf(restoredB)).toBeLessThan(recoveryLog.indexOf('"point":"after_rollback_mutation:0"'));
    }
    expect(fixture.eventLogs.at(-1)!.split('"point":"before_prepared"').length - 1).toBe(1);
  } finally { await fixture.cleanup(); await rm(root, { recursive: true, force: true }); }
}, 30_000);

it.each([
  { kind: "edit_multi_markdown", point: "after_snapshot", fault: "missed_second_restore" },
  { kind: "edit_multi_frontmatter", point: "after_committed", fault: "partial_commit" },
  { kind: "edit_frontmatter", point: "after_committed", fault: "untouched_body" },
  { kind: "edit_multi_frontmatter", point: "after_snapshot", fault: "wrong_terminal_phase" },
] as const)("refuses $fault observed after real Node recovery at $kind/$point", async ({ kind, point, fault }) => {
  const { crashProfile } = await import("../src/installed-runtime/crash-restoration-protocol.js");
  const root = await mkdtemp(join(tmpdir(), "installed-node-wire-counterexample-"));
  const fixture = await arrangeNodeCrashWire(root, kind, point);
  const start = fixture.options.processControl.start;
  let generation = 0;
  try {
    await expect(runInstalledCrashRestorationSlice({ ...fixture.options, processControl: { start: async request => {
      const handle = await start(request);
      if (++generation === 2) {
        const files = crashProfile(kind).files;
        const file = files.at(-1)!;
        if (fault === "missed_second_restore") await writeFile(join(request.vaultPath, file.path), file.committedBytes!);
        if (fault === "partial_commit") await writeFile(join(request.vaultPath, file.path), file.originalBytes!);
        if (fault === "untouched_body") await writeFile(join(request.vaultPath, file.path), Buffer.concat([Buffer.from(file.committedBytes!), Buffer.from("\r\nUNREQUESTED BODY") ]));
        if (fault === "wrong_terminal_phase") {
          const path = join(request.vaultPath, ".llm-wiki", "recovery-journal.bin");
          const journalHandle = await open(path, "r+");
          try { const journal = await openRecoveryJournal(journalHandle); const prior = await journal.recover(); await journal.write({ phase: "COMMITTED", payload: { ...(prior!.payload as object), phase: "COMMITTED" } }); }
          finally { await journalHandle.close(); }
        }
      }
      return handle;
    } } })).rejects.toThrow(fault === "wrong_terminal_phase" ? "durable terminal intent" : "whole-state inventory");
    expect(fixture.eventLogs).toHaveLength(2);
  } finally { await fixture.cleanup(); await rm(root, { recursive: true, force: true }); }
}, 30_000);

it("refuses loss of derived directories after real committed create restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "installed-node-wire-derived-dir-"));
  const fixture = await arrangeNodeCrashWire(root, "create_note", "after_committed");
  const start = fixture.options.processControl.start;
  let generation = 0;
  try {
    await expect(runInstalledCrashRestorationSlice({ ...fixture.options, processControl: { start: async request => {
      const handle = await start(request);
      if (++generation === 2) await rm(join(request.vaultPath, "Corpus"), { recursive: true });
      return handle;
    } } })).rejects.toThrow("whole-state inventory");
  } finally { await fixture.cleanup(); await rm(root, { recursive: true, force: true }); }
}, 30_000);

// Orchestration-only fixture. This is deliberately not installed-Obsidian evidence.
async function arrangeCrashOrchestration(root: string, replayId: string, crashPoint: import("../src/installed-runtime/crash-restoration-protocol.js").InstalledCrashPoint = "after_prepared", mutationKind: import("../src/installed-runtime/crash-restoration-protocol.js").InstalledCrashKind = "create_note", fault?: "missing_marker" | "wrong_marker" | "phase_disguise" | "partial_restore" | "early_listener" | "replay_mutation" | "replay_journal" | "dirty_stop", configDirectoryName = ".obsidian") {
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
    const fixtures = crashProfile(mutationKind).files;
    if (kind === "copy_attachment" || kind === "move_attachment") {
      const dirs = [`Corpus/Attachments/${kind === "copy_attachment" ? "Copy" : "Move"}-target`, `Corpus/Attachments/${kind === "copy_attachment" ? "Copy" : "Move"}-target/Nested`];
      const typed = (bytes: Uint8Array | null) => bytes === null ? { kind: "absent" } : { kind: "attachment", sha256: sha(bytes) };
      return { requestedEffects: [{ operationId, kind, projectedOutcome: "changed" }], derivedEffects: dirs.map(path => ({ operationId: `derived/${operationId}/directory/${path}`, causedByOperationId: operationId, kind: "create_directory", projectedOutcome: "changed" })), paths: [...dirs.map(path => ({ path, preState: { kind: "absent" }, projectedFinalState: { kind: "directory" }, projectedOutcome: "changed" })), ...crashProfile(mutationKind).files.map(file => ({ path: file.path, preState: typed(file.originalBytes), projectedFinalState: typed(file.committedBytes), projectedOutcome: file.originalBytes !== null && file.committedBytes !== null ? "unchanged" : "changed" }))].sort((a, b) => a.path.localeCompare(b.path, "en")) };
    }
    const dirs = kind === "create_note" ? ["Corpus", "Corpus/Notes"] : [];
    return { requestedEffects: request.operations.map(({ operationId, kind }: { operationId: string; kind: string }) => ({ operationId, kind, projectedOutcome: "changed" })), derivedEffects: dirs.map(path => ({ operationId: `derived/${operationId}/directory/${path}`, causedByOperationId: operationId, kind: "create_directory", projectedOutcome: "changed" })), paths: [...dirs.map(path => ({ path, preState: { kind: "absent" }, projectedFinalState: { kind: "directory" }, projectedOutcome: "changed" })), ...fixtures.map(fixture => ({ path: fixture.path, preState: fixture.originalBytes === null ? { kind: "absent" } : { kind: "markdown", contentVersion: `sha256:${sha(fixture.originalBytes)}` }, projectedFinalState: { kind: "markdown", contentVersion: `sha256:${sha(fixture.committedBytes!)}` }, projectedOutcome: "changed" }))] };
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
        if (submitting && !sentinel && fault === "replay_journal") await writeFrame(crashPoint === "after_committed" || crashPoint === "before_prepared" ? "COMMITTED" : "ROLLED_BACK");
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
    if (mutationKind === "copy_attachment" || mutationKind === "move_attachment") {
      const name = mutationKind === "copy_attachment" ? "Copy" : "Move";
      const parent = `Corpus/Attachments/${name}-target`;
      await rm(join(vaultPath, parent), { recursive: true, force: true });
      let applied = !["before_prepared", "after_prepared", "after_rollback_verification", "after_rollback_evidence", "before_rolled_back", "after_rolled_back"].includes(point);
      let directoryCount = applied ? 2 : 0;
      if (point.startsWith("after_mutation:")) { const index = Number(point.split(":")[1]); applied = index === 2; directoryCount = Math.min(2, index + 1); }
      if (point.startsWith("after_rollback_mutation:")) { const index = Number(point.split(":")[1]); applied = false; directoryCount = Math.min(2, Math.max(0, (mutationKind === "copy_attachment" ? 3 : 2) - index)); }
      if (directoryCount > 0) await mkdir(join(vaultPath, parent, ...(directoryCount === 2 ? ["Nested"] : [])), { recursive: true });
      for (const file of crashProfile(mutationKind).files) {
        const bytes = applied ? file.committedBytes : file.originalBytes;
        if (bytes === null) await rm(join(vaultPath, file.path), { force: true });
        else await writeFile(join(vaultPath, file.path), bytes);
      }
    } else if (mutationKind === "create_note") {
      await rm(join(vaultPath, "Corpus"), { recursive: true, force: true });
      const present = !["before_prepared", "after_prepared", "after_mutation:0", "after_mutation:1", "after_rollback_mutation:0", "after_rollback_mutation:1", "after_rollback_mutation:2", "after_rollback_verification", "after_rollback_evidence", "before_rolled_back", "after_rolled_back"].includes(point);
      if (present || ["after_mutation:1", "after_rollback_mutation:0"].includes(point)) await mkdir(join(vaultPath, "Corpus", "Notes"), { recursive: true });
      else if (["after_mutation:0", "after_rollback_mutation:1"].includes(point)) await mkdir(join(vaultPath, "Corpus"));
      if (present) await writeFile(join(vaultPath, fixture.path), fixture.committedBytes!);
    } else {
      const files = crashProfile(mutationKind).files;
      for (const [index, fixture] of files.entries()) {
        let original = ["before_prepared", "after_prepared", "after_rollback_verification", "after_rollback_evidence", "before_rolled_back", "after_rolled_back"].includes(point);
        if (point.startsWith("after_file_mutation:")) original = index > Number(point.split(":")[1]);
        if (point.startsWith("after_rollback_mutation:")) original = files.length - 1 - index <= Number(point.split(":")[1]);
        await writeFile(join(vaultPath, fixture.path), original ? fixture.originalBytes! : fixture.committedBytes!);
      }
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
      vaultPath = request.vaultPath;
      const descriptor = JSON.parse(await readFile(descriptorPath, "utf8"));
      terminal = descriptor.command.action !== "idle" && descriptor.command.recovery === undefined;
      stopped = false;
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
    prepareAcceptanceDriver: async (request: any) => { if (request.vaultPath.includes("-crash-move_note-")) throw new Error("Historical orchestration fixture lacks enabled observer source"); terminal = false; publishedSequence = 0; mutationKind = (["copy_attachment", "move_attachment", "edit_multi_frontmatter", "edit_multi_markdown", "edit_frontmatter", "edit_body_whole", "edit_body"] as const).find(kind => request.vaultPath.includes(`-crash-${kind}-`)) ?? "create_note"; crashPoint = request.vaultPath.split(`-crash-${mutationKind}-`)[1].replaceAll("-", "_").replace(/after_(file_mutation|rollback_mutation|mutation)_(\d)/u, "after_$1:$2"); const created = await createInstalledRuntimeAcceptanceDescriptor({ ...request, runId: "orchestration", reportDirectory: join(root, "reports") }); descriptorPath = created.path; return { ...created, cleanup: async () => undefined }; }, record: () => undefined, assertion: () => undefined,
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
  for (const kind of ["create_note", "edit_multi_frontmatter"] as const) {
  for (const fault of ["missing_marker", "wrong_marker", "phase_disguise", "early_listener", "partial_restore", "replay_mutation", "dirty_stop"] as const) {
    const root = await mkdtemp(join(tmpdir(), "installed-crash-adversarial-"));
    const fixture = await arrangeCrashOrchestration(root, "bound-change-set", fault === "early_listener" ? "before_rolled_back" : "after_prepared", kind, fault);
    try { await expect(runInstalledCrashRestorationSlice({ ...fixture.options, timeouts: { startupMs: 100, stopMs: 100, portClosedMs: 100 }, boundaryTimeoutMs: 100 })).rejects.toThrow(); }
    finally { await fixture.cleanup(); await rm(root, { recursive: true, force: true }); }
  }
  }
}, 30_000);

it("fails closed on attachment truncation, missing source, leftover destination, extra copy and partial restore at the runner seam", async () => {
  for (const fault of ["truncated", "corrupt", "source_lost", "target_left", "extra_copy", "partial_restore", "private_stage"] as const) {
    const root = await mkdtemp(join(tmpdir(), "installed-attachment-crash-adversarial-"));
    const fixture = await arrangeCrashOrchestration(root, "bound-change-set", "after_prepared", "copy_attachment");
    const originalStart = fixture.options.processControl.start;
    let generation = 0;
    try {
      await expect(runInstalledCrashRestorationSlice({ ...fixture.options, processControl: { start: async request => {
        const handle = await originalStart(request);
        if (++generation === 2) {
          const source = join(request.vaultPath, "Corpus/Attachments/Copy-source.bin");
          if (fault === "truncated") await writeFile(source, Uint8Array.from([0, 255]));
          if (fault === "corrupt") await writeFile(source, Uint8Array.from([0, 255, 16, 128, 66, 0, 195, 40, 127, 10, 0]));
          if (fault === "source_lost") await rm(source);
          if (fault === "target_left") { await mkdir(join(request.vaultPath, "Corpus/Attachments/Copy-target/Nested"), { recursive: true }); await writeFile(join(request.vaultPath, "Corpus/Attachments/Copy-target/Nested/Copy-destination.bin"), Uint8Array.from([0, 255])); }
          if (fault === "extra_copy") await writeFile(join(request.vaultPath, "Extra-copy.bin"), Uint8Array.from([0, 255]));
          if (fault === "partial_restore") await writeFile(join(request.vaultPath, "Notes/Welcome.md"), "untouched note damaged");
          if (fault === "private_stage") { await mkdir(join(request.vaultPath, ".llm-wiki/staging/leaked"), { recursive: true }); await writeFile(join(request.vaultPath, ".llm-wiki/staging/leaked/copy"), Uint8Array.from([0, 255])); }
        }
        return handle;
      } } })).rejects.toThrow(fault === "private_stage" ? "residue" : "whole-state");
    } finally { await fixture.cleanup(); await rm(root, { recursive: true, force: true }); }
  }
});

it("records attachment source/destination absence, sizes and bare hashes independently at the runner report seam", async () => {
  const root = await mkdtemp(join(tmpdir(), "installed-attachment-crash-report-"));
  const fixture = await arrangeCrashOrchestration(root, "bound-change-set", "after_committed", "move_attachment");
  try {
    const result = await runInstalledCrashRestorationSlice(fixture.options);
    expect(result.records[0]).toMatchObject({ attachmentPaths: [
      { path: "Corpus/Attachments/Move-source.bin", before: { kind: "attachment", sizeBytes: 11, sha256: "bc787415a301ccb4a41bca4e691c49599ce98bc5cce743ee975845e15821626e" }, boundary: { kind: "absent" }, after: { kind: "absent" } },
      { path: "Corpus/Attachments/Move-target/Nested/Move-destination.bin", before: { kind: "absent" }, boundary: { kind: "attachment", sizeBytes: 11, sha256: "bc787415a301ccb4a41bca4e691c49599ce98bc5cce743ee975845e15821626e" }, after: { kind: "attachment", sizeBytes: 11, sha256: "bc787415a301ccb4a41bca4e691c49599ce98bc5cce743ee975845e15821626e" } },
    ], privateFootprint: { before: { stagingFiles: 0, trashFiles: 0 }, boundary: { stagingFiles: 0, trashFiles: 0 }, after: { stagingFiles: 0, trashFiles: 0 } } });
  } finally { await fixture.cleanup(); await rm(root, { recursive: true, force: true }); }
});

it.each(["copy_attachment", "move_attachment"] as const)("actually reaches every %s binary and derived-directory boundary through the fixed production Node wire protocol", async kind => {
  // Independent literal list. The registered GUI/runtime acceptance remains separate.
  const points = ["before_prepared", "after_prepared", "after_mutation:0", "after_mutation:1", "after_mutation:2", "after_raw_verification", "during_semantic_evidence", "after_semantic_evidence", "after_snapshot", "before_committed", "after_committed", "before_rollback", "after_rollback_mutation:0", "after_rollback_mutation:1", "after_rollback_mutation:2", "after_rollback_verification", "after_rollback_evidence", "before_rolled_back", "after_rolled_back", ...(kind === "copy_attachment" ? ["after_rollback_mutation:3"] : [])] as import("../src/installed-runtime/crash-restoration-protocol.js").InstalledCrashPoint[];
  for (const point of points) {
    const root = await mkdtemp(join(tmpdir(), "attachment-fixed-node-wire-"));
    const fixture = await arrangeNodeCrashWire(root, kind, point);
    try {
      const result = await runInstalledCrashRestorationSlice(fixture.options);
      const record = result.records[0];
      const applied = point === "before_prepared" || point === "after_committed";
      expect(record).toMatchObject({ mutationKind: kind, crashPoint: point, cleanupSucceeded: true, proofState: applied ? "intent_applied" : "intent_not_applied", journalPhase: applied ? "COMMITTED" : "ROLLED_BACK" });
      const rollback = point.includes("rollback") || point.includes("rolled_back");
      expect(fixture.eventLogs).toHaveLength(rollback ? 3 : 2);
      expect(fixture.eventLogs[rollback ? 1 : 0]).toContain(`"point":"${point}"`);
      expect(record.processGenerations.every(generation => generation.pid !== null && generation.stopped && generation.listenerClosed)).toBe(true);
      const hash = kind === "copy_attachment" ? "0328c64313d6d6f362d5ed1c3217c3c1d17472b1f63619351cf0a1061cb1597a" : "bc787415a301ccb4a41bca4e691c49599ce98bc5cce743ee975845e15821626e";
      const bytes = { kind: "attachment", sizeBytes: 11, sha256: hash };
      expect(record.attachmentPaths!.map(path => path.after)).toEqual([kind === "move_attachment" && applied ? { kind: "absent" } : bytes, applied ? bytes : { kind: "absent" }]);
      expect(record.privateFootprint).toEqual({ before: { stagingFiles: 0, trashFiles: 0 }, boundary: { stagingFiles: 0, trashFiles: 0 }, after: { stagingFiles: 0, trashFiles: 0 } });
      expect(fixture.eventLogs.at(-1)!.split('"point":"before_prepared"').length - 1).toBe(point === "before_prepared" ? 2 : 1);
    } catch (error) { throw new Error(`${kind}/${point}: ${String(error)}\n${fixture.eventLogs.join("\n")}`); }
    finally { await fixture.cleanup(); await rm(root, { recursive: true, force: true }); }
  }
}, 120_000);

it.each(["copy_attachment", "move_attachment"] as const)("rejects real fixed-protocol %s byte and residue counterexamples after recovery", async kind => {
  const { readFile } = await import("node:fs/promises");
  const name = kind === "copy_attachment" ? "Copy" : "Move";
  // Literal binary oracle includes invalid UTF-8, independent of fixture/projector code.
  const bytes = Buffer.from(kind === "copy_attachment" ? [0, 255, 16, 128, 66, 0, 195, 40, 127, 10, 254] : [137, 80, 78, 71, 13, 10, 26, 10, 0, 255, 129]);
  for (const fault of ["truncated", "corrupt", "source_lost", "target_left", "extra_copy", "partial_restore", "empty_directory", "private_stage", "private_trash", "wrong_hash_type"] as const) {
    const root = await mkdtemp(join(tmpdir(), "attachment-fixed-wire-counterexample-"));
    const fixture = await arrangeNodeCrashWire(root, kind, "after_snapshot");
    const start = fixture.options.processControl.start;
    let generation = 0;
    const proofs: unknown[] = [];
    try {
      await expect(runInstalledCrashRestorationSlice({ ...fixture.options,
        record: (recordKind, recordName, detail) => { if (recordKind === "assertion" && recordName.endsWith("-proof")) proofs.push(detail); },
        processControl: { start: async request => {
          const current = ++generation;
          if (current === 2 && fault === "wrong_hash_type") {
            const path = join(request.vaultPath, ".llm-wiki/recovery-journal.bin");
            const handle = await open(path, "r+");
            try {
              const journal = await openRecoveryJournal(handle);
              const frame = (await journal.recover())!;
              const malformed = JSON.parse(JSON.stringify(frame.payload), (key, value) => key === "sha256" ? `sha256:${value}` : value);
              await journal.write({ phase: "PREPARED", payload: malformed });
            } finally { await handle.close(); }
          }
          const handle = await start(request);
          if (current === 2 && fault === "wrong_hash_type") {
            const identity = JSON.parse(await readFile(join(request.vaultPath, ".obsidian/plugins/crash-plugin/data.json"), "utf8"));
            const health = await fixture.options.client.observeHealth(new URL(`http://127.0.0.1:${identity.port}/mcp`), identity.vaultId);
            expect(health.health.recovery.state).toBe("blocked");
          }
          if (current === 2 && fault !== "wrong_hash_type") {
            const source = join(request.vaultPath, `Corpus/Attachments/${name}-source.bin`);
            expect(await readFile(source)).toEqual(bytes);
            if (fault === "truncated") await writeFile(source, bytes.subarray(0, 2));
            if (fault === "corrupt") { const corrupt = Buffer.from(bytes); corrupt[10] = 0; await writeFile(source, corrupt); }
            if (fault === "source_lost") await rm(source);
            if (fault === "target_left") { await mkdir(join(request.vaultPath, `Corpus/Attachments/${name}-target/Nested`), { recursive: true }); await writeFile(join(request.vaultPath, `Corpus/Attachments/${name}-target/Nested/${name}-destination.bin`), bytes); }
            if (fault === "extra_copy") await writeFile(join(request.vaultPath, "Extra-copy.bin"), bytes);
            if (fault === "partial_restore") await writeFile(join(request.vaultPath, "Notes/Welcome.md"), "untouched note damaged");
            if (fault === "empty_directory") await mkdir(join(request.vaultPath, `Corpus/Attachments/${name}-target`));
            if (fault === "private_stage" || fault === "private_trash") { const directory = join(request.vaultPath, `.llm-wiki/${fault === "private_stage" ? "staging" : "trash"}/leaked`); await mkdir(directory, { recursive: true }); await writeFile(join(directory, "copy"), bytes); }
          }
          return handle;
        } },
      })).rejects.toThrow(fault === "wrong_hash_type" ? "readiness deadline" : fault === "private_stage" || fault === "private_trash" ? "residue" : "whole-state inventory");
      expect(proofs).toEqual([]);
      expect(fixture.eventLogs[0]).toContain('"point":"after_snapshot"');
      expect(fixture.eventLogs).toHaveLength(2);
    } catch (error) { throw new Error(`${kind}/${fault}: ${String(error)}\n${fixture.eventLogs.join("\n")}`); }
    finally { await fixture.cleanup(); await rm(root, { recursive: true, force: true }); }
  }
}, 60_000);

it.each([
  { kind: "copy_attachment", point: "after_mutation:2" },
  { kind: "copy_attachment", point: "after_rollback_mutation:0" },
  { kind: "move_attachment", point: "after_mutation:2" },
  { kind: "move_attachment", point: "after_rollback_mutation:0" },
] as const)("independently reads parked binary bytes and path absence at $kind/$point", async ({ kind, point }) => {
  const { readFile, stat } = await import("node:fs/promises");
  const name = kind === "copy_attachment" ? "Copy" : "Move";
  const bytes = Buffer.from(kind === "copy_attachment" ? [0, 255, 16, 128, 66, 0, 195, 40, 127, 10, 254] : [137, 80, 78, 71, 13, 10, 26, 10, 0, 255, 129]);
  const rollback = point === "after_rollback_mutation:0";
  const root = await mkdtemp(join(tmpdir(), "attachment-fixed-wire-independent-bytes-"));
  const fixture = await arrangeNodeCrashWire(root, kind, point);
  const start = fixture.options.processControl.start;
  let generation = 0;
  let observed = false;
  try {
    const result = await runInstalledCrashRestorationSlice({ ...fixture.options, processControl: { start: async request => {
      const handle = await start(request);
      const current = ++generation;
      return { ...handle, stop: async () => {
        try {
          if (current === (rollback ? 2 : 1)) {
            const source = join(request.vaultPath, `Corpus/Attachments/${name}-source.bin`);
            const destination = join(request.vaultPath, `Corpus/Attachments/${name}-target/Nested/${name}-destination.bin`);
            if (kind === "move_attachment" && !rollback) await expect(stat(source)).rejects.toMatchObject({ code: "ENOENT" });
            else expect(await readFile(source)).toEqual(bytes);
            if (rollback) await expect(stat(destination)).rejects.toMatchObject({ code: "ENOENT" });
            else expect(await readFile(destination)).toEqual(bytes);
            expect((await stat(join(request.vaultPath, `Corpus/Attachments/${name}-target/Nested`))).isDirectory()).toBe(true);
            expect((await readInstalledCrashJournal(join(request.vaultPath, ".llm-wiki/recovery-journal.bin"))).phase).toBe("PREPARED");
            observed = true;
          }
        } finally { await handle.stop(); }
      } };
    } } });
    expect(observed).toBe(true);
    expect(result.records[0]).toMatchObject({ proofState: "intent_not_applied", cleanupSucceeded: true });
    expect(fixture.eventLogs[rollback ? 1 : 0]).toContain(`"point":"${point}"`);
  } finally { await fixture.cleanup(); await rm(root, { recursive: true, force: true }); }
}, 30_000);

it("reports missing local recovery authority as blocked before submitting a sentinel", async () => {
  const root = await mkdtemp(join(tmpdir(), "installed-crash-local-authority-"));
  const fixture = await arrangeCrashOrchestration(root, "bound-change-set");
  try {
    await expect(runInstalledCrashRestorationSlice({ ...fixture.options, client: { observeHealth: async () => ({ health: { readiness: { searchSnapshot: "ready" }, recovery: { state: "none" }, write: { gate: "open", state: "paused" } } }) } as never })).rejects.toThrow("requires local authority");
  } finally { await fixture.cleanup(); await rm(root, { recursive: true, force: true }); }
});

it("rejects repeat execution that rewrites the same terminal journal despite identical file bytes and replay proof", async () => {
  const root = await mkdtemp(join(tmpdir(), "installed-multi-repeat-execution-"));
  const fixture = await arrangeCrashOrchestration(root, "bound-change-set", "after_committed", "edit_multi_frontmatter", "replay_journal");
  try { await expect(runInstalledCrashRestorationSlice(fixture.options)).rejects.toThrow("replay changed the durable terminal frame"); }
  finally { await fixture.cleanup(); await rm(root, { recursive: true, force: true }); }
});

it("closes full status and retained replay for both requested files rather than a primary-file proof", async () => {
  for (const kind of ["edit_frontmatter", "edit_multi_markdown", "edit_multi_frontmatter"] as const) {
    for (const point of ["after_prepared", "after_committed", "after_file_mutation:0", "after_rollback_mutation:0"] as const) {
      const root = await mkdtemp(join(tmpdir(), "installed-multi-proof-"));
      const fixture = await arrangeCrashOrchestration(root, "bound-change-set", point, kind);
      try {
        const outcome = await runInstalledCrashRestorationSlice(fixture.options);
        expect(outcome.records[0]).toMatchObject({ mutationKind: kind, crashPoint: point, cleanupSucceeded: true });
        expect(outcome.records[0].after.filter(entry => entry.kind === "file" && entry.path.startsWith("Corpus/"))).toHaveLength(kind === "edit_frontmatter" ? 1 : 2);
      } finally { await fixture.cleanup(); await rm(root, { recursive: true, force: true }); }
    }
  }
}, 30_000);

it("orchestrates all independently bound apply/rollback points including whole-body and repeated recovery crashes", async () => {
  const { installedCrashScenarios, crashScenarioParts } = await import("../src/installed-runtime/crash-restoration-protocol.js");
  for (const scenario of installedCrashScenarios.filter(scenario => !scenario.startsWith("move_note/"))) {
    // Move's independently sealed observer is exercised by the real Node wire
    // matrix below, not fabricated by this historical orchestration-only fixture.
    const root = await mkdtemp(join(tmpdir(), "installed-crash-complete-orchestration-"));
    const { kind, point } = crashScenarioParts(scenario);
    const fixture = await arrangeCrashOrchestration(root, "bound-change-set", point, kind);
    try {
      const outcome = await runInstalledCrashRestorationSlice(fixture.options);
      expect(outcome.records).toMatchObject([{ mutationKind: kind, crashPoint: point, cleanupSucceeded: true, wholeStateVerified: true, sentinelAppliedAfterRestore: true }]);
      expect(outcome.records[0]!.processGenerations).toHaveLength(point.includes("rollback") || point.includes("rolled_back") ? 3 : 2);
    } catch (error) { throw new Error(`${scenario}: ${String(error)}`); }
    finally { await fixture.cleanup(); await rm(root, { recursive: true, force: true }); }
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


it("refuses to promote historical orchestration fixtures once the move enabled-observer source is required", async () => {
  const root = await mkdtemp(join(tmpdir(), "installed-crash-partial-orchestration-"));
  const fixture = await arrangeCrashOrchestration(root, "bound-change-set");
  const { createAuthoritativeInstalledRuntimeRunners } = await import("../src/installed-runtime/smoke-command.js");
  const records: unknown[] = [];
  try {
    await expect(createAuthoritativeInstalledRuntimeRunners().runCrashRestorationRetainedAuthorityCorpus({
      installed: fixture.options, workingDirectory: root,
      record: (_kind, name, detail) => { if (name.startsWith("installed-crash-")) records.push(detail); },
      assertion: () => undefined,
    })).rejects.toThrow("Historical orchestration fixture lacks enabled observer source");
    expect(records).toHaveLength(131);
    expect(records).toEqual(expect.arrayContaining([
      expect.objectContaining({ scope: "single-after-prepared-installed-rollback-slice" }),
      expect.objectContaining({ scope: "single-after-committed-installed-replay-slice" }),
      expect.objectContaining({ records: [expect.objectContaining({ mutationKind: "edit_body_whole", crashPoint: "before_rolled_back" })] }),
    ]));
  } finally { await fixture.cleanup(); await rm(root, { recursive: true, force: true }); }
}, 30_000);


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


it.each(["halfwrite-event", "replay-second-rewrite"] as const)("rejects %s from the live owning process observer even with identical terminal inventory", async fault => {
  const root = await mkdtemp(join(tmpdir(), "move-480-event-fault-"));
  const fixture = await arrangeNodeCrashWire(root, "move_note", fault === "halfwrite-event" ? "after_file_mutation:0" : "after_committed", fault);
  const context: import("../src/installed-runtime/installed-crash-restoration-slice.js").InstalledMoveObserverContext = { runId: fixture.options.runId, candidateBundleSha256: fixture.options.candidate.identity.bundleSha256, installedMainSha256: fixture.options.candidate.identity.files.find(file => file.path === "main.js")!.sha256, profileName: fixture.options.profile.name, observations: [] };
  try {
    await expect(runInstalledCrashRestorationSlice({ ...fixture.options, moveObserverContext: context })).rejects.toThrow(fault === "halfwrite-event" ? /complete before\/after/ : /duplicate closure rewrite/);
  } finally { await fixture.cleanup(); await rm(root, { recursive: true, force: true }); }
}, 30_000);

it("closes every reachable move apply/rollback boundary through real termination, literal closure bytes and retained observer source (Node adapter, not GUI)", async () => {
  const { readFile } = await import("node:fs/promises");
  const { verifyInstalledMoveObserverSource } = await import("../src/installed-runtime/installed-crash-restoration-slice.js");
  const points = ["before_prepared", "after_prepared", "after_file_mutation:0", "after_file_mutation:1", "after_mutation:0", "after_raw_verification", "during_semantic_evidence", "after_semantic_evidence", "after_snapshot", "before_committed", "after_committed", "before_rollback", "after_rollback_mutation:0", "after_rollback_mutation:1", "after_rollback_mutation:2", "after_rollback_verification", "after_rollback_evidence", "before_rolled_back", "after_rolled_back"] as const;
  const paths = ["Corpus/Move/Alpha.md", "Corpus/Move/Beta.md", "Corpus/Move/Derived-A.md", "Corpus/Move/Derived-B.md"];
  const source = "# Alpha\r\n\r\nSource note body 你好 🚀.\r\nSecond body line.\r\n";
  const a = '﻿# Derived A\r\n你好 🚀 [[Alpha|保留 alias]] and [标题](Alpha.md "untouched title")\r\n';
  const aAfter = '﻿# Derived A\r\n你好 🚀 [[Beta|保留 alias]] and [标题](Beta.md "untouched title")\r\n';
  const b = '# Derived B\n![[Alpha#Heading|保留 embed 🌍]]\n尾部不改\n';
  const bAfter = '# Derived B\n![[Beta#Heading|保留 embed 🌍]]\n尾部不改\n';
  for (const point of points) {
    const root = await mkdtemp(join(tmpdir(), "move-480-all-boundaries-"));
    const fixture = await arrangeNodeCrashWire(root, "move_note", point);
    const context: import("../src/installed-runtime/installed-crash-restoration-slice.js").InstalledMoveObserverContext = { runId: fixture.options.runId, candidateBundleSha256: fixture.options.candidate.identity.bundleSha256, installedMainSha256: fixture.options.candidate.identity.files.find(file => file.path === "main.js")!.sha256, profileName: fixture.options.profile.name, observations: [] };
    const start = fixture.options.processControl.start;
    const rollback = point.includes("rollback") || point.includes("rolled_back");
    let generation = 0;
    let boundaryRead = false;
    try {
      const outcome = await runInstalledCrashRestorationSlice({ ...fixture.options, moveObserverContext: context, processControl: { start: async request => {
        const handle = await start(request); const current = ++generation;
        return { ...handle, stop: async () => {
          try {
            const terminal = current === (rollback ? 3 : 2);
            const boundary = current === (rollback ? 2 : 1);
            if (boundary || terminal) {
              let moved = terminal ? point === "after_committed" || point === "before_prepared" : !["before_prepared", "after_prepared", "after_file_mutation:0", "after_file_mutation:1"].includes(point) && !point.startsWith("after_rollback") && !["before_rolled_back", "after_rolled_back"].includes(point);
              let publishedA = moved, publishedB = moved;
              if (boundary && point === "after_file_mutation:0") { publishedA = true; publishedB = false; }
              if (boundary && point === "after_file_mutation:1") { publishedA = true; publishedB = true; }
              if (boundary && point === "after_rollback_mutation:0") { moved = false; publishedA = true; publishedB = true; }
              if (boundary && point === "after_rollback_mutation:1") { moved = false; publishedA = true; publishedB = false; }
              const expected = [moved ? null : source, moved ? source : null, publishedA ? aAfter : a, publishedB ? bAfter : b];
              for (const [index, path] of paths.entries()) {
                const bytes = await readFile(join(request.vaultPath, path)).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; });
                expect(bytes).toEqual(expected[index] === null ? null : Buffer.from(expected[index]!));
              }
              if (boundary) boundaryRead = true;
            }
          } finally { await handle.stop(); }
        } };
      } } });
      const record = outcome.records[0];
      expect(boundaryRead).toBe(true);
      expect(record.processGenerations).toHaveLength(rollback ? 3 : 2);
      expect(record.observer?.windows).toHaveLength(rollback ? 3 : 2);
      expect(record.cleanupSucceeded).toBe(true);
      expect(record.moveClosure).toHaveLength(4);
      expect(record.privateFootprint?.after).toEqual({ stagingFiles: 0, trashFiles: 0 });
      expect(() => verifyInstalledMoveObserverSource(record, context)).not.toThrow();
      expect(() => verifyInstalledMoveObserverSource(record, { ...context, observations: [] })).toThrow(/source context/);
      expect(() => verifyInstalledMoveObserverSource({ ...record, cleanupSucceeded: false } as never, context)).toThrow(/source context/);
      const tampered = structuredClone(context);
      const rawEvents = tampered.observations[0]!.verification.events as { mac: string }[];
      rawEvents[0]!.mac = "0".repeat(64);
      expect(() => verifyInstalledMoveObserverSource(record, tampered)).toThrow(/authentication/);
      expect(() => verifyInstalledMoveObserverSource({ ...record, observer: { ...record.observer!, windows: record.observer!.windows.map((window, index) => index === 0 ? { ...window, transcriptSha256: "0".repeat(64) } : window) } }, context)).toThrow(/authenticated retained source/);
      expect(fixture.eventLogs[rollback ? 1 : 0]).toContain(`"point":"${point}"`);
      expect(fixture.eventLogs.at(-1)!.split('"point":"before_prepared"').length - 1).toBe(point === "before_prepared" ? 2 : 1);
    } catch (error) { throw new Error(`${point}: ${String(error)}\n${fixture.eventLogs.join("\n")}`); }
    finally { await fixture.cleanup(); await rm(root, { recursive: true, force: true }); }
  }
}, 120_000);

it("uses literal BOM/CRLF/CJK/astral wrapper alias and Markdown title bytes in the fixed installed move closure", async () => {
  const { crashProfile } = await import("../src/installed-runtime/crash-restoration-protocol.js");
  const files = crashProfile("move_note").files;
  expect(Buffer.from(files[2]!.originalBytes!)).toEqual(Buffer.from('﻿# Derived A\r\n你好 🚀 [[Alpha|保留 alias]] and [标题](Alpha.md "untouched title")\r\n'));
  expect(Buffer.from(files[2]!.committedBytes!)).toEqual(Buffer.from('﻿# Derived A\r\n你好 🚀 [[Beta|保留 alias]] and [标题](Beta.md "untouched title")\r\n'));
  expect(Buffer.from(files[3]!.originalBytes!)).toEqual(Buffer.from('# Derived B\n![[Alpha#Heading|保留 embed 🌍]]\n尾部不改\n'));
  expect(Buffer.from(files[3]!.committedBytes!)).toEqual(Buffer.from('# Derived B\n![[Beta#Heading|保留 embed 🌍]]\n尾部不改\n'));
});

it("registers all reachable installed note move closure boundaries, not the obsolete generic barrier", async () => {
  const { installedCrashScenarios } = await import("../src/installed-runtime/crash-restoration-protocol.js");
  expect(installedCrashScenarios.filter(scenario => scenario.startsWith("move_note/")).map(scenario => scenario.slice(10)).sort()).toEqual([
    "before_prepared", "after_prepared", "after_file_mutation:0", "after_file_mutation:1", "after_mutation:0",
    "after_raw_verification", "during_semantic_evidence", "after_semantic_evidence", "after_snapshot", "before_committed", "after_committed",
    "before_rollback", "after_rollback_mutation:0", "after_rollback_mutation:1", "after_rollback_mutation:2",
    "after_rollback_verification", "after_rollback_evidence", "before_rolled_back", "after_rolled_back",
  ].sort());
});

it("restores the complete note move and referrer closure through fixed Node MCP wire after actual termination", async () => {
  const root = await mkdtemp(join(tmpdir(), "move-480-wire-"));
  const fixture = await arrangeNodeCrashWire(root, "move_note", "after_file_mutation:0");
  const moveObserverContext = { runId: fixture.options.runId, candidateBundleSha256: fixture.options.candidate.identity.bundleSha256, installedMainSha256: fixture.options.candidate.identity.files.find(file => file.path === "main.js")!.sha256, profileName: fixture.options.profile.name, observations: [] };
  try {
    const result = await runInstalledCrashRestorationSlice({ ...fixture.options, moveObserverContext });
    expect(result.records[0].observer?.windows).toHaveLength(2);
    expect(result.records[0]).toMatchObject({ mutationKind: "move_note", proofState: "intent_not_applied", cleanupSucceeded: true });
    expect(fixture.eventLogs).toHaveLength(2);
    expect(fixture.eventLogs[0]).toContain('"point":"after_file_mutation:0"');
  } finally { await fixture.cleanup(); await rm(root, { recursive: true, force: true }); }
}, 30_000);

it.each(["unpaired", "missing_referrer", "stale_closure"] as const)("rejects %s after actual move recovery rather than certifying only rename", async fault => {
  const root = await mkdtemp(join(tmpdir(), "move-480-counterexample-"));
  const fixture = await arrangeNodeCrashWire(root, "move_note", "after_snapshot");
  const start = fixture.options.processControl.start;
  let generation = 0;
  try {
    await expect(runInstalledCrashRestorationSlice({ ...fixture.options, processControl: { start: async request => {
      const handle = await start(request);
      if (++generation === 2) {
        if (fault === "unpaired") await writeFile(join(request.vaultPath, "Corpus/Move/Beta.md"), "# Alpha\r\n\r\nSource note body 你好 🚀.\r\nSecond body line.\r\n");
        if (fault === "missing_referrer") await rm(join(request.vaultPath, "Corpus/Move/Derived-B.md"));
        if (fault === "stale_closure") await writeFile(join(request.vaultPath, "Corpus/Move/Derived-A.md"), "# Stale closure\r\n[[Beta]]\r\n");
      }
      return handle;
    } } })).rejects.toThrow("whole-state inventory");
    expect(fixture.eventLogs).toHaveLength(2);
  } finally { await fixture.cleanup(); await rm(root, { recursive: true, force: true }); }
}, 30_000);
