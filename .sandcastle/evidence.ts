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

type EventFields<TKind extends SandcastleEvidenceEvent["kind"]> = Omit<
  Extract<SandcastleEvidenceEvent, { readonly kind: TKind }>,
  keyof SandcastleExecutionContext | "kind"
>;

export interface SandcastleEvidenceRecorder {
  sessionStarted(
    context: SandcastleExecutionContext,
    fields: EventFields<"session-started">,
  ): void;
  gateFinished(
    context: SandcastleExecutionContext,
    fields: EventFields<"gate-finished">,
  ): void;
  mergeRequested(
    context: SandcastleExecutionContext,
    fields: EventFields<"merge-requested">,
  ): void;
  workflowFinished(
    context: SandcastleExecutionContext,
    fields: EventFields<"workflow-finished">,
  ): void;
}

export async function recordSandcastleWorkflow<TResult>(
  recorder: SandcastleEvidenceRecorder,
  context: SandcastleExecutionContext,
  run: () => Promise<TResult>,
  mergedRevision: (result: TResult) => string,
): Promise<TResult> {
  try {
    const result = await run();
    recorder.workflowFinished(context, {
      outcome: "merged",
      revision: mergedRevision(result),
    });
    return result;
  } catch (error) {
    recorder.workflowFinished(context, {
      outcome: "failed",
      ...(typeof error === "object" && error !== null && "stage" in error &&
          typeof error.stage === "string"
        ? { failureStage: error.stage }
        : {}),
    });
    throw error;
  }
}

export function createSandcastleEvidenceRecorder(
  write: (event: SandcastleEvidenceEvent) => void,
): SandcastleEvidenceRecorder {
  return {
    sessionStarted: (context, fields) => write({
      kind: "session-started",
      ...context,
      ...fields,
    }),
    gateFinished: (context, fields) => write({
      kind: "gate-finished",
      ...context,
      ...fields,
    }),
    mergeRequested: (context, fields) => write({
      kind: "merge-requested",
      ...context,
      ...fields,
    }),
    workflowFinished: (context, fields) => write({
      kind: "workflow-finished",
      ...context,
      ...fields,
    }),
  };
}
