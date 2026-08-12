import { describe, expect, it, vi } from "vitest";

import type { BridgeInstance } from "../src/bridge-instance.js";
import {
  ManagedVaultBridgeRuntime,
  type ManagedVaultBridgeRuntimeOptions,
  type PersistedBridgeSettings,
} from "../src/managed-vault-runtime.js";

function fakeBridge(port: number): BridgeInstance {
  return {
    endpoint: new URL(`http://127.0.0.1:${port}/mcp`),
    port,
    start: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
    registrationCommand: vi.fn(
      () =>
        `claude mcp add --transport http --scope local --header 'X-Expected-Vault-ID: vault-a' alpha 'http://127.0.0.1:${port}/mcp'`,
    ),
  };
}

describe("Managed Vault Bridge plugin lifecycle", () => {
  it("persists first-run identity and port, then reuses both on reload", async () => {
    let stored: PersistedBridgeSettings | undefined;
    const bridges: BridgeInstance[] = [];
    const createBridge = vi.fn(
      ({ port, health }: Parameters<ManagedVaultBridgeRuntimeOptions["createBridge"]>[0]) => {
        expect(health).toMatchObject({
          write: { gate: "blocked", state: "paused" },
          effectiveGate: { code: "writes_paused" },
          overall: "blocked",
          reasonCodes: ["content_tools_not_ready"],
          operatorAction: "finish_initialization",
        });
        const bridge = fakeBridge(port);
        bridges.push(bridge);
        return bridge;
      },
    );
    const store = {
      load: vi.fn(async () => stored),
      save: vi.fn(async (settings: PersistedBridgeSettings) => {
        stored = settings;
      }),
    };

    const first = new ManagedVaultBridgeRuntime({
      vault: { name: "Alpha", path: "D:/Vaults/Alpha" },
      settings: store,
      createBridge,
      createVaultId: () => "vault-a",
      selectInitialPort: () => 27123,
    });
    await first.load();
    await first.unload();

    const second = new ManagedVaultBridgeRuntime({
      vault: { name: "Alpha", path: "D:/Vaults/Alpha" },
      settings: store,
      createBridge,
      createVaultId: () => "must-not-regenerate",
      selectInitialPort: () => 29999,
    });
    await second.load();

    expect(store.save).toHaveBeenCalledOnce();
    expect(createBridge.mock.calls.map(([value]) => value.port)).toEqual([27123, 27123]);
    expect(stored).toEqual({
      schemaVersion: 1,
      vaultId: "vault-a",
      port: 27123,
      diagnosticPath: "D:/Vaults/Alpha",
    });
    expect(bridges[0]?.stop).toHaveBeenCalledOnce();

    await second.unload();
  });

  it("fails closed when the persistent port cannot bind and never changes it", async () => {
    const settings: PersistedBridgeSettings = {
      schemaVersion: 1,
      vaultId: "vault-a",
      port: 27123,
      diagnosticPath: "D:/Vaults/Alpha",
    };
    const save = vi.fn(async () => undefined);
    const runtime = new ManagedVaultBridgeRuntime({
      vault: { name: "Alpha", path: "D:/Vaults/Alpha" },
      settings: { load: async () => settings, save },
      createBridge: () => ({
        ...fakeBridge(settings.port),
        start: async () => {
          throw new Error("EADDRINUSE");
        },
      }),
    });

    await expect(runtime.load()).rejects.toThrow("EADDRINUSE");
    expect(save).not.toHaveBeenCalled();
    expect(runtime.bridge).toBeUndefined();
  });

  it("rejects invalid persisted state instead of replacing Vault identity", async () => {
    const save = vi.fn(async () => undefined);
    const createBridge = vi.fn(() => fakeBridge(27123));
    const runtime = new ManagedVaultBridgeRuntime({
      vault: { name: "Alpha", path: "D:/Vaults/Alpha" },
      settings: {
        load: async () => ({ schemaVersion: 999, vaultId: "old-vault", port: 27123 }),
        save,
      },
      createBridge,
      createVaultId: () => "new-vault",
      selectInitialPort: () => 29999,
    });

    await expect(runtime.load()).rejects.toThrow("incompatible or invalid");
    expect(save).not.toHaveBeenCalled();
    expect(createBridge).not.toHaveBeenCalled();
  });

  it("pauses startup when the persisted diagnostic path no longer matches", async () => {
    const settings: PersistedBridgeSettings = {
      schemaVersion: 1,
      vaultId: "vault-a",
      port: 27123,
      diagnosticPath: "D:/Vaults/Alpha",
    };
    const createBridge = vi.fn(() => fakeBridge(settings.port));
    const runtime = new ManagedVaultBridgeRuntime({
      vault: { name: "Alpha", path: "E:/Moved/Alpha" },
      settings: { load: async () => settings, save: async () => undefined },
      createBridge,
    });

    await expect(runtime.load()).rejects.toThrow("classification required");
    expect(createBridge).not.toHaveBeenCalled();
    expect(runtime.pendingPathChange).toEqual({
      previousPath: "D:/Vaults/Alpha",
      currentPath: "E:/Moved/Alpha",
    });
  });

  it("classifies a moved Vault by retaining identity and updating its path", async () => {
    let stored: PersistedBridgeSettings = {
      schemaVersion: 1,
      vaultId: "vault-a",
      port: 27123,
      diagnosticPath: "D:/Vaults/Alpha",
    };
    const save = vi.fn(async (settings: PersistedBridgeSettings) => {
      stored = settings;
    });
    const runtime = new ManagedVaultBridgeRuntime({
      vault: { name: "Alpha", path: "E:/Moved/Alpha" },
      settings: { load: async () => stored, save },
      createBridge: ({ port }) => fakeBridge(port),
    });

    await expect(runtime.load()).rejects.toThrow("classification required");
    await runtime.classifyPathChange("move");
    await runtime.load();

    expect(stored).toEqual({
      schemaVersion: 1,
      vaultId: "vault-a",
      port: 27123,
      diagnosticPath: "E:/Moved/Alpha",
    });
    await runtime.unload();
  });

  it("classifies a copied Vault by generating a new identity and port", async () => {
    let stored: PersistedBridgeSettings = {
      schemaVersion: 1,
      vaultId: "vault-a",
      port: 27123,
      diagnosticPath: "D:/Vaults/Alpha",
    };
    const save = vi.fn(async (settings: PersistedBridgeSettings) => {
      stored = settings;
    });
    const runtime = new ManagedVaultBridgeRuntime({
      vault: { name: "Alpha Copy", path: "E:/Copies/Alpha" },
      settings: { load: async () => stored, save },
      createBridge: ({ port }) => fakeBridge(port),
      createVaultId: () => "vault-copy",
      selectInitialPort: () => 29999,
    });

    await expect(runtime.load()).rejects.toThrow("classification required");
    await runtime.classifyPathChange("copy");
    await runtime.load();

    expect(stored).toEqual({
      schemaVersion: 1,
      vaultId: "vault-copy",
      port: 29999,
      diagnosticPath: "E:/Copies/Alpha",
    });
    await runtime.unload();
  });

  it("rejects copy classification when generators do not produce a new identity and port", async () => {
    const stored: PersistedBridgeSettings = {
      schemaVersion: 1,
      vaultId: "vault-a",
      port: 27123,
      diagnosticPath: "D:/Vaults/Alpha",
    };
    const save = vi.fn(async () => undefined);
    const runtime = new ManagedVaultBridgeRuntime({
      vault: { name: "Alpha Copy", path: "E:/Copies/Alpha" },
      settings: { load: async () => stored, save },
      createBridge: ({ port }) => fakeBridge(port),
      createVaultId: () => "vault-a",
      selectInitialPort: () => 27123,
    });

    await expect(runtime.load()).rejects.toThrow("classification required");
    await expect(runtime.classifyPathChange("copy")).rejects.toThrow(
      "new Vault identity and port",
    );
    expect(save).not.toHaveBeenCalled();
  });

  it("builds and injects one ready Search Snapshot before starting the Bridge", async () => {
    const bridge = fakeBridge(27123);
    let captured: Parameters<ManagedVaultBridgeRuntimeOptions["createBridge"]>[0] | undefined;
    const runtime = new ManagedVaultBridgeRuntime({
      vault: { name: "Alpha", path: "D:/Vaults/Alpha" },
      settings: { load: async () => undefined, save: async () => undefined },
      searchDataSource: {
        listMarkdownPaths: async () => ["note.md"],
        readBinary: async () => new TextEncoder().encode("needle"),
      },
      createBridge: (options) => {
        captured = options;
        return bridge;
      },
      createVaultId: () => "vault-a",
      selectInitialPort: () => 27123,
    });

    await runtime.load();

    expect(captured?.searchSnapshotReadiness?.()).toBe("ready");
    expect(captured?.health).toMatchObject({
      readiness: { searchSnapshot: "ready", index: "ready" },
      effectiveGate: { code: "writes_paused" },
      overall: "blocked",
      reasonCodes: ["writes_paused"],
      operatorAction: "resume_writes",
    });
    await expect(
      captured?.discoverService?.execute({
        query: { text: { literal: "needle", caseSensitive: true } },
        projection: { matches: true },
        order: { by: "path", direction: "asc" },
        page: { maxItems: 10, continuation: null },
      }),
    ).resolves.toMatchObject({ outcome: "results", items: [{ path: "note.md" }] });
    expect(bridge.start).toHaveBeenCalledOnce();
    await runtime.unload();
  });

  it("starts health reporting when the initial Search Snapshot build fails closed", async () => {
    const bridge = fakeBridge(27123);
    let captured: Parameters<ManagedVaultBridgeRuntimeOptions["createBridge"]>[0] | undefined;
    const runtime = new ManagedVaultBridgeRuntime({
      vault: { name: "Alpha", path: "D:/Vaults/Alpha" },
      settings: { load: async () => undefined, save: async () => undefined },
      searchDataSource: {
        listMarkdownPaths: async () => ["missing.md"],
        readBinary: async () => null,
      },
      createBridge: (options) => {
        captured = options;
        return bridge;
      },
      createVaultId: () => "vault-a",
      selectInitialPort: () => 27123,
    });

    await runtime.load();

    expect(captured?.searchSnapshotReadiness?.()).toBe("unavailable");
    expect(bridge.start).toHaveBeenCalledOnce();
    await runtime.unload();
  });

  it("publishes a successor Search Snapshot on refresh", async () => {
    let content = "old";
    let captured: Parameters<ManagedVaultBridgeRuntimeOptions["createBridge"]>[0] | undefined;
    const runtime = new ManagedVaultBridgeRuntime({
      vault: { name: "Alpha", path: "D:/Vaults/Alpha" },
      settings: { load: async () => undefined, save: async () => undefined },
      searchDataSource: {
        listMarkdownPaths: async () => ["note.md"],
        readBinary: async () => new TextEncoder().encode(content),
      },
      createBridge: (options) => {
        captured = options;
        return fakeBridge(27123);
      },
      createVaultId: () => "vault-a",
      selectInitialPort: () => 27123,
    });
    await runtime.load();

    content = "new needle";
    await runtime.refreshSearchSnapshot();
    const result = await captured?.discoverService?.execute({
      query: { text: { literal: "needle", caseSensitive: true } },
      projection: { matches: true },
      order: { by: "path", direction: "asc" },
      page: { maxItems: 10, continuation: null },
    });

    expect(result).toMatchObject({
      outcome: "results",
      items: [{ path: "note.md", sizeBytes: 10, matches: [{ text: "needle" }] }],
    });
    await runtime.unload();
  });

  it("returns the local Claude Code registration command without executing it", async () => {
    const bridge = fakeBridge(27123);
    const runtime = new ManagedVaultBridgeRuntime({
      vault: { name: "Alpha", path: "D:/Vaults/Alpha" },
      settings: { load: async () => undefined, save: async () => undefined },
      createBridge: () => bridge,
      createVaultId: () => "vault-a",
      selectInitialPort: () => 27123,
    });
    await runtime.load();

    expect(runtime.registrationCommand("alpha")).toBe(
      "claude mcp add --transport http --scope local --header 'X-Expected-Vault-ID: vault-a' alpha 'http://127.0.0.1:27123/mcp'",
    );
    expect(bridge.registrationCommand).toHaveBeenCalledWith("alpha");

    await runtime.unload();
  });
});
