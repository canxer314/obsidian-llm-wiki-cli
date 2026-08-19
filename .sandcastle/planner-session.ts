import {
  Output,
  claudeCode,
  run,
  type SandboxHooks,
  type SandboxProvider,
} from "@ai-hero/sandcastle";

import type {
  SandcastleEvidenceRecorder,
  SandcastleExecutionContext,
} from "./evidence.js";
import type { PlannerAgentSession } from "./planner.js";

const plannerPrompt = (issueNumber: number) => `
Plan only GitHub Issue #${issueNumber} in this repository.

Use GitHub CLI to read the latest Issue directly with gh issue view ${issueNumber} --comments. Read its title, body, labels, and all comments before planning. Do not select, inspect, or plan another Issue. Determine whether dependencies or missing decisions block implementation. Determine whether the Issue explicitly permits changes to Sandcastle or GitHub automation configuration.

Return one JSON object inside <plan> tags. Include status (ready or blocked), implementationSummary, blockingReason (null when ready), allowsAutomationChanges, and the complete Issue context you read: number, title, body, label names, and every comment's author and body.
`;

export function createSandcastlePlannerSession(options: {
  readonly sandbox: SandboxProvider;
  readonly hooks: SandboxHooks;
  readonly runAgent?: typeof run;
  readonly createAgent?: typeof claudeCode;
  readonly evidence?: SandcastleEvidenceRecorder;
  readonly execution?: SandcastleExecutionContext;
}): PlannerAgentSession {
  const runAgent = options.runAgent ?? run;
  const createAgent = options.createAgent ?? claudeCode;
  return {
    async run(request) {
      const sessionName = `planner-issue-${request.issueNumber}`;
      if (options.evidence !== undefined && options.execution !== undefined) {
        options.evidence.record({
          kind: "session-started",
          ...options.execution,
          role: "planner",
          attempt: 1,
          sessionName,
        });
      }
      const result = await runAgent({
        agent: createAgent(request.model),
        sandbox: options.sandbox,
        hooks: options.hooks,
        branchStrategy: { type: "head" },
        maxIterations: 1,
        name: sessionName,
        prompt: plannerPrompt(request.issueNumber),
        output: Output.object({
          tag: request.output.tag,
          schema: request.output.schema,
        }),
      });
      return result.output;
    },
  };
}
