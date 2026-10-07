import { createHash, randomUUID } from "node:crypto";
import { open, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  parseChangeSetStatusResult, parseChangeSetSubmitInput, parseChangeSetSubmitResult, parseHealthResult,
  serializeChangeSetSubmitCompatibilityText, type ChangeSetSubmitInput,
  serializeChangeSetStatusCompatibilityText, serializeCompatibilityText,
  type ChangeSetRecord,
} from "@llm-wiki/vault-contracts";
import { fingerprintChangeSetRequest, parseChangeSetRegistryState } from "../change-set.js";
import { openRecoveryJournal } from "../recovery-journal.js";
import { snapshotInventory, compareInventories } from "./test-vault.js";
import { waitForCondition } from "./obsidian-process.js";
import type { PrivacyRecoveryAuthorityMcpSession } from "./privacy-recovery-authority-corpus.js";

export interface InstalledRecoveryObservationOptions {
  readonly vaultPath: string;
  readonly vaultId: string;
  readonly session: Pick<PrivacyRecoveryAuthorityMcpSession, "callTool">;
}
export const recoveryObservationDigest = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");

async function call<T>(options: InstalledRecoveryObservationOptions, name: string, args: Record<string, unknown>,
  parse: (raw: unknown) => T, serialize: (value: T) => string, expectedError = false): Promise<T> {
  const raw = await options.session.callTool(name, args);
  const value = parse(raw.structuredContent);
  if ((raw.isError === true) !== expectedError || raw.content?.length !== 1 ||
      typeof raw.content[0] !== "object" || raw.content[0] === null ||
      !("text" in raw.content[0]) || raw.content[0].text !== serialize(value)) {
    throw new Error("Recovery observation wire representation or disposition differs");
  }
  return value;
}

export async function observeInstalledRecoveryHealth(options: InstalledRecoveryObservationOptions) {
  const health = await call(options, "vault_health", {}, parseHealthResult, serializeCompatibilityText);
  if (health.outcome !== "observed" || health.vault.id !== options.vaultId) throw new Error("Recovery observation Vault identity differs");
  return health;
}

/** Reads durable progress/registry only; never creates, repairs, clears, or authorizes state. */
export async function observeInstalledRecoveryRegistry(options: Pick<InstalledRecoveryObservationOptions, "vaultPath" | "vaultId">) {
  const raw = JSON.parse(await readFile(join(options.vaultPath, ".llm-wiki", "bridge-state.json"), "utf8")) as { vaultId?: unknown; changeSets?: unknown };
  if (raw.vaultId !== options.vaultId || raw.changeSets === undefined) throw new Error("Durable recovery Vault identity or registry is missing");
  return parseChangeSetRegistryState(raw.changeSets);
}

export async function observeInstalledRecoveryStatus(options: InstalledRecoveryObservationOptions, submissionKey: string) {
  return call(options, "vault_change_set_status", { submissionKey }, parseChangeSetStatusResult, serializeChangeSetStatusCompatibilityText);
}

export interface InstalledBlockedRecoveryIntent {
  readonly input: ChangeSetSubmitInput;
  readonly terminal: ChangeSetRecord;
}

/** Public submit while recovery blocked binds history, never requests local recovery authority. */
export async function bindInstalledBlockedRecoveryIntent(options: InstalledRecoveryObservationOptions & { readonly runId: string }): Promise<InstalledBlockedRecoveryIntent> {
  const input: ChangeSetSubmitInput = { submissionKey: `${options.runId}-blocked-${randomUUID()}`,
    operations: [{ operationId: "historical-blocked-create", kind: "create_note", path: "RecoveryAuthorityProof/Continued.md", content: "# Continued after explicit resume\n", ifExists: "reject" }] };
  if ((await observeInstalledRecoveryStatus(options, input.submissionKey)).lookup !== "unknown") throw new Error("Recovery blocked key is not fresh");
  const result = await call(options, "vault_change_set_submit", input, parseChangeSetSubmitResult, serializeChangeSetSubmitCompatibilityText, true);
  if (result.outcome !== "registered" || result.changeSet.state !== "intent_not_applied" || result.changeSet.failure !== undefined || result.gate?.code !== "recovery_blocked") {
    throw new Error("Recovery blocked key did not bind its historical intent_not_applied gate");
  }
  return { input, terminal: result.changeSet };
}

/** Compares complete public records, current Vault projections, and non-execution in durable state. */
export async function observeInstalledRecoveryHistory(options: InstalledRecoveryObservationOptions & {
  readonly terminal: InstalledBaselinePreconditions;
  readonly blocked: InstalledBlockedRecoveryIntent;
}) {
  const health = await observeInstalledRecoveryHealth(options);
  const beforeInventory = await snapshotInventory(options.vaultPath);
  const beforeRegistry = await observeInstalledRecoveryRegistry(options);
  const original = await observeInstalledRecoveryStatus(options, options.terminal.submissionKey);
  const blocked = await observeInstalledRecoveryStatus(options, options.blocked.input.submissionKey);
  const replay = await call(options, "vault_change_set_submit", options.blocked.input, parseChangeSetSubmitResult, serializeChangeSetSubmitCompatibilityText, true);
  const currentVault = { writeGate: health.write.gate, writeState: health.write.state };
  if (original.lookup !== "found" || recoveryObservationDigest(original.changeSet) !== recoveryObservationDigest(options.terminal.terminal) ||
      blocked.lookup !== "found" || recoveryObservationDigest(blocked.changeSet) !== recoveryObservationDigest(options.blocked.terminal) ||
      replay.outcome !== "registered" || replay.gate?.code !== "recovery_blocked" ||
      recoveryObservationDigest(replay.changeSet) !== recoveryObservationDigest(options.blocked.terminal) ||
      [original.vault, blocked.vault, replay.vault].some(vault => recoveryObservationDigest(vault) !== recoveryObservationDigest(currentVault))) {
    throw new Error("Recovery historical terminal record, blocked gate, or current Vault projection changed");
  }
  const registry = await observeInstalledRecoveryRegistry(options);
  const compared = compareInventories(beforeInventory, await snapshotInventory(options.vaultPath));
  if (compared.beforeDigest !== compared.afterDigest || recoveryObservationDigest(beforeRegistry) !== recoveryObservationDigest(registry)) {
    throw new Error("Recovery historical replay changed raw bytes, registry, or progress");
  }
  const entry = registry.entries.find(candidate => candidate.submissionKey === options.blocked.input.submissionKey);
  if (entry === undefined || entry.execution !== undefined || entry.historicalGate?.code !== "recovery_blocked" ||
      recoveryObservationDigest(entry.changeSet) !== recoveryObservationDigest(options.blocked.terminal)) {
    throw new Error("Recovery blocked historical key was re-executed or lost its durable disposition");
  }
  return { terminalUnchanged: true as const, blockedKeyUnchanged: true as const,
    terminalRecordSha256: recoveryObservationDigest(original.changeSet), blockedRecordSha256: recoveryObservationDigest(blocked.changeSet),
    currentVaultSha256: recoveryObservationDigest(currentVault) };
}

/** An Operator report is never proof that disk clearing/progress or live write state changed. */
export async function observeInstalledRecoveryTransition(options: InstalledRecoveryObservationOptions & {
  readonly terminal: InstalledBaselinePreconditions;
  readonly state: "paused" | "writable";
}) {
  const health = await observeInstalledRecoveryHealth(options);
  const registry = await observeInstalledRecoveryRegistry(options);
  const status = await observeInstalledRecoveryStatus(options, options.terminal.submissionKey);
  if (health.recovery.state !== "none" || health.write.gate !== "open" || health.write.state !== options.state ||
      health.queue.currentExecutionId !== null || registry.recovery?.state !== "none" ||
      (options.state === "paused" ? (health.effectiveGate?.code !== "writes_paused" || health.write.pauseSource !== "manual" || registry.writeMode !== "manual_paused") :
        (health.effectiveGate !== null || health.write.pauseSource !== null || registry.writeMode !== undefined)) ||
      status.lookup !== "found" || recoveryObservationDigest(status.changeSet) !== recoveryObservationDigest(options.terminal.terminal) ||
      status.vault.writeGate !== health.write.gate || status.vault.writeState !== health.write.state) {
    throw new Error("Recovery transition lacks independent live state, durable progress, or preserved terminal evidence");
  }
  const handle = await open(join(options.vaultPath, ".llm-wiki", "recovery-journal.bin"), "r");
  try {
    const journal = await openRecoveryJournal(handle);
    const frame = await journal.recover();
    const facts = await journal.diagnosticFacts();
    if (frame !== undefined || facts.frames.length !== 2 || facts.frames.some(slot => slot.state !== "empty")) {
      throw new Error("Recovery transition lacks independent Journal clearing");
    }
    return { journalCleared: true as const, recoveryReleased: true as const, writeState: options.state,
      registrySha256: recoveryObservationDigest(registry), terminalRecordSha256: recoveryObservationDigest(status.changeSet) };
  } finally { await handle.close(); }
}

export async function observeInstalledRecoveryContinuation(options: InstalledRecoveryObservationOptions & {
  readonly blocked: InstalledBlockedRecoveryIntent;
  readonly submissionKey: string;
  readonly timeoutMs: number;
}) {
  if (options.submissionKey === options.blocked.input.submissionKey) throw new Error("Recovery continuation requires a new Submission Key");
  const health = await observeInstalledRecoveryHealth(options);
  if (health.recovery.state !== "none" || health.write.state !== "writable" || health.write.gate !== "open" || health.effectiveGate !== null) {
    throw new Error("Recovery continuation requires independent explicit resume evidence");
  }
  if ((await observeInstalledRecoveryStatus(options, options.submissionKey)).lookup !== "unknown") throw new Error("Recovery continuation key is already bound");
  const input = { ...options.blocked.input, submissionKey: options.submissionKey };
  const submitted = await call(options, "vault_change_set_submit", input, parseChangeSetSubmitResult, serializeChangeSetSubmitCompatibilityText);
  if (submitted.outcome !== "registered" || submitted.gate !== undefined || submitted.changeSet.changeSetId === options.blocked.terminal.changeSetId) {
    throw new Error("New recovery continuation did not register a distinct Change Set");
  }
  let terminal: ChangeSetRecord | undefined;
  await waitForCondition(async () => {
    const status = await observeInstalledRecoveryStatus(options, input.submissionKey);
    if (status.lookup !== "found" || status.changeSet.changeSetId !== submitted.changeSet.changeSetId) throw new Error("Continuation status identity differs");
    if (status.changeSet.state === "in_progress") return false;
    if (status.changeSet.state !== "intent_applied") throw new Error("New recovery continuation did not prove intent_applied");
    terminal = status.changeSet;
    return true;
  }, { timeoutMs: options.timeoutMs, intervalMs: 25 });
  const operation = input.operations[0];
  if (operation?.kind !== "create_note") throw new Error("Recovery continuation fixture is not the bound create intent");
  const actual = await readFile(join(options.vaultPath, operation.path));
  const expected = Buffer.from(operation.content, "utf8");
  if (!actual.equals(expected)) throw new Error("Recovery continuation raw bytes differ from the original blocked intent");
  return { newKeyApplied: true as const, submissionKeySha256: recoveryObservationDigest(input.submissionKey),
    terminalRecordSha256: recoveryObservationDigest(terminal), rawBytesSha256: createHash("sha256").update(actual).digest("hex") };
}

export interface InstalledBaselinePreconditions {
  readonly submissionKey: string;
  readonly changeSetId: string;
  readonly terminal: ChangeSetRecord;
  readonly journalSha256: string;
  readonly registrySha256: string;
}

/** Independent live wire + readable disk Journal + durable registry correlation. */
export async function observeInstalledBaselinePreconditions(options: InstalledRecoveryObservationOptions): Promise<InstalledBaselinePreconditions> {
  const health = await observeInstalledRecoveryHealth(options);
  if (health.recovery.state !== "blocked" || health.effectiveGate?.code !== "recovery_blocked" ||
      health.write.gate !== "blocked" || health.queue.currentExecutionId !== null) {
    throw new Error("Baseline requires blocked recovery with no in-flight execution");
  }
  const registry = await observeInstalledRecoveryRegistry(options);
  const unproven = registry.entries.filter(entry => entry.changeSet.state === "result_unproven");
  const entry = unproven[0];
  if (unproven.length !== 1 || entry?.execution?.phase !== "terminal" || registry.recovery?.state !== "blocked" ||
      registry.recovery.changeSetId !== entry.changeSetId || registry.entries.some(candidate => candidate.execution?.phase === "executing")) {
    throw new Error("Baseline requires a unique associated terminal result_unproven registry");
  }
  const path = join(options.vaultPath, ".llm-wiki", "recovery-journal.bin");
  const handle = await open(path, "r");
  try {
    const journal = await openRecoveryJournal(handle);
    const frame = await journal.recover();
    const diagnostic = await journal.diagnosticFacts();
    if (diagnostic.frames.length !== 2 || diagnostic.frames.some(slot => slot.state === "invalid")) throw new Error("Baseline has a corrupt Journal slot");
    const payload = frame?.payload;
    if (frame?.phase !== "FAILED" || typeof payload !== "object" || payload === null || Array.isArray(payload) ||
        payload.phase !== "FAILED" || payload.vaultId !== options.vaultId || payload.changeSetId !== entry.changeSetId ||
        payload.enqueueSeq !== entry.enqueueSeq ||
        fingerprintChangeSetRequest(parseChangeSetSubmitInput(payload.input)) !== entry.fingerprint ||
        parseChangeSetSubmitInput(payload.input).submissionKey !== entry.submissionKey) {
      throw new Error("Baseline FAILED Journal does not match the same Vault and terminal Change Set");
    }
    const status = await observeInstalledRecoveryStatus(options, entry.submissionKey);
    if (status.lookup !== "found" || recoveryObservationDigest(status.changeSet) !== recoveryObservationDigest(entry.changeSet)) {
      throw new Error("Baseline live terminal record differs from durable registry");
    }
    return { submissionKey: entry.submissionKey, changeSetId: entry.changeSetId, terminal: status.changeSet,
      journalSha256: createHash("sha256").update(await readFile(path)).digest("hex"), registrySha256: recoveryObservationDigest(registry) };
  } finally { await handle.close(); }
}
