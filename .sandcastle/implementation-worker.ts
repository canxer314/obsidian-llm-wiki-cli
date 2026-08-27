import { GithubCliPort } from "./github-cli.ts";
import { createSandcastleImplementerSession } from "./implementer-session.ts";
import { implementIssue } from "./implementer.ts";
import { planIssue } from "./planner.ts";
import { createSandcastlePlannerSession } from "./planner-session.ts";
import { sandboxHooksFor } from "./sandbox.ts";
import { readTargetWorkerStartup } from "./target-operation-startup.ts";

const [issueNumber, baseRevision, checkoutPath, plannerModel, implementerModel] = process.argv.slice(2);
if (
  issueNumber === undefined ||
  baseRevision === undefined ||
  checkoutPath === undefined ||
  plannerModel === undefined ||
  implementerModel === undefined
) {
  throw new Error("Expected implementation worker arguments");
}

const startup = await readTargetWorkerStartup();
const plannerSession = createSandcastlePlannerSession({
  sandbox: startup.sandbox,
  hooks: { sandbox: { onSandboxReady: [] } },
  checkoutPath,
});
const plan = await planIssue({
  issueNumber: Number(issueNumber),
  model: plannerModel,
  session: plannerSession,
});
if (plan.status === "blocked") throw new Error(plan.blockingReason);
const implementerSession = createSandcastleImplementerSession({
  sandbox: startup.sandbox,
  hooks: sandboxHooksFor("implementer"),
});
const pullRequest = await implementIssue({
  plan,
  model: implementerModel,
  session: implementerSession,
  checkoutPath,
  github: new GithubCliPort(undefined, undefined, startup.githubEnvironment),
});
if (pullRequest.headSha === baseRevision) {
  throw new Error("Implementer did not advance the authorized base revision");
}
console.log(JSON.stringify({
  branch: `sandcastle/issue-${issueNumber}`,
  pullRequestUrl: pullRequest.url,
}));
