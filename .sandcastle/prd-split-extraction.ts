import { Output, claudeCode, run, type SandboxHooks, type SandboxProvider } from "@ai-hero/sandcastle";
import { z } from "zod";

import { agentLogging } from "./agent-logging.ts";

export interface PrdSlice {
  readonly title: string;
  readonly whatToBuild: string;
  readonly acceptanceCriteria: readonly string[];
}

const sliceSchema = z.strictObject({
  title: z.string().min(1).max(200),
  whatToBuild: z.string().min(1),
  acceptanceCriteria: z.array(z.string().min(1)).min(1),
});

export const prdSplitSchema = z.strictObject({ slices: z.array(sliceSchema).min(1) });

const producePrompt = (prdNumber: number, title: string) => `
Break PRD #${prdNumber} — ${title} into an ordered, flat list of self-contained implementation Issues.

Read the PRD with \`gh issue view ${prdNumber} --comments\`, then read CONTEXT.md, relevant ADRs, and inspect the codebase. Each slice must be a realistic, independently implementable tracer-bullet vertical slice. Do not create Issues, modify files, commit, push, or publish anything. Keep the complete breakdown in this session for a formatting request.
`;

const extractionPrompt = `
Now emit the breakdown you just produced as one JSON object inside <output> tags. It must have a non-empty slices array. Each slice requires title (1–200 characters), whatToBuild (non-empty), and a non-empty acceptanceCriteria array of non-empty strings. Include no other fields.
`;

export function createSameSessionPrdSplitExtractor(options: {
  readonly sandbox: SandboxProvider;
  readonly hooks: SandboxHooks;
  readonly runAgent?: typeof run;
  readonly createAgent?: typeof claudeCode;
}) {
  const runAgent = options.runAgent ?? run;
  const createAgent = options.createAgent ?? claudeCode;
  return {
    async split(request: {
      readonly prdNumber: number;
      readonly title: string;
      readonly checkoutPath: string;
      readonly model: string;
    }): Promise<readonly PrdSlice[]> {
      const logging = agentLogging();
      const produced = await runAgent({
        agent: createAgent(request.model),
        sandbox: options.sandbox,
        hooks: options.hooks,
        cwd: request.checkoutPath,
        branchStrategy: { type: "head" },
        maxIterations: 1,
        ...(logging === undefined ? {} : { logging }),
        prompt: producePrompt(request.prdNumber, request.title),
      });
      if (produced.commits.length > 0) throw new Error("PRD splitter session must not create commits");
      if (produced.resume === undefined) throw new Error("PRD splitter session identity is unavailable");
      const extracted = await produced.resume(extractionPrompt, {
        ...(logging === undefined ? {} : { logging }),
        output: Output.object({ tag: "output", schema: prdSplitSchema, maxRetries: 2 }),
      }) as unknown as { readonly commits: readonly unknown[]; readonly output: { readonly slices: readonly PrdSlice[] } };
      if (extracted.commits.length > 0) throw new Error("PRD splitter session must not create commits");
      return extracted.output.slices;
    },
  };
}
