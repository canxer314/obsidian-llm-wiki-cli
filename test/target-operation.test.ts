import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { createTargetOperationCommandRunner } from "../.sandcastle/target-operation-command.js";
import {
  createTargetOperationRunner,
  executeTargetOperationInCheckout,
  type TargetOperationIdentity,
} from "../.sandcastle/target-operation.js";

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
  it("records a blocked operation outcome as a failed job", async () => {
    const root = mkdtempSync(join(tmpdir(), "target-operation-blocked-log-"));
    const logsPath = join(root, "logs");
    const runner = createTargetOperationRunner({
      jobLogRoot: logsPath,
      startup: {
        imageName: "fixture-image",
        childEnvironments: { git: {}, github: {}, claude: {}, githubAgent: {} },
        models: { default: "default-model", planner: "planner-model", implementer: "implementer-model", reviewer: "reviewer-model" },
      },
      start: () => spawn("bash", ["-c", 'printf \'%s\\n\' \'{"status":"blocked","reason":"execution"}\''], {
        detached: true,
        stdio: ["pipe", "pipe", "pipe"],
      }),
    });

    try {
      await expect(runner.run({
        operation: "implement-issue",
        number: 219,
        revision,
        jobId: "blocked-job-219",
      })).resolves.toEqual({ status: "blocked", reason: "execution" });
      expect(JSON.parse(readFileSync(
        join(logsPath, "blocked-job-219", "metadata.json"),
        "utf8",
      ))).toMatchObject({ status: "failed", jobId: "blocked-job-219" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each(Object.keys(operationEntries) as TargetOperationIdentity[])(
    "retains one completed whole-job log for fixed %s execution",
    async (operation) => {
      const root = mkdtempSync(join(tmpdir(), "target-operation-identity-log-"));
      const jobId = `job-${operation}`;
      const start = vi.fn(() => spawn("bash", ["-c", 'printf \'%s\\n\' \'{"status":"completed-fixture"}\''], {
        detached: true,
        stdio: ["pipe", "pipe", "pipe"],
      }));
      const runner = createTargetOperationRunner({
        jobLogRoot: join(root, "logs"),
        startup: {
          imageName: "fixture-image",
          childEnvironments: { git: {}, github: {}, claude: {}, githubAgent: {} },
          models: { default: "default-model", planner: "planner-model", implementer: "implementer-model", reviewer: "reviewer-model" },
        },
        start,
      });
      const pullRequest = operation === "implement-feedback" || operation === "review" || operation === "update-branch"
        ? {
            headSha: revision,
            headRefName: "feature-branch",
            baseRefName: "master",
            baseRepository: "owner/repository",
            headRepository: "owner/repository",
          }
        : undefined;

      try {
        await expect(runner.run({
          operation,
          number: 219,
          revision,
          jobId,
          ...(pullRequest === undefined ? {} : { pullRequest }),
        })).resolves.toEqual({ status: "completed-fixture" });
        expect(JSON.parse(readFileSync(
          join(root, "logs", jobId, "metadata.json"),
          "utf8",
        ))).toMatchObject({ operation, status: "completed", jobId });
        expect(start).toHaveBeenCalledWith([]);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it("preserves the target failure when failure metadata cannot be completed", async () => {
    const root = mkdtempSync(join(tmpdir(), "target-operation-metadata-failure-"));
    const logsPath = join(root, "logs");
    const runner = createTargetOperationRunner({
      jobLogRoot: logsPath,
      startup: {
        imageName: "fixture-image",
        childEnvironments: { git: {}, github: {}, claude: {}, githubAgent: {} },
        models: { default: "default-model", planner: "planner-model", implementer: "implementer-model", reviewer: "reviewer-model" },
      },
      start: () => {
        const metadataPath = join(logsPath, "job-219", "metadata.json");
        rmSync(metadataPath);
        mkdirSync(metadataPath);
        return spawn("bash", ["-c", 'printf "original target failure" >&2; exit 9'], {
          detached: true,
          stdio: ["pipe", "pipe", "pipe"],
        });
      },
    });

    try {
      await expect(runner.run({
        operation: "implement-issue",
        number: 219,
        revision,
        jobId: "job-219",
      })).rejects.toThrow("original target failure");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("classifies a failed outer worker by outcome rather than diagnostic wording", async () => {
    const root = mkdtempSync(join(tmpdir(), "target-operation-failed-log-"));
    const logsPath = join(root, "logs");
    const runner = createTargetOperationRunner({
      jobLogRoot: logsPath,
      startup: {
        imageName: "fixture-image",
        childEnvironments: { git: {}, github: {}, claude: {}, githubAgent: {} },
        models: { default: "default-model", planner: "planner-model", implementer: "implementer-model", reviewer: "reviewer-model" },
      },
      start: () => spawn("bash", ["-c", 'printf "partial stdout\\n"; printf "setup timed out" >&2; exit 7'], {
        detached: true,
        stdio: ["pipe", "pipe", "pipe"],
      }),
    });

    try {
      await expect(runner.run({
        operation: "implement-issue",
        number: 219,
        revision,
        jobId: "failed-job-219",
      })).rejects.toThrow("setup timed out");
      expect(readFileSync(join(logsPath, "failed-job-219", "stdout.log"), "utf8"))
        .toBe("partial stdout\n");
      expect(readFileSync(join(logsPath, "failed-job-219", "stderr.log"), "utf8"))
        .toBe("setup timed out");
      expect(JSON.parse(readFileSync(
        join(logsPath, "failed-job-219", "metadata.json"),
        "utf8",
      ))).toMatchObject({ status: "failed", jobId: "failed-job-219" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("times out checkout setup and terminates its whole descendant process group", async () => {
    const logRoot = mkdtempSync(join(tmpdir(), "target-operation-timeout-log-"));
    const marker = join(tmpdir(), `target-checkout-descendant-${process.pid}.pid`);
    const script = [
      'trap "" TERM',
      'printf "checkout started\\n"',
      'printf "checkout waiting\\n" >&2',
      `bash -c 'trap "" TERM; sleep 30' </dev/null >/dev/null 2>&1 &`,
      `echo $! > "${marker}"`,
      "wait",
    ].join("\n");
    const runner = createTargetOperationRunner({
      jobLogRoot: logRoot,
      startup: {
        imageName: "fixture-image",
        childEnvironments: { git: {}, github: {}, claude: {}, githubAgent: {} },
        models: { default: "default-model", planner: "planner-model", implementer: "implementer-model", reviewer: "reviewer-model" },
      },
      timeoutMilliseconds: 100,
      graceMilliseconds: 100,
      start: () => spawn("bash", ["-c", script], {
        detached: true,
        stdio: ["pipe", "pipe", "pipe"],
      }),
    });

    try {
      await expect(runner.run({
        operation: "implement-issue",
        number: 219,
        revision,
        jobId: "job-219",
      })).rejects.toThrow("Target operation implement-issue timed out");
      expect(readFileSync(join(logRoot, "job-219", "stdout.log"), "utf8"))
        .toContain("checkout started\n");
      expect(readFileSync(join(logRoot, "job-219", "stderr.log"), "utf8"))
        .toContain("checkout waiting\n");
      expect(JSON.parse(readFileSync(
        join(logRoot, "job-219", "metadata.json"),
        "utf8",
      ))).toMatchObject({ status: "timed-out", jobId: "job-219" });
      const descendantPid = Number(readFileSync(marker, "utf8"));
      expect(() => process.kill(descendantPid, 0)).toThrow();
    } finally {
      try {
        process.kill(Number(readFileSync(marker, "utf8")), "SIGKILL");
      } catch {
        // The assertion path normally leaves no process to clean up.
      }
      rmSync(marker, { force: true });
      rmSync(logRoot, { recursive: true, force: true });
    }
  });

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
        await expect(executeTargetOperationInCheckout({
          checkout: { withCheckout },
          startup: {
            imageName: "fixture-image",
            childEnvironments: { git: {}, github: { GH_TOKEN: "snapshot-token" }, claude: {}, githubAgent: {} },
            models: { default: "default-model", planner: "planner-model", implementer: "implementer-model", reviewer: "reviewer-model" },
          },
          invocation: {
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
          },
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
      const target = {
        run: (invocation: Parameters<typeof executeTargetOperationInCheckout>[0]["invocation"]) =>
          executeTargetOperationInCheckout({
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
            invocation,
          }),
      };
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
      await expect(executeTargetOperationInCheckout({
        checkout: { withCheckout: async (_request, action) => action(checkoutPath) },
        startup: {
          imageName: "fixture-image",
          childEnvironments: { git: {}, github: {}, claude: {}, githubAgent: {} },
          models: { default: "default-model", planner: "planner-model", implementer: "implementer-model", reviewer: "reviewer-model" },
        },
        invocation: {
          operation: "implement-issue",
          number: 219,
          revision,
          jobId: "job-219",
        },
      })).rejects.toThrow(
        "Target operation entry must be a regular file inside the authorized checkout",
      );
    } finally {
      rmSync(checkoutPath, { force: true, recursive: true });
      rmSync(outsidePath, { force: true });
    }
  });
});
