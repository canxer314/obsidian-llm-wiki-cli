import { createBranchUpdateConflictResolverSession } from "./branch-update-conflict-resolver.ts";
import { loadSandboxStartup, sandboxHooksFor } from "./sandbox.ts";

const [pullRequestNumber, branch, baseBranch, revision, checkoutPath, model, conflictsJson] = process.argv.slice(2);
if (
  pullRequestNumber === undefined ||
  branch === undefined ||
  baseBranch === undefined ||
  revision === undefined ||
  checkoutPath === undefined ||
  model === undefined ||
  conflictsJson === undefined
) {
  throw new Error("Expected branch update conflict resolver worker arguments");
}

const conflicts = JSON.parse(conflictsJson) as unknown;
if (!Array.isArray(conflicts) || conflicts.some((conflict) => typeof conflict !== "string")) {
  throw new Error("Expected branch update conflict paths");
}

const startup = await loadSandboxStartup();
const result = await createBranchUpdateConflictResolverSession({
  sandbox: startup.automationSandbox,
  hooks: sandboxHooksFor("merger"),
}).resolve({
  model,
  pullRequestNumber: Number(pullRequestNumber),
  branch,
  baseBranch,
  checkoutPath,
  conflicts,
});
console.log(JSON.stringify(result));
