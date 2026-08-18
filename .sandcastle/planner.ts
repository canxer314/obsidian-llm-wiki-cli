import { z } from "zod";

const issueContextSchema = z.object({
  number: z.number().int().positive(),
  title: z.string().min(1),
  body: z.string(),
  labels: z.array(z.string()),
  comments: z.array(z.object({
    author: z.string().min(1),
    body: z.string(),
  }).strict()),
}).strict();

const planFields = {
  implementationSummary: z.string().min(1),
  allowsAutomationChanges: z.boolean(),
  issue: issueContextSchema,
};

export const plannerOutputSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("ready"),
    ...planFields,
    blockingReason: z.null(),
  }).strict(),
  z.object({
    status: z.literal("blocked"),
    ...planFields,
    blockingReason: z.string().min(1),
  }).strict(),
]);

export type PlannerOutput = z.infer<typeof plannerOutputSchema>;

export interface PlannerAgentSessionRequest {
  readonly issueNumber: number;
  readonly model: string;
  readonly output: {
    readonly tag: "plan";
    readonly schema: typeof plannerOutputSchema;
  };
}

export interface PlannerAgentSession {
  run(request: PlannerAgentSessionRequest): Promise<unknown>;
}

export class PlannerOutputError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PlannerOutputError";
  }
}

export async function planIssue(options: {
  readonly issueNumber: number;
  readonly model: string;
  readonly session: PlannerAgentSession;
}): Promise<PlannerOutput> {
  const rawOutput = await options.session.run({
    issueNumber: options.issueNumber,
    model: options.model,
    output: { tag: "plan", schema: plannerOutputSchema },
  });
  const parsed = plannerOutputSchema.safeParse(rawOutput);
  if (!parsed.success) {
    throw new PlannerOutputError("Planner did not return a valid structured plan", {
      cause: parsed.error,
    });
  }
  if (parsed.data.issue.number !== options.issueNumber) {
    throw new PlannerOutputError(
      `Planner returned Issue #${parsed.data.issue.number} for requested Issue #${options.issueNumber}`,
    );
  }
  return parsed.data;
}
