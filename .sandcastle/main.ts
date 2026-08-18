#!/usr/bin/env node

import { SandcastleCliError, runSandcastleCli } from "./cli.ts";
import { GithubCliPort } from "./github-cli.ts";

try {
  await runSandcastleCli(process.argv.slice(2), {
    github: new GithubCliPort(),
    startPlanner: async (issueNumber) => {
      console.log(`Issue #${issueNumber} passed Sandcastle startup validation`);
    },
  });
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = error instanceof SandcastleCliError ? error.exitCode : 1;
}
