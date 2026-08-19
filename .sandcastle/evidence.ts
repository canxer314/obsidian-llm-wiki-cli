export interface SandcastleExecutionContext {
  readonly runId: string;
  readonly batchId: number;
  readonly issueNumber: number;
}

type SessionRole = "planner" | "implementer" | "reviewer" | "merger";
type GateContext = "sandcastle/local-quality" | "sandcastle/review";
type EvidenceOutcome = "success" | "failure" | "error";

export type SandcastleEvidenceEvent =
  | (SandcastleExecutionContext & {
    readonly kind: "session-started";
    readonly role: SessionRole;
    readonly attempt: number;
    readonly sessionName: string;
    readonly pullRequestNumber?: number;
    readonly revision?: string;
  })
  | (SandcastleExecutionContext & {
    readonly kind: "gate-finished";
    readonly pullRequestNumber: number;
    readonly revision: string;
    readonly context: GateContext;
    readonly outcome: EvidenceOutcome;
  })
  | (SandcastleExecutionContext & {
    readonly kind: "merge-requested";
    readonly pullRequestNumber: number;
    readonly expectedHeadSha: string;
  })
  | (SandcastleExecutionContext & {
    readonly kind: "workflow-finished";
    readonly outcome: "merged" | "failed";
    readonly revision?: string;
    readonly failureStage?: string;
  });

export interface SandcastleEvidenceRecorder {
  record(event: SandcastleEvidenceEvent): void;
}

const SHA_PATTERN = /^[0-9a-f]{40}$/u;
const SAFE_TEXT_PATTERN = /^[a-zA-Z0-9._:-]+$/u;

function requireIdentifier(name: string, value: string): void {
  if (value.length === 0 || value.length > 128 || !SAFE_TEXT_PATTERN.test(value)) {
    throw new Error(`Sandcastle evidence ${name} is invalid`);
  }
}

function requireNumber(name: string, value: number, minimum: number): void {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`Sandcastle evidence ${name} is invalid`);
  }
}

function validateEvent(event: SandcastleEvidenceEvent): void {
  requireIdentifier("runId", event.runId);
  requireNumber("batchId", event.batchId, 0);
  requireNumber("issueNumber", event.issueNumber, 1);
  if ("pullRequestNumber" in event && event.pullRequestNumber !== undefined) {
    requireNumber("pullRequestNumber", event.pullRequestNumber, 1);
  }
  if ("attempt" in event) requireNumber("attempt", event.attempt, 0);
  if ("sessionName" in event) requireIdentifier("sessionName", event.sessionName);
  if ("failureStage" in event && event.failureStage !== undefined) {
    requireIdentifier("failureStage", event.failureStage);
  }
  for (const revision of [
    "revision" in event ? event.revision : undefined,
    "expectedHeadSha" in event ? event.expectedHeadSha : undefined,
  ]) {
    if (revision !== undefined && !SHA_PATTERN.test(revision)) {
      throw new Error("Sandcastle evidence revision is invalid");
    }
  }
}

export function createSandcastleEvidenceRecorder(
  write: (event: SandcastleEvidenceEvent) => void,
): SandcastleEvidenceRecorder {
  return {
    record(event) {
      validateEvent(event);
      write(event);
    },
  };
}

export async function recordSandcastleGate<TResult extends {
  readonly status: EvidenceOutcome;
  readonly revision: string;
}>(
  recorder: SandcastleEvidenceRecorder,
  execution: SandcastleExecutionContext,
  fields: {
    readonly pullRequestNumber: number;
    readonly context: GateContext;
  },
  run: () => Promise<TResult>,
): Promise<TResult> {
  const result = await run();
  recorder.record({
    kind: "gate-finished",
    ...execution,
    ...fields,
    revision: result.revision,
    outcome: result.status,
  });
  return result;
}

export async function recordSandcastleMerge<TResult>(
  recorder: SandcastleEvidenceRecorder,
  execution: SandcastleExecutionContext,
  fields: {
    readonly pullRequestNumber: number;
    readonly expectedHeadSha: string;
  },
  run: () => Promise<TResult>,
): Promise<TResult> {
  recorder.record({ kind: "merge-requested", ...execution, ...fields });
  return run();
}

export async function recordSandcastleWorkflow<TResult>(
  recorder: SandcastleEvidenceRecorder,
  execution: SandcastleExecutionContext,
  run: () => Promise<TResult>,
  mergedRevision: (result: TResult) => string,
): Promise<TResult> {
  try {
    const result = await run();
    recorder.record({
      kind: "workflow-finished",
      ...execution,
      outcome: "merged",
      revision: mergedRevision(result),
    });
    return result;
  } catch (error) {
    recorder.record({
      kind: "workflow-finished",
      ...execution,
      outcome: "failed",
      ...(typeof error === "object" && error !== null && "stage" in error &&
          typeof error.stage === "string"
        ? { failureStage: error.stage }
        : {}),
    });
    throw error;
  }
}
