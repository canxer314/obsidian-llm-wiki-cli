import { loadSandboxStartup } from "./sandbox.ts";
import { createSameSessionReviewExtractor } from "./review-extraction.ts";

const [pullRequestNumber, revision, checkoutPath, model, artifactDirectory] = process.argv.slice(2);
if (
  pullRequestNumber === undefined ||
  revision === undefined ||
  checkoutPath === undefined ||
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
  revision,
  checkoutPath,
  model,
  artifactDirectory,
});
console.log(JSON.stringify(review));
