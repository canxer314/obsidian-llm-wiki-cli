import { createFeedbackImplementerSession } from "./feedback-implementer-session.ts";
import { loadSandboxStartup, sandboxHooksFor } from "./sandbox.ts";

const [pullRequestNumber, branch, revision, checkoutPath, model] = process.argv.slice(2);
if (
  pullRequestNumber === undefined ||
  branch === undefined ||
  revision === undefined ||
  checkoutPath === undefined ||
  model === undefined
) {
  throw new Error("Expected feedback implementation worker arguments");
}

const startup = await loadSandboxStartup();
const reply = await createFeedbackImplementerSession({
  sandbox: startup.githubAgentSandbox,
  hooks: sandboxHooksFor("feedback"),
}).run({
  model,
  pullRequestNumber: Number(pullRequestNumber),
  branch,
  revision,
  checkoutPath,
});
console.log(JSON.stringify({ status: "implemented", reply }));
