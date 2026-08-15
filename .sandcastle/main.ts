import { run, claudeCode } from "@ai-hero/sandcastle";
import { docker } from "@ai-hero/sandcastle/sandboxes/docker";

const result = await run({
  name: "afk-worker",
  agent: claudeCode("gpt-5.6-sol"),
  sandbox: docker({
    network: "host",
    cpus: 4,
  }),
  branchStrategy: {
    type: "branch",
    branch: "sandcastle/afk",
  },
  promptFile: "./.sandcastle/prompt.md",
  maxIterations: 1,
  completionSignal: "<promise>COMPLETE</promise>",
  hooks: {
    sandbox: {
      onSandboxReady: [{ command: "npm ci", timeoutMs: 300_000 }],
    },
  },
  logging: {
    type: "file",
    path: ".sandcastle/logs/afk.log",
    verbose: true,
  },
});

console.log({
  branch: result.branch,
  commits: result.commits,
  iterations: result.iterations,
  completionSignal: result.completionSignal,
});
