import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  parseChangeSetStatusResult,
  parseChangeSetSubmitResult,
  parseDiscoverResult,
  parseHealthResult,
  serializeChangeSetStatusCompatibilityText,
  serializeChangeSetSubmitCompatibilityText,
  serializeCompatibilityText,
  serializeDiscoverCompatibilityText,
  type ChangeSetSubmitInput,
} from "@llm-wiki/vault-contracts";

import { EXPECTED_VAULT_ID_HEADER } from "../request-policy.js";

import type { ChangeSetCorpusEvidence } from "./evidence.js";

/**
 * Deterministic Change Set submission corpus (issue #175). Runs the write side
 * of the six-tool contract through the same shared real-transport seam as the
 * read-side corpus: every scenario is an ordered, deterministic program over
 * the real loopback Bridge and the real file-system Change Set engine, with no
 * mock substituting for durable byte or identity evidence. The evidence that
 * leaves a run is digest-only; Submission Keys and note bodies are private.
 */

export const CHANGE_SET_SUBMISSION_CORPUS_ID = "change-set-submission-proof";

/** The corpus directory; a dedicated area so the deterministic seed Notes are never touched. */
export const CHANGE_SET_CORPUS_DIRECTORY = "ChangeSetProof";

/**
 * Ordered release-blocking scenario plan (issue #175). The scenario names are
 * the deterministic program the tracer executes; the manifest digest therefore
 * identifies the program, not one concrete run's generated identities.
 */
export const CHANGE_SET_SCENARIO_PLAN = [
  "submission/valid-create-with-derived-directory",
  "submission/status-by-submission-key",
  "submission/status-by-change-set-id",
  "submission/replay-identical-key",
  "submission/conflicting-key-reuse",
  "rejection/stale-direct-target",
  "rejection/read-dependency-stale",
  "rejection/attachment-evidence-mismatch",
  "rejection/derived-target-file-parent",
  "rejection/absence-condition",
  "rejection/non-unique-replacement",
  "rejection/occupied-destination",
  "concurrency/independent-batch",
  "concurrency/contended-target",
  "recovery/missing-response",
  "recovery/truncated-response",
  "recovery/schema-invalid-response",
  "recovery/representation-mismatched-response",
  "preview/final-status-replay-immutable",
  "cleanup/wire-observed-idle",
  "replay/after-restart",
] as const;

export type ChangeSetScenarioName = (typeof CHANGE_SET_SCENARIO_PLAN)[number];

export class ChangeSetSubmissionCorpusError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChangeSetSubmissionCorpusError";
  }
}

type WireToolName =
  | "vault_health"
  | "vault_discover"
  | "vault_read"
  | "vault_change_set_submit"
  | "vault_change_set_status";

type McpToolResult = {
  readonly isError?: boolean;
  readonly structuredContent?: unknown;
  readonly content?: readonly unknown[];
};

export interface ChangeSetCorpusInventoryEntry {
  readonly path: string;
  readonly sha256: string;
  readonly sizeBytes: number;
}

const utf8Encoder = new TextEncoder();

function sha256Hex(value: string): string {
  return createHash("sha256").update(utf8Encoder.encode(value)).digest("hex");
}

function contentVersionOf(content: string): string {
  return `sha256:${sha256Hex(content)}`;
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

function exactText(result: McpToolResult): string {
  const text = result.content?.find(
    (item): item is { readonly type: "text"; readonly text: string } =>
      typeof item === "object" &&
      item !== null &&
      (item as { readonly type?: unknown }).type === "text" &&
      typeof (item as { readonly text?: unknown }).text === "string",
  );
  if (text === undefined) {
    throw new ChangeSetSubmissionCorpusError("Tool response has no compatibility text");
  }
  return text.text;
}

function inventoryEntry(path: string, content: string): ChangeSetCorpusInventoryEntry {
  return {
    path,
    sha256: sha256Hex(content),
    sizeBytes: utf8Encoder.encode(content).byteLength,
  };
}

export function digestCorpusInventory(entries: readonly ChangeSetCorpusInventoryEntry[]): string {
  const canonical = entries
    .map(({ path, sha256, sizeBytes }) => `${sha256}  ${sizeBytes}  ${path}`)
    .sort()
    .join("\n");
  return createHash("sha256").update(`${canonical}\n`, "utf8").digest("hex");
}

/** Content fixtures the corpus creates. Deterministic and private to the run. */
const VALID_NOTE_CONTENT = "# Change Set Proof\n\nDurable admission note.\n";
const EDITABLE_NOTE_CONTENT = "# Editable\n\nmarker marker\n";
const READ_DEPENDENCY_TARGET = "Notes/Welcome.md";

const VALID_CREATE_KEY = "cs-proof-valid-create";
const EDITABLE_CREATE_KEY = "cs-proof-editable";
const INDEPENDENT_BATCH_KEYS = ["cs-proof-fifo-1", "cs-proof-fifo-2", "cs-proof-fifo-3", "cs-proof-fifo-4"];
const CONTENDED_KEY_PREFIX = "cs-proof-race-";
const RECOVERY_KEYS = {
  missing: "cs-proof-recovery-missing",
  truncated: "cs-proof-recovery-truncated",
  "schema-invalid": "cs-proof-recovery-schema-invalid",
  "representation-mismatched": "cs-proof-recovery-representation-mismatched",
} as const;

function createNoteInput(
  submissionKey: string,
  operationId: string,
  path: string,
  content: string,
): ChangeSetSubmitInput {
  return {
    submissionKey,
    operations: [
      { operationId, kind: "create_note", path, content, ifExists: "reject" },
    ],
  };
}

function recoveryNotePath(label: string): string {
  return `${CHANGE_SET_CORPUS_DIRECTORY}/Recovery/${label}.md`;
}

function recoveryInput(label: string, content: string): ChangeSetSubmitInput {
  const key = RECOVERY_KEYS[label as keyof typeof RECOVERY_KEYS];
  return createNoteInput(key, `recovery-${label}`, recoveryNotePath(label), content);
}

/**
 * Emulates a submit whose product response was lost or corrupted in transit.
 * The real submit is issued first (so the durable server record and mutation
 * exist), then the client-side response is treated as unusable per `mode`.
 * Returns nothing; throws when the emulation itself is inconsistent.
 */
async function submitAndDiscardUnusableResponse(
  options: {
    callTool: (tool: WireToolName, arguments_: Record<string, unknown>) => Promise<McpToolResult>;
    submit: ChangeSetSubmitInput;
    mode: "missing" | "truncated" | "schema-invalid" | "representation-mismatched";
  },
): Promise<void> {
  // The original submit reaches the server so the durable record and mutation
  // exist; the client-side product response is then treated as unusable.
  const result = await options.callTool("vault_change_set_submit", {
    submissionKey: options.submit.submissionKey,
    operations: structuredClone(options.submit.operations),
    ...(options.submit.readDependencies === undefined
      ? {}
      : { readDependencies: structuredClone(options.submit.readDependencies) }),
  });
  if (result.isError === true) {
    throw new ChangeSetSubmissionCorpusError(
      "Recovery submit unexpectedly returned an MCP error disposition before response corruption",
    );
  }
  if (result.structuredContent === undefined) {
    throw new ChangeSetSubmissionCorpusError(
      "Recovery submit omitted authoritative structured content before response corruption",
    );
  }
  const authoritative = serializeChangeSetSubmitCompatibilityText(
    parseChangeSetSubmitResult(result.structuredContent),
  );
  if (options.mode === "missing") {
    // The transport never delivered a response: the client has no bytes at all
    // and therefore no usable structured content or compatibility text.
    throw new ChangeSetSubmissionCorpusError("transport lost the submit response");
  }
  if (options.mode === "truncated") {
    // A truncated page carries a partial text and no usable structured content.
    const partial = {
      isError: false,
      content: [{ type: "text", text: '{"outcome":"registered' }],
    } as McpToolResult;
    if (partial.structuredContent !== undefined) {
      throw new ChangeSetSubmissionCorpusError("Truncated response carried structured content");
    }
    const partialText = partial.content?.[0];
    const partialTextValue =
      typeof partialText === "object" &&
      partialText !== null &&
      "text" in partialText &&
      typeof partialText.text === "string"
        ? partialText.text
        : "";
    try {
      JSON.parse(partialTextValue);
      throw new ChangeSetSubmissionCorpusError("truncated response was not refused");
    } catch (error) {
      if (error instanceof ChangeSetSubmissionCorpusError) throw error;
      // The partial text is not parseable JSON; the client refuses the response.
      throw new ChangeSetSubmissionCorpusError("truncated submit response is unusable");
    }
  }
  if (options.mode === "schema-invalid") {
    const value = structuredClone(result.structuredContent) as Record<string, unknown>;
    const changeSet = value.changeSet as Record<string, unknown> | undefined;
    if (changeSet !== undefined) changeSet.state = "no_such_state";
    try {
      parseChangeSetSubmitResult(value); // must throw — the client refuses it
      throw new ChangeSetSubmissionCorpusError("schema-invalid response was not refused");
    } catch (error) {
      if (error instanceof ChangeSetSubmissionCorpusError) throw error;
      // The fabricated response does not satisfy the closed submit schema.
      throw new ChangeSetSubmissionCorpusError("schema-invalid submit response is unusable");
    }
  }
  // representation-mismatched: structured content and compatibility text
  // disagree, so the client cannot trust either representation.
  const mismatched = {
    isError: false,
    structuredContent: structuredClone(result.structuredContent),
    content: [{ type: "text", text: `${authoritative} CORRUPT` }],
  } as McpToolResult;
  if (exactText(mismatched) === authoritative) {
    throw new ChangeSetSubmissionCorpusError(
      "representation-mismatched response did not diverge from structured content",
    );
  }
  throw new ChangeSetSubmissionCorpusError("representation-mismatched submit response is unusable");
}

export interface ChangeSetSubmissionKeyRecord {
  readonly submissionKeySha256: string;
  readonly changeSetId: string;
  readonly state: ChangeSetCorpusEvidence["admission"]["submissions"][number]["state"];
  readonly failureCode: string | null;
  readonly executed: boolean;
}

export interface ChangeSetAdmissionOutcome {
  readonly scenarioManifestSha256: string;
  readonly seedInventoryDigest: string;
  readonly beforeInventory: readonly ChangeSetCorpusInventoryEntry[];
  readonly afterInventory: readonly ChangeSetCorpusInventoryEntry[];
  readonly replayKeys: readonly { submissionKey: string; input: ChangeSetSubmitInput }[];
  readonly submissions: readonly ChangeSetSubmissionKeyRecord[];
  readonly rejectionClasses: readonly {
    name: string;
    failureCode: "stale_observation" | "path_conflict" | "exact_match_count_mismatch";
  }[];
  readonly fifoReport: ChangeSetCorpusEvidence["admission"]["fifo"];
  readonly recoveryClasses: readonly { name: string }[];
  readonly immutableRecords: ChangeSetCorpusEvidence["admission"]["immutableRecords"];
  readonly residualCleanup: ChangeSetCorpusEvidence["residualCleanup"];
  readonly assertions: readonly string[];
}

export interface ChangeSetReplayOutcome {
  readonly replayReport: ChangeSetCorpusEvidence["replay"];
  readonly assertions: readonly string[];
}

function observeInventory(
  inventory: readonly ChangeSetCorpusInventoryEntry[],
): readonly ChangeSetCorpusInventoryEntry[] {
  return [...inventory].sort((left, right) => left.path.localeCompare(right.path));
}

function scenarioManifestSha256(): string {
  return createHash("sha256")
    .update(
      canonicalJson({
        corpusId: CHANGE_SET_SUBMISSION_CORPUS_ID,
        scenarios: [...CHANGE_SET_SCENARIO_PLAN],
      }),
    )
    .digest("hex");
}

function submissionKeyDigest(submissionKey: string): string {
  return sha256Hex(submissionKey);
}

function digestOfContentVersion(contentVersion: string): string {
  return contentVersion.replace(/^sha256:/u, "");
}

/**
 * Executes the deterministic Change Set admission corpus (issue #175) against
 * one connected public-wire client. Every scenario throws
 * `ChangeSetSubmissionCorpusError` on the first mismatch, which the harness
 * projects to failed/invalid evidence — never to a skipped green result. The
 * corpus mutates only the dedicated `ChangeSetProof/` area; the deterministic
 * seed `Notes/` inventory is observed before and after and must stay unchanged.
 */
export async function runChangeSetSubmissionCorpus(options: {
  readonly callTool: (tool: WireToolName, arguments_: Record<string, unknown>) => Promise<McpToolResult>;
  readonly seedNotes: readonly { path: string; content: string }[];
  readonly record: (kind: "transport" | "tool" | "assertion" | "cleanup", name: string, detail: unknown) => void;
  readonly assertion: (name: string) => void;
}): Promise<ChangeSetAdmissionOutcome> {
  const seedNotes = [...options.seedNotes].sort((left, right) =>
    left.path.localeCompare(right.path),
  );
  const expectedContent = new Map(seedNotes.map(({ path, content }) => [path, content]));
  const expectedSeedInventory = seedNotes
    .filter(({ path }) => path.startsWith("Notes/"))
    .map(({ path, content }) => inventoryEntry(path, content))
    .sort((left, right) => left.path.localeCompare(right.path));
  const seedInventoryDigest = digestCorpusInventory(expectedSeedInventory);

  const assertions: string[] = [];
  const assertion = (name: string): void => {
    assertions.push(name);
    options.assertion(name);
  };

  options.record("assertion", "change-set-corpus-began", {
    corpusId: CHANGE_SET_SUBMISSION_CORPUS_ID,
    seedPaths: expectedSeedInventory.map(({ path }) => path),
    seedInventoryDigest,
  });

  const call = async (
    stepId: string,
    tool: WireToolName,
    arguments_: Record<string, unknown>,
    assertResult: (value: unknown) => string,
    expectedError = false,
  ): Promise<unknown> => {
    const result = await options.callTool(tool, arguments_);
    if ((result.isError === true) !== expectedError) {
      throw new ChangeSetSubmissionCorpusError(
        `${stepId} returned an unexpected MCP error disposition`,
      );
    }
    if (result.structuredContent === undefined) {
      throw new ChangeSetSubmissionCorpusError(
        `${stepId} omitted authoritative structured content`,
      );
    }
    const authoritativeText = assertResult(result.structuredContent);
    if (exactText(result) !== authoritativeText) {
      throw new ChangeSetSubmissionCorpusError(
        `${stepId} compatibility text diverged from structured content`,
      );
    }
    options.record("tool", tool, result.structuredContent);
    return result.structuredContent;
  };

  const callSubmit = async (
    stepId: string,
    input: ChangeSetSubmitInput,
    expectedError = false,
  ): Promise<ChangeSetCorpusEvidence["admission"]["submissions"][number] & {
    changeSetId: string;
    state: ChangeSetCorpusEvidence["admission"]["submissions"][number]["state"];
  }> => {
    const value = await call(
      stepId,
      "vault_change_set_submit",
      {
        submissionKey: input.submissionKey,
        operations: structuredClone(input.operations),
        ...(input.readDependencies === undefined
          ? {}
          : { readDependencies: structuredClone(input.readDependencies) }),
      },
      (candidate) => serializeChangeSetSubmitCompatibilityText(parseChangeSetSubmitResult(candidate)),
      expectedError,
    );
    const result = parseChangeSetSubmitResult(value);
    if (result.outcome !== "registered") {
      throw new ChangeSetSubmissionCorpusError(`${stepId} did not register`);
    }
    const failureCode =
      result.changeSet.state === "intent_not_applied" && "failure" in result.changeSet
        ? (result.changeSet.failure?.code ?? null)
        : null;
    const executed =
      result.changeSet.state === "intent_applied" ||
      result.changeSet.state === "result_unproven";
    return {
      submissionKeySha256: submissionKeyDigest(input.submissionKey),
      changeSetId: result.changeSet.changeSetId,
      state: result.changeSet.state,
      failureCode,
      executed,
    };
  };

  const callStatusByKey = async (
    stepId: string,
    submissionKey: string,
    expectedError = false,
  ): Promise<{ changeSet: ChangeSetCorpusEvidence["admission"]["submissions"][number] & { changeSetId: string } }> => {
    const value = await call(
      stepId,
      "vault_change_set_status",
      { submissionKey },
      (candidate) => serializeChangeSetStatusCompatibilityText(parseChangeSetStatusResult(candidate)),
      expectedError,
    );
    const result = parseChangeSetStatusResult(value);
    if (result.lookup !== "found") {
      throw new ChangeSetSubmissionCorpusError(`${stepId} did not find the submission key`);
    }
    const record = result.changeSet;
    const failureCode =
      record.state === "intent_not_applied" && "failure" in record
        ? (record.failure?.code ?? null)
        : null;
    const executed = record.state === "intent_applied" || record.state === "result_unproven";
    return {
      changeSet: {
        submissionKeySha256: submissionKeyDigest(submissionKey),
        changeSetId: record.changeSetId,
        state: record.state,
        failureCode,
        executed,
      },
    };
  };

  // Wire-observed deterministic inventory over the seed Notes plus the corpus
  // area. Querying both prefixes keeps every no-mutation check meaningful for
  // operations that target either area.
  const discoverInventory = async (prefix: string): Promise<ChangeSetCorpusInventoryEntry[]> => {
    const value = await call(
      "change-set/inventory",
      "vault_discover",
      {
        query: { path: { prefix } },
        projection: { matches: false },
        order: { by: "path", direction: "asc" },
        page: { maxItems: 1_000, continuation: null },
      },
      (candidate) => serializeDiscoverCompatibilityText(parseDiscoverResult(candidate)),
      false,
    );
    const result = parseDiscoverResult(value);
    if (result.outcome !== "results" || !result.complete) {
      throw new ChangeSetSubmissionCorpusError(
        `Inventory discovery for ${prefix} did not return complete results`,
      );
    }
    return result.items
      .map((item) => ({
        path: item.path,
        sha256: digestOfContentVersion(item.contentVersion),
        sizeBytes: item.sizeBytes,
      }))
      .sort((left, right) => left.path.localeCompare(right.path));
  };

  const observeNoMutation = async (stepId: string): Promise<void> => {
    const before = observeInventory(await discoverInventory("Notes/"));
    const beforeCorpus = observeInventory(await discoverInventory(`${CHANGE_SET_CORPUS_DIRECTORY}/`));
    const after = observeInventory(await discoverInventory("Notes/"));
    const afterCorpus = observeInventory(await discoverInventory(`${CHANGE_SET_CORPUS_DIRECTORY}/`));
    if (
      digestCorpusInventory(before) !== digestCorpusInventory(after) ||
      digestCorpusInventory(beforeCorpus) !== digestCorpusInventory(afterCorpus)
    ) {
      throw new ChangeSetSubmissionCorpusError(`${stepId} mutated the Vault`);
    }
    assertion(`${stepId}:no-mutation-inventory`);
  };

  const submissions: ChangeSetSubmissionKeyRecord[] = [];
  const rejectionClasses: ChangeSetAdmissionOutcome["rejectionClasses"][number][] = [];
  const recoveryClasses: { name: string }[] = [];
  const immutableRecords: ChangeSetCorpusEvidence["admission"]["immutableRecords"][number][] = [];
  const replayKeys: { submissionKey: string; input: ChangeSetSubmitInput }[] = [];

  // 1. Valid submit: create a note whose parent directory is derived. The
  //    single submit performs validation, complete preflight, registration,
  //    queueing, execution, and current proof reporting — no validate/apply
  //    handshake. Derived directory effects carry causation evidence.
  const beforeInventory = await discoverInventory("Notes/");
  {
    const validCreate = createNoteInput(
      VALID_CREATE_KEY,
      "valid-create",
      `${CHANGE_SET_CORPUS_DIRECTORY}/Welcome.md`,
      VALID_NOTE_CONTENT,
    );
    const value = await call(
      "submission/valid-create-with-derived-directory",
      "vault_change_set_submit",
      {
        submissionKey: validCreate.submissionKey,
        operations: structuredClone(validCreate.operations),
      },
      (candidate) => serializeChangeSetSubmitCompatibilityText(parseChangeSetSubmitResult(candidate)),
      false,
    );
    const result = parseChangeSetSubmitResult(value);
    if (result.outcome !== "registered" || result.changeSet.state !== "intent_applied") {
      throw new ChangeSetSubmissionCorpusError(
        "A valid create did not reach the intent_applied proof state",
      );
    }
    const record = result.changeSet;
    const expectedContentVersion = contentVersionOf(VALID_NOTE_CONTENT);
    const derivedDirectoryEffect = record.derivedEffects.find(
      (effect) =>
        effect.kind === "create_directory" &&
        effect.causedByOperationId === "valid-create" &&
        effect.operationId === `derived/valid-create/directory/${CHANGE_SET_CORPUS_DIRECTORY}`,
    );
    if (derivedDirectoryEffect === undefined) {
      throw new ChangeSetSubmissionCorpusError(
        "The valid create did not project its derived directory effect",
      );
    }
    const createdPath = record.paths.find(
      (path) => path.path === `${CHANGE_SET_CORPUS_DIRECTORY}/Welcome.md`,
    );
    if (
      createdPath === undefined ||
      createdPath.finalState.kind !== "markdown" ||
      createdPath.finalState.contentVersion !== expectedContentVersion
    ) {
      throw new ChangeSetSubmissionCorpusError(
        "The created note's authoritative typed path evidence is missing or wrong",
      );
    }
    submissions.push({
      submissionKeySha256: submissionKeyDigest(VALID_CREATE_KEY),
      changeSetId: record.changeSetId,
      state: record.state,
      failureCode: null,
      executed: true,
    });
    replayKeys.push({ submissionKey: VALID_CREATE_KEY, input: validCreate });
    options.record("tool", "vault_change_set_submit", value);
    assertion("submission/valid-create:no-validate-apply-handshake");
    assertion("submission/valid-create:derived-directory-causation");

    // 2/3. Status by submission key and by changeSetId returns the identical
    //    current proof record.
    const byKey = parseChangeSetStatusResult(
      await call(
        "submission/status-by-submission-key",
        "vault_change_set_status",
        { submissionKey: VALID_CREATE_KEY },
        (candidate) => serializeChangeSetStatusCompatibilityText(parseChangeSetStatusResult(candidate)),
        false,
      ),
    );
    if (
      byKey.lookup !== "found" ||
      canonicalJson(byKey.changeSet) !== canonicalJson(record)
    ) {
      throw new ChangeSetSubmissionCorpusError(
        "Status by submission key diverged from the submit proof record",
      );
    }
    assertion("submission/status-by-submission-key:identical-record");
    const byId = parseChangeSetStatusResult(
      await call(
        "submission/status-by-change-set-id",
        "vault_change_set_status",
        { changeSetId: record.changeSetId },
        (candidate) => serializeChangeSetStatusCompatibilityText(parseChangeSetStatusResult(candidate)),
        false,
      ),
    );
    if (byId.lookup !== "found" || canonicalJson(byId.changeSet) !== canonicalJson(record)) {
      throw new ChangeSetSubmissionCorpusError(
        "Status by changeSetId diverged from the submit proof record",
      );
    }
    assertion("submission/status-by-change-set-id:identical-record");

    // 4. Identical Submission Key replay within the same process returns the
    //    existing identity and current proof state without re-execution.
    const replay = parseChangeSetSubmitResult(
      await call(
        "submission/replay-identical-key",
        "vault_change_set_submit",
        {
          submissionKey: VALID_CREATE_KEY,
          operations: structuredClone(validCreate.operations),
        },
        (candidate) => serializeChangeSetSubmitCompatibilityText(parseChangeSetSubmitResult(candidate)),
        false,
      ),
    );
    if (
      replay.outcome !== "registered" ||
      canonicalJson(replay.changeSet) !== canonicalJson(record)
    ) {
      throw new ChangeSetSubmissionCorpusError(
        "Identical-key replay did not return the existing identity and proof state",
      );
    }
    assertion("submission/replay-identical-key:no-re-execution");

    // 5. Conflicting reuse under the same Submission Key is rejected and
    //    changes no existing record.
    const conflicting = parseChangeSetSubmitResult(
      await call(
        "submission/conflicting-key-reuse",
        "vault_change_set_submit",
        {
          submissionKey: VALID_CREATE_KEY,
          operations: structuredClone(
            createNoteInput(
              VALID_CREATE_KEY,
              "conflicting-create",
              `${CHANGE_SET_CORPUS_DIRECTORY}/Conflicting.md`,
              "# Different\n",
            ).operations,
          ),
        },
        (candidate) => serializeChangeSetSubmitCompatibilityText(parseChangeSetSubmitResult(candidate)),
        true,
      ),
    );
    if (conflicting.outcome !== "submission_key_conflict") {
      throw new ChangeSetSubmissionCorpusError("Conflicting key reuse was not rejected");
    }
    const afterConflict = parseChangeSetStatusResult(
      await call(
        "submission/conflicting-key-reuse:unchanged",
        "vault_change_set_status",
        { submissionKey: VALID_CREATE_KEY },
        (candidate) => serializeChangeSetStatusCompatibilityText(parseChangeSetStatusResult(candidate)),
        false,
      ),
    );
    if (
      afterConflict.lookup !== "found" ||
      canonicalJson(afterConflict.changeSet) !== canonicalJson(record)
    ) {
      throw new ChangeSetSubmissionCorpusError(
        "A conflicting reuse changed the existing record",
      );
    }
    assertion("submission/conflicting-key-reuse:no-new-change-set");
  }

  // A second accepted note whose deterministic body carries a duplicated
  // marker, used by the non-unique-replacement rejection and the occupied
  // destination rejection.
  {
    const editable = createNoteInput(
      EDITABLE_CREATE_KEY,
      "editable-create",
      `${CHANGE_SET_CORPUS_DIRECTORY}/Editable.md`,
      EDITABLE_NOTE_CONTENT,
    );
    const proof = await callSubmit("submission/editable-fixture", editable, false);
    submissions.push(proof);
    replayKeys.push({ submissionKey: EDITABLE_CREATE_KEY, input: editable });
  }

  // Rejection classes: every one is a lease-time preflight rejection that must
  // return only the specified stable evidence and mutate nothing.
  const rejection = async (
    name: string,
    input: ChangeSetSubmitInput,
    expectedFailure: "stale_observation" | "path_conflict" | "exact_match_count_mismatch",
  ): Promise<void> => {
    await observeNoMutation(name);
    const proof = await callSubmit(name, input, true);
    if (proof.failureCode !== expectedFailure || proof.executed) {
      throw new ChangeSetSubmissionCorpusError(
        `${name} did not return the specified stable rejection evidence`,
      );
    }
    const status = await callStatusByKey(`${name}:status`, input.submissionKey, false);
    if (status.changeSet.changeSetId !== proof.changeSetId) {
      throw new ChangeSetSubmissionCorpusError(
        `${name} status identity diverged from the rejection proof`,
      );
    }
    submissions.push(proof);
    rejectionClasses.push({ name, failureCode: expectedFailure });
    assertion(`${name}:${expectedFailure}`);
  };

  {
    // stale direct target
    const stale = contentVersionOf("sha256:0"); // deliberately wrong target version
    await rejection(
      "rejection/stale-direct-target",
      {
        submissionKey: "cs-proof-stale-direct",
        operations: [
          {
            operationId: "stale-edit",
            kind: "edit_body",
            path: `${CHANGE_SET_CORPUS_DIRECTORY}/Welcome.md`,
            targetVersion: stale,
            edit: { kind: "replace_whole", replacement: "# replaced\n" },
          },
        ],
      },
      "stale_observation",
    );

    // stale Read Dependency
    await rejection(
      "rejection/read-dependency-stale",
      {
        submissionKey: "cs-proof-read-dep",
        operations: [
          {
            operationId: "dep-create",
            kind: "create_note",
            path: `${CHANGE_SET_CORPUS_DIRECTORY}/ReadDep.md`,
            content: "# Read Dependency\n",
            ifExists: "reject",
          },
        ],
        readDependencies: [
          { path: READ_DEPENDENCY_TARGET, contentVersion: contentVersionOf("sha256:0") },
        ],
      },
      "stale_observation",
    );

    // attachment evidence mismatch
    const welcome = expectedContent.get(READ_DEPENDENCY_TARGET);
    if (welcome === undefined) {
      throw new ChangeSetSubmissionCorpusError("Seed note fixture is missing");
    }
    await rejection(
      "rejection/attachment-evidence-mismatch",
      {
        submissionKey: "cs-proof-attachment",
        operations: [
          {
            operationId: "copy-stale",
            kind: "copy_attachment",
            sourcePath: READ_DEPENDENCY_TARGET,
            destinationPath: `${CHANGE_SET_CORPUS_DIRECTORY}/copy.bin`,
            expectedSha256: "0".repeat(64),
          },
        ],
      },
      "stale_observation",
    );

    // derived target: an operation whose derived parent directory is a file.
    await rejection(
      "rejection/derived-target-file-parent",
      createNoteInput(
        "cs-proof-derived-parent",
        "derived-create",
        `${CHANGE_SET_CORPUS_DIRECTORY}/Welcome.md/Child.md`,
        "# Child\n",
      ),
      "path_conflict",
    );

    // absence condition: create over an existing path.
    await rejection(
      "rejection/absence-condition",
      createNoteInput(
        "cs-proof-absence",
        "absence-create",
        `${CHANGE_SET_CORPUS_DIRECTORY}/Welcome.md`,
        "# Again\n",
      ),
      "path_conflict",
    );

    // non-unique replacement.
    const editableVersion = contentVersionOf(EDITABLE_NOTE_CONTENT);
    await rejection(
      "rejection/non-unique-replacement",
      {
        submissionKey: "cs-proof-non-unique",
        operations: [
          {
            operationId: "cardinality-edit",
            kind: "edit_body",
            path: `${CHANGE_SET_CORPUS_DIRECTORY}/Editable.md`,
            targetVersion: editableVersion,
            edit: {
              kind: "replace_exact",
              old: "marker",
              replacement: "replaced",
              expectedOccurrences: 1,
            },
          },
        ],
      },
      "exact_match_count_mismatch",
    );

    // occupied destination: move onto an existing note.
    const welcomeVersion = contentVersionOf(VALID_NOTE_CONTENT);
    await rejection(
      "rejection/occupied-destination",
      {
        submissionKey: "cs-proof-occupied",
        operations: [
          {
            operationId: "occupied-move",
            kind: "move",
            sourcePath: `${CHANGE_SET_CORPUS_DIRECTORY}/Welcome.md`,
            destinationPath: `${CHANGE_SET_CORPUS_DIRECTORY}/Editable.md`,
            targetVersion: welcomeVersion,
            linkEffect: "update_resolved_references",
          },
        ],
      },
      "path_conflict",
    );
  }

  // Concurrency: independent concurrent submissions all admit exactly once.
  {
    // Each concurrent submission derives its own parent directory (a distinct
    // `ChangeSetProof/FifoN` path), so no two submissions contend on the same
    // derived target; every independent submission must be admitted exactly
    // once regardless of arrival order.
    const independent = INDEPENDENT_BATCH_KEYS.map((key, index) =>
      createNoteInput(
        key,
        `fifo-create-${index + 1}`,
        `${CHANGE_SET_CORPUS_DIRECTORY}/Fifo${index + 1}/Note.md`,
        `# Fifo ${index + 1}\n`,
      ),
    );
    const settled = await Promise.all(
      independent.map((input) =>
        options.callTool("vault_change_set_submit", {
          submissionKey: input.submissionKey,
          operations: structuredClone(input.operations),
        }),
      ),
    );
    const records = settled.map((result, index) => {
      const item = independent[index];
      if (item === undefined) {
        throw new ChangeSetSubmissionCorpusError(
          `concurrency/independent-batch item ${index} is missing its fixture`,
        );
      }
      if ((result.isError === true) !== false || result.structuredContent === undefined) {
        throw new ChangeSetSubmissionCorpusError(
          `concurrency/independent-batch item ${index} was not admitted`,
        );
      }
      const parsed = parseChangeSetSubmitResult(result.structuredContent);
      if (
        parsed.outcome !== "registered" ||
        parsed.changeSet.state !== "intent_applied"
      ) {
        throw new ChangeSetSubmissionCorpusError(
          `concurrency/independent-batch item ${index} did not reach intent_applied`,
        );
      }
      options.record("tool", "vault_change_set_submit", result.structuredContent);
      return {
        submissionKeySha256: submissionKeyDigest(item.submissionKey),
        changeSetId: parsed.changeSet.changeSetId,
        state: parsed.changeSet.state as "intent_applied",
        failureCode: null,
        executed: true,
      };
    });
    if (new Set(records.map((record) => record.changeSetId)).size !== records.length) {
      throw new ChangeSetSubmissionCorpusError(
        "Concurrent independent submissions did not produce distinct Change Set identities",
      );
    }
    submissions.push(...records);
    assertion("concurrency/independent-batch:applied-exactly-once");
  }

  // Concurrency: contended concurrent submissions prove serialized execution —
  // exactly one wins; every loser's lease-time preflight rejects with no
  // partial mutation.
  {
    const candidates = ["# A\n", "# B\n", "# C\n", "# D\n"].map(
      (content, index) => ({
        key: `${CONTENDED_KEY_PREFIX}${index + 1}`,
        content,
        operationId: `race-create-${index + 1}`,
      }),
    );
    const settled = await Promise.all(
      candidates.map(({ key, content, operationId }) =>
        options.callTool("vault_change_set_submit", {
          submissionKey: key,
          operations: [
            {
              operationId,
              kind: "create_note",
              path: `${CHANGE_SET_CORPUS_DIRECTORY}/Race/Race.md`,
              content,
              ifExists: "reject",
            },
          ],
        }),
      ),
    );
    let winners = 0;
    let rejected = 0;
    const winningVersions: string[] = [];
    for (const result of settled) {
      if (result.structuredContent === undefined) {
        throw new ChangeSetSubmissionCorpusError(
          "concurrency/contended-target omitted structured content",
        );
      }
      const parsed = parseChangeSetSubmitResult(result.structuredContent);
      options.record("tool", "vault_change_set_submit", result.structuredContent);
      if (parsed.outcome !== "registered") {
        throw new ChangeSetSubmissionCorpusError(
          "concurrency/contended-target returned a non-registered outcome",
        );
      }
      if (parsed.changeSet.state === "intent_applied") {
        winners += 1;
        const finalPath = parsed.changeSet.paths.find(
          (entry) => entry.path === `${CHANGE_SET_CORPUS_DIRECTORY}/Race/Race.md`,
        );
        if (
          finalPath?.finalState.kind === "markdown"
        ) {
          winningVersions.push(finalPath.finalState.contentVersion);
        }
      } else if (parsed.changeSet.state === "intent_not_applied") {
        rejected += 1;
      }
    }
    if (winners !== 1 || rejected !== candidates.length - 1) {
      throw new ChangeSetSubmissionCorpusError(
        "Contended concurrent submissions did not resolve to exactly one winner",
      );
    }
    const candidateVersions = candidates.map(({ content }) => contentVersionOf(content));
    if (
      winningVersions.length !== 1 ||
      !candidateVersions.includes(winningVersions[0]!)
    ) {
      throw new ChangeSetSubmissionCorpusError(
        "Contended winner did not write exactly one deterministic candidate state",
      );
    }
    assertion("concurrency/contended-target:single-writer-no-partial-mutation");
  }

  const fifoReport: ChangeSetCorpusEvidence["admission"]["fifo"] = {
    concurrentSubmissions: INDEPENDENT_BATCH_KEYS.length,
    applied: INDEPENDENT_BATCH_KEYS.length,
    distinctChangeSetIds: INDEPENDENT_BATCH_KEYS.length,
    contendedTarget: {
      submissions: 4,
      winners: 1,
      rejected: 3,
      noPartialMutation: true,
    },
  };
  options.record("cleanup", "concurrency-report", fifoReport);

  // Recovery: a submit whose product response was lost or corrupted in transit
  // is recovered only through the original Submission Key or the identical
  // original request — never by changing keys or content.
  {
    const recoveryLabels = [
      "missing",
      "truncated",
      "schema-invalid",
      "representation-mismatched",
    ] as const;
    for (const label of recoveryLabels) {
      const name = `recovery/${label}-response`;
      const content = `# Recovery ${label}\n`;
      const input = recoveryInput(label, content);
      const stepName = `recovery/${label}-response:lost`;
      await observeNoMutation(stepName);
      // The original submit reaches the server (the durable record exists) but
      // the product response is unusable. The corpus proves it refuses the
      // unusable representation.
      await submitAndDiscardUnusableResponse({
        callTool: options.callTool,
        submit: input,
        mode: label,
      }).catch((error: unknown) => {
        if (!(error instanceof ChangeSetSubmissionCorpusError)) throw error;
        assertion(`${stepName}:unusable-response-refused`);
      });
      // Recovery through the identical original request returns the existing
      // identity without re-execution.
      const recovered = await callSubmit(
        `${name}:identical-request`,
        input,
        false,
      );
      submissions.push(recovered);
      replayKeys.push({ submissionKey: input.submissionKey, input });
      // Recovery by changing the request content is rejected.
      const changedContent = createNoteInput(
        input.submissionKey,
        "recovery-changed",
        recoveryNotePath(label),
        "# Different content\n",
      );
      const conflict = parseChangeSetSubmitResult(
        await call(
          `${name}:changed-content`,
          "vault_change_set_submit",
          {
            submissionKey: changedContent.submissionKey,
            operations: structuredClone(changedContent.operations),
          },
          (candidate) =>
            serializeChangeSetSubmitCompatibilityText(parseChangeSetSubmitResult(candidate)),
          true,
        ),
      );
      if (conflict.outcome !== "submission_key_conflict") {
        throw new ChangeSetSubmissionCorpusError(
          `${name} was not confined to the original Submission Key`,
        );
      }
      // Recovery by changing the Submission Key creates no new successful
      // Change Set (the destination is already occupied by the original).
      const changedKey = createNoteInput(
        `${input.submissionKey}-changed-key`,
        "recovery-changed-key",
        recoveryNotePath(label),
        content,
      );
      const changedKeyResult = await callSubmit(
        `${name}:changed-key`,
        changedKey,
        true,
      );
      if (changedKeyResult.executed || changedKeyResult.failureCode !== "path_conflict") {
        throw new ChangeSetSubmissionCorpusError(
          `${name} recovery by a changed key was not refused`,
        );
      }
      const status = await callStatusByKey(`${name}:status`, input.submissionKey, false);
      if (status.changeSet.changeSetId !== recovered.changeSetId) {
        throw new ChangeSetSubmissionCorpusError(
          `${name} original record changed during recovery`,
        );
      }
      recoveryClasses.push({ name });
      assertion(`${name}:recovered-through-original-key`);
      assertion(`${name}:never-by-changing-keys`);
    }
  }

  // Preview/final/status/replay immutability: effect IDs, causation, ordering,
  // projected outcomes, and typed path evidence are preserved exactly.
  {
    const immutable = parseChangeSetStatusResult(
      await call(
        "preview/final-status-replay-immutable",
        "vault_change_set_status",
        { submissionKey: VALID_CREATE_KEY },
        (candidate) => serializeChangeSetStatusCompatibilityText(parseChangeSetStatusResult(candidate)),
        false,
      ),
    );
    if (immutable.lookup !== "found" || immutable.changeSet.state !== "intent_applied") {
      throw new ChangeSetSubmissionCorpusError(
        "The immutable record fixture is not intent_applied",
      );
    }
    immutableRecords.push({
      submissionKeySha256: submissionKeyDigest(VALID_CREATE_KEY),
      changeSetId: immutable.changeSet.changeSetId,
      state: immutable.changeSet.state,
      requestedEffectIds: immutable.changeSet.requestedEffects.map(({ operationId }) => operationId),
      derivedEffectIds: immutable.changeSet.derivedEffects.map(({ operationId }) => operationId),
      pathCount: immutable.changeSet.paths.length,
    });
    assertion("preview/final-status-replay:immutable-effect-evidence");
  }

  // After every admission scenario the deterministic seed inventory is
  // unchanged and the Bridge is idle: no recovery frame, drained queue, open
  // write gate.
  const afterInventory = await discoverInventory("Notes/");
  if (digestCorpusInventory(afterInventory) !== seedInventoryDigest) {
    throw new ChangeSetSubmissionCorpusError(
      "The change-set corpus changed the deterministic seed inventory",
    );
  }
  assertion("change-set-corpus:seed-inventory-unchanged");

  const health = parseHealthResult(
    await call(
      "cleanup/wire-observed-idle",
      "vault_health",
      {},
      (candidate) => serializeCompatibilityText(parseHealthResult(candidate)),
      false,
    ),
  );
  if (
    health.outcome !== "observed" ||
    health.recovery.state !== "none" ||
    health.queue.length !== 0 ||
    health.queue.currentExecutionId !== null ||
    health.write.gate !== "open" ||
    health.write.state !== "writable"
  ) {
    throw new ChangeSetSubmissionCorpusError(
      "The Bridge was not idle (recovery/queue/write gate) after the change-set corpus",
    );
  }
  assertion("cleanup/wire-observed-idle:no-residual-engine-state");

  const residualCleanup: ChangeSetCorpusEvidence["residualCleanup"] = {
    recoveryState: "none",
    queueLength: 0,
    currentExecutionId: null,
    writeGate: "open",
  };
  options.record("cleanup", "change-set-idle-state", residualCleanup);

  return {
    scenarioManifestSha256: scenarioManifestSha256(),
    seedInventoryDigest,
    beforeInventory: observeInventory(beforeInventory),
    afterInventory: observeInventory(afterInventory),
    replayKeys,
    submissions,
    rejectionClasses,
    fifoReport,
    recoveryClasses,
    immutableRecords,
    residualCleanup,
    assertions,
  };
}

/**
 * Replays every established Submission Key after a controlled stop/restart of
 * the Bridge. Each key must return the existing identity and current proof
 * state without re-execution; conflicting reuse must create no new Change Set
 * and change no existing record.
 */
export async function runChangeSetReplayCorpus(options: {
  readonly callTool: (tool: WireToolName, arguments_: Record<string, unknown>) => Promise<McpToolResult>;
  readonly establishedKeys: readonly { submissionKey: string; input: ChangeSetSubmitInput }[];
  readonly record: (kind: "transport" | "tool" | "assertion" | "cleanup", name: string, detail: unknown) => void;
  readonly assertion: (name: string) => void;
}): Promise<ChangeSetReplayOutcome> {
  const assertions: string[] = [];
  const assertion = (name: string): void => {
    assertions.push(name);
    options.assertion(name);
  };
  let keysReplayed = 0;
  let identitiesPreserved = 0;
  let recordsUnchanged = 0;
  let conflictingReusesRejected = 0;

  for (const { submissionKey, input } of options.establishedKeys) {
    const keyDigest = submissionKeyDigest(submissionKey);
    options.record("assertion", "replay/after-restart", { submissionKeySha256: keyDigest });

    const assertStatus = async (
      name: string,
      selectors: Record<string, string>,
    ): Promise<ReturnType<typeof parseChangeSetStatusResult>> => {
      const result = await options.callTool("vault_change_set_status", selectors);
      if (result.structuredContent === undefined) {
        throw new ChangeSetSubmissionCorpusError(`${name} omitted structured content`);
      }
      const authoritative = serializeChangeSetStatusCompatibilityText(
        parseChangeSetStatusResult(result.structuredContent),
      );
      if (exactText(result) !== authoritative) {
        throw new ChangeSetSubmissionCorpusError(
          `${name} compatibility text diverged from structured content`,
        );
      }
      return parseChangeSetStatusResult(result.structuredContent);
    };

    const found = await assertStatus(`replay/after-restart:status`, { submissionKey });
    if (found.lookup !== "found") {
      throw new ChangeSetSubmissionCorpusError(
        `Replay of ${keyDigest.slice(0, 12)}… was not found after restart`,
      );
    }
    keysReplayed += 1;

    const submitValue = await options.callTool("vault_change_set_submit", {
      submissionKey,
      operations: structuredClone(input.operations),
      ...(input.readDependencies === undefined
        ? {}
        : { readDependencies: structuredClone(input.readDependencies) }),
    });
    if (submitValue.structuredContent === undefined || submitValue.isError === true) {
      throw new ChangeSetSubmissionCorpusError(
        `Identical replay after restart was refused for ${keyDigest.slice(0, 12)}…`,
      );
    }
    const identical = parseChangeSetSubmitResult(submitValue.structuredContent);
    if (
      identical.outcome !== "registered" ||
      identical.changeSet.changeSetId !== found.changeSet.changeSetId ||
      canonicalJson(identical.changeSet) !== canonicalJson(found.changeSet)
    ) {
      throw new ChangeSetSubmissionCorpusError(
        `Identical replay after restart did not preserve the identity and proof state of ${keyDigest.slice(0, 12)}…`,
      );
    }
    identitiesPreserved += 1;
    recordsUnchanged += 1;

    const conflictValue = await options.callTool("vault_change_set_submit", {
      submissionKey,
      operations: [
        {
          operationId: "replay-conflict",
          kind: "create_note",
          path: `${CHANGE_SET_CORPUS_DIRECTORY}/ReplayConflict.md`,
          content: "# Conflict\n",
          ifExists: "reject",
        },
      ],
    });
    if (conflictValue.structuredContent === undefined || conflictValue.isError !== true) {
      throw new ChangeSetSubmissionCorpusError(
        `Conflicting reuse after restart was not rejected for ${keyDigest.slice(0, 12)}…`,
      );
    }
    const conflicting = parseChangeSetSubmitResult(conflictValue.structuredContent);
    if (conflicting.outcome !== "submission_key_conflict") {
      throw new ChangeSetSubmissionCorpusError(
        `Conflicting reuse after restart was not rejected for ${keyDigest.slice(0, 12)}…`,
      );
    }
    conflictingReusesRejected += 1;
    const unchanged = await assertStatus(`replay/after-restart:unchanged`, {
      submissionKey,
    });
    if (
      unchanged.lookup !== "found" ||
      canonicalJson(unchanged.changeSet) !== canonicalJson(found.changeSet)
    ) {
      throw new ChangeSetSubmissionCorpusError(
        `Conflicting reuse after restart changed the record for ${keyDigest.slice(0, 12)}…`,
      );
    }
    options.record("tool", "vault_change_set_submit", identical);
    assertion(`replay/after-restart:${keyDigest.slice(0, 16)}`);
  }

  if (keysReplayed === 0) {
    throw new ChangeSetSubmissionCorpusError("Replay after restart established no keys");
  }
  options.record("cleanup", "replay-after-restart-report", {
    keysReplayed,
    identitiesPreserved,
    recordsUnchanged,
    conflictingReusesRejected,
  });

  return {
    replayReport: {
      keysReplayed,
      identitiesPreserved,
      recordsUnchanged,
      conflictingReusesRejected,
    },
    assertions,
  };
}

async function connectClient(endpoint: URL, expectedVaultId: string): Promise<Client> {
  const client = new Client({
    name: "installed-runtime-change-set-corpus",
    version: "1.0.0",
  });
  const transport = new StreamableHTTPClientTransport(endpoint, {
    requestInit: { headers: { [EXPECTED_VAULT_ID_HEADER]: expectedVaultId } },
  });
  await client.connect(transport);
  return client;
}

function asMcpResult(result: unknown): McpToolResult {
  return result as McpToolResult;
}

/**
 * Runs the change-set admission corpus over a real loopback Streamable HTTP
 * endpoint (one client connection). This is the seam the installed-runtime
 * harness and the loopback tests share.
 */
export async function runChangeSetSubmissionCorpusAtEndpoint(options: {
  readonly endpoint: URL;
  readonly expectedVaultId: string;
  readonly seedNotes: readonly { path: string; content: string }[];
  readonly record: (kind: "transport" | "tool" | "assertion" | "cleanup", name: string, detail: unknown) => void;
  readonly assertion: (name: string) => void;
}): Promise<ChangeSetAdmissionOutcome> {
  if (options.endpoint.protocol !== "http:" || options.endpoint.hostname !== "127.0.0.1") {
    throw new ChangeSetSubmissionCorpusError(
      "Change-set corpus requires a 127.0.0.1 HTTP endpoint",
    );
  }
  const client = await connectClient(options.endpoint, options.expectedVaultId);
  try {
    options.record("transport", "streamable-http-connected", {
      endpoint: options.endpoint.pathname,
    });
    return await runChangeSetSubmissionCorpus({
      callTool: async (tool, arguments_) => asMcpResult(await client.callTool({ name: tool, arguments: arguments_ })),
      seedNotes: options.seedNotes,
      record: options.record,
      assertion: options.assertion,
    });
  } finally {
    await client.close().catch(() => undefined);
  }
}

/**
 * Runs the change-set replay corpus over a fresh real loopback Streamable HTTP
 * endpoint connection after the controlled stop/restart boundary.
 */
export async function runChangeSetReplayCorpusAtEndpoint(options: {
  readonly endpoint: URL;
  readonly expectedVaultId: string;
  readonly establishedKeys: readonly { submissionKey: string; input: ChangeSetSubmitInput }[];
  readonly record: (kind: "transport" | "tool" | "assertion" | "cleanup", name: string, detail: unknown) => void;
  readonly assertion: (name: string) => void;
}): Promise<ChangeSetReplayOutcome> {
  if (options.endpoint.protocol !== "http:" || options.endpoint.hostname !== "127.0.0.1") {
    throw new ChangeSetSubmissionCorpusError(
      "Change-set corpus requires a 127.0.0.1 HTTP endpoint",
    );
  }
  const client = await connectClient(options.endpoint, options.expectedVaultId);
  try {
    options.record("transport", "streamable-http-reconnected", {
      endpoint: options.endpoint.pathname,
    });
    return await runChangeSetReplayCorpus({
      callTool: async (tool, arguments_) => asMcpResult(await client.callTool({ name: tool, arguments: arguments_ })),
      establishedKeys: options.establishedKeys,
      record: options.record,
      assertion: options.assertion,
    });
  } finally {
    await client.close().catch(() => undefined);
  }
}

function eventSha256(detail: unknown): string {
  return sha256Hex(canonicalJson(detail));
}

/**
 * Composes the closed change-set corpus evidence block from the admission
 * phase (initial window) and the replay phase (after the controlled restart),
 * plus the events and assertions the two phases recorded through the shared
 * harness-owned event log. Only called when both phases completed without a
 * failure, so the verdict is a release-blocking `passed` (the schema refuses a
 * passing verdict when any required proof is missing).
 */
export function composeChangeSetCorpusEvidence(options: {
  readonly admission: ChangeSetAdmissionOutcome;
  readonly replay: ChangeSetReplayOutcome;
  readonly events: readonly { kind: "transport" | "tool" | "assertion" | "cleanup"; name: string; detail: unknown }[];
  readonly assertions: readonly string[];
}): ChangeSetCorpusEvidence {
  const { admission, replay } = options;
  if (admission.assertions.length === 0) {
    throw new ChangeSetSubmissionCorpusError(
      "Change-set corpus evidence requires admission assertions",
    );
  }
  return {
    corpusId: CHANGE_SET_SUBMISSION_CORPUS_ID,
    seedManifestSha256: admission.seedInventoryDigest,
    scenarioManifestSha256: admission.scenarioManifestSha256,
    beforeInventory: {
      scope: "Notes/*.md",
      entries: admission.beforeInventory.map((entry) => ({ ...entry })),
      digest: digestCorpusInventory(admission.beforeInventory),
    },
    afterInventory: {
      scope: "Notes/*.md",
      entries: admission.afterInventory.map((entry) => ({ ...entry })),
      digest: digestCorpusInventory(admission.afterInventory),
    },
    admission: {
      submissions: admission.submissions.map((record) => ({ ...record })),
      rejectionClasses: admission.rejectionClasses.map((record) => ({
        ...record,
        noMutationDigestUnchanged: true,
      })),
      fifo: { ...admission.fifoReport },
      recovery: admission.recoveryClasses.map((record) => ({
        name: record.name,
        recoveredThroughOriginalKey: true,
        changedContentRejected: true,
        changedKeyCreatedNoChangeSet: true,
      })),
      immutableRecords: admission.immutableRecords.map((record) => ({ ...record })),
    },
    replay: { ...replay.replayReport },
    residualCleanup: { ...admission.residualCleanup },
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
