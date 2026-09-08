import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const sandcastleDir = resolve(import.meta.dirname, "../.sandcastle");

const automationGithubSource = (): string =>
  readFileSync(resolve(sandcastleDir, "automation-github.ts"), "utf8");

// Every read the review publisher gates on must flow through the single
// `execute` binding that createAutomationGithubPort derives from the shared
// safe-read boundary (#444). These members are the whole publication and
// reply surface; an idempotent GET or GraphQL read added anywhere else in them
// that shells out behind the boundary would silently lose the shared retry
// budget and could replay a review submission the next time GitHub blips.
const PUBLISH_GATED_MEMBERS: readonly {
  readonly name: string;
  readonly signature: string;
}[] = [
  { name: "publishReview", signature: "async publishReview(request) {" },
  { name: "readUnresolvedReviewThreads", signature: "async readUnresolvedReviewThreads(pullRequestNumber) {" },
  { name: "replyToReviewThread", signature: "async replyToReviewThread(request) {" },
  { name: "markPullRequestReady", signature: "async markPullRequestReady(pullRequestNumber) {" },
];

function memberBody(source: string, signature: string): string {
  const start = source.indexOf(signature);
  if (start === -1) throw new Error(`member not found: ${signature}`);
  const openBrace = source.indexOf("{", start);
  let depth = 0;
  for (let index = openBrace; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    else if (source[index] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(openBrace + 1, index);
    }
  }
  throw new Error(`member body is unterminated: ${signature}`);
}

const RAW_EXECUTOR_PATTERNS: readonly { readonly pattern: RegExp; readonly description: string }[] = [
  { pattern: /execFile(?:Async)?\(/u, description: "a raw execFile executor" },
  { pattern: /executeFile\(/u, description: "the promisified execFile helper" },
  { pattern: /options\.execute\(/u, description: "the unwrapped injected execute" },
];

function seamDriftViolations(name: string, body: string): string[] {
  const violations: string[] = [];
  if (!body.includes('execute("gh"')) {
    violations.push(`${name} no longer issues its gh traffic through the shared execute`);
  }
  for (const { pattern, description } of RAW_EXECUTOR_PATTERNS) {
    if (pattern.test(body)) {
      violations.push(`${name} issues gh traffic through ${description} instead of the shared execute`);
    }
  }
  if (/\bconst execute\s*=/u.test(body)) {
    violations.push(`${name} shadows the shared execute binding`);
  }
  // The boundary treats every `gh api graphql` invocation as an idempotent read
  // (#444). A mutation smuggled through that shape would be replayed on a
  // transient failure, so none of these members may carry one.
  if (body.includes('"mutation=')) {
    violations.push(`${name} routes a GraphQL mutation through the retry-safe GraphQL read shape`);
  }
  return violations;
}

describe("review publication safe-read seam drift guard", () => {
  it("keeps createAutomationGithubPort bound to the single shared safe-read boundary", () => {
    const source = automationGithubSource();
    const portStart = source.indexOf("export function createAutomationGithubPort(");
    const seamBindings = source.match(/const execute = createGithubSafeReadRetryBoundary\(/gu) ?? [];
    expect(portStart).toBeGreaterThanOrEqual(0);
    expect(seamBindings).toHaveLength(1);
    expect(source.indexOf("const execute = createGithubSafeReadRetryBoundary(")).toBeGreaterThan(portStart);
  });

  it.each(PUBLISH_GATED_MEMBERS)(
    "routes every $name GitHub call through the shared execute and never a raw executor",
    ({ name, signature }) => {
      expect(seamDriftViolations(name, memberBody(automationGithubSource(), signature))).toEqual([]);
    },
  );

  it("still inspects the idempotent reads the publisher gates on", () => {
    const source = automationGithubSource();
    const publish = memberBody(source, "async publishReview(request) {");
    const threads = memberBody(source, "async readUnresolvedReviewThreads(pullRequestNumber) {");
    const reply = memberBody(source, "async replyToReviewThread(request) {");
    expect(publish).toContain('"pr", "view"');
    expect(publish).toContain("/files");
    expect(threads).toContain('"api", "graphql"');
    expect(reply).toContain('"api", "graphql"');
  });

  it("keeps the review POST, Ready mutation, and thread reply POST in single-shot gh shapes", () => {
    const source = automationGithubSource();
    const publish = memberBody(source, "async publishReview(request) {");
    const ready = memberBody(source, "async markPullRequestReady(pullRequestNumber) {");
    const reply = memberBody(source, "async replyToReviewThread(request) {");
    // Explicit REST POSTs and the pr ready command are not classified as
    // retry-safe reads, so the shared boundary executes them exactly once.
    expect(publish).toContain("/reviews");
    expect(publish).toContain('"--method", "POST"');
    expect(reply).toContain("/replies");
    expect(reply).toContain('"--method", "POST"');
    expect(ready).toContain('"pr", "ready"');
  });

  it("catches a future publish-gated read that bypasses the shared boundary", () => {
    const source = automationGithubSource();
    // A new gated read that shells out directly instead of going through the
    // seam would lose the shared retry budget and must fail the guard.
    const bypassed = memberBody(source, "async publishReview(request) {")
      .replace('execute("gh",', 'executeFile("gh",');
    expect(seamDriftViolations("publishReview", bypassed)).not.toEqual([]);

    // A write converted into the retry-safe GraphQL shape would be replayed on
    // a transient failure; the guard must flag it too.
    const mutatedReply = memberBody(source, "async replyToReviewThread(request) {")
      .replace("query=query($id:ID!)", "mutation=resolveReviewThread");
    expect(seamDriftViolations("replyToReviewThread", mutatedReply)).not.toEqual([]);
  });
});
