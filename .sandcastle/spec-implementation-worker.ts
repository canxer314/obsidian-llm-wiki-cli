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
const result = await implementerSession.run({
  model: implementerModel,
  branch,
  plan,
  checkoutPath,
  parentSpec: { number: Number(specNumber) },
});
if (result.branch !== branch) {
  throw new Error(`Implementer used branch ${result.branch}; expected ${branch}`);
}
const headSha = result.commits.at(-1)?.sha;
if (headSha === undefined) throw new Error("Implementer did not create a commit");
if (headSha === baseRevision) {
  throw new Error("Implementer did not advance the authorized base revision");
}
console.log(JSON.stringify({ branch, headSha }));
