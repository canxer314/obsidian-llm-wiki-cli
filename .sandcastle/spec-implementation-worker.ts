import { implementSpecChild } from "./implementer.ts";
import { createSandcastleImplementerSession } from "./implementer-session.ts";
import { planIssue } from "./planner.ts";
import { createSandcastlePlannerSession } from "./planner-session.ts";
import { sandboxHooksFor } from "./sandbox.ts";
import { readTargetWorkerStartup } from "./target-operation-startup.ts";

const [specNumber, childNumber, branch, baseRevision, checkoutPath, plannerModel, implementerModel] = process.argv.slice(2);
if (
  specNumber === undefined ||
  childNumber === undefined ||
  branch === undefined ||
  baseRevision === undefined ||
  checkoutPath === undefined ||
  plannerModel === undefined ||
  implementerModel === undefined
) {
  throw new Error("Expected Spec implementation worker arguments");
}

const startup = await readTargetWorkerStartup();
const plannerSession = createSandcastlePlannerSession({
  sandbox: startup.sandbox,
  hooks: { sandbox: { onSandboxReady: [] } },
  checkoutPath,
  specContext: { parentSpec: Number(specNumber), branch },
});
const plan = await planIssue({
  issueNumber: Number(childNumber),
  model: plannerModel,
  session: plannerSession,
});
if (plan.status === "blocked") throw new Error(plan.blockingReason);
const implementerSession = createSandcastleImplementerSession({
  sandbox: startup.sandbox,
  hooks: sandboxHooksFor("implementer"),
});
// The Spec child runs through the durable Implementer path (#459): branch
// coordination freezes the shared accumulating branch head (or the Spec's
// authorized base revision) before attempt 1, recovery reconciles durable
// branch state between attempts, and the emitted headSha is read from the
// durable named ref — never from a single invocation's commit list.
const result = await implementSpecChild({
  plan,
  model: implementerModel,
  session: implementerSession,
  specNumber: Number(specNumber),
  branch,
  baseRevision,
  checkoutPath,
});
console.log(JSON.stringify({ branch: result.branch, headSha: result.headSha }));
