import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";

import { createLinuxObsidianProcessControl } from "../src/installed-runtime/obsidian-process.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

it("terminates a process that ignores the initial stop signal", async () => {
  const root = await mkdtemp(join(tmpdir(), "linux-process-tree-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const handle = await createLinuxObsidianProcessControl({
    executablePath: process.execPath,
    launchArguments: ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)", "--"],
    stopTimeoutMs: 100,
  }).start({ vaultPath: root, profileDirectory: join(root, "profile") });
  cleanups.push(() => handle.stop());
  await new Promise((resolve) => setTimeout(resolve, 100));
  await handle.stop();
  expect(() => process.kill(handle.pid!, 0)).toThrow();
});

it("stops the isolated Linux process group and permits repeated stop", async () => {
  const root = await mkdtemp(join(tmpdir(), "linux-process-control-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const control = createLinuxObsidianProcessControl({
    executablePath: process.execPath,
    launchArguments: ["-e", "setInterval(() => {}, 1000)", "--"],
    stopTimeoutMs: 2_000,
  });
  const handle = await control.start({ vaultPath: root, profileDirectory: join(root, "profile") });
  cleanups.push(() => handle.stop());
  expect(handle.pid).toBeGreaterThan(0);
  await handle.stop();
  await handle.stop();
  expect(() => process.kill(handle.pid!, 0)).toThrow();
});

it("confirms that descendants have exited before stop resolves", async () => {
  const { readFile } = await import("node:fs/promises");
  const root = await mkdtemp(join(tmpdir(), "linux-process-descendant-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const pidPath = join(root, "descendant.pid");
  const script = `const {spawn}=require('node:child_process');const fs=require('node:fs');const child=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],{stdio:'ignore'});fs.writeFileSync(${JSON.stringify(pidPath)},String(child.pid));process.on('SIGTERM',()=>process.exit(0));setInterval(()=>{},1000);`;
  const handle = await createLinuxObsidianProcessControl({
    executablePath: process.execPath, launchArguments: ["-e", script, "--"], stopTimeoutMs: 2_000,
  }).start({ vaultPath: root, profileDirectory: join(root, "profile") });
  cleanups.push(() => handle.stop());
  await expect.poll(async () => readFile(pidPath, "utf8").catch(() => "")).not.toBe("");
  await new Promise((resolve) => setTimeout(resolve, 100));
  await handle.stop();
  expect(() => process.kill(-handle.pid!, 0)).toThrow();
});

it("refuses to replace a profile registered to another Vault", async () => {
  const { mkdir, writeFile, readFile } = await import("node:fs/promises");
  const root = await mkdtemp(join(tmpdir(), "linux-process-profile-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const profileDirectory = join(root, "profile");
  await mkdir(profileDirectory);
  const original = JSON.stringify({ vaults: { personal: { path: "/home/operator/real-vault" } } });
  await writeFile(join(profileDirectory, "obsidian.json"), original);
  await expect(createLinuxObsidianProcessControl({
    executablePath: process.execPath, launchArguments: ["-e", "", "--"],
  }).start({ vaultPath: root, profileDirectory })).rejects.toThrow("already registered");
  expect(await readFile(join(profileDirectory, "obsidian.json"), "utf8")).toBe(original);
});
