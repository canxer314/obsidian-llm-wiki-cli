import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { ChangeSetService, InjectedChangeSetCrash, type ChangeSetServiceOptions } from "../src/change-set.js";
import { createHash } from "node:crypto";
import { verifyFifoObservations, type FifoEvent } from "../src/installed-runtime/fifo-observation.js";
import type { ChangeSetSubmitInput } from "@llm-wiki/vault-contracts";
import { createFileSystemChangeSetExecutionAdapter, createNodeFileSystemChangeSetHost } from "../src/file-system-change-set-execution.js";

describe("actual durable Change Set FIFO observations", () => {
  it("retains queued order across COMMITTED restart and rejects target and dependency drift before mutation", async () => {
    const root = await mkdtemp(join(tmpdir(), "fifo-restart-"));
    const events: FifoEvent[] = [];
    const registry = join(root, "registry.json");
    const hash = (s: string) => createHash("sha256").update(s).digest("hex");
    await writeFile(join(root, "Target.md"), "original target");
    await writeFile(join(root, "Dependency.md"), "original dependency");
    await writeFile(join(root, "Derived.md"), "unchanged derived");
    const inputs: ChangeSetSubmitInput[] = [
      { submissionKey: "head", operations: [{ operationId: "head", kind: "create_note", path: "Head.md", content: "head", ifExists: "reject" }] },
      { submissionKey: "target", operations: [{ operationId: "target", kind: "edit_body", path: "Target.md", targetVersion: `sha256:${hash("original target")}`, edit: { kind: "replace_whole", replacement: "incorrect stale target" } }] },
      { submissionKey: "dependency", readDependencies: [{ path: "Dependency.md", contentVersion: `sha256:${hash("original dependency")}` }], operations: [{ operationId: "dependency", kind: "edit_body", path: "Derived.md", targetVersion: `sha256:${hash("unchanged derived")}`, edit: { kind: "replace_whole", replacement: "incorrect stale derived" } }] },
      { submissionKey: "tail", operations: [{ operationId: "tail", kind: "create_note", path: "Tail.md", content: "tail", ifExists: "reject" }] },
    ];
    const request = { vault: { writeGate: "open" as const, writeState: "writable" as const }, effectiveGate: null };
    const makeExecution = () => createNodeFileSystemChangeSetHost({ basePath: root, stateDirectory: join(root, ".llm-wiki"), publishSearchSnapshot: async () => {} }).then(host => createFileSystemChangeSetExecutionAdapter({ journalPath: join(root, ".llm-wiki", "journal.bin"), host }));
    let execution = await makeExecution();
    let release!: () => void;
    let parked!: () => void;
    const parkedPromise = new Promise<void>(resolve => { parked = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    let old = true;
    let stopped = false;
    const options = (): ChangeSetServiceOptions => ({
      vaultId: "test-vault", execution: { ...execution, loadRecoveryFrame: async () => {
        if (old && stopped) throw new InjectedChangeSetCrash("process-stopped");
        return execution.loadRecoveryFrame();
      } },
      store: { load: async () => readFile(registry, "utf8").then(JSON.parse).catch(e => { if (e.code === "ENOENT") return undefined; throw e; }), save: async state => { await writeFile(registry, JSON.stringify(state)); } },
      dataSource: { isContained: async () => true, readBinary: async path => readFile(join(root, path)).catch(e => { if (e.code === "ENOENT") return null; throw e; }), pathKind: async path => readFile(join(root, path)).then(() => "file" as const).catch(e => { if (e.code === "ENOENT") return null; throw e; }) },
      acceptanceObserver: async e => {
        events.push(e);
        if (old && e.kind === "committed" && e.submissionKey === "head") { parked(); await gate; throw new InjectedChangeSetCrash("after_committed"); }
      },
    });
    try {
      const first = await ChangeSetService.open(options());
      const pending = [first.submit(inputs[0]!, request).catch(() => undefined)];
      await parkedPromise;
      for (const input of inputs.slice(1)) {
        pending.push(first.submit(input, request).catch(() => undefined));
        while (events.filter(e => e.kind === "enqueued").length < pending.length) await new Promise(r => setTimeout(r, 5));
      }
      await writeFile(join(root, "Target.md"), "changed target");
      await writeFile(join(root, "Dependency.md"), "changed dependency");
      events.push({ kind: "fixtures-changed", targetBefore: hash("original target"), targetAfter: hash("changed target"), dependencyBefore: hash("original dependency"), dependencyAfter: hash("changed dependency") });
      stopped = true;
      release();
      await Promise.all(pending);
      await execution.close();
      events.push({ kind: "restart", stopped: true });
      old = false;
      execution = await makeExecution();
      const reopened = await ChangeSetService.open(options());
      for (const input of inputs) {
        const before = await reopened.status({ submissionKey: input.submissionKey }, request);
        const replay = await reopened.submit(input, request);
        expect(before.lookup).toBe("found");
        expect(replay.outcome).toBe("registered");
      }
      const state = JSON.parse(await readFile(registry, "utf8"));
      verifyFifoObservations({ events, expected: state.entries.map(({ submissionKey, changeSetId, enqueueSeq }: any) => ({ submissionKey, changeSetId, enqueueSeq })), staleKeys: ["target", "dependency"] });
      expect(await readFile(join(root, "Target.md"), "utf8")).toBe("changed target");
      expect(await readFile(join(root, "Derived.md"), "utf8")).toBe("unchanged derived");
      expect(state.entries.map((e: any) => e.changeSet.state)).toEqual(["intent_applied", "intent_not_applied", "intent_not_applied", "intent_applied"]);
    } finally { release?.(); await execution.close(); await rm(root, { recursive: true, force: true }); }
  });
  it("observes persisted enqueue, leased execution preflight and mutation rather than response order", async () => {
    const root = await mkdtemp(join(tmpdir(), "fifo-observer-"));
    const events: unknown[] = [];
    const registry = join(root, "registry.json");
    const execution = await createFileSystemChangeSetExecutionAdapter({ journalPath: join(root, ".llm-wiki", "journal.bin"), host: await createNodeFileSystemChangeSetHost({ basePath: root, stateDirectory: join(root, ".llm-wiki"), publishSearchSnapshot: async () => {} }) });
    try {
      const service = await ChangeSetService.open({
        store: { load: async () => undefined, save: async state => { await writeFile(registry, JSON.stringify(state)); } },
        dataSource: { readBinary: async () => null, pathKind: async () => null, isContained: async () => true },
        execution, vaultId: "test-vault",
        acceptanceObserver: async event => {
          if (event.kind === "enqueued") {
            const state = JSON.parse(await readFile(registry, "utf8"));
            expect(state.entries[0].enqueueSeq).toBe(1);
          }
          events.push(event);
        },
      });
      const result = await service.submit({ submissionKey: "test-fifo", operations: [{ operationId: "one", kind: "create_note", ifExists: "reject", path: "One.md", content: "# One\n" }] }, { vault: { writeGate: "open", writeState: "writable" }, effectiveGate: null });
      expect(result.outcome).toBe("registered");
      expect(events).toMatchObject([
        { kind: "enqueued", enqueueSeq: 1 }, { kind: "started", enqueueSeq: 1, writeLease: true },
        { kind: "preflight", enqueueSeq: 1, accepted: true, writeLease: true },
        { kind: "first-mutation", enqueueSeq: 1 }, { kind: "committed", enqueueSeq: 1 },
        { kind: "terminal", state: "intent_applied" },
      ]);
    } finally { await execution.close(); await rm(root, { recursive: true, force: true }); }
  });
});
