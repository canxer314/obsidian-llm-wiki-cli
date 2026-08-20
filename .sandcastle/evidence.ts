import type { SandcastleLiveStatusPort } from "./live-status.ts";

export interface SandcastleExecutionContext {
  readonly runId: string;
  readonly batchId: number;
  readonly issueNumber: number;
  readonly liveStatus?: SandcastleLiveStatusPort;
}

type SessionRole = "planner" | "implementer" | "reviewer" | "merger";
type SessionStage = "planner" | "implementer" | "reviewer" | "repair" | "merger";
type SessionOutcome = "completed" | "failed" | "blocked";
type GateContext = "sandcastle/local-quality" | "sandcastle/review";
type EvidenceOutcome = "success" | "failure" | "error";

export type SandcastleEvidenceEvent =
  | (SandcastleExecutionContext & {
    readonly kind: "session-started";
    readonly role: SessionRole;
    readonly stage?: SessionStage;
    readonly attempt: number;
    readonly sessionName: string;
    readonly timestamp?: string;
    readonly pullRequestNumber?: number;
    readonly revision?: string;
  })
  | (SandcastleExecutionContext & {
    readonly kind: "session-finished";
    readonly role: SessionRole;
    readonly stage: SessionStage;
    readonly attempt: number;
    readonly sessionName: string;
    readonly timestamp: string;
    readonly durationMs: number;
    readonly outcome: SessionOutcome;
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

export function validateSandcastleRunId(runId: string): void {
  requireIdentifier("runId", runId);
}

function requireNumber(name: string, value: number, minimum: number): void {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`Sandcastle evidence ${name} is invalid`);
  }
}

function normalizedEvent(event: SandcastleEvidenceEvent): SandcastleEvidenceEvent {
  const execution = {
    runId: event.runId,
    batchId: event.batchId,
    issueNumber: event.issueNumber,
  };
  switch (event.kind) {
    case "session-started":
      return {
        kind: event.kind,
        ...execution,
        role: event.role,
        ...(event.stage === undefined ? {} : { stage: event.stage }),
        attempt: event.attempt,
        sessionName: event.sessionName,
        ...(event.timestamp === undefined ? {} : { timestamp: event.timestamp }),
        ...(event.pullRequestNumber === undefined
          ? {}
          : { pullRequestNumber: event.pullRequestNumber }),
        ...(event.revision === undefined ? {} : { revision: event.revision }),
      };
    case "session-finished":
      return {
        kind: event.kind,
        ...execution,
        role: event.role,
        stage: event.stage,
        attempt: event.attempt,
        sessionName: event.sessionName,
        timestamp: event.timestamp,
        durationMs: event.durationMs,
        outcome: event.outcome,
        ...(event.pullRequestNumber === undefined
          ? {}
          : { pullRequestNumber: event.pullRequestNumber }),
        ...(event.revision === undefined ? {} : { revision: event.revision }),
      };
    case "gate-finished":
      return {
        kind: event.kind,
        ...execution,
        pullRequestNumber: event.pullRequestNumber,
        revision: event.revision,
        context: event.context,
        outcome: event.outcome,
      };
    case "merge-requested":
      return {
        kind: event.kind,
        ...execution,
        pullRequestNumber: event.pullRequestNumber,
        expectedHeadSha: event.expectedHeadSha,
      };
    case "workflow-finished":
      return {
        kind: event.kind,
        ...execution,
        outcome: event.outcome,
        ...(event.revision === undefined ? {} : { revision: event.revision }),
        ...(event.failureStage === undefined ? {} : { failureStage: event.failureStage }),
      };
  }
}

const SESSION_ROLES = new Set<unknown>(["planner", "implementer", "reviewer", "merger"]);
const SESSION_STAGES = new Set<unknown>(["planner", "implementer", "reviewer", "repair", "merger"]);
const SESSION_OUTCOMES = new Set<unknown>(["completed", "failed", "blocked"]);
const GATE_CONTEXTS = new Set<unknown>(["sandcastle/local-quality", "sandcastle/review"]);
const EVIDENCE_OUTCOMES = new Set<unknown>(["success", "failure", "error"]);

function validateEvent(event: SandcastleEvidenceEvent): void {
  validateSandcastleRunId(event.runId);
  requireNumber("batchId", event.batchId, 0);
  requireNumber("issueNumber", event.issueNumber, 1);
  if ("pullRequestNumber" in event && event.pullRequestNumber !== undefined) {
    requireNumber("pullRequestNumber", event.pullRequestNumber, 1);
  }
  if ("attempt" in event) requireNumber("attempt", event.attempt, 0);
  if ("durationMs" in event) requireNumber("durationMs", event.durationMs, 0);
  if ("sessionName" in event) requireIdentifier("sessionName", event.sessionName);
  if ("timestamp" in event && event.timestamp !== undefined &&
      new Date(event.timestamp).toISOString() !== event.timestamp) {
    throw new Error("Sandcastle evidence timestamp is invalid");
  }
  if ("failureStage" in event && event.failureStage !== undefined) {
    requireIdentifier("failureStage", event.failureStage);
  }
  if ((event.kind === "session-started" || event.kind === "session-finished") &&
      !SESSION_ROLES.has(event.role)) {
    throw new Error("Sandcastle evidence role is invalid");
  }
  if (event.kind === "session-finished" &&
      (!SESSION_STAGES.has(event.stage) || !SESSION_OUTCOMES.has(event.outcome))) {
    throw new Error("Sandcastle evidence session lifecycle is invalid");
  }
  if (event.kind === "session-started" && event.stage !== undefined &&
      !SESSION_STAGES.has(event.stage)) {
    throw new Error("Sandcastle evidence session stage is invalid");
  }
  if (event.kind === "gate-finished" && (
    !GATE_CONTEXTS.has(event.context) || !EVIDENCE_OUTCOMES.has(event.outcome)
  )) {
    throw new Error("Sandcastle evidence gate result is invalid");
  }
  if (event.kind === "workflow-finished" &&
      event.outcome !== "merged" && event.outcome !== "failed") {
    throw new Error("Sandcastle evidence workflow outcome is invalid");
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
      const normalized = normalizedEvent(event);
      validateEvent(normalized);
      write(normalized);
    },
  };
}

export async function recordSandcastleSession<TResult>(
  recorder: SandcastleEvidenceRecorder,
  execution: SandcastleExecutionContext,
  fields: {
    readonly role: SessionRole;
    readonly stage: SessionStage;
    readonly attempt: number;
    readonly sessionName: string;
    readonly pullRequestNumber?: number;
    readonly revision?: string;
  },
  run: () => Promise<TResult>,
  dependencies: {
    readonly monotonicNow?: () => number;
    readonly utcNow?: () => Date;
    readonly outcome?: (result: TResult) => SessionOutcome;
  } = {},
): Promise<TResult> {
  const monotonicNow = dependencies.monotonicNow ?? (() => performance.now());
  const utcNow = dependencies.utcNow ?? (() => new Date());
  const startedAt = monotonicNow();
  recorder.record({
    kind: "session-started",
    ...execution,
    ...fields,
    timestamp: utcNow().toISOString(),
  });
  try {
    const result = await run();
    recorder.record({
      kind: "session-finished",
      ...execution,
      ...fields,
      timestamp: utcNow().toISOString(),
      durationMs: Math.max(0, Math.floor(monotonicNow() - startedAt)),
      outcome: dependencies.outcome?.(result) ?? "completed",
    });
    return result;
  } catch (error) {
    recorder.record({
      kind: "session-finished",
      ...execution,
      ...fields,
      timestamp: utcNow().toISOString(),
      durationMs: Math.max(0, Math.floor(monotonicNow() - startedAt)),
      outcome: "failed",
    });
    throw error;
  }
}

export async function recordSandcastleGate<TResult extends {
  readonly status: EvidenceOutcome;
  readonly revision: string;
}>(
  recorder: SandcastleEvidenceRecorder,
  execution: SandcastleExecutionContext,
  fields: {
    readonly pullRequestNumber: number;
    readonly revision: string;
    readonly context: GateContext;
  },
  run: () => Promise<TResult>,
): Promise<TResult> {
  try {
    const result = await run();
    recorder.record({
      kind: "gate-finished",
      ...execution,
      ...fields,
      revision: result.revision,
      outcome: result.status,
    });
    return result;
  } catch (error) {
    recorder.record({
      kind: "gate-finished",
      ...execution,
      ...fields,
      outcome: "error",
    });
    throw error;
  }
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
