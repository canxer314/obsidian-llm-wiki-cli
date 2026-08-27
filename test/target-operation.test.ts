import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { createTargetOperationCommandRunner } from "../.sandcastle/target-operation-command.js";
import { createTargetOperationRunner, type TargetOperationIdentity } from "../.sandcastle/target-operation.js";

const revision = "a".repeat(40);

const operationEntries: Readonly<Record<TargetOperationIdentity, string>> = {
  "implement-issue": "implement-issue.ts",
  "implement-prd": "implement-prd.ts",
  "implement-feedback": "implement-pr.ts",
  review: "review-pr.ts",
  "update-branch": "update-branch.ts",
  "split-prd": "split-prd.ts",
  "architecture-review": "architecture-review.ts",
};

describe("Target operation runner", () => {
  it.each(Object.entries(operationEntries) as [TargetOperationIdentity, string][])(
    "executes fixed %s from the authorized Target Checkout",
    async (operation, entry) => {
      const checkoutPath = mkdtempSync(join(tmpdir(), "target-operation-"));
      const operationDirectory = join(checkoutPath, ".sandcastle", "operations");
      mkdirSync(operationDirectory, { recursive: true });
      writeFileSync(
        join(operationDirectory, entry),
        [
          'let input = ""; for await (const chunk of process.stdin) input += chunk;',
          'const startup = JSON.parse(input);',
          'console.log(JSON.stringify({ source: "authorized-operation", number: Number(process.argv[2]), token: startup.childEnvironments.github.GH_TOKEN, tokenInArguments: process.argv.includes(startup.childEnvironments.github.GH_TOKEN) }));',
        ].join("\n"),
      );
      const withCheckout = vi.fn(async (request, action: (path: string) => Promise<unknown>) => {
        expect(request).toEqual({ pullRequestNumber: 219, revision });
        return action(checkoutPath);
      });

      try {
        const runner = createTargetOperationRunner({
          checkout: { withCheckout },
          startup: {
            imageName: "fixture-image",
            childEnvironments: { git: {}, github: { GH_TOKEN: "snapshot-token" }, claude: {}, githubAgent: {} },
            models: { default: "default-model", planner: "planner-model", implementer: "implementer-model", reviewer: "reviewer-model" },
          },
        });

        await expect(runner.run({
          operation,
          number: 219,
          revision,
          jobId: "job-219",
          ...(operation === "implement-feedback" || operation === "review" || operation === "update-branch"
            ? {
                pullRequest: {
                  headSha: revision,
                  headRefName: "feature-branch",
                  baseRefName: "master",
                  baseRepository: "owner/repository",
                  headRepository: "owner/repository",
                },
              }
            : {}),
        })).resolves.toEqual({
          source: "authorized-operation",
          number: 219,
          token: "snapshot-token",
          tokenInArguments: false,
        });
        expect(withCheckout).toHaveBeenCalledOnce();
      } finally {
        rmSync(checkoutPath, { force: true, recursive: true });
      }
    },
  );

  it("captures the current Pull Request revision while trusted acquisition owns the labels", async () => {
    const checkoutPath = mkdtempSync(join(tmpdir(), "target-operation-acquisition-"));
    const operationDirectory = join(checkoutPath, ".sandcastle", "operations");
    mkdirSync(operationDirectory, { recursive: true });
    writeFileSync(
      join(operationDirectory, "review-pr.ts"),
      'for await (const _chunk of process.stdin) {} console.log(JSON.stringify({ status: "reviewed" }));\n',
    );
    const discoveredRevision = "a".repeat(40);
    const acquiredRevision = "b".repeat(40);
    const events: string[] = [];
    let readCount = 0;
    const read = vi.fn(async () => {
      readCount += 1;
      return {
        state: "OPEN",
        labels: readCount === 1
          ? ["agent:review"]
          : readCount === 2
            ? ["agent:review", "agent:in-progress"]
            : ["agent:in-progress"],
        revision: readCount === 1 ? discoveredRevision : acquiredRevision,
        pullRequest: {
          headSha: readCount === 1 ? discoveredRevision : acquiredRevision,
          headRefName: "feature-branch",
          baseRefName: "master",
          baseRepository: "owner/repository",
          headRepository: "owner/repository",
        },
      };
    });

    try {
      const target = createTargetOperationRunner({
        checkout: {
          withCheckout: async (request, action) => {
            events.push(`checkout:${request.revision}`);
            expect(request.revision).toBe(acquiredRevision);
            return action(checkoutPath);
          },
        },
        startup: {
          imageName: "fixture-image",
          childEnvironments: { git: {}, github: {}, claude: {}, githubAgent: {} },
          models: { default: "default-model", planner: "planner-model", implementer: "implementer-model", reviewer: "reviewer-model" },
        },
      });
      const runner = createTargetOperationCommandRunner({
        target,
        acquisition: {
          read,
          addInProgress: async () => { events.push("add-in-progress"); },
          removeTrigger: async () => { events.push("remove-trigger"); },
          addBlocked: async () => { events.push("add-blocked"); },
          addBlockedDiagnostic: async () => { events.push("add-blocked-diagnostic"); },
          removeInProgress: async () => { events.push("remove-in-progress"); },
        },
        createJobId: () => "job-219",
      });

      await expect(runner.run("review", 219)).resolves.toEqual({ status: "reviewed" });
      expect(events).toEqual([
        "add-in-progress",
        "remove-trigger",
        `checkout:${acquiredRevision}`,
        "remove-in-progress",
      ]);
      expect(read).toHaveBeenCalledTimes(3);
    } finally {
      rmSync(checkoutPath, { force: true, recursive: true });
    }
  });

  it("rejects a fixed operation entry that escapes the Target Checkout through a symlink", async () => {
    const checkoutPath = mkdtempSync(join(tmpdir(), "target-operation-symlink-"));
    const outsidePath = join(tmpdir(), `outside-operation-${process.pid}.ts`);
    const operationDirectory = join(checkoutPath, ".sandcastle", "operations");
    mkdirSync(operationDirectory, { recursive: true });
    writeFileSync(outsidePath, 'console.log(JSON.stringify({ escaped: true }));\n');
    symlinkSync(outsidePath, join(operationDirectory, "implement-issue.ts"));

    try {
      const runner = createTargetOperationRunner({
        checkout: { withCheckout: async (_request, action) => action(checkoutPath) },
        startup: {
          imageName: "fixture-image",
          childEnvironments: { git: {}, github: {}, claude: {}, githubAgent: {} },
          models: { default: "default-model", planner: "planner-model", implementer: "implementer-model", reviewer: "reviewer-model" },
        },
      });

      await expect(runner.run({
        operation: "implement-issue",
        number: 219,
        revision,
        jobId: "job-219",
      })).rejects.toThrow(
        "Target operation entry must be a regular file inside the authorized checkout",
      );
    } finally {
      rmSync(checkoutPath, { force: true, recursive: true });
      rmSync(outsidePath, { force: true });
    }
  });
});
