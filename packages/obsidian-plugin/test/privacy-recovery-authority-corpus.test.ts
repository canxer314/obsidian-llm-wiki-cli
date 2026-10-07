import { describe, expect, it } from "vitest";

import { serializeCompatibilityText } from "@llm-wiki/vault-contracts";

import {
  PRIVACY_RECOVERY_AUTHORITY_CORPUS_ID,
  composePrivacyRecoveryAuthorityCorpusEvidence,
  runPrivacyRecoveryAuthorityCorpus,
  type LocalRecoveryState,
  type PrivacyRecoveryAuthorityMcpSession,
} from "../src/installed-runtime/privacy-recovery-authority-corpus.js";
import { privacyRecoveryAuthorityCorpusEvidenceSchema } from "../src/installed-runtime/evidence.js";
import { createContentInclusiveDiagnosticBundle } from "../src/content-inclusive-diagnostic-bundle.js";
import { createStandardDiagnosticBundle } from "../src/diagnostic-bundle.js";

const PRIVATE_NOTE = "secret private note body";
const PRIVATE_PATH = "/private/test-vault/Notes/Private.md";
const RAW_SUBMISSION_KEY = "private-submission-key";
const DIGEST = "a".repeat(64);

function diagnosticEvidence(vaultId: string) {
  return {
    vaultId,
    versions: {
      bridge: "1.0.0",
      plugin: "1.0.0",
      protocol: "1.0",
      persistentStateSchema: 2,
      recoveryJournalSchema: 3,
    },
    health: {
      readiness: { searchSnapshot: "ready", cache: "ready", index: "ready" },
      recovery: "none",
      write: { gate: "open", state: "writable", pauseSource: null },
      effectiveGate: null,
      overall: "healthy",
      reasonCodes: [],
      operatorAction: "none",
    },
    listener: { address: "127.0.0.1" as const, port: 34567 },
    queue: { currentExecutionId: null, length: 0, headChangeSetId: null },
    lifecycle: { startup: "ready", upgrade: "not_run", migration: "not_run", recovery: "not_run" },
    journal: { availability: "unavailable" as const, frames: [] as const },
    changeSets: [],
    machineEvents: [],
  };
}

function compatibilityText(value: Parameters<typeof serializeCompatibilityText>[0]): string {
  return serializeCompatibilityText(value);
}

function session(vaultId: string, recovery: { state: LocalRecoveryState }): PrivacyRecoveryAuthorityMcpSession {
  const health = {
    outcome: "observed" as const,
    vault: { id: vaultId, name: "private-vault", path: PRIVATE_PATH },
    versions: {
      bridge: "1.0.0",
      plugin: "1.0.0",
      protocol: "1.0",
      persistentStateSchema: 2,
      recoveryJournalSchema: 3,
    },
    listener: { address: "127.0.0.1" as const, port: 34567 },
    readiness: { searchSnapshot: "ready" as const, cache: "ready" as const, index: "ready" as const },
    recovery: { state: recovery.state === "blocked" ? "blocked" as const : "none" as const },
    write: {
      gate: recovery.state === "blocked" ? "blocked" as const : "open" as const,
      state: recovery.state === "writable" ? "writable" as const : "paused" as const,
      pauseSource: recovery.state === "writable" ? null : "manual" as const,
    },
    queue: { currentExecutionId: null, length: 0, headChangeSetId: null },
    lifecycle: { startup: "ready" as const, upgrade: "not_run" as const, migration: "not_run" as const, recovery: "not_run" as const },
    effectiveGate: recovery.state === "blocked" ? { code: "recovery_blocked" as const } : recovery.state === "paused" ? { code: "writes_paused" as const } : null,
    overall: recovery.state === "writable" ? "healthy" as const : "blocked" as const,
    reasonCodes: recovery.state === "blocked" ? ["recovery_blocked"] : [],
    operatorAction: recovery.state === "blocked" ? "review_recovery" as const : recovery.state === "paused" ? "resume_writes" as const : "none" as const,
  };
  return {
    listTools: async () => [
      { name: "vault_health" },
      { name: "vault_discover" },
      { name: "vault_read" },
      { name: "vault_continue" },
      { name: "vault_change_set_submit" },
      { name: "vault_change_set_status" },
    ],
    callTool: async (name, arguments_) => {
      if (name !== "vault_health") return { isError: true, structuredContent: { code: "unknown_tool" }, content: [{ type: "text", text: "unknown_tool" }] };
      if (Object.keys(arguments_).length > 0) {
        return {
          isError: true,
          structuredContent: { code: "request_invalid" },
          content: [{ type: "text", text: "request_invalid" }],
        };
      }
      return {
        structuredContent: health,
        content: [{ type: "text", text: compatibilityText(health) }],
      };
    },
  };
}

describe("privacy and recovery-authority installed-runtime corpus", () => {
  it("proves local-only diagnostics and recovery authority through the six-tool contract", async () => {
    const a = { state: "blocked" as LocalRecoveryState };
    const b = { state: "writable" as LocalRecoveryState };
    const events: unknown[] = [];
    const assertions: string[] = [];
    const local = (vaultId: string, state: { state: LocalRecoveryState }) => ({
      createStandardDiagnosticBundle: async () => createStandardDiagnosticBundle(diagnosticEvidence(vaultId)),
      createContentInclusiveDiagnosticBundle: async (selection: string) =>
        createContentInclusiveDiagnosticBundle(diagnosticEvidence(vaultId), selection),
      recoveryState: async () => state.state,
      historicalStatusSha256: async () => DIGEST,
      acceptTrustedRecoveryBaseline: async () => {
        if (state.state !== "blocked") throw new Error("not blocked");
        state.state = "paused";
      },
      resumeWrites: async () => {
        if (state.state !== "paused") throw new Error("must remain paused");
        state.state = "writable";
      },
      cleanup: async () => ({ residualPaths: [] }),
    });

    const outcome = await runPrivacyRecoveryAuthorityCorpus({
      vaultA: {
        label: "vault-a",
        vaultId: "raw-vault-a",
        mcp: session("raw-vault-a", a),
        local: local("raw-vault-a", a),
        privateMarkers: [PRIVATE_NOTE, PRIVATE_PATH, RAW_SUBMISSION_KEY, "raw-vault-a"],
      },
      vaultB: {
        label: "vault-b",
        vaultId: "raw-vault-b",
        mcp: session("raw-vault-b", b),
        local: local("raw-vault-b", b),
        privateMarkers: [PRIVATE_NOTE, PRIVATE_PATH, RAW_SUBMISSION_KEY, "raw-vault-b"],
      },
      record: (kind, name, detail) => events.push({ kind, name, detail }),
      assertion: (name) => assertions.push(name),
    });

    expect(outcome.baselineAcceptanceLocalOnly).toBe(true);
    expect(outcome.explicitResumeRequired).toBe(true);
    expect(outcome.secondVaultUnaffected).toBe(true);
    expect(outcome.agentAuthorityStateMutations).toBe(0);
    expect(a.state).toBe("writable");
    expect(b.state).toBe("writable");

    const evidence = composePrivacyRecoveryAuthorityCorpusEvidence({
      outcome,
      events: events as never,
      assertions,
    });
    expect(evidence.corpusId).toBe(PRIVACY_RECOVERY_AUTHORITY_CORPUS_ID);
    expect(privacyRecoveryAuthorityCorpusEvidenceSchema.parse(evidence)).toEqual(evidence);
    const serialized = JSON.stringify(evidence);
    expect(serialized).not.toContain(PRIVATE_NOTE);
    expect(serialized).not.toContain(PRIVATE_PATH);
    expect(serialized).not.toContain(RAW_SUBMISSION_KEY);
    expect(serialized).not.toContain("raw-vault-a");
  });

  it("refuses to compose passing evidence from an incomplete outcome", () => {
    expect(() =>
      composePrivacyRecoveryAuthorityCorpusEvidence({
        outcome: {
          scenarioManifestSha256: DIGEST,
          vaultIdSha256s: { "vault-a": DIGEST, "vault-b": DIGEST },
          healthSummarySha256s: { "vault-a": DIGEST, "vault-b": DIGEST },
          standardDiagnosticChecksums: 2,
          privateMarkersRejected: 1,
          contentInclusiveLocalOnly: true,
          rejectedAgentAuthorityAttempts: 1,
          agentAuthorityStateMutations: 1,
          baselineAcceptanceLocalOnly: true,
          journalPreconditionsProven: true,
          explicitResumeRequired: true,
          secondVaultUnaffected: true,
          residualPaths: [],
          assertions: ["failed-outcome"],
        },
        events: [{ kind: "assertion", name: "failed-outcome", detail: {} }],
        assertions: ["failed-outcome"],
      }),
    ).toThrow("release-blocking evidence invariants");
  });

  it("fails closed when vault_health accepts a detailed or content-inclusive mode", async () => {
    const state = { state: "blocked" as LocalRecoveryState };
    const permissiveHealth = session("vault-a", state);
    const local = {
      createStandardDiagnosticBundle: async () => createStandardDiagnosticBundle(diagnosticEvidence("vault-a")),
      createContentInclusiveDiagnosticBundle: async (selection: string) =>
        createContentInclusiveDiagnosticBundle(diagnosticEvidence("vault-a"), selection),
      recoveryState: async () => state.state,
      historicalStatusSha256: async () => DIGEST,
      acceptTrustedRecoveryBaseline: async () => {
        if (state.state !== "blocked") throw new Error("not blocked");
        state.state = "paused";
      },
      resumeWrites: async () => {
        if (state.state !== "paused") throw new Error("must remain paused");
        state.state = "writable";
      },
      cleanup: async () => ({ residualPaths: [] }),
    };
    await expect(
      runPrivacyRecoveryAuthorityCorpus({
        vaultA: {
          label: "vault-a",
          vaultId: "vault-a",
          mcp: {
            ...permissiveHealth,
            callTool: async (name, arguments_) => {
              if (name === "vault_health" && Object.keys(arguments_).length > 0) {
                return permissiveHealth.callTool(name, {});
              }
              return permissiveHealth.callTool(name, arguments_);
            },
          },
          local,
          privateMarkers: [PRIVATE_NOTE],
        },
        vaultB: {
          label: "vault-b",
          vaultId: "vault-b",
          mcp: session("vault-b", { state: "writable" }),
          local: {
            ...local,
            recoveryState: async () => "writable" as const,
            acceptTrustedRecoveryBaseline: async () => {
              throw new Error("not blocked");
            },
            resumeWrites: async () => undefined,
          },
          privateMarkers: [PRIVATE_NOTE],
        },
        record: () => undefined,
        assertion: () => undefined,
      }),
    ).rejects.toThrow("content-inclusive or detailed vault_health mode");
  });

  it("fails closed when an unrelated Vault accepts a baseline without recovery proof", async () => {
    const blocked = { state: "blocked" as LocalRecoveryState };
    const writable = { state: "writable" as LocalRecoveryState };
    const localA = {
      createStandardDiagnosticBundle: async () => createStandardDiagnosticBundle(diagnosticEvidence("vault-a")),
      createContentInclusiveDiagnosticBundle: async (selection: string) =>
        createContentInclusiveDiagnosticBundle(diagnosticEvidence("vault-a"), selection),
      recoveryState: async () => blocked.state,
      historicalStatusSha256: async () => DIGEST,
      acceptTrustedRecoveryBaseline: async () => {
        if (blocked.state !== "blocked") throw new Error("not blocked");
        blocked.state = "paused";
      },
      resumeWrites: async () => {
        if (blocked.state !== "paused") throw new Error("must remain paused");
        blocked.state = "writable";
      },
      cleanup: async () => ({ residualPaths: [] }),
    };
    const localB = {
      ...localA,
      recoveryState: async () => writable.state,
      acceptTrustedRecoveryBaseline: async () => {
        writable.state = "paused";
      },
      resumeWrites: async () => {
        writable.state = "writable";
      },
    };
    await expect(
      runPrivacyRecoveryAuthorityCorpus({
        vaultA: { label: "vault-a", vaultId: "vault-a", mcp: session("vault-a", blocked), local: localA, privateMarkers: [PRIVATE_NOTE] },
        vaultB: { label: "vault-b", vaultId: "vault-b", mcp: session("vault-b", writable), local: localB, privateMarkers: [PRIVATE_NOTE] },
        record: () => undefined,
        assertion: () => undefined,
      }),
    ).rejects.toThrow("bypassed blocked recovery Journal preconditions");
    expect(writable.state).toBe("paused");
  });

  it("fails closed when a standard bundle carries malformed private content", async () => {
    const state = { state: "blocked" as LocalRecoveryState };
    const privateMarker = "private\nreason";
    const local = {
      createStandardDiagnosticBundle: async () => ({ health: { reasonCodes: [privateMarker] } }),
      createContentInclusiveDiagnosticBundle: async (selection: string) =>
        createContentInclusiveDiagnosticBundle(diagnosticEvidence("vault-a"), selection),
      recoveryState: async () => state.state,
      historicalStatusSha256: async () => DIGEST,
      acceptTrustedRecoveryBaseline: async () => { state.state = "paused"; },
      resumeWrites: async () => { state.state = "writable"; },
      cleanup: async () => ({ residualPaths: [] }),
    };
    await expect(
      runPrivacyRecoveryAuthorityCorpus({
        vaultA: { label: "vault-a", vaultId: "vault-a", mcp: session("vault-a", state), local, privateMarkers: [privateMarker] },
        vaultB: { label: "vault-b", vaultId: "vault-b", mcp: session("vault-b", { state: "writable" }), local, privateMarkers: [privateMarker] },
        record: () => undefined,
        assertion: () => undefined,
      }),
    ).rejects.toThrow("standard diagnostic bundle failed checksum validation");
  });

  it("fails closed when Agent rejection changes historical status behavior", async () => {
    const state = { state: "blocked" as LocalRecoveryState };
    let historyCalls = 0;
    const local = {
      createStandardDiagnosticBundle: async () => createStandardDiagnosticBundle(diagnosticEvidence("vault-a")),
      createContentInclusiveDiagnosticBundle: async (selection: string) =>
        createContentInclusiveDiagnosticBundle(diagnosticEvidence("vault-a"), selection),
      recoveryState: async () => state.state,
      historicalStatusSha256: async () => `${DIGEST.slice(0, 63)}${historyCalls++}`,
      acceptTrustedRecoveryBaseline: async () => { state.state = "paused"; },
      resumeWrites: async () => { state.state = "writable"; },
      cleanup: async () => ({ residualPaths: [] }),
    };
    await expect(
      runPrivacyRecoveryAuthorityCorpus({
        vaultA: { label: "vault-a", vaultId: "vault-a", mcp: session("vault-a", state), local, privateMarkers: [PRIVATE_NOTE] },
        vaultB: {
          label: "vault-b",
          vaultId: "vault-b",
          mcp: session("vault-b", { state: "writable" }),
          local: { ...local, recoveryState: async () => "writable" as const },
          privateMarkers: [PRIVATE_NOTE],
        },
        record: () => undefined,
        assertion: () => undefined,
      }),
    ).rejects.toThrow("altered historical status behavior");
  });

  it("rejects evidence that substitutes a non-public tool", () => {
    const outcome = {
      scenarioManifestSha256: DIGEST,
      vaultIdSha256s: { "vault-a": DIGEST, "vault-b": DIGEST },
      healthSummarySha256s: { "vault-a": DIGEST, "vault-b": DIGEST },
      standardDiagnosticChecksums: 2 as const,
      privateMarkersRejected: 1,
      contentInclusiveLocalOnly: true as const,
      rejectedAgentAuthorityAttempts: 1,
      agentAuthorityStateMutations: 0 as const,
      baselineAcceptanceLocalOnly: true as const,
      journalPreconditionsProven: true as const,
      explicitResumeRequired: true as const,
      secondVaultUnaffected: true as const,
      residualPaths: [] as const,
      assertions: ["proof"],
    };
    const evidence = composePrivacyRecoveryAuthorityCorpusEvidence({
      outcome,
      events: [{ kind: "assertion", name: "proof", detail: {} }],
      assertions: ["proof"],
    });
    expect(() =>
      privacyRecoveryAuthorityCorpusEvidenceSchema.parse({
        ...evidence,
        tools: [...evidence.tools.slice(0, 5), "vault_local_authority"],
      }),
    ).toThrow("exactly the six public tools");
  });

  it("fails closed when a standard bundle leaks a private marker", async () => {
    const state = { state: "blocked" as LocalRecoveryState };
    const leakingLocal = {
      createStandardDiagnosticBundle: async () => ({ leaked: PRIVATE_NOTE }),
      createContentInclusiveDiagnosticBundle: async (selection: string) =>
        createContentInclusiveDiagnosticBundle(diagnosticEvidence("vault-a"), selection),
      recoveryState: async () => state.state,
      historicalStatusSha256: async () => DIGEST,
      acceptTrustedRecoveryBaseline: async () => { state.state = "paused"; },
      resumeWrites: async () => { state.state = "writable"; },
      cleanup: async () => ({ residualPaths: [] }),
    };
    await expect(
      runPrivacyRecoveryAuthorityCorpus({
        vaultA: { label: "vault-a", vaultId: "vault-a", mcp: session("vault-a", state), local: leakingLocal, privateMarkers: [PRIVATE_NOTE] },
        vaultB: { label: "vault-b", vaultId: "vault-b", mcp: session("vault-b", { state: "writable" }), local: leakingLocal, privateMarkers: [PRIVATE_NOTE] },
        record: () => undefined,
        assertion: () => undefined,
      }),
    ).rejects.toThrow("standard diagnostic bundle");
  });
});
