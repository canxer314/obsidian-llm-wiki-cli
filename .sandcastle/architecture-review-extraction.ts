import { join } from "node:path";

import {
  Output,
  claudeCode,
  run,
  type SandboxHooks,
  type SandboxProvider,
} from "@ai-hero/sandcastle";
import { z } from "zod";

import { agentLogging } from "./agent-logging.ts";
import type {
  ArchitectureReviewOutcome,
  ArchitectureReviewProposal,
} from "./architecture-review-automation.ts";

// Upstream-equivalent output contract (course-video-manager
// architecture-review.ts at the accepted baseline): a discriminated union of
// an accepted proposal and an explicit skip.
const legacyPrdTerminology = /\bPRDs?\b/iu;
const specProposalText = z.string().min(1).refine(
  (value) => !legacyPrdTerminology.test(value),
  "Spec proposals must not use legacy PRD terminology",
);

export const architectureReviewSchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("proposed"),
    title: specProposalText.pipe(z.string().max(256)),
    body: specProposalText,
    oneLineSummary: z.string().min(1),
    candidatesConsidered: z.array(z.string().min(1)).min(1),
  }),
  z.strictObject({
    status: z.literal("skipped"),
    reason: z.string().min(1),
  }),
]);

const producePrompt = (revision: string, priorProposals: readonly ArchitectureReviewProposal[]) => `
You are running the unattended architecture-review pass for this repository at exact revision ${revision}. Find ONE fresh deepening opportunity in this codebase and prepare it as a Spec proposal.

Read CONTEXT.md and any relevant ADRs under docs/adr/ first — treat ADRs as binding. Then explore the codebase for deepening opportunities: shallow modules whose interface is nearly as complex as their implementation, pass-throughs that fail the deletion test (deleting the module would make the complexity vanish), friction spread across callers that a deeper module would concentrate in one place (locality), and interfaces whose leverage does not justify their complexity. Do not delegate exploration to subagents or launch Agent tasks; use this session's tools directly. Inspect at most twelve focused files after reading CONTEXT.md and the relevant ADRs. Stop exploring as soon as you can rank three credible candidates, or skip when the available evidence does not support a fresh proposal.

Prior architecture-review proposals are listed below as JSON (number, title, state, body). All of them — open, merged, or closed — count as already proposed. A candidate is a duplicate when it touches substantially the same modules as a prior proposal or addresses the same underlying friction, even with a different angle; when in doubt, treat it as a duplicate. Do not re-propose anything matching a load-bearing reason recorded on a closed proposal.

<prior-proposals>
${JSON.stringify(priorProposals)}
</prior-proposals>

Internally generate three to five candidates, rank them on leverage, locality gain, test-surface improvement, and cost-to-value, and pick the single top candidate. Prepare its Spec with the standard sections (Problem Statement, Solution, User Stories, Implementation Decisions, Testing Decisions, Out of Scope, Further Notes), preceded by an Architecture review section naming the files involved, the problem and the solution in CONTEXT.md and deepening vocabulary, the benefits in terms of locality and leverage, a fenced mermaid before/after diagram of the shallow-to-deep transition, and a recommendation strength of Strong, Worth exploring, or Speculative.

Rules: this pass is read-only — do not modify files, commit, push, or create or edit any GitHub Issue or label; the command publishes an accepted proposal itself. Propose at most one Spec. Use Spec terminology throughout the proposal title and body; never call the proposal a PRD. If every reasonable candidate is already covered by a prior proposal, decide to skip instead. Keep your chosen title, full Spec body, one-line summary, and considered candidates — or your skip reason — in this session for a subsequent formatting request.
`;

const extractionPrompt = `
Now emit the outcome of the architecture-review pass as one JSON object inside <output> tags. It has exactly one of two shapes. When you prepared a proposal: {"status":"proposed","title":"...","body":"...","oneLineSummary":"...","candidatesConsidered":["..."]} with a title of at most 256 characters, the full Spec body, a one-line summary, and a non-empty candidatesConsidered array. The proposal title and body must use Spec terminology throughout and must not contain the legacy term PRD or PRDs. When you decided to skip: {"status":"skipped","reason":"..."} naming the candidates considered and the prior proposals that already cover them. Emit no fields beyond those listed.
`;

// Upstream architecture-review jobs time out after twenty minutes.
const ARCHITECTURE_REVIEW_TIMEOUT_MILLISECONDS = 20 * 60 * 1000;

export function createSameSessionArchitectureReviewExtractor(options: {
  readonly sandbox: SandboxProvider;
  readonly hooks: SandboxHooks;
  readonly runAgent?: typeof run;
  readonly createAgent?: typeof claudeCode;
  readonly timeoutMilliseconds?: number;
}) {
  const runAgent = options.runAgent ?? run;
  const createAgent = options.createAgent ?? claudeCode;
  return {
    async review(request: {
      readonly revision: string;
      readonly checkoutPath: string;
      readonly priorProposals: readonly ArchitectureReviewProposal[];
      readonly model: string;
      readonly artifactDirectory?: string;
    }): Promise<ArchitectureReviewOutcome> {
      const controller = new AbortController();
      const timeout = setTimeout(
        () => controller.abort(new Error("Architecture review execution timed out")),
        options.timeoutMilliseconds ?? ARCHITECTURE_REVIEW_TIMEOUT_MILLISECONDS,
      );
      try {
        const logging = agentLogging(
          request.artifactDirectory === undefined
            ? undefined
            : join(request.artifactDirectory, "architecture-review.log"),
        );
        const produced = await runAgent({
        agent: createAgent(request.model),
        sandbox: options.sandbox,
        hooks: options.hooks,
        cwd: request.checkoutPath,
        ...(logging === undefined ? {} : { logging }),
        signal: controller.signal,
        branchStrategy: { type: "head" },
        maxIterations: 1,
        prompt: producePrompt(request.revision, request.priorProposals),
      });
      if (produced.commits.length > 0) {
        throw new Error("Architecture review session must not create commits");
      }
      if (produced.resume === undefined) {
        throw new Error("Architecture review session identity is unavailable");
      }
      const extracted = await produced.resume(extractionPrompt, {
        ...(logging === undefined ? {} : { logging }),
        signal: controller.signal,
        output: Output.object({ tag: "output", schema: architectureReviewSchema, maxRetries: 2 }),
      }) as unknown as { readonly commits: readonly unknown[]; readonly output: ArchitectureReviewOutcome };
      if (extracted.commits.length > 0) {
        throw new Error("Architecture review session must not create commits");
      }
      return extracted.output;
      } finally {
        clearTimeout(timeout);
      }
    },
  };
}
