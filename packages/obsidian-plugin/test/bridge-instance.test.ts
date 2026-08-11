import { describe, expect, it } from "vitest";

import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";

import { createBridgeInstance, type BridgeHealthState } from "../src/index.js";

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
