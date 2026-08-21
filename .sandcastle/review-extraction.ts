import { join } from "node:path";

import {
  Output,
  claudeCode,
  run,
  type SandboxHooks,
  type SandboxProvider,
} from "@ai-hero/sandcastle";
import { z } from "zod";

import type { ReviewFinding } from "./review-automation.ts";

export interface ExtractedReview {
  readonly verdict: "Approved" | "Changes requested";
  readonly summary: string;
  readonly findings: readonly ReviewFinding[];
}

const reviewFindingSchema = z.strictObject({
  summary: z.string().min(1),
  details: z.string().min(1),
  location: z.strictObject({
    path: z.string().min(1).refine((path) => !path.startsWith("/") && !path.includes(".."), {
      message: "location path must be repository-relative",
    }),
    line: z.number().int().positive(),
    side: z.enum(["LEFT", "RIGHT"]),
  }).optional(),
});

const reviewSchema = z.strictObject({
  verdict: z.enum(["Approved", "Changes requested"]),
  summary: z.string().min(1),
  findings: z.array(reviewFindingSchema),
}).refine(
  (review) => review.verdict === "Approved" || review.findings.length > 0,
  { message: "Changes requested requires at least one finding", path: ["findings"] },
);

const producePrompt = (pullRequestNumber: number, revision: string) => `
Review Pull Request #${pullRequestNumber} at exact revision ${revision}.

Inspect the Git diff, implementation, tests, repository standards, and originating Issue. Do not modify files, commit, push, or publish GitHub feedback. Develop a complete review with concrete correctness, security, or specification findings where applicable. Keep your review in this session for a subsequent formatting request.
`;

const extractionPrompt = `
Now emit the review you just produced as one JSON object inside <review> tags. The verdict must be exactly Approved or Changes requested. Include a concise summary and a findings array. Each finding must have a concrete summary and details; use an empty findings array when approved. When a finding applies to a changed line, include its repository-relative path, exact diff line number, and LEFT or RIGHT side in location; omit location when no valid diff location exists.
`;

const REVIEW_TIMEOUT_MILLISECONDS = 30 * 60 * 1000;

export function createSameSessionReviewExtractor(options: {
  readonly sandbox: SandboxProvider;
  readonly hooks: SandboxHooks;
  readonly runAgent?: typeof run;
  readonly createAgent?: typeof claudeCode;
  readonly agentEnvironment?: Readonly<Record<string, string>>;
  readonly timeoutMilliseconds?: number;
}) {
  const runAgent = options.runAgent ?? run;
  const createAgent = options.createAgent ?? claudeCode;
  return {
    async review(request: {
      readonly pullRequestNumber: number;
      readonly revision: string;
      readonly checkoutPath: string;
      readonly model: string;
      readonly artifactDirectory?: string;
    }): Promise<ExtractedReview> {
      const controller = new AbortController();
      const timeout = setTimeout(
        () => controller.abort(new Error("Reviewer execution timed out")),
        options.timeoutMilliseconds ?? REVIEW_TIMEOUT_MILLISECONDS,
      );
      try {
        const produced = await runAgent({
        agent: createAgent(
          request.model,
          options.agentEnvironment === undefined ? undefined : { env: { ...options.agentEnvironment } },
        ),
        sandbox: options.sandbox,
        hooks: options.hooks,
        cwd: request.checkoutPath,
        ...(request.artifactDirectory === undefined ? {} : {
          logging: { type: "file" as const, path: join(request.artifactDirectory, "review.log"), verbose: true },
        }),
        signal: controller.signal,
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
        ...(request.artifactDirectory === undefined ? {} : {
          logging: { type: "file" as const, path: join(request.artifactDirectory, "review.log"), verbose: true },
        }),
        signal: controller.signal,
        output: Output.object({ tag: "review", schema: reviewSchema, maxRetries: 2 }),
      }) as unknown as { readonly commits: readonly unknown[]; readonly output: ExtractedReview };
      if (extracted.commits.length > 0) {
        throw new Error("Reviewer session must not create commits");
      }
      return extracted.output;
      } finally {
        clearTimeout(timeout);
      }
    },
  };
}
