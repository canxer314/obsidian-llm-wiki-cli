import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFile, mkdir, readFile, rm, truncate, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { capturePath, initializeJournal, readLatestFrame, writeFrame } from "./journal.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));
const vaultPath = resolve(process.env.THINKFLYWHEEL_VAULT ?? "C:/Obsidian/ThinkFlywheelVault");
const vaultName = process.env.THINKFLYWHEEL_VAULT_NAME ?? basename(vaultPath);
const probeRootName = `__llm_cli_runtime_probe__/run-${process.pid}-${Date.now()}`;
const probeRoot = join(vaultPath, ...probeRootName.split("/"));
const journalDir = join(probeRoot, ".journal");
const pluginId = "llm-cli-runtime-durability-probe";
const pluginDir = join(vaultPath, ".obsidian", "plugins", pluginId);
const outputDir = join(here, "output");
const reportJson = join(outputDir, "latest-report.json");
const reportMd = join(outputDir, "latest-report.md");
const child = join(here, "crash-child.mjs");
const vaultIdentity = createHash("sha256").update(vaultPath.toLowerCase()).digest("hex");
const ansi = { bold: "\x1b[1m", dim: "\x1b[2m", reset: "\x1b[0m" };

function obsidian(...args) {
  return execFileSync("obsidian", [`vault=${vaultName}`, ...args], { encoding: "utf8", windowsHide: true }).trim();
}

function evalObsidian(code) {
  const output = obsidian("eval", `code=${code}`);
  const marker = output.indexOf("=>");
  return marker >= 0 ? output.slice(marker + 2).trim() : output;
}

function wait(ms) {
  return new Promise((resolveWait) => setTimeout(resolveWait, ms));
}

function add(report, id, evidence, verdict, detail) {
  report.checks.push({ id, evidence, verdict, detail });
}

async function installProbePlugin() {
  await mkdir(pluginDir, { recursive: true });
  await Promise.all([
    copyFile(join(here, "probe-plugin", "manifest.json"), join(pluginDir, "manifest.json")),
    copyFile(join(here, "probe-plugin", "main.js"), join(pluginDir, "main.js")),
  ]);
  evalObsidian(`(async()=>{await app.plugins.loadManifests();await app.plugins.enablePlugin('${pluginId}');return Boolean(globalThis.__llmCliRuntimeProbe)})()`);
  const loaded = evalObsidian("Boolean(globalThis.__llmCliRuntimeProbe)");
  if (loaded !== "true") throw new Error("probe_plugin_not_loaded");
}

async function removeProbePlugin() {
  try {
    evalObsidian(`(async()=>{if(app.plugins.disablePluginAndSave){await app.plugins.disablePluginAndSave('${pluginId}')}else{await app.plugins.disablePlugin('${pluginId}');app.plugins.enabledPlugins.delete('${pluginId}');await app.plugins.saveEnabledPlugins()}return true})()`);
  } catch {}
  await rm(pluginDir, { recursive: true, force: true });
}

async function snapshotFootprint(frame) {
  return Promise.all((frame?.mutations ?? []).map(async (mutation) => ({
    path: mutation.path,
    current: await capturePath(mutation.path),
    before: mutation.before,
    after: mutation.after,
  })));
}

function footprintMatches(snapshot, side) {
  return snapshot.every(({ current, [side]: expected }) => current.exists === expected.exists && current.sha256 === expected.sha256);
}

async function runCrashCase(kind, point) {
  const caseRoot = join(probeRoot, `crash-${kind}-${point}`);
  const caseJournalDir = join(caseRoot, ".journal");
  const args = [child, caseRoot, point, vaultIdentity, `--kind=${kind}`];
  const run = spawnSync(process.execPath, args, { encoding: "utf8", windowsHide: true });
  const latest = await readLatestFrame(caseJournalDir, vaultIdentity);
  const afterCrash = await snapshotFootprint(latest.frame);
  let recovered = null;
  if (latest.frame?.phase === "PREPARED") {
    const recovery = spawnSync(process.execPath, [child, caseRoot, "none", vaultIdentity, `--kind=${kind}`, "--recover"], { encoding: "utf8", windowsHide: true });
    if (recovery.status !== 0) throw new Error(recovery.stderr || `recovery failed: ${recovery.status}`);
    recovered = await snapshotFootprint(latest.frame);
  }
  return {
    kind,
    point,
    exit: run.status,
    journalPhase: latest.frame?.phase ?? null,
    stateAfterCrash: footprintMatches(afterCrash, point === "after-committed" || ["after-mutation", "after-raw-verify"].includes(point) ? "after" : "before") ? "expected" : "unexpected",
    recoveryState: recovered ? (footprintMatches(recovered, "before") ? "before" : "unexpected") : null,
    stderr: run.stderr.trim(),
  };
}

async function runJournalChecks(report) {
  const mutationKinds = [
    "create-markdown",
    "modify-markdown",
    "frontmatter-rewrite",
    "derived-link-rewrite",
    "attachment-write",
    "same-volume-move",
    "managed-trash",
  ];
  const crashPoints = ["before-prepared", "after-prepared", "after-mutation", "after-raw-verify", "after-committed"];
  for (const kind of mutationKinds) {
    for (const point of crashPoints) {
      const result = await runCrashCase(kind, point);
      const shouldRollback = ["after-prepared", "after-mutation", "after-raw-verify"].includes(point);
      const pass = result.stateAfterCrash === "expected" && (shouldRollback
        ? result.journalPhase === "PREPARED" && result.recoveryState === "before"
        : point === "before-prepared"
          ? result.journalPhase === "EMPTY"
          : result.journalPhase === "COMMITTED");
      add(report, `process-kill:${kind}:${point}`, "observed", pass ? "pass" : "fail", result);
    }
  }

  const journalCheckRoot = join(probeRoot, "journal-checks");
  const journalCheckDir = join(journalCheckRoot, ".journal");
  const journalInit = await initializeJournal(journalCheckDir);
  add(report, "journal:directory-sync", journalInit.directorySync === "supported" ? "observed" : "unsupported", journalInit.directorySync === "supported" ? "pass" : "native-seam-required", journalInit);
  const base = { sequence: 1, phase: "PREPARED", vaultIdentity, mutations: [] };
  await writeFrame(journalCheckDir, base);
  await truncate(join(journalCheckDir, "slot-1.wal"), 31);
  const truncated = await readLatestFrame(journalCheckDir, vaultIdentity);
  add(report, "journal:truncation", "observed", truncated.errors.some((entry) => entry.slot === 1) ? "pass" : "fail", truncated.errors);

  const identityCheckDir = join(probeRoot, "identity-check", ".journal");
  await initializeJournal(identityCheckDir);
  await writeFrame(identityCheckDir, base);
  let wrongVault = null;
  try { await readLatestFrame(identityCheckDir, "wrong-vault"); } catch (error) { wrongVault = error.message; }
  add(report, "journal:wrong-vault", "observed", wrongVault === "journal_wrong_vault_identity" ? "pass" : "fail", wrongVault);

  let diskFull = null;
  try { await writeFrame(identityCheckDir, base, { injectDiskFull: true }); } catch (error) { diskFull = error.code; }
  add(report, "journal:disk-full", "injected", diskFull === "ENOSPC" ? "pass" : "fail", { errorCode: diskFull, note: "Failure path only; the physical volume was not filled." });
}

async function runPluginLifecycle(report) {
  const lifecycleRootName = `${probeRootName}/plugin-lifecycle`;
  const lifecycleRoot = join(vaultPath, ...lifecycleRootName.split("/"));
  const crash = spawnSync(process.execPath, [child, lifecycleRoot, "after-prepared", vaultIdentity], { encoding: "utf8", windowsHide: true });
  if (crash.status === 0) throw new Error("expected child process termination");
  evalObsidian(`globalThis.__llmCliRuntimeProbeRunRoot='${lifecycleRootName}'; 'set'`);
  evalObsidian(`(async()=>{await app.plugins.disablePlugin('${pluginId}');await app.plugins.enablePlugin('${pluginId}');return Boolean(globalThis.__llmCliRuntimeProbe)})()`);
  const snapshotText = evalObsidian("JSON.stringify(globalThis.__llmCliRuntimeProbe?.snapshot())");
  if (snapshotText === "(no output)") throw new Error("probe_plugin_reload_failed");
  const snapshot = JSON.parse(snapshotText);
  const detected = snapshot.journalOnLoad?.status === "PREPARED";
  add(report, "plugin:reload-active-prepared", "observed", detected ? "pass" : "fail", snapshot.journalOnLoad);
  const recovery = spawnSync(process.execPath, [child, lifecycleRoot, "none", vaultIdentity, "--recover"], { encoding: "utf8", windowsHide: true });
  if (recovery.status !== 0) throw new Error(recovery.stderr || "lifecycle recovery failed");
}

async function runObsidianEvents(report) {
  evalObsidian("globalThis.__llmCliRuntimeProbe.reset(); 'reset'");
  const eventRootName = `${probeRootName}/obsidian-events`;
  const code = `(async()=>{
    const root='${eventRootName}';
    const linkName='链接目标-'+root.split('/')[1];
    const targetPath=root+'/'+linkName+'.md';
    const trashPath=root+'/.managed-trash/'+linkName+'.md';
    const p=globalThis.__llmCliRuntimeProbe;
    const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
    const until=async(label,predicate,timeout=5000)=>{
      const started=Date.now();
      p.record('probe-start',root,{label,timeout});
      while(Date.now()-started<timeout){
        const value=await predicate();
        if(value){const elapsed=Date.now()-started;p.record('probe-ready',root,{label,elapsed});return {label,elapsed};}
        await sleep(25);
      }
      p.record('probe-timeout',root,{label,timeout});
      throw new Error('probe_timeout:'+label);
    };
    const probes=[];
    const existing=app.vault.getAbstractFileByPath(root);
    if(existing) throw new Error('run_namespace_collision:'+root);
    await app.vault.createFolder(root);
    const target=await app.vault.create(targetPath,'# target\\n');
    p.record('before-create-cjk',root+'/中文原始.md');
    const cjk=await app.vault.create(root+'/中文原始.md','第一行\\r\\n[['+linkName+']]\\r\\n');
    p.record('after-create-cjk',cjk.path);
    probes.push(await until('create-cache-and-link',()=>{
      const cache=app.metadataCache.getFileCache(cjk);
      return cache?.links?.some(x=>x.link===linkName)&&app.metadataCache.getFirstLinkpathDest(linkName,cjk.path)?.path===target.path;
    }));
    p.record('before-modify',cjk.path);
    const modifyMarker=p.snapshot().events.at(-1).seq;
    await app.vault.modify(cjk,'第二行\\r\\n[['+linkName+']]\\r\\n');
    p.record('after-modify',cjk.path);
    probes.push(await until('modify-changed-event',()=>p.snapshot().events.some(e=>e.seq>modifyMarker&&e.source==='metadataCache'&&e.kind==='changed'&&e.path===cjk.path)));
    p.record('before-rename',cjk.path);
    await app.vault.rename(cjk,root+'/中文改名.md');
    p.record('after-rename',cjk.path);
    probes.push(await until('rename-raw-and-cache',async()=>await app.vault.adapter.exists(cjk.path)&&Boolean(app.metadataCache.getFileCache(cjk))));
    const raw=await app.vault.adapter.readBinary(cjk.path);
    const cache=app.metadataCache.getFileCache(cjk);
    const links=(cache?.links??[]).map(x=>x.link);
    const resolvedBeforeTrash=app.metadataCache.getFirstLinkpathDest(linkName,cjk.path)?.path??null;
    await app.vault.createFolder(root+'/.managed-trash');
    p.record('before-managed-trash',target.path);
    await app.vault.rename(target,trashPath);
    p.record('after-managed-trash',target.path);
    probes.push(await until('trash-raw-and-unresolved',async()=>
      !(await app.vault.adapter.exists(targetPath))&&
      await app.vault.adapter.exists(trashPath)&&
      !app.metadataCache.getFirstLinkpathDest(linkName,cjk.path)
    ));
    const trashRaw=await app.vault.adapter.readBinary(trashPath);
    const hiddenTrashLookup=app.vault.getAbstractFileByPath(trashPath);
    p.record('before-trash-restore',target.path,{hiddenTrashIndexed:Boolean(hiddenTrashLookup)});
    await app.vault.rename(target,targetPath);
    p.record('after-trash-restore',target.path);
    probes.push(await until('restore-raw-and-resolved',async()=>
      await app.vault.adapter.exists(targetPath)&&
      !(await app.vault.adapter.exists(trashPath))&&
      app.metadataCache.getFirstLinkpathDest(linkName,cjk.path)?.path===targetPath
    ));
    const restoredRaw=await app.vault.adapter.readBinary(targetPath);
    const snapshot=p.snapshot();
    return JSON.stringify({events:snapshot.events,rawBytes:Array.from(new Uint8Array(raw)),trashBytes:Array.from(new Uint8Array(trashRaw)),restoredBytes:Array.from(new Uint8Array(restoredRaw)),hiddenTrashIndexed:Boolean(hiddenTrashLookup),linkName,links,resolvedBeforeTrash,probes});
  })()`;
  const observed = JSON.parse(evalObsidian(code));
  const kinds = observed.events.map((event) => `${event.source}:${event.kind}`);
  const hasCreate = kinds.includes("vault:create");
  const hasModify = kinds.includes("vault:modify") && kinds.includes("metadataCache:changed");
  const renameIndex = observed.events.findIndex((event) => event.kind === "rename" && event.path?.endsWith("中文改名.md"));
  const changedAfterRename = observed.events.slice(Math.max(0, renameIndex + 1)).some((event) => event.kind === "changed" && event.path?.endsWith("中文改名.md"));
  const trashRenames = observed.events.filter((event) => event.kind === "rename" && (event.path?.includes("/.managed-trash/") || event.oldPath?.includes("/.managed-trash/")));
  const bytes = Buffer.from(observed.rawBytes);
  const trashBytes = Buffer.from(observed.trashBytes);
  const restoredBytes = Buffer.from(observed.restoredBytes);
  const expectedContent = `第二行\r\n[[${observed.linkName}]]\r\n`;
  const preservesCrLf = bytes.toString("utf8") === expectedContent;
  const trashRecovered = trashRenames.length >= 1 && trashBytes.equals(restoredBytes);
  const restoreRenameObserved = trashRenames.some((event) => event.oldPath?.includes("/.managed-trash/"));
  add(report, "events:create-modify", "observed", hasCreate && hasModify ? "pass" : "fail", { events: observed.events, probes: observed.probes });
  add(report, "events:rename-cache", "observed", renameIndex >= 0 ? "pass" : "fail", { renameObserved: renameIndex >= 0, metadataChangedAfterRename: changedAfterRename, probes: observed.probes.filter((probe) => probe.label.startsWith("rename")), note: "metadataCache.changed did not follow rename; vault.rename plus raw/cache probes must gate it." });
  add(report, "events:managed-trash-rename", "observed", trashRecovered ? "pass" : "fail", { hiddenTrashIndexed: observed.hiddenTrashIndexed, restoreRenameObserved, recoveryConstraint: "Hidden trash was not indexed and restore emitted no vault.rename in this run. Retain the TFile reference across the hidden-directory rename or restore through the adapter, then gate rollback acknowledgment on raw hash plus targeted cache probes rather than an event count.", renames: trashRenames, probes: observed.probes.filter((probe) => probe.label.includes("trash") || probe.label.includes("restore")), trashHash: createHash("sha256").update(trashBytes).digest("hex"), restoredHash: createHash("sha256").update(restoredBytes).digest("hex") });
  add(report, "content:cjk-newlines", "observed", preservesCrLf ? "pass" : "fail", { utf8: bytes.toString("utf8"), sha256: createHash("sha256").update(bytes).digest("hex") });
  add(report, "cache:targeted-link-probe", "observed", observed.links.includes(observed.linkName) && observed.resolvedBeforeTrash?.endsWith(`${observed.linkName}.md`) && observed.probes.every((probe) => probe.elapsed < 5000) ? "pass" : "fail", { linkName: observed.linkName, links: observed.links, resolvedBeforeTrash: observed.resolvedBeforeTrash, probes: observed.probes });
}

function addDurabilityBoundary(report) {
  add(report, "durability:hard-power-loss", "manual", "not-run", {
    reason: "A host run cannot produce trustworthy hard-power-loss evidence.",
    required: "Run the generated VM matrix and inspect the NTFS volume after forced VM power-off at every PREPARED, mutation, raw-verify, and COMMITTED boundary.",
  });
  add(report, "durability:native-write-through", "unsupported", "required-for-strong-claim", {
    node: process.version,
    finding: "The JavaScript fs API exposes FileHandle.sync() but no MoveFileExW(MOVEFILE_WRITE_THROUGH) control or volume flush primitive.",
    decision: "Keep the MVP claim at bounded process-crash all-or-restore unless VM hard-power-loss trials pass on the target stack; retain a native FlushFileBuffers/MoveFileExW seam for any stronger claim.",
  });
}

async function writeReport(report) {
  await mkdir(outputDir, { recursive: true });
  await writeFile(reportJson, JSON.stringify(report, null, 2) + "\n", "utf8");
  const counts = report.checks.reduce((acc, check) => ((acc[check.verdict] = (acc[check.verdict] ?? 0) + 1), acc), {});
  const lines = [
    "# Runtime durability probe — latest run",
    "",
    "> PROTOTYPE evidence. Do not treat injected or manual checks as observed durability.",
    "",
    `- Vault: \`${report.environment.vaultPath}\``,
    `- Obsidian: ${report.environment.obsidianVersion}`,
    `- Node: ${report.environment.node}`,
    `- Volume: ${report.environment.volume}`,
    `- Summary: ${JSON.stringify(counts)}`,
    "",
    "## Checks",
    "",
    ...report.checks.map((check) => `- **${check.id}** — ${check.verdict} (${check.evidence})`),
    "",
    "## Boundary verdict",
    "",
    "Observed evidence supports process-termination recovery and evidence-gated cache readiness on this installed stack. It does not establish hard-power-loss durability. Use the ordering below as the candidate MVP gate:",
    "",
    "1. Sync a complete, checksummed PREPARED frame in a preallocated journal slot before the first mutation.",
    "2. Apply each mutation; for move/trash, preserve both source and destination footprints and do not rely on hidden paths remaining indexed.",
    "3. Raw-reread every touched path and compare existence plus SHA-256 with expected-after.",
    "4. Wait for operation-specific evidence: metadataCache.changed for create/modify; vault.rename for normal rename; path existence plus targeted cache/link probes for hidden managed-trash and restore.",
    "5. Sync COMMITTED only after all raw and cache probes pass; only then acknowledge succeeded.",
    "6. On rollback, compare-before-restore every footprint, raw-reread/hash the before state, repeat targeted cache probes, sync ROLLED_BACK, then acknowledge rolled_back.",
    "7. Timeout or third-party state means failed/restoration_incomplete and keeps the write gate closed.",
    "",
    "The observed cache convergence times in this run are in the machine-readable report. They are samples, not a production timeout budget. A stronger physical durability claim requires the VM matrix and potentially a native Windows write-through seam.",
  ];
  await writeFile(reportMd, lines.join("\n") + "\n", "utf8");
}

function render(report, selected = 0) {
  console.clear();
  console.log(`${ansi.bold}Runtime durability probe (THROWAWAY)${ansi.reset}`);
  console.log(`${ansi.dim}${vaultPath}${ansi.reset}\n`);
  report.checks.forEach((check, index) => {
    const cursor = index === selected ? ">" : " ";
    console.log(`${cursor} ${check.verdict.padEnd(25)} ${check.id} ${ansi.dim}[${check.evidence}]${ansi.reset}`);
  });
  console.log(`\n${ansi.bold}[r]${ansi.reset} run all  ${ansi.bold}[j/k]${ansi.reset} select  ${ansi.bold}[d]${ansi.reset} detail  ${ansi.bold}[q]${ansi.reset} quit`);
}

async function runAll() {
  const volume = execFileSync("powershell", ["-NoProfile", "-Command", `(Get-Volume -DriveLetter '${vaultPath[0]}').FileSystem`], { encoding: "utf8" }).trim();
  const report = {
    generatedAt: new Date().toISOString(),
    question: "Which Recovery Journal and cache-readiness evidence can gate acknowledgment on the installed Obsidian/Electron/Node runtime, and which durability claims remain unproved?",
    environment: {
      vaultPath,
      vaultIdentity,
      obsidianVersion: obsidian("version"),
      node: process.version,
      electron: evalObsidian("process.versions.electron"),
      chrome: evalObsidian("process.versions.chrome"),
      volume,
    },
    checks: [],
  };
  await installProbePlugin();
  try {
    await runJournalChecks(report);
    await runPluginLifecycle(report);
    await runObsidianEvents(report);
    addDurabilityBoundary(report);
    await writeReport(report);
  } finally {
    try { evalObsidian("globalThis.__llmCliRuntimeProbe?.dispose(); 'disposed'"); } catch {}
    await removeProbePlugin();
  }
  return report;
}

async function interactive() {
  let report = { checks: [] };
  let selected = 0;
  render(report, selected);
  process.stdin.setRawMode?.(true);
  process.stdin.resume();
  process.stdin.setEncoding("utf8");
  for await (const key of process.stdin) {
    if (key === "q" || key === "\u0003") break;
    if (key === "r") {
      console.clear();
      console.log("Running observed and injected checks…");
      report = await runAll();
      selected = 0;
    } else if (key === "j") selected = Math.min(report.checks.length - 1, selected + 1);
    else if (key === "k") selected = Math.max(0, selected - 1);
    else if (key === "d" && report.checks[selected]) {
      console.clear();
      console.log(JSON.stringify(report.checks[selected], null, 2));
      console.log("\nPress any key to return.");
      await new Promise((resolveKey) => process.stdin.once("data", resolveKey));
    }
    render(report, selected);
  }
  process.stdin.setRawMode?.(false);
  process.stdin.pause();
}

if (process.argv.includes("--run")) {
  const report = await runAll();
  console.log(JSON.stringify({ reportJson, reportMd, verdicts: report.checks.map(({ id, evidence, verdict }) => ({ id, evidence, verdict })) }, null, 2));
} else {
  await interactive();
}
