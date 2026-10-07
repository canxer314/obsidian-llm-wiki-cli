import { createHash } from "node:crypto";
import { connect } from "node:net";
import { open, readFile, realpath } from "node:fs/promises";
import { openRecoveryJournal } from "../recovery-journal.js";
import { dirname, join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { parseChangeSetStatusResult, parseHealthResult } from "@llm-wiki/vault-contracts";
import { EXPECTED_VAULT_ID_HEADER } from "../request-policy.js";
import { HealthObservationError } from "./loopback-client.js";
import { observeInstalledBlockedGate } from "./installed-blocked-gate-observation.js";
import { observeInstalledBaselinePreconditions, bindInstalledBlockedRecoveryIntent, observeInstalledRecoveryHistory,
  observeInstalledRecoveryTransition, observeInstalledRecoveryContinuation, observeInstalledRecoveryRegistry, recoveryObservationDigest,
  type InstalledBaselinePreconditions, type InstalledBlockedRecoveryIntent } from "./installed-baseline-resume-observation.js";
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
import { cleanupTestVault, provisionTestVault, snapshotInventory, compareInventories, type ProvisionedTestVault } from "./test-vault.js";
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
  readonly baselineResumeEvidence?: {
    readonly runId: string;
    readonly scenarioManifestSha256: string;
    readonly seed: "installed-baseline-resume-v1";
    readonly seedManifestSha256s: Readonly<Record<"vault-a" | "vault-b", string>>;
    readonly inventories: readonly { readonly label: "vault-a" | "vault-b"; readonly beforeSha256: string; readonly afterSha256: string }[];
    readonly orderedObservations: readonly { readonly sequence: number; readonly name: string; readonly detailSha256: string }[];
    readonly cleanup: { readonly confirmed: true; readonly residualCount: 0 };
    readonly verdict: "observed";
  };
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
      reportDirectory: join(dirname(vault.vaultPath), `privacy-local-reports-${options.runId}-${label}`),
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
  if (health.outcome !== "observed") throw new Error(`${runtime.label} health is not observed`);
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
  if (!Number.isSafeInteger(rawOptions.operatorReportTimeoutMs) || rawOptions.operatorReportTimeoutMs < 1) {
    throw new Error("Local Primary Operator report timeout must be a positive integer");
  }
  if (rawOptions.contentConfirmation !== undefined && !/^[a-f0-9]{64}$/u.test(rawOptions.contentConfirmation.expectedSelectionSha256)) {
    throw new Error("Local content selection digest must be SHA-256");
  }
  if (rawOptions.profileName !== rawOptions.profile.name || rawOptions.probe.probeRunning === undefined) {
    throw new Error("Privacy/recovery boundary slice requires a registered profile and running-runtime probe");
  }
  const orderedObservations: { sequence: number; name: string; detailSha256: string }[] = [];
  const options: SliceOptions = { ...rawOptions, probe: { ...rawOptions.probe, probeRunning: rawOptions.probe.probeRunning },
    record: (kind, name, detail) => {
      if (name.startsWith("baseline-") || name.endsWith("local-control-report-required")) orderedObservations.push({ sequence: orderedObservations.length + 1, name, detailSha256: digest(detail) });
      rawOptions.record(kind, name, detail);
    },
  };
  const runtimes: LiveVault[] = [];
  let cleaned = false;
  let baselineResumeEvidence: InstalledPrivacyAuthorityBoundarySliceResult["baselineResumeEvidence"];
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
    const authorityNames = [
      "vault_diagnostic_bundle",
      "vault_content_inclusive_diagnostic",
      "vault_accept_trusted_recovery_baseline",
      "vault_resume_writes",
    ];
    const statusBefore = await Promise.all(runtimes.map((runtime) => observeStatus(runtime)));
    const secondInventoryBefore = options.recoveryControls === true ? await snapshotInventory(runtimes[1]!.vault.vaultPath) : undefined;
    const secondRegistryBefore = options.recoveryControls === true ? recoveryObservationDigest(await observeInstalledRecoveryRegistry({
      vaultPath: runtimes[1]!.vault.vaultPath, vaultId: runtimes[1]!.identity.vaultId })) : undefined;
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
    let terminalProof: { readonly submissionKey: string; readonly statusSha256: string } | undefined;
    let baselinePreconditions: InstalledBaselinePreconditions | undefined;
    let blockedIntent: InstalledBlockedRecoveryIntent | undefined;
    const recoveryObservation = (runtime: LiveVault) => ({ vaultPath: runtime.vault.vaultPath, vaultId: runtime.identity.vaultId,
      session: { callTool: async (name: string, arguments_: Record<string, unknown>) => {
        const result = await runtime.client.callTool({ name, arguments: arguments_ });
        return { isError: result.isError === true, structuredContent: result.structuredContent,
          ...(Array.isArray(result.content) ? { content: result.content } : {}) };
      } } });
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
        if (options.recoveryControls === true) {
          baselinePreconditions = await observeInstalledBaselinePreconditions(recoveryObservation(runtime));
          blockedIntent = await bindInstalledBlockedRecoveryIntent({ ...recoveryObservation(runtime), runId: options.runId });
          const history = await observeInstalledRecoveryHistory({ ...recoveryObservation(runtime), terminal: baselinePreconditions, blocked: blockedIntent });
          options.record("assertion", "baseline-independent-preconditions-and-blocked-history", {
            journalSha256: baselinePreconditions.journalSha256, registrySha256: baselinePreconditions.registrySha256, ...history,
          });
        }
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
      options.record("assertion", `${runtime.label}-standard-local-report-observed`, facts);
    }
    const contentConfirmationObservations: InstalledPrivacyAuthorityBoundarySliceResult["contentConfirmationObservations"][number][] = [];
    if (options.contentConfirmation !== undefined) {
      const affected = runtimes[0]!;
      const unaffected = runtimes[1]!;
      const consumedConfirmationIds: string[] = [];
      for (const outcome of ["cancelled", "copied"] as const) {
        options.record("transport", `vault-a-${outcome}-local-content-report-required`, { label: "vault-a", action: "content-inclusive-diagnostic-copy", expectedSelectionSha256: options.contentConfirmation.expectedSelectionSha256 });
        const report = await waitForNextInstalledLocalContentReport({ descriptor: affected.descriptor, vaultId: affected.identity.vaultId,
          endpoint: affected.endpoint, configDirectoryName: options.configDirectoryName, consumedConfirmationIds,
          expectedSelectionSha256: options.contentConfirmation.expectedSelectionSha256, timeoutMs: options.operatorReportTimeoutMs });
        if (report.outcome !== outcome) throw new Error("Local content confirmations must observe cancellation before a distinct copy");
        consumedConfirmationIds.push(report.confirmationId);
        if ((await observeHealth(unaffected)).digest !== before[1]!.digest || await observeStatus(unaffected) !== statusBefore[1]) {
          throw new Error("Local content confirmation changed Vault B health or status");
        }
        const facts = { confirmationIdSha256: digest(report.confirmationId), outcome: report.outcome,
          ...(outcome === "copied" ? { bundleChecksum: report.bundleChecksum!, bundleVersion: report.bundleVersion!, checksumVerified: true as const } : {}) };
        contentConfirmationObservations.push(facts);
        options.record("assertion", `vault-a-${outcome}-local-content-report-observed`, facts);
      }
    }
    if (options.recoveryControls === true) {
      const affected = runtimes[0]!;
      const unaffected = runtimes[1]!;
      if (terminalProof === undefined || baselinePreconditions === undefined || blockedIntent === undefined) throw new Error("Recovery controls require independent blocked terminal and Journal preconditions");
      const originalTerminal = baselinePreconditions;
      const historicalBlocked = blockedIntent;
      const affectedObservation = recoveryObservation(affected);
      const assertHistory = async () => {
        const facts = await observeInstalledRecoveryHistory({ ...affectedObservation, terminal: originalTerminal, blocked: historicalBlocked });
        options.record("assertion", "baseline-full-terminal-and-blocked-key-history", facts);
      };
      const consumedInvocationIds: string[] = [];
      const recoveryInventories = await Promise.all(runtimes.map(runtime => snapshotInventory(runtime.vault.vaultPath)));
      const secondInventory = secondInventoryBefore!;
      const secondState = secondRegistryBefore!;
      const assertSecondVault = async () => {
        const comparison = compareInventories(secondInventory, await snapshotInventory(unaffected.vault.vaultPath));
        if (comparison.beforeDigest !== comparison.afterDigest) throw new Error("Vault B inventory changed during local recovery");
        if (recoveryObservationDigest(await observeInstalledRecoveryRegistry(recoveryObservation(unaffected))) !== secondState) {
          throw new Error("Vault B registry or recovery progress changed during local recovery");
        }
        if ((await observeHealth(unaffected)).digest !== before[1]!.digest || await observeStatus(unaffected) !== statusBefore[1]) {
          throw new Error("Vault B health or status changed during local recovery");
        }
      };
      const consume = async (runtime: LiveVault, action: "accept-recovery-baseline" | "resume-writes") => {
        options.record("transport", `${runtime.label}-${action}-local-control-report-required`, { label: runtime.label, action });
        const report = await waitForNextInstalledLocalControlReport({ descriptor: runtime.descriptor, vaultId: runtime.identity.vaultId,
          endpoint: runtime.endpoint, configDirectoryName: options.configDirectoryName,
          action, consumedInvocationIds, timeoutMs: options.operatorReportTimeoutMs, observeWhileWaiting: assertSecondVault });
        consumedInvocationIds.push(report.invocationId);
        await assertSecondVault();
        await assertHistory();
        options.record("assertion", `baseline-${runtime.label}-${action}-${report.outcome}-observed`, {
          invocationIdSha256: digest(report.invocationId), outcome: report.outcome,
          beforeDiagnosticSha256: report.before.checksum.canonicalPayload, afterDiagnosticSha256: report.after.checksum.canonicalPayload,
        });
        return report;
      };
      const blockedHealth = (await observeHealth(affected)).digest;
      const invalidResume = await consume(affected, "resume-writes");
      if (invalidResume.outcome !== "rejected" || (await observeHealth(affected)).digest !== blockedHealth) {
        throw new Error("Invalid resume requires an explicit local rejection without live state changes");
      }
      recoveryControlObservations.push({ label: "vault-a", action: "resume-writes", outcome: "rejected",
        invocationIdSha256: digest(invalidResume.invocationId), liveHealthUnchanged: true });
      const rejectedPreconditions = await observeInstalledBaselinePreconditions(affectedObservation);
      if (rejectedPreconditions.journalSha256 !== originalTerminal.journalSha256) throw new Error("Rejected resume changed FAILED Journal bytes");
      options.record("assertion", "baseline-invalid-resume-explicitly-rejected", { invocationIdSha256: digest(invalidResume.invocationId), journalUnchanged: true });
      const report = await consume(unaffected, "accept-recovery-baseline");
      if (report.outcome !== "rejected" || (await observeHealth(unaffected)).digest !== before[1]!.digest ||
          await observeStatus(unaffected) !== statusBefore[1]) throw new Error("Vault B baseline rejection changed live health or status");
      recoveryControlObservations.push({ label: "vault-b", action: "accept-recovery-baseline", outcome: "rejected",
        invocationIdSha256: digest(report.invocationId), liveHealthUnchanged: true });
      await observeInstalledBaselinePreconditions(affectedObservation);
      const accepted = await consume(affected, "accept-recovery-baseline");
      const pausedTransition = await observeInstalledRecoveryTransition({ ...affectedObservation, terminal: originalTerminal, state: "paused" });
      options.record("assertion", "baseline-independent-cleared-journal-paused-progress", pausedTransition);
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
      const writableTransition = await observeInstalledRecoveryTransition({ ...affectedObservation, terminal: originalTerminal, state: "writable" });
      options.record("assertion", "baseline-independent-explicit-resume", writableTransition);
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
      const continuation = await observeInstalledRecoveryContinuation({ ...affectedObservation, blocked: historicalBlocked,
        submissionKey: `${options.runId}-baseline-continuation`, timeoutMs: options.timeouts.startupMs });
      await assertHistory();
      await assertSecondVault();
      options.record("assertion", "baseline-new-key-continuation-and-vault-b-isolation", { ...continuation, secondRegistrySha256: secondState,
        secondInventorySha256: compareInventories(secondInventory, await snapshotInventory(unaffected.vault.vaultPath)).afterDigest });
      options.assertion("recovery:baseline-paused-explicit-resume-history-preserved-new-key-only");
      const inventories = await Promise.all(runtimes.map(async (runtime, index) => {
        const sourceInventory = index === 1 ? secondInventory : recoveryInventories[index]!;
        const compared = compareInventories(sourceInventory, await snapshotInventory(runtime.vault.vaultPath));
        return { label: runtime.label, beforeSha256: compared.beforeDigest, afterSha256: compared.afterDigest };
      }));
      baselineResumeEvidence = { runId: options.runId, seed: "installed-baseline-resume-v1", scenarioManifestSha256: digest({
        corpusId: "installed-baseline-resume-v1", scenarios: ["failed-journal-terminal-preconditions", "blocked-key-binding", "invalid-resume-rejection",
          "invalid-baseline-rejection", "baseline-accept-paused", "independent-resume", "historical-key-replay", "new-key-continuation", "second-vault-isolation", "confirmed-cleanup"],
      }), seedManifestSha256s: { "vault-a": affected.vault.seedManifestSha256, "vault-b": unaffected.vault.seedManifestSha256 },
        inventories, orderedObservations, cleanup: { confirmed: true, residualCount: 0 }, verdict: "observed" };
    }
    cleaned = true;
    await stopAndClean(options, runtimes);
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
      ...(baselineResumeEvidence === undefined ? {} : { baselineResumeEvidence }),
      recoveryControlObservations,
      contentConfirmationObservations,
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
    if (!cleaned && runtimes.length > 0) await stopAndClean(options, runtimes);
  }
};
