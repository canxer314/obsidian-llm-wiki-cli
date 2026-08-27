import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import * as sandboxModule from "../.sandcastle/sandbox.js";

const root = resolve(import.meta.dirname, "..");
const dockerfile = readFileSync(resolve(root, ".sandcastle/Dockerfile"), "utf8");
const dockerIgnore = readFileSync(resolve(root, ".dockerignore"), "utf8");
const sandboxDockerIgnore = readFileSync(
  resolve(root, ".sandcastle/.dockerignore"),
  "utf8",
);
const sandboxConfig = readFileSync(
  resolve(root, ".sandcastle/sandbox.ts"),
  "utf8",
);
const feedbackWorker = readFileSync(
  resolve(root, ".sandcastle/feedback-worker.ts"),
  "utf8",
);
const implementationWorker = readFileSync(
  resolve(root, ".sandcastle/implementation-worker.ts"),
  "utf8",
);
const prdImplementationWorker = readFileSync(
  resolve(root, ".sandcastle/prd-implementation-worker.ts"),
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
      "repairSandboxHooks",
      "sandboxHooks",
      "sandboxHooksFor",
    ]);
  });

  it("uses the repository's Node.js 24 runtime floor", () => {
    expect(packageJson.engines?.node).toBe(">=24.14.0");
    expect(dockerfile).toMatch(/^FROM node:24\.14\.0-bookworm$/m);
  });

  it("uses host networking", () => {
    expect(sandboxConfig).toMatch(/network:\s*["']host["']/);
    expect(sandboxConfig).toMatch(/env:\s*\{ \.\.\.environment \}/);
  });

  it("uses an image-seeded offline install for implementers only", () => {
    expect(sandboxModule.plannerSandboxHooks).toEqual({
      sandbox: { onSandboxReady: [] },
    });
    expect(sandboxModule.sandboxHooks.sandbox.onSandboxReady).toHaveLength(1);
    expect(sandboxModule.sandboxHooks.sandbox.onSandboxReady[0]).toEqual({
      command: expect.stringContaining("npm ci --offline"),
      timeoutMs: 270_000,
    });
    expect(sandboxModule.sandboxHooksFor("implementer")).toBe(
      sandboxModule.sandboxHooks,
    );
    expect(sandboxModule.sandboxHooksFor("feedback")).toBe(
      sandboxModule.repairSandboxHooks,
    );
    for (const role of ["reviewer", "merger"] as const) {
      expect(sandboxModule.sandboxHooksFor(role)).toBe(
        sandboxModule.repairSandboxHooks,
      );
    }
    expect(sandboxModule.sandboxHooksFor("planner")).toBe(
      sandboxModule.plannerSandboxHooks,
    );
    expect(dockerfile).toMatch(/COPY[^\n]*package\.json package-lock\.json/);
    expect(dockerfile).toMatch(/npm ci --ignore-scripts/);
    expect(dockerfile).toMatch(/sandcastle-image\.sha256/);
    expect(dockerfile).toMatch(/sandcastle-runtime\.versions/);
    expect(sandboxConfig).toMatch(/sha256sum --check --status/);
    expect(sandboxConfig).toMatch(/cmp --silent/);
    expect(sandboxConfig).toMatch(/timeout --signal=TERM --kill-after=10s 240s/);
    const revisionCompatibleInstall = sandboxModule.sandboxHooksFor("feedback")
      .sandbox.onSandboxReady[0];
    expect(revisionCompatibleInstall).toEqual({
      command: expect.stringContaining("npm ci --prefer-offline"),
      timeoutMs: 270_000,
    });
    for (const argument of [
      "cmp --silent - /home/agent/.npm/sandcastle-runtime.versions",
      "timeout --signal=TERM --kill-after=10s 240s",
      "--fetch-timeout=30000",
      "--fetch-retries=1",
      "--fetch-retry-mintimeout=1000",
      "--fetch-retry-maxtimeout=5000",
    ]) {
      expect(revisionCompatibleInstall?.command).toContain(argument);
    }
    expect(revisionCompatibleInstall?.command).not.toContain(
      "sha256sum --check",
    );
    expect(sandboxModule.repairSandboxHooks.sandbox.onSandboxReady[0]?.command)
      .toContain("npm ci --prefer-offline");
    expect(sandboxModule.repairSandboxHooks.sandbox.onSandboxReady[0]?.command)
      .toContain("--fetch-timeout=30000");
    expect(sandboxConfig).not.toMatch(/command:\s*["']npm install["']/);
    expect(sandboxConfig).not.toMatch(/copyToWorktree[\s\S]*node_modules/);
  });

  it("wires feedback to the revision-compatible install profile", () => {
    expect(feedbackWorker).toContain('sandboxHooksFor("feedback")');
    expect(feedbackWorker).not.toContain('sandboxHooksFor("implementer")');
  });

  it("keeps current-base implementation workers on the strict install profile", () => {
    for (const worker of [implementationWorker, prdImplementationWorker]) {
      expect(worker).toContain('sandboxHooksFor("implementer")');
      expect(worker).not.toContain('sandboxHooksFor("feedback")');
    }
  });

  it("excludes private configuration from Docker build contexts", () => {
    expect(dockerIgnore).toContain(".sandcastle/*");
    expect(dockerIgnore).toContain("!.sandcastle/Dockerfile");
    expect(dockerIgnore).not.toContain("!.sandcastle/.env");
    expect(sandboxDockerIgnore).toContain(".sandcastle/*");
    expect(sandboxDockerIgnore).toContain("!.sandcastle/Dockerfile");
    expect(sandboxDockerIgnore).not.toContain("!.sandcastle/.env");
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
    expect(smokeTest).toMatch(/docker exec [^\n]* npm ci --offline/);
    expect(smokeTest).toMatch(/docker exec [^\n]* npm run build/);
    expect(smokeTest).toMatch(/docker exec [^\n]* npm run typecheck/);
    expect(smokeTest).toMatch(/docker exec [^\n]* npm test/);
    expect(smokeTest).toMatch(/rsync -a --delete/);
    expect(smokeTest).toMatch(/--exclude='node_modules'/);
    expect(smokeTest).toMatch(/--exclude='\.sandcastle\/\.env'/);
    expect(smokeTest).not.toMatch(/--volume[^\n]*node_modules/);
  });
});
