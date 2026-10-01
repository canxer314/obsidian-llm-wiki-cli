import { createHash } from "node:crypto";
import { connect } from "node:net";
import { open, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  parseChangeSetStatusResult,
  parseChangeSetSubmitResult,
  parseChangeSetSubmitInput,
} from "@llm-wiki/vault-contracts";

import { createNoteCorpusProfile } from "../corpus/create-note-corpus.js";
import { EXPECTED_VAULT_ID_HEADER } from "../request-policy.js";
import { openRecoveryJournal } from "../recovery-journal.js";
import {
  preflightRuntimeProfile,
  type ObservedRuntimeEnvironment,
  type RegisteredRuntimeProfile,
  type RuntimeEnvironmentProbe,
} from "./runtime-profile.js";
import { ObsidianProcessError, waitForCondition, readPersistedBridgeIdentity } from "./obsidian-process.js";
import { type VerifiedCandidateBundle, installCandidateBundle } from "./candidate-bundle.js";
import { provisionTestVault, cleanupTestVault } from "./test-vault.js";
import type { ObsidianProcessControl, ObsidianProcessHandle } from "./obsidian-process.js";
import { HealthObservationError, type LoopbackMcpClient } from "./loopback-client.js";

import type { PersistedBridgeIdentity } from "./obsidian-process.js";

export interface InstalledCrashRestorationSliceRecord {
  readonly source: "installed-obsidian";
  readonly runId: string;
  readonly vaultId: string;
  readonly candidateBundleSha256: string;
  readonly installedMainSha256: string;
  readonly crashPoint: "after_prepared";
  readonly processStoppedBeforeRestart: true;
  readonly preparedJournalPhase: "PREPARED";
  readonly journalPhase: "ROLLED_BACK";
  readonly proofState: "intent_not_applied";
  readonly originalFileAbsentAfterRecovery: true;
  readonly healthRecoveryState: "none";
  readonly cleanupSucceeded: true;
  readonly verdict: "passed";
}

export interface InstalledCrashRestorationSliceOutcome {
  readonly scope: "single-after-prepared-installed-rollback-slice";
  readonly records: readonly [InstalledCrashRestorationSliceRecord];
  readonly verdict: "passed";
}

export type InstalledCrashRestorationSliceRunner = (options: InstalledCrashRestorationSliceOptions) => Promise<InstalledCrashRestorationSliceOutcome>;

export interface InstalledCrashRestorationSliceOptions {
  readonly runId: string;
  readonly workingDirectory: string;
  readonly reportDirectory: string;
  readonly candidate: VerifiedCandidateBundle;
  readonly processControl: ObsidianProcessControl;
  readonly client: LoopbackMcpClient;
  readonly configDirectoryName?: string;
  readonly timeouts: { readonly startupMs: number; readonly stopMs: number; readonly portClosedMs: number };
  readonly profile: RegisteredRuntimeProfile;
  readonly probe: RuntimeEnvironmentProbe & {
    probeRunning(request: { readonly vaultPath: string; readonly profileDirectory: string }): Promise<ObservedRuntimeEnvironment>;
  };
  readonly prepareAcceptanceDriver: (options: {
    readonly vaultPath: string;
    readonly pluginId: string;
    readonly candidateBundleSha256: string;
    readonly configDirectoryName: string;
  }) => Promise<{
    readonly path: string;
    readonly descriptor: import("./acceptance-driver-protocol.js").InstalledRuntimeAcceptanceDescriptor;
    cleanup(): Promise<void>;
  }>;
  readonly record: (kind: "transport" | "tool" | "assertion" | "cleanup", name: string, detail: unknown) => void;
  readonly assertion: (name: string) => void;
}

const POLL_MS = 25;
const MAX_SLICE_MS = 120_000;

async function loopbackCall<T>(options: {
  endpoint: URL;
  vaultId: string;
  name: string;
  args: Record<string, unknown>;
  parse(value: unknown): T;
  expectedError?: boolean;
}): Promise<T> {
  const client = new Client({ name: "installed-crash-restoration-slice", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(options.endpoint, {
    requestInit: { headers: { [EXPECTED_VAULT_ID_HEADER]: options.vaultId } },
  });
  try {
    await client.connect(transport);
    const result = await client.callTool({ name: options.name, arguments: options.args });
    if ((result.isError === true) !== (options.expectedError === true) || result.structuredContent === undefined) {
      throw new Error(`Installed crash slice ${options.name} call failed`);
    }
    return options.parse(result.structuredContent);
  } finally {
    await client.close().catch(() => undefined);
  }
}

async function waitForIdentity(check: () => Promise<PersistedBridgeIdentity | null>, timeoutMs: number): Promise<PersistedBridgeIdentity> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const identity = await check();
    if (identity !== null) return identity;
    if (Date.now() >= deadline) throw new Error("Installed crash slice Bridge identity is unavailable");
    await new Promise((resolvePromise) => setTimeout(resolvePromise, POLL_MS));
  }
}

export async function runInstalledCrashRestorationSlice(
  options: InstalledCrashRestorationSliceOptions,
): Promise<InstalledCrashRestorationSliceOutcome> {
  const configDirectoryName = options.configDirectoryName ?? ".obsidian";
  const vault = await provisionTestVault({
    workingDirectory: options.workingDirectory,
    runId: `${options.runId}-crash-prepared`,
    configDirectoryName,
  });
  let processHandle: ObsidianProcessHandle | null = null;
  let startupShutdownUnconfirmed = false;
  let identity: { vaultId: string; port: number } | null = null;
  let descriptorPath: string | null = null;
  let acceptanceDriverCleanup: (() => Promise<void>) | null = null;
  let stopped = false;
  let proof: Omit<InstalledCrashRestorationSliceRecord,
    "cleanupSucceeded" | "verdict"> | null = null;
  let failure: unknown;
  try {
    await installCandidateBundle(options.candidate, vault.vaultPath, configDirectoryName);
    const acceptanceDriver = await options.prepareAcceptanceDriver({
      vaultPath: vault.vaultPath,
      pluginId: options.candidate.identity.pluginId,
      candidateBundleSha256: options.candidate.identity.bundleSha256,
      configDirectoryName,
    });
    descriptorPath = acceptanceDriver.path;
    acceptanceDriverCleanup = acceptanceDriver.cleanup;
    const installed = acceptanceDriver.descriptor;
    const reportDirectory = resolve(options.reportDirectory);
    if (installed.reportDirectory !== reportDirectory || installed.runId !== options.runId ||
        installed.candidateBundleSha256 !== options.candidate.identity.bundleSha256) {
      throw new Error("Crash slice acceptance descriptor is not candidate/run bound");
    }
    const startRuntime = async (): Promise<ObsidianProcessHandle> => {
      const started = await options.processControl.start({
        vaultPath: vault.vaultPath,
        profileDirectory: vault.profileDirectory,
      });
      processHandle = started;
      const observed = await options.probe.probeRunning({
        vaultPath: vault.vaultPath,
        profileDirectory: vault.profileDirectory,
      });
      if (preflightRuntimeProfile(options.profile, observed).length > 0) {
        throw new Error("Installed crash slice runtime did not match the registered profile");
      }
      options.record("transport", "crash-runtime-profile-observed", {
        profile: options.profile.name, observed,
      });
      return started;
    };
    const initialHandle = await startRuntime();
    processHandle = initialHandle;
    const observedIdentity = await waitForIdentity(async () => await readPersistedBridgeIdentity(
      vault.vaultPath,
      options.candidate.identity.pluginId,
      configDirectoryName,
    ), options.timeouts.startupMs);
    identity = observedIdentity;
    const endpoint = new URL(`http://127.0.0.1:${identity.port}/mcp`);
    await waitForCondition(async () => {
      const health = await options.client.observeHealth(endpoint, identity!.vaultId);
      return health.health.readiness.searchSnapshot === "ready";
    }, { timeoutMs: options.timeouts.startupMs, intervalMs: POLL_MS });

    const profile = createNoteCorpusProfile();
    const seed = `${options.runId}-after-prepared`;
    const input = profile.buildSubmitInput(seed);
  const parsedInput = parseChangeSetSubmitInput(input);
  options.assertion("crash-after-prepared:verified-candidate-and-generated-vault");

    // This initial request must be acknowledged by the installed private driver.
    await publishCrashCommand({
      descriptorPath,
      descriptor: installed,
      action: "run-crash-restoration-scenario",
      expectedVaultId: identity.vaultId,
      endpoint,
      input: parsedInput,
      crashPoint: "after_prepared",
    });

    const journalPath = join(vault.vaultPath, ".llm-wiki", "recovery-journal.bin");
    const publicPath = join(vault.vaultPath, ...profile.primaryPath.split("/"));

    // The runner needs an authenticated boundary marker emitted after durable PREPARED;
    // without it, observing a journal alone does not prove the injected code has parked.
    const { loadCrashBoundaryReport } = await import("./crash-restoration-protocol.js");
    await waitForCondition(async () => {
      try {
        await loadCrashBoundaryReport({ reportDirectory: options.reportDirectory,
          runId: options.runId, vaultId: identity!.vaultId, candidateBundleSha256: installed.candidateBundleSha256,
          installedMainSha256: installed.installedMainSha256, capabilityToken: installed.capabilityToken,
          endpoint: endpoint.toString(), submissionKey: parsedInput.submissionKey });
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw error;
      }
    }, { timeoutMs: MAX_SLICE_MS, intervalMs: POLL_MS });
    const preCrashStatus = await loopbackCall({ endpoint, vaultId: identity.vaultId,
      name: "vault_change_set_status", args: { submissionKey: parsedInput.submissionKey },
      parse: parseChangeSetStatusResult });
    const preCrashHealth = await options.client.observeHealth(endpoint, identity.vaultId);
    options.record("assertion", "crash-boundary-wire-observed", {
      lookup: preCrashStatus.lookup,
      state: preCrashStatus.lookup === "found" ? preCrashStatus.changeSet.state : null,
      recovery: preCrashHealth.health.recovery.state,
    });
    if (preCrashStatus.lookup !== "found" || preCrashStatus.changeSet.state !== "in_progress" ||
        preCrashHealth.health.recovery.state !== "none") {
      throw new Error("Installed Change Set did not remain in progress at PREPARED boundary");
    }
    const preparedDiskFrame = await readInstalledCrashJournal(journalPath);
    if (preparedDiskFrame.phase !== "PREPARED" ||
        typeof preparedDiskFrame.payload !== "object" || preparedDiskFrame.payload === null ||
        Array.isArray(preparedDiskFrame.payload) || preparedDiskFrame.payload.vaultId !== identity.vaultId ||
        preparedDiskFrame.payload.changeSetId !== preCrashStatus.changeSet.changeSetId ||
        JSON.stringify(preparedDiskFrame.payload.input) !== JSON.stringify(parsedInput)) {
      throw new Error("Crash slice did not observe its bound durable PREPARED frame");
    }
    const beforeFile = await readFile(publicPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (beforeFile !== null) throw new Error("Create-note fixture was already visible before mutation");

    await initialHandle.stop();
    await waitForCondition(async () => !await isPortOpen(identity!.port), {
      timeoutMs: options.timeouts.portClosedMs, intervalMs: POLL_MS,
    });
    processHandle = null;
    stopped = true;
    options.assertion("crash-after-prepared:supervisor-confirmed-process-stop-before-restart");

    const restarted = await startRuntime();
    processHandle = restarted;
    await waitForCondition(async () => {
      try {
        const health = await options.client.observeHealth(endpoint, identity!.vaultId);
        return health.health.readiness.searchSnapshot === "ready" && health.health.recovery.state === "none";
      } catch (error) {
        if (error instanceof HealthObservationError && error.code === "health_unreachable") return false;
        throw error;
      }
    }, { timeoutMs: options.timeouts.startupMs, intervalMs: POLL_MS });
    const recoveredHealth = await options.client.observeHealth(endpoint, identity.vaultId);
    const recoveredStatus = await loopbackCall({ endpoint, vaultId: identity.vaultId,
      name: "vault_change_set_status", args: { submissionKey: parsedInput.submissionKey },
      parse: parseChangeSetStatusResult });
    const recoveredJournal = await readInstalledCrashJournal(journalPath);
    const afterFile = await readFile(publicPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    const createHashHex = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
    const expectedDigest = createHashHex(new TextEncoder().encode(JSON.stringify(input)));
    if (recoveredHealth.health.recovery.state !== "none" ||
        recoveredStatus.lookup !== "found" || recoveredStatus.changeSet.state !== "intent_not_applied" ||
        recoveredJournal.phase !== "ROLLED_BACK" || afterFile !== null ||
        typeof recoveredJournal.payload !== "object" || recoveredJournal.payload === null ||
        Array.isArray(recoveredJournal.payload) || recoveredJournal.payload.vaultId !== identity.vaultId ||
        recoveredJournal.payload.changeSetId !== preCrashStatus.changeSet.changeSetId ||
        recoveredStatus.changeSet.changeSetId !== preCrashStatus.changeSet.changeSetId ||
        JSON.stringify(recoveredJournal.payload.input) !== JSON.stringify(parsedInput)) {
      throw new Error("Installed restart did not recover PREPARED intent as not applied");
    }
    const submitResult = await loopbackCall({ endpoint, vaultId: identity.vaultId,
      name: "vault_change_set_submit", args: input, parse: parseChangeSetSubmitResult, expectedError: true });
    if (submitResult.outcome !== "registered" || submitResult.changeSet.state !== "intent_not_applied") {
      throw new Error("Recovered Bridge did not replay the retained terminal record");
    }
    proof = {
      source: "installed-obsidian",
      runId: options.runId,
      vaultId: identity.vaultId,
      candidateBundleSha256: options.candidate.identity.bundleSha256,
      installedMainSha256: installed.installedMainSha256,
      crashPoint: "after_prepared",
      processStoppedBeforeRestart: stopped,
      preparedJournalPhase: preparedDiskFrame.phase,
      journalPhase: recoveredJournal.phase,
      proofState: "intent_not_applied",
      originalFileAbsentAfterRecovery: true,
      healthRecoveryState: "none",
    };
    options.record("assertion", "installed-crash-after-prepared-proof", {
      ...proof,
      inputSha256: expectedDigest,
      preparedFrameSha256: createHashHex(new TextEncoder().encode(JSON.stringify(preparedDiskFrame))),
      recoveredFrameSha256: createHashHex(new TextEncoder().encode(JSON.stringify(recoveredJournal))),
    });
    options.assertion("crash-after-prepared:recovery-restored-whole-change-set");
  } catch (error) {
    if (error instanceof ObsidianProcessError && error.code === "obsidian_stop_failed") {
      startupShutdownUnconfirmed = true;
    }
    failure = error;
  } finally {
    let stopFailure: unknown;
    try {
      if (processHandle !== null) {
        const stopping = processHandle;
        await stopping.stop();
        await waitForCondition(async () => identity === null || !await isPortOpen(identity.port), {
          timeoutMs: options.timeouts.portClosedMs,
          intervalMs: POLL_MS,
        });
        processHandle = null;
      }
    } catch (error) {
      stopFailure = error;
    }
    if (stopFailure !== undefined || startupShutdownUnconfirmed) {
      throw new ObsidianProcessError("Generated crash-slice shutdown was not confirmed; roots retained", "obsidian_stop_failed");
    }
    await acceptanceDriverCleanup?.();
    const cleanup = await cleanupTestVault(vault);
    if (cleanup.residualPaths.length > 0) throw new Error("Installed crash slice left generated Vault residue");
    options.record("cleanup", "installed-crash-after-prepared-cleanup", { residualPaths: cleanup.residualPaths.length });
    if (failure !== undefined) throw failure;
  }
  if (proof === null) throw new Error("Installed crash slice did not produce a proof record");
  return { scope: "single-after-prepared-installed-rollback-slice",
    records: [{ ...proof, cleanupSucceeded: true, verdict: "passed" }], verdict: "passed" };
}

async function publishCrashCommand(options: {
  descriptorPath: string;
  descriptor: import("./acceptance-driver-protocol.js").InstalledRuntimeAcceptanceDescriptor;
  action: string;
  expectedVaultId: string;
  endpoint: URL;
  input: unknown;
  crashPoint: "after_prepared";
}): Promise<void> {
  const protocol = await import("./crash-restoration-protocol.js");
  await protocol.requestInstalledCrashRestorationScenario({ ...options });
}

export async function readInstalledCrashJournal(path: string) {
  const handle = await open(path, "r");
  try {
    const journal = await openRecoveryJournal(handle);
    const record = await journal.recover();
    if (record === undefined) throw new Error("Installed crash journal has no durable frame");
    return record;
  } finally {
    await handle.close();
  }
}

async function isPortOpen(port: number): Promise<boolean> {
  return await new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port });
    socket.once("connect", () => { socket.destroy(); resolve(true); });
    socket.once("error", () => resolve(false));
  });
}
