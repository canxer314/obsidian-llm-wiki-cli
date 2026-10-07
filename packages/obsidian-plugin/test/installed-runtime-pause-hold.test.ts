import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import { createInstalledFifoObserver, fifoDigest } from "../src/installed-runtime/installed-fifo-observer.js";
import { createInstalledRuntimeAcceptanceDescriptor } from "../src/installed-runtime/smoke-command.js";

it("releases only the generated FIFO hold after a matching observed pausing fixture marker", async () => {
  const root = await mkdtemp(join(tmpdir(), "pause-hold-"));
  const vaultPath = join(root, "installed-runtime-vault-hold");
  const pluginDirectory = join(vaultPath, ".obsidian/plugins/bridge");
  const reportDirectory = join(root, "reports");
  await mkdir(pluginDirectory, { recursive: true });
  await mkdir(reportDirectory);
  await writeFile(join(pluginDirectory, "main.js"), "candidate");
  const created = await createInstalledRuntimeAcceptanceDescriptor({ runId: "hold", vaultPath, pluginId: "bridge", candidateBundleSha256: "a".repeat(64), reportDirectory });
  const descriptor = { ...created.descriptor, command: { action: "observe-persistent-fifo", sequence: 1, capabilityToken: created.descriptor.capabilityToken,
    expectedVaultId: "vault", endpoint: "http://127.0.0.1:1234/mcp", keys: ["head", "tail1", "tail2", "tail3"], holdUntil: "observed-manual-pausing" } };
  await writeFile(created.path, JSON.stringify(descriptor));
  await writeFile(join(pluginDirectory, "data.json"), JSON.stringify({ vaultId: "vault", port: 1234 }));
  try {
    const observer = await createInstalledFifoObserver({ vaultPath, pluginId: "bridge" });
    const held = observer!({ kind: "committed", submissionKey: "head", changeSetId: "cs-head", enqueueSeq: 1 });
    await writeFile(join(reportDirectory, "persistent-fifo-release.json"), JSON.stringify({ schemaVersion: 1,
      runId: "hold", candidateBundleSha256: descriptor.candidateBundleSha256, installedMainSha256: descriptor.installedMainSha256,
      capabilityToken: descriptor.capabilityToken, vaultId: "vault", endpoint: descriptor.command.endpoint,
      headChangeSetId: "cs-head", pausingObserved: true }), { mode: 0o600 });
    await expect(Promise.race([held.then(() => "released"), new Promise(resolve => setTimeout(() => resolve("still-held"), 500))])).resolves.toBe("released");
    expect(fifoDigest("cs-head")).toHaveLength(64);
  } finally { await rm(root, { recursive: true, force: true }); }
});
