import { describe, expect, it } from "vitest";
import type {
  ReviewRequest,
  ValidationRequest,
} from "@llm-wiki/afk-delivery-core";
import {
  buildReviewRequest,
  parseReviewHandoff,
  runReviewStage,
  runValidationStage,
  validationCheckId,
  type ReviewStagePorts,
  type ValidationStagePorts,
} from "../src/validation-review.js";

const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);

const validationRequest: ValidationRequest = {
  revision: HEAD,
  round: 2,
  workflowRun: { id: "run-7", attempt: 3 },
  checks: [
    { command: "npm test", source: "repository-policy" },
    { command: "npm run ticket-check", source: "delivery-ticket" },
  ],
};

const capabilities = {
  sourceReadOnly: true,
  canEdit: false,
  canCommit: false,
  canPush: false,
  canComment: false,
  githubCredentials: false,
} as const;

const reviewRequest: ReviewRequest = {
  ticket: {
    number: 67,
    open: true,
    labels: ["ready-for-agent"],
    openBlockerNumbers: [],
    dependencyDataComplete: true,
    body: "Complete ticket",
  },
  round: 1,
  repositoryInstructions: "Repository instructions",
  domainDocuments: [{ path: "CONTEXT.md", content: "Domain" }],
  architectureDecisions: [{ path: "docs/adr/0001.md", content: "Decision" }],
  baseRevision: BASE,
  headRevision: HEAD,
  diff: "diff --git a/a.ts b/a.ts\n+change",
  skill: {
    path: "/home/agent/.claude/skills/code-review/SKILL.md",
    revision: "sha256:29f1ac715f1a2acb97a694b958531a032249ab0ad662aa28b40ba54c4bdb2ab0",
  },
  capabilities,
};

const approvedHandoff = [
  "## Verdict",
  "approved",
  "",
  "## Standards",
  "No findings.",
  "",
  "## Spec",
  "No findings.",
  "",
  "## Interactions",
  "None.",
  "",
  "## Constraints",
  "None.",
].join("\n");

function validationPorts(
  runCheck: ValidationStagePorts["runCheck"],
  createDetachedClone: ValidationStagePorts["createDetachedClone"] = async () => ({ path: "/tmp/exact" }),
) {
  let removed = false;
  return {
    ports: {
      createDetachedClone,
      runCheck,
      removeDetachedClone: async () => { removed = true; },
    } satisfies ValidationStagePorts,
    removed: () => removed,
  };
}

describe("validation and independent-review stages", () => {
  it("runs every required check and records exact workflow-bound identities", async () => {
    const seen: string[] = [];
    const fake = validationPorts(async ({ command }) => {
      seen.push(command);
      return { exitCode: 0, timedOut: false };
    });

    const outcome = await runValidationStage(validationRequest, 5_000, fake.ports);

    expect(seen).toEqual(["npm test", "npm run ticket-check"]);
    expect(outcome).toEqual({
      kind: "validation",
      status: "succeeded",
      revision: HEAD,
      round: 2,
      commands: [
        { command: "npm test", checkId: validationCheckId(validationRequest, 0), exitCode: 0, timedOut: false },
        { command: "npm run ticket-check", checkId: validationCheckId(validationRequest, 1), exitCode: 0, timedOut: false },
      ],
    });
    expect(new Set(outcome.commands.map((command) => command.checkId)).size).toBe(2);
    expect(fake.removed()).toBe(true);
  });

  it("classifies command failure and timeout as code validation failures", async () => {
    let ordinal = 0;
    const fake = validationPorts(async () => ordinal++ === 0
      ? { exitCode: 1, timedOut: false }
      : { exitCode: null, timedOut: true });

    const outcome = await runValidationStage(validationRequest, 5_000, fake.ports);

    expect(outcome).toMatchObject({ status: "failed", failureKind: "code-validation" });
    expect(outcome.commands).toMatchObject([
      { exitCode: 1, timedOut: false },
      { exitCode: null, timedOut: true },
    ]);
  });

  it("distinguishes checkout and process infrastructure failures", async () => {
    const checkout = validationPorts(async () => ({ exitCode: 0, timedOut: false }), async () => {
      throw new Error("checkout failed");
    });
    await expect(runValidationStage(validationRequest, 5_000, checkout.ports)).resolves.toMatchObject({
      status: "failed",
      failureKind: "infrastructure",
      commands: [
        { command: "npm test", exitCode: null, timedOut: false },
        { command: "npm run ticket-check", exitCode: null, timedOut: false },
      ],
    });

    const process = validationPorts(async () => { throw new Error("spawn failed"); });
    await expect(runValidationStage(validationRequest, 5_000, process.ports)).resolves.toMatchObject({
      status: "failed",
      failureKind: "infrastructure",
    });
    expect(process.removed()).toBe(true);
  });

  it("parses only the complete ordered five-section handoff", () => {
    expect(parseReviewHandoff(approvedHandoff)).toEqual({
      disposition: "approved",
      narrative: approvedHandoff,
    });
    expect(parseReviewHandoff("## Verdict\napproved\n\n## Standards\nNo findings."))
      .toBeUndefined();
  });

  it("passes the complete immutable core request to the reviewer", async () => {
    let invocation: Parameters<ReviewStagePorts["runReviewer"]>[0] | undefined;
    const outcome = await runReviewStage(reviewRequest, 90_000, {
      runReviewer: async (input) => {
        invocation = input;
        return { exitCode: 0, stdout: approvedHandoff, stderr: "" };
      },
    });

    expect(JSON.parse(invocation!.request)).toEqual(reviewRequest);
    expect(invocation?.timeoutMs).toBe(90_000);
    expect(outcome).toEqual({
      kind: "review",
      status: "succeeded",
      revision: HEAD,
      baseRevision: BASE,
      round: 1,
      disposition: "approved",
      narrative: approvedHandoff,
      capabilities,
    });
    expect(buildReviewRequest(reviewRequest)).toBe(JSON.stringify(reviewRequest));
  });

  it.each([
    ["non-zero reviewer", async () => ({ exitCode: 1, stdout: "", stderr: "review failed" })],
    ["incomplete handoff", async () => ({ exitCode: 0, stdout: "## Verdict\napproved", stderr: "" })],
    ["launcher failure", async () => { throw new Error("reviewer unavailable"); }],
  ])("records %s as a complete unable-to-review handoff", async (_name, runReviewer) => {
    const outcome = await runReviewStage(reviewRequest, 90_000, { runReviewer });

    expect(outcome).toMatchObject({
      kind: "review",
      status: "succeeded",
      revision: HEAD,
      baseRevision: BASE,
      round: 1,
      disposition: "unable-to-review",
      capabilities,
    });
    expect(parseReviewHandoff(outcome.narrative)?.disposition).toBe("unable-to-review");
  });
});
