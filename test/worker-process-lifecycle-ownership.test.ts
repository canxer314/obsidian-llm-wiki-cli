import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const lifecycle = readFileSync(new URL("../.sandcastle/worker-process-lifecycle.ts", import.meta.url), "utf8");
const timeout = readFileSync(new URL("../.sandcastle/job-timeout.ts", import.meta.url), "utf8");

describe("worker process lifecycle ownership", () => {
  it("keeps timeout orchestration behind the lifecycle seam", () => {
    expect(lifecycle).toContain('from "./job-timeout.ts"');
    expect(timeout).toContain("runJobWithTimeout");
  });

  it("does not become a universal command runner", () => {
    expect(lifecycle).not.toMatch(/\bspawn\b/u);
    expect(lifecycle).not.toMatch(/\b(?:executable|arguments_|checkoutPath|workerFile)\b/u);
  });
});
