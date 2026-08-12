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
      schemaVersion: 2,
      vaultId: "vault-a",
      port: 27123,
      diagnosticPath: "D:/Vaults/Alpha",
      changeSets: {
        schemaVersion: 1,
        nextEnqueueSeq: 1,
        entries: [],
        tombstones: [],
      },
    });
    expect(bridges[0]?.stop).toHaveBeenCalledOnce();

    await second.unload();
  });

  it("migrates v1 identity settings without changing the Vault identity or port", async () => {
    let stored: unknown = {
      schemaVersion: 1,
      vaultId: "vault-a",
      port: 27123,
      diagnosticPath: "D:/Vaults/Alpha",
    };
    const save = vi.fn(async (settings: PersistedBridgeSettings) => {
      stored = settings;
    });
    const runtime = new ManagedVaultBridgeRuntime({
      vault: { name: "Alpha", path: "D:/Vaults/Alpha" },
      settings: { load: async () => stored, save },
      createBridge: ({ port }) => fakeBridge(port),
      createVaultId: () => "must-not-regenerate",
      selectInitialPort: () => 29999,
    });

    await runtime.load();

    expect(stored).toEqual({
      schemaVersion: 2,
      vaultId: "vault-a",
      port: 27123,
      diagnosticPath: "D:/Vaults/Alpha",
      changeSets: {
        schemaVersion: 1,
        nextEnqueueSeq: 1,
        entries: [],
        tombstones: [],
      },
    });
    expect(runtime.persistedSettings).toEqual(stored);
    await runtime.unload();
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

  it("recovers missing primary settings from the independent recovery copy", async () => {
    const acceptedChangeSets: PersistedBridgeSettings["changeSets"] = {
      schemaVersion: 1,
      nextEnqueueSeq: 2,
      entries: [
        {
          submissionKey: "submission-1",
          fingerprint: `sha256:${"a".repeat(64)}`,
          changeSetId: "change-set-1",
          enqueueSeq: 1,
          acceptedAt: 0,
          expiresAt: 7 * 24 * 60 * 60 * 1_000,
          changeSet: { changeSetId: "change-set-1", state: "in_progress" },
        },
      ],
      tombstones: [],
    };
    const recovered: PersistedBridgeSettings = {
      schemaVersion: 2,
      vaultId: "vault-a",
      port: 27123,
      diagnosticPath: "D:/Vaults/Alpha",
      changeSets: acceptedChangeSets,
    };
    let primary: PersistedBridgeSettings | undefined;
    let recoveredStore: { load(): Promise<unknown> } | undefined;
    const createBridge = vi.fn(
      ({ port, changeSets }: Parameters<ManagedVaultBridgeRuntimeOptions["createBridge"]>[0]) => {
        expect(port).toBe(27123);
        recoveredStore = changeSets?.store;
        return fakeBridge(port);
      },
    );
    const runtime = new ManagedVaultBridgeRuntime({
      vault: { name: "Alpha", path: "D:/Vaults/Alpha" },
      settings: {
        load: async () => primary,
        save: async (settings) => {
          primary = structuredClone(settings);
        },
        loadRecovery: async () => structuredClone(recovered),
        saveRecovery: vi.fn(async () => undefined),
      },
      createBridge,
      changeSetDataSource: {
        readBinary: async () => null,
        pathKind: async () => null,
        isContained: async () => true,
      },
      createVaultId: () => "must-not-regenerate",
      selectInitialPort: () => 29999,
    });

    await runtime.load();

    expect(primary).toEqual(recovered);
    expect(runtime.persistedSettings).toEqual(recovered);
    await expect(recoveredStore?.load()).resolves.toEqual(acceptedChangeSets);
    expect(createBridge).toHaveBeenCalledOnce();
    await runtime.unload();
  });

  it("prefers the recovery copy when the primary write lagged", async () => {
    const primary: PersistedBridgeSettings = {
      schemaVersion: 2,
      vaultId: "stale-primary",
      port: 27124,
      diagnosticPath: "D:/Vaults/Alpha",
      changeSets: { schemaVersion: 1, nextEnqueueSeq: 1, entries: [], tombstones: [] },
    };
    const recovery: PersistedBridgeSettings = {
      ...primary,
      vaultId: "vault-a",
      port: 27123,
    };
    const runtime = new ManagedVaultBridgeRuntime({
      vault: { name: "Alpha", path: "D:/Vaults/Alpha" },
      settings: {
        load: async () => primary,
        save: async () => undefined,
        loadRecovery: async () => recovery,
        saveRecovery: async () => undefined,
      },
      createBridge: ({ port }) => fakeBridge(port),
    });

    await runtime.load();

    expect(runtime.persistedSettings).toMatchObject({ vaultId: "vault-a", port: 27123 });
    await runtime.unload();
  });

  it("persists primary and recovery settings before first startup", async () => {
    const calls: string[] = [];
    const runtime = new ManagedVaultBridgeRuntime({
      vault: { name: "Alpha", path: "D:/Vaults/Alpha" },
      settings: {
        load: async () => undefined,
        save: async () => {
          calls.push("primary");
        },
        loadRecovery: async () => undefined,
        saveRecovery: async () => {
          calls.push("recovery");
        },
      },
      createBridge: ({ port }) => fakeBridge(port),
      createVaultId: () => "vault-a",
      selectInitialPort: () => 27123,
    });

    await runtime.load();

    expect(calls).toEqual(["recovery", "primary"]);
    await runtime.unload();
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

  it("rejects a corrupt Change Set registry instead of reporting accepted keys unknown", async () => {
    const save = vi.fn(async () => undefined);
    const createBridge = vi.fn(() => fakeBridge(27123));
    const runtime = new ManagedVaultBridgeRuntime({
      vault: { name: "Alpha", path: "D:/Vaults/Alpha" },
      settings: {
        load: async () => ({
          schemaVersion: 2,
          vaultId: "vault-a",
          port: 27123,
          diagnosticPath: "D:/Vaults/Alpha",
          changeSets: null,
        }),
        save,
      },
      createBridge,
    });

    await expect(runtime.load()).rejects.toThrow("incompatible or invalid");
    expect(save).not.toHaveBeenCalled();
    expect(createBridge).not.toHaveBeenCalled();
  });

  it("rejects a persisted record whose public and registry identities disagree", async () => {
    const save = vi.fn(async () => undefined);
    const createBridge = vi.fn(() => fakeBridge(27123));
    const runtime = new ManagedVaultBridgeRuntime({
      vault: { name: "Alpha", path: "D:/Vaults/Alpha" },
      settings: {
        load: async () => ({
          schemaVersion: 2,
          vaultId: "vault-a",
          port: 27123,
          diagnosticPath: "D:/Vaults/Alpha",
          changeSets: {
            schemaVersion: 1,
            nextEnqueueSeq: 2,
            entries: [
              {
                submissionKey: "submission-1",
                fingerprint: `sha256:${"a".repeat(64)}`,
                changeSetId: "registry-id",
                enqueueSeq: 1,
                acceptedAt: 0,
                expiresAt: 7 * 24 * 60 * 60 * 1_000,
                changeSet: { changeSetId: "public-id", state: "in_progress" },
              },
            ],
            tombstones: [],
          },
        }),
        save,
      },
      createBridge,
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
      schemaVersion: 2,
      vaultId: "vault-a",
      port: 27123,
      diagnosticPath: "E:/Moved/Alpha",
      changeSets: {
        schemaVersion: 1,
        nextEnqueueSeq: 1,
        entries: [],
        tombstones: [],
      },
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
      schemaVersion: 2,
      vaultId: "vault-copy",
      port: 29999,
      diagnosticPath: "E:/Copies/Alpha",
      changeSets: {
        schemaVersion: 1,
        nextEnqueueSeq: 1,
        entries: [],
        tombstones: [],
      },
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
