import { spawn } from "node:child_process";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { createTargetOperationRunner } from "../.sandcastle/target-operation.js";
import { INHERITED_JOB_PROCESS_GROUP } from "../.sandcastle/worker-process.js";

const executeFile = promisify(execFile);
const roots: string[] = [];

const git = async (arguments_: readonly string[]): Promise<string> =>
  (await executeFile("git", [...arguments_])).stdout.trim();

describe("whole Target job process", () => {
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it.each([
    [undefined, undefined],
    ["", undefined],
    ["0", undefined],
    ["true", undefined],
    [" ", undefined],
    ["inherited", undefined],
    [undefined, "{"],
  ])("rejects marker %j before reading input %j", async (marker, input) => {
    const environment = { ...process.env };
    if (marker === undefined) delete environment[INHERITED_JOB_PROCESS_GROUP];
    else environment[INHERITED_JOB_PROCESS_GROUP] = marker;
    const child = spawn(process.execPath, [
      "--experimental-strip-types",
      join(import.meta.dirname, "../.sandcastle/target-job-worker.ts"),
    ], {
      env: environment,
      stdio: ["pipe", "ignore", "pipe"],
    });
    if (input !== undefined) child.stdin.write(input);
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    const closed = new Promise<number | null>((resolveExit, reject) => {
      child.once("error", reject);
      child.once("close", resolveExit);
    });
    let deadline: NodeJS.Timeout | undefined;

    try {
      const exitCode = await Promise.race([
        closed,
        new Promise<never>((_resolve, reject) => {
          deadline = setTimeout(
            () => reject(new Error("Target job worker waited for stdin")),
            1_500,
          );
        }),
      ]);

      expect(exitCode).not.toBe(0);
      expect(stderr.trim()).toBe("Target job worker requires an inherited process group");
    } finally {
      if (deadline !== undefined) clearTimeout(deadline);
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await closed.catch(() => undefined);
      }
    }
  });

  it.each([
    ["", "Target job input is missing"],
    ["{", "Target job input is invalid"],
    ["null", "Target job input is invalid"],
  ])("rejects invalid serialized input %j without success output", async (input, message) => {
    const child = spawn(process.execPath, [
      "--experimental-strip-types",
      join(import.meta.dirname, "../.sandcastle/target-job-worker.ts"),
    ], {
      env: { ...process.env, [INHERITED_JOB_PROCESS_GROUP]: "1" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.stdin.end(input);
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    const exitCode = await new Promise<number | null>((resolveExit, reject) => {
      child.once("error", reject);
      child.once("close", resolveExit);
    });

    expect(exitCode).not.toBe(0);
    expect(stdout).toBe("");
    expect(stderr.trim()).toBe(message);
  });

  it("redacts malformed serialized Target job input", async () => {
    const child = spawn(process.execPath, [
      "--experimental-strip-types",
      join(import.meta.dirname, "../.sandcastle/target-job-worker.ts"),
    ], {
      env: { ...process.env, [INHERITED_JOB_PROCESS_GROUP]: "1" },
      stdio: ["pipe", "ignore", "pipe"],
    });
    const forbiddenMarker = "TOP_SECRET";
    const replyBody = `${forbiddenMarker}_REPLY_BODY`;
    child.stdin.end([
      '{"checkout":null,"startup":null,"invocation":{',
      '"operation":"implement-feedback","reconcile":{"expectedReply":{',
      `"rootCommentId":"root","body":${replyBody}`,
      "}}}}",
    ].join(""));
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    const exitCode = await new Promise<number | null>((resolveExit, reject) => {
      child.once("error", reject);
      child.once("close", resolveExit);
    });

    expect(exitCode).not.toBe(0);
    expect(stderr.trim()).toBe("Target job input is invalid");
    expect(stderr).not.toContain(forbiddenMarker);
    expect(stderr).not.toContain("expectedReply");
    expect(stderr).not.toContain("Unexpected token");
  });

  it("validates the serialized invocation before constructing checkout execution", async () => {
    const child = spawn(process.execPath, [
      "--experimental-strip-types",
      join(import.meta.dirname, "../.sandcastle/target-job-worker.ts"),
    ], {
      env: { ...process.env, [INHERITED_JOB_PROCESS_GROUP]: "1" },
      stdio: ["pipe", "ignore", "pipe"],
    });
    child.stdin.end(JSON.stringify({
      checkout: null,
      startup: null,
      invocation: {
        operation: "implement-issue",
        number: 219,
        revision: "a".repeat(40),
        jobId: "unacquired-target-job",
      },
    }));
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    const exitCode = await new Promise<number | null>((resolveExit, reject) => {
      child.once("error", reject);
      child.once("close", resolveExit);
    });

    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("Target operation invocation is not acquired");
    expect(stderr).not.toContain("Cannot read properties");
  });

  it("retains partial setup output when the whole-job deadline kills a hung command", async () => {
    const root = await mkdtemp(join(tmpdir(), "target-job-hung-setup-"));
    roots.push(root);
    const trustedPath = join(root, "trusted");
    const jobsPath = join(root, "jobs");
    const logsPath = join(jobsPath, "logs");
    const binPath = join(root, "bin");
    const remoteUrl = "https://github.com/example/hung-setup-fixture.git";
    await git(["init", "-b", "master", trustedPath]);
    await git(["-C", trustedPath, "config", "user.name", "Trusted Source"]);
    await git(["-C", trustedPath, "config", "user.email", "trusted@example.test"]);
    await git(["-C", trustedPath, "commit", "--allow-empty", "-m", "trusted fixture"]);
    const revision = await git(["-C", trustedPath, "rev-parse", "HEAD"]);
    await git(["-C", trustedPath, "remote", "add", "origin", remoteUrl]);
    await mkdir(binPath);
    const gitWrapper = join(binPath, "git");
    await writeFile(gitWrapper, [
      "#!/usr/bin/env bash",
      'if [[ "$1" == "clone" ]]; then',
      '  trap "" TERM',
      '  printf "partial clone stdout\\n"',
      '  printf "partial clone stderr\\n" >&2',
      "  sleep 30",
      "fi",
      'exec /usr/bin/git "$@"',
    ].join("\n"));
    await chmod(gitWrapper, 0o755);
    const transport = {
      HOME: process.env.HOME ?? "",
      PATH: `${binPath}:${process.env.PATH ?? ""}`,
    };
    const runner = createTargetOperationRunner({
      checkoutOptions: {
        sourceRepositoryPath: trustedPath,
        checkoutRoot: jobsPath,
        gitEnvironment: transport,
        dependencyEnvironment: transport,
      },
      jobLogRoot: logsPath,
      startup: {
        imageName: "fixture-image",
        childEnvironments: { git: transport, github: {}, claude: {}, githubAgent: {} },
        models: {
          default: "default-model",
          planner: "planner-model",
          implementer: "implementer-model",
          reviewer: "reviewer-model",
        },
      },
      timeoutMilliseconds: 1_000,
      graceMilliseconds: 100,
    });

    await expect(runner.run({
      operation: "implement-issue",
      number: 219,
      revision,
      jobId: "hung-setup-job",
      acquired: true,
    })).rejects.toThrow("Target operation implement-issue timed out");
    await expect(readFile(join(logsPath, "hung-setup-job", "stdout.log"), "utf8"))
      .resolves.toContain("partial clone stdout\n");
    await expect(readFile(join(logsPath, "hung-setup-job", "stderr.log"), "utf8"))
      .resolves.toContain("partial clone stderr\n");
    await expect(readFile(join(logsPath, "hung-setup-job", "metadata.json"), "utf8").then(JSON.parse))
      .resolves.toMatchObject({ status: "timed-out" });
  }, 10_000);

  it("runs checkout setup and the fixed target operation in one outer worker", async () => {
    const root = await mkdtemp(join(tmpdir(), "target-job-worker-"));
    roots.push(root);
    const remotePath = join(root, "remote.git");
    const contributorPath = join(root, "contributor");
    const trustedPath = join(root, "trusted");
    const jobsPath = join(root, "jobs");
    const logsPath = join(jobsPath, "logs");
    const binPath = join(root, "bin");
    const remoteUrl = "https://github.com/example/whole-job-fixture.git";

    await git(["init", "--bare", "-b", "master", remotePath]);
    await git(["init", "-b", "master", contributorPath]);
    await git(["-C", contributorPath, "config", "user.name", "Fixture Contributor"]);
    await git(["-C", contributorPath, "config", "user.email", "contributor@example.test"]);
    await mkdir(join(contributorPath, ".sandcastle", "operations"), { recursive: true });
    await writeFile(join(contributorPath, "package.json"), JSON.stringify({
      name: "whole-job-fixture",
      version: "1.0.0",
      private: true,
    }));
    await writeFile(join(contributorPath, "package-lock.json"), JSON.stringify({
      name: "whole-job-fixture",
      version: "1.0.0",
      lockfileVersion: 3,
      requires: true,
      packages: { "": { name: "whole-job-fixture", version: "1.0.0" } },
    }));
    await writeFile(
      join(contributorPath, ".sandcastle", "operations", "implement-issue.ts"),
      [
        'for await (const _chunk of process.stdin) {}',
        'console.log(JSON.stringify({ status: "implemented", source: "target-revision" }));',
      ].join("\n"),
    );
    await git(["-C", contributorPath, "add", "-A"]);
    await git(["-C", contributorPath, "commit", "-m", "target fixture"]);
    const revision = await git(["-C", contributorPath, "rev-parse", "HEAD"]);
    await git(["-C", contributorPath, "remote", "add", "origin", remotePath]);
    await git(["-C", contributorPath, "push", "origin", "master"]);
    await git(["clone", "--no-local", remotePath, trustedPath]);
    await git(["-C", trustedPath, "config", "user.name", "Trusted Source"]);
    await git(["-C", trustedPath, "config", "user.email", "trusted@example.test"]);
    await git(["-C", trustedPath, "remote", "set-url", "origin", remoteUrl]);
    await mkdir(binPath);
    const gitWrapper = join(binPath, "git");
    await writeFile(gitWrapper, [
      "#!/usr/bin/env bash",
      `if [[ "$1" == "clone" && "$4" == "${remoteUrl}" ]]; then`,
      `  exec /usr/bin/git "$1" "$2" "$3" "${remotePath}" "${'$'}5"`,
      "fi",
      'exec /usr/bin/git "$@"',
    ].join("\n"));
    await chmod(gitWrapper, 0o755);

    const transport = {
      HOME: process.env.HOME ?? "",
      PATH: `${binPath}:${process.env.PATH ?? ""}`,
    };
    const runner = createTargetOperationRunner({
      checkoutOptions: {
        sourceRepositoryPath: trustedPath,
        checkoutRoot: jobsPath,
        gitEnvironment: transport,
        dependencyEnvironment: {
          HOME: process.env.HOME ?? "",
          PATH: process.env.PATH ?? "",
        },
      },
      jobLogRoot: logsPath,
      startup: {
        imageName: "fixture-image",
        childEnvironments: { git: transport, github: {}, claude: {}, githubAgent: {} },
        models: {
          default: "default-model",
          planner: "planner-model",
          implementer: "implementer-model",
          reviewer: "reviewer-model",
        },
      },
      timeoutMilliseconds: 30_000,
      graceMilliseconds: 100,
    });

    await expect(runner.run({
      operation: "implement-issue",
      number: 219,
      revision,
      jobId: "job-219",
      acquired: true,
    })).resolves.toEqual({ status: "implemented", source: "target-revision" });
    await expect(readdir(jobsPath)).resolves.toEqual(["logs"]);
    await expect(readFile(join(logsPath, "job-219", "stdout.log"), "utf8"))
      .resolves.toContain('"source":"target-revision"');
    await expect(readFile(join(logsPath, "job-219", "metadata.json"), "utf8").then(JSON.parse))
      .resolves.toMatchObject({ status: "completed", jobId: "job-219" });
  }, 40_000);
});
