#!/usr/bin/env node

import { SandcastleCliError, runSandcastleCli } from "./cli.ts";
import { GithubCliPort } from "./github-cli.ts";
import { createSandcastlePlannerSession } from "./planner-session.ts";
import { planIssue } from "./planner.ts";
import { loadSandboxStartup, sandboxHooks } from "./sandbox.ts";

try {
  const plan = await runSandcastleCli(process.argv.slice(2), {
    github: new GithubCliPort(),
    startPlanner: async (issueNumber) => {
      const startup = await loadSandboxStartup();
      const session = createSandcastlePlannerSession({
        sandbox: startup.sandbox,
        hooks: sandboxHooks,
      });
      return planIssue({
        issueNumber,
        model: startup.models.planner,
        session,
      });
    },
  });
  if (plan !== undefined) console.log(JSON.stringify(plan));
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = error instanceof SandcastleCliError ? error.exitCode : 1;
}
