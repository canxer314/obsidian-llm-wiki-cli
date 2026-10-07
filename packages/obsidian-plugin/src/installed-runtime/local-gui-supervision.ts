import { readFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { hasBoundInstalledCrashRecoveryPark } from "./crash-restoration-protocol.js";
import type { ObservedRuntimeEnvironment } from "./runtime-profile.js";

export function createSupervisedInstalledRuntimeProbe(probeHost: () => Promise<ObservedRuntimeEnvironment>) {
  return { probe: probeHost, probeRunning: async (request: { vaultPath: string; profileDirectory: string }): Promise<ObservedRuntimeEnvironment> => ({ ...await probeHost(), ...await confirmGeneratedVaultTrust({ ...request, timeoutMs: 30_000 }) }) };
}

export interface SupervisedRuntimeVersions {
  readonly obsidianVersion: string;
  readonly electronVersion: string;
  readonly nodeVersion: string;
}

class GuiSupervisionIdentityError extends Error {}

/** Local GUI supervision restricted to a generated acceptance profile. */
export async function confirmGeneratedVaultTrust(options: {
  readonly vaultPath: string;
  readonly profileDirectory: string;
  readonly timeoutMs: number;
}): Promise<SupervisedRuntimeVersions> {
  const vaultPath = resolve(options.vaultPath);
  if (!basename(vaultPath).startsWith("installed-runtime-vault-")) {
    throw new Error("GUI trust confirmation requires a generated acceptance Vault");
  }
  const profile = JSON.parse(await readFile(join(options.profileDirectory, "obsidian.json"), "utf8")) as {
    vaults?: Record<string, { path?: string }>;
  };
  const vaults = Object.values(profile.vaults ?? {});
  if (vaults.length !== 1 || vaults[0]?.path !== vaultPath) {
    throw new Error("GUI supervision profile does not exclusively bind the generated acceptance Vault");
  }
  const enabled = JSON.parse(await readFile(join(vaultPath, ".obsidian", "community-plugins.json"), "utf8")) as unknown;
  if (!Array.isArray(enabled) || enabled.length !== 1 || typeof enabled[0] !== "string") {
    throw new Error("GUI supervision requires exactly one enabled candidate plugin");
  }
  const pluginId = enabled[0];
  const recoveryParked = await hasBoundInstalledCrashRecoveryPark(vaultPath, pluginId);
  const runtimeVersionsExpression = "({obsidianVersion:JSON.parse(require('fs').readFileSync(require('path').join(process.resourcesPath,'obsidian.asar','package.json'),'utf8')).version,electronVersion:process.versions.electron,nodeVersion:process.versions.node})";
  const deadline = Date.now() + options.timeoutMs;
  while (Date.now() < deadline) {
    let port: number;
    try {
      port = Number((await readFile(join(options.profileDirectory, "DevToolsActivePort"), "utf8")).split("\n")[0]);
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid GUI supervision port");
      const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1_000) });
      const targets = await response.json() as Array<{ type: string; url: string; webSocketDebuggerUrl: string }>;
      const target = targets.find(({ type, url }) => type === "page" && url.startsWith("app://obsidian.md"));
      if (target === undefined) throw new Error("GUI renderer unavailable");
      const debuggerUrl = new URL(target.webSocketDebuggerUrl);
      if (debuggerUrl.protocol !== "ws:" || debuggerUrl.hostname !== "127.0.0.1" ||
          debuggerUrl.port !== String(port)) {
        throw new GuiSupervisionIdentityError("GUI renderer debugger escaped the supervised loopback port");
      }
      const socket = new WebSocket(debuggerUrl);
      try {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("GUI supervision connection timed out")), 1_000);
          socket.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
          socket.addEventListener("error", () => { clearTimeout(timer); reject(new Error("GUI supervision connection failed")); }, { once: true });
        });
        const result = await new Promise<{ result?: { result?: { value?: unknown }; exceptionDetails?: unknown } }>((resolve, reject) => {
          const timer = setTimeout(() => {
            socket.removeEventListener("message", onMessage);
            reject(new Error("GUI confirmation timed out"));
          }, 1_000);
          const onMessage = (event: MessageEvent): void => {
            let response;
            try { response = JSON.parse(String(event.data)); } catch { return; }
            if (response?.id !== 1) return;
            clearTimeout(timer);
            socket.removeEventListener("message", onMessage);
            if (response.error !== undefined) {
              reject(new GuiSupervisionIdentityError("GUI evaluation was rejected"));
              return;
            }
            resolve(response);
          };
          socket.addEventListener("message", onMessage);
          socket.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: {
            expression: recoveryParked
              ? `(()=>{if(typeof app==='undefined'||!app.vault?.adapter)return 'waiting';if(app.vault.adapter.getBasePath()!==${JSON.stringify(vaultPath)})throw Error('Wrong acceptance Vault');return ${runtimeVersionsExpression};})()`
              : `(()=>{if(typeof app==='undefined'||!app.vault?.adapter)return 'waiting';if(app.vault.adapter.getBasePath()!==${JSON.stringify(vaultPath)})throw Error('Wrong acceptance Vault');const button=[...document.querySelectorAll('.modal button')].find(b=>b.textContent==='Trust author and enable plugins');if(button){button.click();return 'waiting';}if(!app.plugins?.plugins)return 'waiting';return Object.keys(app.plugins.plugins).length===1&&app.plugins.plugins[${JSON.stringify(pluginId)}]&&app.vault.getMarkdownFiles().every(f=>app.metadataCache.getFileCache(f)!==null)?${runtimeVersionsExpression}:'waiting';})()`,
            returnByValue: true,
          } }));
        });
        if (result.result?.exceptionDetails !== undefined) throw new GuiSupervisionIdentityError("GUI Vault identity verification failed");
        const value = result.result?.result?.value;
        if (value !== "waiting") {
          if (typeof value !== "object" || value === null ||
              !["obsidianVersion", "electronVersion", "nodeVersion"].every(key =>
                typeof (value as Record<string, unknown>)[key] === "string" &&
                /^\d+\.\d+\.\d+$/u.test((value as Record<string, string>)[key]!))) {
            throw new GuiSupervisionIdentityError("GUI runtime versions are unavailable");
          }
          return value as SupervisedRuntimeVersions;
        }
      } finally { socket.close(); }
    } catch (error) {
      if (error instanceof GuiSupervisionIdentityError) throw error;
      // Renderer/profile initialization may not have completed yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Generated acceptance Vault local trust confirmation timed out");
}
