import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const sandcastleDirectory = resolve(import.meta.dirname, "../.sandcastle");
const lifecycleName = "worker-process-lifecycle.ts";
const timeoutName = "job-timeout.ts";
const lifecycle = readFileSync(resolve(sandcastleDirectory, lifecycleName), "utf8");
const timeout = readFileSync(resolve(sandcastleDirectory, timeoutName), "utf8");
const protocolRunners = [
  "agent-process-runner.ts",
  "review-process-runner.ts",
  "architecture-review-process-runner.ts",
  "branch-update-process-runner.ts",
  "branch-update-conflict-process-runner.ts",
] as const;
const agentProtocolRunners = [
  "feedback-process-runner.ts",
  "branch-update-conflict-process-runner.ts",
  "implementation-process-runner.ts",
  "prd-split-process-runner.ts",
  "prd-implementation-process-runner.ts",
] as const;

function source(name: string): string {
  return readFileSync(resolve(sandcastleDirectory, name), "utf8");
}

function productionSources(): readonly { readonly name: string; readonly content: string }[] {
  return readdirSync(sandcastleDirectory)
    .filter((name) => name.endsWith(".ts"))
    .map((name) => ({ name, content: source(name) }));
}

describe("worker process lifecycle ownership", () => {
  it("keeps timeout orchestration behind the lifecycle seam", () => {
    const timeoutImports = productionSources()
      .filter(({ content }) => /from "\.\/job-timeout\.ts"/u.test(content))
      .map(({ name }) => name);

    expect(timeoutImports).toEqual([lifecycleName]);
    expect(lifecycle).toContain('from "./job-timeout.ts"');
    expect(timeout).toContain("runJobWithTimeout");
    for (const name of [...protocolRunners, ...agentProtocolRunners]) {
      const content = source(name);
      expect(content).not.toMatch(/\b(?:kill|wait|groupExited|probeGroup|processGroupOwner|inherited)\s*:/u);
      if (name !== "agent-process-runner.ts") {
        expect(content).not.toMatch(/readonly\s+(?:timeoutMilliseconds|graceMilliseconds)\??\s*:/u);
      }
    }
    for (const name of protocolRunners) {
      const content = source(name);
      expect(content).not.toMatch(/\brunJobWithTimeout\b/u);
      expect(content).not.toMatch(/\blifecycle\??\s*:/u);
      expect(content).not.toMatch(/\.on\(["']data["']/u);
    }
  });

  it("does not turn lifecycle admission into a command specification", () => {
    expect(lifecycle).not.toMatch(/\bspawn\b/u);
    expect(lifecycle).not.toMatch(
      /readonly\s+(?:executable|argv|arguments_|environment|checkoutPath|worker(?:File|Path)|command)\b/u,
    );
  });

  it("keeps fixed launch authority in the concrete protocol adapters", () => {
    expect(source("agent-process-runner.ts")).toContain("spawn(process.execPath");
    expect(source("review-process-runner.ts")).toContain('"review-worker.ts"');
    expect(source("architecture-review-process-runner.ts")).toContain('"architecture-review-worker.ts"');
    expect(source("branch-update-process-runner.ts")).toContain('spawn("git"');
    for (const name of agentProtocolRunners) {
      expect(source(name)).toMatch(/workerFile:\s*"[a-z-]+-worker\.ts"/u);
    }
  });
});
