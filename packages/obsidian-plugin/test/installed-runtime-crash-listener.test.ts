import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { brandVerifiedCandidateBundle, inspectCandidateBundle } from "../src/installed-runtime/candidate-bundle.js";
import { createInstalledRuntimeAcceptanceDescriptor } from "../src/installed-runtime/smoke-command.js";
import { runInstalledCrashRestorationSlice, type InstalledCrashRestorationSliceOptions } from "../src/installed-runtime/installed-crash-restoration-slice.js";
import { ObsidianProcessError } from "../src/installed-runtime/obsidian-process.js";

vi.mock("node:net", async importOriginal => ({
  ...await importOriginal<typeof import("node:net")>(),
  connect: () => {
    const socket = Object.assign(new EventEmitter(), {
      destroy: () => undefined,
      setTimeout: () => undefined,
    });
    queueMicrotask(() => socket.emit("error", Object.assign(new Error("Permission denied"), { code: "EACCES" })));
    return socket;
  },
}));

it("retains generated crash roots when listener closure cannot be observed", async () => {
  const root = await mkdtemp(join(tmpdir(), "installed-crash-listener-unknown-"));
  const candidateDirectory = join(root, "candidate");
  await mkdir(candidateDirectory);
  await writeFile(join(candidateDirectory, "manifest.json"), JSON.stringify({ id: "crash-plugin", version: "0.1.0", minAppVersion: "1.0.0" }));
  await writeFile(join(candidateDirectory, "main.js"), "candidate");
  const candidate = brandVerifiedCandidateBundle({
    bundleDirectory: candidateDirectory, identity: await inspectCandidateBundle(candidateDirectory),
    tag: "v0.1.0", repository: "test/crash", workflowRef: "test", attestationSource: "local-candidate",
  });
  let vaultPath = "";
  let cleaned = false;
  try {
    await expect(runInstalledCrashRestorationSlice({
      runId: "unknown-listener", workingDirectory: root, reportDirectory: join(root, "reports"), candidate,
      processControl: { start: async request => {
        vaultPath = request.vaultPath;
        await writeFile(join(vaultPath, ".obsidian", "plugins", "crash-plugin", "data.json"), JSON.stringify({ vaultId: "crash-vault", port: 32123 }));
        return { stop: async () => undefined };
      } },
      client: {}, profile: {}, probe: { probeRunning: async () => { throw new Error("Preflight failed"); } },
      timeouts: { startupMs: 10, stopMs: 10, portClosedMs: 30 },
      prepareAcceptanceDriver: async request => {
        const created = await createInstalledRuntimeAcceptanceDescriptor({ ...request, runId: "unknown-listener", reportDirectory: join(root, "reports") });
        return { ...created, cleanup: async () => { cleaned = true; } };
      }, record: () => undefined, assertion: () => undefined,
    } as InstalledCrashRestorationSliceOptions)).rejects.toBeInstanceOf(ObsidianProcessError);
    expect(cleaned).toBe(false);
    expect(await readdir(vaultPath)).toContain(".obsidian");
  } finally { await rm(root, { recursive: true, force: true }); }
});
