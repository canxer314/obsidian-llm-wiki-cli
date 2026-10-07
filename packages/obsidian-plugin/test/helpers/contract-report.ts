import { SINGLE_SPAN_BEFORE, SINGLE_SPAN_AFTER } from "../../src/installed-runtime/registered-reference-single-span.js";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { CONTRACT_PACKAGE_ASSERTION, contractDigest, versionContractAuthorityDigest, defaultContractPackageRoot, type ContractPackageCorpusEvidence, type ContractToolName } from "../../src/installed-runtime/contract-package-corpus.js";

/** Unit report shape only. Never an installed runtime or executed producer. */
export function unitContractReport(binding: ContractPackageCorpusEvidence["binding"]): ContractPackageCorpusEvidence {
  const authority = JSON.parse(readFileSync(fileURLToPath(new URL("../../../contracts/fixtures/v1/acceptance-manifest.json", import.meta.url)), "utf8"));
  const hash = "a".repeat(64);
  const authorityHash = versionContractAuthorityDigest(defaultContractPackageRoot());
  const inputs: ContractPackageCorpusEvidence["wire"]["inputs"] = authority.fixtures.flatMap((fixture: { path: string; valid: boolean; fields: { pointer: string; direction: string; tool: ContractToolName }[] }) => fixture.fields.filter(field => field.direction === "input").map(field => ({ id: fixture.path + "#" + field.pointer, tool: field.tool, valid: fixture.valid, requestSha256: hash, responseSha256: fixture.valid ? hash : null, rejected: !fixture.valid })));
  inputs.push({ id: "roots/vault_health/input", tool: "vault_health", valid: true, requestSha256: hash, responseSha256: hash, rejected: false });
  const outputs: ContractPackageCorpusEvidence["wire"]["outputs"] = authority.roots.filter((root: { direction: string }) => root.direction === "output").map((root: { path: string; tool: ContractToolName }) => ({ tool: root.tool, root: root.path, responseSha256: hash, requestEvidencePointer: `inputs/${inputs.findIndex(input => input.tool === root.tool && input.valid)}`, structuredTextIdentical: true }));
  const outputFixtures: ContractPackageCorpusEvidence["wire"]["outputFixtures"] = authority.fixtures.flatMap((fixture: { path: string; valid: boolean; fields: { pointer: string; direction: string; tool: ContractToolName }[] }) => fixture.fields.filter(field => field.direction === "output").map(field => ({ id: fixture.path + "#" + field.pointer, root: outputs.find(output => output.tool === field.tool)!.root, valid: fixture.valid, mode: "validator-only", associatedOutputPointer: `outputs/${outputs.findIndex(output => output.tool === field.tool)}` })));
  const eventLog = [{ sequence: 1, kind: "cleanup" as const, name: "unit-report-shape-only", detailSha256: hash }];
  return {
    corpusId: "version-contract-package", contractVersion: "1.0.0", authoritySha256: authorityHash, binding,
    wire: { authoritySha256: authorityHash, inputs, outputs, outputFixtures, unknownFieldRejections: outputs.map(output => ({ tool: output.tool, requestSha256: hash })), eventLog, cleanup: { sessionClosed: true }, verdict: "passed" },
    roots: authority.roots.map((root: { path: string; tool: ContractToolName; direction: string; sha256: string }) => ({ id: root.path, sha256: root.sha256, evidencePointer: root.direction === "input" ? `wire/inputs/${inputs.findIndex(row => row.tool === root.tool && row.valid)}` : `wire/outputs/${outputs.findIndex(row => row.tool === root.tool)}` })),
    sharedDefinitions: authority.sharedDefinitions.map((def: { root: string; pointer: string }) => ({ id: def.root + def.pointer, rootEvidencePointer: `roots/${authority.roots.findIndex((root: { path: string }) => root.path === def.root)}` })),
    fixtures: authority.fixtures.flatMap((fixture: { path: string; valid: boolean; fields: { pointer: string; direction: "input" | "output" }[] }) => fixture.fields.map(field => ({ id: fixture.path + "#" + field.pointer, valid: fixture.valid, direction: field.direction, mode: field.direction === "input" ? "executed" : "validator-only", evidencePointer: field.direction === "input" ? `wire/inputs/${inputs.findIndex(row => row.id === fixture.path + "#" + field.pointer)}` : `wire/outputFixtures/${outputFixtures.findIndex(row => row.id === fixture.path + "#" + field.pointer)}` }))),
    crossCalls: authority.scenarios.map((scenario: { id: string; execution: string; requiredCorpus?: string }, index: number) => {
      const rows: Record<string, [string, Record<string, string | number | boolean>][]> = {
        "identity-health": [["identity-bound-health", { identityMatched: true, listenerMatched: true }]],
        "structured-text": [["vault_health", { schemaValid: true, structuredTextIdentical: true }]],
        "section-no-fallback": [["no-section-fallback", { noFallback: true }]],
        "mixed-read": [["ordered-duplicate-exact-bytes", { duplicatePreserved: true, exactBytes: true, canonicalContentVersions: true }]],
        "limit-grouping": [["limit-and-contiguous-grouping", { singleNoteRefused: true, noPartialContent: true, contiguousOrderedGroups: true }]],
        "change-set-program": [["vault_change_set_submit", { schemaValid: true }], ["program-expectation", { expectationMatched: true }]],
        "frozen-continuation": [["frozen-after-source-change", { sourceChanged: true, exactFrozenBytes: true }]],
        "invalid-utf8": [["invalid-utf8-untrusted-rejection", { fixtureInvalidUtf8: true, noTrustedResult: true, notSatisfiedNotSubstituted: true }]],
        "structured-graph": [["combined-structured-graph-raw-byte-projection", { allPredicatesMatched: true, frontmatterOutlineMatchesReferences: true, rawByteVersionMatched: true }]],
        "uncertain-response": [["submit-wire-response-discarded", { actuallyReceived: true, deliberatelyUnavailable: true }], ["original-key-recovered-after-restart", { identityPreserved: true, originalKeyRecovered: true }]],
        "client-bound-sliding": [["wrong-client-token-rejected", { wrongClientRejected: true }], ["original-client-token-preserved", { ownerTokenPreserved: true }], ["real-time-sliding-lifetime", { replacementSurvivesOriginalExpiry: true, originalAgeMs: 910000, replacementAgeMs: 310000 }], ["real-time-token-expiry", { expiredRejected: true, elapsedMs: 901000 }]],
        "quota-cleanup": [["quota-preserved-and-session-capacity-released", { eightChainsSurvived: true, ninthRejected: true, completionReleasedCapacity: true, closedSessionTokenRejected: true }], ["retained-byte-quota-no-eviction", { acceptedChains: 1, secondRejected: true, acceptedChainDrained: true }], ["expiry-releases-retained-capacity", { expiredTokenRejected: true, capacityReleased: true, elapsedMs: 901000 }], ["bridge-teardown-releases-retained-capacity", { oldTokenRejected: true, capacityReleased: true }]],
      };
      if (scenario.execution === "missing-identity" || scenario.execution === "wrong-identity") rows[scenario.execution] = ["initialize", ...Array(6).fill("tools/call")].map(name => [name, { status: 403, rejectedBeforeDispatch: true }]);
      if (scenario.execution === "dependent-corpus") rows[scenario.execution] = [["validated-installed-dependent-proof", { requiredCorpus: scenario.requiredCorpus!, sourceReportValidated: true, bindingMatched: true, cleanupConfirmed: true }]];
      const observations = rows[scenario.execution]!.map(([name, facts], row) => ({ sequence: row + 1, name, facts, requestSha256: hash, responseSha256: hash }));
      const dependencyReport = scenario.execution === "dependent-corpus" ? unitDependencyReport(scenario.id) : null;
      const proof = { scenarioId: scenario.id, authoritySha256: authorityHash, binding, observations, cleanup: { sessionsClosed: true }, verdict: "passed" as const, requiredCorpus: null, dependency: dependencyReport === null ? null : { binding, reportSha256: contractDigest(dependencyReport), report: dependencyReport } };
      return { id: scenario.id, evidenceSha256: contractDigest(proof), evidencePointer: `crossCalls/${index}/observations`, source: "real-loopback" as const, observations, proof };
    }),
    beforeInventorySha256: hash, afterInventorySha256: hash, cleanup: { attempted: true, residualPaths: [], sessionClosed: true }, eventLog, assertions: [CONTRACT_PACKAGE_ASSERTION], verdict: "passed",
  };
}
function unitDependencyReport(id: string): unknown {
  const hash = "a".repeat(64);
  const eventLog = [{ sequence: 1, kind: "assertion", name: "unit-shape-only", detailSha256: hash }];
  if (id === "registered-reference-byte-verification") {
    const bytes = Buffer.from(SINGLE_SPAN_BEFORE);
    const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
    const inventory = { scope: "Notes/", entries: [], digest: hash };
    return { corpusId: "registered-reference-rewrite-proof", seedManifestSha256: hash, scenarioManifestSha256: hash, beforeInventory: inventory, afterInventory: inventory,
      moves: ["wikilink", "embed", "markdown_inline_link", "markdown_embed"].map(profile => ({ scenario: profile, profile, submissionKeySha256: hash, changeSetId: profile, sourcePath: "from.md", destinationPath: "to.md", derivedPaths: ["ref.md"], destinationContentVersionSha256: hash, rewrittenContentVersionSha256: hash, oldPathAbsent: true, destinationTypedMarkdown: true, finalBytesReread: true })),
      rawBytes: { fixtures: [{ scenario: "span", hostModes: ["bom", "crlf", "cjk", "astral"], locatedReferences: 2, everyReferenceExactlyOneVerifiedSpan: true, everyUntouchedByteExact: true, finalBytesHashReread: true }], duplicateEqualSpellings: { referencesRewritten: 2, untouchedBytesExact: true }, secondEqualSpellingOnly: { scenario: "span/second-equal-spelling-only", fixturePath: "ReferenceProof/Single/Ref.md", fixtureSha256: sha(bytes), beforeSha256: sha(bytes), afterSha256: sha(SINGLE_SPAN_AFTER), referencesLocated: 2, selectedOrdinal: 2, selectedSpan: { startByte: 58, endByteExclusive: 72 }, beforeSizeBytes: 83, afterSizeBytes: 89, untouchedPrefixSha256: sha(bytes.subarray(0, 58)), untouchedSuffixSha256: sha(bytes.subarray(72)), untouchedPrefixExact: true, untouchedSuffixExact: true, firstReferenceExact: true, fullBytesExact: true, finalBytesHashReread: true } },
      rejections: [{ scenario: "reject", failureCode: "stale_observation", registered: true, noMutationDigestUnchanged: true }], observer: { enabledSecondObserver: true, discoversIssued: 1, privateStagingPathsObserved: 0, halfWrittenMarkdownObserved: 0 }, residualCleanup: { recoveryState: "none", queueLength: 0, currentExecutionId: null, writeGate: "open" }, eventLog, assertions: ["unit-shape-only"], verdict: "passed" };
  }
  if (id === "successor-search-snapshot-graph-evidence") return { corpusId: "semantic-evidence-search-snapshot-proof", scenarioManifestSha256: hash, tools: ["vault_health", "vault_discover", "vault_read", "vault_continue", "vault_change_set_submit", "vault_change_set_status"], scenarios: ["create_note", "move_note", "trash_note"].map(mutationKind => ({ scenario: mutationKind + "/clean", source: "installed-obsidian", mutationKind, proofState: "intent_applied", statusProofState: "intent_applied", journalPhase: "COMMITTED", evidenceDeadlineMs: 5000, successBarrierDeadlineMs: 5000, evidenceSessions: [{ mode: "apply", outcome: "converged", virtualElapsedMs: 250 }], quietWindowResets: 1, acceptedSnapshotRounds: 1, rejectedSnapshotRounds: 0, successorSnapshot: { baselineVersion: 1, version: 2, immutable: true, publishedBeforeIntentApplied: true }, durableCommitBeforeIntentApplied: true, writesBlocked: false, beforeInventorySha256: hash, afterInventorySha256: hash, cleanupSucceeded: true })), coverage: { delayedOlderContentVersionRejected: true, quietWindowStabilityProven: true, createModifyRenameDeleteAndClosureProven: true, hiddenTrashRestoreUsesTargetedProbes: true, deadlineRollbackOrUnprovenProven: true, contraryEvidenceResetsQuietWindow: true, noPublicSearchSnapshotCapability: true }, residualCleanup: { reportsRemoved: true, residualReportPaths: [] }, eventLog, assertions: ["unit-shape-only"], verdict: "passed" };
  const read = (path: string) => JSON.parse(readFileSync(fileURLToPath(new URL("../../../contracts/fixtures/v1/" + path, import.meta.url)), "utf8"));
  if (id === "change-set-seven-day-retention") {
    const before = read("vault-change-set/valid/found-rejection.json").statusResult;
    return { kind: "installed-contract-retention-proof", retentionMs: 604800000, timeBoundaryFixtureSha256: hash, before, afterRestart: before, afterRetention: { lookup: "expired", vault: before.vault }, cleanupConfirmed: true };
  }
  const calls: unknown[] = [];
  const call = (tool: string, arguments_: unknown, structuredContent: unknown) => calls.push({ sequence: calls.length + 1, tool, arguments: arguments_, structuredContent, compatibilityText: JSON.stringify(structuredContent), isError: false, rawAccessCount: 0 });
  if (id === "schema-compatible-incompatible-health") call("vault_health", {}, read("valid/incompatible.json"));
  if (id === "two-vault-coexistence") call("vault_health", {}, read("valid/incompatible.json"));
  if (id === "content-read-operational-block") for (const tool of ["vault_discover", "vault_read", "vault_continue"]) call(tool, {}, { outcome: "operationally_blocked", gate: { code: "recovery_blocked" } });
  if (id === "continuation-operational-gate-precedence") { call("vault_continue", { continuation: "token" }, { outcome: "operationally_blocked", gate: { code: "recovery_blocked" } }); call("vault_continue", { continuation: "token" }, { outcome: "page", items: [{ index: 0, item: { outcome: "not_satisfied" } }], continuation: null, complete: true }); }
  return { kind: "installed-contract-gate-proof", scenarioId: id, source: "installed-obsidian", calls, identities: [hash, "b".repeat(64)].map(value => ({ vaultIdSha256: value, endpointSha256: value, healthSha256: value, stateSha256: value })), cleanup: { attempted: true, residualPaths: [] } };
}
export { contractDigest };
