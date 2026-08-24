import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const sandcastleDir = resolve(import.meta.dirname, "../.sandcastle");

function workerSource(name: string): string {
  return readFileSync(resolve(sandcastleDir, name), "utf8");
}

// Agent roles whose contract can invoke the GitHub CLI inside the container.
// Each prompt either calls gh directly (planner, implementer, PRD splitter)
// or must inspect the Pull Request discussion (feedback implementer, reviewer).
const GITHUB_CAPABLE_WORKERS = [
  "implementation-worker.ts",
  "prd-implementation-worker.ts",
  "feedback-worker.ts",
  "review-worker.ts",
  "prd-split-worker.ts",
] as const;

// Agent roles that never call gh inside the container: the architecture
// review pass is explicitly read-only with proposals supplied as artifacts,
// and branch-update conflict resolution works purely over git.
const GITHUB_INDEPENDENT_WORKERS = [
  "architecture-review-worker.ts",
  "branch-update-conflict-worker.ts",
] as const;

describe("Agent container environment routing", () => {
  it("routes every GitHub-capable worker through the GitHub-capable sandbox", () => {
    for (const name of GITHUB_CAPABLE_WORKERS) {
      const source = workerSource(name);
      expect(source, name).toContain("startup.githubAgentSandbox");
    }
  });

  it("keeps GitHub-independent workers on the narrower Claude-only sandbox", () => {
    for (const name of GITHUB_INDEPENDENT_WORKERS) {
      const source = workerSource(name);
      expect(source, name).toContain("startup.automationSandbox");
      expect(source, name).not.toContain("githubAgentSandbox");
    }
  });

  it("never forwards a separate agent environment that could overlap the sandbox environment", () => {
    for (const name of [...GITHUB_CAPABLE_WORKERS, ...GITHUB_INDEPENDENT_WORKERS]) {
      expect(workerSource(name), name).not.toContain("agentEnvironment");
    }
  });
});
