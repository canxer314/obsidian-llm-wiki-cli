import { join } from "node:path";

import {
  Output,
  claudeCode,
  run,
  type SandboxHooks,
  type SandboxProvider,
} from "@ai-hero/sandcastle";
import { z } from "zod";

import type { PublishedReview, ReviewThreadComment } from "./review-automation.ts";

export type ExtractedReview = PublishedReview;

const inlineCommentSchema = z.strictObject({
  path: z.string().min(1).refine((path) => !path.startsWith("/") && !path.split("/").includes(".."), {
    message: "inline comment path must be repository-relative",
  }),
  line: z.number().int().positive(),
  body: z.string().min(1),
});

const replySchema = z.strictObject({
  commentId: z.string().min(1),
  body: z.string().min(1),
});

const reviewSchema = z.strictObject({
  summary: z.string().min(1),
  inlineComments: z.array(inlineCommentSchema).default([]),
  replies: z.array(replySchema).default([]),
});

function producePrompt(request: {
  readonly pullRequestNumber: number;
  readonly branch: string;
  readonly revision: string;
  readonly reviewThreads: readonly ReviewThreadComment[];
}): string {
  return `Review Pull Request #${request.pullRequestNumber} on branch ${request.branch}, which starts at exact revision ${request.revision}.

Inspect the Git diff, implementation, tests, repository standards, and originating Issue. Actively improve correct, in-scope problems you find: make the smallest correct changes, run appropriate checks, and commit every intended improvement on the existing branch. Do not create an Issue, branch, or Pull Request. Do not run gh auth setup-git, git push, rebase, or force-push; a controlled publisher will push your local commits after you exit.

Unresolved review threads are below. Address code-review requests when appropriate and prepare a reply for each addressed or substantively declined request. Only reply to one of these exact comment IDs.

${JSON.stringify(request.reviewThreads, null, 2)}

Keep your review in this session for a subsequent formatting request.`;
}

const extractionPrompt = `
Now emit the review you just completed as one JSON object inside <review> tags. Do not make further code changes. Include a concise summary, inlineComments, and replies. Each inline comment requires a repository-relative path, exact current line number, and body. Each reply requires an exact commentId from the provided unresolved review threads and body. Use empty arrays when none apply.
`;

const REVIEW_TIMEOUT_MILLISECONDS = 30 * 60 * 1000;

export function createSameSessionReviewExtractor(options: {
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
      readonly pullRequestNumber: number;
      readonly branch: string;
      readonly revision: string;
      readonly checkoutPath: string;
      readonly reviewThreads: readonly ReviewThreadComment[];
      readonly model: string;
      readonly artifactDirectory?: string;
    }): Promise<ExtractedReview> {
      const controller = new AbortController();
      const timeout = setTimeout(
        () => controller.abort(new Error("Reviewer execution timed out")),
        options.timeoutMilliseconds ?? REVIEW_TIMEOUT_MILLISECONDS,
      );
      try {
        const logging = request.artifactDirectory === undefined ? undefined : {
          type: "file" as const,
          path: join(request.artifactDirectory, "review.log"),
          verbose: true,
        };
        const produced = await runAgent({
          agent: createAgent(request.model),
          sandbox: options.sandbox,
          hooks: options.hooks,
          cwd: request.checkoutPath,
          ...(logging === undefined ? {} : { logging }),
          signal: controller.signal,
          branchStrategy: { type: "branch", branch: request.branch },
          maxIterations: 1,
          prompt: producePrompt(request),
        });
        if (produced.resume === undefined) {
          throw new Error("Reviewer session identity is unavailable");
        }
        const extracted = await produced.resume(extractionPrompt, {
          ...(logging === undefined ? {} : { logging }),
          signal: controller.signal,
          output: Output.object({ tag: "review", schema: reviewSchema, maxRetries: 2 }),
        }) as unknown as { readonly output: ExtractedReview };
        return extracted.output;
      } finally {
        clearTimeout(timeout);
      }
    },
  };
}
