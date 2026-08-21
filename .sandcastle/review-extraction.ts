import {
  Output,
  claudeCode,
  run,
  type SandboxHooks,
  type SandboxProvider,
} from "@ai-hero/sandcastle";
import { z } from "zod";

export interface ExtractedReview {
  readonly verdict: "Approved" | "Changes requested";
  readonly summary: string;
  readonly findings: readonly {
    readonly summary: string;
    readonly details: string;
  }[];
}

const reviewSchema = z.strictObject({
  verdict: z.enum(["Approved", "Changes requested"]),
  summary: z.string().min(1),
  findings: z.array(z.strictObject({
    summary: z.string().min(1),
    details: z.string().min(1),
  })),
}).refine(
  (review) => review.verdict === "Approved" || review.findings.length > 0,
  { message: "Changes requested requires at least one finding", path: ["findings"] },
);

const producePrompt = (pullRequestNumber: number, revision: string) => `
Review Pull Request #${pullRequestNumber} at exact revision ${revision}.

Inspect the Git diff, implementation, tests, repository standards, and originating Issue. Do not modify files, commit, push, or publish GitHub feedback. Develop a complete review with concrete correctness, security, or specification findings where applicable. Keep your review in this session for a subsequent formatting request.
`;

const extractionPrompt = `
Now emit the review you just produced as one JSON object inside <review> tags. The verdict must be exactly Approved or Changes requested. Include a concise summary and a findings array. Each finding must have a concrete summary and details; use an empty findings array when approved.
`;

export function createSameSessionReviewExtractor(options: {
  readonly sandbox: SandboxProvider;
  readonly hooks: SandboxHooks;
  readonly runAgent?: typeof run;
  readonly createAgent?: typeof claudeCode;
  readonly agentEnvironment?: Readonly<Record<string, string>>;
}) {
  const runAgent = options.runAgent ?? run;
  const createAgent = options.createAgent ?? claudeCode;
  return {
    async review(request: {
      readonly pullRequestNumber: number;
      readonly revision: string;
      readonly checkoutPath: string;
      readonly model: string;
    }): Promise<ExtractedReview> {
      const produced = await runAgent({
        agent: createAgent(
          request.model,
          options.agentEnvironment === undefined ? undefined : { env: { ...options.agentEnvironment } },
        ),
        sandbox: options.sandbox,
        hooks: options.hooks,
        cwd: request.checkoutPath,
        branchStrategy: { type: "head" },
        maxIterations: 1,
        prompt: producePrompt(request.pullRequestNumber, request.revision),
      });
      if (produced.commits.length > 0) {
        throw new Error("Reviewer session must not create commits");
      }
      if (produced.resume === undefined) {
        throw new Error("Reviewer session identity is unavailable");
      }
      const extracted = await produced.resume(extractionPrompt, {
        output: Output.object({ tag: "review", schema: reviewSchema, maxRetries: 2 }),
      }) as unknown as { readonly commits: readonly unknown[]; readonly output: ExtractedReview };
      if (extracted.commits.length > 0) {
        throw new Error("Reviewer session must not create commits");
      }
      return extracted.output;
    },
  };
}
