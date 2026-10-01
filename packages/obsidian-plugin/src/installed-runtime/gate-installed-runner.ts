import { createHash } from "node:crypto";
import { connect } from "node:net";
import { readFile } from "node:fs/promises";
import { HealthObservationError } from "./loopback-client.js";
import { lookupRegisteredRuntimeProfile } from "./runtime-profile.js";
import type { RuntimeEnvironmentProbe, RegisteredRuntimeProfile, RuntimePreflightMismatch, ObservedRuntimeEnvironment } from "./runtime-profile.js";
import { preflightRuntimeProfile } from "./runtime-profile.js";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { EXPECTED_VAULT_ID_HEADER } from "../request-policy.js";
import { installCandidateBundle, type VerifiedCandidateBundle } from "./candidate-bundle.js";
import type { GateIsolationVaultSession, InstalledGateIsolationResult } from "./gate-isolation-corpus.js";
import { runInstalledGateIsolationSlice } from "./gate-isolation-corpus.js";
import {
  readPersistedBridgeIdentity,
  waitForCondition,
  type ObsidianProcessControl,
  type ObsidianProcessHandle,
  ObsidianProcessError,
  type PersistedBridgeIdentity,
} from "./obsidian-process.js";
import {
  cleanupTestVault,
  provisionTestVault,
  type CleanupReport,
  type ProvisionedTestVault,
} from "./test-vault.js";
import type { LoopbackMcpClient } from "./loopback-client.js";
import type { InstalledRuntimeHarnessOptions } from "./harness.js";

type GateSliceOptions = Pick<InstalledGateIsolationOptions,
  "runId" | "workingDirectory" | "candidate" | "processControl" | "client" | "configDirectoryName" | "timeouts" | "provisionVault" | "cleanupVault" | "profileName" | "profile" | "probe"
>;

type HarnessRunner = NonNullable<InstalledRuntimeHarnessOptions["runGateIsolationCorpus"]>;
type InstalledGateIsolationOptions = Parameters<HarnessRunner>[0];
type GateSliceRunner = (options: InstalledGateIsolationOptions) => Promise<InstalledGateIsolationRun>;

export interface InstalledGateIsolationRun {
  readonly scope: "two-vault-registry-isolation";
  readonly result: InstalledGateIsolationResult | null;
  readonly verdict: "partial" | "failed";
  readonly cleanup: Readonly<{ "vault-a": CleanupReport | null; "vault-b": CleanupReport | null }>;
  readonly failure: "installed_gate_slice_failed" | null;
  readonly candidateBundleSha256: string;
  readonly profileName: string;
  readonly runtimeMismatches: readonly RuntimePreflightMismatch[];
  readonly provenance: Readonly<{
    vaults: readonly {
      readonly label: "vault-a" | "vault-b";
      readonly vaultIdSha256: string;
      readonly installedMainSha256: string;
      readonly runtime: ObservedRuntimeEnvironment;
    }[];
  }>;
}

interface LiveVault {
  readonly vault: ProvisionedTestVault;
  readonly process: ObsidianProcessHandle;
  readonly identity: PersistedBridgeIdentity;
  readonly client: Client;
  readonly session: GateIsolationVaultSession;
  readonly runtime: ObservedRuntimeEnvironment;
  readonly installedMainSha256: string;
}

async function listenerClosed(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const result = await new Promise<"open" | "closed">((resolve, reject) => {
      const socket = connect({ host: "127.0.0.1", port });
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error("Listener state probe timed out"));
      }, Math.max(1, deadline - Date.now()));
      socket.once("connect", () => { clearTimeout(timer); socket.destroy(); resolve("open"); });
      socket.once("error", (error: NodeJS.ErrnoException) => {
        clearTimeout(timer);
        if (error.code === "ECONNREFUSED") resolve("closed");
        else reject(error);
      });
    });
    if (result === "closed") return;
    if (Date.now() >= deadline) throw new Error("Installed gate Bridge listener remained open after stop");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function installedMainDigest(vaultPath: string, pluginId: string, configDirectoryName: string): Promise<string> {
  const identityPath = `${vaultPath}/${configDirectoryName}/plugins/${pluginId}/main.js`;
  const bytes = await readFile(identityPath);
  return createHash("sha256").update(bytes).digest("hex");
}

async function startVault(options: GateSliceOptions, label: "vault-a" | "vault-b", runtimeMismatches: RuntimePreflightMismatch[], cleanup: { "vault-a": CleanupReport | null; "vault-b": CleanupReport | null }): Promise<LiveVault> {
  const vault = await options.provisionVault({
    workingDirectory: options.workingDirectory,
    runId: `${options.runId}-gate-${label}`,
    configDirectoryName: options.configDirectoryName,
  });
  let process: ObsidianProcessHandle | undefined;
  let client: Client | undefined;
  try {
    await installCandidateBundle(options.candidate, vault.vaultPath, options.configDirectoryName);
    process = await options.processControl.start({ vaultPath: vault.vaultPath, profileDirectory: vault.profileDirectory });
    if (options.probe.probeRunning === undefined) throw new Error("Installed gate requires a running-runtime version probe");
    const observed = await options.probe.probeRunning({ vaultPath: vault.vaultPath, profileDirectory: vault.profileDirectory });
    const mismatches = preflightRuntimeProfile(options.profile, observed);
    runtimeMismatches.push(...mismatches);
    if (mismatches.length > 0) throw new Error("Installed gate runtime does not match its registered profile");
    let identity: PersistedBridgeIdentity | null = null;
    await waitForCondition(async () => {
      const observed = await readPersistedBridgeIdentity(vault.vaultPath, options.candidate.identity.pluginId, options.configDirectoryName);
      if (observed === null) return false;
      identity = observed;
      return true;
    }, { timeoutMs: options.timeouts.startupMs });
    const observedIdentity = identity as PersistedBridgeIdentity | null;
    if (observedIdentity === null) throw new Error("Installed gate Vault did not persist its Bridge identity");
    const endpoint = new URL(`http://127.0.0.1:${observedIdentity.port}/mcp`);
    await waitForCondition(async () => {
      try {
        return (await options.client.observeHealth(endpoint, observedIdentity.vaultId)).health.readiness.searchSnapshot === "ready";
      } catch (error) {
        if (error instanceof HealthObservationError && error.code === "health_unreachable") return false;
        throw error;
      }
    }, { timeoutMs: options.timeouts.startupMs });
    client = new Client({ name: `installed-gate-${label}`, version: "1.0.0" });
    await client.connect(new StreamableHTTPClientTransport(endpoint, {
      requestInit: { headers: { [EXPECTED_VAULT_ID_HEADER]: observedIdentity.vaultId } },
    }));
    const installedMainSha256 = await installedMainDigest(vault.vaultPath, options.candidate.identity.pluginId, options.configDirectoryName);
    if (installedMainSha256 !== options.candidate.identity.files.find(({ path }) => path === "main.js")?.sha256) {
      throw new Error("Installed candidate main digest differs from verified bundle");
    }
    const wireClient = client;
    const session: GateIsolationVaultSession = {
      label,
      vaultIdSha256: createHash("sha256").update(observedIdentity.vaultId).digest("hex"),
      seedNotes: vault.seedNotes,
      async callTool(tool, arguments_) {
        const result = await wireClient.callTool({ name: tool, arguments: arguments_ as never });
        const content = Array.isArray(result.content) ? result.content : undefined;
        return { isError: result.isError === true, structuredContent: result.structuredContent, ...(content === undefined ? {} : { content }) };
      },
      operator: {
        async arrange() { throw new Error("Gate control is outside this installed isolation slice"); },
        async pauseWrites() { throw new Error("Gate control is outside this installed isolation slice"); },
        async resumeWrites() { throw new Error("Gate control is outside this installed isolation slice"); },
        async restoreIdle() { throw new Error("Gate control is outside this installed isolation slice"); },
      },
    };
    return { vault, process, identity: observedIdentity, client, session, runtime: observed, installedMainSha256 };
  } catch (error) {
    cleanup[label] = { attempted: true, residualPaths: ["cleanup_unconfirmed"] };
    await client?.close().catch(() => undefined);
    if (process !== undefined) {
    try {
      await process.stop();
      } catch (stopError) {
        if (stopError instanceof ObsidianProcessError) throw stopError;
        throw new ObsidianProcessError("Installed gate startup cleanup could not confirm process stop", "obsidian_stop_failed");
      }
      const identity = await readPersistedBridgeIdentity(vault.vaultPath, options.candidate.identity.pluginId, options.configDirectoryName);
      if (identity !== null) await listenerClosed(identity.port, options.timeouts.portClosedMs);
    } else if (error instanceof ObsidianProcessError && error.code === "obsidian_stop_failed") {
      throw error;
    }
    const report = await options.cleanupVault(vault);
    cleanup[label] = report;
    if (report.residualPaths.length > 0) throw new Error("Startup failure cleanup left generated roots");
    throw error;
  }
}

async function stopVault(options: Pick<GateSliceOptions, "timeouts" | "cleanupVault">, live: LiveVault): Promise<CleanupReport> {
  await live.client.close().catch(() => undefined);
  await live.process.stop();
  await listenerClosed(live.identity.port, options.timeouts.portClosedMs);
  return options.cleanupVault(live.vault);
}

/**
 * Installed two-Vault slice: install the verified candidate into independently
 * provisioned generated Vaults, start the configured Obsidian processes, and
 * prove the healthy observational gate row and registry isolation over public
 * MCP. A partial verdict is intentional; this is not the complete gate corpus
 * and makes no blocked-gate, recovery, operator-control, or FIFO claims.
 */
export const runInstalledGateIsolationCorpus: GateSliceRunner = async (options) => {
  let a: LiveVault | undefined;
  let b: LiveVault | undefined;
  let result: InstalledGateIsolationResult | null = null;
  let failed = false;
  let sliceVerified = false;
  let aVaultIdSha256 = "";
  const runtimeMismatches: RuntimePreflightMismatch[] = [];
  const cleanup: { "vault-a": CleanupReport | null; "vault-b": CleanupReport | null } = { "vault-a": null, "vault-b": null };
  try {
    if (options.probe.probeRunning === undefined) throw new Error("Installed gate requires a running-runtime version probe");
    const runtimeOptions: GateSliceOptions = {
      ...options,
      probe: { ...options.probe, probeRunning: options.probe.probeRunning! },
    };
    if (options.profileName !== options.profile.name || (lookupRegisteredRuntimeProfile(options.profileName) !== null && lookupRegisteredRuntimeProfile(options.profileName) !== options.profile)) {
      throw new Error("Installed gate requires the matching registered runtime profile");
    }
    a = await startVault(runtimeOptions, "vault-a", runtimeMismatches, cleanup);
    aVaultIdSha256 = a.session.vaultIdSha256;
    b = await startVault(runtimeOptions, "vault-b", runtimeMismatches, cleanup);
    result = await runInstalledGateIsolationSlice({ vaultA: a.session, vaultB: b.session });
    sliceVerified = true;
  } catch {
    failed = true;
  } finally {
    for (const [label, live] of [["vault-b", b], ["vault-a", a]] as const) {
      if (live === undefined) continue;
      try {
        const report = await stopVault(options, live);
        cleanup[label] = report;
        if (report.residualPaths.length > 0) failed = true;
        } catch {
          failed = true;
          cleanup[label] = { attempted: true, residualPaths: ["cleanup_unconfirmed"] };
        }
      }
  }
  const verdict = failed ? "failed" : "partial";
  if (sliceVerified && !failed && cleanup["vault-a"] !== null && cleanup["vault-b"] !== null) {
    options.record("assertion", "installed-gate-isolation-slice", { scope: "two-vault-registry-isolation", verdict });
    options.assertion("two-vault-installed-registry-isolation");
    options.assertion("two-vault-installed-healthy-gate-row");
  }
  return {
    scope: "two-vault-registry-isolation",
    result,
    verdict,
    cleanup,
    failure: failed ? "installed_gate_slice_failed" : null,
    vaultIdSha256: aVaultIdSha256,
    candidateBundleSha256: options.candidate.identity.bundleSha256,
    profileName: options.profile.name,
    runtimeMismatches,
    provenance: {
      vaults: [a, b].flatMap((live, index) => live === undefined ? [] : [{
        label: index === 0 ? "vault-a" as const : "vault-b" as const,
        vaultIdSha256: live.session.vaultIdSha256,
        installedMainSha256: live.installedMainSha256,
        runtime: live.runtime,
      }]),
    },
  };
};
