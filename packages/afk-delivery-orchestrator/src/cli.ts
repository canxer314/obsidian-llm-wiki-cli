#!/usr/bin/env node

import type { RepositoryPolicy } from "@llm-wiki/afk-delivery-core";
import { execFile } from "node:child_process";

import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import {
  adoptManagedPullRequest,
  continueManagedPullRequest,
  createBoundedTransitionWork,
  createGitHubContinuationEffects,
  createGitHubManagedImplementationPorts,
  createGitHubManagedPullRequestRecoveryPorts,
  createGitSynchronizationPorts,
  createLocalConflictResolutionPorts,
  createLocalImplementationPorts,
  createManagedPullRequestReconstructor,
  containerClaudeSettingsPath,
  discoverDeliveryFrontier,
  discoverManagedPullRequestRecovery,
  executeNewImplementationTransition,
  implementationTransitionId,
  reconstructDeliveryTicket,
  runConflictResolutionStage,
  runWorkerPreflight,
  type GitHubReadPort,
  type PreflightCheck,
  type PromptDocument,
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

function trustedActor(): { login: string; type: "Bot" | "App" } {
  const type = process.env.AFK_DELIVERY_ACTOR_TYPE ?? "Bot";
  if (type !== "Bot" && type !== "App") {
    throw new Error("AFK_DELIVERY_ACTOR_TYPE must be Bot or App");
  }
  return { login: requiredEnvironment("AFK_DELIVERY_ACTOR"), type };
}

function stagePolicy() {
  return {
    model: process.env.AFK_MODEL ?? "fable",
    contextWindow: Number(process.env.AFK_CONTEXT_WINDOW ?? "372000"),
    maximumIterations: Number(process.env.AFK_MAX_ITERATIONS ?? "24"),
    timeoutMs: Number(process.env.AFK_STAGE_TIMEOUT_MS ?? "3600000"),
    cpuLimit: Number(process.env.AFK_STAGE_CPUS ?? "2"),
  };
}

function repositoryPolicy(targetBranch: string, actor: ReturnType<typeof trustedActor>): RepositoryPolicy {
  return {
    schemaVersion: 1,
    targetBranch,
    readyLabel: process.env.AFK_READY_LABEL ?? "ready-for-agent",
    prohibitedLabel: process.env.AFK_PROHIBITED_LABEL ?? "afk:prohibited",
    needsHumanLabel: process.env.AFK_NEEDS_HUMAN_LABEL ?? "afk:needs-human",
    trustedActors: [actor],
    maximumRepairRounds: Number(process.env.AFK_MAX_REPAIR_ROUNDS ?? "2"),
    requiredValidationCommands: (process.env.AFK_VALIDATION_COMMANDS ?? "npm run typecheck\nnpm test -- --run")
      .split("\n").filter(Boolean),
    mergeStrategy: "squash",
  };
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

async function loadFrontier() {
  const { owner, repository } = repositoryParts();
  return discoverDeliveryFrontier(new GitHubApi(), {
    owner,
    repository,
    readyLabel: process.env.AFK_READY_LABEL ?? "ready-for-agent",
    prohibitedLabel: process.env.AFK_PROHIBITED_LABEL ?? "afk:prohibited",
  });
}

async function discover(): Promise<void> {
  const result = await loadFrontier();
  const repository = repositoryParts().fullName;
  const recovery = await discoverManagedPullRequestRecovery(
    createGitHubManagedPullRequestRecoveryPorts({ repository }),
    {
      repository,
      targetBranch: process.env.AFK_TARGET_BRANCH ?? "master",
      trustedActors: [trustedActor()],
      maximumPullRequests: Number(process.env.AFK_RECOVERY_SCAN_LIMIT ?? "100"),
    },
  );
  const tickets = [...new Set([
    ...result.frontier.map((ticket) => ticket.number),
    ...recovery.managedPullRequests.map((pr) => pr.ticketNumber),
    ...recovery.ambiguousTicketNumbers,
  ])].sort((left, right) => left - right);
  await writeOutput("tickets", JSON.stringify(tickets));
  process.stdout.write(`${JSON.stringify({ ...result, recovery, tickets })}\n`);
}

async function preflight(): Promise<void> {
  const result = await runWorkerPreflight(preflightChecks());
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (result.status !== "ready") process.exitCode = 1;
}

async function reconstruct(ticketNumber: number): Promise<void> {
  const { owner, repository } = repositoryParts();
  const result = await reconstructDeliveryTicket(new GitHubApi(), {
    owner,
    repository,
    ticketNumber,
    readyLabel: process.env.AFK_READY_LABEL ?? "ready-for-agent",
    prohibitedLabel: process.env.AFK_PROHIBITED_LABEL ?? "afk:prohibited",
  });
  if (result.status === "needs-human") throw new Error(result.reason);
  await writeOutput("snapshot", JSON.stringify(result.ticket));
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

async function dispatch(ticketNumber: number): Promise<void> {
  const runId = requiredEnvironment("GITHUB_RUN_ID");
  const attempt = Number(requiredEnvironment("GITHUB_RUN_ATTEMPT"));
  const value: unknown = JSON.parse(requiredEnvironment("AFK_DELIVERY_SNAPSHOT"));
  if (typeof value !== "object" || value === null || (value as { number?: unknown }).number !== ticketNumber ||
      !Number.isInteger(attempt)) {
    throw new Error("bounded transition input does not match the leased Delivery Ticket");
  }
  const work = createBoundedTransitionWork({
    repository: repositoryParts().fullName,
    snapshot: value as Parameters<typeof createBoundedTransitionWork>[0]["snapshot"],
    leaseId: `${runId}:${attempt}`,
    workflowRun: { id: runId, attempt },
    policy: {
      readyLabel: process.env.AFK_READY_LABEL ?? "ready-for-agent",
      prohibitedLabel: process.env.AFK_PROHIBITED_LABEL ?? "afk:prohibited",
    },
  });
  await writeOutput("transition_work", JSON.stringify(work));
  process.stdout.write(`${JSON.stringify(work)}\n`);
}

async function readPromptDocuments(paths: string[]): Promise<PromptDocument[]> {
  return Promise.all(paths.map(async (path) => ({ path, content: await readFile(path, "utf8") })));
}

function configuredPaths(name: string): string[] {
  const value = process.env[name];
  return value === undefined || value.length === 0
    ? []
    : value.split(":").filter(Boolean).map((path) => resolve(path));
}

async function adopt(ticketNumber: number, prNumber: number): Promise<void> {
  const repository = repositoryParts().fullName;
  const targetBranch = process.env.AFK_TARGET_BRANCH ?? "master";
  const actor = trustedActor();
  const viewer = JSON.parse(await command("gh", ["api", "user"])) as { login?: unknown; type?: unknown };
  if (viewer.login !== actor.login || viewer.type !== actor.type) {
    throw new Error("GitHub credential is not the configured trusted bot/App identity");
  }
  const raw = await command("gh", [
    "pr", "view", String(prNumber), "--repo", repository,
    "--json", "number,state,baseRefName,headRefName,headRefOid,headRepository,body,closingIssuesReferences",
  ]);
  const pr = JSON.parse(raw) as {
    number: number;
    state: string;
    baseRefName: string;
    headRefName: string;
    headRefOid: string;
    headRepository: { nameWithOwner: string } | null;
    body: string;
    closingIssuesReferences: Array<{ number: number }>;
  };
  if (
    pr.number !== prNumber || pr.state !== "OPEN" || pr.baseRefName !== targetBranch ||
    pr.headRepository?.nameWithOwner !== repository ||
    pr.closingIssuesReferences.length !== 1 || pr.closingIssuesReferences[0]?.number !== ticketNumber
  ) {
    throw new Error("adoption requires one authenticated open PR link at the configured target branch");
  }
  const transitionId = `afk-v1-adopt-${ticketNumber}-${prNumber}-${pr.headRefOid.slice(0, 12)}`;
  const result = await adoptManagedPullRequest({
    repository,
    ticketNumber,
    prNumber,
    targetBranch,
    currentRevision: pr.headRefOid,
    transitionId,
    workflowRunId: requiredEnvironment("GITHUB_RUN_ID"),
    trustedActor: actor,
    narrative: "Explicitly adopted for autonomous Managed PR continuation.",
  }, createGitHubManagedImplementationPorts({
    repositoryPath: resolve(process.env.GITHUB_WORKSPACE ?? process.cwd()),
    repository,
  }));
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

async function implement(ticketNumber: number): Promise<void> {
  const { owner, repository: repositoryName, fullName: repository } = repositoryParts();
  const reconstructedTicket = await reconstructDeliveryTicket(new GitHubApi(), {
    owner,
    repository: repositoryName,
    ticketNumber,
    readyLabel: process.env.AFK_READY_LABEL ?? "ready-for-agent",
    prohibitedLabel: process.env.AFK_PROHIBITED_LABEL ?? "afk:prohibited",
  });
  if (reconstructedTicket.status !== "eligible") {
    if (reconstructedTicket.status === "waiting") {
      process.stdout.write(`${JSON.stringify(reconstructedTicket)}\n`);
      return;
    }
    throw new Error(reconstructedTicket.reason);
  }
  const repositoryPath = resolve(process.env.GITHUB_WORKSPACE ?? process.cwd());
  const targetBranch = process.env.AFK_TARGET_BRANCH ?? "master";
  const rawTicket = await command("gh", [
    "issue", "view", String(ticketNumber), "--repo", repository,
    "--json", "number,title,body,state,labels",
  ]);
  const ticket = JSON.parse(rawTicket) as {
    number: number;
    title: string;
    body: string;
    state: string;
    labels: Array<{ name: string }>;
  };
  if (ticket.number !== ticketNumber || ticket.state !== "OPEN" ||
      !ticket.labels.some((label) => label.name === (process.env.AFK_READY_LABEL ?? "ready-for-agent")) ||
      ticket.labels.some((label) => label.name === (process.env.AFK_PROHIBITED_LABEL ?? "afk:prohibited"))) {
    throw new Error(`Delivery Ticket #${ticketNumber} is no longer authorized for implementation`);
  }
  const transitionId = implementationTransitionId({
    repository,
    ticketNumber,
    targetBranch,
  });
  const publication = createGitHubManagedImplementationPorts({ repositoryPath, repository });
  const actor = trustedActor();
  const policy = repositoryPolicy(targetBranch, actor);
  const boundedStagePolicy = stagePolicy();
  const recovery = createGitHubManagedPullRequestRecoveryPorts({ repository });
  const reconstructor = createManagedPullRequestReconstructor({
    repository,
    targetBranch,
    trustedActors: [actor],
    maximumPullRequests: Number(process.env.AFK_RECOVERY_SCAN_LIMIT ?? "100"),
    candidates: recovery,
    loadTicket: async () => {
      const current = await reconstructDeliveryTicket(new GitHubApi(), {
        owner,
        repository: repositoryName,
        ticketNumber,
        readyLabel: policy.readyLabel,
        prohibitedLabel: policy.prohibitedLabel,
      });
      if (current.status === "needs-human") throw new Error(current.reason);
      return current.ticket;
    },
    loadTargetRevision: async () => command("gh", [
      "api", `repos/${repository}/git/ref/heads/${targetBranch}`, "--jq", ".object.sha",
    ]),
  });
  const repositoryUrl = await command("git", ["-C", repositoryPath, "remote", "get-url", "origin"]);
  const localConflict = createLocalConflictResolutionPorts({
    repositoryPath,
    image: requiredEnvironment("AFK_DELIVERY_IMAGE"),
    claudeSettingsPath: containerClaudeSettingsPath(),
    modelGatewayUrl: requiredEnvironment("MODEL_GATEWAY_URL"),
    modelGatewayToken: requiredEnvironment("MODEL_GATEWAY_TOKEN"),
  });
  const continuation = await continueManagedPullRequest({
    repository,
    ticketNumber,
    lease: { status: "acquired", leaseId: `${requiredEnvironment("GITHUB_RUN_ID")}:${process.env.GITHUB_RUN_ATTEMPT ?? "1"}` },
    policy,
    workflowRun: {
      id: requiredEnvironment("GITHUB_RUN_ID"),
      attempt: Number(process.env.GITHUB_RUN_ATTEMPT ?? "1"),
    },
  }, {
    ...reconstructor,
    ...createGitSynchronizationPorts({ repositoryUrl }),
    ...createGitHubContinuationEffects({ repository, trustedActor: actor }),
    resolveConflicts: async (conflict) => runConflictResolutionStage({
      repository,
      ticket: conflict.ticket,
      prNumber: conflict.prNumber,
      headBranch: conflict.headBranch,
      expectedHeadRevision: conflict.expectedHeadRevision,
      targetRevision: conflict.targetRevision,
      authorizeOutput: conflict.authorizeOutput,
      conflicts: conflict.conflicts,
      controlComments: conflict.controlComments,
      policy: boundedStagePolicy,
    }, localConflict),
  });
  if (continuation.status === "needs-human") {
    process.stdout.write(`${JSON.stringify(continuation)}\n`);
    process.exitCode = 1;
    return;
  }
  if (continuation.status !== "selected" || continuation.transition.kind !== "implement") {
    process.stdout.write(`${JSON.stringify(continuation)}\n`);
    return;
  }

  const result = await executeNewImplementationTransition({
    repository,
    ticket,
    repositoryInstructions: await readPromptDocuments(configuredPaths("AFK_REPOSITORY_INSTRUCTIONS")),
    domainDocuments: await readPromptDocuments(configuredPaths("AFK_DOMAIN_DOCUMENTS")),
    architectureDecisions: await readPromptDocuments(configuredPaths("AFK_ARCHITECTURE_DECISIONS")),
    targetBranch,
    validationCommands: policy.requiredValidationCommands,
    transitionId,
    workflowRunId: requiredEnvironment("GITHUB_RUN_ID"),
    trustedActor: actor,
    policy: boundedStagePolicy,
  }, {
    stage: createLocalImplementationPorts({
      repositoryPath,
      image: requiredEnvironment("AFK_DELIVERY_IMAGE"),
      claudeSettingsPath: containerClaudeSettingsPath(),
      modelGatewayUrl: requiredEnvironment("MODEL_GATEWAY_URL"),
      modelGatewayToken: requiredEnvironment("MODEL_GATEWAY_TOKEN"),
    }),
    publication,
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (result.status !== "published") process.exitCode = 1;
}

const [operation, argument, secondArgument] = process.argv.slice(2);
if (operation === "discover") await discover();
else if (operation === "preflight") await preflight();
else if (operation === "adopt" && /^\d+$/u.test(argument ?? "") && /^\d+$/u.test(secondArgument ?? "")) {
  await adopt(Number(argument), Number(secondArgument));
} else if ((operation === "reconstruct" || operation === "dispatch" || operation === "implement") && /^\d+$/u.test(argument ?? "")) {
  const ticketNumber = Number(argument);
  if (operation === "reconstruct") await reconstruct(ticketNumber);
  else if (operation === "dispatch") await dispatch(ticketNumber);
  else await implement(ticketNumber);
} else {
  throw new Error("usage: afk-delivery <discover|preflight|adopt TICKET PR|reconstruct TICKET|dispatch TICKET|implement TICKET>");
}
