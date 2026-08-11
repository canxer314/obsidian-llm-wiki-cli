import { createServer, type IncomingMessage, type Server as HttpServer } from "node:http";
import { randomUUID } from "node:crypto";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  parseHealthResult,
  serializeCompatibilityText,
  type HealthResult,
} from "@llm-wiki/vault-contracts";
import { z } from "zod";

import { rejectRequest, verifyRequestPolicy } from "./request-policy.js";
import { createRegistrationCommand } from "./registration-command.js";

const LOOPBACK_ADDRESS = "127.0.0.1";
const MCP_PATH = "/mcp";

export interface BridgeHealthState {
  vault: { id: string; name: string; path: string };
  readiness: {
    searchSnapshot: "ready" | "building" | "unavailable";
    cache: "ready" | "building" | "unavailable";
    index: "ready" | "building" | "unavailable";
  };
}

export interface BridgeInstanceOptions {
  port: number;
  health: BridgeHealthState;
  incompatibleHealth?: Extract<HealthResult, { outcome: "incompatible" }>;
}

export interface BridgeInstance {
  readonly endpoint: URL;
  readonly port: number;
  start(): Promise<void>;
  stop(): Promise<void>;
  registrationCommand(serverName?: string): string;
}

function projectObservedHealth(
  state: BridgeHealthState,
  port: number,
): HealthResult {
  const ready = Object.values(state.readiness).every((value) => value === "ready");
  return parseHealthResult({
    outcome: "observed",
    vault: state.vault,
    versions: {
      bridge: "0.1.0",
      plugin: "0.1.0",
      protocol: "1.0",
      persistentStateSchema: 1,
      recoveryJournalSchema: 1,
    },
    listener: { address: LOOPBACK_ADDRESS, port },
    readiness: state.readiness,
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
    overall: ready ? "healthy" : "degraded",
    reasonCodes: ready ? [] : ["content_tools_not_ready"],
    operatorAction: ready ? "none" : "wait_for_readiness",
  });
}

export function createBridgeInstance(options: BridgeInstanceOptions): BridgeInstance {
  let port = options.port;
  let httpServer: HttpServer | undefined;
  const sessions = new Map<
    string,
    { server: McpServer; transport: StreamableHTTPServerTransport }
  >();

  async function readBody(request: IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    if (chunks.length === 0) return undefined;
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  }

  function createMcpServer(): McpServer {
    const server = new McpServer({
      name: "obsidian-vault-operation-bridge",
      version: "0.1.0",
    });

    server.registerTool(
      "vault_health",
      {
        description: "Observe this Managed Vault's Bridge health evidence.",
        inputSchema: z.object({}).strict(),
      },
      () => {
        const health = options.incompatibleHealth ?? projectObservedHealth(options.health, port);
        return {
          content: [{ type: "text", text: serializeCompatibilityText(health) }],
          structuredContent: health,
          isError: false,
        };
      },
    );

    return server;
  }

  async function handleRequest(
    request: IncomingMessage,
    response: import("node:http").ServerResponse,
  ): Promise<void> {
    if (request.url !== MCP_PATH) {
      response.writeHead(404, { "Cache-Control": "no-store" });
      response.end();
      return;
    }

    const policyFailure = verifyRequestPolicy(request, options.health.vault.id, port);
    if (policyFailure !== null) {
      rejectRequest(response, policyFailure);
      return;
    }

    const sessionHeader = request.headers["mcp-session-id"];
    const sessionId = typeof sessionHeader === "string" ? sessionHeader : undefined;
    let session = sessionId === undefined ? undefined : sessions.get(sessionId);
    let body: unknown;

    if (request.method === "POST") {
      try {
        body = await readBody(request);
      } catch {
        response.writeHead(400, { "Cache-Control": "no-store" });
        response.end();
        return;
      }
    }

    if (session === undefined && request.method === "POST" && sessionId === undefined) {
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
      });
      const server = createMcpServer();
      transport.onclose = () => {
        if (transport.sessionId !== undefined) sessions.delete(transport.sessionId);
      };
      await server.connect(transport);
      await transport.handleRequest(request, response, body);
      if (transport.sessionId !== undefined) {
        sessions.set(transport.sessionId, { server, transport });
      }
      return;
    }

    if (session === undefined) {
      response.writeHead(400, {
        "Cache-Control": "no-store",
        "Content-Type": "application/json",
      });
      response.end(
        JSON.stringify({
          jsonrpc: "2.0",
          error: { code: -32_000, message: "invalid_session" },
          id: null,
        }),
      );
      return;
    }

    await session.transport.handleRequest(request, response, body);
  }

  return {
    get endpoint() {
      return new URL(`http://${LOOPBACK_ADDRESS}:${port}${MCP_PATH}`);
    },
    get port() {
      return port;
    },
    async start() {
      if (httpServer !== undefined) throw new Error("Bridge Instance already started");
      const server = createServer((request, response) => {
        void handleRequest(request, response).catch(() => {
          if (!response.headersSent) response.writeHead(500);
          response.end();
        });
      });
      httpServer = server;

      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => reject(error);
        server.once("error", onError);
        server.listen(port, LOOPBACK_ADDRESS, () => {
          server.off("error", onError);
          const address = server.address();
          if (address === null || typeof address === "string") {
            reject(new Error("Bridge listener did not bind a TCP address"));
            return;
          }
          if (address.address !== LOOPBACK_ADDRESS) {
            reject(new Error("Bridge listener escaped the loopback boundary"));
            return;
          }
          port = address.port;
          resolve();
        });
      });
    },
    async stop() {
      const server = httpServer;
      if (server === undefined) return;
      httpServer = undefined;
      await Promise.all([...sessions.values()].map(({ server: mcp }) => mcp.close()));
      sessions.clear();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      });
    },
    registrationCommand(serverName) {
      return createRegistrationCommand(options.health.vault.id, port, serverName);
    },
  };
}
