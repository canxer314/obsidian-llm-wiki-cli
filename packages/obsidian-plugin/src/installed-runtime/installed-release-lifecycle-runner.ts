import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { connect } from "node:net";
import { runLifecycleInstallScenario, type LifecycleScenarioOptions } from "./lifecycle-scenario.js";
import { runManagedVaultUninstallScenario } from "./uninstall-scenario.js";
import { ObsidianProcessError, readPersistedBridgeIdentity, type ObsidianLaunchRequest, type ObsidianProcessHandle } from "./obsidian-process.js";
import { lookupRegisteredRuntimeProfile, preflightRuntimeProfile, type ObservedRuntimeEnvironment, type RegisteredRuntimeProfile, type RuntimeEnvironmentProbe } from "./runtime-profile.js";

export interface InstalledReleaseLifecycleSliceOptions extends Omit<LifecycleScenarioOptions, "obsidianVersion"> {
  readonly profileName: string;
  readonly profile: RegisteredRuntimeProfile;
  readonly probe: RuntimeEnvironmentProbe;
  readonly record: (kind: "transport" | "tool" | "assertion" | "cleanup", name: string, detail: unknown) => void;
  readonly assertion: (name: string) => void;
}

/** A rejected launch has not transferred its handle to the scenario yet. */
async function stopRejectedRuntime(options: InstalledReleaseLifecycleSliceOptions, request: ObsidianLaunchRequest, handle: ObsidianProcessHandle): Promise<void> {
  try {
    const identity = await readPersistedBridgeIdentity(request.vaultPath, options.candidate.identity.pluginId, options.configDirectoryName ?? ".obsidian");
    await handle.stop();
    if (identity === null) return;
    const deadline = Date.now() + (options.timeouts?.stopMs ?? 30_000);
    while (Date.now() < deadline) {
      const closed = await new Promise<boolean>((resolve, reject) => {
        const socket = connect({ host: "127.0.0.1", port: identity.port });
        const timer = setTimeout(() => { socket.destroy(); reject(new Error("Listener confirmation timed out")); }, Math.max(1, deadline - Date.now()));
        socket.once("connect", () => { clearTimeout(timer); socket.destroy(); resolve(false); });
        socket.once("error", (error: NodeJS.ErrnoException) => {
          clearTimeout(timer); socket.destroy();
          if (error.code === "ECONNREFUSED") resolve(true);
          else reject(error);
        });
      });
      if (closed) return;
      await new Promise(resolve => setTimeout(resolve, Math.min(25, Math.max(1, deadline - Date.now()))));
    }
    throw new Error("Listener survived process stop");
  } catch {
    throw new ObsidianProcessError("Rejected lifecycle runtime shutdown could not be confirmed", "obsidian_stop_failed");
  }
}

/** Installed install/repair only. Simulated registration/status observations in
 * the existing scenario are deliberately not elevated into lifecycle authority. */
export async function runInstalledReleaseLifecycleSlice(options: InstalledReleaseLifecycleSliceOptions) {
  if (options.profileName !== options.profile.name || lookupRegisteredRuntimeProfile(options.profileName) !== options.profile || options.probe.probeRunning === undefined) {
    throw new Error("Installed lifecycle slice requires a registered profile and running-runtime probe");
  }
  let runtime: ObservedRuntimeEnvironment | null = null;
  let installedMainSha256: string | null = null;
  const result = await runLifecycleInstallScenario({
    ...options,
    obsidianVersion: options.profile.versions.obsidian,
    processControl: { start: async request => {
      const bytes = await readFile(join(request.vaultPath, options.configDirectoryName ?? ".obsidian", "plugins", options.candidate.identity.pluginId, "main.js"));
      installedMainSha256 = createHash("sha256").update(bytes).digest("hex");
      if (installedMainSha256 !== options.candidate.identity.files.find(file => file.path === "main.js")?.sha256) {
        throw new Error("Installed lifecycle main.js differs from the verified candidate");
      }
      const handle = await options.processControl.start(request);
      // Observe while the process is running; on a failed probe stop it before
      // throwing, otherwise the scenario never receives the owning handle.
      try {
        runtime = await options.probe.probeRunning!(request);
        if (preflightRuntimeProfile(options.profile, runtime).length !== 0) throw new Error("Installed lifecycle runtime does not match its registered profile");
      } catch (error) {
        await stopRejectedRuntime(options, request, handle);
        throw error;
      }
      return handle;
    } },
  });
  const verdict = result.verdict === "passed" && runtime !== null && installedMainSha256 !== null && result.cleanup?.attempted === true && result.cleanup.residualPaths.length === 0 ? "partial" : "failed";
  const partial = {
    scope: "installed-install-repair" as const,
    verdict: verdict as "partial" | "failed",
    candidateBundleSha256: options.candidate.identity.bundleSha256,
    profileName: options.profileName,
    installedMainSha256,
    runtime,
    install: result.install === null ? null : { outcome: result.install.outcome, action: result.install.action },
    repair: result.repair === null ? null : { outcome: result.repair.outcome, action: result.repair.action },
    cleanup: result.cleanup === null ? null : { attempted: result.cleanup.attempted, residualPaths: result.cleanup.residualPaths.map(() => "generated_runtime_residue") },
    failedStage: result.failure?.stage ?? null,
    humanRequired: ["mcp-registration", "identity-mismatch-live-observation", "upgrade-and-explicit-resume", "uninstall", "purge"] as const,
  };
  options.record("assertion", "installed-release-lifecycle-partial", partial);
  if (verdict === "partial") options.assertion("lifecycle:installed-first-install-and-same-version-repair-only");
  return partial;
}
export type InstalledReleaseLifecycleSliceResult = Awaited<ReturnType<typeof runInstalledReleaseLifecycleSlice>>;


/** Real MCP work, offline release-managed removal, and retained-state reinstall.
 * The registration commands are generated only, never installed authority. */
export async function runInstalledReleaseUninstallSlice(options: InstalledReleaseLifecycleSliceOptions) {
  if (options.profileName !== options.profile.name || lookupRegisteredRuntimeProfile(options.profileName) !== options.profile || options.probe.probeRunning === undefined) {
    throw new Error("Installed uninstall slice requires a registered profile and running-runtime probe");
  }
  const provenance: { installedMainSha256: string; runtime: ObservedRuntimeEnvironment }[] = [];
  const result = await runManagedVaultUninstallScenario({
    ...options,
    obsidianVersion: options.profile.versions.obsidian,
    processControl: { start: async request => {
      const bytes = await readFile(join(request.vaultPath, options.configDirectoryName ?? ".obsidian", "plugins", options.candidate.identity.pluginId, "main.js"));
      const installedMainSha256 = createHash("sha256").update(bytes).digest("hex");
      if (installedMainSha256 !== options.candidate.identity.files.find(file => file.path === "main.js")?.sha256) {
        throw new Error("Installed uninstall main.js differs from the verified candidate");
      }
      const handle = await options.processControl.start(request);
      try {
        const runtime = await options.probe.probeRunning!(request);
        if (preflightRuntimeProfile(options.profile, runtime).length !== 0) throw new Error("Installed uninstall runtime does not match its registered profile");
        provenance.push({ installedMainSha256, runtime });
      } catch (error) {
        await stopRejectedRuntime(options, request, handle);
        throw error;
      }
      return handle;
    } },
  });
  const verdict = result.verdict === "passed" && provenance.length === 2 && result.cleanup?.attempted === true && result.cleanup.residualPaths.length === 0 ? "partial" : "failed";
  const partial = {
    scope: "installed-uninstall-reinstall" as const,
    verdict: verdict as "partial" | "failed",
    candidateBundleSha256: options.candidate.identity.bundleSha256,
    profileName: options.profileName,
    provenance,
    uninstall: result.uninstall === null ? null : { outcome: result.uninstall.outcome },
    reinstall: result.reinstall === null ? null : { outcome: result.reinstall.outcome, action: result.reinstall.action },
    drainedMcpWork: verdict === "partial" && result.drainedChangeSetId !== null,
    cleanup: result.cleanup === null ? null : { attempted: result.cleanup.attempted, residualPaths: result.cleanup.residualPaths.map(() => "generated_runtime_residue") },
    failedStage: result.failure?.stage ?? null,
    humanRequired: ["mcp-registration-and-removal", "queued-executing-recovery-refusal", "upgrade-and-explicit-resume", "purge"] as const,
  };
  options.record("assertion", "installed-release-uninstall-partial", partial);
  if (verdict === "partial") options.assertion("lifecycle:installed-uninstall-and-lossless-reinstall-only");
  return partial;
}
export type InstalledReleaseUninstallSliceResult = Awaited<ReturnType<typeof runInstalledReleaseUninstallSlice>>;
