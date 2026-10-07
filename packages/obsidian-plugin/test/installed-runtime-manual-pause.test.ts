import { describe, expect, it } from "vitest";
import { verifyManualPauseObservations, manualPauseProofSchema } from "../src/installed-runtime/manual-pause-observation.js";
import { syntheticManualPauseProof } from "./helpers/manual-pause-proof.js";

const identity = (key: string, seq: number) => ({ submissionKey: key, changeSetId: `cs-${key}`, enqueueSeq: seq });
const head = identity("head", 1);
const tail = identity("tail", 2);
const event = (kind: string, entry = head, extra = {}) => ({ kind, ...entry, ...extra });
const third = identity("third", 3);
const lifecycle = (entry = head) => [event("started", entry, { writeLease: true }),
  event("preflight", entry, { accepted: true, writeLease: true }), event("first-mutation", entry),
  event("committed", entry), event("terminal", entry, { state: "intent_applied" })];
const normal = () => ({ expected: [head, tail, third],
  events: [event("enqueued"), ...lifecycle().slice(0, 4), event("enqueued", tail), event("enqueued", third),
    event("terminal", head, { state: "intent_applied" }), ...lifecycle(tail), ...lifecycle(third)],
  pausingEventCount: 7, pausedEventCount: 8, resumeEventCount: 8 });

describe("manual pause execution observation seam", () => {
  it("rejects starting the next queued item while the current item is draining", () => {
    expect(() => verifyManualPauseObservations({
      expected: [head, tail],
      events: [event("enqueued"), event("started", head, { writeLease: true }),
        event("preflight", head, { accepted: true, writeLease: true }), event("first-mutation"), event("committed"),
        event("enqueued", tail), event("started", tail, { writeLease: true })],
      pausingEventCount: 6, pausedEventCount: 7, resumeEventCount: 7,
    })).toThrow(/pause.*next|queued.*pause/u);
  });
  it("rejects losing a queued item instead of retaining its original FIFO identity", () => {
    expect(() => verifyManualPauseObservations({ expected: [head, tail], events: [],
      pausingEventCount: 0, pausedEventCount: 0, resumeEventCount: 0 })).toThrow(/FIFO|incomplete/u);
  });
  it("rejects reordering retained work after resume even if every item succeeds", () => {
    const proof = normal();
    proof.events.splice(8, 10, ...lifecycle(third), ...lifecycle(tail));
    expect(() => verifyManualPauseObservations(proof)).toThrow(/FIFO|order/u);
  });
  it("rejects paused before the current item has a trustworthy terminal observation", () => {
    const proof = normal();
    proof.pausedEventCount = 7;
    expect(() => verifyManualPauseObservations(proof)).toThrow(/terminal|drain/u);
  });
  it("rejects incomplete or contradictory leased execution evidence", () => {
    const proof = normal();
    proof.events = proof.events.filter(e => e.kind !== "preflight" || e.submissionKey !== "tail");
    expect(() => verifyManualPauseObservations(proof)).toThrow(/preflight|lifecycle/u);
  });
  it("rejects a paused new key bound into the final registry", () => {
    const proof = syntheticManualPauseProof("run", "profile", "a".repeat(64));
    proof.vaults[0]!.registry.push({ submissionKey: proof.unboundKeySha256, changeSetId: "f".repeat(64), enqueueSeq: 5, state: "intent_applied", executionPhase: "terminal" });
    expect(manualPauseProofSchema.safeParse(proof).success).toBe(false);
  });
  it("rejects automatic resume or reused local actions even if the final content succeeded", () => {
    const proof = syntheticManualPauseProof("run", "profile", "a".repeat(64));
    proof.localActions[1].invocationIdSha256 = proof.localActions[0].invocationIdSha256;
    expect(manualPauseProofSchema.safeParse(proof).success).toBe(false);
    const auto = normal(); auto.resumeEventCount = auto.events.length;
    expect(() => verifyManualPauseObservations(auto)).toThrow(/independent resume/u);
  });
  it("rejects mismatched independent Vault inventory footprints", async () => {
    const proof = syntheticManualPauseProof("run", "profile", "a".repeat(64));
    proof.vaults[1]!.inventory.after.push({ path: "ManualPauseProof/Head.md", sha256: "e".repeat(64), sizeBytes: 10 });
    const { compareInventories } = await import("../src/installed-runtime/test-vault.js");
    Object.assign(proof.vaults[1]!.inventory, compareInventories(proof.vaults[1]!.inventory.before, proof.vaults[1]!.inventory.after));
    expect(manualPauseProofSchema.safeParse(proof).success).toBe(false);
  });
  it("accepts serial leased FIFO with independent pausing, paused and resume observations", () => {
    expect(() => verifyManualPauseObservations(normal())).not.toThrow();
  });
});
