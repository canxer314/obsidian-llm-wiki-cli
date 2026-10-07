import { z } from "zod";
import { fifoEventSchema, type FifoEntryIdentity } from "./fifo-observation.js";
import { compareInventories } from "./test-vault.js";

const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const identity = z.object({ submissionKey: digest, changeSetId: digest, enqueueSeq: z.number().int().positive() }).strict();
const inventoryEntry = z.object({ path: z.string().min(1), sha256: digest, sizeBytes: z.number().int().nonnegative() }).strict();
const registryEntry = identity.extend({ state: z.enum(["in_progress", "intent_applied", "intent_not_applied", "result_unproven"]), executionPhase: z.enum(["queued", "executing", "terminal"]).nullable() }).strict();
const health = z.object({ write: z.object({ gate: z.enum(["open", "blocked"]), state: z.enum(["writable", "pausing", "paused"]), pauseSource: z.enum(["manual", "maintenance"]).nullable() }).strict(),
  recovery: z.enum(["none", "in_progress", "blocked"]), effectiveGate: z.enum(["writes_paused", "upgrade_in_progress", "recovery_blocked", "recovery_in_progress"]).nullable(),
  queue: z.object({ currentExecutionId: digest.nullable(), length: z.number().int().nonnegative(), headChangeSetId: digest.nullable() }).strict() }).strict();
export const manualPauseProofSchema = z.object({
  scope: z.literal("manual-pause-drain-and-fifo"), source: z.literal("installed-obsidian"), runId: z.string().min(1), profile: z.string().min(1),
  candidateBundleSha256: digest, installedMainSha256: digest, canonicalManifestSha256: digest,
  vaults: z.array(z.object({ label: z.enum(["vault-a", "vault-b"]), vaultIdSha256: digest, seed: digest,
    runtime: z.object({ platform: z.string(), osBuild: z.string(), obsidianVersion: z.string(), electronVersion: z.string(), nodeVersion: z.string(), capabilities: z.array(z.string()) }).strict(),
    inventory: z.object({ before: z.array(inventoryEntry).min(1), after: z.array(inventoryEntry).min(1), beforeDigest: digest, afterDigest: digest,
      addedPaths: z.array(z.string()), removedPaths: z.array(z.string()), changedPaths: z.array(z.string()) }).strict(), registry: z.array(registryEntry).min(1) }).strict()).length(2),
  enqueue: z.array(identity).length(4), events: z.array(fifoEventSchema).min(1),
  pausingEventCount: z.number().int().positive(), pausedEventCount: z.number().int().positive(), resumeEventCount: z.number().int().positive(),
  health: z.object({ pausing: health, paused: health, resumed: health }).strict(),
  localActions: z.tuple([z.object({ action: z.literal("pause-writes"), invocationIdSha256: digest, beforeSha256: digest, afterSha256: digest }).strict(),
    z.object({ action: z.literal("resume-writes"), invocationIdSha256: digest, beforeSha256: digest, afterSha256: digest }).strict()]),
  unboundKeySha256: digest, contentSha256: digest, independentProgressChangeSetIdSha256: digest,
  cleanup: z.array(z.object({ attempted: z.literal(true), residualPaths: z.array(z.string()).length(0) }).strict()).length(2),
  cleanupSucceeded: z.literal(true), verdict: z.literal("passed"),
}).strict().superRefine((proof, context) => {
  const fail = (message: string) => context.addIssue({ code: "custom", message });
  try { verifyManualPauseObservations({ ...proof, expected: proof.enqueue }); }
  catch (error) { fail(error instanceof Error ? error.message : "Manual pause invalid execution evidence"); }
  if (proof.events.some(event => "submissionKey" in event && (!digest.safeParse(event.submissionKey).success || !digest.safeParse(event.changeSetId).success))) fail("Manual pause public identities must be redacted digests");
  if (proof.vaults[0]?.label !== "vault-a" || proof.vaults[1]?.label !== "vault-b" || proof.vaults[0]!.vaultIdSha256 === proof.vaults[1]!.vaultIdSha256 ||
      proof.localActions[0].invocationIdSha256 === proof.localActions[1].invocationIdSha256) fail("Manual pause requires independent Vaults and independent local invocations");
  const { pausing, paused, resumed } = proof.health;
  if (pausing.write.state !== "pausing" || pausing.write.pauseSource !== "manual" || pausing.effectiveGate !== "writes_paused" || pausing.queue.currentExecutionId !== proof.enqueue[0]?.changeSetId || pausing.queue.length !== 4 ||
      paused.write.state !== "paused" || paused.write.pauseSource !== "manual" || paused.effectiveGate !== "writes_paused" || paused.queue.currentExecutionId !== null || paused.queue.length !== 3 || paused.queue.headChangeSetId !== proof.enqueue[1]?.changeSetId ||
      resumed.write.state !== "writable" || resumed.write.pauseSource !== null || resumed.effectiveGate !== null || resumed.queue.length !== 0 || resumed.queue.currentExecutionId !== null || resumed.queue.headChangeSetId !== null ||
      [pausing, paused, resumed].some(value => value.recovery !== "none" || value.write.gate !== "open")) fail("Manual pause live health/queue contradicts drain/resume");
  const expectedAdded = [["Head", "First", "Second", "Third"].map(name => `ManualPauseProof/${name}.md`).sort(), ["ManualPauseProof/Independent.md"]];
  for (const [index, vault] of proof.vaults.entries()) {
    if (JSON.stringify(vault.inventory.addedPaths) !== JSON.stringify(expectedAdded[index])) fail("Manual pause independent Vault inventory footprint mismatch");
    const comparison = compareInventories(vault.inventory.before, vault.inventory.after);
    if (comparison.beforeDigest !== vault.inventory.beforeDigest || comparison.afterDigest !== vault.inventory.afterDigest ||
        JSON.stringify(comparison.addedPaths) !== JSON.stringify(vault.inventory.addedPaths) || comparison.removedPaths.length || comparison.changedPaths.length || vault.inventory.removedPaths.length || vault.inventory.changedPaths.length) fail("Manual pause inventories contradict observed bytes");
    if (vault.registry.some(entry => entry.executionPhase !== "terminal" || entry.state !== "intent_applied" || entry.submissionKey === proof.unboundKeySha256)) fail("Manual pause registry lost work or bound paused key");
  }
  if (JSON.stringify(proof.vaults[0]!.registry.map(({ state, executionPhase, ...entry }) => entry)) !== JSON.stringify(proof.enqueue) ||
      proof.vaults[1]!.registry.length !== 1 || proof.vaults[1]!.registry[0]?.changeSetId !== proof.independentProgressChangeSetIdSha256) fail("Manual pause final registries contradict independent execution");
});
export type ManualPauseProof = z.infer<typeof manualPauseProofSchema>;

/** Append positions are sampled independently from live pausing/paused and local resume. */
export function verifyManualPauseObservations(options: {
  readonly events: readonly unknown[];
  readonly expected: readonly FifoEntryIdentity[];
  readonly pausingEventCount: number;
  readonly pausedEventCount: number;
  readonly resumeEventCount: number;
}): void {
  const events = z.array(fifoEventSchema).parse(options.events);
  if (events.some((event, index) => event.kind === "started" &&
      event.submissionKey !== options.expected[0]?.submissionKey && index < options.resumeEventCount)) {
    throw new Error("Manual pause started the next queued item before independent resume");
  }
  const expected = options.expected;
  const enqueued = events.filter(event => event.kind === "enqueued");
  if (expected.length < 2 || new Set(expected.map(entry => entry.submissionKey)).size !== expected.length ||
      new Set(expected.map(entry => entry.changeSetId)).size !== expected.length ||
      expected.some((entry, index) => index > 0 && entry.enqueueSeq <= expected[index - 1]!.enqueueSeq) ||
      enqueued.length !== expected.length || enqueued.some((event, index) =>
        JSON.stringify({ submissionKey: event.submissionKey, changeSetId: event.changeSetId, enqueueSeq: event.enqueueSeq }) !== JSON.stringify(expected[index]))) {
    throw new Error("Manual pause incomplete durable FIFO identities");
  }
  const headTerminal = events.findIndex(event => event.kind === "terminal" && event.submissionKey === expected[0]?.submissionKey);
  if (![options.pausingEventCount, options.pausedEventCount, options.resumeEventCount].every(count => Number.isSafeInteger(count) && count >= 0 && count <= events.length) ||
      options.pausingEventCount >= options.pausedEventCount || options.pausedEventCount > options.resumeEventCount ||
      headTerminal < options.pausingEventCount || headTerminal >= options.pausedEventCount) {
    throw new Error("Manual pause did not drain the current item to a trustworthy terminal before paused");
  }
  const starts = events.filter(event => event.kind === "started");
  if (starts.length !== expected.length || starts.some((event, index) => event.submissionKey !== expected[index]?.submissionKey ||
      event.changeSetId !== expected[index]?.changeSetId || event.enqueueSeq !== expected[index]?.enqueueSeq)) {
    throw new Error("Manual pause resumed execution order contradicts durable FIFO");
  }
  if (events.some(event => !("submissionKey" in event) || !expected.some(entry =>
      entry.submissionKey === event.submissionKey && entry.changeSetId === event.changeSetId && entry.enqueueSeq === event.enqueueSeq))) {
    throw new Error("Manual pause contains unbound execution evidence");
  }
  let previousTerminal = -1;
  for (const entry of expected) {
    const lifecycle = events.flatMap((event, index) => "submissionKey" in event && event.submissionKey === entry.submissionKey ? [{ event, index }] : []);
    const kinds = lifecycle.map(({ event }) => event.kind);
    if (JSON.stringify(kinds) !== JSON.stringify(["enqueued", "started", "preflight", "first-mutation", "committed", "terminal"]) ||
        lifecycle[1]!.index <= previousTerminal ||
        (lifecycle[2]!.event.kind === "preflight" && !lifecycle[2]!.event.accepted) ||
        (lifecycle[5]!.event.kind === "terminal" && lifecycle[5]!.event.state !== "intent_applied")) {
      throw new Error("Manual pause incomplete or contradictory serial preflight/mutation/commit/terminal lifecycle");
    }
    previousTerminal = lifecycle[5]!.index;
  }
}
