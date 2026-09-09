import {
  claudeCode,
  run,
  type SandboxHooks,
  type SandboxProvider,
} from "@ai-hero/sandcastle";
import { z } from "zod";

import { agentLogging } from "./agent-logging.ts";
import type { CheckoutObserver } from "./checkout-safety.ts";
import { inheritedJobLogView, type JobLog } from "./job-logs.ts";
import { createStructuredExtractionDriver } from "./structured-extraction-driver.ts";

export interface SpecSlice {
  readonly title: string;
  readonly whatToBuild: string;
  readonly acceptanceCriteria: readonly string[];
}

const sliceSchema = z.strictObject({
  title: z.string().min(1).max(200),
  whatToBuild: z.string().min(1),
  acceptanceCriteria: z.array(z.string().min(1)).min(1),
});

export const specSplitSchema = z.strictObject({ slices: z.array(sliceSchema).min(1) });

// The Spec splitter's strict read-only and no-GitHub-write contract. The
// complete split prompt carries it and every format-correction prompt repeats
// it verbatim.
export const SPEC_SPLITTER_READ_ONLY_CONTRACT =
  "Read-only contract: you must not modify, create, or delete any file in this checkout; " +
  "you must not stage, commit, or otherwise change Git state (HEAD, the index, tracked files, " +
  "or untracked files); you must not create Issues, commit, push, or publish anything; " +
  "run only read-only inspection commands.";

// One complete prompt both produces the breakdown and emits the structured
// result: the repository-owned driver owns every structured attempt, so there
// is no separate produce pass to resume for formatting.
const specSplitPrompt = (specNumber: number, title: string) => `
Break Spec #${specNumber} — ${title} into an ordered, flat list of self-contained implementation Issues.

Read the Spec with \`gh issue view ${specNumber} --comments\`, then read CONTEXT.md, relevant ADRs, and inspect the codebase. Each slice must be a realistic, independently implementable tracer-bullet vertical slice.

${SPEC_SPLITTER_READ_ONLY_CONTRACT}

Return one JSON object inside <output> tags. It must have a non-empty slices array. Each slice requires title (1–200 characters), whatToBuild (non-empty), and a non-empty acceptanceCriteria array of non-empty strings. Include no other fields.
`;

// The Spec splitter seam runs through the repository-owned structured
// extraction driver (Spec #449): at most three completed structured attempts,
// each inside one bounded invocation recovery window, with the Target
// Checkout observed clean before attempt one and proven unchanged after every
// invocation. The library's recursive output retry is never armed — run calls
// carry no `output` definition — because the driver owns every structured
// attempt.
export function createSameSessionSpecSplitExtractor(options: {
  readonly sandbox: SandboxProvider;
  readonly hooks: SandboxHooks;
  readonly checkoutPath: string;
  readonly observer?: CheckoutObserver;
  readonly log?: JobLog;
  readonly runAgent?: typeof run;
  readonly createAgent?: typeof claudeCode;
  readonly now?: () => number;
  readonly wait?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
}) {
  const log = options.log ?? inheritedJobLogView();
  const driver = createStructuredExtractionDriver({
    sandbox: options.sandbox,
    hooks: options.hooks,
    checkoutPath: options.checkoutPath,
    role: "spec-splitter",
    stage: "structured-extraction",
    ...(options.observer === undefined ? {} : { observer: options.observer }),
    ...(log === undefined ? {} : { log }),
    ...(options.runAgent === undefined ? {} : { runAgent: options.runAgent }),
    ...(options.createAgent === undefined ? {} : { createAgent: options.createAgent }),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.wait === undefined ? {} : { wait: options.wait }),
  });
  return {
    async split(request: {
      readonly specNumber: number;
      readonly title: string;
      readonly model: string;
    }): Promise<readonly SpecSlice[]> {
      const logging = agentLogging();
      const extracted = await driver.extract({
        model: request.model,
        name: `spec-split-${request.specNumber}`,
        initialPrompt: specSplitPrompt(request.specNumber, request.title),
        readOnlyContract: SPEC_SPLITTER_READ_ONLY_CONTRACT,
        ...(logging === undefined ? {} : { logging }),
        output: { tag: "output", schema: specSplitSchema },
      });
      return extracted.slices;
    },
  };
}
