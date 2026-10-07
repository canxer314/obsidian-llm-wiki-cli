import { parseChangeSetStatusResult, parseChangeSetSubmitResult, serializeChangeSetStatusCompatibilityText, serializeChangeSetSubmitCompatibilityText } from "@llm-wiki/vault-contracts";
import { activateInstalledRuntimeAcceptanceDriver, createInstalledRuntimeAcceptanceDescriptor } from "../src/installed-runtime/smoke-command.js";
import { requestInstalledCrashRestorationScenario, parseCrashRestorationCommand } from "../src/installed-runtime/crash-restoration-protocol.js";
import { mkdtemp, mkdir, readdir, open, rm, symlink, writeFile, lstat, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { crashRestorationBoundaryPath, loadCrashBoundaryReport, writeCrashRestorationBoundaryReport } from "../src/installed-runtime/crash-restoration-protocol.js";
import { openRecoveryJournal } from "../src/recovery-journal.js";
import { readInstalledCrashJournal, runInstalledCrashRestorationSlice } from "../src/installed-runtime/installed-crash-restoration-slice.js";
import { brandVerifiedCandidateBundle, inspectCandidateBundle } from "../src/installed-runtime/candidate-bundle.js";
import { ObsidianProcessError } from "../src/installed-runtime/obsidian-process.js";
import type { InstalledCrashRestorationSliceOptions } from "../src/installed-runtime/installed-crash-restoration-slice.js";

async function arrangeNodeCrashWire(root: string, mutationKind: import("../src/installed-runtime/crash-restoration-protocol.js").InstalledCrashKind, crashPoint: import("../src/installed-runtime/crash-restoration-protocol.js").InstalledCrashPoint, observerFault?: "halfwrite-event" | "replay-second-rewrite") {
  const { spawn } = await import("node:child_process");
  const { readFile } = await import("node:fs/promises");
  const { createServer } = await import("node:net");
  const { buildOwningProcessBundle } = await import("../src/corpus/crash-corpus-runner.js");
  const { createLoopbackMcpClient } = await import("../src/installed-runtime/loopback-client.js");
  const { waitForCondition } = await import("../src/installed-runtime/obsidian-process.js");
  const originalBundle = await buildOwningProcessBundle();
  const bundle = join(root, "owning-process-delayed-replay.cjs");
  const raw = await readFile(originalBundle, "utf8");
  const before = raw.match(/await [^\n]+\n            emitTestCallback\("modify", path\);/gu)?.find(text => text.includes("root, path"));
  const after = `if (!globalThis.__mergerDelayedRewriteArmed) {
              const observerConfig = JSON.parse(require("node:fs").readFileSync(require("node:path").join(root, ".obsidian", "plugins", "llm-wiki-event-observer", "event-observer.json"), "utf8"));
              if (observerConfig.binding.generation > 1) {
              globalThis.__mergerDelayedRewriteArmed = true;
              const timer = setInterval(async () => {
                const command = await require("node:fs/promises").readFile(require("node:path").join(root, ".obsidian", "plugins", "llm-wiki-event-observer", "window-command.json"), "utf8").then(JSON.parse).catch(() => null);
                if (command?.action !== "end") return;
                clearInterval(timer);
                await require("node:fs/promises").writeFile(require("node:path").join(root, path), await require("node:fs/promises").readFile(require("node:path").join(root, path)));
                emitTestCallback("modify", path);
              }, 1);
              }
            }`;
  if (before === undefined) throw Error("Pinned Node adapter replay fault hook changed");
  await writeFile(bundle, raw.replace(before, after), { flag: "wx" });
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

// Independent merger counterexamples. No production source is changed.
// The Node observer adapter is not installed Obsidian acceptance evidence.
it("merger rejects a same-bytes replay rewrite arriving after the immediate scan but before authenticated seal", async () => {
  const root = await mkdtemp(join(tmpdir(), "merger-480-delayed-replay-"));
  const fixture = await arrangeNodeCrashWire(root, "move_note", "after_committed", "replay-second-rewrite");
  const context = { runId: fixture.options.runId, candidateBundleSha256: fixture.options.candidate.identity.bundleSha256,
    installedMainSha256: fixture.options.candidate.identity.files.find(file => file.path === "main.js")!.sha256,
    profileName: fixture.options.profile.name, observations: [] };
  try {
    let result: Awaited<ReturnType<typeof runInstalledCrashRestorationSlice>> | undefined;
    let failure: unknown;
    try { result = await runInstalledCrashRestorationSlice({ ...fixture.options, moveObserverContext: context }); }
    catch (error) { failure = error; }
    if (result !== undefined) {
      const events = (context.observations[1] as any).verification.events as { payload: { kind: string; path?: string; sequence: number } }[];
      const duplicate = events.find(event => event.payload.kind === "modify" && event.payload.path === "Corpus/Move/Derived-A.md");
      expect(duplicate, "the final authenticated sealed source must contain the real delayed write callback").toBeDefined();
      const evidence = { root, verdict: result.verdict, generation: 2, duplicateSequence: duplicate!.payload.sequence,
        sealedEndSequence: events.at(-1)!.payload.sequence, source: result.records[0].observer!.sourceReports[1] };
      await writeFile(join(root, "counterexample-evidence.json"), JSON.stringify(evidence, null, 2));
      console.log("RETAINED_DELAYED_REPLAY", JSON.stringify(evidence));
    }
    expect(failure, "same-bytes replay rewrite in the authenticated final sealed source must be rejected").toBeDefined();
    expect(String(failure)).toMatch(/duplicate closure rewrite/);
    const sealed = (await readFile(join(root, "reports", "observer-generation-2.sealed.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
    expect(sealed.some(event => event.payload.kind === "modify" && event.payload.path === "Corpus/Move/Derived-A.md")).toBe(true);
    expect(sealed.at(-1).payload.kind).toBe("window-end");
  } finally { await fixture.cleanup(); }
}, 30_000);

it("merger retains an unresolved PREPARED move Journal after observer rejection", async () => {
  const root = await mkdtemp(join(tmpdir(), "merger-480-unresolved-journal-"));
  const fixture = await arrangeNodeCrashWire(root, "move_note", "after_file_mutation:0", "halfwrite-event");
  const context = { runId: fixture.options.runId, candidateBundleSha256: fixture.options.candidate.identity.bundleSha256,
    installedMainSha256: fixture.options.candidate.identity.files.find(file => file.path === "main.js")!.sha256,
    profileName: fixture.options.profile.name, observations: [] };
  let journalPath: string | undefined;
  let stoppedPhase: string | undefined;
  const start = fixture.options.processControl.start;
  const cleanupRecords: unknown[] = [];
  try {
    await expect(runInstalledCrashRestorationSlice({ ...fixture.options, moveObserverContext: context,
      record: (kind, _name, detail) => { if (kind === "cleanup") cleanupRecords.push(detail); },
      processControl: { start: async request => {
        journalPath = join(request.vaultPath, ".llm-wiki", "recovery-journal.bin");
        const handle = await start(request);
        return { ...handle, stop: async () => {
          await handle.stop();
          stoppedPhase = (await readInstalledCrashJournal(journalPath!)).phase;
          // Preserve the real unresolved recovery input outside the runner's deletion scope.
          const { cp } = await import("node:fs/promises");
          await cp(request.vaultPath, join(root, "retained-unresolved-vault"), { recursive: true, errorOnExist: true, force: false });
          console.log("RETAINED_PREPARED_JOURNAL", JSON.stringify({ phase: stoppedPhase, actualJournalPath: journalPath, preservedVault: join(root, "retained-unresolved-vault") }));
        } };
      } },
    })).rejects.toThrow(/complete before\/after/);
    expect(stoppedPhase).toBe("PREPARED");
    expect(await lstat(journalPath!).then(() => true).catch(() => false), "unresolved Journal must remain after a failed move observer window").toBe(true);
    expect((await readInstalledCrashJournal(journalPath!)).phase).toBe("PREPARED");
    const vaultPath = join(journalPath!, "..", "..");
    expect(await lstat(join(vaultPath, ".obsidian", "plugins", "crash-plugin", "installed-runtime-acceptance.json")).then(() => true).catch(() => false)).toBe(true);
    expect(await readdir(join(vaultPath, ".llm-wiki", "staging"))).not.toHaveLength(0);
    expect(cleanupRecords).toEqual([expect.objectContaining({ attempted: false, cleanupSucceeded: false, rootsRetained: true, journal: { verified: true, phase: "PREPARED" } })]);
  } finally { await fixture.cleanup(); }
}, 30_000);
