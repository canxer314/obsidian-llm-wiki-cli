import { createHash } from "node:crypto";
import { connect } from "node:net";
import { open, readFile, realpath, stat, rm, readdir } from "node:fs/promises";
import { openRecoveryJournal } from "../recovery-journal.js";
import { dirname, join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { parseChangeSetStatusResult, parseHealthResult } from "@llm-wiki/vault-contracts";
import { EXPECTED_VAULT_ID_HEADER } from "../request-policy.js";
import { HealthObservationError } from "./loopback-client.js";
import { observeInstalledBlockedGate } from "./installed-blocked-gate-observation.js";
import { PUBLIC_WIRE_TOOL_NAMES } from "./public-wire-corpus.js";
import { waitForInstalledLocalOperatorReport, waitForNextInstalledLocalControlReport, waitForNextInstalledLocalContentReport } from "./local-operator-report.js";
import { requestInstalledSemanticEvidenceScenario } from "./smoke-command.js";
import { readInstalledCrashJournal } from "./installed-crash-restoration-slice.js";
import { preflightRuntimeProfile } from "./runtime-profile.js";
import { loadInstalledRuntimeAcceptanceDescriptor, semanticEvidenceScenarioReportPath } from "./acceptance-driver-protocol.js";
import { z } from "zod";
import type { InstalledRuntimeAcceptanceDescriptor } from "./acceptance-driver-protocol.js";
import type { ObservedRuntimeEnvironment, RegisteredRuntimeProfile, RuntimeEnvironmentProbe } from "./runtime-profile.js";
import {
  ObsidianProcessError,
  readPersistedBridgeIdentity,
  waitForCondition,
  type ObsidianProcessHandle,
  type PersistedBridgeIdentity,
} from "./obsidian-process.js";
import { cleanupTestVault, provisionTestVault, snapshotInventory, type ProvisionedTestVault } from "./test-vault.js";
import { diagnosticSha256, diagnosticCanonicalJson, prepareInstalledDiagnosticPrivacyFixture, observeInstalledDiagnosticPrivacySources,
  verifyInstalledDiagnosticPrivacyBundle, validateInstalledDiagnosticPrivacyProof, INSTALLED_DIAGNOSTIC_PRIVACY_COVERAGE, DIAGNOSTIC_PRIVATE_MARKER_CATEGORIES,
  type InstalledDiagnosticPrivacyFixture, type InstalledDiagnosticTrustedObservation, type InstalledDiagnosticTrustedContext } from "./installed-diagnostic-privacy.js";
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
  readonly operatorReportTimeoutMs: number;
  readonly recoveryFixture?: "trash_note/restore_evidence_deadline_blocks_writes";
  readonly recoveryControls?: true;
  readonly contentConfirmation?: { readonly expectedSelectionSha256: string };
  /** Strict A33 observation; never invokes a local command or confirmation. */
  readonly diagnosticPrivacy?: true;
  /** Host run composition retains this source separately; it must never be sourced from a submitted public proof. */
  readonly retainDiagnosticObservation?: (context: InstalledDiagnosticTrustedContext) => Promise<void>;
  readonly profileName: string;
  readonly profile: RegisteredRuntimeProfile;
  readonly probe: RuntimeEnvironmentProbe;
  readonly provisionVault: typeof provisionTestVault;
  readonly cleanupVault: typeof cleanupTestVault;
  readonly prepareInstalledRuntimeAcceptanceDriver: (request: {
    readonly vaultPath: string; readonly pluginId: string; readonly candidateBundleSha256: string; readonly configDirectoryName: string;
    readonly reportDirectory: string;
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
  readonly standardDiagnostics: readonly {
    readonly label: "vault-a" | "vault-b";
    readonly checksum: string;
    readonly bundleVersion: "1.0";
    readonly checksumVerified: true;
    readonly redactionVerified: true;
    readonly listenerPort: number;
  }[];
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
  readonly recoveryHandoff: readonly {
    readonly label: "vault-a" | "vault-b";
    readonly journalPhase: "FAILED";
    readonly proofState: "result_unproven";
    readonly recovery: "blocked";
    readonly effectiveGate: "recovery_blocked";
    readonly submissionKeySha256: string;
  }[];
  readonly recoveryControlObservations: readonly {
    readonly label: "vault-a" | "vault-b";
    readonly action: "accept-recovery-baseline" | "resume-writes";
    readonly outcome: "accepted" | "rejected";
    readonly invocationIdSha256: string;
    readonly liveHealthUnchanged?: true;
    readonly liveWriteState?: "paused" | "writable";
    readonly journalCleared?: true;
    readonly terminalStatusUnchanged?: true;
  }[];
  readonly contentConfirmationObservations: readonly {
    readonly confirmationIdSha256: string;
    readonly outcome: "cancelled" | "copied";
    readonly bundleChecksum?: string;
    readonly bundleVersion?: "1.0";
    readonly checksumVerified?: true;
  }[];
  readonly humanRequired: readonly ["diagnostic-bundles", "recovery-baseline", "resume-writes"];
  readonly diagnosticProof?: InstalledDiagnosticPrivacyProof;
}

export interface InstalledDiagnosticPrivacyProof {
  readonly schemaVersion: 1; readonly scope: "installed-diagnostic-privacy-A33"; readonly verdict: "passed";
  readonly runId: string; readonly candidateBundleSha256: string; readonly profileName: string;
  readonly coverage: readonly string[];
  readonly vaults: readonly {
    readonly label: "vault-a" | "vault-b"; readonly vaultIdSha256: string; readonly installedMainSha256: string;
    readonly runtime: ObservedRuntimeEnvironment; readonly seed: string; readonly manifestSha256: string;
    readonly beforeInventorySha256: string; readonly afterInventorySha256: string;
    readonly beforePrivateStateSha256: string; readonly afterPrivateStateSha256: string;
    readonly checksum: string; readonly markerCount: number; readonly markerCategories: readonly string[];
    readonly markerManifestSha256: string; readonly correlatedJournalAliases: number;
  }[];
  readonly confirmations: readonly { readonly outcome: "cancelled" | "copied"; readonly confirmationIdSha256: string;
    readonly selectionSha256: string; readonly copiedTextSha256?: string; readonly bundleChecksum?: string }[];
  readonly wireRejections: number; readonly secondVaultUnchanged: true;
  readonly eventLog: readonly { readonly sequence: number; readonly name: string; readonly detailSha256: string }[];
  readonly cleanup: { readonly verified: true; readonly vaultCount: 2; readonly residualCount: 0 };
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
  readonly privacyFixture?: InstalledDiagnosticPrivacyFixture;
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
      reportDirectory: join(dirname(vault.vaultPath), `privacy-local-reports-${options.runId}-${label}`),
    });
    if (acceptance.descriptor.runId !== options.runId || acceptance.descriptor.vaultPath !== vault.vaultPath ||
        acceptance.descriptor.pluginId !== options.candidate.identity.pluginId ||
        acceptance.descriptor.candidateBundleSha256 !== options.candidate.identity.bundleSha256 ||
        acceptance.descriptor.installedMainSha256 !== options.candidate.identity.files.find(({ path }) => path === "main.js")?.sha256) {
      throw new Error("Installed privacy/recovery descriptor does not match this run and candidate");
    }
    const privacyFixture = options.diagnosticPrivacy === true ? await prepareInstalledDiagnosticPrivacyFixture(vault, options.runId, label) : undefined;
    process = await options.processControl.start({
      vaultPath: vault.vaultPath,
      profileDirectory: vault.profileDirectory,
      ...(privacyFixture === undefined ? {} : { diagnosticPrivacyEnvironment: { ...privacyFixture.environment } }),
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
    if (options.diagnosticPrivacy === true && (await readdir(descriptor.reportDirectory)).length !== 0) throw new Error("Fresh installed diagnostic run requires an empty report root");
    const startedProcess = process;
    if (startedProcess === undefined || client === undefined) throw new Error("Installed privacy/recovery process or transport is unavailable");
    if (descriptor.runId !== options.runId || descriptor.vaultPath !== vault.vaultPath ||
        descriptor.pluginId !== options.candidate.identity.pluginId ||
        descriptor.candidateBundleSha256 !== options.candidate.identity.bundleSha256 ||
        descriptor.installedMainSha256 !== options.candidate.identity.files.find(({ path }) => path === "main.js")?.sha256 ||
        descriptor.reportDirectory !== acceptance.descriptor.reportDirectory) {
      throw new Error("Installed privacy/recovery descriptor does not match this run and candidate");
    }
    return { label, vault, identity: observedIdentity, endpoint, process: startedProcess, client, descriptorPath: acceptance.path, descriptor, acceptance, observedRuntime: observed, ...(privacyFixture === undefined ? {} : { privacyFixture }) };
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

async function observeInventories(runtime: LiveVault, configDirectoryName: string) {
  const entries = await snapshotInventory(runtime.vault.vaultPath);
  const redact = (entry: typeof entries[number]) => ({ pathSha256: diagnosticSha256(entry.path), sha256: entry.sha256, sizeBytes: entry.sizeBytes });
  return { content: entries.filter(entry => !entry.path.startsWith(configDirectoryName + "/") && !entry.path.startsWith(".llm-wiki/")).map(redact),
    privateState: entries.filter(entry => entry.path.startsWith(".llm-wiki/") || entry.path.endsWith("/data.json")).map(redact) };
}

async function privateStateInventorySha256(runtime: LiveVault): Promise<string> {
  return diagnosticSha256(diagnosticCanonicalJson((await observeInventories(runtime, "")).privateState));
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
  if (health.outcome !== "observed") throw new Error(`${runtime.label} health is not observed`);
  return { digest: digest(health), state: health };
}

function isExplicitToolRejection(error: unknown, name: string): boolean {
  return error instanceof McpError && error.code === ErrorCode.InvalidParams &&
    error.message.endsWith(`Tool ${name} not found`);
}

async function rejectedAuthorityAttempt(runtime: LiveVault, name: string, arguments_: Record<string, unknown> = {}): Promise<void> {
  let result: McpResult;
  try {
    result = await runtime.client.callTool({ name, arguments: arguments_ }) as McpResult;
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

async function rejectDetailedHealth(runtime: LiveVault, arguments_: Record<string, unknown>): Promise<void> {
  const result = await runtime.client.callTool({ name: "vault_health", arguments: arguments_ }) as McpResult;
  if (result.isError !== true || result.structuredContent !== undefined || !Array.isArray(result.content) ||
      !result.content.some(item => typeof item === "object" && item !== null && item.type === "text" &&
        typeof item.text === "string" && item.text.includes("unrecognized_keys"))) {
    throw new Error("Installed detailed/content health was not explicitly rejected by the closed input contract");
  }
}

async function stopAndClean(options: RunnerOptions, runtimes: readonly LiveVault[]): Promise<InstalledDiagnosticTrustedObservation["removedRoots"]> {
  const removedRoots: InstalledDiagnosticTrustedObservation["removedRoots"][number][] = [];
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
    try {
      await runtime.acceptance.cleanup();
      // Report roots were bound to this generated run before start; raw content/capability evidence never survives confirmed teardown.
      await rm(runtime.descriptor.reportDirectory, { recursive: true, force: true });
    } catch (error) { failure ??= error; }
    try {
      const report = await options.cleanupVault(runtime.vault);
      const retained = await Promise.all([runtime.vault.vaultPath, runtime.vault.profileDirectory, runtime.descriptor.reportDirectory].map(async path => {
        try { await stat(path); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
      }));
      if (report.attempted !== true || report.residualPaths.length > 0 || retained.some(Boolean)) throw new Error("Privacy/recovery cleanup left generated paths or was not confirmed");
      removedRoots.push(...(["vault", "profile", "reports"] as const).map((kind, index) => ({ label: runtime.label, kind,
        rootSha256: diagnosticSha256([runtime.vault.vaultPath, runtime.vault.profileDirectory, runtime.descriptor.reportDirectory][index]!) })));
      options.record("cleanup", `${runtime.label}-generated-vault`, { residualCount: report.residualPaths.length });
    } catch (error) { failure ??= error; }
  }
  if (failure !== undefined) throw failure;
  return removedRoots;
}

/** Proves only the installed Agent authority boundary; local diagnostics and recovery transitions remain human-required. */
export const runInstalledPrivacyRecoveryAuthorityCorpus = async (rawOptions: RunnerOptions): Promise<InstalledPrivacyAuthorityBoundarySliceResult> => {
  if (rawOptions.diagnosticPrivacy === true && rawOptions.retainDiagnosticObservation === undefined) throw new Error("Installed diagnostic composable proof requires external source retention");
  if (!Number.isSafeInteger(rawOptions.operatorReportTimeoutMs) || rawOptions.operatorReportTimeoutMs < 1) {
    throw new Error("Local Primary Operator report timeout must be a positive integer");
  }
  if (rawOptions.contentConfirmation !== undefined && !/^[a-f0-9]{64}$/u.test(rawOptions.contentConfirmation.expectedSelectionSha256)) {
    throw new Error("Local content selection digest must be SHA-256");
  }
  if (rawOptions.profileName !== rawOptions.profile.name || rawOptions.probe.probeRunning === undefined) {
    throw new Error("Privacy/recovery boundary slice requires a registered profile and running-runtime probe");
  }
  const proofEvents: { sequence: number; name: string; detailSha256: string }[] = [];
  const options: SliceOptions = { ...rawOptions,
    ...(rawOptions.diagnosticPrivacy === true ? { recoveryFixture: "trash_note/restore_evidence_deadline_blocks_writes" as const } : {}),
    record: (kind, name, detail) => { proofEvents.push({ sequence: proofEvents.length + 1, name, detailSha256: diagnosticSha256(diagnosticCanonicalJson(detail)) }); rawOptions.record(kind, name, detail); },
    probe: { ...rawOptions.probe, probeRunning: rawOptions.probe.probeRunning } };
  const runtimes: LiveVault[] = [];
  let cleaned = false;
  try {
    for (const label of ["vault-a", "vault-b"] as const) {
      const runtime = await startVault(options, label);
      runtimes.push(runtime);
      options.record("transport", `${label}-installed-runtime-ready`, {
        port: runtime.identity.port,
        vaultIdSha256: digest(runtime.identity.vaultId),
      });
    }
    if (await realpath(runtimes[0]!.descriptor.reportDirectory) === await realpath(runtimes[1]!.descriptor.reportDirectory)) {
      throw new Error("Each privacy Vault requires an independent report root");
    }
    const diagnosticVaults: InstalledDiagnosticPrivacyProof["vaults"][number][] = [];
    const diagnosticConfirmations: InstalledDiagnosticPrivacyProof["confirmations"][number][] = [];
    let journalPayload: unknown;
    const observedVaults: InstalledDiagnosticTrustedObservation["vaults"][number][] = [];
    const inventorySources = await Promise.all(runtimes.map(runtime => observeInventories(runtime, options.configDirectoryName)));
    const contentInventories = inventorySources.map(inventory => diagnosticSha256(diagnosticCanonicalJson(inventory.content)));
    const privateInventories = await Promise.all(runtimes.map(privateStateInventorySha256));
    const authorityNames = [
      "vault_diagnostic_bundle",
      "vault_content_inclusive_diagnostic",
      "vault_accept_trusted_recovery_baseline",
      "vault_resume_writes",
      ...(options.diagnosticPrivacy === true ? ["vault_download_diagnostic", "vault_download_diagnostic_bundle"] : []),
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
      if (options.diagnosticPrivacy === true) {
        for (const arguments_ of [{ detail: "diagnostic" }, { contentInclusive: true }]) await rejectDetailedHealth(runtime, arguments_);
        options.record("tool", `${runtime.label}-closed-health-input-modes-rejected`, { rejectedModes: 2 });
      }
    }
    const after = await Promise.all(runtimes.map(observeHealth));
    const statusAfter = await Promise.all(runtimes.map(observeStatus));
    if (before.some((item, index) => item.digest !== after[index]?.digest) ||
        statusBefore.some((item, index) => item !== statusAfter[index])) {
      throw new Error("Rejected Agent authority attempts changed health or Change Set status observations");
    }
    if (options.diagnosticPrivacy === true && (await Promise.all(runtimes.map(privateStateInventorySha256))).some((value, index) => value !== privateInventories[index])) {
      throw new Error("Rejected wire authority attempts changed private state");
    }
    options.record("assertion", "agent-authority-attempts-observations-unchanged", { attempts: authorityNames.length * 2, statusObservations: 2 });
    options.assertion("authority:agent-attempts-rejected-without-observed-health-or-status-change");
    let terminalProof: { readonly submissionKey: string; readonly statusSha256: string } | undefined;
    const recoveryControlObservations: InstalledPrivacyAuthorityBoundarySliceResult["recoveryControlObservations"][number][] = [];
    const recoveryHandoff: InstalledPrivacyAuthorityBoundarySliceResult["recoveryHandoff"][number][] = [];
    const standardDiagnostics: InstalledPrivacyAuthorityBoundarySliceResult["standardDiagnostics"][number][] = [];
    for (const runtime of runtimes) {
      if (options.recoveryFixture !== undefined && runtime.label === "vault-a") {
        await requestInstalledSemanticEvidenceScenario({ descriptorPath: runtime.descriptorPath, descriptor: runtime.descriptor,
          scenario: options.recoveryFixture, expectedVaultId: runtime.identity.vaultId, endpoint: runtime.endpoint });
        const reportPath = semanticEvidenceScenarioReportPath(runtime.descriptor.reportDirectory, options.recoveryFixture);
        await waitForCondition(async () => {
          const text = await readFile(reportPath, "utf8").catch((error: NodeJS.ErrnoException) => {
            if (error.code === "ENOENT") return null;
            throw error;
          });
          if (text === null) return false;
          const completed = z.object({ schemaVersion: z.literal(1), runId: z.string(), vaultId: z.string(), endpoint: z.string(),
            scenario: z.string(), candidateBundleSha256: z.string(), installedMainSha256: z.string(), capabilityToken: z.string(),
            summary: z.object({ scenario: z.string(), proofState: z.literal("result_unproven"), statusProofState: z.literal("result_unproven"),
              journalPhase: z.literal("FAILED"), writesBlocked: z.literal(true), cleanupSucceeded: z.literal(true) }).passthrough(),
          }).strict().parse(JSON.parse(text));
          if (completed.runId !== runtime.descriptor.runId || completed.vaultId !== runtime.identity.vaultId ||
              completed.endpoint !== runtime.endpoint.toString() || completed.scenario !== options.recoveryFixture ||
              completed.summary.scenario !== options.recoveryFixture || completed.capabilityToken !== runtime.descriptor.capabilityToken ||
              completed.candidateBundleSha256 !== runtime.descriptor.candidateBundleSha256 || completed.installedMainSha256 !== runtime.descriptor.installedMainSha256) {
            throw new Error("Blocked fixture completion report identity does not match");
          }
          return true;
        }, { timeoutMs: options.operatorReportTimeoutMs });
        await waitForCondition(async () => {
          const health = (await observeHealth(runtime)).state;
          return health.outcome === "observed" && health.recovery.state === "blocked" && health.effectiveGate?.code === "recovery_blocked";
        }, { timeoutMs: options.operatorReportTimeoutMs });
        const frame = await readInstalledCrashJournal(join(runtime.vault.vaultPath, ".llm-wiki", "recovery-journal.bin"));
        if (frame.phase !== "FAILED" || typeof frame.payload !== "object" || frame.payload === null || Array.isArray(frame.payload) ||
            frame.payload.vaultId !== runtime.identity.vaultId || typeof frame.payload.input !== "object" ||
            frame.payload.input === null || Array.isArray(frame.payload.input) || typeof frame.payload.input.submissionKey !== "string") {
          throw new Error("Recovery handoff requires a real Vault-bound durable FAILED journal");
        }
        journalPayload = frame.payload;
        const submissionKey = frame.payload.input.submissionKey;
        const result = await runtime.client.callTool({ name: "vault_change_set_status", arguments: { submissionKey } });
        if (result.isError === true) throw new Error("Recovery fixture status observation failed");
        const status = parseChangeSetStatusResult(result.structuredContent);
        if (status.lookup !== "found" || status.changeSet.changeSetId !== frame.payload.changeSetId ||
            status.changeSet.state !== "result_unproven") {
          throw new Error("Recovery handoff requires terminal result_unproven status");
        }
        const blockedGate = await observeInstalledBlockedGate({
          session: { callTool: async (name, arguments_) => {
            const response = await runtime.client.callTool({ name, arguments: arguments_ });
            return { isError: response.isError === true, structuredContent: response.structuredContent,
              ...(Array.isArray(response.content) ? { content: response.content } : {}) };
          } },
          vaultIdSha256: createHash("sha256").update(runtime.identity.vaultId).digest("hex"),
          knownSubmissionKey: submissionKey,
        });
        options.record("assertion", `${runtime.label}-recovery-blocked-gate-row-observed`, blockedGate);
        for (const assertion of blockedGate.assertions) options.assertion(assertion);
        terminalProof = { submissionKey, statusSha256: digest(status.changeSet) };
        recoveryHandoff.push({ label: runtime.label, journalPhase: "FAILED", proofState: "result_unproven",
          recovery: "blocked", effectiveGate: "recovery_blocked", submissionKeySha256: digest(submissionKey) });
      }
      if (options.recoveryFixture !== undefined && runtime.label === "vault-b") {
        const health = await observeHealth(runtime);
        if (health.digest !== before[1]!.digest || await observeStatus(runtime) !== statusBefore[1]) {
          throw new Error("Vault A recovery fixture changed Vault B health or status observations");
        }
      }
      options.record("transport", `${runtime.label}-standard-local-report-required`, { action: "standard-diagnostic-copy" });
      const report = await waitForInstalledLocalOperatorReport({ descriptor: runtime.descriptor, vaultId: runtime.identity.vaultId,
        endpoint: runtime.endpoint, configDirectoryName: options.configDirectoryName,
        action: "standard-diagnostic-copy", timeoutMs: options.operatorReportTimeoutMs });
      if (report.action !== "standard-diagnostic-copy") throw new Error("Expected the standard local diagnostic report");
      if (options.recoveryFixture !== undefined && runtime.label === "vault-a" && (report.bundle.health.recovery !== "blocked" ||
          report.bundle.health.effectiveGate !== "recovery_blocked" || report.bundle.journal.availability !== "available" ||
          !report.bundle.journal.frames.some(frame => frame.state === "valid" && frame.phase === "FAILED"))) {
        throw new Error("Standard report does not preserve the real blocked recovery fixture");
      }
      if (options.diagnosticPrivacy === true) {
        if (report.diagnosticPrivacySources === undefined) throw new Error("Installed diagnostic process environment source was not observed");
        if (runtime.privacyFixture === undefined || journalPayload === undefined) throw new Error("Installed diagnostic source fixture is unavailable");
        // The FAILED journal belongs to A; B's standard bundle is also scanned against every observed private category.
        const markers = await observeInstalledDiagnosticPrivacySources({ fixture: runtime.privacyFixture, vault: runtime.vault,
          journalPayload, vaultId: runtimes[0]!.identity.vaultId, capabilityToken: runtime.descriptor.capabilityToken,
          environment: report.diagnosticPrivacySources.environment, username: report.diagnosticPrivacySources.username });
        const journalSequence = (journalPayload as { enqueueSeq?: unknown }).enqueueSeq;
        if (runtime.label === "vault-a" && (!Number.isSafeInteger(journalSequence) || (journalSequence as number) < 1)) throw new Error("Installed journal FIFO correlation source is missing");
        const verified = verifyInstalledDiagnosticPrivacyBundle(report.bundle, [...markers, { category: "raw-id", value: runtime.identity.vaultId }],
          runtime.label === "vault-a" ? { journalEnqueueSeq: journalSequence as number, journalPhase: "FAILED" } : undefined);
        if (verified.markerCategories.length !== DIAGNOSTIC_PRIVATE_MARKER_CATEGORIES.length ||
            (runtime.label === "vault-a" && verified.correlatedJournalAliases < 1)) throw new Error("Installed diagnostic marker coverage or alias correlation is incomplete");
        const index = runtime.label === "vault-a" ? 0 : 1;
        const afterInventory = await observeInventories(runtime, options.configDirectoryName);
        const inventory = diagnosticSha256(diagnosticCanonicalJson(afterInventory.content));
        const sourceMarkers = [...markers, { category: "raw-id" as const, value: runtime.identity.vaultId }].map(marker => ({ category: marker.category, sha256: diagnosticSha256(marker.value), length: marker.value.length }));
        observedVaults.push({ label: runtime.label, vaultIdSha256: diagnosticSha256(runtime.identity.vaultId), runtime: runtime.observedRuntime,
          seed: runtime.privacyFixture.seed, files: runtime.privacyFixture.files.map(file => ({ path: file.path, contentSha256: diagnosticSha256(file.content) })),
          standardBundle: structuredClone(report.bundle), markers: sourceMarkers, ...(index === 0 ? { journalEnqueueSeq: journalSequence as number } : {}),
          beforeInventory: inventorySources[index]!.content, afterInventory: afterInventory.content,
          beforePrivateState: inventorySources[index]!.privateState, afterPrivateState: afterInventory.privateState });
        diagnosticVaults.push({ label: runtime.label, vaultIdSha256: diagnosticSha256(runtime.identity.vaultId),
          installedMainSha256: runtime.descriptor.installedMainSha256, runtime: runtime.observedRuntime,
          seed: runtime.privacyFixture.seed, manifestSha256: runtime.privacyFixture.manifestSha256,
          beforeInventorySha256: contentInventories[runtime.label === "vault-a" ? 0 : 1]!, afterInventorySha256: inventory,
          beforePrivateStateSha256: privateInventories[runtime.label === "vault-a" ? 0 : 1]!, afterPrivateStateSha256: await privateStateInventorySha256(runtime),
          ...verified, markerManifestSha256: diagnosticSha256(diagnosticCanonicalJson(sourceMarkers)) });
      }
      const serialized = JSON.stringify(report.bundle);
      for (const marker of [runtime.identity.vaultId, runtime.vault.vaultPath, runtime.vault.profileDirectory, runtime.descriptor.capabilityToken]) {
        if (serialized.includes(marker) || serialized.includes(JSON.stringify(marker).slice(1, -1))) {
          throw new Error("Standard local diagnostic contains private runtime identity");
        }
      }
      const facts = { label: runtime.label, checksum: report.bundle.checksum.canonicalPayload,
        bundleVersion: report.bundle.bundleVersion, checksumVerified: true as const, redactionVerified: true as const,
        listenerPort: runtime.identity.port };
      standardDiagnostics.push(facts);
      options.record("assertion", `${runtime.label}-standard-local-report-observed`, options.diagnosticPrivacy === true ? diagnosticVaults.at(-1)! : facts);
    }
    const contentConfirmationObservations: InstalledPrivacyAuthorityBoundarySliceResult["contentConfirmationObservations"][number][] = [];
    const expectedSelectionSha256 = options.diagnosticPrivacy === true ? runtimes[0]!.privacyFixture!.expectedSelectionSha256 : options.contentConfirmation?.expectedSelectionSha256;
    if (expectedSelectionSha256 !== undefined) {
      const affected = runtimes[0]!;
      const unaffected = runtimes[1]!;
      const consumedConfirmationIds: string[] = [];
      for (const outcome of ["cancelled", "copied"] as const) {
        if (options.diagnosticPrivacy === true) {
          const existing = (await readdir(affected.descriptor.reportDirectory)).filter(filename => filename.startsWith("local-content-inclusive-diagnostic-copy-") && filename.endsWith(".json")).sort();
          const expected = consumedConfirmationIds.map(id => `local-content-inclusive-diagnostic-copy-${diagnosticSha256(id)}.json`).sort();
          if (JSON.stringify(existing) !== JSON.stringify(expected)) throw new Error("Installed diagnostic fresh confirmation window contains unconsumed prior evidence");
        }
        options.record("transport", `vault-a-${outcome}-local-content-report-required`, { label: "vault-a", action: "content-inclusive-diagnostic-copy", expectedSelectionSha256 });
        const report = await waitForNextInstalledLocalContentReport({ descriptor: affected.descriptor, vaultId: affected.identity.vaultId,
          endpoint: affected.endpoint, configDirectoryName: options.configDirectoryName, consumedConfirmationIds,
          expectedSelectionSha256, timeoutMs: options.operatorReportTimeoutMs });
        if (report.outcome !== outcome) throw new Error("Local content confirmations must observe cancellation before a distinct copy");
        if (options.diagnosticPrivacy === true) {
          if (outcome === "copied" && report.copiedTextSha256 === undefined) throw new Error("Installed diagnostic actual copied checksum is missing");
          diagnosticConfirmations.push({ outcome, confirmationIdSha256: diagnosticSha256(report.confirmationId), selectionSha256: report.selectionSha256,
            ...(outcome === "copied" ? { copiedTextSha256: report.copiedTextSha256!, bundleChecksum: report.bundleChecksum! } : {}) });
        }
        consumedConfirmationIds.push(report.confirmationId);
        if ((await observeHealth(unaffected)).digest !== before[1]!.digest || await observeStatus(unaffected) !== statusBefore[1]) {
          throw new Error("Local content confirmation changed Vault B health or status");
        }
        const facts = { confirmationIdSha256: digest(report.confirmationId), outcome: report.outcome,
          ...(outcome === "copied" ? { bundleChecksum: report.bundleChecksum!, bundleVersion: report.bundleVersion!, checksumVerified: true as const } : {}) };
        contentConfirmationObservations.push(facts);
        options.record("assertion", `vault-a-${outcome}-local-content-report-observed`, options.diagnosticPrivacy === true ? diagnosticConfirmations.at(-1)! : facts);
      }
    }
    if (options.recoveryControls === true) {
      const affected = runtimes[0]!;
      const unaffected = runtimes[1]!;
      if (terminalProof === undefined) throw new Error("Recovery controls require the observed blocked terminal proof");
      const consumedInvocationIds: string[] = [];
      const consume = async (runtime: LiveVault, action: "accept-recovery-baseline" | "resume-writes") => {
        options.record("transport", `${runtime.label}-${action}-local-control-report-required`, { label: runtime.label, action });
        const report = await waitForNextInstalledLocalControlReport({ descriptor: runtime.descriptor, vaultId: runtime.identity.vaultId,
          endpoint: runtime.endpoint, configDirectoryName: options.configDirectoryName,
          action, consumedInvocationIds, timeoutMs: options.operatorReportTimeoutMs });
        consumedInvocationIds.push(report.invocationId);
        return report;
      };
      const report = await consume(unaffected, "accept-recovery-baseline");
      if (report.outcome !== "rejected" || (await observeHealth(unaffected)).digest !== before[1]!.digest ||
          await observeStatus(unaffected) !== statusBefore[1]) throw new Error("Vault B baseline rejection changed live health or status");
      recoveryControlObservations.push({ label: "vault-b", action: "accept-recovery-baseline", outcome: "rejected",
        invocationIdSha256: digest(report.invocationId), liveHealthUnchanged: true });
      const accepted = await consume(affected, "accept-recovery-baseline");
      const health = (await observeHealth(affected)).state;
      const handle = await open(join(affected.vault.vaultPath, ".llm-wiki", "recovery-journal.bin"), "r");
      let journalCleared: boolean;
      try { journalCleared = (await (await openRecoveryJournal(handle)).recover()) === undefined; }
      finally { await handle.close(); }
      const status = await affected.client.callTool({ name: "vault_change_set_status", arguments: { submissionKey: terminalProof.submissionKey } });
      const observedStatus = parseChangeSetStatusResult(status.structuredContent);
      if (accepted.outcome !== "accepted" || !journalCleared || health.outcome !== "observed" ||
          health.recovery.state !== "none" || health.write.state !== "paused" || health.effectiveGate?.code !== "writes_paused" ||
          status.isError === true || observedStatus.lookup !== "found" || observedStatus.vault.writeState !== "paused" ||
          observedStatus.vault.writeGate !== health.write.gate || digest(observedStatus.changeSet) !== terminalProof.statusSha256 ||
          (await observeHealth(unaffected)).digest !== before[1]!.digest || await observeStatus(unaffected) !== statusBefore[1]) {
        throw new Error("Accepted baseline lacks cleared journal, live paused recovery, or preserved terminal status and Vault B");
      }
      recoveryControlObservations.push({ label: "vault-a", action: "accept-recovery-baseline", outcome: "accepted",
        invocationIdSha256: digest(accepted.invocationId), liveWriteState: "paused", journalCleared: true, terminalStatusUnchanged: true });
      const resumed = await consume(affected, "resume-writes");
      const resumedHealth = (await observeHealth(affected)).state;
      const resumedResult = await affected.client.callTool({ name: "vault_change_set_status", arguments: { submissionKey: terminalProof.submissionKey } });
      const resumedStatus = parseChangeSetStatusResult(resumedResult.structuredContent);
      if (resumed.outcome !== "accepted" || resumedHealth.outcome !== "observed" || resumedHealth.recovery.state !== "none" ||
          resumedHealth.write.state !== "writable" || resumedHealth.write.gate !== "open" || resumedHealth.write.pauseSource !== null ||
          resumedHealth.effectiveGate !== null || resumedResult.isError === true || resumedStatus.lookup !== "found" ||
          resumedStatus.vault.writeState !== "writable" || resumedStatus.vault.writeGate !== "open" ||
          digest(resumedStatus.changeSet) !== terminalProof.statusSha256 ||
          (await observeHealth(unaffected)).digest !== before[1]!.digest || await observeStatus(unaffected) !== statusBefore[1]) {
        throw new Error("Resume lacks live writable recovery-safe state or preserved terminal status and Vault B");
      }
      recoveryControlObservations.push({ label: "vault-a", action: "resume-writes", outcome: "accepted",
        invocationIdSha256: digest(resumed.invocationId), liveWriteState: "writable", terminalStatusUnchanged: true });
    }
    let diagnosticProof: InstalledDiagnosticPrivacyProof | undefined;
    if (options.diagnosticPrivacy === true) {
      const finalB = diagnosticSha256(diagnosticCanonicalJson((await observeInventories(runtimes[1]!, options.configDirectoryName)).content));
      if (finalB !== contentInventories[1] || await privateStateInventorySha256(runtimes[1]!) !== privateInventories[1] || (await observeHealth(runtimes[1]!)).digest !== before[1]!.digest || await observeStatus(runtimes[1]!) !== statusBefore[1]) {
        throw new Error("Installed diagnostic local actions changed second Vault inventory or state");
      }
      if (diagnosticVaults.length !== 2 || diagnosticConfirmations.length !== 2 ||
          diagnosticConfirmations[0]!.confirmationIdSha256 === diagnosticConfirmations[1]!.confirmationIdSha256) throw new Error("Installed diagnostic proof lacks distinct confirmations or both reports");
      const removedRoots = await stopAndClean(options, runtimes);
      cleaned = true;
      const sourceBinding = { runId: options.runId, candidateBundleSha256: options.candidate.identity.bundleSha256,
        profileName: options.profileName, installedMainSha256: options.candidate.identity.files.find(file => file.path === "main.js")!.sha256 };
      const observation: InstalledDiagnosticTrustedObservation = { binding: sourceBinding, vaults: observedVaults,
        confirmations: structuredClone(diagnosticConfirmations), events: structuredClone(proofEvents), removedRoots };
      const trustedContext: InstalledDiagnosticTrustedContext = { observation, expectedObservationSha256: diagnosticSha256(diagnosticCanonicalJson(observation)) };
      diagnosticProof = { schemaVersion: 1, scope: "installed-diagnostic-privacy-A33", verdict: "passed",
        runId: options.runId, candidateBundleSha256: options.candidate.identity.bundleSha256, profileName: options.profileName,
        coverage: [...INSTALLED_DIAGNOSTIC_PRIVACY_COVERAGE],
        vaults: diagnosticVaults, confirmations: diagnosticConfirmations, wireRejections: (authorityNames.length + 2) * 2,
        secondVaultUnchanged: true, eventLog: proofEvents, cleanup: { verified: true, vaultCount: 2, residualCount: 0 } };
      validateInstalledDiagnosticPrivacyProof(diagnosticProof, sourceBinding, trustedContext);
      await options.retainDiagnosticObservation?.(trustedContext);
      options.assertion("diagnostics:installed-A33-complete");
    }
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
      standardDiagnostics,
      recoveryHandoff,
      recoveryControlObservations,
      contentConfirmationObservations,
      provenance: runtimes.map((runtime, index) => ({
        label: runtime.label, vaultIdSha256: digest(runtime.identity.vaultId),
        installedMainSha256: runtime.descriptor.installedMainSha256,
        runtime: runtime.observedRuntime,
        beforeHealthSha256: before[index]!.digest, afterHealthSha256: after[index]!.digest,
        beforeUnknownKeyStatusSha256: statusBefore[index]!, afterUnknownKeyStatusSha256: statusAfter[index]!,
      })),
      ...(diagnosticProof === undefined ? {} : { diagnosticProof }),
      humanRequired: ["diagnostic-bundles", "recovery-baseline", "resume-writes"],
    };
  } finally {
    if (!cleaned && runtimes.length > 0) await stopAndClean(options, runtimes);
  }
};

/** Standalone A33 runner. Only Primary Operator standard copies and fresh cancel/confirm are observed. */
export async function runInstalledDiagnosticPrivacyAcceptance(options: InstalledPrivacyBoundaryOptions): Promise<InstalledDiagnosticPrivacyProof> {
  if (options.retainDiagnosticObservation === undefined) throw new Error("Installed diagnostic composable proof requires external source retention");
  let trusted: InstalledDiagnosticTrustedContext | undefined;
  const result = await runInstalledPrivacyRecoveryAuthorityCorpus({ ...options, diagnosticPrivacy: true, recoveryControls: undefined,
    retainDiagnosticObservation: async context => { trusted = context; await options.retainDiagnosticObservation?.(context); } });
  if (result.diagnosticProof === undefined) throw new Error("Installed A33 diagnostic proof is missing");
  validateInstalledDiagnosticPrivacyProof(result.diagnosticProof, { runId: options.runId,
    candidateBundleSha256: options.candidate.identity.bundleSha256, profileName: options.profileName, installedMainSha256: options.candidate.identity.files.find(file => file.path === "main.js")!.sha256 }, trusted);
  return result.diagnosticProof;
}
