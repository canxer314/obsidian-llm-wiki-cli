import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { dirname, join, relative, resolve } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { parseDiscoverResult } from "@llm-wiki/vault-contracts";

import { EXPECTED_VAULT_ID_HEADER } from "../request-policy.js";
import { installCandidateBundle } from "./candidate-bundle.js";
import type { InstalledRuntimeHarnessOptions } from "./harness.js";
import {
  readPersistedBridgeIdentity,
  waitForCondition,
  type ObsidianProcessHandle,
  type PersistedBridgeIdentity,
} from "./obsidian-process.js";
import {
  registeredReferenceRewriteFixtures,
  runRegisteredReferenceRewriteCorpus,
  type RegisteredReferenceRewriteArrange,
  type RegisteredReferenceRewriteFixture,
  type RegisteredReferenceRewriteRejectionSession,
  type WireClient,
} from "./registered-reference-rewrite-corpus.js";
import type { ProvisionedTestVault } from "./test-vault.js";

type RegisteredReferenceRunner = NonNullable<
  InstalledRuntimeHarnessOptions["runRegisteredReferenceRewriteCorpus"]
>;
type RegisteredReferenceRunnerOptions = Parameters<RegisteredReferenceRunner>[0];
type WireToolName = Parameters<WireClient["callTool"]>[0];
type McpToolResult = Awaited<ReturnType<WireClient["callTool"]>>;

const REJECTION_FIXTURES = [
  {
    scenario: "reject/duplicate-basename-ambiguous",
    fixtures: [
      { path: "ReferenceProof/Amb/A/Shared.md", content: "# A Shared\n" },
      { path: "ReferenceProof/Amb/B/Shared.md", content: "# B Shared\n" },
      { path: "ReferenceProof/Amb/AmbRef.md", content: "See [[Shared]].\n" },
    ],
    sourcePath: "ReferenceProof/Amb/A/Shared.md",
    destinationPath: "ReferenceProof/Amb/A/Shared Moved.md",
  },
  {
    scenario: "reject/invalid-fragment-closed",
    fixtures: [
      { path: "ReferenceProof/Fragment/Source.md", content: "# Source\n" },
      {
        path: "ReferenceProof/Fragment/FragRef.md",
        content: "See [[Source#Missing]] now.\n",
      },
    ],
    sourcePath: "ReferenceProof/Fragment/Source.md",
    destinationPath: "ReferenceProof/Fragment/Source Moved.md",
  },
  {
    scenario: "reject/duplicate-heading-closed",
    fixtures: [
      {
        path: "ReferenceProof/Heading/Head.md",
        content: "# Head\n\n## Duplicated\n\n## Duplicated\n",
      },
      {
        path: "ReferenceProof/Heading/HeadRef.md",
        content: "See [[Head#Duplicated]].\n",
      },
    ],
    sourcePath: "ReferenceProof/Heading/Head.md",
    destinationPath: "ReferenceProof/Heading/Head Moved.md",
  },
] as const satisfies readonly {
  readonly scenario: string;
  readonly fixtures: readonly RegisteredReferenceRewriteFixture[];
  readonly sourcePath: string;
  readonly destinationPath: string;
}[];

interface LiveRegisteredReferenceRuntime {
  readonly vault: ProvisionedTestVault;
  readonly identity: PersistedBridgeIdentity;
  readonly endpoint: URL;
  readonly process: ObsidianProcessHandle;
  readonly clients: Client[];
  readonly arrange: RegisteredReferenceRewriteArrange;
  connectClient(): Promise<Client>;
  callTool(client: Client, tool: WireToolName, arguments_: Record<string, unknown>): Promise<McpToolResult>;
}

function fixturePath(vaultPath: string, path: string): string {
  const destination = resolve(vaultPath, ...path.split("/"));
  const traversal = relative(resolve(vaultPath), destination);
  if (traversal === "" || traversal.startsWith("..") || resolve(traversal) === traversal) {
    throw new Error(`Registered-reference fixture path escaped the generated Vault: ${path}`);
  }
  return destination;
}

async function writeFixtures(
  vaultPath: string,
  fixtures: readonly RegisteredReferenceRewriteFixture[],
): Promise<void> {
  for (const fixture of fixtures) {
    const destination = fixturePath(vaultPath, fixture.path);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, fixture.content, "utf8");
  }
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function requireListenerClosed(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (await new Promise<boolean>((resolve) => {
    const socket = connect({ host: "127.0.0.1", port });
    socket.setTimeout(Math.max(1, deadline - Date.now()));
    socket.once("connect", () => { socket.destroy(); resolve(true); });
    socket.once("error", (error: NodeJS.ErrnoException) => {
      socket.destroy();
      resolve(error.code !== "ECONNREFUSED");
    });
    socket.once("timeout", () => { socket.destroy(); resolve(true); });
  })) {
    if (Date.now() >= deadline) {
      throw new Error("Registered-reference listener survived the controlled Obsidian stop");
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function startRuntime(
  options: RegisteredReferenceRunnerOptions,
  label: string,
  fixtures: readonly RegisteredReferenceRewriteFixture[],
  expectedSnapshotOutcome: "results" | "snapshot_unavailable",
): Promise<LiveRegisteredReferenceRuntime> {
  const vault = await options.provisionVault({
    workingDirectory: options.workingDirectory,
    runId: `${options.runId}-registered-reference-${label}`,
    configDirectoryName: options.configDirectoryName,
  });
  let process: ObsidianProcessHandle | undefined;
  const clients: Client[] = [];
  try {
    await writeFixtures(vault.vaultPath, fixtures);
    await installCandidateBundle(
      options.candidate,
      vault.vaultPath,
      options.configDirectoryName,
    );
    process = await options.processControl.start({
      vaultPath: vault.vaultPath,
      profileDirectory: vault.profileDirectory,
    });

    let observedIdentity: PersistedBridgeIdentity | null = null;
    await waitForCondition(
      async () => {
        observedIdentity = await readPersistedBridgeIdentity(
          vault.vaultPath,
          options.candidate.identity.pluginId,
          options.configDirectoryName,
        );
        return observedIdentity !== null;
      },
      { timeoutMs: options.timeouts.startupMs },
    );
    if (observedIdentity === null) {
      throw new Error("Registered-reference runtime did not persist a Bridge identity");
    }
    const identity: PersistedBridgeIdentity = observedIdentity;
    const endpoint = new URL(`http://127.0.0.1:${identity.port}/mcp`);
    await waitForCondition(
      async () => {
        try {
          await options.client.observeHealth(endpoint, identity.vaultId);
          return true;
        } catch {
          return false;
        }
      },
      { timeoutMs: options.timeouts.startupMs },
    );

    const connectClient = async (): Promise<Client> => {
      const client = new Client({
        name: `installed-registered-reference-${label}`,
        version: "1.0.0",
      });
      try {
        await client.connect(
          new StreamableHTTPClientTransport(endpoint, {
            requestInit: {
              headers: { [EXPECTED_VAULT_ID_HEADER]: identity.vaultId },
            },
          }),
        );
      } catch (error) {
        await client.close().catch(() => undefined);
        throw error;
      }
      clients.push(client);
      return client;
    };
    const callTool = async (
      client: Client,
      tool: WireToolName,
      arguments_: Record<string, unknown>,
    ): Promise<McpToolResult> =>
      (await client.callTool({
        name: tool,
        arguments: arguments_ as never,
      })) as McpToolResult;

    const readinessClient = await connectClient();
    await waitForCondition(
      async () => {
        try {
          const result = await callTool(readinessClient, "vault_discover", {
            query: { path: { prefix: "Notes/" } },
            projection: { matches: false },
            order: { by: "path", direction: "asc" },
            page: { maxItems: 1_000, continuation: null },
          });
          if (result.structuredContent === undefined) return false;
          return parseDiscoverResult(result.structuredContent).outcome === expectedSnapshotOutcome;
        } catch {
          return false;
        }
      },
      { timeoutMs: options.timeouts.startupMs, intervalMs: 50 },
    );

    let pendingPublication: { readonly path: string; readonly digest: string } | null = null;
    const arrange: RegisteredReferenceRewriteArrange = {
      async readBinary(path) {
        try {
          return new Uint8Array(await readFile(fixturePath(vault.vaultPath, path)));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
          throw error;
        }
      },
      async writeBinary(path, bytes) {
        const destination = fixturePath(vault.vaultPath, path);
        await mkdir(dirname(destination), { recursive: true });
        await writeFile(destination, bytes);
        pendingPublication = { path, digest: sha256(bytes) };
      },
      async publishSnapshot() {
        const expected = pendingPublication;
        if (expected === null) {
          throw new Error("Registered-reference snapshot publication has no pending file write");
        }
        await waitForCondition(
          async () => {
            try {
              const result = await callTool(readinessClient, "vault_discover", {
                query: { path: { prefix: expected.path } },
                projection: { matches: false },
                order: { by: "path", direction: "asc" },
                page: { maxItems: 1_000, continuation: null },
              });
              if (result.structuredContent === undefined) return false;
              const discovery = parseDiscoverResult(result.structuredContent);
              return (
                discovery.outcome === "results" &&
                discovery.items.some(
                  (item) =>
                    item.path === expected.path &&
                    item.contentVersion === `sha256:${expected.digest}`,
                )
              );
            } catch {
              return false;
            }
          },
          { timeoutMs: options.timeouts.startupMs, intervalMs: 50 },
        );
        pendingPublication = null;
      },
    };

    options.record("transport", "registered-reference-runtime-ready", {
      label,
      endpoint: endpoint.pathname,
      snapshotOutcome: expectedSnapshotOutcome,
    });
    return {
      vault,
      identity,
      endpoint,
      process,
      clients,
      arrange,
      connectClient,
      callTool,
    };
  } catch (error) {
    for (const client of clients.reverse()) await client.close().catch(() => undefined);
    if (process !== undefined) {
      await process.stop();
      const identity = await readPersistedBridgeIdentity(
        vault.vaultPath, options.candidate.identity.pluginId, options.configDirectoryName,
      );
      if (identity !== null) await requireListenerClosed(identity.port, options.timeouts.portClosedMs);
    }
    const cleanup = await options.cleanupVault(vault);
    if (cleanup.residualPaths.length > 0) {
      throw new Error(
        `Registered-reference setup failed and cleanup left residual paths: ${cleanup.residualPaths.join(", ")}`,
        { cause: error },
      );
    }
    throw error;
  }
}

async function cleanupRuntimes(
  options: RegisteredReferenceRunnerOptions,
  runtimes: readonly LiveRegisteredReferenceRuntime[],
): Promise<void> {
  let firstError: unknown;
  for (const runtime of [...runtimes].reverse()) {
    for (const client of [...runtime.clients].reverse()) {
      try {
        await client.close();
      } catch (error) {
        firstError ??= error;
      }
    }
    try {
      await runtime.process.stop();
      await requireListenerClosed(runtime.identity.port, options.timeouts.portClosedMs);
    } catch (error) {
      firstError ??= error;
      // Never remove a Vault underneath an unconfirmed live process/listener.
      continue;
    }
    try {
      const cleanup = await options.cleanupVault(runtime.vault);
      if (cleanup.residualPaths.length > 0) {
        firstError ??= new Error(
          `Registered-reference cleanup left residual paths: ${cleanup.residualPaths.join(", ")}`,
        );
      }
    } catch (error) {
      firstError ??= error;
    }
  }
  if (firstError !== undefined) throw firstError;
}

/**
 * Runs the existing issue #178 corpus against only installed candidate Bridges.
 * Every fail-closed reference arrangement gets a dedicated generated Vault so
 * malformed Search Snapshot evidence cannot affect another scenario.
 */
export const runInstalledRegisteredReferenceRewriteCorpus: RegisteredReferenceRunner =
  async (options) => {
    const runtimes: LiveRegisteredReferenceRuntime[] = [];
    try {
      const fixtures = registeredReferenceRewriteFixtures();
      const primary = await startRuntime(
        options,
        "primary",
        fixtures,
        "results",
      );
      runtimes.push(primary);
      const primaryClient = await primary.connectClient();
      const observerClient = await primary.connectClient();

      const rejectionSessions: RegisteredReferenceRewriteRejectionSession[] = [];
      for (const rejection of REJECTION_FIXTURES) {
        const runtime = await startRuntime(
          options,
          rejection.scenario.replaceAll(/[^A-Za-z0-9_-]/gu, "-"),
          [...fixtures, ...rejection.fixtures],
          "snapshot_unavailable",
        );
        runtimes.push(runtime);
        const client = await runtime.connectClient();
        rejectionSessions.push({
          scenario: rejection.scenario,
          sourcePath: rejection.sourcePath,
          destinationPath: rejection.destinationPath,
          callTool: (tool, arguments_) => runtime.callTool(client, tool, arguments_),
          arrange: runtime.arrange,
          expectSnapshotUnavailable: true,
        });
      }

      return await runRegisteredReferenceRewriteCorpus({
        session: {
          callTool: (tool, arguments_) =>
            primary.callTool(primaryClient, tool, arguments_),
          arrange: primary.arrange,
          observer: {
            callTool: (tool, arguments_) =>
              primary.callTool(observerClient, tool, arguments_),
          },
          seedNotes: primary.vault.seedNotes,
          fixtures,
          rejectionSessions,
        },
        record: options.record,
        assertion: options.assertion,
      });
    } finally {
      await cleanupRuntimes(options, runtimes);
    }
  };
