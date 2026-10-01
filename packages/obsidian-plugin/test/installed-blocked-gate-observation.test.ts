import { createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { expect, it } from "vitest";
import { createBridgeInstance } from "../src/bridge-instance.js";
import { ManagedVaultBridgeRuntime, type PersistedBridgeSettings } from "../src/managed-vault-runtime.js";
import { observeInstalledBlockedGate } from "../src/installed-runtime/installed-blocked-gate-observation.js";

it("observes recovery-blocked gates and terminal history over public MCP after actual journal failure", async () => {
  const stored: PersistedBridgeSettings = {
    schemaVersion: 2, vaultId: "blocked-vault", port: 27123, diagnosticPath: "D:/Generated",
    changeSets: { schemaVersion: 2, nextEnqueueSeq: 2, tombstones: [], entries: [{
      submissionKey: "known-terminal", fingerprint: `sha256:${"a".repeat(64)}`,
      changeSetId: "known-change-set", enqueueSeq: 1, acceptedAt: Date.now(),
      expiresAt: Number.MAX_SAFE_INTEGER,
      changeSet: { changeSetId: "known-change-set", state: "result_unproven" },
    }] },
  };
  const runtime = new ManagedVaultBridgeRuntime({
    vault: { name: "Generated", path: "D:/Generated" },
    settings: { load: async () => stored, save: async () => undefined },
    readDataSource: { readBinary: async () => null, parseFrontmatter: () => null, headings: () => null },
    searchDataSource: { listMarkdownPaths: async () => ["Notes/Welcome.md"], readBinary: async () => null },
    changeSetDataSource: { readBinary: async () => null, pathKind: async () => null, isContained: async () => true },
    changeSetExecution: {
      loadRecoveryFrame: async () => { throw new Error("journal unavailable"); },
      persistRecoveryFrame: async () => undefined, pathKind: async () => null,
      directoryIdentity: async () => null, prepareDirectory: async () => "directory",
      publishDirectory: async () => undefined, discardPreparedDirectory: async () => undefined,
      removeDirectory: async () => undefined, publishSearchSnapshot: async () => undefined,
    },
    createBridge: options => createBridgeInstance({ ...options, port: 0 }),
  });
  const client = new Client({ name: "blocked-gate-test", version: "1.0.0" });
  try {
    await runtime.load();
    await client.connect(new StreamableHTTPClientTransport(runtime.bridge!.endpoint, {
      requestInit: { headers: { "X-Expected-Vault-ID": "blocked-vault" } },
    }));
    const session = { callTool: async (name: string, arguments_: Record<string, unknown>) => client.callTool({ name, arguments: arguments_ }) };
    const result = await observeInstalledBlockedGate({ session,
      vaultIdSha256: createHash("sha256").update("blocked-vault").digest("hex"),
      knownSubmissionKey: "known-terminal",
    });
    expect(result).toMatchObject({ effectiveGate: "recovery_blocked", terminalHistoryPreserved: true,
      freshKeyInitiallyUnknown: true, freshKeyDisposition: "intent_not_applied" });
    expect(result.assertions).toContain("recovery-blocked-content-tools-gated");
    await expect(observeInstalledBlockedGate({ session, vaultIdSha256: "0".repeat(64),
      knownSubmissionKey: "known-terminal" })).rejects.toThrow("identity");
  } finally {
    await client.close().catch(() => undefined);
    await runtime.unload();
  }
});
