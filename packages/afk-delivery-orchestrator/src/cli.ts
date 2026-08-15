#!/usr/bin/env node

import { execFile } from "node:child_process";
import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  discoverDeliveryFrontier,
  runWorkerPreflight,
  type GitHubReadPort,
  type PreflightCheck,
} from "./index.js";

const execFileAsync = promisify(execFile);

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) throw new Error(`${name} is required`);
  return value;
}

async function command(file: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(file, args, { timeout: 30_000 });
  return stdout.trim();
}

class GitHubApi implements GitHubReadPort {
  async request(path: string, signal?: AbortSignal): Promise<Response> {
    return fetch(`https://api.github.com${path}`, {
      ...(signal === undefined ? {} : { signal }),
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${requiredEnvironment("GITHUB_TOKEN")}`,
        "x-github-api-version": "2026-03-10",
        "user-agent": "afk-delivery-worker",
      },
    });
  }
}

function repositoryParts(): { owner: string; repository: string; fullName: string } {
  const fullName = requiredEnvironment("GITHUB_REPOSITORY");
  const [owner, repository, extra] = fullName.split("/");
  if (owner === undefined || repository === undefined || extra !== undefined) {
    throw new Error("GITHUB_REPOSITORY must be owner/repository");
  }
  return { owner, repository, fullName };
}

async function writeOutput(name: string, value: string): Promise<void> {
  const output = requiredEnvironment("GITHUB_OUTPUT");
  await appendFile(output, `${name}=${value}\n`, "utf8");
}

function preflightChecks(): PreflightCheck[] {
  return [
    { name: "docker", check: async () => { await command("docker", ["info", "--format", "{{.ServerVersion}}"]); return { ok: true }; } },
    { name: "model-gateway", check: async (signal) => {
      const url = new URL("/v1/models", requiredEnvironment("MODEL_GATEWAY_URL"));
      const response = await fetch(url, signal === undefined ? {} : { signal });
      return response.ok ? { ok: true } : { ok: false, reason: `gateway returned ${response.status}` };
    } },
    { name: "delivery-image", check: async () => {
      await command("docker", ["image", "inspect", requiredEnvironment("AFK_DELIVERY_IMAGE")]);
      return { ok: true };
    } },
    { name: "pinned-skills", check: async () => {
      const actual = await command("docker", ["run", "--rm", "--network", "none", requiredEnvironment("AFK_DELIVERY_IMAGE"), "cat", "/opt/afk-delivery/skills.lock"]);
      const expected = await readFile(requiredEnvironment("AFK_DELIVERY_SKILL_MANIFEST"), "utf8");
      return actual === expected.trim()
        ? { ok: true }
        : { ok: false, reason: "image skill versions do not match the pinned manifest" };
    } },
    { name: "github-authentication", check: async () => {
      const viewer = JSON.parse(await command("gh", ["api", "user"])) as { login?: unknown; type?: unknown };
      const allowedLogin = requiredEnvironment("AFK_DELIVERY_ACTOR");
      return viewer.login === allowedLogin && (viewer.type === "Bot" || viewer.type === "App")
        ? { ok: true }
        : { ok: false, reason: "GitHub credential is not the configured bot/App identity" };
    } },
    { name: "repository-access", check: async () => { await command("gh", ["repo", "view", repositoryParts().fullName, "--json", "nameWithOwner"]); return { ok: true }; } },
    { name: "writable-workspace", check: async () => {
      const directory = await mkdtemp(join(process.env.RUNNER_TEMP ?? tmpdir(), "afk-delivery-"));
      try { await writeFile(join(directory, "probe"), "ok", "utf8"); } finally { await rm(directory, { recursive: true, force: true }); }
      return { ok: true };
    } },
  ];
}

async function discover(): Promise<void> {
  const { owner, repository } = repositoryParts();
  const result = await discoverDeliveryFrontier(new GitHubApi(), {
    owner,
    repository,
    readyLabel: process.env.AFK_READY_LABEL ?? "ready-for-agent",
    prohibitedLabel: process.env.AFK_PROHIBITED_LABEL ?? "afk:prohibited",
  });
  await writeOutput("tickets", JSON.stringify(result.frontier.map((ticket) => ticket.number)));
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

async function preflight(): Promise<void> {
  const result = await runWorkerPreflight(preflightChecks());
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (result.status !== "ready") process.exitCode = 1;
}

async function reconstruct(ticketNumber: number): Promise<void> {
  const { owner, repository } = repositoryParts();
  const result = await discoverDeliveryFrontier(new GitHubApi(), {
    owner,
    repository,
    readyLabel: process.env.AFK_READY_LABEL ?? "ready-for-agent",
    prohibitedLabel: process.env.AFK_PROHIBITED_LABEL ?? "afk:prohibited",
  });
  const ticket = result.frontier.find((candidate) => candidate.number === ticketNumber);
  if (ticket === undefined) throw new Error(`Delivery Ticket #${ticketNumber} is no longer in the Delivery Frontier`);
  await writeOutput("snapshot", JSON.stringify(ticket));
  process.stdout.write(`${JSON.stringify(ticket)}\n`);
}

async function dispatch(ticketNumber: number): Promise<void> {
  const leaseId = `${requiredEnvironment("GITHUB_RUN_ID")}:${requiredEnvironment("GITHUB_RUN_ATTEMPT")}`;
  process.stdout.write(`${JSON.stringify({ ticketNumber, lease: { status: "acquired", leaseId }, maximumTransitions: 1 })}\n`);
}

const [operation, argument] = process.argv.slice(2);
if (operation === "discover") await discover();
else if (operation === "preflight") await preflight();
else if ((operation === "reconstruct" || operation === "dispatch") && /^\d+$/u.test(argument ?? "")) {
  const ticketNumber = Number(argument);
  if (operation === "reconstruct") await reconstruct(ticketNumber);
  else await dispatch(ticketNumber);
} else {
  throw new Error("usage: afk-delivery <discover|preflight|reconstruct TICKET|dispatch TICKET>");
}
