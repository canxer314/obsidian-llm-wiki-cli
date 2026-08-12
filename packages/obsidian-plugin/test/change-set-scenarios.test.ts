import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import {
  createBridgeInstance,
  type BridgeHealthState,
  type BridgeInstance,
  type ChangeSetRegistryState,
  type ChangeSetRegistryStore,
} from "../src/index.js";

const fixturesRoot = fileURLToPath(
  new URL("../../contracts/fixtures/v1/", import.meta.url),
);

interface ScenarioStep {
  call: "submit" | "status" | "restart";
  arguments?: Record<string, unknown>;
  capture?: string;
  discardResponse?: boolean;
  expect?: {
    outcome?: string;
    lookup?: string;
    state?: string;
    failureCode?: string;
    sameChangeSetAs?: string;
  };
}

interface Scenario {
  id: string;
  steps: ScenarioStep[];
}

class MemoryStore implements ChangeSetRegistryStore {
  state: ChangeSetRegistryState | undefined;

  async load(): Promise<unknown> {
    return structuredClone(this.state);
  }

  async save(state: ChangeSetRegistryState): Promise<void> {
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

function loadScenarios(): Scenario[] {
  const manifest = JSON.parse(readFileSync(`${fixturesRoot}/scenarios.json`, "utf8")) as {
    scenarios: Array<{ id: string; fixture?: string }>;
  };
  return manifest.scenarios
    .filter(({ fixture }) => fixture?.startsWith("vault-change-set/scenario-") === true)
    .map(({ fixture }) =>
      JSON.parse(readFileSync(`${fixturesRoot}/${fixture as string}`, "utf8")) as Scenario,
    );
}

interface ResponseFaults {
  discardNextPost: boolean;
}

async function connect(bridge: BridgeInstance, faults: ResponseFaults): Promise<Client> {
  await bridge.start();
  const client = new Client({ name: "change-set-scenario-runner", version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(bridge.endpoint, {
      requestInit: { headers: { "X-Expected-Vault-ID": "vault-a" } },
      fetch: async (input, init) => {
        const response = await fetch(input, init);
        if (faults.discardNextPost && init?.method === "POST") {
          faults.discardNextPost = false;
          throw new Error("injected lost product response");
        }
        return response;
      },
    }),
  );
  return client;
}

describe("versioned Change Set cross-call scenario corpus", () => {
  for (const scenario of loadScenarios()) {
    it(scenario.id, async () => {
      const store = new MemoryStore();
      let nextId = 1;
      const createBridge = () =>
        createBridgeInstance({
          port: 0,
          health: healthState(),
          changeSets: {
            store,
            dataSource: {
              readBinary: async () => null,
              pathKind: async () => null,
              isContained: async () => true,
            },
            createChangeSetId: () => `scenario-change-set-${nextId++}`,
          },
        });
      let bridge = createBridge();
      const faults = { discardNextPost: false };
      let client = await connect(bridge, faults);
      const captures = new Map<string, string>();

      try {
        for (const step of scenario.steps) {
          if (step.call === "restart") {
            await client.close();
            await bridge.stop();
            bridge = createBridge();
            client = await connect(bridge, faults);
            continue;
          }
          if (step.discardResponse) {
            faults.discardNextPost = true;
            await expect(
              client.callTool({
                name:
                  step.call === "submit"
                    ? "vault_change_set_submit"
                    : "vault_change_set_status",
                arguments: step.arguments,
              }),
            ).rejects.toThrow("injected lost product response");
            continue;
          }
          const response = await client.callTool({
            name:
              step.call === "submit"
                ? "vault_change_set_submit"
                : "vault_change_set_status",
            arguments: step.arguments,
          });
          const result = response.structuredContent as Record<string, unknown>;
          const record = result.changeSet as Record<string, unknown> | undefined;
          if (step.capture !== undefined && record !== undefined) {
            captures.set(step.capture, record.changeSetId as string);
          }
          expect(result.outcome).toBe(step.expect?.outcome);
          expect(result.lookup).toBe(step.expect?.lookup);
          if (step.expect?.state !== undefined) expect(record?.state).toBe(step.expect.state);
          if (step.expect?.failureCode !== undefined) {
            expect((record?.failure as Record<string, unknown> | undefined)?.code).toBe(
              step.expect.failureCode,
            );
          }
          if (step.expect?.sameChangeSetAs !== undefined) {
            expect(record?.changeSetId).toBe(captures.get(step.expect.sameChangeSetAs));
          }
        }
      } finally {
        await client.close();
        await bridge.stop();
      }
    });
  }
});
