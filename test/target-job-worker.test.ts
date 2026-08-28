import { execFile } from "node:child_process";
import { chmod, mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { createTargetOperationRunner } from "../.sandcastle/target-operation.js";

const executeFile = promisify(execFile);
const roots: string[] = [];

const git = async (arguments_: readonly string[]): Promise<string> =>
  (await executeFile("git", [...arguments_])).stdout.trim();

describe("whole Target job process", () => {
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("runs checkout setup and the fixed target operation in one outer worker", async () => {
    const root = await mkdtemp(join(tmpdir(), "target-job-worker-"));
    roots.push(root);
    const remotePath = join(root, "remote.git");
    const contributorPath = join(root, "contributor");
    const trustedPath = join(root, "trusted");
    const jobsPath = join(root, "jobs");
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
    })).resolves.toEqual({ status: "implemented", source: "target-revision" });
    await expect(readdir(jobsPath)).resolves.toEqual([]);
  }, 40_000);
});
