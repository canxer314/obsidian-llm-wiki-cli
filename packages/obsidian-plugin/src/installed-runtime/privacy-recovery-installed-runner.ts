import { createHash } from "node:crypto";
import { connect } from "node:net";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { parseChangeSetStatusResult, parseHealthResult } from "@llm-wiki/vault-contracts";
import { EXPECTED_VAULT_ID_HEADER } from "../request-policy.js";
import { HealthObservationError } from "./loopback-client.js";
import { PUBLIC_WIRE_TOOL_NAMES } from "./public-wire-corpus.js";
import { preflightRuntimeProfile } from "./runtime-profile.js";
import { loadInstalledRuntimeAcceptanceDescriptor } from "./acceptance-driver-protocol.js";
import type { InstalledRuntimeAcceptanceDescriptor } from "./acceptance-driver-protocol.js";
import type { ObservedRuntimeEnvironment, RegisteredRuntimeProfile, RuntimeEnvironmentProbe } from "./runtime-profile.js";
import {
  ObsidianProcessError,
  readPersistedBridgeIdentity,
  waitForCondition,
  type ObsidianProcessHandle,
  type PersistedBridgeIdentity,
} from "./obsidian-process.js";
import { cleanupTestVault, provisionTestVault, type ProvisionedTestVault } from "./test-vault.js";
import type { VerifiedCandidateBundle } from "./candidate-bundle.js";
import type { LoopbackMcpClient } from "./loopback-client.js";
import type { ObsidianProcessControl } from "./obsidian-process.js";

export interface InstalledPrivacyBoundaryOptions {
  readonly runId: string;
  readonly workingDirectory: string;
  readonly candidate: VerifiedCandidateBundle;
  readonly processControl: ObsidianProcessControl;
  readonly client: LoopbackMcpClient;
  readonly configDirectoryName: string;
  readonly timeouts: { readonly startupMs: number; readonly stopMs: number; readonly portClosedMs: number };
  readonly profileName: string;
  readonly profile: RegisteredRuntimeProfile;
  readonly probe: RuntimeEnvironmentProbe;
  readonly provisionVault: typeof provisionTestVault;
  readonly cleanupVault: typeof cleanupTestVault;
  readonly prepareInstalledRuntimeAcceptanceDriver: (request: {
    readonly vaultPath: string; readonly pluginId: string; readonly candidateBundleSha256: string; readonly configDirectoryName: string;
  }) => Promise<{ readonly path: string; readonly descriptor: InstalledRuntimeAcceptanceDescriptor; cleanup(): Promise<void> }>;
  readonly record: (kind: "transport" | "tool" | "assertion" | "cleanup", name: string, detail: unknown) => void;
  readonly assertion: (name: string) => void;
}
type RunnerOptions = InstalledPrivacyBoundaryOptions;
type SliceOptions = RunnerOptions & {
  readonly probe: RuntimeEnvironmentProbe & {
    probeRunning(request: { readonly vaultPath: string; readonly profileDirectory: string }): Promise<ObservedRuntimeEnvironment>;
  };
};
type AcceptanceHandle = Awaited<ReturnType<RunnerOptions["prepareInstalledRuntimeAcceptanceDriver"]>>;
type McpResult = Awaited<ReturnType<Client["callTool"]>>;
export interface InstalledPrivacyAuthorityBoundarySliceResult {
  readonly scope: "two-vault-agent-authority-boundary";
  readonly verdict: "partial";
  readonly candidateBundleSha256: string;
  readonly profileName: string;
  readonly vaultIdsSha256: Readonly<Record<"vault-a" | "vault-b", string>>;
  readonly rejectedAuthorityAttempts: number;
  readonly observedHealthUnchanged: true;
  readonly provenance: readonly {
    readonly label: "vault-a" | "vault-b";
    readonly vaultIdSha256: string;
    readonly installedMainSha256: string;
    readonly runtime: ObservedRuntimeEnvironment;
    readonly beforeHealthSha256: string;
    readonly afterHealthSha256: string;
    readonly beforeUnknownKeyStatusSha256: string;
    readonly afterUnknownKeyStatusSha256: string;
  }[];
  readonly humanRequired: readonly ["diagnostic-bundles", "recovery-baseline", "resume-writes"];
}

interface LiveVault {
  readonly label: "vault-a" | "vault-b";
  readonly vault: ProvisionedTestVault;
  readonly identity: PersistedBridgeIdentity;
  readonly endpoint: URL;
  readonly process: ObsidianProcessHandle;
  readonly client: Client;
  readonly descriptorPath: string;
  readonly descriptor: Awaited<ReturnType<typeof loadInstalledRuntimeAcceptanceDescriptor>>["descriptor"];
  readonly acceptance: AcceptanceHandle;
  readonly observedRuntime: ObservedRuntimeEnvironment;
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

async function waitForIdentity(check: () => Promise<PersistedBridgeIdentity | null>, timeoutMs: number): Promise<PersistedBridgeIdentity> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const poll = async (): Promise<void> => {
      try {
        const identity = await check();
        if (identity !== null) return resolve(identity);
        if (Date.now() >= deadline) return reject(new Error("Privacy/recovery Bridge identity unavailable"));
        setTimeout(() => { void poll(); }, 25);
      } catch (error) {
        reject(error);
      }
    };
    void poll();
  });
}

async function waitForListenerClosed(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const connected = await new Promise<boolean>((resolve) => {
      const socket = connect({ host: "127.0.0.1", port });
      socket.setTimeout(Math.max(1, deadline - Date.now()));
      socket.once("connect", () => { socket.destroy(); resolve(true); });
      socket.once("error", (error: NodeJS.ErrnoException) => {
        socket.destroy();
        resolve(error.code !== "ECONNREFUSED");
      });
      socket.once("timeout", () => { socket.destroy(); resolve(true); });
    });
    if (!connected) return;
    if (Date.now() >= deadline) throw new Error("Privacy/recovery MCP listener remained open after stop");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function startVault(options: SliceOptions, label: LiveVault["label"]): Promise<LiveVault> {
  const vault = await options.provisionVault({
    workingDirectory: options.workingDirectory,
    runId: `${options.runId}-privacy-${label}`,
    configDirectoryName: options.configDirectoryName,
  });
  let process: ObsidianProcessHandle | undefined;
  let client: Client | undefined;
  let acceptance: AcceptanceHandle | undefined;
  let identity: PersistedBridgeIdentity | undefined;
  let listenerPort: number | undefined;
  try {
    const { installCandidateBundle } = await import("./candidate-bundle.js");
    await installCandidateBundle(options.candidate, vault.vaultPath, options.configDirectoryName);
    acceptance = await options.prepareInstalledRuntimeAcceptanceDriver({
      vaultPath: vault.vaultPath,
      pluginId: options.candidate.identity.pluginId,
      candidateBundleSha256: options.candidate.identity.bundleSha256,
      configDirectoryName: options.configDirectoryName,
    });
    if (acceptance.descriptor.runId !== options.runId || acceptance.descriptor.vaultPath !== vault.vaultPath ||
        acceptance.descriptor.pluginId !== options.candidate.identity.pluginId ||
        acceptance.descriptor.candidateBundleSha256 !== options.candidate.identity.bundleSha256 ||
        acceptance.descriptor.installedMainSha256 !== options.candidate.identity.files.find(({ path }) => path === "main.js")?.sha256) {
      throw new Error("Installed privacy/recovery descriptor does not match this run and candidate");
    }
    process = await options.processControl.start({
      vaultPath: vault.vaultPath,
      profileDirectory: vault.profileDirectory,
    });
    const observed = await options.probe.probeRunning({ vaultPath: vault.vaultPath, profileDirectory: vault.profileDirectory });
    if (preflightRuntimeProfile(options.profile, observed).length > 0) throw new Error("Privacy/recovery running runtime does not match the registered profile");
    const observedIdentity = await waitForIdentity(async (): Promise<PersistedBridgeIdentity | null> => {
      identity = await readPersistedBridgeIdentity(
        vault.vaultPath,
        options.candidate.identity.pluginId,
        options.configDirectoryName,
      ) ?? undefined;
      return identity ?? null;
    }, options.timeouts.startupMs);
    listenerPort = observedIdentity.port;
    const endpoint = new URL(`http://127.0.0.1:${observedIdentity.port}/mcp`);
    await waitForCondition(async () => {
      try {
        const health = await options.client.observeHealth(endpoint, observedIdentity.vaultId);
        return health.health.readiness.searchSnapshot === "ready";
      } catch (error) {
        if (error instanceof HealthObservationError && error.code === "health_unreachable") return false;
        throw error;
      }
    }, { timeoutMs: options.timeouts.startupMs });
    client = new Client({ name: `privacy-recovery-${label}`, version: "1.0.0" });
    await client.connect(new StreamableHTTPClientTransport(endpoint, {
      requestInit: { headers: { [EXPECTED_VAULT_ID_HEADER]: observedIdentity.vaultId } },
    }));
    if (acceptance === undefined) throw new Error("Installed privacy/recovery acceptance descriptor was not armed");
    const loaded = await loadInstalledRuntimeAcceptanceDescriptor({
      vaultPath: vault.vaultPath,
      pluginId: options.candidate.identity.pluginId,
      configDirectoryName: options.configDirectoryName,
    });
    const descriptor = loaded.descriptor;
    const startedProcess = process;
    if (startedProcess === undefined || client === undefined) throw new Error("Installed privacy/recovery process or transport is unavailable");
    if (descriptor.runId !== options.runId || descriptor.vaultPath !== vault.vaultPath ||
        descriptor.pluginId !== options.candidate.identity.pluginId ||
        descriptor.candidateBundleSha256 !== options.candidate.identity.bundleSha256 ||
        descriptor.installedMainSha256 !== options.candidate.identity.files.find(({ path }) => path === "main.js")?.sha256 ||
        descriptor.reportDirectory !== acceptance.descriptor.reportDirectory) {
      throw new Error("Installed privacy/recovery descriptor does not match this run and candidate");
    }
    return { label, vault, identity: observedIdentity, endpoint, process: startedProcess, client, descriptorPath: acceptance.path, descriptor, acceptance, observedRuntime: observed };
  } catch (error) {
    if (process === undefined && error instanceof ObsidianProcessError && error.code === "obsidian_stop_failed") {
      throw error;
    }
    await client?.close().catch(() => undefined);
    if (process !== undefined) {
      try {
        await process.stop();
        listenerPort ??= (await readPersistedBridgeIdentity(vault.vaultPath,
          options.candidate.identity.pluginId, options.configDirectoryName))?.port;
        if (listenerPort !== undefined) await waitForListenerClosed(listenerPort, options.timeouts.portClosedMs);
      } catch (cleanupError) {
        throw new Error(`Privacy/recovery setup failed; generated Vault retained because process teardown was not confirmed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`, { cause: error });
      }
    }
    try {
      await acceptance?.cleanup();
      const cleanup = await options.cleanupVault(vault);
      if (cleanup.residualPaths.length > 0) throw new Error(`Privacy/recovery setup cleanup left residual paths: ${cleanup.residualPaths.join(", ")}`, { cause: error });
    } catch (cleanupError) {
      throw new Error(`Privacy/recovery setup failed and generated-root cleanup was incomplete: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`, { cause: error });
    }
    throw error;
  }
}

async function observeStatus(runtime: LiveVault): Promise<string> {
  const result = await runtime.client.callTool({
    name: "vault_change_set_status",
    arguments: { submissionKey: "privacy-authority-observation-absent" },
  }) as McpResult;
  if (result.isError === true || result.structuredContent === undefined) throw new Error(`${runtime.label} status observation failed`);
  return digest(parseChangeSetStatusResult(result.structuredContent));
}

async function observeHealth(runtime: LiveVault): Promise<{ digest: string; state: import("@llm-wiki/vault-contracts").HealthResult }> {
  const result = await runtime.client.callTool({ name: "vault_health", arguments: {} }) as McpResult;
  if (result.isError === true || result.structuredContent === undefined) {
    throw new Error(`${runtime.label} health observation failed`);
  }
  const health = parseHealthResult(result.structuredContent);
  if (health.outcome !== "observed" || health.readiness.searchSnapshot !== "ready") throw new Error(`${runtime.label} health is not ready`);
  return { digest: digest(health), state: health };
}

function isExplicitToolRejection(error: unknown, name: string): boolean {
  return error instanceof McpError && error.code === ErrorCode.InvalidParams &&
    error.message.endsWith(`Tool ${name} not found`);
}

async function rejectedAuthorityAttempt(runtime: LiveVault, name: string): Promise<void> {
  let result: McpResult;
  try {
    result = await runtime.client.callTool({ name, arguments: {} }) as McpResult;
  } catch (error) {
    if (isExplicitToolRejection(error, name)) return;
    throw new Error(`${runtime.label} authority request failed without a contract rejection: ${name}`, { cause: error });
  }
  const expected = new McpError(ErrorCode.InvalidParams, `Tool ${name} not found`).message;
  const content = result.content;
  const rejected = Array.isArray(content) && content.some((item: unknown) =>
    typeof item === "object" && item !== null && "type" in item && item.type === "text" &&
    "text" in item && item.text === expected);
  if (result.isError !== true || result.structuredContent !== undefined || !rejected) {
    throw new Error(`${runtime.label} authority endpoint did not explicitly reject ${name}`);
  }
}

async function stopAndClean(options: RunnerOptions, runtimes: readonly LiveVault[]): Promise<void> {
  let failure: unknown;
  for (const runtime of [...runtimes].reverse()) {
    try { await runtime.client.close(); } catch (error) { failure ??= error; }
    try {
      await runtime.process.stop();
      await waitForListenerClosed(runtime.identity.port, options.timeouts.portClosedMs);
    } catch (error) {
      failure ??= error;
      continue;
    }
    try { await runtime.acceptance.cleanup(); } catch (error) { failure ??= error; }
    try {
      const report = await options.cleanupVault(runtime.vault);
      if (report.residualPaths.length > 0) throw new Error("Privacy/recovery cleanup left generated paths");
      options.record("cleanup", `${runtime.label}-generated-vault`, { residualCount: report.residualPaths.length });
    } catch (error) { failure ??= error; }
  }
  if (failure !== undefined) throw failure;
}

/** Proves only the installed Agent authority boundary; local diagnostics and recovery transitions remain human-required. */
export const runInstalledPrivacyRecoveryAuthorityCorpus = async (rawOptions: RunnerOptions): Promise<InstalledPrivacyAuthorityBoundarySliceResult> => {
  if (rawOptions.profileName !== rawOptions.profile.name || rawOptions.probe.probeRunning === undefined) {
    throw new Error("Privacy/recovery boundary slice requires a registered profile and running-runtime probe");
  }
  const options: SliceOptions = { ...rawOptions, probe: { ...rawOptions.probe, probeRunning: rawOptions.probe.probeRunning } };
  const runtimes: LiveVault[] = [];
  try {
    for (const label of ["vault-a", "vault-b"] as const) {
      const runtime = await startVault(options, label);
      runtimes.push(runtime);
      options.record("transport", `${label}-installed-runtime-ready`, {
        port: runtime.identity.port,
        vaultIdSha256: digest(runtime.identity.vaultId),
      });
    }
    const authorityNames = [
      "vault_diagnostic_bundle",
      "vault_content_inclusive_diagnostic",
      "vault_accept_trusted_recovery_baseline",
      "vault_resume_writes",
    ];
    const statusBefore = await Promise.all(runtimes.map((runtime) => observeStatus(runtime)));
    const before = await Promise.all(runtimes.map(observeHealth));
    for (const runtime of runtimes) {
        const tools = await runtime.client.listTools();
        const names = tools.tools.map(({ name }) => name).sort();
        const expected = [...PUBLIC_WIRE_TOOL_NAMES].sort();
        if (JSON.stringify(names) !== JSON.stringify(expected)) throw new Error(`${runtime.label} installed Bridge did not expose exactly the six public tools`);
      options.record("transport", `${runtime.label}-six-tool-inventory`, { names });
      options.assertion("transport:six-tool-contract-only");
      for (const name of authorityNames) {
        await rejectedAuthorityAttempt(runtime, name);
        options.record("tool", `${runtime.label}-rejected-${name}`, { rejected: true, disposition: "explicit-contract-rejection" });
      }
    }
    const after = await Promise.all(runtimes.map(observeHealth));
    const statusAfter = await Promise.all(runtimes.map(observeStatus));
    if (before.some((item, index) => item.digest !== after[index]?.digest) ||
        statusBefore.some((item, index) => item !== statusAfter[index])) {
      throw new Error("Rejected Agent authority attempts changed health or Change Set status observations");
    }
    options.record("assertion", "agent-authority-attempts-observations-unchanged", { attempts: authorityNames.length * 2, statusObservations: 2 });
    options.assertion("authority:agent-attempts-rejected-without-observed-health-or-status-change");
    return {
      scope: "two-vault-agent-authority-boundary",
      verdict: "partial",
      candidateBundleSha256: options.candidate.identity.bundleSha256,
      profileName: options.profileName,
      vaultIdsSha256: {
        "vault-a": digest(runtimes[0]!.identity.vaultId),
        "vault-b": digest(runtimes[1]!.identity.vaultId),
      },
      rejectedAuthorityAttempts: authorityNames.length * runtimes.length,
      observedHealthUnchanged: true,
      provenance: runtimes.map((runtime, index) => ({
        label: runtime.label, vaultIdSha256: digest(runtime.identity.vaultId),
        installedMainSha256: runtime.descriptor.installedMainSha256,
        runtime: runtime.observedRuntime,
        beforeHealthSha256: before[index]!.digest, afterHealthSha256: after[index]!.digest,
        beforeUnknownKeyStatusSha256: statusBefore[index]!, afterUnknownKeyStatusSha256: statusAfter[index]!,
      })),
      humanRequired: ["diagnostic-bundles", "recovery-baseline", "resume-writes"],
    };
  } finally {
    if (runtimes.length > 0) await stopAndClean(options, runtimes);
  }
};
