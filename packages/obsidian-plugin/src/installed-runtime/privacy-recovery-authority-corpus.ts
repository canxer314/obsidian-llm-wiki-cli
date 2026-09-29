import { createHash } from "node:crypto";

import {
  parseHealthResult,
  serializeCompatibilityText,
} from "@llm-wiki/vault-contracts";

import {
  verifyContentInclusiveDiagnosticBundle,
} from "../content-inclusive-diagnostic-bundle.js";
import { verifyStandardDiagnosticBundle } from "../diagnostic-bundle.js";
import { PUBLIC_WIRE_TOOL_NAMES } from "./public-wire-corpus.js";
export const PRIVACY_RECOVERY_AUTHORITY_CORPUS_ID = "privacy-recovery-authority-proof";

export const PRIVACY_RECOVERY_AUTHORITY_SCENARIO_PLAN = [
  "health/closed-observed-summary",
  "diagnostics/standard-redaction-and-checksum",
  "diagnostics/content-inclusive-local-only",
  "authority/agent-local-actions-rejected",
  "authority/trusted-baseline-journal-preconditions",
  "authority/explicit-resume-after-baseline",
  "isolation/second-vault-unaffected",
  "cleanup/no-residual-private-state",
] as const;

export type PrivacyRecoveryAuthorityScenarioName =
  (typeof PRIVACY_RECOVERY_AUTHORITY_SCENARIO_PLAN)[number];

export class PrivacyRecoveryAuthorityCorpusError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PrivacyRecoveryAuthorityCorpusError";
  }
}

export interface PrivacyRecoveryAuthorityToolResult {
  readonly isError?: boolean;
  readonly structuredContent?: unknown;
  readonly content?: readonly unknown[];
}

export interface PrivacyRecoveryAuthorityMcpSession {
  listTools(): Promise<readonly { readonly name: string }[]>;
  callTool(
    name: string,
    arguments_: Record<string, unknown>,
  ): Promise<PrivacyRecoveryAuthorityToolResult>;
}

export type LocalRecoveryState = "blocked" | "paused" | "writable";

/**
 * The host-only Primary Operator surface. It deliberately is not an MCP tool
 * interface: the corpus calls it only after proving the remote tool inventory.
 */
export interface LocalRecoveryAuthority {
  createStandardDiagnosticBundle(): Promise<unknown>;
  createContentInclusiveDiagnosticBundle(selectedContent: string): Promise<unknown>;
  recoveryState(): Promise<LocalRecoveryState>;
  /** A local-only digest of historical Change Set status records. */
  historicalStatusSha256(): Promise<string>;
  acceptTrustedRecoveryBaseline(): Promise<void>;
  resumeWrites(): Promise<void>;
  cleanup(): Promise<{ readonly residualPaths: readonly string[] }>;
}

export interface PrivacyRecoveryAuthorityVaultSession {
  readonly label: "vault-a" | "vault-b";
  /** Never placed in evidence; only used to derive a stable opaque digest. */
  readonly vaultId: string;
  readonly mcp: PrivacyRecoveryAuthorityMcpSession;
  readonly local: LocalRecoveryAuthority;
  /** Private values that must not be emitted by this Vault's standard bundle. */
  readonly privateMarkers: readonly string[];
}

export interface PrivacyRecoveryAuthorityCorpusOutcome {
  readonly scenarioManifestSha256: string;
  readonly vaultIdSha256s: Readonly<Record<"vault-a" | "vault-b", string>>;
  readonly healthSummarySha256s: Readonly<Record<"vault-a" | "vault-b", string>>;
  readonly standardDiagnosticChecksums: number;
  readonly privateMarkersRejected: number;
  readonly contentInclusiveLocalOnly: boolean;
  readonly rejectedAgentAuthorityAttempts: number;
  readonly agentAuthorityStateMutations: number;
  readonly baselineAcceptanceLocalOnly: boolean;
  readonly journalPreconditionsProven: boolean;
  readonly explicitResumeRequired: boolean;
  readonly secondVaultUnaffected: boolean;
  readonly residualPaths: readonly string[];
  readonly assertions: readonly string[];
}

const encoder = new TextEncoder();

function sha256(value: string): string {
  return createHash("sha256").update(encoder.encode(value)).digest("hex");
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, canonicalize(nested)]),
  );
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function scenarioManifestSha256(): string {
  return sha256(
    canonicalJson({
      corpusId: PRIVACY_RECOVERY_AUTHORITY_CORPUS_ID,
      scenarios: [...PRIVACY_RECOVERY_AUTHORITY_SCENARIO_PLAN],
    }),
  );
}

function exactText(result: PrivacyRecoveryAuthorityToolResult): string {
  const text = result.content?.find(
    (item): item is { readonly type: "text"; readonly text: string } =>
      typeof item === "object" &&
      item !== null &&
      (item as { readonly type?: unknown }).type === "text" &&
      typeof (item as { readonly text?: unknown }).text === "string",
  );
  if (text === undefined) {
    throw new PrivacyRecoveryAuthorityCorpusError("Tool response has no compatibility text");
  }
  return text.text;
}

async function observeClosedHealth(
  session: PrivacyRecoveryAuthorityMcpSession,
  label: string,
): Promise<{ readonly digest: string; readonly state: ReturnType<typeof parseHealthResult> }> {
  const result = await session.callTool("vault_health", {});
  if (result.isError === true || result.structuredContent === undefined) {
    throw new PrivacyRecoveryAuthorityCorpusError(`${label} could not observe vault_health`);
  }
  const health = parseHealthResult(result.structuredContent);
  if (health.outcome !== "observed") {
    throw new PrivacyRecoveryAuthorityCorpusError(`${label} returned incompatible vault_health`);
  }
  if (exactText(result) !== serializeCompatibilityText(health)) {
    throw new PrivacyRecoveryAuthorityCorpusError(
      `${label} vault_health compatibility text diverged from structured content`,
    );
  }
  return { digest: sha256(canonicalJson(health)), state: health };
}

async function assertSixTools(session: PrivacyRecoveryAuthorityMcpSession, label: string): Promise<void> {
  const actual = (await session.listTools()).map(({ name }) => name).sort();
  const expected = [...PUBLIC_WIRE_TOOL_NAMES].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new PrivacyRecoveryAuthorityCorpusError(
      `${label} exposed a capability outside the six-tool MCP contract`,
    );
  }
}

async function rejectedMcpInvocation(
  session: PrivacyRecoveryAuthorityMcpSession,
  name: string,
  arguments_: Record<string, unknown> = {},
): Promise<boolean> {
  try {
    const result = await session.callTool(name, arguments_);
    return result.isError === true;
  } catch {
    return true;
  }
}

async function rejectedLocalBaselineAcceptance(
  authority: LocalRecoveryAuthority,
): Promise<boolean> {
  try {
    await authority.acceptTrustedRecoveryBaseline();
    return false;
  } catch {
    return true;
  }
}

function validateStandardDiagnostic(
  bundle: unknown,
  privateMarkers: readonly string[],
  label: string,
): void {
  if (!verifyStandardDiagnosticBundle(bundle)) {
    throw new PrivacyRecoveryAuthorityCorpusError(`${label} standard diagnostic bundle failed checksum validation`);
  }
  const serialized = canonicalJson(bundle);
  for (const marker of privateMarkers) {
    if (marker.length === 0) continue;
    const escapedMarker = JSON.stringify(marker).slice(1, -1);
    if (serialized.includes(marker) || serialized.includes(escapedMarker)) {
      throw new PrivacyRecoveryAuthorityCorpusError(`${label} standard diagnostic bundle leaked a private marker`);
    }
  }
  const aliases = [...serialized.matchAll(/(?:vault|change_set)_[a-f0-9]{32}/gu)].map(
    ([alias]) => alias,
  );
  if (aliases.length === 0 || aliases.some((alias) => privateMarkers.includes(alias))) {
    throw new PrivacyRecoveryAuthorityCorpusError(
      `${label} standard diagnostic bundle did not contain opaque correlation aliases`,
    );
  }
}

/**
 * Drives the privacy and recovery-authority acceptance program. All remote
 * activity is constrained to the existing six MCP tools; authority calls are
 * deliberately made only through the supplied local Primary Operator surface.
 */
export async function runPrivacyRecoveryAuthorityCorpus(options: {
  readonly vaultA: PrivacyRecoveryAuthorityVaultSession;
  readonly vaultB: PrivacyRecoveryAuthorityVaultSession;
  readonly record: (
    kind: "transport" | "tool" | "assertion" | "cleanup",
    name: string,
    detail: unknown,
  ) => void;
  readonly assertion: (name: string) => void;
}): Promise<PrivacyRecoveryAuthorityCorpusOutcome> {
  const { vaultA, vaultB } = options;
  const assertions: string[] = [];
  const assertion = (name: string): void => {
    assertions.push(name);
    options.assertion(name);
  };

  await Promise.all([assertSixTools(vaultA.mcp, "vault-a"), assertSixTools(vaultB.mcp, "vault-b")]);
  options.record("transport", "six-tool-contract", { vaults: 2, tools: PUBLIC_WIRE_TOOL_NAMES.length });
  assertion("transport:six-tool-contract-only");

  const [healthA, healthB] = await Promise.all([
    observeClosedHealth(vaultA.mcp, "vault-a"),
    observeClosedHealth(vaultB.mcp, "vault-b"),
  ]);
  const healthModesRejected = await Promise.all([
    rejectedMcpInvocation(vaultA.mcp, "vault_health", { detail: "diagnostic" }),
    rejectedMcpInvocation(vaultB.mcp, "vault_health", { contentInclusive: true }),
  ]);
  if (!healthModesRejected.every(Boolean)) {
    throw new PrivacyRecoveryAuthorityCorpusError(
      "An Agent Session requested a content-inclusive or detailed vault_health mode",
    );
  }
  options.record("tool", "vault_health", { vaults: 2, closed: true, rejectedModes: 2 });
  assertion("health:closed-observed-summary-only");
  assertion("health:detail-and-content-modes-rejected");

  const [standardA, standardB] = await Promise.all([
    vaultA.local.createStandardDiagnosticBundle(),
    vaultB.local.createStandardDiagnosticBundle(),
  ]);
  validateStandardDiagnostic(standardA, vaultA.privateMarkers, "vault-a");
  validateStandardDiagnostic(standardB, vaultB.privateMarkers, "vault-b");
  options.record("assertion", "standard-diagnostic-redaction", {
    bundles: 2,
    privateMarkers: vaultA.privateMarkers.length + vaultB.privateMarkers.length,
    checksums: 2,
  });
  assertion("diagnostics:standard-redaction-aliases-and-checksums");

  const selectedContent = "private-content-inclusive-selection";
  const contentInclusive = await vaultA.local.createContentInclusiveDiagnosticBundle(selectedContent);
  if (!verifyContentInclusiveDiagnosticBundle(contentInclusive)) {
    throw new PrivacyRecoveryAuthorityCorpusError("Local content-inclusive diagnostic bundle failed validation");
  }
  if (canonicalJson(contentInclusive).includes(selectedContent) !== true) {
    throw new PrivacyRecoveryAuthorityCorpusError("Local content-inclusive diagnostic lost its explicit selection");
  }
  const beforeAgentAttempts = await vaultA.local.recoveryState();
  const historicalStatusBefore = await vaultA.local.historicalStatusSha256();
  const authorityToolNames = [
    "vault_diagnostic_bundle",
    "vault_content_inclusive_diagnostic",
    "vault_accept_trusted_recovery_baseline",
    "vault_resume_writes",
  ];
  const rejected = await Promise.all(
    authorityToolNames.map((name) => rejectedMcpInvocation(vaultA.mcp, name)),
  );
  if (!rejected.every(Boolean)) {
    throw new PrivacyRecoveryAuthorityCorpusError("An Agent Session invoked a local-authority action through MCP");
  }
  const afterAgentAttempts = await vaultA.local.recoveryState();
  const historicalStatusAfter = await vaultA.local.historicalStatusSha256();
  if (afterAgentAttempts !== beforeAgentAttempts) {
    throw new PrivacyRecoveryAuthorityCorpusError("Rejected Agent authority attempts mutated recovery state");
  }
  if (historicalStatusAfter !== historicalStatusBefore) {
    throw new PrivacyRecoveryAuthorityCorpusError(
      "Rejected Agent authority attempts altered historical status behavior",
    );
  }
  options.record("assertion", "content-inclusive-and-authority-mcp-rejected", {
    rejected: rejected.length,
    stateMutations: 0,
    historicalStatusUnchanged: true,
  });
  assertion("diagnostics:content-inclusive-local-only");
  assertion("authority:agent-attempts-rejected-without-mutation-or-history-change");

  if (beforeAgentAttempts !== "blocked") {
    throw new PrivacyRecoveryAuthorityCorpusError("Recovery baseline scenario did not begin at a blocked gate");
  }
  if (!(await rejectedLocalBaselineAcceptance(vaultB.local))) {
    throw new PrivacyRecoveryAuthorityCorpusError(
      "Local baseline acceptance bypassed blocked recovery Journal preconditions",
    );
  }
  if ((await vaultB.local.recoveryState()) !== "writable") {
    throw new PrivacyRecoveryAuthorityCorpusError(
      "Rejected local baseline acceptance mutated the unrelated Vault",
    );
  }
  const beforeResume = await rejectedMcpInvocation(vaultA.mcp, "vault_resume_writes");
  if (!beforeResume || (await vaultA.local.recoveryState()) !== "blocked") {
    throw new PrivacyRecoveryAuthorityCorpusError("Recovery gate weakened before local baseline acceptance");
  }
  await vaultA.local.acceptTrustedRecoveryBaseline();
  if ((await vaultA.local.recoveryState()) !== "paused") {
    throw new PrivacyRecoveryAuthorityCorpusError(
      "Accepted trusted recovery baseline did not retain explicit-resume precondition",
    );
  }
  await vaultA.local.resumeWrites();
  if ((await vaultA.local.recoveryState()) !== "writable") {
    throw new PrivacyRecoveryAuthorityCorpusError("Explicit local resume did not reopen writes");
  }
  options.record("assertion", "local-recovery-baseline-and-explicit-resume", {
    rejectedInvalidBaseline: true,
    journalPreconditions: true,
    explicitResume: true,
  });
  assertion("authority:invalid-baseline-journal-preconditions-rejected");
  assertion("authority:trusted-baseline-journal-preconditions-local-only");
  assertion("authority:explicit-local-resume-required");

  const afterB = await observeClosedHealth(vaultB.mcp, "vault-b-after-authority");
  if (afterB.digest !== healthB.digest || (await vaultB.local.recoveryState()) !== "writable") {
    throw new PrivacyRecoveryAuthorityCorpusError("Vault A recovery authority crossed the Managed Vault boundary");
  }
  options.record("assertion", "multi-vault-isolation", { vaultBUnaffected: true });
  assertion("isolation:second-vault-unaffected");

  const [cleanupA, cleanupB] = await Promise.all([vaultA.local.cleanup(), vaultB.local.cleanup()]);
  const residualPaths = [...cleanupA.residualPaths, ...cleanupB.residualPaths];
  if (residualPaths.length > 0) {
    throw new PrivacyRecoveryAuthorityCorpusError("Privacy/recovery corpus cleanup left residual state");
  }
  options.record("cleanup", "privacy-recovery-residual-state", { residualPaths: 0 });
  assertion("cleanup:no-residual-private-state");

  return {
    scenarioManifestSha256: scenarioManifestSha256(),
    vaultIdSha256s: { "vault-a": sha256(vaultA.vaultId), "vault-b": sha256(vaultB.vaultId) },
    healthSummarySha256s: { "vault-a": healthA.digest, "vault-b": healthB.digest },
    standardDiagnosticChecksums: 2,
    privateMarkersRejected: vaultA.privateMarkers.length + vaultB.privateMarkers.length,
    contentInclusiveLocalOnly: true,
    rejectedAgentAuthorityAttempts: authorityToolNames.length + 1,
    agentAuthorityStateMutations: 0,
    baselineAcceptanceLocalOnly: true,
    journalPreconditionsProven: true,
    explicitResumeRequired: true,
    secondVaultUnaffected: true,
    residualPaths: [],
    assertions,
  };
}

export interface PrivacyRecoveryAuthorityEvidenceDraft {
  readonly corpusId: typeof PRIVACY_RECOVERY_AUTHORITY_CORPUS_ID;
  readonly scenarioManifestSha256: string;
  readonly tools: readonly string[];
  readonly vaults: readonly {
    readonly label: "vault-a" | "vault-b";
    readonly vaultIdSha256: string;
    readonly healthSummarySha256: string;
  }[];
  readonly diagnostics: {
    readonly standardBundles: 2;
    readonly validChecksums: 2;
    readonly privateMarkersRejected: number;
    readonly stableOpaqueAliases: true;
    readonly contentInclusiveLocalOnly: true;
  };
  readonly authority: {
    readonly rejectedAgentAttempts: number;
    readonly agentStateMutations: 0;
    readonly baselineAcceptanceLocalOnly: true;
    readonly journalPreconditionsProven: true;
    readonly explicitResumeRequired: true;
  };
  readonly isolation: { readonly secondVaultUnaffected: true };
  readonly residualCleanup: { readonly residualPaths: readonly [] };
  readonly eventLog: readonly {
    readonly sequence: number;
    readonly kind: "transport" | "tool" | "assertion" | "cleanup";
    readonly name: string;
    readonly detailSha256: string;
  }[];
  readonly assertions: readonly string[];
  readonly verdict: "passed";
}

export function composePrivacyRecoveryAuthorityCorpusEvidence(options: {
  readonly outcome: PrivacyRecoveryAuthorityCorpusOutcome;
  readonly events: readonly {
    kind: "transport" | "tool" | "assertion" | "cleanup";
    name: string;
    detail: unknown;
  }[];
  readonly assertions: readonly string[];
}): PrivacyRecoveryAuthorityEvidenceDraft {
  const { outcome } = options;
  if (
    outcome.standardDiagnosticChecksums !== 2 ||
    outcome.privateMarkersRejected <= 0 ||
    outcome.contentInclusiveLocalOnly !== true ||
    outcome.rejectedAgentAuthorityAttempts <= 0 ||
    outcome.agentAuthorityStateMutations !== 0 ||
    outcome.baselineAcceptanceLocalOnly !== true ||
    outcome.journalPreconditionsProven !== true ||
    outcome.explicitResumeRequired !== true ||
    outcome.secondVaultUnaffected !== true ||
    outcome.residualPaths.length !== 0
  ) {
    throw new PrivacyRecoveryAuthorityCorpusError(
      "Privacy/recovery outcome does not satisfy the release-blocking evidence invariants",
    );
  }
  if (outcome.assertions.length === 0 || options.assertions.length === 0) {
    throw new PrivacyRecoveryAuthorityCorpusError("Privacy/recovery evidence requires assertions");
  }
  return {
    corpusId: PRIVACY_RECOVERY_AUTHORITY_CORPUS_ID,
    scenarioManifestSha256: outcome.scenarioManifestSha256,
    tools: [...PUBLIC_WIRE_TOOL_NAMES],
    vaults: (["vault-a", "vault-b"] as const).map((label) => ({
      label,
      vaultIdSha256: outcome.vaultIdSha256s[label],
      healthSummarySha256: outcome.healthSummarySha256s[label],
    })),
    diagnostics: {
      standardBundles: 2 as const,
      validChecksums: 2 as const,
      privateMarkersRejected: outcome.privateMarkersRejected,
      stableOpaqueAliases: true as const,
      contentInclusiveLocalOnly: true as const,
    },
    authority: {
      rejectedAgentAttempts: outcome.rejectedAgentAuthorityAttempts,
      agentStateMutations: 0 as const,
      baselineAcceptanceLocalOnly: true as const,
      journalPreconditionsProven: true as const,
      explicitResumeRequired: true as const,
    },
    isolation: { secondVaultUnaffected: true as const },
    residualCleanup: { residualPaths: [] as const },
    eventLog: options.events.map((event, index) => ({
      sequence: index + 1,
      kind: event.kind,
      name: event.name,
      detailSha256: sha256(canonicalJson(event.detail)),
    })),
    assertions: [...options.assertions],
    verdict: "passed",
  };
}
