import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
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
