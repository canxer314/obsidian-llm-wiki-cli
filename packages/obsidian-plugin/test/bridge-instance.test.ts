import { describe, expect, it } from "vitest";

import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";

import {
  createBridgeInstance,
  SearchSnapshotManager,
  VaultDiscoverService,
  type BridgeHealthState,
  type VaultReadDataSource,
} from "../src/index.js";

function healthState(vaultId: string, name: string): BridgeHealthState {
  return {
    vault: { id: vaultId, name, path: `D:/Vaults/${name}` },
    readiness: { searchSnapshot: "ready", cache: "ready", index: "ready" },
    recovery: { state: "none" },
    write: { gate: "open", state: "writable", pauseSource: null },
    queue: { currentExecutionId: null, length: 0, headChangeSetId: null },
    lifecycle: {
      startup: "ready",
      upgrade: "not_run",
      migration: "not_run",
      recovery: "not_run",
    },
    effectiveGate: null,
    overall: "healthy",
    reasonCodes: [],
    operatorAction: "none",
  };
}

async function connect(endpoint: URL, expectedVaultId?: string): Promise<Client> {
  const client = new Client({ name: "bridge-test", version: "1.0.0" });
  const headers = expectedVaultId
    ? { "X-Expected-Vault-ID": expectedVaultId }
    : undefined;
  const transport = new StreamableHTTPClientTransport(endpoint, {
    requestInit: headers ? { headers } : undefined,
  });
  await client.connect(transport);
  return client;
}

describe("Bridge Instance over loopback Streamable HTTP", () => {
  it("projects the fixed gate precedence consistently across all six tools", async () => {
    const health = healthState("vault-a", "Alpha");
    health.effectiveGate = { code: "upgrade_in_progress" };
    health.recovery = { state: "blocked" };
    health.write = { gate: "blocked", state: "paused", pauseSource: "maintenance" };
    const bridge = createBridgeInstance({
      port: 0,
      health,
      discoverService: {
        execute: async () => {
          throw new Error("blocked discovery must not execute");
        },
        releaseClient: () => undefined,
      },
      readDataSource: {
        readBinary: async () => {
          throw new Error("blocked read must not execute");
        },
        parseFrontmatter: () => null,
        headings: () => [],
      },
      changeSets: {
        store: {
          load: async () => undefined,
          save: async () => undefined,
        },
        dataSource: {
          readBinary: async () => {
            throw new Error("blocked submit must not read");
          },
          pathKind: async () => {
            throw new Error("blocked submit must not inspect paths");
          },
          isContained: async () => {
            throw new Error("blocked submit must not inspect containment");
          },
        },
        createChangeSetId: () => "blocked-change-set",
      },
    });
    await bridge.start();

    try {
      const client = await connect(bridge.endpoint, "vault-a");
      const calls = await Promise.all([
        client.callTool({ name: "vault_health", arguments: {} }),
        client.callTool({
          name: "vault_discover",
          arguments: {
            query: { text: { literal: "blocked", caseSensitive: true } },
            projection: { matches: false },
            order: { by: "path", direction: "asc" },
            page: { maxItems: 10, continuation: null },
          },
        }),
        client.callTool({
          name: "vault_read",
          arguments: { items: [{ kind: "exact", path: "Note.md" }] },
        }),
        client.callTool({
          name: "vault_continue",
          arguments: { continuation: "uninspected" },
        }),
        client.callTool({
          name: "vault_change_set_submit",
          arguments: {
            submissionKey: "blocked-key",
            operations: [
              {
                operationId: "mkdir-1",
                kind: "create_directory",
                path: "Blocked",
                ifExists: "reject",
              },
            ],
          },
        }),
      ]);
      const status = await client.callTool({
        name: "vault_change_set_status",
        arguments: { submissionKey: "blocked-key" },
      });

      expect(calls[0]).toMatchObject({
        isError: false,
        structuredContent: { effectiveGate: { code: "recovery_blocked" } },
      });
      for (const result of calls.slice(1, 4)) {
        expect(result).toMatchObject({
          isError: true,
          structuredContent: {
            outcome: "operationally_blocked",
            gate: { code: "recovery_blocked" },
          },
        });
      }
      expect(calls[4]).toMatchObject({
        isError: true,
        structuredContent: {
          outcome: "registered",
          changeSet: { state: "intent_not_applied" },
          gate: { code: "recovery_blocked" },
        },
      });
      expect(status).toMatchObject({
        isError: false,
        structuredContent: { lookup: "found" },
      });
      await client.close();
    } finally {
      await bridge.stop();
    }
  });

  it("keeps manual pause and maintenance local while observational tools remain available", async () => {
    const health = healthState("vault-a", "Alpha");
    const bridge = createBridgeInstance({
      port: 0,
      health,
      discoverService: {
        execute: async () => ({ outcome: "results", items: [], continuation: null }),
        releaseClient: () => undefined,
      },
      readDataSource: {
        readBinary: async () => null,
        parseFrontmatter: () => null,
        headings: () => [],
      },
      changeSets: {
        store: { load: async () => undefined, save: async () => undefined },
        dataSource: {
          readBinary: async () => null,
          pathKind: async () => null,
          isContained: async () => true,
        },
      },
    });
    await bridge.start();

    try {
      const client = await connect(bridge.endpoint, "vault-a");
      await bridge.pauseWrites();
      const pausedHealth = await client.callTool({ name: "vault_health", arguments: {} });
      const pausedRead = await client.callTool({
        name: "vault_read",
        arguments: { items: [{ kind: "metadata", path: "Missing.md" }] },
      });
      const pausedStatus = await client.callTool({
        name: "vault_change_set_status",
        arguments: { submissionKey: "unknown" },
      });
      const pausedSubmit = await client.callTool({
        name: "vault_change_set_submit",
        arguments: {
          submissionKey: "paused-key",
          operations: [
            {
              operationId: "mkdir-1",
              kind: "create_directory",
              path: "Paused",
              ifExists: "reject",
            },
          ],
        },
      });

      expect(pausedHealth).toMatchObject({
        isError: false,
        structuredContent: {
          write: { state: "paused", pauseSource: "manual" },
          effectiveGate: { code: "writes_paused" },
        },
      });
      expect(pausedRead.isError).toBe(false);
      expect(pausedStatus.isError).toBe(false);
      expect(pausedSubmit).toMatchObject({
        isError: true,
        structuredContent: {
          outcome: "operationally_blocked",
          gate: { code: "writes_paused" },
        },
      });

      const maintenanceSteps: string[] = [];
      await expect(
        bridge.runMaintenance({
          replaceValidatedBundle: () => {
            maintenanceSteps.push("replace");
          },
          migrateState: () => {
            maintenanceSteps.push("migrate");
            throw new Error("migration failed");
          },
          recheckHealth: () => {
            maintenanceSteps.push("health");
          },
        }),
      ).rejects.toThrow("migration failed");
      expect(maintenanceSteps).toEqual(["replace", "migrate"]);
      const failedHealth = await client.callTool({ name: "vault_health", arguments: {} });
      expect(failedHealth).toMatchObject({
        isError: false,
        structuredContent: {
          write: { gate: "blocked", state: "paused", pauseSource: "maintenance" },
          lifecycle: { upgrade: "failed", migration: "failed" },
          overall: "blocked",
          effectiveGate: { code: "upgrade_in_progress" },
        },
      });
      await expect(bridge.resumeWrites()).rejects.toThrow();
      await expect(bridge.pauseWrites()).rejects.toThrow();
      const stillFailed = await client.callTool({ name: "vault_health", arguments: {} });
      expect(stillFailed).toMatchObject({
        structuredContent: {
          write: { gate: "blocked", pauseSource: "maintenance" },
          effectiveGate: { code: "upgrade_in_progress" },
        },
      });

      await bridge.runMaintenance({
        replaceValidatedBundle: () => {
          maintenanceSteps.push("replace");
        },
        migrateState: () => {
          maintenanceSteps.push("migrate");
        },
        recheckHealth: () => {
          maintenanceSteps.push("health");
        },
      });
      const maintainedHealth = await client.callTool({ name: "vault_health", arguments: {} });
      expect(maintenanceSteps).toEqual([
        "replace",
        "migrate",
        "replace",
        "migrate",
        "health",
      ]);
      expect(maintainedHealth).toMatchObject({
        isError: false,
        structuredContent: {
          write: { gate: "open", state: "paused", pauseSource: "maintenance" },
          effectiveGate: { code: "writes_paused" },
          lifecycle: { upgrade: "succeeded", migration: "succeeded" },
          overall: "healthy",
          reasonCodes: [],
        },
      });

      await bridge.resumeWrites();
      const resumedHealth = await client.callTool({ name: "vault_health", arguments: {} });
      expect(resumedHealth).toMatchObject({
        structuredContent: {
          write: { state: "writable", pauseSource: null },
          effectiveGate: null,
        },
      });
      await client.close();
    } finally {
      await bridge.stop();
    }
  });

  it("preserves a recovery safety block raised during maintenance health recheck", async () => {
    const health = healthState("vault-a", "Alpha");
    const bridge = createBridgeInstance({
      port: 0,
      health,
      changeSets: {
        store: { load: async () => undefined, save: async () => undefined },
        dataSource: {
          readBinary: async () => null,
          pathKind: async () => null,
          isContained: async () => true,
        },
      },
    });
    await bridge.start();

    try {
      await bridge.runMaintenance({
        replaceValidatedBundle: () => undefined,
        migrateState: () => undefined,
        recheckHealth: () => {
          health.recovery = { state: "blocked" };
          health.write = { gate: "blocked", state: "paused", pauseSource: null };
          health.effectiveGate = { code: "recovery_blocked" };
          health.overall = "blocked";
          health.reasonCodes = ["recovery_blocked"];
          health.operatorAction = "review_recovery";
        },
      });

      const client = await connect(bridge.endpoint, "vault-a");
      const observed = await client.callTool({ name: "vault_health", arguments: {} });
      expect(observed).toMatchObject({
        isError: false,
        structuredContent: {
          recovery: { state: "blocked" },
          write: { gate: "blocked", pauseSource: null },
          effectiveGate: { code: "recovery_blocked" },
          overall: "blocked",
          reasonCodes: ["recovery_blocked"],
          operatorAction: "review_recovery",
        },
      });
      await expect(bridge.resumeWrites()).rejects.toThrow();
      await client.close();
    } finally {
      await bridge.stop();
    }
  });

  it("serves trustworthy health only when initialization and tool entry identities match", async () => {
    const bridge = createBridgeInstance({
      port: 0,
      health: healthState("vault-a", "Alpha"),
    });
    await bridge.start();

    try {
      const client = await connect(bridge.endpoint, "vault-a");
      const result = await client.callTool({ name: "vault_health", arguments: {} });

      expect(result.isError).toBe(false);
      expect(result.structuredContent).toMatchObject({
        outcome: "observed",
        vault: { id: "vault-a", name: "Alpha" },
        listener: { address: "127.0.0.1", port: bridge.port },
      });
      expect(JSON.parse(result.content[0]?.type === "text" ? result.content[0].text : ""))
        .toEqual(result.structuredContent);

      await client.close();
    } finally {
      await bridge.stop();
    }
  });

  it("rejects missing or mismatched expected Vault IDs during initialization", async () => {
    const bridge = createBridgeInstance({
      port: 0,
      health: healthState("vault-a", "Alpha"),
    });
    await bridge.start();

    try {
      await expect(connect(bridge.endpoint)).rejects.toThrow();
      await expect(connect(bridge.endpoint, "vault-b")).rejects.toThrow();
    } finally {
      await bridge.stop();
    }
  });

  it("rechecks the expected Vault ID on every tool entry after initialization", async () => {
    const bridge = createBridgeInstance({
      port: 0,
      health: healthState("vault-a", "Alpha"),
    });
    await bridge.start();

    try {
      let expectedVaultId = "vault-a";
      const transport = new StreamableHTTPClientTransport(bridge.endpoint, {
        fetch: (input, init) => {
          const headers = new Headers(init?.headers);
          headers.set("X-Expected-Vault-ID", expectedVaultId);
          return fetch(input, { ...init, headers });
        },
      });
      const client = new Client({ name: "bridge-test", version: "1.0.0" });
      await client.connect(transport);
      expectedVaultId = "vault-b";

      await expect(
        client.callTool({ name: "vault_health", arguments: {} }),
      ).rejects.toThrow();
      await client.close();
    } finally {
      await bridge.stop();
    }
  });

  it("never reads or binds Change Set state for an incompatible connection", async () => {
    let loads = 0;
    let saves = 0;
    const bridge = createBridgeInstance({
      port: 0,
      health: healthState("vault-a", "Alpha"),
      peerProtocol: {
        protocol: "2.0",
        supported: { major: 2, minimumMinor: 0, maximumMinor: 0 },
      },
      readDataSource: {
        readBinary: async () => {
          throw new Error("incompatible read must not inspect content");
        },
        parseFrontmatter: () => null,
        headings: () => [],
      },
      changeSets: {
        store: {
          load: async () => {
            loads += 1;
            throw new Error("incompatible connection must not load the registry");
          },
          save: async () => {
            saves += 1;
          },
        },
        dataSource: {
          readBinary: async () => {
            throw new Error("incompatible submit must not inspect content");
          },
          pathKind: async () => {
            throw new Error("incompatible submit must not inspect paths");
          },
          isContained: async () => {
            throw new Error("incompatible submit must not inspect containment");
          },
        },
      },
    });
    await bridge.start();

    try {
      const client = await connect(bridge.endpoint, "vault-a");
      const tools = await client.listTools();
      expect(tools.tools.map(({ name }) => name)).toContain("vault_change_set_submit");
      expect(tools.tools.map(({ name }) => name)).toContain("vault_change_set_status");
      const malformedTools = [
        ["vault_discover", { query: null }],
        ["vault_read", { items: "bad" }],
        ["vault_continue", { continuation: 42 }],
      ] as const;
      for (const [name, arguments_] of malformedTools) {
        const blocked = await client.callTool({ name, arguments: arguments_ });
        expect(blocked).toMatchObject({
          isError: true,
          structuredContent: {
            outcome: "operationally_blocked",
            gate: { code: "incompatible_protocol" },
          },
        });
      }
      const submit = await client.callTool({
        name: "vault_change_set_submit",
        arguments: {
          submissionKey: "uninspected-key",
          operations: [
            {
              operationId: "mkdir-1",
              kind: "create_directory",
              path: "Uninspected",
              ifExists: "reject",
            },
          ],
        },
      });
      const status = await client.callTool({
        name: "vault_change_set_status",
        arguments: { submissionKey: "uninspected-key" },
      });

      expect(submit).toMatchObject({
        isError: true,
        structuredContent: {
          outcome: "operationally_blocked",
          gate: { code: "incompatible_protocol" },
        },
      });
      expect(status).toMatchObject({
        isError: true,
        structuredContent: {
          lookup: "operationally_blocked",
          gate: { code: "incompatible_protocol" },
        },
      });
      expect(loads).toBe(0);
      expect(saves).toBe(0);
      await client.close();
    } finally {
      await bridge.stop();
    }
  });

  it("derives the minimal incompatible health projection from protocol participants", async () => {
    const bridge = createBridgeInstance({
      port: 0,
      health: healthState("vault-a", "Alpha"),
      peerProtocol: {
        protocol: "2.0",
        supported: { major: 2, minimumMinor: 0, maximumMinor: 0 },
      },
    });
    await bridge.start();

    try {
      const client = await connect(bridge.endpoint, "vault-a");
      const tools = await client.listTools();
      expect(tools.tools.map(({ name }) => name).sort()).toEqual([
        "vault_change_set_status",
        "vault_change_set_submit",
        "vault_continue",
        "vault_discover",
        "vault_health",
        "vault_read",
      ]);
      const result = await client.callTool({ name: "vault_health", arguments: {} });
      expect(result.isError).toBe(false);
      expect(result.structuredContent).toEqual({
        outcome: "incompatible",
        gate: { code: "incompatible_protocol" },
        compatibility: {
          local: {
            protocol: "1.0",
            supported: { major: 1, minimumMinor: 0, maximumMinor: 0 },
          },
          peer: {
            protocol: "2.0",
            supported: { major: 2, minimumMinor: 0, maximumMinor: 0 },
          },
        },
      });
      expect(result.structuredContent).not.toHaveProperty("vault");
      expect(result.structuredContent).not.toHaveProperty("queue");
      await client.close();
    } finally {
      await bridge.stop();
    }
  });

  it("runs the authentication seam before initialization and every tool entry", async () => {
    let authenticated = false;
    const bridge = createBridgeInstance({
      port: 0,
      health: healthState("vault-a", "Alpha"),
      authenticator: {
        authenticate: async () => authenticated,
      },
    });
    await bridge.start();

    try {
      await expect(connect(bridge.endpoint, "vault-a")).rejects.toThrow();
      authenticated = true;
      const client = await connect(bridge.endpoint, "vault-a");
      authenticated = false;
      await expect(
        client.callTool({ name: "vault_health", arguments: {} }),
      ).rejects.toThrow();
      await client.close();
    } finally {
      await bridge.stop();
    }
  });

  it("reports unavailable content readiness as degraded rather than fabricating healthy evidence", async () => {
    const bridge = createBridgeInstance({
      port: 0,
      health: {
        ...healthState("vault-a", "Alpha"),
        readiness: {
          searchSnapshot: "unavailable",
          cache: "unavailable",
          index: "unavailable",
        },
        overall: "degraded",
        reasonCodes: ["content_tools_not_ready"],
        operatorAction: "wait_for_readiness",
      },
    });
    await bridge.start();

    try {
      const client = await connect(bridge.endpoint, "vault-a");
      const result = await client.callTool({ name: "vault_health", arguments: {} });
      expect(result.structuredContent).toMatchObject({
        overall: "degraded",
        reasonCodes: ["content_tools_not_ready"],
        operatorAction: "wait_for_readiness",
      });
      await client.close();
    } finally {
      await bridge.stop();
    }
  });

  it("preserves unrelated degraded health when the Search Snapshot is ready", async () => {
    const degraded = healthState("vault-a", "Alpha");
    degraded.overall = "degraded";
    degraded.reasonCodes = ["cache_rebuilding"];
    degraded.operatorAction = "wait_for_readiness";
    const bridge = createBridgeInstance({
      port: 0,
      health: degraded,
      searchSnapshotReadiness: () => "ready",
    });
    await bridge.start();

    try {
      const client = await connect(bridge.endpoint, "vault-a");
      const result = await client.callTool({ name: "vault_health", arguments: {} });
      expect(result.structuredContent).toMatchObject({
        overall: "degraded",
        reasonCodes: ["cache_rebuilding"],
        operatorAction: "wait_for_readiness",
      });
      await client.close();
    } finally {
      await bridge.stop();
    }
  });

  it("serves vault_discover from one ready internal Search Snapshot", async () => {
    const files = new Map([
      ["Alpha.md", new TextEncoder().encode("Search Snapshot")],
      ["Beta.md", new TextEncoder().encode("other")],
    ]);
    const snapshots = new SearchSnapshotManager({
      listMarkdownPaths: async () => [...files.keys()],
      readBinary: async (path) => files.get(path) ?? null,
    });
    await snapshots.rebuild();
    const health = healthState("vault-a", "Alpha");
    const bridge = createBridgeInstance({
      port: 0,
      health,
      discoverService: new VaultDiscoverService(snapshots),
      searchSnapshotReadiness: () => snapshots.readiness,
    });
    await bridge.start();

    try {
      const client = await connect(bridge.endpoint, "vault-a");
      const result = await client.callTool({
        name: "vault_discover",
        arguments: {
          query: { text: { literal: "Search", caseSensitive: true } },
          projection: { matches: true },
          order: { by: "path", direction: "asc" },
          page: { maxItems: 100, continuation: null },
        },
      });

      expect(result.isError).toBe(false);
      expect(result.structuredContent).toMatchObject({
        outcome: "results",
        items: [{ path: "Alpha.md", matches: [{ text: "Search" }] }],
      });
      expect(result.structuredContent).not.toHaveProperty("snapshot");
      await client.close();
    } finally {
      await bridge.stop();
    }
  });

  it("keeps discovery continuations inside their originating MCP session", async () => {
    const files = new Map([
      ["a.md", new TextEncoder().encode("needle")],
      ["b.md", new TextEncoder().encode("needle")],
    ]);
    const snapshots = new SearchSnapshotManager({
      listMarkdownPaths: async () => [...files.keys()],
      readBinary: async (path) => files.get(path) ?? null,
    });
    await snapshots.rebuild();
    const bridge = createBridgeInstance({
      port: 0,
      health: healthState("vault-a", "Alpha"),
      discoverService: new VaultDiscoverService(snapshots, {
        createToken: () => "session-bound",
      }),
    });
    await bridge.start();

    try {
      const clientA = await connect(bridge.endpoint, "vault-a");
      const clientB = await connect(bridge.endpoint, "vault-a");
      const first = await clientA.callTool({
        name: "vault_discover",
        arguments: {
          query: { text: { literal: "needle", caseSensitive: true } },
          projection: { matches: true },
          order: { by: "path", direction: "asc" },
          page: { maxItems: 1, continuation: null },
        },
      });
      expect(first.structuredContent).toMatchObject({
        items: [{ path: "a.md" }],
        continuation: "session-bound:1",
      });
      const continuationArguments = {
        query: { path: { exact: "ignored.md" } },
        projection: { matches: false },
        order: { by: "path", direction: "asc" },
        page: { maxItems: 1, continuation: "session-bound:1" },
      };

      const crossed = await clientB.callTool({
        name: "vault_discover",
        arguments: continuationArguments,
      });
      expect(crossed.structuredContent).toEqual({
        outcome: "snapshot_unavailable",
        code: "search_snapshot_unavailable",
      });
      const resumed = await clientA.callTool({
        name: "vault_discover",
        arguments: continuationArguments,
      });
      expect(resumed.structuredContent).toMatchObject({
        outcome: "results",
        items: [{ path: "b.md" }],
        complete: true,
      });
      await clientA.close();
      await clientB.close();
    } finally {
      await bridge.stop();
    }
  });

  it("releases discovery continuations when an MCP client disconnects", async () => {
    const executedFor: string[] = [];
    const released: string[] = [];
    const bridge = createBridgeInstance({
      port: 0,
      health: healthState("vault-a", "Alpha"),
      discoverService: {
        execute: async (_input, clientId) => {
          executedFor.push(clientId);
          return {
            outcome: "results",
            ordering: { by: "path", direction: "asc", tieBreaker: "path_utf8_bytes" },
            items: [],
            complete: true,
            continuation: null,
          };
        },
        releaseClient: (clientId) => released.push(clientId),
      },
    });
    await bridge.start();

    try {
      const client = new Client({ name: "bridge-test", version: "1.0.0" });
      const transport = new StreamableHTTPClientTransport(bridge.endpoint, {
        requestInit: { headers: { "X-Expected-Vault-ID": "vault-a" } },
      });
      await client.connect(transport);
      await client.callTool({
        name: "vault_discover",
        arguments: {
          query: { path: { exact: "Alpha.md" } },
          projection: { matches: false },
          order: { by: "path", direction: "asc" },
          page: { maxItems: 10, continuation: null },
        },
      });
      await transport.terminateSession();
      await client.close();

      expect(executedFor).toHaveLength(1);
      expect(released).toEqual(executedFor);
    } finally {
      await bridge.stop();
    }
  });

  it("releases discovery continuations when the Bridge stops", async () => {
    const executedFor: string[] = [];
    const released: string[] = [];
    const bridge = createBridgeInstance({
      port: 0,
      health: healthState("vault-a", "Alpha"),
      discoverService: {
        execute: async (_input, clientId) => {
          executedFor.push(clientId);
          return {
            outcome: "results",
            ordering: { by: "path", direction: "asc", tieBreaker: "path_utf8_bytes" },
            items: [],
            complete: true,
            continuation: null,
          };
        },
        releaseClient: (clientId) => released.push(clientId),
      },
    });
    await bridge.start();
    const client = await connect(bridge.endpoint, "vault-a");
    await client.callTool({
      name: "vault_discover",
      arguments: {
        query: { path: { exact: "Alpha.md" } },
        projection: { matches: false },
        order: { by: "path", direction: "asc" },
        page: { maxItems: 10, continuation: null },
      },
    });

    await bridge.stop();

    expect(executedFor).toHaveLength(1);
    expect(released).toEqual(executedFor);
    await client.close();
  });

  it("reports Search Snapshot inconsistency through health and discovery without another gate", async () => {
    const health = healthState("vault-a", "Alpha");
    let readiness: "ready" | "building" | "unavailable" = "unavailable";
    const bridge = createBridgeInstance({
      port: 0,
      health,
      searchSnapshotReadiness: () => readiness,
      discoverService: {
        execute: async () => ({
          outcome: "snapshot_unavailable",
          code: "search_snapshot_unavailable",
        }),
        releaseClient: () => {},
      },
    });
    await bridge.start();

    try {
      const client = await connect(bridge.endpoint, "vault-a");
      const observed = await client.callTool({ name: "vault_health", arguments: {} });
      expect(observed.structuredContent).toMatchObject({
        outcome: "observed",
        readiness: { searchSnapshot: "unavailable" },
        overall: "degraded",
        reasonCodes: ["search_snapshot_unavailable"],
        operatorAction: "wait_for_readiness",
        effectiveGate: null,
      });

      const discovery = await client.callTool({
        name: "vault_discover",
        arguments: {
          query: { path: { exact: "Alpha.md" } },
          projection: { matches: false },
          order: { by: "path", direction: "asc" },
          page: { maxItems: 10, continuation: null },
        },
      });
      expect(discovery.isError).toBe(true);
      expect(discovery.structuredContent).toEqual({
        outcome: "snapshot_unavailable",
        code: "search_snapshot_unavailable",
      });
      readiness = "building";
      const building = await client.callTool({ name: "vault_health", arguments: {} });
      expect(building.structuredContent).toMatchObject({
        readiness: { searchSnapshot: "building", index: "building" },
        reasonCodes: ["search_snapshot_building"],
      });
      readiness = "ready";
      const ready = await client.callTool({ name: "vault_health", arguments: {} });
      expect(ready.structuredContent).toMatchObject({
        readiness: { searchSnapshot: "ready", index: "ready" },
        overall: "healthy",
        reasonCodes: [],
        operatorAction: "none",
      });
      await client.close();
    } finally {
      await bridge.stop();
    }
  });

  it("performs one byte-exact ordered heterogeneous vault_read", async () => {
    const content =
      "﻿---\r\n状态: 就绪\r\n---\r\n# 父级\r\n开头😀\r\n## 子级\r\n第一段\r\n## 子级\r\n第二段中文😀\r\n# 结尾\r\n";
    const bytes = Buffer.from(content, "utf8");
    const reads: string[] = [];
    const dataSource: VaultReadDataSource = {
      readBinary: async (path) => {
        reads.push(path);
        return bytes;
      },
      parseFrontmatter: () => ({ 状态: "就绪" }),
      headings: () => [
        { heading: "父级", level: 1, startOffset: 18, endOffset: 22 },
        { heading: "子级", level: 2, startOffset: 30, endOffset: 35 },
        { heading: "子级", level: 2, startOffset: 42, endOffset: 47 },
        { heading: "结尾", level: 1, startOffset: 58, endOffset: 62 },
      ],
    };
    const bridge = createBridgeInstance({
      port: 0,
      health: healthState("vault-a", "Alpha"),
      readDataSource: dataSource,
    });
    await bridge.start();

    try {
      const client = await connect(bridge.endpoint, "vault-a");
      const result = await client.callTool({
        name: "vault_read",
        arguments: {
          items: [
            { kind: "metadata", path: "资料/重复.md" },
            { kind: "outline", path: "资料/重复.md" },
            {
              kind: "section",
              path: "资料/重复.md",
              hierarchy: ["父级", "子级"],
              occurrence: 2,
            },
            { kind: "exact", path: "资料/重复.md" },
          ],
        },
      });

      expect(result.isError).toBe(false);
      expect(result.structuredContent).toEqual({
        outcome: "items",
        items: [
          {
            outcome: "satisfied",
            result: {
              kind: "metadata",
              index: 0,
              path: "资料/重复.md",
              contentVersion:
                "sha256:33f6b0b9716b03f72951d1d6425a8acd28c17a0b21adcd11ee17c9b2eaab2909",
              sizeBytes: 115,
              frontmatter: { 状态: "就绪" },
            },
          },
          {
            outcome: "satisfied",
            result: {
              kind: "outline",
              index: 1,
              path: "资料/重复.md",
              contentVersion:
                "sha256:33f6b0b9716b03f72951d1d6425a8acd28c17a0b21adcd11ee17c9b2eaab2909",
              sizeBytes: 115,
              headings: [
                { heading: "父级", level: 1 },
                { heading: "子级", level: 2 },
                { heading: "子级", level: 2 },
                { heading: "结尾", level: 1 },
              ],
            },
          },
          {
            outcome: "satisfied",
            result: {
              kind: "section",
              index: 2,
              path: "资料/重复.md",
              contentVersion:
                "sha256:33f6b0b9716b03f72951d1d6425a8acd28c17a0b21adcd11ee17c9b2eaab2909",
              sizeBytes: 115,
              hierarchy: ["父级", "子级"],
              occurrence: 2,
              content: "## 子级\r\n第二段中文😀\r\n",
            },
          },
          {
            outcome: "satisfied",
            result: {
              kind: "exact",
              index: 3,
              path: "资料/重复.md",
              contentVersion:
                "sha256:33f6b0b9716b03f72951d1d6425a8acd28c17a0b21adcd11ee17c9b2eaab2909",
              sizeBytes: 115,
              content,
            },
          },
        ],
      });
      expect(reads).toEqual([
        "资料/重复.md",
        "资料/重复.md",
        "资料/重复.md",
        "资料/重复.md",
      ]);
      expect(JSON.parse(result.content[0]?.type === "text" ? result.content[0].text : ""))
        .toEqual(result.structuredContent);
      await client.close();
    } finally {
      await bridge.stop();
    }
  });

  it("never falls back when a heading hierarchy occurrence is unsatisfied", async () => {
    const bytes = Buffer.from("# Parent\n## Child\nonly section\n", "utf8");
    const bridge = createBridgeInstance({
      port: 0,
      health: healthState("vault-a", "Alpha"),
      readDataSource: {
        readBinary: async () => bytes,
        parseFrontmatter: () => null,
        headings: () => [
          { heading: "Parent", level: 1, startOffset: 0, endOffset: 8 },
          { heading: "Child", level: 2, startOffset: 9, endOffset: 17 },
        ],
      },
    });
    await bridge.start();

    try {
      const client = await connect(bridge.endpoint, "vault-a");
      const result = await client.callTool({
        name: "vault_read",
        arguments: {
          items: [
            {
              kind: "section",
              path: "note.md",
              hierarchy: ["Parent", "Child"],
              occurrence: 2,
            },
          ],
        },
      });

      expect(result.isError).toBe(false);
      expect(result.structuredContent).toEqual({
        outcome: "items",
        items: [{ outcome: "not_satisfied" }],
      });
      expect(JSON.stringify(result.structuredContent)).not.toContain("only section");
      await client.close();
    } finally {
      await bridge.stop();
    }
  });

  it("returns a typed result instead of truncating a note over the Exact Read limit", async () => {
    const bytes = Buffer.alloc(1_048_577, 0x61);
    const bridge = createBridgeInstance({
      port: 0,
      health: healthState("vault-a", "Alpha"),
      readDataSource: {
        readBinary: async () => bytes,
        parseFrontmatter: () => null,
        headings: () => [],
      },
    });
    await bridge.start();

    try {
      const client = await connect(bridge.endpoint, "vault-a");
      const result = await client.callTool({
        name: "vault_read",
        arguments: { items: [{ kind: "exact", path: "large.md" }] },
      });

      expect(result.isError).toBe(false);
      expect(result.structuredContent).toEqual({
        outcome: "items",
        items: [{ outcome: "note_exceeds_exact_read_limit" }],
      });
      await client.close();
    } finally {
      await bridge.stop();
    }
  });

  it("returns complete ordered contiguous groups when aggregate Exact Reads exceed 1 MiB", async () => {
    const notes = new Map([
      ["a.md", Buffer.alloc(600_000, 0x61)],
      ["b.md", Buffer.alloc(400_000, 0x62)],
      ["c.md", Buffer.alloc(400_000, 0x63)],
    ]);
    const bridge = createBridgeInstance({
      port: 0,
      health: healthState("vault-a", "Alpha"),
      readDataSource: {
        readBinary: async (path) => {
          const bytes = notes.get(path);
          if (bytes === undefined) throw new Error("missing");
          return bytes;
        },
        parseFrontmatter: () => null,
        headings: () => [],
      },
    });
    await bridge.start();

    try {
      const client = await connect(bridge.endpoint, "vault-a");
      const result = await client.callTool({
        name: "vault_read",
        arguments: {
          items: [
            { kind: "exact", path: "a.md" },
            { kind: "exact", path: "b.md" },
            { kind: "metadata", path: "a.md" },
            { kind: "exact", path: "c.md" },
          ],
        },
      });

      expect(result.isError).toBe(true);
      expect(result.structuredContent).toEqual({
        outcome: "grouping_required",
        suggestedGroups: [
          { startIndex: 0, endIndexExclusive: 3, exactReadBytes: 1_000_000 },
          { startIndex: 3, endIndexExclusive: 4, exactReadBytes: 400_000 },
        ],
      });
      expect(JSON.stringify(result.structuredContent)).not.toContain("aaaa");
      await client.close();
    } finally {
      await bridge.stop();
    }
  });

  it("continues an oversized metadata item through bounded transport pages", async () => {
    const frontmatter = { large: "界😀".repeat(60_000) };
    const bridge = createBridgeInstance({
      port: 0,
      health: healthState("vault-a", "Alpha"),
      readDataSource: {
        readBinary: async () => Buffer.from("x", "utf8"),
        parseFrontmatter: () => frontmatter,
        headings: () => [],
      },
    });
    await bridge.start();

    try {
      const client = await connect(bridge.endpoint, "vault-a");
      const results = [
        await client.callTool({
          name: "vault_read",
          arguments: { items: [{ kind: "metadata", path: "large.md" }] },
        }),
      ];
      let continuation = (results[0]?.structuredContent as { continuation: string | null })
        .continuation;
      while (continuation !== null) {
        const continued = await client.callTool({
          name: "vault_continue",
          arguments: { continuation },
        });
        results.push(continued);
        continuation = (continued.structuredContent as { continuation: string | null })
          .continuation;
      }

      const chunks = results.flatMap((result) =>
        (result.structuredContent as {
          items: Array<{
            kind: string;
            start: number;
            end: number;
            content: string;
            complete: boolean;
          }>;
        }).items,
      );
      expect(results.every((result) => result.isError === false)).toBe(true);
      expect(
        results.every(
          (result) =>
            Buffer.byteLength(
              JSON.stringify({
                content: result.content,
                structuredContent: result.structuredContent,
                isError: result.isError,
              }),
              "utf8",
            ) <= 262_144,
        ),
      ).toBe(true);
      expect(chunks.every((chunk) => chunk.kind === "item")).toBe(true);
      expect(
        chunks.every(
          (chunk, index) => index === 0 || chunks[index - 1]?.end === chunk.start,
        ),
      ).toBe(true);
      expect(chunks.at(-1)?.complete).toBe(true);
      expect(JSON.parse(chunks.map((chunk) => chunk.content).join(""))).toMatchObject({
        outcome: "satisfied",
        result: { kind: "metadata", frontmatter },
      });
      await client.close();
    } finally {
      await bridge.stop();
    }
  });

  it("continues an accepted Exact Read through frozen bounded transport pages", async () => {
    const original = `﻿${"正文😀\r\n".repeat(50_000)}`;
    let current = Buffer.from(original, "utf8");
    let readCount = 0;
    const bridge = createBridgeInstance({
      port: 0,
      health: healthState("vault-a", "Alpha"),
      readDataSource: {
        readBinary: async () => {
          readCount += 1;
          return current;
        },
        parseFrontmatter: () => null,
        headings: () => [],
      },
    });
    await bridge.start();

    try {
      const owner = await connect(bridge.endpoint, "vault-a");
      const other = await connect(bridge.endpoint, "vault-a");
      const first = await owner.callTool({
        name: "vault_read",
        arguments: { items: [{ kind: "exact", path: "large.md" }] },
      });
      expect(first.isError).toBe(false);
      expect(first.structuredContent).toMatchObject({
        outcome: "page",
        complete: false,
      });
      expect(
        Buffer.byteLength(
          JSON.stringify({
            content: first.content,
            structuredContent: first.structuredContent,
            isError: first.isError,
          }),
          "utf8",
        ),
      ).toBeLessThanOrEqual(262_144);

      const firstPage = first.structuredContent as {
        items: Array<{ content: string; start: number; end: number }>;
        continuation: string;
      };
      const firstToken = firstPage.continuation;
      const wrongClient = await other.callTool({
        name: "vault_continue",
        arguments: { continuation: firstToken },
      });
      expect(wrongClient.isError).toBe(true);
      expect(wrongClient.structuredContent).toEqual({
        code: "continuation_unavailable",
      });

      current = Buffer.from("changed after accepted read", "utf8");
      const pages = [firstPage];
      let continuation: string | null = firstToken;
      while (continuation !== null) {
        const continued = await owner.callTool({
          name: "vault_continue",
          arguments: { continuation },
        });
        expect(continued.isError).toBe(false);
        expect(
          Buffer.byteLength(
            JSON.stringify({
              content: continued.content,
              structuredContent: continued.structuredContent,
              isError: continued.isError,
            }),
            "utf8",
          ),
        ).toBeLessThanOrEqual(262_144);
        const page = continued.structuredContent as {
          items: Array<{ content: string; start: number; end: number }>;
          continuation: string | null;
        };
        pages.push(page);
        continuation = page.continuation;
      }

      const chunks = pages.flatMap((page) => page.items);
      expect(
        chunks.every(
          (chunk, index) => index === 0 || chunks[index - 1]?.end === chunk.start,
        ),
      ).toBe(true);
      expect(Buffer.from(chunks.map((chunk) => chunk.content).join(""), "utf8")).toEqual(
        Buffer.from(original, "utf8"),
      );
      expect(readCount).toBe(1);

      const replay = await owner.callTool({
        name: "vault_continue",
        arguments: { continuation: firstToken },
      });
      expect(replay.isError).toBe(true);
      expect(replay.structuredContent).toEqual({
        code: "continuation_unavailable",
      });
      await owner.close();
      await other.close();
    } finally {
      await bridge.stop();
    }
  });

  it("maps malformed and never-issued tokens to one trusted failure", async () => {
    const bridge = createBridgeInstance({
      port: 0,
      health: healthState("vault-a", "Alpha"),
      readDataSource: {
        readBinary: async () => Buffer.from("content", "utf8"),
        parseFrontmatter: () => null,
        headings: () => [],
      },
    });
    await bridge.start();

    try {
      const client = await connect(bridge.endpoint, "vault-a");
      const unavailable = await client.callTool({
        name: "vault_continue",
        arguments: { continuation: "malformed-never-issued-token" },
      });
      expect(unavailable.isError).toBe(true);
      expect(unavailable.structuredContent).toEqual({
        code: "continuation_unavailable",
      });
      expect(
        JSON.parse(
          unavailable.content[0]?.type === "text" ? unavailable.content[0].text : "",
        ),
      ).toEqual(unavailable.structuredContent);
      await client.close();
    } finally {
      await bridge.stop();
    }
  });

  it("projects blocking gates before inspecting a continuation token", async () => {
    const health = healthState("vault-a", "Alpha");
    const bridge = createBridgeInstance({
      port: 0,
      health,
      readDataSource: {
        readBinary: async () => Buffer.from("x".repeat(300_000), "utf8"),
        parseFrontmatter: () => null,
        headings: () => [],
      },
    });
    await bridge.start();

    try {
      const client = await connect(bridge.endpoint, "vault-a");
      const first = await client.callTool({
        name: "vault_read",
        arguments: { items: [{ kind: "exact", path: "large.md" }] },
      });
      const token = (first.structuredContent as { continuation: string }).continuation;
      health.effectiveGate = { code: "recovery_in_progress" };
      health.recovery = { state: "in_progress" };

      const blocked = await client.callTool({
        name: "vault_continue",
        arguments: { continuation: token },
      });
      expect(blocked.isError).toBe(true);
      expect(blocked.structuredContent).toEqual({
        outcome: "operationally_blocked",
        gate: { code: "recovery_in_progress" },
      });

      health.effectiveGate = null;
      health.recovery = { state: "none" };
      const resumed = await client.callTool({
        name: "vault_continue",
        arguments: { continuation: token },
      });
      expect(resumed.isError).toBe(false);
      expect(resumed.structuredContent).toMatchObject({ outcome: "page" });
      await client.close();
    } finally {
      await bridge.stop();
    }
  });

  it("expires continuation tokens at the fifteen-minute boundary", async () => {
    let now = 0;
    const bridge = createBridgeInstance({
      port: 0,
      health: healthState("vault-a", "Alpha"),
      continuationNow: () => now,
      readDataSource: {
        readBinary: async () => Buffer.from("x".repeat(300_000), "utf8"),
        parseFrontmatter: () => null,
        headings: () => [],
      },
    });
    await bridge.start();

    try {
      const client = await connect(bridge.endpoint, "vault-a");
      const first = await client.callTool({
        name: "vault_read",
        arguments: { items: [{ kind: "exact", path: "large.md" }] },
      });
      const token = (first.structuredContent as { continuation: string }).continuation;
      now = 15 * 60_000;

      const expired = await client.callTool({
        name: "vault_continue",
        arguments: { continuation: token },
      });
      expect(expired.isError).toBe(true);
      expect(expired.structuredContent).toEqual({ code: "continuation_unavailable" });
      await client.close();
    } finally {
      await bridge.stop();
    }
  });

  it("rejects a ninth live continuation without evicting existing chains", async () => {
    const bridge = createBridgeInstance({
      port: 0,
      health: healthState("vault-a", "Alpha"),
      readDataSource: {
        readBinary: async (path) => Buffer.from(`${path}:${"x".repeat(300_000)}`, "utf8"),
        parseFrontmatter: () => null,
        headings: () => [],
      },
    });
    await bridge.start();

    try {
      const client = await connect(bridge.endpoint, "vault-a");
      const issued = [];
      for (let index = 0; index < 8; index += 1) {
        issued.push(
          await client.callTool({
            name: "vault_read",
            arguments: { items: [{ kind: "exact", path: `live-${index}.md` }] },
          }),
        );
      }
      const ninth = await client.callTool({
        name: "vault_read",
        arguments: { items: [{ kind: "exact", path: "rejected.md" }] },
      });
      expect(ninth.isError).toBe(true);
      expect(ninth.structuredContent).toEqual({ code: "continuation_unavailable" });

      for (const result of issued) {
        const token = (result.structuredContent as { continuation: string }).continuation;
        const next = await client.callTool({
          name: "vault_continue",
          arguments: { continuation: token },
        });
        expect(next.isError).toBe(false);
      }
      await client.close();
    } finally {
      await bridge.stop();
    }
  });

  it("enforces retained-byte quota independently and releases delivered prefixes", async () => {
    const section = `# Large\n${"界".repeat(2_650_000)}`;
    const bridge = createBridgeInstance({
      port: 0,
      health: healthState("vault-a", "Alpha"),
      readDataSource: {
        readBinary: async (path) =>
          Buffer.from(path === "section.md" ? section : "x".repeat(1_000_000), "utf8"),
        parseFrontmatter: () => null,
        headings: (path) =>
          path === "section.md"
            ? [{ heading: "Large", level: 1, startOffset: 0, endOffset: 7 }]
            : [],
      },
    });
    await bridge.start();

    try {
      const client = await connect(bridge.endpoint, "vault-a");
      let sectionPage = await client.callTool({
        name: "vault_read",
        arguments: {
          items: [
            {
              kind: "section",
              path: "section.md",
              hierarchy: ["Large"],
              occurrence: 1,
            },
          ],
        },
      });
      expect(sectionPage.isError).toBe(false);

      const rejected = await client.callTool({
        name: "vault_read",
        arguments: { items: [{ kind: "exact", path: "exact.md" }] },
      });
      expect(rejected.isError).toBe(true);
      expect(rejected.structuredContent).toEqual({ code: "continuation_unavailable" });

      for (let index = 0; index < 5; index += 1) {
        const token = (sectionPage.structuredContent as { continuation: string }).continuation;
        sectionPage = await client.callTool({
          name: "vault_continue",
          arguments: { continuation: token },
        });
        expect(sectionPage.isError).toBe(false);
      }

      const accepted = await client.callTool({
        name: "vault_read",
        arguments: { items: [{ kind: "exact", path: "exact.md" }] },
      });
      expect(accepted.isError).toBe(false);
      expect(accepted.structuredContent).toMatchObject({ outcome: "page" });
      await client.close();
    } finally {
      await bridge.stop();
    }
  });

  it("releases frozen continuations when their MCP session closes", async () => {
    const bridge = createBridgeInstance({
      port: 0,
      health: healthState("vault-a", "Alpha"),
      readDataSource: {
        readBinary: async () => Buffer.from("x".repeat(300_000), "utf8"),
        parseFrontmatter: () => null,
        headings: () => [],
      },
    });
    await bridge.start();

    try {
      const owner = await connect(bridge.endpoint, "vault-a");
      const first = await owner.callTool({
        name: "vault_read",
        arguments: { items: [{ kind: "exact", path: "large.md" }] },
      });
      const token = (first.structuredContent as { continuation: string }).continuation;
      await owner.close();

      const replacementClient = await connect(bridge.endpoint, "vault-a");
      const unavailable = await replacementClient.callTool({
        name: "vault_continue",
        arguments: { continuation: token },
      });
      expect(unavailable.isError).toBe(true);
      expect(unavailable.structuredContent).toEqual({ code: "continuation_unavailable" });
      await replacementClient.close();
    } finally {
      await bridge.stop();
    }
  });

  it("blocks content reads before touching bytes during recovery", async () => {
    let readCount = 0;
    const bridge = createBridgeInstance({
      port: 0,
      health: {
        ...healthState("vault-a", "Alpha"),
        effectiveGate: { code: "recovery_in_progress" },
        recovery: { state: "in_progress" },
        overall: "blocked",
      },
      readDataSource: {
        readBinary: async () => {
          readCount += 1;
          return Buffer.from("secret", "utf8");
        },
        parseFrontmatter: () => null,
        headings: () => [],
      },
    });
    await bridge.start();

    try {
      const client = await connect(bridge.endpoint, "vault-a");
      const result = await client.callTool({
        name: "vault_read",
        arguments: { items: [{ kind: "exact", path: "note.md" }] },
      });

      expect(result.isError).toBe(true);
      expect(result.structuredContent).toEqual({
        outcome: "operationally_blocked",
        gate: { code: "recovery_in_progress" },
      });
      expect(readCount).toBe(0);
      await client.close();
    } finally {
      await bridge.stop();
    }
  });

  it("does not turn invalid UTF-8 into a trustworthy unsatisfied result", async () => {
    const bridge = createBridgeInstance({
      port: 0,
      health: healthState("vault-a", "Alpha"),
      readDataSource: {
        readBinary: async () => Uint8Array.from([0xc3, 0x28]),
        parseFrontmatter: () => null,
        headings: () => [],
      },
    });
    await bridge.start();

    try {
      const client = await connect(bridge.endpoint, "vault-a");
      const result = await client.callTool({
        name: "vault_read",
        arguments: { items: [{ kind: "exact", path: "invalid.md" }] },
      });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toBeUndefined();
      await client.close();
    } finally {
      await bridge.stop();
    }
  });

  it("does not turn binary I/O failures into trustworthy unsatisfied results", async () => {
    const bridge = createBridgeInstance({
      port: 0,
      health: healthState("vault-a", "Alpha"),
      readDataSource: {
        readBinary: async () => {
          throw new Error("permission denied");
        },
        parseFrontmatter: () => null,
        headings: () => [],
      },
    });
    await bridge.start();

    try {
      const client = await connect(bridge.endpoint, "vault-a");
      const result = await client.callTool({
        name: "vault_read",
        arguments: { items: [{ kind: "exact", path: "unreadable.md" }] },
      });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toBeUndefined();
      await client.close();
    } finally {
      await bridge.stop();
    }
  });

  it("fails closed when cached heading positions do not match the raw snapshot", async () => {
    const bridge = createBridgeInstance({
      port: 0,
      health: healthState("vault-a", "Alpha"),
      readDataSource: {
        readBinary: async () => Buffer.from("# Current\n# Stale\nbody\n", "utf8"),
        parseFrontmatter: () => null,
        headings: () => [
          { heading: "Stale", level: 1, startOffset: 0, endOffset: 17 },
        ],
      },
    });
    await bridge.start();

    try {
      const client = await connect(bridge.endpoint, "vault-a");
      const result = await client.callTool({
        name: "vault_read",
        arguments: {
          items: [
            { kind: "outline", path: "note.md" },
            {
              kind: "section",
              path: "note.md",
              hierarchy: ["Stale"],
              occurrence: 1,
            },
          ],
        },
      });
      expect(result.isError).toBe(false);
      expect(result.structuredContent).toEqual({
        outcome: "items",
        items: [
          { outcome: "not_satisfied" },
          { outcome: "not_satisfied" },
        ],
      });
      await client.close();
    } finally {
      await bridge.stop();
    }
  });

  it("keeps two Vault endpoints and health evidence isolated", async () => {
    const alpha = createBridgeInstance({
      port: 0,
      health: healthState("vault-a", "Alpha"),
    });
    const beta = createBridgeInstance({
      port: 0,
      health: healthState("vault-b", "Beta"),
    });
    await Promise.all([alpha.start(), beta.start()]);

    try {
      expect(alpha.port).not.toBe(beta.port);
      const [alphaClient, betaClient] = await Promise.all([
        connect(alpha.endpoint, "vault-a"),
        connect(beta.endpoint, "vault-b"),
      ]);
      const [alphaHealth, betaHealth] = await Promise.all([
        alphaClient.callTool({ name: "vault_health", arguments: {} }),
        betaClient.callTool({ name: "vault_health", arguments: {} }),
      ]);

      expect(alphaHealth.structuredContent).toMatchObject({ vault: { id: "vault-a" } });
      expect(betaHealth.structuredContent).toMatchObject({ vault: { id: "vault-b" } });
      await expect(connect(beta.endpoint, "vault-a")).rejects.toThrow();

      await Promise.all([alphaClient.close(), betaClient.close()]);
    } finally {
      await Promise.all([alpha.stop(), beta.stop()]);
    }
  });
});
