import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  parseHealthResult,
  serializeCompatibilityText,
  type HealthResult,
} from "@llm-wiki/vault-contracts";

import { EXPECTED_VAULT_ID_HEADER } from "../request-policy.js";

/**
 * Loopback MCP access seam (issue #197): one real Streamable HTTP client that
 * initializes with the expected Vault ID and obtains a schema-valid
 * `vault_health` result from the loaded candidate. Every structural,
 * identity, or boundary violation throws a typed failure — the harness turns
 * those into failed evidence, never into skipped green results.
 */

export type ObservedHealth = Extract<HealthResult, { outcome: "observed" }>;

export type HealthObservationFailureCode =
  | "endpoint_not_loopback"
  | "health_unreachable"
  | "health_schema_invalid"
  | "health_incompatible"
  | "identity_mismatch"
  | "listener_mismatch"
  | "representation_mismatch";

export class HealthObservationError extends Error {
  constructor(
    message: string,
    readonly code: HealthObservationFailureCode,
  ) {
    super(message);
    this.name = "HealthObservationError";
  }
}

export interface BridgeHealthObservation {
  /** The expected Vault ID that was asserted and matched. */
  readonly expectedVaultId: string;
  readonly health: ObservedHealth;
}

export interface LoopbackMcpClient {
  observeHealth(endpoint: URL, expectedVaultId: string): Promise<BridgeHealthObservation>;
}

export interface LoopbackMcpClientOptions {
  readonly clientName?: string;
  readonly clientVersion?: string;
  readonly timeoutMs?: number;
}

function assertLoopbackEndpoint(endpoint: URL): void {
  if (
    endpoint.protocol !== "http:" ||
    (endpoint.hostname !== "127.0.0.1" && endpoint.hostname !== "localhost")
  ) {
    throw new HealthObservationError(
      "Bridge endpoint escaped the loopback boundary",
      "endpoint_not_loopback",
    );
  }
}

export function createLoopbackMcpClient(
  options: LoopbackMcpClientOptions = {},
): LoopbackMcpClient {
  return {
    async observeHealth(endpoint, expectedVaultId) {
      assertLoopbackEndpoint(endpoint);
      if (expectedVaultId.length === 0) {
        throw new HealthObservationError(
          "The expected Vault ID must not be empty",
          "identity_mismatch",
        );
      }
      const client = new Client({
        name: options.clientName ?? "installed-runtime-harness",
        version: options.clientVersion ?? "1.0.0",
      });
      const transport = new StreamableHTTPClientTransport(endpoint, {
        requestInit: { headers: { [EXPECTED_VAULT_ID_HEADER]: expectedVaultId } },
      });
      let raw: unknown;
      try {
        await client.connect(transport);
        const result = await client.callTool({ name: "vault_health", arguments: {} });
        if (result.isError === true) {
          throw new HealthObservationError(
            "vault_health reported a request-level error",
            "health_unreachable",
          );
        }
        raw = result.structuredContent;
        const text = Array.isArray(result.content)
          ? result.content.find(
              (item) => typeof item === "object" && item !== null && item.type === "text",
            )
          : undefined;
        if (raw === undefined) {
          throw new HealthObservationError(
            "vault_health returned no structured content",
            "health_schema_invalid",
          );
        }
        let health: HealthResult;
        try {
          health = parseHealthResult(raw);
        } catch {
          throw new HealthObservationError(
            "vault_health result failed contract schema validation",
            "health_schema_invalid",
          );
        }
        if (health.outcome !== "observed") {
          throw new HealthObservationError(
            "vault_health reported the incompatible branch",
            "health_incompatible",
          );
        }
        // Spec §6.7: the compatibility text must be an identical serialization
        // of the authoritative structured content.
        const textValue =
          text !== undefined && "text" in text && typeof text.text === "string"
            ? text.text
            : undefined;
        if (textValue !== serializeCompatibilityText(health)) {
          throw new HealthObservationError(
            "vault_health structured and text representations diverge",
            "representation_mismatch",
          );
        }
        if (health.vault.id !== expectedVaultId) {
          throw new HealthObservationError(
            "The connected Bridge Instance belongs to a different Vault",
            "identity_mismatch",
          );
        }
        const expectedPort = Number(endpoint.port);
        if (
          health.listener.address !== "127.0.0.1" ||
          (Number.isInteger(expectedPort) && health.listener.port !== expectedPort)
        ) {
          throw new HealthObservationError(
            "The reported listener escaped the expected loopback endpoint",
            "listener_mismatch",
          );
        }
        return { expectedVaultId, health };
      } catch (error) {
        if (error instanceof HealthObservationError) throw error;
        throw new HealthObservationError(
          `Bridge health observation failed: ${error instanceof Error ? error.message : String(error)}`,
          "health_unreachable",
        );
      } finally {
        await client.close().catch(() => undefined);
      }
    },
  };
}
