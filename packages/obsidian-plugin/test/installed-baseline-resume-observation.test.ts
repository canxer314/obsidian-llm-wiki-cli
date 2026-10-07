import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { expect, it } from "vitest";
import { createBridgeInstance } from "../src/bridge-instance.js";
import { createChangeSetSemanticEvidenceTracker, createFileSystemChangeSetExecutionAdapter, createNodeFileSystemChangeSetHost } from "../src/file-system-change-set-execution.js";
import { contentVersion } from "../src/content-version.js";
import { parseChangeSetSubmitResult } from "@llm-wiki/vault-contracts";
import { observeInstalledBaselinePreconditions, bindInstalledBlockedRecoveryIntent, observeInstalledRecoveryHistory, observeInstalledRecoveryTransition, observeInstalledRecoveryContinuation, observeInstalledRecoveryDiagnosticSources } from "../src/installed-runtime/installed-baseline-resume-observation.js";

// Actual loopback MCP and disk FAILED Journal; no local baseline/resume invocation.
async function failedFixture() {
  const root = await mkdtemp(join(tmpdir(), "baseline-observation-"));
  const vaultPath = join(root, "installed-runtime-vault-observation");
  const stateDirectory = join(vaultPath, ".llm-wiki");
  await mkdir(stateDirectory, { recursive: true });
  const bytes = Buffer.from("# Failed restoration evidence\n");
  await writeFile(join(vaultPath, "blocked.md"), bytes, { flag: "wx" });
  const tracker = createChangeSetSemanticEvidenceTracker({ publishSuccessorSearchSnapshot: async () => undefined,
    deadlineMs: 1, probes: { cacheVisible: async () => true, referenced: async () => false } });
  const host = await createNodeFileSystemChangeSetHost({ basePath: vaultPath, stateDirectory,
    beginSemanticEvidence: request => tracker.begin(request), awaitSemanticEvidence: request => tracker.await(request),
    referenced: async () => true, publishSearchSnapshot: async () => undefined });
  const execution = await createFileSystemChangeSetExecutionAdapter({ journalPath: join(stateDirectory, "recovery-journal.bin"), host, slotCapacity: 16384 });
  const bridge = createBridgeInstance({ port: 0, health: { vault: { id: "observed-vault", name: "fixture", path: vaultPath },
    readiness: { searchSnapshot: "ready", cache: "ready", index: "ready" }, recovery: { state: "none" },
    write: { gate: "open", state: "writable", pauseSource: null }, queue: { currentExecutionId: null, length: 0, headChangeSetId: null },
    lifecycle: { startup: "ready", upgrade: "not_run", migration: "not_run", recovery: "not_run" },
    effectiveGate: null, overall: "healthy", reasonCodes: [], operatorAction: "none" },
    changeSets: { store: { load: async () => undefined, save: async state => {
      await writeFile(join(stateDirectory, "bridge-state.json"), JSON.stringify({ vaultId: "observed-vault", changeSets: state }));
    } }, execution, dataSource: {
      readBinary: path => readFile(join(vaultPath, path)).catch(() => null),
      pathKind: async path => { const facts = await stat(join(vaultPath, path)).catch(() => null); return facts === null ? null : facts.isDirectory() ? "directory" : "file"; },
      isContained: async () => true,
    } } });
  await bridge.start();
  const client = new Client({ name: "baseline-observation", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(bridge.endpoint, { requestInit: { headers: { "X-Expected-Vault-ID": "observed-vault" } } }));
  const input = { submissionKey: `unproven-${randomUUID()}`, operations: [{ operationId: "trash", kind: "trash", path: "blocked.md", targetVersion: contentVersion(bytes) }] };
  const raw = await client.callTool({ name: "vault_change_set_submit", arguments: input });
  if (raw.structuredContent === undefined) throw new Error(JSON.stringify(raw));
  const submitted = parseChangeSetSubmitResult(raw.structuredContent);
  expect(submitted).toMatchObject({ outcome: "registered", changeSet: { state: "result_unproven" } });
  const options = { vaultPath, vaultId: "observed-vault", session: { callTool: async (name: string, arguments_: Record<string, unknown>) => {
    const result = await client.callTool({ name, arguments: arguments_ });
    return { isError: result.isError === true, structuredContent: result.structuredContent, content: result.content as unknown[] };
  } } };
  return { root, stateDirectory, options, input,
    cleanup: async () => { await client.close(); await bridge.stop(); await execution.close?.(); await rm(root, { recursive: true, force: true }); } };
}

it("samples diagnostic source identities from actual wire and disk and rejects a durable key substitution", async () => {
  const fixture = await failedFixture();
  try {
    const actual = await observeInstalledRecoveryDiagnosticSources(fixture.options);
    expect(actual.vaultId).toBe(fixture.options.vaultId);
    expect(actual.changeSets[0]).toMatchObject({ submissionKey: fixture.input.submissionKey, state: "result_unproven", executionPhase: "terminal" });
    expect(actual.journal.frames.some(frame => frame.state === "valid" && frame.phase === "FAILED" && frame.changeSetId === actual.changeSets[0]!.changeSetId)).toBe(true);
    const path = join(fixture.stateDirectory, "bridge-state.json");
    const registry = JSON.parse(await readFile(path, "utf8"));
    registry.changeSets.entries[0].submissionKey = "foreign-durable-key";
    await writeFile(path, JSON.stringify(registry));
    await expect(observeInstalledRecoveryDiagnosticSources(fixture.options)).rejects.toThrow("actual wire terminal or durable key association differs");
  } finally { await fixture.cleanup(); }
});

it("binds a recovery-blocked key and refuses a rewritten historical disposition or replayed execution", async () => {
  const fixture = await failedFixture();
  try {
    const preconditions = await observeInstalledBaselinePreconditions(fixture.options);
    const blocked = await bindInstalledBlockedRecoveryIntent({ ...fixture.options, runId: "history-proof" });
    expect(await observeInstalledRecoveryHistory({ ...fixture.options, terminal: preconditions, blocked })).toMatchObject({ terminalUnchanged: true, blockedKeyUnchanged: true });
    const altered = { ...blocked, terminal: { ...blocked.terminal, changeSetId: "forged-history" } };
    await expect(observeInstalledRecoveryHistory({ ...fixture.options, terminal: preconditions, blocked: altered })).rejects.toThrow("historical");
    const registry = JSON.parse(await readFile(join(fixture.stateDirectory, "bridge-state.json"), "utf8"));
    const entry = registry.changeSets.entries.find((item: { submissionKey: string }) => item.submissionKey === blocked.input.submissionKey);
    entry.execution = { phase: "executing", input: blocked.input };
    await writeFile(join(fixture.stateDirectory, "bridge-state.json"), JSON.stringify(registry));
    await expect(observeInstalledRecoveryHistory({ ...fixture.options, terminal: preconditions, blocked })).rejects.toThrow("re-executed");
  } finally { await fixture.cleanup(); }
});

it("does not treat an accepted report as cleared Journal or recovery release", async () => {
  const fixture = await failedFixture();
  try {
    const preconditions = await observeInstalledBaselinePreconditions(fixture.options);
    await expect(observeInstalledRecoveryTransition({ ...fixture.options, terminal: preconditions, state: "paused" })).rejects.toThrow("independent");
    await expect(observeInstalledRecoveryTransition({ ...fixture.options, terminal: preconditions, state: "writable" })).rejects.toThrow("independent");
  } finally { await fixture.cleanup(); }
});

it("does not submit continuation with the blocked historical key", async () => {
  const fixture = await failedFixture();
  try {
    const blocked = await bindInstalledBlockedRecoveryIntent({ ...fixture.options, runId: "new-key-proof" });
    await expect(observeInstalledRecoveryContinuation({ ...fixture.options, blocked, submissionKey: blocked.input.submissionKey, timeoutMs: 50 })).rejects.toThrow("new Submission Key");
    expect(await stat(join(fixture.options.vaultPath, "RecoveryAuthorityProof", "Continued.md")).catch(() => null)).toBeNull();
  } finally { await fixture.cleanup(); }
});

it("rejects historical replay that leaves raw-byte side effects even with an unchanged wire terminal", async () => {
  const fixture = await failedFixture();
  try {
    const terminal = await observeInstalledBaselinePreconditions(fixture.options);
    const blocked = await bindInstalledBlockedRecoveryIntent({ ...fixture.options, runId: "replay-byte-proof" });
    const session = { callTool: async (name: string, args: Record<string, unknown>) => {
      const result = await fixture.options.session.callTool(name, args);
      if (name === "vault_change_set_submit") await writeFile(join(fixture.options.vaultPath, "blocked.md"), "unexpected replay execution");
      return result;
    } };
    await expect(observeInstalledRecoveryHistory({ ...fixture.options, session, terminal, blocked })).rejects.toThrow("replay changed raw bytes");
  } finally { await fixture.cleanup(); }
});

it("requires the actual durable FAILED Journal to match the live terminal result, not a report's claim", async () => {
  const fixture = await failedFixture();
  try {
    const observed = await observeInstalledBaselinePreconditions(fixture.options);
    expect(observed.terminal).toMatchObject({ state: "result_unproven" });
    await expect(observeInstalledBaselinePreconditions({ ...fixture.options, vaultId: "foreign-vault" })).rejects.toThrow("Vault identity");
    await rm(join(fixture.stateDirectory, "recovery-journal.bin"));
    await expect(observeInstalledBaselinePreconditions(fixture.options)).rejects.toThrow();
  } finally { await fixture.cleanup(); }
});
