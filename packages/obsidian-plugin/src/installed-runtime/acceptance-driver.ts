import { watch, type FSWatcher } from "node:fs";
import { verifyStandardDiagnosticBundle, type StandardDiagnosticBundle } from "../diagnostic-bundle.js";
import { verifyContentInclusiveDiagnosticBundle, type ContentInclusiveDiagnosticBundle } from "../content-inclusive-diagnostic-bundle.js";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, realpath, link, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import { parseCrashRestorationCommand } from "./crash-restoration-protocol.js";
import { readPersistedBridgeIdentity } from "./obsidian-process.js";
import {
  installedRuntimeAcceptanceDescriptorSchema,
  isPathInside,
  loadInstalledRuntimeAcceptanceDescriptor,
  semanticEvidenceScenarioReportPath,
  type InstalledRuntimeAcceptanceDescriptor,
} from "./acceptance-driver-protocol.js";

export interface InstalledRuntimeAcceptanceActivation {
  readonly descriptor: InstalledRuntimeAcceptanceDescriptor;
  recordStandardDiagnosticCopy(options: {
    readonly vaultId: string;
    readonly endpoint: URL;
    readonly bundle: unknown;
  }): Promise<void>;
  recordContentInclusiveDiagnosticCopy(options: {
    readonly vaultId: string;
    readonly endpoint: URL;
    readonly confirmationId: string;
    readonly selection: string;
  } & ({ readonly outcome: "cancelled" } | {
    readonly outcome: "copied";
    readonly bundle: ContentInclusiveDiagnosticBundle;
  })): Promise<void>;
  recordLocalWriteControl(options: {
    readonly vaultId: string;
    readonly endpoint: URL;
    readonly invocationId: string;
    readonly action: "pause-writes" | "accept-recovery-baseline" | "resume-writes";
    readonly outcome: "accepted" | "rejected";
    readonly before: StandardDiagnosticBundle;
    readonly after: StandardDiagnosticBundle;
  }): Promise<void>;
  dispose(): void;
}

export interface InstalledRuntimeAcceptanceDriverOptions {
  readonly vaultPath: string;
  readonly pluginId: string;
  readonly configDirectoryName?: string;
  readonly executeCrashRestorationScenario?: (options: {
    readonly descriptor: InstalledRuntimeAcceptanceDescriptor;
    readonly command: import("./crash-restoration-protocol.js").CrashRestorationCommand;
  }) => Promise<{ readonly boundary: "after_prepared"; readonly journalPhase: "PREPARED" }>;
  readonly executeSemanticEvidenceScenario?: (options: {
    readonly descriptor: InstalledRuntimeAcceptanceDescriptor;
    readonly scenario: string;
    readonly expectedVaultId: string;
    readonly endpoint: URL;
  }) => Promise<unknown>;
}

/**
 * Enables plugin-private acceptance control only for an explicitly armed,
 * generated Vault whose installed entry point still matches the descriptor.
 * This activation never registers an MCP tool or route.
 */
export async function activateInstalledRuntimeAcceptanceDriver(
  options: InstalledRuntimeAcceptanceDriverOptions,
): Promise<InstalledRuntimeAcceptanceActivation | null> {
  let loaded: Awaited<ReturnType<typeof loadInstalledRuntimeAcceptanceDescriptor>>;
  try {
    loaded = await loadInstalledRuntimeAcceptanceDescriptor(options);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const reportFacts = await stat(loaded.descriptor.reportDirectory).catch(
    (error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    },
  );
  if (reportFacts === null) {
    await mkdir(loaded.descriptor.reportDirectory, { recursive: true });
  } else if (!reportFacts.isDirectory()) {
    throw new Error("Installed acceptance report root is not a directory");
  }
  const workspaceRealPath = await realpath(dirname(loaded.descriptor.vaultPath));
  const reportRealPath = await realpath(loaded.descriptor.reportDirectory);
  const requireBoundReportRoot = async (): Promise<void> => {
    if (await realpath(loaded.descriptor.reportDirectory) !== reportRealPath ||
        !isPathInside(workspaceRealPath, reportRealPath)) {
      throw new Error("Installed acceptance report root changed or escaped the real run workspace");
    }
  };
  await requireBoundReportRoot();
  let watcher: FSWatcher | undefined;
  let disposed = false;
  let lastSequence = loaded.descriptor.command.sequence;
  let commandTail: Promise<void> = Promise.resolve();
  const executeSemanticEvidenceScenario = options.executeSemanticEvidenceScenario;
  const executeCrashRestorationScenario = options.executeCrashRestorationScenario;
  if (executeSemanticEvidenceScenario !== undefined || executeCrashRestorationScenario !== undefined) {
    const inspectCommand = async (): Promise<void> => {
      if (disposed) return;
      const parsed = installedRuntimeAcceptanceDescriptorSchema.parse(
        JSON.parse(await readFile(loaded.path, "utf8")) as unknown,
      );
      if (
        parsed.runId !== loaded.descriptor.runId ||
        parsed.vaultPath !== loaded.descriptor.vaultPath ||
        parsed.pluginId !== loaded.descriptor.pluginId ||
        parsed.candidateBundleSha256 !==
          loaded.descriptor.candidateBundleSha256 ||
        parsed.installedMainSha256 !== loaded.descriptor.installedMainSha256 ||
        parsed.reportDirectory !== loaded.descriptor.reportDirectory ||
        parsed.capabilityToken !== loaded.descriptor.capabilityToken
      ) {
        throw new Error("Installed acceptance descriptor identity changed");
      }
      await requireBoundReportRoot();
      const command = parsed.command;
      if (command.sequence <= lastSequence) return;
      if (command.sequence !== lastSequence + 1) {
        throw new Error("Installed acceptance command sequence is not contiguous");
      }
      if (command.capabilityToken !== loaded.descriptor.capabilityToken) {
        throw new Error("Installed acceptance command capability changed");
      }
      if (command.action !== "idle") {
        const endpoint = new URL(command.endpoint);
        if (endpoint.protocol !== "http:" || endpoint.hostname !== "127.0.0.1" ||
            endpoint.username !== "" || endpoint.password !== "") {
          throw new Error("Installed acceptance commands require a credential-free loopback endpoint");
        }
      }
      const crashCommand = parseCrashRestorationCommand(command);
      if (crashCommand !== null) {
        if (executeCrashRestorationScenario === undefined) return;
        lastSequence = command.sequence;
        try {
          await executeCrashRestorationScenario({ descriptor: parsed, command: crashCommand });
        } catch {
          // Do not publish a success-shaped marker when the installed execution failed.
        }
        return;
      }
      if (command.action !== "run-semantic-evidence-scenario") return;
      if (executeSemanticEvidenceScenario === undefined) return;
      lastSequence = command.sequence;
      let result: { readonly summary: unknown } | {
        readonly failure: { readonly code: "scenario_execution_failed" };
      };
      try {
        result = { summary: await executeSemanticEvidenceScenario({
          descriptor: parsed,
          scenario: command.scenario,
          expectedVaultId: command.expectedVaultId,
          endpoint: new URL(command.endpoint),
        }) };
      } catch {
        // Error messages may contain Vault content, paths, or credentials.
        result = { failure: { code: "scenario_execution_failed" } };
      }
      const reportPath = semanticEvidenceScenarioReportPath(
        parsed.reportDirectory,
        command.scenario,
      );
      await requireBoundReportRoot();
      await mkdir(dirname(reportPath), { recursive: true });
      const temporaryPath = `${reportPath}.${command.sequence}.next`;
      await writeFile(
        temporaryPath,
        `${JSON.stringify({
          schemaVersion: 1,
          runId: parsed.runId,
          vaultId: command.expectedVaultId,
          endpoint: command.endpoint,
          scenario: command.scenario,
          candidateBundleSha256: parsed.candidateBundleSha256,
          installedMainSha256: parsed.installedMainSha256,
          capabilityToken: parsed.capabilityToken,
          ...result,
        })}\n`,
        { encoding: "utf8", flag: "wx", mode: 0o600 },
      );
      try {
        await rename(temporaryPath, reportPath);
      } catch (error) {
        await rm(temporaryPath, { force: true });
        throw error;
      }
    };
    watcher = watch(dirname(loaded.path), { persistent: false }, (_event, filename) => {
      if (filename !== null && filename.toString() !== basename(loaded.path)) return;
      commandTail = commandTail.then(inspectCommand).catch(() => undefined);
    });
  }
  return {
    descriptor: loaded.descriptor,
    async recordStandardDiagnosticCopy(request) {
      if (!verifyStandardDiagnosticBundle(request.bundle)) {
        throw new Error("Local acceptance requires a valid standard diagnostic bundle");
      }
      if (disposed) throw new Error("Installed acceptance activation is disposed");
      const current = (await loadInstalledRuntimeAcceptanceDescriptor(options)).descriptor;
      if (current.runId !== loaded.descriptor.runId || current.vaultPath !== loaded.descriptor.vaultPath ||
          current.pluginId !== loaded.descriptor.pluginId || current.candidateBundleSha256 !== loaded.descriptor.candidateBundleSha256 ||
          current.installedMainSha256 !== loaded.descriptor.installedMainSha256 ||
          current.reportDirectory !== loaded.descriptor.reportDirectory || current.capabilityToken !== loaded.descriptor.capabilityToken) {
        throw new Error("Installed acceptance descriptor identity changed");
      }
      const endpoint = request.endpoint;
      if (endpoint.protocol !== "http:" || endpoint.hostname !== "127.0.0.1" ||
          endpoint.username !== "" || endpoint.password !== "" || request.vaultId.length === 0) {
        throw new Error("Local diagnostic acceptance requires a Vault-bound loopback endpoint");
      }
      const identity = await readPersistedBridgeIdentity(options.vaultPath, options.pluginId, options.configDirectoryName);
      if (identity === null || identity.vaultId !== request.vaultId ||
          endpoint.toString() !== `http://127.0.0.1:${identity.port}/mcp`) {
        throw new Error("Local diagnostic report does not match the running Vault identity");
      }
      await requireBoundReportRoot();
      const reportPath = join(reportRealPath, "local-standard-diagnostic-copy.json");
      const temporaryPath = `${reportPath}.${randomBytes(16).toString("hex")}.next`;
      await writeFile(temporaryPath, `${JSON.stringify({
        schemaVersion: 1,
        runId: loaded.descriptor.runId,
        candidateBundleSha256: loaded.descriptor.candidateBundleSha256,
        installedMainSha256: loaded.descriptor.installedMainSha256,
        capabilityToken: loaded.descriptor.capabilityToken,
        vaultId: request.vaultId,
        endpoint: endpoint.toString(),
        action: "standard-diagnostic-copy",
        checksumVerified: true,
        bundle: request.bundle,
      })}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
      try {
        await requireBoundReportRoot();
        await link(temporaryPath, reportPath);
      } finally {
        await rm(temporaryPath, { force: true });
      }
    },
    async recordContentInclusiveDiagnosticCopy(request) {
      if (request.outcome === "copied" && (!verifyContentInclusiveDiagnosticBundle(request.bundle) ||
          request.bundle.selection.content !== request.selection)) {
        throw new Error("Local acceptance requires a valid selection-bound content diagnostic bundle");
      }
      if (disposed) throw new Error("Installed acceptance activation is disposed");
      const current = (await loadInstalledRuntimeAcceptanceDescriptor(options)).descriptor;
      if (current.runId !== loaded.descriptor.runId || current.vaultPath !== loaded.descriptor.vaultPath ||
          current.pluginId !== loaded.descriptor.pluginId || current.candidateBundleSha256 !== loaded.descriptor.candidateBundleSha256 ||
          current.installedMainSha256 !== loaded.descriptor.installedMainSha256 ||
          current.reportDirectory !== loaded.descriptor.reportDirectory || current.capabilityToken !== loaded.descriptor.capabilityToken) {
        throw new Error("Installed acceptance descriptor identity changed");
      }
      const identity = await readPersistedBridgeIdentity(options.vaultPath, options.pluginId, options.configDirectoryName);
      if (identity === null || identity.vaultId !== request.vaultId ||
          request.endpoint.toString() !== `http://127.0.0.1:${identity.port}/mcp` ||
          request.confirmationId.length === 0 || request.selection.length === 0) {
        throw new Error("Local content diagnostic report does not match the running Vault identity or confirmation");
      }
      await requireBoundReportRoot();
      const confirmationDigest = createHash("sha256").update(request.confirmationId).digest("hex");
      const reportPath = join(reportRealPath, `local-content-inclusive-diagnostic-copy-${confirmationDigest}.json`);
      const temporaryPath = `${reportPath}.${randomBytes(16).toString("hex")}.next`;
      await writeFile(temporaryPath, `${JSON.stringify({
        schemaVersion: 1, runId: loaded.descriptor.runId,
        candidateBundleSha256: loaded.descriptor.candidateBundleSha256,
        installedMainSha256: loaded.descriptor.installedMainSha256,
        capabilityToken: loaded.descriptor.capabilityToken,
        vaultId: request.vaultId, endpoint: request.endpoint.toString(),
        action: "content-inclusive-diagnostic-copy", confirmationId: request.confirmationId,
        outcome: request.outcome, generated: request.outcome === "copied", copied: request.outcome === "copied",
        ...(request.outcome === "copied" ? {
          checksumVerified: true, bundleChecksum: request.bundle.checksum.canonicalPayload,
          bundleVersion: request.bundle.bundleVersion, versions: request.bundle.trace.versions,
        } : {}),
        selectionSha256: createHash("sha256").update(request.selection).digest("hex"),
      })}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
      try {
        await requireBoundReportRoot();
        await link(temporaryPath, reportPath);
      } finally {
        await rm(temporaryPath, { force: true });
      }
    },
    async recordLocalWriteControl(request) {
      if (!verifyStandardDiagnosticBundle(request.before) || !verifyStandardDiagnosticBundle(request.after)) {
        throw new Error("Local write control requires verified before/after diagnostics");
      }
      if (disposed) throw new Error("Installed acceptance activation is disposed");
      const current = (await loadInstalledRuntimeAcceptanceDescriptor(options)).descriptor;
      if (current.runId !== loaded.descriptor.runId || current.vaultPath !== loaded.descriptor.vaultPath ||
          current.pluginId !== loaded.descriptor.pluginId || current.candidateBundleSha256 !== loaded.descriptor.candidateBundleSha256 ||
          current.installedMainSha256 !== loaded.descriptor.installedMainSha256 ||
          current.reportDirectory !== loaded.descriptor.reportDirectory || current.capabilityToken !== loaded.descriptor.capabilityToken) {
        throw new Error("Installed acceptance descriptor identity changed");
      }
      const identity = await readPersistedBridgeIdentity(options.vaultPath, options.pluginId, options.configDirectoryName);
      if (identity === null || identity.vaultId !== request.vaultId ||
          request.endpoint.toString() !== `http://127.0.0.1:${identity.port}/mcp` || request.invocationId.length === 0) {
        throw new Error("Local write control report does not match the running Vault identity");
      }
      await requireBoundReportRoot();
      const invocationDigest = createHash("sha256").update(request.invocationId).digest("hex");
      const reportPath = join(reportRealPath, `local-write-control-${invocationDigest}.json`);
      const temporaryPath = `${reportPath}.${randomBytes(16).toString("hex")}.next`;
      await writeFile(temporaryPath, `${JSON.stringify({
        schemaVersion: 1, runId: loaded.descriptor.runId,
        candidateBundleSha256: loaded.descriptor.candidateBundleSha256,
        installedMainSha256: loaded.descriptor.installedMainSha256,
        capabilityToken: loaded.descriptor.capabilityToken,
        vaultId: request.vaultId, endpoint: request.endpoint.toString(),
        invocationId: request.invocationId, action: request.action, outcome: request.outcome,
        before: request.before, after: request.after,
      })}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
      try {
        await requireBoundReportRoot();
        await link(temporaryPath, reportPath);
      } finally {
        await rm(temporaryPath, { force: true });
      }
    },
    dispose() {
      disposed = true;
      watcher?.close();
      watcher = undefined;
    },
  };
}
