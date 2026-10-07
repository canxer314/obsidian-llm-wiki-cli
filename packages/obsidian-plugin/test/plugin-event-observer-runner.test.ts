import { createHash, createHmac } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runPluginEventObserverScenario } from "../src/index.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function arrange() {
  const root = await mkdtemp(join(tmpdir(), "observer-runner-test-")); roots.push(root);
  return { root, options: { scenario: "success", runId: "runner", workingDirectory: root, reportDirectory: join(root, "reports"),
    candidate: { identity: { bundleSha256: "a".repeat(64), pluginId: "candidate" } },
    probe: { probeRunning: async () => { throw new Error("must not run"); } },
    processControl: { start: async () => { throw new Error("must not launch"); } },
  } };
}
describe("plugin observer generated runner lifecycle boundary", () => {
  it("authenticates independent sealed report bytes before consuming a substituted summary", async () => {
    // Node report-boundary fixture, not installed Obsidian acceptance evidence.
    const { verifyPluginEventObserverWindow } = await import("../src/installed-runtime/plugin-event-observer.js");
    const { EVENT_OBSERVER_PLUGIN_SOURCE } = await import("../src/installed-runtime/plugin-event-observer-plugin.js");
    const corpus = await import("../src/installed-runtime/plugin-event-observer-corpus.js");
    const { root } = await arrange();
    const vaultPath = join(root, "installed-runtime-vault-source");
    const reportDirectory = join(root, "reports");
    const hash = (value: string) => createHash("sha256").update(value).digest("hex");
    const candidateMain = "candidate source fixture";
    const binding = { runId: "source-run", vaultPath, vaultId: "managed-source", candidateBundleSha256: "a".repeat(64), installedMainSha256: hash(candidateMain), profileName: "source-profile", observerMainSha256: hash(EVENT_OBSERVER_PLUGIN_SOURCE), generation: 1, capabilityToken: "d".repeat(64) };
    const before = Buffer.from("before\r\n中文"); const after = Buffer.from("after\r\n完整中文");
    const { capabilityToken: _token, ...identity } = binding;
    const events = [
      { kind: "ready", listeners: ["create", "modify", "rename", "delete", "changed", "resolved"], enabledPlugins: ["llm-wiki-event-observer", "candidate"] },
      { kind: "candidate-start" }, { kind: "window-begin" },
      { kind: "modify", path: "Target.md", presence: "file", rawBytesBase64: after.toString("base64") },
      { kind: "changed", path: "Target.md", presence: "file", rawBytesBase64: after.toString("base64") },
      { kind: "window-end" },
    ].map((event, index) => {
      const payload = { ...identity, pid: process.pid, sequence: index + 1, at: 1000 + index * 10, ...event };
      return { payload, mac: createHmac("sha256", binding.capabilityToken).update(JSON.stringify(payload)).digest("hex") };
    });
    for (const [plugin, source] of [["candidate", candidateMain], ["llm-wiki-event-observer", EVENT_OBSERVER_PLUGIN_SOURCE]]) {
      const directory = join(vaultPath, ".obsidian", "plugins", plugin!);
      await mkdir(directory, { recursive: true }); await writeFile(join(directory, "main.js"), source!);
    }
    await writeFile(join(vaultPath, ".obsidian", "plugins", "candidate", "data.json"), JSON.stringify({ vaultId: binding.vaultId, port: 12345 }));
    await writeFile(join(vaultPath, ".obsidian", "community-plugins.json"), JSON.stringify(["llm-wiki-event-observer", "candidate"]));
    await mkdir(reportDirectory);
    const sealedPath = join(reportDirectory, "observer-generation-1.sealed.jsonl");
    await writeFile(sealedPath, events.map(event => JSON.stringify(event)).join("\n") + "\n");
    const verification = { binding, candidatePluginId: "candidate", files: [{ path: "Target.md", before, after }], maxSilenceMs: 2000, requiredVisibleStates: [{ path: "Target.md", bytes: after }] };
    const window = { ...verifyPluginEventObserverWindow({ ...verification, expectedPid: process.pid, events }), supervisorPid: process.pid, supervisedProcessTreeVerified: true as const };
    const options = { ...verification, reportDirectory, configDirectoryName: ".obsidian", scenario: "success" as const, supervisorPid: process.pid, window };
    for (const replacement of [{ pid: process.pid + 100000 }, { transcriptSha256: "f".repeat(64) }, { generation: 2 }, { observerMainSha256: "f".repeat(64) }]) {
      await expect(corpus.readPluginEventObserverSourceReport({ ...options, window: { ...window, ...replacement } })).rejects.toThrow(/independent.*source|summary.*source/i);
    }
    for (const replacement of [{ runId: "borrowed-run" }, { vaultId: "other-vault" }, { candidateBundleSha256: "f".repeat(64) }]) {
      await expect(corpus.readPluginEventObserverSourceReport({ ...options, binding: { ...binding, ...replacement } })).rejects.toThrow(/binding|identity/);
    }
    await expect(corpus.readPluginEventObserverSourceReport({ ...options, supervisorPid: process.pid + 100000 })).rejects.toThrow(/process|ancestor|supervis/i);
    const source = await corpus.readPluginEventObserverSourceReport(options);
    expect(source).toMatchObject({ runId: "source-run", generation: 1, rendererPid: process.pid, supervisorPid: process.pid, transcriptSha256: window.transcriptSha256 });
    const forged = await readFile(sealedPath, "utf8");
    await writeFile(sealedPath, forged.replace(after.toString("base64"), before.toString("base64")));
    await expect(corpus.readPluginEventObserverSourceReport(options)).rejects.toThrow(/authentication/);
  });
  it("leaves ordinary Vault candidate startup unchanged without an armed correctness descriptor", async () => {
    const { awaitPluginEventObserverBeforeStartup } = await import("../src/installed-runtime/plugin-event-observer-plugin.js");
    await expect(awaitPluginEventObserverBeforeStartup({ vaultPath: "/ordinary-vault", pluginId: "candidate" })).resolves.toBeUndefined();
  });
  it("rejects ThinkFlywheel or a caller-selected ordinary Vault as a correctness scenario", async () => {
    const { options } = await arrange();
    await expect(runPluginEventObserverScenario({ ...options, scenario: "../../ThinkFlywheelVault" } as never)).rejects.toThrow(/scenario/);
  });
  it("refuses to overwrite an existing generated correctness Vault", async () => {
    const { root, options } = await arrange();
    const vaultPath = join(root, "installed-runtime-vault-runner-observer-success");
    await mkdir(vaultPath); await writeFile(join(vaultPath, "keep.txt"), "keep");
    await expect(runPluginEventObserverScenario(options as never)).rejects.toThrow(/overwrite/);
    expect((await stat(join(vaultPath, "keep.txt"))).size).toBe(4);
  });
  it("fails closed without embedded installed runtime observation before provisioning", async () => {
    const { root, options } = await arrange();
    await expect(runPluginEventObserverScenario({ ...options, probe: {} } as never)).rejects.toThrow(/installed runtime/);
    await expect(stat(join(root, "installed-runtime-vault-runner-observer-success"))).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("cleans generated roots when candidate installation fails without reporting passed", async () => {
    const { root, options } = await arrange();
    await expect(runPluginEventObserverScenario({ ...options, candidate: { directory: join(root, "missing") } } as never)).rejects.toThrow();
    await expect(stat(join(root, "installed-runtime-vault-runner-observer-success"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(join(root, "installed-runtime-profile-runner-observer-success"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
