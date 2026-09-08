import { createHash } from "node:crypto";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  parseChangeSetStatusResult,
  parseChangeSetSubmitResult,
  parseContinueResult,
  parseDiscoverResult,
  parseHealthResult,
  parseReadToolResult,
  serializeChangeSetStatusCompatibilityText,
  serializeChangeSetSubmitCompatibilityText,
  serializeCompatibilityText,
  serializeContinueCompatibilityText,
  serializeDiscoverCompatibilityText,
  serializeReadToolCompatibilityText,
} from "@llm-wiki/vault-contracts";

import { EXPECTED_VAULT_ID_HEADER } from "../request-policy.js";

import type { PublicWireCorpusEvidence } from "./evidence.js";

export const PUBLIC_WIRE_TOOL_NAMES = [
  "vault_health",
  "vault_discover",
  "vault_read",
  "vault_continue",
  "vault_change_set_submit",
  "vault_change_set_status",
] as const;

export type PublicWireToolName = (typeof PUBLIC_WIRE_TOOL_NAMES)[number];

type McpToolResult = {
  readonly isError?: boolean;
  readonly structuredContent?: unknown;
  readonly content?: readonly unknown[];
};

export interface PublicWireScenarioFragment {
  readonly id: string;
  readonly tool: PublicWireToolName;
  readonly arguments: Record<string, unknown>;
  readonly expectedError: boolean;
  readonly assertResult: (value: unknown) => string;
}

export interface PublicWireCorpusManifest {
  readonly schemaVersion: 1;
  readonly fragments: readonly PublicWireScenarioFragment[];
}

export class PublicWireCorpusError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PublicWireCorpusError";
  }
}

export interface PublicWireCorpusResult {
  readonly evidence: PublicWireCorpusEvidence;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, canonicalize(nested)]),
  );
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function exactText(result: McpToolResult): string {
  const text = result.content?.find(
    (item): item is { readonly type: "text"; readonly text: string } =>
      typeof item === "object" &&
      item !== null &&
      (item as { readonly type?: unknown }).type === "text" &&
      typeof (item as { readonly text?: unknown }).text === "string",
  );
  if (text === undefined) throw new PublicWireCorpusError("Tool response has no compatibility text");
  return text.text;
}

function assertHealth(value: unknown): string {
  return serializeCompatibilityText(parseHealthResult(value));
}

function assertDiscover(value: unknown): string {
  return serializeDiscoverCompatibilityText(parseDiscoverResult(value));
}

function assertRead(value: unknown): string {
  return serializeReadToolCompatibilityText(parseReadToolResult(value));
}

function assertContinue(value: unknown): string {
  return serializeContinueCompatibilityText(parseContinueResult(value));
}

function assertSubmit(value: unknown): string {
  return serializeChangeSetSubmitCompatibilityText(parseChangeSetSubmitResult(value));
}

function assertStatus(value: unknown): string {
  return serializeChangeSetStatusCompatibilityText(parseChangeSetStatusResult(value));
}

function fragment(
  id: string,
  tool: PublicWireToolName,
  arguments_: Record<string, unknown>,
  expectedError: boolean,
  assertResult: (value: unknown) => string,
): PublicWireScenarioFragment {
  return { id, tool, arguments: arguments_, expectedError, assertResult };
}

export function registerHealthPublicWireFragment(register: (fragment: PublicWireScenarioFragment) => void): void {
  register(fragment("health/observed", "vault_health", {}, false, assertHealth));
}

export function registerDiscoverPublicWireFragment(register: (fragment: PublicWireScenarioFragment) => void): void {
  register(
    fragment(
      "discover/seeded-note",
      "vault_discover",
      {
        query: { path: { exact: "Notes/Welcome.md" } },
        projection: { matches: false },
        order: { by: "path", direction: "asc" },
        page: { maxItems: 10, continuation: null },
      },
      false,
      assertDiscover,
    ),
  );
}

export function registerReadPublicWireFragment(register: (fragment: PublicWireScenarioFragment) => void): void {
  register(
    fragment(
      "read/seeded-note",
      "vault_read",
      { items: [{ kind: "metadata", path: "Notes/Welcome.md" }] },
      false,
      assertRead,
    ),
  );
}

export function registerContinuePublicWireFragment(register: (fragment: PublicWireScenarioFragment) => void): void {
  register(
    fragment(
      "continue/unavailable-token",
      "vault_continue",
      { continuation: "public-wire-corpus-unavailable" },
      true,
      assertContinue,
    ),
  );
}

export function registerSubmitPublicWireFragment(register: (fragment: PublicWireScenarioFragment) => void): void {
  register(
    fragment(
      "change-set/submit-directory",
      "vault_change_set_submit",
      {
        submissionKey: "public-wire-corpus-submission",
        operations: [
          {
            operationId: "public-wire-create-directory",
            kind: "create_directory",
            path: "PublicWireCorpus",
            ifExists: "reject",
          },
        ],
      },
      false,
      assertSubmit,
    ),
  );
}

export function registerStatusPublicWireFragment(register: (fragment: PublicWireScenarioFragment) => void): void {
  register(
    fragment(
      "change-set/status-directory",
      "vault_change_set_status",
      { submissionKey: "public-wire-corpus-submission" },
      false,
      assertStatus,
    ),
  );
}

/**
 * Builds the first authority manifest by independent fragment registration.
 * Additional tracers extend it through the registrar rather than changing a
 * shared hand-maintained scenario array.
 */
export function createPublicWireCorpusManifest(
  registerFragments: (
    register: (fragment: PublicWireScenarioFragment) => void,
  ) => void = registerAuthoritativePublicWireFragments,
): PublicWireCorpusManifest {
  const fragments: PublicWireScenarioFragment[] = [];
  registerFragments((candidate) => {
    if (fragments.some(({ id }) => id === candidate.id)) {
      throw new PublicWireCorpusError(`Duplicate public-wire fragment: ${candidate.id}`);
    }
    fragments.push(candidate);
  });
  if (new Set(fragments.map(({ tool }) => tool)).size !== PUBLIC_WIRE_TOOL_NAMES.length) {
    throw new PublicWireCorpusError("The authoritative public-wire manifest must contain exactly six tools");
  }
  return {
    schemaVersion: 1,
    fragments: fragments.map((candidate) => ({
      ...candidate,
      arguments: structuredClone(candidate.arguments),
    })),
  };
}

export function canonicalPublicWireCorpusManifest(manifest: PublicWireCorpusManifest): {
  readonly schemaVersion: 1;
  readonly fragments: readonly {
    readonly id: string;
    readonly tool: PublicWireToolName;
    readonly arguments: Record<string, unknown>;
    readonly expectedError: boolean;
  }[];
} {
  return {
    schemaVersion: manifest.schemaVersion,
    fragments: manifest.fragments
      .map(({ id, tool, arguments: arguments_, expectedError }) => ({
        id,
        tool,
        arguments: structuredClone(arguments_),
        expectedError,
      }))
      .sort((left, right) => left.id.localeCompare(right.id)),
  };
}

export function registerAuthoritativePublicWireFragments(
  register: (fragment: PublicWireScenarioFragment) => void,
): void {
  registerHealthPublicWireFragment(register);
  registerDiscoverPublicWireFragment(register);
  registerReadPublicWireFragment(register);
  registerContinuePublicWireFragment(register);
  registerSubmitPublicWireFragment(register);
  registerStatusPublicWireFragment(register);
}

async function assertRejectedInitialization(endpoint: URL, expectedVaultId: string): Promise<void> {
  const cases: readonly [string, HeadersInit][] = [
    ["missing Vault identity", {}],
    ["mismatched Vault identity", { [EXPECTED_VAULT_ID_HEADER]: `${expectedVaultId}-wrong` }],
    [
      "unsafe Host",
      {
        [EXPECTED_VAULT_ID_HEADER]: expectedVaultId,
        Host: "outside.example:80",
      },
    ],
    [
      "unsafe Origin",
      {
        [EXPECTED_VAULT_ID_HEADER]: expectedVaultId,
        Origin: "http://outside.example",
      },
    ],
  ];
  for (const [label, headers] of cases) {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });
    if (response.status !== 403) {
      throw new PublicWireCorpusError(`${label} did not fail at the connection boundary`);
    }
  }
}

export async function runPublicWireCorpus(options: {
  readonly endpoint: URL;
  readonly expectedVaultId: string;
  readonly fixtureSeed: string;
  readonly registerFragments?: (
    register: (fragment: PublicWireScenarioFragment) => void,
  ) => void;
}): Promise<PublicWireCorpusResult> {
  if (options.endpoint.protocol !== "http:" || options.endpoint.hostname !== "127.0.0.1") {
    throw new PublicWireCorpusError("Public-wire corpus requires a 127.0.0.1 HTTP endpoint");
  }
  const manifest = createPublicWireCorpusManifest(options.registerFragments);
  const manifestSha256 = sha256(canonicalJson(canonicalPublicWireCorpusManifest(manifest)));
  const events: Array<PublicWireCorpusEvidence["eventLog"][number]> = [];
  const assertions: string[] = [];
  const record = (kind: PublicWireCorpusEvidence["eventLog"][number]["kind"], name: string, detail: unknown) => {
    events.push({ sequence: events.length + 1, kind, name, detailSha256: sha256(canonicalJson(detail)) });
  };

  const client = new Client({ name: "installed-runtime-public-wire-corpus", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(options.endpoint, {
    requestInit: { headers: { [EXPECTED_VAULT_ID_HEADER]: options.expectedVaultId } },
  });
  try {
    await assertRejectedInitialization(options.endpoint, options.expectedVaultId);
    record("assertion", "connection-boundaries", { rejected: 4 });
    await client.connect(transport);
    record("transport", "streamable-http-connected", { endpoint: options.endpoint.pathname });

    const inventory = await client.listTools();
    const listed = inventory.tools.map(({ name }) => name).sort();
    const expected = [...PUBLIC_WIRE_TOOL_NAMES].sort();
    if (JSON.stringify(listed) !== JSON.stringify(expected)) {
      throw new PublicWireCorpusError(`Public tool inventory differs from the six-tool contract: ${listed.join(",")}`);
    }
    record("assertion", "public-tool-inventory", listed);
    assertions.push("public-tool-inventory");

    for (const item of manifest.fragments) {
      const result = (await client.callTool({
        name: item.tool,
        arguments: item.arguments,
      })) as McpToolResult;
      if ((result.isError === true) !== item.expectedError) {
        throw new PublicWireCorpusError(`${item.id} returned an unexpected MCP error disposition`);
      }
      if (result.structuredContent === undefined) {
        throw new PublicWireCorpusError(`${item.id} omitted authoritative structured content`);
      }
      const authoritativeText = item.assertResult(result.structuredContent);
      if (exactText(result) !== authoritativeText) {
        throw new PublicWireCorpusError(`${item.id} compatibility text diverged from structured content`);
      }
      record("tool", item.tool, result.structuredContent);
      assertions.push(`${item.id}:structured-content-equivalence`);
    }
    const invoked = events.filter(({ kind }) => kind === "tool").map(({ name }) => name).sort();
    if (JSON.stringify(invoked) !== JSON.stringify(expected)) {
      throw new PublicWireCorpusError("The corpus did not invoke each public tool exactly once");
    }
    record("assertion", "six-tool-invocation", invoked);
    assertions.push("six-tool-invocation");

    return {
      evidence: {
        fixtureSeed: sha256(options.fixtureSeed),
        canonicalManifestSha256: manifestSha256,
        tools: [...PUBLIC_WIRE_TOOL_NAMES],
        eventLog: events,
        assertions,
        verdict: "passed",
      },
    };
  } finally {
    await client.close().catch(() => undefined);
  }
}
