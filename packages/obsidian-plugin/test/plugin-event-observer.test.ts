import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyPluginEventObserverWindow } from "../src/installed-runtime/plugin-event-observer.js";

const binding = { runId: "observer-run", vaultPath: "/tmp/installed-runtime-vault-observer-run", vaultId: "managed-vault", candidateBundleSha256: "a".repeat(64), installedMainSha256: "b".repeat(64), profileName: "MVP-PERF-REF-LINUX-1", observerMainSha256: "c".repeat(64), generation: 1, capabilityToken: "d".repeat(64) };
const before = new TextEncoder().encode("﻿# before\r\n中文 😀\n");
const after = new TextEncoder().encode("﻿# after\r\n完整内容 😀\n");
function transcript(bytes: Uint8Array, path = "Notes/Target.md") {
  return [
    { kind: "ready", listeners: ["create", "modify", "rename", "delete", "changed", "resolved"], enabledPlugins: ["llm-wiki-event-observer", "candidate"] },
    { kind: "candidate-start" },
    { kind: "window-begin" },
    { kind: "modify", path, rawBytesBase64: Buffer.from(bytes).toString("base64"), presence: "file" },
    { kind: "changed", path: "Notes/Target.md", rawBytesBase64: Buffer.from(after).toString("base64"), presence: "file" },
    { kind: "window-end" },
  ].map((event, index) => {
    const { capabilityToken: _token, ...identity } = binding;
    const payload = { ...identity, pid: 1234, sequence: index + 1, at: index * 10 + 1000, ...event };
    const mac = createHmac("sha256", binding.capabilityToken).update(JSON.stringify(payload)).digest("hex");
    return { payload, mac };
  });
}
function verify(events: unknown) {
  return verifyPluginEventObserverWindow({ binding, events, candidatePluginId: "candidate", expectedPid: 1234, files: [{ path: "Notes/Target.md", before, after }], maxSilenceMs: 1000 });
}

describe("enabled plugin event/indexing report boundary", () => {
  it("checks half-written move referrers even when only the destination callback is required", () => {
    expect(() => verifyPluginEventObserverWindow({ binding, events: transcript(before.slice(0, 9)), candidatePluginId: "candidate", expectedPid: 1234,
      files: [{ path: "Notes/Target.md", before, after }], maxSilenceMs: 1000, requiredCallbackPaths: [],
    })).toThrow(/complete before\/after/);
  });
  it("accepts a registered sealed no-mutation crash window without inventing callbacks", () => {
    const events = transcript(before).filter(event => !["modify", "changed"].includes(event.payload.kind));
    for (const [index, event] of events.entries()) {
      event.payload.sequence = index + 1;
      event.mac = createHmac("sha256", binding.capabilityToken).update(JSON.stringify(event.payload)).digest("hex");
    }
    expect(verifyPluginEventObserverWindow({ binding, events, candidatePluginId: "candidate", expectedPid: 1234,
      files: [{ path: "Notes/Target.md", before, after }], maxSilenceMs: 1000, requiredCallbackPaths: [],
    })).toMatchObject({ eventCount: 0, indexingCount: 0 });
  });
  it("rejects event-time partial bytes even when the last indexed bytes are complete", () => {
    expect(() => verify(transcript(before.slice(0, 9)))).toThrow(/complete before\/after/);
  });
  it("rejects a heartbeat-only observer that never captured a real Vault or indexing callback", () => {
    const events = transcript(before);
    for (const event of events) {
      if (event.payload.kind === "modify" || event.payload.kind === "changed") {
        event.payload.kind = "heartbeat";
        delete (event.payload as { path?: string }).path;
        delete (event.payload as { rawBytesBase64?: string }).rawBytesBase64;
        delete (event.payload as { presence?: string }).presence;
        event.mac = createHmac("sha256", binding.capabilityToken).update(JSON.stringify(event.payload)).digest("hex");
      }
    }
    expect(() => verify(events)).toThrow(/live event\/indexing coverage|target.*indexing|Vault callback/);
  });
  it("rejects indexing-only observations that omit the mutation Vault callback", () => {
    const events = transcript(before);
    events[3]!.payload.kind = "resolved";
    events[3]!.mac = createHmac("sha256", binding.capabilityToken).update(JSON.stringify(events[3]!.payload)).digest("hex");
    expect(() => verify(events)).toThrow(/Vault callback/);
  });
  it("rejects rollback evidence whose complete before bytes were only observed before complete after bytes", () => {
    expect(() => verifyPluginEventObserverWindow({ binding, events: transcript(before), candidatePluginId: "candidate", expectedPid: 1234,
      files: [{ path: "Notes/Target.md", before, after }], maxSilenceMs: 1000,
      requiredTransition: { path: "Notes/Target.md", states: [after, before] },
    })).toThrow(/transition/);
  });
  it("rejects forged, reused, missing, reordered, and long-silent observation evidence", () => {
    const forged = transcript(before); forged[3]!.payload.rawBytesBase64 = Buffer.from(after).toString("base64");
    expect(() => verify(forged)).toThrow(/authentication/);
    const reused = transcript(before); reused[3]!.payload.runId = "other-run";
    reused[3]!.mac = createHmac("sha256", binding.capabilityToken).update(JSON.stringify(reused[3]!.payload)).digest("hex");
    expect(() => verify(reused)).toThrow(/binding/);
    const reordered = transcript(before); [reordered[0], reordered[1]] = [reordered[1]!, reordered[0]!];
    expect(() => verify(reordered)).toThrow(/order/);
    expect(() => verify(transcript(before).filter((_, index) => index !== 3))).toThrow(/order/);
    const silent = transcript(before);
    for (const event of silent.slice(3)) {
      event.payload.at += 5000;
      event.mac = createHmac("sha256", binding.capabilityToken).update(JSON.stringify(event.payload)).digest("hex");
    }
    expect(() => verify(silent)).toThrow(/failed during/);
  });
  it("rejects complete before-only callbacks when success must expose complete after bytes", () => {
    const events = transcript(before);
    events[4]!.payload.rawBytesBase64 = Buffer.from(before).toString("base64");
    events[4]!.mac = createHmac("sha256", binding.capabilityToken).update(JSON.stringify(events[4]!.payload)).digest("hex");
    expect(() => verifyPluginEventObserverWindow({ binding, events, candidatePluginId: "candidate", expectedPid: 1234,
      files: [{ path: "Notes/Target.md", before, after }], maxSilenceMs: 1000,
      requiredVisibleStates: [{ path: "Notes/Target.md", bytes: after }],
    })).toThrow(/required.*state/);
  });
  it("rejects unrelated indexing callbacks as a substitute for observing the mutation target", () => {
    const events = transcript(before);
    events[4]!.payload.path = "Notes/Unchanged.md";
    events[4]!.payload.rawBytesBase64 = Buffer.from(before).toString("base64");
    events[4]!.mac = createHmac("sha256", binding.capabilityToken).update(JSON.stringify(events[4]!.payload)).digest("hex");
    expect(() => verifyPluginEventObserverWindow({ binding, events, candidatePluginId: "candidate", expectedPid: 1234, files: [
      { path: "Notes/Target.md", before, after }, { path: "Notes/Unchanged.md", before, after: before },
    ], maxSilenceMs: 1000 })).toThrow(/target.*indexing/);
  });
  it("rejects signed heartbeat rows carrying invented file bytes as real callback coverage", () => {
    const events = transcript(before);
    events[3]!.payload.kind = "heartbeat";
    events[4]!.payload.kind = "resolved";
    for (const event of events) event.mac = createHmac("sha256", binding.capabilityToken).update(JSON.stringify(event.payload)).digest("hex");
    expect(() => verify(events)).toThrow(/callback/);
  });
  it("rejects a staging file outside the fixture allowlist", () => {
    expect(() => verify(transcript(after, "Notes/staging-hidden.next"))).toThrow(/staging|undeclared/);
  });
  it("rejects an observer that never started, stops mid-window, or omits the end", () => {
    expect(() => verify(transcript(before).slice(1))).toThrow();
    expect(() => verify(transcript(before).slice(0, -1))).toThrow(/window/);
    const events = transcript(before);
    events[3]!.payload.kind = "stopped";
    events[3]!.mac = createHmac("sha256", binding.capabilityToken).update(JSON.stringify(events[3]!.payload)).digest("hex");
    expect(() => verify(events)).toThrow(/failed during/);
  });
  it("counts byte-bearing callbacks without claiming parent-directory callbacks as content observations", () => {
    const events = transcript(after);
    events.splice(3, 0, { ...events[3]!, payload: { ...events[3]!.payload, path: "Notes", presence: "directory", rawBytesBase64: undefined } });
    for (const [index, event] of events.entries()) {
      event.payload.sequence = index + 1;
      event.payload.at = 1000 + index * 10;
      event.mac = createHmac("sha256", binding.capabilityToken).update(JSON.stringify(event.payload)).digest("hex");
    }
    expect(verify(events)).toMatchObject({ eventCount: 2, indexingCount: 1 });
  });
  it("accepts only complete allowed bytes through the whole registered callback window", () => {
    expect(verify(transcript(before))).toMatchObject({ eventCount: 2, verdict: "passed", observerId: "llm-wiki-event-observer" });
  });
});
