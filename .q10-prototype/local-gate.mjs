#!/usr/bin/env node

// PROTOTYPE — throw away after Q10 is answered.

import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { spawnSync } from "node:child_process";

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined) {
      throw new Error(`Expected --name value, received: ${key ?? "<nothing>"}`);
    }
    args[key.slice(2)] = value;
  }
  return args;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio: options.capture ? "pipe" : "inherit",
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0 && !options.allowFailure) {
    throw new Error(`${command} exited with status ${result.status}`);
  }
  return result;
}

function output(command, args) {
  return run(command, args, { capture: true }).stdout.trim();
}

function required(args, name) {
  if (!args[name]) throw new Error(`Missing --${name}`);
  return args[name];
}

function resolveHead(args) {
  if (args.pr) {
    const pr = JSON.parse(output("gh", [
      "pr", "view", args.pr,
      "--repo", required(args, "repository"),
      "--json", "number,state,isDraft,headRefOid,baseRefName,url",
    ]));
    if (pr.state !== "OPEN" || pr.isDraft) throw new Error("PR must be open and ready for review");
    return { sha: pr.headRefOid, pr };
  }

  const ref = `refs/heads/${required(args, "head-ref")}`;
  const line = output("git", ["ls-remote", required(args, "remote"), ref]);
  const sha = line.split(/\s+/)[0];
  if (!sha) throw new Error(`Remote ref not found: ${ref}`);
  return { sha, pr: null };
}

function createPublisher(args, sha, startedAt) {
  const context = args.context ?? "sandcastle/local-quality";
  const logPath = args["status-log"];

  return (state, description) => {
    const event = {
      elapsedSeconds: Number(((Date.now() - startedAt) / 1000).toFixed(3)),
      sha,
      context,
      state,
      description,
    };
    console.log(`STATUS ${JSON.stringify(event)}`);

    if (args.publisher === "github") {
      run("gh", [
        "api", "--method", "POST",
        `repos/${required(args, "repository")}/statuses/${sha}`,
        "-f", `state=${state}`,
        "-f", `context=${context}`,
        "-f", `description=${description.slice(0, 140)}`,
      ]);
    } else if (logPath) {
      appendFileSync(logPath, `${JSON.stringify(event)}\n`);
    }
  };
}

function executeCommandInDocker(args, checkout, startedAt, command, phase) {
  const image = args.image ?? "node:24-bookworm";
  const uid = process.getuid?.() ?? 1000;
  const gid = process.getgid?.() ?? 1000;
  const dockerArgs = [
    "run", "--rm",
    "--user", `${uid}:${gid}`,
    "--env", "HOME=/tmp",
    "--volume", `${checkout}:/workspace`,
    "--workdir", "/workspace",
  ];
  if (args.network) {
    dockerArgs.push("--network", args.network);
  }
  if (args["npm-cache"]) {
    dockerArgs.push("--volume", `${args["npm-cache"]}:/tmp/.npm`);
  }
  dockerArgs.push(image, "bash", "-lc", command);

  console.log(`EXECUTOR phase=${phase} image=${image} sha=${args.sha} command=${JSON.stringify(command)}`);
  const result = run("docker", dockerArgs, { allowFailure: true });

  console.log(`EXECUTOR_RESULT phase=${phase} exit=${result.status} elapsedSeconds=${((Date.now() - startedAt) / 1000).toFixed(3)}`);
  return result.status ?? 1;
}

function merge(args, sha) {
  if (!args.pr) {
    console.log(`MERGE would-call head=${sha} (no --pr supplied)`);
    return;
  }
  if (args.publisher !== "github") {
    console.log(`MERGE would-call pr=${args.pr} matchHead=${sha} (publisher is log-only)`);
    return;
  }
  const mergeArgs = [
    "pr", "merge", args.pr,
    "--repo", required(args, "repository"),
    "--squash",
    "--match-head-commit", sha,
  ];
  if (args["delete-branch"] === "true") mergeArgs.push("--delete-branch");
  run("gh", mergeArgs);
}

const args = parseArgs(process.argv.slice(2));
const startedAt = Date.now();
const workspaceRoot = process.env.CLAUDE_JOB_DIR
  ? join(process.env.CLAUDE_JOB_DIR, "tmp")
  : tmpdir();
const checkout = mkdtempSync(join(workspaceRoot, "q10-local-gate-checkout-"));
let publish;
let sha;

try {
  const subject = resolveHead(args);
  sha = subject.sha;
  args.sha = sha;
  publish = createPublisher(args, sha, startedAt);
  publish("pending", "Local quality gate is running");

  run("git", ["clone", "--quiet", "--no-checkout", required(args, "remote"), checkout]);
  run("git", ["-C", checkout, "checkout", "--quiet", "--detach", sha]);

  let setupExit = 0;
  const setupCommand = args.setup;
  if (setupCommand) {
    const attempts = Number(args["setup-attempts"] ?? "1");
    setupExit = 1;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      setupExit = executeCommandInDocker(args, checkout, startedAt, setupCommand, `setup-${attempt}`);
      if (setupExit === 0) break;
    }
  }

  if (setupExit !== 0) {
    publish("error", `Local gate setup failed with exit ${setupExit}`);
    process.exitCode = 2;
  } else {
    const exitCode = executeCommandInDocker(args, checkout, startedAt, required(args, "command"), "quality");
    if (exitCode !== 0) {
      publish("failure", `Local quality gate failed with exit ${exitCode}`);
      process.exitCode = exitCode;
    } else {
      const current = resolveHead(args);
      if (current.sha !== sha) {
        publish("error", `Head changed during checks; expected ${sha.slice(0, 12)}`);
        process.exitCode = 2;
      } else {
        publish("success", "Local quality gate passed");
        merge(args, sha);
      }
    }
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  if (publish) publish("error", message);
  console.error(`GATE_ERROR ${message}`);
  process.exitCode = 2;
} finally {
  rmSync(checkout, { recursive: true, force: true });
  console.log(`DONE elapsedSeconds=${((Date.now() - startedAt) / 1000).toFixed(3)} workspace=${basename(checkout)}`);
}
