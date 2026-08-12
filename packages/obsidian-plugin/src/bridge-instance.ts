import { createServer, type IncomingMessage, type Server as HttpServer } from "node:http";
import { randomUUID } from "node:crypto";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  parseHealthResult,
  parseReadInput,
  parseReadResult,
  readInputSchema,
  serializeCompatibilityText,
  serializeReadCompatibilityText,
  type HealthResult,
} from "@llm-wiki/vault-contracts";
import { z } from "zod";

import { rejectRequest, verifyRequestPolicy } from "./request-policy.js";
import { createRegistrationCommand } from "./registration-command.js";
import { performVaultRead, type VaultReadDataSource } from "./vault-read.js";
import {
  BRIDGE_VERSION,
  PLUGIN_VERSION,
  PROTOCOL_VERSION,
} from "./version.js";

const LOOPBACK_ADDRESS = "127.0.0.1";
const MCP_PATH = "/mcp";

export type ProtocolParticipant = Extract<
  HealthResult,
  { outcome: "incompatible" }
>["compatibility"]["local"];

const LOCAL_PROTOCOL: ProtocolParticipant = {
  protocol: PROTOCOL_VERSION,
  supported: { major: 1, minimumMinor: 0, maximumMinor: 0 },
};

export interface BridgeRequestAuthenticator {
  authenticate(request: IncomingMessage): boolean | Promise<boolean>;
}

export interface BridgeHealthState {
  vault: { id: string; name: string; path: string };
  readiness: {
    searchSnapshot: "ready" | "building" | "unavailable";
    cache: "ready" | "building" | "unavailable";
    index: "ready" | "building" | "unavailable";
  };
  recovery: Extract<HealthResult, { outcome: "observed" }>["recovery"];
  write: Extract<HealthResult, { outcome: "observed" }>["write"];
  queue: Extract<HealthResult, { outcome: "observed" }>["queue"];
  lifecycle: Extract<HealthResult, { outcome: "observed" }>["lifecycle"];
  effectiveGate: Extract<HealthResult, { outcome: "observed" }>["effectiveGate"];
  overall: Extract<HealthResult, { outcome: "observed" }>["overall"];
  reasonCodes: string[];
  operatorAction: Extract<HealthResult, { outcome: "observed" }>["operatorAction"];
}

export interface BridgeInstanceOptions {
  port: number;
  health: BridgeHealthState;
  peerProtocol?: ProtocolParticipant;
  authenticator?: BridgeRequestAuthenticator;
  readDataSource?: VaultReadDataSource;
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
  return parseHealthResult({
    outcome: "observed",
    vault: state.vault,
    versions: {
      bridge: BRIDGE_VERSION,
      plugin: PLUGIN_VERSION,
      protocol: PROTOCOL_VERSION,
      persistentStateSchema: 1,
      recoveryJournalSchema: 1,
    },
    listener: { address: LOOPBACK_ADDRESS, port },
    readiness: state.readiness,
    recovery: state.recovery,
    write: state.write,
    queue: state.queue,
    lifecycle: state.lifecycle,
    effectiveGate: state.effectiveGate,
    overall: state.overall,
    reasonCodes: state.reasonCodes,
    operatorAction: state.operatorAction,
  });
}

function projectIncompatibleHealth(
  peer: ProtocolParticipant,
): Extract<HealthResult, { outcome: "incompatible" }> {
  return parseHealthResult({
    outcome: "incompatible",
    gate: { code: "incompatible_protocol" },
    compatibility: { local: LOCAL_PROTOCOL, peer },
  }) as Extract<HealthResult, { outcome: "incompatible" }>;
}

function protocolsOverlap(peer: ProtocolParticipant): boolean {
  return (
    peer.supported.major === LOCAL_PROTOCOL.supported.major &&
    peer.supported.maximumMinor >= LOCAL_PROTOCOL.supported.minimumMinor &&
    peer.supported.minimumMinor <= LOCAL_PROTOCOL.supported.maximumMinor
  );
}

export function createBridgeInstance(options: BridgeInstanceOptions): BridgeInstance {
  let port = options.port;
  let httpServer: HttpServer | undefined;
  const sessions = new Map<
    string,
    {
      server: McpServer;
      transport: StreamableHTTPServerTransport;
      incompatibleHealth?: Extract<HealthResult, { outcome: "incompatible" }>;
    }
  >();

  async function readBody(request: IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    if (chunks.length === 0) return undefined;
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  }

  function createMcpServer(sessionState: {
    incompatibleHealth?: Extract<HealthResult, { outcome: "incompatible" }>;
  }): McpServer {
    const server = new McpServer({
      name: "obsidian-vault-operation-bridge",
      version: PLUGIN_VERSION,
    });

    server.registerTool(
      "vault_health",
      {
        description: "Observe this Managed Vault's Bridge health evidence.",
        inputSchema: z.object({}).strict(),
      },
      () => {
        const health =
          sessionState.incompatibleHealth ?? projectObservedHealth(options.health, port);
        return {
          content: [{ type: "text", text: serializeCompatibilityText(health) }],
          structuredContent: health,
          isError: false,
        };
      },
    );

    if (options.readDataSource !== undefined) {
      server.registerTool(
        "vault_read",
        {
          description:
            "Read ordered metadata, outline, heading section, and exact Markdown observations.",
          inputSchema: readInputSchema,
        },
        async (arguments_) => {
          const input = parseReadInput(arguments_);
          const effectiveGate = sessionState.incompatibleHealth?.gate ?? options.health.effectiveGate;
          const blocksContent =
            effectiveGate?.code === "incompatible_protocol" ||
            effectiveGate?.code === "recovery_in_progress" ||
            effectiveGate?.code === "recovery_blocked";
          const result = blocksContent
            ? parseReadResult({ outcome: "operationally_blocked", gate: effectiveGate })
            : await performVaultRead(options.readDataSource!, input);
          return {
            content: [{ type: "text", text: serializeReadCompatibilityText(result) }],
            structuredContent: result,
            isError:
              result.outcome === "grouping_required" ||
              result.outcome === "operationally_blocked",
          };
        },
      );
    }

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
    if (
      options.authenticator !== undefined &&
      !(await options.authenticator.authenticate(request))
    ) {
      rejectRequest(response, "authentication_failed");
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
      const sessionState: {
        incompatibleHealth?: Extract<HealthResult, { outcome: "incompatible" }>;
      } = {};
      if (options.peerProtocol !== undefined && !protocolsOverlap(options.peerProtocol)) {
        sessionState.incompatibleHealth = projectIncompatibleHealth(options.peerProtocol);
      }
      const server = createMcpServer(sessionState);
      transport.onclose = () => {
        if (transport.sessionId !== undefined) sessions.delete(transport.sessionId);
      };
      await server.connect(transport);
      await transport.handleRequest(request, response, body);
      if (transport.sessionId !== undefined) {
        sessions.set(transport.sessionId, { server, transport, ...sessionState });
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
