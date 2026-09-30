import { createHash, randomBytes } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";

import { compareSemanticVersions, parseReleaseTag } from "../release/release-identity.js";
import {
  verifyReleaseBundle,
  type VerifiedReleaseBundle,
} from "../release/verify-release-bundle.js";

import { activateInstalledRuntimeAcceptanceDriver } from "./acceptance-driver.js";
import {
  INSTALLED_RUNTIME_ACCEPTANCE_DESCRIPTOR,
  INSTALLED_RUNTIME_VAULT_DIRECTORY_PREFIX,
  installedRuntimeAcceptanceCommandSchema,
  installedRuntimeAcceptanceDescriptorSchema,
  isPathInside,
  loadInstalledRuntimeAcceptanceDescriptor as loadAcceptanceDescriptor,
  semanticEvidenceScenarioReportPath,
  type InstalledRuntimeAcceptanceDescriptor,
} from "./acceptance-driver-protocol.js";

import {
  semanticEvidenceSearchSnapshotCorpusEvidenceSchema,
  type SemanticEvidenceCorpusEvidence,
} from "./evidence.js";
import type { InstalledRuntimeHarnessOptions } from "./harness.js";
import type {
  InstalledSemanticEvidenceScenarioRunner,
  SemanticEvidenceSearchSnapshotScenarioName,
} from "./semantic-evidence-corpus.js";
import { runInstalledRegisteredReferenceRewriteCorpus } from "./registered-reference-installed-runner.js";
import { MVP_PERF_REF_1 } from "./runtime-profile.js";

export {
  activateInstalledRuntimeAcceptanceDriver,
  INSTALLED_RUNTIME_ACCEPTANCE_DESCRIPTOR,
};

export interface InstalledRuntimeAcceptanceDescriptorOptions {
  readonly runId: string;
  readonly vaultPath: string;
  readonly pluginId: string;
  readonly candidateBundleSha256: string;
  readonly reportDirectory: string;
  readonly configDirectoryName?: string;
  readonly createCapabilityToken?: () => string;
}

/**
 * Arms the private plugin-side acceptance driver for one generated Vault. The
 * descriptor lives beside the installed candidate and binds the run, Vault,
 * installed entry-point bytes, report root, and an unguessable capability.
 */
export async function createInstalledRuntimeAcceptanceDescriptor(
  options: InstalledRuntimeAcceptanceDescriptorOptions,
): Promise<{
  readonly path: string;
  readonly descriptor: InstalledRuntimeAcceptanceDescriptor;
}> {
  const vaultPath = resolve(options.vaultPath);
  if (
    !vaultPath.split(/[\\/]/u).at(-1)?.startsWith(INSTALLED_RUNTIME_VAULT_DIRECTORY_PREFIX)
  ) {
    throw new Error(
      "Installed acceptance can only arm a generated installed-runtime Vault",
    );
  }
  const reportDirectory = resolve(options.reportDirectory);
  if (!isPathInside(resolve(vaultPath, ".."), reportDirectory)) {
    throw new Error("Installed acceptance report root must stay inside the run workspace");
  }
  const configDirectoryName = options.configDirectoryName ?? ".obsidian";
  if (
    configDirectoryName.length === 0 ||
    configDirectoryName.includes("/") ||
    configDirectoryName.includes("\\") ||
    configDirectoryName === "." ||
    configDirectoryName === ".."
  ) {
    throw new Error("Installed acceptance configuration directory is unsafe");
  }
  const pluginDirectory = join(
    vaultPath,
    configDirectoryName,
    "plugins",
    options.pluginId,
  );
  const mainBytes = await readFile(join(pluginDirectory, "main.js"));
  const capabilityToken =
    options.createCapabilityToken?.() ?? randomBytes(32).toString("hex");
  const descriptor = installedRuntimeAcceptanceDescriptorSchema.parse({
    schemaVersion: 1,
    runId: options.runId,
    vaultPath,
    pluginId: options.pluginId,
    candidateBundleSha256: options.candidateBundleSha256,
    installedMainSha256: createHash("sha256").update(mainBytes).digest("hex"),
    reportDirectory,
    capabilityToken,
    command: {
      sequence: 0,
      capabilityToken,
      action: "idle",
    },
  });
  const path = join(pluginDirectory, INSTALLED_RUNTIME_ACCEPTANCE_DESCRIPTOR);
  await writeFile(path, `${JSON.stringify(descriptor)}\n`, { flag: "wx" });
  return { path, descriptor };
}

export async function loadInstalledRuntimeAcceptanceDescriptor(options: {
  readonly vaultPath: string;
  readonly pluginId: string;
  readonly configDirectoryName?: string;
}): Promise<InstalledRuntimeAcceptanceDescriptor> {
  return (await loadAcceptanceDescriptor(options)).descriptor;
}

export async function requestInstalledSemanticEvidenceScenario(options: {
  readonly descriptorPath: string;
  readonly descriptor: InstalledRuntimeAcceptanceDescriptor;
  readonly scenario: SemanticEvidenceSearchSnapshotScenarioName;
  readonly expectedVaultId: string;
  readonly endpoint: URL;
}): Promise<void> {
  if (
    options.endpoint.protocol !== "http:" ||
    options.endpoint.hostname !== "127.0.0.1"
  ) {
    throw new Error("Installed acceptance commands require the loopback endpoint");
  }
  const current = installedRuntimeAcceptanceDescriptorSchema.parse(
    JSON.parse(await readFile(options.descriptorPath, "utf8")) as unknown,
  );
  if (
    current.runId !== options.descriptor.runId ||
    current.vaultPath !== options.descriptor.vaultPath ||
    current.pluginId !== options.descriptor.pluginId ||
    current.candidateBundleSha256 !==
      options.descriptor.candidateBundleSha256 ||
    current.installedMainSha256 !== options.descriptor.installedMainSha256 ||
    current.reportDirectory !== options.descriptor.reportDirectory ||
    current.capabilityToken !== options.descriptor.capabilityToken
  ) {
    throw new Error("Installed acceptance descriptor identity changed before command publication");
  }
  const command = installedRuntimeAcceptanceCommandSchema.parse({
    sequence: current.command.sequence + 1,
    capabilityToken: current.capabilityToken,
    action: "run-semantic-evidence-scenario",
    scenario: options.scenario,
    expectedVaultId: options.expectedVaultId,
    endpoint: options.endpoint.toString(),
  });
  const updated = installedRuntimeAcceptanceDescriptorSchema.parse({
    ...current,
    command,
  });
  await writeFile(options.descriptorPath, `${JSON.stringify(updated)}\n`, "utf8");
}

const semanticScenarioSchema =
  semanticEvidenceSearchSnapshotCorpusEvidenceSchema.shape.scenarios.element;
type SemanticScenarioSummary = SemanticEvidenceCorpusEvidence["scenarios"][number];

const installedScenarioReportIdentitySchema = z
  .object({
    schemaVersion: z.literal(1),
    runId: z.string().min(1),
    vaultId: z.string().min(1),
    endpoint: z.string().url(),
    scenario: z.string().min(1),
  })
  .passthrough();

const installedScenarioReportSchema = z.union([
  installedScenarioReportIdentitySchema.extend({
    candidateBundleSha256: z.string().regex(/^[a-f0-9]{64}$/u),
    installedMainSha256: z.string().regex(/^[a-f0-9]{64}$/u),
    capabilityToken: z.string().regex(/^[a-f0-9]{64}$/u),
    summary: semanticScenarioSchema,
  }).strict(),
  installedScenarioReportIdentitySchema.extend({
    candidateBundleSha256: z.string().regex(/^[a-f0-9]{64}$/u),
    installedMainSha256: z.string().regex(/^[a-f0-9]{64}$/u),
    capabilityToken: z.string().regex(/^[a-f0-9]{64}$/u),
    failure: z.object({ code: z.literal("scenario_execution_failed") }).strict(),
  }).strict(),
]);

export const AUTHORITATIVE_INSTALLED_RUNTIME_RUNNER_NAMES = [
  "prepareInstalledRuntimeAcceptanceDriver",
  "runGateIsolationCorpus",
  "runRegisteredReferenceRewriteCorpus",
  "runPrivacyRecoveryAuthorityCorpus",
  "runReleaseLifecycleCorpus",
  "semanticEvidenceScenarioRunner",
] as const;

type HarnessAuthoritativeInstalledRuntimeRunners = Required<
  Pick<
    InstalledRuntimeHarnessOptions,
    | "runGateIsolationCorpus"
    | "runRegisteredReferenceRewriteCorpus"
    | "runPrivacyRecoveryAuthorityCorpus"
    | "runReleaseLifecycleCorpus"
    | "semanticEvidenceScenarioRunner"
  >
>;

export interface InstalledRuntimeAcceptanceDriverHandle {
  readonly path: string;
  readonly descriptor: InstalledRuntimeAcceptanceDescriptor;
  requestSemanticEvidenceScenario(options: {
    readonly scenario: SemanticEvidenceSearchSnapshotScenarioName;
    readonly expectedVaultId: string;
    readonly endpoint: URL;
  }): Promise<void>;
  cleanup(): Promise<void>;
}

export interface AuthoritativeInstalledRuntimeRunners
  extends HarnessAuthoritativeInstalledRuntimeRunners {
  readonly isolateSemanticEvidenceScenarios: true;
  prepareInstalledRuntimeAcceptanceDriver(options: {
    readonly vaultPath: string;
    readonly pluginId: string;
    readonly candidateBundleSha256: string;
    readonly configDirectoryName?: string;
  }): Promise<InstalledRuntimeAcceptanceDriverHandle>;
}

export interface AuthoritativeInstalledRuntimeRunnerOptions {
  /** Identity shared with the harness and every plugin-side acceptance report. */
  readonly runId?: string;
  /** Private report root populated only by the installed plugin acceptance driver. */
  readonly reportDirectory?: string;
  readonly releaseArguments?: InstalledRuntimeSmokeArguments;
  readonly obsidianVersion?: string;
}

export function authoritativeInstalledRuntimeRunnerNames(): readonly string[] {
  return [...AUTHORITATIVE_INSTALLED_RUNTIME_RUNNER_NAMES];
}

function unavailableRunner(name: string): never {
  throw new Error(
    `${name} requires the installed Obsidian acceptance driver; no in-process or simulated substitute is authoritative`,
  );
}

function scenarioReportPath(
  reportDirectory: string,
  scenario: SemanticEvidenceSearchSnapshotScenarioName,
): string {
  return semanticEvidenceScenarioReportPath(reportDirectory, scenario);
}

async function waitForScenarioReport(reportPath: string): Promise<unknown> {
  const deadline = Date.now() + 10_000;
  while (true) {
    try {
      return JSON.parse(await readFile(reportPath, "utf8")) as unknown;
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code !== "ENOENT" ||
        Date.now() >= deadline
      ) {
        throw error;
      }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
    }
  }
}

function createInstalledSemanticEvidenceScenarioRunner(options: {
  readonly runId?: string;
  readonly reportDirectory?: string;
  readonly binding?: () => InstalledRuntimeAcceptanceDescriptor | undefined;
}): InstalledSemanticEvidenceScenarioRunner {
  return {
    async run(request): Promise<SemanticScenarioSummary> {
      if (options.runId === undefined || options.reportDirectory === undefined) {
        return unavailableRunner("Semantic Evidence corpus");
      }
      const reportPath = scenarioReportPath(options.reportDirectory, request.scenario);
      let parsed: unknown;
      try {
        parsed = await waitForScenarioReport(reportPath);
      } catch (error) {
        throw new Error(
          `Installed Semantic Evidence report is unavailable: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
      const identity = installedScenarioReportIdentitySchema.parse(parsed);
      if (identity.runId !== options.runId) {
        throw new Error("Installed Semantic Evidence report has the wrong run identity");
      }
      if (identity.vaultId !== request.expectedVaultId) {
        throw new Error("Installed Semantic Evidence report has the wrong Managed Vault identity");
      }
      if (identity.endpoint !== request.endpoint.toString()) {
        throw new Error("Installed Semantic Evidence report has the wrong loopback endpoint");
      }
      if (identity.scenario !== request.scenario) {
        throw new Error("Installed Semantic Evidence report has the wrong scenario identity");
      }
      const report = installedScenarioReportSchema.parse(parsed);
      const binding = options.binding?.();
      if (
        binding === undefined ||
        report.candidateBundleSha256 !== binding.candidateBundleSha256 ||
        report.installedMainSha256 !== binding.installedMainSha256 ||
        report.capabilityToken !== binding.capabilityToken
      ) {
        throw new Error("Installed Semantic Evidence report has the wrong candidate binding");
      }
      if ("failure" in report) {
        throw new Error(`Installed Semantic Evidence scenario failed: ${report.failure.code}`);
      }
      if (report.summary.scenario !== request.scenario) {
        throw new Error("Installed Semantic Evidence report has the wrong scenario identity");
      }
      await rm(reportPath, { force: true });
      return report.summary;
    },
  };
}

/**
 * Built-in authoritative composition for the installed smoke command. Missing
 * plugin-side control is a closed failure: these adapters never fall back to
 * the Node corpus simulators or caller-provided modules.
 */
export function createAuthoritativeInstalledRuntimeRunners(
  options: AuthoritativeInstalledRuntimeRunnerOptions = {},
): AuthoritativeInstalledRuntimeRunners {
  let activeDescriptor: InstalledRuntimeAcceptanceDescriptor | undefined;
  return {
    async prepareInstalledRuntimeAcceptanceDriver(request) {
      if (options.runId === undefined || options.reportDirectory === undefined) {
        return unavailableRunner("Installed acceptance driver");
      }
      const created = await createInstalledRuntimeAcceptanceDescriptor({
        ...request,
        runId: options.runId,
        reportDirectory: options.reportDirectory,
      });
      activeDescriptor = created.descriptor;
      return {
        ...created,
        requestSemanticEvidenceScenario: (request) =>
          requestInstalledSemanticEvidenceScenario({
            ...request,
            descriptorPath: created.path,
            descriptor: created.descriptor,
          }),
        cleanup: async () => {
          activeDescriptor = undefined;
          await rm(created.path, { force: true });
        },
      };
    },
    runGateIsolationCorpus: async () => unavailableRunner("Gate-isolation corpus"),
    runRegisteredReferenceRewriteCorpus:
      runInstalledRegisteredReferenceRewriteCorpus,
    runPrivacyRecoveryAuthorityCorpus: async () =>
      unavailableRunner("Privacy/recovery authority corpus"),
    runReleaseLifecycleCorpus: async (request) => {
      await resolveInstalledRuntimePreviousRelease({
        arguments: options.releaseArguments ?? { profile: MVP_PERF_REF_1.name },
        candidateVersion: request.candidate.identity.pluginVersion,
        obsidianVersion: options.obsidianVersion ?? MVP_PERF_REF_1.versions.obsidian,
      });
      return unavailableRunner("Release-lifecycle local Primary Operator control");
    },
    isolateSemanticEvidenceScenarios: true,
    semanticEvidenceScenarioRunner:
      createInstalledSemanticEvidenceScenarioRunner({
        ...options,
        binding: () => activeDescriptor,
      }),
  };
}

export interface InstalledRuntimeSmokeArguments {
  candidate?: string;
  previousRelease?: string;
  previousReleaseTag?: string;
  previousReleaseAttestation?: string;
  registration?: string;
  workdir?: string;
  evidence?: string;
  profile: string;
}

export async function resolveInstalledRuntimePreviousRelease(options: {
  readonly arguments: InstalledRuntimeSmokeArguments;
  readonly candidateVersion: string;
  readonly obsidianVersion: string;
}): Promise<VerifiedReleaseBundle> {
  const args = options.arguments;
  if (args.previousRelease === undefined || args.previousReleaseTag === undefined) {
    throw new Error("Previous release directory and immutable tag are required for lifecycle acceptance");
  }
  const release = await verifyReleaseBundle({
    bundleDirectory: resolve(args.previousRelease),
    expectedTag: args.previousReleaseTag,
    supportedObsidianVersion: options.obsidianVersion,
    ...(args.previousReleaseAttestation === undefined ? {} : {
      attestationPath: resolve(args.previousReleaseAttestation),
    }),
  });
  if (compareSemanticVersions(release.identity.pluginVersion, options.candidateVersion) >= 0) {
    throw new Error("Previous release must be older than the candidate");
  }
  return release;
}

export function parseInstalledRuntimeSmokeArguments(
  argv: readonly string[],
): InstalledRuntimeSmokeArguments {
  const parsed: InstalledRuntimeSmokeArguments = { profile: MVP_PERF_REF_1.name };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (value === undefined || value.length === 0 || value.startsWith("--")) {
      throw new Error(`Argument ${flag ?? ""} requires a value`);
    }
    switch (flag) {
      case "--candidate":
        parsed.candidate = value;
        break;
      case "--previous-release":
        parsed.previousRelease = value;
        break;
      case "--previous-release-tag":
        parsed.previousReleaseTag = value;
        break;
      case "--previous-release-attestation":
        parsed.previousReleaseAttestation = value;
        break;
      case "--registration":
        parsed.registration = value;
        break;
      case "--workdir":
        parsed.workdir = value;
        break;
      case "--evidence":
        parsed.evidence = value;
        break;
      case "--profile":
        parsed.profile = value ?? MVP_PERF_REF_1.name;
        break;
      default:
        throw new Error(`Unknown argument: ${flag ?? ""}`);
    }
    if (flag !== undefined && flag.startsWith("--")) index += 1;
  }
  if ((parsed.previousRelease === undefined) !== (parsed.previousReleaseTag === undefined) ||
      (parsed.previousReleaseAttestation !== undefined && parsed.previousRelease === undefined)) {
    throw new Error("Previous release directory and immutable tag must be supplied together");
  }
  if (parsed.previousReleaseTag !== undefined) parseReleaseTag(parsed.previousReleaseTag);
  return parsed;
}
