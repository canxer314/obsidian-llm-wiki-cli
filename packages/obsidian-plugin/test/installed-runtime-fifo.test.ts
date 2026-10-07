import { describe, expect, it } from "vitest";
import { verifyFifoObservations } from "../src/installed-runtime/fifo-observation.js";

const entry = (key: string, seq: number) => ({ submissionKey: key, changeSetId: `cs-${key}`, enqueueSeq: seq });
const event = (kind: string, key: string, seq: number, extra = {}) => ({ kind, ...entry(key, seq), ...extra });
const normal = () => [
  event("enqueued", "head", 1), event("started", "head", 1, { writeLease: true }),
  event("preflight", "head", 1, { accepted: true, writeLease: true }), event("first-mutation", "head", 1),
  event("committed", "head", 1),
  event("enqueued", "target", 2), event("enqueued", "dependency", 3), event("enqueued", "tail", 4),
  { kind: "fixtures-changed", targetBefore: "1".repeat(64), targetAfter: "2".repeat(64), dependencyBefore: "3".repeat(64), dependencyAfter: "4".repeat(64) },
  { kind: "restart", stopped: true },
  event("recovered", "head", 1, { state: "intent_applied" }),
  event("started", "target", 2, { writeLease: true }), event("preflight", "target", 2, { accepted: false, writeLease: true }),
  event("terminal", "target", 2, { state: "intent_not_applied" }),
  event("started", "dependency", 3, { writeLease: true }), event("preflight", "dependency", 3, { accepted: false, writeLease: true }),
  event("terminal", "dependency", 3, { state: "intent_not_applied" }),
  event("started", "tail", 4, { writeLease: true }), event("preflight", "tail", 4, { accepted: true, writeLease: true }),
  event("first-mutation", "tail", 4), event("committed", "tail", 4), event("terminal", "tail", 4, { state: "intent_applied" }),
];
const options = (events: unknown[]) => ({ events, expected: [entry("head", 1), entry("target", 2), entry("dependency", 3), entry("tail", 4)], staleKeys: ["target", "dependency"] });

describe("persistent FIFO execution evidence", () => {
  it("rejects reverse execution even when all responses are distinct and successful", () => {
    const events = normal();
    const start = events.findIndex(e => e.kind === "started" && "submissionKey" in e && e.submissionKey === "target");
    const end = events.findIndex(e => e.kind === "started" && "submissionKey" in e && e.submissionKey === "tail");
    events.splice(start, end - start, ...events.slice(start + 3, end), ...events.slice(start, start + 3));
    expect(() => verifyFifoObservations(options(events))).toThrow(/FIFO/u);
  });
  it("rejects a missing in-lease preflight before the first mutation", () => {
    const events = normal().filter(e => !(e.kind === "preflight" && "submissionKey" in e && e.submissionKey === "tail"));
    expect(() => verifyFifoObservations(options(events))).toThrow(/preflight/u);
  });
  it("rejects a stale Read Dependency that still reaches a mutation", () => {
    const events = normal();
    const index = events.findIndex(e => e.kind === "terminal" && "submissionKey" in e && e.submissionKey === "dependency");
    events.splice(index, 0, event("first-mutation", "dependency", 3));
    expect(() => verifyFifoObservations(options(events))).toThrow(/stale/u);
  });
  it("rejects a missing controlled restart and an unbound extra replay execution", () => {
    expect(() => verifyFifoObservations(options(normal().filter(e => e.kind !== "restart")))).toThrow(/restart/u);
    expect(() => verifyFifoObservations(options([...normal(), event("first-mutation", "foreign", 9)]))).toThrow(/bound/u);
  });
  it("rejects duplicate starts after restart", () => {
    expect(() => verifyFifoObservations(options([...normal(), event("started", "head", 1, { writeLease: true })]))).toThrow(/FIFO/u);
  });
  it("rejects overlap and duplicate first mutations even with FIFO starts", () => {
    const events = normal();
    const start = events.findIndex(e => e.kind === "started" && "submissionKey" in e && e.submissionKey === "tail");
    const terminal = events.findIndex(e => e.kind === "terminal" && "submissionKey" in e && e.submissionKey === "dependency");
    const moved = events.splice(start, 1)[0]!;
    events.splice(terminal, 0, moved);
    expect(() => verifyFifoObservations(options(events))).toThrow(/serial/u);
    expect(() => verifyFifoObservations(options([...normal(), event("first-mutation", "tail", 4)]))).toThrow(/mutation/u);
  });
  it("accepts observed FIFO with stale target and dependency rejected before mutation", () => {
    expect(() => verifyFifoObservations(options(normal()))).not.toThrow();
  });
});
