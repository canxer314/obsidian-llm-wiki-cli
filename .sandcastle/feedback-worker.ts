import { createFeedbackImplementerSession } from "./feedback-implementer-session.ts";
import { sandboxHooksFor } from "./sandbox.ts";
import { readTargetWorkerStartup } from "./target-operation-startup.ts";

const [pullRequestNumber, branch, revision, checkoutPath, rootCommentId, model] = process.argv.slice(2);
if (
  pullRequestNumber === undefined ||
  branch === undefined ||
  revision === undefined ||
  checkoutPath === undefined ||
  rootCommentId === undefined ||
  model === undefined
) {
  throw new Error("Expected feedback implementation worker arguments");
}

const startup = await readTargetWorkerStartup();
const reply = await createFeedbackImplementerSession({
  sandbox: startup.sandbox,
  hooks: sandboxHooksFor("feedback"),
}).run({
  model,
  pullRequestNumber: Number(pullRequestNumber),
  branch,
  revision,
  checkoutPath,
  rootCommentId,
});
console.log(JSON.stringify({ status: "implemented", reply }));
