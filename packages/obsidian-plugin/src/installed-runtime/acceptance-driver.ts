import { watch, type FSWatcher } from "node:fs";
import { mkdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname } from "node:path";

import {
  installedRuntimeAcceptanceDescriptorSchema,
  isPathInside,
  loadInstalledRuntimeAcceptanceDescriptor,
  semanticEvidenceScenarioReportPath,
  type InstalledRuntimeAcceptanceDescriptor,
} from "./acceptance-driver-protocol.js";

export interface InstalledRuntimeAcceptanceActivation {
  readonly descriptor: InstalledRuntimeAcceptanceDescriptor;
  dispose(): void;
}

export interface InstalledRuntimeAcceptanceDriverOptions {
  readonly vaultPath: string;
  readonly pluginId: string;
  readonly configDirectoryName?: string;
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
  if (!isPathInside(await realpath(dirname(loaded.descriptor.vaultPath)),
      await realpath(loaded.descriptor.reportDirectory))) {
    throw new Error("Installed acceptance report root must stay inside the real run workspace");
  }
  let watcher: FSWatcher | undefined;
  let disposed = false;
  let lastSequence = loaded.descriptor.command.sequence;
  let commandTail: Promise<void> = Promise.resolve();
  const executeSemanticEvidenceScenario = options.executeSemanticEvidenceScenario;
  if (executeSemanticEvidenceScenario !== undefined) {
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
      const command = parsed.command;
      if (command.sequence <= lastSequence) return;
      if (command.sequence !== lastSequence + 1) {
        throw new Error("Installed acceptance command sequence is not contiguous");
      }
      if (command.action !== "run-semantic-evidence-scenario") return;
      if (command.capabilityToken !== loaded.descriptor.capabilityToken) {
        throw new Error("Installed acceptance command capability changed");
      }
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
        { encoding: "utf8", flag: "wx" },
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
      commandTail = commandTail.then(inspectCommand);
      void commandTail.catch(() => undefined);
    });
  }
  return {
    descriptor: loaded.descriptor,
    dispose() {
      disposed = true;
      watcher?.close();
      watcher = undefined;
    },
  };
}
