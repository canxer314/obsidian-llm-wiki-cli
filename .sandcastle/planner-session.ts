import {
  Output,
  claudeCode,
  run,
  type SandboxHooks,
  type SandboxProvider,
} from "@ai-hero/sandcastle";

import { agentActivityLoggingFields } from "./agent-session-observability.ts";
import { recordSandcastleSession } from "./evidence.ts";
import type {
  SandcastleEvidenceRecorder,
  SandcastleExecutionContext,
} from "./evidence.js";
import type { PlannerAgentSession } from "./planner.js";

const plannerPrompt = (issueNumber: number) => `
Plan only GitHub Issue #${issueNumber} in this repository.

Use GitHub CLI to read the latest Issue directly with gh issue view ${issueNumber} --comments. Read its title, body, labels, and all comments before planning. Do not select, inspect, or plan another Issue. Determine whether dependencies or missing decisions block implementation. Determine whether the Issue explicitly permits changes to Sandcastle or GitHub automation configuration.

Return one JSON object inside <plan> tags. It must exactly match this strict schema; include no fields other than those listed:
- top level: status ("ready" or "blocked"), implementationSummary (a non-empty string, never an array or object), blockingReason, allowsAutomationChanges (boolean), and issue.
- when status is "ready", blockingReason must be null; when status is "blocked", blockingReason must be a non-empty string.
- issue: only number (positive integer), title (non-empty string), body (string), labels (array of strings), and comments (array).
- each comment: only author (non-empty string) and body (string).

Do not add scope, metadata, explanation, helper, or any other fields at the top level or inside issue or comments.
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
      const runSession = async () => {
        const result = await runAgent({
        agent: createAgent(request.model),
        sandbox: options.sandbox,
        hooks: options.hooks,
        branchStrategy: { type: "head" },
        maxIterations: 1,
        name: sessionName,
        ...agentActivityLoggingFields(sessionName, options.execution?.liveStatus),
        prompt: plannerPrompt(request.issueNumber),
        output: Output.object({
          tag: request.output.tag,
          schema: request.output.schema,
        }),
        });
        return result.output;
      };
      if (options.evidence === undefined || options.execution === undefined) return runSession();
      return recordSandcastleSession(
        options.evidence,
        options.execution,
        { role: "planner", stage: "planner", attempt: 1, sessionName },
        runSession,
        { outcome: (output) => output.status === "blocked" ? "blocked" : "completed" },
      );
    },
  };
}
