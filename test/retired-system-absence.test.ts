import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const sandcastleDir = resolve(import.meta.dirname, "../.sandcastle");

function automationSources(): { readonly name: string; readonly content: string }[] {
  return readdirSync(sandcastleDir)
    .filter((name) => name.endsWith(".ts"))
    .map((name) => ({ name, content: readFileSync(resolve(sandcastleDir, name), "utf8") }));
}

// The retired claim/watch/worktree/repair system must not survive in any
// replacement execution path. These patterns encode the cutover boundary:
// no claim branches or receipts, no manual remote-tracking refs, no
// source-repository worktree registration, no Legacy Run State adoption.
const FORBIDDEN_PATTERNS: readonly { readonly pattern: RegExp; readonly behavior: string }[] = [
  { pattern: /refs\/remotes\/origin/u, behavior: "manually creates a remote-tracking ref" },
  { pattern: /update-ref/u, behavior: "rewrites refs behind fetch" },
  { pattern: /\bgit\b[^'"\n]*\bworktree\b[^'"\n]*\b(add|register)\b/u, behavior: "registers a source-repository worktree" },
  { pattern: /SandcastleClaimReceipt|runSandcastleCli|finalizeInterruptedClaim/u, behavior: "uses the retired claim receipt model" },
  { pattern: /sandcastle:failed/u, behavior: "uses the retired failure label model" },
  { pattern: /\brecovered\b/u, behavior: "resumes Legacy Run State" },
  { pattern: /--watch/u, behavior: "exposes the retired watch process" },
];

describe("retired Sandcastle system absence", () => {
  it("no replacement source path contains retired claim, ref, worktree, or recovery behavior", () => {
    const sources = automationSources();
    expect(sources.length).toBeGreaterThan(0);
    const violations = sources.flatMap(({ name, content }) =>
      FORBIDDEN_PATTERNS.filter(({ pattern }) => pattern.test(content))
        .map(({ behavior }) => `${name}: ${behavior}`));
    expect(violations).toEqual([]);
  });

  it("the retired feedback entry seam is absent from the repository", () => {
    expect(existsSync(resolve(sandcastleDir, "feedback-implementation-ports.ts"))).toBe(false);
    const violations = automationSources().flatMap(({ name, content }) =>
      /feedback-implementation-ports|createFeedbackImplementationEntry|runDirect|runDispatcher/u.test(content)
        ? [name]
        : []);
    expect(violations).toEqual([]);
  });

  it("the production entry exposes only the automation command CLI", () => {
    const main = readFileSync(resolve(sandcastleDir, "main.ts"), "utf8");
    expect(main).toContain("runAutomationCli");
    expect(main).not.toContain("runSandcastleCli");
    expect(main).not.toMatch(/from "\.\/cli\.ts"/u);
  });
});
