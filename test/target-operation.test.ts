import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { AgentWorkerTimeoutError } from "../.sandcastle/agent-process-runner.js";
import { createTargetOperationCommandRunner } from "../.sandcastle/target-operation-command.js";
import {
  createTargetOperationRunner,
  createTargetOperationRunnerWithWorker,
  executeTargetOperationInCheckout,
  type TargetOperationIdentity,
} from "../.sandcastle/target-operation.js";

const revision = "a".repeat(40);

const operationStatuses: Readonly<Record<TargetOperationIdentity, string>> = {
  "implement-issue": "implemented",
  "implement-prd": "implemented",
  "implement-feedback": "implemented",
  review: "reviewed",
  "update-branch": "updated",
  "split-prd": "split",
  "architecture-review": "proposed",
};

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
  it.each([
    ["implement-issue", 60 * 60 * 1000],
    ["implement-prd", 60 * 60 * 1000],
    ["implement-feedback", 60 * 60 * 1000],
    ["review", 30 * 60 * 1000],
    ["update-branch", 60 * 60 * 1000],
    ["split-prd", 60 * 60 * 1000],
    ["architecture-review", 21 * 60 * 1000],
  ] as const)("applies the %i-millisecond whole-job timeout for %s", async (operation, timeoutMilliseconds) => {
    const runWorker = vi.fn(async () => ({ output: JSON.stringify({ status: operationStatuses[operation] }), code: 0, diagnostics: "" }));
    const runner = createTargetOperationRunnerWithWorker({
      startup: {
        imageName: "fixture-image",
        childEnvironments: { git: {}, github: {}, claude: {}, githubAgent: {} },
        models: { default: "default-model", planner: "planner-model", implementer: "implementer-model", reviewer: "reviewer-model" },
      },
      start: () => {
        throw new Error("Target operation timeout test start should not run");
      },
    }, runWorker);
    const invocation = operation === "architecture-review"
      ? { operation, revision, jobId: `timeout-${operation}` }
      : {
          operation,
          number: 219,
          revision,
          jobId: `timeout-${operation}`,
          acquired: true,
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
        };

    await expect(runner.run(invocation)).resolves.toEqual({ status: operationStatuses[operation] });
    expect(runWorker).toHaveBeenCalledWith(expect.objectContaining({ timeoutMilliseconds }));
  });

  it("records an accepted refusal as a completed job", async () => {
    const root = mkdtempSync(join(tmpdir(), "target-operation-refused-log-"));
    const logsPath = join(root, "logs");
    const runner = createTargetOperationRunner({
      jobLogRoot: logsPath,
      startup: {
        imageName: "fixture-image",
        childEnvironments: { git: {}, github: {}, claude: {}, githubAgent: {} },
        models: { default: "default-model", planner: "planner-model", implementer: "implementer-model", reviewer: "reviewer-model" },
      },
      start: () => spawn("bash", ["-c", 'cat >/dev/null; printf \'%s\\n\' \'{"status":"refused","reason":"already handled"}\''], {
        detached: true,
        stdio: ["pipe", "pipe", "pipe"],
      }),
    });

    try {
      await expect(runner.run({
        operation: "implement-issue",
        number: 219,
        revision,
        jobId: "refused-job-219",
        acquired: true,
      })).resolves.toEqual({ status: "refused", reason: "already handled" });
      expect(JSON.parse(readFileSync(
        join(logsPath, "refused-job-219", "metadata.json"),
        "utf8",
      ))).toMatchObject({ status: "completed", jobId: "refused-job-219" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

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
      start: () => spawn("bash", ["-c", 'cat >/dev/null; printf \'%s\\n\' \'{"status":"blocked","reason":"execution"}\''], {
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
        acquired: true,
      })).resolves.toEqual({ status: "blocked", reason: "execution" });
      expect(JSON.parse(readFileSync(
        join(logsPath, "blocked-job-219", "metadata.json"),
        "utf8",
      ))).toMatchObject({ status: "failed", jobId: "blocked-job-219" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    "rejects label-triggered Target operations with invalid Work Item number %s before starting a Target job",
    async (number) => {
      const start = vi.fn();
      const runner = createTargetOperationRunner({
        startup: {
          imageName: "fixture-image",
          childEnvironments: { git: {}, github: {}, claude: {}, githubAgent: {} },
          models: { default: "default-model", planner: "planner-model", implementer: "implementer-model", reviewer: "reviewer-model" },
        },
        start,
      });

      await expect(runner.run({
        operation: "implement-issue",
        number,
        revision,
        jobId: "invalid-work-item-number",
      })).rejects.toThrow("Target operation Work Item number is invalid");
      expect(start).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["a Work Item number", { number: 1 }],
    ["an acquisition marker", { acquired: true }],
    ["Pull Request metadata", {
      pullRequest: {
        headSha: revision,
        headRefName: "feature-branch",
        baseRefName: "master",
        baseRepository: "owner/repository",
        headRepository: "owner/repository",
      },
    }],
    ["a label receiver", { receiver: "issue" }],
    ["a trigger label", { trigger: "agent:review" }],
    ["feedback reconciliation authorization", {
      reconcile: { invocation: "reconcile", expectedPost: revision },
    }],
    ["an unrecognized field", { unexpected: true }],
  ])("rejects scheduled architecture review with %s before starting a Target job", async (_caseName, forbidden) => {
    const start = vi.fn();
    const runner = createTargetOperationRunner({
      startup: {
        imageName: "fixture-image",
        childEnvironments: { git: {}, github: {}, claude: {}, githubAgent: {} },
        models: { default: "default-model", planner: "planner-model", implementer: "implementer-model", reviewer: "reviewer-model" },
      },
      start,
    });

    await expect(runner.run({
      operation: "architecture-review",
      revision,
      jobId: "invalid-scheduled-review",
      ...forbidden,
    } as Parameters<typeof runner.run>[0])).rejects.toThrow("Scheduled architecture review invocation is invalid");
    expect(start).not.toHaveBeenCalled();
  });

  it("records scheduled architecture review without a Work Item number", async () => {
    const root = mkdtempSync(join(tmpdir(), "target-operation-scheduled-log-"));
    const logsPath = join(root, "logs");
    const runner = createTargetOperationRunner({
      jobLogRoot: logsPath,
      startup: {
        imageName: "fixture-image",
        childEnvironments: { git: {}, github: {}, claude: {}, githubAgent: {} },
        models: { default: "default-model", planner: "planner-model", implementer: "implementer-model", reviewer: "reviewer-model" },
      },
      start: () => spawn("bash", ["-c", 'cat >/dev/null; printf \'%s\\n\' \'{"status":"proposed"}\''], {
        detached: true,
        stdio: ["pipe", "pipe", "pipe"],
      }),
    });

    try {
      await expect(runner.run({
        operation: "architecture-review",
        revision,
        jobId: "scheduled-architecture-review",
      })).resolves.toEqual({ status: "proposed" });
      expect(JSON.parse(readFileSync(
        join(logsPath, "scheduled-architecture-review", "metadata.json"),
        "utf8",
      ))).toEqual(expect.objectContaining({
        operation: "architecture-review",
        revision,
        status: "completed",
      }));
      expect(JSON.parse(readFileSync(
        join(logsPath, "scheduled-architecture-review", "metadata.json"), "utf8",
      ))).not.toHaveProperty("number");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each(Object.keys(operationEntries) as TargetOperationIdentity[])(
    "retains one completed whole-job log for fixed %s execution",
    async (operation) => {
      const root = mkdtempSync(join(tmpdir(), "target-operation-identity-log-"));
      const jobId = `job-${operation}`;
      const start = vi.fn(() => spawn("bash", ["-c", `cat >/dev/null; printf '%s\\n' '{"status":"${operationStatuses[operation]}"}'`], {
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

      const invocation = operation === "architecture-review"
        ? { operation, revision, jobId }
        : {
            operation,
            number: 219,
            revision,
            jobId,
            acquired: true,
            ...(pullRequest === undefined ? {} : { pullRequest }),
          };

      try {
        await expect(runner.run(invocation)).resolves.toEqual({ status: operationStatuses[operation] });
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

  it("rejects after successful execution when completed metadata cannot be finalized", async () => {
    const root = mkdtempSync(join(tmpdir(), "target-operation-completed-metadata-failure-"));
    const logsPath = join(root, "logs");
    const checkoutPath = join(root, "checkout");
    mkdirSync(checkoutPath);
    const runWorker = vi.fn(async () => {
      rmSync(checkoutPath, { recursive: true });
      const metadataPath = join(logsPath, "completed-log-failure", "metadata.json");
      chmodSync(metadataPath, 0o400);
      return { output: JSON.stringify({ status: "refused" }), code: 0, diagnostics: "" };
    });
    const runner = createTargetOperationRunnerWithWorker({
      jobLogRoot: logsPath,
      startup: {
        imageName: "fixture-image",
        childEnvironments: { git: {}, github: {}, claude: {}, githubAgent: {} },
        models: { default: "default-model", planner: "planner-model", implementer: "implementer-model", reviewer: "reviewer-model" },
      },
      start: () => {
        throw new Error("completed metadata failure test start should not run");
      },
    }, runWorker);

    try {
      await expect(runner.run({
        operation: "implement-issue",
        number: 219,
        revision,
        jobId: "completed-log-failure",
        acquired: true,
      })).rejects.toMatchObject({ code: "EACCES" });
      expect(existsSync(checkoutPath)).toBe(false);
      expect(JSON.parse(readFileSync(
        join(logsPath, "completed-log-failure", "metadata.json"),
        "utf8",
      ))).toMatchObject({ status: "running", jobId: "completed-log-failure" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

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
        return spawn("bash", ["-c", 'cat >/dev/null; printf "original target failure" >&2; exit 9'], {
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
        acquired: true,
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
      start: () => spawn("bash", ["-c", 'cat >/dev/null; printf "partial stdout\\n"; printf "setup timed out" >&2; exit 7'], {
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
        acquired: true,
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
      const failure = await runner.run({
        operation: "implement-issue",
        number: 219,
        revision,
        jobId: "job-219",
        acquired: true,
      }).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(AgentWorkerTimeoutError);
      expect(failure).toHaveProperty("name", "AgentWorkerTimeoutError");
      expect(failure).toHaveProperty("message", "Target operation implement-issue timed out");
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

  it.each([
    ["missing Pull Request metadata", undefined],
    ["a mismatched head SHA", {
      headSha: "b".repeat(40),
      headRefName: "feature-branch",
      baseRefName: "master",
      baseRepository: "owner/repository",
      headRepository: "owner/repository",
    }],
    ["a forked Pull Request", {
      headSha: revision,
      headRefName: "feature-branch",
      baseRefName: "master",
      baseRepository: "owner/repository",
      headRepository: "fork/repository",
    }],
  ])("rejects a Target runtime invocation with %s before reading startup", async (_caseName, pullRequest) => {
    const child = spawn(process.execPath, [
      "--experimental-strip-types",
      join(import.meta.dirname, "../.sandcastle/operations/review-pr.ts"),
      "219",
      JSON.stringify({
        operation: "review",
        revision,
        jobId: "runtime-pr-validation",
        acquired: true,
        ...(pullRequest === undefined ? {} : { pullRequest }),
      }),
    ], { stdio: ["pipe", "ignore", "pipe"] });
    child.stdin.end();
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    await new Promise<void>((resolveExit, reject) => {
      child.once("error", reject);
      child.once("close", () => resolveExit());
    });

    expect(stderr).toContain("Target Pull Request operation requires an acquired same-repository revision");
    expect(stderr).not.toContain("Target operation startup snapshot is missing");
  });

  it.each([
    ["missing Pull Request metadata", undefined],
    ["a mismatched head SHA", {
      headSha: "b".repeat(40),
      headRefName: "feature-branch",
      baseRefName: "master",
      baseRepository: "owner/repository",
      headRepository: "owner/repository",
    }],
    ["a forked Pull Request", {
      headSha: revision,
      headRefName: "feature-branch",
      baseRefName: "master",
      baseRepository: "owner/repository",
      headRepository: "fork/repository",
    }],
  ])("rejects %s before starting the Target job worker", async (_caseName, pullRequest) => {
    const start = vi.fn();
    const runner = createTargetOperationRunner({
      startup: {
        imageName: "fixture-image",
        childEnvironments: { git: {}, github: {}, claude: {}, githubAgent: {} },
        models: { default: "default-model", planner: "planner-model", implementer: "implementer-model", reviewer: "reviewer-model" },
      },
      start,
    });

    await expect(runner.run({
      operation: "review",
      number: 219,
      revision,
      jobId: "invalid-pr-invocation",
      acquired: true,
      ...(pullRequest === undefined ? {} : { pullRequest }),
    })).rejects.toThrow("Target Pull Request operation requires an acquired same-repository revision");
    expect(start).not.toHaveBeenCalled();
  });

  it.each([
    ["a Work Item number", { number: 1 }],
    ["an acquisition marker", { acquired: true }],
    ["Pull Request metadata", {
      pullRequest: {
        headSha: revision,
        headRefName: "feature-branch",
        baseRefName: "master",
        baseRepository: "owner/repository",
        headRepository: "owner/repository",
      },
    }],
    ["a label receiver", { receiver: "issue" }],
    ["a trigger label", { trigger: "agent:review" }],
    ["feedback reconciliation authorization", {
      reconcile: { invocation: "reconcile", expectedPost: revision },
    }],
    ["an unrecognized field", { unexpected: true }],
  ])("rejects a non-canonical scheduled envelope before reading startup", async (_caseName, forbidden) => {
    const child = spawn(process.execPath, [
      "--experimental-strip-types",
      join(import.meta.dirname, "../.sandcastle/operations/architecture-review.ts"),
      JSON.stringify({
        operation: "architecture-review",
        revision,
        jobId: "runtime-scheduled-envelope-validation",
        ...forbidden,
      }),
    ], { stdio: ["pipe", "ignore", "pipe"] });
    child.stdin.end();
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    await new Promise<void>((resolveExit, reject) => {
      child.once("error", reject);
      child.once("close", () => resolveExit());
    });

    expect(stderr).toContain("Target operation invocation is invalid");
    expect(stderr).not.toContain("Target operation startup snapshot is missing");
  });

  it("executes scheduled architecture review without a fake checkout number or wrapper argument", async () => {
    const checkoutPath = mkdtempSync(join(tmpdir(), "scheduled-architecture-review-"));
    const operationDirectory = join(checkoutPath, ".sandcastle", "operations");
    mkdirSync(operationDirectory, { recursive: true });
    writeFileSync(
      join(operationDirectory, "architecture-review.ts"),
      'let input = ""; for await (const chunk of process.stdin) input += chunk; console.log(JSON.stringify({ status: "proposed", arguments: process.argv.slice(2), checkout: JSON.parse(input).imageName }));\n',
    );
    const withCheckout = vi.fn(async (request, action: (path: string) => Promise<{
      readonly value: unknown;
      readonly disposition: "cleanup" | "retain";
    }>) => {
      expect(request).toEqual({ revision });
      const completion = await action(checkoutPath);
      expect(completion.disposition).toBe("cleanup");
      return completion.value;
    });

    try {
      await expect(executeTargetOperationInCheckout({
        checkout: { withCheckout },
        startup: {
          imageName: "fixture-image",
          childEnvironments: { git: {}, github: {}, claude: {}, githubAgent: {} },
          models: { default: "default-model", planner: "planner-model", implementer: "implementer-model", reviewer: "reviewer-model" },
        },
        invocation: {
          operation: "architecture-review",
          revision,
          jobId: "scheduled-architecture-review",
        },
      })).resolves.toEqual({
        status: "proposed",
        arguments: [JSON.stringify({ operation: "architecture-review", revision, jobId: "scheduled-architecture-review" })],
        checkout: "fixture-image",
      });
    } finally {
      rmSync(checkoutPath, { force: true, recursive: true });
    }
  });

  it.each(Object.entries(operationEntries).filter(
    ([operation]) => operation !== "architecture-review",
  ) as [Exclude<TargetOperationIdentity, "architecture-review">, string][])(
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
          'const invocation = JSON.parse(process.argv[3]); console.log(JSON.stringify({ status: ({ "implement-issue": "implemented", "implement-prd": "implemented", "implement-feedback": "implemented", review: "reviewed", "update-branch": "updated", "split-prd": "split", "architecture-review": "proposed" })[invocation.operation], source: "authorized-operation", number: Number(process.argv[2]), token: startup.childEnvironments.github.GH_TOKEN, tokenInArguments: process.argv.includes(startup.childEnvironments.github.GH_TOKEN) }));',
        ].join("\n"),
      );
      const withCheckout = vi.fn(async (request, action: (path: string) => Promise<{
        readonly value: unknown;
        readonly disposition: "cleanup" | "retain";
      }>) => {
        expect(request).toEqual({ pullRequestNumber: 219, revision });
        const completion = await action(checkoutPath);
        expect(completion.disposition).toBe("cleanup");
        return completion.value;
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
            acquired: true,
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
          status: operationStatuses[operation],
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
                const completion = await action(checkoutPath);
                expect(completion.disposition).toBe("cleanup");
                return completion.value;
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

  it("rejects a fixed operation wrapper whose literal disagrees with the outer selected operation before startup", async () => {
    const child = spawn(process.execPath, [
      "--experimental-strip-types",
      join(import.meta.dirname, "../.sandcastle/operations/implement-issue.ts"),
      "219",
      JSON.stringify({
        operation: "review",
        revision,
        jobId: "wrapper-identity-mismatch",
      }),
    ], { stdio: ["pipe", "ignore", "pipe"] });
    child.stdin.end();
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    const exitCode = await new Promise<number | null>((resolveExit, reject) => {
      child.once("error", reject);
      child.once("close", resolveExit);
    });

    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("Target operation wrapper does not match the authorized invocation");
  });

  it.each([
    ["is missing", (operationDirectory: string) => operationDirectory],
    ["is a directory", (operationDirectory: string) => {
      mkdirSync(join(operationDirectory, "implement-issue.ts"));
      return operationDirectory;
    }],
  ])("rejects a fixed operation entry that %s before a worker starts", async (_caseName, prepare) => {
    const checkoutPath = mkdtempSync(join(tmpdir(), "target-operation-invalid-entry-"));
    const operationDirectory = join(checkoutPath, ".sandcastle", "operations");
    mkdirSync(operationDirectory, { recursive: true });
    prepare(operationDirectory);
    const withCheckout = vi.fn(async (_request, action: (path: string) => Promise<{
      readonly value: unknown;
      readonly disposition: "cleanup" | "retain";
    }>) => (await action(checkoutPath)).value);

    try {
      await expect(executeTargetOperationInCheckout({
        checkout: { withCheckout },
        startup: {
          imageName: "fixture-image",
          childEnvironments: { git: {}, github: {}, claude: {}, githubAgent: {} },
          models: { default: "default-model", planner: "planner-model", implementer: "implementer-model", reviewer: "reviewer-model" },
        },
        invocation: {
          operation: "implement-issue",
          number: 219,
          revision,
          jobId: "invalid-entry-job",
          acquired: true,
        },
      })).rejects.toThrow("Target operation entry must be a regular file inside the authorized checkout");
      expect(withCheckout).toHaveBeenCalledOnce();
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
        checkout: {
          withCheckout: async (_request, action) => (await action(checkoutPath)).value,
        },
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
          acquired: true,
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
