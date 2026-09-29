import { createHash } from "node:crypto";

import { z } from "zod";

import type { InstalledRuntimeEvidence } from "./evidence.js";

/**
 * The complete #44 acceptance matrix. Each criterion is bound once to concrete
 * evidence from one of the installed-runtime child corpora or final inspection.
 */
export const ACCEPTANCE_MATRIX_SCHEMA_VERSION = 1;
export const ACCEPTANCE_MATRIX_ID = "spec-44-a-01-through-a-44";

export const ACCEPTANCE_IDS = Array.from(
  { length: 44 },
  (_, index) => `A-${String(index + 1).padStart(2, "0")}`,
) as readonly string[];

export const ACCEPTANCE_CORPUS_IDS = [
  "public-wire",
  "change-set-submission",
  "gate-isolation",
  "registered-reference-rewrite",
  "semantic-evidence-search-snapshot",
  "privacy-recovery-authority",
  "release-lifecycle",
  "crash-restoration-retained-authority",
] as const;

export type AcceptanceCorpusId = (typeof ACCEPTANCE_CORPUS_IDS)[number];
export type AcceptanceId = (typeof ACCEPTANCE_IDS)[number];

export interface AcceptanceMatrixChildManifest {
  readonly corpusId: AcceptanceCorpusId;
  readonly manifestSha256: string;
  readonly evidenceSha256: string;
  readonly assertions: readonly string[];
  readonly verdict: "passed";
}

export interface AcceptanceMatrixScenario {
  readonly id: AcceptanceId;
  readonly corpusId: AcceptanceCorpusId;
  readonly evidencePointer: string;
  readonly verdict: "passed";
}

export interface AcceptanceMatrixFinalInspection {
  readonly publicTools: readonly string[];
  readonly localOnlyRecoveryAuthority: true;
  readonly searchSnapshotInternalOnly: true;
  readonly noDirectMutationPath: true;
  readonly noResidualFixtureContent: true;
  readonly noUnreportedBlockedGate: true;
}

export interface AcceptanceMatrixReport {
  readonly schemaVersion: typeof ACCEPTANCE_MATRIX_SCHEMA_VERSION;
  readonly matrixId: typeof ACCEPTANCE_MATRIX_ID;
  readonly profile: { readonly name: string; readonly versions: { readonly obsidian: string; readonly electron: string; readonly node: string } };
  readonly candidate: { readonly pluginId: string; readonly pluginVersion: string; readonly bundleSha256: string };
  readonly childManifests: readonly AcceptanceMatrixChildManifest[];
  readonly scenarios: readonly AcceptanceMatrixScenario[];
  readonly beforeInventorySha256: string;
  readonly afterInventorySha256: string;
  readonly cleanup: { readonly residualPaths: readonly string[] };
  readonly installedClientCompatibilityObserved: true;
  readonly finalInspection: AcceptanceMatrixFinalInspection;
  readonly verdict: "passed";
  readonly canonicalManifestSha256: string;
}

export class AcceptanceMatrixError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AcceptanceMatrixError";
  }
}

const sha256Pattern = /^[a-f0-9]{64}$/u;
const sixPublicTools = [
  "vault_change_set_status",
  "vault_change_set_submit",
  "vault_continue",
  "vault_discover",
  "vault_health",
  "vault_read",
] as const;

const matrixPlan = [
  ["A-01", "gate-isolation"], ["A-02", "public-wire"], ["A-03", "public-wire"],
  ["A-04", "public-wire"], ["A-05", "public-wire"], ["A-06", "public-wire"],
  ["A-07", "public-wire"], ["A-08", "public-wire"], ["A-09", "public-wire"],
  ["A-10", "public-wire"], ["A-11", "public-wire"], ["A-12", "public-wire"],
  ["A-13", "public-wire"], ["A-14", "change-set-submission"], ["A-15", "change-set-submission"],
  ["A-16", "change-set-submission"], ["A-17", "change-set-submission"], ["A-18", "change-set-submission"],
  ["A-19", "change-set-submission"], ["A-20", "change-set-submission"], ["A-21", "crash-restoration-retained-authority"],
  ["A-22", "crash-restoration-retained-authority"], ["A-23", "gate-isolation"], ["A-24", "registered-reference-rewrite"],
  ["A-25", "registered-reference-rewrite"], ["A-26", "registered-reference-rewrite"], ["A-27", "semantic-evidence-search-snapshot"],
  ["A-28", "semantic-evidence-search-snapshot"], ["A-29", "semantic-evidence-search-snapshot"], ["A-30", "gate-isolation"],
  ["A-31", "release-lifecycle"], ["A-32", "release-lifecycle"], ["A-33", "privacy-recovery-authority"],
  ["A-34", "change-set-submission"], ["A-35", "crash-restoration-retained-authority"], ["A-36", "gate-isolation"],
  ["A-37", "privacy-recovery-authority"], ["A-38", "semantic-evidence-search-snapshot"], ["A-39", "public-wire"],
  ["A-40", "gate-isolation"], ["A-41", "change-set-submission"], ["A-42", "public-wire"],
  ["A-43", "change-set-submission"], ["A-44", "semantic-evidence-search-snapshot"],
] as const satisfies readonly (readonly [AcceptanceId, AcceptanceCorpusId])[];

export const ACCEPTANCE_MATRIX_PLAN = Object.freeze(
  matrixPlan.map(([id, corpusId]) => ({ id, corpusId })),
);

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

function corpusManifest(corpusId: AcceptanceCorpusId, evidence: unknown, manifestSha256: string, assertions: readonly string[]): AcceptanceMatrixChildManifest {
  if (!sha256Pattern.test(manifestSha256)) {
    throw new AcceptanceMatrixError(`${corpusId} child manifest has an invalid checksum`);
  }
  if (assertions.length === 0) {
    throw new AcceptanceMatrixError(`${corpusId} child manifest has no assertions`);
  }
  return { corpusId, manifestSha256, evidenceSha256: sha256(evidence), assertions: [...assertions], verdict: "passed" };
}

function requireCorpus<T>(value: T | null | undefined, name: string): T {
  if (value === null || value === undefined) throw new AcceptanceMatrixError(`Required ${name} evidence is absent`);
  return value;
}

function childManifests(evidence: InstalledRuntimeEvidence): AcceptanceMatrixChildManifest[] {
  const publicWire = requireCorpus(evidence.publicWireCorpus, "public-wire corpus");
  const changeSet = requireCorpus(evidence.changeSetCorpus, "change-set corpus");
  const gate = requireCorpus(evidence.gateIsolationCorpus, "gate-isolation corpus");
  const rewrite = requireCorpus(evidence.registeredReferenceRewriteCorpus, "registered-reference rewrite corpus");
  const semantic = requireCorpus(evidence.semanticEvidenceSearchSnapshotCorpus, "Semantic Evidence/Search Snapshot corpus");
  const privacy = requireCorpus(evidence.privacyRecoveryAuthorityCorpus, "privacy/recovery authority corpus");
  const lifecycle = requireCorpus(evidence.releaseLifecycleCorpus, "release-lifecycle corpus");
  const crash = requireCorpus(evidence.crashRestorationRetainedAuthorityCorpus, "crash-restoration corpus");
  const all = [
    corpusManifest("public-wire", publicWire, publicWire.canonicalManifestSha256, publicWire.assertions),
    corpusManifest("change-set-submission", changeSet, changeSet.scenarioManifestSha256, changeSet.assertions),
    corpusManifest("gate-isolation", gate, gate.scenarioManifestSha256, gate.assertions),
    corpusManifest("registered-reference-rewrite", rewrite, rewrite.scenarioManifestSha256, rewrite.assertions),
    corpusManifest("semantic-evidence-search-snapshot", semantic, semantic.scenarioManifestSha256, semantic.assertions),
    corpusManifest("privacy-recovery-authority", privacy, privacy.scenarioManifestSha256, privacy.assertions),
    corpusManifest("release-lifecycle", lifecycle, lifecycle.scenarioManifestSha256, lifecycle.assertions),
    corpusManifest("crash-restoration-retained-authority", crash, crash.scenarioManifestSha256, crash.assertions),
  ];
  if (new Set(all.map((child) => child.corpusId)).size !== ACCEPTANCE_CORPUS_IDS.length) {
    throw new AcceptanceMatrixError("Acceptance matrix contains duplicate child manifests");
  }
  return all;
}

function inspect(evidence: InstalledRuntimeEvidence): AcceptanceMatrixFinalInspection {
  const publicTools = [...evidence.publicWireCorpus!.tools].sort();
  if (publicTools.join("\0") !== [...sixPublicTools].sort().join("\0")) {
    throw new AcceptanceMatrixError("Final inspection requires exactly six public MCP tools");
  }
  if (evidence.privacyRecoveryAuthorityCorpus!.authority.baselineAcceptanceLocalOnly !== true) {
    throw new AcceptanceMatrixError("Final inspection requires local-only recovery authority");
  }
  if (evidence.semanticEvidenceSearchSnapshotCorpus!.coverage.noPublicSearchSnapshotCapability !== true) {
    throw new AcceptanceMatrixError("Final inspection requires Search Snapshot to remain internal-only");
  }
  if (evidence.changeSetCorpus!.admission.submissions.some((submission) => !submission.executed && submission.state === "intent_applied")) {
    throw new AcceptanceMatrixError("Final inspection found an unproven direct mutation path");
  }
  if (
    evidence.cleanup?.residualPaths.length !== 0 ||
    evidence.crashRestorationRetainedAuthorityCorpus!.cleanup.fixtureResidue !== 0 ||
    evidence.releaseLifecycleCorpus!.cleanup.residualPaths.length !== 0
  ) {
    throw new AcceptanceMatrixError("Final inspection found residual fixture content");
  }
  if (evidence.gateIsolationCorpus!.residualCleanup["vault-a"].writeGate !== "open" || evidence.gateIsolationCorpus!.residualCleanup["vault-b"].writeGate !== "open") {
    throw new AcceptanceMatrixError("Final inspection found an unreported blocked gate");
  }
  return {
    publicTools,
    localOnlyRecoveryAuthority: true,
    searchSnapshotInternalOnly: true,
    noDirectMutationPath: true,
    noResidualFixtureContent: true,
    noUnreportedBlockedGate: true,
  };
}

function canonicalReport(report: Omit<AcceptanceMatrixReport, "canonicalManifestSha256">): Omit<AcceptanceMatrixReport, "canonicalManifestSha256"> {
  return {
    ...report,
    childManifests: [...report.childManifests].sort((left, right) => left.corpusId.localeCompare(right.corpusId)),
    scenarios: [...report.scenarios].sort((left, right) => left.id.localeCompare(right.id)),
    finalInspection: { ...report.finalInspection, publicTools: [...report.finalInspection.publicTools].sort() },
  };
}

export function createAcceptanceMatrixReport(evidence: InstalledRuntimeEvidence): AcceptanceMatrixReport {
  if (evidence.verdict !== "passed" || evidence.failure !== null) throw new AcceptanceMatrixError("Acceptance matrix requires a passing installed-runtime run");
  if (evidence.profile.mismatches.length !== 0 || evidence.candidate === null || evidence.bridgeIdentity === null) {
    throw new AcceptanceMatrixError("Acceptance matrix requires matched profile and runtime identity");
  }
  if (evidence.beforeInventory === null || evidence.afterInventory === null || evidence.cleanup === null) {
    throw new AcceptanceMatrixError("Acceptance matrix requires inventories and cleanup evidence");
  }
  const children = childManifests(evidence);
  const scenarios = ACCEPTANCE_MATRIX_PLAN.map(({ id, corpusId }) => ({
    id,
    corpusId,
    evidencePointer: `childManifests/${corpusId}`,
    verdict: "passed" as const,
  }));
  const draft = canonicalReport({
    schemaVersion: ACCEPTANCE_MATRIX_SCHEMA_VERSION,
    matrixId: ACCEPTANCE_MATRIX_ID,
    profile: { name: evidence.profile.name, versions: { ...evidence.profile.registered.versions } },
    candidate: { pluginId: evidence.candidate.pluginId, pluginVersion: evidence.candidate.pluginVersion, bundleSha256: evidence.candidate.bundleSha256 },
    childManifests: children,
    scenarios,
    beforeInventorySha256: sha256(evidence.beforeInventory),
    afterInventorySha256: sha256(evidence.afterInventory),
    cleanup: { residualPaths: [...evidence.cleanup.residualPaths] },
    installedClientCompatibilityObserved: true,
    finalInspection: inspect(evidence),
    verdict: "passed",
  });
  return { ...draft, canonicalManifestSha256: sha256(draft) };
}

const acceptanceMatrixReportSchema = z.object({
  schemaVersion: z.literal(ACCEPTANCE_MATRIX_SCHEMA_VERSION),
  matrixId: z.literal(ACCEPTANCE_MATRIX_ID),
  profile: z.object({ name: z.string().min(1), versions: z.object({ obsidian: z.string().min(1), electron: z.string().min(1), node: z.string().min(1) }).strict() }).strict(),
  candidate: z.object({ pluginId: z.string().min(1), pluginVersion: z.string().min(1), bundleSha256: z.string().regex(sha256Pattern) }).strict(),
  childManifests: z.array(z.object({ corpusId: z.enum(ACCEPTANCE_CORPUS_IDS), manifestSha256: z.string().regex(sha256Pattern), evidenceSha256: z.string().regex(sha256Pattern), assertions: z.array(z.string().min(1)).min(1), verdict: z.literal("passed") }).strict()).length(ACCEPTANCE_CORPUS_IDS.length),
  scenarios: z.array(z.object({ id: z.string(), corpusId: z.enum(ACCEPTANCE_CORPUS_IDS), evidencePointer: z.string().min(1), verdict: z.literal("passed") }).strict()).length(ACCEPTANCE_IDS.length),
  beforeInventorySha256: z.string().regex(sha256Pattern),
  afterInventorySha256: z.string().regex(sha256Pattern),
  cleanup: z.object({ residualPaths: z.array(z.string()).length(0) }).strict(),
  installedClientCompatibilityObserved: z.literal(true),
  finalInspection: z.object({ publicTools: z.array(z.string()).length(6), localOnlyRecoveryAuthority: z.literal(true), searchSnapshotInternalOnly: z.literal(true), noDirectMutationPath: z.literal(true), noResidualFixtureContent: z.literal(true), noUnreportedBlockedGate: z.literal(true) }).strict(),
  verdict: z.literal("passed"),
  canonicalManifestSha256: z.string().regex(sha256Pattern),
}).strict().superRefine((report, context) => {
  const actualIds = report.scenarios.map((scenario) => scenario.id).sort();
  if (actualIds.join("\0") !== [...ACCEPTANCE_IDS].sort().join("\0")) context.addIssue({ code: "custom", message: "Acceptance matrix must contain every A-01 through A-44 exactly once" });
  if (new Set(report.childManifests.map((child) => child.corpusId)).size !== ACCEPTANCE_CORPUS_IDS.length) context.addIssue({ code: "custom", message: "Acceptance matrix must contain every child manifest exactly once" });
  const { canonicalManifestSha256: _canonicalManifestSha256, ...draft } = report;
  if (sha256(canonicalReport(draft)) !== report.canonicalManifestSha256) context.addIssue({ code: "custom", message: "Acceptance matrix canonical manifest hash does not match content" });
});

export function validateAcceptanceMatrixReport(report: AcceptanceMatrixReport): AcceptanceMatrixReport {
  return acceptanceMatrixReportSchema.parse(report) as AcceptanceMatrixReport;
}
