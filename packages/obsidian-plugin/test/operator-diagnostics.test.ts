import { describe, expect, it } from "vitest";

import {
  createStandardDiagnosticBundle,
  requestContentInclusiveDiagnosticData,
  type StandardDiagnosticSource,
} from "../src/operator-diagnostics.js";

const source: StandardDiagnosticSource = {
  generatedAt: "2026-08-13T00:00:00.000Z",
  correlationSalt: "bundle-local-salt",
  versions: {
    bridge: "1.2.3",
    plugin: "1.2.3",
    protocol: "1.0",
    persistentStateSchema: 2,
    recoveryJournalSchema: 2,
  },
  health: {
    overall: "blocked",
    reasonCodes: ["recovery_blocked"],
    operatorAction: "review_recovery",
  },
  listenerTimeline: [
    { at: "2026-08-13T00:00:01.000Z", state: "listening", listenerId: "listener-raw" },
  ],
  queueTimeline: [
    {
      at: "2026-08-13T00:00:02.000Z",
      state: "blocked",
      queueLength: 1,
      changeSetId: "change-set-raw",
      submissionKey: "submission-key-raw",
    },
  ],
  lifecycle: { startup: "ready", upgrade: "not_run", migration: "not_run", recovery: "failed" },
  journal: {
    state: "readable",
    phase: "FAILED",
    sequence: 7,
    checksum: "valid",
    changeSetId: "change-set-raw",
  },
  logs: [{ at: "2026-08-13T00:00:03.000Z", level: "error", code: "recovery_failed" }],
  stacks: [{ code: "recovery_failed", frames: ["ChangeSetService.recover", "Bridge.start"] }],
};

function allStrings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(allStrings);
  if (typeof value !== "object" || value === null) return [];
  return Object.values(value).flatMap(allStrings);
}

describe("standard local operator diagnostics", () => {
  it("emits only redacted structured evidence with stable within-bundle correlation", () => {
    const bundle = createStandardDiagnosticBundle(source);
    const strings = allStrings(bundle);
    for (const secret of [
      "listener-raw",
      "change-set-raw",
      "submission-key-raw",
      "C:/Users/alice/Vault",
      "alice",
    ]) {
      expect(strings.join("\n")).not.toContain(secret);
    }

    expect(bundle.queueTimeline[0]?.changeSetAlias).toBe(bundle.journal.changeSetAlias);
    expect(bundle.queueTimeline[0]?.submissionKeyDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(bundle.listenerTimeline[0]?.listenerAlias).toMatch(/^listener-[0-9a-f]{12}$/u);
    expect(bundle.checksum).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(bundle).not.toHaveProperty("correlationSalt");
  });

  it("produces a deterministic checksum over the redacted payload", () => {
    const first = createStandardDiagnosticBundle(source);
    const second = createStandardDiagnosticBundle(structuredClone(source));
    expect(second).toEqual(first);

    const changed = createStandardDiagnosticBundle({
      ...source,
      health: { ...source.health, reasonCodes: ["recovery_blocked", "writes_paused"] },
    });
    expect(changed.checksum).not.toBe(first.checksum);
  });

  it("requires a local interactive confirmation for selected content-inclusive data", async () => {
    await expect(
      requestContentInclusiveDiagnosticData(
        async () => false,
        [{ label: "selected-note", content: "private note" }],
      ),
    ).rejects.toThrow(/not confirmed/u);

    await expect(
      requestContentInclusiveDiagnosticData(
        async () => true,
        [{ label: "selected-note", content: "private note" }],
      ),
    ).resolves.toEqual({
      format: "llm-wiki-content-diagnostics-v1",
      selections: [{ label: "selected-note", content: "private note" }],
    });
  });

  it("rejects free-form logs, stack paths, and environment-shaped details", () => {
    expect(() =>
      createStandardDiagnosticBundle({
        ...source,
        logs: [{ at: source.generatedAt, level: "error", code: "failed at C:/Users/alice" }],
      }),
    ).toThrow(/machine code/u);
    expect(() =>
      createStandardDiagnosticBundle({
        ...source,
        stacks: [{ code: "recovery_failed", frames: ["C:/src/change-set.ts:12"] }],
      }),
    ).toThrow(/without a path/u);
  });

  it("does not accept content-bearing or environment-shaped source fields", () => {
    expect(() =>
      createStandardDiagnosticBundle({
        ...source,
        noteBodies: ["private note"],
      } as StandardDiagnosticSource),
    ).toThrow(/unknown diagnostic source field/u);
  });
});
