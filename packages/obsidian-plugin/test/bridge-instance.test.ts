import { describe, expect, it } from "vitest";

import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";

import {
  createBridgeInstance,
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
