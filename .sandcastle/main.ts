#!/usr/bin/env node

import { SandcastleCliError, runSandcastleCli } from "./cli.ts";
import { GithubCliPort } from "./github-cli.ts";
import { createSandcastleImplementerSession } from "./implementer-session.ts";
import { implementIssue } from "./implementer.ts";
import { createSandcastlePlannerSession } from "./planner-session.ts";
import { planIssue } from "./planner.ts";
import { loadSandboxStartup, sandboxHooks } from "./sandbox.ts";

try {
  const github = new GithubCliPort();
  const result = await runSandcastleCli(process.argv.slice(2), {
    github,
    processIssue: async (issueNumber) => {
      const startup = await loadSandboxStartup();
      const plannerSession = createSandcastlePlannerSession({
        sandbox: startup.sandbox,
        hooks: sandboxHooks,
      });
      const plan = await planIssue({
        issueNumber,
        model: startup.models.planner,
        session: plannerSession,
      });
      if (plan.status === "blocked") return plan;
      const implementerSession = createSandcastleImplementerSession({
        sandbox: startup.sandbox,
        hooks: sandboxHooks,
      });
      return implementIssue({
        plan,
        model: startup.models.implementer,
        session: implementerSession,
        github,
      });
    },
  });
  if (result !== undefined) console.log(JSON.stringify(result));
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = error instanceof SandcastleCliError ? error.exitCode : 1;
}
