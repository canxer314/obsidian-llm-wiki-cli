import { randomUUID } from "node:crypto";

import {
  Output,
  claudeCode,
  run,
  type SandboxHooks,
  type SandboxProvider,
} from "@ai-hero/sandcastle";
import { z } from "zod";

import { agentActivityLoggingFields } from "./agent-session-observability.ts";
import { recordSandcastleSession } from "./evidence.ts";
import type {
  SandcastleEvidenceRecorder,
  SandcastleExecutionContext,
} from "./evidence.js";

export interface ReviewerFinding {
  readonly summary: string;
  readonly details: string;
}

export interface ReviewerOutput {
  readonly verdict: "Approved" | "Changes requested";
  readonly summary: string;
  readonly findings: readonly ReviewerFinding[];
}

export interface ReviewerAgentSessionRequest {
  readonly pullRequestNumber: number;
  readonly revision: string;
  readonly model: string;
}

export interface ReviewerAgentSession {
  run(request: ReviewerAgentSessionRequest): Promise<ReviewerOutput>;
}

const reviewerOutputSchema = z.strictObject({
  verdict: z.enum(["Approved", "Changes requested"]),
  summary: z.string().min(1),
  findings: z.array(z.strictObject({
    summary: z.string().min(1),
    details: z.string().min(1),
  })),
}).refine(
  (output) => output.verdict === "Approved" || output.findings.length > 0,
  { message: "Changes requested requires at least one finding", path: ["findings"] },
);

const reviewerPrompt = (pullRequestNumber: number, revision: string) => `
Review Pull Request #${pullRequestNumber} at exact revision ${revision}.

This is an independent, read-only review after local quality succeeded for this same revision. Inspect the Git diff, implementation, tests, repository standards, and the originating Issue. Report concrete correctness, security, or specification problems. Do not modify files, commit, push, or publish GitHub feedback.

Return one JSON object inside <review> tags. The verdict must be exactly Approved or Changes requested. Include a concise summary and a findings array. Each finding must have a concrete summary and details; use an empty findings array when approved.
`;

export function createSandcastleReviewerSession(options: {
  readonly sandbox: SandboxProvider;
  readonly hooks: SandboxHooks;
  readonly runAgent?: typeof run;
  readonly createAgent?: typeof claudeCode;
  readonly createSessionId?: () => string;
  readonly evidence?: SandcastleEvidenceRecorder;
  readonly execution?: SandcastleExecutionContext;
}): ReviewerAgentSession {
  const runAgent = options.runAgent ?? run;
  const createAgent = options.createAgent ?? claudeCode;
  const createSessionId = options.createSessionId ?? randomUUID;
  let attempt = 0;
  return {
    async run(request) {
      attempt += 1;
      const suffix = request.revision.slice(0, 12);
      const sessionId = createSessionId();
      const sessionName = `reviewer-pr-${request.pullRequestNumber}-${suffix}-attempt-${attempt}`;
      const fields = {
        role: "reviewer" as const,
        stage: "reviewer" as const,
        attempt,
        sessionName,
        pullRequestNumber: request.pullRequestNumber,
        revision: request.revision,
      };
      const runSession = async () => {
        const result = await runAgent({
        agent: createAgent(request.model),
        sandbox: options.sandbox,
        hooks: options.hooks,
        branchStrategy: {
          type: "branch",
          branch: `sandcastle/review-${request.pullRequestNumber}-${suffix}-${sessionId}`,
          baseBranch: request.revision,
        },
        maxIterations: 1,
        name: sessionName,
        ...agentActivityLoggingFields(sessionName, options.execution?.liveStatus),
        prompt: reviewerPrompt(request.pullRequestNumber, request.revision),
        output: Output.object({
          tag: "review",
          schema: reviewerOutputSchema,
        }),
        });
        if (result.commits.length > 0) {
          throw new Error("Reviewer session must not create commits");
        }
        return result.output;
      };
      if (options.evidence === undefined || options.execution === undefined) return runSession();
      return recordSandcastleSession(options.evidence, options.execution, fields, runSession);
    },
  };
}
