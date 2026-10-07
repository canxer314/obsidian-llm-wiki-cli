import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { loadInstalledRuntimeAcceptanceDescriptor, isPathInside } from "./acceptance-driver-protocol.js";
import { EVENT_OBSERVER_ID, pluginEventObserverBindingSchema, type PluginEventObserverBinding } from "./plugin-event-observer.js";
import { readPersistedBridgeIdentity } from "./obsidian-process.js";

export const OBSERVER_CONFIG_FILE = "event-observer.json";
export const OBSERVER_REQUIRED_FILE = "event-observer-required.json";
export const OBSERVER_GLOBAL_KEY = "llm-wiki.correctness-event-observer.v1";

/** Independent enabled community plugin, not a Bridge collaborator or MCP client.
 * Synchronous readFileSync happens in the actual Obsidian callback stack, before
 * yielding to any later mutation. No cachedRead, Search Snapshot, or deferred reads.
 */
export const EVENT_OBSERVER_PLUGIN_SOURCE = String.raw`
const { Plugin } = require("obsidian");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
module.exports = class EventObserver extends Plugin {
  async onload() {
    const base = fs.realpathSync(this.app.vault.adapter.getBasePath());
    if (!path.basename(base).startsWith("installed-runtime-vault-")) throw Error("Observer requires generated Vault");
    const configPath = path.join(base, this.app.vault.configDir, "plugins", this.manifest.id, "event-observer.json");
    const c = JSON.parse(fs.readFileSync(configPath, "utf8"));
    if (c.binding.vaultPath !== base || c.observerId !== this.manifest.id || c.binding.observerMainSha256 !== crypto.createHash("sha256").update(fs.readFileSync(path.join(path.dirname(configPath), "main.js"))).digest("hex")) throw Error("Observer binding changed");
    const report = fs.realpathSync(c.reportDirectory);
    if (!report.startsWith(path.dirname(base) + path.sep) || report.startsWith(base + path.sep)) throw Error("Observer report must be outside generated Vault");
    const output = path.join(report, "observer-generation-" + c.binding.generation + ".jsonl");
    const fd = fs.openSync(output, "wx", 0o600);
    let sequence = 0, closed = false, sealed = false, candidateStarted = false, begun = false, boundVaultId = null;
    const sealedOutput = path.join(report, "observer-generation-" + c.binding.generation + ".sealed.jsonl");
    const identity = { ...c.binding }; delete identity.capabilityToken;
    const emit = (event) => {
      if (closed) throw Error("Observer is stopped");
      const payload = { ...identity, vaultId: boundVaultId, pid: process.pid, sequence: ++sequence, at: Date.now(), ...event };
      const mac = crypto.createHmac("sha256", c.binding.capabilityToken).update(JSON.stringify(payload)).digest("hex");
      fs.writeSync(fd, JSON.stringify({ payload, mac }) + "\n"); fs.fsyncSync(fd);
      if (sealed && event.kind === "failure") fs.writeFileSync(sealedOutput + ".failed", "failed", { mode: 0o600 });
    };
    const capture = (kind, file, oldPath) => {
      try {
        const p = typeof file === "string" ? file : file.path;
        if (!p || p.includes("\\") || p.startsWith("/") || p.split("/").includes("..")) throw Error("Unsafe callback path");
        const absolute = path.join(base, ...p.split("/"));
        let presence = "absent", rawBytesBase64;
        try {
          const facts = fs.lstatSync(absolute);
          if (facts.isSymbolicLink() || !fs.realpathSync(absolute).startsWith(base + path.sep)) throw Error("Escaped callback path");
          if (facts.isDirectory()) presence = "directory";
          else { presence = "file"; rawBytesBase64 = fs.readFileSync(absolute).toString("base64"); }
        } catch (error) { if (error.code !== "ENOENT") throw error; }
        emit({ kind, path: p, ...(oldPath === undefined ? {} : {oldPath}), presence, ...(rawBytesBase64 === undefined ? {} : {rawBytesBase64}) });
      } catch { emit({ kind: "failure" }); }
    };
    for (const kind of ["create", "modify", "rename", "delete"]) this.registerEvent(this.app.vault.on(kind, (file, oldPath) => capture(kind, file, oldPath)));
    this.registerEvent(this.app.metadataCache.on("changed", file => capture("changed", file)));
    this.registerEvent(this.app.metadataCache.on("resolved", () => { for (const file of this.app.vault.getFiles()) capture("resolved", file); }));
    const enabledPlugins = JSON.parse(fs.readFileSync(path.join(base, this.app.vault.configDir, "community-plugins.json"), "utf8"));
    emit({ kind: "ready", listeners: ["create", "modify", "rename", "delete", "changed", "resolved"], enabledPlugins });
    const state = { pid: process.pid, generation: c.binding.generation, runId: c.binding.runId, vaultPath: base, candidateBundleSha256: c.binding.candidateBundleSha256, installedMainSha256: c.binding.installedMainSha256, observerMainSha256: c.binding.observerMainSha256, capabilityToken: c.binding.capabilityToken,
      candidateStart: () => { if (candidateStarted) throw Error("Candidate already started"); candidateStarted = true; emit({kind: "candidate-start"}); },
      begin: vaultId => { if (!candidateStarted || begun) throw Error("Observer begin sequence invalid"); begun = true; boundVaultId = vaultId; emit({kind: "window-begin"}); for (const file of this.app.vault.getFiles()) capture("snapshot", file); },
      end: () => { if (!begun || sealed) throw Error("Observer window end sequence invalid"); emit({kind: "window-end"}); fs.copyFileSync(output, sealedOutput, fs.constants.COPYFILE_EXCL); sealed = true; } };
    const registry = globalThis[Symbol.for("llm-wiki.correctness-event-observer.v1")] ||= new Map();
    if (registry.has(base)) throw Error("Duplicate observer instance");
    registry.set(base, state);
    const heartbeat = setInterval(() => emit({ kind: "heartbeat" }), 100);
    const commandPath = path.join(path.dirname(configPath), "window-command.json");
    let lastCommand = 0;
    const timer = setInterval(() => {
      try {
        const command = JSON.parse(fs.readFileSync(commandPath, "utf8"));
        if (command.sequence <= lastCommand) return;
        const commandIdentityPath = path.join(base, this.app.vault.configDir, "plugins", c.candidatePluginId, "data.json");
        const managedIdentity = JSON.parse(fs.readFileSync(commandIdentityPath, "utf8"));
        if (managedIdentity.vaultId !== command.vaultId) throw Error("Observer command Managed Vault identity changed");
        if (command.sequence !== lastCommand + 1 || command.capabilityToken !== c.binding.capabilityToken || command.generation !== c.binding.generation || command.runId !== c.binding.runId) throw Error("Observer command binding changed");
        lastCommand = command.sequence;
        if (command.action === "begin") state.begin(command.vaultId);
        else if (command.action === "end") state.end();
        else throw Error("Unknown observer command");
      } catch (error) { if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) { emit({kind: "failure"}); clearInterval(timer); } }
    }, 25);
    this.register(() => { clearInterval(timer); clearInterval(heartbeat); registry.delete(base); emit({kind: "stopped"}); closed = true; fs.closeSync(fd); });
  }
};
`;

export async function installPluginEventObserver(options: {
  vaultPath: string; configDirectoryName?: string; reportDirectory: string;
  binding: Omit<PluginEventObserverBinding, "observerMainSha256" | "capabilityToken">;
  candidatePluginId: string;
}): Promise<{ binding: PluginEventObserverBinding; directory: string }> {
  const vaultPath = await realpath(options.vaultPath);
  if (!basename(vaultPath).startsWith("installed-runtime-vault-")) throw new Error("Observer requires a generated Vault");
  const reportDirectory = resolve(options.reportDirectory);
  if (!isPathInside(resolve(vaultPath, ".."), reportDirectory) || isPathInside(vaultPath, reportDirectory)) throw new Error("Observer report must stay outside generated Vault");
  await mkdir(reportDirectory, { recursive: true });
  const configDirectory = join(vaultPath, options.configDirectoryName ?? ".obsidian");
  const plugins = JSON.parse(await readFile(join(configDirectory, "community-plugins.json"), "utf8")) as unknown;
  if (JSON.stringify(plugins) !== JSON.stringify([options.candidatePluginId])) throw new Error("Correctness observer requires isolated candidate-only starting inventory");
  const directory = join(configDirectory, "plugins", EVENT_OBSERVER_ID);
  await mkdir(directory); // Refuse to replace an existing observer fixture.
  const binding = pluginEventObserverBindingSchema.parse({ ...options.binding, vaultPath,
    observerMainSha256: createHash("sha256").update(EVENT_OBSERVER_PLUGIN_SOURCE).digest("hex"), capabilityToken: randomBytes(32).toString("hex") });
  await writeFile(join(directory, "main.js"), EVENT_OBSERVER_PLUGIN_SOURCE, { flag: "wx" });
  await writeFile(join(directory, "manifest.json"), JSON.stringify({ id: EVENT_OBSERVER_ID, name: "Isolated correctness event observer", version: "1.0.0", minAppVersion: "1.13.0", author: "Vault Bridge acceptance", isDesktopOnly: true }), { flag: "wx" });
  await writeFile(join(directory, OBSERVER_CONFIG_FILE), JSON.stringify({ binding, observerId: EVENT_OBSERVER_ID, candidatePluginId: options.candidatePluginId, reportDirectory }), { flag: "wx", mode: 0o600 });
  await writeFile(join(configDirectory, "plugins", options.candidatePluginId, OBSERVER_REQUIRED_FILE), JSON.stringify({
    runId: binding.runId, vaultPath: binding.vaultPath, candidateBundleSha256: binding.candidateBundleSha256, installedMainSha256: binding.installedMainSha256,
  }), { flag: "wx", mode: 0o600 });
  await writeFile(join(configDirectory, "community-plugins.json"), JSON.stringify([EVENT_OBSERVER_ID, options.candidatePluginId]));
  return { binding, directory };
}

/** Gate only explicitly armed generated correctness runs. Default startup unchanged. */
export async function awaitPluginEventObserverBeforeStartup(options: { vaultPath: string; pluginId: string; configDirectoryName?: string }): Promise<void> {
  if (!basename(resolve(options.vaultPath)).startsWith("installed-runtime-vault-")) return;
  let loaded: Awaited<ReturnType<typeof loadInstalledRuntimeAcceptanceDescriptor>>;
  try { loaded = await loadInstalledRuntimeAcceptanceDescriptor(options); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  let requirement: { runId: string; vaultPath: string; candidateBundleSha256: string; installedMainSha256: string };
  try { requirement = JSON.parse(await readFile(join(loaded.descriptor.vaultPath, options.configDirectoryName ?? ".obsidian", "plugins", options.pluginId, OBSERVER_REQUIRED_FILE), "utf8")) as typeof requirement; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  if (requirement.runId !== loaded.descriptor.runId || requirement.vaultPath !== loaded.descriptor.vaultPath || requirement.candidateBundleSha256 !== loaded.descriptor.candidateBundleSha256 || requirement.installedMainSha256 !== loaded.descriptor.installedMainSha256) throw new Error("Correctness observer requirement binding changed");
  const configPath = join(loaded.descriptor.vaultPath, options.configDirectoryName ?? ".obsidian", "plugins", EVENT_OBSERVER_ID, OBSERVER_CONFIG_FILE);
  let config: { binding: unknown };
  try { config = JSON.parse(await readFile(configPath, "utf8")) as { binding: unknown }; }
  catch { throw new Error("Required correctness observer configuration unavailable"); }
  const binding = pluginEventObserverBindingSchema.parse(config.binding);
  if (binding.runId !== loaded.descriptor.runId || binding.vaultPath !== loaded.descriptor.vaultPath || binding.candidateBundleSha256 !== loaded.descriptor.candidateBundleSha256 || binding.installedMainSha256 !== loaded.descriptor.installedMainSha256) throw new Error("Correctness observer is not candidate/run bound");
  if (binding.vaultId !== null) {
    const managed = await readPersistedBridgeIdentity(binding.vaultPath, options.pluginId, options.configDirectoryName);
    if (managed?.vaultId !== binding.vaultId) throw new Error("Correctness recovery observer Managed Vault identity changed");
  }
  const observerBytes = await readFile(join(loaded.descriptor.vaultPath, options.configDirectoryName ?? ".obsidian", "plugins", EVENT_OBSERVER_ID, "main.js"));
  if (createHash("sha256").update(observerBytes).digest("hex") !== binding.observerMainSha256) throw new Error("Correctness observer plugin bytes changed");
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const registry = (globalThis as Record<symbol, Map<string, PluginEventObserverBinding & { pid: number; candidateStart(): void }> | undefined>)[Symbol.for(OBSERVER_GLOBAL_KEY)];
    const state = registry?.get(binding.vaultPath);
    if (state !== undefined) {
      if (state.pid !== process.pid || state.generation !== binding.generation || state.runId !== binding.runId || state.candidateBundleSha256 !== binding.candidateBundleSha256 || state.installedMainSha256 !== binding.installedMainSha256 || state.observerMainSha256 !== binding.observerMainSha256 || state.capabilityToken !== binding.capabilityToken) throw new Error("Correctness observer did not register in this candidate process generation");
      state.candidateStart();
      if (binding.vaultId !== null) (state as typeof state & { begin(vaultId: string): void }).begin(binding.vaultId);
      return;
    }
    await new Promise(resolvePromise => setTimeout(resolvePromise, 25));
  }
  throw new Error("Correctness observer was not active before startup recovery");
}
