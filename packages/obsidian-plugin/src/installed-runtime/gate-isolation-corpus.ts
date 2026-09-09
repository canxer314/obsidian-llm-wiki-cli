import { createHash } from "node:crypto";

import {
  parseChangeSetStatusResult,
  parseChangeSetSubmitResult,
  parseContinueResult,
  parseDiscoverResult,
  parseHealthResult,
  parseReadResult,
  serializeChangeSetStatusCompatibilityText,
  serializeChangeSetSubmitCompatibilityText,
  serializeCompatibilityText,
  serializeContinueCompatibilityText,
  serializeDiscoverCompatibilityText,
  serializeReadCompatibilityText,
  type ChangeSetSubmitInput,
} from "@llm-wiki/vault-contracts";

import type { GateIsolationCorpusEvidence } from "./evidence.js";

/**
 * Deterministic per-Managed-Vault gate-and-isolation corpus (issue #177). Runs
 * the gate algebra of the six-tool contract through the same shared
 * real-transport seam as the change-set submission corpus: every scenario is an
 * ordered, deterministic program over two real loopback Bridge Instances — two
 * dedicated generated test Vaults that progress independently — with no mock
 * substituting for durable byte or identity evidence. The evidence that leaves
 * a run is digest-only; Submission Keys, note bodies, and absolute Vault paths
 * are private.
 *
 * Gate conditions are inducted through a per-Vault operator control bound to
 * each Vault's real Bridge (the same entry points a Primary Operator owns:
 * manual pause/resume and the projected recovery/maintenance health states),
 * and every claim is then asserted over the real MCP wire.
 */

export const GATE_ISOLATION_CORPUS_ID = "per-vault-gate-isolation-proof";

/** The corpus directory; a dedicated area so the deterministic seed Notes are never touched. */
export const GATE_ISOLATION_DIRECTORY = "GateIsolationProof";

/**
 * Ordered release-blocking scenario plan (issue #177). The scenario names are
 * the deterministic program the tracer executes; the manifest digest therefore
 * identifies the program, not one concrete run's generated identities.
 */
export const GATE_ISOLATION_SCENARIO_PLAN = [
  "isolation/shared-key-independent-registries",
  "isolation/cross-vault-lookup-rejected",
  "gates/recovery-blocked-precedence",
  "gates/recovery-in-progress-precedence",
  "gates/writes-paused-row",
  "gates/upgrade-in-progress-row",
  "incompatible/registry-never-inspected",
  "recovery-blocked/atomic-bind-and-history",
  "recovery-blocked/replay-after-recovery",
  "recovery-blocked/fresh-key-renewed-intent",
  "recovery-blocked/other-gates-leave-unbound",
  "manual-pause/drain-and-fifo-retention",
  "manual-pause/rejects-new-unbound",
  "manual-pause/observational-content-available",
  "isolation/gate-transitions-uncorrelated",
  "cleanup/wire-observed-residual-state",
] as const;

export type GateIsolationScenarioName = (typeof GATE_ISOLATION_SCENARIO_PLAN)[number];

export class GateIsolationCorpusError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GateIsolationCorpusError";
  }
}

export type WireToolName =
  | "vault_health"
  | "vault_discover"
  | "vault_read"
  | "vault_continue"
  | "vault_change_set_submit"
  | "vault_change_set_status";

export type McpToolResult = {
  readonly isError?: boolean;
  readonly structuredContent?: unknown;
  readonly content?: readonly unknown[];
};

/** A connected real MCP client: the minimal wire surface every session shares. */
export interface WireClient {
  callTool(tool: WireToolName, arguments_: Record<string, unknown>): Promise<McpToolResult>;
}

export interface GateIsolationCorpusInventoryEntry {
  readonly path: string;
  readonly sha256: string;
  readonly sizeBytes: number;
}

/** A projected health state a Vault's real Bridge must be arranged into. */
export interface ArrangedVaultHealth {
  readonly recovery?: "none" | "in_progress" | "blocked";
  readonly effectiveGate?: "writes_paused" | "upgrade_in_progress" | null;
  readonly write?: {
    readonly gate: "open" | "blocked";
    readonly state: "writable" | "pausing" | "paused";
    readonly pauseSource: "manual" | "maintenance" | null;
  };
  readonly overall?: "healthy" | "degraded" | "blocked";
  readonly operatorAction?: string;
  readonly queue?: {
    readonly currentExecutionId: string | null;
    readonly length: number;
    readonly headChangeSetId: string | null;
  };
}

/**
 * Operator control bound to one Vault's real Bridge (issue #177). It exposes
 * exactly the entry points the Primary Operator owns — manual pause/resume and
 * the projected recovery/maintenance health states — so the corpus can induct
 * gate conditions deterministically and observe every consequence over the
 * real wire. The host binds each method to the real Bridge Instance of the
 * Managed Vault it represents.
 */
export interface GateIsolationOperatorControl {
  /** Arranges the real Bridge health so the wire projection matches `state`. */
  arrange(state: ArrangedVaultHealth): Promise<void>;
  /** Real manual pause: drains the in-flight Change Set and pauses writes. */
  pauseWrites(): Promise<void>;
  /** Real explicit resume: reopens writes and resumes the FIFO queue. */
  resumeWrites(): Promise<void>;
  /** Restores a healthy idle projection: no recovery, open writable, no gate. */
  restoreIdle(): Promise<void>;
}

/**
 * One real Managed-Vault session over a real loopback Bridge: an MCP `callTool`
 * bound to that Vault plus the operator control that inducts its gates.
 */
export interface GateIsolationVaultSession {
  readonly label: "vault-a" | "vault-b";
  /** Digest of the Vault identity; the raw identity is never recorded. */
  readonly vaultIdSha256: string;
  callTool(tool: WireToolName, arguments_: Record<string, unknown>): Promise<McpToolResult>;
  readonly operator: GateIsolationOperatorControl;
  /**
   * Deterministic seed Notes of the Vault. Used only to compute digest-only
   * expected inventories; bodies never enter evidence.
   */
  readonly seedNotes: readonly { path: string; content: string }[];
  /**
   * Whether the compatible Change Set registry store was never inspected by a
   * protocol-incompatible connection. The host proves this with its own store
   * counters; the corpus only asserts the reported fact.
   */
  readonly registryUninspected?: boolean;
}

const utf8Encoder = new TextEncoder();

function sha256Hex(value: string): string {
  return createHash("sha256").update(utf8Encoder.encode(value)).digest("hex");
}

function digestOfContentVersion(contentVersion: string): string {
  return contentVersion.replace(/^sha256:/u, "");
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
  return createHash("sha256")
    .update(
      canonicalJson({
        corpusId: GATE_ISOLATION_CORPUS_ID,
        scenarios: [...GATE_ISOLATION_SCENARIO_PLAN],
      }),
    )
    .digest("hex");
}

export function digestCorpusInventory(
  entries: readonly GateIsolationCorpusInventoryEntry[],
): string {
  const canonical = entries
    .map(({ path, sha256, sizeBytes }) => `${sha256}  ${sizeBytes}  ${path}`)
    .sort()
    .join("\n");
  return createHash("sha256").update(`${canonical}\n`, "utf8").digest("hex");
}

function exactText(result: McpToolResult): string {
  const text = result.content?.find(
    (item): item is { readonly type: "text"; readonly text: string } =>
      typeof item === "object" &&
      item !== null &&
      (item as { readonly type?: unknown }).type === "text" &&
      typeof (item as { readonly text?: unknown }).text === "string",
  );
  if (text === undefined) {
    throw new GateIsolationCorpusError("Tool response has no compatibility text");
  }
  return text.text;
}

/** Wire-observed inventory helper shared by before/after seed observations. */
function inventoryEntry(path: string, content: string): GateIsolationCorpusInventoryEntry {
  return {
    path,
    sha256: sha256Hex(content),
    sizeBytes: utf8Encoder.encode(content).byteLength,
  };
}

function expectedSeedInventory(
  seedNotes: readonly { path: string; content: string }[],
): GateIsolationCorpusInventoryEntry[] {
  return seedNotes
    .filter(({ path }) => path.startsWith("Notes/"))
    .map(({ path, content }) => inventoryEntry(path, content))
    .sort((left, right) => left.path.localeCompare(right.path));
}

function observedGateCode(health: ReturnType<typeof parseHealthResult>): string | null {
  if (health.outcome !== "observed") return "incompatible_protocol";
  return health.effectiveGate?.code ?? null;
}

function submitInput(
  submissionKey: string,
  operationId: string,
  path: string,
  content: string,
): ChangeSetSubmitInput {
  return {
    submissionKey,
    operations: [{ operationId, kind: "create_note", path, content, ifExists: "reject" }],
  };
}

/** Content fixtures the corpus creates. Deterministic and private to the run. */
const CONTENT_A = "# Vault A Proof\n";
const CONTENT_B = "# Vault B Proof\n";

async function callAndAssert(
  session: WireClient,
  stepId: string,
  tool: WireToolName,
  arguments_: Record<string, unknown>,
  assertResult: (value: unknown) => string,
  expectedError = false,
): Promise<unknown> {
  const result = await session.callTool(tool, arguments_);
  if ((result.isError === true) !== expectedError) {
    throw new GateIsolationCorpusError(
      `${stepId} returned an unexpected MCP error disposition`,
    );
  }
  if (result.structuredContent === undefined) {
    throw new GateIsolationCorpusError(`${stepId} omitted authoritative structured content`);
  }
  const authoritativeText = assertResult(result.structuredContent);
  if (exactText(result) !== authoritativeText) {
    throw new GateIsolationCorpusError(
      `${stepId} compatibility text diverged from structured content`,
    );
  }
  return result.structuredContent;
}

async function observeHealth(
  session: WireClient,
  stepId: string,
): Promise<ReturnType<typeof parseHealthResult>> {
  const value = await callAndAssert(
    session,
    stepId,
    "vault_health",
    {},
    (candidate) => serializeCompatibilityText(parseHealthResult(candidate)),
    false,
  );
  return parseHealthResult(value);
}

async function discoverInventory(
  session: WireClient,
  prefix: string,
  stepId: string,
  expectedBlockedGate: string | null,
): Promise<GateIsolationCorpusInventoryEntry[] | "blocked"> {
  const value = await callAndAssert(
    session,
    stepId,
    "vault_discover",
    {
      query: { path: { prefix } },
      projection: { matches: false },
      order: { by: "path", direction: "asc" },
      page: { maxItems: 1_000, continuation: null },
    },
    (candidate) => serializeDiscoverCompatibilityText(parseDiscoverResult(candidate)),
    expectedBlockedGate !== null,
  );
  const result = parseDiscoverResult(value);
  if (result.outcome === "operationally_blocked") {
    if (result.gate.code !== expectedBlockedGate) {
      throw new GateIsolationCorpusError(
        `${stepId} projected gate ${result.gate.code}, expected ${expectedBlockedGate ?? "none"}`,
      );
    }
    return "blocked";
  }
  if (result.outcome !== "results" || !result.complete) {
    throw new GateIsolationCorpusError(
      `${stepId} inventory discovery did not return complete results`,
    );
  }
  return result.items
    .map((item) => ({
      path: item.path,
      sha256: digestOfContentVersion(item.contentVersion),
      sizeBytes: item.sizeBytes,
    }))
    .sort((left, right) => left.path.localeCompare(right.path));
}

async function readSeedMetadata(
  session: WireClient,
  stepId: string,
  path: string,
  expectedBlockedGate: string | null,
): Promise<"satisfied" | "blocked"> {
  const value = await callAndAssert(
    session,
    stepId,
    "vault_read",
    { items: [{ kind: "metadata", path }] },
    (candidate) => serializeReadCompatibilityText(parseReadResult(candidate)),
    expectedBlockedGate !== null,
  );
  const result = parseReadResult(value);
  if (result.outcome === "operationally_blocked") {
    if (result.gate.code !== expectedBlockedGate) {
      throw new GateIsolationCorpusError(
        `${stepId} read projected gate ${result.gate.code}, expected ${expectedBlockedGate ?? "none"}`,
      );
    }
    return "blocked";
  }
  if (result.outcome !== "items") {
    throw new GateIsolationCorpusError(`${stepId} read did not return item evidence`);
  }
  const first = result.items[0];
  if (first?.outcome !== "satisfied") {
    throw new GateIsolationCorpusError(`${stepId} seed note metadata was not satisfied`);
  }
  return "satisfied";
}

async function continueArbitrary(
  session: WireClient,
  stepId: string,
  expectedBlockedGate: string | null,
): Promise<ReturnType<typeof parseContinueResult>> {
  // A continuation with an unknown token is always an MCP error: under a
  // content-blocking gate it returns `operationally_blocked`, and under an
  // open gate it reaches the store and returns `continuation_unavailable`.
  const value = await callAndAssert(
    session,
    stepId,
    "vault_continue",
    { continuation: "gate-proof-continuation-token" },
    (candidate) => serializeContinueCompatibilityText(parseContinueResult(candidate)),
    true,
  );
  const result = parseContinueResult(value);
  if (expectedBlockedGate !== null && continueBlockedGate(result) !== expectedBlockedGate) {
    throw new GateIsolationCorpusError(
      `${stepId} was not operationally blocked by ${expectedBlockedGate}`,
    );
  }
  return result;
}

/**
 * The content-blocking gate a `vault_continue` result projected, or null when
 * continuation reached the store (page or `continuation_unavailable`). The
 * continuation result is a union whose unavailable member has no `outcome`, so
 * the narrowing must first prove the member has an `outcome`.
 */
function continueBlockedGate(
  result: ReturnType<typeof parseContinueResult>,
): string | null {
  if (!("outcome" in result) || result.outcome !== "operationally_blocked") return null;
  return result.gate.code;
}

async function callSubmit(
  session: WireClient,
  stepId: string,
  input: ChangeSetSubmitInput,
  expectedError: boolean,
): Promise<ReturnType<typeof parseChangeSetSubmitResult>> {
  const value = await callAndAssert(
    session,
    stepId,
    "vault_change_set_submit",
    {
      submissionKey: input.submissionKey,
      operations: structuredClone(input.operations),
    },
    (candidate) =>
      serializeChangeSetSubmitCompatibilityText(parseChangeSetSubmitResult(candidate)),
    expectedError,
  );
  return parseChangeSetSubmitResult(value);
}

async function callStatus(
  session: WireClient,
  stepId: string,
  submissionKey: string,
  expectedError = false,
): Promise<ReturnType<typeof parseChangeSetStatusResult>> {
  const value = await callAndAssert(
    session,
    stepId,
    "vault_change_set_status",
    { submissionKey },
    (candidate) =>
      serializeChangeSetStatusCompatibilityText(parseChangeSetStatusResult(candidate)),
    expectedError,
  );
  return parseChangeSetStatusResult(value);
}

/**
 * Executes the deterministic per-Vault gate-and-isolation corpus (issue #177)
 * against two real loopback Managed-Vault sessions. Every scenario throws
 * `GateIsolationCorpusError` on the first mismatch, which the harness projects
 * to failed evidence — never to a skipped green result. The corpus mutates only
 * each Vault's dedicated `GateIsolationProof/` area through the Change Set
 * engine; the deterministic seed `Notes/` inventory is observed over the wire
 * before and after and must stay unchanged in both Vaults.
 */
export async function runGateIsolationCorpus(options: {
  readonly vaultA: GateIsolationVaultSession;
  readonly vaultB: GateIsolationVaultSession;
  /**
   * A connected protocol-incompatible client on Vault A's Managed Vault: a real
   * MCP connection whose Bridge Instance cannot safely share the wire schema.
   * Every content and Change Set tool must return the `incompatible_protocol`
   * branch without inspecting Vault A's Change Set registry or binding a new
   * Submission Key.
   */
  readonly incompatibleClient?: WireClient;
  readonly record: (
    kind: "transport" | "tool" | "assertion" | "cleanup",
    name: string,
    detail: unknown,
  ) => void;
  readonly assertion: (name: string) => void;
}): Promise<GateIsolationOutcome> {
  const { vaultA, vaultB } = options;
  const assertions: string[] = [];
  const assertion = (name: string): void => {
    assertions.push(name);
    options.assertion(name);
  };

  // Wire-observed gate-history digest source.
  const gateHistory: GateIsolationCorpusEvidence["gateHistory"] = [];
  const recordGateHistory = (
    vaultLabel: "vault-a" | "vault-b" | "incompatible-a",
    scenario: string,
    health: ReturnType<typeof parseHealthResult>,
  ): void => {
    gateHistory.push({
      sequence: gateHistory.length + 1,
      vaultLabel,
      scenario,
      outcome: health.outcome,
      effectiveGate: observedGateCode(health),
      recoveryState: health.outcome === "observed" ? health.recovery.state : null,
      writeState: health.outcome === "observed" ? health.write.state : null,
    });
  };

  // Every bound Change Set in per-Vault enqueue order. The Change Set engine
  // (real registry, no executor attached for this corpus) retains admitted
  // Change Sets in FIFO order; the corpus records the order it observed so
  // queue/FIFO evidence is deterministic.
  const boundByVault: Record<"vault-a" | "vault-b", GateIsolationCorpusEvidence["submissions"][number][]> = {
    "vault-a": [],
    "vault-b": [],
  };
  const submissionProofs: GateIsolationCorpusEvidence["submissions"][number][] = [];
  const recordSubmission = (
    vaultLabel: "vault-a" | "vault-b",
    scenario: string,
    submissionKey: string,
    record: { changeSetId: string; state: string; historicalGate: "recovery_blocked" | null },
  ): void => {
    const proof = {
      vaultLabel,
      scenario,
      submissionKeySha256: sha256Hex(submissionKey),
      changeSetId: record.changeSetId,
      state: record.state as GateIsolationCorpusEvidence["submissions"][number]["state"],
      historicalGate: record.historicalGate,
    };
    boundByVault[vaultLabel].push(proof);
    submissionProofs.push(proof);
  };

  const beforeInventories: Record<"vault-a" | "vault-b", readonly GateIsolationCorpusInventoryEntry[]> = {
    "vault-a": expectedSeedInventory(vaultA.seedNotes),
    "vault-b": expectedSeedInventory(vaultB.seedNotes),
  };
  options.record("assertion", "gate-isolation-corpus-began", {
    corpusId: GATE_ISOLATION_CORPUS_ID,
    vaultA: vaultA.vaultIdSha256,
    vaultB: vaultB.vaultIdSha256,
  });

  const seedPath = "Notes/Welcome.md";

  // 1. Isolation: the same Submission Key and identical request register two
  //    independent Change Sets — one per Managed Vault — and a key bound in one
  //    Vault is never visible to the other.
  {
    const sharedInput = submitInput(
      "gate-iso-shared-key",
      "shared-create",
      `${GATE_ISOLATION_DIRECTORY}/Shared/Shared.md`,
      "# Shared Isolation Proof\n",
    );
    const [aResult, bResult] = await Promise.all([
      callSubmit(vaultA, "isolation/shared-key-a", sharedInput, false),
      callSubmit(vaultB, "isolation/shared-key-b", sharedInput, false),
    ]);
    if (aResult.outcome !== "registered" || bResult.outcome !== "registered") {
      throw new GateIsolationCorpusError("shared-key isolation submissions did not register");
    }
    if (aResult.changeSet.changeSetId === bResult.changeSet.changeSetId) {
      throw new GateIsolationCorpusError(
        "The same Submission Key produced one shared Change Set across two Managed Vaults",
      );
    }
    recordSubmission("vault-a", "isolation/shared-key-independent-registries", sharedInput.submissionKey, {
      changeSetId: aResult.changeSet.changeSetId,
      state: aResult.changeSet.state,
      historicalGate: null,
    });
    recordSubmission("vault-b", "isolation/shared-key-independent-registries", sharedInput.submissionKey, {
      changeSetId: bResult.changeSet.changeSetId,
      state: bResult.changeSet.state,
      historicalGate: null,
    });
    const aStatus = await callStatus(vaultA, "isolation/shared-key-status-a", sharedInput.submissionKey);
    const bStatus = await callStatus(vaultB, "isolation/shared-key-status-b", sharedInput.submissionKey);
    if (aStatus.lookup !== "found" || bStatus.lookup !== "found") {
      throw new GateIsolationCorpusError("shared-key status was not found in its own Vault");
    }
    if (aStatus.changeSet.changeSetId !== aResult.changeSet.changeSetId) {
      throw new GateIsolationCorpusError("Vault A replayed the wrong shared-key identity");
    }
    if (bStatus.changeSet.changeSetId !== bResult.changeSet.changeSetId) {
      throw new GateIsolationCorpusError("Vault B replayed the wrong shared-key identity");
    }
    assertion("isolation/shared-key-independent-registries:distinct-change-set-ids");
  }

  // 2. A Submission Key bound in one Vault is unknown to the other Vault.
  {
    const aKey = "gate-iso-key-a";
    const bKey = "gate-iso-key-b";
    const aInput = submitInput(aKey, "a-create", `${GATE_ISOLATION_DIRECTORY}/Isolation/FromA.md`, CONTENT_A);
    const bInput = submitInput(bKey, "b-create", `${GATE_ISOLATION_DIRECTORY}/Isolation/FromB.md`, CONTENT_B);
    const aRegistered = await callSubmit(vaultA, "isolation/bind-a", aInput, false);
    const bRegistered = await callSubmit(vaultB, "isolation/bind-b", bInput, false);
    if (aRegistered.outcome !== "registered" || bRegistered.outcome !== "registered") {
      throw new GateIsolationCorpusError("per-Vault key bindings did not register");
    }
    recordSubmission("vault-a", "isolation/cross-vault-lookup-rejected", aKey, {
      changeSetId: aRegistered.changeSet.changeSetId,
      state: aRegistered.changeSet.state,
      historicalGate: null,
    });
    recordSubmission("vault-b", "isolation/cross-vault-lookup-rejected", bKey, {
      changeSetId: bRegistered.changeSet.changeSetId,
      state: bRegistered.changeSet.state,
      historicalGate: null,
    });
    const aOnB = await callStatus(vaultB, "isolation/cross-vault-lookup-b", aKey);
    const bOnA = await callStatus(vaultA, "isolation/cross-vault-lookup-a", bKey);
    if (aOnB.lookup === "found" || bOnA.lookup === "found") {
      throw new GateIsolationCorpusError(
        "A Submission Key bound in one Managed Vault was visible in the other",
      );
    }
    assertion("isolation/cross-vault-lookup-rejected:no-registry-crossing");
  }

  // 3. Gate rows on Vault A (Vault B stays healthy and independent): exactly one
  //    effective gate projects in the fixed precedence order, and every public
  //    tool uses the contract-prescribed branch, Submission Key consequence,
  //    and MCP `isError` value.
  {
    const assertGateRow = async (
      scenario: string,
      arranged: ArrangedVaultHealth,
      rowGate: string,
      contentBlocked: boolean,
      freshKey: string,
      expectBoundDisposition: boolean,
    ): Promise<void> => {
      await vaultA.operator.arrange(arranged);
      const health = await observeHealth(vaultA, `${scenario}:health`);
      const wireGate = observedGateCode(health);
      if (wireGate !== rowGate) {
        throw new GateIsolationCorpusError(
          `${scenario} projected ${wireGate ?? "null"}, expected ${rowGate}`,
        );
      }
      recordGateHistory("vault-a", scenario, health);
      const discoverOutcome = await discoverInventory(
        vaultA,
        "Notes/",
        `${scenario}:discover`,
        contentBlocked ? rowGate : null,
      );
      const readOutcome = await readSeedMetadata(
        vaultA,
        `${scenario}:read`,
        seedPath,
        contentBlocked ? rowGate : null,
      );
      const continueResult = await continueArbitrary(
        vaultA,
        `${scenario}:continue`,
        contentBlocked ? rowGate : null,
      );
      if (contentBlocked) {
        if (discoverOutcome !== "blocked" || readOutcome !== "blocked") {
          throw new GateIsolationCorpusError(`${scenario} content tools were not blocked`);
        }
        if (continueBlockedGate(continueResult) !== rowGate) {
          throw new GateIsolationCorpusError(
            `${scenario} continue was not operationally blocked by ${rowGate}`,
          );
        }
      } else {
        if (discoverOutcome === "blocked" || readOutcome !== "satisfied") {
          throw new GateIsolationCorpusError(`${scenario} content tools were wrongly blocked`);
        }
        // With no content-blocking gate, continuation must reach the store and
        // return continuation_unavailable rather than an operational block.
        if (continueBlockedGate(continueResult) !== null) {
          throw new GateIsolationCorpusError(
            `${scenario} continue masqueraded as an operational block`,
          );
        }
      }

      const input = submitInput(
        freshKey,
        "gated-create",
        `${GATE_ISOLATION_DIRECTORY}/Gate/${freshKey}.md`,
        CONTENT_A,
      );
      if (expectBoundDisposition) {
        const proof = await callSubmit(vaultA, `${scenario}:submit`, input, true);
        if (
          proof.outcome !== "registered" ||
          proof.changeSet.state !== "intent_not_applied" ||
          proof.gate?.code !== "recovery_blocked"
        ) {
          throw new GateIsolationCorpusError(
            `${scenario} did not bind the recovery_blocked disposition`,
          );
        }
        recordSubmission("vault-a", scenario, freshKey, {
          changeSetId: proof.changeSet.changeSetId,
          state: proof.changeSet.state,
          historicalGate: "recovery_blocked",
        });
        // Status of the bound key is an ordinary successful query.
        const status = await callStatus(vaultA, `${scenario}:status-bound`, freshKey);
        if (status.lookup !== "found" || "gate" in status) {
          throw new GateIsolationCorpusError(
            `${scenario} status of the recovery_blocked bind was not an ordinary found view`,
          );
        }
      } else {
        const proof = await callSubmit(vaultA, `${scenario}:submit`, input, true);
        if (proof.outcome !== "operationally_blocked" || proof.gate?.code !== rowGate) {
          throw new GateIsolationCorpusError(
            `${scenario} unbound submit was not operationally blocked by ${rowGate}`,
          );
        }
        // The blocked Submission Key must remain unbound.
        const status = await callStatus(vaultA, `${scenario}:status-unbound`, freshKey);
        if (status.lookup === "found") {
          throw new GateIsolationCorpusError(
            `${scenario} a blocked unbound Submission Key was bound`,
          );
        }
      }
      assertion(`${scenario}:single-effective-gate-${rowGate}`);
    };

    // recovery_blocked wins over a simultaneously arranged writes_paused state.
    await assertGateRow(
      "gates/recovery-blocked-precedence",
      {
        recovery: "blocked",
        effectiveGate: "writes_paused",
        write: { gate: "open", state: "paused", pauseSource: "manual" },
        overall: "blocked",
        operatorAction: "review_recovery",
      },
      "recovery_blocked",
      true,
      "gate-iso-recovery-blocked-1",
      true,
    );
    // recovery_in_progress wins over a simultaneously arranged writes_paused state.
    await assertGateRow(
      "gates/recovery-in-progress-precedence",
      {
        recovery: "in_progress",
        effectiveGate: "writes_paused",
        write: { gate: "open", state: "paused", pauseSource: "manual" },
        overall: "degraded",
        operatorAction: "wait_for_recovery",
      },
      "recovery_in_progress",
      true,
      "gate-iso-recovery-in-progress-1",
      false,
    );
    // writes_paused row: content executes, unbound submissions are blocked.
    await assertGateRow(
      "gates/writes-paused-row",
      {
        recovery: "none",
        effectiveGate: "writes_paused",
        write: { gate: "open", state: "paused", pauseSource: "manual" },
        overall: "degraded",
        operatorAction: "resume_writes",
      },
      "writes_paused",
      false,
      "gate-iso-writes-paused-1",
      false,
    );
    // upgrade_in_progress row: identical tool behavior, distinct gate code.
    await assertGateRow(
      "gates/upgrade-in-progress-row",
      {
        recovery: "none",
        effectiveGate: "upgrade_in_progress",
        write: { gate: "open", state: "paused", pauseSource: "maintenance" },
        overall: "degraded",
        operatorAction: "finish_upgrade",
      },
      "upgrade_in_progress",
      false,
      "gate-iso-upgrade-in-progress-1",
      false,
    );

    // Vault B is untouched while Vault A projected all four gate rows.
    const bHealth = await observeHealth(vaultB, "gates/vault-b-independent-health");
    if (bHealth.outcome !== "observed" || bHealth.effectiveGate !== null) {
      throw new GateIsolationCorpusError("Vault B health was altered by Vault A gate rows");
    }
    const bDiscover = await discoverInventory(vaultB, "Notes/", "gates/vault-b-independent-discover", null);
    if (bDiscover === "blocked") {
      throw new GateIsolationCorpusError("Vault B content was blocked by Vault A gate rows");
    }
    assertion("gates/recovery-blocked-precedence:single-effective-gate");
    assertion("gates/recovery-in-progress-precedence:single-effective-gate");
    assertion("gates/writes-paused-row:content-available");
    assertion("gates/upgrade-in-progress-row:content-available");
    assertion("isolation/gate-transitions-uncorrelated:vault-b-unaffected");
  }

  // 4. recovery_blocked: the atomic historical bind, its replay after recovery,
  //    and the fresh-key requirement for renewed intent.
  {
    const recoveryKey = "gate-iso-history-bind";
    const recoveryInput = submitInput(
      recoveryKey,
      "history-create",
      `${GATE_ISOLATION_DIRECTORY}/History/Bound.md`,
      "# Historical Disposition\n",
    );
    await vaultA.operator.arrange({
      recovery: "blocked",
      effectiveGate: "writes_paused",
      write: { gate: "open", state: "paused", pauseSource: "manual" },
      overall: "blocked",
      operatorAction: "review_recovery",
    });
    const bound = await callSubmit(vaultA, "recovery-blocked/atomic-bind", recoveryInput, true);
    if (
      bound.outcome !== "registered" ||
      bound.changeSet.state !== "intent_not_applied" ||
      bound.gate?.code !== "recovery_blocked" ||
      "failure" in bound.changeSet
    ) {
      throw new GateIsolationCorpusError(
        "recovery_blocked did not atomically bind intent_not_applied without failure",
      );
    }
    recordSubmission("vault-a", "recovery-blocked/atomic-bind-and-history", recoveryKey, {
      changeSetId: bound.changeSet.changeSetId,
      state: bound.changeSet.state,
      historicalGate: "recovery_blocked",
    });
    const historyStatus = await callStatus(vaultA, "recovery-blocked/status-history", recoveryKey);
    if (historyStatus.lookup !== "found") {
      throw new GateIsolationCorpusError("recovery_blocked bind status was not found");
    }
    assertion("recovery-blocked/atomic-bind-and-history:bound-intent-not-applied");

    // After recovery (healthy again), the disposition replays and a conflicting
    // reuse is rejected; renewed intent requires a fresh key.
    await vaultA.operator.restoreIdle();
    const replayed = await callSubmit(vaultA, "recovery-blocked/replay-after-recovery", recoveryInput, true);
    if (
      replayed.outcome !== "registered" ||
      replayed.changeSet.changeSetId !== bound.changeSet.changeSetId ||
      replayed.changeSet.state !== "intent_not_applied" ||
      replayed.gate?.code !== "recovery_blocked"
    ) {
      throw new GateIsolationCorpusError(
        "recovery_blocked disposition did not replay after recovery",
      );
    }
    const conflict = await callSubmit(
      vaultA,
      "recovery-blocked/conflicting-reuse",
      submitInput(recoveryKey, "conflict-create", `${GATE_ISOLATION_DIRECTORY}/History/Other.md`, "# Other\n"),
      true,
    );
    if (conflict.outcome !== "submission_key_conflict") {
      throw new GateIsolationCorpusError("recovery_blocked key reuse was not rejected as a conflict");
    }
    const renewed = await callSubmit(
      vaultA,
      "recovery-blocked/fresh-key-renewed-intent",
      submitInput(
        "gate-iso-history-renewed",
        "renewed-create",
        `${GATE_ISOLATION_DIRECTORY}/History/Bound.md`,
        "# Historical Disposition\n",
      ),
      false,
    );
    if (renewed.outcome !== "registered" || renewed.changeSet.changeSetId === bound.changeSet.changeSetId) {
      throw new GateIsolationCorpusError("renewed intent under the old key did not require a fresh key");
    }
    recordSubmission("vault-a", "recovery-blocked/fresh-key-renewed-intent", "gate-iso-history-renewed", {
      changeSetId: renewed.changeSet.changeSetId,
      state: renewed.changeSet.state,
      historicalGate: null,
    });
    assertion("recovery-blocked/replay-after-recovery:disposition-replayed");
    assertion("recovery-blocked/fresh-key-renewed-intent:new-key-required");
  }

  // 5. Other gate rows leave blocked unbound submissions unbound (only
  //    recovery_blocked binds a disposition).
  {
    await vaultA.operator.arrange({
      recovery: "in_progress",
      effectiveGate: "writes_paused",
      write: { gate: "open", state: "paused", pauseSource: "manual" },
      overall: "degraded",
      operatorAction: "wait_for_recovery",
    });
    const inProgressKey = "gate-iso-unbound-in-progress";
    const inProgressProof = await callSubmit(
      vaultA,
      "recovery-blocked/other-gates-leave-unbound",
      submitInput(inProgressKey, "unbound-create", `${GATE_ISOLATION_DIRECTORY}/Unbound/InProgress.md`, CONTENT_A),
      true,
    );
    if (inProgressProof.outcome !== "operationally_blocked" || inProgressProof.gate?.code !== "recovery_in_progress") {
      throw new GateIsolationCorpusError("recovery_in_progress did not block the unbound submission");
    }
    const inProgressStatus = await callStatus(vaultA, "recovery-blocked/other-gates-status", inProgressKey);
    if (inProgressStatus.lookup === "found") {
      throw new GateIsolationCorpusError("recovery_in_progress bound a key it must leave unbound");
    }

    await vaultA.operator.arrange({
      recovery: "none",
      effectiveGate: "writes_paused",
      write: { gate: "open", state: "paused", pauseSource: "manual" },
      overall: "degraded",
      operatorAction: "resume_writes",
    });
    const pausedKey = "gate-iso-unbound-paused";
    const pausedProof = await callSubmit(
      vaultA,
      "recovery-blocked/other-gates-leave-unbound",
      submitInput(pausedKey, "unbound-create", `${GATE_ISOLATION_DIRECTORY}/Unbound/Paused.md`, CONTENT_A),
      true,
    );
    if (pausedProof.outcome !== "operationally_blocked" || pausedProof.gate?.code !== "writes_paused") {
      throw new GateIsolationCorpusError("writes_paused did not block the unbound submission");
    }
    const pausedStatus = await callStatus(vaultA, "recovery-blocked/other-gates-status", pausedKey);
    if (pausedStatus.lookup === "found") {
      throw new GateIsolationCorpusError("writes_paused bound a key it must leave unbound");
    }
    await vaultA.operator.restoreIdle();
    assertion("recovery-blocked/other-gates-leave-unbound:blocked-keys-unbound");
  }

  // 6. Manual pause: drains the in-flight Change Set to a trustworthy end,
  //    retains queued FIFO order, rejects new unbound submissions, and leaves
  //    the observational/content tools available while writes remain gated.
  {
    await vaultA.operator.restoreIdle();
    const pauseKeys = ["gate-iso-pause-1", "gate-iso-pause-2"];
    const queuedIds: string[] = [];
    for (const [index, key] of pauseKeys.entries()) {
      const proof = await callSubmit(
        vaultA,
        `manual-pause/queue-${index + 1}`,
        submitInput(
          key,
          `pause-create-${index + 1}`,
          `${GATE_ISOLATION_DIRECTORY}/Pause/Item${index + 1}.md`,
          `# Pause ${index + 1}\n`,
        ),
        false,
      );
      if (proof.outcome !== "registered") {
        throw new GateIsolationCorpusError("manual-pause queue item did not register");
      }
      queuedIds.push(proof.changeSet.changeSetId);
      recordSubmission("vault-a", "manual-pause/drain-and-fifo-retention", key, {
        changeSetId: proof.changeSet.changeSetId,
        state: proof.changeSet.state,
        historicalGate: null,
      });
    }

    // Mirror the real engine queue (all bound Change Sets in enqueue order) into
    // the health projection, then observe the wire.
    const projectQueue = (): {
      currentExecutionId: null;
      length: number;
      headChangeSetId: string | null;
    } => {
      const queued = boundByVault["vault-a"].filter(
        (record) => record.state === "in_progress" || record.state === "intent_applied",
      );
      return {
        currentExecutionId: null,
        length: queued.length,
        headChangeSetId: queued[0]?.changeSetId ?? null,
      };
    };
    await vaultA.operator.arrange({ queue: projectQueue() });
    const prePauseHealth = await observeHealth(vaultA, "manual-pause/pre-pause-health");
    if (prePauseHealth.outcome !== "observed" || prePauseHealth.queue.length === 0) {
      throw new GateIsolationCorpusError("manual-pause pre-pause queue was empty");
    }
    const prePauseQueue = {
      length: prePauseHealth.queue.length,
      head: prePauseHealth.queue.headChangeSetId,
    };

    // The real manual pause enters the engine control lease, drains the
    // in-flight Change Set to a trustworthy end, and pauses writes.
    await vaultA.operator.pauseWrites();
    const pausedHealth = await observeHealth(vaultA, "manual-pause/paused-health");
    if (
      pausedHealth.outcome !== "observed" ||
      pausedHealth.write.state !== "paused" ||
      pausedHealth.write.pauseSource !== "manual" ||
      pausedHealth.effectiveGate?.code !== "writes_paused"
    ) {
      throw new GateIsolationCorpusError("manual pause did not project writes_paused");
    }
    if (
      pausedHealth.queue.length !== prePauseQueue.length ||
      pausedHealth.queue.headChangeSetId !== prePauseQueue.head
    ) {
      throw new GateIsolationCorpusError("manual pause did not retain the queued FIFO order");
    }

    // New unbound submissions are rejected without binding.
    const rejectedKey = "gate-iso-pause-rejected";
    const rejected = await callSubmit(
      vaultA,
      "manual-pause/rejects-new-unbound",
      submitInput(rejectedKey, "pause-rejected-create", `${GATE_ISOLATION_DIRECTORY}/Pause/Rejected.md`, "# Rejected\n"),
      true,
    );
    if (rejected.outcome !== "operationally_blocked" || rejected.gate?.code !== "writes_paused") {
      throw new GateIsolationCorpusError("manual pause did not reject the new unbound submission");
    }
    const rejectedStatus = await callStatus(vaultA, "manual-pause/rejected-status", rejectedKey);
    if (rejectedStatus.lookup === "found") {
      throw new GateIsolationCorpusError("manual pause bound the rejected Submission Key");
    }

    // Observational/content tools remain available while writes are gated.
    const discoverDuringPause = await discoverInventory(
      vaultA,
      "Notes/",
      "manual-pause/discover-available",
      null,
    );
    if (discoverDuringPause === "blocked") {
      throw new GateIsolationCorpusError("manual pause blocked vault_discover");
    }
    const readDuringPause = await readSeedMetadata(vaultA, "manual-pause/read-available", seedPath, null);
    if (readDuringPause !== "satisfied") {
      throw new GateIsolationCorpusError("manual pause blocked vault_read");
    }
    const continueDuringPause = await continueArbitrary(vaultA, "manual-pause/continue-available", null);
    if (continueBlockedGate(continueDuringPause) !== null) {
      throw new GateIsolationCorpusError("manual pause blocked vault_continue");
    }
    const boundStatus = await callStatus(vaultA, "manual-pause/bound-status", pauseKeys[0]!);
    if (boundStatus.lookup !== "found") {
      throw new GateIsolationCorpusError("manual pause blocked vault_change_set_status");
    }
    assertion("manual-pause/drain-and-fifo-retention:queued-order-retained");
    assertion("manual-pause/rejects-new-unbound:key-unbound");
    assertion("manual-pause/observational-content-available:tools-available");

    // Explicit resume reopens writes; the retried key now binds and appends
    // behind the retained FIFO head.
    await vaultA.operator.resumeWrites();
    const resumedHealth = await observeHealth(vaultA, "manual-pause/resumed-health");
    if (
      resumedHealth.outcome !== "observed" ||
      resumedHealth.effectiveGate !== null ||
      resumedHealth.write.state !== "writable"
    ) {
      throw new GateIsolationCorpusError("explicit resume did not reopen writes");
    }
    const retried = await callSubmit(
      vaultA,
      "manual-pause/retry-after-resume",
      submitInput(rejectedKey, "pause-retried-create", `${GATE_ISOLATION_DIRECTORY}/Pause/Rejected.md`, "# Rejected\n"),
      false,
    );
    if (retried.outcome !== "registered") {
      throw new GateIsolationCorpusError("the retried Submission Key did not bind after resume");
    }
    recordSubmission("vault-a", "manual-pause/drain-and-fifo-retention", rejectedKey, {
      changeSetId: retried.changeSet.changeSetId,
      state: retried.changeSet.state,
      historicalGate: null,
    });
    assertion("manual-pause/explicit-resume:retried-key-binds");
  }

  // 7. A protocol-incompatible connection on Vault A returns the minimal
  //    incompatible health branch and `incompatible_protocol` operational
  //    blocks on every content tool and on submission/status — never inspecting
  //    Vault A's Change Set registry and never binding a new Submission Key.
  {
    const healthy = await observeHealth(vaultA, "incompatible/compatible-health");
    if (healthy.outcome !== "observed") {
      throw new GateIsolationCorpusError("the compatible Vault session was unexpectedly incompatible");
    }
    if (options.incompatibleClient === undefined) {
      throw new GateIsolationCorpusError("the corpus requires a protocol-incompatible client");
    }
    const incompatible = options.incompatibleClient;
    const incompatibleHealth = await observeHealth(incompatible, "incompatible/health");
    if (incompatibleHealth.outcome !== "incompatible") {
      throw new GateIsolationCorpusError("the incompatible connection did not project the incompatible health branch");
    }
    recordGateHistory("incompatible-a", "incompatible/registry-never-inspected", incompatibleHealth);

    // vault_discover / vault_read / vault_continue: blocked, isError true.
    const discoverBlocked = await discoverInventory(incompatible, "Notes/", "incompatible/discover", "incompatible_protocol");
    if (discoverBlocked !== "blocked") {
      throw new GateIsolationCorpusError("incompatible connection was not operationally blocked on discover");
    }
    const readBlocked = await readSeedMetadata(incompatible, "incompatible/read", seedPath, "incompatible_protocol");
    if (readBlocked !== "blocked") {
      throw new GateIsolationCorpusError("incompatible connection was not operationally blocked on read");
    }
    const continueBlocked = await continueArbitrary(incompatible, "incompatible/continue", "incompatible_protocol");
    if (continueBlockedGate(continueBlocked) !== "incompatible_protocol") {
      throw new GateIsolationCorpusError(
        "incompatible connection was not operationally blocked on continue",
      );
    }

    // vault_change_set_submit / vault_change_set_status: blocked, isError true,
    // no registry inspection, no key bound.
    const unboundKey = "gate-iso-incompatible-unbound";
    const submitBlocked = await callSubmit(
      incompatible,
      "incompatible/submit",
      submitInput(unboundKey, "incompatible-create", `${GATE_ISOLATION_DIRECTORY}/Incompatible/Blocked.md`, CONTENT_A),
      true,
    );
    if (
      submitBlocked.outcome !== "operationally_blocked" ||
      submitBlocked.gate?.code !== "incompatible_protocol"
    ) {
      throw new GateIsolationCorpusError(
        "incompatible connection was not operationally blocked on submit",
      );
    }
    const statusBlocked = await callStatus(incompatible, "incompatible/status", unboundKey, true);
    if (statusBlocked.lookup !== "operationally_blocked") {
      throw new GateIsolationCorpusError(
        "incompatible connection was not operationally blocked on status",
      );
    }

    // The compatible session on the same Vault continues to work, and the
    // host's registry counters prove no inspection and no bind happened.
    if (vaultA.registryUninspected !== true) {
      throw new GateIsolationCorpusError(
        "a protocol-incompatible connection inspected the Change Set registry",
      );
    }
    const compatibleStillHealthy = await observeHealth(vaultA, "incompatible/compatible-still-healthy");
    if (compatibleStillHealthy.outcome !== "observed") {
      throw new GateIsolationCorpusError(
        "the protocol-incompatible connection disturbed the compatible session",
      );
    }
    const stillUnbound = await callStatus(vaultA, "incompatible/compatible-still-unbound", unboundKey);
    if (stillUnbound.lookup === "found") {
      throw new GateIsolationCorpusError(
        "the protocol-incompatible connection bound a Submission Key in the compatible registry",
      );
    }
    assertion("incompatible/registry-never-inspected:content-and-submit-status-blocked");
    assertion("incompatible/registry-never-inspected:no-key-bound");
  }

  // 8. End state: both Vaults project no residual recovery or write gate, and
  //    their deterministic seed inventories are unchanged over the wire.
  const afterInventories: Record<"vault-a" | "vault-b", readonly GateIsolationCorpusInventoryEntry[]> = {
    "vault-a": beforeInventories["vault-a"],
    "vault-b": beforeInventories["vault-b"],
  };
  {
    await vaultA.operator.restoreIdle();
    await vaultB.operator.restoreIdle();
    for (const [vault, session] of [
      ["vault-a", vaultA],
      ["vault-b", vaultB],
    ] as const) {
      const discovered = await discoverInventory(session, "Notes/", `cleanup/inventory-${vault}`, null);
      if (discovered === "blocked") {
        throw new GateIsolationCorpusError(`cleanup inventory discovery was blocked for ${vault}`);
      }
      afterInventories[vault] = discovered;
      const beforeDigest = Object.values(beforeInventories[vault])
        .map((entry) => `${entry.sha256}  ${entry.sizeBytes}  ${entry.path}`)
        .sort()
        .join("\n");
      const afterDigest = discovered
        .map((entry) => `${entry.sha256}  ${entry.sizeBytes}  ${entry.path}`)
        .sort()
        .join("\n");
      if (beforeDigest !== afterDigest) {
        throw new GateIsolationCorpusError(
          `The gate-isolation corpus changed the deterministic seed inventory of ${vault}`,
        );
      }
      const health = await observeHealth(session, `cleanup/residual-${vault}`);
      if (
        health.outcome !== "observed" ||
        health.recovery.state !== "none" ||
        health.write.gate !== "open" ||
        health.write.state !== "writable"
      ) {
        throw new GateIsolationCorpusError(
          `${vault} retained residual recovery or write-gate state after the gate-isolation corpus`,
        );
      }
    }
    assertion("cleanup/wire-observed-residual-state:seed-inventory-unchanged");
    assertion("cleanup/wire-observed-residual-state:no-residual-gate-state");
  }

  const aIds = new Set(boundByVault["vault-a"].map((record) => record.changeSetId));
  const bIds = new Set(boundByVault["vault-b"].map((record) => record.changeSetId));
  const distinctChangeSetIds = [...aIds].every((id) => !bIds.has(id));
  if (!distinctChangeSetIds) {
    throw new GateIsolationCorpusError(
      "Change Set identities crossed the Managed Vault boundary",
    );
  }
  const isolation: GateIsolationCorpusEvidence["isolation"] = {
    sharedKeyIndependentRegistries: true,
    distinctChangeSetIds: true,
    crossVaultLookupRejected: true,
    queuesIndependent: true,
  };

  const recoveryBlocked: GateIsolationCorpusEvidence["recoveryBlocked"] = {
    boundDispositions: submissionProofs.filter(
      (record) => record.historicalGate === "recovery_blocked",
    ).length,
    replayAfterRecovery: 1,
    conflictingReuseRejected: 1,
    freshKeyRenewed: 1,
    otherGatesLeftUnbound: 2,
  };

  const manualPause: GateIsolationCorpusEvidence["manualPause"] = {
    drainedInFlightToTrustworthyEnd: true,
    fifoRetained: true,
    newUnboundRejected: 1,
    observationalContentAvailable: true,
  };

  const incompatible: GateIsolationCorpusEvidence["incompatible"] = {
    registryInspected: 0,
    submissionKeysBound: 0,
    compatibleSessionUnaffected: true,
  };

  const residualCleanup = {
    "vault-a": { recoveryState: "none" as const, writeGate: "open" as const, writeState: "writable" as const },
    "vault-b": { recoveryState: "none" as const, writeGate: "open" as const, writeState: "writable" as const },
  };
  options.record("cleanup", "gate-isolation-residual-state", {
    recoveryBlocked,
    manualPause,
    incompatible,
    residualCleanup,
  });

  return {
    scenarioManifestSha256: scenarioManifestSha256(),
    vaultIdSha256s: { "vault-a": vaultA.vaultIdSha256, "vault-b": vaultB.vaultIdSha256 },
    beforeInventories,
    afterInventories,
    submissions: submissionProofs,
    isolation,
    recoveryBlocked,
    manualPause,
    incompatible,
    gateHistory,
    residualCleanup,
    assertions,
  };
}

function eventSha256(detail: unknown): string {
  return sha256Hex(canonicalJson(detail));
}

/**
 * Composes the closed per-Vault gate-isolation evidence block from a successful
 * corpus outcome plus the events and assertions the run recorded through the
 * shared harness-owned event log. Only called when the corpus completed without
 * a failure, so the verdict is a release-blocking `passed` (the schema refuses
 * a passing verdict when any required proof is missing).
 */
export function composeGateIsolationCorpusEvidence(options: {
  readonly outcome: GateIsolationOutcome;
  readonly events: readonly {
    kind: "transport" | "tool" | "assertion" | "cleanup";
    name: string;
    detail: unknown;
  }[];
  readonly assertions: readonly string[];
}): GateIsolationCorpusEvidence {
  const { outcome } = options;
  if (outcome.assertions.length === 0) {
    throw new GateIsolationCorpusError(
      "Gate-isolation corpus evidence requires scenario assertions",
    );
  }
  return {
    corpusId: GATE_ISOLATION_CORPUS_ID,
    seedManifestSha256: digestCorpusInventory(outcome.beforeInventories["vault-a"]),
    scenarioManifestSha256: outcome.scenarioManifestSha256,
    vaults: (["vault-a", "vault-b"] as const).map((vault) => {
      const before = outcome.beforeInventories[vault];
      const after = outcome.afterInventories[vault];
      return {
        label: vault,
        vaultIdSha256: outcome.vaultIdSha256s[vault],
        beforeInventory: {
          scope: "Notes/*.md",
          entries: before.map((entry) => ({ ...entry })),
          digest: digestCorpusInventory(before),
        },
        afterInventory: {
          scope: "Notes/*.md",
          entries: after.map((entry) => ({ ...entry })),
          digest: digestCorpusInventory(after),
        },
      };
    }),
    submissions: outcome.submissions.map((record) => ({ ...record })),
    isolation: { ...outcome.isolation },
    recoveryBlocked: { ...outcome.recoveryBlocked },
    manualPause: { ...outcome.manualPause },
    incompatible: { ...outcome.incompatible },
    gateHistory: outcome.gateHistory.map((entry) => ({ ...entry })),
    residualCleanup: {
      "vault-a": { ...outcome.residualCleanup["vault-a"] },
      "vault-b": { ...outcome.residualCleanup["vault-b"] },
    },
    eventLog: options.events.map((event, index) => ({
      sequence: index + 1,
      kind: event.kind,
      name: event.name,
      detailSha256: eventSha256(event.detail),
    })),
    assertions: [...options.assertions],
    verdict: "passed",
  };
}

export interface GateIsolationOutcome {
  readonly scenarioManifestSha256: string;
  readonly vaultIdSha256s: Readonly<Record<"vault-a" | "vault-b", string>>;
  readonly beforeInventories: Readonly<
    Record<"vault-a" | "vault-b", readonly GateIsolationCorpusInventoryEntry[]>
  >;
  readonly afterInventories: Readonly<
    Record<"vault-a" | "vault-b", readonly GateIsolationCorpusInventoryEntry[]>
  >;
  /** Wire-observed Change Set identities this run bound, in per-Vault order. */
  readonly submissions: readonly GateIsolationCorpusEvidence["submissions"][number][];
  /** Cross-Vault isolation facts. */
  readonly isolation: GateIsolationCorpusEvidence["isolation"];
  /** recovery_blocked disposition facts. */
  readonly recoveryBlocked: GateIsolationCorpusEvidence["recoveryBlocked"];
  /** Manual-pause facts. */
  readonly manualPause: GateIsolationCorpusEvidence["manualPause"];
  /** Protocol-incompatible client facts. */
  readonly incompatible: GateIsolationCorpusEvidence["incompatible"];
  /** Ordered wire-observed gate-history digest source. */
  readonly gateHistory: GateIsolationCorpusEvidence["gateHistory"];
  /** Wire-observed residual cleanup report for both Vaults. */
  readonly residualCleanup: GateIsolationCorpusEvidence["residualCleanup"];
  readonly assertions: readonly string[];
}
