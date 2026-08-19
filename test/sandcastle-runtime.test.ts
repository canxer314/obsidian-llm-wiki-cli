import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import * as sandboxModule from "../.sandcastle/sandbox.js";

const root = resolve(import.meta.dirname, "..");
const dockerfile = readFileSync(resolve(root, ".sandcastle/Dockerfile"), "utf8");
const sandboxConfig = readFileSync(
  resolve(root, ".sandcastle/sandbox.ts"),
  "utf8",
);
const smokeTest = readFileSync(
  resolve(root, ".sandcastle/smoke-test.sh"),
  "utf8",
);
const packageJson = JSON.parse(
  readFileSync(resolve(root, "package.json"), "utf8"),
) as {
  engines?: { node?: string };
};

describe("Sandcastle Docker runtime", () => {
  it("provides role-specific startup hooks", () => {
    expect(Object.keys(sandboxModule).sort()).toEqual([
      "loadSandboxStartup",
      "plannerSandboxHooks",
      "sandboxHooks",
      "sandboxHooksFor",
    ]);
  });

  it("uses the repository's Node.js 24 runtime floor", () => {
    expect(packageJson.engines?.node).toBe(">=24.14.0");
    expect(dockerfile).toMatch(/^FROM node:24\.14\.0-bookworm$/m);
  });

  it("uses host networking", () => {
    expect(sandboxConfig).toMatch(/docker\(\{ network: ["']host["'], env:/);
  });

  it("installs lockfile dependencies for non-Planner sessions only", () => {
    expect(sandboxModule.plannerSandboxHooks).toEqual({
      sandbox: { onSandboxReady: [] },
    });
    expect(sandboxModule.sandboxHooks).toEqual({
      sandbox: {
        onSandboxReady: [{ command: "npm ci", timeoutMs: 300_000 }],
      },
    });
    expect(sandboxModule.sandboxHooksFor("planner")).toBe(
      sandboxModule.plannerSandboxHooks,
    );
    for (const role of ["implementer", "reviewer", "merger"] as const) {
      expect(sandboxModule.sandboxHooksFor(role)).toBe(sandboxModule.sandboxHooks);
    }
    expect(sandboxConfig).not.toMatch(/command:\s*["']npm install["']/);
    expect(sandboxConfig).not.toMatch(/copyToWorktree[\s\S]*node_modules/);
  });

  it("does not mount host credential or client configuration directories", () => {
    expect(sandboxConfig).not.toMatch(/mounts\s*:/);
    expect(sandboxConfig).not.toMatch(
      /hostPath:\s*["'][^"']*(?:\.claude|cc-switch|\.config\/gh|oauth)/i,
    );
  });

  it("provides a real Docker smoke test for the complete quality gate", () => {
    expect(smokeTest).toMatch(/docker run[\s\S]*--network host/);
    expect(smokeTest).toMatch(/docker inspect[\s\S]*NetworkMode/);
    expect(smokeTest).toMatch(/docker inspect[\s\S]*\.Mounts/);
    expect(smokeTest).toMatch(/docker exec [^\n]* npm ci/);
    expect(smokeTest).toMatch(/docker exec [^\n]* npm run build/);
    expect(smokeTest).toMatch(/docker exec [^\n]* npm run typecheck/);
    expect(smokeTest).toMatch(/docker exec [^\n]* npm test/);
    expect(smokeTest).not.toMatch(/node_modules/);
  });
});
