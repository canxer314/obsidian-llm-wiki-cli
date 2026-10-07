import { unitContractReport, contractDigest } from "./helpers/contract-report.js";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import * as crashCorpus from "../src/installed-runtime/crash-restoration-retained-authority-corpus.js";
import { SINGLE_SPAN_BEFORE, SINGLE_SPAN_AFTER } from "../src/installed-runtime/registered-reference-single-span.js";
const a26Digest = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");

import {
  createBridgeInstance,
  createLoopbackMcpClient,
  HealthObservationError,
  createFileSystemChangeSetExecutionAdapter,
  createNodeFileSystemChangeSetHost,
  ManagedVaultBridgeRuntime,
  ObsidianProcessError,
  parseEvidence,
  provisionTestVault,
  cleanupTestVault,
  RELEASE_REPOSITORY,
  RELEASE_WORKFLOW_PATH,
  runInstalledRuntimeHarness,
  runInstalledGateIsolationCorpus,
  TEST_VAULT_DIRECTORY_PREFIX,
  type BridgeHealthState,
  type CrashRestorationRetainedAuthorityCorpusOutcome,
  type RegisteredReferenceRewriteOutcome,
  type GateIsolationOutcome,
  type PrivacyRecoveryAuthorityCorpusOutcome,
  type ReleaseLifecycleCorpusOutcome,
  type SemanticEvidenceSearchSnapshotOutcome,
  type InstalledRuntimeHarnessOptions,
  type LoopbackMcpClient,
  type ObsidianProcessControl,
  type ObservedRuntimeEnvironment,
  type PersistedBridgeSettings,
  type RegisteredRuntimeProfile,
  type RuntimeEnvironmentProbe,
} from "../src/index.js";

const INNER_PROFILE: RegisteredRuntimeProfile = {
  name: "INNER-TEST",
  os: { platform: "linux", build: "inner-build" },
  versions: { obsidian: "0.0.0-inner", electron: "0.0.0-inner", node: "0.0.0-inner" },
  capabilities: ["loopback_http"],
  profileRequirement: "dedicated_candidate_only",
};

const PROFILES = new Map([[INNER_PROFILE.name, INNER_PROFILE]]);

const MATCHING_OBSERVED: ObservedRuntimeEnvironment = {
  platform: "linux",
  osBuild: "inner-build",
  obsidianVersion: "0.0.0-inner",
  electronVersion: "0.0.0-inner",
  nodeVersion: "0.0.0-inner",
  capabilities: ["loopback_http"],
};

function probe(observed: Partial<ObservedRuntimeEnvironment> = {}): RuntimeEnvironmentProbe {
  return { probe: async () => ({ ...MATCHING_OBSERVED, ...observed }) };
}

const CANDIDATE_MANIFEST = `${JSON.stringify(
  {
    id: "candidate-bridge",
    name: "Candidate Bridge",
    version: "0.2.0",
    minAppVersion: "1.13.4",
    isDesktopOnly: true,
  },
  null,
  2,
)}\n`;
const CANDIDATE_MAIN = "// candidate main\n";
const CANDIDATE_TAG = "v0.2.0";

async function writeCandidateBundle(
  directory: string,
  options: { corruptChecksum?: boolean; withAttestation?: boolean } = {},
): Promise<void> {
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "manifest.json"), CANDIDATE_MANIFEST, "utf8");
  await writeFile(join(directory, "main.js"), CANDIDATE_MAIN, "utf8");
  const digest = (content: string) => createHash("sha256").update(content, "utf8").digest("hex");
  const lines = [
    `${digest(CANDIDATE_MAIN)}  main.js`,
    `${digest(CANDIDATE_MANIFEST)}  manifest.json`,
  ].sort();
  if (options.corruptChecksum === true) {
    lines[lines.findIndex((line) => line.endsWith("  main.js"))] = `${"0".repeat(64)}  main.js`;
  }
  const checksums = `${lines.join("\n")}\n`;
  await writeFile(join(directory, "checksums.sha256"), checksums, "utf8");
  if (options.withAttestation === false) {
    await rm(`${directory}.attestation.json`, { force: true });
    return;
  }
  {
    // Claims live outside the closed bundle file set, mirroring the GitHub
    // attestation store (issue #196).
    const claims = {
      source: "local-candidate",
      repository: RELEASE_REPOSITORY,
      workflowRef: `${RELEASE_REPOSITORY}/${RELEASE_WORKFLOW_PATH}@refs/tags/${CANDIDATE_TAG}`,
      subjects: [
        ...lines.map((line) => {
          const [subjectDigest, path] = line.split("  ");
          return { name: path, sha256: subjectDigest };
        }),
        { name: "checksums.sha256", sha256: digest(checksums) },
      ].sort((left, right) => left.name!.localeCompare(right.name!)),
    };
    await writeFile(
      `${directory}.attestation.json`,
      `${JSON.stringify(claims, null, 2)}\n`,
      "utf8",
    );
  }
}

/**
 * Fake Obsidian for inner tests: each start() loads the enabled candidate
 * plugin exactly the way the real plugin host would — identity persisted at
 * `.obsidian/plugins/<id>/data.json` — and hosts a real per-Vault Bridge
 * Instance over real loopback Streamable HTTP.
 */
interface FakeObsidianKnobs {
  startError?: ObsidianProcessError;
  stopError?: ObsidianProcessError;
  skipPersist?: boolean;
  forgetOnSecondStart?: boolean;
  leavePortOpenOnStop?: boolean;
}

const liveRuntimes: ManagedVaultBridgeRuntime[] = [];

afterEach(async () => {
  await Promise.all(liveRuntimes.splice(0).map((runtime) => runtime.unload().catch(() => undefined)));
});

function createFakeObsidianProcessControl(
  knobs: FakeObsidianKnobs = {},
): ObsidianProcessControl & { starts: number } {
  let starts = 0;
  return {
    get starts() {
      return starts;
    },
    async start({ vaultPath }) {
      starts += 1;
      if (knobs.startError !== undefined) throw knobs.startError;
      const configDirectory = join(vaultPath, ".obsidian");
      const enabled = JSON.parse(
        await readFile(join(configDirectory, "community-plugins.json"), "utf8"),
      ) as string[];
      const pluginId = enabled[0];
      if (typeof pluginId !== "string") {
        throw new ObsidianProcessError("No enabled candidate plugin", "obsidian_start_failed");
      }
      const dataPath = join(configDirectory, "plugins", pluginId, "data.json");
      let stored: PersistedBridgeSettings | undefined;
      if (knobs.skipPersist !== true && !(knobs.forgetOnSecondStart === true && starts > 1)) {
        try {
          stored = JSON.parse(await readFile(dataPath, "utf8")) as PersistedBridgeSettings;
        } catch {
          stored = undefined;
        }
      }
      const runtime = new ManagedVaultBridgeRuntime({
        vault: { name: basename(vaultPath), path: vaultPath },
        settings: {
          load: async () => stored,
          save: async (settings) => {
            if (knobs.skipPersist === true) return;
            stored = settings;
            await mkdir(join(dataPath, ".."), { recursive: true });
            await writeFile(dataPath, JSON.stringify(settings), "utf8");
          },
        },
        searchDataSource: {
          listMarkdownPaths: async () => [],
          readBinary: async () => null,
        },
        createBridge: (options) => {
          // Inner tests allocate the first listener atomically through the OS.
          // Production persistent-port conflict behavior is tested separately.
          const firstStart = starts === 1 || knobs.forgetOnSecondStart === true;
          const bridge = createBridgeInstance({ ...options, port: firstStart ? 0 : options.port });
          return {
            ...bridge,
            get port() { return bridge.port; },
            get endpoint() { return bridge.endpoint; },
            async start() {
              await bridge.start();
              if (stored !== undefined && firstStart) {
                stored.port = bridge.port;
                await writeFile(dataPath, JSON.stringify(stored), "utf8");
              }
            },
          };
        },
      });
      liveRuntimes.push(runtime);
      await runtime.load();
      return {
        pid: 40_000 + starts,
        stop: async () => {
          if (knobs.stopError !== undefined) throw knobs.stopError;
          if (knobs.leavePortOpenOnStop === true) return;
          await runtime.unload();
        },
      };
    },
  };
}

interface RunContext {
  root: string;
  candidate: string;
  options: InstalledRuntimeHarnessOptions;
}

async function arrangeRun(
  runId: string,
  overrides: Partial<InstalledRuntimeHarnessOptions> = {},
): Promise<RunContext> {
  const root = await mkdtemp(join(tmpdir(), "installed-runtime-harness-"));
  const candidate = join(root, "candidate");
  await writeCandidateBundle(candidate);
  const options: InstalledRuntimeHarnessOptions = {
    profileName: INNER_PROFILE.name,
    candidateBundleDirectory: candidate,
    candidateVerification: { expectedTag: CANDIDATE_TAG, expectedPluginId: "candidate-bridge" },
    workingDirectory: root,
    evidencePath: join(root, "evidence", `${runId}.json`),
    probe: probe(),
    processControl: createFakeObsidianProcessControl(),
    prepareInstalledRuntimeAcceptanceDriver: async () => ({
      requestSemanticEvidenceScenario: async () => undefined,
      cleanup: async () => undefined,
    }),
    profiles: PROFILES,
    runId,
    // Public runner-seam unit shapes only, never installed proof.
    runContractPackageWire: async ({ authority }) => ({ authoritySha256: authority.manifestSha256, inputs: [], outputs: [], outputFixtures: [], unknownFieldRejections: [], eventLog: [], cleanup: { sessionClosed: true }, verdict: "passed" }),
    runContractCrossCall: async ({ authority, scenarioId }) => ({ scenarioId, authoritySha256: authority.manifestSha256, observations: [], cleanup: { sessionsClosed: true }, verdict: "blocked", requiredCorpus: "unit-boundary" }),
    completeContractPackage: ({ binding }) => unitContractReport(binding),
    runPublicWireCorpus: async ({ fixtureSeed }) => ({
      evidence: {
        fixtureSeed: createHash("sha256").update(fixtureSeed, "utf8").digest("hex"),
        canonicalManifestSha256: "a".repeat(64),
        tools: [
          "vault_health",
          "vault_discover",
          "vault_read",
          "vault_continue",
          "vault_change_set_submit",
          "vault_change_set_status",
        ],
        corpus: {
          corpusId: "discovery-reads-continuation",
          seedManifestSha256: "c".repeat(64),
          scenarioManifestSha256: "d".repeat(64),
        },
        beforeInventory: {
          scope: "Notes/*.md",
          entries: [{ path: "Notes/Welcome.md", sha256: "c".repeat(64), sizeBytes: 0 }],
          digest: "e".repeat(64),
        },
        afterInventory: {
          scope: "Notes/*.md",
          entries: [{ path: "Notes/Welcome.md", sha256: "c".repeat(64), sizeBytes: 0 }],
          digest: "e".repeat(64),
        },
        retainedByteCleanup: {
          chainsIssued: 1,
          chainsConsumed: 1,
          replayAfterConsumptionRejected: 1,
          bytesReconstructed: 0,
          residualChains: 0,
        },
        eventLog: [
          {
            sequence: 1,
            kind: "assertion",
            name: "stubbed-public-wire-corpus",
            detailSha256: "b".repeat(64),
          },
        ],
        assertions: [
          "connection-boundaries",
          "discovery/empty-result:complete-empty-collection",
          "discovery/combined-graph:snapshot-bound-evidence",
          "read/ordered-byte-exact:preserves-index-and-duplicates",
          "read/ordered-byte-exact:no-section-fallback",
          "read/ordered-byte-exact:bom-cjk-astral-exact-utf8",
          "read/single-note-over-limit:refused-without-content",
          "read/multi-note-logical-grouping:deterministic-contiguous-groups",
          "continuation/framing:pages-within-256kib",
          "continuation/single-use-replay-rejected:continuation-unavailable",
          "continuation/quota-exhaustion:rejects-without-evicting-live-state",
          "six-tool-invocation",
          "content-version:canonical-markdown-sha256-and-attachment-distinction",
        ],
        verdict: "passed",
      },
    }),
    runChangeSetCorpus: async ({ seedNotes, record, assertion, inventoryContext, expectedVaultId }) => {
      const seeded =
        seedNotes.find(({ path }) => path === "Notes/Welcome.md")?.content ?? "";
      const digest = createHash("sha256").update(seeded, "utf8").digest("hex");
      const entries = [{ path: "Notes/Welcome.md", sha256: digest, sizeBytes: 0 }];
      record("assertion", "change-set-corpus-began", {
        corpusId: "change-set-submission-proof",
      });
      record("cleanup", "change-set-idle-state", {
        recoveryState: "none",
        queueLength: 0,
        currentExecutionId: null,
        writeGate: "open",
      });
      const inventoryEntries = [
        { kind: "directory" as const, path: "Notes" }, { kind: "directory" as const, path: "ChangeSetProof" },
        { kind: "file" as const, path: "Notes/Welcome.md", sha256: digest, sizeBytes: 0 },
        { kind: "file" as const, path: "ChangeSetProof/AdmissionProof.md", sha256: digest, sizeBytes: 44 },
        { kind: "file" as const, path: "ChangeSetProof/Editable.md", sha256: digest, sizeBytes: 26 },
        { kind: "file" as const, path: "ChangeSetProof/Evidence.bin", sha256: digest, sizeBytes: 5 },
        { kind: "absent" as const, path: "ChangeSetProof/ReadDep.md" },
        { kind: "absent" as const, path: "ChangeSetProof/copy.bin" },
        { kind: "absent" as const, path: "ChangeSetProof/AdmissionProof.md/Child.md" },
      ].map((entry) => Object.fromEntries(Object.entries(entry).sort(([left], [right]) => left.localeCompare(right)))) as Array<{kind:"file";path:string;sha256:string;sizeBytes:number}|{kind:"directory"|"absent";path:string}>;
      const inventoryDigest = createHash("sha256").update(JSON.stringify(inventoryEntries)).digest("hex");
      const inventory = { scope: "all-public-vault-files-directories-and-affected-absence" as const, entries: inventoryEntries, digest: inventoryDigest };
      const rejectionNames = ["rejection/stale-direct-target", "rejection/read-dependency-stale", "rejection/attachment-evidence-mismatch", "rejection/derived-target-file-parent", "rejection/absence-condition", "rejection/non-unique-replacement", "rejection/occupied-destination"];
      const proofs = rejectionNames.map((name, index) => ({ submissionKeySha256: createHash("sha256").update(name).digest("hex"), changeSetId: `rejected-${index}`, state: "intent_not_applied" as const, failureCode: name === "rejection/non-unique-replacement" ? "exact_match_count_mismatch" as const : index < 3 ? "stale_observation" as const : "path_conflict" as const, executed: false }));
      for (const [index, name] of rejectionNames.entries()) {
        const proof = proofs[index]!;
        const changeSet = { changeSetId: proof.changeSetId, state: proof.state, failure: proof.failureCode === "path_conflict" ? { code: proof.failureCode, operationId: "operation", path: "ChangeSetProof/AdmissionProof.md" } : proof.failureCode === "exact_match_count_mismatch" ? { code: proof.failureCode, operationId: "operation", actualOccurrences: 2 } : { code: proof.failureCode } };
        const vault = { writeGate: "open", writeState: "writable" };
        record("assertion", `${name}:inventory-before`, inventory);
        record("tool", "vault_change_set_submit", { submissionKeySha256: proof.submissionKeySha256, result: { outcome: "registered", changeSet, vault } });
        record("tool", "vault_change_set_status", { submissionKeySha256: proof.submissionKeySha256, result: { lookup: "found", changeSet, vault } });
        record("tool", "vault_health", {
          outcome: "observed", vault: { id: expectedVaultId, name: "fixture", path: inventoryContext!.vaultPath },
          versions: { bridge: "1", plugin: "1", protocol: "1.0", persistentStateSchema: 1, recoveryJournalSchema: 1 },
          readiness: { searchSnapshot: "ready", cache: "ready", index: "ready" },
          recovery: { state: "none" }, write: { gate: "open", state: "writable", pauseSource: null },
          queue: { currentExecutionId: null, length: 0, headChangeSetId: null },
          lifecycle: { startup: "ready", upgrade: "not_run", migration: "not_run", recovery: "not_run" },
          listener: { address: "127.0.0.1", port: 32123 },
          effectiveGate: null, overall: "healthy", reasonCodes: [], operatorAction: "none",
        });
        record("assertion", `${name}:inventory-after`, inventory);
      }
      const assertions = [
        "submission/valid-create:no-validate-apply-handshake",
        "rejection/stale-direct-target:no-mutation-inventory",
        "rejection/non-unique-replacement:exact_match_count_mismatch",
        "rejection/occupied-destination:path_conflict",
        "submission/replay-identical-key:no-re-execution",
        "submission/conflicting-key-reuse:no-new-change-set",
        "concurrency/independent-batch:applied-exactly-once",
        "recovery/missing-response:recovered-through-original-key",
        "preview/final-status-replay:immutable-effect-evidence",
      ];
      for (const name of assertions) assertion(name);
      return {
        scenarioManifestSha256: "d".repeat(64),
        seedInventoryDigest: digest,
        beforeInventory: entries,
        afterInventory: entries,
        replayKeys: [
          {
            submissionKey: "cs-proof-valid-create",
            input: {
              submissionKey: "cs-proof-valid-create",
              operations: [
                {
                  operationId: "valid-create",
                  kind: "create_note",
                  path: "ChangeSetProof/Welcome.md",
                  content: "# stub\n",
                  ifExists: "reject",
                },
              ],
            },
          },
        ],
        submissions: [
          {
            submissionKeySha256: "b".repeat(64),
            changeSetId: "change-set-1",
            state: "intent_applied",
            failureCode: null,
            executed: true,
          },
        ],
        rejectionClasses: rejectionNames.map((name, index) => ({
            name, failureCode: proofs[index]!.failureCode, noMutationDigestUnchanged: true,
            binding: { runId: inventoryContext!.runId, runtimeProfileId: inventoryContext!.runtimeProfileId, candidateBundleSha256: inventoryContext!.candidateBundleSha256, vaultIdSha256: createHash("sha256").update(expectedVaultId).digest("hex") },
            beforeInventory: inventory, afterInventory: inventory, proof: proofs[index]!, status: proofs[index]!,
            eventOrder: { before: index * 5 + 3, submit: index * 5 + 4, status: index * 5 + 5, terminal: index * 5 + 6, after: index * 5 + 7 },
            terminal: { recoveryState: "none", queueLength: 0, currentExecutionId: null, writeGate: "open" },
          })),
        fifoReport: {
          concurrentSubmissions: 1,
          applied: 1,
          distinctChangeSetIds: 1,
          contendedTarget: {
            submissions: 2,
            winners: 1,
            rejected: 1,
            noPartialMutation: true,
          },
        },
        recoveryClasses: [{ name: "recovery/missing-response" }],
        immutableRecords: [
          {
            submissionKeySha256: "b".repeat(64),
            changeSetId: "change-set-1",
            state: "intent_applied",
            requestedEffectIds: ["valid-create"],
            derivedEffectIds: [],
            pathCount: 2,
          },
        ],
        residualCleanup: {
          recoveryState: "none",
          queueLength: 0,
          currentExecutionId: null,
          writeGate: "open",
        },
        assertions,
      };
    },
    runChangeSetReplay: async ({ record, assertion }) => {
      record("assertion", "stubbed-change-set-replay-began", {
        keys: 1,
      });
      assertion("stubbed-change-set-replay");
      return {
        replayReport: {
          keysReplayed: 1,
          identitiesPreserved: 1,
          recordsUnchanged: 1,
          conflictingReusesRejected: 1,
        },
        assertions: ["stubbed-change-set-replay"],
      };
    },
    runGateIsolationCorpus: async ({ record, assertion }) => {
      record("assertion", "stubbed-gate-isolation-began", {
        corpusId: "per-vault-gate-isolation-proof",
      });
      record("cleanup", "stubbed-gate-isolation-residual", {});
      for (const name of [
        "isolation/shared-key-independent-registries:distinct-change-set-ids",
        "recovery-blocked/atomic-bind-and-history:bound-intent-not-applied",
        "manual-pause/drain-and-fifo-retention:queued-order-retained",
        "incompatible/registry-never-inspected:no-key-bound",
        "gates/recovery-blocked-precedence:single-effective-gate",
      ]) assertion(name);
      return stubGateIsolationOutcome();
    },
    runRegisteredReferenceRewriteCorpus: async ({ record, assertion }) => {
      record("assertion", "stubbed-registered-reference-rewrite", {});
      record("cleanup", "stubbed-registered-reference-rewrite-cleanup", {});
      for (const name of [
        "span/bom-crlf-cjk-astral:single-verified-span",
        "reject/stale-closure:no-mutation",
        "span/duplicate-equal-spellings:untouched-bytes-exact",
        "span/second-equal-spelling-only:untouched-bytes-exact",
        "observer:no-half-written-markdown",
      ]) assertion(name);
      return stubRegisteredReferenceRewriteOutcome();
    },
    runPrivacyRecoveryAuthorityCorpus: async ({ record, assertion }) => {
      record("transport", "stubbed-privacy-recovery-connected", {});
      record("assertion", "stubbed-privacy-recovery", {});
      record("cleanup", "stubbed-privacy-recovery-cleanup", {});
      assertion("health:closed-observed-summary-only");
      return stubPrivacyRecoveryAuthorityOutcome();
    },
    runCrashRestorationRetainedAuthorityCorpus: async ({ record, assertion }) => {
      record("assertion", "stubbed-crash-restoration-retained-authority", {});
      record("cleanup", "stubbed-crash-restoration-retained-authority-cleanup", {});
      for (const name of [
        "recovery:durable-prepared-restores-whole-change-set-before-writes",
        "recovery:compare-before-restore-preserves-third-party-bytes-and-blocks-writes",
        "retention:seven-day-records-queryable-across-crash-and-reconnect",
      ]) assertion(name);
      return stubCrashRestorationRetainedAuthorityOutcome();
    },
    runReleaseLifecycleCorpus: async ({ record, assertion }) => {
      record("assertion", "stubbed-release-lifecycle", {});
      record("cleanup", "stubbed-release-lifecycle-cleanup", {});
      assertion("upgrade:drain-stop-dequeue-reject-migrate-health-recheck-maintenance-pause");
      assertion("install:verified-identity-attestation-sha-runtime-target-capacity-preflight");
      return stubReleaseLifecycleOutcome();
    },
    semanticEvidenceScenarioRunner: {
      run: async () => stubSemanticEvidenceSearchSnapshotOutcome().scenarios[0]!,
    },
    isolateSemanticEvidenceScenarios: false,
    runSemanticEvidenceSearchSnapshotCorpus: async ({ record, assertion }) => {
      record("transport", "stubbed-semantic-evidence-connected", {});
      record("assertion", "stubbed-semantic-evidence", {});
      record("cleanup", "stubbed-semantic-evidence-cleanup", {});
      for (const name of [
        "scenario:edit_body/stale_version_callback_after_newer_bytes:closed",
        "scenario:create_note/clean_convergence:closed",
        "scenario:edit_body/missing_observation_deadline:closed",
        "scenario:trash_note/delayed_probes_converge:closed",
        "transport:six-tool-inventory-without-search-snapshot",
      ]) assertion(name);
      return stubSemanticEvidenceSearchSnapshotOutcome();
    },
    timeouts: { startupMs: 5_000, stopMs: 5_000, portClosedMs: 2_000 },
    ...overrides,
  };
  return { root, candidate, options };
}

function stubSemanticEvidenceSearchSnapshotOutcome(): SemanticEvidenceSearchSnapshotOutcome {
  return {
    scenarioManifestSha256: "e".repeat(64),
    tools: [
      "vault_health",
      "vault_discover",
      "vault_read",
      "vault_continue",
      "vault_change_set_submit",
      "vault_change_set_status",
    ],
    scenarios: [
      {
        scenario: "create_note/clean_convergence",
        source: "installed-obsidian",
        mutationKind: "create_note",
        proofState: "intent_applied",
        statusProofState: "intent_applied",
        journalPhase: "COMMITTED",
        evidenceDeadlineMs: 5_000,
        successBarrierDeadlineMs: 5_000,
        evidenceSessions: [{ mode: "apply", outcome: "converged", virtualElapsedMs: 250 }],
        quietWindowResets: 1,
        acceptedSnapshotRounds: 1,
        rejectedSnapshotRounds: 1,
        successorSnapshot: {
          baselineVersion: 1,
          version: 2,
          immutable: true,
          publishedBeforeIntentApplied: true,
        },
        durableCommitBeforeIntentApplied: true,
        writesBlocked: false,
        beforeInventorySha256: "a".repeat(64),
        afterInventorySha256: "b".repeat(64),
        cleanupSucceeded: true,
      },
    ],
    coverage: {
      delayedOlderContentVersionRejected: true,
      quietWindowStabilityProven: true,
      createModifyRenameDeleteAndClosureProven: true,
      hiddenTrashRestoreUsesTargetedProbes: true,
      deadlineRollbackOrUnprovenProven: true,
      contraryEvidenceResetsQuietWindow: true,
      noPublicSearchSnapshotCapability: true,
    },
    residualCleanup: { reportsRemoved: true, residualReportPaths: [] },
    assertions: ["stubbed-semantic-evidence-corpus"],
  };
}

function stubPrivacyRecoveryAuthorityOutcome(): PrivacyRecoveryAuthorityCorpusOutcome {
  return {
    scenarioManifestSha256: "a".repeat(64),
    vaultIdSha256s: { "vault-a": "b".repeat(64), "vault-b": "c".repeat(64) },
    healthSummarySha256s: { "vault-a": "d".repeat(64), "vault-b": "e".repeat(64) },
    standardDiagnosticChecksums: 2,
    privateMarkersRejected: 4,
    contentInclusiveLocalOnly: true,
    rejectedAgentAuthorityAttempts: 5,
    agentAuthorityStateMutations: 0,
    baselineAcceptanceLocalOnly: true,
    journalPreconditionsProven: true,
    explicitResumeRequired: true,
    secondVaultUnaffected: true,
    residualPaths: [],
    assertions: ["stubbed-privacy-recovery-corpus"],
  };
}

function stubCrashRestorationRetainedAuthorityOutcome(): CrashRestorationRetainedAuthorityCorpusOutcome {
  return {
    scenarioManifestSha256: "a".repeat(64),
    records: [
      {
        mutationKind: "create_note",
        injectionPoint: "apply:after_prepared",
        fixtureSha256: "b".repeat(64),
        beforeInventorySha256: "c".repeat(64),
        afterInventorySha256: "d".repeat(64),
        proofState: "intent_not_applied",
        gate: null,
        cleanupSucceeded: true,
        verdict: "passed",
      },
    ],
    coverage: {
      everyMutationKindAtEveryDeclaredBoundary: true,
      preparedRestoresWholeChangeSet: true,
      committedSuppressesRestoration: true,
      conflictingBytesPreservedAndWritesBlocked: true,
      deterministicJournalStorageDestinationAndSemanticFaults: true,
      callbackReorderAndSemanticTimeoutProven: true,
      concurrentIdempotencyProven: true,
    },
    retainedAuthority: {
      retentionMs: 7 * 24 * 60 * 60 * 1_000,
      queryableAcrossCrashAndReconnect: true,
      completeRecordsRetained: true,
      requiredRecordsNeverBecomeOrdinaryUnknown: true,
    },
    cleanup: { residualPaths: [], vaultVisibleStaging: 0, managedTrashLeakage: 0, fixtureResidue: 0 },
    assertions: ["stubbed-crash-restoration-retained-authority-corpus"],
  };
}

function stubReleaseLifecycleOutcome(): ReleaseLifecycleCorpusOutcome {
  const release = {
    pluginId: "candidate-bridge",
    pluginVersion: "0.2.0",
    bundleSha256: "a".repeat(64),
    filesSha256: "b".repeat(64),
  };
  const inventory = {
    beforeBundleSha256: "c".repeat(64),
    afterBundleSha256: "d".repeat(64),
    beforeStateSha256: "e".repeat(64),
    afterStateSha256: "f".repeat(64),
  };
  return {
    scenarioManifestSha256: "a".repeat(64),
    releases: { install: release, previous: release, upgrade: release },
    inventories: {
      install: inventory,
      repair: inventory,
      upgrade: inventory,
      uninstall: inventory,
      purge: inventory,
    },
    migration: {
      completedPhases: ["replace", "reload", "migrate", "recovery", "health"],
      drainedCurrentItem: true,
      healthRechecked: true,
      maintenancePaused: true,
      newSubmissionsRejected: true,
      explicitOperatorResumeRequired: true,
    },
    rollback: {
      verifiedStagingBeforeReplacement: true,
      perVaultAtomicReplacement: true,
      unverifiedReleaseExecutable: false,
    },
    lifecycleStatus: {
      notInstalled: true,
      installedNotEnabled: true,
      bridgeOffline: true,
      mcpNotRegistered: true,
      identityMismatch: true,
      ready: true,
    },
    removal: {
      uninstallGuarded: true,
      purgeQueuedWorkRefused: true,
      purgeRecoveryRefused: true,
      purgeInteractive: true,
      backupVerified: true,
    },
    cleanup: { scenarios: ["install", "upgrade", "uninstall", "purge"], residualPaths: [] },
    assertions: ["stubbed-release-lifecycle-corpus"],
  };
}

function stubRegisteredReferenceRewriteOutcome(): RegisteredReferenceRewriteOutcome {
  const entry = { path: "Notes/Welcome.md", sha256: "c".repeat(64), sizeBytes: 0 };
  const move = (profile: "wikilink" | "embed" | "markdown_inline_link" | "markdown_embed") => ({
    scenario: `move/${profile}`,
    profile,
    submissionKeySha256: "d".repeat(64),
    changeSetId: `change-set-${profile}`,
    sourcePath: "Proof/Source.md",
    destinationPath: "Proof/Destination.md",
    derivedPaths: ["Proof/Referrer.md"],
    destinationContentVersionSha256: "e".repeat(64),
    rewrittenContentVersionSha256: "f".repeat(64),
    oldPathAbsent: true,
    destinationTypedMarkdown: true,
    finalBytesReread: true,
  });
  return {
    scenarioManifestSha256: "a".repeat(64),
    seedInventoryDigest: "b".repeat(64),
    beforeInventory: [entry],
    afterInventory: [entry],
    moves: [move("wikilink"), move("embed"), move("markdown_inline_link"), move("markdown_embed")],
    rawBytes: {
      fixtures: [{ scenario: "span/exact", hostModes: ["bom"], locatedReferences: 1, everyReferenceExactlyOneVerifiedSpan: true, everyUntouchedByteExact: true, finalBytesHashReread: true }],
      duplicateEqualSpellingsRewritten: 1,
      secondEqualSpellingOnly: {
        scenario: "span/second-equal-spelling-only", fixturePath: "ReferenceProof/Single/Ref.md",
        fixtureSha256: a26Digest(SINGLE_SPAN_BEFORE), beforeSha256: a26Digest(SINGLE_SPAN_BEFORE), afterSha256: a26Digest(SINGLE_SPAN_AFTER),
        referencesLocated: 2, selectedOrdinal: 2, selectedSpan: { startByte: 58, endByteExclusive: 72 },
        beforeSizeBytes: 83, afterSizeBytes: 89, untouchedPrefixSha256: a26Digest(Buffer.from(SINGLE_SPAN_BEFORE).subarray(0, 58)), untouchedSuffixSha256: a26Digest(Buffer.from(SINGLE_SPAN_BEFORE).subarray(72)),
        untouchedPrefixExact: true, untouchedSuffixExact: true, firstReferenceExact: true, fullBytesExact: true, finalBytesHashReread: true,
      },
    },
    rejections: [{ scenario: "reject/stale", failureCode: "stale_observation", registered: true, noMutationDigestUnchanged: true }],
    observer: { enabledSecondObserver: true, discoversIssued: 1, privateStagingPathsObserved: 0, halfWrittenMarkdownObserved: 0 },
    residualCleanup: { recoveryState: "none", queueLength: 0, currentExecutionId: null, writeGate: "open" },
    assertions: ["stubbed-registered-reference-rewrite-corpus"],
  };
}

function stubGateIsolationOutcome(): GateIsolationOutcome {
  const entry = { path: "Notes/Welcome.md", sha256: "c".repeat(64), sizeBytes: 0 };
  return {
    scenarioManifestSha256: "a".repeat(64),
    vaultIdSha256s: { "vault-a": "b".repeat(64), "vault-b": "b".repeat(64) },
    beforeInventories: { "vault-a": [entry], "vault-b": [entry] },
    afterInventories: { "vault-a": [entry], "vault-b": [entry] },
    submissions: [
      {
        vaultLabel: "vault-a",
        scenario: "isolation/shared-key-independent-registries",
        submissionKeySha256: "d".repeat(64),
        changeSetId: "change-set-a",
        state: "in_progress",
        historicalGate: null,
      },
      {
        vaultLabel: "vault-b",
        scenario: "isolation/shared-key-independent-registries",
        submissionKeySha256: "d".repeat(64),
        changeSetId: "change-set-b",
        state: "in_progress",
        historicalGate: null,
      },
    ],
    isolation: {
      sharedKeyIndependentRegistries: true,
      distinctChangeSetIds: true,
      crossVaultLookupRejected: true,
      queuesIndependent: true,
    },
    recoveryBlocked: {
      boundDispositions: 2,
      replayAfterRecovery: 1,
      conflictingReuseRejected: 1,
      freshKeyRenewed: 1,
      otherGatesLeftUnbound: 2,
    },
    manualPause: {
      drainedInFlightToTrustworthyEnd: true,
      fifoRetained: true,
      newUnboundRejected: 1,
      observationalContentAvailable: true,
    },
    incompatible: {
      registryInspected: 0,
      submissionKeysBound: 0,
      compatibleSessionUnaffected: true,
    },
    gateHistory: [
      {
        sequence: 1,
        vaultLabel: "vault-a",
        scenario: "stubbed-gate-isolation",
        outcome: "observed",
        effectiveGate: null,
        recoveryState: "none",
        writeState: "writable",
      },
    ],
    residualCleanup: {
      "vault-a": { recoveryState: "none", writeGate: "open", writeState: "writable" },
      "vault-b": { recoveryState: "none", writeGate: "open", writeState: "writable" },
    },
    assertions: ["stubbed-gate-isolation-corpus"],
  };
}

describe("installed-runtime harness orchestration", () => {
  it("cleans a stopped gate runtime when its running profile is rejected", async () => {
    const { root, candidate } = await arrangeRun("gate-profile-cleanup");
    const { verifyReleaseBundle } = await import("../src/release/verify-release-bundle.js");
    const verified = await verifyReleaseBundle({ bundleDirectory: candidate,
      expectedTag: CANDIDATE_TAG, expectedPluginId: "candidate-bridge" });
    let stopped = false;
    let cleanupCalls = 0;
    const result = await runInstalledGateIsolationCorpus({
      runId: "gate-profile-cleanup", workingDirectory: root, candidate: verified,
      processControl: { start: async () => ({ pid: 50001, stop: async () => { stopped = true; } }) },
      client: createLoopbackMcpClient(), configDirectoryName: ".obsidian",
      timeouts: { startupMs: 10, stopMs: 10, portClosedMs: 10 },
      profileName: INNER_PROFILE.name, profile: INNER_PROFILE,
      probe: { ...probe(), probeRunning: async () => ({ ...MATCHING_OBSERVED, nodeVersion: "0.0.0" }) },
      provisionVault: provisionTestVault,
      cleanupVault: async vault => { expect(stopped).toBe(true); cleanupCalls += 1; return cleanupTestVault(vault); },
      record: () => undefined, assertion: () => undefined,
    });
    expect(result.verdict).toBe("failed");
    expect(cleanupCalls).toBe(1);
    expect(result.cleanup["vault-a"]).toEqual({ attempted: true, residualPaths: [] });
  });

  it("runs installed gate isolation on two generated Vaults and cleans both after process stop", async () => {
    const { root, candidate } = await arrangeRun("run-gate-isolation-installed");
    const verified = await import("../src/release/verify-release-bundle.js").then(({ verifyReleaseBundle }) =>
      verifyReleaseBundle({
        bundleDirectory: candidate,
        expectedTag: CANDIDATE_TAG,
        expectedPluginId: "candidate-bridge",
      }),
    );
    const starts: string[] = [];
    const gateAssertions: string[] = [];
    const processControl: ObsidianProcessControl = {
      async start({ vaultPath }) {
        starts.push(vaultPath);
        const dataPath = join(vaultPath, ".obsidian", "plugins", "candidate-bridge", "data.json");
        let stored: PersistedBridgeSettings | undefined;
        const stateDirectory = join(vaultPath, ".llm-wiki");
        const execution = await createFileSystemChangeSetExecutionAdapter({
          journalPath: join(stateDirectory, "recovery-journal.bin"),
          slotCapacity: 16 * 1024,
          host: await createNodeFileSystemChangeSetHost({
            basePath: vaultPath,
            stateDirectory,
            referenced: async () => false,
            awaitSemanticEvidence: async () => undefined,
            publishSearchSnapshot: async () => undefined,
          }),
        });
        const runtime = new ManagedVaultBridgeRuntime({
          vault: { name: basename(vaultPath), path: vaultPath },
          settings: {
            load: async () => stored,
            save: async (settings) => {
              stored = settings;
              await mkdir(join(dataPath, ".."), { recursive: true });
              await writeFile(dataPath, JSON.stringify(settings), "utf8");
            },
          },
          readDataSource: {
            readBinary: execution.readBinary!,
            parseFrontmatter: () => null,
            headings: () => null,
          },
          searchDataSource: {
            listMarkdownPaths: async () => (await readdir(join(vaultPath, "Notes"))).map(name => `Notes/${name}`),
            readBinary: execution.readBinary!,
          },
          changeSetDataSource: {
            readBinary: execution.readBinary!,
            pathKind: execution.pathKind,
            isContained: async () => true,
          },
          changeSetExecution: execution,
          createBridge: (options) => createBridgeInstance(options),
        });
        liveRuntimes.push(runtime);
        await runtime.load();
        return { pid: 50_000 + starts.length, stop: async () => runtime.unload() };
      },
    };
    const result = await runInstalledGateIsolationCorpus({
      runId: "run-gate-isolation-installed",
      workingDirectory: root,
      candidate: verified,
      processControl,
      client: createLoopbackMcpClient(),
      configDirectoryName: ".obsidian",
      timeouts: { startupMs: 5_000, stopMs: 5_000, portClosedMs: 2_000 },
      profileName: INNER_PROFILE.name,
      profile: INNER_PROFILE,
      probe: { ...probe(), probeRunning: async () => MATCHING_OBSERVED },
      provisionVault: provisionTestVault,
      cleanupVault: cleanupTestVault,
      record: () => undefined,
      assertion: name => gateAssertions.push(name),
    });
    expect(result.verdict, result.failure).toBe("partial");
    expect(gateAssertions).toEqual(["two-vault-installed-registry-isolation", "two-vault-installed-healthy-gate-row"]);
    expect(result.failure).toBeNull();
    expect(result.result?.scope).toBe("two-vault-registry-isolation");
    expect(result.result?.crossVaultLookupsAbsent).toBe(true);
    expect(starts).toHaveLength(2);
    expect(new Set(starts).size).toBe(2);
    expect(result.cleanup["vault-a"]?.residualPaths).toEqual([]);
    expect(result.cleanup["vault-b"]?.residualPaths).toEqual([]);
    for (const path of starts) await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
  }, 30_000);

  it("checks running versions before executing any acceptance corpus", async () => {
    let corpusCalls = 0;
    const { options } = await arrangeRun("run-live-version-mismatch", {
      probe: {
        probe: async () => ({ ...MATCHING_OBSERVED, obsidianVersion: undefined,
          electronVersion: undefined, nodeVersion: undefined }),
        probeRunning: async () => ({ ...MATCHING_OBSERVED, electronVersion: "wrong-runtime" }),
      },
      runPublicWireCorpus: async () => { corpusCalls += 1; throw new Error("must not run"); },
    });
    const result = await runInstalledRuntimeHarness(options);
    expect(result.failure).toMatchObject({ stage: "preflight", code: "profile_mismatch" });
    expect(result.evidence.profile.observed?.electronVersion).toBe("wrong-runtime");
    expect(result.evidence.profile.mismatches).toEqual([
      { field: "versions.electron", expected: "0.0.0-inner", actual: "wrong-runtime" },
    ]);
    expect(corpusCalls).toBe(0);
    expect(result.evidence.cleanup?.residualPaths).toEqual([]);
  });

  it("refuses missing running versions even when the registration claims a match", async () => {
    const { options } = await arrangeRun("run-live-version-missing", {
      probe: {
        probe: async () => MATCHING_OBSERVED,
        probeRunning: async () => ({ ...MATCHING_OBSERVED, obsidianVersion: undefined }),
      },
    });
    const result = await runInstalledRuntimeHarness(options);
    expect(result.verdict).toBe("invalid");
    expect(result.evidence.profile.mismatches).toEqual([
      { field: "versions.obsidian", expected: "0.0.0-inner", actual: null },
    ]);
    expect(result.evidence.publicWireCorpus).toBeNull();
  });

  it("fails closed before launch when the private acceptance driver is not wired", async () => {
    const { options } = await arrangeRun("run-missing-acceptance-driver", {
      prepareInstalledRuntimeAcceptanceDriver: undefined,
    });

    const result = await runInstalledRuntimeHarness(options);

    expect(result.verdict).toBe("invalid");
    expect(result.failure).toMatchObject({
      stage: "acceptance_driver",
      code: "acceptance_driver_unavailable",
    });
    expect(result.evidence.observations).toEqual([]);
  });

  it("fails closed when a required acceptance corpus runner is not wired", async () => {
    const { options } = await arrangeRun("run-missing-acceptance-runner", {
      runRegisteredReferenceRewriteCorpus: undefined,
    });
    const result = await runInstalledRuntimeHarness(options);
    expect(result.verdict).toBe("failed");
    expect(result.failure).toMatchObject({
      stage: "registered_reference_rewrite_corpus",
      code: "registered_reference_rewrite_corpus_failed",
    });
    expect(result.evidence.registeredReferenceRewriteCorpus).toBeNull();
  });

  it("proves candidate load, health, restart, and cleanup with passing evidence", async () => {
    const { root, options } = await arrangeRun("run-pass");
    const processControl = options.processControl as ReturnType<
      typeof createFakeObsidianProcessControl
    >;

    const result = await runInstalledRuntimeHarness(options);

    expect(result.verdict).toBe("passed");
    expect(result.failure).toBeNull();
    expect(processControl.starts).toBe(2);

    const evidence = parseEvidence(await readFile(result.evidencePath, "utf8"));
    expect(evidence).toEqual(result.evidence);
    expect(evidence.profile.name).toBe(INNER_PROFILE.name);
    expect(evidence.profile.mismatches).toEqual([]);
    expect(evidence.candidate?.pluginId).toBe("candidate-bridge");
    expect(evidence.bridgeIdentity?.vaultId).toMatch(/^[0-9a-f-]{36}$/u);
    expect(evidence.observations.map((observation) => observation.phase)).toEqual([
      "initial",
      "after_restart",
    ]);
    expect(evidence.beforeInventory?.map((entry) => entry.path)).toContain(
      ".obsidian/plugins/candidate-bridge/main.js",
    );
    expect(evidence.inventoryComparison).not.toBeNull();
    expect(evidence.publicWireCorpus?.verdict).toBe("passed");
    expect(evidence.changeSetCorpus?.verdict).toBe("passed");
    expect(evidence.changeSetCorpus?.corpusId).toBe("change-set-submission-proof");
    expect(evidence.changeSetCorpus?.replay.keysReplayed).toBeGreaterThan(0);
    expect(evidence.gateIsolationCorpus?.verdict).toBe("passed");
    expect(evidence.gateIsolationCorpus?.corpusId).toBe("per-vault-gate-isolation-proof");
    expect(evidence.gateIsolationCorpus?.vaults).toHaveLength(2);
    expect(evidence.semanticEvidenceSearchSnapshotCorpus?.verdict).toBe("passed");
    expect(evidence.semanticEvidenceSearchSnapshotCorpus?.scenarios).toHaveLength(1);
    expect(evidence.privacyRecoveryAuthorityCorpus?.verdict).toBe("passed");
    expect(evidence.privacyRecoveryAuthorityCorpus?.authority.agentStateMutations).toBe(0);
    expect(evidence.releaseLifecycleCorpus?.verdict).toBe("passed");
    expect(evidence.releaseLifecycleCorpus?.migration.maintenancePaused).toBe(true);
    expect(evidence.cleanup).toEqual({ attempted: true, residualPaths: [] });

    // The generated roots are gone and nothing private leaked into evidence.
    await expect(
      stat(join(root, `${TEST_VAULT_DIRECTORY_PREFIX}run-pass`)),
    ).rejects.toMatchObject({ code: "ENOENT" });
    const serialized = await readFile(result.evidencePath, "utf8");
    expect(serialized).not.toContain(root);
    expect(serialized).not.toContain("This generated note seeds the dedicated test Vault");
  });

  it("waits for Search Snapshot readiness before invoking acceptance corpora", async () => {
    const wire = createLoopbackMcpClient();
    let observations = 0;
    let corpusStarted = false;
    const { options } = await arrangeRun("run-delayed-snapshot");
    const publicCorpus = options.runPublicWireCorpus!;
    const result = await runInstalledRuntimeHarness({
      ...options,
      client: {
        async observeHealth(endpoint, vaultId) {
          const observation = await wire.observeHealth(endpoint, vaultId);
          observations += 1;
          if (observations === 1) {
            return {
              ...observation,
              health: {
                ...observation.health,
                readiness: { ...observation.health.readiness, searchSnapshot: "building" },
              },
            };
          }
          return observation;
        },
      },
      runPublicWireCorpus: async (request) => {
        expect(observations).toBeGreaterThanOrEqual(2);
        corpusStarted = true;
        return publicCorpus(request);
      },
    });
    expect(corpusStarted).toBe(true);
    expect(result.verdict).toBe("passed");
    expect(result.evidence.observations[0]?.readiness.searchSnapshot).toBe("ready");
  });

  it("keeps the Bridge identity stable across the controlled restart", async () => {
    const { options } = await arrangeRun("run-stable");
    const result = await runInstalledRuntimeHarness(options);
    expect(result.verdict).toBe("passed");
    const [initial, restarted] = result.evidence.observations;
    expect(initial).toBeDefined();
    expect(restarted).toBeDefined();
    expect(result.evidence.bridgeIdentity?.vaultId).toMatch(/^.+$/u);
    expect(initial?.healthSha256).toMatch(/^[a-f0-9]{64}$/u);
  });
});

describe("installed-runtime harness failure projection", () => {
  it("records invalid evidence for an unregistered profile", async () => {
    const { root, options } = await arrangeRun("run-unregistered", {
      profileName: "NOT-REGISTERED",
    });
    const result = await runInstalledRuntimeHarness(options);
    expect(result.verdict).toBe("invalid");
    expect(result.failure).toMatchObject({
      stage: "preflight",
      code: "unregistered_profile",
    });
    const evidence = parseEvidence(await readFile(result.evidencePath, "utf8"));
    expect(evidence.verdict).toBe("invalid");
    expect(evidence.observations).toEqual([]);
    expect(await readFile(result.evidencePath, "utf8")).not.toContain(root);
  });

  it("records invalid evidence when the probed host mismatches the registered profile", async () => {
    const { options } = await arrangeRun("run-mismatch", {
      probe: probe({ nodeVersion: "22.0.0", capabilities: [] }),
    });
    const result = await runInstalledRuntimeHarness(options);
    expect(result.verdict).toBe("invalid");
    expect(result.failure).toMatchObject({ stage: "preflight", code: "profile_mismatch" });
    expect(result.evidence.profile.mismatches).toEqual([
      { field: "versions.node", expected: "0.0.0-inner", actual: "22.0.0" },
      { field: "capabilities", expected: "loopback_http", actual: "" },
    ]);
  });

  it("records invalid evidence when the profile probe itself fails", async () => {
    const { options } = await arrangeRun("run-probe-fails", {
      probe: {
        probe: async () => {
          throw new Error("probe transport down");
        },
      },
    });
    const result = await runInstalledRuntimeHarness(options);
    expect(result.verdict).toBe("invalid");
    expect(result.failure).toMatchObject({ stage: "preflight", code: "profile_probe_failed" });
    expect(result.evidence.profile.observed).toBeNull();
  });

  it("refuses to overwrite an existing Vault root", async () => {
    const { root, options } = await arrangeRun("run-existing");
    await provisionTestVault({ workingDirectory: root, runId: "run-existing" });
    const result = await runInstalledRuntimeHarness(options);
    expect(result.verdict).toBe("invalid");
    expect(result.failure).toMatchObject({ stage: "provision", code: "vault_root_exists" });
    // The pre-existing root was left untouched: no cleanup deletion, no evidence of removal.
    expect(result.evidence.cleanup).toBeNull();
    await stat(join(root, `${TEST_VAULT_DIRECTORY_PREFIX}run-existing`));
  });

  it("records invalid evidence for a candidate that fails integrity verification", async () => {
    const { root, candidate, options } = await arrangeRun("run-corrupt-candidate");
    await writeCandidateBundle(candidate, { corruptChecksum: true });
    const result = await runInstalledRuntimeHarness(options);
    expect(result.verdict).toBe("invalid");
    expect(result.failure).toMatchObject({
      stage: "candidate",
      code: "candidate_checksum_mismatch",
    });
    expect(result.evidence.candidate).toBeNull();
    await expect(stat(join(root, `${TEST_VAULT_DIRECTORY_PREFIX}run-corrupt-candidate`))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("records invalid evidence for a candidate without attestation claims", async () => {
    const { root, candidate, options } = await arrangeRun("run-unattested-candidate");
    await writeCandidateBundle(candidate, { withAttestation: false });
    const result = await runInstalledRuntimeHarness(options);
    expect(result.verdict).toBe("invalid");
    expect(result.failure).toMatchObject({
      stage: "candidate",
      code: "release_attestation_absent",
    });
    expect(result.evidence.candidate).toBeNull();
    await expect(stat(join(root, `${TEST_VAULT_DIRECTORY_PREFIX}run-unattested-candidate`))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("runs every installed Semantic Evidence scenario in a fresh generated runtime", async () => {
    const processControl = createFakeObsidianProcessControl();
    let scenarioRuns = 0;
    const { options } = await arrangeRun("run-semantic-isolation", {
      processControl,
      isolateSemanticEvidenceScenarios: true,
      semanticEvidenceScenarioRunner: {
        run: async () => {
          scenarioRuns += 1;
          return stubSemanticEvidenceSearchSnapshotOutcome().scenarios[0]!;
        },
      },
      runSemanticEvidenceSearchSnapshotCorpus: async ({ scenarioRunner, record, assertion }) => {
        for (const name of [
          "scenario:edit_body/stale_version_callback_after_newer_bytes:closed",
          "scenario:create_note/clean_convergence:closed",
          "scenario:edit_body/missing_observation_deadline:closed",
          "scenario:trash_note/delayed_probes_converge:closed",
          "transport:six-tool-inventory-without-search-snapshot",
        ]) assertion(name);
        record("assertion", "isolated-semantic-evidence", {});
        const first = await scenarioRunner.run({
          scenario: "edit_body/contrary_third_party_blocks_writes",
          endpoint: new URL("http://127.0.0.1:1/mcp"),
          expectedVaultId: "primary-vault",
          workingDirectory: ".",
        });
        const second = await scenarioRunner.run({
          scenario: "edit_multi_frontmatter/reordered_cache_callbacks",
          endpoint: new URL("http://127.0.0.1:1/mcp"),
          expectedVaultId: "primary-vault",
          workingDirectory: ".",
        });
        const outcome = stubSemanticEvidenceSearchSnapshotOutcome();
        return { ...outcome, scenarios: [first, second] };
      },
    });

    const result = await runInstalledRuntimeHarness(options);

    expect(result.failure).toBeNull();
    expect(scenarioRuns).toBe(2);
    expect(processControl.starts).toBe(4);
  });

  it("invalidates evidence when isolated Vault cleanup throws", async () => {
    const { options } = await arrangeRun("run-isolated-cleanup-throws", {
      cleanupVault: async vault => {
        if (vault.vaultPath.endsWith("-semantic-1")) throw new Error("cleanup refused");
        return { attempted: true, residualPaths: [] };
      },
      isolateSemanticEvidenceScenarios: true,
      semanticEvidenceScenarioRunner: { run: async () => stubSemanticEvidenceSearchSnapshotOutcome().scenarios[0]! },
      runSemanticEvidenceSearchSnapshotCorpus: async ({ scenarioRunner }) => {
        await scenarioRunner.run({ scenario: "create_note/clean_convergence",
          endpoint: new URL("http://127.0.0.1:1/mcp"), expectedVaultId: "primary", workingDirectory: "." });
        return stubSemanticEvidenceSearchSnapshotOutcome();
      },
    });
    const result = await runInstalledRuntimeHarness(options);
    expect(result.failure?.stage).toBe("semantic_evidence_search_snapshot_corpus");
    expect(result.verdict).toBe("invalid");
    expect(result.evidence.cleanup?.residualPaths).toContain("isolated-runtime/");
  });

  it("rejects an isolated runtime version mismatch before requesting its scenario", async () => {
    let runs = 0;
    const { options } = await arrangeRun("run-isolated-version-mismatch", {
      probe: {
        probe: async () => MATCHING_OBSERVED,
        probeRunning: async request => request.vaultPath.endsWith("-semantic-1")
          ? { ...MATCHING_OBSERVED, electronVersion: "wrong-runtime" } : MATCHING_OBSERVED,
      },
      isolateSemanticEvidenceScenarios: true,
      semanticEvidenceScenarioRunner: { run: async () => { runs += 1; return stubSemanticEvidenceSearchSnapshotOutcome().scenarios[0]!; } },
      runSemanticEvidenceSearchSnapshotCorpus: async ({ scenarioRunner }) => {
        await scenarioRunner.run({ scenario: "create_note/clean_convergence",
          endpoint: new URL("http://127.0.0.1:1/mcp"), expectedVaultId: "primary", workingDirectory: "." });
        return stubSemanticEvidenceSearchSnapshotOutcome();
      },
    });
    const result = await runInstalledRuntimeHarness(options);
    expect(result.failure?.stage).toBe("semantic_evidence_search_snapshot_corpus");
    expect(runs).toBe(0);
    expect(result.evidence.semanticEvidenceSearchSnapshotCorpus).toBeNull();
    expect(result.evidence.cleanup?.residualPaths).toEqual([]);
  });

  it("retains an isolated Vault when startup shutdown cannot be confirmed", async () => {
    const control = createFakeObsidianProcessControl();
    const cleaned: string[] = [];
    const { options } = await arrangeRun("run-isolated-start-cleanup-fails", {
      processControl: { start: async request => {
        if (request.vaultPath.endsWith("-semantic-1")) {
          throw new ObsidianProcessError("startup group survived", "obsidian_stop_failed");
        }
        return control.start(request);
      } },
      cleanupVault: async vault => { cleaned.push(vault.vaultPath); return { attempted: true, residualPaths: [] }; },
      isolateSemanticEvidenceScenarios: true,
      semanticEvidenceScenarioRunner: { run: async () => stubSemanticEvidenceSearchSnapshotOutcome().scenarios[0]! },
      runSemanticEvidenceSearchSnapshotCorpus: async ({ scenarioRunner }) => {
        await scenarioRunner.run({ scenario: "create_note/clean_convergence",
          endpoint: new URL("http://127.0.0.1:1/mcp"), expectedVaultId: "primary", workingDirectory: "." });
        return stubSemanticEvidenceSearchSnapshotOutcome();
      },
    });
    const result = await runInstalledRuntimeHarness(options);
    expect(cleaned.some(path => path.endsWith("-semantic-1"))).toBe(false);
    expect(result.verdict).toBe("invalid");
    expect(result.evidence.cleanup?.residualPaths).toContain("isolated-runtime/");
  });

  it("retains an isolated scenario Vault when its process cannot stop", async () => {
    const control = createFakeObsidianProcessControl();
    const cleaned: string[] = [];
    const { options } = await arrangeRun("run-isolated-stop-fails", {
      processControl: { start: async request => {
        const handle = await control.start(request);
        return request.vaultPath.endsWith("-semantic-1")
          ? { ...handle, stop: async () => { throw new Error("isolated stop failed"); } }
          : handle;
      } },
      cleanupVault: async vault => {
        cleaned.push(vault.vaultPath);
        return { attempted: true, residualPaths: [] };
      },
      isolateSemanticEvidenceScenarios: true,
      semanticEvidenceScenarioRunner: { run: async () => stubSemanticEvidenceSearchSnapshotOutcome().scenarios[0]! },
      runSemanticEvidenceSearchSnapshotCorpus: async ({ scenarioRunner }) => {
        await scenarioRunner.run({ scenario: "create_note/clean_convergence",
          endpoint: new URL("http://127.0.0.1:1/mcp"), expectedVaultId: "primary", workingDirectory: "." });
        return stubSemanticEvidenceSearchSnapshotOutcome();
      },
    });
    const result = await runInstalledRuntimeHarness(options);
    expect(result.failure?.stage).toBe("semantic_evidence_search_snapshot_corpus");
    expect(cleaned.some(path => path.endsWith("-semantic-1"))).toBe(false);
    expect(result.verdict).toBe("invalid");
    expect(result.evidence.cleanup?.residualPaths).not.toEqual([]);
  });

  it("retains generated roots when startup cleanup cannot confirm process shutdown", async () => {
    let cleaned = false;
    const { options } = await arrangeRun("run-start-cleanup-fails", {
      processControl: createFakeObsidianProcessControl({
        startError: new ObsidianProcessError("startup process group survived", "obsidian_stop_failed"),
      }),
      cleanupVault: async () => { cleaned = true; return { attempted: true, residualPaths: [] }; },
    });
    const result = await runInstalledRuntimeHarness(options);
    expect(result.failure?.code).toBe("obsidian_stop_failed");
    expect(cleaned).toBe(false);
    expect(result.verdict).toBe("invalid");
    expect(result.evidence.cleanup?.residualPaths).not.toEqual([]);
  });

  it("records failed evidence when Obsidian cannot start", async () => {
    const { options } = await arrangeRun("run-start-fails", {
      processControl: createFakeObsidianProcessControl({
        startError: new ObsidianProcessError("spawn ENOENT", "obsidian_start_failed"),
      }),
    });
    const result = await runInstalledRuntimeHarness(options);
    expect(result.verdict).toBe("failed");
    expect(result.failure).toMatchObject({
      stage: "obsidian_start",
      code: "obsidian_start_failed",
    });
    expect(result.evidence.cleanup).toEqual({ attempted: true, residualPaths: [] });
  });

  it("records invalid evidence when residual content survives after an earlier failure", async () => {
    const { options } = await arrangeRun("run-residual-after-failure", {
      processControl: createFakeObsidianProcessControl({
        startError: new ObsidianProcessError("spawn ENOENT", "obsidian_start_failed"),
      }),
      cleanupVault: async () => ({ attempted: true, residualPaths: ["Notes/Welcome.md"] }),
    });
    const result = await runInstalledRuntimeHarness(options);
    // The residual content invalidates the run even though a candidate-class
    // failure was recorded first; a failed verdict would hide the residue.
    expect(result.verdict).toBe("invalid");
    expect(result.evidence.cleanup).toEqual({
      attempted: true,
      residualPaths: ["Notes/Welcome.md"],
    });
  });

  it("records failed evidence when the Bridge never becomes ready", async () => {
    const { options } = await arrangeRun("run-no-readiness", {
      processControl: createFakeObsidianProcessControl({ skipPersist: true }),
      timeouts: { startupMs: 600, stopMs: 2_000, portClosedMs: 1_000 },
    });
    const result = await runInstalledRuntimeHarness(options);
    expect(result.verdict).toBe("failed");
    expect(result.failure).toMatchObject({
      stage: "bridge_readiness",
      code: "bridge_readiness_timeout",
    });
  });

  it("records failed evidence when the health result is schema-invalid", async () => {
    const client: LoopbackMcpClient = {
      observeHealth: async () => {
        throw new HealthObservationError("schema rejected", "health_schema_invalid");
      },
    };
    const { options } = await arrangeRun("run-bad-health", { client });
    const result = await runInstalledRuntimeHarness(options);
    expect(result.verdict).toBe("failed");
    expect(result.failure).toMatchObject({
      stage: "health_initial",
      code: "health_schema_invalid",
    });
  });

  it("records failed evidence when the connected Bridge belongs to another Vault", async () => {
    const client: LoopbackMcpClient = {
      observeHealth: async () => {
        throw new HealthObservationError("wrong vault", "identity_mismatch");
      },
    };
    const { options } = await arrangeRun("run-wrong-vault", { client });
    const result = await runInstalledRuntimeHarness(options);
    expect(result.verdict, JSON.stringify({ failure: result.failure, cleanup: result.evidence.cleanup })).toBe("failed");
    expect(result.failure).toMatchObject({
      stage: "health_initial",
      code: "identity_mismatch",
    });
  });

  it("records failed evidence when the Bridge identity changes across restart", async () => {
    const { options } = await arrangeRun("run-identity-flip", {
      processControl: createFakeObsidianProcessControl({ forgetOnSecondStart: true }),
    });
    const result = await runInstalledRuntimeHarness(options);
    expect(result.verdict).toBe("failed");
    expect(result.failure).toMatchObject({
      stage: "health_restart",
      code: "restart_identity_mismatch",
    });
    expect(result.evidence.observations.map((observation) => observation.phase)).toEqual([
      "initial",
    ]);
  });

  it("records failed evidence when the Bridge listener survives the controlled stop", async () => {
    const { options } = await arrangeRun("run-port-survives", {
      processControl: createFakeObsidianProcessControl({ leavePortOpenOnStop: true }),
      timeouts: { startupMs: 5_000, stopMs: 2_000, portClosedMs: 400 },
    });
    const result = await runInstalledRuntimeHarness(options);
    expect(result.verdict).toBe("invalid");
    expect(result.failure).toMatchObject({
      stage: "obsidian_stop",
      code: "bridge_still_reachable",
    });
  });

  it("records failed evidence when the controlled stop itself fails", async () => {
    let cleanupCalls = 0;
    const { options } = await arrangeRun("run-stop-fails", {
      processControl: createFakeObsidianProcessControl({
        stopError: new ObsidianProcessError("taskkill refused", "obsidian_stop_failed"),
      }),
      cleanupVault: async () => { cleanupCalls += 1; return { attempted: true, residualPaths: [] }; },
      timeouts: { startupMs: 5_000, stopMs: 500, portClosedMs: 300 },
    });
    const result = await runInstalledRuntimeHarness(options);
    expect(result.verdict).toBe("invalid");
    expect(cleanupCalls).toBe(0);
    expect(result.evidence.cleanup?.residualPaths).not.toEqual([]);
    expect(result.failure).toMatchObject({
      stage: "obsidian_stop",
      code: "obsidian_stop_failed",
    });
  });

  it("records invalid evidence, not a green skip, when residual test content survives cleanup", async () => {
    const { options } = await arrangeRun("run-residual", {
      cleanupVault: async () => ({ attempted: true, residualPaths: ["Notes/Welcome.md"] }),
    });
    const result = await runInstalledRuntimeHarness(options);
    expect(result.verdict).toBe("invalid");
    expect(result.failure).toMatchObject({
      stage: "cleanup",
      code: "residual_test_content",
    });
    expect(result.evidence.observations).toHaveLength(2);
  });

  it("records invalid evidence when cleanup itself fails", async () => {
    const { options } = await arrangeRun("run-cleanup-fails", {
      cleanupVault: async () => {
        throw new Error("permission denied");
      },
    });
    const result = await runInstalledRuntimeHarness(options);
    expect(result.verdict).toBe("invalid");
    expect(result.failure).toMatchObject({ stage: "cleanup", code: "cleanup_failed" });
  });

  it("records invalid evidence when the inventory snapshot fails", async () => {
    const { options } = await arrangeRun("run-inventory-fails", {
      snapshotVaultInventory: async () => {
        throw new Error("inventory unreadable");
      },
    });
    const result = await runInstalledRuntimeHarness(options);
    expect(result.verdict).toBe("invalid");
    expect(result.failure).toMatchObject({ stage: "inventory_before", code: "inventory_failed" });
  });

  it("does not promote a partial installed slice into full gate evidence", async () => {
    const { options } = await arrangeRun("run-gate-partial-not-full", {
      runGateIsolationCorpus: async () => ({
        scope: "two-vault-registry-isolation",
        result: null,
        verdict: "partial",
        cleanup: { "vault-a": null, "vault-b": null },
        failure: null,
        candidateBundleSha256: "a".repeat(64),
        profileName: INNER_PROFILE.name,
        runtimeMismatches: [],
        provenance: { vaults: [] },
      }),
    });
    const result = await runInstalledRuntimeHarness(options);
    expect(result.verdict).toBe("failed");
    expect(result.failure).toMatchObject({ stage: "gate_isolation_corpus", code: "gate_isolation_corpus_failed" });
    expect(result.evidence.gateIsolationCorpus).toBeNull();
  });


  it("records failed evidence when the gate-isolation corpus fails", async () => {
    const { root, options } = await arrangeRun("run-gate-isolation-fails", {
      runGateIsolationCorpus: async () => {
        throw new Error("gate-isolation corpus failed");
      },
    });
    const result = await runInstalledRuntimeHarness(options);
    expect(result.verdict).toBe("failed");
    expect(result.failure).toMatchObject({
      stage: "gate_isolation_corpus",
      code: "gate_isolation_corpus_failed",
    });
    const evidence = parseEvidence(await readFile(result.evidencePath, "utf8"));
    expect(evidence.verdict).toBe("failed");
    expect(evidence.gateIsolationCorpus).toBeNull();
    expect(evidence.semanticEvidenceSearchSnapshotCorpus?.verdict).toBe("passed");
    expect(evidence.semanticEvidenceSearchSnapshotCorpus?.scenarios).toHaveLength(1);
    expect(await readFile(result.evidencePath, "utf8")).not.toContain(root);
  });

  it("records failed evidence when the registered-reference rewrite corpus fails", async () => {
    const { root, options } = await arrangeRun("run-registered-reference-fails", {
      runRegisteredReferenceRewriteCorpus: async () => {
        throw new Error("registered-reference rewrite corpus failed");
      },
    });
    const result = await runInstalledRuntimeHarness(options);
    expect(result.verdict).toBe("failed");
    expect(result.failure).toMatchObject({
      stage: "registered_reference_rewrite_corpus",
      code: "registered_reference_rewrite_corpus_failed",
    });
    const evidence = parseEvidence(await readFile(result.evidencePath, "utf8"));
    expect(evidence.verdict).toBe("failed");
    expect(evidence.registeredReferenceRewriteCorpus).toBeNull();
    expect(await readFile(result.evidencePath, "utf8")).not.toContain(root);
  });

  it("records failed evidence when the semantic-evidence corpus fails", async () => {
    const { root, options } = await arrangeRun("run-semantic-evidence-fails", {
      runSemanticEvidenceSearchSnapshotCorpus: async () => {
        throw new Error("semantic-evidence corpus failed");
      },
    });
    const result = await runInstalledRuntimeHarness(options);
    expect(result.verdict).toBe("failed");
    expect(result.failure).toMatchObject({
      stage: "semantic_evidence_search_snapshot_corpus",
      code: "semantic_evidence_search_snapshot_corpus_failed",
    });
    const evidence = parseEvidence(await readFile(result.evidencePath, "utf8"));
    expect(evidence.verdict).toBe("failed");
    expect(evidence.semanticEvidenceSearchSnapshotCorpus).toBeNull();
    expect(await readFile(result.evidencePath, "utf8")).not.toContain(root);
  });

  it("records failed evidence when the privacy/recovery corpus fails", async () => {
    const { root, options } = await arrangeRun("run-privacy-recovery-fails", {
      runPrivacyRecoveryAuthorityCorpus: async () => {
        throw new Error("privacy/recovery corpus failed");
      },
    });
    const result = await runInstalledRuntimeHarness(options);
    expect(result.verdict).toBe("failed");
    expect(result.failure).toMatchObject({
      stage: "privacy_recovery_authority_corpus",
      code: "privacy_recovery_authority_corpus_failed",
    });
    const evidence = parseEvidence(await readFile(result.evidencePath, "utf8"));
    expect(evidence.verdict).toBe("failed");
    expect(evidence.privacyRecoveryAuthorityCorpus).toBeNull();
    expect(await readFile(result.evidencePath, "utf8")).not.toContain(root);
  });

  it("does not promote an installed privacy boundary slice to full authority evidence", async () => {
    const { options } = await arrangeRun("run-privacy-partial", {
      runPrivacyRecoveryAuthorityCorpus: async () => ({
        scope: "two-vault-agent-authority-boundary", verdict: "partial", candidateBundleSha256: "a".repeat(64), profileName: INNER_PROFILE.name,
        vaultIdsSha256: { "vault-a": "b".repeat(64), "vault-b": "c".repeat(64) }, rejectedAuthorityAttempts: 8,
        observedHealthUnchanged: true, provenance: [], humanRequired: ["diagnostic-bundles", "recovery-baseline", "resume-writes"],
      }),
    });
    const result = await runInstalledRuntimeHarness(options);
    expect(result.failure).toMatchObject({ stage: "privacy_recovery_authority_corpus", code: "privacy_recovery_authority_corpus_failed" });
    expect(result.evidence.privacyRecoveryAuthorityCorpus).toBeNull();
    expect(result.evidence.acceptanceMatrix).toBeNull();
    expect(result.evidence.cleanup?.residualPaths).toEqual([]);
  });

  it("fails closed without an installed crash runner instead of invoking the Node crash corpus", async () => {
    const simulator = vi.spyOn(crashCorpus, "runCrashRestorationRetainedAuthorityCorpus").mockRejectedValue(new Error("Node simulator invoked"));
    try {
      const { options } = await arrangeRun("run-crash-installed-missing");
      const { runCrashRestorationRetainedAuthorityCorpus: _installed, ...withoutRunner } = options;
      const result = await runInstalledRuntimeHarness(withoutRunner);
      expect(result.failure).toMatchObject({
        stage: "crash_restoration_retained_authority_corpus", code: "crash_restoration_retained_authority_corpus_failed",
      });
      expect(simulator).not.toHaveBeenCalled();
      expect(result.evidence.crashRestorationRetainedAuthorityCorpus).toBeNull();
      expect(result.evidence.cleanup?.residualPaths).toEqual([]);
    } finally { simulator.mockRestore(); }
  });

  it("records failed evidence when the crash-restoration retained-authority corpus fails", async () => {
    const { root, options } = await arrangeRun("run-crash-restoration-fails", {
      runCrashRestorationRetainedAuthorityCorpus: async () => {
        throw new Error("crash-restoration retained-authority corpus failed");
      },
    });
    const result = await runInstalledRuntimeHarness(options);
    expect(result.verdict).toBe("failed");
    expect(result.failure).toMatchObject({
      stage: "crash_restoration_retained_authority_corpus",
      code: "crash_restoration_retained_authority_corpus_failed",
    });
    const evidence = parseEvidence(await readFile(result.evidencePath, "utf8"));
    expect(evidence.verdict).toBe("failed");
    expect(evidence.crashRestorationRetainedAuthorityCorpus).toBeNull();
    // Restart replay has not run, so this corpus is still incomplete.
    expect(evidence.changeSetCorpus).toBeNull();
    expect(evidence.gateIsolationCorpus?.verdict).toBe("passed");
    expect(evidence.registeredReferenceRewriteCorpus?.verdict).toBe("passed");
    expect(evidence.privacyRecoveryAuthorityCorpus?.verdict).toBe("passed");
    expect(evidence.releaseLifecycleCorpus?.verdict).toBe("passed");
    expect(await readFile(result.evidencePath, "utf8")).not.toContain(root);
  });

  it("never overwrites an existing evidence record", async () => {
    const { options } = await arrangeRun("run-evidence-exists");
    await mkdir(join(options.evidencePath, ".."), { recursive: true });
    await writeFile(options.evidencePath, "previous evidence", "utf8");
    await expect(runInstalledRuntimeHarness(options)).rejects.toMatchObject({
      name: "EvidenceWriteError",
    });
    expect(await readFile(options.evidencePath, "utf8")).toBe("previous evidence");
  });
});
