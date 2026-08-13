import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import {
  createBridgeInstance,
  type BridgeInstance,
} from "../src/bridge-instance.js";
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

  it("keeps a durable registry update when the primary mirror write fails", async () => {
    let primary: PersistedBridgeSettings | undefined;
    let recovery: PersistedBridgeSettings | undefined;
    let failPrimary = false;
    let registryStore:
      | { save(state: NonNullable<PersistedBridgeSettings["changeSets"]>): Promise<void> }
      | undefined;
    const runtime = new ManagedVaultBridgeRuntime({
      vault: { name: "Alpha", path: "D:/Vaults/Alpha" },
      settings: {
        load: async () => primary,
        save: async (settings) => {
          if (failPrimary) throw new Error("injected primary mirror failure");
          primary = structuredClone(settings);
        },
        loadRecovery: async () => recovery,
        saveRecovery: async (settings) => {
          recovery = structuredClone(settings);
        },
      },
      createBridge: ({ port, changeSets }) => {
        registryStore = changeSets?.store;
        return fakeBridge(port);
      },
      changeSetDataSource: {
        readBinary: async () => null,
        pathKind: async () => null,
        isContained: async () => true,
      },
      createVaultId: () => "vault-a",
      selectInitialPort: () => 27123,
    });
    await runtime.load();
    failPrimary = true;
    const accepted = {
      schemaVersion: 1 as const,
      nextEnqueueSeq: 2,
      entries: [
        {
          submissionKey: "submission-1",
          fingerprint: `sha256:${"a".repeat(64)}`,
          changeSetId: "change-set-1",
          enqueueSeq: 1,
          acceptedAt: 0,
          expiresAt: 7 * 24 * 60 * 60 * 1_000,
          changeSet: { changeSetId: "change-set-1", state: "in_progress" as const },
        },
      ],
      tombstones: [],
    };

    await expect(registryStore?.save(accepted)).resolves.toBeUndefined();
    expect(recovery?.changeSets).toEqual(accepted);
    expect(primary?.changeSets).not.toEqual(accepted);
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

  it("starts an observable recovery-blocked Bridge through the production composition", async () => {
    const settings: PersistedBridgeSettings = {
      schemaVersion: 2,
      vaultId: "vault-a",
      port: 27123,
      diagnosticPath: "D:/Vaults/Alpha",
      changeSets: {
        schemaVersion: 1,
        nextEnqueueSeq: 2,
        entries: [
          {
            submissionKey: "directory-key",
            fingerprint: `sha256:${"a".repeat(64)}`,
            changeSetId: "change-set-unproven",
            enqueueSeq: 1,
            acceptedAt: 0,
            expiresAt: Number.MAX_SAFE_INTEGER,
            execution: {
              phase: "queued",
              input: {
                submissionKey: "directory-key",
                operations: [
                  {
                    operationId: "mkdir-1",
                    kind: "create_directory",
                    path: "Directory",
                    ifExists: "reject",
                  },
                ],
              },
            },
            changeSet: {
              changeSetId: "change-set-unproven",
              state: "in_progress",
              preview: {
                requestedEffects: [
                  {
                    operationId: "mkdir-1",
                    kind: "create_directory",
                    projectedOutcome: "changed",
                  },
                ],
                derivedEffects: [],
                paths: [
                  {
                    path: "Directory",
                    preState: { kind: "absent" },
                    projectedFinalState: { kind: "directory" },
                    projectedOutcome: "changed",
                  },
                ],
              },
            },
          },
        ],
        tombstones: [],
      },
    };
    const execution = {
      loadRecoveryFrame: async () => {
        throw new Error("corrupt recovery journal");
      },
      persistRecoveryFrame: async () => undefined,
      pathKind: async () => null,
      directoryIdentity: async () => null,
      prepareDirectory: async () => "directory",
      publishDirectory: async () => undefined,
      discardPreparedDirectory: async () => undefined,
      removeDirectory: async () => undefined,
      publishSearchSnapshot: async () => undefined,
    };
    let bridge: BridgeInstance | undefined;
    const runtime = new ManagedVaultBridgeRuntime({
      vault: { name: "Alpha", path: "D:/Vaults/Alpha" },
      settings: { load: async () => settings, save: async () => undefined },
      changeSetDataSource: {
        readBinary: async () => null,
        pathKind: async () => null,
        isContained: async () => true,
      },
      changeSetExecution: execution,
      createBridge: (options) => {
        bridge = createBridgeInstance({ ...options, port: 0 });
        return bridge;
      },
      createVaultId: () => "vault-a",
      selectInitialPort: () => 27123,
    });

    await expect(runtime.load()).resolves.toBeUndefined();
    const client = new Client({ name: "recovery-test", version: "1.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(bridge!.endpoint, {
        requestInit: { headers: { "X-Expected-Vault-ID": "vault-a" } },
      }),
    );

    try {
      const health = await client.callTool({ name: "vault_health", arguments: {} });
      expect(health.structuredContent).toMatchObject({
        recovery: { state: "blocked" },
        write: { gate: "blocked", state: "paused" },
        effectiveGate: { code: "recovery_blocked" },
        overall: "blocked",
        operatorAction: "review_recovery",
      });
      const status = await client.callTool({
        name: "vault_change_set_status",
        arguments: { changeSetId: "change-set-unproven" },
      });
      expect(status.structuredContent).toMatchObject({
        lookup: "found",
        changeSet: { state: "result_unproven" },
      });
    } finally {
      await client.close();
      await runtime.unload();
    }
  });

  it("derives note-move reference closure from the frozen Search Snapshot", async () => {
    const target = "# Target\n";
    const backlink = "See [[Target|alias]]\n";
    const bytes = new Map([
      ["Notes/Target.md", Buffer.from(target)],
      ["Notes/Backlink.md", Buffer.from(backlink)],
    ]);
    const start = backlink.indexOf("[[Target|alias]]");
    let captured: Parameters<ManagedVaultBridgeRuntimeOptions["createBridge"]>[0] | undefined;
    const runtime = new ManagedVaultBridgeRuntime({
      vault: { name: "Alpha", path: "D:/Vaults/Alpha" },
      settings: { load: async () => undefined, save: async () => undefined },
      searchDataSource: {
        listMarkdownPaths: async () => [...bytes.keys()],
        readBinary: async (path) => bytes.get(path) ?? null,
        semanticEvidence: async (path) => path === "Notes/Backlink.md"
          ? {
              frontmatter: null,
              tags: [],
              headings: [],
              references: [{
                profile: "wikilink",
                target: "Target",
                resolvedPath: "Notes/Target.md",
                original: "[[Target|alias]]",
                position: {
                  start: { line: 0, col: start, offset: start },
                  end: { line: 0, col: start + 16, offset: start + 16 },
                },
              }],
              resolvedLinks: { "Notes/Target.md": 1 },
              unresolvedLinks: {},
            }
          : {
              frontmatter: null,
              tags: [],
              headings: [{ heading: "Target", level: 1 }],
              references: [],
              resolvedLinks: {},
              unresolvedLinks: {},
            },
      },
      changeSetDataSource: {
        readBinary: async (path) => bytes.get(path) ?? null,
        pathKind: async (path) => path === "Notes" ? "directory" : bytes.has(path) ? "file" : null,
        isContained: async () => true,
      },
      createBridge: (options) => {
        captured = options;
        return fakeBridge(27123);
      },
      createVaultId: () => "vault-a",
      selectInitialPort: () => 27123,
    });
    await runtime.load();

    const projectMove = captured?.changeSets?.dataSource.projectMove;
    const projection = await projectMove?.({
      operationId: "move-1",
      kind: "move",
      sourcePath: "Notes/Target.md",
      destinationPath: "Notes/Renamed.md",
      targetVersion: `sha256:${createHash("sha256").update(target).digest("hex")}`,
      linkEffect: "update_resolved_references",
    }, Buffer.from(target));

    expect(Buffer.from(projection!.derivedEffects[0]!.projectedBytes).toString())
      .toBe("See [[Renamed|alias]]\n");
    await runtime.unload();
  });

  it("reports healthy readiness when snapshots and durable mutation execution are ready", async () => {
    let captured: Parameters<ManagedVaultBridgeRuntimeOptions["createBridge"]>[0] | undefined;
    const execution = {
      loadRecoveryFrame: async () => null,
      persistRecoveryFrame: async () => undefined,
      pathKind: async () => null,
      directoryIdentity: async () => null,
      prepareDirectory: async () => "directory",
      publishDirectory: async () => undefined,
      discardPreparedDirectory: async () => undefined,
      removeDirectory: async () => undefined,
      publishSearchSnapshot: async () => undefined,
    };
    const runtime = new ManagedVaultBridgeRuntime({
      vault: { name: "Alpha", path: "D:/Vaults/Alpha" },
      settings: { load: async () => undefined, save: async () => undefined },
      searchDataSource: {
        listMarkdownPaths: async () => ["note.md"],
        readBinary: async () => new TextEncoder().encode("ready"),
      },
      changeSetDataSource: {
        readBinary: async () => null,
        pathKind: async () => null,
        isContained: async () => true,
      },
      changeSetExecution: execution,
      createBridge: (options) => {
        captured = options;
        return fakeBridge(27123);
      },
      createVaultId: () => "vault-a",
      selectInitialPort: () => 27123,
    });

    await runtime.load();

    expect(captured?.health).toMatchObject({
      write: { gate: "open", state: "writable" },
      effectiveGate: null,
      overall: "healthy",
      reasonCodes: [],
      operatorAction: "none",
    });
    expect(captured?.changeSets).toMatchObject({
      execution,
      vaultId: "vault-a",
    });
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
