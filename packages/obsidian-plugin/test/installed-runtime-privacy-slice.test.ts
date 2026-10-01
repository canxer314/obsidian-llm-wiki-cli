import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { expect, it } from "vitest";
import { brandVerifiedCandidateBundle, inspectCandidateBundle } from "../src/installed-runtime/candidate-bundle.js";
import { createInstalledRuntimeAcceptanceDescriptor } from "../src/installed-runtime/smoke-command.js";
import { runInstalledPrivacyRecoveryAuthorityCorpus, type InstalledPrivacyBoundaryOptions } from "../src/installed-runtime/privacy-recovery-installed-runner.js";
import { provisionTestVault, cleanupTestVault } from "../src/installed-runtime/test-vault.js";
import { ObsidianProcessError } from "../src/installed-runtime/obsidian-process.js";

it("rejects a foreign privacy descriptor before starting the generated runtime", async () => {
  const root = await mkdtemp(join(tmpdir(), "privacy-foreign-descriptor-"));
  const candidateDirectory = join(root, "candidate");
  await mkdir(candidateDirectory);
  await writeFile(join(candidateDirectory, "manifest.json"), JSON.stringify({ id: "privacy-plugin", version: "0.1.0", minAppVersion: "1.0.0" }));
  await writeFile(join(candidateDirectory, "main.js"), "candidate");
  const candidate = brandVerifiedCandidateBundle({
    bundleDirectory: candidateDirectory, identity: await inspectCandidateBundle(candidateDirectory),
    tag: "v0.1.0", repository: "test/privacy", workflowRef: "test", attestationSource: "local-candidate",
  });
  let starts = 0;
  try {
    await expect(runInstalledPrivacyRecoveryAuthorityCorpus({
      runId: "privacy-binding", workingDirectory: root, candidate, configDirectoryName: ".obsidian",
      profileName: "test", profile: { name: "test" }, probe: { probeRunning: async () => { throw new Error("Must not probe"); } }, client: {},
      processControl: { start: async () => { starts += 1; throw new Error("Unexpected startup"); } },
      timeouts: { startupMs: 10, stopMs: 10, portClosedMs: 10 }, provisionVault: provisionTestVault, cleanupVault: cleanupTestVault,
      prepareInstalledRuntimeAcceptanceDriver: async request => {
        const created = await createInstalledRuntimeAcceptanceDescriptor({ ...request, runId: "privacy-binding", reportDirectory: join(root, "reports") });
        return { ...created, descriptor: { ...created.descriptor, runId: "foreign-run" }, cleanup: async () => undefined };
      }, record: () => undefined, assertion: () => undefined,
    } as InstalledPrivacyBoundaryOptions)).rejects.toThrow("descriptor does not match");
    expect(starts).toBe(0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("preserves privacy roots if a listener survives a running-profile probe failure", async () => {
  const root = await mkdtemp(join(tmpdir(), "privacy-preflight-listener-"));
  const candidateDirectory = join(root, "candidate");
  await mkdir(candidateDirectory);
  await writeFile(join(candidateDirectory, "manifest.json"), JSON.stringify({ id: "privacy-plugin", version: "0.1.0", minAppVersion: "1.0.0" }));
  await writeFile(join(candidateDirectory, "main.js"), "candidate");
  const candidate = brandVerifiedCandidateBundle({
    bundleDirectory: candidateDirectory, identity: await inspectCandidateBundle(candidateDirectory),
    tag: "v0.1.0", repository: "test/privacy", workflowRef: "test", attestationSource: "local-candidate",
  });
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  let cleanupCalls = 0;
  try {
    await expect(runInstalledPrivacyRecoveryAuthorityCorpus({
      runId: "privacy-listener", workingDirectory: root, candidate, configDirectoryName: ".obsidian",
      profileName: "test", profile: { name: "test" }, probe: { probeRunning: async () => { throw new Error("Profile probe refused"); } }, client: {},
      processControl: { start: async request => {
        await writeFile(join(request.vaultPath, ".obsidian", "plugins", "privacy-plugin", "data.json"), JSON.stringify({ vaultId: "privacy-vault", port }));
        return { pid: 1, stop: async () => undefined };
      } },
      timeouts: { startupMs: 10, stopMs: 10, portClosedMs: 30 }, provisionVault: provisionTestVault,
      cleanupVault: async vault => { cleanupCalls += 1; return cleanupTestVault(vault); },
      prepareInstalledRuntimeAcceptanceDriver: async request => {
        const created = await createInstalledRuntimeAcceptanceDescriptor({ ...request, runId: "privacy-listener", reportDirectory: join(root, "reports") });
        return { ...created, cleanup: async () => { cleanupCalls += 1; } };
      }, record: () => undefined, assertion: () => undefined,
    } as InstalledPrivacyBoundaryOptions)).rejects.toThrow("teardown was not confirmed");
    expect(cleanupCalls).toBe(0);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

it("retains the generated privacy roots when startup cannot confirm shutdown without returning a handle", async () => {
  const root = await mkdtemp(join(tmpdir(), "privacy-startup-stop-"));
  const candidateDirectory = join(root, "candidate");
  await mkdir(candidateDirectory);
  await writeFile(join(candidateDirectory, "manifest.json"), JSON.stringify({ id: "privacy-plugin", version: "0.1.0", minAppVersion: "1.0.0" }));
  await writeFile(join(candidateDirectory, "main.js"), "candidate");
  const candidate = brandVerifiedCandidateBundle({
    bundleDirectory: candidateDirectory, identity: await inspectCandidateBundle(candidateDirectory),
    tag: "v0.1.0", repository: "test/privacy", workflowRef: "test", attestationSource: "local-candidate",
  });
  let cleanupCalls = 0;
  let descriptorCleanupCalls = 0;
  const unconfirmed = new ObsidianProcessError("Startup process group survived", "obsidian_stop_failed");
  try {
    await expect(runInstalledPrivacyRecoveryAuthorityCorpus({
      runId: "privacy-stop", workingDirectory: root, candidate, configDirectoryName: ".obsidian",
      profileName: "test", profile: { name: "test" }, probe: { probeRunning: async () => { throw new Error("Must not probe"); } }, client: {},
      processControl: { start: async () => { throw unconfirmed; } },
      timeouts: { startupMs: 10, stopMs: 10, portClosedMs: 10 }, provisionVault: provisionTestVault,
      cleanupVault: async vault => { cleanupCalls += 1; return cleanupTestVault(vault); },
      prepareInstalledRuntimeAcceptanceDriver: async request => {
        const created = await createInstalledRuntimeAcceptanceDescriptor({ ...request, runId: "privacy-stop", reportDirectory: join(root, "reports") });
        return { ...created, cleanup: async () => { descriptorCleanupCalls += 1; } };
      }, record: () => undefined, assertion: () => undefined,
    } as InstalledPrivacyBoundaryOptions)).rejects.toBe(unconfirmed);
    expect(cleanupCalls).toBe(0);
    expect(descriptorCleanupCalls).toBe(0);
    expect((await readdir(root)).some(name => name.startsWith("installed-runtime-vault-"))).toBe(true);
  } finally { await rm(root, { recursive: true, force: true }); }
});
