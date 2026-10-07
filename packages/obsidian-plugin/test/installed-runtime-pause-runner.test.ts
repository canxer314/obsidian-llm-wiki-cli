import { mkdtemp, mkdir, writeFile, rm, readFile, readdir, stat, rename } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import { brandVerifiedCandidateBundle, inspectCandidateBundle } from "../src/installed-runtime/candidate-bundle.js";
import { manualPauseProofSchema } from "../src/installed-runtime/manual-pause-observation.js";
import { consumeManualPauseProof, manualPauseSourceDigest, type ManualPauseConsumptionContext } from "../src/installed-runtime/manual-pause-source.js";
import { runInstalledManualPauseCorpus } from "../src/installed-runtime/manual-pause-installed-runner.js";
import { createInstalledRuntimeAcceptanceDescriptor, activateInstalledRuntimeAcceptanceDriver } from "../src/installed-runtime/smoke-command.js";
import { createBridgeInstance } from "../src/bridge-instance.js";
import { createLoopbackMcpClient } from "../src/installed-runtime/loopback-client.js";
import { createInstalledFifoObserver } from "../src/installed-runtime/installed-fifo-observer.js";
import { createFileSystemChangeSetExecutionAdapter, createNodeFileSystemChangeSetHost } from "../src/file-system-change-set-execution.js";
import { SearchSnapshotManager } from "../src/search-snapshot.js";
import { VaultDiscoverService } from "../src/vault-discover.js";
import { createStandardDiagnosticBundle } from "../src/diagnostic-bundle.js";
import { randomUUID } from "node:crypto";

import { MVP_PERF_REF_LINUX_1 as profile } from "../src/installed-runtime/runtime-profile.js";

it("refuses a foreign pause descriptor before starting any generated process", async () => {
  const root = await mkdtemp(join(tmpdir(), "pause-runner-"));
  const bundleDirectory = join(root, "candidate");
  await mkdir(bundleDirectory);
  await writeFile(join(bundleDirectory, "manifest.json"), JSON.stringify({ id: "bridge", version: "0.1.0", minAppVersion: "1.0.0" }));
  await writeFile(join(bundleDirectory, "main.js"), "candidate");
  const candidate = brandVerifiedCandidateBundle({ bundleDirectory, identity: await inspectCandidateBundle(bundleDirectory), tag: "v0.1.0", repository: "test/pause", workflowRef: "test", attestationSource: "local-candidate" });
  let starts = 0;
  try {
    await expect(runInstalledManualPauseCorpus({ runId: "pause", workingDirectory: root, reportDirectory: join(root, "reports"), candidate,
      profile, probe: { probe: async () => ({ platform: "linux", capabilities: [] }), probeRunning: async () => { throw new Error("Unexpected probe"); } },
      client: { observeHealth: async () => { throw new Error("Unexpected health"); } },
      processControl: { start: async () => { starts++; throw new Error("Unexpected process start"); } },
      timeouts: { startupMs: 100, stopMs: 100, portClosedMs: 100 }, record: () => {}, assertion: () => {},
      prepareAcceptanceDriver: async request => {
        const created = await createInstalledRuntimeAcceptanceDescriptor({ ...request, runId: "foreign", reportDirectory: request.reportDirectory });
        return { ...created, cleanup: async () => {} };
      },
    })).rejects.toThrow(/descriptor.*bound/u);
    expect(starts).toBe(0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("refuses unregistered profiles before preparing an Operator scene", async () => {
  await expect(runInstalledManualPauseCorpus({ profile: { ...profile, name: "unregistered" } } as never)).rejects.toThrow(/registered/u);
});

// Process/report seam regression, NOT registered installed acceptance. Local
// controls below belong to this test host; the runner has no control callback.
async function wireFixture(mode: "real" | "missing" | "forged" | "foreign-report" | "missing-resume" | "auto-resume" | "stale-report" | "report-root-replaced" | "stop-uncertain" = "real") {
  const root = await mkdtemp(join(tmpdir(), "pause-wire-"));
  const bundleDirectory = join(root, "candidate");
  await mkdir(bundleDirectory);
  await writeFile(join(bundleDirectory, "manifest.json"), JSON.stringify({ id: "bridge", version: "0.1.0", minAppVersion: "1.0.0" }));
  await writeFile(join(bundleDirectory, "main.js"), "test-host-candidate");
  const candidate = brandVerifiedCandidateBundle({ bundleDirectory, identity: await inspectCandidateBundle(bundleDirectory), tag: "v0.1.0", repository: "test/pause", workflowRef: "test", attestationSource: "local-candidate" });
  const descriptors = new Map<string, Awaited<ReturnType<typeof createInstalledRuntimeAcceptanceDescriptor>>>();
  const bridges = new Map<string, ReturnType<typeof createBridgeInstance>>();
  const executions: Awaited<ReturnType<typeof createFileSystemChangeSetExecutionAdapter>>[] = [];
  const jobs: Promise<unknown>[] = [];
  const records: { name: string; detail: unknown }[] = [];
  const healthClient = createLoopbackMcpClient();
  const capture = async (vaultPath: string) => {
    const bridge = bridges.get(vaultPath)!;
    const health = (await healthClient.observeHealth(bridge.endpoint, vaultPath)).health;
    const state = JSON.parse(await readFile(join(vaultPath, ".llm-wiki/bridge-state.json"), "utf8"));
    return createStandardDiagnosticBundle({ vaultId: vaultPath, versions: health.versions,
      health: { readiness: health.readiness, recovery: health.recovery.state, write: health.write,
        effectiveGate: health.effectiveGate?.code ?? null, overall: health.overall, reasonCodes: health.reasonCodes, operatorAction: health.operatorAction },
      listener: health.listener, queue: health.queue, lifecycle: health.lifecycle, journal: { availability: "unavailable", frames: [] },
      changeSets: state.changeSets.entries.map((e: any) => ({ changeSetId: e.changeSetId, submissionKey: e.submissionKey, enqueueSeq: e.enqueueSeq, state: e.changeSet.state, executionPhase: e.execution?.phase ?? null })), machineEvents: [] });
  };
  const context: ManualPauseConsumptionContext = { runId: "pause-wire", candidateBundleSha256: candidate.identity.bundleSha256, installedMainSha256: candidate.identity.files.find(file => file.path === "main.js")!.sha256, profile: profile.name };
  const options = { runId: "pause-wire", retainSource: (source: NonNullable<ManualPauseConsumptionContext["source"]>) => { context.source = structuredClone(source); context.sourceSha256 = manualPauseSourceDigest(source); }, workingDirectory: root, reportDirectory: join(root, "reports"), candidate, profile,
    operatorReportTimeoutMs: 800, timeouts: { startupMs: 1500, stopMs: 1500, portClosedMs: 1500 }, client: healthClient,
    probe: { probe: async () => ({ platform: profile.os.platform, osBuild: profile.os.build, capabilities: profile.capabilities }),
      probeRunning: async () => ({ platform: profile.os.platform, osBuild: profile.os.build, capabilities: profile.capabilities,
        obsidianVersion: profile.versions.obsidian, electronVersion: profile.versions.electron, nodeVersion: profile.versions.node }) },
    prepareAcceptanceDriver: async (request: any) => {
      const created = await createInstalledRuntimeAcceptanceDescriptor({ ...request, runId: "pause-wire" });
      await mkdir(created.descriptor.reportDirectory, { recursive: true });
      if (mode === "stale-report") await writeFile(join(created.descriptor.reportDirectory, "local-write-control-stale.json"), "{}");
      descriptors.set(request.vaultPath, created);
      return { ...created, cleanup: async () => {
        await rm(created.path);
        if (mode === "report-root-replaced" && request.vaultPath.endsWith("vault-a")) {
          await rename(request.reportDirectory, `${request.reportDirectory}.original`);
          await mkdir(request.reportDirectory);
          await writeFile(join(request.reportDirectory, "foreign.txt"), "not owned by this run");
        }
      } };
    }, processControl: { start: async ({ vaultPath }: { vaultPath: string }) => {
      const readBinary = async (path: string) => readFile(join(vaultPath, path)).catch((e: NodeJS.ErrnoException) => { if (e.code === "ENOENT") return null; throw e; });
      const snapshots = new SearchSnapshotManager({ listMarkdownPaths: async () => ["Notes/Welcome.md", "Notes/Linked.md", "ManualPauseProof/Content.md"].filter(path => path !== "Notes/Linked.md"), readBinary,
        semanticEvidence: async () => ({ frontmatter: null, tags: [], headings: [], references: [], resolvedLinks: {}, unresolvedLinks: {} }) });
      await snapshots.rebuild();
      const stateDirectory = join(vaultPath, ".llm-wiki");
      await mkdir(stateDirectory, { recursive: true });
      const host = await createNodeFileSystemChangeSetHost({ basePath: vaultPath, stateDirectory, publishSearchSnapshot: async () => { await snapshots.rebuild(); } });
      const execution = await createFileSystemChangeSetExecutionAdapter({ journalPath: join(stateDirectory, "journal.bin"), host });
      executions.push(execution);
      const observer = await createInstalledFifoObserver({ vaultPath, pluginId: "bridge" });
      const registry = join(stateDirectory, "bridge-state.json");
      const persisted = await readFile(join(vaultPath, ".obsidian/plugins/bridge/data.json"), "utf8").then(JSON.parse).catch(() => null);
      const bridge = createBridgeInstance({ port: persisted?.port ?? 0, health: { vault: { id: vaultPath, name: "private", path: vaultPath },
        readiness: { searchSnapshot: "ready", cache: "ready", index: "ready" }, recovery: { state: "none" },
        write: { gate: "open", state: "writable", pauseSource: null }, queue: { currentExecutionId: null, length: 0, headChangeSetId: null },
        lifecycle: { startup: "ready", upgrade: "not_run", migration: "not_run", recovery: "not_run" }, effectiveGate: null, overall: "healthy", reasonCodes: [], operatorAction: "none" },
        discoverService: new VaultDiscoverService(snapshots), searchSnapshotReadiness: () => snapshots.readiness,
        readDataSource: { readBinary, parseFrontmatter: () => null, headings: () => [] },
        changeSets: { vaultId: vaultPath, execution, ...(observer === undefined ? {} : { acceptanceObserver: observer }),
          store: { load: async () => readFile(registry, "utf8").then(raw => JSON.parse(raw).changeSets).catch((e: NodeJS.ErrnoException) => { if (e.code === "ENOENT") return undefined; throw e; }),
            save: async changeSets => { const next = `${registry}.next`; await writeFile(next, JSON.stringify({ changeSets })); await rename(next, registry); } },
          dataSource: { readBinary, isContained: async () => true, pathKind: async path => { const facts = await stat(join(vaultPath, path)).catch(() => null); return facts === null ? null : facts.isDirectory() ? "directory" : "file"; } } } });
      await bridge.start(); bridges.set(vaultPath, bridge);
      if (await readFile(registry).catch(() => null) === null) await writeFile(registry, JSON.stringify({ changeSets: { schemaVersion: 2, nextEnqueueSeq: 1, entries: [], tombstones: [] } }));
      await writeFile(join(vaultPath, ".obsidian/plugins/bridge/data.json"), JSON.stringify({ vaultId: vaultPath, port: bridge.port }));
      return { pid: 1, stop: async () => { await bridge.stop(); if (mode === "stop-uncertain" && vaultPath.endsWith("vault-b")) throw new Error("Process stop unconfirmed"); } };
    } }, assertion: () => {}, record: (_kind: string, name: string, detail: unknown) => {
      records.push({ name, detail });
      if (!name.endsWith("local-control-report-required") || mode === "missing") return;
      const vaultPath = [...bridges.keys()].find(path => path.endsWith("pause-vault-a"))!;
      const bridge = bridges.get(vaultPath)!;
      const action = name.includes("resume") ? "resume-writes" : "pause-writes";
      if (mode === "missing-resume" && action === "resume-writes") return;
      jobs.push((async () => {
        const before = await capture(vaultPath);
        if (mode !== "forged") {
          if (action === "pause-writes") await bridge.pauseWrites(); else await bridge.resumeWrites();
        }
        const after = mode === "forged" ? before : await capture(vaultPath);
        const activation = await activateInstalledRuntimeAcceptanceDriver({ vaultPath, pluginId: "bridge" });
        const invocationId = randomUUID();
        try { await activation!.recordLocalWriteControl({ vaultId: vaultPath, endpoint: bridge.endpoint, invocationId, action, outcome: "accepted", before, after }); }
        finally { activation?.dispose(); }
        if (mode === "auto-resume" && action === "pause-writes") await bridge.resumeWrites();
        if (mode === "foreign-report") {
          const { createHash } = await import("node:crypto");
          const path = join(descriptors.get(vaultPath)!.descriptor.reportDirectory, `local-write-control-${createHash("sha256").update(invocationId).digest("hex")}.json`);
          const report = JSON.parse(await readFile(path, "utf8"));
          await writeFile(path, JSON.stringify({ ...report, vaultId: "another-vault" }), { mode: 0o600 });
        }
      })());
    } };
  return { options, context, root, records, cleanup: async () => { await Promise.allSettled(jobs); for (const b of bridges.values()) await b.stop(); for (const e of executions) await e.close(); await rm(root, { recursive: true, force: true }); } };
}

it("observes real-wire pausing/drain, retained FIFO, independent resume and Vault B progress through the process/report seam", async () => {
  const fixture = await wireFixture();
  try {
    const proof = await runInstalledManualPauseCorpus(fixture.options);
    expect(proof).toMatchObject({ scope: "manual-pause-drain-and-fifo", verdict: "passed", cleanupSucceeded: true });
    expect(manualPauseProofSchema.safeParse(proof).success).toBe(true);
    expect(manualPauseProofSchema.safeParse({ ...proof, cleanupSucceeded: false }).success).toBe(false);
    expect(manualPauseProofSchema.safeParse({ ...proof, capabilityToken: "c".repeat(64) }).success).toBe(false);
    expect(proof.toolRows.map(row => row.tool)).toEqual(expect.arrayContaining(["vault_health", "vault_discover", "vault_read", "vault_continue", "vault_change_set_submit", "vault_change_set_status"]));
    expect(proof.toolRows.every(row => row.structuredSha256 === row.textSha256)).toBe(true);
    const forged = structuredClone(proof);
    for (const row of forged.toolRows) {
      row.requestSha256 = row.structuredSha256 = row.textSha256 = "0".repeat(64);
      if (row.continuationInSha256 !== null) row.continuationInSha256 = "0".repeat(64);
      if (row.continuationOutSha256 !== null) row.continuationOutSha256 = "0".repeat(64);
    }
    for (const action of forged.localActions) action.beforeSha256 = action.afterSha256 = "0".repeat(64);
    expect(consumeManualPauseProof(proof, fixture.context)).toEqual(proof);
    expect(() => consumeManualPauseProof(forged, fixture.context)).toThrow(/independent actual source/u);
    expect(() => consumeManualPauseProof(proof)).toThrow(/independently retained source/u);
    const changedSource = structuredClone(fixture.context);
    changedSource.source!.localReports[0]!.before = changedSource.source!.localReports[0]!.after;
    expect(() => consumeManualPauseProof(proof, changedSource)).toThrow(/pin/u);
    expect(fixture.records.filter(e => e.name === "manual-pause-observed")).toHaveLength(1);
  } finally { await fixture.cleanup(); }
}, 20000);

it("independently rejects coordinated substitution of actual runner wire digests and continuation association", async () => {
  const fixture = await wireFixture();
  try {
    const proof = await runInstalledManualPauseCorpus(fixture.options);
    expect(manualPauseProofSchema.safeParse(proof).success).toBe(true);
    const forged = structuredClone(proof);
    const substituted = "0".repeat(64);
    for (const row of forged.toolRows) {
      row.requestSha256 = substituted;
      row.structuredSha256 = substituted;
      row.textSha256 = substituted;
      if (row.continuationInSha256 !== null) row.continuationInSha256 = substituted;
      if (row.continuationOutSha256 !== null) row.continuationOutSha256 = substituted;
    }
    for (const action of forged.localActions) {
      action.beforeSha256 = substituted;
      action.afterSha256 = substituted;
    }
    // Neither the real MCP transcript nor the two real local reports changed.
    // Matching public hashes/flags and token endpoints cannot prove that source.
    const retainedContext = structuredClone(fixture.context);
    const retainedPin = retainedContext.sourceSha256;
    expect(consumeManualPauseProof(proof, retainedContext)).toEqual(proof);
    expect(() => consumeManualPauseProof(forged, retainedContext)).toThrow(/independent actual source/u);
    expect(() => consumeManualPauseProof(proof)).toThrow(/independently retained source/u);
    expect(() => consumeManualPauseProof(proof, { ...retainedContext, sourceSha256: substituted })).toThrow(/pin/u);
    const coordinatedSource = structuredClone(retainedContext);
    const changed = coordinatedSource.source!.wire.find(row => row.name === "vault_continue")!;
    changed.arguments.continuation = "substituted-private-token";
    const coordinatedProof = structuredClone(proof);
    for (const row of coordinatedProof.toolRows) {
      if (row.continuationInSha256 !== null) row.continuationInSha256 = substituted;
      if (row.continuationOutSha256 !== null) row.continuationOutSha256 = substituted;
    }
    expect(coordinatedSource.sourceSha256).toBe(retainedPin);
    expect(() => consumeManualPauseProof(coordinatedProof, coordinatedSource)).toThrow(/pin/u);
    expect(retainedContext.sourceSha256).toBe(retainedPin);
    expect(consumeManualPauseProof(proof, retainedContext)).toEqual(proof);
    const publicText = JSON.stringify(proof);
    for (const observation of retainedContext.source!.wire) {
      if (typeof observation.arguments.submissionKey === "string") expect(publicText).not.toContain(observation.arguments.submissionKey);
      if (typeof observation.arguments.continuation === "string") expect(publicText).not.toContain(observation.arguments.continuation);
    }
    expect(publicText).not.toContain("capabilityToken");
    expect(publicText).not.toContain("localReports");
  } finally { await fixture.cleanup(); }
}, 20000);

it("fails closed when no real local pause arrives instead of claiming installed acceptance", async () => {
  const fixture = await wireFixture("missing");
  try {
    await expect(runInstalledManualPauseCorpus(fixture.options)).rejects.toThrow(/timed out|paus/u);
    expect(fixture.records.some(e => e.name === "manual-pause-observed")).toBe(false);
  } finally { await fixture.cleanup(); }
}, 20000);

it.each(["foreign-report", "missing-resume", "stop-uncertain"] as const)("fails closed for %s at the process/report observation seam", async mode => {
  const fixture = await wireFixture(mode);
  try {
    await expect(runInstalledManualPauseCorpus(fixture.options)).rejects.toThrow(/identity|resume-writes|unconfirmed/u);
    expect(fixture.records.some(e => e.name === "manual-pause-observed")).toBe(false);
    if (mode === "stop-uncertain") {
      const cleanup = fixture.records.find(e => e.name === "manual-pause-cleanup")?.detail as { vaults: unknown[] };
      expect(cleanup.vaults).toHaveLength(2);
    }
  } finally { await fixture.cleanup(); }
}, 20000);

it.each(["auto-resume", "stale-report"] as const)("rejects %s rather than trusting local report assertions", async mode => {
  const fixture = await wireFixture(mode);
  try {
    await expect(runInstalledManualPauseCorpus(fixture.options)).rejects.toThrow(/paus|stale/u);
    expect(fixture.records.some(e => e.name === "manual-pause-observed")).toBe(false);
  } finally { await fixture.cleanup(); }
}, 20000);

it("preserves a replaced report root and fails closed on uncertain report cleanup", async () => {
  const fixture = await wireFixture("report-root-replaced");
  try {
    await expect(runInstalledManualPauseCorpus(fixture.options)).rejects.toThrow(/report.*ownership/u);
    expect(await readFile(join(fixture.root, "reports/manual-pause-vault-a/foreign.txt"), "utf8")).toBe("not owned by this run");
    expect(fixture.records.some(e => e.name === "manual-pause-observed")).toBe(false);
  } finally { await fixture.cleanup(); }
}, 20000);

it("fails closed for a fabricated pause report without independently observed live pausing", async () => {
  const fixture = await wireFixture("forged");
  try {
    await expect(runInstalledManualPauseCorpus(fixture.options)).rejects.toThrow(/timed out|paus/u);
    expect(fixture.records.some(e => e.name === "manual-pause-observed")).toBe(false);
  } finally { await fixture.cleanup(); }
}, 20000);
