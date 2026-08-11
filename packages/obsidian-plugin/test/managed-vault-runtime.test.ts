import { describe, expect, it, vi } from "vitest";

import type { BridgeInstance } from "../src/bridge-instance.js";
import {
  ManagedVaultBridgeRuntime,
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
    const createBridge = vi.fn(({ port }: { port: number }) => {
      const bridge = fakeBridge(port);
      bridges.push(bridge);
      return bridge;
    });
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
