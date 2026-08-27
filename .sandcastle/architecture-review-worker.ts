import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { createSameSessionArchitectureReviewExtractor } from "./architecture-review-extraction.ts";
import type { ArchitectureReviewProposal } from "./architecture-review-automation.ts";
import { readTargetWorkerStartup } from "./target-operation-startup.ts";

const [revision, checkoutPath, model, artifactDirectory] = process.argv.slice(2);
if (
  revision === undefined ||
  checkoutPath === undefined ||
  model === undefined ||
  artifactDirectory === undefined
) {
  throw new Error("Expected architecture review worker arguments");
}

const priorProposals = JSON.parse(
  await readFile(join(artifactDirectory, "architecture-review-input.json"), "utf8"),
) as readonly ArchitectureReviewProposal[];

const startup = await readTargetWorkerStartup();
const reviewer = createSameSessionArchitectureReviewExtractor({
  sandbox: startup.sandbox,
  hooks: { sandbox: { onSandboxReady: [] } },
});
const outcome = await reviewer.review({
  revision,
  checkoutPath,
  priorProposals,
  model,
  artifactDirectory,
});
console.log(JSON.stringify(outcome));
