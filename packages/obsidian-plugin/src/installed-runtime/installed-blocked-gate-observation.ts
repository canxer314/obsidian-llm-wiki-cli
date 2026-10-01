import { createHash, randomUUID } from "node:crypto";
import {
  parseHealthResult, parseReadResult, parseDiscoverResult, parseContinueResult,
  parseChangeSetSubmitResult, parseChangeSetStatusResult,
  serializeCompatibilityText, serializeReadCompatibilityText, serializeDiscoverCompatibilityText,
  serializeContinueCompatibilityText, serializeChangeSetSubmitCompatibilityText, serializeChangeSetStatusCompatibilityText,
} from "@llm-wiki/vault-contracts";
import type { WireClient, WireToolName } from "./gate-isolation-corpus.js";

/** Public-wire observations only. The caller must induct recovery through a real installed fault. */
export async function observeInstalledBlockedGate(options: {
  readonly session: WireClient;
  readonly vaultIdSha256: string;
  readonly knownSubmissionKey: string;
}): Promise<{
  readonly effectiveGate: "recovery_blocked";
  readonly terminalHistoryPreserved: true;
  readonly terminalRecordSha256: string;
  readonly freshKeyInitiallyUnknown: true;
  readonly freshKeyDisposition: "intent_not_applied";
  readonly assertions: readonly string[];
}> {
  const digest = (value: string) => createHash("sha256").update(value).digest("hex");
  async function call<T>(tool: WireToolName, args: Record<string, unknown>, parse: (value: unknown) => T,
    serialize: (value: T) => string, error: boolean): Promise<T> {
    const response = await options.session.callTool(tool, args);
    if ((response.isError === true) !== error || response.structuredContent === undefined) {
      throw new Error(`Blocked gate ${tool} returned an unexpected wire disposition`);
    }
    const result = parse(response.structuredContent);
    const text = response.content?.filter(item => typeof item === "object" && item !== null &&
      "type" in item && item.type === "text").map(item => (item as { text: string }).text).join("\n");
    if (text !== serialize(result)) throw new Error(`Blocked gate ${tool} compatibility text differs`);
    return result;
  }
  const health = await call("vault_health", {}, parseHealthResult, serializeCompatibilityText, false);
  if (health.outcome !== "observed" || digest(health.vault.id) !== options.vaultIdSha256) {
    throw new Error("Blocked gate health identity differs");
  }
  if (health.recovery.state !== "blocked" || health.effectiveGate?.code !== "recovery_blocked" ||
    health.overall !== "blocked" || health.write.gate !== "blocked" || health.write.state !== "paused") {
    throw new Error("Installed runtime is not recovery blocked");
  }
  const status = (submissionKey: string) => call("vault_change_set_status", { submissionKey },
    parseChangeSetStatusResult, serializeChangeSetStatusCompatibilityText, false);
  const before = await status(options.knownSubmissionKey);
  if (before.lookup !== "found" || before.changeSet.state !== "result_unproven") {
    throw new Error("Blocked gate requires a known terminal result_unproven record");
  }
  const read = await call("vault_read", { items: [{ kind: "metadata", path: "Notes/Welcome.md" }] },
    parseReadResult, serializeReadCompatibilityText, true);
  const discover = await call("vault_discover", {
    query: { path: { prefix: "Notes/" } }, projection: { matches: false },
    order: { by: "path", direction: "asc" }, page: { maxItems: 10, continuation: null },
  }, parseDiscoverResult, serializeDiscoverCompatibilityText, true);
  const continuation = await call("vault_continue", { continuation: "blocked-gate-observation-token" },
    parseContinueResult, serializeContinueCompatibilityText, true);
  if (read.outcome !== "operationally_blocked" || read.gate.code !== "recovery_blocked" ||
    discover.outcome !== "operationally_blocked" || discover.gate.code !== "recovery_blocked" ||
    !("outcome" in continuation) || continuation.outcome !== "operationally_blocked" || continuation.gate.code !== "recovery_blocked") {
    throw new Error("Recovery blocked did not gate every content tool");
  }
  const freshKey = `blocked-gate-${randomUUID()}`;
  if ((await status(freshKey)).lookup !== "unknown") throw new Error("Fresh blocked gate key is already bound");
  const submitted = await call("vault_change_set_submit", {
    submissionKey: freshKey,
    operations: [{ operationId: "blocked-gate-create", kind: "create_note", path: "GateIsolationProof/Blocked.md", content: "# Blocked\n", ifExists: "reject" }],
  }, parseChangeSetSubmitResult, serializeChangeSetSubmitCompatibilityText, true);
  if (submitted.outcome !== "registered" || submitted.changeSet.state !== "intent_not_applied" || submitted.gate?.code !== "recovery_blocked") {
    throw new Error("Recovery blocked did not bind the historical intent-not-applied disposition");
  }
  const bound = await status(freshKey);
  if (bound.lookup !== "found" || JSON.stringify(bound.changeSet) !== JSON.stringify(submitted.changeSet)) {
    throw new Error("Recovery blocked status did not retain its bound disposition");
  }
  const after = await status(options.knownSubmissionKey);
  if (JSON.stringify(after) !== JSON.stringify(before)) throw new Error("Blocked gate observation changed terminal history");
  return {
    effectiveGate: "recovery_blocked", terminalHistoryPreserved: true,
    terminalRecordSha256: digest(JSON.stringify(before.changeSet)), freshKeyInitiallyUnknown: true,
    freshKeyDisposition: "intent_not_applied",
    assertions: ["recovery-blocked-content-tools-gated", "recovery-blocked-terminal-history-preserved", "recovery-blocked-fresh-key-disposition-bound"],
  };
}
