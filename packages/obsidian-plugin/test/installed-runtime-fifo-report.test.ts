import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { appendFifoEvent, createInstalledFifoObserver, loadFifoEvents, fifoDigest } from "../src/installed-runtime/installed-fifo-observer.js";
import { syntheticFifoProof } from "./helpers/fifo-proof.js";
import { persistentFifoProofSchema } from "../src/installed-runtime/fifo-observation.js";
import type { InstalledRuntimeAcceptanceDescriptor } from "../src/installed-runtime/acceptance-driver-protocol.js";

describe("private installed FIFO report boundary", () => {
  it("rejects an applied tail without its durable COMMITTED observation", () => {
    const proof = syntheticFifoProof("run", "profile", "a".repeat(64));
    proof.events = proof.events.filter(e => !(e.kind === "committed" && e.submissionKey === proof.enqueue[3]!.submissionKey));
    expect(persistentFifoProofSchema.safeParse(proof).success).toBe(false);
  });
  it("rejects a stale preflight rejection that also has a COMMITTED observation", () => {
    const proof = syntheticFifoProof("run", "profile", "a".repeat(64));
    const index = proof.events.findIndex(e => e.kind === "terminal" && e.submissionKey === proof.staleKeys[0]);
    proof.events.splice(index, 0, { kind: "committed", ...proof.enqueue[1]! });
    expect(persistentFifoProofSchema.safeParse(proof).success).toBe(false);
  });
  it("rejects contradictory duplicate terminal observations for a stale key", () => {
    const proof = syntheticFifoProof("run", "profile", "a".repeat(64));
    const terminal = proof.events.find(e => e.kind === "terminal" && e.submissionKey === proof.staleKeys[0])!;
    if (terminal.kind !== "terminal") throw new Error("fixture omitted terminal");
    terminal.state = "intent_applied";
    proof.events.push({ kind: "terminal", ...proof.enqueue[1]!, state: "intent_not_applied" });
    expect(persistentFifoProofSchema.safeParse(proof).success).toBe(false);
  });
  it("rejects final byte observations that contradict the queued fixture drift", () => {
    const proof = syntheticFifoProof("run", "profile", "a".repeat(64));
    expect(persistentFifoProofSchema.safeParse({ ...proof, targetAfterSha256: "e".repeat(64), dependencyAfterSha256: "f".repeat(64) }).success).toBe(false);
  });
  it("rejects a second fixture drift observation rather than ignoring its contradictory bytes", () => {
    const proof = syntheticFifoProof("run", "profile", "a".repeat(64));
    const drift = proof.events.find(e => e.kind === "fixtures-changed")!;
    proof.events.push({ ...drift, kind: "fixtures-changed", targetBefore: "5".repeat(64), targetAfter: "6".repeat(64), dependencyBefore: "7".repeat(64), dependencyAfter: "8".repeat(64) });
    expect(persistentFifoProofSchema.safeParse(proof).success).toBe(false);
  });
  it("refuses missing, torn and cross-run reports; does not activate on an ordinary Vault", async () => {
    const root = await mkdtemp(join(tmpdir(), "fifo-report-"));
    try {
      const descriptor: InstalledRuntimeAcceptanceDescriptor = { schemaVersion: 1, runId: "run", vaultPath: join(root, "installed-runtime-vault-run"),
        pluginId: "bridge", candidateBundleSha256: "a".repeat(64), installedMainSha256: "b".repeat(64), capabilityToken: "c".repeat(64), reportDirectory: join(root, "reports"),
        command: { action: "observe-persistent-fifo", sequence: 1, capabilityToken: "c".repeat(64), expectedVaultId: "vault", endpoint: "http://127.0.0.1:1234/mcp", keys: ["head", "target", "dependency", "tail"] } };
      await mkdir(descriptor.reportDirectory);
      await mkdir(descriptor.vaultPath);
      await expect(loadFifoEvents(descriptor)).rejects.toThrow();
      await appendFifoEvent(descriptor, { kind: "enqueued", submissionKey: "head", changeSetId: "cs-head", enqueueSeq: 1 });
      expect(await loadFifoEvents(descriptor)).toEqual([{ kind: "enqueued", submissionKey: "head", changeSetId: "cs-head", enqueueSeq: 1 }]);
      await expect(loadFifoEvents({ ...descriptor, runId: "another" })).rejects.toThrow(/binding/u);
      const path = join(descriptor.reportDirectory, "persistent-fifo-events.jsonl");
      const raw = await readFile(path, "utf8");
      await writeFile(path, raw.trimEnd());
      await expect(loadFifoEvents(descriptor)).rejects.toThrow(/torn/u);
      expect(await createInstalledFifoObserver({ vaultPath: join(root, "ordinary-vault"), pluginId: "bridge" })).toBeUndefined();
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it("rejects unconfirmed cleanup, missing preflight and duplicate execution in public redacted proof", () => {
    const proof = syntheticFifoProof("run", "profile", "a".repeat(64));
    expect(persistentFifoProofSchema.safeParse(proof).success).toBe(true);
    expect(persistentFifoProofSchema.safeParse({ ...proof, cleanupSucceeded: false }).success).toBe(false);
    expect(persistentFifoProofSchema.safeParse({ ...proof, events: proof.events.filter(e => e.kind !== "preflight") }).success).toBe(false);
    expect(persistentFifoProofSchema.safeParse({ ...proof, events: [...proof.events, proof.events[1]] }).success).toBe(false);
    expect(fifoDigest("vault")).toMatch(/^[a-f0-9]{64}$/u);
  });
});
