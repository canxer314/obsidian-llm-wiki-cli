import { runInNewContext } from "node:vm";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { confirmGeneratedVaultTrust } from "../src/installed-runtime/local-gui-supervision.js";

it("observes a recovery-parked generated renderer without waiting for plugin activation or clicking local controls", async () => {
  const root = await mkdtemp(join(tmpdir(), "local-gui-recovery-park-"));
  const vaultPath = join(root, "installed-runtime-vault-park");
  const profileDirectory = join(root, "profile");
  let clicks = 0;
  try {
    await mkdir(join(vaultPath, ".obsidian"), { recursive: true }); await mkdir(profileDirectory);
    await writeFile(join(profileDirectory, "obsidian.json"), JSON.stringify({ vaults: { acceptance: { path: vaultPath } } }));
    await writeFile(join(profileDirectory, "DevToolsActivePort"), "9222\n");
    await writeFile(join(vaultPath, ".obsidian", "community-plugins.json"), '["candidate"]');
    vi.stubGlobal("fetch", async () => ({ json: async () => [{ type: "page", url: "app://obsidian.md/index.html", webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/test" }] }));
    class RendererSocket extends EventTarget {
      constructor() { super(); queueMicrotask(() => this.dispatchEvent(new Event("open"))); }
      send(message: string) {
        const command = JSON.parse(message);
        const value = runInNewContext(command.params.expression, { app: { vault: { adapter: { getBasePath: () => vaultPath } } }, document: { querySelectorAll: () => [{ textContent: "Trust author and enable plugins", click: () => { clicks += 1; } }] }, process: { resourcesPath: "/resources", versions: { electron: "43.3.0", node: "24.18.1" } }, require: (name: string) => name === "path" ? { join: (...parts: string[]) => parts.join("/") } : { readFileSync: () => '{"version":"1.13.7"}' } });
        queueMicrotask(() => this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ id: command.id, result: { result: { value } } }) })));
      }
      close() {}
    }
    vi.stubGlobal("WebSocket", RendererSocket);
    const { createInstalledRuntimeAcceptanceDescriptor } = await import("../src/installed-runtime/smoke-command.js");
    const { crashProfile, crashDigest, writeCrashRestorationBoundaryReport } = await import("../src/installed-runtime/crash-restoration-protocol.js");
    const { openRecoveryJournal } = await import("../src/recovery-journal.js");
    const { open } = await import("node:fs/promises");
    const pluginPath = join(vaultPath, ".obsidian", "plugins", "candidate");
    await mkdir(pluginPath, { recursive: true }); await writeFile(join(pluginPath, "main.js"), "candidate");
    await writeFile(join(pluginPath, "data.json"), JSON.stringify({ vaultId: "park-vault", port: 1234 }));
    const created = await createInstalledRuntimeAcceptanceDescriptor({ vaultPath, pluginId: "candidate", runId: "park", reportDirectory: join(root, "reports"), candidateBundleSha256: "a".repeat(64) });
    await mkdir(created.descriptor.reportDirectory);
    const input = crashProfile("create_note").buildSubmitInput("park");
    const frame = { phase: "PREPARED", vaultId: "park-vault", changeSetId: "park-id", input };
    const command = { sequence: 1, capabilityToken: created.descriptor.capabilityToken, action: "run-crash-restoration-scenario" as const, scenario: "create_note/after_snapshot" as const, expectedVaultId: "park-vault", endpoint: "http://127.0.0.1:1234/mcp", submissionKey: "submission-park", input };
    await writeCrashRestorationBoundaryReport({ descriptor: created.descriptor, command, journalPhase: "PREPARED", frameSha256: crashDigest(frame), inventorySha256: "b".repeat(64) });
    await mkdir(join(vaultPath, ".llm-wiki")); const handle = await open(join(vaultPath, ".llm-wiki", "recovery-journal.bin"), "wx+");
    await (await openRecoveryJournal(handle, { slotCapacity: 4096 })).write({ phase: "PREPARED", payload: frame }); await handle.close();
    await writeFile(created.path, JSON.stringify({ ...created.descriptor, command: { ...command, sequence: 2, scenario: "create_note/before_rolled_back", recovery: { changeSetId: "park-id", frameSha256: crashDigest(frame) } } }));
    await expect(confirmGeneratedVaultTrust({ vaultPath, profileDirectory, timeoutMs: 250 })).resolves.toEqual({ obsidianVersion: "1.13.7", electronVersion: "43.3.0", nodeVersion: "24.18.1" });
    expect(clicks).toBe(0);
    const parkedFrame = { ...frame, phase: "ROLLED_BACK" };
    const recovered = await open(join(vaultPath, ".llm-wiki", "recovery-journal.bin"), "r+");
    await (await openRecoveryJournal(recovered, { slotCapacity: 4096 })).write({ phase: "ROLLED_BACK", payload: parkedFrame }); await recovered.close();
    await writeFile(created.path, JSON.stringify({ ...created.descriptor, command: { ...command, sequence: 2, scenario: "create_note/after_rolled_back", recovery: { changeSetId: "park-id", frameSha256: crashDigest(frame) } } }));
    await writeCrashRestorationBoundaryReport({ descriptor: created.descriptor, command: { ...command, sequence: 2, scenario: "create_note/after_rolled_back", recovery: { changeSetId: "park-id", frameSha256: crashDigest(frame) } }, journalPhase: "ROLLED_BACK", frameSha256: crashDigest(parkedFrame), inventorySha256: "b".repeat(64) });
    await expect(confirmGeneratedVaultTrust({ vaultPath, profileDirectory, timeoutMs: 250 })).resolves.toEqual({ obsidianVersion: "1.13.7", electronVersion: "43.3.0", nodeVersion: "24.18.1" });
    expect(clicks).toBe(0);
  } finally { vi.unstubAllGlobals(); await rm(root, { recursive: true, force: true }); }
});

it("supplies the same actual renderer probe for ordinary Windows/Linux and recovery-parked launches", async () => {
  const { createSupervisedInstalledRuntimeProbe } = await import("../src/installed-runtime/local-gui-supervision.js");
  for (const platform of ["win32", "linux"]) {
    const root = await mkdtemp(join(tmpdir(), "supervised-runtime-probe-"));
    try {
      const vaultPath = join(root, "installed-runtime-vault-proof");
      const profileDirectory = join(root, "profile");
      await mkdir(join(vaultPath, ".obsidian"), { recursive: true }); await mkdir(profileDirectory);
      await writeFile(join(profileDirectory, "obsidian.json"), JSON.stringify({ vaults: { acceptance: { path: vaultPath } } }));
      await writeFile(join(profileDirectory, "DevToolsActivePort"), "9222\n");
      await writeFile(join(vaultPath, ".obsidian", "community-plugins.json"), '["candidate"]');
      vi.stubGlobal("fetch", async () => ({ json: async () => [{ type: "page", url: "app://obsidian.md/index.html", webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/test" }] }));
      class RendererSocket extends EventTarget {
        constructor() { super(); queueMicrotask(() => this.dispatchEvent(new Event("open"))); }
        send() { queueMicrotask(() => this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ id: 1, result: { result: { value: { obsidianVersion: "1.13.7", electronVersion: "43.3.0", nodeVersion: "24.18.1" } } } }) }))); }
        close() {}
      }
      vi.stubGlobal("WebSocket", RendererSocket);
      const probe = createSupervisedInstalledRuntimeProbe(async () => ({ platform, osBuild: "registered", capabilities: [] }));
      expect(await probe.probeRunning({ vaultPath, profileDirectory })).toEqual({ platform, osBuild: "registered", capabilities: [], obsidianVersion: "1.13.7", electronVersion: "43.3.0", nodeVersion: "24.18.1" });
    } finally { vi.unstubAllGlobals(); await rm(root, { recursive: true, force: true }); }
  }
});

it("refuses local GUI supervision for a non-generated Vault", async () => {
  await expect(confirmGeneratedVaultTrust({
    vaultPath: "/home/operator/real-vault", profileDirectory: "/tmp/profile", timeoutMs: 1,
  })).rejects.toThrow("generated acceptance Vault");
});

it("refuses a profile already registered to a different Vault", async () => {
  const root = await mkdtemp(join(tmpdir(), "local-gui-binding-"));
  try {
    const profileDirectory = join(root, "profile");
    await mkdir(profileDirectory);
    await writeFile(join(profileDirectory, "obsidian.json"), JSON.stringify({
      vaults: { personal: { path: "/home/operator/real-vault", open: true } },
    }));
    await expect(confirmGeneratedVaultTrust({
      vaultPath: join(root, "installed-runtime-vault-proof"), profileDirectory, timeoutMs: 1,
    })).rejects.toThrow("profile does not exclusively bind");
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("fails immediately when the supervised renderer rejects the Vault identity", async () => {
  const root = await mkdtemp(join(tmpdir(), "local-gui-identity-"));
  const vaultPath = join(root, "installed-runtime-vault-proof");
  const profileDirectory = join(root, "profile");
  try {
    await mkdir(join(vaultPath, ".obsidian"), { recursive: true });
    await mkdir(profileDirectory);
    await writeFile(join(profileDirectory, "obsidian.json"), JSON.stringify({ vaults: { acceptance: { path: vaultPath } } }));
    await writeFile(join(profileDirectory, "DevToolsActivePort"), "9222\n");
    await writeFile(join(vaultPath, ".obsidian", "community-plugins.json"), '["candidate"]');
    vi.stubGlobal("fetch", async () => ({ json: async () => [{
      type: "page", url: "app://obsidian.md/index.html", webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/test",
    }] }));
    class RendererSocket extends EventTarget {
      constructor() { super(); queueMicrotask(() => this.dispatchEvent(new Event("open"))); }
      send() {
        queueMicrotask(() => this.dispatchEvent(new MessageEvent("message", {
          data: JSON.stringify({ id: 1, result: { exceptionDetails: { text: "Wrong acceptance Vault" } } }),
        })));
      }
      close() {}
    }
    vi.stubGlobal("WebSocket", RendererSocket);
    await expect(confirmGeneratedVaultTrust({ vaultPath, profileDirectory, timeoutMs: 500 }))
      .rejects.toThrow("GUI Vault identity verification failed");
  } finally {
    vi.unstubAllGlobals();
    await rm(root, { recursive: true, force: true });
  }
});

it("ignores unrelated debugger messages before accepting the matching response", async () => {
  const root = await mkdtemp(join(tmpdir(), "local-gui-correlation-"));
  const vaultPath = join(root, "installed-runtime-vault-proof");
  const profileDirectory = join(root, "profile");
  try {
    await mkdir(join(vaultPath, ".obsidian"), { recursive: true });
    await mkdir(profileDirectory);
    await writeFile(join(profileDirectory, "obsidian.json"), JSON.stringify({ vaults: { acceptance: { path: vaultPath } } }));
    await writeFile(join(profileDirectory, "DevToolsActivePort"), "9222\n");
    await writeFile(join(vaultPath, ".obsidian", "community-plugins.json"), '["candidate"]');
    vi.stubGlobal("fetch", async () => ({ json: async () => [{
      type: "page", url: "app://obsidian.md/index.html", webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/test",
    }] }));
    class RendererSocket extends EventTarget {
      constructor() { super(); queueMicrotask(() => this.dispatchEvent(new Event("open"))); }
      send() {
        queueMicrotask(() => {
          this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ id: 99, result: { result: { value: "loaded" } } }) }));
          this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ id: 1, result: { exceptionDetails: {} } }) }));
        });
      }
      close() {}
    }
    vi.stubGlobal("WebSocket", RendererSocket);
    await expect(confirmGeneratedVaultTrust({ vaultPath, profileDirectory, timeoutMs: 500 }))
      .rejects.toThrow("GUI Vault identity verification failed");
  } finally {
    vi.unstubAllGlobals();
    await rm(root, { recursive: true, force: true });
  }
});

it("waits for the plugin manager after the correct Vault becomes available", async () => {
  const root = await mkdtemp(join(tmpdir(), "local-gui-initialization-"));
  const vaultPath = join(root, "installed-runtime-vault-proof");
  const profileDirectory = join(root, "profile");
  let evaluations = 0;
  try {
    await mkdir(join(vaultPath, ".obsidian"), { recursive: true });
    await mkdir(profileDirectory);
    await writeFile(join(profileDirectory, "obsidian.json"), JSON.stringify({ vaults: { acceptance: { path: vaultPath } } }));
    await writeFile(join(profileDirectory, "DevToolsActivePort"), "9222\n");
    await writeFile(join(vaultPath, ".obsidian", "community-plugins.json"), '["candidate"]');
    vi.stubGlobal("fetch", async () => ({ json: async () => [{
      type: "page", url: "app://obsidian.md/index.html", webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/test",
    }] }));
    class RendererSocket extends EventTarget {
      constructor() { super(); queueMicrotask(() => this.dispatchEvent(new Event("open"))); }
      send(message: string) {
        const command = JSON.parse(message);
        evaluations += 1;
        let result;
        try {
          result = { result: { value: runInNewContext(command.params.expression, {
            app: { vault: { adapter: { getBasePath: () => vaultPath }, getMarkdownFiles: () => [] },
              ...(evaluations === 1 ? {} : { plugins: { plugins: { candidate: {} } } }) },
            document: { querySelectorAll: () => [] },
            process: { resourcesPath: "/installed/resources", versions: { electron: "43.3.0", node: "24.18.1" } },
            require: (name: string) => {
              if (name === "path") return { join: (...parts: string[]) => parts.join("/") };
              if (name === "fs") return { readFileSync: (path: string) => {
                expect(path).toBe("/installed/resources/obsidian.asar/package.json");
                return '{"version":"1.13.7"}';
              } };
              throw new Error("Unexpected module");
            },
          }) } };
        } catch { result = { exceptionDetails: {} }; }
        queueMicrotask(() => this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ id: command.id, result }) })));
      }
      close() {}
    }
    vi.stubGlobal("WebSocket", RendererSocket);
    await expect(confirmGeneratedVaultTrust({ vaultPath, profileDirectory, timeoutMs: 1_000 })).resolves.toEqual({
      obsidianVersion: "1.13.7", electronVersion: "43.3.0", nodeVersion: "24.18.1",
    });
    expect(evaluations).toBe(2);
  } finally { vi.unstubAllGlobals(); await rm(root, { recursive: true, force: true }); }
});
