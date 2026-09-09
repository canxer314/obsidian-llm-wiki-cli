import { createBranchUpdateConflictResolverSession } from "./branch-update-conflict-resolver.ts";
import { sandboxHooksFor } from "./sandbox.ts";
import { readTargetWorkerStartup } from "./target-operation-startup.ts";

const [mode, pullRequestNumber, branch, baseBranch, revision, checkoutPath, model, recoveryFlag, conflictsJson] = process.argv.slice(2);
if (
  (mode !== "resolve" && mode !== "format") ||
  pullRequestNumber === undefined ||
  branch === undefined ||
  baseBranch === undefined ||
  revision === undefined ||
  checkoutPath === undefined ||
  model === undefined ||
  recoveryFlag === undefined ||
  conflictsJson === undefined
) {
  throw new Error("Expected branch update conflict resolver worker arguments");
}
if (recoveryFlag !== "initial" && recoveryFlag !== "recovery") {
  throw new Error("Expected branch update conflict resolver recovery flag");
}

const conflicts = JSON.parse(conflictsJson) as unknown;
if (!Array.isArray(conflicts) || conflicts.some((conflict) => typeof conflict !== "string")) {
  throw new Error("Expected branch update conflict paths");
}

const startup = await readTargetWorkerStartup();
const session = createBranchUpdateConflictResolverSession({
  sandbox: startup.sandbox,
  hooks: sandboxHooksFor("merger"),
});
// Resolve mode runs one produce invocation against the in-progress merge and
// then the immutable formatting stage; format mode goes straight to
// formatting for an already completed exact merge.
const result = mode === "resolve"
  ? await session.resolve({
      model,
      pullRequestNumber: Number(pullRequestNumber),
      branch,
      baseBranch,
      checkoutPath,
      recovery: recoveryFlag === "recovery",
      conflicts,
    })
  : await session.format({
      model,
      pullRequestNumber: Number(pullRequestNumber),
      branch,
      baseBranch,
      checkoutPath,
    });
console.log(JSON.stringify(result));
