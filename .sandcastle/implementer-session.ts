import {
  claudeCode,
  run,
  type SandboxHooks,
  type SandboxProvider,
} from "@ai-hero/sandcastle";

import type {
  SandcastleEvidenceRecorder,
  SandcastleExecutionContext,
} from "./evidence.js";
import type { PlannerOutput } from "./planner.js";
import type { RepairFeedback } from "./repair-orchestrator.js";

export interface ImplementerRepairContext {
  readonly attempt: 1 | 2;
  readonly pullRequestNumber: number;
  readonly revision: string;
  readonly feedback: RepairFeedback;
}

export interface ImplementerAgentSessionRequest {
  readonly model: string;
  readonly branch: string;
  readonly plan: Extract<PlannerOutput, { status: "ready" }>;
  readonly repair?: ImplementerRepairContext;
}

export interface ImplementerAgentSessionResult {
  readonly branch: string;
  readonly commits: readonly { readonly sha: string }[];
}

export interface ImplementerAgentSession {
  run(request: ImplementerAgentSessionRequest): Promise<ImplementerAgentSessionResult>;
}

const initialImplementerPrompt = (
  branch: string,
  plan: Extract<PlannerOutput, { status: "ready" }>,
) => `
Implement GitHub Issue #${plan.issue.number} using this complete Planner handoff:

${JSON.stringify(plan)}

Work only on branch ${branch}. Implement the Issue, run the relevant tests, commit all intended changes, run gh auth setup-git, and run git push origin ${branch}. Do not rebase or force-push.

Create a Draft Pull Request with gh pr create --draft. Its base must be the repository default branch, its head must be ${branch}, and its body must contain exactly the closing relationship Closes #${plan.issue.number}.

${plan.allowsAutomationChanges
    ? "This Issue explicitly allows changes to Sandcastle or GitHub workflow automation."
    : "Do not modify .sandcastle/ or .github/workflows/. This Issue does not allow automation changes."}
`;

const repairImplementerPrompt = (
  branch: string,
  plan: Extract<PlannerOutput, { status: "ready" }>,
  repair: ImplementerRepairContext,
) => `
This is Implementer repair attempt ${repair.attempt} of 2 for GitHub Issue #${plan.issue.number}, Pull Request #${repair.pullRequestNumber}, at revision ${repair.revision}.

Use this complete original Planner handoff:

${JSON.stringify(plan)}

Fix only the concrete failure described by this redacted feedback:

${JSON.stringify(repair.feedback)}

Work only on branch ${branch}. Confirm HEAD includes revision ${repair.revision}, make the smallest correct repair, run the relevant tests, commit all intended changes, run gh auth setup-git, and run git push origin ${branch}. The push must produce a new commit SHA. Do not rebase or force-push. Do not create another Pull Request; update the existing Pull Request #${repair.pullRequestNumber} only by pushing the branch.

${plan.allowsAutomationChanges
    ? "This Issue explicitly allows changes to Sandcastle or GitHub workflow automation."
    : "Do not modify .sandcastle/ or .github/workflows/. This Issue does not allow automation changes."}
`;

export function createSandcastleImplementerSession(options: {
  readonly sandbox: SandboxProvider;
  readonly hooks: SandboxHooks;
  readonly runAgent?: typeof run;
  readonly createAgent?: typeof claudeCode;
  readonly evidence?: SandcastleEvidenceRecorder;
  readonly execution?: SandcastleExecutionContext;
}): ImplementerAgentSession {
  const runAgent = options.runAgent ?? run;
  const createAgent = options.createAgent ?? claudeCode;
  return {
    async run(request) {
      const sessionName = request.repair === undefined
        ? `implementer-issue-${request.plan.issue.number}`
        : `implementer-repair-issue-${request.plan.issue.number}-attempt-${request.repair.attempt}`;
      if (options.evidence !== undefined && options.execution !== undefined) {
        options.evidence.record({
          kind: "session-started",
          ...options.execution,
          role: "implementer",
          attempt: request.repair?.attempt ?? 0,
          sessionName,
          ...(request.repair === undefined ? {} : {
            pullRequestNumber: request.repair.pullRequestNumber,
            revision: request.repair.revision,
          }),
        });
      }
      const result = await runAgent({
        agent: createAgent(request.model),
        sandbox: options.sandbox,
        hooks: options.hooks,
        branchStrategy: {
          type: "branch",
          branch: request.branch,
          baseBranch: `origin/${request.branch}`,
        },
        maxIterations: 1,
        name: sessionName,
        prompt: request.repair === undefined
          ? initialImplementerPrompt(request.branch, request.plan)
          : repairImplementerPrompt(request.branch, request.plan, request.repair),
      });
      return { branch: result.branch, commits: result.commits };
    },
  };
}
