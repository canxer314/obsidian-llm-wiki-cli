import { z } from "zod";

export interface FifoEntryIdentity {
  readonly submissionKey: string;
  readonly changeSetId: string;
  readonly enqueueSeq: number;
}
const identity = { submissionKey: z.string().min(1), changeSetId: z.string().min(1), enqueueSeq: z.number().int().positive() };
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
export const fifoCommandSchema = z.object({
  action: z.literal("observe-persistent-fifo"), sequence: z.number().int().positive(), capabilityToken: digest,
  expectedVaultId: z.string().min(1), endpoint: z.string().url(),
  keys: z.tuple([z.string().min(1), z.string().min(1), z.string().min(1), z.string().min(1)]).refine(keys => new Set(keys).size === 4),
}).strict();
export const fifoEventSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("enqueued"), ...identity }).strict(),
  z.object({ kind: z.literal("started"), ...identity, writeLease: z.literal(true) }).strict(),
  z.object({ kind: z.literal("preflight"), ...identity, accepted: z.boolean(), writeLease: z.literal(true) }).strict(),
  z.object({ kind: z.literal("first-mutation"), ...identity }).strict(),
  z.object({ kind: z.literal("committed"), ...identity }).strict(),
  z.object({ kind: z.enum(["terminal", "recovered"]), ...identity, state: z.enum(["intent_applied", "intent_not_applied"]) }).strict(),
  z.object({ kind: z.literal("fixtures-changed"), targetBefore: digest, targetAfter: digest, dependencyBefore: digest, dependencyAfter: digest }).strict(),
  z.object({ kind: z.literal("restart"), stopped: z.literal(true) }).strict(),
]);
export type FifoEvent = z.infer<typeof fifoEventSchema>;

export const persistentFifoProofSchema = z.object({
  scope: z.literal("persistent-fifo-and-pre-mutation-repreflight"), source: z.literal("installed-obsidian"),
  runId: z.string().min(1), candidateBundleSha256: digest, installedMainSha256: digest,
  profile: z.string().min(1), vaultIdSha256: digest, seed: digest, canonicalManifestSha256: digest,
  beforeInventorySha256: digest, afterInventorySha256: digest,
  enqueue: z.array(z.object(identity).strict()).length(4), staleKeys: z.array(digest).length(2),
  events: z.array(fifoEventSchema).min(1), targetAfterSha256: digest, dependencyAfterSha256: digest, derivedAfterSha256: digest,
  cleanupSucceeded: z.literal(true), verdict: z.literal("passed"),
  replay: z.object({ keysReplayed: z.literal(4), identitiesPreserved: z.literal(4), recordsUnchanged: z.literal(4), noAdditionalExecutionEvents: z.literal(true) }).strict(),
}).strict().superRefine((proof, context) => {
  if (proof.enqueue.some(e => !digest.safeParse(e.submissionKey).success || !digest.safeParse(e.changeSetId).success) ||
      proof.events.some(e => "submissionKey" in e && (!digest.safeParse(e.submissionKey).success || !digest.safeParse(e.changeSetId).success))) context.addIssue({ code: "custom", message: "FIFO public identities must be redacted digests" });
  try { verifyFifoObservations({ events: proof.events, expected: proof.enqueue, staleKeys: proof.staleKeys }); }
  catch (error) { context.addIssue({ code: "custom", message: error instanceof Error ? error.message : "FIFO invalid observations" }); }
});
export type PersistentFifoProof = z.infer<typeof persistentFifoProofSchema>;


/** Events are consumed in observed append order, never reordered by a response or timestamp. */
export function verifyFifoObservations(options: {
  readonly events: readonly unknown[];
  readonly expected: readonly FifoEntryIdentity[];
  readonly staleKeys: readonly string[];
}): void {
  const events = z.array(fifoEventSchema).parse(options.events);
  const expected = options.expected;
  if (expected.length !== 4 || options.staleKeys.length !== 2 || new Set(options.staleKeys).size !== 2 ||
      options.staleKeys[0] !== expected[1]?.submissionKey || options.staleKeys[1] !== expected[2]?.submissionKey) throw new Error("FIFO incomplete scenario identities");
  if (new Set(expected.map(e => e.submissionKey)).size !== expected.length ||
      new Set(expected.map(e => e.changeSetId)).size !== expected.length ||
      expected.some((e, i) => i > 0 && e.enqueueSeq <= expected[i - 1]!.enqueueSeq)) throw new Error("FIFO invalid durable identities");
  for (const e of events) {
    if ("submissionKey" in e && !expected.some(x => x.submissionKey === e.submissionKey &&
        x.changeSetId === e.changeSetId && x.enqueueSeq === e.enqueueSeq)) throw new Error("FIFO unbound execution event");
  }
  const restarts = events.flatMap((e, i) => e.kind === "restart" ? [i] : []);
  const changed = events.findIndex(e => e.kind === "fixtures-changed");
  if (restarts.length !== 1 || changed < 0 || restarts[0]! <= changed) throw new Error("FIFO missing controlled restart");
  const restart = restarts[0]!;
  const drift = events[changed]!;
  if (drift.kind !== "fixtures-changed" || drift.targetBefore === drift.targetAfter || drift.dependencyBefore === drift.dependencyAfter) throw new Error("FIFO missing fixture drift");
  const enqueues = events.filter(e => e.kind === "enqueued");
  if (enqueues.length !== expected.length || enqueues.some((e, i) => e.submissionKey !== expected[i]?.submissionKey ||
      e.enqueueSeq !== expected[i]?.enqueueSeq) || events.some((e, i) => e.kind === "enqueued" && i >= changed)) throw new Error("FIFO durable enqueue order missing");
  const committedHead = events.findIndex(e => e.kind === "committed" && e.submissionKey === expected[0]?.submissionKey);
  if (committedHead < 0 || committedHead >= changed ||
      !events.some((e, i) => i > restart && e.kind === "recovered" && e.submissionKey === expected[0]?.submissionKey && e.state === "intent_applied")) throw new Error("FIFO missing committed restart recovery");
  const starts = events.filter(e => e.kind === "started");
  if (starts.length !== expected.length || starts.some((e, i) =>
      e.submissionKey !== expected[i]?.submissionKey || e.enqueueSeq !== expected[i]?.enqueueSeq ||
      e.changeSetId !== expected[i]?.changeSetId)) throw new Error("FIFO actual execution order disagrees with durable enqueueSeq");
  for (const [index, entry] of expected.entries()) {
    const start = events.findIndex(e => e.kind === "started" && e.submissionKey === entry.submissionKey);
    if (index > 0 && start <= restart) throw new Error("FIFO queued execution occurred before controlled restart");
    const previous = expected[index - 1];
    const previousEnd = previous === undefined ? -1 : events.findIndex(e =>
      (e.kind === (index === 1 ? "recovered" : "terminal")) && e.submissionKey === previous.submissionKey);
    if (index > 0 && (previousEnd < 0 || previousEnd >= start)) throw new Error("FIFO executions were not serial");
    const end = events.findIndex(e => (e.kind === (index === 0 ? "committed" : "terminal")) && e.submissionKey === entry.submissionKey);
    const enqueue = events.findIndex(e => e.kind === "enqueued" && e.submissionKey === entry.submissionKey);
    if (enqueue >= start || end <= start) throw new Error("FIFO incomplete serial execution lifecycle");
    const ending = events[end]!;
    if (!options.staleKeys.includes(entry.submissionKey) && ending.kind === "terminal" && ending.state !== "intent_applied") throw new Error("FIFO healthy tail did not apply");
    const checks = events.flatMap((e, i) => e.kind === "preflight" && e.submissionKey === entry.submissionKey ? [{ e, i }] : []);
    const mutations = events.flatMap((e, i) => e.kind === "first-mutation" && e.submissionKey === entry.submissionKey ? [i] : []);
    const mutation = mutations[0] ?? -1;
    if (mutations.length > 1 || (!options.staleKeys.includes(entry.submissionKey) && (mutation < 0 || end <= mutation))) throw new Error("FIFO mutation was missing, duplicated or outside execution");
    if (checks.length !== 1 || checks[0]!.i <= start || checks[0]!.i >= end || (mutation !== -1 && checks[0]!.i >= mutation) ||
        (!options.staleKeys.includes(entry.submissionKey) && !checks[0]!.e.accepted)) {
      throw new Error("FIFO missing in-lease preflight before first mutation");
    }
    if (options.staleKeys.includes(entry.submissionKey) && (checks[0]!.e.accepted || mutation !== -1 ||
        !events.some(e => e.kind === "terminal" && e.submissionKey === entry.submissionKey && e.state === "intent_not_applied"))) {
      throw new Error("FIFO stale target or Read Dependency was not rejected before mutation");
    }
  }
}
