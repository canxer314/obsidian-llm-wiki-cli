import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import {
  InjectedChangeSetCrash,
  createBridgeInstance,
  type BridgeHealthState,
  type ChangeSetExecutionAdapter,
  type ChangeSetRegistryState,
  type ChangeSetRegistryStore,
  type RecoveryJournalFrame,
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

class MemoryMcpExecution implements ChangeSetExecutionAdapter {
  readonly directories = new Set<string>();
  readonly files = new Map<string, Uint8Array>();
  readonly identities = new Map<string, string>();
  readonly stagedDirectories = new Map<string, string>();
  readonly stagedFiles = new Map<string, { bytes: Uint8Array; identity: string }>();
  frame: RecoveryJournalFrame | null = null;
  snapshots = 0;
  filePublishes = 0;
  #identity = 0;

  async loadRecoveryFrame(): Promise<RecoveryJournalFrame | null> {
    return structuredClone(this.frame);
  }

  async persistRecoveryFrame(frame: RecoveryJournalFrame): Promise<void> {
    this.frame = structuredClone(frame);
  }

  async pathKind(path: string): Promise<"directory" | "file" | null> {
    return this.directories.has(path) ? "directory" : this.files.has(path) ? "file" : null;
  }

  async directoryIdentity(path: string): Promise<string | null> {
    return this.identities.get(path) ?? null;
  }

  async prepareDirectory(stageId: string): Promise<string> {
    const identity = `directory-${++this.#identity}`;
    this.stagedDirectories.set(stageId, identity);
    return identity;
  }

  async publishDirectory(stageId: string, path: string): Promise<void> {
    const identity = this.stagedDirectories.get(stageId);
    if (identity === undefined) throw new Error("missing staged directory");
    this.stagedDirectories.delete(stageId);
    this.directories.add(path);
    this.identities.set(path, identity);
  }

  async discardPreparedDirectory(stageId: string): Promise<void> {
    this.stagedDirectories.delete(stageId);
  }

  async removeDirectory(path: string): Promise<void> {
    this.directories.delete(path);
    this.identities.delete(path);
  }

  async readBinary(path: string): Promise<Uint8Array | null> {
    const bytes = this.files.get(path);
    return bytes === undefined ? null : Uint8Array.from(bytes);
  }

  async fileIdentity(path: string): Promise<string | null> {
    return this.identities.get(path) ?? null;
  }

  async prepareFile(stageId: string, bytes: Uint8Array): Promise<string> {
    const identity = `file-${++this.#identity}`;
    this.stagedFiles.set(stageId, { bytes: Uint8Array.from(bytes), identity });
    return identity;
  }

  async publishFile(stageId: string, path: string): Promise<void> {
    const staged = this.stagedFiles.get(stageId);
    if (staged === undefined) throw new Error("missing staged file");
    this.filePublishes += 1;
    this.stagedFiles.delete(stageId);
    this.files.set(path, staged.bytes);
    this.identities.set(path, staged.identity);
  }

  async discardPreparedFile(stageId: string): Promise<void> {
    this.stagedFiles.delete(stageId);
  }

  async removeFile(path: string): Promise<void> {
    this.files.delete(path);
    this.identities.delete(path);
  }

  async publishSearchSnapshot(): Promise<void> {
    this.snapshots += 1;
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
  it("reports already-satisfied over MCP without publishing a file", async () => {
    const execution = new MemoryMcpExecution();
    execution.directories.add("Notes");
    execution.files.set("Notes/Same.md", Buffer.from("same"));
    execution.identities.set("Notes/Same.md", "same-file");
    const bridge = createBridgeInstance({
      port: 0,
      health: healthState(),
      changeSets: {
        store: new MemoryChangeSetStore(),
        dataSource: {
          readBinary: (path) => execution.readBinary(path),
          pathKind: (path) => execution.pathKind(path),
          isContained: async () => true,
        },
        execution,
        createChangeSetId: () => "change-set-mcp-same",
      },
    });
    await bridge.start();
    const client = await connect(bridge.endpoint);

    const result = await client.callTool({
      name: "vault_change_set_submit",
      arguments: {
        submissionKey: "mcp-same-key",
        operations: [
          {
            operationId: "same-1",
            kind: "edit_body",
            path: "Notes/Same.md",
            targetVersion: VERSION("same"),
            edit: { kind: "replace_whole", replacement: "same" },
          },
        ],
      },
    });

    expect(result.isError).toBe(false);
    expect(result.structuredContent).toMatchObject({
      changeSet: {
        state: "intent_applied",
        requestedEffects: [
          { operationId: "same-1", outcome: "already_satisfied" },
        ],
        paths: [{ path: "Notes/Same.md", outcome: "unchanged" }],
      },
    });
    expect(execution.filePublishes).toBe(0);
    expect(execution.snapshots).toBe(1);

    await client.close();
    await bridge.stop();
  });

  for (const [crashPoint, expectedState, expectedContent] of [
    ["after_file_mutation:0", "intent_not_applied", "before"],
    ["after_committed", "intent_applied", "after 🚀\r\n"],
  ] as const) {
    it(`recovers MCP proof state after a crash at ${crashPoint}`, async () => {
      const store = new MemoryChangeSetStore();
      const execution = new MemoryMcpExecution();
      execution.directories.add("Notes");
      execution.files.set("Notes/Crash.md", Buffer.from("before"));
      execution.identities.set("Notes/Crash.md", "crash-before");
      const request = {
        submissionKey: `mcp-crash-${crashPoint}`,
        operations: [
          {
            operationId: "edit-crash",
            kind: "edit_body",
            path: "Notes/Crash.md",
            targetVersion: VERSION("before"),
            edit: { kind: "replace_whole", replacement: "after 🚀\r\n" },
          },
        ],
      };
      const changeSetId = `change-set-mcp-${crashPoint}`;
      const dataSource = {
        readBinary: (path: string) => execution.readBinary(path),
        pathKind: (path: string) => execution.pathKind(path),
        isContained: async () => true,
      };
      const crashingBridge = createBridgeInstance({
        port: 0,
        health: healthState(),
        changeSets: {
          store,
          dataSource,
          execution,
          createChangeSetId: () => changeSetId,
          crashInjector: (point) => {
            if (point === crashPoint) throw new InjectedChangeSetCrash(point);
          },
        },
      });
      await crashingBridge.start();
      const crashingClient = await connect(crashingBridge.endpoint);

      const interrupted = await crashingClient.callTool({
        name: "vault_change_set_submit",
        arguments: request,
      });
      expect(interrupted.isError).toBe(true);
      await crashingClient.close();
      await crashingBridge.stop();

      const recoveredBridge = createBridgeInstance({
        port: 0,
        health: healthState(),
        changeSets: { store, dataSource, execution },
      });
      await recoveredBridge.start();
      const recoveredClient = await connect(recoveredBridge.endpoint);
      const status = await recoveredClient.callTool({
        name: "vault_change_set_status",
        arguments: { submissionKey: `mcp-crash-${crashPoint}` },
      });

      expect(Buffer.from(execution.files.get("Notes/Crash.md") ?? []).toString()).toBe(
        expectedContent,
      );
      expect(status.isError).toBe(false);
      expect(status.structuredContent).toMatchObject({
        lookup: "found",
        changeSet: {
          changeSetId,
          state: expectedState,
          ...(expectedState === "intent_applied"
            ? {
                paths: [
                  {
                    path: "Notes/Crash.md",
                    finalState: {
                      kind: "markdown",
                      contentVersion: VERSION(expectedContent),
                    },
                  },
                ],
              }
            : {}),
        },
      });

      await recoveredClient.close();
      await recoveredBridge.stop();
    });
  }

  it("creates and edits multiple notes through one durable MCP Change Set", async () => {
    const store = new MemoryChangeSetStore();
    const execution = new MemoryMcpExecution();
    const dataSource = {
      readBinary: (path: string) => execution.readBinary(path),
      pathKind: (path: string) => execution.pathKind(path),
      isContained: async () => true,
    };
    const bridge = createBridgeInstance({
      port: 0,
      health: healthState(),
      changeSets: {
        store,
        dataSource,
        execution,
        createChangeSetId: () => "change-set-mcp-notes",
      },
    });
    await bridge.start();
    const client = await connect(bridge.endpoint);
    const firstContent = "# One\r\nold 🚀\r\n";
    const exactContent = "# One\r\nnew 🚀\r\n";
    const finalContent = "# Final\n";
    const request = {
      submissionKey: "mcp-notes-key",
      operations: [
        {
          operationId: "create-one",
          kind: "create_note",
          path: "Notes/One.md",
          content: firstContent,
          ifExists: "reject",
        },
        {
          operationId: "edit-one-exact",
          afterOperationId: "create-one",
          kind: "edit_body",
          path: "Notes/One.md",
          targetVersion: VERSION(firstContent),
          edit: {
            kind: "replace_exact",
            old: "old",
            replacement: "new",
            expectedOccurrences: 1,
          },
        },
        {
          operationId: "edit-one-whole",
          afterOperationId: "edit-one-exact",
          kind: "edit_body",
          path: "Notes/One.md",
          targetVersion: VERSION(exactContent),
          edit: { kind: "replace_whole", replacement: finalContent },
        },
        {
          operationId: "create-two",
          kind: "create_note",
          path: "Notes/Two.md",
          content: "# Two\n",
          ifExists: "reject",
        },
      ],
    };

    const submitted = await client.callTool({
      name: "vault_change_set_submit",
      arguments: request,
    });
    const status = await client.callTool({
      name: "vault_change_set_status",
      arguments: { submissionKey: "mcp-notes-key" },
    });
    const replayed = await client.callTool({
      name: "vault_change_set_submit",
      arguments: request,
    });

    expect(submitted.isError).toBe(false);
    expect(submitted.structuredContent).toMatchObject({
      outcome: "registered",
      changeSet: {
        changeSetId: "change-set-mcp-notes",
        state: "intent_applied",
        requestedEffects: [
          { operationId: "create-one", outcome: "changed" },
          { operationId: "edit-one-exact", outcome: "changed" },
          { operationId: "edit-one-whole", outcome: "changed" },
          { operationId: "create-two", outcome: "changed" },
        ],
        paths: [
          { path: "Notes", finalState: { kind: "directory" } },
          {
            path: "Notes/One.md",
            finalState: { kind: "markdown", contentVersion: VERSION(finalContent) },
          },
          {
            path: "Notes/Two.md",
            finalState: { kind: "markdown", contentVersion: VERSION("# Two\n") },
          },
        ],
      },
    });
    expect(Buffer.from(execution.files.get("Notes/One.md") ?? []).toString()).toBe(
      finalContent,
    );
    expect(Buffer.from(execution.files.get("Notes/Two.md") ?? []).toString()).toBe(
      "# Two\n",
    );
    expect(execution.snapshots).toBe(1);
    expect(status.structuredContent).toMatchObject({
      lookup: "found",
      changeSet: (submitted.structuredContent as { changeSet: unknown }).changeSet,
    });
    expect(replayed.structuredContent).toEqual(submitted.structuredContent);

    await client.close();
    await bridge.stop();
  });

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

  it("replays a request when Read Dependencies use a different order", async () => {
    const store = new MemoryChangeSetStore();
    const files = new Map<string, Uint8Array>([
      ["Notes/A.md", Buffer.from("alpha")],
      ["Notes/B.md", Buffer.from("beta")],
    ]);
    const bridge = createBridgeInstance({
      port: 0,
      health: healthState(),
      changeSets: {
        store,
        dataSource: {
          readBinary: async (path: string) => files.get(path) ?? null,
          pathKind: async (path: string) => (files.has(path) ? ("file" as const) : null),
          isContained: async () => true,
        },
        createChangeSetId: () => "change-set-ordered-dependencies",
      },
    });
    await bridge.start();
    const client = await connect(bridge.endpoint);
    const dependencies = [
      { path: "Notes/A.md", contentVersion: VERSION("alpha") },
      { path: "Notes/B.md", contentVersion: VERSION("beta") },
    ];

    const first = await client.callTool({
      name: "vault_change_set_submit",
      arguments: { ...createNote(), readDependencies: dependencies },
    });
    const replay = await client.callTool({
      name: "vault_change_set_submit",
      arguments: { ...createNote(), readDependencies: [...dependencies].reverse() },
    });

    expect(first.isError).toBe(false);
    expect(replay.structuredContent).toEqual(first.structuredContent);
    await client.close();
    await bridge.stop();
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

    for (const [submissionKey, old, actualOccurrences] of [
      ["count-zero", "missing", 0],
      ["count-multiple", "old", 2],
    ] as const) {
      const cardinality = await submit(
        edit(submissionKey, VERSION("old old"), old),
      );
      expect(cardinality.structuredContent).toMatchObject({
        changeSet: {
          state: "intent_not_applied",
          failure: {
            code: "exact_match_count_mismatch",
            operationId: "edit-1",
            actualOccurrences,
          },
        },
      });
    }

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
