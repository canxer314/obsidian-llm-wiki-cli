import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import {
  parseHealthResult,
  serializeCompatibilityText,
  type HealthResult,
} from "@llm-wiki/vault-contracts";
import { afterEach, describe, expect, it } from "vitest";

import {
  createBridgeInstance,
  createLoopbackMcpClient,
  HealthObservationError,
  type BridgeHealthState,
  type BridgeInstance,
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

const bridges: BridgeInstance[] = [];
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(bridges.splice(0).map((bridge) => bridge.stop()));
  await Promise.all(
    servers.splice(0).map(
      (server) => new Promise<void>((resolve) => server.close(() => resolve())),
    ),
  );
});

async function startBridge(
  options: Partial<Parameters<typeof createBridgeInstance>[0]> = {},
): Promise<BridgeInstance> {
  const bridge = createBridgeInstance({
    port: 0,
    health: healthState("vault-a", "Alpha"),
    ...options,
  });
  bridges.push(bridge);
  await bridge.start();
  return bridge;
}

describe("loopback MCP health observation against a real Bridge Instance", () => {
  it("obtains a schema-valid observed vault_health with the expected Vault ID", async () => {
    const bridge = await startBridge();
    const client = createLoopbackMcpClient();
    const observation = await client.observeHealth(bridge.endpoint, "vault-a");
    expect(observation.expectedVaultId).toBe("vault-a");
    expect(observation.health.outcome).toBe("observed");
    expect(observation.health.vault.id).toBe("vault-a");
    expect(observation.health.listener).toEqual({
      address: "127.0.0.1",
      port: bridge.port,
    });
    expect(observation.health.versions.protocol).toBe("1.0");
  });

  it("fails closed when the expected Vault ID is wrong or absent", async () => {
    const bridge = await startBridge();
    const client = createLoopbackMcpClient();
    await expect(client.observeHealth(bridge.endpoint, "vault-b")).rejects.toMatchObject({
      name: "HealthObservationError",
      code: "health_unreachable",
    });
    await expect(client.observeHealth(bridge.endpoint, "")).rejects.toMatchObject({
      code: "identity_mismatch",
    });
  });

  it("projects an incompatible health branch as a typed failure", async () => {
    const bridge = await startBridge({ incompatibleState: true });
    const client = createLoopbackMcpClient();
    await expect(client.observeHealth(bridge.endpoint, "vault-a")).rejects.toMatchObject({
      code: "health_incompatible",
    });
  });

  it("fails closed when the endpoint is unreachable or not loopback", async () => {
    const bridge = await startBridge();
    const client = createLoopbackMcpClient();
    await bridge.stop();
    await expect(client.observeHealth(bridge.endpoint, "vault-a")).rejects.toMatchObject({
      code: "health_unreachable",
    });
    await expect(
      client.observeHealth(new URL("http://192.0.2.10:27123/mcp"), "vault-a"),
    ).rejects.toMatchObject({ code: "endpoint_not_loopback" });
    await expect(
      client.observeHealth(new URL("https://127.0.0.1:27123/mcp"), "vault-a"),
    ).rejects.toMatchObject({ code: "endpoint_not_loopback" });
  });
});

function validObservedHealth(vaultId: string, port: number): HealthResult {
  return parseHealthResult({
    outcome: "observed",
    vault: { id: vaultId, name: "Stub", path: "D:/Vaults/Stub" },
    versions: {
      bridge: "0.1.0",
      plugin: "0.1.0",
      protocol: "1.0",
      persistentStateSchema: 2,
      recoveryJournalSchema: 1,
    },
    listener: { address: "127.0.0.1", port },
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
  });
}

async function startStubMcpServer(toolResult: (port: number) => unknown): Promise<URL> {
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const port = (server.address() as AddressInfo).port;
      const rawBody = Buffer.concat(chunks).toString("utf8");
      if (rawBody.length === 0) {
        // Session teardown (DELETE) and similar bodyless control requests.
        response.writeHead(200);
        response.end();
        return;
      }
      const message = JSON.parse(rawBody) as {
        id?: unknown;
        method?: string;
        params?: { protocolVersion?: string };
      };
      if (message.method === "initialize") {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: message.id,
            result: {
              protocolVersion: message.params?.protocolVersion ?? "2025-03-26",
              capabilities: {},
              serverInfo: { name: "stub", version: "0.0.0" },
            },
          }),
        );
        return;
      }
      if (message.method === "notifications/initialized") {
        response.writeHead(202);
        response.end();
        return;
      }
      if (message.method === "tools/call") {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: toolResult(port) }));
        return;
      }
      response.writeHead(400);
      response.end();
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return new URL(`http://127.0.0.1:${port}/mcp`);
}

describe("loopback MCP health observation failure projection", () => {
  it("rejects schema-invalid health results", async () => {
    const endpoint = await startStubMcpServer(() => ({
      content: [{ type: "text", text: "{}" }],
      structuredContent: { bogus: true },
      isError: false,
    }));
    await expect(
      createLoopbackMcpClient().observeHealth(endpoint, "vault-a"),
    ).rejects.toMatchObject({ code: "health_schema_invalid" });
  });

  it("rejects results whose text representation diverges from structured content", async () => {
    const endpoint = await startStubMcpServer((port) => {
      const health = validObservedHealth("vault-a", port);
      return {
        content: [{ type: "text", text: "{\"tampered\":true}" }],
        structuredContent: health,
        isError: false,
      };
    });
    await expect(
      createLoopbackMcpClient().observeHealth(endpoint, "vault-a"),
    ).rejects.toMatchObject({ code: "representation_mismatch" });
  });

  it("rejects a schema-valid health result from the wrong Vault", async () => {
    const endpoint = await startStubMcpServer((port) => {
      const health = validObservedHealth("vault-b", port);
      return {
        content: [{ type: "text", text: serializeCompatibilityText(health) }],
        structuredContent: health,
        isError: false,
      };
    });
    await expect(
      createLoopbackMcpClient().observeHealth(endpoint, "vault-a"),
    ).rejects.toMatchObject({ code: "identity_mismatch" });
  });

  it("rejects health reported from an unexpected listener", async () => {
    const endpoint = await startStubMcpServer(() => {
      const health = validObservedHealth("vault-a", 1);
      return {
        content: [{ type: "text", text: serializeCompatibilityText(health) }],
        structuredContent: health,
        isError: false,
      };
    });
    await expect(
      createLoopbackMcpClient().observeHealth(endpoint, "vault-a"),
    ).rejects.toMatchObject({ code: "listener_mismatch" });
  });
});
