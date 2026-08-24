import { loadSandboxStartup } from "./sandbox.ts";
import { createSameSessionReviewExtractor } from "./review-extraction.ts";

const [pullRequestNumber, branch, revision, checkoutPath, reviewThreadsJson, model, artifactDirectory] = process.argv.slice(2);
if (
  pullRequestNumber === undefined ||
  branch === undefined ||
  revision === undefined ||
  checkoutPath === undefined ||
  reviewThreadsJson === undefined ||
  model === undefined ||
  artifactDirectory === undefined
) {
  throw new Error("Expected reviewer worker arguments");
}

const startup = await loadSandboxStartup();
const reviewer = createSameSessionReviewExtractor({
  sandbox: startup.automationSandbox,
  hooks: { sandbox: { onSandboxReady: [] } },
  agentEnvironment: startup.childEnvironments.claude,
});
const review = await reviewer.review({
  pullRequestNumber: Number(pullRequestNumber),
  branch,
  revision,
  checkoutPath,
  reviewThreads: JSON.parse(reviewThreadsJson),
  model,
  artifactDirectory,
});
console.log(JSON.stringify(review));
