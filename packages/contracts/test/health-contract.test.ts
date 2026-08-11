import { describe, expect, it } from "vitest";

import {
  parseHealthResult,
  serializeCompatibilityText,
  type HealthResult,
} from "../src/index.js";

const observed: HealthResult = {
  outcome: "observed",
  vault: {
    id: "vault-2f36a4d0",
    name: "Research",
    path: "D:/Vaults/Research",
  },
  versions: {
    bridge: "0.1.0",
    plugin: "0.1.0",
    protocol: "1.0",
    persistentStateSchema: 1,
    recoveryJournalSchema: 1,
  },
  listener: { address: "127.0.0.1", port: 27123 },
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

describe("vault_health v1 contract", () => {
  it("accepts a complete observed health result and serializes the exact structured value", () => {
    expect(parseHealthResult(observed)).toEqual(observed);
    expect(JSON.parse(serializeCompatibilityText(observed))).toEqual(observed);
  });

  it("rejects unknown fields at every object root", () => {
    expect(() => parseHealthResult({ ...observed, secret: "not allowed" })).toThrow();
    expect(() =>
      parseHealthResult({
        ...observed,
        listener: { ...observed.listener, host: "localhost" },
      }),
    ).toThrow();
  });

  it("accepts only the minimal incompatible projection", () => {
    const incompatible: HealthResult = {
      outcome: "incompatible",
      gate: { code: "incompatible_protocol" },
      compatibility: {
        local: {
          protocol: "1.0",
          supported: { major: 1, minimumMinor: 0, maximumMinor: 0 },
        },
        peer: {
          protocol: "2.0",
          supported: { major: 2, minimumMinor: 0, maximumMinor: 0 },
        },
      },
    };

    expect(parseHealthResult(incompatible)).toEqual(incompatible);
    expect(() =>
      parseHealthResult({ ...incompatible, vault: observed.vault }),
    ).toThrow();
  });
});
