import {
  claudeCode,
  run,
  type SandboxHooks,
  type SandboxProvider,
} from "@ai-hero/sandcastle";

import { agentLogging } from "./agent-logging.ts";
import type { PlannerOutput } from "./planner.js";

export interface ImplementerAgentSessionRequest {
  readonly model: string;
  readonly branch: string;
  readonly plan: Extract<PlannerOutput, { status: "ready" }>;
  readonly checkoutPath?: string;
  readonly parentSpec?: { readonly number: number };
  // Present from the second bounded invocation attempt onward (Issue #458):
  // the frozen authorized base revision the deterministic branch started
  // from. Its presence selects the recovery prompt, which inspects durable
  // branch state before acting.
  readonly recovery?: { readonly baseline: string };
}

export interface ImplementerAgentSessionResult {
  readonly branch: string;
  readonly commits: readonly { readonly sha: string }[];
}

export interface ImplementerAgentSession {
  run(request: ImplementerAgentSessionRequest): Promise<ImplementerAgentSessionResult>;
}

const draftPullRequestInstructions = (branch: string, relationship: string) => `Before publishing, inspect whether this branch already has a Draft Pull Request. Reuse and update one existing upstream-equivalent Draft Pull Request; otherwise create exactly one Draft Pull Request with gh pr create --draft. Its base must be the repository default branch, its head must be ${branch}, and its body must contain the relationship ${relationship}.`;

// The shared Implementation body used on the first bounded invocation attempt.
// For one child of a Spec it opens by resuming the existing shared
// accumulating branch so earlier completed children are preserved.
const implementationInstructions = (
  branch: string,
  plan: Extract<PlannerOutput, { status: "ready" }>,
  parentSpec?: { readonly number: number },
) => `
Implement GitHub Issue #${plan.issue.number} using this complete Planner handoff:

${JSON.stringify(plan)}

Work only on branch ${branch}. Implement the Issue, choose and run the appropriate repository checks, commit all intended changes, run gh auth setup-git, and run git push origin ${branch}. Do not rebase or force-push.

${parentSpec === undefined
    ? draftPullRequestInstructions(branch, `Closes #${plan.issue.number}`)
    : `This Issue is one child of Spec #${parentSpec.number}, delivered on the shared accumulating branch ${branch}. If ${branch} already exists on origin, resume it with git fetch origin ${branch} && git checkout -B ${branch} origin/${branch} so earlier completed children are preserved. ${draftPullRequestInstructions(branch, `Part of #${parentSpec.number}`)}`}

${plan.allowsAutomationChanges
    ? "This Issue explicitly allows changes to Sandcastle or GitHub workflow automation."
    : "Do not modify .sandcastle/ or .github/workflows/. This Issue does not allow automation changes."}
`;

// The Implementation body appended to recovery prompts. Recovery prompts carry
// their own state-inspection preamble, so this body deliberately does not
// repeat the fresh-attempt "resume with git checkout -B origin/<branch>"
// instruction: resetting the local branch to origin could discard a valid
// current-child commit left by the interrupted attempt.
const recoveryImplementationInstructions = (
  branch: string,
  plan: Extract<PlannerOutput, { status: "ready" }>,
  parentSpec?: { readonly number: number },
) => `
Implement GitHub Issue #${plan.issue.number} using this complete Planner handoff:

${JSON.stringify(plan)}

Work only on branch ${branch}. Implement the Issue, choose and run the appropriate repository checks, commit all intended changes, run gh auth setup-git, and run git push origin ${branch}. Do not rebase or force-push.

${parentSpec === undefined
    ? draftPullRequestInstructions(branch, `Closes #${plan.issue.number}`)
    : draftPullRequestInstructions(branch, `Part of #${parentSpec.number}`)}

${plan.allowsAutomationChanges
    ? "This Issue explicitly allows changes to Sandcastle or GitHub workflow automation."
    : "Do not modify .sandcastle/ or .github/workflows/. This Issue does not allow automation changes."}
`;

// The complete implementer prompt for the first bounded invocation attempt.
export const initialImplementerPrompt = implementationInstructions;

// The recovery implementer prompt used from the second bounded invocation
// attempt onward (Issue #458 for ordinary Issues, #459 for Spec children). The
// interrupted attempt may have left durable partial work — local commits, a
// pushed remote branch, or a Draft Pull Request — so the Agent first inspects
// that durable state and then continues it. It never resets the local branch
// to the remote, rebases, force-pushes, merges unknown concurrent work, or
// opens a duplicate Pull Request.
export const recoveryImplementerPrompt = (
  branch: string,
  plan: Extract<PlannerOutput, { status: "ready" }>,
  baseline: string,
  parentSpec?: { readonly number: number },
) => parentSpec === undefined
  ? `
A previous attempt to implement GitHub Issue #${plan.issue.number} on branch ${branch} was interrupted before it finished. The branch started at the frozen authorized base revision ${baseline}, which remains the authorized base for this recovery.

Before doing anything else, inspect the durable state the interrupted attempt left behind: the local branch ${branch} (git status and git log ${branch}), the remote branch (git fetch origin ${branch}, then git log origin/${branch} when it exists), and any existing Draft Pull Request for ${branch} (gh pr list --head ${branch} --state all). Then continue that work instead of starting over: keep every valid commit already on the branch, complete or commit any partial work you find, and do not duplicate commits, pushes, or Pull Requests that already exist.

Never reset the local branch to the remote branch, never rebase, never force-push, never merge unknown concurrent work, and never create a second Pull Request — when a Draft Pull Request for ${branch} already exists, reuse and update that one.

${recoveryImplementationInstructions(branch, plan, parentSpec)}
`
  : `
A previous attempt to implement GitHub Issue #${plan.issue.number}, child #${plan.issue.number} of Spec #${parentSpec.number}, on the shared accumulating branch ${branch} was interrupted before it finished. The branch started at the frozen shared-branch baseline ${baseline} — the head of the earlier completed children of Spec #${parentSpec.number} already accumulated on the shared branch — and that baseline remains fixed for this recovery.

Before doing anything else, inspect and preserve the durable state the interrupted attempt left behind: the earlier child implementations already accumulated on ${branch} (git log ${branch}, and git log origin/${branch} after fetching), the current local commits on ${branch} (git status and git log ${branch}), the remote shared branch (git fetch origin ${branch}, then git log origin/${branch} when it exists), and the single existing Draft Pull Request for ${branch} (gh pr list --head ${branch} --state all; its body says Part of #${parentSpec.number}). Then continue that work instead of starting over: keep every earlier child implementation and every valid current-child commit already on the branch, complete or commit any partial current-child work you find, and reuse the existing matching resources rather than duplicating commits, pushes, or the Pull Request.

Never reset the local branch to the remote branch, never rebase, never force-push, never merge unknown concurrent work, and never create a second Pull Request — when the Draft Pull Request for ${branch} already exists, reuse and update that one.

${recoveryImplementationInstructions(branch, plan, parentSpec)}
`;

export function createSandcastleImplementerSession(options: {
  readonly sandbox: SandboxProvider;
  readonly hooks: SandboxHooks;
  readonly runAgent?: typeof run;
  readonly createAgent?: typeof claudeCode;
}): ImplementerAgentSession {
  const runAgent = options.runAgent ?? run;
  const createAgent = options.createAgent ?? claudeCode;
  return {
    async run(request) {
      const logging = agentLogging();
      const result = await runAgent({
        agent: createAgent(request.model),
        sandbox: options.sandbox,
        ...(request.checkoutPath === undefined ? {} : { cwd: request.checkoutPath }),
        hooks: options.hooks,
        branchStrategy: {
          type: "branch",
          branch: request.branch,
        },
        maxIterations: 1,
        name: `implementer-issue-${request.plan.issue.number}`,
        ...(logging === undefined ? {} : { logging }),
        prompt: request.recovery === undefined
          ? initialImplementerPrompt(request.branch, request.plan, request.parentSpec)
          : recoveryImplementerPrompt(
            request.branch,
            request.plan,
            request.recovery.baseline,
            request.parentSpec,
          ),
      });
      return { branch: result.branch, commits: result.commits };
    },
  };
}
