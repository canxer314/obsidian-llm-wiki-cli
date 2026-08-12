import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import {
  createBridgeInstance,
  type BridgeHealthState,
  type ChangeSetRegistryState,
  type ChangeSetRegistryStore,
} from "../src/index.js";

const DAY = 24 * 60 * 60 * 1_000;
const VERSION = (content: string) =>
  `sha256:${createHash("sha256").update(content).digest("hex")}`;

class MemoryChangeSetStore implements ChangeSetRegistryStore {
  state: unknown;
  saves = 0;
  failNextSave = false;

  async load(): Promise<unknown> {
    return structuredClone(this.state);
  }

  async save(state: ChangeSetRegistryState): Promise<void> {
    this.saves += 1;
    if (this.failNextSave) {
      this.failNextSave = false;
      throw new Error("injected persistence failure");
    }
    this.state = structuredClone(state);
  }
}

function healthState(): BridgeHealthState {
  return {
    vault: { id: "vault-a", name: "Alpha", path: "D:/Vaults/Alpha" },
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

async function connect(endpoint: URL): Promise<Client> {
  const client = new Client({ name: "change-set-test", version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(endpoint, {
      requestInit: { headers: { "X-Expected-Vault-ID": "vault-a" } },
    }),
  );
  return client;
}

function createNote(content = "hello") {
  return {
    submissionKey: "submission-1",
    operations: [
      {
        operationId: "create-1",
        kind: "create_note",
        path: "Notes/New.md",
        content,
        ifExists: "reject",
      },
    ],
  };
}

describe("public Change Set MCP tools", () => {
  it("replays one durable identity, rejects key conflicts, and recovers status after restart", async () => {
    const store = new MemoryChangeSetStore();
    const files = new Map<string, Uint8Array>();
    let now = Date.UTC(2026, 7, 12);
    const options = () => ({
      port: 0,
      health: healthState(),
      changeSets: {
        store,
        dataSource: {
          readBinary: async (path: string) => files.get(path) ?? null,
          pathKind: async (path: string) => (files.has(path) ? ("file" as const) : null),
          isContained: async () => true,
        },
        now: () => now,
        createChangeSetId: () => "change-set-1",
      },
    });

    const firstBridge = createBridgeInstance(options());
    await firstBridge.start();
    const firstClient = await connect(firstBridge.endpoint);
    const first = await firstClient.callTool({
      name: "vault_change_set_submit",
      arguments: createNote(),
    });
    const replay = await firstClient.callTool({
      name: "vault_change_set_submit",
      arguments: createNote(),
    });
    const conflict = await firstClient.callTool({
      name: "vault_change_set_submit",
      arguments: createNote("different"),
    });

    expect(first.isError).toBe(false);
    expect(first.structuredContent).toMatchObject({
      outcome: "registered",
      changeSet: {
        changeSetId: "change-set-1",
        state: "in_progress",
        preview: {
          derivedEffects: [
            {
              operationId: "derived/create-1/directory/Notes",
              causedByOperationId: "create-1",
              kind: "create_directory",
              projectedOutcome: "changed",
            },
          ],
          paths: [
            { path: "Notes", projectedFinalState: { kind: "directory" } },
            { path: "Notes/New.md", projectedFinalState: { kind: "markdown" } },
          ],
        },
      },
    });
    expect(replay.structuredContent).toEqual(first.structuredContent);
    expect(conflict.isError).toBe(true);
    expect(conflict.structuredContent).toEqual({ outcome: "submission_key_conflict" });
    expect(files.size).toBe(0);

    await firstClient.close();
    await firstBridge.stop();

    const restartedBridge = createBridgeInstance(options());
    await restartedBridge.start();
    const restartedClient = await connect(restartedBridge.endpoint);
    const found = await restartedClient.callTool({
      name: "vault_change_set_status",
      arguments: { submissionKey: "submission-1" },
    });
    expect(found.isError).toBe(false);
    expect(found.structuredContent).toMatchObject({
      lookup: "found",
      changeSet: { changeSetId: "change-set-1" },
    });

    now += 7 * DAY + 1;
    const expired = await restartedClient.callTool({
      name: "vault_change_set_status",
      arguments: { changeSetId: "change-set-1" },
    });
    expect(expired.isError).toBe(false);
    expect(expired.structuredContent).toEqual({
      lookup: "expired",
      vault: { writeGate: "open", writeState: "writable" },
    });

    await restartedClient.close();
    await restartedBridge.stop();
  });

  it("replays the historical recovery_blocked disposition but omits it from status", async () => {
    const health = healthState();
    health.recovery = { state: "blocked" };
    health.write = { gate: "blocked", state: "paused", pauseSource: null };
    health.effectiveGate = { code: "writes_paused" };
    const bridge = createBridgeInstance({
      port: 0,
      health,
      changeSets: {
        store: new MemoryChangeSetStore(),
        dataSource: {
          readBinary: async () => {
            throw new Error("recovery-blocked submit must not read targets");
          },
          pathKind: async () => {
            throw new Error("recovery-blocked submit must not inspect paths");
          },
          isContained: async () => {
            throw new Error("recovery-blocked submit must not inspect containment");
          },
        },
        createChangeSetId: () => "change-set-blocked",
      },
    });
    await bridge.start();
    const client = await connect(bridge.endpoint);

    const submitted = await client.callTool({
      name: "vault_change_set_submit",
      arguments: createNote(),
    });
    health.recovery = { state: "none" };
    health.write = { gate: "open", state: "writable", pauseSource: null };
    health.effectiveGate = null;
    const replayed = await client.callTool({
      name: "vault_change_set_submit",
      arguments: createNote(),
    });
    const status = await client.callTool({
      name: "vault_change_set_status",
      arguments: { submissionKey: "submission-1" },
    });

    expect(submitted.isError).toBe(true);
    expect(submitted.structuredContent).toMatchObject({
      outcome: "registered",
      changeSet: { state: "intent_not_applied" },
      gate: { code: "recovery_blocked" },
    });
    expect(replayed.structuredContent).toEqual({
      ...(submitted.structuredContent as Record<string, unknown>),
      vault: { writeGate: "open", writeState: "writable" },
    });
    expect(status.isError).toBe(false);
    expect(status.structuredContent).not.toHaveProperty("gate");

    await client.close();
    await bridge.stop();
  });

  it("publishes the strict submit and status input schemas", async () => {
    const bridge = createBridgeInstance({
      port: 0,
      health: healthState(),
      changeSets: {
        store: new MemoryChangeSetStore(),
        dataSource: {
          readBinary: async () => null,
          pathKind: async () => null,
          isContained: async () => true,
        },
      },
    });
    await bridge.start();
    const client = await connect(bridge.endpoint);

    const tools = await client.listTools();
    const submit = tools.tools.find(({ name }) => name === "vault_change_set_submit");
    const status = tools.tools.find(({ name }) => name === "vault_change_set_status");

    expect(submit?.inputSchema).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: ["submissionKey", "operations"],
    });
    expect(status?.inputSchema).toMatchObject({
      oneOf: [
        { required: ["submissionKey"], additionalProperties: false },
        { required: ["changeSetId"], additionalProperties: false },
      ],
    });

    await client.close();
    await bridge.stop();
  });

  it("freezes projected final bytes in an immutable preview across replay and status", async () => {
    const store = new MemoryChangeSetStore();
    const original = "before old after";
    const projected = "before new after";
    const bridge = createBridgeInstance({
      port: 0,
      health: healthState(),
      changeSets: {
        store,
        dataSource: {
          readBinary: async (path) =>
            path === "Notes/A.md" ? Buffer.from(original) : null,
          pathKind: async (path) =>
            path === "Notes" ? "directory" : path === "Notes/A.md" ? "file" : null,
          isContained: async () => true,
        },
        createChangeSetId: () => "change-set-preview",
      },
    });
    await bridge.start();
    const client = await connect(bridge.endpoint);
    const request = {
      submissionKey: "preview-key",
      operations: [
        {
          operationId: "edit-1",
          kind: "edit_body",
          path: "Notes/A.md",
          targetVersion: VERSION(original),
          edit: {
            kind: "replace_exact",
            old: "old",
            replacement: "new",
            expectedOccurrences: 1,
          },
        },
      ],
    };

    const submitted = await client.callTool({
      name: "vault_change_set_submit",
      arguments: request,
    });
    const replayed = await client.callTool({
      name: "vault_change_set_submit",
      arguments: request,
    });
    const status = await client.callTool({
      name: "vault_change_set_status",
      arguments: { changeSetId: "change-set-preview" },
    });

    expect(submitted.structuredContent).toMatchObject({
      changeSet: {
        preview: {
          paths: [
            {
              path: "Notes/A.md",
              preState: { kind: "markdown", contentVersion: VERSION(original) },
              projectedFinalState: {
                kind: "markdown",
                contentVersion: VERSION(projected),
              },
            },
          ],
        },
      },
    });
    expect(replayed.structuredContent).toEqual(submitted.structuredContent);
    expect(status.structuredContent).toMatchObject({
      changeSet: (submitted.structuredContent as { changeSet: unknown }).changeSet,
    });

    await client.close();
    await bridge.stop();
  });

  it("freezes move reference closure as explicit derived effects", async () => {
    const moved = "# Target\n";
    const backlink = "See [[Target]]\n";
    const projectedBacklink = "See [[Renamed]]\n";
    const files = new Map<string, Uint8Array>([
      ["Notes/Target.md", Buffer.from(moved)],
      ["Notes/Backlink.md", Buffer.from(backlink)],
    ]);
    const bridge = createBridgeInstance({
      port: 0,
      health: healthState(),
      changeSets: {
        store: new MemoryChangeSetStore(),
        dataSource: {
          readBinary: async (path) => files.get(path) ?? null,
          pathKind: async (path) =>
            path === "Notes" ? "directory" : files.has(path) ? "file" : null,
          isContained: async () => true,
          projectMove: async () => ({
            derivedEffects: [
              {
                operationId: "derived/move-1/Notes/Backlink.md/4",
                path: "Notes/Backlink.md",
                targetVersion: VERSION(backlink),
                projectedBytes: Buffer.from(projectedBacklink),
              },
            ],
          }),
        },
        createChangeSetId: () => "change-set-move",
      },
    });
    await bridge.start();
    const client = await connect(bridge.endpoint);

    const submitted = await client.callTool({
      name: "vault_change_set_submit",
      arguments: {
        submissionKey: "move-key",
        operations: [
          {
            operationId: "move-1",
            kind: "move",
            sourcePath: "Notes/Target.md",
            destinationPath: "Notes/Renamed.md",
            targetVersion: VERSION(moved),
            linkEffect: "update_resolved_references",
          },
        ],
      },
    });

    expect(submitted.structuredContent).toMatchObject({
      changeSet: {
        state: "in_progress",
        preview: {
          requestedEffects: [
            { operationId: "move-1", kind: "move", projectedOutcome: "changed" },
          ],
          derivedEffects: [
            {
              operationId: "derived/move-1/Notes/Backlink.md/4",
              causedByOperationId: "move-1",
              kind: "edit_body",
              projectedOutcome: "changed",
            },
          ],
          paths: [
            {
              path: "Notes/Backlink.md",
              projectedFinalState: {
                kind: "markdown",
                contentVersion: VERSION(projectedBacklink),
              },
            },
            { path: "Notes/Renamed.md", projectedFinalState: { kind: "markdown" } },
            { path: "Notes/Target.md", projectedFinalState: { kind: "absent" } },
          ],
        },
      },
    });
    expect(files.get("Notes/Target.md")?.toString()).toBe(moved);
    expect(files.has("Notes/Renamed.md")).toBe(false);

    await client.close();
    await bridge.stop();
  });

  it("preflights frontmatter through a byte-preserving projector", async () => {
    const original = "---\ntitle: Old\nkeep: 'formatted'\n---\nBody\n";
    const projected = "---\ntitle: New\nkeep: 'formatted'\n---\nBody\n";
    let projectorCalls = 0;
    const bridge = createBridgeInstance({
      port: 0,
      health: healthState(),
      changeSets: {
        store: new MemoryChangeSetStore(),
        dataSource: {
          readBinary: async (path) =>
            path === "Notes/A.md" ? Buffer.from(original) : null,
          pathKind: async (path) =>
            path === "Notes" ? "directory" : path === "Notes/A.md" ? "file" : null,
          isContained: async () => true,
          projectFrontmatter: async (bytes, changes) => {
            projectorCalls += 1;
            expect(Buffer.from(bytes).toString()).toBe(original);
            expect(changes).toEqual([{ kind: "set", key: "title", value: "New" }]);
            return Buffer.from(projected);
          },
        },
        createChangeSetId: () => "change-set-frontmatter",
      },
    });
    await bridge.start();
    const client = await connect(bridge.endpoint);

    const submitted = await client.callTool({
      name: "vault_change_set_submit",
      arguments: {
        submissionKey: "frontmatter-key",
        operations: [
          {
            operationId: "frontmatter-1",
            kind: "edit_frontmatter",
            path: "Notes/A.md",
            targetVersion: VERSION(original),
            changes: [{ kind: "set", key: "title", value: "New" }],
          },
        ],
      },
    });

    expect(submitted.structuredContent).toMatchObject({
      changeSet: {
        state: "in_progress",
        preview: {
          requestedEffects: [
            { operationId: "frontmatter-1", projectedOutcome: "changed" },
          ],
          paths: [
            {
              path: "Notes/A.md",
              preState: { kind: "markdown", contentVersion: VERSION(original) },
              projectedFinalState: {
                kind: "markdown",
                contentVersion: VERSION(projected),
              },
            },
          ],
        },
      },
    });
    expect(projectorCalls).toBe(1);

    await client.close();
    await bridge.stop();
  });

  it("preflights chained operations against projected state and marks no-op effects satisfied", async () => {
    const original = "old";
    const bridge = createBridgeInstance({
      port: 0,
      health: healthState(),
      changeSets: {
        store: new MemoryChangeSetStore(),
        dataSource: {
          readBinary: async (path) =>
            path === "Notes/A.md" ? Buffer.from(original) : null,
          pathKind: async (path) =>
            path === "Notes" ? "directory" : path === "Notes/A.md" ? "file" : null,
          isContained: async () => true,
        },
        createChangeSetId: () => "change-set-chain",
      },
    });
    await bridge.start();
    const client = await connect(bridge.endpoint);

    const chained = await client.callTool({
      name: "vault_change_set_submit",
      arguments: {
        submissionKey: "chain-key",
        operations: [
          {
            operationId: "edit-1",
            kind: "edit_body",
            path: "Notes/A.md",
            targetVersion: VERSION(original),
            edit: { kind: "replace_whole", replacement: "middle" },
          },
          {
            operationId: "edit-2",
            afterOperationId: "edit-1",
            kind: "edit_body",
            path: "Notes/A.md",
            targetVersion: VERSION("middle"),
            edit: { kind: "replace_whole", replacement: "final" },
          },
        ],
      },
    });
    const unchanged = await client.callTool({
      name: "vault_change_set_submit",
      arguments: {
        submissionKey: "unchanged-key",
        operations: [
          {
            operationId: "edit-same",
            kind: "edit_body",
            path: "Notes/A.md",
            targetVersion: VERSION(original),
            edit: { kind: "replace_whole", replacement: original },
          },
        ],
      },
    });

    expect(chained.structuredContent).toMatchObject({
      changeSet: {
        state: "in_progress",
        preview: {
          requestedEffects: [
            { operationId: "edit-1", projectedOutcome: "changed" },
            { operationId: "edit-2", projectedOutcome: "changed" },
          ],
          paths: [
            {
              path: "Notes/A.md",
              preState: { kind: "markdown", contentVersion: VERSION(original) },
              projectedFinalState: {
                kind: "markdown",
                contentVersion: VERSION("final"),
              },
            },
          ],
        },
      },
    });
    expect(unchanged.structuredContent).toMatchObject({
      changeSet: {
        state: "in_progress",
        preview: {
          requestedEffects: [
            { operationId: "edit-same", projectedOutcome: "already_satisfied" },
          ],
          paths: [{ path: "Notes/A.md", projectedOutcome: "unchanged" }],
        },
      },
    });

    await client.close();
    await bridge.stop();
  });

  it("returns a trustworthy request_invalid result for structurally invalid submit input", async () => {
    const bridge = createBridgeInstance({
      port: 0,
      health: healthState(),
      changeSets: {
        store: new MemoryChangeSetStore(),
        dataSource: {
          readBinary: async () => null,
          pathKind: async () => null,
          isContained: async () => true,
        },
      },
    });
    await bridge.start();
    const client = await connect(bridge.endpoint);

    const result = await client.callTool({
      name: "vault_change_set_submit",
      arguments: { submissionKey: "submission-1", operations: [] },
    });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({ outcome: "request_invalid" });
    expect(JSON.parse(result.content[0]?.type === "text" ? result.content[0].text : ""))
      .toEqual(result.structuredContent);

    await client.close();
    await bridge.stop();
  });

  it("serializes concurrent same-key submissions into one durable binding", async () => {
    const store = new MemoryChangeSetStore();
    let identities = 0;
    const bridge = createBridgeInstance({
      port: 0,
      health: healthState(),
      changeSets: {
        store,
        dataSource: {
          readBinary: async () => null,
          pathKind: async () => null,
          isContained: async () => {
            await new Promise((resolve) => setTimeout(resolve, 5));
            return true;
          },
        },
        createChangeSetId: () => `change-set-${++identities}`,
      },
    });
    await bridge.start();
    const [left, right] = await Promise.all([
      connect(bridge.endpoint),
      connect(bridge.endpoint),
    ]);

    const [leftResult, rightResult] = await Promise.all([
      left.callTool({ name: "vault_change_set_submit", arguments: createNote() }),
      right.callTool({ name: "vault_change_set_submit", arguments: createNote() }),
    ]);

    expect(leftResult.structuredContent).toEqual(rightResult.structuredContent);
    expect(identities).toBe(1);
    expect(store.state).toMatchObject({ entries: [{ changeSetId: "change-set-1" }] });

    await Promise.all([left.close(), right.close()]);
    await bridge.stop();
  });

  it("does not accept a key in memory when durable binding fails", async () => {
    const store = new MemoryChangeSetStore();
    store.failNextSave = true;
    let identities = 0;
    const bridge = createBridgeInstance({
      port: 0,
      health: healthState(),
      changeSets: {
        store,
        dataSource: {
          readBinary: async () => null,
          pathKind: async () => null,
          isContained: async () => true,
        },
        createChangeSetId: () => `change-set-${++identities}`,
      },
    });
    await bridge.start();
    const client = await connect(bridge.endpoint);

    const failed = await client.callTool({
      name: "vault_change_set_submit",
      arguments: createNote(),
    });
    expect(failed.isError).toBe(true);
    expect(failed.structuredContent).toBeUndefined();
    const retry = await client.callTool({
      name: "vault_change_set_submit",
      arguments: createNote(),
    });

    expect(retry.structuredContent).toMatchObject({
      outcome: "registered",
      changeSet: { changeSetId: "change-set-2" },
    });
    expect(store.state).toMatchObject({ entries: [{ changeSetId: "change-set-2" }] });

    await client.close();
    await bridge.stop();
  });

  it("rejects stale, exact-cardinality, path-conflict, and protected-boundary intents before mutation", async () => {
    const store = new MemoryChangeSetStore();
    const files = new Map<string, Uint8Array>([
      ["Notes/A.md", Buffer.from("old old")],
      ["Notes/Existing.md", Buffer.from("existing")],
    ]);
    let id = 0;
    const bridge = createBridgeInstance({
      port: 0,
      health: healthState(),
      changeSets: {
        store,
        dataSource: {
          readBinary: async (path) => files.get(path) ?? null,
          pathKind: async (path) =>
            path === "Notes" ? "directory" : files.has(path) ? "file" : null,
          isContained: async () => true,
        },
        createChangeSetId: () => `change-set-${++id}`,
      },
    });
    await bridge.start();
    const client = await connect(bridge.endpoint);

    const submit = (arguments_: Record<string, unknown>) =>
      client.callTool({ name: "vault_change_set_submit", arguments: arguments_ });
    const edit = (submissionKey: string, targetVersion: string, old: string) => ({
      submissionKey,
      operations: [
        {
          operationId: "edit-1",
          kind: "edit_body",
          path: "Notes/A.md",
          targetVersion,
          edit: {
            kind: "replace_exact",
            old,
            replacement: "new",
            expectedOccurrences: 1,
          },
        },
      ],
    });

    const stale = await submit(edit("stale", `sha256:${"0".repeat(64)}`, "old"));
    expect(stale.structuredContent).toMatchObject({
      changeSet: { state: "intent_not_applied", failure: { code: "stale_observation" } },
    });

    const cardinality = await submit(edit("count", VERSION("old old"), "old"));
    expect(cardinality.structuredContent).toMatchObject({
      changeSet: {
        state: "intent_not_applied",
        failure: {
          code: "exact_match_count_mismatch",
          operationId: "edit-1",
          actualOccurrences: 2,
        },
      },
    });

    const conflict = await submit({
      ...createNote(),
      submissionKey: "path-conflict",
      operations: [
        {
          operationId: "create-1",
          kind: "create_note",
          path: "Notes/Existing.md",
          content: "new",
          ifExists: "reject",
        },
      ],
    });
    expect(conflict.structuredContent).toMatchObject({
      changeSet: {
        state: "intent_not_applied",
        failure: {
          code: "path_conflict",
          operationId: "create-1",
          path: "Notes/Existing.md",
        },
      },
    });

    const protectedResult = await submit({
      ...createNote(),
      submissionKey: "protected",
      operations: [
        {
          operationId: "create-1",
          kind: "create_note",
          path: ".obsidian/Plugins.md",
          content: "new",
          ifExists: "reject",
        },
      ],
    });
    expect(protectedResult.structuredContent).toMatchObject({
      changeSet: {
        state: "intent_not_applied",
        failure: {
          code: "path_conflict",
          operationId: "create-1",
          path: ".obsidian/Plugins.md",
        },
      },
    });
    expect(files.get("Notes/A.md")?.toString()).toBe("old old");

    await client.close();
    await bridge.stop();
  });
});
