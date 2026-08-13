import { Buffer } from "node:buffer";
import { createServer, type IncomingMessage, type Server as HttpServer } from "node:http";
import { randomUUID } from "node:crypto";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import {
  changeSetSubmitInputSchema,
  continueInputSchema,
  createChangeSetStatusInputJsonSchema,
  discoverInputSchema,
  parseChangeSetStatusInput,
  parseChangeSetStatusResult,
  parseChangeSetSubmitResult,
  parseContinueInput,
  parseContinueResult,
  parseDiscoverInput,
  parseDiscoverResult,
  parseHealthResult,
  parseReadInput,
  parseReadResult,
  readInputSchema,
  serializeChangeSetStatusCompatibilityText,
  serializeChangeSetSubmitCompatibilityText,
  serializeCompatibilityText,
  serializeContinueCompatibilityText,
  serializeDiscoverCompatibilityText,
  serializeReadCompatibilityText,
  serializeReadToolCompatibilityText,
  type ContinueResult,
  type DiscoverResult,
  type HealthResult,
} from "@llm-wiki/vault-contracts";
import { z } from "zod";

import {
  ChangeSetService,
  RECOVERY_JOURNAL_FRAME_SCHEMA_VERSION,
  type ChangeSetServiceOptions,
} from "./change-set.js";
import { rejectRequest, verifyRequestPolicy } from "./request-policy.js";
import { createRegistrationCommand } from "./registration-command.js";
import { performVaultRead, type VaultReadDataSource } from "./vault-read.js";
import {
  MAXIMUM_COMPACT_RESPONSE_BYTES,
  createVaultContinuationStore,
} from "./vault-continuation.js";
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

export interface BridgeDiscoverService {
  execute(input: unknown, clientId: string): Promise<DiscoverResult>;
  releaseClient(clientId: string): void;
}

export interface BridgeInstanceOptions {
  port: number;
  health: BridgeHealthState;
  peerProtocol?: ProtocolParticipant;
  authenticator?: BridgeRequestAuthenticator;
  readDataSource?: VaultReadDataSource;
  discoverService?: BridgeDiscoverService;
  searchSnapshotReadiness?: () => "ready" | "building" | "unavailable";
  changeSets?: ChangeSetServiceOptions;
  continuationNow?: () => number;
  continuationToken?: () => string;
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
  searchSnapshotReadiness?: () => "ready" | "building" | "unavailable",
): HealthResult {
  const snapshotReadiness = searchSnapshotReadiness?.() ?? state.readiness.searchSnapshot;
  const dynamicSnapshotState = searchSnapshotReadiness !== undefined;
  const snapshotNotReady = dynamicSnapshotState && snapshotReadiness !== "ready";
  const initialSnapshotReasonCodes = new Set([
    "content_tools_not_ready",
    "search_snapshot_building",
    "search_snapshot_unavailable",
  ]);
  const stableReasonCodes = dynamicSnapshotState
    ? state.reasonCodes.filter((code) => !initialSnapshotReasonCodes.has(code))
    : state.reasonCodes;
  if (
    dynamicSnapshotState &&
    state.effectiveGate !== null &&
    !stableReasonCodes.includes(state.effectiveGate.code)
  ) {
    stableReasonCodes.push(state.effectiveGate.code);
  }
  const reasonCode =
    snapshotReadiness === "building"
      ? "search_snapshot_building"
      : "search_snapshot_unavailable";
  return parseHealthResult({
    outcome: "observed",
    vault: state.vault,
    versions: {
      bridge: BRIDGE_VERSION,
      plugin: PLUGIN_VERSION,
      protocol: PROTOCOL_VERSION,
      persistentStateSchema: 2,
      recoveryJournalSchema: RECOVERY_JOURNAL_FRAME_SCHEMA_VERSION,
    },
    listener: { address: LOOPBACK_ADDRESS, port },
    readiness: {
      ...state.readiness,
      searchSnapshot: snapshotReadiness,
      index:
        searchSnapshotReadiness === undefined
          ? state.readiness.index
          : snapshotReadiness,
    },
    recovery: state.recovery,
    write: state.write,
    queue: state.queue,
    lifecycle: state.lifecycle,
    effectiveGate: state.effectiveGate,
    overall:
      snapshotNotReady && state.overall === "healthy" ? "degraded" : state.overall,
    reasonCodes: snapshotNotReady
      ? [...new Set([...stableReasonCodes, reasonCode])]
      : stableReasonCodes,
    operatorAction:
      snapshotNotReady &&
      (state.operatorAction === "none" ||
        state.operatorAction === "finish_initialization")
        ? "wait_for_readiness"
        : dynamicSnapshotState &&
            snapshotReadiness === "ready" &&
            state.effectiveGate?.code === "writes_paused" &&
            state.operatorAction === "finish_initialization"
          ? "resume_writes"
          : state.operatorAction,
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

function projectEffectiveGate(state: BridgeHealthState): NonNullable<BridgeHealthState["effectiveGate"]> | null {
  if (state.recovery.state === "blocked") return { code: "recovery_blocked" };
  if (state.recovery.state === "in_progress") return { code: "recovery_in_progress" };
  return state.effectiveGate;
}

function blocksVaultContent(
  gate: { code: string } | null | undefined,
): gate is {
  code: "incompatible_protocol" | "recovery_in_progress" | "recovery_blocked";
} {
  return (
    gate?.code === "incompatible_protocol" ||
    gate?.code === "recovery_in_progress" ||
    gate?.code === "recovery_blocked"
  );
}

export function createBridgeInstance(options: BridgeInstanceOptions): BridgeInstance {
  let port = options.port;
  let httpServer: HttpServer | undefined;
  let changeSetService: ChangeSetService | undefined;
  const continuationStore = createVaultContinuationStore({
    now: options.continuationNow,
    token: options.continuationToken,
    measureResponse: (result) => {
      const text = serializeContinueCompatibilityText(result);
      return Buffer.byteLength(
        JSON.stringify({
          content: [{ type: "text", text }],
          structuredContent: result,
          isError: false,
        }),
        "utf8",
      );
    },
  });
  const sessions = new Map<
    string,
    {
      server: McpServer;
      transport: StreamableHTTPServerTransport;
      clientId?: string;
      incompatibleHealth?: Extract<HealthResult, { outcome: "incompatible" }>;
    }
  >();

  function releaseSession(sessionId: string): void {
    if (!sessions.delete(sessionId)) return;
    continuationStore.releaseClient(sessionId);
    options.discoverService?.releaseClient(sessionId);
  }

  async function readBody(request: IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    if (chunks.length === 0) return undefined;
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  }

  function createMcpServer(sessionState: {
    clientId?: string;
    incompatibleHealth?: Extract<HealthResult, { outcome: "incompatible" }>;
  }): McpServer {
    const server = new McpServer({
      name: "obsidian-vault-operation-bridge",
      version: PLUGIN_VERSION,
    });
    const requestState = () => ({
      vault: {
        writeGate: options.health.write.gate,
        writeState: options.health.write.state,
      },
      effectiveGate:
        sessionState.incompatibleHealth?.gate ?? projectEffectiveGate(options.health),
    });
    const healthInputSchema = {
      type: "object" as const,
      properties: {},
      additionalProperties: false,
    };
    const discoverToolInputSchema = z.toJSONSchema(discoverInputSchema, {
      target: "draft-2020-12",
    });
    const readToolInputSchema = z.toJSONSchema(readInputSchema, {
      target: "draft-2020-12",
    });
    const continueToolInputSchema = z.toJSONSchema(continueInputSchema, {
      target: "draft-2020-12",
    });
    const submitToolInputSchema = z.toJSONSchema(changeSetSubmitInputSchema, {
      target: "draft-2020-12",
    });
    const statusToolInputSchema = createChangeSetStatusInputJsonSchema();

    server.server.registerCapabilities({ tools: { listChanged: false } });
    server.server.setRequestHandler(ListToolsRequestSchema, () => ({
      tools: [
        {
          name: "vault_health",
          description: "Observe this Managed Vault's Bridge health evidence.",
          inputSchema: healthInputSchema,
        },
        ...(options.discoverService === undefined
          ? []
          : [
              {
                name: "vault_discover",
                description:
                  "Discover canonical Markdown paths and text evidence from one immutable Search Snapshot.",
                inputSchema: discoverToolInputSchema,
              },
            ]),
        ...(options.readDataSource === undefined
          ? []
          : [
              {
                name: "vault_read",
                description:
                  "Read ordered metadata, outline, heading section, and exact Markdown observations.",
                inputSchema: readToolInputSchema,
              },
              {
                name: "vault_continue",
                description: "Continue transporting one accepted frozen Vault read result.",
                inputSchema: continueToolInputSchema,
              },
            ]),
        ...(changeSetService === undefined
          ? []
          : [
              {
                name: "vault_change_set_submit",
                description:
                  "Preflight and durably register one idempotent Change Set intent without a separate apply handshake.",
                inputSchema: submitToolInputSchema,
              },
              {
                name: "vault_change_set_status",
                description:
                  "Look up a trusted Change Set proof record by Submission Key or Change Set identity.",
                inputSchema: statusToolInputSchema,
              },
            ]),
      ],
    }));
    server.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      try {
        if (request.params.name === "vault_health") {
        z.object({}).strict().parse(request.params.arguments ?? {});
        const health =
          sessionState.incompatibleHealth ??
          projectObservedHealth(options.health, port, options.searchSnapshotReadiness);
        return {
          content: [{ type: "text" as const, text: serializeCompatibilityText(health) }],
          structuredContent: health,
          isError: false,
        };
      }

      const incompatibleGate = sessionState.incompatibleHealth?.gate;
      if (incompatibleGate !== undefined) {
        if (request.params.name === "vault_change_set_status") {
          const result = parseChangeSetStatusResult({
            lookup: "operationally_blocked",
            gate: incompatibleGate,
          });
          return {
            content: [
              {
                type: "text" as const,
                text: serializeChangeSetStatusCompatibilityText(result),
              },
            ],
            structuredContent: result,
            isError: true,
          };
        }
        if (request.params.name === "vault_change_set_submit") {
          const result = parseChangeSetSubmitResult({
            outcome: "operationally_blocked",
            gate: incompatibleGate,
          });
          return {
            content: [
              {
                type: "text" as const,
                text: serializeChangeSetSubmitCompatibilityText(result),
              },
            ],
            structuredContent: result,
            isError: true,
          };
        }
      }

      if (request.params.name === "vault_discover" && options.discoverService !== undefined) {
        const input = parseDiscoverInput(request.params.arguments);
        const effectiveGate =
          sessionState.incompatibleHealth?.gate ?? projectEffectiveGate(options.health);
        let result: DiscoverResult;
        if (blocksVaultContent(effectiveGate)) {
          result = parseDiscoverResult({ outcome: "operationally_blocked", gate: effectiveGate });
        } else if (sessionState.clientId === undefined) {
          result = parseDiscoverResult({
            outcome: "snapshot_unavailable",
            code: "search_snapshot_unavailable",
          });
        } else {
          result = await options.discoverService.execute(input, sessionState.clientId);
        }
        return {
          content: [
            { type: "text" as const, text: serializeDiscoverCompatibilityText(result) },
          ],
          structuredContent: result,
          isError: result.outcome !== "results",
        };
      }

      if (request.params.name === "vault_read" && options.readDataSource !== undefined) {
        const input = parseReadInput(request.params.arguments);
        const effectiveGate =
          sessionState.incompatibleHealth?.gate ?? projectEffectiveGate(options.health);
        const result = blocksVaultContent(effectiveGate)
          ? parseReadResult({ outcome: "operationally_blocked", gate: effectiveGate })
          : await performVaultRead(options.readDataSource, input);
        const text = serializeReadCompatibilityText(result);
        const directResponseBytes = Buffer.byteLength(
          JSON.stringify({
            content: [{ type: "text", text }],
            structuredContent: result,
            isError:
              result.outcome === "grouping_required" ||
              result.outcome === "operationally_blocked",
          }),
          "utf8",
        );
        if (result.outcome === "items" && directResponseBytes > MAXIMUM_COMPACT_RESPONSE_BYTES) {
          if (sessionState.clientId === undefined) {
            throw new Error("MCP session identity is unavailable");
          }
          const page = continuationStore.issue(sessionState.clientId, result);
          return {
            content: [
              { type: "text" as const, text: serializeReadToolCompatibilityText(page) },
            ],
            structuredContent: page,
            isError: !("outcome" in page && page.outcome === "page"),
          };
        }
        return {
          content: [{ type: "text" as const, text }],
          structuredContent: result,
          isError:
            result.outcome === "grouping_required" ||
            result.outcome === "operationally_blocked",
        };
      }

      if (request.params.name === "vault_continue" && options.readDataSource !== undefined) {
        const input = parseContinueInput(request.params.arguments);
        const effectiveGate =
          sessionState.incompatibleHealth?.gate ?? projectEffectiveGate(options.health);
        let result: ContinueResult;
        if (blocksVaultContent(effectiveGate)) {
          result = parseContinueResult({ outcome: "operationally_blocked", gate: effectiveGate });
        } else if (sessionState.clientId === undefined) {
          result = parseContinueResult({ code: "continuation_unavailable" });
        } else {
          result = continuationStore.continue(sessionState.clientId, input.continuation);
        }
        return {
          content: [
            { type: "text" as const, text: serializeContinueCompatibilityText(result) },
          ],
          structuredContent: result,
          isError: !("outcome" in result && result.outcome === "page"),
        };
      }

      if (
        request.params.name === "vault_change_set_submit" &&
        changeSetService !== undefined
      ) {
        const parsed = changeSetSubmitInputSchema.safeParse(request.params.arguments);
        const result = parsed.success
          ? await changeSetService.submit(parsed.data, requestState())
          : parseChangeSetSubmitResult({ outcome: "request_invalid" });
        return {
          content: [
            {
              type: "text" as const,
              text: serializeChangeSetSubmitCompatibilityText(result),
            },
          ],
          structuredContent: result,
          isError:
            result.outcome !== "registered" ||
            result.changeSet.state === "intent_not_applied" ||
            result.changeSet.state === "result_unproven",
        };
      }

      if (
        request.params.name === "vault_change_set_status" &&
        changeSetService !== undefined
      ) {
        const result = await changeSetService.status(
          parseChangeSetStatusInput(request.params.arguments),
          requestState(),
        );
        return {
          content: [
            {
              type: "text" as const,
              text: serializeChangeSetStatusCompatibilityText(result),
            },
          ],
          structuredContent: result,
          isError: result.lookup === "operationally_blocked",
        };
      }

      throw new McpError(ErrorCode.InvalidParams, `Tool ${request.params.name} not found`);
      } catch (error) {
        if (error instanceof McpError) throw error;
        return {
          content: [
            {
              type: "text" as const,
              text: error instanceof Error ? error.message : "Tool execution failed",
            },
          ],
          isError: true,
        };
      }
    });

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
        clientId?: string;
        incompatibleHealth?: Extract<HealthResult, { outcome: "incompatible" }>;
      } = {};
      if (options.peerProtocol !== undefined && !protocolsOverlap(options.peerProtocol)) {
        sessionState.incompatibleHealth = projectIncompatibleHealth(options.peerProtocol);
      }
      const server = createMcpServer(sessionState);
      transport.onclose = () => {
        if (transport.sessionId !== undefined) releaseSession(transport.sessionId);
      };
      await server.connect(transport);
      await transport.handleRequest(request, response, body);
      if (transport.sessionId !== undefined) {
        sessionState.clientId = transport.sessionId;
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
      if (options.changeSets !== undefined) {
        const runtimeState = options.changeSets.runtimeState ?? {
          setQueue: (queue: BridgeHealthState["queue"]) => {
            options.health.queue = queue;
          },
          blockWritesForUnproven: () => {
            options.health.recovery = { state: "blocked" };
            options.health.write = {
              gate: "blocked",
              state: "paused",
              pauseSource: null,
            };
            options.health.effectiveGate = { code: "recovery_blocked" };
            options.health.overall = "blocked";
            options.health.reasonCodes = [
              ...new Set([...options.health.reasonCodes, "recovery_blocked"]),
            ];
            options.health.operatorAction = "review_recovery";
          },
        };
        changeSetService = await ChangeSetService.open({
          ...options.changeSets,
          vaultId: options.changeSets.vaultId ?? options.health.vault.id,
          runtimeState,
        });
      }
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
      const activeSessions = [...sessions.entries()];
      for (const [sessionId] of activeSessions) releaseSession(sessionId);
      await Promise.all(activeSessions.map(([, { server: mcp }]) => mcp.close()));
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      });
    },
    registrationCommand(serverName) {
      return createRegistrationCommand(options.health.vault.id, port, serverName);
    },
  };
}
