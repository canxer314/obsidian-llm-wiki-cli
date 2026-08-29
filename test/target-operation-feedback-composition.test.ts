import { spawn } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createTargetOperationCommandDispatch } from "../.sandcastle/target-operation-dispatch.js";
import { createTargetOperationCliHandlers } from "../.sandcastle/automation-target-composition.js";
import { runAutomationCli } from "../.sandcastle/automation-cli.js";
import type { AuthorizedTargetOperationInvocation } from "../.sandcastle/target-operation.js";

const PRE = "a".repeat(40);
const POST = "b".repeat(40);
const ROOT = "PRRC_root";
const operationEntry = resolve(import.meta.dirname, "../.sandcastle/operations/implement-pr.ts");
const temporaryDirectories: string[] = [];

const GH_FIXTURE = `#!/usr/bin/env node
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
appendFileSync(process.env.CALLS_FILE, JSON.stringify(args) + "\\n");
const pullRequest = {
  number: 347,
  state: "open",
  draft: true,
  base: { ref: "master", repo: { full_name: "owner/repository" } },
  head: { ref: "feature/feedback", sha: process.env.POST, repo: { full_name: "owner/repository" } },
  labels: [],
};
const marker = "<!-- feedback-reconcile op=feedback pr=347 pre=" + process.env.PRE + " post=" + process.env.POST + " root=" + process.env.ROOT + " -->";
const reviewState = (withReply) => ({
  pageInfo: { hasNextPage: false },
  nodes: [{
    isResolved: false,
    comments: {
      pageInfo: { hasNextPage: false },
      nodes: [
        { id: process.env.ROOT, replyTo: null, body: "Please fix.", createdAt: "2026-01-01T00:00:00Z" },
        ...(withReply ? [{
          id: "PRRC_reply",
          replyTo: { id: process.env.ROOT },
          body: "Fixed.\\n\\n" + marker,
          createdAt: "2026-01-01T00:00:01Z",
        }] : []),
      ],
    },
  }],
});

if (args[0] === "api" && args[1] === "repos/{owner}/{repo}/pulls/347") {
  process.stdout.write(JSON.stringify(pullRequest));
} else if (args[0] === "api" && args[1] === "repos/{owner}/{repo}/commits/" + process.env.POST) {
  process.stdout.write(process.env.PRE + "\\n");
} else if (args[0] === "api" && args[1] === "graphql" && args.some((value) => value.includes("reviewThreads(first:100)"))) {
  const count = existsSync(process.env.COUNT_FILE) ? Number(readFileSync(process.env.COUNT_FILE, "utf8")) : 0;
  const next = count + 1;
  writeFileSync(process.env.COUNT_FILE, String(next));
  if (process.env.SCENARIO === "reply-only" && next === 3) {
    process.stderr.write("HTTP 503 Service Unavailable\\n");
    process.exit(1);
  }
  process.stdout.write(JSON.stringify(reviewState(process.env.SCENARIO === "ordinary" || next >= 4)));
} else if (args[0] === "api" && args[1] === "graphql" && args.some((value) => value.includes("node(id:$id)"))) {
  process.stdout.write("123\\n");
} else if (args[0] === "api" && args[1].includes("/comments/123/replies")) {
  process.stdout.write("{}\\n");
} else if (args[0] === "pr" && args[1] === "comment") {
  process.stdout.write("{}\\n");
} else {
  process.stderr.write("Unexpected gh invocation: " + JSON.stringify(args) + "\\n");
  process.exit(2);
}
`;

async function executeFeedbackTarget(
  githubEnvironment: Readonly<Record<string, string>>,
  invocation: AuthorizedTargetOperationInvocation,
): Promise<Record<string, unknown>> {
  const startup = {
    imageName: "fixture-image",
    childEnvironments: { git: {}, github: githubEnvironment, claude: {}, githubAgent: {} },
    models: {
      default: "default-model",
      planner: "planner-model",
      implementer: "implementer-model",
      reviewer: "reviewer-model",
    },
  };
  const child = spawn(process.execPath, [
    "--experimental-strip-types",
    operationEntry,
    "347",
    JSON.stringify(invocation),
  ], {
    env: process.env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdin.end(JSON.stringify(startup));
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => { stderr += chunk; });
  const result = await new Promise<Record<string, unknown>>((resolveResult, rejectResult) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      rejectResult(new Error(`Target operation did not produce an outcome: ${stderr}`));
    }, 4000);
    child.on("error", rejectResult);
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      const line = stdout.indexOf("\n");
      if (line === -1) return;
      clearTimeout(timeout);
      try {
        resolveResult(JSON.parse(stdout.slice(0, line)) as Record<string, unknown>);
      } catch (error) {
        rejectResult(error);
      } finally {
        child.kill("SIGKILL");
      }
    });
    child.on("exit", (code) => {
      if (stdout.includes("\n")) return;
      clearTimeout(timeout);
      rejectResult(new Error(`Target operation exited ${code}: ${stderr}`));
    });
  });
  return result;
}

async function runFeedbackTarget(options: {
  readonly scenario: "ordinary" | "reply-only";
  readonly authorization?: {
    readonly invocation: "reconcile";
    readonly baseRevision: string;
    readonly expectedPost: string;
    readonly expectedReply: { readonly rootCommentId: string; readonly body: string };
  };
}) {
  const directory = await mkdtemp(join(tmpdir(), "feedback-composition-"));
  temporaryDirectories.push(directory);
  const gh = join(directory, "gh");
  const callsFile = join(directory, "calls.jsonl");
  const countFile = join(directory, "count");
  await writeFile(gh, GH_FIXTURE);
  await chmod(gh, 0o755);
  const githubEnvironment = {
    PATH: `${directory}${delimiter}${process.env.PATH ?? ""}`,
    CALLS_FILE: callsFile,
    COUNT_FILE: countFile,
    SCENARIO: options.scenario,
    PRE,
    POST,
    ROOT,
  };
  let labels = ["agent:implement"];
  const pullRequest = () => ({
    state: "OPEN",
    labels,
    headSha: POST,
    headRefName: "feature/feedback",
    baseRefName: "master",
    baseRepository: "owner/repository",
    headRepository: "owner/repository",
  });
  const target = {
    run: (invocation: AuthorizedTargetOperationInvocation) =>
      executeFeedbackTarget(githubEnvironment, invocation),
  };
  const dispatch = createTargetOperationCommandDispatch({
    github: {
      readBaseRevision: async () => POST,
      readPrd: async () => { throw new Error("Feedback composition has no PRD"); },
      readPullRequest: async () => pullRequest(),
      addIssueLabel: async () => { throw new Error("Feedback composition has no Issue labels"); },
      removeIssueLabel: async () => { throw new Error("Feedback composition has no Issue labels"); },
      addPullRequestLabel: async (_number, label) => { labels = [...new Set([...labels, label])]; },
      removePullRequestLabel: async (_number, label) => { labels = labels.filter((value) => value !== label); },
    },
    target,
    createJobId: () => "feedback-job",
  });
  const result = options.authorization === undefined
    ? await dispatch.runCommand({
        number: 347,
        operation: "implement",
        identity: "pull-request:347",
        labels: ["agent:implement"],
      })
    : await dispatch.runOperation("implement-feedback", 347, options.authorization);
  const calls = (await readFile(callsFile, "utf8"))
    .trim()
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as string[]);
  return { result, calls };
}

async function createCliFeedbackComposition(scenario: "ordinary" | "reply-only") {
  const directory = await mkdtemp(join(tmpdir(), "feedback-cli-composition-"));
  temporaryDirectories.push(directory);
  const gh = join(directory, "gh");
  const callsFile = join(directory, "calls.jsonl");
  await writeFile(gh, GH_FIXTURE);
  await chmod(gh, 0o755);
  const githubEnvironment = {
    PATH: `${directory}${delimiter}${process.env.PATH ?? ""}`,
    CALLS_FILE: callsFile,
    COUNT_FILE: join(directory, "count"),
    SCENARIO: scenario,
    PRE,
    POST,
    ROOT,
  };
  let labels = ["agent:implement"];
  const targetOperationCommands = createTargetOperationCommandDispatch({
    github: {
      readBaseRevision: async () => POST,
      readPrd: async () => { throw new Error("Feedback composition has no PRD"); },
      readPullRequest: async () => ({
        state: "OPEN",
        labels,
        headSha: POST,
        headRefName: "feature/feedback",
        baseRefName: "master",
        baseRepository: "owner/repository",
        headRepository: "owner/repository",
      }),
      addIssueLabel: async () => { throw new Error("Feedback composition has no Issue labels"); },
      removeIssueLabel: async () => { throw new Error("Feedback composition has no Issue labels"); },
      addPullRequestLabel: async (_number, label) => { labels = [...new Set([...labels, label])]; },
      removePullRequestLabel: async (_number, label) => { labels = labels.filter((value) => value !== label); },
    },
    target: { run: (invocation) => executeFeedbackTarget(githubEnvironment, invocation) },
    createJobId: () => "feedback-job",
  });
  return {
    callsFile,
    handlers: createTargetOperationCliHandlers({
      targetOperationCommands,
      withScheduler: async (_identity, action) => action(),
    }),
  };
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("Target feedback implementation production composition", () => {
  it("runs ordinary Target execution without Feedback Reconcile Authorization", async () => {
    const execution = await runFeedbackTarget({ scenario: "ordinary" });

    expect(execution.result).toMatchObject({
      status: "blocked",
      reason: "feedback-reconciliation",
      jobId: "feedback-job",
    });
    expect(execution.calls.filter((args) => args.some((value) => value.includes("/comments/123/replies"))))
      .toHaveLength(0);
  });

  it("preserves explicit authorization and uses the production read-error classifier", async () => {
    const execution = await runFeedbackTarget({
      scenario: "reply-only",
      authorization: {
        invocation: "reconcile",
        baseRevision: PRE,
        expectedPost: POST,
        expectedReply: { rootCommentId: ROOT, body: "Fixed." },
      },
    });

    expect(execution.result).toEqual({ status: "implemented", revision: POST, reconciled: true });
    expect(execution.calls.filter((args) => args.some((value) => value.includes("reviewThreads(first:100)"))))
      .toHaveLength(4);
    expect(execution.calls.filter((args) => args.some((value) => value.includes("/comments/123/replies"))))
      .toHaveLength(1);
  });

  it("runs ordinary CLI feedback without Feedback Reconcile Authorization", async () => {
    const composition = await createCliFeedbackComposition("ordinary");

    await expect(runAutomationCli(["run", "feedback", "347"], {
      runReview: composition.handlers.runReview,
      runFeedback: composition.handlers.runFeedback,
      runImplement: composition.handlers.runImplement,
      runImplementPrd: composition.handlers.runImplementPrd,
      runSplit: composition.handlers.runSplit,
      runUpdate: composition.handlers.runUpdate,
    })).resolves.toMatchObject({ status: "blocked", reason: "feedback-reconciliation" });

    expect((await readFile(composition.callsFile, "utf8")).split("\n").filter(Boolean)
      .map((line) => JSON.parse(line) as string[])
      .filter((args) => args.some((value) => value.includes("/comments/123/replies"))))
      .toHaveLength(0);
  });

  it("runs the real reconcile CLI adapter through common Target acquisition", async () => {
    const composition = await createCliFeedbackComposition("reply-only");

    await expect(runAutomationCli([
      "reconcile", "feedback", "347",
      "--base-revision", PRE,
      "--expected-post", POST,
      "--reply-root", ROOT,
      "--reply-body", "Fixed.",
    ], {
      runReview: composition.handlers.runReview,
      runFeedback: composition.handlers.runFeedback,
      runImplement: composition.handlers.runImplement,
      runImplementPrd: composition.handlers.runImplementPrd,
      runSplit: composition.handlers.runSplit,
      runUpdate: composition.handlers.runUpdate,
    })).resolves.toEqual({ status: "implemented", revision: POST, reconciled: true });

    expect((await readFile(composition.callsFile, "utf8")).split("\n").filter(Boolean)
      .map((line) => JSON.parse(line) as string[])
      .filter((args) => args.some((value) => value.includes("/comments/123/replies"))))
      .toHaveLength(1);
  });
});
